/**
 * A FAITHFUL STUB OF THE LOCAL GATEWAY (:8080) — the far side of `backendFetch`.
 *
 * ── WHY THIS EXISTS ALONGSIDE serveTrpc, AND DOES NOT REPLACE IT ──
 *
 * `serveTrpc` (fixtures/trpc.ts) intercepts `/api/trpc/*` with `page.route`, i.e. in the
 * BROWSER. That is the right seam for everything the browser owns — the confirmation
 * dialog's focus model, a row's null-rendering, the debounce, `disabled`. It replaces the
 * tRPC ROUTER.
 *
 * It is the WRONG seam for one specific class of assertion, and scenario C of this work is
 * exactly that class. The defect fixed in 81bc473 — a removed member rendering in the
 * Members list AND in Former members — was fixed in the ROUTER:
 *
 *   src/lib/trpc/routers/team.ts:83-89   (getById)
 *   src/lib/trpc/routers/team.ts:126-128 (listMembers)
 *   src/lib/trpc/routers/team.ts:156-160 (getMyTeam)
 *
 * The PAGE has no filter of its own and never did: `team.members.map(...)` renders whatever
 * it is handed. So a spec that served `team.getById` from a fixture and then asserted "the
 * INACTIVE person is absent from Members" would fail against CORRECT production code —
 * it would have mocked away the thing under test and then reported the mock as a defect.
 * That is the single worst thing a QA harness can do, so this seam exists instead.
 *
 * ── WHAT IS REAL WHEN A SPEC USES THIS ──
 *
 * Everything except the microservices. `backendFetch` runs SERVER-SIDE inside the Next
 * process (lib/backend.ts:34), so it is unreachable from `page.route` — no browser-level
 * interception can touch it. Pointing it at a real socket is therefore the only way to
 * exercise the router at all. In exchange:
 *
 *   - the real tRPC router runs, INCLUDING the status filter under test;
 *   - the real `protectedProcedure` runs, so the session must genuinely be valid;
 *   - the real superjson encoding, batching link and React Query run;
 *   - the real workspace layout derives `isMember` from the real filtered array.
 *
 * The portal already points here: `.env` sets BACKEND_URL="http://localhost:8080".
 * Nothing is reconfigured and no production code is touched to make this work.
 *
 * ── AND WHAT IS NOT VERIFIED BY IT ──
 *
 * The SERVICES' own behaviour. This answers the shapes the routers parse; it is not
 * evidence about what the team service really returns, and it applies no authorization.
 * Every assertion built on it is about the PORTAL — the router plus the page — and says so.
 *
 * ── ONE PORT, SO ONE WORKER ──
 *
 * :8080 can be bound once. Playwright runs different FILES in different workers, so every
 * spec using this must live in ONE file, and that file must not be split. `listen()` here
 * fails loudly on EADDRINUSE rather than silently sharing state with something else — a
 * stub quietly answering another process's requests is a cross-test contamination bug that
 * would read as flakiness.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

/** The port `.env` points BACKEND_URL at. Not configurable — it is a fact. */
export const GATEWAY_PORT = 8080;

/**
 * One membership row AS THE TEAM SERVICE EMITS IT — i.e. BEFORE the router's mapper.
 *
 * `status` is OPTIONAL and that is the whole point of this type. `GET /v1/teams/:id/members`
 * returns INACTIVE rows deliberately (team.ts:55), and rows written before the field existed
 * carry NO attribute at all. Absent means ACTIVE. A fixture type that made `status` required
 * would make the legacy case — the dangerous direction, where `status === "ACTIVE"` empties
 * every legacy roster — unrepresentable, and therefore untestable.
 */
export interface ServiceMemberRow {
  userId: string;
  role: string;
  user?: { id: string; name?: string; email?: string };
  /** Absent, "ACTIVE", "INACTIVE", "inactive", " INACTIVE " — all are real inputs. */
  status?: string;
}

/** One former-member row as `GET /v1/teams/:id/former-members` emits it. */
export interface ServiceFormerMemberRow {
  userId: string;
  name: string | null;
  email: string | null;
  removedAt: string;
  removedByName: string | null;
  removedByRole: string;
  reason: string | null;
  joinedAt: string | null;
}

