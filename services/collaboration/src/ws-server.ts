import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { verifyJwtIdentity } from "@praimana/service-shared";
import type { TeamAccess } from "./authz.js";
import { subscribeTeamEvents } from "./live-bus.js";

/**
 * Real-time team-event delivery over WebSockets — the replacement for the old
 * SSE `GET /v1/teams/:teamId/events` route.
 *
 * WHY WEBSOCKETS (not SSE, not API Gateway): this service is a single always-on
 * instance (it can't go on Lambda because of the long-lived connections here), so
 * the in-process live-bus fan-out is still correct — every connection for a team
 * lives in THIS process. A native `ws` server holds those connections directly,
 * which comfortably covers the target of ~500 concurrent users across many teams
 * on one instance with no connection registry / PostToConnection plumbing. If the
 * service is ever scaled horizontally, replace live-bus with a shared broker
 * (Redis pub/sub) — the socket layer here would not change.
 *
 * AUTH: the WS upgrade can't run Hono middleware, so it authenticates the SAME
 * way as edgeIdentityMiddleware via the shared verifyJwtIdentity (one source of
 * truth for the JWT secret + claims), then authorizes team READ access through
 * the injected TeamAccess (same guard the REST routes use). A browser WebSocket
 * can't set an Authorization header, so the token is accepted from the `token`
 * query param; the desktop client (Node) may use either.
 */

// Matches the SSE route's path so the client URL barely changes: /v1/teams/:id/events
const EVENTS_PATH = /^\/v1\/teams\/([^/?]+)\/events(?:\?|$)/;

// Heartbeat: ping idle sockets so dead connections (and proxies that drop idle
// ones) are detected and reaped, matching the old SSE ~25s heartbeat.
const HEARTBEAT_MS = 25_000;

export interface TeamEventWsDeps {
  teamAccess: TeamAccess;
}

/**
 * Attach a WebSocket endpoint for team events to an existing http.Server. Returns
 * a disposer that closes the server + clears the heartbeat (used by tests).
 */
export function attachTeamEventsWs(server: Server, deps: TeamEventWsDeps): () => void {
  // noServer: we do the upgrade by hand so we can authenticate BEFORE accepting.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    const match = url.match(EVENTS_PATH);
    if (!match) {
      // Not our route — destroy so we don't leave a dangling upgrade. (If other
      // WS endpoints are added later, switch this to a router instead.)
      socket.destroy();
      return;
    }
    const teamId = decodeURIComponent(match[1]);

    // Extract the token from the query string or the Authorization header.
    const token = tokenFromRequest(url, req.headers.authorization);

    // Authenticate + authorize before completing the handshake. Any failure ends
    // the TCP socket with the right HTTP status instead of a half-open upgrade.
    //
    // ── THE .catch IS NOT DEFENSIVE PADDING; ITS ABSENCE WAS A LEAK ──
    //
    // Without it a REJECTED authorize() — a TeamAccess implementation that throws rather
    // than returning false — took neither branch below: the socket was never written to and
    // never destroyed, so the client sat on a HALF-OPEN TCP connection until something else
    // timed it out, and the rejection surfaced only as an unhandled promise rejection which
    // in Node 22 can terminate the process. One slow-then-throwing dependency could
    // therefore accumulate stuck sockets on an always-on instance. Found by
    // ws-authz.test.ts's "REJECTS a throwing Team context" case, which hung for 15s against
    // the previous code.
    //
    // HttpTeamAccess already swallows every network failure into `false`, so this is
    // unreachable through the deployed wiring — which is exactly why it must not be relied
    // upon: an authorization outcome must not depend on a collaborator's internal
    // discipline, and the failure mode here is a resource leak rather than merely a wrong
    // answer. 401 for the same reason the `!identity` branch uses it: the caller is not
    // being told which of authN or authZ was undetermined.
    void authorize(deps, teamId, token)
      .then((identity) => {
        if (!identity) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // `token` is non-null here: authorize() returned an identity, which it only does
          // after verifyJwtIdentity accepted that token.
          handleConnection(ws, teamId, identity.id, tokenExpiryMs(token ?? ""));
        });
      })
      .catch((err) => {
        // Identifiers only — never the token, and never the payload.
        console.error("[collaboration] ws upgrade authorization failed — refusing", {
          teamId,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        rejectUpgrade(socket, 401, "Unauthorized");
      });
  });

  // Liveness sweep: terminate sockets that didn't answer the previous ping.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as WsWithAlive;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, HEARTBEAT_MS);
  // Don't keep the process alive just for the heartbeat timer.
  heartbeat.unref?.();

  return () => {
    clearInterval(heartbeat);
    wss.close();
  };
}

interface WsWithAlive extends WebSocket {
  isAlive?: boolean;
}

