// ── ⚠ "2 MESSAGES NOT SYNCED", AND WHAT MAY HONESTLY BE COUNTED ──────────────────────────
//
// The per-message badge no longer renders for `synced` rows — 88% of them — so the conversation needs one
// place that says whether anything is outstanding. Without it, hiding the common case would mean hiding the
// information rather than just the noise.
//
// ── ⚠ `unknown` IS NOT COUNTED, AND THAT IS THE WHOLE JUDGEMENT IN THIS FILE ──
//
// `sync_status IS NULL` means nothing recorded whether the push worked — rows written before migration 11,
// and turns whose status was never stamped. It does NOT mean the message failed. `SyncBadge` already makes
// exactly this distinction in its wording: an unknown row's control says "Sync", never "Not synced", because
// we do not know that it failed.
//
// Counting those here would have been the visible, alarming version of the same mistake. One real database held
// 14 such rows against 98 synced ones, so a header lumping them together would have
// greeted every older conversation with "14 messages not synced" — a false alarm on messages that in all
// likelihood reached the team perfectly well. The per-message badge still offers a push for them; the
// conversation-level claim stays silent rather than guessing.
//
// ── ⚠ AND `pending` IS NOT THE SAME CLAIM AS `failed` ──
//
// A pending message may be in flight this second: a turn syncs moments after it ends. Reporting that as "not
// synced" would call a working system broken every time somebody sends a message. So the two are counted
// separately and worded differently — "syncing" while it is plausible, "not synced" only once the server has
// actually refused.

/** Just the field this needs. Both chat views' message types satisfy it. */
export interface SyncCountable {
  sync_status?: "pending" | "synced" | "failed" | null | undefined;
}

export interface SyncSummary {
  /** The server refused these, or a retry failed. Actionable, and the only true "not synced". */
  failed: number;
  /** Sent, not yet acknowledged. May be in flight right now. */
  pending: number;
  /** `sync_status IS NULL` — nobody recorded an outcome. Deliberately NOT part of any claim. See above. */
  untracked: number;
}

export function summariseSync(messages: readonly SyncCountable[]): SyncSummary {
  let failed = 0;
  let pending = 0;
  let untracked = 0;
  for (const m of messages) {
    if (m.sync_status === "failed") failed++;
    else if (m.sync_status === "pending") pending++;
    else if (m.sync_status !== "synced") untracked++;
  }
  return { failed, pending, untracked };
}

/** What the header should say, and how loudly. `null` when there is nothing outstanding to report. */
export interface SyncNotice {
  text: string;
  /**
   * `warn` has actually failed.
   *
   * ⚠ `quiet` IS CURRENTLY UNREACHABLE and is kept deliberately. It was the tone for "still in flight", which
   * no longer produces a line at all — see `describeSync`. Retained because the distinction it encodes is the
   * one thing a future caller must not lose: a message in flight is not a message that failed.
   */
  tone: "warn" | "quiet";
}

/**
 * One line for the conversation, or nothing.
 *
 * ⚠ FAILURE OUTRANKS PENDING rather than being added to it. A conversation with one refused message and three
 * in flight has one problem, not four — summing them would inflate the number that matters into a number
 * nobody can act on. The pending ones are reported only when nothing has actually failed.
 *
 * ⚠ AND SILENCE MEANS "NOTHING OUTSTANDING", not "everything verified". Untracked rows produce no line at
 * all, which is the same restraint the badge shows: the app does not claim an outcome it never observed.
 */
export function describeSync(s: SyncSummary): SyncNotice | null {
  if (s.failed > 0) {
    return {
      text: `${s.failed} ${s.failed === 1 ? "message" : "messages"} not synced`,
      tone: "warn",
    };
  }
  /**
   * ⚠ PENDING PRODUCES NO LINE EITHER, and this reverses my own first version of this function.
   *
   * The badge was the loud half of that, but a header reading "2 messages syncing" on every single turn is
   * the same fault in a smaller font — and it appears the moment you press send, which is precisely when
   * nobody needs telling.
   *
   * ⚠ AND IT COSTS NOTHING, for the reason recorded in `SyncBadge`: `pending` is not a resting state. The push
   * stamps `synced` or `failed` under a timeout, and `sync-sweep` re-pushes anything left pending at the next
   * start. A push that genuinely does not arrive becomes `failed`, which this DOES report.
   *
   * The count stays in `SyncSummary` — it is honest data, and a future caller may want it — but nothing draws
   * a conclusion from it here.
   */
  return null;
}
