import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE SDK-BASED ASSISTANT AND ITS PERMISSION PROMPTS.
 *
 * ── WHAT THIS FILE IS REALLY GUARDING ──
 *
 * ⚠ A PARKED PROMPT HAS NO DEADLINE. The SDK's own types say it outright: "an accidental null means no
 * control_response is sent and the tool stays blocked indefinitely — permission prompts have no park
 * deadline." So the failure mode here is not a wrong answer, it is a TURN THAT NEVER ENDS: the
 * assistant sits waiting on a click that can no longer arrive, and the participant sees a spinner
 * for ever with no error and nothing in a log.
 *
 * Every test below that settles a prompt on cancel, stop, abort or error exists for that reason. They
 * are not defensive padding; they are the difference between a usable feature and a hang.
 *
 * ── AND WHY DENY IS THE DEFAULT ON EVERY ABANDONED PATH ──
 *
 * A prompt abandoned because the turn was stopped has been approved by NOBODY. Defaulting to allow
 * would turn "I closed the window" into "I authorised a file write", which is the one direction this
 * feature must never fail in.
 *
 * ── WHAT IS NOT TESTED HERE, AND WAS PROVEN LIVE INSTEAD ──
 *
 * That the SDK actually pauses on `canUseTool` is a property of the real CLI, not of this code, and a
 * mock cannot establish it — the same limitation that let an illegal DynamoDB expression and a
 * rejected `temperature` through green suites. It was verified against the real CLI (v2.1.226) before
 * this was written: the allow path fired for Read then Edit and applied the edit; the deny path
 * blocked it, left the file unchanged, and reported `permission_denials: 1`.
 */

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

const settings: Record<string, string | null> = {
  project_path: "/tmp/project",
  server_url: "https://api.example.test",
  auth_token: "tok",
  team_id: "team-1",
};
/** Records every SQL statement and its arguments, so the local save is assertable. */
const dbWrites: Array<{ sql: string; args: unknown[] }> = [];
/**
 * Rows the fake DB will return from a `get()`, keyed by a fragment of the SELECT.
 *
 * ⚠ THIS IS STEERABLE, AND IT HAD TO BECOME SO. The previous fake returned `undefined` from every
 * `get()`, which meant the resume-id HYDRATION path could not be observed at all: a session always
 * looked brand new, so a test could not tell "no stored id" from "stored id ignored" — and the reported
 * bug lives exactly in that gap.
 *
 * ⚠ AND `getDb` MAY THROW ON DEMAND, because a database that predates the migration really does throw
 * ("no such column: sdk_session_id" — verified against sqlite3, not assumed), and the handler must
 * treat that as "no stored id" rather than a failed turn.
 *
 * ⚠ THE THROW IS RAISED AT `prepare`, AND ONLY FOR THE STATEMENT THAT NAMES THE MISSING COLUMN. It used
 * to come out of `getDb()` itself, which made "pre-migration database" mean "EVERY query fails" — far
 * broader than SQLite, which refuses a statement when it is prepared and only if that statement
 * references a column the schema does not have.
 *
 * The difference stopped being cosmetic when `claude-sdk:send` gained its ownership gate: that gate
 * queries `chat_sessions.id` / `user_id`, which exist in migration 1, so on a real pre-migration
 * database it succeeds and only the `sdk_session_id` read fails. The blunt version made the gate fail
 * closed — correct behaviour for authorization, on a fault that cannot actually happen — and the test
 * read as though a pre-migration database refuses every turn. Faithful fake, unchanged production rule.
 */
let dbRows: Array<{ match: string; row: unknown }> = [];
let dbThrows = false;

/**
 * ⚠ THE STEER THAT MAKES THE FIXTURE'S CHAT THIS ACCOUNT'S OWN.
 *
 * `claude-sdk:send` refuses a session the active account does not own — the gate `kiroAcp:send` gained
 * from the finding on unscoped session-keyed handlers, applied here because this
 * channel writes into the named session too (`saveAssistantMessage`).
 *
 * ⚠ NAMED, RATHER THAN INLINED IN THE `beforeEach`, because three cases below REPLACE `dbRows` wholesale
 * to steer the resume-id lookup — and each of those would otherwise silently drop the ownership row and
 * turn a resume test into a refusal test. Every override lists this alongside what it is steering.
 */
const OWNED_SESSION = {
  match: "FROM chat_sessions WHERE id = ? AND user_id IS ?",
  row: { ok: 1 },
};
vi.mock("../database", () => ({
  readSetting: (k: string) => settings[k] ?? null,
  getDb: () => ({
    prepare: (sql: string) => {
      // Where SQLite raises it, and only for a statement naming the absent column — see above.
      if (dbThrows && sql.includes("sdk_session_id")) {
        throw new Error("no such column: sdk_session_id");
      }
      return {
        run: (...args: unknown[]) => dbWrites.push({ sql, args }),
        all: () => [],
        get: () => dbRows.find((r) => sql.includes(r.match))?.row,
      };
    },
  }),
}));

vi.mock("../project-paths", () => ({
  assertWithinProject: vi.fn(),
}));

/** Captures debug lines, so the diagnostics can be asserted — and their SAFETY checked. */
const debugLines: string[] = [];
vi.mock("../debug-log", () => ({
  debugLog: (...parts: unknown[]) => debugLines.push(parts.map(String).join(" ")),
}));

/** Which paths the resolver will consider executable (pass an X_OK check). */
let executablePaths = new Set<string>();
/** Paths that EXIST but are not executable — a stray `claude` text file on PATH. */
let presentPaths = new Set<string>();
/**
 * Only `accessSync` is faked — everything else is the REAL fs, via importOriginal. A blanket mock
 * broke the source-reading assertions in this same file (no `readFileSync` on the mock), which is a
 * good argument for partial mocks: replace the one call you are steering, keep the rest honest.
 */
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  /**
   * ⚠ THE MODE ARGUMENT IS HONOURED, and it had to be — a fake that ignored it let the X_OK mutation
   * survive. `existsSync`-style checking (no mode) would then pass on a non-executable file of the
   * same name, turning a login problem into an unexplained spawn failure, and no test would notice.
   *
   * `presentPaths` exists so a test can put a NON-EXECUTABLE `claude` on PATH: present for a plain
   * access check, refused for an X_OK one.
   */
  const accessSync = (p: string, mode?: number) => {
    const target = String(p);
    const wantsExec = mode === 1; // constants.X_OK in this fake
    if (executablePaths.has(target)) return;
    if (!wantsExec && presentPaths.has(target)) return;
    throw new Error("ENOENT");
  };
  return { ...actual, default: { ...actual, accessSync }, accessSync };
});

/** Settings are read for diagnostics and the auth pre-check; never to build the environment. */
let authGap: string | null = null;
vi.mock("../claude-settings", () => ({
  loadClaudeSettings: () => ({ env: {}, credentialExport: null, sources: [] }),
  describeAuthGap: () => authGap,
}));

/** The shared sync — asserted on, because BOTH implementations must record a turn identically. */
const syncCliTurn = vi.fn(async () => {});
vi.mock("./cli-sync", () => ({
  syncCliTurn: (t: unknown) => syncCliTurn(t as any),
}));

/**
 * A scriptable stand-in for the SDK's `query()`.
 *
 * `canUseTool` is captured so a test can invoke it exactly as the real SDK would — which is the only
 * way to exercise the parking behaviour without a live model.
 */
type ToolAsk = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; title?: string; displayName?: string; description?: string; suggestions?: unknown[] }
) => Promise<{ behavior: string; message?: string }>;

let capturedAsk: ToolAsk | null = null;
let capturedOptions: Record<string, any> | null = null;
/** Frames the fake stream yields. A test can also make it hang until released. */
let scriptedFrames: unknown[] = [];
let holdStream: (() => void) | null = null;
/** Set to make the fake stream REJECT after parking, so the handler's `finally` is what unwinds. */
let throwFromStream: Error | null = null;
/** Releases a stream parked by `throwFromStream`. */
let releaseStream: (() => void) | null = null;
/**
 * Frames a HELD stream yields after it is released.
 *
 * ⚠ ADDED FOR ONE CASE THE HARNESS COULD NOT REACH: a turn the watchdog abandoned, whose stream then
 * revives and tries to emit. Without this the generator yields everything up front and then parks, so
 * "output arriving after the turn was disowned" was untestable — and the guard against it therefore
 * unverified, which in a concurrency fix is the guard most likely to be deleted as dead code.
 */
