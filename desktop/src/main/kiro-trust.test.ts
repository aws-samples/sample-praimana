// ── ⚠ THE AGENT ASKS BEFORE IT RUNS A SHELL COMMAND ───────────────────────────────────────────
//
// So `execute_bash` — arbitrary shell as this user — ran with no prompt, along with `use_aws` (the signed-in
// AWS role) and every MCP tool on the participant's machine.
//
// ⚠ THE OBVIOUS FIX WOULD HAVE HUNG EVERY KIRO TURN, and that is the fact these tests exist to hold
// on to. Measured against kiro-cli 2.18.1 over the real ACP protocol:
//
//     no flag + answer "allow"   → tool runs, turn ends stopReason: end_turn
//     no flag + answer "reject"  → tool blocked, agent explains, turn ends cleanly
//     no flag + NEVER answered   → session/prompt NEVER RESOLVES. Hangs for ever.
//
// This client had no way to answer: every inbound message went to `onNotification`, and
// `session/request_permission` is a REQUEST that waits. Hence two halves — a narrower flag, and a
// reply path. Anyone who deletes the second half must fail a test rather than discover this in a
// workshop.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PERMISSION_PROMPT_TIMEOUT_MS,
  TRUSTED_KIRO_TOOLS,
  isTrustedKiroTool,
  kiroTrustArg,
} from "./kiro-trust";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const ACP = readFileSync(local("./handlers/kiro-acp.ts"), "utf8");
const acp = strip(ACP);
const CLI = strip(readFileSync(local("./handlers/cli-assistant.ts"), "utf8"));
const VIEW = readFileSync(local("./../renderer/components/KiroChatView.tsx"), "utf8");
const PRELOAD = readFileSync(local("./../preload/index.ts"), "utf8");

