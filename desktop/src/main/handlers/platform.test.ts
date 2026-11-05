// ── CHANGING THE PLATFORM VOIDS THE SESSION ────────────────────────────────────
//
// The stored bearer and refresh token belong to ONE Cognito pool. Point the app at a
// different platform and both become artefacts of a pool that no longer applies. So the
// properties under test here are about the teardown, and its ORDER:
//
//   - a change tears the session down BEFORE the new config is written;
//   - a FAILED save changes nothing at all, so a bad URL cannot break a working install;
//   - re-saving the same URL is not a "change" and must not sign anyone out;
//   - the server-side re-check FAILS OPEN, so a flaky network is not a logout.
//
// The last one is the easiest to get wrong and the most user-visible: treating "portal
// briefly unreachable" the same as "pool rotated" would log people out every time the
// wifi dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

// Windows the broadcast would reach. Captured so a test can assert WHICH channel fired.
const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
}));
vi.mock("better-sqlite3", () => ({ default: class {} }));

const store = new Map<string, string>();
vi.mock("../database", async () => {
  // isSensitiveSetting must be the REAL one: setting-access.ts (imported transitively via
  // handlers/ai) validates its allowlists against it at module load and throws if a credential
  // key ever appears there. Stubbing it would disable that invariant during tests.
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    readSetting: (key: string) => store.get(key) ?? null,
    writeSetting: (key: string, value: string) => {
      store.set(key, value);
    },
    getDb: () => ({
      transaction: (fn: () => void) => () => fn(),
      /**
       * `get()` answers the one aggregate `platform:pendingLink` asks — how many projects and chat
       * sessions this profile holds. Driven by `profileWorkRows` so a test can model a profile that has
       * been disconnected but still contains work, which is the case that matters.
       */
      prepare: () => ({
        all: () => [],
        get: () => ({ n: profileWorkRows }),
        run: () => {},
      }),
    }),
  };
});
vi.mock("ws", () => ({ default: class {} }));

/** The pending link main is holding. `null` means no link arrived. */
let pendingLink: any = null;
let takeCalls = 0;
/**
 * The id main would have minted for the pending proposal.
 *
 * ⚠ THE COMMIT IS BOUND TO IT NOW. The `pendingLink` slot was over-writable and not bound to the
 * user's confirmation. `platform:connect` names the proposal it
 * is confirming, and the real `takePendingConnectLink` refuses any other id, so the fake has to
 * model that rather than hand back whatever is in the slot.
 */
const PENDING_ID = "proposal-1";
vi.mock("../deep-link", () => ({
  hasPendingConnectLink: () => pendingLink != null,  // nosemgrep: eqeq-is-bad
  peekPendingConnectLink: () => (pendingLink ? { link: pendingLink, id: PENDING_ID } : null),
  takePendingConnectLink: (expectedId: string) => {
    takeCalls++;
    if (!pendingLink || expectedId !== PENDING_ID) return null;
    const link = pendingLink;
    // Consumed, exactly as the real implementation does.
    pendingLink = null;
    return link;
  },
}));

vi.mock("./ai", () => ({ tearDownSession: () => {} }));

/**
 * ⚠ `platform:reset` NOW DELETES THE SAVED ACCOUNTS FOR THE PLATFORM IT IS LEAVING, so this test
 * records the call. Reset cleared the config and the session
 * and left every row's encrypted bearer and 30-day refresh token on disk, unreachable from inside the
 * app — while the confirmation dialog said "the saved accounts for it will be forgotten".
 */
const forgotten: Array<string | null> = [];
/** Set per test where the "is this profile already in use" answer matters. */
let profileAccounts: string[] = [];
/** How many times the profile's identity binding was released — see the mock below. */
let released = 0;
/** Projects + chat sessions this profile holds. The signal a Disconnect cannot erase. */
let profileWorkRows = 0;

