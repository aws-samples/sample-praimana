import type { WorkshopEntitlements, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
} from "@praimana/service-shared";

/**
 * HTTP-backed WorkshopEntitlements — asks the Team service for the caller's entitled
 * workshop ids, `E(self)`, so `requirePublishedSummaryRead` can answer "may this judge read
 * THIS team's summary?" rather than "is this caller a judge at all?".
 *
 * ── A DELIBERATE THIRD COPY (evaluation/, workshop/, here) ──
 *
 * Same route, same contract, same failure semantics, byte-for-byte the same three-valued
 * result — the CODE below is identical in all three files and only these opening paragraphs
 * differ. Copied rather than shared for the reason every other cross-service client in this
 * repo is copied: these are bundled Lambdas that take no dependency on a workspace package
 * beyond `service-shared`, and the composition roots differ. They MUST NOT DRIFT — if the
 * failure table below stops matching the other two, one of the three services is wrong.
 *
 * WHAT IT GATES HERE: the ONLY route in this service reachable by a non-member — the
 * published team summary. The entitlement is checked against the workshopId STORED ON THE
 * SNAPSHOT at generation time, never one named by the caller.
 *
 * THERE IS NO ENTITLEMENTS TABLE TO READ. An earlier Workshop-local entitlement store design was
 * withdrawn and never built. `GET /v1/entitlements/workshops` is the live
 * mechanism: Team computes the union from invitations naming a workshop
 * (`invitations`/`email-index`) and workshops reached through team membership
 * (`team-members`/`userId-index` → `teams`/`id-index`), because Team owns all three tables.
 *
 * ⚠ THE REVOKED/EXPIRED FILTER IS INHERITED, NOT RE-IMPLEMENTED. That route used to return
 * workshops from REVOKED and EXPIRED invitations — an authorization defect, since
 * fixed — and it now filters both terminal states with the same predicate pair every
 * other reader of that table applies. This client asks the question and trusts the answer;
 * a local status filter here would be a second copy of a rule that belongs in exactly one
 * place, and the copy that fell behind would be the hole.
 *
 * NO userId OR email PARAMETER. The callee keys both halves on the token's verified claims,
 * so this client cannot ask about anybody else even if a future caller wanted it to. An
 * entitlement probe that takes a subject is an enumeration oracle for "who can see which
 * workshop". `role` is passed only to forwardedIdentityHeaders for the internal-hop
 * fallback, never as a query parameter.
 *
 * ── THREE-VALUED, AND EVERY NON-2xx IS "UNAVAILABLE" ──
 *
 *   200 with a well-formed body        → the ids (a DETERMINED answer, possibly empty)
 *   timeout, 5xx, unreachable          → "unavailable"
 *   non-JSON or unrecognised shape     → "unavailable"
 *   401 / 403                          → "unavailable"
 *   404                                → "unavailable"
 *
 * There is NO status on this route that legitimately means "you are entitled to nothing",
 * because a genuinely empty entitlement set is a 200 with an empty array. A 404 means the
 * route is unmapped (the expected transient state of a rolling deploy, hence TEAM FIRST); a
 * 401/403 means the hop itself is broken, since there is no reading in which a caller's own
 * entitlement list is forbidden to them.
 *
 * The consumer turns "unavailable" into a 503, NEVER a 403 and never a pass — the
 * central rule. Reading a failed hop as an empty set would tell a judge mid-judging "not
 * your workshop" when the truth is "Team is briefly unreachable": the same class of defect
 * as the 403 that said "not the owner" when a probe had timed out.
 *
 * BOUNDED IN TIME (EAST_WEST_TIMEOUT_MS). An abort rejects the fetch and lands in the same
 * catch as a connect error — identical semantics, bounded wait. Note this bound is the
 * dominant term in the scoring route's p99.9; the latency budget explains why the
 * number is UNVALIDATED in the current topology rather than wrong.
 */
export class HttpWorkshopEntitlements implements WorkshopEntitlements {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  async listEntitledWorkshopIds(
    role: string,
    auth?: AuthContext
  ): Promise<{ workshopIds: string[]; truncated: boolean } | "unavailable"> {
    // No Context ⇒ no caller token to re-present, and the gateway would reject the call.
    // "unavailable" rather than an empty list: we did not ask, so we do not know.
    if (!auth) {
      console.warn("[authz] entitlements: no request context to forward");
      return "unavailable";
    }

    const url = `${this.baseUrl}/entitlements/workshops`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: forwardedIdentityHeaders(auth, { id: "", role }),
        signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
      });
    } catch (err) {
      const elapsedMs = Date.now() - started;
      console.warn("[authz] entitlements probe FAILED — undetermined, not empty", {
        role,
        elapsedMs,
        timeoutMs: EAST_WEST_TIMEOUT_MS,
        timedOut: err instanceof Error && err.name === "TimeoutError",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return "unavailable";
    }

    if (!res.ok) {
      console.warn("[authz] entitlements probe non-OK — undetermined, not empty", {
        role,
        status: res.status,
        elapsedMs: Date.now() - started,
        url,
      });
      return "unavailable";
    }

    const data = (await res.json().catch(() => null)) as {
      workshopIds?: unknown;
      truncated?: unknown;
    } | null;

    // Shape is pinned rather than trusted. A 200 carrying an unrecognised body (an error
    // envelope, an HTML page from a misrouted gateway) must not read as a determined empty
    // list — for a JUDGE that is indistinguishable from "you may score nothing".
    if (!data || !Array.isArray(data.workshopIds)) {
      console.warn("[authz] entitlements probe returned an unrecognised body", {
        role,
        elapsedMs: Date.now() - started,
      });
      return "unavailable";
    }

    const workshopIds = (data.workshopIds as unknown[]).filter(
      (x): x is string => typeof x === "string" && x.length > 0
    );

    return { workshopIds, truncated: data.truncated === true };
  }
}