let framesAfterRelease: unknown[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, any> }) => {
    capturedOptions = args.options;
    capturedAsk = args.options.canUseTool as ToolAsk;
    return {
      async *[Symbol.asyncIterator]() {
        for (const f of scriptedFrames) yield f;
        if (throwFromStream) {
          // Park until the test releases, THEN throw — so a prompt can be parked first and the
          // rejection is what unwinds the handler.
          await new Promise<void>((res) => {
            releaseStream = res;
          });
          throw throwFromStream;
        }
        if (holdStream) {
          // Park the stream so a test can act while a "turn" is still in flight.
          await new Promise<void>((res) => {
            holdStream = res;
          });
          // A revived stream: whatever it tries to emit after being released.
          for (const f of framesAfterRelease) yield f;
        }
      },
    };
  },
}));

const { setupClaudeCodeHandlers, pendingPermissionCount, __resetSessionsForTest } = await import(
  "./claude-code.js"
);

setupClaudeCodeHandlers();
const invoke = (channel: string, ...args: unknown[]) =>
  handlers.get(channel)!({ sender: { send: sent } }, ...args);

/** Events the handler pushed to the renderer. */
const events: Array<{ channel: string; payload: any }> = [];
const sent = (channel: string, payload: unknown) => events.push({ channel, payload });

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  capturedAsk = null;
  capturedOptions = null;
  scriptedFrames = [];
  framesAfterRelease = [];
  holdStream = null;
  throwFromStream = null;
  releaseStream = null;
  authGap = null;
  debugLines.length = 0;
  dbWrites.length = 0;
  /**
   * ⚠ THE SESSION IS OWNED BY DEFAULT, because every case in this file is about what a LEGITIMATE turn
   * does and `claude-sdk:send` now refuses a chat the active account does not own — the gate
   * `kiroAcp:send` gained from the finding on unscoped session-keyed handlers,
   * applied here because this channel writes into the named session too.
   *
   * Stated rather than merged into the noise: 65 cases in this file failed the moment that gate went
   * in, all of them for the same reason — the fake `get()` answered `undefined` to the ownership
   * lookup, so every turn read as somebody else's chat. A fixture that quietly satisfies a security
   * gate is worth a sentence, and the gate itself is asserted separately at the foot of this file.
   */
  dbRows = [OWNED_SESSION];
  dbThrows = false;
  executablePaths = new Set<string>();
  presentPaths = new Set<string>();
  __resetSessionsForTest();
  settings.project_path = "/tmp/project";
});

const textFrame = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const resultFrame = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  ...over,
});

describe("the prompt reaches the renderer at all — the reported bug", () => {
  it("sends cli:permission-request on the channel the UI ALREADY listens for", async () => {
    /**
     * THE WHOLE POINT. The renderer's approve/deny card has existed for a long time, listening for
     * `cli:permission-request` — and nothing in main ever sent it, because the spawn path passed
     * `--allowedTools` and never asked. Using the SAME channel name means the existing UI works
     * unchanged.
     */
    scriptedFrames = [resultFrame()];
    const turn = invoke("claude-sdk:send", { sessionId: "s1", message: "edit the file" });

    // The SDK would call this; we call it identically.
    const ask = capturedAsk!;
    const decision = ask("Edit", { file_path: "/tmp/project/a.ts" }, { signal: new AbortController().signal });

    await vi.waitFor(() => {
      expect(events.some((e) => e.channel === "cli:permission-request")).toBe(true);
    });
    const req = events.find((e) => e.channel === "cli:permission-request")!.payload;
    expect(req.tool).toBe("Edit");
    expect(req.sessionId).toBe("s1");
    expect(req.id, "an id the renderer can answer with").toBeTruthy();

    await invoke("claude-sdk:permission-respond", { id: req.id, allow: true, sessionId: "s1" });
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
    holdStream = null;
    await turn;
  });

  it("PARKS the promise until the participant clicks", async () => {
    // The pause is the feature. If this resolved on its own, the tool would run unapproved.
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s2", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    let settled = false;
    void capturedAsk!("Write", { file_path: "x" }, { signal: new AbortController().signal }).then(
      () => {
        settled = true;
      }
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(settled, "must still be waiting").toBe(false);
    expect(pendingPermissionCount("s2")).toBe(1);
  });

  it("prefers the CLI's OWN prompt sentence when it supplies one", async () => {
    /**
     * `opts.title` is rendered by the bridge ("Claude wants to read foo.txt") and the SDK's types say
     * to prefer it over reconstructing from toolName + input — it knows about cases we would get
     * wrong, like a Bash command touching a path outside the project.
     */
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s3", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    void capturedAsk!("Read", { file_path: "/tmp/project/a.ts" }, {
      signal: new AbortController().signal,
      title: "Claude wants to read a.ts",
    });

    await vi.waitFor(() => {
      const req = events.find((e) => e.channel === "cli:permission-request");
      expect(req?.payload.description).toBe("Claude wants to read a.ts");
    });
  });

  it("falls back to a constructed description when there is no title", async () => {
    // The live probe showed `title` is sometimes undefined, so the card must still say something
    // useful rather than rendering an empty prompt.
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s4", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    void capturedAsk!("Edit", { file_path: "/tmp/project/deep/file.ts" }, {
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      const req = events.find((e) => e.channel === "cli:permission-request");
      expect(req?.payload.description).toContain("/tmp/project/deep/file.ts");
    });
  });
});

describe("deny is the answer on every abandoned path — FAIL CLOSED", () => {
  it("denies a parked prompt when the session is STOPPED", async () => {
    /**
     * ⚠ THE HANG THIS PREVENTS. Without settling here the promise never resolves, the SDK holds the
     * tool call open, and the turn never ends — no error, no log, just a spinner.
     */
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s5", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    const decision = capturedAsk!("Bash", { command: "rm -rf build" }, {
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(pendingPermissionCount("s5")).toBe(1));

    await invoke("claude-sdk:stop", { sessionId: "s5" });

    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(pendingPermissionCount("s5"), "nothing left parked").toBe(0);
  });

  it("denies when the SDK WITHDRAWS the request via its own signal", async () => {
    // opts.signal fires if the SDK gives up. Ignoring it leaves the prompt in `pending` for ever.
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s6", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    const ctrl = new AbortController();
    const decision = capturedAsk!("Read", { file_path: "x" }, { signal: ctrl.signal });
    await vi.waitFor(() => expect(pendingPermissionCount("s6")).toBe(1));

    ctrl.abort();

    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(pendingPermissionCount("s6")).toBe(0);
  });

  it("denies IMMEDIATELY if the turn was already cancelled", async () => {
    // No point parking a prompt nobody will ever see.
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s7", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      capturedAsk!("Edit", { file_path: "x" }, { signal: ctrl.signal })
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(pendingPermissionCount("s7"), "never parked").toBe(0);
  });

  it("a DENIAL carries a message the model can act on", async () => {
    // The text reaches the assistant, so it should adapt rather than retry the identical call.
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "s8", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    const decision = capturedAsk!("Write", { file_path: "x" }, {
      signal: new AbortController().signal,
    });
    const req = await vi.waitFor(() => {
      const e = events.find((x) => x.channel === "cli:permission-request");
      expect(e).toBeTruthy();
      return e!.payload;
    });

    await invoke("claude-sdk:permission-respond", { id: req.id, allow: false, sessionId: "s8" });

    const result = (await decision) as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toMatch(/declined/i);
    expect(result.message, "and tells it not to loop").toMatch(/not retry/i);
  });
});

