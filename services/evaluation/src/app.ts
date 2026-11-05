import {
  createDocClient,
  EventBridgePublisher,
  withHealth,
} from "@praimana/service-shared";
import { createEvaluationRoutes } from "./routes.js";
import {
  DynamoSubmissionRepository,
  DynamoScoreRepository,
  DynamoMemberRatingRepository,
  DynamoWorkshopResultsRepository,
} from "./repository.dynamo.js";
import { DynamoActivityReadModel } from "./activity-readmodel.dynamo.js";
import { DynamoUsersReadModel } from "./users-readmodel.dynamo.js";
import { HttpTeamAccess } from "./team-access.http.js";
import { HttpWorkshopEntitlements } from "./workshop-entitlements.http.js";
import {
  HttpDocsCatalog,
  HttpPhaseNotes,
  HttpTeamDirectory,
  HttpTeamRoster,
  HttpWorkshopDirectory,
} from "./snapshot-sources.http.js";

/**
 * Composition root. This is the ONE place that knows about concrete
 * implementations; it wires them into the routes. Swapping DynamoDB for another
 * store, or HttpTeamAccess for an event-fed read-model, is a change HERE only —
 * routes.ts and domain logic never change (Dependency Inversion in action).
 */
const db = createDocClient();

/**
 * The activity read-model is exported because this service has TWO entry points
 * that share one composition root: the HTTP routes below, and the EventBridge
 * consumer in handler.ts that projects domain events into these counters. Both
 * must write the same table via the same implementation.
 */
export const activityReadModel = new DynamoActivityReadModel(db);

const app = createEvaluationRoutes({
  submissions: new DynamoSubmissionRepository(db),
  /**
   * The two content sources a RELEASE pins into its snapshot. HTTP-backed against the
   * OWNING services' own APIs — this service reads neither the docs table nor team-phases.
   *
   * ⚠ THEY NEED `DOCS_SERVICE_URL` AND `WORKSHOP_SERVICE_URL` IN THE ENVIRONMENT. Absent, both
   * default to localhost and every release answers 503 SNAPSHOT_SOURCE_UNAVAILABLE — which is the
   * safe direction (nothing is released on an unanswered precondition) but is a misconfiguration,
   * not a brownout. Set both in the template alongside `TABLE_SUBMISSIONS`.
   */
  docs: new HttpDocsCatalog(),
  phases: new HttpPhaseNotes(),
  /**
   * The team's display NAME, pinned into the snapshot at release — the only way a judge can learn it
   * without widening Team's authz (see `Snapshot.teamName`). Best-effort: a failure pins null.
   */
  teams: new HttpTeamDirectory(),
  // WHO IS ON A TEAM, for the one write that names somebody other than the caller. Wired here
  // because the rating route FAILS CLOSED without it (503) rather than skipping the check.
  roster: new HttpTeamRoster(),
  /**
   * The experience's owner and state. Needed by the judging list's "or owner" branch, which the
   * entitlements probe structurally cannot serve, and by publishing places.
   */
  workshops: new HttpWorkshopDirectory(),
  /**
   * The published ranking. ⚠ Its table is NEW and does not exist until the template is deployed, so a
   * results read fails LOUDLY rather than returning "not published yet" — see the note on
   * `TABLE_WORKSHOP_RESULTS`.
   */
  results: new DynamoWorkshopResultsRepository(db),
  scores: new DynamoScoreRepository(db),
  ratings: new DynamoMemberRatingRepository(db),
  activity: activityReadModel,
  users: new DynamoUsersReadModel(db),
  teamAccess: new HttpTeamAccess(),
  /**
   * The judge-scoping entitlement source (BACKLOG P0-3). HTTP-backed
   * against Team's `GET /v1/entitlements/workshops` — the LIVE mechanism.
   * There is no entitlements table; an earlier Workshop-local store was withdrawn.
   *
   * `NoWorkshopEntitlements` is the alternative wiring for a deployment with no Team
   * service: it refuses every judge definitively (never "unavailable"), so an ADMIN is
   * the only role that can score. Deliberately not the default — silently narrowing
   * judging to admins is not a configuration anyone would notice choosing.
   */
  entitlements: new HttpWorkshopEntitlements(),
  events: new EventBridgePublisher(),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "evaluation");
