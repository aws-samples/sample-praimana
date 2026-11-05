// ── ⚠ ONE DEAD SESSION IS ONE EVENT, NOT ONE PER REQUEST ────────────────────────────────────────
//
//   [team-data] team:checkAccess: the session could not be renewed (HTTP 401)
//   [cli-assistant] sync failed (ai-chat): message sync failed: HTTP 401 — {"message":"Unauthorized"}
//   [sync-sweep] attempted 1, recovered 0, failed 1, 1 row(s) still unsynced
//
// `fetchAuthed` wraps every authenticated call, and its `onAuthExpired` broadcast `auth:expired` each time a
// refresh failed. The callers are POLLERS — `chat:getTeamMessages` every 5 seconds, `team:checkAccess`, the
// board, the phases, the startup sweep — and App.tsx shows a toast per broadcast. So one dead session emitted
// an unbounded stream of identical alerts.
//
// ⚠ THE POLLING IS NOT THE DEFECT. It is supposed to poll; the defect is reporting a repeated CONDITION as
// repeated EVENTS — the same shape as the audit-log flood, and `noteFailure` in team-data.ts already reached
// this conclusion for its console lines by deduping per (channel, reason). This is the broadcast it could not
// dedupe from over there.

import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
/** Every `webContents.send` the module made, so a test can count the broadcasts. */
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
        webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
      },
    ],
  },
  app: { getPath: () => "/tmp", setBadgeCount: vi.fn(), getVersion: () => "0.0.0-test" },
  safeStorage: { isEncryptionAvailable: () => true },
  shell: { openExternal: vi.fn() },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("ws", () => ({ default: class {} }));

const store = new Map<string, string>();
vi.mock("../database", async () => {
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    EncryptionUnavailableError: actual.EncryptionUnavailableError,
    isSecretStorageAvailable: () => true,
    assertSecretStorageAvailable: () => {},
    readSetting: (key: string) => store.get(key) ?? null,
    writeSetting: (key: string, value: string) => {
      store.set(key, value);
    },
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
  };
});

vi.mock("../accounts", () => ({
  upsertActiveAccount: vi.fn(),
  syncActiveAccountFromSettings: vi.fn(),
  listAccounts: vi.fn(() => ({ accounts: [], activeUserId: null })),
  switchAccount: vi.fn(() => ({ ok: true })),
  removeAccount: vi.fn(() => ({ ok: true })),
  profileIdentity: vi.fn(() => ({ count: 0, onlyEmail: null })),
  isForeignToProfile: vi.fn(() => false),
  bindProfileIdentity: vi.fn(),
  releaseProfileIdentity: vi.fn(),
}));

vi.mock("../cognito-oauth", () => ({ loginWithHostedUi: vi.fn() }));

vi.mock("../cognito-refresh", () => ({
  refreshViaCognitoIdp: vi.fn(async () => null),
  revokeRefreshToken: vi.fn(async () => {}),
}));

const { fetchAuthed, adoptSession, tearDownSession } = await import("./ai");

const expiredBroadcasts = () => sent.filter((s) => s.channel === "auth:expired").length;

beforeEach(() => {
  /**
   * ⚠ THE LATCH IS MODULE STATE, so it has to be reset between cases — the same property that makes it
   * work across the pollers makes it leak across tests. `tearDownSession` is the production reset, so using
   * it here keeps the harness honest rather than reaching into the module.
   */
  tearDownSession();
  store.clear();
  sent.length = 0;
  // A stored session that the server will reject and the refresh cannot save.
  store.set("auth_token", "dead-token");
  store.set("cognito_refresh_token", "dead-refresh");
  store.set("cognito_pool_id", "us-east-1_Abc123");
  store.set("cognito_client_id", "client-1");
});

/** Anything authenticated: every one of them goes through `fetchAuthed`. */
const poll = () =>
  fetchAuthed(async () => new Response("{\"message\":\"Unauthorized\"}", { status: 401 })).catch(
    () => undefined
  );

describe("⚠ a dead session is announced once, however many requests notice it", () => {
  it("broadcasts auth:expired on the first failure", async () => {
    await poll();
    expect(expiredBroadcasts()).toBe(1);
  });

  /**
   * Twenty polls is a couple of minutes of `chat:getTeamMessages` at its five-second interval — the
   * participant saw far more than twenty.
   */
  it("⚠ does not broadcast again for twenty more failing requests", async () => {
    for (let i = 0; i < 20; i++) await poll();
    expect(expiredBroadcasts(), "one condition, one event").toBe(1);
  });

  /**
   * ⚠ AND THE LATCH REOPENS, because a latch that never does would silence the SECOND expiry of a long
   * session — a worse failure than the flood, and a silent one.
   */
  it("⚠ announces the next death after a new session is adopted", async () => {
    for (let i = 0; i < 5; i++) await poll();
    expect(expiredBroadcasts()).toBe(1);

    adoptSession({
      idToken: "fresh",
      refreshToken: "fresh-refresh",
      userId: "user-1",
      email: "owner@example.com",
      name: "Owner",
    });

    await poll();
    expect(expiredBroadcasts(), "the new session's expiry is its own event").toBe(2);
  });

  it("announces again after a teardown, for the same reason", async () => {
    await poll();
    tearDownSession();
    await poll();
    expect(expiredBroadcasts()).toBe(2);
  });
});

/**
 * ── ⚠ AND NOTHING SPENDS A REQUEST ON A SESSION KNOWN TO BE DEAD ────────────────────────────────
 *
 * Every guard that existed tested PRESENCE: App.tsx on `team_joined`, the views on `connected`,
 * `teamContext()` on `server_url` + `team_id`, the sweep on `auth_token`. A 401'd session has all of them,
 * because they are cleared by an explicit sign-out and not by a failed refresh.
 */
describe("⚠ a dead session stops the pollers, not just the alerts", () => {
  it("reports the credential as unusable once a refresh has failed", async () => {
    const { isSessionUsable, refreshHasFailed } = await import("../session-liveness");
    expect(isSessionUsable(), "a stored token, nothing proved wrong yet").toBe(true);
    expect(refreshHasFailed()).toBe(false);

    await poll();

    expect(isSessionUsable(), "the refresh failed, so it is not worth a request").toBe(false);
    expect(refreshHasFailed()).toBe(true);
  });

  it("becomes usable again the moment a session is adopted", async () => {
    const { isSessionUsable } = await import("../session-liveness");
    await poll();
    expect(isSessionUsable()).toBe(false);

    adoptSession({
      idToken: "fresh",
      refreshToken: "fresh-refresh",
      userId: "user-1",
      email: "owner@example.com",
      name: "Owner",
    });

    expect(isSessionUsable(), "a new sign-in restores every reader immediately").toBe(true);
  });

  /**
   * ⚠ AND `refreshHasFailed` IS NARROWER THAN `!isSessionUsable`, deliberately. team-data.ts reports "no
   * token at all" as `no-session` — which shows a banner naming the profile — and "token that no longer
   * works" as `signed-out`, which shows none because this very broadcast owns that message. The first
   * version of the guard used `!isSessionUsable()` and collapsed the two, silently withdrawing the banner
   * added for the blank-phases report.
   */
  it("⚠ distinguishes an absent token from a dead one", async () => {
    const { isSessionUsable, refreshHasFailed } = await import("../session-liveness");
    store.delete("auth_token");

    expect(isSessionUsable(), "nothing stored, so nothing to spend").toBe(false);
    expect(refreshHasFailed(), "but no refresh has failed — this is 'never signed in'").toBe(false);
  });
});