/**
 * The mutable state one test configures. Read on every request, so a test can change the
 * roster mid-run and the next refetch genuinely sees the new value — which is what makes an
 * invalidate-then-refetch cycle observable rather than assumed.
 */
export interface GatewayState {
  teamId: string;
  teamName: string;
  workshopId: string;
  workshopName: string;
  inviteCode: string;
  /** The roster, PRE-FILTER. The router's exclusion is what this harness measures. */
  members: ServiceMemberRow[];
  formerMembers: ServiceFormerMemberRow[];
  formerMembersTruncated: boolean;
  /** Set to make `/former-members` fail, for the "history could not be loaded" path. */
  formerMembersStatus: number | null;
  me: { id: string; email: string; name: string; role: string };
  /** Every path this stub was asked for, in order. Proves what the router actually called. */
  requests: string[];
}

export interface GatewayHandle {
  state: GatewayState;
  /** Requests for one path substring — the assertion surface for "the router asked". */
  countOf(pathFragment: string): number;
  close(): Promise<void>;
}

/**
 * ONE STUB PER WORKER PROCESS, reused across `beforeAll` calls.
 *
 * ── WHY A SINGLETON, AND THE FLAKE THAT FORCED IT ──
 *
 * The first version bound a fresh server per `beforeAll` and closed it in `afterAll`. That
 * passed a single run and FAILED under `--repeat-each=10`, with 8 passed and 63 "did not run":
 *
 *     Error: e2e gateway stub could not bind :8080 — something is already listening.
 *
 * `--repeat-each` re-runs the describe's hooks per repetition, and `server.close()` does not
 * release the listening socket synchronously — so repetition N+1's bind raced repetition N's
 * teardown. That is a latent flake in the HARNESS, and it presented exactly as a product
 * failure would, which is why it is fixed rather than retried around.
 *
 * The guard below did its job: it refused loudly instead of letting the router talk to an
 * unknown backend, so the failure was legible in one line. Keeping that guard for the case it
 * is actually for (a real gateway on :8080) while removing the self-collision is the fix.
 */
let singleton: { handle: GatewayHandle; server: http.Server } | null = null;

/**
 * Start the stub, or hand back this worker's existing one with its state reset.
 *
 * Refuses rather than degrades: if :8080 is held by something that is NOT this worker's own
 * stub (a real gateway, another worker) this throws with the reason. A stub that silently
 * failed to bind would leave the router talking to something else entirely, and the resulting
 * assertions would be about an unknown backend — worse than no test.
 */
export async function startGateway(initial: Partial<GatewayState> = {}): Promise<GatewayHandle> {
  // Reuse rather than re-bind. The state is fully reset, so a reused stub is indistinguishable
  // from a fresh one to the test that receives it — which is the property that matters.
  if (singleton) {
    Object.assign(singleton.handle.state, {
      members: [],
      formerMembers: [],
      formerMembersTruncated: false,
      formerMembersStatus: null,
      ...initial,
    });
    singleton.handle.state.requests.length = 0;
    return singleton.handle;
  }
  return bindGateway(initial);
}

