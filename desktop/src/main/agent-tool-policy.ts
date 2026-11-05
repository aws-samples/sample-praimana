/**
 * ── ⚠ WHAT TOOL POLICY DID THIS AGENT LAUNCH UNDER? ───────────────────────────────────────────
 *
 * The finding had two halves. The first was that two of the three runtimes launched with tool approval
 * PRE-GRANTED; that is fixed at the launch sites (kiro-trust.ts for both Kiro paths, buildCliArgs for the
 * Claude CLI). The second was that there was "no durable record of the privileged actions", and this is the
 * part of that record which actually matters: not which binary ran, but whether it had been given permission
 * in advance.
 *
 * ── WHY ITS OWN MODULE ──
 *
 * Three spawn sites in two files need the answer, and each needed the flag NAMES to work it out —
 * which put the literal `"--trust-all-tools"` back into files whose test asserts, correctly, that
 * shipped spawn code does not contain it (kiro-trust.test.ts). A detector is not a passer, but a
 * grep cannot tell them apart, so the vocabulary lives here instead: one file that names the flags,
 * exempt by being obviously about reading them.
 *
 * ── WHAT THE CODES MEAN ──
 *
 *   trust-all      every tool pre-approved, nothing asked. What the finding was about.
 *   trust-listed   a named subset pre-approved, the rest asked — kiro-trust.ts's list.
 *   pre-approved   `--allowedTools <names>`: those names never prompt.
 *   sandbox-write  codex `--sandbox workspace-write`: file writes AND shell, confined to the workspace,
 *                  nothing asked. Codex has no per-tool allowlist, so this is the only way it can
 *                  express a bounded pre-approval — narrower than `trust-all`, wider than any list.
 *   sandbox-read   codex `--sandbox read-only`: reads pre-approved, writes refused outright.
 *   ask            no pre-approval flags; the runtime asks before each tool.
 *
 * ⚠ THE TWO SANDBOX CODES ARE NOT FOLDED INTO `pre-approved`.
 * The codex setup argv carries none of the three flags below, so it fell through to `ask` and the
 * hash-chained log stated that the runtime asked before each tool when in fact NOTHING was asked — the
 * widest of the three setup policies recorded as the narrowest. Reusing `pre-approved` would have fixed
 * the lie and lost the distinction that matters: `--allowedTools Read,Grep` grants no shell, and
 * `workspace-write` grants shell. An audit code that conflates those answers the wrong question.
 */

/** The blanket-trust flag, named once so the detectors below are the only readers of it. */
const TRUST_ALL_FLAG = "--trust-all-tools";
/** The narrow form: `--trust-tools=a,b,c`. */
const TRUST_LISTED_PREFIX = "--trust-tools=";
/** Claude's form: `--allowedTools Bash Read …`. */
const ALLOWED_TOOLS_FLAG = "--allowedTools";
/**
 * Codex's only expression of tool policy: one flag, three documented values.
 *
 * ⚠ `danger-full-access` IS DETECTED THOUGH IT IS NEVER PASSED. This module reads argv rather than
 * intent, and its whole purpose is to keep saying the truth after somebody adds a flag — a detector
 * that only knows the values currently in use would report `ask` for the one value that grants
 * everything, which is the exact failure this file exists to prevent.
 */
const SANDBOX_FLAG = "--sandbox";
const SANDBOX_FULL_ACCESS = "danger-full-access";
const SANDBOX_WORKSPACE_WRITE = "workspace-write";
const SANDBOX_READ_ONLY = "read-only";
/** Codex's blanket bypass, which the tree passes nowhere — see the note on `SANDBOX_FLAG`. */
const BYPASS_SANDBOX_FLAG = "--dangerously-bypass-approvals-and-sandbox";

/** The value given to `--sandbox`, or undefined when the flag is absent or trailing. */
function sandboxMode(args: readonly string[]): string | undefined {
  const at = args.indexOf(SANDBOX_FLAG);
  return at === -1 ? undefined : args[at + 1];
}

export type AgentToolPolicy =
  | "trust-all"
  | "trust-listed"
  | "pre-approved"
  | "sandbox-write"
  | "sandbox-read"
  | "ask";

/**
 * The policy an argv actually carries.
 *
 * ⚠ READ FROM THE ARGV THAT IS ABOUT TO BE SPAWNED, not from a constant beside it. A record derived
 * from what the code intends would keep saying "ask" after somebody added a flag, which is the one
 * failure mode an audit trail must not have.
 *
 * ⚠ ORDERED MOST-PERMISSIVE FIRST, so an argv carrying both forms is recorded as the weaker one it
 * actually grants rather than the stricter one it also mentions.
 */
export function toolPolicyOf(args: readonly string[]): AgentToolPolicy {
  if (args.includes(TRUST_ALL_FLAG)) return "trust-all";
  if (args.includes(BYPASS_SANDBOX_FLAG)) return "trust-all";
  if (sandboxMode(args) === SANDBOX_FULL_ACCESS) return "trust-all";
  if (args.some((a) => a.startsWith(TRUST_LISTED_PREFIX))) return "trust-listed";
  if (args.includes(ALLOWED_TOOLS_FLAG)) return "pre-approved";
  /**
   * ⚠ AFTER the flag forms above, so an argv carrying both is still recorded as the weaker grant —
   * the ordering rule this function's header states. `read-only` is checked LAST of the three sandbox
   * values because it is the only one that grants nothing a reader would call a privilege, and an
   * argv that somehow carried both sandbox values should report the wider.
   */
  if (sandboxMode(args) === SANDBOX_WORKSPACE_WRITE) return "sandbox-write";
  if (sandboxMode(args) === SANDBOX_READ_ONLY) return "sandbox-read";
  return "ask";
}
