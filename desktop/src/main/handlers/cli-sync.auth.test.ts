// ── ⚠ THE TWO DEFECTS THAT KEPT TRANSCRIPTS OFF THE PORTAL ───────────────────────────────
//
// Both reported from a live session, both in `syncToServer`, and neither was reachable by the existing
// `cli-sync.test.ts` — which asserts against a LOCAL COPY of `checkedFetch` rather than the module, so
// no change to the real function can fail it. These drive the exported `syncCliTurn` instead.
//
//   1. HTTP 401. `[cli-assistant] sync failed (ai-chat): message sync failed: HTTP 401 —
//      {"message":"Unauthorized"}`, twice in one log. This module read `auth_token` ONCE and sent it
//      raw. This pool issues ID tokens valid for **30 MINUTES** (`IdTokenValidity: 30`, units minutes)
//      and the desktop sends the idToken as its bearer — so half an hour into any session every sync
//      401s, and it stays broken until some unrelated `ai.ts` call happens to refresh the stored token.
//      The refresh-and-retry wrapper already existed (`fetchAuthed` → `fetchWithAuthRetry`, used at ~50
//      sites across `ai.ts` and `team-data.ts`); this module simply did not use it.
//
//   2. A STOPPED TURN SYNCED NOTHING. The turn was only ever sent as a user+assistant PAIR, so
//      pressing Stop before the first token sent neither half and the question vanished from the portal.
//
// ⚠ THE REAL `fetchWithAuthRetry` IS USED BELOW, not a stub of it. Mocking the retry away would leave
// this file asserting that cli-sync calls a function, which is not the property that broke.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithAuthRetry } from "../with-auth-retry";

const settings: Record<string, string | null> = {};

vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("../database", () => ({
  readSetting: (k: string) => settings[k] ?? null,
}));
vi.mock("../debug-log", () => ({ debugLog: vi.fn() }));

/** Records which rows were stamped, and with what — the observable half of migration 11. */
const stamped: Array<{ ids: readonly string[]; status: string }> = [];
let stampThrows = false;
/** Real local times, keyed by row id — set by a test that cares, empty otherwise. */
let messageTimes: Record<string, string> = {};

vi.mock("../message-sync-status", () => ({
  readMessageTimes: () => messageTimes,
  SYNC_PENDING: "pending",
  SYNC_SYNCED: "synced",
  SYNC_FAILED: "failed",
  markMessagesSynced: (ids: readonly string[]) => {
    if (stampThrows) throw new Error("database is locked");
    stamped.push({ ids, status: "synced" });
  },
  markMessagesFailed: (ids: readonly string[]) => {
    if (stampThrows) throw new Error("database is locked");
    stamped.push({ ids, status: "failed" });
  },
}));

/**
 * `fetchAuthed` is mocked to the REAL retry helper wired to a scripted refresher — so the 401 → refresh
 * → retry path actually executes here, exactly as it does in `ai.ts`.
 */
let currentToken = "expired-token";
let refreshCount = 0;
let refreshSucceeds = true;

vi.mock("./ai", () => ({
  fetchAuthed: (build: (token: string) => Promise<Response>) =>
    fetchWithAuthRetry({
      getToken: () => currentToken,
      refresh: async () => {
        refreshCount++;
        if (!refreshSucceeds) return null;
        currentToken = "fresh-token";
        return currentToken;
      },
      doFetch: build,
    }),
}));

const { syncCliTurn } = await import("./cli-sync");

interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: Record<string, unknown>;
}

let calls: Call[] = [];
/** Per-URL scripted status, keyed by a substring of the path. */
let statusFor: (url: string) => number;

beforeEach(() => {
  settings.server_url = "https://api.example.com";
  settings.auth_token = "expired-token";
  settings.team_id = "team-1";
  currentToken = "expired-token";
  refreshCount = 0;
  refreshSucceeds = true;
  calls = [];
  messageTimes = {};
  stamped.length = 0;
  stampThrows = false;
  statusFor = () => 200;

  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      auth: headers.Authorization,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const status = statusFor(String(url));
    // The thread probe reads `.messages`, so a 200 must be valid JSON with that shape.
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status })
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const syncOf = () => calls.find((c) => c.url.includes("/sync"));
const turn = (over: Partial<Parameters<typeof syncCliTurn>[0]> = {}) => ({
  sessionId: "s1",
  userMessage: "why is the build red?",
  assistantMessage: "because the lockfile drifted",
  aiProvider: "claude",
  ...over,
});

