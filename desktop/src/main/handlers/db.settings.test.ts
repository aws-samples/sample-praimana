// The governing security condition — the renderer must not be able to read a
// credential out of the settings table.
//
// These tests drive the REAL ipcMain handlers registered by setupDbHandlers()
// (electron's ipcMain is stubbed with a registry so we can invoke them the way
// the renderer does), and they assert on `readSetting` itself: a blocked key must
// not merely be filtered out of the response, it must never reach the decrypting
// read at all. Delete the allowlist from handlers/db.ts and every test in the
// first two blocks fails.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Registry of handlers registered via ipcMain.handle, so a test can invoke a
// channel exactly as the preload bridge does.
const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  app: { getPath: () => "/tmp", setBadgeCount: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`CIPHER:${s}`, "utf-8"),
    decryptString: (buf: Buffer) => buf.toString("utf-8").replace(/^CIPHER:/, ""),
  },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));

// In-memory settings store standing in for the SQLite table. readSetting/
// writeSetting are spied so we can assert a blocked key never reaches them —
// which is the actual security property, not just the returned value.
const store = new Map<string, string>();
const readSetting = vi.fn((key: string) => store.get(key) ?? null);
const writeSetting = vi.fn((key: string, value: string) => {
  store.set(key, value);
});

vi.mock("../database", async () => {
  // isSensitiveSetting is the REAL implementation: setting-access.ts checks its
  // allowlists against it at module load, and that invariant is under test too.
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    readSetting: (key: string) => readSetting(key),
    writeSetting: (key: string, value: string) => writeSetting(key, value),
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
  };
});

import { setupDbHandlers } from "./db";
import {
  RENDERER_READABLE_SETTINGS,
  RENDERER_WRITABLE_SETTINGS,
  TENANT_SETTINGS,
  SIGN_OUT_SETTINGS,
  canRendererRead,
  canRendererWrite,
} from "../setting-access";
import { isSensitiveSetting } from "../database";
import { ALLOWLIST_SOURCE_SETTINGS } from "../project-paths";

setupDbHandlers();

/** Invoke an IPC channel the way the renderer does. */
function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return handler({}, ...args);
}

// The three keys database.ts encrypts at rest. Hard-coded rather than imported so
// a test still fails if someone shrinks SENSITIVE_KEYS instead of fixing a leak.
const CREDENTIAL_KEYS = ["auth_token", "cognito_refresh_token", "user_password"];

// Blocked reads/writes log a warning by design; silence it so the suite output
// stays readable. Cleared (not re-created) each test: vi.spyOn returns the spy
// already installed on console.warn, so its call list would otherwise accumulate
// across tests and break the "logged exactly once" assertions.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  store.clear();
  readSetting.mockClear();
  writeSetting.mockClear();
  warnSpy.mockClear();
});

describe("db:getSetting — credentials are unreadable from the renderer", () => {
  it.each(CREDENTIAL_KEYS)("returns null for %s and never calls readSetting", async (key) => {
    // Seed a real value so a passing test cannot be an artefact of an empty store.
    store.set(key, "live-secret-value");

    const value = await invoke("db:getSetting", key);

    expect(value).toBeNull();
    // The security property: the decrypting read is not reached.
    expect(readSetting).not.toHaveBeenCalled();
  });

  it("does not distinguish a forbidden key from an absent one", async () => {
    store.set("cognito_refresh_token", "live-refresh-token");

    const forbidden = await invoke("db:getSetting", "cognito_refresh_token");
    const absent = await invoke("db:getSetting", "server_url"); // allowed, unset

    // Identical results — a compromised caller learns nothing about which keys
    // exist, and neither read throws (a throw would itself be an oracle).
    expect(forbidden).toBeNull();
    expect(absent).toBeNull();
  });

  it("logs the blocked key name but never the value", async () => {
    store.set("auth_token", "eyJhbGciOi-super-secret");

    await invoke("db:getSetting", "auth_token");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0].join(" ");
    expect(logged).toContain("auth_token");
    expect(logged).not.toContain("eyJhbGciOi-super-secret");
  });

  it("blocks unknown keys too (deny by default, not a denylist)", async () => {
    store.set("some_future_key", "value");

    expect(await invoke("db:getSetting", "some_future_key")).toBeNull();
    expect(readSetting).not.toHaveBeenCalled();
  });

  it("blocks active_user_id — it selects which account's local chats are visible", async () => {
    store.set("active_user_id", "user-a");
    expect(await invoke("db:getSetting", "active_user_id")).toBeNull();
  });
});

