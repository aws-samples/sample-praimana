import type { WorkshopMembership, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
} from "@praimana/service-shared";

/**
 * HTTP-backed WorkshopMembership — asks the Team service "is this caller a member of
 * any team in this workshop?", the branch that lets a PARTICIPANT or EXECUTIVE read
 * the workshop they are actually building in.
 *
 * The question is Team's to answer: it owns teamMembers, and it owns teams (whose
 * partition key IS workshopId), so it can settle this with two single-partition
 * Queries and no hop of its own. We read that answer through Team's own API
 * (GET /v1/workshops/:workshopId/membership) rather than reaching into its tables —
 * the same boundary rule as HttpTeamAccess beside this file.
 *
 * WHY IT ASKS FOR A WORKSHOP AND NOT A LIST OF TEAMS — the obvious alternative is to
 * fetch the workshop's teams and check each one, but this service does not own teams
 * and must not enumerate them; and doing it per-team would turn one round trip into a
 * fan-out that grows with workshop size on a page-render path. One question, one
 * answer, bounded.
 *
 * NO userId PARAMETER, deliberately. The callee keys the answer on the token's
 * verified subject, so this client cannot ask about anybody else even if a future
 * caller wanted it to — which is what stops the route being an enumeration oracle for
 * "who is in which workshop". `userId` is passed only to
 * forwardedIdentityHeaders, for the internal-hop fallback, and is never a query param.
 *
 * THREE-VALUED, and this is the whole reason the class exists rather than reusing the
 * boolean shape of HttpTeamAccess:
 *
 *   - an explicit `{ isMember: true }`            → true
 *   - an explicit `{ isMember: false }`, or a 403 → false   (Team answered: no)
 *   - timeout, 5xx, unreachable, non-JSON, 200
 *     with an unrecognised shape                  → "unavailable"  (Team did not answer)
 *
 * Collapsing the third case into `false` is exactly the mistake this avoids: it would
 * turn a brownout into "you don't have access", a 403 that lies to the user and sends
 * them to support instead of showing a retry. Both outcomes deny the read — this is
 * still fail-closed — but only one of them is honest about why. The guard in authz.ts
 * maps "unavailable" to 503 + Retry-After.
 *
 * A 404 is treated as `false` rather than "unavailable": the callee returns a body for
 * every workshop id, including unknown ones, so a 404 means the route is not there —
 * a definite "this deployment cannot tell you yes". A 401/403 likewise means the
 * request was understood and refused.
 *
 * BOUNDED IN TIME (EAST_WEST_TIMEOUT_MS) for the same reason as every other east-west
 * client here: a Team service answering in 30s with zero errors would otherwise hold
 * one Workshop Lambda per waiter for the full 29s gateway timeout, and workshop reads
 * are a page-render path.
 */
export class HttpWorkshopMembership implements WorkshopMembership {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  async isMember(
    workshopId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean | "unavailable"> {
    // No workshop id is a definite no, not a failure — there is nothing to ask about.
    if (!workshopId) return false;

    // No Context ⇒ no caller token to re-present, and TEAM_SERVICE_URL is the public
    // API where every route sits behind the Cognito JWT authorizer, so the call could
    // only ever 401. "unavailable" rather than false: we genuinely cannot find out,
    // and a 503 is the honest answer to a misconfigured hop — reporting `false` would
    // silently 403 every participant and look like a permissions problem.
    if (!auth) return "unavailable";

    try {
      const res = await fetch(
        `${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}/membership`,
        {
          headers: forwardedIdentityHeaders(auth, { id: userId, role }),
          signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
        }
      );

      // Understood and refused, or the route isn't there — a definite "not yes".
      if (res.status === 401 || res.status === 403 || res.status === 404) return false;
      // Anything else non-2xx (5xx, a gateway error page, a throttle) is unknown.
      if (!res.ok) return "unavailable";

      const data = (await res.json()) as { isMember?: unknown };
      // Only a real boolean counts. A 200 with an unexpected shape — an error
      // envelope, a proxy's HTML — is "we did not get an answer", never a grant and
      // never a denial we would report as one.
      if (typeof data.isMember !== "boolean") return "unavailable";
      return data.isMember;
    } catch {
      // Timeout (AbortSignal), connect error, or a body that would not parse.
      return "unavailable";
    }
  }
}