/** Verify the token and confirm the caller may read this team's CONTENT. */
async function authorize(
  deps: TeamEventWsDeps,
  teamId: string,
  token: string | undefined
): Promise<{ id: string; role: string } | null> {
  const identity = await verifyJwtIdentity(token);
  if (!identity) return null;
  // CONTENT read — MEMBER-ONLY, narrowed from the wider canRead.
  //
  // This stream carries the very payloads the REST content routes now restrict: every
  // message posted to the team chat and every board task created or updated (see the
  // publishTeamEvent calls in routes.ts). Gating the sockets on the wider administration
  // predicate while the REST routes are member-only would not preserve any access an admin
  // is meant to have — it would just move the disclosure to the channel that delivers the
  // same content continuously and in real time, which is strictly worse than the polling
  // route it replaced.
  //
  // Read access (not write) is still the right level: a read-only EXECUTIVE member watches
  // the stream and mutates nothing, because writes go through the REST routes'
  // requireTeamContentWrite.
  //
  // NOTE: no Context is passed — a WS upgrade has no Hono Context — so HttpTeamAccess
  // takes its `if (!auth) return DENY_ALL` branch in the deployed topology and this
  // authorization is decided by the injected implementation, exactly as it was before this
  // change. Fail-closed either way; not a behaviour this change alters.
  const mayRead = await deps.teamAccess.canReadContent(
    teamId,
    identity.id,
    identity.role
  );
  if (!mayRead) return null;
  return { id: identity.id, role: identity.role };
}

/**
 * WebSocket close code for "the credential that opened this socket has expired".
 *
 * 4001 is in the 4000-4999 private range, so it cannot collide with a protocol-defined
 * code. A distinct code (rather than a generic 1000/1008) lets the client tell "your session
 * ended, reconnect with a fresh token" apart from "you were never allowed in" — which it
 * would otherwise present to the user as an unexplained disconnect.
 */
export const WS_CLOSE_TOKEN_EXPIRED = 4001;

/**
 * The `exp` claim, in epoch milliseconds, from a token that has ALREADY BEEN VERIFIED.
 *
 * DECODE-ONLY, and safe precisely because of that ordering: `authorize()` has already run
 * `verifyJwtIdentity`, which checks the signature, issuer, audience and expiry against the
 * pool's JWKS. This only re-reads a claim from a payload already proven authentic, so it is
 * not a second, weaker verification — a forged token never reaches here.
 *
 * Read locally rather than by widening `verifyJwtIdentity`'s EdgeIdentity return type: this
 * is the only caller on the platform that needs the expiry, and adding a field to a shared
 * identity shape used by nine services to serve one consumer is the wrong trade.
 *
 * Returns null on anything unreadable, which the caller treats as "no bound" rather than as
 * an immediate close — see the note at the call site.
 */
export function tokenExpiryMs(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Bridge one accepted socket to the team's live-bus until it closes. */
function handleConnection(
  ws: WsWithAlive,
  teamId: string,
  actorId: string,
  expiresAtMs: number | null
): void {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // ── BOUND THE SESSION TO THE CREDENTIAL THAT OPENED IT ──
  //
  // The token is verified ONCE, at handshake, and never again — so without this a socket
  // outlives the credential that authorised it by an UNBOUNDED margin. The heartbeat below
  // only reaps sockets that stop answering pings; a healthy client streams every team event
  // for as long as it stays connected.
  //
  // That made "access ends when the token expires" false for this path. A member removed
  // from a team, a user whose access was disabled, a changed role — none of them closed an
  // open stream. Deactivating someone stopped them signing in and left them watching the
  // team's live events indefinitely.
  //
  // Closing at `exp` bounds every socket to the token's own lifetime (30 minutes here) and
  // fixes the whole class at once, rather than only the deactivation case: the client
  // reconnects with a fresh token, and a client that can no longer GET one simply stays out.
  //
  // A MISSING OR UNREADABLE exp leaves the socket UNBOUNDED rather than closing it
  // immediately. Deliberate: the token is already verified, so an unreadable claim means our
  // decoder disagreed with jose about the payload — a bug on our side, and closing every
  // socket on it would turn that bug into a total outage of the live stream. Logged instead,
  // so it is visible rather than silent.
  if (expiresAtMs === null) {
    console.warn("[collaboration] ws opened with no readable exp — session is unbounded", {
      teamId,
      actorId,
    });
  } else {
    // Never negative: a token that expired between the verify and this line closes on the
    // next tick rather than scheduling into the past.
    const ttl = Math.max(0, expiresAtMs - Date.now());
    const expiryTimer = setTimeout(() => {
      try {
        ws.close(WS_CLOSE_TOKEN_EXPIRED, "token expired");
      } catch {
        /* already closing */
      }
    }, ttl);
    // unref so a pending timer cannot hold the process open at shutdown.
    expiryTimer.unref?.();
    ws.on("close", () => clearTimeout(expiryTimer));
  }

  // Forward every team event to this client. `actorId` is included so the client
  // can skip badging the user's own actions (same contract as the SSE payload).
  const unsubscribe = subscribeTeamEvents(teamId, (event) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch {
      /* send raced with a close; the close handler will clean up */
    }
  });

  ws.on("close", unsubscribe);
  ws.on("error", () => {
    unsubscribe();
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  });

  // Mirror the SSE "connected" hello so the client has a definite ready signal.
  try {
    ws.send(JSON.stringify({ type: "connected", teamId }));
  } catch {
    /* closed immediately */
  }
  // actorId currently unused server-side but part of the accepted contract.
  void actorId;
}

/** token query param takes precedence; fall back to a Bearer Authorization header. */
function tokenFromRequest(
  url: string,
  authHeader: string | undefined
): string | undefined {
  const q = url.indexOf("?");
  if (q !== -1) {
    const params = new URLSearchParams(url.slice(q + 1));
    const t = params.get("token");
    if (t) return t;
  }
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return undefined;
}

/** End a rejected upgrade with a minimal HTTP response, then close the socket. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n"
  );
  socket.destroy();
}