vi.mock("../accounts", () => ({
  forgetAccountsForPlatform: (fingerprint: string | null) => {
    forgotten.push(fingerprint);
    return 2;
  },
  profileIdentity: () => ({
    count: profileAccounts.length,
    onlyEmail: profileAccounts.length === 1 ? profileAccounts[0] : null,
  }),
  /**
   * Recorded rather than no-op'd: releasing the profile's identity binding is part of what a platform
   * CHANGE and a RESET now mean, and "did this path release it" is a property worth asserting.
   */
  releaseProfileIdentity: () => {
    released++;
  },
  bindProfileIdentity: () => {},
}));

import {
  setupPlatformHandlers,
  checkPlatformDrift,
  recheckPlatformFromServer,
} from "./platform";
import { savePlatformConfig, validateDiscovery } from "../platform-config";

const POOL_A = "us-east-1_EXAMPLE01";
const ISSUER_A = `https://cognito-idp.us-east-1.amazonaws.com/${POOL_A}`;
const AUTHZ = "https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize";
const TOKEN = "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token";
const CLIENT_A = "clientaaaaaaaaaaaaaaaaaaaa";
const API_A = "https://api.a.example";
const PORTAL_A = "https://ai.a.example";

const PARAMS_A = { poolId: POOL_A, clientId: CLIENT_A, apiBaseUrl: "https://api.a.example" };

/** An AWS OIDC discovery document for platform A, with overrides. */
function discovery(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER_A,
    authorization_endpoint: AUTHZ,
    token_endpoint: TOKEN,
    scopes_supported: ["openid", "email", "profile"],
    ...overrides,
  };
}

/**
 * Platform B — a genuinely DIFFERENT pool, which is what "another platform" now means.
 *
 * Its discovery document must name its own pool: `validateDiscovery` binds the response to
 * the pool the Access Key asked about, so reusing A's document for B is correctly rejected.
 */
const POOL_B = "us-east-1_BbbbbbBBB";

function discoveryFor(poolId: string, overrides: Record<string, unknown> = {}) {
  return discovery({
    issuer: `https://cognito-idp.us-east-1.amazonaws.com/${poolId}`,
    ...overrides,
  });
}

/**
 * A pending link, as the OS would have delivered it. CONFIG ONLY — no code, no token: the
 * portal cannot mint a session for the desktop, so there is nothing to redeem.
 */
function linkFor(poolId = POOL_A, apiBaseUrl = API_A, portalUrl = PORTAL_A) {
  return { portalUrl, apiBaseUrl, poolId, clientId: CLIENT_A };
}

