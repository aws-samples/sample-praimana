// ── ⚠ A FAILED TURN MUST NOT LOOK LIKE A QUIET ONE ───────────────────────────────────────
//
// The spinner cleared, the question synced, and nothing said why the answer never came.
//
// ⚠ THE CAUSE WAS THAT WE THREW THE EXPLANATION AWAY. Codex reports a failure in two shapes and BOTH fell
// through to `ignore`, because `parseCodexLine` only handled an error NESTED in `item.completed`. The fixture
// below is a real failing run captured from CLI 0.146.1 (forced with an invalid `-m`), not an invention —
// which matters, because the terminal event's message is nested (`error.message`) while the top-level event's
// is flat (`message`), and one handler cannot read both.

import { describe, it, expect } from "vitest";
import { parseCodexLine } from "./codex-events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The tail of a real failing run, verbatim. Note five retries, then a restatement, then the terminal event. */
const FAILING_RUN = [
  `{"type":"thread.started","thread_id":"01a0008b-b3d2-7661-aa31-139c0be9b784"}`,  // nosemgrep: missing-template-string-indicator
  `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for \`bogus\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}`,  // nosemgrep: missing-template-string-indicator
  `{"type":"turn.started"}`,  // nosemgrep: missing-template-string-indicator
  `{"type":"error","message":"Reconnecting... 1/5 (unexpected status 404 Not Found: The model 'bogus' does not exist)"}`,  // nosemgrep: missing-template-string-indicator
  `{"type":"error","message":"Reconnecting... 5/5 (unexpected status 404 Not Found: The model 'bogus' does not exist)"}`,  // nosemgrep: missing-template-string-indicator
  `{"type":"error","message":"unexpected status 404 Not Found: The model 'bogus' does not exist"}`,  // nosemgrep: missing-template-string-indicator
  `{"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: The model 'bogus' does not exist"}}`,  // nosemgrep: missing-template-string-indicator
];

describe("⚠ the terminal failure is surfaced", () => {
  it("reads turn.failed's NESTED message", () => {
    const effect = parseCodexLine(FAILING_RUN[6]);

    expect(effect.kind).toBe("failure");
    expect(effect.kind === "failure" && effect.message).toContain("does not exist");
  });

  /** A failure with no message is still a failure — silence is the defect being fixed. */
  it("still reports a failure when Codex gives no reason", () => {
    for (const line of [`{"type":"turn.failed"}`, `{"type":"turn.failed","error":{}}`]) {  // nosemgrep: missing-template-string-indicator
      const effect = parseCodexLine(line);
      expect(effect.kind, line).toBe("failure");
      expect(effect.kind === "failure" && effect.message.length, "never an empty explanation").toBeGreaterThan(0);
    }
  });

  /**
   * ⚠ EXACTLY ONE FAILURE FOR ONE FAULT. The run above contains SIX error lines for a single 404 — five
   * retries and a restatement — and the renderer appends every `cli:error` to the transcript. Surfacing them
   * all would stack six identical warnings under the question.
   */
  it("produces one failure for a run that reported the same fault six times", () => {
    const kinds = FAILING_RUN.map((l) => parseCodexLine(l).kind);

    expect(kinds.filter((k) => k === "failure").length, "one terminal failure").toBe(1);
    // The retries are carried as notices — logged and available as a fallback, not shown.
    expect(kinds.filter((k) => k === "notice").length).toBe(4);
  });

  /** A successful turn must produce no failure at all. */
  it("does not invent a failure for a turn that worked", () => {
    const ok = [
      `{"type":"thread.started","thread_id":"t1"}`,  // nosemgrep: missing-template-string-indicator
      `{"type":"turn.started"}`,  // nosemgrep: missing-template-string-indicator
      `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}`,  // nosemgrep: missing-template-string-indicator
      `{"type":"turn.completed","usage":{"output_tokens":2}}`,  // nosemgrep: missing-template-string-indicator
    ].map((l) => parseCodexLine(l).kind);

    expect(ok).not.toContain("failure");
    expect(ok).toContain("text");
  });

  /**
   * ⚠ THE TOP-LEVEL SHAPE IS FLAT AND THE TERMINAL ONE IS NESTED. Reading `message` on `turn.failed` (or
   * `error.message` on the top-level event) yields undefined, and the fallback text would then hide the real
   * reason behind "Codex gave no reason" on every failure.
   */
  it("keeps the two error shapes distinct", () => {
    const top = parseCodexLine(`{"type":"error","message":"flat text"}`);  // nosemgrep: missing-template-string-indicator
    const terminal = parseCodexLine(`{"type":"turn.failed","error":{"message":"nested text"}}`);  // nosemgrep: missing-template-string-indicator

    expect(top.kind).toBe("notice");
    expect(top.kind === "notice" && top.message).toBe("flat text");
    expect(terminal.kind === "failure" && terminal.message).toBe("nested text");
  });
});

// The wiring — no return value to assert, and it is where the visible behaviour lives.
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const handler = strip(readFileSync(join(__dirname, "cli-assistant.ts"), "utf8"));

