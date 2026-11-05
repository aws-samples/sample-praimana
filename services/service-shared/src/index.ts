export * from "./edge-identity.js";
export * from "./east-west.js";
export * from "./repository.js";
export * from "./event-bus.js";
export * from "./dynamo.js";
export * from "./send-quota.js";
export * from "./health.js";
export * from "./metrics.js";
export * from "./request-scope.js";
export * from "./activity-events.js";
export * from "./service-invoke.js";

// ── Business rules shared by the portal and these services, but NOT by desktop ──────────────
// A vendored copy of the upstream shared constants. They are NOT in the
// vendored `shared/` folder on purpose: that folder is the three-way intersection (desktop + portal +
// services), and desktop imports none of these. Per the rule in ../../README.md, a module used by fewer
// than all three belongs to the repo that uses it — so services owns this copy, and the portal repo
// carries its own. The service's refusal is what decides; the portal's copy only decides what it shows
// someone before asking.
export * from "./scoring.js";
export * from "./profile.js";
export * from "./roles.js";
export type * from "./types/team.js";
/**
 * Cross-repo file reads for the six template assertions. TEST-ONLY in practice, exported here rather
 * than duplicated into six services — see the header of `sibling-repo.ts` for why the relative paths
 * the monorepo used cannot survive the split.
 */
export * from "./sibling-repo.js";
