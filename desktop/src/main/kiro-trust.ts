/**
 * ── ⚠ WHICH OF KIRO'S TOOLS RUN WITHOUT ASKING ────────────────────────────────────────────────
 *
 * Its own help text is unambiguous about what that means:
 *
 *     -a, --trust-all-tools   Auto-approve all tool permission requests
 *
 * So `execute_bash` — arbitrary shell, as this user, on this laptop — ran with no prompt, and so did
 * `use_aws` (the signed-in AWS role), `web_fetch`, and every MCP tool the participant's machine
 * happens to have configured. The confined cwd does not help: `execute_bash` takes its own command.
 *
 * ── ⚠ WHY NOT SIMPLY DROP THE FLAG (AND WHY THE OBVIOUS FIX WOULD HAVE HUNG EVERY TURN) ──
 *
 * Measured against kiro-cli 2.18.1, driving the real ACP protocol:
 *
 *   flag removed, permission answered "allow"   → tool runs, turn ends `stopReason: end_turn`
 *   flag removed, permission answered "reject"  → tool blocked, agent explains, turn ends cleanly
 *   flag removed, permission NEVER answered     → `session/prompt` NEVER RESOLVES. The turn hangs.
 *
 * That last line is why this is a two-part change. Removing the flag alone would have hung every
 * Kiro turn that touched a tool, because this client treated every inbound message as a NOTIFICATION
 * and never replied to a request. `session/request_permission` is a REQUEST, with an id, and the
 * agent waits for its answer indefinitely. The handler in kiro-acp.ts is the other half.
 *
 * ── ⚠ AND WHY NOT PROMPT FOR EVERYTHING ──
 *
 * Because this app has a deliberate, documented position on permission dialogs and it is not
 * "always ask": `cli:trustWorkspace` exists precisely so that "participants are not answering
 * permission dialogs during a workshop" (SelectAssistantView), and the Claude path pre-approves the
 * project's `permissions.allow` for the same reason. A prompt on every file edit would be a
 * workshop-stopping regression, and the honest consequence of one is that people learn to click
 * Allow without reading — which is worse than the status quo, not better.
 *
 * `--trust-tools` is the granularity that resolves it, verified on both subcommands:
 *
 *     --trust-tools <TOOL_NAMES>   Trust only this set of tools
 *
 * Probed with the list below: writing a file produced ZERO prompts, and `execute_bash` produced one
 * naming the actual command ("Running: echo shelled > shelled.txt"). Which is exactly the split
 * wanted — the everyday work of an AI coding session is silent, and the two things that reach beyond
 * the project ask first.
 */

/**
 * Kiro tools the app pre-approves, and the reason each is here.
 *
 * ⚠ DENY BY DEFAULT: anything absent from this list PROMPTS. That includes tools that do not exist
 * yet and every MCP tool on the participant's machine — kiro names those `@server/tool`, and the app
 * cannot know what a given laptop has configured, so it must not vouch for them.
 *
 * ⚠ EVERY ENTRY IS SCOPED TO READING OR WRITING FILES. That is the test for adding one. The
 * deliberate omissions are the point of the whole change:
 *
 *     execute_bash   arbitrary shell as this user — the finding's actual hazard
 *     use_aws        acts as the signed-in AWS role, against real accounts
 *     web_fetch      reaches the network with the project's contents
 *     web_search     same
 *     use_subagent   spawns an agent whose own tool use this list would not cover
 *     code, knowledge, introspect, session, report_issue
 *                    not needed for the workshop flow, so not vouched for
 *
 * fs_write IS trusted, and that is a judgement rather than an oversight: it can be handed an
 * absolute path outside the project, so trusting it accepts a real residual risk. It is accepted
 * because it is the tool an AI coding session exists to use, because prompting on it is the
 * regression described above, and because it is the same bargain the Claude path already strikes
 * with `permissions.allow` + workspace trust. The line is drawn at tools that reach OUTSIDE the
 * filesystem — shell, cloud, network — where a single approval cannot be reasoned about locally.
 */
export const TRUSTED_KIRO_TOOLS: readonly string[] = Object.freeze([
  /** Read a file. The least consequential thing an assistant does. */
  "fs_read",
  /** Write a file — see the judgement above. */
  "fs_write",
  /** Search file contents. Read-only. */
  "grep",
  /** Match file paths. Read-only. */
  "glob",
  /** The agent's own scratch to-do list. Touches nothing outside itself. */
  "todo_list",
]);

