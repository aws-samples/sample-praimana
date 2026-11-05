import type { TeamAccess, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
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
 * is why the DEPLOY ORDER IS TEAM FIRST, THEN THIS SERVICE: shipping this consumer ahead
 * of Team would 403 every legitimate member's board and chat until Team caught up.
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
 * One frozen constant rather than four inline literals: it is the fail-closed answer, and
 * a fifth field added to TeamAccessFlags without adding it here would be a compile error
 * instead of a field that silently defaults to `undefined` — i.e. to whatever `!!` makes
 * of it at the far end. Frozen and shared safely because it is never mutated: the success
 * path builds a fresh object.
 */
const DENY_ALL: Readonly<TeamAccessFlags> = Object.freeze({
  canRead: false,
  canWrite: false,
  canReadContent: false,
  canWriteContent: false,
});