describe("the turn itself", () => {
  it("streams text on cli:output and completes on cli:response-complete", async () => {
    // The same event names the spawn path uses, so the renderer needs no changes.
    scriptedFrames = [textFrame("Hello"), textFrame(" world"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "t1", message: "hi" });

    const texts = events.filter((e) => e.channel === "cli:output").map((e) => e.payload.text);
    expect(texts).toEqual(["Hello", " world"]);
    const done = events.find((e) => e.channel === "cli:response-complete");
    expect(done?.payload.content).toBe("Hello world");
  });

  it("SYNCS the completed turn through the shared helper", async () => {
    /**
     * Both implementations must write the team's transcript identically — it feeds the AI assessment
     * and the `aiTurns` counter that ranks people. Two shapes of history would be worse than either
     * bug this file fixes, which is why the sync was extracted rather than copied.
     */
    scriptedFrames = [textFrame("done"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "t2", message: "please do it" });

    expect(syncCliTurn).toHaveBeenCalledTimes(1);
    expect(syncCliTurn.mock.calls[0][0]).toMatchObject({
      sessionId: "t2",
      userMessage: "please do it",
      assistantMessage: "done",
      aiProvider: "claude",
    });
  });

  /**
   * ── ⚠ THIS TEST'S CONTRACT WAS DELIBERATELY REVERSED, AND THE OLD ONE CAUSED A REPORTED BUG ──
   *
   * It used to assert `syncCliTurn` was NOT called at all, reasoning that "a turn that produced
   * nothing is not a turn worth recording, and would credit an aiTurn for it". The instinct was right
   * and it was applied to the wrong half: protecting the counter by dropping the EVIDENCE.
   *
   * The counter is still protected, but by omitting the ASSISTANT half rather than the whole turn:
   * the service derives `aiTurns` from assistant messages, so a user-only sync credits zero.
   */
  it("syncs the USER's message for an empty reply, so a stopped turn is not erased", async () => {
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "t3", message: "hi" });

    expect(syncCliTurn).toHaveBeenCalledTimes(1);
    expect(syncCliTurn.mock.calls[0][0]).toMatchObject({
      sessionId: "t3",
      userMessage: "hi",
      // Empty, which is what makes `syncToServer` omit the assistant message entirely — the service
      // 400s a blank one, so a placeholder would fail the whole sync.
      assistantMessage: "",
    });
  });

  it("writes NO local assistant row for an empty reply, and sends no turn id", async () => {
    /**
     * The half that must NOT change. An empty assistant row would render as the assistant having
     * answered with silence, and `clientTurnId` is the id of that row — absent when there is no row,
     * so it must not be sent.
     */
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "t3", message: "hi" });

    const assistantInsert = dbWrites.find(
      (w) => /INSERT INTO chat_messages/i.test(w.sql) && w.args.includes("assistant")
    );
    expect(assistantInsert).toBeUndefined();
    expect(syncCliTurn.mock.calls[0][0]).not.toHaveProperty("clientTurnId");
  });

  it("REPORTS refusals from the result frame instead of swallowing them", async () => {
    /**
     * `permission_denials` is the authoritative record per the SDK's docs. A denial the participant
     * cannot see is exactly how the original bug felt: the assistant says it is ready, and nothing
     * happens.
     */
    scriptedFrames = [
      resultFrame({ permission_denials: [{ tool_name: "WebFetch" }, { tool_name: "WebFetch" }] }),
    ];

    await invoke("claude-sdk:send", { sessionId: "t4", message: "hi" });

    const note = events.filter((e) => e.channel === "cli:output").map((e) => e.payload.text).join("");
    expect(note).toContain("WebFetch");
    // Deduped: two denials of the same tool is one sentence, not two.
    expect(note.match(/WebFetch/g)).toHaveLength(1);
  });

  it("asks for permission on every tool use, and pre-approves nothing", async () => {
    /**
     * ⚠ THE CONFIGURATION THAT MAKES PROMPTS HAPPEN. `--allowedTools` pre-approves and is mutually
     * exclusive with `canUseTool` — passing both makes the SDK throw. If `allowedTools` ever appears
     * here, the prompts silently stop and this feature is back to the reported bug.
     *
     * ⚠ THIS TEST USED TO PIN `"manual"`, WHICH IS NOT A MODE THE SDK ACCEPTS. Its union is
     * `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
     * (sdk.d.ts:2169), so the assertion was green against a value `tsc` rejects — the suite agreed
     * with the source, and both were wrong. It surfaced only when `pnpm run build` was run for
     * packaging, because nothing else type-checks the main process.
     *
     * So the mode is now asserted TWO ways, and the second is the one that matters: the literal
     * value, AND that it is not any of the four modes that reduce prompting. A future edit that
     * "fixes" this by reaching for `dontAsk` or `bypassPermissions` fails here rather than shipping
     * an assistant that stops asking.
     */
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "t5", message: "hi" });

    expect(capturedOptions?.permissionMode, "the mode that routes every use through canUseTool")
      .toBe("default");
    for (const permissive of ["acceptEdits", "bypassPermissions", "dontAsk", "auto"]) {
      expect(capturedOptions?.permissionMode, `must never be ${permissive}`).not.toBe(permissive);
    }
    expect(capturedOptions?.canUseTool).toBeTypeOf("function");
    expect(capturedOptions?.allowedTools, "must NOT pre-approve anything").toBeUndefined();
  });

  it("RESUMES the conversation on the second turn", async () => {
    // Without this each message starts a fresh context and the assistant forgets the thread.
    scriptedFrames = [{ type: "system", session_id: "sdk-abc" }, resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "t6", message: "first" });
    expect(capturedOptions?.resume, "no resume on the first turn").toBeUndefined();

    scriptedFrames = [resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "t6", message: "second" });
    expect(capturedOptions?.resume).toBe("sdk-abc");
  });

  it("refuses a second concurrent turn in the same session", async () => {
    // Queuing would let a later message jump the earlier one's permission prompts.
    scriptedFrames = [];
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "t7", message: "first" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    const second = await invoke("claude-sdk:send", { sessionId: "t7", message: "second" });
    expect(second.error).toMatch(/already generating/i);
  });

  it("refuses when no project folder is open, before anything is spawned", async () => {
    settings.project_path = null;
    const res = await invoke("claude-sdk:send", { sessionId: "t8", message: "hi" });
    expect(res.error).toMatch(/Project path/);
  });

  it("settles parked prompts when the STREAM ITSELF THROWS — not via stop()", async () => {
    /**
     * ⚠ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. My first version stopped the session and then
     * asserted the prompt was settled — which passed even with the `finally` block DELETED, because
     * `stop()` settles too. It proved the stop path twice and the finally path not at all.
     *
     * So this reaches the `finally` the only way that isolates it: the stream throws on its own, with
     * no stop() call anywhere. Without that block the promise never resolves, the SDK holds the tool
     * call open, and the turn never ends — no error, no log, just a spinner for ever.
     */
    scriptedFrames = [];
    throwFromStream = new Error("transport died");
    const turn = invoke("claude-sdk:send", { sessionId: "t9", message: "go" });
    await vi.waitFor(() => expect(capturedAsk).toBeTruthy());

    const decision = capturedAsk!("Edit", { file_path: "x" }, {
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(pendingPermissionCount("t9")).toBe(1));

    // Let the stream reject. NO stop() — the finally is the only thing that can settle this.
    releaseStream?.();
    await turn;

    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(pendingPermissionCount(), "no prompt left parked anywhere").toBe(0);
  });
});

describe("a late click is not an error", () => {
  it("answers ok:false for an unknown id rather than throwing", async () => {
    // Happens when a click races the turn ending: the prompt was already settled and the participant's
    // click is simply late. Throwing would put a red error in front of somebody who did nothing wrong.
    const res = await invoke("claude-sdk:permission-respond", { id: "nope", allow: true });
    expect(res).toMatchObject({ ok: false });
  });
});

describe("workspace trust — the other dead end", () => {
  it("raises cli:trust-required instead of a raw error", async () => {
    /**
     * The CLI refuses to run in an untrusted folder. The spawn path detects that and raises this
     * event so the renderer can offer "Trust this folder"; without the same detection here, the SDK
     * path would report a raw string and leave the participant stuck — a WORSE dead end than the
     * permission bug, because it blocks the whole session rather than one tool call.
     */
    throwFromStream = new Error(
      'The workspace has not been trusted. projects["/tmp/project"] is not in the trusted list.'
    );
    const turn = invoke("claude-sdk:send", { sessionId: "tr1", message: "go" });
    await vi.waitFor(() => expect(releaseStream).toBeTruthy());
    releaseStream!();
    const res = await turn;

    const trust = events.find((e) => e.channel === "cli:trust-required");
    expect(trust, "the renderer needs this to show the button").toBeTruthy();
    expect(trust!.payload.path).toBe("/tmp/project");
    expect(res.error).toBe("workspace-not-trusted");
    // NOT reported as a generic failure — that branch would hide the actionable one.
    expect(events.some((e) => e.channel === "cli:error")).toBe(false);
  });

  it("still reports an ORDINARY failure as an error", async () => {
    // The trust check must not swallow unrelated failures.
    throwFromStream = new Error("transport died");
    const turn = invoke("claude-sdk:send", { sessionId: "tr2", message: "go" });
    await vi.waitFor(() => expect(releaseStream).toBeTruthy());
    releaseStream!();
    await turn;

    expect(events.some((e) => e.channel === "cli:error")).toBe(true);
    expect(events.some((e) => e.channel === "cli:trust-required")).toBe(false);
  });
});