/** A `fetch` that answers AWS discovery with `body`. */
function mockDiscovery(body: unknown, init: { status?: number } = {}) {
  return vi.fn(async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    body: null,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

const tearDown = vi.fn();
setupPlatformHandlers(tearDown);

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return Promise.resolve(handler({}, ...args));
}

/** Seed a signed-in session on Platform A. */
function signedInOnPlatformA() {
  savePlatformConfig(validateDiscovery(PARAMS_A, discovery()));
  store.set("auth_token", "a-token");
  store.set("connected", "true");
}

/**
 * The re-check throttle is MODULE state (`lastServerRecheckMs`), which is correct for
 * production — one shared clock per process — and leaks between tests. Rather than adding
 * a test-only reset to production code, each test starts a simulated day later than the
 * last, so every one begins outside the throttle window.
 *
 * Without this, a test asserting "hits the network once" observes ZERO calls because an
 * earlier test already consumed the window — a failure that looks like the throttle
 * working and is actually the test lying.
 */
let simulatedNow = new Date("2026-08-11T00:00:00.000Z").getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  store.clear();
  sent.length = 0;
  tearDown.mockClear();
  takeCalls = 0;
  pendingLink = null;
  // Module state, like the three above it: a test that leaves a remembered account behind would make
  // every later `profileInUse` answer wrong rather than failing where the mistake is.
  profileAccounts = [];
  released = 0;
  profileWorkRows = 0;
  simulatedNow += ONE_DAY_MS;
  vi.useFakeTimers();
  vi.setSystemTime(simulatedNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("platform:connect — commits the confirmed config", () => {
  it("resolves the pool and stores the platform", async () => {
    pendingLink = linkFor();
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    const result = await invoke("platform:connect", PENDING_ID);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false); // fresh install: nothing to void
    expect(tearDown).not.toHaveBeenCalled();
    expect(store.get("cognito_pool_id")).toBe(POOL_A);
    expect(store.get("portal_url")).toBe(PORTAL_A);
    expect(store.get("server_url")).toBe(API_A);
  });

  /**
   * ⚠ IT DOES NOT SIGN ANYONE IN. That used to be this handler's job, via a one-time code. The
   * portal cannot mint a session for another client (see the gate doc), so sign-in is the app's
   * own SRP form and runs after this. A `connected` flag set here would send the user straight
   * past the form with no bearer.
   */
  it("does NOT mark the app signed in", async () => {
    pendingLink = linkFor();
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    await invoke("platform:connect", PENDING_ID);

    expect(store.get("connected") || "").not.toBe("true");
    expect(store.get("auth_token") || "").toBe("");
  });

  it("refuses when no link is pending", async () => {
    pendingLink = null;
    expect((await invoke("platform:connect", PENDING_ID)).ok).toBe(false);
  });

  /**
   * ⚠ RESOLVE BEFORE ANYTHING IS WRITTEN. A link naming a pool AWS does not recognise must
   * leave a working install exactly as it was — the user tried to switch, it failed, and they
   * should still have what they had.
   */
  it("changes NOTHING when AWS discovery rejects the pool", async () => {
    signedInOnPlatformA();
    store.set("auth_token", "a-token");
    pendingLink = linkFor(POOL_B, "https://api.b.example", "https://ai.b.example");
    // A document naming a DIFFERENT pool than the link: the binding must refuse it.
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    const result = await invoke("platform:connect", PENDING_ID);

    expect(result.ok).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
    expect(store.get("cognito_pool_id")).toBe(POOL_A);
    expect(store.get("auth_token")).toBe("a-token");
  });

  /**
   * The link is consumed even on failure: leaving it pending would let a later mount re-offer a
   * link the user already saw fail, with no new information.
   */
  it("consumes the link even when resolution fails", async () => {
    pendingLink = linkFor(POOL_B);
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    await invoke("platform:connect", PENDING_ID);

    expect(takeCalls).toBe(1);
    expect((await invoke("platform:connect", PENDING_ID)).ok).toBe(false);
  });

  it("tears the session down and broadcasts when the platform changes", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor(POOL_B, "https://api.b.example", "https://ai.b.example");
    vi.stubGlobal("fetch", mockDiscovery(discoveryFor(POOL_B)));

    const result = await invoke("platform:connect", PENDING_ID);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(tearDown).toHaveBeenCalledTimes(1);
    expect(store.get("cognito_pool_id")).toBe(POOL_B);
  });

  /**
   * ⚠ A DISTINCT EVENT FROM `auth:expired`. Both land on the sign-in screen, but "your session
   * expired" is false here — the session was fine, the platform moved.
   */
  it("broadcasts platform:changed, NOT auth:expired", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor(POOL_B, "https://api.b.example", "https://ai.b.example");
    vi.stubGlobal("fetch", mockDiscovery(discoveryFor(POOL_B)));

    await invoke("platform:connect", PENDING_ID);

    expect(sent.map((x) => x.channel)).toEqual(["platform:changed"]);
  });

  it("does NOT sign out when reconnecting to the SAME platform", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor();
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    const result = await invoke("platform:connect", PENDING_ID);

    expect(result.changed).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
    // A warning that fires when nothing happens is one people learn to click past.
    expect(sent).toHaveLength(0);
  });
});

