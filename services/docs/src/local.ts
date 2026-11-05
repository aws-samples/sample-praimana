import { serve } from "@hono/node-server";
import app from "./app.js";

// Local dev entry point (mirrors the monolith's local.ts). Runs on its own port
// so it can run alongside the other services during the strangler migration.
const port = parseInt(process.env.PORT || "4018");

console.log(`Docs service running at http://localhost:${port}/v1`);
serve({ fetch: app.fetch, port });