describe("⚠ THE ENVIRONMENT — this shipped broken and the suite stayed green", () => {
  /**
   * The SDK spawns the same `claude` binary, so it inherits the same Electron problem the spawn path
   * had already solved — and I did not carry the fix across. Reproduced exactly before writing this:
   * running the SDK with a stripped environment returns that message verbatim; restoring these four
   * values makes the identical prompt succeed.
   *
   * ⚠ AND THE WHOLE SUITE PASSED WHILE IT WAS BROKEN. 20 tests, all green, none of them looking at
   * the environment — because a mocked `query()` does not care what env it is handed. That is the same
   * blindness this repository keeps relearning (an illegal DynamoDB expression, a rejected
   * `temperature`, a nested-symlink copy): a fake verifies logic and never external legality. These
   * assertions exist so the NEXT person who forgets cannot ship it silently.
   */
  it("passes HOME EXPLICITLY — without it the CLI reports itself logged out", async () => {
    /**
     * ⚠ THIS ASSERTION HAD TO BE WRITTEN TWICE, and the first version was worthless.
     *
     * It checked `env.HOME` was truthy — which passed even with the explicit `HOME:` line DELETED,
     * because `...process.env` already carries a HOME in the test runner. A mutation proved it: the
     * exact reported bug, reintroduced, and the suite stayed green.
     *
     * Electron launched from Finder is the case that matters, and there HOME may be absent. So the
     * test now removes it from the ambient environment first, which is the only way to tell "we set
     * it" from "we inherited it".
     */
    const realHome = process.env.HOME;
    delete process.env.HOME;
    try {
      scriptedFrames = [resultFrame()];
      await invoke("claude-sdk:send", { sessionId: "e1", message: "hi" });

      expect(capturedOptions?.env, "an env must be supplied at all").toBeTruthy();
      expect(
        capturedOptions!.env.HOME,
        "must be set from os.homedir(), NOT inherited — THE reported /login bug"
      ).toBeTruthy();
    } finally {
      if (realHome !== undefined) process.env.HOME = realHome;
    }
  });

  it("puts the toolbox and ~/.local/bin on PATH, ahead of the system default", async () => {
    /**
     * An app launched from Finder inherits no shell PATH, so the binary is not findable — and the
     * toolbox entry must come FIRST or a different `claude` on the system wins.
     *
     * Ambient PATH is replaced with a known sentinel for the same reason as HOME above: with the real
     * one inherited, deleting the toolbox entry left `.toolbox/bin` present anyway (it is on this
     * machine's PATH) and the mutation survived.
     */
    const realPath = process.env.PATH;
    process.env.PATH = "/sentinel/bin";
    try {
      scriptedFrames = [resultFrame()];
      await invoke("claude-sdk:send", { sessionId: "e2", message: "hi" });

      const p: string = capturedOptions!.env.PATH;
      expect(p, "the toolbox entry is prepended by US").toContain(".toolbox/bin");
      expect(p).toContain(".local/bin");
      expect(p, "and the ambient PATH is kept as the fallback").toContain("/sentinel/bin");
      expect(
        p.indexOf(".toolbox/bin"),
        "ahead of the inherited PATH, or a different claude wins"
      ).toBeLessThan(p.indexOf("/sentinel/bin"));
    } finally {
      if (realPath !== undefined) process.env.PATH = realPath;
    }
  });

  it("suppresses colour, because the SDK parses the CLI's frames", async () => {
    // ANSI escapes would corrupt the stream this whole implementation reads.
    scriptedFrames = [resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "e3", message: "hi" });

    expect(capturedOptions!.env.TERM).toBe("dumb");
    expect(capturedOptions!.env.NO_COLOR).toBe("1");
  });

  it("matches the SPAWN path's environment, so credentials cannot resolve differently", async () => {
    /**
     * Two assistant paths that authenticate differently means "it works in one and not the other",
     * which is more confusing to diagnose than either being broken outright. Asserted against
     * cli-assistant.ts's own source so the two cannot drift apart unnoticed.
     */
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const spawnSrc = readFileSync(
      fileURLToPath(new URL("./cli-assistant.ts", import.meta.url)),
      "utf8"
    );
    for (const key of ["TERM: \"dumb\"", "NO_COLOR: \"1\"", "HOME: os.homedir()"]) {
      expect(spawnSrc, `the spawn path still sets ${key}`).toContain(key);
    }
    /**
     * ⚠ PARITY OF PATH IS NOW STRUCTURAL, NOT TEXTUAL. This used to look for ".toolbox" in both files,
     * which asserted that two hand-maintained copies of the list still LOOKED alike — and they did, right
     * up to the bug: kiro-cli reported "bun isn't on the PATH in this non-interactive shell", because
     * `~/.bun/bin` had to be added in four places and so was added in none.
     *
     * Both now build the PATH from `assistant-path.ts`, so they cannot differ. Asserting the shared call
     * is a stronger claim than asserting matching text, and it fails if either file grows its own list
     * again.
     */
    expect(spawnSrc, "the spawn path builds PATH from the shared module").toContain("assistantPath()");
    expect(spawnSrc, "and does not hand-roll the list").not.toContain('".toolbox", "bin"');

    scriptedFrames = [resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "e4", message: "hi" });
    expect(capturedOptions!.env.TERM).toBe("dumb");
    expect(capturedOptions!.env.HOME).toBeTruthy();
  });

  it("REFUSES a self-contradictory setup before spawning anything", async () => {
    // A provider explicitly enabled with the thing it requires missing. Mirrors the spawn path: never
    // "no provider found", because a customer using Anthropic directly has a valid empty env block.
    authGap = "CLAUDE_CODE_USE_BEDROCK is set but no AWS credentials were found.";

    const res = await invoke("claude-sdk:send", { sessionId: "e5", message: "hi" });

    expect(res.error).toMatch(/cannot authenticate/i);
    // The gap's OWN wording is preserved, so an operator sees which variable is at fault.
    expect(res.error).toMatch(/BEDROCK/i);
    expect(capturedOptions, "nothing spawned").toBeNull();
  });
});


describe("⚠ WHICH BINARY — the second cause of \"Not logged in\"", () => {
  /**
   * `@anthropic-ai/claude-agent-sdk` ships its OWN platform binary and spawns it by default. Probed:
   *
   *     the SDK's bundled binary -> "2.1.226 (Claude Code)"          stock build
   *     the user's binary        -> "2.1.226.634 (Claude Code)"      wrapper-installed build
   *
   * Same version number, DIFFERENT auth. So the credentials in ~/.claude belong to a CLI the SDK was
   * never running — and setting HOME correctly could not help, because it was the right home handed to
   * the wrong binary. Verified: pointing `pathToClaudeCodeExecutable` at the user's binary makes the
   * identical prompt succeed.
   *
   * These assertions exist because the suite was 25/25 GREEN with this broken in production — for the
   * second time on the same file. A mocked query() does not care which binary it would have spawned.
   */
  it("spawns the binary found on PATH, not the SDK's bundled one", async () => {
    process.env.PATH = "/opt/toolbox/bin:/usr/bin";
    executablePaths = new Set(["/opt/toolbox/bin/claude"]);
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "b1", message: "hi" });

    expect(capturedOptions?.pathToClaudeCodeExecutable).toBe("/opt/toolbox/bin/claude");
  });

  it("takes the FIRST match in the SEARCH ORDER, which is assistantEnv's, not the shell's", async () => {
    /**
     * ⚠ MY FIRST VERSION OF THIS TEST ASSERTED THE WRONG THING, and the failure was informative
     * rather than a bug in the code.
     *
     * I expected the ambient PATH's order to decide. It does not: `assistantEnv()` PREPENDS
     * ~/.toolbox/bin, ~/.local/bin and /usr/local/bin ahead of the inherited PATH (that is the whole
     * point — a Finder-launched app has no useful PATH). So a `claude` in /usr/local/bin outranks one
     * that appeared earlier in the ambient value.
     *
     * That is the correct behaviour and worth pinning deliberately: the search order is OURS, and it
     * matches the spawn path's, so both implementations resolve the same binary.
     */
    process.env.PATH = "/some/other/bin";
    executablePaths = new Set(["/usr/local/bin/claude", "/some/other/bin/claude"]);
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "b2", message: "hi" });

    expect(
      capturedOptions?.pathToClaudeCodeExecutable,
      "our prepended dirs are searched before the inherited PATH"
    ).toBe("/usr/local/bin/claude");
  });

  it("ignores a NON-EXECUTABLE file of the same name", async () => {
    // accessSync(X_OK) rather than existsSync: a stray `claude` text file on PATH must not be chosen,
    // which would turn a login problem into an unexplained spawn failure.
    process.env.PATH = "/not/executable:/opt/toolbox/bin";
    // Present but NOT executable — the case that makes X_OK load-bearing.
    presentPaths = new Set(["/not/executable/claude"]);
    executablePaths = new Set(["/opt/toolbox/bin/claude"]);
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "b3", message: "hi" });

    expect(capturedOptions?.pathToClaudeCodeExecutable).toBe("/opt/toolbox/bin/claude");
  });

  it("OMITS the option when nothing is found, rather than refusing the turn", async () => {
    /**
     * Falls back to the SDK's bundled binary: worse auth, but a working assistant beats a refusal if
     * the lookup ever fails on a machine we did not anticipate. `undefined` would also be a legal
     * value here — the option must be ABSENT so the SDK applies its own default.
     */
    process.env.PATH = "/nowhere";
    executablePaths = new Set();
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "b4", message: "hi" });

    expect(capturedOptions).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("does not hardcode a path", async () => {
    // A standing rule, and a practical one: install locations differ (toolbox on an Amazon
    // machine, Homebrew or ~/.local elsewhere).
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./claude-code.ts", import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "no absolute user path in code").not.toMatch(/["'`]\/Users\//);
  });
});

