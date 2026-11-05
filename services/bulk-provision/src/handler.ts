// ── BULK PROVISIONING WORKER ─────────────────────────────────────────────────────────────
//
// Invoked ASYNCHRONOUSLY by an EventBridge rule on `bulk-provision.requested`, and does the work the
// upload no longer waits for: resolve or create each team, write invitation rows, provision Cognito
// accounts, email each invitee, then email the facilitator a report.
//
// ── ⚠ NO SQS. LAMBDA'S ASYNC INVOCATION *IS* THE DURABLE QUEUE ──
//
// An earlier draft put an SQS queue between the bus and this function. It is not needed, and the
// owner was right to ask. Verified against the AWS docs rather than assumed: EventBridge retries a
// failed Lambda target with exponential backoff for **up to 24 hours / 185 attempts**, then drops the
// event or sends it to a DLQ. That is durability, and `EvaluationActivityRule` in this repo's own
// template already uses exactly this shape.
//
// Dropping SQS removes a queue, an event source mapping, and the partial-batch-failure machinery —
// with ONE event per invocation, a poison message cannot affect its neighbours by construction rather
// than by careful reporting.
//
// ⚠ AND THE DEFAULT RETRY POLICY WOULD BE ACTIVELY DANGEROUS HERE. 185 attempts over 24 hours is
// reasonable for an idempotent projection; this function CREATES COGNITO ACCOUNTS AND SENDS EMAIL. A
// job that half-succeeded and then failed would be re-attempted up to 185 times against a pool whose
// admin API is rate-limited and shared with real sign-ins, and against a 200/day SES quota. The rule
// must therefore pin `MaximumRetryAttempts` low (2) and `MaximumEventAgeInSeconds` to an hour, so a
// broken job reaches the DLQ in minutes instead of hammering two shared quotas for a day.
//
// Re-runs are SAFE but not free: the skip-if-already-invited rule makes a retry mostly
// a no-op, which is what makes any retry policy tolerable at all.
//
// ── ⚠ THE FAILURE CONTRACT: THROW, OR THE EVENT IS GONE ──
//
// For an async invocation, throwing is what makes EventBridge retry and eventually DLQ; returning
// normally marks the event DELIVERED and unrecoverable. So this handler rethrows from both the parse
// and the run paths, and there is deliberately no catch-and-log-and-return anywhere in it — that
// would look tidier and would silently consume a facilitator's whole upload.
//
// ⚠ BUT ONLY A FAILURE TO *START* SHOULD THROW. Per-team and per-address failures are DATA in the
// report, because throwing on them would make EventBridge retry a batch that mostly succeeded — and
// re-attempt real invitations for the people it already invited.
//
// ── HOW IT AUTHENTICATES, WITH NO SECRET ──
//
// It invokes team/user-access/notify DIRECTLY and constructs the invocation event itself, populating
// `requestContext.authorizer.jwt.claims` with the facilitator's identity — which
// `edgeIdentityMiddleware` path 1 reads and verifies NOTHING, because the gateway normally has.
// `lambda:InvokeFunction`, scoped to three named functions, IS the credential. See ./invoke.ts.

import { applyPlan, type ApplyReport } from "./apply";
import { assertNoCredential, buildReportEmail } from "./report";
import { callService } from "./invoke";
import {
  failuresFromReport,
  reportProgress,
  type BatchProgress,
  type ProgressTarget,
} from "./progress";

/**
 * Report progress, and make it STRUCTURALLY unable to affect the batch.
 *
 * `reportProgress` already catches everything and returns false — but "never throws" as a property of
 * another module is a promise, and this call site's correctness must not depend on one. A rejection
 * escaping here would do real damage in all three places it is called: before the work it would abort
 * a batch over a visibility failure, after the work it would make EventBridge retry a batch that had
 * already sent every invitation, and inside the catch it would REPLACE the original error — losing the
 * reason for the retry and sending an operator after the wrong fault.
 *
 * So the guarantee is enforced here, where it matters, rather than assumed.
 */
async function reportStatus(target: ProgressTarget, progress: BatchProgress): Promise<boolean> {
  return reportProgress(target, progress).catch(() => false);
}

/** Exactly what the Team service publishes — an identity, never a credential. */
export interface BulkProvisionMessage {
  batchId: string;
  workshopId: string;
  plan: {
    teams: Array<{ teamKey: string; teamName: string; memberCount: number }>;
    members: Array<{
      line: number;
      teamName: string;
      teamKey: string;
      email: string;
      platformRole: string;
      teamRole?: string;
    }>;
  };
  requestedBy: { id: string; email: string; role: string };
}

/**
 * Bounds re-stated here rather than imported: this Lambda is bundled alone, and a bound enforced only
 * upstream is not a bound. The BFF and the Team route both check these too — three copies, because
 * the cost of a stray one is a worker creating more accounts than anyone authorised, and this one is
 * reachable by a DLQ replay that never passed through either.
 */