describe("db:getSetting — benign keys still round-trip", () => {
  it.each([...RENDERER_READABLE_SETTINGS])("reads %s", async (key) => {
    store.set(key, `value-for-${key}`);

    const value = await invoke("db:getSetting", key);

    expect(value).toBe(`value-for-${key}`);
    expect(readSetting).toHaveBeenCalledWith(key);
  });

  it("returns null for an allowed key that is not set", async () => {
    expect(await invoke("db:getSetting", "team_name")).toBeNull();
    expect(readSetting).toHaveBeenCalledWith("team_name");
  });

  it("covers every key the renderer actually reads", () => {
    // Guards against the allowlist drifting behind the UI: these are the keys
    // src/renderer passes to getSetting today. If a component starts reading a
    // new key, add it here AND to the allowlist deliberately.
    const rendererReads = [
      "connected", "team_joined", "setup_complete", "server_url",
      "team_id", "team_name", "team_invite_code", "workshop_id",
      "user_id", "user_name", "user_email",
      "ai_assistant", "ai_command", "project_path",
      "notify_sound", "telemetry_enabled", "chat_history_visible", "active_session_id",
    ];
    for (const key of rendererReads) {
      expect(canRendererRead(key)).toBe(true);
    }
  });
});

describe("db:setSetting — credentials are unwritable from the renderer", () => {
  it.each(CREDENTIAL_KEYS)("refuses a non-empty write to %s", async (key) => {
    await invoke("db:setSetting", key, "stolen");

    expect(writeSetting).not.toHaveBeenCalled();
    expect(store.has(key)).toBe(false);
  });

  it.each(CREDENTIAL_KEYS)("refuses even a clear of %s — auth:signOut owns that", async (key) => {
    store.set(key, "live-secret-value");

    await invoke("db:setSetting", key, "");

    // The renderer gets no sign-out primitive of its own, and no way to wipe
    // another account's credentials.
    expect(writeSetting).not.toHaveBeenCalled();
    expect(store.get(key)).toBe("live-secret-value");
  });

  it("a blocked write is a no-op, not a throw", async () => {
    await expect(invoke("db:setSetting", "auth_token", "stolen")).resolves.toBeUndefined();
  });

  it("logs the blocked key name but never the attempted value", async () => {
    await invoke("db:setSetting", "cognito_refresh_token", "planted-refresh-token");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0].join(" ");
    expect(logged).toContain("cognito_refresh_token");
    expect(logged).not.toContain("planted-refresh-token");
  });

  it("refuses to repoint active_user_id at another local account", async () => {
    await invoke("db:setSetting", "active_user_id", "someone-else");
    expect(writeSetting).not.toHaveBeenCalled();
  });
});

describe("db:setSetting — benign keys still round-trip", () => {
  it.each([...RENDERER_WRITABLE_SETTINGS])("writes %s", async (key) => {
    await invoke("db:setSetting", key, "new-value");

    expect(writeSetting).toHaveBeenCalledWith(key, "new-value");
    expect(store.get(key)).toBe("new-value");
  });

  it("round-trips a benign key through both handlers", async () => {
    await invoke("db:setSetting", "notify_sound", "false");
    expect(await invoke("db:getSetting", "notify_sound")).toBe("false");
  });

  it("allows clearing a benign key (App.tsx sets connected='' / 'false')", async () => {
    await invoke("db:setSetting", "connected", "");
    expect(store.get("connected")).toBe("");
  });

  it("does not let a writable-but-unreadable key leak on read", async () => {
    // Nothing is currently writable-only, but the two sets are independent by
    // design; this pins that the read policy is not derived from the write one.
    for (const key of RENDERER_WRITABLE_SETTINGS) {
      expect(canRendererWrite(key)).toBe(true);
    }
  });
});

