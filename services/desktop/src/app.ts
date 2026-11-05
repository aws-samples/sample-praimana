import { withHealth } from "@praimana/service-shared";
import { createDesktopRoutes } from "./routes.js";
import { S3InstallerStore } from "./s3.store.js";

/**
 * Composition root. The ONE place that knows about the concrete S3InstallerStore;
 * it wires it into the routes. Swapping S3 for another blob store is a change
 * HERE only — routes.ts and the domain interface never change (Dependency
 * Inversion in action).
 *
 * Unlike the docs service this one touches NO DynamoDB — there's no per-team
 * scoping. The installer is the same artifact for every authenticated user, so
 * the store is purely the shared-account S3 bucket.
 */
const app = createDesktopRoutes({
  store: new S3InstallerStore(),
});

// Wrap with an unauthenticated /health (liveness + uptime), then export.
export default withHealth(app, "desktop");