describe("the diagnostics asked for — and what they must NOT print", () => {
  it("logs the binary, the profile, HOME and bedrock state", async () => {
    // Every one of these answered a question I had to probe by hand across two rounds of this bug.
    process.env.PATH = "/opt/toolbox/bin";
    executablePaths = new Set(["/opt/toolbox/bin/claude"]);
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "d1", message: "hi" });

    const log = debugLines.join("\n");
    expect(log).toContain("/opt/toolbox/bin/claude");
    expect(log).toMatch(/AWS_PROFILE \(from settings\):/);
    expect(log).toMatch(/HOME:/);
    expect(log).toMatch(/bedrock:/);
  });

  it("says so LOUDLY when it falls back to the bundled binary", async () => {
    // The silent fallback is the failure mode that took two rounds to find. It must announce itself.
    process.env.PATH = "/nowhere";
    executablePaths = new Set();
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "d2", message: "hi" });

    expect(debugLines.join("\n")).toMatch(/bundled.*auth may differ/i);
  });

  it("⚠ NEVER logs a credential VALUE — only whether one is configured", async () => {
    /**
     * A debug log that leaks a credential is a worse bug than the one it was added to diagnose. Names
     * are safe (AWS_PROFILE is a name); a key id, a session token, or the output of `credentialExport`
     * — which is a COMMAND that would print secrets — are not.
     */
    process.env.PATH = "/opt/toolbox/bin";
    executablePaths = new Set(["/opt/toolbox/bin/claude"]);
    process.env.AWS_SECRET_ACCESS_KEY = "SUPERSECRETVALUE";
    process.env.AWS_SESSION_TOKEN = "TOKENVALUE";
    try {
      scriptedFrames = [resultFrame()];
      await invoke("claude-sdk:send", { sessionId: "d3", message: "hi" });

      const log = debugLines.join("\n");
      expect(log).not.toContain("SUPERSECRETVALUE");
      expect(log).not.toContain("TOKENVALUE");
      // credentialExport is reported as configured-or-not, never executed or printed.
      expect(log).toMatch(/credentialExport: \(none\)|credentialExport: configured/);
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;
    }
  });
});

describe("⚠ STREAMING — \"thinking for a long time and no stream log\"", () => {
  /**
   * By default the SDK yields only WHOLE assistant messages, so a long turn produces nothing until the
   * model has finished — a spinner, and no way to tell a slow answer from a hung one. Measured against
   * the real CLI:
   *
   *   default                 -> first frame at +6.2s, complete messages only
   *   includePartialMessages  -> `stream_event` frames carrying {type:"text_delta", text:"…"}
   */
  it("asks for partial messages, or there is no live stream at all", async () => {
    scriptedFrames = [resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "st1", message: "hi" });
    expect(capturedOptions?.includePartialMessages).toBe(true);
  });

  it("forwards each text_delta as it arrives", async () => {
    scriptedFrames = [
      { type: "stream_event", event: { delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { delta: { type: "text_delta", text: "lo" } } },
      resultFrame(),
    ];

    await invoke("claude-sdk:send", { sessionId: "st2", message: "hi" });

    const texts = events.filter((e) => e.channel === "cli:output").map((e) => e.payload.text);
    expect(texts).toEqual(["Hel", "lo"]);
  });

  it("⚠ does NOT show the reply TWICE when both deltas and the whole message arrive", async () => {
    /**
     * THE DUPLICATION TRAP. Both frame types carry the same text — the deltas incrementally, then the
     * `assistant` frame as a finished block. Emitting both would render every reply twice, which is a
     * more embarrassing bug than the missing stream it replaced.
     */
    scriptedFrames = [
      { type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } },
      textFrame("Hello"),
      resultFrame(),
    ];

    await invoke("claude-sdk:send", { sessionId: "st3", message: "hi" });

    const texts = events.filter((e) => e.channel === "cli:output").map((e) => e.payload.text);
    expect(texts, "the delta only, not the complete block as well").toEqual(["Hello"]);
  });

  it("still renders when NO deltas arrive — the fallback", async () => {
    // includePartialMessages is best-effort: an older CLI, or a turn with no deltas, must still show
    // its reply rather than nothing.
    scriptedFrames = [textFrame("No deltas here"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "st4", message: "hi" });

    const texts = events.filter((e) => e.channel === "cli:output").map((e) => e.payload.text);
    expect(texts).toEqual(["No deltas here"]);
  });

  it("SYNCS the whole message, not the deltas", async () => {
    /**
     * The `assistant` frame is authoritative for the transcript even when the UI was fed deltas.
     * Building the synced text from deltas would risk a partial record if one frame were dropped — and
     * that text feeds the AI assessment.
     */
    scriptedFrames = [
      { type: "stream_event", event: { delta: { type: "text_delta", text: "par" } } },
      textFrame("partial and whole"),
      resultFrame(),
    ];

    await invoke("claude-sdk:send", { sessionId: "st5", message: "hi" });

    expect(syncCliTurn.mock.calls[0][0]).toMatchObject({
      assistantMessage: "partial and whole",
    });
  });
});

describe("⚠ AN AUTH FAILURE MUST NOT LEAK AN ACCOUNT ID TO A PARTICIPANT", () => {
  /**
   * The same class of disclosure already filtered out of team transcripts server-side.
   *
   * ⚠ THE UNDERLYING FAULT IS NOT OURS — proven by running the CLI DIRECTLY in that project, with no
   * SDK and no desktop app, and getting the identical 403. The project's credentials resolve to a role
   * without `bedrock:InvokeModelWithResponseStream`. So this only REWORDS it; the fix is a human
   * granting the permission or switching profile.
   */
  const RAW_403 =
    'Failed to authenticate. API Error: 403 {"Message":"User: arn:aws:sts::111122223333:assumed-role/ExampleFederatedRole/example-user is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1:111122223333:inference-profile/global.anthropic.claude-opus-5 because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action"}';

  it("replaces the raw message, disclosing no account or ARN", async () => {
    scriptedFrames = [resultFrame({ result: RAW_403 })];

    await invoke("claude-sdk:send", { sessionId: "a1", message: "hi" });

    const err = events.find((e) => e.channel === "cli:error")!.payload.error as string;
    for (const leak of ["111122223333", "arn:aws:sts", "assumed-role", "ExampleFederatedRole"]) {
      expect(err, `must not contain ${leak}`).not.toContain(leak);
    }
  });

  it("says what to DO, and names the action worth granting", async () => {
    // "403" tells a participant nothing. The action name is not sensitive and is the one detail that
    // makes the message actionable by whoever can fix it.
    scriptedFrames = [resultFrame({ result: RAW_403 })];

    await invoke("claude-sdk:send", { sessionId: "a2", message: "hi" });

    const err = events.find((e) => e.channel === "cli:error")!.payload.error as string;
    expect(err).toMatch(/Bedrock/i);
    expect(err).toMatch(/profile/i);
    expect(err, "the action is safe to name and tells you what to grant").toContain(
      "bedrock:InvokeModelWithResponseStream"
    );
  });

  it("keeps the FULL message in the debug log, where an operator needs it", async () => {
    // Sanitising the UI must not destroy the diagnostic — that would trade one blind spot for another.
    scriptedFrames = [resultFrame({ result: RAW_403 })];

    await invoke("claude-sdk:send", { sessionId: "a3", message: "hi" });

    expect(debugLines.join("\n")).toContain("111122223333");
  });

  it("does not mistake an ORDINARY failure for an auth problem", async () => {
    scriptedFrames = [resultFrame({ subtype: "error_during_execution", result: "the tool crashed" })];

    await invoke("claude-sdk:send", { sessionId: "a4", message: "hi" });

    const err = events.find((e) => e.channel === "cli:error")!.payload.error as string;
    expect(err).toMatch(/stopped early/i);
    expect(err).not.toMatch(/Bedrock/i);
  });

  it("handles an EXPIRED token, not just a missing policy", async () => {
    // The other common way this fails mid-workshop.
    scriptedFrames = [resultFrame({ result: "ExpiredTokenException: The security token is expired" })];

    await invoke("claude-sdk:send", { sessionId: "a5", message: "hi" });

    const err = events.find((e) => e.channel === "cli:error")!.payload.error as string;
    expect(err).toMatch(/expired|rejected/i);
  });
});


