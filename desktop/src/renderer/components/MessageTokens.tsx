// ── ⚠ WHAT ONE TURN COST ──────────────────────────────────────────────────────────────────
//
// ⚠ RENDERS NOTHING WHEN NOTHING WAS COUNTED, which is most of the existing history: the columns arrived in
// migration 13, and Claude's spawn path and Kiro do not report counts at all. A confident "0" on a real reply
// would be worse than silence — the same rule the sync badge follows for an untracked row.

import { formatTokens, hasTokens } from "../lib/token-display";

export function MessageTokens({
  input,
  output,
  /** Light container (Codex's own bubble is terracotta) needs white ink — see `SyncBadge` for the ratios. */
  onLight = false,
}: {
  input?: number | null;
  output?: number | null;
  onLight?: boolean;
}) {
  if (!hasTokens({ input_tokens: input, output_tokens: output })) return null;

  const parts: string[] = [];
  if (typeof input === "number") parts.push(`${formatTokens(input)} ctx`);
  if (typeof output === "number") parts.push(`${formatTokens(output)} out`);

  return (
    <span
      className={`text-[10px] tabular-nums ${onLight ? "text-white" : "text-surface-faint"}`}
      /*
        ⚠ "ctx" AND NOT "in". The input count is the WHOLE prompt for the turn — the conversation goes with it —
        so a short reply late in a thread reports tens of thousands. Calling it "in" invites reading it as what
        the participant typed, which it is not. The tooltip spells the whole thing out.
      */
      title={
        `${typeof input === "number" ? `${input.toLocaleString()} tokens of context sent (this turn's whole prompt, including the conversation so far)` : "context not counted"}` +
        `; ${typeof output === "number" ? `${output.toLocaleString()} generated` : "output not counted"}.`
      }
    >
      {parts.join(" · ")}
    </span>
  );
}
