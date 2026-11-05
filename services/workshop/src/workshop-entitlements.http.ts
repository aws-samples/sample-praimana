import type { WorkshopEntitlements, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
} from "@praimana/service-shared";

/**
 * HTTP-backed WorkshopEntitlements — asks the Team service for the caller's entitled
 * workshop ids, `E(self)`, so `GET /v1/workshops` can answer a JUDGE, EXECUTIVE or
 * PARTICIPANT instead of handing them the empty list `listByOwner` produces.
 *
 * The question is Team's to answer: `E(self)` is the union of invitations naming a
 * workshop (`invitations`/`email-index`) and workshops reached through team membership
 * (`team-members`/`userId-index` → `teams`/`id-index`), and Team owns all three
 * tables. We read that answer through Team's own API rather than reaching into its
 * tables — same boundary rule as HttpWorkshopMembership and HttpTeamAccess beside
 * this file. The Workshop-local projection cannot
 * answer a LIST.
 *
 * NO userId OR email PARAMETER. The callee keys both halves on the token's verified
 * claims, so this client cannot ask about anybody else even if a future caller wanted
 * it to. An entitlement probe that takes a subject is an enumeration oracle for "who
 * can see which workshop". `role` is passed only to forwardedIdentityHeaders for the
 * internal-hop fallback, never as a query parameter.
 *
 * ── THREE-VALUED, AND THE 404 CASE DIVERGES FROM HttpWorkshopMembership ──
 *
 *   200 with a well-formed body        → the ids (a DETERMINED answer, possibly empty)
 *   timeout, 5xx, unreachable          → "unavailable"
 *   non-JSON or unrecognised shape     → "unavailable"
 *   401 / 403                          → "unavailable"
 *   404                                → "unavailable"   ← DIFFERENT, see below
 *
 * HttpWorkshopMembership treats a 404 as a definite `false`, correctly reasoned there:
 * that callee returns a body for every workshop id, so a 404 means the route is
 * absent and cannot say yes. HERE the same reasoning gives the opposite answer. This
 * route is NEW, so during a rolling deploy — Workshop N+1 live before the Team route
 * is mapped in the gateway — a 404 is the EXPECTED transient state. Reading it as
 * "no entitlements" would hand every executive an empty experiences page with no
 * error signal anywhere: the exact bug this code was written to fix, silently
 * restored. So 404 means "ask again", and the deploy order is Team first.
 *
 * A 401/403 is also "unavailable" rather than a definite empty: unlike a per-resource
 * gate, there is no legitimate reading in which the caller's own entitlement list is
 * FORBIDDEN to them. If the gateway refuses this hop, the hop is broken.
 *
 * BOUNDED IN TIME (EAST_WEST_TIMEOUT_MS). An abort rejects the fetch and lands in the
 * same catch as a connect error — identical semantics, bounded wait. Note this bound
 * is now the dominant term in the route's p99.9 and was derived from an in-VPC
 * measurement in a topology that no longer exists.
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
    // No Context ⇒ no caller token to re-present, and the gateway would reject the
    // call. "unavailable" rather than an empty list: we did not ask, so we do not know.
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
      // EVERY non-2xx is undetermined here — including 404 and 403. See the class
      // note: there is no status on this route that legitimately means "you have
      // none", because an empty entitlement set is a 200 with an empty array.
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

    // Shape is pinned rather than trusted. A 200 carrying an unrecognised body (an
    // error envelope, an HTML page from a misrouted gateway) must not read as a
    // determined empty list — that is indistinguishable from the bug.
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
