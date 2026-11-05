import {
  createDocClient,
  EventBridgePublisher,
  withHealth,
} from "@praimana/service-shared";
import { createAiRoutes } from "./routes.js";
import {
  DynamoThreadRepository,
  DynamoMessageRepository,
  DynamoTeamAiRatingRepository,
} from "./repository.dynamo.js";
import { DynamoUsersReadModel } from "./users-readmodel.dynamo.js";
import { HttpTeamAccess } from "./team-access.http.js";
import { HttpWorkshopEntitlements } from "./workshop-entitlements.http.js";
import { BedrockRatingAnalyst } from "./analyst.bedrock.js";
import {
  HttpTeamChatReader,
  HttpTeamCountersReader,
  HttpTeamWorkshopLookup,
} from "./ratings-readers.http.js";

/**
 * Composition root. This is the ONE place that knows about concrete
 * implementations; it wires them into the routes. Swapping DynamoDB for another
 * store, or HttpTeamAccess for an event-fed read-model, is a change HERE only —
 * routes.ts and domain logic never change (Dependency Inversion in action).
 */
const db = createDocClient();

const app = createAiRoutes({
  threads: new DynamoThreadRepository(db),
  messages: new DynamoMessageRepository(db),
  users: new DynamoUsersReadModel(db),
  teamAccess: new HttpTeamAccess(),
  events: new EventBridgePublisher(),

  // ── The team AI ratings feature ──────────────────────────────────────────────
  //
  // Wired as a group, and the routes treat them as a group: if any of these are absent the
  // four ratings routes answer 503 RATINGS_UNAVAILABLE rather than half-working. That is
  // what makes this block safe to omit in `local.ts` and safe to omit in tests.
  //
  // `analyst` is the only billable dependency in this file. It is reached by exactly one
  // route (POST .../ratings/analyze, member-write, behind a 10-minute cooldown); the read
  // routes never invoke it, which the tests assert by injecting an analyst that throws.
  ratings: new DynamoTeamAiRatingRepository(db),
  analyst: new BedrockRatingAnalyst(),
  teamChat: new HttpTeamChatReader(),
  counters: new HttpTeamCountersReader(),
  workshops: new HttpTeamWorkshopLookup(),
  entitlements: new HttpWorkshopEntitlements(),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "ai");