describe("platform:pendingLink — describe without committing", () => {
  it("reports the link's origins and does NOT consume it", async () => {
    pendingLink = linkFor();

    const result = await invoke("platform:pendingLink");

    expect(result.pending).toBe(true);
    expect(result.portalUrl).toBe(PORTAL_A);
    expect(result.apiBaseUrl).toBe(API_A);
    // Not consumed: `platform:connect` is what commits it, and the user has not decided yet.
    expect(takeCalls).toBe(0);
  });

  it("reports nothing pending when no link arrived", async () => {
    pendingLink = null;
    expect(await invoke("platform:pendingLink")).toEqual({ pending: false });
  });

  it("flags a switch that would sign the user out", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor(POOL_B, "https://api.b.example", "https://ai.b.example");
    expect((await invoke("platform:pendingLink")).wouldSignOut).toBe(true);

    pendingLink = linkFor();
    expect((await invoke("platform:pendingLink")).wouldSignOut).toBe(false);
  });

  /**
   * ── ⚠ THE SUBSTITUTION THIS PANEL EXISTS TO CATCH ──────────────────────────────────────────
   *
   * A hostile page can send the REAL portal and the REAL API alongside an ATTACKER'S OWN Cognito pool — a
   * genuine AWS-hosted pool, so the pool-id shape, the issuer↔pool tie and `assertAwsDiscoveryHost` all pass.
   * Nothing on the panel differed from a legitimate proposal, and the pool is where the app's own SRP form
   * then sends the participant's email, password and TOTP.
   *
   * `wouldSignOut` compared ONLY `apiBaseUrl`, so this case reported `false` — no warning, a bare
   * "Connect" button — while `platform:connect` computed `changed` from the whole fingerprint and
   * voided the session anyway. The panel contradicted the commit. It now asks the same question.
   */
  it("flags a pool swap that keeps the genuine portal and API", async () => {
    signedInOnPlatformA();
    // Only the pool differs. Both origins are the ones the participant expects to see.
    pendingLink = linkFor(POOL_B, API_A, PORTAL_A);

    const result = await invoke("platform:pendingLink");

    expect(result.apiBaseUrl).toBe(API_A);
    expect(result.portalUrl).toBe(PORTAL_A);
    expect(result.wouldSignOut).toBe(true);
  });

  it("flags a client-id swap, which the fingerprint also covers", async () => {
    signedInOnPlatformA();
    pendingLink = { ...linkFor(), clientId: "clientbbbbbbbbbbbbbbbbbbbb" };

    expect((await invoke("platform:pendingLink")).wouldSignOut).toBe(true);
  });

  /** The panel cannot show what it is not told, and the pool is the field that decides trust. */
  it("reports the pool, client and region so the panel can display them", async () => {
    pendingLink = linkFor();

    const result = await invoke("platform:pendingLink");

    expect(result.poolId).toBe(POOL_A);
    expect(result.clientId).toBe(CLIENT_A);
    expect(result.region).toBe("us-east-1");
  });

  /**
   * ── ⚠ THE COMMIT NAMES THE PROPOSAL IT IS CONFIRMING ────────────────────────────────────────
   *
   * `platform:connect` took no argument and committed whatever occupied main's single mutable proposal slot
   * at that instant, while the display path merely peeked. Any web page can overwrite that slot, so the
   * origin the participant READ and the origin PERSISTED were only incidentally the same one — and a proposal
   * planted at any earlier time stayed armed indefinitely, to be re-offered on a setup screen the participant
   * reached by their own route.
   */
  it("reports the proposal's id, so the click can name what it confirmed", async () => {
    pendingLink = linkFor();
    expect((await invoke("platform:pendingLink")).linkId).toBe(PENDING_ID);
  });

  it("⚠ REFUSES a commit that does not name the current proposal", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor(POOL_B, "https://api.b.example", "https://ai.b.example");
    vi.stubGlobal("fetch", mockDiscovery(discoveryFor(POOL_B)));

    // The id the panel would have been holding for an EARLIER proposal.
    const result = await invoke("platform:connect", "a-stale-proposal-id");

    expect(result.ok).toBe(false);
    // Nothing was committed and nothing was torn down: a refusal changes no state at all.
    expect(tearDown).not.toHaveBeenCalled();
    expect(store.get("cognito_pool_id")).toBe(POOL_A);
  });

  it("⚠ REFUSES a commit that names no proposal at all", async () => {
    pendingLink = linkFor();
    expect((await invoke("platform:connect")).ok).toBe(false);
    expect((await invoke("platform:connect", "")).ok).toBe(false);
  });

  /** The diff is the part a participant can actually read; a bare pool id is not. */
  it("reports the configured platform to diff against, and null when there is none", async () => {
    pendingLink = linkFor(POOL_B);
    expect((await invoke("platform:pendingLink")).current).toBeNull();

    signedInOnPlatformA();
    expect((await invoke("platform:pendingLink")).current).toMatchObject({
      poolId: POOL_A,
      apiBaseUrl: API_A,
      region: "us-east-1",
    });
  });

  /**
   * ── ⚠ "IS THIS PROFILE ALREADY IN USE" IS A DIFFERENT QUESTION FROM "DOES THE PLATFORM CHANGE" ──
   *
   * ⚠ AND `wouldSignOut` WAS FALSE THROUGHOUT, which is why a second signal was needed rather than a
   * better warning on the first. Measured on the reporter's machine: `…-codevibranium` and
   * `…-jarvisdeploy` carry the SAME pool, client, `server_url` and `portal_url` — two workshops inside
   * ONE deployment. The link named exactly the platform that profile already had, so the fingerprint
   * matched and every platform-level check correctly said "nothing changes". The profile was still the
   * wrong place to put a second workspace.
   */
  it("⚠ flags a profile that is already in use, even when the platform does not change at all", async () => {
    signedInOnPlatformA();
    store.set("team_name", "Code Vibranium");
    profileAccounts = ["owner@example.com"];
    // The SAME platform the profile already has: this is the case that showed no warning.
    pendingLink = linkFor(POOL_A, API_A, PORTAL_A);

    const res = await invoke("platform:pendingLink");

    expect(res.wouldSignOut, "the platform genuinely does not change").toBe(false);
    expect(res.profileInUse, "but the profile is already somebody's workspace").toBe(true);
    expect(res.profileTeamName, "named, so the panel can say which one").toBe("Code Vibranium");
    expect(res.configured).toBe(true);
  });

  /** A team with no remembered account still counts — either one means the profile is in use. */
  it("counts a joined team as in-use even with no remembered account", async () => {
    signedInOnPlatformA();
    store.set("team_id", "team-1");
    profileAccounts = [];
    pendingLink = linkFor(POOL_A, API_A, PORTAL_A);

    expect((await invoke("platform:pendingLink")).profileInUse).toBe(true);
  });

  /**
   * ⚠ AND A FRESH PROFILE MUST NOT BE FLAGGED, or the panel becomes a banner people click past — the
   * failure mode TeamAccessNotice's header warns about. First-time setup is the common case.
   */
  /**
   * ── ⚠ THE BINDING FOLLOWS THE PLATFORM, AND ONLY THE PLATFORM ───────────────────────────────
   *
   * The profile's identity binding (accounts.ts) survives sign-out on purpose — signing out does not make
   * a profile stop being yours — so the two places that DO release it are the two that mean "this profile
   * is for a different experience now". The model is one profile per experience, with different email
   * addresses for different experiences or teams, so holding the binding across a platform change would
   * be a lockout rather than a guard.
   */
  it("⚠ releases the profile identity binding when the platform CHANGES", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor(POOL_B);
    vi.stubGlobal("fetch", mockDiscovery(discoveryFor(POOL_B)));

    await invoke("platform:connect", PENDING_ID);

    expect(released, "a different platform legitimately expects a different address").toBe(1);
  });

  /** And NOT when it is the same platform — which is the case the binding exists for. */
  it("⚠ keeps the binding when the same platform is re-confirmed", async () => {
    signedInOnPlatformA();
    pendingLink = linkFor(POOL_A, API_A, PORTAL_A);
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    await invoke("platform:connect", PENDING_ID);

    expect(released, "arriving via a portal link for the same deployment must not unbind").toBe(0);
  });

  /**
   * ── ⚠ THE CASE A DISCONNECT PRODUCES, WHICH EVERY OTHER SIGNAL MISSES ───────────────────────
   *
   * It could not — `platform:reset` forgets the accounts rows, the teardown clears `team_id`, and the
   * identity binding is released, all three deliberately. Measured on the reporter's machine:
   * `…-codevibranium` had zero accounts and no team and still held 1 project, 1 chat session and 6 messages.
   *
   * The work is what survives, and it is also what is at stake — two workspaces' projects and transcripts
   * interleaved in one profile is the harm, so asking "is there work here" asks about the thing itself
   * rather than a proxy the arrival flow erases.
   */
  it("⚠ flags a disconnected profile that still holds work, with no account and no team", async () => {
    profileAccounts = [];
    store.delete("team_id");
    store.delete("team_name");
    profileWorkRows = 2; // one project, one chat session
    pendingLink = linkFor(POOL_A, API_A, PORTAL_A);

    const res = await invoke("platform:pendingLink");

    expect(res.profileInUse, "the work is still here even if the credentials are not").toBe(true);
    expect(res.profileHasWork, "so the panel can say what is at stake").toBe(true);
  });

  it("⚠ does NOT flag a fresh profile", async () => {
    profileAccounts = [];
    store.delete("team_id");
    store.delete("team_name");
    pendingLink = linkFor(POOL_A, API_A, PORTAL_A);

    const res = await invoke("platform:pendingLink");

    expect(res.profileInUse, "nothing to lose here — this is ordinary setup").toBe(false);
    expect(res.configured, "and it is not connected yet either").toBe(false);
  });
});

