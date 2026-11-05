import { serve } from "@hono/node-server";
import app from "./app.js";

// Local dev entry point (mirrors the other services' local.ts). Its own port so it
// runs alongside the rest of the stack — 4020, the next one after desktop's 4019.
//
// NOTE this service makes REAL Cognito admin calls, so running it locally needs
// credentials that can write to the pool and COGNITO_USER_POOL_ID set. Without the
// latter it refuses to start (see app.ts), which is the intended behaviour: a local
// run that silently could not create accounts would be worse than one that says so.
const port = parseInt(process.env.PORT || "4020");

console.log(`User Access service running at http://localhost:${port}/v1/user-access`);
serve({ fetch: app.fetch, port });
