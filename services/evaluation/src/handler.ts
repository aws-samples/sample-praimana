import { handle } from "hono/aws-lambda";
import type { DomainEvent } from "@praimana/service-shared";
import app, { activityReadModel } from "./app.js";
import { applyActivityEvent } from "./routes.js";

/**
 * AWS Lambda entry point. This function has TWO invocation sources and must tell
 * them apart, because the payload shapes are unrelated:
 *
 *   1. **API Gateway (HTTP API)** — every `/v1/...` route. Handled by Hono.
 *   2. **EventBridge** — the `praimana-evaluation-activity` rule, which
 *      matches the domain events listed in `applyActivityEvent` and feeds the
 *      per-member activity counters.
 *
 * WHY this branch exists: `handle(app)` is an HTTP adapter. An EventBridge event
 * has no `requestContext`/`rawPath`, so routing it through Hono matched nothing
 * and returned **404** — and because a 404 is a *successful* Lambda invocation,
 * EventBridge never retried and the DLQ never saw it. The activity read-model was
 * silently never written, so `/contribution` reported zeros for everyone. The rule
 * was wired in infra long before this branch existed; don't remove it.
 */

/** An EventBridge payload — identified by the fields only it carries. */
function isEventBridgeEvent(event: unknown): event is {
  "detail-type": string;
  source: string;
  detail?: unknown;
  /** EventBridge's per-delivery id. Optional in the guard because a hand-built test event
   *  may omit it; the consumer treats a missing id as "cannot dedup" (see increment). */
  id?: unknown;
} {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e["detail-type"] === "string" && typeof e.source === "string";
}

const httpHandler = handle(app);

export const handler = async (event: unknown, context: unknown) => {
  if (isEventBridgeEvent(event)) {
    // Map EventBridge's wire format onto the internal DomainEvent shape that
    // applyActivityEvent (and the in-process publisher) already speak.
    const domainEvent: DomainEvent = {
      source: event.source,
      type: event["detail-type"],
      detail: event.detail ?? {},
      /**
       * ── ⚠ THE PUBLISHER'S OWN KEY WINS OVER EVENTBRIDGE'S ─────────────────────────────
       *
       * EventBridge's `id` is per-DELIVERY: it dedups a REDELIVERY of one publish, which is what this
       * line was added for — a redelivered `task.status-changed` had incremented `tasksCompleted`
       * twice for one completed task.
       *
       * It does NOT dedup a re-PUBLISH, and that gap became reachable the moment the desktop grew a
       * per-message "retry sync" button. A retried turn converges its MESSAGES (the AI service derives
       * `sync-<clientTurnId>-<i>` ids), then publishes a brand-new `ai.response-generated` — new
       * EventBridge id, no matching dedup claim, `aiTurns` incremented a second time for one turn. The
       * transcript stays correct while the counter that feeds a model-written assessment of a named
       * person quietly inflates, once per press.
       *
       * So a publisher that can genuinely identify its own work says so in `dedupeKey`, and that is
       * preferred here. Falling back to `event.id` keeps every existing publisher — none of which sets
       * one — behaving exactly as before.
       */
      id:
        typeof (event.detail as { dedupeKey?: unknown } | undefined)?.dedupeKey === "string"
          ? (event.detail as { dedupeKey: string }).dedupeKey
          : typeof event.id === "string"
            ? event.id
            : undefined,
    };

    // Let failures THROW. Unlike publishing (fire-and-forget, where the write is
    // the source of truth), a dropped projection update is permanent data loss:
    // there is no reconciliation pass. Throwing is what makes EventBridge retry
    // and, after retries, park the event on the DLQ for replay.
    await applyActivityEvent(activityReadModel, domainEvent);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return httpHandler(event as any, context as any);
};