// ─── 1. THE 401 ──────────────────────────────────────────────────────────────────────

describe("⚠ an expired bearer is refreshed and the sync retried", () => {
  /**
   * Before the fix this logged `message sync failed: HTTP 401` and the turn stayed local for ever.
   */
  it("recovers from a 401 on the message sync", async () => {
    let seen = 0;
    statusFor = (url) => (url.includes("/sync") && seen++ === 0 ? 401 : 200);

    await syncCliTurn(turn());

    expect(refreshCount).toBe(1);
    const syncCalls = calls.filter((c) => c.url.includes("/sync"));
    expect(syncCalls).toHaveLength(2);
    // The retry carries the NEW token — a retry with the same dead bearer would 401 identically.
    expect(syncCalls[0].auth).toBe("Bearer expired-token");
    expect(syncCalls[1].auth).toBe("Bearer fresh-token");
  });

  /**
   * ⚠ THE PROBE IS AUTHENTICATED TOO. It is deliberately unchecked (a 404 means "no thread yet"), so a
   * 401 there would be read as "not 404, not ok" and silently skip thread creation — a first turn that
   * never creates its thread, which is a different and harder failure to see.
   */
  it("refreshes on a 401 from the thread probe as well", async () => {
    let seen = 0;
    statusFor = (url) => (url.includes("/messages") && seen++ === 0 ? 401 : 200);

    await syncCliTurn(turn());

    expect(refreshCount).toBe(1);
    expect(calls.filter((c) => c.url.includes("/messages"))).toHaveLength(2);
  });

  it("sends the bearer from the token authority, never a stale stored one", async () => {
    // The setting is deliberately different from what the authority hands out: a regression that read
    // `auth_token` directly again would send "stored-and-stale" and this would catch it.
    settings.auth_token = "stored-and-stale";
    currentToken = "authority-token";

    await syncCliTurn(turn());

    expect(calls.every((c) => c.auth === "Bearer authority-token")).toBe(true);
  });

  /**
   * ⚠ AN UNRECOVERABLE SESSION IS STILL REPORTED, NOT RETRIED FOR EVER. `fetchWithAuthRetry` returns
   * the original 401 when the refresh fails, and `checkedFetch` turns that into the toast — so the
   * participant learns their session ended instead of the sync failing silently.
   */
  it("reports the failure when the refresh itself fails", async () => {
    refreshSucceeds = false;
    statusFor = () => 401;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncCliTurn(turn());

    /**
     * TWO, not one, and that is `fetchWithAuthRetry` working as designed rather than a leak: retry is
     * per-REQUEST, so the thread probe and the message sync each attempt one refresh before giving up.
     * With a genuinely dead session that is two Cognito calls and then the toast — the same cost every
     * other `fetchAuthed` call site already pays, and far cheaper than a shared retry that could mask
     * which hop failed.
     */
    expect(refreshCount).toBe(2);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/401/);
    warn.mockRestore();
  });

  it("never throws, whatever happens — a failed sync must not fail the turn", async () => {
    statusFor = () => 500;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(syncCliTurn(turn())).resolves.toBeUndefined();
  });
});

// ─── 2. THE STOPPED TURN ─────────────────────────────────────────────────────────────

