// ── HOW AN UPLOAD'S STATE IS PRESENTED ───────────────────────────────────────────────────
//
// The Team service stores the batch; this decides what a human is told about it. Kept out of the
// component so the interesting rules, when "processing" becomes untrustworthy, when a count needs a
// caveat, are testable without rendering anything.

/** Mirrors the Team service's `BulkBatchStatus`. Re-stated: the portal shares no code with a Lambda. */
export type BulkBatchStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed";

export interface BulkBatchFailure {
  teamName: string;
  email?: string;
  reason: string;
}

export interface BulkBatchView {
  batchId: string;
  workshopId: string;
  status: BulkBatchStatus;
  requestedBy: { id: string; email: string };
  requested: { teams: number; members: number };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  counts?: {
    teamsCreated: number;
    teamsMatched: number;
    invited: number;
    skipped: number;
    failed: number;
  };
  failures?: BulkBatchFailure[];
  failuresTruncated?: boolean;
  reportSent?: boolean;
  error?: string;
}

/**
 * ── ⚠ WHEN DOES "PROCESSING" STOP BEING BELIEVABLE? ─────────────────────────────────────
 *
 * A worker that is OOM-killed, hits its 300s ceiling, or dies between its two status writes leaves a
 * row saying `processing` with nobody working on it. Showing that as "in progress" forever is the same
 * lie the CloudWatch-only version told, just prettier, and it is the specific lie that let the first
 * failed upload sit unnoticed behind the word "Accepted".
 *
 * Nothing fires when a Lambda dies, so this is inferred from elapsed time, and the threshold is chosen
 * so a FALSE stall is impossible rather than so a real one is caught quickly: the function's ceiling is
 * 300s and EventBridge may retry it twice, so a legitimately running batch, retries included, cannot
 * still be going after 20 minutes.
 *
 * ⚠ IT IS A DISPLAY RULE AND NOTHING WRITES IT. A batch that reappears and finishes after 25 minutes
 * must still be able to report `completed`; a stored `stalled` status would have made that impossible.
 * The wording says only what is known: no update for N minutes.
 *
 * ⚠ AND IT APPLIES TO `queued` TOO, for a different failure. `EventBridgePublisher.publish` swallows
 * its errors so a bus hiccup never fails the originating write, which means a batch can be accepted,
 * recorded, and never reach a worker with nothing reporting a problem. A row stuck in `queued` is the
 * only way that ever becomes visible to anyone.
 */
export const STALLED_AFTER_MS = 20 * 60 * 1000;

export function isStalled(batch: BulkBatchView, now = Date.now()): boolean {
  if (batch.status !== "processing" && batch.status !== "queued") return false;
  const since = Date.parse(batch.startedAt ?? batch.createdAt);
  // An unparseable timestamp is not evidence of anything, never invent a stall from a bad date.
  if (Number.isNaN(since)) return false;
  return now - since > STALLED_AFTER_MS;
}

export function isTerminal(status: BulkBatchStatus): boolean {
  return status === "completed" || status === "completed_with_errors" || status === "failed";
}

export type Tone = "pending" | "good" | "warn" | "bad";

export interface StatusView {
  label: string;
  tone: Tone;
  /** The one-line explanation under the label. Empty when the label says everything. */
  detail: string;
}

/**
 * The label, its tone, and the sentence beneath it.
 *
 * ⚠ `completed_with_errors` IS NOT SHOWN AS SUCCESS, and it is not shown as failure either. Some people
 * were invited and some were not, so both "Complete" and "Failed" would be false, and the tone has to
 * pull the eye, because the whole reason this state is separate is that it needs a human.
 */
export function statusView(batch: BulkBatchView, now = Date.now()): StatusView {
  const stalled = isStalled(batch, now);

  if (stalled) {
    const minutes = Math.floor((now - Date.parse(batch.startedAt ?? batch.createdAt)) / 60000);
    return {
      label: batch.status === "queued" ? "Not started" : "No response",
      tone: "warn",
      /**
       * ⚠ IT SAYS WHAT IS KNOWN, NOT WHAT IS GUESSED. "Failed" would be a claim we cannot support, the
       * batch may have finished and failed only to report it, and "processing" would be a claim we no
       * longer believe. So: how long it has been silent, and what to do about it.
       */
      detail:
        batch.status === "queued"
          ? `No worker has picked this up in ${minutes} minutes. It may not have been queued, ask an administrator before re-uploading.`
          : `No update for ${minutes} minutes. It may have stopped; check before re-uploading.`,
    };
  }

  switch (batch.status) {
    case "queued":
      return { label: "Queued", tone: "pending", detail: "Waiting to start." };
    case "processing":
      return { label: "Processing", tone: "pending", detail: "Creating teams and sending invitations." };
    case "completed":
      return {
        label: "Complete",
        tone: "good",
        detail: batch.counts
          ? `${batch.counts.invited} invited.` +
            // Named explicitly so it cannot read as a failure: these people already held a live
            // invitation and were deliberately left alone, so their existing link still works.
            (batch.counts.skipped > 0
              ? ` ${batch.counts.skipped} already had a live invitation and were left alone.`
              : "")
          : "",
      };
    case "completed_with_errors":
      return {
        label: "Finished with problems",
        tone: "warn",
        detail: batch.counts
          ? `${batch.counts.invited} invited, ${batch.counts.failed} failed.`
          : "Some parts of this upload failed.",
      };
    case "failed":
      return {
        label: "Failed",
        tone: "bad",
        // ⚠ THE STORED REASON, NOT A GENERIC ONE. "Failed" alone is what sent somebody to CloudWatch.
        detail: batch.error || "This upload could not run. Nothing was created.",
      };
  }
}

/**
 * The problems on this batch, in the order an operator should read them.
 *
 * ⚠ A WHOLE TEAM THAT WAS NEVER CREATED COMES FIRST. Nobody on it was invited, and the fix is a human
 * decision about the name, which is a bigger problem than one rejected address, so it must not be
 * buried among them.
 */
export function orderedFailures(batch: BulkBatchView): BulkBatchFailure[] {
  const failures = batch.failures ?? [];
  const teamLevel = failures.filter((f) => !f.email);
  const addressLevel = failures.filter((f) => f.email);
  return [...teamLevel, ...addressLevel];
}

/** Whether there is anything to expand. Used to decide if a row is clickable at all. */
export function hasDetail(batch: BulkBatchView): boolean {
  return orderedFailures(batch).length > 0 || !!batch.error;
}

/**
 * ⚠ A TERMINAL BATCH WHOSE REPORT DID NOT SEND IS ITS OWN WARNING, and it has to be surfaced. This is
 * the case that actually happened: the row said what became of the upload, and the person who uploaded
 * it was never told anything. Someone reading the panel is the only remaining path to them knowing.
 */
export function reportMissing(batch: BulkBatchView): boolean {
  return isTerminal(batch.status) && batch.reportSent === false;
}

/** Short, local, and unambiguous, an upload is a thing you did today, not an ISO string. */
export function formatWhen(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How long it took, once both ends are known. Absent rather than guessed. */
export function formatDuration(batch: BulkBatchView): string {
  const start = Date.parse(batch.startedAt ?? batch.createdAt);
  const end = Date.parse(batch.completedAt ?? "");
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
