import type { TeamAccess, TeamWorkshop, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
  requireIdentity,
} from "@praimana/service-shared";

/**
 * HTTP-backed TeamAccess — asks the Team service whether a user may read/write a
 * team. This is a cross-service call, but it reads the Team service's DATA through
 * the Team service's OWN API (its `/teams/:id/access` endpoint) rather than
 * reaching into its teams/teamMembers tables. That's the difference between
 * microservices and a distributed monolith.
 *
 * It RE-PRESENTS THE CALLER'S OWN BEARER TOKEN (forwardedIdentityHeaders) so the
 * Team service re-derives the identity from verified claims and authorizes as the
 * SAME user. That is not a stylistic choice: TEAM_SERVICE_URL points at the PUBLIC
 * HTTP API, whose routes all sit behind the Cognito JWT authorizer, so a tokenless
 * "trusted internal hop" is 401'd by the gateway before the Team Lambda ever runs —
 * and this class reads a non-2xx as "denied", which silently made every
 * cross-service decision false. See forwardedIdentityHeaders for the full note.
 *
 * The role still travels for the write decision (it is only a hint — the callee
 * derives the authoritative role from the token's cognito:groups). Results should
 * be short-TTL cached in production to keep this off the hot path (or replaced with
 * an event-fed read-model — see authz.ts).
 *
 * BOUNDED IN TIME as well as in outcome (EAST_WEST_TIMEOUT_MS). Fail-closed alone is
 * not enough: a Team service answering slowly but successfully would pin this Lambda
 * for the full 29s gateway timeout per waiter, and every route that needs a team
 * decision would fill concurrency waiting on it. The timeout does not change the
 * MEANING of a failure here — an abort rejects the fetch, which the catch below
 * already reads as "denied" — it only bounds the wait.
 *
 * ── FOUR FIELDS, AND ABSENT MEANS DENIED ──
 *
 * `canReadContent`/`canWriteContent` are the MEMBER-ONLY pair; `canRead`/`canWrite` keep
 * their existing administration meaning. `!!data.canReadContent` on an OLDER Team service
 * that does not send the field yields false — a denial. That is the right direction and it
 * is why the DEPLOY ORDER IS TEAM FIRST, THEN THIS SERVICE: shipping this consumer ahead of
 * Team would 403 every legitimate member on every content surface until Team caught up.
 */
