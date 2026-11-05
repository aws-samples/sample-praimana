import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";

/**
 * WHO MAY OPEN THE TEAM EVENT STREAM — the authorization half of the WebSocket upgrade.
 *
 * ws-session-bound.test.ts covers how long a socket LIVES. This file covers whether it
 * should have been opened at all, which had no test before and is the more consequential
 * question: this stream carries every message posted to the team chat and every board task
 * created or updated (see the publishTeamEvent calls in routes.ts).
 *
 * ── WHY IT MATTERS FOR MEMBER-ONLY ACCESS ──
 *
 * The REST content routes are now member-only. Gating the sockets on the WIDER
 * administration predicate would not preserve any access an admin is meant to have — it
 * would relocate the disclosure to the channel that delivers the SAME content continuously
 * and in real time, which is strictly worse than the polling route it replaced. So
 * `authorize()` asks canReadContent, and this file asserts that it asks THAT and not
 * canRead.
 *
 * Driven through a REAL http.Server and a REAL ws client, because the property under test is
 * the upgrade handshake: a unit test of `authorize` would not prove that a refused caller's
 * TCP socket is actually closed rather than left half-open.
 */

// verifyJwtIdentity reaches Cognito's JWKS, which is neither available nor the subject of
// this test — authN is proven in shared/edge-identity.test.ts. Mocked so each case can
// present a chosen VERIFIED identity and the assertions are about authoriZation only.
const verify = vi.hoisted(() => vi.fn());
vi.mock("@praimana/service-shared", async (orig) => {
  const actual = await orig<typeof import("@praimana/service-shared")>();
  return { ...actual, verifyJwtIdentity: verify };
});

const { attachTeamEventsWs } = await import("./ws-server.js");
type TeamAccess = import("./authz.js").TeamAccess;

/** Records which predicate the upgrade consulted — the drift assertion's mechanism. */
class RecordingTeamAccess implements TeamAccess {
  readonly calls: string[] = [];
  constructor(
    private readonly wide = true,
    private readonly content = true
  ) {}
  async canRead() {
    this.calls.push("canRead");
    return this.wide;
  }
  async canWrite() {
    this.calls.push("canWrite");
    return this.wide;
  }
  async canReadContent() {
    this.calls.push("canReadContent");
    return this.content;
  }
  async canWriteContent() {
    this.calls.push("canWriteContent");
    return this.content;
  }
}

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

