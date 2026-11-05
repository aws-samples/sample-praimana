// ── THE BULK UPLOAD AUDIT RECORD ─────────────────────────────────────────────────────────
//
// One row per uploaded file: when it arrived, how much it named, what happened to it, and — when
// something went wrong — exactly what.
//
// ⚠ WHY THIS EXISTS, AND IT IS NOT BOOKKEEPING. Making the work asynchronous bought
// the facilitator their time back and cost them all visibility: the panel says "accepted, we'll
// email you", and from that moment the only record of a batch lived in CloudWatch. The first real
// upload proved how bad that is — all three teams were refused by a broken east-west hop, the
// requester's email was empty so no report could be sent either, and the ONLY evidence that anything
// had happened at all was one log line in a Lambda log group. The operator saw "Accepted" and would
// have waited forever.
//
// ⚠ SO THE REPORT EMAIL IS NOT THE SYSTEM OF RECORD — THIS IS. An email can fail to send, go to a
// dead address, or be deleted, and none of those may erase the outcome of a job that created
// accounts. The email is a notification ABOUT this row.
//
// ── THE STATUS IS THE WHOLE POINT, SO IT DISTINGUISHES MORE THAN "DONE / NOT DONE" ──
//
// `completed` and `completed_with_errors` are separate states because they demand different actions:
// one is finished, the other needs a human to look at named addresses. Collapsing them into "done"
// would bury exactly the information the operator needs, which is the same mistake the report email
// was designed to avoid by putting the failure count in the headline.

/**
 * ⚠ `queued` MEANS "PUBLISHED, NOT YET SEEN BY A WORKER", and it is a real state rather than a
 * transient one. `EventBridgePublisher.publish` deliberately SWALLOWS a failure so a bus hiccup
 * cannot fail the originating write — which means a batch can be accepted, logged as queued, and
 * never reach a worker, with nothing anywhere reporting a problem. A row stuck in `queued` is the
 * only way that becomes visible.
 */
export type BulkBatchStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed";

/** A named failure, as the operator needs to see it: what failed, and why. */
export interface BulkBatchFailure {
  /** The team it belongs to. Present even for a whole-team failure, which is the worst case. */
  teamName: string;
  /**
   * Absent for a team that was never created at all — the distinction matters, because a team-level
   * failure means NOBODY on it was invited, not that one address bounced.
   */
  email?: string;
  reason: string;
}

/**
 * How much the file asked for, recorded at ACCEPT time from the validated plan.
 *
 * ⚠ SEPARATE FROM THE OUTCOME COUNTS BELOW, deliberately. "18 members requested, 12 invited" is the
 * sentence an operator needs; a single mutable counter cannot say it, because after a partial run
 * there would be no record of what was originally asked.
 */
export interface BulkBatchRequested {
  teams: number;
  members: number;
}

/** What actually happened. Absent until a worker has finished a pass. */
export interface BulkBatchCounts {
  teamsCreated: number;
  teamsMatched: number;
  invited: number;
  /** Already held a live invitation and deliberately left alone — NOT a failure. */
  skipped: number;
  failed: number;
}

export interface BulkBatch {
  batchId: string;
  workshopId: string;
  status: BulkBatchStatus;
  /** Who uploaded it. The email is also who the report is sent to. */
  requestedBy: { id: string; email: string };
  requested: BulkBatchRequested;
  /** ISO 8601, set when the upload was accepted. Also the sort key's natural order (ULID). */
  createdAt: string;
  /** When a worker picked it up. Absent while `queued`. */
  startedAt?: string;
  /** When it reached a terminal state. Absent until then. */
  completedAt?: string;
  counts?: BulkBatchCounts;
  /**
   * ⚠ BOUNDED. A file may name 80 members and every one of them can fail, so an unbounded list would
   * put an arbitrary amount of operator-supplied text in one item. Truncated at
   * MAX_RECORDED_FAILURES with `failuresTruncated` set, because a silently short list would read as
   * "these are all the problems".
   */
  failures?: BulkBatchFailure[];
  failuresTruncated?: boolean;
  /** Whether the report email went out. A false here with a terminal status is a real gap. */
  reportSent?: boolean;
  /** Set when the batch itself could not run — a parse failure, or an unreadable team list. */
  error?: string;
}

/**
 * ⚠ WHY A CAP AT ALL, WHEN 80 WOULD FIT. A DynamoDB item is limited to 400 KB and each failure
 * carries an address plus a free-text reason; 40 is far more than anyone reads in a UI and leaves the
 * item an order of magnitude below the ceiling even with long reasons. The email report caps at ten
 * per team for the same reason and says how many more there were.
 */
export const MAX_RECORDED_FAILURES = 40;

/** The fields a worker may set when it reports progress. Nothing else is writable after accept. */
export interface BulkBatchProgress {
  status: BulkBatchStatus;
  startedAt?: string;
  completedAt?: string;
  counts?: BulkBatchCounts;
  failures?: BulkBatchFailure[];
  failuresTruncated?: boolean;
  reportSent?: boolean;
  error?: string;
}

export interface BulkBatchRepository {
  /**
   * Record an accepted upload.
   *
   * ⚠ CALLED BEFORE THE EVENT IS PUBLISHED, and the order is load-bearing. If this write fails the
   * route must refuse the upload outright rather than run a job nothing can observe; if it succeeded
   * and the publish then failed silently, the row sits in `queued` and says so.
   */
  create(batch: BulkBatch): Promise<void>;
  /**
   * Advance a batch. Merges the supplied fields; never resurrects a deleted row.
   *
   * ⚠ MUST NOT CREATE. A PATCH for a batchId that does not exist is either a replay of a DLQ'd event
   * whose row was pruned, or a caller inventing an id — and an upsert would silently manufacture an
   * audit record for a batch nobody accepted. Returns false instead so the caller can 404.
   */
  update(workshopId: string, batchId: string, progress: BulkBatchProgress): Promise<boolean>;
  /** Most recent first. Bounded by `limit`. */
  listByWorkshop(workshopId: string, limit: number): Promise<BulkBatch[]>;
}