/**
 * ── ⚠ THE SET WITH `fs_write` WITHDRAWN, FOR A PARTICIPANT WHO ASKS FOR IT ────────────────────
 *
 * The judgement above is unchanged and is not being second-guessed here: the finding's complaint was never
 * that the default is wrong, it was that there was "no setting, prompt or flag through which a participant
 * can decline". So the DEFAULT STAYS, and declining becomes possible.
 *
 * ⚠ WHY NOT SIMPLY FLIP THE DEFAULT, which is the other reading of the finding. Because the paragraph
 * above already answers it with measurements: prompting on every file write is the workshop-stopping
 * regression this list exists to avoid, and its second-order effect is that people learn to click Allow
 * without reading — worse than the status quo rather than better. That argument is not weakened by the
 * finding; the finding is about the absence of a choice, and this is the choice.
 *
 * ⚠ `fs_read`, `grep`, `glob` AND `todo_list` STAY EITHER WAY. Withdrawing read tools would make the
 * assistant prompt to look at a file it was asked about, which is not a security decision any
 * participant can reason about — and the finding names `fs_write` specifically, because writing is the
 * part that can be handed an absolute path outside the project.
 */
export const TRUSTED_KIRO_TOOLS_WITHOUT_WRITE: readonly string[] = Object.freeze(
  TRUSTED_KIRO_TOOLS.filter((t) => t !== "fs_write")
);

/**
 * The spawn argument, for both `kiro-cli acp` and `kiro-cli chat`.
 *
 * ⚠ ONE ARGV ELEMENT, `--trust-tools=a,b,c`, not two. Verified: the split form is accepted too, but
 * the `=` form is what kiro-cli's own help documents, and these sites spawn with `shell: false`
 * where a stray space would silently become a positional argument.
 *
 * ⚠ THE ARGUMENT IS ALWAYS PASSED, EVEN WITH `fs_write` WITHDRAWN. Dropping the flag entirely is the
 * one thing that must not happen: `--trust-tools` with a shorter list still means DENY BY DEFAULT for
 * everything absent, whereas no flag at all is a different code path whose behaviour this module has
 * not measured. The list shrinks; the mechanism does not change.
 *
 * @param trustFileWrites whether `fs_write` runs without asking. Passed in rather than read here so
 *        this module stays a pure policy definition with no settings dependency — the same reason
 *        message-sync-status.ts takes its account id.
 */
export function kiroTrustArg(trustFileWrites = true): string {
  const tools = trustFileWrites ? TRUSTED_KIRO_TOOLS : TRUSTED_KIRO_TOOLS_WITHOUT_WRITE;
  return `--trust-tools=${tools.join(",")}`;
}

/**
 * True if the tool runs without asking.
 *
 * ⚠ ITS DOCSTRING USED TO CLAIM IT WAS "exported for the permission handler's log line", and it had no
 * caller outside its own test — dead code advertising an intention nobody had implemented. A security
 * review found it while establishing that the audit record named no tool at all.
 *
 * It is kept, and honestly described: a permission prompt only ever fires for a tool that is NOT on the
 * trusted list, so calling this from the handler would answer `false` every time. What the audit record
 * needed was the tool's KIND, which comes from the ACP frame instead (see `rememberToolKind`). This
 * remains the readable definition of the trust boundary and is asserted directly by kiro-trust.test.ts.
 */
export function isTrustedKiroTool(tool: string): boolean {
  return TRUSTED_KIRO_TOOLS.includes(tool);
}

/**
 * How long an unanswered permission prompt is allowed to hold a turn before it is DENIED.
 *
 * ⚠ BOUNDED, AND THE BOUND IS A DENIAL. An unanswered prompt holds the agent's turn open — measured
 * above, `session/prompt` never resolves — so "wait for ever" would be a hang the user cannot
 * distinguish from a crash. Ten minutes is long enough for someone who stepped away from a workshop
 * and short enough that a forgotten window does not park a live agent process indefinitely.
 *
 * It fails CLOSED because the alternative is a timeout that approves shell access on the strength of
 * nobody having been at the keyboard.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