/** Start a server with the WS endpoint attached; returns its loopback WebSocket base URL. */
async function serve(teamAccess: TeamAccess): Promise<string> {
  const server = createServer((_req, res) => res.end());
  const dispose = attachTeamEventsWs(server, { teamAccess });
  servers.push({ server, dispose });
  server.listen(0);
  await once(server, "listening");
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Attempt one handshake. Resolves "open" when the socket is accepted, or "rejected" when
 * the upgrade is refused — whichever happens first.
 *
 * `unexpected-response` is what `ws` emits for the 401 written by rejectUpgrade, and `error`
 * covers the socket being destroyed. Both are the refusal path.
 */
function handshake(base: string, teamId = "t1"): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/v1/teams/${teamId}/events?token=a.b.c`);
    const settle = (outcome: "open" | "rejected") => {
      ws.removeAllListeners();
      // `terminate()` THROWS "closed before the connection was established" when the
      // handshake never completed, which is precisely the refusal case — and an uncaught
      // throw here surfaced as an unhandled exception that Vitest rightly warns can mask a
      // real failure. So only an OPEN socket is terminated (to stop it holding the server);
      // a refused one already has no connection to tear down. A no-op listener keeps a late
      // `error` event from re-raising after we have settled.
      ws.on("error", () => {});
      if (outcome === "open") ws.terminate();
      resolve(outcome);
    };
    ws.on("open", () => settle("open"));
    ws.on("unexpected-response", () => settle("rejected"));
    ws.on("error", () => settle("rejected"));
  });
}

describe("the team-events WebSocket upgrade", () => {
  it("REJECTS an unauthenticated caller before consulting the Team context", async () => {
    verify.mockResolvedValue(null);
    const ta = new RecordingTeamAccess(true, true);

    expect(await handshake(await serve(ta))).toBe("rejected");
    // authN first: no point asking about a team for a caller we cannot identify, and it
    // keeps an unauthenticated flood from generating east-west traffic.
    expect(ta.calls).toHaveLength(0);
  });

  it("ACCEPTS a member — the case that must keep working", async () => {
    verify.mockResolvedValue({ id: "member", email: "m@example.com", role: "PARTICIPANT" });
    const ta = new RecordingTeamAccess(true, true);

    expect(await handshake(await serve(ta))).toBe("open");
  });

  it("ACCEPTS a read-only EXECUTIVE member — read access is enough to observe", async () => {
    // Writes go through the REST routes' requireTeamContentWrite; watching is not writing.
    verify.mockResolvedValue({ id: "exec", email: "e@example.com", role: "EXECUTIVE" });
    const ta = new RecordingTeamAccess(true, true);

    expect(await handshake(await serve(ta))).toBe("open");
  });

  it("asks canReadContent, NOT canRead — the drift assertion", async () => {
    // ── THE ONE THAT CATCHES THE RELOCATED LEAK ──
    //
    // If this consulted canRead, every case where the two pairs agree would still pass and
    // an ADMIN would keep a real-time feed of the chat that the REST route now refuses them.
    verify.mockResolvedValue({ id: "u9", email: "u@example.com", role: "ADMIN" });
    const ta = new RecordingTeamAccess(true, true);

    await handshake(await serve(ta));

    expect(ta.calls).toEqual(["canReadContent"]);
  });

  it("REJECTS a caller the CONTENT predicate refuses but the WIDE one allows", async () => {
    // Exactly the shape the Team service answers for a non-member ADMIN or a
    // workshop-owning FACILITATOR: wide true, content false.
    verify.mockResolvedValue({ id: "admin", email: "a@example.com", role: "ADMIN" });
    const ta = new RecordingTeamAccess(true, false);

    expect(await handshake(await serve(ta))).toBe("rejected");
  });

  it("REJECTS when the Team context cannot answer (fail-closed)", async () => {
    // HttpTeamAccess maps a 5xx, a timeout, a connect error and an ABSENT FIELD all to
    // false, so "undetermined" arrives here as a refusal — never as an open socket.
    verify.mockResolvedValue({ id: "u1", email: "u@example.com", role: "PARTICIPANT" });
    const unavailable: TeamAccess = {
      canRead: async () => false,
      canWrite: async () => false,
      canReadContent: async () => false,
      canWriteContent: async () => false,
    };

    expect(await handshake(await serve(unavailable))).toBe("rejected");
  });

  it("REJECTS a throwing Team context rather than leaving the upgrade hanging", async () => {
    // A rejected promise inside the upgrade handler must not leave a half-open socket or an
    // unhandled rejection: the caller gets no stream either way, and the socket is closed.
    verify.mockResolvedValue({ id: "u1", email: "u@example.com", role: "PARTICIPANT" });
    const throwing: TeamAccess = {
      canRead: async () => false,
      canWrite: async () => false,
      canReadContent: async () => {
        throw new Error("team service exploded");
      },
      canWriteContent: async () => false,
    };

    expect(await handshake(await serve(throwing))).toBe("rejected");
  });

  it("asks about the team in the URL, not one the caller could choose", async () => {
    verify.mockResolvedValue({ id: "u1", email: "u@example.com", role: "PARTICIPANT" });
    const asked: string[] = [];
    const recording: TeamAccess = {
      canRead: async () => false,
      canWrite: async () => false,
      canReadContent: async (teamId: string) => {
        asked.push(teamId);
        return true;
      },
      canWriteContent: async () => false,
    };

    await handshake(await serve(recording), "t-42");

    expect(asked).toEqual(["t-42"]);
  });
});