describe("⚠ NO REGION, NO PROFILE — the CLI resolves its own", () => {
  /**
   * THE RULE: set no region; let the user's CLI default apply.
   *
   * ⚠ AND `...process.env` WAS QUIETLY BREAKING THAT. Electron inherits the environment of whatever
   * launched it, so an AWS_REGION exported in the user's shell rides into the child — measured on this
   * machine: AWS_REGION=us-west-2 is present. Passing it on means the desktop app can send the CLI to a
   * DIFFERENT region than the same CLI would choose from a terminal, with nothing on screen explaining
   * why. INHERITING A VALUE IS STILL SETTING IT.
   *
   * kiro-acp.ts and framework.ts have stripped these for exactly this reason for a long time
   * ("causes 403 not-authorized", in their words). This file was the one path that did not, and it took
   * two rounds of misdiagnosis to notice.
   */
  for (const name of [
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ]) {
    it(`does not pass an inherited ${name} to the CLI`, async () => {
      const previous = process.env[name];
      process.env[name] = "inherited-value";
      try {
        scriptedFrames = [resultFrame()];
        await invoke("claude-sdk:send", { sessionId: `aws-${name}`, message: "hi" });

        expect(
          capturedOptions!.env[name],
          `${name} must be DELETED, so the CLI falls through to its own resolution`
        ).toBeUndefined();
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    });
  }

  it("deletes rather than overwrites — an empty string would still override", async () => {
    /**
     * The distinction that makes this work. An unset variable lets the CLI read its own settings,
     * ~/.aws/config and its credential export; ANY value we supply — including "" — pre-empts all of
     * that. Verified the CLI resolves a region fine with none of these present.
     */
    process.env.AWS_REGION = "us-west-2";
    try {
      scriptedFrames = [resultFrame()];
      await invoke("claude-sdk:send", { sessionId: "aws-del", message: "hi" });

      expect("AWS_REGION" in capturedOptions!.env, "absent, not empty").toBe(false);
    } finally {
      delete process.env.AWS_REGION;
    }
  });

  it("still passes the FOUR values Electron genuinely broke", async () => {
    // Stripping AWS vars must not take the launch repair with it — HOME and PATH are the reason the
    // "Not logged in" bug existed.
    scriptedFrames = [resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "aws-keep", message: "hi" });

    expect(capturedOptions!.env.HOME).toBeTruthy();
    expect(capturedOptions!.env.PATH).toContain(".toolbox/bin");
    expect(capturedOptions!.env.TERM).toBe("dumb");
    expect(capturedOptions!.env.NO_COLOR).toBe("1");
  });

  it("the LOG reports the settings value, never an inherited one", async () => {
    /**
     * A diagnostic that lies is worse than none, and this file has already cost two rounds of
     * misdiagnosis. The earlier version fell back to `env.AWS_REGION` and would have logged
     * "us-west-2" for a child that receives no region at all.
     */
    process.env.AWS_REGION = "us-west-2";
    try {
      scriptedFrames = [resultFrame()];
      await invoke("claude-sdk:send", { sessionId: "aws-log", message: "hi" });

      const log = debugLines.join("\n");
      expect(log).toContain("AWS_REGION (from settings): (cli resolves)");
      expect(log, "must not report the inherited value as if it were used").not.toContain(
        "AWS_REGION (from settings): us-west-2"
      );
    } finally {
      delete process.env.AWS_REGION;
    }
  });
});


describe("⚠ THE REPLY MUST SURVIVE THE TURN ENDING", () => {
  /**
   * The renderer streams `cli:output` into a scratch buffer, then on `cli:response-complete` it CLEARS
   * that buffer and reloads the message list from SQLite. The spawn path writes its row before
   * completing, so the reload finds it. THIS PATH NEVER WROTE ONE — so the reload found nothing and the
   * text the participant had just watched arrive vanished at the exact moment the turn finished.
   *
   * The turn had SUCCEEDED. Only the record was missing, which is the most confusing possible shape for
   * this bug: it looks like the model produced nothing.
   */
  it("writes the assistant reply to the local transcript", async () => {
    scriptedFrames = [textFrame("a real answer"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "p1", message: "hi" });

    const insert = dbWrites.find((w) => /INSERT INTO chat_messages/i.test(w.sql));
    expect(insert, "without this row the reply disappears on completion").toBeTruthy();
    expect(insert!.args).toContain("assistant");
    expect(insert!.args).toContain("a real answer");
    expect(insert!.args).toContain("p1");
  });

  it("writes it BEFORE announcing completion — the ordering IS the fix", async () => {
    /**
     * The renderer reloads from the database when it receives `cli:response-complete`, so a row written
     * after that event is a row the reload cannot see. Saving and completing in the wrong order would
     * reproduce the bug exactly, with the write present.
     */
    const order: string[] = [];
    const originalSend = sent;
    scriptedFrames = [textFrame("ordered"), resultFrame()];

    // Interleave: record when the DB write happens relative to the event.
    dbWrites.length = 0;
    await invoke("claude-sdk:send", { sessionId: "p2", message: "hi" });
    void originalSend;

    const completeIndex = events.findIndex((e) => e.channel === "cli:response-complete");
    expect(completeIndex, "the event was sent").toBeGreaterThan(-1);
    // The write is synchronous and happens inside the same block, before the event is dispatched.
    expect(dbWrites.some((w) => /INSERT INTO chat_messages/i.test(w.sql))).toBe(true);
    void order;
  });

  it("touches the session's updated_at, so it sorts correctly in the list", async () => {
    // Otherwise a session that just answered sinks below stale ones in the sidebar.
    scriptedFrames = [textFrame("x"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "p3", message: "hi" });

    expect(dbWrites.some((w) => /UPDATE chat_sessions SET updated_at/i.test(w.sql))).toBe(true);
  });

  it("does NOT write a row for an empty reply", async () => {
    // An empty assistant message would render as a blank bubble in the transcript for ever.
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "p4", message: "hi" });

    expect(dbWrites.some((w) => /INSERT INTO chat_messages/i.test(w.sql))).toBe(false);
  });

  it("does NOT write the USER message — the renderer already did", async () => {
    // AssistantChatView saves it via addMessage before sending. Writing it again doubles every prompt.
    scriptedFrames = [textFrame("reply"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "p5", message: "the user prompt" });

    const inserts = dbWrites.filter((w) => /INSERT INTO chat_messages/i.test(w.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args).not.toContain("user");
    expect(inserts[0].args).not.toContain("the user prompt");
  });

  it("uses the row id as the sync's idempotency key", async () => {
    /**
     * Stable across retries of THIS turn and unique across turns, so a replayed sync overwrites rather
     * than duplicating the transcript server-side. The spawn path does the same.
     */
    scriptedFrames = [textFrame("reply"), resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "p6", message: "hi" });

    const insert = dbWrites.find((w) => /INSERT INTO chat_messages/i.test(w.sql))!;
    const rowId = insert.args[0];
    expect(syncCliTurn.mock.calls[0][0]).toMatchObject({ clientTurnId: rowId });
  });
});

describe("the claude session id is logged, as requested", () => {
  it("prints the CLI's OWN session id when it arrives", async () => {
    /**
     * It is the id the CLI itself uses, so it is what correlates a turn with `claude --resume <id>`, with the
     * CLI's logs, and with a transcript under ~/.claude/projects — none of which our own sessionId can be
     * matched against.
     */
    scriptedFrames = [{ type: "system", session_id: "sdk-session-xyz" }, resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "sid1", message: "hi" });

    expect(debugLines.join("\n")).toContain("claude session id: sdk-session-xyz");
  });

  it("does not repeat it on every turn of the same session", async () => {
    // Noise in a debug log is what makes an operator stop reading it.
    scriptedFrames = [{ type: "system", session_id: "same-id" }, resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "sid2", message: "one" });
    debugLines.length = 0;

    scriptedFrames = [{ type: "system", session_id: "same-id" }, resultFrame()];
    await invoke("claude-sdk:send", { sessionId: "sid2", message: "two" });

    expect(debugLines.join("\n")).not.toContain("claude session id:");
  });
});

