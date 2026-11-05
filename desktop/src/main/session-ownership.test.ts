// ── ⚠ A CALLER-SUPPLIED SESSION ID IS NOT A CLAIM OF OWNERSHIP ────────────────────────────────
//
//   "kiroAcp:send replays any chat session's transcript into the agent prompt with no
//    account-ownership predicate"
//   "db:addMessage writes chat_messages with no owner predicate, allowing cross-account transcript
//    injection"
//
// Multi-account switching on one profile is a first-class feature of this app, so "a well-formed UUID"
// and "your chat" are different questions. `chat_messages` carries no account of its own — the session
// owns it — so every operation keyed on a caller's `sessionId` has to reach through `chat_sessions`.
//
// ⚠ THE THREE READ CHANNELS IN handlers/db.ts LEARNED THIS ALREADY, each spelling the predicate out
// inline, and their in-file comment records that they were fixed after review found exactly this. What
// this file pins is the rest of the surface — the WRITES, and the transcript replay — plus the fact
// that a shape check is not an authorization check, which is the confusion that let these through.

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rows the fake DB returns from `get()`, keyed by a fragment of the SELECT. */
let ownedRow: unknown = undefined;
const prepared: string[] = [];
const bound: unknown[][] = [];

const settings = new Map<string, string>();

vi.mock("./database", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
  getDb: () => ({
    prepare: (sql: string) => {
      prepared.push(sql);
      return {
        get: (...args: unknown[]) => {
          bound.push(args);
          return sql.includes("FROM chat_sessions WHERE id = ?") ? ownedRow : undefined;  // nosemgrep: useless-ternary
        },
        all: (...args: unknown[]) => {
          bound.push(args);
          return [];
        },
        run: (...args: unknown[]) => {
          bound.push(args);
        },
      };
    },
  }),
}));

const { isSessionOwnedByActiveAccount } = await import("./session-ownership");

beforeEach(() => {
  prepared.length = 0;
  bound.length = 0;
  settings.clear();
  ownedRow = undefined;
});

describe("isSessionOwnedByActiveAccount", () => {
  it("is true for a chat the signed-in account owns", () => {
    settings.set("user_id", "user-a");
    ownedRow = { ok: 1 };

    expect(isSessionOwnedByActiveAccount("chat-1")).toBe(true);
    expect(bound[0], "the account is bound, not assumed").toEqual(["chat-1", "user-a"]);
  });

  it("⚠ is false when the row does not resolve for that account", () => {
    // The fake returns nothing, which is what a foreign row and an absent row both look like here.
    settings.set("user_id", "user-a");
    ownedRow = undefined;

    expect(isSessionOwnedByActiveAccount("chat-1")).toBe(false);
  });

  /**
   * ⚠ `IS ?` RATHER THAN `= ?`, and this is the assertion that stops somebody "tidying" it. A session
   * written before the `user_id` column existed carries NULL, and `NULL = NULL` is never true in SQL —
   * so `=` would make the oldest chats permanently unusable, which reads as the app forgetting a
   * participant's conversations rather than as a security control.
   */
  it("uses the null-safe comparison every sibling uses", () => {
    ownedRow = { ok: 1 };
    isSessionOwnedByActiveAccount("chat-1");

    expect(prepared[0]).toContain("user_id IS ?");
    expect(prepared[0], "a bare equality would strand every legacy chat").not.toMatch(/user_id\s*=\s*\?/);
  });

  it("matches a legacy chat when nobody is signed in", () => {
    // Signed out, nothing is owned by anybody, and a legacy chat is still this machine's own.
    ownedRow = { ok: 1 };

    expect(isSessionOwnedByActiveAccount("chat-1")).toBe(true);
    expect(bound[0]).toEqual(["chat-1", null]);
  });

  it("prefers active_user_id over user_id, like every other scoped query", () => {
    settings.set("user_id", "signed-in-first");
    settings.set("active_user_id", "switched-to");
    ownedRow = { ok: 1 };

    isSessionOwnedByActiveAccount("chat-1");

    expect(bound[0]?.[1]).toBe("switched-to");
  });

  /**
   * ⚠ THE SHAPE CHECK IS A CHEAP REFUSAL, NOT THE AUTHORIZATION — and it must come FIRST, so a value
   * that is not an id at all never reaches the query.
   */
  it("refuses a malformed id without querying", () => {
    ownedRow = { ok: 1 };

    expect(isSessionOwnedByActiveAccount("a/b")).toBe(false);
    expect(isSessionOwnedByActiveAccount("s1?x=1")).toBe(false);
    expect(isSessionOwnedByActiveAccount("")).toBe(false);
    expect(isSessionOwnedByActiveAccount(undefined)).toBe(false);
    expect(isSessionOwnedByActiveAccount(null)).toBe(false);
    expect(isSessionOwnedByActiveAccount(42)).toBe(false);
    expect(prepared, "nothing should have been prepared at all").toEqual([]);
  });

  /**
   * ⚠ A FAILED LOOKUP IS A REFUSAL, NEVER A PASS. Treating a transient fault as ownership would turn
   * every mid-migration boot into the hole this closes.
   */
  it("⚠ fails closed when the query itself cannot run", async () => {
    vi.resetModules();
    vi.doMock("./database", () => ({
      readSetting: () => null,
      getDb: () => {
        throw new Error("no such table: chat_sessions");
      },
    }));
    const { isSessionOwnedByActiveAccount: underFault } = await import("./session-ownership");

    expect(underFault("chat-1")).toBe(false);
    vi.doUnmock("./database");
    vi.resetModules();
  });
});