const MAX_ROWS = 80;
const MAX_TEAMS = 20;

/**
 * Validate one event payload.
 *
 * ⚠ A MALFORMED EVENT IS NOT RETRYABLE, and saying so matters: with the retry policy pinned at 2 it
 * costs three invocations before the DLQ either way, but the log line is what tells an operator
 * whether replaying it could ever work.
 */
export function parseMessage(detail: unknown): BulkProvisionMessage {
  const m = (detail ?? {}) as Partial<BulkProvisionMessage>;

  if (!m.batchId || !m.workshopId) throw new Error("PERMANENT: batchId and workshopId are required");
  if (!m.plan || !Array.isArray(m.plan.teams) || !Array.isArray(m.plan.members)) {
    throw new Error("PERMANENT: plan.teams and plan.members are required");
  }
  if (m.plan.members.length === 0 || m.plan.teams.length === 0) {
    throw new Error("PERMANENT: the plan is empty");
  }
  if (m.plan.members.length > MAX_ROWS || m.plan.teams.length > MAX_TEAMS) {
    throw new Error(`PERMANENT: plan exceeds ${MAX_TEAMS} teams / ${MAX_ROWS} members`);
  }
  if (!m.requestedBy?.id || !m.requestedBy?.role) {
    // Without an identity there is nothing to assert via x-identity-*, and it must NOT fall back to
    // anything wider.
    throw new Error("PERMANENT: requestedBy.id and requestedBy.role are required");
  }

  return m as BulkProvisionMessage;
}

/**
 * Do the work for one batch.
 *
 * Throws only when the run could not START — a missing APP_URL, or an unreadable team list. Per-team
 * and per-address failures are DATA in the report, not exceptions, because throwing on them would
 * make EventBridge retry a batch that mostly succeeded.
 */
export async function runBatch(message: BulkProvisionMessage): Promise<ApplyReport> {
  const target: ProgressTarget = {
    batchId: message.batchId,
    workshopId: message.workshopId,
    requestedBy: message.requestedBy,
  };

  /**
   * ⚠ ANNOUNCED BEFORE THE WORK, NOT AFTER. A batch that dies mid-run — OOM, the 300s ceiling, a
   * poisoned row — would otherwise leave the audit row saying `queued` forever, which is
   * indistinguishable from an event that never arrived. Those two have completely different fixes
   * (replay the event vs. investigate the worker), so the row has to record that a worker DID pick it
   * up even if that worker then vanished.
   */
  await reportStatus(target, { status: "processing", startedAt: new Date().toISOString() });

  const report = await applyPlan(
    message.workshopId,
    message.plan,
    {
      id: message.requestedBy.id,
      email: message.requestedBy.email,
      role: message.requestedBy.role,
    },
    process.env.APP_URL || "",
    message.requestedBy.email || undefined
  );

  console.log("[bulk-provision] applied", {
    batchId: message.batchId,
    teamsCreated: report.teamsCreated,
    teamsMatched: report.teamsMatched,
    invited: report.invited,
    skipped: report.skipped,
    failed: report.failed,
  });

  /**
   * ⚠ THE PER-FAILURE REASONS ARE ALSO LOGGED, AND THEY WERE NOT BEFORE. The first real batch printed
   * `applied {failed: 3}` and nothing else, so diagnosing WHY needed the Team service's log group and
   * a matching timestamp. The reasons are ours, not operator text; the ADDRESSES are not logged,
   * because they are the PII on this path — they go in the audit row, which is access-controlled, and
   * in the report email, which goes to the person who supplied them.
   */
  if (report.failed > 0) {
    console.error("[bulk-provision] failures in this batch", {
      batchId: message.batchId,
      failed: report.failed,
      reasons: [...new Set(failuresFromReport(report).map((f) => f.reason))].slice(0, 10),
    });
  }

  const reportSent = await sendReport(message, report);

  /**
   * ⚠ WRITTEN AFTER THE EMAIL SO `reportSent` IS THE TRUTH RATHER THAN AN INTENTION. A terminal row
   * claiming the report was sent when it was not is worse than no claim: it is the flag an operator
   * would use to decide nobody needs telling.
   */
  await reportStatus(target, {
    status: report.failed > 0 ? "completed_with_errors" : "completed",
    completedAt: new Date().toISOString(),
    counts: {
      teamsCreated: report.teamsCreated,
      teamsMatched: report.teamsMatched,
      invited: report.invited,
      skipped: report.skipped,
      failed: report.failed,
    },
    failures: failuresFromReport(report),
    reportSent,
  });

  return report;
}