describe("what is trusted, and what is deliberately not", () => {
  it("trusts file work only", () => {
    expect([...TRUSTED_KIRO_TOOLS].sort()).toEqual(["fs_read", "fs_write", "glob", "grep", "todo_list"]);
  });

  it("⚠ does NOT trust the tools that reach outside the project", () => {
    /**
     * The finding, restated as the assertion that matters. `execute_bash` is the hazard —
     * arbitrary shell, as this user, on this laptop — and `use_aws` acts as the signed-in AWS role
     * against real accounts. Adding either to the list must fail here.
     */
    for (const dangerous of [
      "execute_bash",
      "use_aws",
      "web_fetch",
      "web_search",
      "use_subagent",
      "code",
      "knowledge",
      "introspect",
      "session",
      "report_issue",
    ]) {
      expect(isTrustedKiroTool(dangerous), `${dangerous} must ask first`).toBe(false);
    }
  });

  it("does not trust MCP tools, whatever the participant has installed", () => {
    // kiro names them `@server/tool`. The app cannot know what a given laptop has configured, so it
    // must not vouch for any of it — deny by default, including for tools that do not exist yet.
    for (const mcp of ["@builder-mcp/InternalCodeSearch", "@anything/at_all", "future_tool"]) {
      expect(isTrustedKiroTool(mcp)).toBe(false);
    }
  });

  it("cannot be widened at runtime", () => {
    expect(Object.isFrozen(TRUSTED_KIRO_TOOLS)).toBe(true);
  });

  it("builds the single argv element kiro-cli documents", () => {
    // One element with `=`, not two — these sites spawn with shell:false, where a stray space
    // becomes a positional argument instead of a value.
    expect(kiroTrustArg()).toBe("--trust-tools=fs_read,fs_write,grep,glob,todo_list");
    expect(kiroTrustArg().split(" ")).toHaveLength(1);
  });

  it("times out into a DENIAL, and the bound exists", () => {
    /**
     * An unanswered prompt holds a live agent process, so "wait for ever" is not available. The
     * value is a judgement (long enough for someone who stepped away, short enough not to park an
     * agent overnight); that it FAILS CLOSED is not.
     */
    expect(PERMISSION_PROMPT_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(PERMISSION_PROMPT_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe("neither spawn site passes --trust-all-tools any more", () => {
  it("the ACP path passes the narrow flag", () => {
    /**
     * ⚠ MATCHED ON THE CALL, NOT ITS ARGUMENT LIST. This pinned `kiroTrustArg()` verbatim and broke when
     * the function gained the participant's file-write opt-out (`fs_write` had no way to decline). What this case is named for is that the NARROW flag is passed at all, so
     * that is what it asserts; the argument is covered behaviourally above.
     */
    expect(acp).toMatch(/const args = \["acp", kiroTrustArg\(/);
    expect(acp, "no blanket trust in shipped ACP code").not.toContain('"--trust-all-tools"');
  });

  it("the non-interactive chat path passes it too", () => {
    /**
     * That path cannot prompt, and the measured result of an untrusted call there is a clean
     * refusal — "rejected because … non-interactive mode (no user to approve)" — then a normal end
     * of turn. Fail-closed and legible, which is the right outcome where there is nobody to ask.
     */
    expect(CLI).toMatch(/\["chat", "--no-interactive", kiroTrustArg\(/);
    expect(CLI).not.toContain('"--trust-all-tools"');
  });

  /**
   * ── ⚠ ONE FILE MAY NAME THE FLAG, AND IT IS THE ONE THAT READS IT ────────────────────────────
   *
   * The two assertions above are greps, and a grep cannot tell a spawn site that PASSES the flag from
   * a detector that READS it. The audit record for an agent launch has to say which policy the argv
   * actually carried — the privileged-access requirement asks for a durable record of privileged
   * actions — and working that out means naming the flag somewhere.
   *
   * So it is named in exactly one module, `agent-tool-policy.ts`, whose whole purpose is reading it —
   * and this case exists so that exemption is a decision rather than a hole that appeared when a grep
   * stopped matching.
   */
  it("only agent-tool-policy.ts names the flag, and only to detect it", () => {
    const policy = strip(readFileSync(local("./agent-tool-policy.ts"), "utf8"));
    expect(policy).toContain('"--trust-all-tools"');
    // Read, never handed to a spawn: stripped of comments, the module builds no argv and starts no
    // process — its prose mentions both, which is why the comparison is on the code.
    expect(policy).not.toMatch(/spawn/i);
    expect(policy).not.toMatch(/args\.push/);

    // And the spawn sites use it rather than re-deriving the answer beside their own argv.
    expect(acp).toContain("toolPolicyOf(args)");
    expect(CLI).toContain("toolPolicyOf(args)");
  });
});

describe("⚠ the reply path, without which the narrow flag hangs the app", () => {
  it("routes an inbound message that has BOTH id and method to a request handler", () => {
    /**
     * The distinction the old code lacked. `pendingRequests` only matches ids WE issued, so an
     * agent-initiated request fell through to `onNotification` and was forwarded to the renderer as
     * a fire-and-forget event — no reply, ever.
     */
    expect(acp).toMatch(
      /if \("method" in msg && msg\.method && "id" in msg && msg\.id !== undefined[\s\S]{0,120}handleAgentRequest/
    );
    // And it must come BEFORE the notification branch, or the request is consumed as an event.
    expect(acp.indexOf("handleAgentRequest")).toBeLessThan(
      acp.indexOf("this.onNotification(msg.method, msg.params)")
    );
  });

  it("answers EVERY request, including ones it does not understand", () => {
    // Silence is the hang. An unsupported method gets JSON-RPC -32601 rather than nothing.
    expect(acp).toMatch(/code: -32601/);
    expect(acp).toMatch(/method !== "session\/request_permission"/);
  });

  it("echoes the agent's own option id rather than inventing one", () => {
    // The ids are the agent's ("allow_once", "reject_once"). A value we made up would be rejected
    // and put us back to an unanswered request.
    expect(acp).toContain('pick("allow_once")');
    expect(acp).toContain('pick("reject_once")');
    expect(acp).toMatch(/outcome: \{ outcome: "selected", optionId: chosen\.optionId \}/);
  });

  it("⚠ NEVER selects allow_always", () => {
    /**
     * `allow_always` writes a persistent trust rule into the user's kiro-cli configuration —
     * outside this app, surviving it, applying to their terminal sessions too. A workshop app must
     * not widen the trust of a tool someone uses elsewhere, so the only approval it can give is the
     * one-shot one. The UI says "Allow once" for the same reason.
     */
    expect(acp).not.toContain('pick("allow_always")');
    expect(acp).not.toMatch(/optionId: "allow_always"/);
    expect(VIEW).toContain("Allow once");
  });

  it("answers `cancelled` when no option is recognisable", () => {
    // Still an answer. The protocol defines it, and it is the only honest reply when the offered
    // options are not ones we know.
    expect(acp).toMatch(/outcome: \{ outcome: "cancelled" \}/);
  });

  it("defaults to DENY when no prompt callback is wired up", () => {
    // A caller that forgets `onPermission` gets an agent that cannot use an untrusted tool, not one
    // silently back to trust-all behaviour.
    expect(acp).toMatch(/this\.onPermission = options\.onPermission \?\? \(async \(\) => false\)/);
  });

  it("treats a failed prompt as a denial", () => {
    expect(acp).toMatch(/catch[\s\S]{0,200}approved = false/);
  });
});

describe("the prompt cannot leak or be answered by the wrong chat", () => {
  it("parks pending prompts per session, keyed by the agent's request id", () => {
    expect(acp).toContain("const pendingAcpPermissions = new Map<string, Map<string, (approved: boolean) => void>>()");
  });

  it("denies everything parked when the client goes away", () => {
    // Four exits: agent exited, session stopped, all stopped, client replaced, failed start.
    const denials = acp.match(/denyAllPendingPermissions\(/g) ?? [];
    expect(denials.length).toBeGreaterThanOrEqual(6); // 1 definition + 5 call sites
    expect(acp).toMatch(/denyAllPendingPermissions\(appSessionId, "the agent exited"\)/);
    expect(acp).toMatch(/denyAllPendingPermissions\(params\.sessionId, "the session was stopped"\)/);
  });

  it("denies immediately when there is no window to ask", () => {
    expect(acp).toMatch(/if \(sender\.isDestroyed\(\)\)[\s\S]{0,120}resolve\(false\)/);
  });

  it("⚠ coerces the renderer's answer — only exactly true approves", () => {
    /**
     * This is renderer input deciding whether an agent may run a shell command. `params.allow ===
     * true` rather than a truthiness test, so a malformed payload, a string "false" or a missing
     * field is a denial.
     */
    expect(acp).toMatch(/settle\(params\?\.allow === true\)/);
  });

  it("looks the prompt up under the session the caller named", () => {
    // So one chat cannot answer another's question, and a compromised renderer cannot approve a
    // request it was not shown.
    expect(acp).toMatch(/pendingAcpPermissions\.get\(sessionId\)\?\.get\(id\)/);
  });

  it("does not hold the app open waiting for a click", () => {
    expect(acp).toMatch(/timer\.unref\?\.\(\)/);
  });
});

describe("⚠ the audit record names WHICH tool was approved", () => {
  /**
   * ⚠ THE PROMPT ITSELF CARRIES NO TOOL NAME. Measured against kiro-cli 2.18.1, the params are
   * `{sessionId, toolCall: {toolCallId, title}, options, _meta}` — and `title` is agent PROSE ("Running:
   * rm -rf build"), exactly what must not reach the log. The identity comes from the preceding
   * `tool_call` frame, whose `kind` is ACP's closed vocabulary.
   */
  it("remembers the kind from the tool_call frame and records it", () => {
    expect(acp).toContain("rememberToolKind(update.toolCallId, update.kind)");
    expect(acp).toMatch(/const kind = toolKindById\.get\(request\.toolCallId\) \?\? "unknown"/);
    expect(acp).toMatch(/detail: `\$\{approved \? "allowed-once" : "denied"\}:\$\{kind\}`/);
  });

  it("⚠ still records no tool ARGUMENTS", () => {
    // The original reasoning stands: `title` can contain a full shell command with paths in it.
    const settle = acp.slice(acp.indexOf("const settle = (approved: boolean)"));
    const block = settle.slice(0, settle.indexOf("resolve(approved)"));
    expect(block).not.toContain("title");
    expect(block).not.toContain("request.title");
  });

  it("constrains the kind to a closed vocabulary rather than echoing it", () => {
    // It arrives from the agent, so an unexpected value is recorded as `unknown`, not passed through.
    expect(acp).toMatch(/\/\^\[a-z_\]\{1,24\}\$\/\.test\(kind\)/);
    expect(acp).toContain('"unknown"');
  });

  it("bounds the remembered map and releases each entry when answered", () => {
    // Keyed by agent-supplied ids, so it needs a ceiling; and a long session must not accumulate.
    expect(acp).toContain("MAX_REMEMBERED_TOOL_KINDS");
    expect(acp).toMatch(/toolKindById\.delete\(request\.toolCallId\)/);
  });

  it("⚠ isTrustedKiroTool is no longer described as wiring that does not exist", () => {
    /**
     * Its docstring claimed it was "exported for the permission handler's log line" and it had no caller
     * outside its own test — dead code advertising an intention nobody had implemented. A prompt only
     * fires for an UNtrusted tool, so calling it there would answer false every time; the docstring now
     * says that rather than implying the opposite.
     */
    const trust = readFileSync(local("./kiro-trust.ts"), "utf8");
    expect(trust).not.toContain("Exported for the permission handler's log line");
    expect(trust).toMatch(/would answer `false` every time/);
  });
});

describe("the participant is actually asked", () => {
  it("the bridge exposes the event and the answer", () => {
    expect(PRELOAD).toContain("onKiroAcpPermissionRequest");
    expect(PRELOAD).toContain('ipcRenderer.invoke("kiroAcp:permissionRespond", params)');
  });

  it("removes the listener with the rest, so a remount does not double-deliver", () => {
    expect(PRELOAD).toContain('ipcRenderer.removeAllListeners("kiroAcp:permissionRequest")');
  });

  it("KiroChatView subscribes and renders a card with both answers", () => {
    expect(VIEW).toContain("api.onKiroAcpPermissionRequest(handlePermission)");
    expect(VIEW).toContain("Permission required");
    expect(VIEW).toMatch(/allow: false/);
    expect(VIEW).toMatch(/allow: true/);
  });

  it("keys the prompt by session, like every other per-chat state here", () => {
    // Two Kiro chats can each be parked mid-tool-call; a single value would show one and hang the other.
    expect(VIEW).toContain("permissionBySession");
    expect(VIEW).toContain("permissionBySession[activeId]");
  });

  it("⚠ hides \"Working…\" while a prompt is up, because the turn is NOT progressing", () => {
    // session/prompt does not resolve until this is answered, so showing both would be untrue.
    expect(VIEW).toContain("{streaming && !permissionRequest && (");
  });

  it("shows the agent's own sentence, which names the actual command", () => {
    // "Running: rm -rf build" is what makes an approval informed; a tool name alone does not.
    expect(VIEW).toContain("{permissionRequest.description}");
    expect(VIEW).toContain("font-mono");
  });

  it("clears the card when the turn ends, the agent exits, or it errors", () => {
    /**
     * Five call sites, named individually rather than counted, because a count is satisfied by five
     * of the wrong ones. The three lifecycle cases matter most: main has already denied those
     * prompts, and a card left on screen invites a click that resolves nothing.
     */
    const view = strip(VIEW);
    for (const [name, marker] of [
      ["turn end", "const handleTurnEnd"],
      ["agent exit", "const handleExited"],
      ["error", "const handleError"],
    ] as const) {
      const body = view.slice(view.indexOf(marker), view.indexOf(marker) + 400);
      expect(body, `${name} must clear the card`).toContain("dropPermission(");
    }
    /**
     * ⚠ EVERY ANSWER BUTTON CLEARS IT, and there are three now: Deny, Allow, and "Allow for this chat".
     * The count is the property — a card left up after an answer invites a second click that resolves
     * nothing, because main has already settled the promise.
     */
    expect((view.match(/dropPermission\(activeId\)/g) ?? []).length).toBe(3);
  });
});

/**
 * ── ⚠ SHELL APPROVED FOR THE REST OF A CHAT, AND NO FURTHER ─────────────────────────────────────
 *
 * The AI-DLC orchestrator runs each step through `bun`, so each step is an `execute_bash` call, so each step
 * asked the same question and got the same answer.
 *
 * ⚠ THE TOOL POLICY IS UNMOVED. `execute_bash` stays out of `TRUSTED_KIRO_TOOLS` — the first shell command
 * of a chat is still a real question with a real refusal. What is removed is being re-asked for work already
 * agreed to.
 *
 * ⚠ AND IT IS NOT `allow_always`. That option exists in the protocol and is still never selected: it writes
 * a rule into `~/.kiro` that outlives this app and applies to the participant's own terminal. Asserted here
 * because "Always" is the obvious thing for a later edit to wire up, and the objection is not obvious.
 *
 * ⚠ PATTERN TRUST WAS CONSIDERED AND REFUSED — e.g. an "Always" option covering every run on all `.ts`
 * files. `session/request_permission` carries only `{toolCall: {toolCallId, title}}` and `title`
 * is the agent's OWN PROSE — there is no argv and no independent view of the command. So a pattern matched
 * against it would let the agent decide whether its command matches, which reads like a filter and is not
 * one. A session grant claims no filter, which is why it is the one that shipped.
 */
describe("⚠ the session-scoped shell grant", () => {
  /** Comments are KEPT here: two of these assertions are about the recorded reasoning, not the code. */
  const acp = ACP;

  it("keeps execute_bash out of the trusted list", () => {
    expect(TRUSTED_KIRO_TOOLS).not.toContain("execute_bash");
    expect(kiroTrustArg(true)).not.toContain("execute_bash");
  });

  it("still never selects allow_always", () => {
    /**
     * ⚠ AGAINST THE STRIPPED SOURCE. The literal appears in a COMMENT that records the measured option
     * shape from kiro-cli 2.18.1 — which is worth keeping — so an unstripped search finds the documentation
     * rather than a use.
     */
    expect(strip(acp), "the option is read from the request, never chosen").not.toMatch(
      /optionId:\s*"allow_always"/
    );
    expect(acp, "and the reason is on the record").toMatch(
      /allow_always` IS DELIBERATELY NEVER CHOSEN/
    );
  });

  it("is keyed by app session, so one chat's grant is not another's", () => {
    expect(acp).toContain("shellApprovedForSession");
    expect(acp).toMatch(/shellApprovedForSession\.add\(sessionId\)/);
    expect(acp).toMatch(/shellApprovedForSession\.has\(appSessionId\)/);
  });

  /** Only ever widens an APPROVAL, and only for shell — both checked in main, not trusted from the UI. */
  it("records the grant only on an explicit allow", () => {
    const handler = acp.slice(acp.indexOf('"kiroAcp:permissionRespond"'), acp.indexOf('"kiroAcp:stop"'));
    expect(handler).toMatch(/params\?\.allow === true && params\?\.remember === true/);
  });

  it("consults it only for a request whose remembered kind is the shell one", () => {
    expect(acp).toMatch(/isShellRequest\(request\.toolCallId\)/);
    expect(acp).toMatch(/toolKindById\.get\(toolCallId\)\s*\?\?\s*""\)\s*===\s*"execute"/);
  });

  /**
   * ⚠ IT DOES NOT OUTLIVE THE SESSION. That bound is the whole difference from `allow_always`, so it is
   * asserted rather than left to the comment: both `kiroAcp:stop` branches drop it.
   */
  it("⚠ is dropped when the session stops", () => {
    expect((acp.match(/shellApprovedForSession\.delete\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const stop = acp.slice(acp.indexOf('"kiroAcp:stop"'));
    expect(stop.slice(0, 1200), "the named branch").toContain("shellApprovedForSession.delete(");
  });

  /** Both outcomes are audited, and distinguishably — "granted once" is not "covered by an earlier grant". */
  it("audits the grant and the approvals it covers, distinguishably", () => {
    expect(acp).toContain('detail: "granted-session:execute"');
    expect(acp).toContain('detail: "allowed-session:execute"');
  });
});
