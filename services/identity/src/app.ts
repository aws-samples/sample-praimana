import {
  createDocClient,
  createSendQuota,
  withHealth,
} from "@praimana/service-shared";
import { createIdentityRoutes } from "./routes.js";
import { DynamoUserRepository } from "./repository.dynamo.js";
import { DynamoFeedbackRepository } from "./feedback.dynamo.js";
import { HttpFeedbackNotifier } from "./notifier.http.js";
import { CloudWatchHealthReader } from "./health.cloudwatch.js";
import { CostExplorerReader } from "./cost.explorer.js";
import { CachedCostReader } from "./cost.dynamo.js";

// Composition root — the only place concrete implementations are wired.
// Auth is native Cognito now; this service only reads the users profile store.
const db = createDocClient();

const app = createIdentityRoutes({
  users: new DynamoUserRepository(db),
  /**
   * Feedback and bug reports (reports go in the DB, not into email).
   *
   * Wired unconditionally: the table ships with the stack, so an environment where it is missing is a
   * deploy fault rather than a configuration choice. The routes still degrade to 503 if the port is
   * absent — that is for a composition root that has not been updated, not for a runtime switch.
   */
  feedback: new DynamoFeedbackRepository(db),
  /**
   * ── ⚠ PER-REPORTER SEND ACCOUNTING (a medium security finding) ──────────────────────────────
   *
   * POST /v1/auth/feedback is reachable by any signed-in role and each call costs a DynamoDB
   * write, a users-table read and mail to every admin and facilitator. It was unmetered.
   *
   * Metered HERE rather than only in notify because this path calls notify with a synthesised
   * `{ id: "system", role: "ADMIN" }` identity — notify's per-sender budget would put every
   * reporter on the platform in one bucket named "system", where one person exhausts it for
   * everybody and nobody is attributable.
   *
   * Absent SEND_QUOTA_TABLE leaves it unmetered and says so, rather than failing to start:
   * refusing to boot over a quota table would take down profile reads and the whole identity
   * surface to protect a mail budget.
   */
  feedbackQuota: (() => {
    const table = process.env.SEND_QUOTA_TABLE;
    if (!table) {
      console.warn(
        "[identity] SEND_QUOTA_TABLE is not set — feedback reports are NOT METERED. Any signed-in " +
          "user can mail every admin and facilitator without limit."
      );
      return undefined;
    }
    // Six an hour: filing more than that is not reporting, and the staff mailbox is the cost.
    const perHour = Number(process.env.FEEDBACK_MAX_REPORTS_PER_HOUR || "6");
    if (!Number.isFinite(perHour) || perHour < 1) {
      throw new Error(
        `[identity] FEEDBACK_MAX_REPORTS_PER_HOUR must be a positive number, got "${process.env.FEEDBACK_MAX_REPORTS_PER_HOUR}"`
      );
    }
    console.log(`[identity] feedback quota — ${perHour} reports/hour per reporter, table ${table}`);
    return createSendQuota({
      client: db,
      tableName: table,
      maxPerWindow: perHour,
      // Namespaced away from notify's counter so the two cannot consume each other.
      scope: "feedback-report",
    });
  })(),
  /**
   * Emails staff when a report arrives (notification comes from the backend, not by handing the
   * reporter a mailto).
   *
   * It swallows its own failures and the route defends itself as well, so a notify outage costs a log line
   * and nothing else — the report is stored either way.
   */
  notifier: new HttpFeedbackNotifier(),
  /**
   * The read-only platform health panel in Administration.
   *
   * Wired unconditionally, and it costs nothing to construct: the CloudWatch SDK is imported on the FIRST
   * READ, not here, so a runtime that cannot resolve the client degrades that one route to 503 instead of
   * failing this module and taking `GET /v1/auth/me` with it.
   */
  health: new CloudWatchHealthReader(),
  /**
   * What the platform costs to run — ADMIN only, enforced on the route.
   *
   * ⚠ THE CACHE IS NOT AN OPTIMISATION, IT IS THE BUDGET. Cost Explorer bills $0.01 per request and this
   * platform spends about $1/day, so an uncached panel refreshed twenty times would cost ~40% of the spend it
   * reports. `CachedCostReader` wraps the billable reader and refreshes at most every six hours — and serves
   * a stale snapshot with its age rather than an error when a refresh fails.
   */
  cost: new CachedCostReader(db, new CostExplorerReader()),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "identity");
