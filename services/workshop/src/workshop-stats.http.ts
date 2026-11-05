import type { WorkshopStats } from "./domain.js";
import type { Context } from "hono";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
  requireIdentity,
} from "@praimana/service-shared";

/**
 * HTTP-backed WorkshopStats — asks the Team service how many teams a workshop has.
 *
 * ── WHY THIS EXISTS ──
 *
 * `ZeroWorkshopStats` was wired in app.ts and returned 0 for EVERY workshop, so the
 * experiences list showed "0 teams" next to workshops that plainly had teams. It was an
 * honest placeholder — the comment says "use this until a real Team-service client is
 * wired" — and this is that client. The teams table belongs to the Team service (its
 * partition key IS workshopId), so this ASKS rather than reading a foreign table, the same
 * boundary rule as HttpTeamAccess and HttpWorkshopMembership beside it.
 *
 * ── THE SUBTLETY THAT MAKES THIS MORE THAN A FETCH ──
 *
 * `GET /v1/workshops/:workshopId/teams` FILTERS BY CALLER: an ADMIN or the owning
 * facilitator sees every team, while a PARTICIPANT sees only the teams they belong to
 * (team/src/routes.ts:1352-1374). So counting that response verbatim would tell a
 * participant their workshop has "1 team" — a number that is not wrong about them but is
 * wrong about the workshop, and worse than 0 because it looks plausible.
 *
 * So this asks for `?count=1`, which makes the callee report the WORKSHOP-WIDE total
 * alongside the (still filtered) list. That is safe to widen where the list is not: a
 * count is an aggregate — "this experience has 2 teams" — while the list is a roster
 * naming who is where. An EXECUTIVE is entitled to the experience and needs the former to
 * read the page; they are still refused the latter.
 *
 * If the callee does not report a total, the answer is UNKNOWN and the route omits the
 * field. Falling back to `teams.length` would silently restore the per-caller figure, which
 * is the wrong number wearing the right shape.
 *
 * ── FAILURE IS ABSENT, NOT ZERO ──
 *
 * Every failure path — timeout, 5xx, unreachable, non-JSON, unexpected shape — yields
 * `undefined` for that workshop, never 0. This is a display statistic on a list page: a
 * brownout must not silently redraw a healthy workshop as empty, which is precisely the
 * failure mode the placeholder had.
 */
export class HttpWorkshopStats implements WorkshopStats {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  /**
   * Counts keyed by workshopId. A workshop is ABSENT from the result when its count could
   * not be established, so `?? 0` at a call site would be reintroducing the original bug —
   * the routes spread the value only when present.
   *
   * Bounded fan-out: one request per workshop, capped, and all in flight together rather
   * than serially. The list page shows a page of workshops, not thousands, and the cap is
   * what keeps a large account from turning one page render into an unbounded burst
   * against the Team service.
   */
  async teamCounts(
    workshopIds: string[],
    c?: Context
  ): Promise<Record<string, number>> {
    // No Context ⇒ no caller identity to forward, and this route requires one. Returning
    // an empty map means "unknown for all", which the caller renders as "—".
    if (!c || workshopIds.length === 0) return {};

    const identity = requireIdentity(c);
    const headers = forwardedIdentityHeaders(c, identity);
    const ids = workshopIds.slice(0, MAX_COUNT_FANOUT);

    const results = await Promise.all(
      ids.map(async (workshopId) => {
        try {
          const res = await fetch(
            `${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}/teams?count=1`,
            { headers, signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS) }
          );
          if (!res.ok) return null;
          const data = (await res.json()) as { teamCount?: unknown; teams?: unknown };
          // Prefer the WORKSHOP-WIDE total the callee reports for `?count=1`. Falling back
          // to `teams.length` would silently reintroduce the per-caller figure for any
          // callee that ignores the flag, so an unrecognised shape is UNKNOWN instead.
          if (typeof data.teamCount === "number" && Number.isFinite(data.teamCount)) {
            return [workshopId, data.teamCount] as const;
          }
          return null;
        } catch {
          return null;
        }
      })
    );

    return Object.fromEntries(results.filter((r): r is [string, number] => r !== null));
  }
}

/**
 * Ceiling on the per-render fan-out.
 *
 * The experiences list is paged in practice, so 50 covers a real page with headroom.
 * Beyond it the remaining workshops report no count rather than issuing an unbounded burst
 * of east-west calls to render a subtitle — the page still works, it just says "—".
 */
const MAX_COUNT_FANOUT = 50;
