import type { UserRoles, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
} from "@praimana/service-shared";

/**
 * HTTP-backed UserRoles — asks the Identity service "what platform role does this user hold?".
 *
 * ⚠ IT EXISTS FOR EXACTLY ONE CALLER, AND THAT CALLER IS AN ESCALATION GATE. Ownership transfer
 * writes a new `ownerId` onto an experience, and `isOwnerOrAdmin` — the write gate on every
 * mutating workshop route — is PURE OWNERSHIP with no role check:
 *
 *     return workshop.ownerId === identity.id;
 *
 * So transferring an experience to a PARTICIPANT would hand that participant the power to rename
 * it, set its phases, move its current phase and reopen its submissions. `canCreateWorkshops`
 * gates who may CREATE an experience and says nothing about who may come to own one. Without this
 * port the recovery route would be a privilege-escalation primitive with an audit trail.
 *
 * Users are Identity's data, so the question is asked over Identity's own API
 * (`GET /v1/admin/users?ids=…`) rather than by reading its table — the same boundary rule every
 * other `*.http.ts` in this service follows.
 *
 * ⚠ THE CALLER'S OWN BEARER IS RE-PRESENTED, which makes the answer subject to Identity's own
 * visibility rule (`visibleRolesFor`) rather than to ours. That is the correct polarity: this
 * service must not be able to learn a role its caller could not. The route above it admits only an
 * ADMIN, and an ADMIN sees every role, so the narrowing never bites in practice — but if that route
 * ever widens, this degrades to "cannot determine" rather than quietly disclosing.
 *
 * ⚠ NO CYCLE. Identity does not call this service — verified by sweep, not assumed — so
 * `workshop → identity` cannot close a loop the way `Team → Workshop → Team` could.
 *
 * THREE-VALUED, for the reason every sibling port here repeats:
 *
 *   · a role string      → Identity answered, and this is the role.
 *   · `null`             → Identity answered, and there is no such user (or none it will disclose).
 *   · `"unavailable"`    → Identity did NOT answer: timeout, 5xx, unreachable, non-JSON, or a 200
 *                          whose shape we do not recognise.
 *
 * Collapsing `"unavailable"` into `null` would turn a brownout into "that user does not exist" and
 * refuse a legitimate recovery with a message that sends an operator looking for a typo. The route
 * maps it to 503 + Retry-After.
 *
 * BOUNDED IN TIME (EAST_WEST_TIMEOUT_MS). An abort rejects the fetch and lands in the same catch as
 * a connect error — identical semantics, bounded wait.
 */
export class HttpUserRoles implements UserRoles {
  constructor(
    private readonly baseUrl = process.env.IDENTITY_SERVICE_URL ||
      process.env.TEAM_SERVICE_URL ||
      "http://localhost:4011/v1"
  ) {}

  async roleOf(
    userId: string,
    auth?: AuthContext
  ): Promise<string | null | "unavailable"> {
    // No Context ⇒ no caller token to re-present, and the gateway would 401 the call.
    // "unavailable" rather than null: we did not ask, so we do not know.
    if (!auth) {
      console.warn("[authz] role lookup: no request context to forward", { userId });
      return "unavailable";
    }

    const url = `${this.baseUrl}/admin/users?ids=${encodeURIComponent(userId)}`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: forwardedIdentityHeaders(auth, { id: userId, role: "ADMIN" }),
        signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn("[authz] role lookup FAILED — undetermined, not absent", {
        userId,
        elapsedMs: Date.now() - started,
        timeoutMs: EAST_WEST_TIMEOUT_MS,
        timedOut: err instanceof Error && err.name === "TimeoutError",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return "unavailable";
    }

    if (!res.ok) {
      console.warn("[authz] role lookup non-OK — undetermined, not absent", {
        userId,
        status: res.status,
        elapsedMs: Date.now() - started,
      });
      return "unavailable";
    }

    const data = (await res.json().catch(() => null)) as {
      users?: unknown;
    } | null;

    /**
     * Shape is PINNED rather than trusted. A 200 carrying an error envelope or an HTML page from a
     * misrouted gateway must not read as "no such user" — that is indistinguishable from a real
     * absence, and here it would refuse a valid transfer.
     */
    if (!data || !Array.isArray(data.users)) {
      console.warn("[authz] role lookup returned an unrecognised body", { userId });
      return "unavailable";
    }

    const match = (data.users as Array<{ id?: unknown; role?: unknown }>).find(
      (u) => u && u.id === userId
    );
    // A determined absence. Identity answered and either has no such user or will not disclose it;
    // both mean "not somebody this transfer may name".
    if (!match) return null;
    return typeof match.role === "string" && match.role ? match.role : null;
  }
}
