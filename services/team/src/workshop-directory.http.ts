import type { AuthContext, WorkshopDirectory, WorkshopRef } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
} from "@praimana/service-shared";

/**
 * Cap on the WORKSHOP-NAME fan-out `resolveWorkshopNames` will make in one call.
 *
 * ⚠ THIS LIVED IN routes.ts AS `MAX_DIRECTORY_WORKSHOP_NAMES` AND BELONGS HERE NOW. It capped the
 * unscoped ADMIN directory's name probes, and the admin scoping removed that call site: an admin
 * restricted to the workshops they OWN gets every name back from `listOwnedWorkshops` in the same hop.
 * The constant was then unreferenced — a lint error — while the
 * `Promise.all` it used to bound was still sitting here with nothing bounding it. Deleting it outright
 * would have turned "bounded by the caller" into "bounded by nobody" for whoever calls this next, so
 * the number moved to the method that actually issues the requests.
 *
 * 25 because the probes go out in PARALLEL: the wall-clock cost is one EAST_WEST_TIMEOUT_MS whatever
 * the count, so what this bounds is the CONCURRENT load one page can put on the Workshop service. Each
 * DISTINCT workshop costs one `GET /v1/workshops/:id`, and the pathological page is 100 teams spread
 * across 100 workshops — 100 simultaneous hops out of a single request. Ids beyond the cap are simply
 * absent from the returned map, so their rows carry `workshopName: null`, which the frozen contract
 * already admits: a short name map is a display gap, never a missing team.
 */
const MAX_WORKSHOP_NAME_PROBES = 25;

/**
 * HTTP-backed WorkshopDirectory — the two Workshop-context reads the TEAMS DIRECTORY needs.
 *
 * The boundary rule is the same one HttpWorkshopAccess beside this file follows: workshops are
 * the Workshop service's data, so they are read through its API and never out of its table.
 * `Team.workshopId` is all this context stores, so both "which workshops does this facilitator
 * own?" (the directory's authorization scope) and "what are these workshops called?" (display)
 * have to be asked.
 *
 * The caller's own Bearer token is re-presented (forwardedIdentityHeaders) for the same reason
 * HttpWorkshopAccess does: WORKSHOP_SERVICE_URL points at the public HTTP API and every route
 * there sits behind the Cognito JWT authorizer, so a tokenless "trusted internal hop" is 401'd
 * by the gateway before the Workshop Lambda runs.
 *
 * ── NO RECURSION, AND IT IS CLOSED AT THE CALL SITE RATHER THAN HERE ──
 *
 * `GET /v1/workshops` branches on role: ADMIN and FACILITATOR are answered by `listByOwner`
 * with NO hop, while JUDGE/EXECUTIVE/PARTICIPANT are answered by calling BACK into Team for
 * `E(self)`. The directory route calls `listOwnedWorkshops` for BOTH owner roles —
 * ⚠ ADMIN INCLUDED, where it previously skipped the scope altogether — and
 * `canReadDirectory` 403s the other three before any hop, so the Team → Workshop → Team cycle
 * is still unreachable. Note what the argument now rests on: the CALLEE resolving both owner
 * roles locally, rather than one of them not making the call. If `listByOwner` ever stops
 * answering an ADMIN locally, this becomes a cycle.
 *
 * `GET /v1/workshops/:id` likewise resolves ADMIN and owner from its own row before any hop
 * (requireWorkshopRead step 1), which is what terminates `ownsWorkshop`/`ownsTeamWorkshop`.
 * These invariants are asserted in routes.test.ts, because they live in the ROUTE's role
 * branch and this class cannot enforce them.
 *
 * ⚠ `resolveWorkshopNames` NOW HAS NO CALLER — it existed for the unscoped ADMIN directory,
 * whose names could not come from an ownership scope it never resolved. Kept for the moment
 * because it and its tests are correct; see the note at its old call site in routes.ts.
 *
 * BOUNDED IN TIME (EAST_WEST_TIMEOUT_MS). An abort rejects the fetch and lands in the same
 * catch as a connect error — identical semantics, bounded wait.
 */