describe("platform:reset — sign in to another experience", () => {
  beforeEach(() => {
    forgotten.length = 0;
  });

  it("clears the session AND the config, then broadcasts", async () => {
    signedInOnPlatformA();
    store.set("auth_token", "a-token");

    const result = await invoke("platform:reset");

    expect(result.ok).toBe(true);
    expect(tearDown).toHaveBeenCalledTimes(1);
    expect(store.get("cognito_pool_id") || "").toBe("");
    expect(store.get("portal_url") || "").toBe("");
    expect(sent.map((x) => x.channel)).toEqual(["platform:changed"]);
    expect(sent[0].payload).toEqual({ reason: "reset" });
  });

  /**
   * ⚠ AND IT FORGETS THE ACCOUNTS, WITH THE OUTGOING FINGERPRINT — which is why the read has to
   * happen BEFORE `clearPlatformConfig` blanks it. Read afterwards, the fingerprint would be null and
   * the delete would match the wrong set of rows.
   */
  it("forgets the saved accounts for the platform being left", async () => {
    signedInOnPlatformA();
    const leaving = store.get("platform_config_fingerprint");
    expect(leaving, "the fixture must be fingerprinted for this to mean anything").toBeTruthy();

    await invoke("platform:reset");

    expect(forgotten).toEqual([leaving]);
  });

  /**
   * ⚠ AND IT RELEASES THE PROFILE'S IDENTITY BINDING, which is the other half of forgetting the accounts.
   *
   * This is the path that produced the follow-up report: reset deletes the accounts rows, so a lock that
   * read only that table had nothing left to read — `…-codevibranium` ended up with zero rows and looked
   * like a profile nobody had used. The binding exists to survive that. Reset is also the one act that
   * SHOULD clear it, because leaving a platform means the profile is for a different experience now.
   */
  it("⚠ releases the profile identity binding too, since the experience is being left", async () => {
    signedInOnPlatformA();

    await invoke("platform:reset");

    expect(released).toBe(1);
  });
});