/**
 * Email the facilitator the outcome.
 *
 * ⚠ A FAILED REPORT MUST NOT FAIL THE BATCH. The teams exist and the invitations are sent; throwing
 * here would make EventBridge retry the whole job and re-attempt every address — a strictly worse
 * outcome than a missing summary. So it is logged loudly and swallowed, and the log line is the
 * operator's only signal that somebody is owed a report.
 */
async function sendReport(
  message: BulkProvisionMessage,
  report: ApplyReport
): Promise<boolean> {
  const to = message.requestedBy.email;
  if (!to) {
    /**
     * ⚠ THIS BRANCH HAS FIRED IN PRODUCTION, and it is why the audit row exists. The Team route
     * published the requester's email from a header that only exists on the internal-hop path, so a
     * facilitator uploading through the gateway produced `email: ""` — and the one promise the feature
     * makes ("we'll email you when it finishes") could not be kept. The route is fixed; this stays as
     * the honest report of a batch nobody was told about.
     */
    console.error("[bulk-provision] no requester email — report NOT sent", {
      batchId: message.batchId,
    });
    return false;
  }

  try {
    const email = buildReportEmail(report);
    // Cheap belt-and-braces before the report leaves the process (see report.ts).
    assertNoCredential(email);

    await callService(
      process.env.NOTIFY_FUNCTION_NAME || "praimana-notify",
      "POST",
      "/v1/notify/workshop-update",
      {
        id: message.requestedBy.id,
        email: message.requestedBy.email,
        role: message.requestedBy.role,
      },
      {
        to,
        headline: email.headline,
        body: email.body,
        details: email.details,
        // No actionUrl: there is no single page that shows this outcome, and a button going nowhere
        // useful is worse than no button.
      }
    );
    console.log("[bulk-provision] report sent", { batchId: message.batchId });
    return true;
  } catch (err) {
    console.error("[bulk-provision] report FAILED to send — the batch itself SUCCEEDED", {
      batchId: message.batchId,
      failed: report.failed,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The EventBridge envelope, narrowed to what this handler reads. */
interface EventBridgeEvent {
  id?: string;
  "detail-type"?: string;
  detail?: unknown;
}

/**
 * EventBridge entry point.
 *
 * ⚠ IT RETHROWS. That is the entire failure contract for an async invocation: a throw is what makes
 * EventBridge retry and eventually route to the DLQ, and a normal return marks the event delivered
 * and unrecoverable. There is deliberately no catch-and-log-and-return anywhere in this function.
 */
export async function handler(event: EventBridgeEvent): Promise<void> {
  /**
   * ⚠ THE PAYLOAD IS TAKEN FROM `detail`, WITH A BARE-OBJECT FALLBACK. Replaying from the DLQ by hand
   * is a real operator action, and the message stored there is the envelope — but a human retrying
   * with just the payload should not fail for envelope reasons.
   */
  const detail =
    event && typeof event === "object" && "detail" in event && event.detail ? event.detail : event;

  let message: BulkProvisionMessage;
  try {
    message = parseMessage(detail);
  } catch (err) {
    // ⚠ NO ADDRESS IN THE LOG. Addresses are the PII on this path and every other service logs at
    // most an email domain; dumping the plan would put eighteen of them in CloudWatch per retry.
    console.error("[bulk-provision] REJECTED an unusable event", {
      eventId: event?.id,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  console.log("[bulk-provision] batch starting", {
    batchId: message.batchId,
    workshopId: message.workshopId,
    teams: message.plan.teams.length,
    members: message.plan.members.length,
    requestedBy: message.requestedBy.id,
  });

  try {
    await runBatch(message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[bulk-provision] batch FAILED", { batchId: message.batchId, reason });

    /**
     * ⚠ RECORD, THEN RETHROW — IN THAT ORDER, AND BOTH.
     *
     * Recording matters because a run that could not START (no APP_URL, an unreadable team list) would
     * otherwise leave the row on `processing` and the operator waiting on a job that is already dead.
     *
     * Rethrowing matters more: a throw is the ENTIRE failure contract for an async invocation. It is
     * what makes EventBridge retry and eventually route to the DLQ, and swallowing it here — which
     * would look tidier now that the failure is written down — would mark the event delivered and
     * silently consume a facilitator's whole upload.
     *
     * ⚠ AND `failed` IS NOT NECESSARILY FINAL. EventBridge will retry twice, and a retry writes
     * `processing` over this. That is correct: the row should say what is true now, not what was true
     * on the first attempt.
     */
    await reportStatus(
      {
        batchId: message.batchId,
        workshopId: message.workshopId,
        requestedBy: message.requestedBy,
      },
      { status: "failed", completedAt: new Date().toISOString(), error: reason }
    );

    throw err;
  }

  console.log("[bulk-provision] batch complete", { batchId: message.batchId });
}