export class HttpTeamAccess implements TeamAccess {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  private async fetchAccess(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<TeamAccessFlags> {
    // No Context ⇒ no caller token to re-present. The gateway would 401 the call,
    // and silently returning "denied" is what previously made every cross-service
    // authz decision false. Fail loudly-but-closed instead of pretending.
    if (!auth) return DENY_ALL;
    try {
      const res = await fetch(
        `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/access`,
        {
          headers: forwardedIdentityHeaders(auth, { id: userId, role }),
          // An abort rejects the fetch, so it lands in the same catch as a connect
          // error and reads as "denied" — identical semantics, bounded wait.
          signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
        }
      );
      if (!res.ok) return DENY_ALL;
      const data = (await res.json()) as Partial<Record<keyof TeamAccessFlags, unknown>>;
      return {
        canRead: !!data.canRead,
        canWrite: !!data.canWrite,
        canReadContent: !!data.canReadContent,
        canWriteContent: !!data.canWriteContent,
      };
    } catch {
      return DENY_ALL;
    }
  }

  async canRead(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean> {
    return (await this.fetchAccess(teamId, userId, role, auth)).canRead;
  }

  async canWrite(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean> {
    return (await this.fetchAccess(teamId, userId, role, auth)).canWrite;
  }

  async canReadContent(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean> {
    return (await this.fetchAccess(teamId, userId, role, auth)).canReadContent;
  }

  async canWriteContent(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean> {
    return (await this.fetchAccess(teamId, userId, role, auth)).canWriteContent;
  }
}

/** The four booleans GET /teams/:teamId/access answers with. */
interface TeamAccessFlags {
  canRead: boolean;
  canWrite: boolean;
  canReadContent: boolean;
  canWriteContent: boolean;
}

/**
 * The single denial value every failure path returns.
 *
 * One frozen constant rather than four inline literals: it is the fail-closed answer, and a
 * fifth field added to TeamAccessFlags without adding it here would be a compile error
 * instead of a field that silently defaults to `undefined` — i.e. to whatever `!!` makes of
 * it at the far end. Frozen and shared safely because it is never mutated: the success path
 * builds a fresh object.
 */
const DENY_ALL: Readonly<TeamAccessFlags> = Object.freeze({
  canRead: false,
  canWrite: false,
  canReadContent: false,
  canWriteContent: false,
});

/**
 * WHICH EXPERIENCE A TEAM BELONGS TO — through Team's `GET /teams/:teamId/access?withWorkshop=1`.
 *
 * ⚠ THE SAME ROUTE THE ACCESS CLIENT ABOVE ALREADY CALLS, with one query parameter added. No new
 * Team endpoint: every route is wired in an API Gateway template that does not live in this repo, so
 * a client written against a route that already exists is deployable on its own, while a new callee
 * route is not verifiable from here and would ship broken. Team built `withWorkshop=1` for exactly
 * this shape of question — the evaluation service's `writeScope` uses it to learn a submission's
 * scope from the same hop that decides the write.
 *
 * ⚠ THREE OUTCOMES, AND THE THIRD IS THE ONE FAIL-CLOSED BOOLEANS CANNOT EXPRESS. `HttpTeamAccess`
 * above collapses every failure to `false`, which is right for "may you?" and wrong here: `null` has
 * to mean "this team genuinely has no experience", so a failed hop must NOT borrow it. The caller
 * refuses a save on `null` and answers 503 on `"unavailable"`.
 *
 * ⚠ THE `in` CHECK IS LOAD-BEARING. `withWorkshop=1` is opt-in at the callee, so a Team older than
 * that parameter answers 200 with no `workshopId` key at all — and `?? null` would read that as
 * "this team has no experience" and refuse every phase save until Team caught up. An ABSENT key is
 * "we could not find out"; a `null` VALUE is a determined answer. Same distinction, same reasoning
 * and same one operator as evaluation's `writeScope`.
 */
export class HttpTeamWorkshop implements TeamWorkshop {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  async workshopIdOf(
    teamId: string,
    auth?: AuthContext
  ): Promise<string | null | "unavailable"> {
    // No Context ⇒ no caller token to re-present, and the gateway would 401 the call. Not `null`:
    // that would claim the team has no experience, which is a fact we have not established.
    if (!auth) {
      console.warn("[team-workshop] workshopIdOf: no request context to forward");
      return "unavailable";
    }

    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/access?withWorkshop=1`,
        {
          headers: forwardedIdentityHeaders(auth, requireIdentity(auth)),
          // Bounded for the same reason as the access client: a callee answering slowly but
          // successfully would pin this Lambda for the full gateway timeout per waiter.
          signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
        }
      );
    } catch (err) {
      console.warn("[team-workshop] hop FAILED — undetermined, not an absence", {
        teamId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return "unavailable";
    }

    /**
     * ⚠ EVERY NON-2xx IS "unavailable", 403 INCLUDED. This is called only after the route's guard
     * established the caller is a member of the team, so a 403 means the two services DISAGREE about
     * membership — a fault, not a statement about which experience the team is in.
     */
    if (!res.ok) {
      console.warn("[team-workshop] hop non-OK — undetermined, not an absence", {
        teamId,
        status: res.status,
      });
      return "unavailable";
    }

    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      return "unavailable";
    }

    if (!("workshopId" in data)) return "unavailable";
    const workshopId = data.workshopId;
    if (typeof workshopId === "string" && workshopId) return workshopId;
    // A determined `null` (or any other shape the callee sends for "none").
    return null;
  }
}
