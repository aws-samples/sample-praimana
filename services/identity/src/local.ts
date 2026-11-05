import { serve } from "@hono/node-server";
import app from "./app.js";

const port = parseInt(process.env.PORT || "4011");

console.log(`Identity service running at http://localhost:${port}/v1/auth`);
serve({ fetch: app.fetch, port });