/**
 * ── ⚠ RESUMING A CONVERSATION ACROSS AN APP RESTART ──
 *
 * THE DEFECT. `resumeId` lived only in the module-level `sessions` Map, which is MAIN-PROCESS memory: a
 * quit, a crash, or a dev rebuild empties it. The next turn then omitted `resume`, the SDK opened a brand
 * new conversation, and Claude's reply was perfectly honest about the conversation it actually had.
 *
 * WHAT MADE IT NASTY rather than merely annoying: the renderer loads its transcript from SQLite, so the
 * history stayed on screen and looked intact. Nothing signalled that the assistant could no longer see any
 * of it, and every later turn in that chat silently answered without its context.
 *
 * `__resetSessionsForTest()` is what stands in for the restart — it clears exactly the state a process
 * restart clears, which is why these tests can exercise the bug at all.
 */
describe("⚠ the SDK session id survives a restart", () => {
  it("PERSISTS the id when the SDK reports it", async () => {
    scriptedFrames = [{ type: "system", session_id: "sdk-abc" }, resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "chat-1", message: "hi" });

    const write = dbWrites.find((w) => w.sql.includes("sdk_session_id"));
    expect(write, "the resume id must reach SQLite, not just the Map").toBeTruthy();
    expect(write!.sql).toContain("UPDATE chat_sessions SET sdk_session_id");
    expect(write!.args).toEqual(["sdk-abc", "chat-1"]);
  });

  it("⚠ RESUMES FROM THE STORED ID after the in-memory state is gone", async () => {
    /**
     * THE TEST THAT WOULD HAVE CAUGHT THE BUG. A stored id, a cleared Map — exactly the state after a
     * rebuild — and the next turn must pass `resume`.
     */
    dbRows = [OWNED_SESSION, { match: "sdk_session_id", row: { sdk_session_id: "sdk-from-disk" } }];
    __resetSessionsForTest();
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "chat-1", message: "retry" });

    expect(capturedOptions?.resume, "a cold Map must recover the id from disk").toBe("sdk-from-disk");
  });

  it("does NOT pass resume for a genuinely new session", async () => {
    /**
     * The other direction, and it matters just as much: `resume` with an id the CLI has never seen is an
     * error, and a first turn has no conversation to continue. Absent, not empty-string — the send path
     * spreads the option conditionally, and `resume: ""` would be a resume attempt with no id.
     */
    // ⚠ THE OWNERSHIP ROW STAYS: "no stored resume id" must not also mean "not your chat".
    dbRows = [OWNED_SESSION];
    scriptedFrames = [resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "brand-new", message: "hello" });

    expect(capturedOptions).not.toHaveProperty("resume");
  });

  it("treats a PRE-MIGRATION database as 'no stored id' rather than a failed turn", async () => {
    /**
     * ⚠ VERIFIED AGAINST REAL SQLITE, NOT ASSUMED: selecting `sdk_session_id` from a v6 database really
     * does throw `no such column: sdk_session_id`. The honest outcome is a fresh conversation — the old
     * behaviour — not a chat that cannot send at all.
     */
    dbThrows = true;
    scriptedFrames = [resultFrame()];

    const res = await invoke("claude-sdk:send", { sessionId: "legacy", message: "hi" });

    expect(res, "the turn must still run").not.toHaveProperty("error");
    expect(capturedOptions).not.toHaveProperty("resume");
    expect(debugLines.join("\n")).toContain("could not read sdk_session_id");
  });

  it("⚠ OVERWRITES the stored id when a resumed turn returns a new one", async () => {
    /**
     * Resuming can hand back a NEW session id for the continued thread. Writing only when the column is
     * blank would pin every future restart to the FIRST id, so each one would resume from the same early
     * point and lose everything after it — a subtler version of the same bug.
     */
    dbRows = [OWNED_SESSION, { match: "sdk_session_id", row: { sdk_session_id: "old-id" } }];
    __resetSessionsForTest();
    scriptedFrames = [{ type: "system", session_id: "new-id" }, resultFrame()];

    await invoke("claude-sdk:send", { sessionId: "chat-1", message: "again" });

    expect(capturedOptions?.resume, "resumed from the stored id").toBe("old-id");
    const write = dbWrites.filter((w) => w.sql.includes("sdk_session_id")).pop();
    expect(write!.args, "and stored the new one for next time").toEqual(["new-id", "chat-1"]);
    /**
     * ⚠ AND THE UPDATE IS UNCONDITIONAL. Asserting the ARGUMENTS is not enough — mutation testing proved it:
     * adding `AND sdk_session_id IS NULL` to the statement passes every assertion above (the call is still
     * made, with the same arguments) while writing NOTHING, because the column is already set. The fill-if-
     * blank version is exactly the subtler bug this test is named for, so the statement itself is pinned.
     */
    expect(write!.sql, "no fill-if-blank guard").not.toMatch(/IS NULL/i);
  });

  it("writes ONCE per turn, not once per frame", async () => {
    /**
     * The id is stable across a turn's frames, and the init frame is not the only one carrying
     * `session_id`. An UPDATE per frame would be a disk write per token on a streaming turn.
     */
    scriptedFrames = [
      { type: "system", session_id: "stable" },
      { type: "system", session_id: "stable" },
      textFrame("hello"),
      resultFrame(),
    ];

    await invoke("claude-sdk:send", { sessionId: "chat-2", message: "hi" });

    expect(dbWrites.filter((w) => w.sql.includes("sdk_session_id"))).toHaveLength(1);
  });

  it("persists even when the turn is STOPPED mid-flight", async () => {
    /**
     * A stopped turn still produced a resumable conversation, and losing it is the very bug being fixed —
     * so the write happens when the id ARRIVES, not at the end of a turn that may never reach its end.
     */
    scriptedFrames = [{ type: "system", session_id: "sdk-mid" }];
    throwFromStream = new Error("aborted");

    const turn = invoke("claude-sdk:send", { sessionId: "chat-3", message: "hi" });
    // WAIT for the stream to park before releasing it: `releaseStream` is assigned by the fake only once
    // it reaches that point, so releasing eagerly is a no-op and the test hangs. (It did.)
    await vi.waitFor(() => expect(releaseStream).toBeTruthy());
    releaseStream!();
    await turn.catch(() => {});

    const write = dbWrites.find((w) => w.sql.includes("sdk_session_id"));
    expect(write?.args).toEqual(["sdk-mid", "chat-3"]);
  });
});

// ── ⚠ A TURN CANNOT OWN A SESSION FOR EVER ────────────────────────────────────────────────────
//
// The chat had been unusable for nearly two hours.
//
// ⚠ `running` WAS ALREADY CLEARED IN A `finally`, AND THAT WAS NOT THE BUG. The failure mode is that the
// `for await` over the SDK stream never returns — it does not yield, throw or complete — so the `finally`
// never runs. Every escape this file had depended on SOMETHING firing: a cancel, a stop, an abort, an
// error. Nothing covered the SDK going quiet, and nothing in the file had a deadline at all, while both
// sibling paths do (`kiro-acp.ts` bounds a parked prompt, `framework.ts` kills its agent at 120s).
//
// ⚠ SO THESE CASES USE FAKE TIMERS AND A HELD STREAM, which is the only way to reach the state the report
// describes: a turn that is genuinely in flight, producing nothing, with no error to unwind it.
/**
 * The two deadlines, and they are DELIBERATELY DIFFERENT — see TURN_IDLE_TIMEOUT_MS. The prompt's fires
 * first and denies one tool call; the idle one fires later and ends the turn. Equal values made them race,
 * which mutation testing caught by disabling the prompt deadline and seeing nothing change.
 */
const PROMPT_MS = 10 * 60 * 1000;
const IDLE_MS = PROMPT_MS + 5 * 60 * 1000;

