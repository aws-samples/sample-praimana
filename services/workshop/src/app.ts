import {
  createDocClient,
  EventBridgePublisher,
  withHealth,
} from "@praimana/service-shared";
import { createWorkshopRoutes } from "./routes.js";
import {
  DynamoWorkshopRepository,
  DynamoPhaseRepository,
  DynamoTeamPhaseRepository,
  DynamoFormatRepository,
} from "./repository.dynamo.js";
import { HttpWorkshopStats } from "./workshop-stats.http.js";
import { HttpTeamAccess, HttpTeamWorkshop } from "./team-access.http.js";
import { HttpWorkshopMembership } from "./workshop-membership.http.js";
import { HttpWorkshopEntitlements } from "./workshop-entitlements.http.js";
import { HttpUserRoles } from "./user-roles.http.js";
import { S3ResourceStore } from "./resource-store.js";

/**
 * Composition root. This is the ONE place that knows about concrete
 * implementations; it wires them into the routes. Swapping DynamoDB for another
 * store, or ZeroWorkshopStats for a real Team-service client / event-fed
 * read-model, is a change HERE only — routes.ts and domain logic never change
 * (Dependency Inversion in action).
 */
const db = createDocClient();

const app = createWorkshopRoutes({
  workshops: new DynamoWorkshopRepository(db),
  phases: new DynamoPhaseRepository(db),
  teamPhases: new DynamoTeamPhaseRepository(db),
  formats: new DynamoFormatRepository(db),
  // Team COUNT is owned by the Team service; until an HTTP client or event-fed
  // read-model is wired, we return 0 rather than read the foreign teams table.
  stats: new HttpWorkshopStats(),
  // Team MEMBERSHIP for the per-team phase routes is owned by the Team service, so
  // it is asked over its own API (forwarding the caller's bearer), never read from
  // teamMembers. TEAM_SERVICE_URL supplies the base URL.
  teamAccess: new HttpTeamAccess(),
  // WHICH EXPERIENCE A TEAM IS IN, so the per-team phase WRITE can check the phase id in the path
  // against that experience's phase template. Wired here because the route FAILS CLOSED without it
  // (503) rather than accepting an unvalidated id — see the dep's note in routes.ts.
  teamWorkshop: new HttpTeamWorkshop(),
  // The membership branch of the workshop READ gate. Also Team-owned, also asked over
  // Team's own API (forwarding the caller's bearer). Reached ONLY when the caller is
  // neither ADMIN nor the workshop's owner — both of which requireWorkshopRead settles
  // locally, which is what keeps this out of the staff path and out of the
  // Team → Workshop → Team cycle. Same TEAM_SERVICE_URL as HttpTeamAccess.
  membership: new HttpWorkshopMembership(),
  // E(self) for the LIST route: the union of invitation- and membership-derived
  // workshops, computed by Team (which owns all three tables) and resolved to rows
  // here. Reached only for JUDGE/EXECUTIVE/PARTICIPANT — ADMIN and FACILITATOR list
  // locally by ownership and never touch this. Same TEAM_SERVICE_URL.
  entitlements: new HttpWorkshopEntitlements(),
  // The new owner's ROLE, for `PATCH /workshops/:id/owner`. Identity-owned, so asked over its API
  // with the caller's own bearer. ⚠ It is what stops ownership transfer being an escalation
  // primitive: `isOwnerOrAdmin` is pure ownership, so an experience handed to a PARTICIPANT would
  // make them able to administer it. Unwired ⇒ the route refuses (501) rather than skipping the
  // check — an absent dependency must never mean "skip the gate".
  userRoles: new HttpUserRoles(),
  /**
   * Workshop resources — the facilitator's material for one experience, in S3.
   *
   * ⚠ WIRED ONLY WHEN THE BUCKET IS NAMED. `RESOURCES_BUCKET` absent means this deployment has no
   * resource storage, and every resource route then answers 501 rather than opening an upload against
   * bucket `""` — which would fail deep inside the SDK with an error nobody can act on. Same polarity as
   * `userRoles` above: an absent dependency refuses, it never skips.
   */
  ...(process.env.RESOURCES_BUCKET ? { resources: new S3ResourceStore() } : {}),
  events: new EventBridgePublisher(),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "workshop");
