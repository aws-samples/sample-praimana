// The governing security condition — the board/chat/phases requests must run in MAIN,
// with the bearer attached here and never handed to the renderer.
//
// These tests invoke the real ipcMain handlers and assert on the actual Request
// that reached `fetch`: the Authorization header, and the presence of an abort
// signal. `fetchAuthed` is stubbed with the same contract handlers/ai.ts provides
// (call build(token) with a token the RENDERER never supplies) so the token
// source is unambiguous — if a handler stopped attaching the header, or dropped
// its timeout, the matching test fails.

import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  app: { getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));

/**
 * A SIGNED-IN app on a team. `auth_token` is part of that and was missing — the fixture mocked
 * `fetchAuthed` wholesale, so nothing needed the setting until `missingContextReason` began asking
 * whether a session exists at all. Production reads the same key: `fetchAuthed`'s `getToken` is
 * `authToken || getSetting("auth_token")`.
 */
const settings = new Map<string, string>([
  ["server_url", "https://backend.example"],
  ["team_id", "team-1"],
  ["workshop_id", "ws-1"],
  ["auth_token", "stored-session-token"],
]);

vi.mock("../database", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
  writeSetting: () => {},
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
}));

// The token main holds. A renderer never sees or supplies this value, so finding
// it in an outgoing Authorization header proves the bearer came from main.
const MAIN_TOKEN = "main-process-id-token";

vi.mock("./ai", () => ({
  fetchAuthed: (build: (token: string) => Promise<Response>) => build(MAIN_TOKEN),
}));

import { setupTeamDataHandlers, __resetTeamReadLogState } from "./team-data";

setupTeamDataHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return Promise.resolve(handler({}, ...args));
}