describe("⚠ a stopped turn still records the person's own message", () => {
  /**
   * The user's row exists locally (AssistantChatView writes it before sending); what was missing was any sync
   * at all, so the portal showed nothing.
   */
  it("sends the user message alone when there is no reply", async () => {
    await syncCliTurn(turn({ assistantMessage: "" }));

    const body = syncOf()!.body!;
    expect(body.messages).toEqual([{ role: "user", content: "why is the build red?" }]);
  });

  /**
   * ⚠ OMITTED, NOT BLANKED. `POST /v1/ai/threads/:id/sync` rejects any message with empty content
   * (400 "each message needs non-empty content"), so sending a placeholder assistant row would fail
   * the whole request and lose the user's message again by another route.
   */
  it("omits the assistant message rather than sending an empty one", async () => {
    await syncCliTurn(turn({ assistantMessage: "   " }));

    const messages = syncOf()!.body!.messages as Array<{ role: string }>;
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
  });

  /**
   * ⚠ AND THAT OMISSION IS WHAT KEEPS THE RANKING HONEST. The service derives `aiTurns` from the count
   * of ASSISTANT messages, so a user-only sync credits zero — which is the property the original
   * "don't sync an empty reply" gate was protecting. It protected it by dropping the evidence; this
   * keeps the evidence and still credits nothing.
   */
  it("carries no latency for a turn that produced no reply", async () => {
    await syncCliTurn(turn({ assistantMessage: "", latencyMs: 4321 }));

    const messages = syncOf()!.body!.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("latencyMs");
  });

  it("still sends BOTH halves for a normal completed turn", async () => {
    // The regression guard: the fix must not reduce a working turn to its user half.
    await syncCliTurn(turn({ latencyMs: 1500 }));

    const messages = syncOf()!.body!.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "because the lockfile drifted",
      latencyMs: 1500,
    });
  });

  it("titles a newly created thread from the user's message", async () => {
    // A stopped first turn still needs a thread to hang off, and the only text available to name it
    // with is what the participant typed.
    statusFor = (url) => (url.includes("/messages") ? 404 : 200);

    await syncCliTurn(turn({ assistantMessage: "" }));

    const create = calls.find((c) => c.url.includes("/threads") && c.method === "POST");
    expect(create!.body).toMatchObject({ id: "s1", title: "why is the build red" });
  });
});

describe("the preconditions are unchanged", () => {
  it.each(["server_url", "auth_token", "team_id"])(
    "skips the sync entirely when %s is missing",
    async (key) => {
      settings[key] = null;

      await syncCliTurn(turn());

      expect(calls).toEqual([]);
    }
  );
});

// ─── 3. THE LOCAL RECORD: DID IT TRAVEL? ─────────────────────────────────────────────
//
// Migration 11 adds `sync_status` / `synced_at` to `chat_messages`. The column exists because both
// failures above were invisible in the same way: the row was written locally and nothing said whether
// it had reached the server. These pin the transitions.

describe("⚠ each message records whether it reached the server", () => {
  const ids = { userMessageId: "u-1", assistantMessageId: "a-1" };

  it("stamps BOTH halves synced when the push succeeds", async () => {
    await syncCliTurn(turn(ids));

    expect(stamped).toEqual([{ ids: ["u-1", "a-1"], status: "synced" }]);
  });

  /**
   * ⚠ WRITTEN FROM THE OUTCOME, NOT OPTIMISTICALLY BEFORE THE PUSH. An optimistic 'synced' is worse
   * than no column: it is a positive claim that the transcript is complete, made by the code that does
   * not yet know whether it is.
   */
  it("stamps them failed when the server refuses", async () => {
    statusFor = () => 500;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncCliTurn(turn(ids));

    expect(stamped).toEqual([{ ids: ["u-1", "a-1"], status: "failed" }]);
  });

  it("stamps only the user's row for a stopped turn", async () => {
    // There is no assistant row to stamp — the reply was empty, so none was written.
    await syncCliTurn(turn({ assistantMessage: "", userMessageId: "u-1" }));

    expect(stamped).toEqual([{ ids: ["u-1"], status: "synced" }]);
  });

  /**
   * ⚠ "NOTHING WAS ATTEMPTED" IS NOT A FAILURE, and the first draft of this got it wrong. A boolean
   * return forced mid-setup (no server / no team / nobody signed in) to share `false` with a real
   * refusal, so the rows would have been stamped 'failed' for a push that never happened — and a retry
   * sweep would then chase them. Left alone, they stay 'pending', which is the truth.
   */
  it("stamps NOTHING when the push was never attempted", async () => {
    settings.team_id = null;

    await syncCliTurn(turn(ids));

    expect(calls).toEqual([]);
    expect(stamped).toEqual([]);
  });

  it("stamps nothing when the caller passed no row ids", async () => {
    // A legacy call site still syncs; it just leaves no local record. Must not throw.
    await expect(syncCliTurn(turn())).resolves.toBeUndefined();
    expect(stamped).toEqual([]);
  });

  /**
   * ⚠ A FAILURE TO RECORD MUST NOT FAIL THE TURN. The push already happened and the participant already
   * saw the reply; a SQLite error here degrades to "unknown status" — which is exactly what leaving the
   * row 'pending' means — rather than throwing into a fire-and-forget caller.
   */
  it("survives the status write itself failing", async () => {
    stampThrows = true;

    await expect(syncCliTurn(turn(ids))).resolves.toBeUndefined();
    // And the push still happened.
    expect(syncOf()).toBeDefined();
  });
});