/**
 * ── ⚠ WHEN IS A `processing` BATCH ACTUALLY DEAD? ────────────────────────────────────────
 *
 * A worker that is OOM-killed, times out at its 300s ceiling, or dies between its two status writes
 * leaves a row saying `processing` with nobody working on it. Showing that as "in progress" forever
 * is the same lie the old CloudWatch-only version told, just prettier.
 *
 * There is no callback that fires when a Lambda dies, so this is inferred from elapsed time, and the
 * threshold is chosen to make a FALSE "stalled" impossible rather than to detect death quickly: the
 * function's own ceiling is 300s and EventBridge may retry it twice, so a legitimately slow batch —
 * including its retries — cannot still be running after 20 minutes. Anything older is either dead or
 * has already been superseded by a retry that will write its own status.
 *
 * ⚠ IT IS A DISPLAY RULE, NOT A WRITE. Nothing rewrites the row: a batch that reappears and finishes
 * after 25 minutes must still be allowed to report `completed`, and a stored `stalled` status would
 * have made that impossible. The UI says "no update for N minutes — it may have stopped", which is
 * exactly as much as is actually known.
 */
export const STALLED_AFTER_MS = 20 * 60 * 1000;

export function isStalled(batch: BulkBatch, now = Date.now()): boolean {
  if (batch.status !== "processing" && batch.status !== "queued") return false;
  const since = Date.parse(batch.startedAt ?? batch.createdAt);
  // An unparseable timestamp is not evidence of staleness — never report a stall on a bad date.
  if (Number.isNaN(since)) return false;
  return now - since > STALLED_AFTER_MS;
}

/** Terminal states, i.e. no worker will touch this row again. */
export function isTerminal(status: BulkBatchStatus): boolean {
  return status === "completed" || status === "completed_with_errors" || status === "failed";
}

/**
 * The status a finished pass should report, from its own counts.
 *
 * ⚠ `skipped` IS NOT A FAILURE and must never push a batch into `completed_with_errors`. Those
 * people already held a live invitation and were deliberately left alone; re-inviting them would
 * have invalidated the link already in their inbox. Counting that as a problem would invite an
 * operator to "fix" it by re-uploading, which is the one action that could actually break it.
 */
export function statusFromCounts(counts: BulkBatchCounts): BulkBatchStatus {
  return counts.failed > 0 ? "completed_with_errors" : "completed";
}

const STATUSES: readonly BulkBatchStatus[] = [
  "queued",
  "processing",
  "completed",
  "completed_with_errors",
  "failed",
];

/** Longest stored failure reason. Reasons are generated by our own code; this bounds a hostile one. */
const MAX_REASON_CHARS = 300;
const MAX_NAME_CHARS = 120;

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * Validate and bound a progress report, or null if it names no valid status.
 *
 * ⚠ EVERY FIELD IS COPIED EXPLICITLY, NOT SPREAD. This body reaches a DynamoDB write, and a spread is
 * an allowlist that silently grows — the same defect that once leaked operator subs out of the roster
 * projection. Enumerating means a future field has to be added HERE to be stored, which is a review
 * rather than an accident.
 *
 * ⚠ AND THE FAILURE LIST IS BOUNDED AND TRUNCATION IS RECORDED. A file may name 80 members and all of
 * them can fail; a list cut short WITHOUT `failuresTruncated` would read as the complete set of
 * problems, which is the one misreading that gets somebody left out of a workshop.
 */
export function normalizeBatchProgress(body: unknown): BulkBatchProgress | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const status = STATUSES.find((s) => s === b.status);
  if (!status) return null;

  const progress: BulkBatchProgress = { status };

  if (typeof b.startedAt === "string") progress.startedAt = b.startedAt.slice(0, 40);
  if (typeof b.completedAt === "string") progress.completedAt = b.completedAt.slice(0, 40);
  if (typeof b.reportSent === "boolean") progress.reportSent = b.reportSent;
  if (typeof b.error === "string") progress.error = b.error.slice(0, MAX_REASON_CHARS);

  if (b.counts && typeof b.counts === "object") {
    const c = b.counts as Record<string, unknown>;
    progress.counts = {
      teamsCreated: count(c.teamsCreated),
      teamsMatched: count(c.teamsMatched),
      invited: count(c.invited),
      skipped: count(c.skipped),
      failed: count(c.failed),
    };
  }

  if (Array.isArray(b.failures)) {
    const all = b.failures.filter((f): f is Record<string, unknown> => !!f && typeof f === "object");
    const kept: BulkBatchFailure[] = all.slice(0, MAX_RECORDED_FAILURES).map((f) => {
      const failure: BulkBatchFailure = {
        teamName: text(f.teamName, MAX_NAME_CHARS),
        reason: text(f.reason, MAX_REASON_CHARS) || "failed",
      };
      // Absent for a whole-team failure — the distinction is meaningful, so an empty string must
      // not be stored in its place.
      const email = text(f.email, MAX_NAME_CHARS);
      if (email) failure.email = email;
      return failure;
    });
    progress.failures = kept;
    if (all.length > kept.length) progress.failuresTruncated = true;
  }

  return progress;
}