/**
 * ── ⚠ EVERY SESSION-KEYED CHANNEL NAMES THE GATE ──────────────────────────────────────────────
 *
 * Asserted against the source, for the reason model-list-scope.test.ts gives about rules that live in
 * more than one file: the property is "no send or write channel keys on a caller's session id without
 * asking whose it is", and that is a fact about a set of handlers rather than about one behaviour.
 *
 * ⚠ THE THREE SEND CHANNELS ARE LISTED TOGETHER ON PURPOSE. The finding named `kiroAcp:send` only, and
 * fixing that alone would have been cosmetic — `cli:send` and `claude-sdk:send` write into the named
 * session too, so the same cross-account write stayed reachable by choosing a different assistant. A
 * gate on one of three doors is not a gate.
 */
describe("⚠ the handlers that take a session id from the renderer", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  };

  it("kiroAcp:send asks before it replays or writes anything", async () => {
    const src = await read("./handlers/kiro-acp.ts");
    const body = src.slice(src.indexOf('"kiroAcp:send"'));
    const gate = body.indexOf("isSessionOwnedByActiveAccount");
    const preamble = body.indexOf("buildHistoryPreamble(");
    const save = body.indexOf("saveMessage(");

    expect(gate, "the gate must exist").toBeGreaterThan(-1);
    expect(gate, "before the transcript is read into the prompt").toBeLessThan(preamble);
    expect(gate, "and before anything is written into the session").toBeLessThan(save);
  });

  it("cli:send asks before it writes or syncs", async () => {
    const src = await read("./handlers/cli-assistant.ts");
    const body = src.slice(src.indexOf('"cli:send"'));
    const gate = body.indexOf("isSessionOwnedByActiveAccount");
    expect(gate).toBeGreaterThan(-1);
    expect(gate, "before the process is fed or a row is written").toBeLessThan(body.indexOf("saveMessage("));
  });

  it("claude-sdk:send asks before it writes or syncs", async () => {
    const src = await read("./handlers/claude-code.ts");
    const body = src.slice(src.indexOf('"claude-sdk:send"'));
    const gate = body.indexOf("isSessionOwnedByActiveAccount");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("saveAssistantMessage("));
  });

  it("db:addMessage asks before the INSERT", async () => {
    const src = await read("./handlers/db.ts");
    const body = src.slice(src.indexOf('"db:addMessage"'));
    const gate = body.indexOf("isSessionOwnedByActiveAccount");
    const insert = body.indexOf("INSERT INTO chat_messages");

    expect(gate).toBeGreaterThan(-1);
    expect(gate, "the row must not be written first and checked after").toBeLessThan(insert);
  });

  it("share:unshareSession asks before the authenticated POST", async () => {
    const src = await read("./handlers/ai.ts");
    const body = src.slice(src.indexOf('"share:unshareSession"'));
    /**
     * ⚠ MATCHED ON THE CALL, NOT THE URL. A first version looked for `/unshare` and found it in the
     * comment above the gate, so the ordering assertion compared a gate against prose and failed on
     * correct code. Ordering tests have to anchor on something only the executable line contains.
     */
    const gate = body.indexOf("if (!isSessionOwnedByActiveAccount");
    const post = body.indexOf("fetchAuthed(");

    expect(gate, "the gate must exist").toBeGreaterThan(-1);
    expect(post, "and so must the request it guards").toBeGreaterThan(-1);
    expect(gate, "an unscoped authenticated write is the defect itself").toBeLessThan(post);
  });

  /**
   * ── ⚠ THE LIFECYCLE AND PERMISSION CHANNELS, WHICH THE SEND GATES DID NOT COVER ──────────────
   *
   * The three SEND channels above were gated and their siblings were not, so the same rows and the same live
   * agent state stayed reachable by asking a different question:
   *
   *   - `kiroAcp:start` / `kiroAcp:newSession` read and OVERWRITE another account's ACP resume
   *     handle, and `session/load` replays that conversation to the calling renderer;
   *   - `claude-sdk:permission-respond` searched every session's pending map, approving a
   *     `Bash`/`Write`/`Edit` call parked in a chat the caller does not own;
   *   - `cli:stop` with no argument killed EVERY agent process on the machine, and `cli:isRunning`
   *     answered for arbitrary ids — the activity oracle this module's refusal wording exists to deny.
   */
  it("kiroAcp:start asks before it touches the session's resume handle", async () => {
    const src = await read("./handlers/kiro-acp.ts");
    const body = src.slice(src.indexOf('"kiroAcp:start"'));
    const gate = body.indexOf("if (!isSessionOwnedByActiveAccount");
    const ensure = body.indexOf("await ensureClient(");

    expect(gate, "the gate must exist").toBeGreaterThan(-1);
    expect(ensure, "and so must the call it guards").toBeGreaterThan(-1);
    expect(gate, "ensureClient reads and rewrites the row, so it must come after").toBeLessThan(ensure);
  });

  it("kiroAcp:newSession asks before it replaces the stored handle", async () => {
    const src = await read("./handlers/kiro-acp.ts");
    const body = src.slice(src.indexOf('"kiroAcp:newSession"'));
    const gate = body.indexOf("isSessionOwnedByActiveAccount");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("client.newSession("));
  });

  /** Both branches: a named id must be owned, and "stop everything" means everything of MINE. */
  for (const [file, channel] of [
    ["./handlers/cli-assistant.ts", '"cli:stop"'],
    ["./handlers/kiro-acp.ts", '"kiroAcp:stop"'],
  ] as const) {
    it(`${channel} cannot stop another account's turn`, async () => {
      const src = await read(file);
      const body = src.slice(src.indexOf(channel), src.indexOf(channel) + 1600);
      expect(
        (body.match(/isSessionOwnedByActiveAccount/g) ?? []).length,
        "the named branch AND the bulk branch"
      ).toBeGreaterThanOrEqual(2);
    });
  }

  for (const [file, channel] of [
    ["./handlers/cli-assistant.ts", '"cli:isRunning"'],
    ["./handlers/kiro-acp.ts", '"kiroAcp:isRunning"'],
  ] as const) {
    it(`${channel} is not an activity oracle for other accounts`, async () => {
      const src = await read(file);
      const body = src.slice(src.indexOf(channel), src.indexOf(channel) + 900);
      expect((body.match(/isSessionOwnedByActiveAccount/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  }

  it("claude-sdk:permission-respond requires the session and gates on it", async () => {
    const src = await read("./handlers/claude-code.ts");
    const body = src.slice(src.indexOf('"claude-sdk:permission-respond"'));
    const gate = body.indexOf("isSessionOwnedByActiveAccount");
    expect(gate, "the gate must exist").toBeGreaterThan(-1);
    // The cross-session fallback is the defect: a prompt is answerable only under its own session.
    // Bounded at the NEXT handler: `claude-sdk:stop`'s bulk branch legitimately walks the map.
    const handler = body.slice(0, body.indexOf('ipcMain.handle("claude-sdk:stop"'));
    expect(handler, "no searching every session's pending map").not.toContain(
      "[...sessions.values()]"
    );
    /**
     * ⚠ AND CONSENT IS EXACTLY `true`. Truthy coercion let a malformed field read as approval for an
     * agent tool call — the ACP sibling already required the strict comparison.
     */
    expect(handler).toContain("params.allow === true");
  });

  /** Answering a prompt by id authorises a tool call, so the id must not be guessable. */
  it("parks permission prompts under an unguessable id", async () => {
    const src = await read("./handlers/claude-code.ts");
    expect(src, "Math.random is not a CSPRNG").not.toMatch(
      /const id = `\$\{sessionId\}:\$\{Date\.now\(\)\}/
    );
    expect(src).toMatch(/const id = `\$\{sessionId\}:\$\{randomUUID\(\)\}`/);
  });

  /**
   * ⚠ AND THE REFUSALS SAY NOTHING DISTINGUISHING. A channel that reported "not your chat" separately
   * from "no such chat" would be a probe for which session ids exist under the other accounts on this
   * machine — the reasoning `share:shareSession` already writes out for its single "Chat not found".
   */
  it("refuses with one indistinguishable message", async () => {
    /**
     * ⚠ ANCHORED ON `if (!…`, NOT ON THE BARE NAME — which matches the IMPORT line first and would
     * assert against a list of imports in every one of these files.
     */
    for (const file of [
      "./handlers/kiro-acp.ts",
      "./handlers/cli-assistant.ts",
      "./handlers/claude-code.ts",
      "./handlers/ai.ts",
    ]) {
      const src = await read(file);
      const idx = src.indexOf("if (!isSessionOwnedByActiveAccount");
      expect(idx, `${file} must gate on ownership`).toBeGreaterThan(-1);
      expect(src.slice(idx, idx + 220), `${file} must not say why`).toContain("Chat not found");
    }
  });
});

/**
 * ── ⚠ COMPLETENESS: THE CHANNEL LIST IS DERIVED FROM THE SOURCE, NOT MAINTAINED BY HAND ────────
 *
 * The suite above asserts the rule channel by channel, from a list somebody typed. That is the right
 * shape for ORDERING — "the gate comes before `saveMessage`" is a fact about one handler and has to be
 * written out — and it is the wrong shape for COVERAGE, which is what this block adds.
 *
 * ⚠ AND THE HAND-WRITTEN LIST HAS ALREADY FAILED ONCE, WHICH IS WHY THIS EXISTS. The cycle that added
 * `claude-sdk:permission-respond` above did not add its two siblings, and the cycle that gated
 * `kiroAcp:stop` did not gate `kiroAcp:cancel`. A later report named exactly those three —
 * `kiroAcp:cancel`, `kiroAcp:permissionRespond`, `cli:permission-respond` — i.e. precisely the
 * channels that were never typed into the list. A list of thirteen that is missing three is not
 * coverage; it is a record of what somebody remembered.
 *
 * Verified: this sweep, run against the source as it was before those three were fixed, reports those
 * three and nothing else. It would have caught them a cycle earlier than the scan did.
 *
 * ── WHAT IT ASSERTS ──
 *
 * Every `ipcMain.handle` whose body TOUCHES session-keyed state must enforce account ownership in one
 * of the three shapes that actually do so. All three are real enforcement; the point of naming them
 * separately is that a channel matching NONE of them is a gap by construction, so channel N+1 fails
 * here on the day it is written rather than appearing in a report next quarter.
 */
describe("⚠ every session-acting channel enforces ownership (derived sweep)", () => {
  /**
   * The files that own live agent state or the chat tables. Deliberately a short, explicit list —
   * this is "where session state lives", which is an architectural fact worth stating, unlike the
   * per-channel list, which is bookkeeping.
   */
  const FILES = [
    "./handlers/kiro-acp.ts",
    "./handlers/cli-assistant.ts",
    "./handlers/claude-code.ts",
    "./handlers/ai.ts",
    "./handlers/db.ts",
  ] as const;

  /**
   * A handler is in scope if it reads or writes something a session owns: the caller-supplied id, one
   * of the account-blind in-memory maps, or either chat table.
   *
   * ⚠ NOT JUST `sessionId`. Keying on the parameter NAME would let a rename dodge the sweep, and
   * `db:deleteSession` already calls its argument `id`. The in-memory maps are named because they are
   * the state the lifecycle findings were about, and they carry no account dimension of their own.
   */
  const ACTS_ON_SESSION =
    /\bsessionId\b|\bacpClients\b|\bpendingAcpPermissions\b|\bactiveProcesses\b|\bpendingPermissions\b|chat_sessions|chat_messages/;

  /** Either spelling of "the account that is asking", so a handler cannot pass by hardcoding one. */
  const ACCOUNT = /activeUserId\(\)|readSetting\("active_user_id"\)/;

  /**
   * The three shapes that genuinely enforce ownership:
   *
   *   1. the helper — what a session-keyed handler should normally use, and what greps;
   *   2. an inline predicate bound to the active account — `db:getMessages`, `share:shareSession` and
   *      `db:getSessions` scope inside the SQL instead, which is equally binding. `IS` and `=` are both
   *      accepted: `IS` keeps legacy NULL rows settleable, `=` is right for a read that should not see
   *      them, and this file's own header explains that choice;
   *   3. an INSERT that STAMPS the owner — `db:createSession` establishes ownership rather than
   *      checking it, and there is nothing to authorise on a row that does not exist yet.
   */
  const enforcesOwnership = (body: string) =>
    /isSessionOwnedByActiveAccount/.test(body) ||
    (/user_id\s+(IS|=)\s+\?/.test(body) && ACCOUNT.test(body)) ||
    (/INSERT INTO chat_sessions/.test(body) && ACCOUNT.test(body));

  /**
   * Channels that touch session state and legitimately enforce nothing.
   *
   * ⚠ EMPTY, AND THAT IS THE ASSERTION. Every session-acting channel in the app currently enforces
   * ownership in one of the three shapes above. An entry here needs a reason in the value, and adding
   * one should feel like a decision — which is the whole mechanism: the alternative to an explicit
   * exemption is a silent omission, and a silent omission is what the last three findings were.
   */
  const EXEMPT: Record<string, string> = {};

  /** Comments name both the helper and the maps, so they must go before anything is matched. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const handlersIn = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = stripComments(
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    );
    // Both call shapes: `ipcMain.handle("x", …)` and the wrapped form with the name on its own line.
    const found = [...src.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => ({
      channel: m[1],
      at: m.index ?? 0,
    }));
    return found.map((h, i) => ({
      channel: h.channel,
      body: src.slice(h.at, i + 1 < found.length ? found[i + 1].at : src.length),
    }));
  };

  it("finds the handlers at all — a sweep that matches nothing proves nothing", async () => {
    const all = (await Promise.all(FILES.map(handlersIn))).flat();
    expect(all.length, "the extractor must see the IPC handlers").toBeGreaterThan(25);
    expect(
      all.filter((h) => ACTS_ON_SESSION.test(h.body)).length,
      "and a substantial number of them must act on session state"
    ).toBeGreaterThan(15);
    // Anchors: if a rename makes these invisible, the sweep silently narrows and this catches it.
    const names = all.map((h) => h.channel);
    for (const required of ["kiroAcp:cancel", "cli:permission-respond", "db:addMessage"]) {
      expect(names, `${required} must be visible to the sweep`).toContain(required);
    }
  });

  it("has no session-acting channel without ownership enforcement", async () => {
    const gaps: string[] = [];
    for (const file of FILES) {
      for (const { channel, body } of await handlersIn(file)) {
        if (!ACTS_ON_SESSION.test(body)) continue;
        if (channel in EXEMPT) continue;
        if (!enforcesOwnership(body)) gaps.push(`${file.replace("./handlers/", "")} ${channel}`);
      }
    }
    expect(
      gaps,
      "each of these takes or touches a session and never asks whose it is — gate it with " +
        "isSessionOwnedByActiveAccount, scope the SQL to the active account, or add it to EXEMPT " +
        "with a reason"
    ).toEqual([]);
  });
});
