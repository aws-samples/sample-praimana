import {
  createDocClient,
  EventBridgePublisher,
  withHealth,
} from "@praimana/service-shared";
import { createCollaborationRoutes } from "./routes.js";
import {
  DynamoTaskRepository,
  DynamoMessageRepository,
} from "./repository.dynamo.js";
import { DynamoUsersReadModel } from "./users-readmodel.dynamo.js";
import { HttpTeamAccess } from "./team-access.http.js";

/**
 * Composition root. This is the ONE place that knows about concrete
 * implementations; it wires them into the routes. Swapping DynamoDB for another
 * store, or HttpTeamAccess for an event-fed read-model, is a change HERE only —
 * routes.ts and domain logic never change (Dependency Inversion in action).
 */
const db = createDocClient();

const app = createCollaborationRoutes({
  tasks: new DynamoTaskRepository(db),
  messages: new DynamoMessageRepository(db),
  users: new DynamoUsersReadModel(db),
  teamAccess: new HttpTeamAccess(),
  events: new EventBridgePublisher(),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "collaboration");