/** Every request `fetch` was called with, in order. */
let calls: { url: string; init: RequestInit }[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Install a fetch stub that records calls and answers each one from `bodies`. */
function stubFetch(responder: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function auth(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(() => {
  calls = [];
  vi.unstubAllGlobals();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("board:getBoard", () => {
  it("sends the main-process bearer on both requests, with a timeout on each", async () => {
    stubFetch((url) =>
      url.includes("/members")
        ? jsonResponse({ members: [{ userId: "u1", user: { name: "Ada" } }] })
        : jsonResponse({ tasks: [{ id: "t1", title: "Task" }] })
    );

    const res = await invoke("board:getBoard");

    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([{ id: "t1", title: "Task" }]);
    expect(res.members).toEqual([{ userId: "u1", user: { name: "Ada" } }]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // The bearer is main's, and the renderer supplied nothing.
      expect(auth(call.init)).toBe(`Bearer ${MAIN_TOKEN}`);
      // Every external call is bounded — no request can hang forever.
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://backend.example/v1/teams/team-1/members",
      "https://backend.example/v1/teams/team-1/tasks",
    ]);
  });

  it("returns the empty shape when the tasks request fails", async () => {
    stubFetch(() => jsonResponse({}, 500));
    const res = await invoke("board:getBoard");
    // `reason` tells the view WHY it is empty. A 500 is transient, so the view keeps quiet.
    expect(res).toEqual({ ok: false, tasks: [], members: [], reason: "unavailable" });
  });

  it("still returns tasks when only the members request fails", async () => {
    stubFetch((url) =>
      url.includes("/members") ? jsonResponse({}, 403) : jsonResponse({ tasks: [{ id: "t1" }] })
    );
    const res = await invoke("board:getBoard");
    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([{ id: "t1" }]);
    expect(res.members).toEqual([]);
  });

  it("returns the empty shape (never throws) when the transport fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(invoke("board:getBoard")).resolves.toEqual({
      ok: false, tasks: [], members: [], reason: "unavailable",
    });
  });

  it("returns the empty shape when the session is unrecoverable", async () => {
    // fetchAuthed throws "Not logged in" once refresh fails; the renderer must
    // see its normal no-data shape rather than an IPC rejection.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    const ai = await import("./ai");
    vi.spyOn(ai, "fetchAuthed").mockRejectedValueOnce(new Error("Not logged in"));
    // ⚠ `signed-out`, NOT `unavailable`. Reporting a dead session as a network failure would send
    // the user to check their wifi instead of signing in again.
    await expect(invoke("board:getBoard")).resolves.toEqual({
      ok: false, tasks: [], members: [], reason: "signed-out",
    });
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("coerces a non-array tasks body to an empty list", async () => {
    stubFetch(() => jsonResponse({ tasks: "not-an-array" }));
    const res = await invoke("board:getBoard");
    expect(res.tasks).toEqual([]);
  });

  it("returns the empty shape without fetching when there is no team", async () => {
    settings.delete("team_id");
    const fetchMock = stubFetch(() => jsonResponse({}));
    const res = await invoke("board:getBoard");
    // Not on a team is not a failure, and must not read as one.
    expect(res).toEqual({ ok: false, tasks: [], members: [], reason: "no-team" });
    expect(fetchMock).not.toHaveBeenCalled();
    settings.set("team_id", "team-1");
  });

  /**
   * ── ⚠ SIGNED OUT IS NOT "NO TEAM", AND CONFLATING THEM HID A REAL STATE ────────────────────
   *
   * Nothing was missing — the profile had been signed out and every team-scoped read returned early reporting
   * `no-team`, which `TeamAccessNotice` renders NOTHING for, correctly, because "signed in with no team
   * joined" is a legitimate state for a fresh install. So four views went blank with no explanation and the
   * cause took a database read to find.
   *
   * The remedies differ — sign in, versus join a team — which is the whole reason these are two codes.
   */
  it("⚠ distinguishes no session at all from no team", async () => {
    /**
     * ⚠ BOTH KEYS, BECAUSE THAT IS WHAT SIGN-OUT DOES. `SIGN_OUT_SETTINGS` clears `auth_token` AND
     * `team_id` together, so a signed-out profile fails `teamContext()` on the team and is then asked
     * WHY — which is where the two codes diverge. Deleting only the token leaves `teamContext()`
     * satisfied and the read simply succeeds, which is the right behaviour and not this case.
     *
     * ⚠ RESTORED IN `finally`, so a failing assertion cannot leak a half-signed-out fixture into every
     * test after it. The inline restores elsewhere in this file are one throw away from that, and this
     * case proved it: an earlier version of it failed and took eighteen unrelated tests with it.
     */
    settings.delete("auth_token");
    settings.delete("team_id");
    const fetchMock = stubFetch(() => jsonResponse({}));
    try {
      const res = await invoke("board:getBoard");

      expect(res.reason, "there is no session, which is not the same as no team").toBe("no-session");
      expect(fetchMock, "and still nothing is attempted").not.toHaveBeenCalled();
    } finally {
      settings.set("auth_token", "stored-session-token");
      settings.set("team_id", "team-1");
    }
  });

  /** A session with no team is the state `no-team` is FOR, so the two cannot collapse back together. */
  it("⚠ still reports no-team when a session exists but no team does", async () => {
    settings.delete("team_id");
    try {
      const res = await invoke("board:getBoard");
      expect(res.reason).toBe("no-team");
    } finally {
      settings.set("team_id", "team-1");
    }
  });
});

describe("board:createTask / board:updateTask", () => {
  it("POSTs the task with the main bearer and a timeout", async () => {
    stubFetch(() => jsonResponse({ task: {} }, 201));

    const res = await invoke("board:createTask", {
      title: "New",
      description: null,
      priority: "HIGH",
      assigneeId: "u1",
    });

    expect(res).toEqual({ ok: true, status: 201 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://backend.example/v1/teams/team-1/tasks");
    expect(calls[0].init.method).toBe("POST");
    expect(auth(calls[0].init)).toBe(`Bearer ${MAIN_TOKEN}`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      title: "New",
      description: null,
      priority: "HIGH",
      assigneeId: "u1",
    });
  });

  /**
   * ⚠ THIS TEST ASSERTED THE WRONG URL AND SO SHIPPED THE BUG WITH IT.
   *
   * The handler was calling `/v1/tasks/{taskId}`, which does not exist (verified against the deployed API:
   * 404, while `/v1/auth/me` on the same host returns 401). The real route is
   * `/v1/teams/{teamId}/tasks/{taskId}`.
   *
   * This test pinned the broken path, so it passed the whole time. A URL assertion is only worth
   * having if the URL was checked against the API rather than copied from the code it tests.
   */
  it("PATCHes the TEAM-SCOPED task route", async () => {
    stubFetch(() => jsonResponse({ task: {} }));

    const res = await invoke("board:updateTask", {
      taskId: "t1",
      title: "Edited",
      description: "d",
      status: "DONE",
      priority: "LOW",
      assigneeId: "u2",
    });

    expect(res).toEqual({ ok: true, status: 200 });
    expect(calls[0].url).toBe("https://backend.example/v1/teams/team-1/tasks/t1");
    expect(calls[0].init.method).toBe("PATCH");
    expect(auth(calls[0].init)).toBe(`Bearer ${MAIN_TOKEN}`);
    expect(JSON.parse(String(calls[0].init.body)).teamId).toBe("team-1");
  });

  it("reports status=null when the request never reached the server", async () => {
    // BoardView keys "keep the form open" on this, so the distinction between
    // "server said no" and "no response" has to survive the move into main.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    const res = await invoke("board:createTask", {
      title: "x", description: null, priority: "LOW", assigneeId: null,
    });
    expect(res).toEqual({ ok: false, status: null });
  });

  it("reports the HTTP status when the server rejects the write", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 403));
    const res = await invoke("board:createTask", {
      title: "x", description: null, priority: "LOW", assigneeId: null,
    });
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it("percent-encodes a task id so it cannot escape the path", async () => {
    stubFetch(() => jsonResponse({}));
    await invoke("board:updateTask", {
      taskId: "../../v1/admin/users",
      title: "t", description: null, status: "TODO", priority: "LOW", assigneeId: null,
    });
    expect(calls[0].url).toBe(
      "https://backend.example/v1/teams/team-1/tasks/..%2F..%2Fv1%2Fadmin%2Fusers"
    );
  });

  /**
   * ── ⚠ THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL BUG ──
   *
   * Every task route in this API is team-scoped — `/v1/teams/{teamId}/tasks[/{taskId}]`, declared
   * in the infrastructure CloudFormation template and handled at `app.patch("/teams/:teamId/tasks/:taskId")`. A
   * top-level `/v1/tasks/...` does not exist and never did.
   *
   * Asserted as a SHAPE rather than a literal, so it holds for any future task call: the two above
   * each pin one exact URL, and neither would have failed if a THIRD handler were added with the
   * same mistake.
   *
   * It fails silently in production, which is what made it expensive: the renderer closes the
   * dialog and reloads whenever the server answers at all, and a 404 is an answer — so the card
   * reverted to its old column with no error anywhere.
   */
  it("never calls a task route that is not team-scoped", async () => {
    stubFetch(() => jsonResponse({ task: {} }));

    await invoke("board:createTask", {
      title: "t", description: null, priority: "LOW", assigneeId: null,
    });
    await invoke("board:updateTask", {
      taskId: "t1", title: "t", description: null, status: "IN_PROGRESS", priority: "LOW",
      assigneeId: null,
    });

    for (const call of calls) {
      expect(call.url, `${call.url} is not team-scoped`).not.toMatch(/\/v1\/tasks\b/);
      expect(call.url).toMatch(/\/v1\/teams\/[^/]+\/tasks/);
    }
  });

  /**
   * The status the user actually reported being unable to set. Named explicitly because the column
   * ids are a contract with the board's own `COLUMNS` array, and a typo either side puts a card in
   * a column that renders nowhere.
   */
  it("sends the status verbatim, including IN_PROGRESS", async () => {
    stubFetch(() => jsonResponse({ task: {} }));

    await invoke("board:updateTask", {
      taskId: "t1", title: "t", description: null, status: "IN_PROGRESS", priority: "LOW",
      assigneeId: "u1",
    });

    expect(JSON.parse(String(calls[0].init.body)).status).toBe("IN_PROGRESS");
  });
});

describe("chat:getTeamMessages / chat:sendTeamMessage", () => {
  it("GETs messages with the main bearer, a bounded limit, and a timeout", async () => {
    stubFetch(() => jsonResponse({ messages: [{ id: "m1", content: "hi" }] }));

    const res = await invoke("chat:getTeamMessages");

    expect(res).toEqual({ ok: true, messages: [{ id: "m1", content: "hi" }] });
    expect(calls[0].url).toBe("https://backend.example/v1/teams/team-1/messages?limit=100");
    expect(auth(calls[0].init)).toBe(`Bearer ${MAIN_TOKEN}`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the empty shape on a failed poll rather than throwing", async () => {
    // The renderer polls this every 5s; a rejection would surface as an
    // unhandled IPC error on every tick.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(invoke("chat:getTeamMessages")).resolves.toEqual({
      ok: false, messages: [], reason: "unavailable",
    });
  });

  it("POSTs a message and reports ok", async () => {
    stubFetch(() => jsonResponse({ message: {} }, 201));
    const res = await invoke("chat:sendTeamMessage", "hello team");
    expect(res).toEqual({ ok: true });
    expect(calls[0].init.method).toBe("POST");
    expect(auth(calls[0].init)).toBe(`Bearer ${MAIN_TOKEN}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ content: "hello team" });
  });

  it("distinguishes a server rejection from a transport failure", async () => {
    stubFetch(() => jsonResponse({}, 500));
    expect(await invoke("chat:sendTeamMessage", "x")).toEqual({ ok: false, status: 500 });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await invoke("chat:sendTeamMessage", "x")).toEqual({ ok: false, status: null });
  });
});

describe("phases:*", () => {
  it("GETs phases + the workshop with the main bearer and timeouts", async () => {
    stubFetch((url) =>
      url.includes("/phases")
        ? jsonResponse({ phases: [{ id: "p1", order: 1 }] })
        : jsonResponse({ workshop: { currentPhaseOrder: 2 } })
    );

    const res = await invoke("phases:getPhases");

    expect(res.ok).toBe(true);
    expect(res.phases).toEqual([{ id: "p1", order: 1 }]);
    expect(res.currentPhaseOrder).toBe(2);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(auth(call.init)).toBe(`Bearer ${MAIN_TOKEN}`);
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("falls back to currentPhaseOrder 0 when the workshop lookup fails", async () => {
    stubFetch((url) =>
      url.includes("/workshops/ws-1") && !url.includes("teams")
        ? jsonResponse({}, 500)
        : jsonResponse({ phases: [{ id: "p1", order: 0 }] })
    );
    const res = await invoke("phases:getPhases");
    expect(res.ok).toBe(true);
    expect(res.currentPhaseOrder).toBe(0);
  });

  it("PUTs phase content and surfaces the server's error message", async () => {
    stubFetch(() => jsonResponse({ error: "Phase is locked" }, 409));

    const res = await invoke("phases:savePhase", { phaseId: "p1", content: "notes" });

    expect(res).toEqual({ ok: false, error: "Phase is locked" });
    expect(calls[0].url).toBe("https://backend.example/v1/workshops/teams/team-1/phases/p1");
    expect(calls[0].init.method).toBe("PUT");
    expect(auth(calls[0].init)).toBe(`Bearer ${MAIN_TOKEN}`);
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    stubFetch(() => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error("not json"); },
    } as unknown as Response));
    const res = await invoke("phases:savePhase", { phaseId: "p1", content: "x" });
    expect(res).toEqual({ ok: false, error: "Save failed (HTTP 502)" });
  });

  /**
   * ── ⚠ THE GENERATE CHANNEL MUST STAY UNREGISTERED ────────────────────────────────────────
   *
   * There was a passing test here that POSTed to `.../phases/p1/generate` and asserted `{ ok: true }`.
   * It passed because `stubFetch` answered whatever URL it was given — so it proved the handler built the
   * request correctly and proved NOTHING about whether the endpoint exists. It does not: the workshop
   * service has never had that route, so in production every call 404'd.
   *
   * ⚠ A GREEN TEST OVER A ROUTE THAT ANSWERS 404 IS WORSE THAN NO TEST, which is why this asserts the
   * ABSENCE of the channel rather than being deleted outright. Re-adding the handler without the backing
   * route now fails here, instead of shipping and failing in a workshop.
   */
  it("registers no phases:generatePhase channel — the backend route does not exist", () => {
    expect(handlers.has("phases:generatePhase")).toBe(false);
    expect(() => invoke("phases:generatePhase", { phaseId: "p1", phaseName: "Inception" })).toThrow();
  });
});

describe("workshop:getSetupInstructions", () => {
  it("returns only the instructions, not the whole workshop record", async () => {
    stubFetch(() =>
      jsonResponse({
        workshop: {
          id: "ws-1",
          setupConfig: { instructions: "Install dependencies and verify the build.", secretField: "nope" },
        },
      })
    );

    const res = await invoke("workshop:getSetupInstructions");

    expect(res).toEqual({ instructions: "Install dependencies and verify the build." });
    expect(JSON.stringify(res)).not.toContain("nope");
    expect(auth(calls[0].init)).toBe(`Bearer ${MAIN_TOKEN}`);
  });

  it("returns null when the workshop has no instructions configured", async () => {
    stubFetch(() => jsonResponse({ workshop: {} }));
    expect(await invoke("workshop:getSetupInstructions")).toEqual({ instructions: null });
  });

  it("returns null for blank/whitespace-only instructions", async () => {
    stubFetch(() => jsonResponse({ workshop: { setupConfig: { instructions: "   " } } }));
    expect(await invoke("workshop:getSetupInstructions")).toEqual({ instructions: null });
  });

  it("returns null without fetching when no workshop is set", async () => {
    settings.delete("workshop_id");
    const fetchMock = stubFetch(() => jsonResponse({}));
    expect(await invoke("workshop:getSetupInstructions")).toEqual({ instructions: null });
    expect(fetchMock).not.toHaveBeenCalled();
    settings.set("workshop_id", "ws-1");
  });
});

describe("backpressure: the request fan-out is bounded", () => {
  it("sheds beyond MAX_IN_FLIGHT instead of queueing, then recovers", async () => {
    // Hold every fetch open so slots stay occupied, and count how many actually
    // start. MAX_IN_FLIGHT is 8 and board:getBoard takes a slot per CALL (not per
    // request), so 8 concurrent calls saturate it and the 9th must be shed.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      await gate;
      return jsonResponse({ messages: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const inFlight = Array.from({ length: 8 }, () => invoke("chat:getTeamMessages"));
    // Let the 8 calls reach their fetch and park on the gate.
    await Promise.resolve();
    await Promise.resolve();

    // The 9th is shed — it resolves IMMEDIATELY with the empty shape rather than
    // waiting for a slot, so overload never becomes unbounded queue growth.
    const shed = await invoke("chat:getTeamMessages");
    // `busy` is distinguishable from a real failure: it never reached the network.
    expect(shed).toEqual({ ok: false, messages: [], reason: "busy" });
    expect(fetchMock).toHaveBeenCalledTimes(8); // the 9th never hit the network

    release();
    await Promise.all(inFlight);

    // Slots are released on completion, so the next call proceeds normally.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ messages: [{ id: "m1" }] });
    }));
    expect(await invoke("chat:getTeamMessages")).toEqual({ ok: true, messages: [{ id: "m1" }] });
  });

  it("releases its slot when a request throws", async () => {
    // A leaked slot on the error path would slowly wedge the app shut, which is
    // exactly the class of bug that only shows up after hours of use.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    for (let i = 0; i < 20; i++) {
      await invoke("chat:getTeamMessages");
    }
    // Still serving after 20 failures — the counter did not drift upward.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ messages: [{ id: "ok" }] })));
    expect(await invoke("chat:getTeamMessages")).toEqual({ ok: true, messages: [{ id: "ok" }] });
  });
});

describe("team reads say WHY they came back empty", () => {
  /**
   * Every failure collapsed into the same `{ ok: false }`, so the one case needing a human decision was
   * indistinguishable from a slow network, and `catch {}` kept it out of the log too.
   */
  it("reports a 403 as access-lost on all three reads", async () => {
    stubFetch(() => jsonResponse({ error: "Forbidden" }, 403));

    expect((await invoke("board:getBoard")).reason).toBe("access-lost");
    expect((await invoke("chat:getTeamMessages")).reason).toBe("access-lost");
    expect((await invoke("phases:getPhases")).reason).toBe("access-lost");
  });

  it("reports a 404 as team-gone — a recreated backend, not a permissions problem", async () => {
    stubFetch(() => jsonResponse({}, 404));

    expect((await invoke("board:getBoard")).reason).toBe("team-gone");
    expect((await invoke("chat:getTeamMessages")).reason).toBe("team-gone");
    expect((await invoke("phases:getPhases")).reason).toBe("team-gone");
  });

  it("reports a surviving 401 as signed-out, not as a network problem", async () => {
    // with-auth-retry returns the 401 to the caller once the refresh cannot save it.
    stubFetch(() => jsonResponse({}, 401));
    expect((await invoke("chat:getTeamMessages")).reason).toBe("signed-out");
  });

  it("keeps every other non-OK status transient", async () => {
    // A 500 or a 502 is the server having a moment; the view keeps its data and stays quiet.
    for (const status of [500, 502, 503]) {
      stubFetch(() => jsonResponse({}, status));
      expect((await invoke("board:getBoard")).reason, String(status)).toBe("unavailable");
    }
  });

  it("still returns the data shape the views already consume", async () => {
    // The whole change is additive: `ok` keeps its meaning and every existing `if (res?.ok)` works.
    stubFetch(() => jsonResponse({ tasks: [{ id: "t1" }], members: [] }));
    const res = await invoke("board:getBoard");
    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([{ id: "t1" }]);
    // No reason on success — the shape is a union on `ok`, not a nullable field.
    expect("reason" in res).toBe(false);
  });

  it("preserves currentPhaseOrder on a failed phases read, as before", async () => {
    // It comes from the OTHER request, which may well have succeeded; the header reads better with
    // the real phase than with a 0 that means "before the first phase".
    stubFetch((url) =>
      url.includes("/phases")
        ? jsonResponse({}, 403)
        : jsonResponse({ workshop: { currentPhaseOrder: 3 } })
    );
    const res = await invoke("phases:getPhases");
    expect(res.reason).toBe("access-lost");
    expect(res.currentPhaseOrder).toBe(3);
  });

  it("logs a persistent failure ONCE, not once per poll", async () => {
    // chat:getTeamMessages polls every 5s. An unguarded warn would emit ~17,000 identical lines a day
    // and bury the one line that matters.
    //
    // ⚠ BOTH RESETS ARE LOAD-BEARING. `vi.spyOn` returns the spy ALREADY installed at module scope, so
    // its call list carries every earlier test's warnings; and the dedupe map is module-level, so a
    // 403 logged by an earlier test would make this one log nothing at all. Without both, this test
    // passes or fails on test ORDER rather than on the behaviour it names.
    __resetTeamReadLogState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    stubFetch(() => jsonResponse({}, 403));

    for (let i = 0; i < 12; i++) await invoke("chat:getTeamMessages");

    const lines = warn.mock.calls.filter((c) => String(c[0]).includes("chat:getTeamMessages"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toMatch(/403/);
    warn.mockRestore();
  });

  it("logs again after a recovery and a relapse", async () => {
    // Reset on success, so a second outage is recorded rather than silently deduped forever.
    __resetTeamReadLogState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    stubFetch(() => jsonResponse({}, 403));
    await invoke("board:getBoard");
    stubFetch(() => jsonResponse({ tasks: [], members: [] }));
    await invoke("board:getBoard");
    stubFetch(() => jsonResponse({}, 403));
    await invoke("board:getBoard");

    const lines = warn.mock.calls.filter((c) => String(c[0]).includes("board:getBoard"));
    expect(lines).toHaveLength(2);
    warn.mockRestore();
  });

  it("does not log transient failures at all", async () => {
    __resetTeamReadLogState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    stubFetch(() => jsonResponse({}, 500));
    for (let i = 0; i < 5; i++) await invoke("board:getBoard");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("board:getBoard"))).toHaveLength(0);
    warn.mockRestore();
  });
});
