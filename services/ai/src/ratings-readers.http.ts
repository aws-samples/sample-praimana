import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
} from "@praimana/service-shared";
import type { AuthContext } from "./authz.js";
import type {
  RatingCounters,
  TeamChatReader,
  TeamCountersReader,
  TeamWorkshopLookup,
} from "./domain.js";

/**
 * The three east-west reads the ratings routes depend on: team chat (collaboration), activity
 * counters (evaluation), and the team's workshop id (team).
 *
 * ── EVERY ONE OF THEM IS THREE-VALUED, AND THAT IS THE POINT ──
 *
 * `HttpTeamAccess` in this same service reads any failure as "denied", which is correct for an
 * authorization probe: fail closed. These are NOT authorization probes. They are the INPUTS to
 * a model-written statement about named people, so the failure mode is inverted — reading a
 * timeout as an empty list would not deny anyone anything, it would generate a confident
 * assessment of a team whose activity we never managed to read, store it, and offer it for
 * publication to a judge.
 *
 * So each returns `"unavailable"`, distinct from `[]`, and the route turns that into a 503
 * rather than proceeding. "We could not ask" and "there is nothing" are different facts and
 * the type keeps them different; a bare `[]` return would let one silently become the other.
 *
 * ── WHY THE CALLER'S OWN TOKEN, RE-PRESENTED ──
 *
 * Both upstream routes are MEMBER-ONLY (`requireTeamContentRead`). That is
 * exactly the gate we want: `analyze` is member-write, so the only caller who can reach these
 * reads is already a member, and the upstream service re-derives that from verified claims
 * rather than trusting us. No service-principal escalation exists here, which means a bug in
 * this file cannot read a team the caller could not read directly.
 *
 * ── BOUNDED IN TIME AND IN SIZE ──
 *
 * Each fetch carries RATINGS_READ_TIMEOUT_MS; an abort rejects and lands in the same catch as a
 * connect error, so the semantics are identical and only the wait is bounded. The chat read
 * also passes an explicit `limit`, and the route caps again on the way into the prompt — the
 * far end deciding to return 10,000 rows must not become this Lambda's memory problem.
 */

/**
 * ── WHY THIS IS NOT `EAST_WEST_TIMEOUT_MS`, AND THE OUTAGE THAT PROVED IT ──
 *
 * These reads are NESTED east-west calls. `GET /teams/:teamId/ratings` on the evaluation service
 * and `GET /teams/:teamId/messages` on collaboration are both member-gated, so each one makes
 * its OWN authz hop back into the team service before it answers. Giving the outer call the same
 * 2,500ms budget as the inner one means the inner hop can consume the entire outer budget, and
 * on a cold start it does:
 *
 *   evaluation fn, measured:       1,721ms duration + 378ms init ≈ 2.1s
 *   our budget for the whole read: 2,500ms
 *   observed:  "[ratings] team counters FAILED … elapsedMs: 2503, timedOut: true"
 *
 * So `analyze` answered 503 TEAM_ACTIVITY_UNAVAILABLE for a team whose counters were sitting
 * right there — the read was refused by our own clock, not by anything upstream.
 *
 * A NESTED CALL NEEDS A LARGER BUDGET THAN THE CALL IT CONTAINS. This is the outer budget, so it
 * is the inner one plus room for the callee's own work and a cold start.
 *
 * ⚠ IT IS STILL BOUNDED, and deliberately well under the AI function's 60s timeout and under
 * RATING_TOTAL_TIMEOUT_MS (45s) in routes.ts — a slow dependency must be OUR abort with a
 * 503 the caller can retry, never the platform killing the function with an opaque 502.
 *
 * These are also on the ANALYZE path only, which is a deliberate button press behind a
 * ten-minute cooldown, not a hot read. Waiting 8s once beats refusing a generation that would
 * have worked.
 */
export const RATINGS_READ_TIMEOUT_MS = Math.max(EAST_WEST_TIMEOUT_MS * 3, 8_000);

/** Read once at module load; a per-call `process.env` read in a hot path buys nothing. */
const COLLABORATION_URL =
  process.env.COLLABORATION_SERVICE_URL || "http://localhost:4000/v1";
const EVALUATION_URL =
  process.env.EVALUATION_SERVICE_URL || "http://localhost:4000/v1";
const TEAM_URL = process.env.TEAM_SERVICE_URL || "http://localhost:4000/v1";

/**
 * One fetch, one shape check, one three-valued answer.
 *
 * Shared by all three readers so the failure table cannot drift between them — the defect the
 * duplicated entitlements clients in evaluation/workshop explicitly warn about. A 200 carrying
 * an unrecognised body (an error envelope, a gateway's HTML) is "unavailable", NOT a
 * determined empty result: that distinction is the whole reason this helper exists.
 */
