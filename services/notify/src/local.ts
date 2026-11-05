import { serve } from "@hono/node-server";
import app from "./app.js";

// Local dev entry point (mirrors the other services' local.ts). Its own port so it
// runs alongside the rest of the stack.
const port = parseInt(process.env.PORT || "4017");

console.log(`Notify service running at http://localhost:${port}/v1/notify`);
serve({ fetch: app.fetch, port });