// ─── 4. THE REAL LOCAL TIMESTAMPS ────────────────────────────────────────────────────
//
// Because the sync sent no timestamps, the AI service stamped each row `now + i` and flagged it `synced` —
// and `timing.ts` correctly refuses to infer user compose time across a synced row, since 1ms gaps describe a
// for-loop. So every gap was unusable and the panel honestly reported that it could not measure.

describe("⚠ the real local times are sent, so timing can be measured", () => {
  it("attaches each row's own createdAt", async () => {
    messageTimes = {
      "u-1": "2026-08-13T11:45:59.000Z",
      "a-1": "2026-08-13T11:47:30.000Z",
    };

    await syncCliTurn(turn({ userMessageId: "u-1", assistantMessageId: "a-1" }));

    const messages = syncOf()!.body!.messages as Array<Record<string, unknown>>;
    expect(messages[0].createdAt).toBe("2026-08-13T11:45:59.000Z");
    expect(messages[1].createdAt).toBe("2026-08-13T11:47:30.000Z");
  });

  /**
   * ⚠ BEST-EFFORT, NOT REQUIRED. A row we cannot resolve — a legacy call site with no id, or a row
   * deleted between the turn and the sync — simply carries no `createdAt`, and the service falls back to
   * its own stamp exactly as before. Refusing to sync over a missing timestamp would trade a real
   * transcript for a cosmetic metric.
   */
  it("omits createdAt when the local time is unknown", async () => {
    messageTimes = {};

    await syncCliTurn(turn({ userMessageId: "u-1", assistantMessageId: "a-1" }));

    const messages = syncOf()!.body!.messages as Array<Record<string, unknown>>;
    expect(messages[0]).not.toHaveProperty("createdAt");
    expect(messages[1]).not.toHaveProperty("createdAt");
  });

  it("sends the user's time even when the turn was stopped", async () => {
    // The half that matters most for a stopped turn: there is no reply, but the question was still
    // asked at a real moment.
    messageTimes = { "u-1": "2026-08-13T11:45:59.000Z" };

    await syncCliTurn(turn({ assistantMessage: "", userMessageId: "u-1" }));

    const messages = syncOf()!.body!.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0].createdAt).toBe("2026-08-13T11:45:59.000Z");
  });
});

// ─── 5. THE THREAD IS NOT RE-CREATED ─────────────────────────────────────────────────
//
// ⚠ THIS IS THE CALLER HALF OF A CONFIRMED DATA LOSS. `POST /threads` was a full-item write, so a
// second create REPLACED the row — dropping `shared`, `sharedAt`, `sharedById`, `sharedByName`,
// resetting `createdAt`, and renaming the thread to the latest prompt. Thread `4392b109` was shared at
// 11:47:01 and found recreated at 12:48:42 with the share gone.
//
// This branch used to fire on a 200 with ZERO messages as well as a 404 — and because message syncs
// were failing on an expired bearer, the thread had zero messages for every subsequent turn. One bug
// made the other repeat.

describe("⚠ a thread is created only when it genuinely does not exist", () => {
  it("creates on a 404", async () => {
    statusFor = (url) => (url.includes("/messages") ? 404 : 200);

    await syncCliTurn(turn());

    expect(calls.filter((c) => c.method === "POST" && /\/threads$/.test(c.url))).toHaveLength(1);
  });

  /**
   * ⚠ THE REGRESSION THAT COST A SHARE. "Zero messages" was never evidence of a missing thread — a
   * thread whose sync has never succeeded looks exactly like one just created.
   */
  it("does NOT create when the thread exists but has no messages", async () => {
    // 200 with an empty list: the thread is there, its messages are not.
    vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        auth: headers.Authorization,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const body = String(url).includes("/messages") ? { messages: [] } : { ok: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });

    await syncCliTurn(turn());

    expect(calls.filter((c) => c.method === "POST" && /\/threads$/.test(c.url))).toEqual([]);
    // And the turn still syncs — not creating must not mean not recording.
    expect(syncOf()).toBeDefined();
  });

  it("does not create when the thread already has messages", async () => {
    await syncCliTurn(turn());
    expect(calls.filter((c) => c.method === "POST" && /\/threads$/.test(c.url))).toEqual([]);
  });
});