export class HttpWorkshopDirectory implements WorkshopDirectory {
  constructor(
    private readonly baseUrl = process.env.WORKSHOP_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  /**
   * The caller's OWNED workshops, or "unavailable".
   *
   * THREE-VALUED ON PURPOSE, and every non-2xx is undetermined. This is the FACILITATOR's
   * directory SCOPE, so "we could not ask" must never be returned as "you own nothing" — that
   * renders an empty teams directory that is indistinguishable from a correct one, which is
   * the exact defect the fail-closed rule was written to prevent. A 404 included: a rolling deploy where
   * this route is briefly unmapped is a transient state, not an answer.
   *
   * `[]` IS THEREFORE A LOAD-BEARING VALUE: it is the ONLY shape that means a determined "you
   * own no workshops". Which is why the all-rows-unreadable case at the bottom of this method
   * must NOT return it.
   */
  async listOwnedWorkshops(
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<WorkshopRef[] | "unavailable"> {
    // No Context ⇒ no caller token to re-present, and the gateway would reject the call.
    // "unavailable" rather than an empty list: we did not ask, so we do not know.
    if (!auth) {
      console.warn("[authz] owned-workshops: no request context to forward", { userId, role });
      return "unavailable";
    }

    const url = `${this.baseUrl}/workshops`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: forwardedIdentityHeaders(auth, { id: userId, role }),
        signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn("[authz] owned-workshops probe FAILED — undetermined, not empty", {
        userId,
        role,
        elapsedMs: Date.now() - started,
        timeoutMs: EAST_WEST_TIMEOUT_MS,
        timedOut: err instanceof Error && err.name === "TimeoutError",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return "unavailable";
    }

    if (!res.ok) {
      console.warn("[authz] owned-workshops probe non-OK — undetermined, not empty", {
        userId,
        role,
        status: res.status,
        elapsedMs: Date.now() - started,
        url,
      });
      return "unavailable";
    }

    const data = (await res.json().catch(() => null)) as { workshops?: unknown } | null;

    // Shape is PINNED rather than trusted. A 200 carrying an unrecognised body (an error
    // envelope, an HTML page from a misrouted gateway) must not read as a determined empty
    // scope — that is indistinguishable from "this facilitator owns nothing".
    if (!data || !Array.isArray(data.workshops)) {
      console.warn("[authz] owned-workshops probe returned an unrecognised body", {
        userId,
        role,
        elapsedMs: Date.now() - started,
      });
      return "unavailable";
    }

    // Rows without a usable id are DROPPED rather than making the whole scope undetermined:
    // the answer arrived and was well-shaped, and one malformed row is not a reason to 503 a
    // facilitator out of their own directory. A missing name renders as unknown.
    const rows = data.workshops as unknown[];
    const usable = rows
      .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
      .map((w) => ({
        id: typeof w.id === "string" ? w.id : "",
        name: typeof w.name === "string" ? w.name : "",
      }))
      .filter((w) => w.id !== "");

    // ── A NON-EMPTY ARRAY THAT YIELDS ZERO USABLE ROWS IS "UNAVAILABLE" ──────────────
    //
    // THE ONE PATH FROM 503-SEMANTICS BACK TO A PLAUSIBLE-BUT-EMPTY PAGE, and it is a schema
    // change rather than an outage: if the Workshop service renames `id`, every row above fails
    // validation, this method returns `[]`, and `[]` is the ONE value that legitimately means
    // "you own no workshops" — so the route answers 200 with an empty directory instead of the
    // 503 every other undetermined case gets. That is exactly the defect the fail-closed rule was written
    // to prevent, arriving through the one door left open. See condition 6.
    //
    // The DISTINCTION that keeps the ordinary case working: dropping SOME rows stays correct
    // (see above). Dropping ALL of them, when there were rows to drop, means we could not read
    // the answer — not that the answer was empty. A genuinely empty `workshops: []` never
    // reaches this branch, because there was nothing to drop.
    if (rows.length > 0 && usable.length === 0) {
      console.warn(
        "[authz] owned-workshops: EVERY row was unreadable — undetermined, not empty",
        {
          userId,
          role,
          // Counts only, never the rows: their shape is another service's response body and may
          // carry anything. `dropped` is what an operator alarms on — a schema drift shows up
          // here as a step change rather than as a silently empty directory.
          received: rows.length,
          dropped: rows.length,
          elapsedMs: Date.now() - started,
        }
      );
      return "unavailable";
    }

    if (usable.length < rows.length) {
      // NOT SILENT even in the benign case. A partial drop is how a schema change starts, and
      // this line is what turns "one facilitator says a workshop is missing" into a diagnosis.
      console.warn("[authz] owned-workshops: some rows were unreadable and were DROPPED", {
        userId,
        role,
        received: rows.length,
        dropped: rows.length - usable.length,
      });
    }

    return usable;
  }

  /**
   * Names for a known set of workshop ids — BEST-EFFORT, DISPLAY ONLY, and never throws.
   *
   * One `GET /v1/workshops/:id` per id. There is no batch route, and inventing one for a
   * display field would be a new enumeration surface on the Workshop service for a column.
   *
   * ⚠ THE FAN-OUT IS BOUNDED HERE, BY THIS METHOD, AND NO LONGER BY ITS CALLER. It read "bounded by
   * the CALLER (see MAX_DIRECTORY_WORKSHOP_NAMES in routes.ts) … a bound here would be a second number
   * for one rule", which held while the unscoped ADMIN directory called it and deduplicated first. That
   * caller is gone (see routes.ts), which left the `Promise.all` below issuing exactly as many
   * concurrent probes as it was handed — an unbounded east-west fan-out with nothing left to bound it,
   * and the one place the old comment pointed at for the number no longer existed.
   *
   * So the cap moved INTO the method, which is the only place that can still guarantee it. A caller may
   * now pass any list, including a duplicate-heavy one, without being the thing that keeps the Workshop
   * service standing up.
   *
   * An id that fails for ANY reason is absent from the map: a timeout, a 403, a 404 for a
   * deleted workshop, a malformed body. The row then carries `workshopName: null`, which the
   * frozen contract admits. Deliberately NOT distinguished from one another — the caller
   * cannot act on the difference, and an absent name must never be read as an access signal.
   */
  async resolveWorkshopNames(
    ids: readonly string[],
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    if (!auth) {
      console.warn("[team] workshop names: no request context to forward", {
        ids: ids.length,
      });
      return {};
    }

    /**
     * DEDUPLICATE, THEN SLICE — in that order, because the order changes the answer. Two teams in one
     * workshop are one probe, so collapsing duplicates first spends the budget on DISTINCT workshops;
     * slicing first would let a repeated id crowd out a name that could have been resolved.
     */
    const distinct = [...new Set(ids)];
    const probed = distinct.slice(0, MAX_WORKSHOP_NAME_PROBES);

    if (probed.length < distinct.length) {
      // The cap is a DISPLAY gap and must be legible as one — an operator seeing blank workshop
      // columns needs to know the fan-out was truncated rather than that the lookups failed.
      console.warn("[team] workshop-name fan-out truncated at the cap — rows beyond it show none", {
        distinct: distinct.length,
        probed: probed.length,
        cap: MAX_WORKSHOP_NAME_PROBES,
      });
    }

    // The CALLER's own identity, not a synthetic one. Behind the gateway this resolves to
    // re-presenting their Bearer token; without one it falls back to the internal-hop headers,
    // which the callee authorizes on — so an empty id/role there would ask as a role-less
    // caller and be refused every name by requireWorkshopRead.
    const headers = forwardedIdentityHeaders(auth, { id: userId, role });

    // Issued in parallel, bounded above at MAX_WORKSHOP_NAME_PROBES. Each is independent, so one
    // slow lookup costs the page EAST_WEST_TIMEOUT_MS rather than N × it.
    const entries = await Promise.all(
      probed.map(async (id) => {
        try {
          const res = await fetch(
            `${this.baseUrl}/workshops/${encodeURIComponent(id)}`,
            { headers, signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS) }
          );
          if (!res.ok) return null;
          const data = (await res.json().catch(() => null)) as {
            workshop?: { name?: unknown };
          } | null;
          const name = data?.workshop?.name;
          return typeof name === "string" && name !== "" ? ([id, name] as const) : null;
        } catch {
          // Swallowed BY DESIGN — this is the one lookup on the route that must never take
          // out the list it annotates. Logged once below rather than per id, so a Workshop
          // brownout does not write one line per row of every directory page.
          return null;
        }
      })
    );

    const resolved = entries.filter((e): e is readonly [string, string] => e !== null);

    // Compared against `probed`, NOT `ids`: rows dropped by the cap are already reported above, and
    // counting them here too would blame the Workshop service for a truncation this method chose.
    if (resolved.length < probed.length) {
      // NOT SILENT. A blank workshop column is indistinguishable from "no workshop" without
      // this line, and that ambiguity makes failures take far longer to find than they
      // should.
      console.warn("[team] some workshop names could not be resolved — rows show none", {
        requested: probed.length,
        resolved: resolved.length,
      });
    }

    return Object.fromEntries(resolved);
  }
}