async function bindGateway(initial: Partial<GatewayState>): Promise<GatewayHandle> {
  const state: GatewayState = {
    teamId: "team-e2e-0001",
    teamName: "Team Peregrine",
    workshopId: "wksp-e2e-0001",
    workshopName: "E2E Accelerator",
    inviteCode: "E2ECODE1",
    members: [],
    formerMembers: [],
    formerMembersTruncated: false,
    formerMembersStatus: null,
    me: {
      id: "sub-admin-0001",
      email: "e2e-admin@example.test",
      name: "Ada Admin",
      role: "ADMIN",
    },
    requests: [],
    ...initial,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    state.requests.push(path);

    const json = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        // Belt and braces against any layer deciding a GET is cacheable: every request
        // must reach this stub, or a refetch would silently replay a stale roster and a
        // spec would assert on a frame that never came from the code under test.
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(payload);
    };

    // ── the routes team.getById makes (three, in parallel) ──
    if (path === `/v1/workshops/${state.workshopId}/teams`) {
      return json(200, {
        teams: [
          {
            id: state.teamId,
            name: state.teamName,
            inviteCode: state.inviteCode,
            workshopId: state.workshopId,
          },
        ],
      });
    }
    if (path === `/v1/workshops/${state.workshopId}`) {
      return json(200, { workshop: { id: state.workshopId, name: state.workshopName } });
    }
    if (path === `/v1/teams/${state.teamId}/members`) {
      // PRE-FILTER, deliberately — INACTIVE rows included, exactly as the real route does
      // (team.ts:55: "returns INACTIVE rows DELIBERATELY"). The router's exclusion is the
      // thing under test, so this must not pre-empt it.
      return json(200, { members: state.members });
    }

    // ── former members ──
    if (path === `/v1/teams/${state.teamId}/former-members`) {
      if (state.formerMembersStatus) {
        return json(state.formerMembersStatus, {
          error: "The removal history could not be read",
          code: "AUDIT_UNAVAILABLE",
        });
      }
      return json(200, {
        formerMembers: state.formerMembers,
        truncated: state.formerMembersTruncated,
      });
    }

    // ── invitations, and the two provenance hops withInviters makes ──
    if (path === `/v1/teams/${state.teamId}/invitations`) {
      return json(200, { invitations: [] });
    }
    if (path === "/v1/directory/invited-by") return json(200, { invitedBy: {} });
    if (path === "/v1/admin/user-names") return json(200, { names: {} });

    // ── ProfileMenu's auth.me, on every authenticated screen ──
    if (path === "/v1/auth/me") {
      return json(200, {
        ...state.me,
        firstName: state.me.name.split(" ")[0],
        lastName: state.me.name.split(" ").slice(1).join(" "),
        organization: "Example Corp",
        profileComplete: true,
      });
    }

    // NAMED, never a bare 404. An unhandled route must tell the reader which one it was:
    // a silent 404 surfaces as "Team not found" on screen and sends them hunting a defect
    // in the page instead of adding six lines here.
    return json(501, {
      error: `e2e gateway stub: no handler for ${req.method} ${path}. Add one in tests/e2e/fixtures/gateway.ts.`,
      code: "E2E_NO_STUB_HANDLER",
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `e2e gateway stub could not bind :${GATEWAY_PORT} — something is already listening. ` +
              `Stop it first (a real gateway — its runner lives in the services repo, not in this ` +
              `repo; or a stale stub: ` +
              `lsof -nP -iTCP:${GATEWAY_PORT} -sTCP:LISTEN). Refusing to run rather than let the ` +
              `router talk to an unknown backend.`
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(GATEWAY_PORT, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  if (address.port !== GATEWAY_PORT) {
    throw new Error(`e2e gateway stub bound :${address.port}, expected :${GATEWAY_PORT}`);
  }

  const handle: GatewayHandle = {
    state,
    countOf: (fragment: string) => state.requests.filter((p) => p.includes(fragment)).length,
    /**
     * A NO-OP BY DESIGN, and that is the deliberate half of the singleton fix.
     *
     * `afterAll` calls this, and under `--repeat-each` that runs between repetitions — so
     * actually closing here is what produced the EADDRINUSE flake (see the note on `singleton`).
     * The socket is released when the worker process exits, which is the correct lifetime for a
     * per-worker fixture: nothing outlives the run.
     *
     * `shutdown()` below is the real close, for a caller that genuinely needs the port back.
     */
    close: async () => {},
  };

  singleton = { handle, server };
  return handle;
}

/**
 * Actually release :8080. Not called by the specs — see `close` above on why they must not.
 * Here so a future harness that needs the port back inside one worker has an honest way to do
 * it, rather than being tempted to make `close()` real again and reintroduce the flake.
 */
export async function shutdownGateway(): Promise<void> {
  const current = singleton;
  if (!current) return;
  singleton = null;
  await new Promise<void>((resolve) => {
    current.server.closeAllConnections?.();
    current.server.close(() => resolve());
  });
}
