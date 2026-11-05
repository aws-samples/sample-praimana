// ── REPORTING PROGRESS INTO THE AUDIT ROW ────────────────────────────────────────────────
//
// Team writes a `queued` row when it accepts an upload; this module advances it. Three calls per
// batch at most: picked up, finished, or could-not-run.
//
// ⚠ WHY THIS EXISTS AT ALL: THE EMAIL IS NOT A RECORD. The report email was the only outcome channel,
// and the first real upload demonstrated all the ways that fails at once — every team was refused by a
// broken east-west hop, the requester's email arrived empty so nothing could be sent, and the sole
// evidence was a CloudWatch line. The operator's screen still said "Accepted". An audit row the
// portal can read is the fix; the email is a notification about it.
//
// ⚠ EVERY CALL HERE IS BEST-EFFORT AND MUST NOT FAIL THE BATCH. That is not laziness about errors, it
// is the correct ordering of harms: the teams exist and the invitations are sent by the time the
// terminal report is written, so throwing would make EventBridge retry the whole job and re-attempt
// real invitations for people who already have one. A missing status update is a visibility problem; a
// re-run is a correctness one. So failures are logged LOUDLY — that log line is the only signal that a
// row is now lying about its state.

import { callService } from "./invoke.js";
import type { ApplyReport } from "./apply.js";

const TEAM_FN = process.env.TEAM_FUNCTION_NAME || "praimana-team";

/** Mirrors the Team service's `BulkBatchStatus`. Re-stated: this Lambda is bundled alone. */
export type BatchStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed";

export interface BatchFailure {
  teamName: string;
  email?: string;
  reason: string;
}

export interface BatchProgress {
  status: BatchStatus;
  startedAt?: string;
  completedAt?: string;
  counts?: {
    teamsCreated: number;
    teamsMatched: number;
    invited: number;
    skipped: number;
    failed: number;
  };
  failures?: BatchFailure[];
  reportSent?: boolean;
  error?: string;
}

export interface ProgressTarget {
  batchId: string;
  workshopId: string;
  requestedBy: { id: string; email: string; role: string };
}

/**
 * ⚠ BOUNDED HERE AS WELL AS IN THE CALLEE. The Team route truncates to its own ceiling, but sending 80
 * failures for it to throw away puts them in a Lambda payload and both services' logs on the way. The
 * callee's bound is the authority; this one is politeness plus payload size.
 */
const MAX_FAILURES_SENT = 40;

/**
 * Advance the audit row. Never throws.
 *
 * Returns whether the update was accepted, which callers may use for logging but must not treat as a
 * reason to abandon work already done.
 */
export async function reportProgress(
  target: ProgressTarget,
  progress: BatchProgress
): Promise<boolean> {
  try {
    await callService(
      TEAM_FN,
      "PATCH",
      `/v1/workshops/${encodeURIComponent(target.workshopId)}/bulk-provision/batches/${encodeURIComponent(target.batchId)}`,
      target.requestedBy,
      progress,
      { source: "bulk-provision-worker" }
    );
    return true;
  } catch (err) {
    /**
     * ⚠ THE LOUD LOG IS THE WHOLE ERROR HANDLING. Somebody is now looking at a row that does not
     * reflect reality — most likely one stuck on `processing` that the portal will eventually show as
     * stalled. That is recoverable by a human reading this line; a thrown error here would not be.
     */
    console.error("[bulk-provision] could not update the batch audit row", {
      batchId: target.batchId,
      status: progress.status,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Flatten an `ApplyReport` into the named failures an operator has to act on.
 *
 * ⚠ A WHOLE TEAM THAT WAS NEVER CREATED COMES FIRST, and carries no address. Nobody on that team was
 * invited, and the remedy is a human decision about the name — which is different in kind from one
 * rejected address, so the two must not be flattened into an undifferentiated list.
 */
export function failuresFromReport(report: ApplyReport): BatchFailure[] {
  const failures: BatchFailure[] = [];

  for (const team of report.teams) {
    if (team.disposition === "failed") {
      failures.push({ teamName: team.teamName, reason: team.error ?? "the team was not created" });
      continue;
    }
    for (const member of team.members) {
      if (member.status !== "failed") continue;
      failures.push({
        teamName: team.teamName,
        email: member.email,
        reason: "reason" in member ? member.reason : "failed",
      });
    }
  }

  return failures.slice(0, MAX_FAILURES_SENT);
}