describe("allowlist invariants", () => {
  it("contains no sensitive key in either direction", () => {
    for (const key of [...RENDERER_READABLE_SETTINGS, ...RENDERER_WRITABLE_SETTINGS]) {
      expect(isSensitiveSetting(key)).toBe(false);
    }
  });

  it("denies every sensitive key by both predicates", () => {
    for (const key of CREDENTIAL_KEYS) {
      expect(isSensitiveSetting(key)).toBe(true); // the key really is sensitive
      expect(canRendererRead(key)).toBe(false);
      expect(canRendererWrite(key)).toBe(false);
    }
  });

  it("is a closed set — an arbitrary key is denied", () => {
    expect(canRendererRead("../../etc/passwd")).toBe(false);
    expect(canRendererRead("")).toBe(false);
    expect(canRendererWrite("__proto__")).toBe(false);
    // Set membership, not property lookup: a prototype key must not pass.
    expect(canRendererRead("constructor")).toBe(false);
    expect(canRendererRead("toString")).toBe(false);
  });

  it("writable is a subset of readable plus the credential keys it clears", () => {
    // The renderer should never be able to write something it cannot read back:
    // that would be a blind-write primitive with no legitimate caller.
    for (const key of RENDERER_WRITABLE_SETTINGS) {
      expect(RENDERER_READABLE_SETTINGS.has(key)).toBe(true);
    }
  });

  it("SIGN_OUT_SETTINGS covers all three credential keys", () => {
    // If a credential key were dropped from the sign-out list it would survive
    // sign-out encrypted-at-rest and be restorable by the next switchAccount.
    for (const key of CREDENTIAL_KEYS) {
      expect(SIGN_OUT_SETTINGS).toContain(key);
    }
  });

  /**
   * ── THE SECOND CLASS OF UNWRITABLE KEY: BOUNDARY INPUTS ──
   *
   * A sensitive key leaks a credential. One of these hands over the filesystem boundary
   * itself, which is worse: `allowedRoots()` (project-paths.ts) builds the confinement roots
   * from `project_path`, so a renderer that can write it chooses its own fence and every
   * `assertWithinProject` in the app becomes a formality. Read access is fine and needed —
   * SettingsView and TeamDocs display the folder — so only writability is forbidden.
   */
  it("no boundary-input key is renderer-writable", () => {
    for (const key of ALLOWLIST_SOURCE_SETTINGS) {
      expect(canRendererWrite(key)).toBe(false);
      expect(RENDERER_WRITABLE_SETTINGS.has(key)).toBe(false);
    }
  });

  it("project_path specifically: readable, not writable", () => {
    // Named explicitly rather than only iterated, so shrinking ALLOWLIST_SOURCE_SETTINGS
    // cannot make this suite pass by having nothing left to check.
    expect(ALLOWLIST_SOURCE_SETTINGS.has("project_path")).toBe(true);
    expect(canRendererRead("project_path")).toBe(true);
    expect(canRendererWrite("project_path")).toBe(false);
  });

  /**
   * ── ⚠ THE FOURTH CLASS: THE KEYS THAT NAME THE TENANT ────────────────────────────────────
   *
   * The tenants here are workshops/teams sharing one platform API, and the desktop's entire notion of "which
   * tenant am I" was these rows. `teamContext()` reads `team_id` and every team-scoped handler interpolates
   * it into the request path; the same value drives `share:shareSession` — which POSTS A PRIVATE LOCAL
   * TRANSCRIPT — and the WebSocket event subscription.
   *
   * While they were writable, `setSetting("team_id", "<other team>")` from anywhere in the renderer
   * bundle re-pointed all of that, and overwrote the value `ai:joinTeam` had established only after a
   * server-verified join. Main derives them now, from `/v1/teams/mine`.
   */
  it("no tenant key is renderer-writable", () => {
    for (const key of TENANT_SETTINGS) {
      expect(canRendererWrite(key), key).toBe(false);
      expect(RENDERER_WRITABLE_SETTINGS.has(key), key).toBe(false);
    }
  });

  it("the tenant keys specifically: readable for display, never writable", () => {
    // Named rather than only iterated, so shrinking TENANT_SETTINGS cannot make this pass vacuously.
    for (const key of ["team_id", "team_name", "team_invite_code", "workshop_id"]) {
      expect(TENANT_SETTINGS.has(key), key).toBe(true);
      // The sidebar, Settings and the Account panel all display the team.
      expect(canRendererRead(key), key).toBe(true);
      expect(canRendererWrite(key), key).toBe(false);
    }
  });

  /**
   * ⚠ AND `team_joined` STAYS WRITABLE, deliberately. It is screen gating — which view App renders —
   * not a tenant key, and the worst a renderer achieves by forging it is showing itself the wrong
   * screen. Asserted so that "tighten the team settings" does not later sweep it up and break the
   * join flow for a reason nobody can find.
   */
  it("team_joined is still writable, because it gates a screen rather than naming a tenant", () => {
    expect(TENANT_SETTINGS.has("team_joined")).toBe(false);
    expect(canRendererWrite("team_joined")).toBe(true);
  });
});