describe("checkPlatformDrift — local integrity", () => {
  it("is silent when the stored config matches its recorded fingerprint", () => {
    signedInOnPlatformA();
    expect(checkPlatformDrift(tearDown)).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
  });

  it("voids the session when a settings row was edited outside savePlatformConfig", () => {
    signedInOnPlatformA();
    // A hand-edited SQLite file, or a future code path writing server_url directly —
    // which is why ai:login no longer does.
    store.set("server_url", "https://attacker.example");

    expect(checkPlatformDrift(tearDown)).toBe(true);
    expect(tearDown).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.channel)).toEqual(["platform:changed"]);
  });

  /**
   * ⚠ AN INSTALL UPGRADING INTO THIS CHANGE HAS SETTINGS BUT NO FINGERPRINT, and must not
   * be signed out for it. The fingerprint is stamped on its next save or sign-in.
   */
  it("does not sign out an install that has no recorded fingerprint yet", () => {
    // A COMPLETE config with no fingerprint recorded — exactly what an install upgrading
    // into this change looks like. It must not be signed out for upgrading.
    store.set("cognito_pool_id", POOL_A);
    store.set("server_url", PARAMS_A.apiBaseUrl);
    store.set("cognito_issuer", ISSUER_A);
    store.set("cognito_client_id", CLIENT_A);
    store.set("cognito_authorization_endpoint", AUTHZ);
    store.set("cognito_token_endpoint", TOKEN);

    expect(checkPlatformDrift(tearDown)).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
  });

  it("does nothing on an unconfigured install", () => {
    expect(checkPlatformDrift(tearDown)).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
  });
});