async function readJson(
  what: string,
  url: string,
  auth: AuthContext | undefined,
  role: string
): Promise<Record<string, unknown> | "unavailable"> {
  if (!auth) {
    console.warn(`[ratings] ${what}: no request context to forward`);
    return "unavailable";
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: forwardedIdentityHeaders(auth, { id: "", role }),
      signal: AbortSignal.timeout(RATINGS_READ_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[ratings] ${what} FAILED — undetermined, not empty`, {  // nosemgrep: unsafe-formatstring
      elapsedMs: Date.now() - started,
      timeoutMs: RATINGS_READ_TIMEOUT_MS,
      timedOut: err instanceof Error && err.name === "TimeoutError",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return "unavailable";
  }

  if (!res.ok) {
    console.warn(`[ratings] ${what} non-OK — undetermined, not empty`, {  // nosemgrep: unsafe-formatstring
      status: res.status,
      elapsedMs: Date.now() - started,
      url,
    });
    return "unavailable";
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") {
    console.warn(`[ratings] ${what} returned an unrecognised body`, {  // nosemgrep: unsafe-formatstring
      elapsedMs: Date.now() - started,
    });
    return "unavailable";
  }
  return data;
}

/** Chat messages, from the collaboration context that owns them. */
export class HttpTeamChatReader implements TeamChatReader {
  constructor(private readonly baseUrl = COLLABORATION_URL) {}

  async recentByTeam(
    teamId: string,
    limit: number,
    auth?: unknown
  ): Promise<Array<{ userId: string; content: string }> | "unavailable"> {
    const data = await readJson(
      "team chat",
      // `limit` travels so the far end bounds its own Query rather than this client
      // discarding rows it already paid to receive.
      `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/messages?limit=${limit}`,
      auth as AuthContext | undefined,
      "PARTICIPANT"
    );
    if (data === "unavailable") return "unavailable";
    if (!Array.isArray(data.messages)) return "unavailable";

    // Rows are FILTERED, not defaulted. A message with no sender cannot be attributed, and
    // attaching it to `""` would credit an anonymous bucket that renders as a phantom member.
    return (data.messages as unknown[]).flatMap((m) => {
      const row = (m ?? {}) as Record<string, unknown>;
      const userId = typeof row.userId === "string" ? row.userId : "";
      const content = typeof row.content === "string" ? row.content : "";
      return userId && content ? [{ userId, content }] : [];
    });
  }
}

/** Activity counters, from the evaluation context that owns them. */
export class HttpTeamCountersReader implements TeamCountersReader {
  constructor(private readonly baseUrl = EVALUATION_URL) {}

  async byTeam(
    teamId: string,
    auth?: unknown
  ): Promise<Array<{ userId: string } & RatingCounters> | "unavailable"> {
    const data = await readJson(
      "team counters",
      `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/ratings`,
      auth as AuthContext | undefined,
      "PARTICIPANT"
    );
    if (data === "unavailable") return "unavailable";
    if (!Array.isArray(data.contributions)) return "unavailable";

    // `contributionScore` and `name` are deliberately DROPPED. The name must never reach a
    // prompt (the summary is publishable, and a model cannot name someone it never saw), and
    // the score is evaluation's own weighting — re-deriving a rating from another service's
    // rating would couple two formulas that are free to change independently.
    return (data.contributions as unknown[]).flatMap((c) => {
      const row = (c ?? {}) as Record<string, unknown>;
      const userId = typeof row.userId === "string" ? row.userId : "";
      if (!userId) return [];
      return [
        {
          userId,
          tasksCreated: count(row.tasksCreated),
          tasksCompleted: count(row.tasksCompleted),
          messagesSent: count(row.messagesSent),
          commitsPushed: count(row.commitsPushed),
          aiThreadsShared: count(row.aiThreadsShared),
          // `count()` maps null/absent to 0 — deliberate here, because these values go into a
          // prompt and a model given `null` writes about "null". The fact that a row was never
          // measured is carried in the snapshot's `coverage[]` instead, where a human reads it.
          aiTurns: count(row.aiTurns),
        },
      ];
    });
  }
}

/**
 * The team's workshop id — the value that gates judge access to a published summary.
 *
 * Piggybacks on `GET /teams/:teamId/access?withWorkshop=1`, the route the Team service already
 * exposes for exactly this, rather than adding an endpoint. It is one bounded local Query
 * there, and it answers only for a caller who may read the team.
 *
 * TWO-VALUED, not three, and that asymmetry is deliberate: `null` means "no workshop", and a
 * FAILED lookup also yields `null`. A team with no workshop is a real state 
 * and the consequence of a null here is that no judge can read the summary —
 * the safe direction. Compare the counters above, where the same collapse would fabricate an
 * assessment. Same technique, opposite failure mode, so opposite choice.
 */
export class HttpTeamWorkshopLookup implements TeamWorkshopLookup {
  constructor(private readonly baseUrl = TEAM_URL) {}

  async workshopIdForTeam(teamId: string, auth?: unknown): Promise<string | null> {
    const data = await readJson(
      "team workshop lookup",
      `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/access?withWorkshop=1`,
      auth as AuthContext | undefined,
      "PARTICIPANT"
    );
    if (data === "unavailable") return null;
    return typeof data.workshopId === "string" && data.workshopId
      ? data.workshopId
      : null;
  }
}

/**
 * A counter, or zero — never NaN and never negative.
 *
 * `Number(undefined)` is NaN, which serialises to `null` in JSON and would reach the prompt as
 * a missing field; a negative would let a corrupt row drag a team's totals down.
 */
function count(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
