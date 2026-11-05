import { serve } from "@hono/node-server";
import app from "./app.js";

// Local dev entry point (mirrors the monolith's local.ts). Runs on its own port
// so it can run alongside the monolith (4000) during the strangler migration.
//
// NOTE: this local entry point serves HTTP only. In the deployed stack the same
// service ALSO consumes domain events — the EvaluationActivityRule invokes
// handler.ts, which routes EventBridge payloads to applyActivityEvent to feed the
// activity read-model. There is no event source locally, so those counters only
// move here if something calls applyActivityEvent directly.
const port = parseInt(process.env.PORT || "4015");

console.log(`Evaluation service running at http://localhost:${port}/v1`);
serve({ fetch: app.fetch, port });