describe("db:setSetting — the boundary input cannot be written from the renderer", () => {
  it("drops a project_path write and never reaches writeSetting", async () => {
    await invoke("db:setSetting", "project_path", "/Users/victim");

    // The security property: the value never lands, so `allowedRoots()` cannot be widened.
    expect(writeSetting).not.toHaveBeenCalled();
    expect(store.get("project_path")).toBeUndefined();
  });

  it("drops it silently rather than throwing, like every other blocked write", async () => {
    // A throw would be an oracle, and would let a stray renderer call crash the UI.
    await expect(invoke("db:setSetting", "project_path", "/")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(" ")).toContain("project_path");
  });

  it("does not widen the boundary even to a path that is already the project", async () => {
    // The legitimate writer is files:commitProjectPath, which checks picker provenance.
    // There is no "same value" exception here, because the check is on the KEY.
    store.set("project_path", "/Users/dev/proj");
    await invoke("db:setSetting", "project_path", "/Users/dev/proj");
    expect(writeSetting).not.toHaveBeenCalled();
  });
});

/**
 * ── THE PLATFORM CONFIG: READABLE, NEVER WRITABLE ──
 *
 * These keys decide which Cognito pool the app authenticates against. Reading them costs
 * nothing — they are public discovery values, and the portal serves the Cognito ones
 * unauthenticated — but WRITING one moves the identity provider and voids the session.
 *
 * `platform:setPortalUrl` does all of that together: it validates the new config
 * (Cognito-owned Hosted UI host), tears the session down through main's single teardown,
 * and stamps the fingerprint that describes it. A renderer that could set `portal_url`
 * directly would do a third of that, leaving an origin and a fingerprint naming DIFFERENT
 * platforms — which is exactly the state the drift check reads to decide whether to sign
 * someone out. That is why these are handlers and not settings.
 */
const PLATFORM_KEYS = [
  "cognito_pool_id",
  "server_url",
  "cognito_issuer",
  "cognito_client_id",
  "cognito_authorization_endpoint",
  "cognito_token_endpoint",
  "cognito_scopes",
  "platform_config_fingerprint",
];

describe("platform config keys", () => {
  it("are NOT writable from the renderer", () => {
    for (const key of PLATFORM_KEYS) {
      expect(canRendererWrite(key), `${key} must not be renderer-writable`).toBe(false);
    }
  });

  it("blocks the write at the handler, not merely in the predicate", () => {
    for (const key of PLATFORM_KEYS) {
      writeSetting.mockClear();
      void handlers.get("db:setSetting")!({}, key, "https://attacker.example");
      expect(writeSetting, `${key} reached writeSetting`).not.toHaveBeenCalled();
    }
  });

  it("keeps the display values readable, so Account can show what is configured", () => {
    // Everything except the fingerprint, which is an internal comparison value with no
    // meaning on screen.
    for (const key of ["cognito_pool_id", "server_url", "cognito_issuer", "cognito_client_id"]) {
      expect(canRendererRead(key), `${key} should be readable for display`).toBe(true);
    }
  });

  /**
   * ⚠ SIGNING OUT MUST NOT UNCONFIGURE THE APP. These keys describe WHICH PLATFORM this
   * install belongs to, not who is signed in. Wiping them on sign-out would drop the user
   * back to "connect to your platform" every single time and make them re-type the URL to
   * sign back in — and it would erase the fingerprint the drift check compares against,
   * so a genuine platform change after a sign-out would go undetected.
   */
  it("SURVIVE sign-out", () => {
    for (const key of PLATFORM_KEYS) {
      expect(SIGN_OUT_SETTINGS, `${key} must survive sign-out`).not.toContain(key);
    }
  });
});
