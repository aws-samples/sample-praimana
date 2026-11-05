import { serve } from "@hono/node-server";
import app from "./app.js";

// Local dev entry point (mirrors the monolith's local.ts). Runs on its own port
// so it can run alongside the monolith (4000) during the strangler migration.
const port = parseInt(process.env.PORT || "4016");

console.log(`Source service running at http://localhost:${port}/v1`);
serve({ fetch: app.fetch, port });
