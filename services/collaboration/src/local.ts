import { serve } from "@hono/node-server";
import app from "./app.js";
import { attachTeamEventsWs } from "./ws-server.js";
import { HttpTeamAccess } from "./team-access.http.js";

// Local dev entry point (mirrors the monolith's local.ts). Runs on its own port
// so it can run alongside the monolith (4000) during the strangler migration.
const port = parseInt(process.env.PORT || "4014");

// serve() returns the underlying Node http.Server; we attach the team-events
// WebSocket endpoint to it so REST (Hono) and real-time (ws) share one port. The
// old SSE route lived inside the Hono app; real-time now upgrades to a WebSocket
// on the same /v1/teams/:id/events path (see ws-server.ts).
const server = serve({ fetch: app.fetch, port });

attachTeamEventsWs(server as unknown as import("node:http").Server, {
  teamAccess: new HttpTeamAccess(),
});

console.log(`Collaboration service running at http://localhost:${port}/v1`);
console.log(`  • team events (WebSocket) at ws://localhost:${port}/v1/teams/:teamId/events`);