describe("recheckPlatformFromServer — rotation detection", () => {
  it("voids the session when the pool's endpoints have moved", async () => {
    signedInOnPlatformA();
    // The rotation: same pool id, but AWS now reports a different authorize endpoint —
    // what a custom auth domain being added or removed actually looks like.
    vi.stubGlobal(
      "fetch",
      mockDiscovery(
        discovery({
          authorization_endpoint: "https://rotated.auth.us-east-1.amazoncognito.com/oauth2/authorize",
        })
      )
    );

    expect(await recheckPlatformFromServer(tearDown)).toBe(true);
    expect(tearDown).toHaveBeenCalledTimes(1);
  });

  it("is silent when the portal reports the same platform", async () => {
    signedInOnPlatformA();
    vi.stubGlobal("fetch", mockDiscovery(discovery()));

    expect(await recheckPlatformFromServer(tearDown)).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
  });

  /**
   * ⚠ FAILS OPEN, AND THIS IS THE MOST IMPORTANT TEST IN THE BLOCK.
   *
   * "The portal is briefly unreachable" is overwhelmingly more common than "the pool was
   * rotated". Treating them the same would sign people out of a working session every time
   * their network hiccuped — and the undetected-rotation case is already handled by the
   * existing 401 → refresh → auth:expired path.
   */
  it("does NOT sign out on a network failure", async () => {
    signedInOnPlatformA();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);

    expect(await recheckPlatformFromServer(tearDown)).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
    expect(store.get("auth_token")).toBe("a-token");
  });

  it("does NOT sign out on a 5xx from the portal", async () => {
    signedInOnPlatformA();
    vi.stubGlobal("fetch", mockDiscovery(discovery(), { status: 503 }));

    expect(await recheckPlatformFromServer(tearDown)).toBe(false);
    expect(tearDown).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THROTTLED, so the 15-second status poll cannot become a request per client every
   * 15 seconds. The stamp is taken BEFORE the await, so two overlapping polls cannot both
   * pass the gate.
   */
  it("hits the network at most once per interval", async () => {
    signedInOnPlatformA();
    const fetchMock = mockDiscovery(discovery());
    vi.stubGlobal("fetch", fetchMock);

    await recheckPlatformFromServer(tearDown);
    await recheckPlatformFromServer(tearDown);
    await recheckPlatformFromServer(tearDown);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks again once the interval has elapsed — a throttle, not a one-shot", () => {
    // Without this, the test above would still pass if the re-check ran exactly once ever
    // and then never again, which would silently disable rotation detection for the life
    // of the process.
    signedInOnPlatformA();
    const fetchMock = mockDiscovery(discovery());
    vi.stubGlobal("fetch", fetchMock);

    return recheckPlatformFromServer(tearDown)
      .then(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.setSystemTime(simulatedNow + 16 * 60 * 1000);
        return recheckPlatformFromServer(tearDown);
      })
      .then(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
  });

  it("does nothing on an unconfigured install", async () => {
    const fetchMock = mockDiscovery(discovery());
    vi.stubGlobal("fetch", fetchMock);

    expect(await recheckPlatformFromServer(tearDown)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