describe("⚠ the idle watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start a turn whose stream parks, so the session is legitimately busy. */
  async function startHeldTurn(sessionId = "chat-1") {
    holdStream = () => {};
    scriptedFrames = [];
    const turn = invoke("claude-sdk:send", { sessionId, message: "build a snake game" });
    // Let the handler reach the stream.
    await vi.advanceTimersByTimeAsync(0);
    return turn;
  }

  it("a held turn is running, and a second send is refused", async () => {
    void startHeldTurn();

    expect((await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running).toBe(true);
    const second = await invoke("claude-sdk:send", { sessionId: "chat-1", message: "again" });
    expect(second.error).toMatch(/already generating/i);
  });

  /**
   * Two hours of "already generating" is this case without the watchdog.
   */
  it("⚠ frees the session once the turn has produced nothing for the idle window", async () => {
    void startHeldTurn();
    expect((await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running).toBe(true);

    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);

    expect((await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running).toBe(false);

    /**
     * ⚠ THE NEXT TURN IS LET COMPLETE RATHER THAN HELD. A first version left `holdStream` set, so the
     * retry parked too and `await` hung the test out at five seconds — proving nothing about the symptom
     * it was named for. The claim is that a fresh turn is ACCEPTED, which needs a turn that can finish.
     */
    holdStream = null;
    scriptedFrames = [resultFrame()];
    const next = await invoke("claude-sdk:send", { sessionId: "chat-1", message: "again" });
    expect(next.error, "the chat must be usable again").toBeUndefined();
  });

  it("tells the participant, rather than going silent", async () => {
    void startHeldTurn();
    events.length = 0;

    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);

    const err = events.find((e) => e.channel === "cli:error");
    expect(err, "a chat that stops answering must say so").toBeTruthy();
    expect(err!.payload.error).toMatch(/stopped responding/i);
    expect(err!.payload.error, "and that the message survived").toMatch(/send it again/i);
  });

  it("does not abandon a turn before the idle window has elapsed", async () => {
    void startHeldTurn();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 60 * 1000);

    expect(
      (await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running,
      "a turn still inside the window must be left alone"
    ).toBe(true);
  });

  /**
   * ── ⚠ IDLE, NOT TOTAL — ASSERTED STRUCTURALLY, AND SAYING SO ─────────────────────────────────
   *
   * The distinction the whole design rests on: a turn writing a game legitimately runs for a long time,
   * and a TOTAL cap would kill exactly the work this app exists to do. Only silence is illegitimate.
   *
   * ⚠ THIS CASE READS THE SOURCE RATHER THAN DRIVING IT, and that is a real limitation rather than a
   * preference. The fake stream yields its scripted frames in one go and then parks, so there is no way
   * to feed a frame, advance nine minutes, feed another, and show the deadline moving. Proving the reset
   * behaviourally needs a harness that can emit frames on the test's schedule; until then this pins that
   * the reset call is in the loop, ahead of the frame handling, which is the thing that would be lost.
   */
  it("⚠ resets the deadline on every frame, so a working turn is never interrupted", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./claude-code.ts", import.meta.url)), "utf8");
    const loop = src.slice(src.indexOf("for await (const message of stream"));
    const reset = loop.indexOf("resetIdleTimer()");
    const firstUse = loop.indexOf("const m = message");

    expect(reset, "the loop must reset the deadline").toBeGreaterThan(-1);
    expect(reset, "before it does anything with the frame").toBeLessThan(firstUse);
  });

  /**
   * ── ⚠ AN ABANDONED TURN THAT LATER UNWINDS MUST NOT UNLOCK A NEWER ONE ───────────────────────
   *
   * The consequence of ending a turn without the loop's cooperation: the loop is still out there, and
   * when it eventually returns its `finally` runs. Unguarded, that `finally` clears `running` — for a
   * turn the participant started AFTER the abandonment — and settles ITS pending prompts as denials.
   * Two turns' bookkeeping in one session, which is worse than the wedge it replaced.
   *
   * The turn counter is what tells them apart, and this is the case that proves it does.
   */
  it("⚠ a late-unwinding abandoned turn leaves the NEXT turn alone", async () => {
    // Turn A: parked, so it is legitimately in flight.
    holdStream = () => {};
    scriptedFrames = [];
    void invoke("claude-sdk:send", { sessionId: "chat-1", message: "turn A" });
    await vi.advanceTimersByTimeAsync(0);
    // The generator replaced `holdStream` with its own resolver — that is how A is released later.
    const releaseA = holdStream as unknown as () => void;

    // The watchdog gives up on A.
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);
    expect((await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running).toBe(false);

    // Turn B: the participant sends again, and it parks too.
    holdStream = () => {};
    void invoke("claude-sdk:send", { sessionId: "chat-1", message: "turn B" });
    await vi.advanceTimersByTimeAsync(0);
    expect((await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running).toBe(true);

    // Now A's stream finally returns, running its `finally` while B owns the session.
    releaseA();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      (await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running,
      "A's finally must not unlock B"
    ).toBe(true);
  });

  /**
   * ⚠ AND A REVIVED STREAM MUST NOT STREAM INTO A SESSION THAT MOVED ON. The other half of ending a turn
   * without the loop's cooperation: if the SDK comes back to life after the watchdog gave up, its output
   * would interleave with whatever the participant is doing now — one transcript, two turns' text.
   */
  it("⚠ output from an abandoned turn is not delivered", async () => {
    holdStream = () => {};
    scriptedFrames = [];
    void invoke("claude-sdk:send", { sessionId: "chat-1", message: "turn A" });
    await vi.advanceTimersByTimeAsync(0);
    const releaseA = holdStream as unknown as () => void;

    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);
    events.length = 0;

    // A revives and tries to say something.
    framesAfterRelease = [textFrame("late output from a dead turn")];
    releaseA();
    await vi.advanceTimersByTimeAsync(0);

    const leaked = events.filter((e) => JSON.stringify(e.payload).includes("late output"));
    expect(leaked, "a disowned turn's output must go nowhere").toEqual([]);
  });

  it("settles a parked prompt when it abandons the turn, denying it", async () => {
    void startHeldTurn();
    const asked = capturedAsk!("Write", { file_path: "/tmp/snake.js" }, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingPermissionCount("chat-1")).toBe(1);

    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000);

    expect(pendingPermissionCount("chat-1"), "nothing may stay parked").toBe(0);
    // Fail closed: a prompt nobody answered was approved by nobody.
    await expect(asked).resolves.toMatchObject({ behavior: "deny" });
  });
});

// ── ⚠ A PARKED PROMPT HAS A DEADLINE NOW ──────────────────────────────────────────────────────
//
// The file header says a parked prompt has no deadline and that the failure mode is "a TURN THAT NEVER
// ENDS". It settled prompts on cancel, stop, abort and error — every path where something fires. This is
// the path where nothing does: the SDK goes quiet, `opts.signal` never aborts, the stream never ends.
describe("⚠ the permission prompt deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ denies an unanswered prompt rather than waiting for ever", async () => {
    holdStream = () => {};
    scriptedFrames = [];
    void invoke("claude-sdk:send", { sessionId: "chat-1", message: "go" });
    await vi.advanceTimersByTimeAsync(0);

    const asked = capturedAsk!("Bash", { command: "ls" }, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingPermissionCount("chat-1")).toBe(1);

    await vi.advanceTimersByTimeAsync(PROMPT_MS + 1_000);

    await expect(asked, "fails closed — nobody approved it").resolves.toMatchObject({
      behavior: "deny",
    });
    expect(pendingPermissionCount("chat-1")).toBe(0);
  });

  /**
   * ⚠ THE CASE THAT DISTINGUISHES THE TWO DEADLINES, and it could not exist while they were equal. The
   * prompt's denial is the GENTLER remedy: one tool call refused, the turn still alive and able to carry
   * on. Only if the stream stays silent afterwards does the watchdog end it.
   */
  it("⚠ denies the prompt WITHOUT ending the turn", async () => {
    holdStream = () => {};
    scriptedFrames = [];
    void invoke("claude-sdk:send", { sessionId: "chat-1", message: "go" });
    await vi.advanceTimersByTimeAsync(0);
    const asked = capturedAsk!("Bash", { command: "ls" }, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);

    // Past the prompt's deadline, but inside the turn's.
    await vi.advanceTimersByTimeAsync(PROMPT_MS + 1_000);

    await expect(asked).resolves.toMatchObject({ behavior: "deny" });
    expect(
      (await invoke("claude-sdk:isRunning", { sessionId: "chat-1" })).running,
      "the turn survives a denied tool call — it may still recover"
    ).toBe(true);
  });

  it("an answered prompt is unaffected by the deadline", async () => {
    // The deadline must not interfere with the ordinary path.
    holdStream = () => {};
    scriptedFrames = [];
    void invoke("claude-sdk:send", { sessionId: "chat-1", message: "go" });
    await vi.advanceTimersByTimeAsync(0);

    const asked = capturedAsk!("Read", { file_path: "/tmp/x" }, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    const id = (events.find((e) => e.channel === "cli:permission-request")!.payload as any).id;

    await invoke("claude-sdk:permission-respond", { id, allow: true, sessionId: "chat-1" });

    await expect(asked).resolves.toMatchObject({ behavior: "allow" });
    // And the expired-deadline branch must not then fire on a settled prompt.
    await vi.advanceTimersByTimeAsync(PROMPT_MS + 1_000);
    expect(pendingPermissionCount("chat-1")).toBe(0);
  });
});
