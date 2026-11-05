import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";

/**
 * WHERE THE UPGRADE FINDS ITS TOKEN — the two accepted carriers, and which one wins.
 *
 * ws-authz.test.ts covers WHO may open the stream; this file covers HOW the credential
 * reaches `authorize()` in the first place. `tokenFromRequest` accepts a `?token=` query
 * param OR a `Bearer` Authorization header, and both branches are load-bearing for a
 * DIFFERENT client:
 *
 *   · the HEADER branch is what the desktop app uses. It moved off the query param because a
 *     URL is the least private part of a request — proxy and load-balancer access logs, APM
 *     traces and error reports all capture it, and none is treated as a credential store.
 *   · the QUERY branch is what the portal uses, and it CANNOT move. The browser
 *     `WebSocket` constructor has no way to set a request header, so deleting this branch
 *     would break every browser client.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE ASSERTION USED TO LIVE IN THE DESKTOP REPO, reading this
 * service's source across a repository boundary (`desktop/src/main/event-stream-auth.test.ts`
 * read `../../../services/collaboration/src/ws-server.ts`). That worked only where the repos
 * happened to be checked out side by side: in the desktop repo's own CI checkout the path did
 * not resolve and the read threw, failing the build gate that guards its publish pipeline. The
 * check belongs here, in the repo that owns the file, where it is always present and where
 * anyone changing `tokenFromRequest` is actually looking.
 *
 * ⚠ AND IT ASSERTS BEHAVIOUR, NOT TEXT. The cross-repo version matched source strings
 * (`/authHeader\?\.startsWith\("Bearer "\)/`), which a correct refactor would have broken and
 * a comment mentioning the right words could have satisfied. Driven through a REAL
 * http.Server and a REAL ws client instead, so what is pinned is the upgrade's observable
 * contract.
 */

// verifyJwtIdentity reaches Cognito's JWKS, which is neither available nor the subject of
// this test — authN is proven in shared/edge-identity.test.ts. Mocked here for a second
// reason as well: its FIRST ARGUMENT is the extracted token, which makes the mock the only
// honest witness to what `tokenFromRequest` actually pulled off the request.
const verify = vi.hoisted(() => vi.fn());
vi.mock("@praimana/service-shared", async (orig) => {
  const actual = await orig<typeof import("@praimana/service-shared")>();
  return { ...actual, verifyJwtIdentity: verify };
});

const { attachTeamEventsWs } = await import("./ws-server.js");
type TeamAccess = import("./authz.js").TeamAccess;

/** Authorization is not the question here — every predicate allows, so only extraction fails. */
const permissive: TeamAccess = {
  canRead: async () => true,
  canWrite: async () => true,
  canReadContent: async () => true,
  canWriteContent: async () => true,
};

const servers: Array<{ server: Server; dispose: () => void }> = [];

afterEach(async () => {
  // Every server and its heartbeat timer torn down, so a leaked interval cannot hold the
  // process open or leak between cases.
  for (const { server, dispose } of servers.splice(0)) {
    dispose();
    server.close();
    await once(server, "close").catch(() => {});
  }
  verify.mockReset();
});

async function serve(): Promise<string> {
  const server = createServer((_req, res) => res.end());
  const dispose = attachTeamEventsWs(server, { teamAccess: permissive });
  servers.push({ server, dispose });
  server.listen(0);
  await once(server, "listening");
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Attempt one handshake, presenting the token via the query string, a header, both or
 * neither. Resolves "open" when accepted, "rejected" when refused.
 *
 * `unexpected-response` is what `ws` emits for the 401 written by rejectUpgrade, and `error`
 * covers the socket being destroyed — both are the refusal path. Only an OPEN socket is
 * terminated: `terminate()` throws on a handshake that never completed, and a late `error`
 * after settling would surface as an unhandled exception.
 */
function handshake(
  base: string,
  opts: { query?: string; header?: string } = {}
): Promise<"open" | "rejected"> {
  const qs = opts.query === undefined ? "" : `?token=${opts.query}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `${base}/v1/teams/t1/events${qs}`,
      opts.header === undefined
        ? undefined
        : { headers: { Authorization: opts.header } }
    );
    const settle = (outcome: "open" | "rejected") => {
      ws.removeAllListeners();
      ws.on("error", () => {});
      if (outcome === "open") ws.terminate();
      resolve(outcome);
    };
    ws.on("open", () => settle("open"));
    ws.on("unexpected-response", () => settle("rejected"));
    ws.on("error", () => settle("rejected"));
  });
}

/** What `tokenFromRequest` handed to authorize(), read off the verify mock. */
const extracted = (): unknown => verify.mock.calls[0]?.[0];

describe("the team-events upgrade finds its token in either carrier", () => {
  it("ACCEPTS a Bearer Authorization header — the desktop's only carrier", async () => {
    // The line the desktop's move off the query param rests on. If this branch is ever
    // dropped, every desktop client loses its realtime badges and notifications at once.
    verify.mockResolvedValue({ id: "u1", email: "u@example.com", role: "PARTICIPANT" });

    expect(await handshake(await serve(), { header: "Bearer h.ead.er" })).toBe("open");
    expect(extracted(), "the header's token, with the Bearer prefix stripped").toBe("h.ead.er");
  });

  it("ACCEPTS a ?token= query param — the portal's only carrier", async () => {
    // ⚠ MUST NOT BE REMOVED. A browser `new WebSocket()` cannot send a header, so this is
    // the portal's only way to authenticate. The desktop's migration was deliberately
    // desktop-only for exactly this reason.
    verify.mockResolvedValue({ id: "u1", email: "u@example.com", role: "PARTICIPANT" });

    expect(await handshake(await serve(), { query: "q.ue.ry" })).toBe("open");
    expect(extracted()).toBe("q.ue.ry");
  });

  it("prefers the QUERY param when both are present", async () => {
    /**
     * ⚠ THE PRECEDENCE IS THE OPPOSITE OF WHAT THE DESKTOP ONCE DOCUMENTED. Its comment
     * claimed the server "prefers the header when present"; it does not. Pinned as a fact
     * rather than left to a comment, because the wrong belief is what made the desktop's
     * change look safe: had the header branch NOT existed, sending only a header would have
     * silently authenticated nobody.
     *
     * Not asserted as the RIGHT design — a header is the more private carrier and would be
     * the better winner. Changing it is safe for both shipping clients, since neither sends
     * both at once. This case exists so such a change is a deliberate edit here rather than
     * an accident nobody notices.
     */
    verify.mockResolvedValue({ id: "u1", email: "u@example.com", role: "PARTICIPANT" });

    await handshake(await serve(), { query: "q.ue.ry", header: "Bearer h.ead.er" });

    expect(extracted()).toBe("q.ue.ry");
  });

  it("REJECTS a caller presenting neither, without inventing a token", async () => {
    // The absent case reaches authorize() as `undefined` rather than "" — so verifyJwtIdentity
    // is asked about nothing at all, and a falsy-but-present token cannot be mistaken for one.
    verify.mockResolvedValue(null);

    expect(await handshake(await serve())).toBe("rejected");
    expect(extracted()).toBeUndefined();
  });

  it("IGNORES a non-Bearer Authorization header", async () => {
    // Basic credentials are not a JWT. Passing the raw header value through would hand
    // verifyJwtIdentity a string it must then reject — undefined says "no token" honestly.
    verify.mockResolvedValue(null);

    expect(await handshake(await serve(), { header: "Basic dXNlcjpwYXNz" })).toBe("rejected");
    expect(extracted()).toBeUndefined();
  });
});