describe("⚠ the failure reaches the participant, not just the log", () => {
  it("sends cli:error, which the renderer appends to the transcript", () => {
    const branch = handler.slice(handler.indexOf('case "failure":'), handler.indexOf('case "notice":'));

    expect(branch).toMatch(/event\.sender\.send\(\s*"cli:error"/);
    expect(branch).toMatch(/error: effect\.message/);
  });

  /**
   * ⚠ AND IT IS NOT COUNTED AS THE ASSISTANT'S REPLY. Returning the message would append it to
   * `fullOutput`, which is saved as the turn AND pushed to the team — the error would appear in the portal
   * as something the assistant said.
   */
  it("does not add the error to the turn's content", () => {
    const branch = handler.slice(handler.indexOf('case "failure":'), handler.indexOf('case "notice":'));

    expect(branch, "must return the empty string, not the message").toMatch(/return "";\s*$/);
    expect(branch).not.toMatch(/return effect\.message/);
  });

  /**
   * The safety net for a run that dies without a terminal event — a kill, a crash, an older CLI. Without it
   * that case is the original silent failure again.
   */
  it("explains an empty turn even when no turn.failed arrived", () => {
    expect(handler).toMatch(
      /if \(!finalContent && !codexFailureReported && lastCodexNotice\)[\s\S]{0,200}?send\(\s*"cli:error"/
    );
  });

  /** Only a NON-benign notice may be used as that explanation. */
  it("never explains an empty turn with a benign warning", () => {
    expect(handler).toMatch(/if \(!isBenignError\(effect\.message\)\) lastCodexNotice = effect\.message/);
  });
});

// ── ⚠ THE RENDERER MUST BE SENT WHAT IS SAVED ────────────────────────────────────────────
//
// ⚠ AND THE PURE FUNCTION BEING RIGHT WAS NOT ENOUGH — this is the gap a mutation found. The separator logic
// was correct and fully tested, while the stream handler still sent `effect.text` raw: the blank line reached
// the database and not the screen. Replacing the addition with `effect.text` here passed every unit test in
// `codex-message-accumulation.test.ts`, because none of them looked at the call site.
describe("⚠ the stream and the saved turn are handed the same bytes", () => {
  it("streams the ADDITION, not the raw message", () => {
    const branch = handler.slice(handler.indexOf('case "text": {'), handler.indexOf('case "usage":'));

    expect(branch, "the addition carries the separator").toMatch(
      /const addition = codexMessageAddition\(fullOutput, effect\.text\)/
    );
    expect(branch, "and it is what goes to the renderer").toMatch(/text: addition/);
    expect(branch, "the raw message must not be sent").not.toMatch(/text: effect\.text/);
    expect(branch, "nor returned for accumulation").toMatch(/return addition;/);
  });

  /** An empty addition means a duplicate: nothing may be streamed, or the repeat reaches the screen. */
  it("sends nothing when the addition is empty", () => {
    const branch = handler.slice(handler.indexOf('case "text": {'), handler.indexOf('case "usage":'));

    expect(branch).toMatch(/if \(addition\) \{[\s\S]{0,160}?send\(\s*"cli:output"/);
  });

  /**
   * ⚠ THE ACCUMULATION MUST NOT RE-APPLY THE RULE. `applyCodexLine` already returns the addition, so a second
   * `appendCodexMessage` around it would insert the separator twice and diverge from what was streamed.
   */
  it("accumulates by plain concatenation of the additions", () => {
    expect(handler).toMatch(/fullOutput \+= applyCodexLine\(line\)/);
    expect(handler).not.toMatch(/fullOutput = appendCodexMessage\(/);
  });
});

// ── ⚠ THE COUNTS MUST REACH THE ROW ──────────────────────────────────────────────────────
//
// `chat_messages.input_tokens` / `output_tokens` have existed since the baseline and were never written to.
// The whole desktop token display reads those columns, so a `saveMessage` that dropped them would leave every
// figure permanently empty while the code around it looked complete.
describe("⚠ the assistant row is saved with its token counts", () => {
  it("passes the turn's counts to saveMessage", () => {
    expect(handler).toMatch(/saveMessage\(params\.sessionId, "assistant", finalContent, turnTokens\)/);
  });

  it("captures them from the usage event rather than inventing them", () => {
    const usage = handler.slice(handler.indexOf('case "usage":'), handler.indexOf('case "notice":'));

    expect(usage).toMatch(/turnTokens = \{/);
    expect(usage).toMatch(/outputTokens: effect\.outputTokens/);
    /* An unreported input count must stay absent, not become 0 — NULL and zero are different facts. */
    expect(usage).toMatch(/effect\.inputTokens !== undefined \? \{ inputTokens: effect\.inputTokens \} : \{\}/);
  });

  /** And they must travel to the server too, or the portal figure and the desktop figure disagree. */
  it("sends them with the sync", () => {
    expect(handler).toMatch(/turnTokens \? \{ tokens: turnTokens \} : \{\}/);
  });
});
