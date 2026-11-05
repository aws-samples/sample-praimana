import { createDocClient, withHealth } from "@praimana/service-shared";
import { createDocsRoutes } from "./routes.js";
import {
  DynamoDocPointerRepository,
  DynamoTeamLookup,
} from "./repository.dynamo.js";
import { DynamoTeamMembership } from "./authz.js";
import { S3DocStore } from "./s3.store.js";
import { DynamoUsersReadModel } from "./users-readmodel.dynamo.js";

/**
 * Composition root. The ONE place that knows about concrete implementations; it
 * wires them into the routes. Swapping S3 for another blob store, or the local
 * DynamoDB membership check for an HTTP call, is a change HERE only — routes.ts and
 * the domain interfaces never change (Dependency Inversion in action).
 *
 * Note the deliberate divergence from the `source` service: there is no
 * HttpTeamAccess here. The Docs Lambda runs VPC-only with no NAT, so it resolves
 * membership locally against praimana-team-members over the DynamoDB gateway
 * endpoint — see authz.ts.
 */
const db = createDocClient();

const app = createDocsRoutes({
  store: new S3DocStore(),
  pointers: new DynamoDocPointerRepository(db),
  teams: new DynamoTeamLookup(db),
  membership: new DynamoTeamMembership(db),
  /**
   * The SIXTH users read-model, added because this service had none — so an uploaded file showed its
   * author as a raw Cognito sub. Local and event-synced, like the other five: reading Identity's
   * users table across the boundary is forbidden.
   */
  users: new DynamoUsersReadModel(db),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "docs");
