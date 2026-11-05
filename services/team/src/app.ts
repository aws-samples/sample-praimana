import {
  createDocClient,
  EventBridgePublisher,
  withHealth,
} from "@praimana/service-shared";
import { createTeamRoutes } from "./routes.js";
import {
  DynamoTeamRepository,
  DynamoTeamMemberRepository,
  DynamoInvitationRepository,
  DynamoAuditRepository,
} from "./repository.dynamo.js";
import { DynamoUsersReadModel } from "./users-readmodel.dynamo.js";
import { DynamoBulkBatchRepository } from "./bulk-batch.dynamo.js";
import { HttpWorkshopAccess } from "./workshop-access.http.js";
import { HttpWorkshopDirectory } from "./workshop-directory.http.js";

/**
 * Composition root. This is the ONE place that knows about concrete
 * implementations; it wires them into the routes. Swapping DynamoDB for another
 * store, or HttpWorkshopAccess for an event-fed read-model, is a change HERE only —
 * routes.ts and domain logic never change (Dependency Inversion in action).
 */
const db = createDocClient();

const teams = new DynamoTeamRepository(db);

const app = createTeamRoutes({
  teams,
  members: new DynamoTeamMemberRepository(db),
  invitations: new DynamoInvitationRepository(db),
  users: new DynamoUsersReadModel(db),
  // Shares the teams repository: workshop OWNERSHIP is the Workshop service's
  // data, but teamId → workshopId is ours, so only the second half is a hop.
  workshops: new HttpWorkshopAccess(teams),
  // The TEAMS DIRECTORY's Workshop-context reads: the caller's owned workshops (its
  // authorization SCOPE) and workshop names (display). A separate port from `workshops`
  // above rather than two more methods on it — see WorkshopDirectory in authz.ts.
  workshopDirectory: new HttpWorkshopDirectory(),
  events: new EventBridgePublisher(),
  // Append-only: who removed whom, and who changed whose access. Its own table rather than
  // log lines, because the question ("who did this?") is asked months later, from the UI.
  audit: new DynamoAuditRepository(db),
  /**
   * The bulk-upload audit trail — the record of what a file asked for and what became of it.
   *
   * Wired UNCONDITIONALLY even though bulk provisioning is feature-gated, because the alternative is
   * worse: reading an env var here to decide would mean an environment with the flag on and the table
   * missing silently accepts uploads and records nothing. The table name defaults, the accept path
   * refuses if the write fails, and the read path answers with an empty list — so a missing table
   * produces an honest 503 on upload rather than an invisible job.
   */
  bulkBatches: new DynamoBulkBatchRepository(db),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "team");
