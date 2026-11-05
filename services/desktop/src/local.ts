import { serve } from "@hono/node-server";
import app from "./app.js";

// Local dev entry point (mirrors the other services). Runs on its own port so it
// can run alongside the rest of the stack during the strangler migration.
const port = parseInt(process.env.PORT || "4019");

console.log(`Desktop service running at http://localhost:${port}/v1`);
serve({ fetch: app.fetch, port });
