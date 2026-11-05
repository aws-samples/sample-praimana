import type { WorkshopAccess, AuthContext } from "./authz.js";
import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
  callService,
  ServiceInvokeError,
} from "@praimana/service-shared";
import type { TeamRepository } from "./domain.js";
// The service's SINGLE local copy of the team-size ceiling. Used here to validate
// the WORKSHOP's stored template before it is allowed to become a team's seatCap — an
// out-of-range stored value must be reported as "invalid", never seeded.
import {
  MAX_TEAM_MEMBERS,
  MIN_TEAM_SIZE,
  isValidMaxTeamSize,
} from "./team-size.js";

/**
 * HTTP-backed WorkshopAccess — decides "does this user own the workshop this team
 * belongs to?", the branch that lets a FACILITATOR reach a team they aren't a member
 * of. Two steps, and WHICH step happens WHERE is the whole point:
 *
 *   1. teamId → workshopId, resolved LOCALLY. `teams` is this service's own table
 *      and Team.workshopId is its partition key — asking another service for it
 *      would be inventing a dependency to look up data we own.
 *   2. workshopId → ownerId, asked of the WORKSHOP service via its own public
 *      GET /workshops/:id. Workshops are its data; we read them through its API,
 *      not its table.
 *
 * PREVIOUS BUG (this is why the class is shaped this way): it called
 * `GET /teams/:teamId/workshop-owner` — a route that exists in NO service and is
 * mapped in no gateway. Every call 404'd, `!res.ok` returned false, and so
 * ownsTeamWorkshop was permanently false: a FACILITATOR who wasn't a team member
 * was denied every team in the workshop they run, and only ADMIN (which
 * short-circuits before this hop in authz.ts) worked. The dependency was also
 * inverted — the Workshop service cannot answer a question keyed on a teamId,
 * because it doesn't own teams.
 *
 * The caller's own Bearer token is re-presented (forwardedIdentityHeaders), because
 * WORKSHOP_SERVICE_URL points at the public HTTP API and every route there sits
 * behind the Cognito JWT authorizer — a tokenless "trusted internal hop" is 401'd by
 * the gateway before the Workshop Lambda runs.
 *
 * Fails CLOSED: any outcome that isn't a matching ownerId is "not the owner".
 *
 * BOUNDED IN TIME as well as in outcome (EAST_WEST_TIMEOUT_MS). Fail-closed alone is
 * not enough: a Workshop service answering slowly but successfully would pin this
 * Lambda for the full 29s gateway timeout per waiter, and every team route that needs
 * the ownership branch would fill concurrency waiting on it. The timeout does not
 * change the MEANING of a failure here — an abort rejects the fetch, which the catch
 * below already reads as "not the owner" — it only bounds the wait.
 */
export class HttpWorkshopAccess implements WorkshopAccess {
  constructor(
    private readonly teams: TeamRepository,
    private readonly baseUrl = process.env.WORKSHOP_SERVICE_URL ||
      "http://localhost:4000/v1",
    /**
     * The Workshop LAMBDA's name, used only when there is no caller bearer to re-present.
     * Unset ⇒ this fallback does not exist and behaviour is exactly as it was. See
     * `requestWorkshop` below.
     */
    private readonly workshopFunctionName = process.env.WORKSHOP_FUNCTION_NAME || ""
  ) {}

  /**
   * ── GET the workshop, over whichever transport can actually carry the caller's identity ──
   *
   * ⚠ THIS METHOD EXISTS BECAUSE THE HTTP TRANSPORT SILENTLY DOES NOT WORK FOR TOKENLESS CALLERS,
   * AND THE FIRST ONE COST A FACILITATOR THEIR WHOLE UPLOAD.
   *
   * `WORKSHOP_SERVICE_URL` is the PUBLIC HTTP API, every route of which inherits the Cognito JWT
   * authorizer. `forwardedIdentityHeaders` re-presents the caller's bearer when there is one and
   * falls back to `x-identity-*` when there is not — and that fallback is 401'd BY THE GATEWAY before
   * the Workshop Lambda runs. For a request that arrived over the gateway there is always a bearer,
   * so this was invisible.
   *
   * Then bulk provisioning arrived. Its worker is woken by an event, has no user session, and invokes
   * this service DIRECTLY with IAM as the credential — so requests reach these routes with no bearer
   * at all. The probe went out tokenless, the gateway answered `401 {"message":"Unauthorized"}`,
   * `ownsWorkshop` fail-closed as it is supposed to, and all three teams in the file were refused
   * with "only the workshop owner can create teams". The facilitator owned the workshop. Nothing was
   * created, and because the same run also lost the requester's email, no report was sent either — so
   * the only evidence was one CloudWatch line reading "denying, not a real denial".
   *
   * ⚠ THE FIX IS A TRANSPORT, NOT A RELAXED CHECK. The ownership question is still asked, still
   * answered by the Workshop service from its own data, and still fails closed. What changes is only
   * HOW the question travels when there is no token: a direct Lambda invocation, where
   * `lambda:InvokeFunction` is the credential instead of a JWT. Weakening the probe for "internal"
   * callers would have been the easy version and would have made a compromised worker able to create
   * teams in any workshop.
   *
   * ⚠ CHOSEN BY WHAT IS AVAILABLE, NEVER PREFERRED. A bearer always wins, so every gateway-served
   * request behaves exactly as before — this path is unreachable for them. And it requires
   * `WORKSHOP_FUNCTION_NAME` to be set, which it is not in local dev: there, the tokenless internal
   * header path over `http://localhost` still works and is still used.
   *
   * Returns a `Response` in both cases so the callers' status handling and their logging stay
   * identical across transports. An invoke-level failure (`ServiceInvokeError` carries the callee's
   * status) becomes a non-OK `Response`; a connect/timeout failure throws, exactly as `fetch` does,
   * and lands in the caller's existing catch.
   */
  private async requestWorkshop(
    workshopId: string,
    userId: string,
    role: string,
    auth: AuthContext
  ): Promise<{ res: Response; headers: Record<string, string>; url: string; transport: string }> {
    const headers = forwardedIdentityHeaders(auth, { id: userId, role });
    const url = `${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}`;

    // A bearer beats everything; no function name ⇒ the fallback does not exist here.
    if (headers.authorization || !this.workshopFunctionName) {
      const res = await fetch(url, {
        headers,
        // An abort rejects the fetch, so it lands in the same catch as a connect
        // error and reads as "not the owner" — identical semantics, bounded wait.
        signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
      });
      return { res, headers, url, transport: "http" };
    }

    const path = `/v1/workshops/${encodeURIComponent(workshopId)}`;
    const target = `lambda:${this.workshopFunctionName}${path}`;
    try {
      const invoked = await callService<unknown>(
        this.workshopFunctionName,
        "GET",
        path,
        // No email: the ownership answer is keyed on `sub`, and this hop has no need of one.
        { id: userId, email: "", role },
        undefined,
        /**
         * ⚠ THE SAME BOUND AS THE HTTP HOP, NOT the invoke default of 30s. This runs inside a
         * request that the gateway kills at 29s, and a 30s probe would hold a Lambda past the point
         * where anyone is still waiting for the answer.
         */
        { timeoutMs: EAST_WEST_TIMEOUT_MS, source: "team-service" }
      );
      return {
        res: new Response(JSON.stringify(invoked.body ?? null), {
          status: invoked.status,
          headers: { "content-type": "application/json" },
        }),
        headers,
        url: target,
        transport: "lambda",
      };
    } catch (err) {
      if (err instanceof ServiceInvokeError) {
        // The callee answered, with an error. Surface it AS a response so the caller's non-OK
        // branch — which distinguishes a 404 from a 403 — keeps working unchanged.
        return {
          res: new Response(JSON.stringify({ error: err.message }), {
            status: err.status,
            headers: { "content-type": "application/json" },
          }),
          headers,
          url: target,
          transport: "lambda",
        };
      }
      // A timeout or a transport fault. `fetch` throws for these too, so the caller already
      // handles it — and must, because "we could not ask" is not an ownership answer.
      throw err;
    }
  }

  async ownsTeamWorkshop(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean> {
    // Step 1 — our own data.
    const team = await this.teams.getById(teamId).catch(() => null);
    if (!team?.workshopId) return false;

    // Step 2 — the Workshop service's data, through the Workshop service.
    return this.ownsWorkshop(team.workshopId, userId, role, auth);
  }

  async ownsWorkshop(
    workshopId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean> {
    // No Context ⇒ no caller token to re-present, and the gateway would reject the
    // call. Deny rather than emit a request that can only 401.
    if (!auth) {
      console.warn("[authz] ownsWorkshop denied: no request context to forward", {
        workshopId,
        userId,
        role,
      });
      return false;
    }
    if (!workshopId) return false;

    // WHY EVERY BRANCH BELOW LOGS.
    //
    // This method used to fail closed SILENTLY: a 401 at the gateway, a cold-start
    // timeout, a malformed body and a genuine "you are not the owner" all returned
    // plain `false`, and the route turned every one of them into the same
    // "Forbidden: only the workshop owner can create teams". A FACILITATOR who DID own
    // the workshop was told they did not, and the CloudWatch logs contained nothing at
    // all — not one line — so the reported bug could not be diagnosed from them. The
    // fail-closed BEHAVIOUR is right and is unchanged; what was wrong was that it was
    // indistinguishable from a real denial.
    //
    // Deliberately console.warn and not an exception: turning an infrastructure blip
    // into a 500 would be a worse outcome than a denial, and the caller cannot act on
    // it either way. These lines exist to make the difference VISIBLE.
    const started = Date.now();
    let res: Response;
    let headers: Record<string, string>;
    let url: string;
    let transport: string;
    try {
      ({ res, headers, url, transport } = await this.requestWorkshop(
        workshopId,
        userId,
        role,
        auth
      ));
    } catch (err) {
      // A TimeoutError here is NOT the same event as a connect failure, and the
      // distinction matters operationally: the callee's cold start has been measured at
      // ~1300ms (1014ms duration + 288ms init) against this 800ms budget, so a cold
      // Workshop Lambda can deny an owner outright. Naming the elapsed time and the
      // budget in the log is what makes that visible instead of inferred.
      const elapsedMs = Date.now() - started;
      console.warn("[authz] ownsWorkshop probe FAILED — denying, not a real denial", {
        workshopId,
        userId,
        role,
        elapsedMs,
        timeoutMs: EAST_WEST_TIMEOUT_MS,
        timedOut: err instanceof Error && err.name === "TimeoutError",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return false;
    }

    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        body = "(unreadable)";
      }
      const sent = headers.authorization ?? "";
      const token = sent.startsWith("Bearer ") ? sent.slice(7) : "";
      console.warn("[authz] ownsWorkshop probe non-OK — denying, not a real denial", {
        workshopId,
        userId,
        role,
        status: res.status,
        elapsedMs: Date.now() - started,
        url,
        // WHICH TRANSPORT carried it. A 401 over "http" with no token is the gateway refusing a
        // tokenless hop — the bug that broke bulk provisioning — and reads completely differently
        // from a 403 over "lambda", which is the Workshop service itself answering.
        transport,
        headerNames: Object.keys(headers),
        // A JWT has 3 dot-separated segments; anything else means we forwarded
        // something that is not a token at all.
        tokenSegments: token ? token.split(".").length : 0,
        tokenLength: token.length,
        body,
      });
      return false;
    }

    const data = (await res.json().catch(() => null)) as {
      workshop?: { ownerId?: unknown; maxTeamSize?: unknown };
    } | null;
    const ownerId = data?.workshop?.ownerId;
    // Compare only real, non-empty strings: an absent ownerId on both sides must
    // never read as a match.
    const owns =
      typeof ownerId === "string" && ownerId !== "" && ownerId === userId;

    if (!owns) {
      // The ONLY branch that is a genuine authorization answer. Logged at info-level
      // detail so a real denial can be told apart from the failure paths above.
      console.log("[authz] ownsWorkshop: caller is not the owner", {
        workshopId,
        userId,
        ownerIdPresent: typeof ownerId === "string" && ownerId !== "",
        elapsedMs: Date.now() - started,
      });
    }
    return owns;
  }

  async teamSeatTemplate(
    workshopId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<number | "unavailable" | "invalid"> {
    // No Context ⇒ no caller token to re-present and the gateway would 401 the call, exactly
    // as in ownsWorkshop. "unavailable" rather than a guess: a request we cannot make has not
    // told us anything about the template.
    if (!auth) {
      console.warn(
        "[authz] teamSeatTemplate: no request context to forward — cannot read the workshop template",
        { workshopId, userId, role }
      );
      return "unavailable";
    }
    if (!workshopId) return "unavailable";

    const started = Date.now();
    let res: Response;
    try {
      // Same transport choice as `ownsWorkshop` — and it MUST be the same, because these two
      // methods are both called by team creation. A version of this that worked for the ownership
      // gate and not for the seat template would turn the bulk path's failure from "Forbidden" into
      // "503 seat template unavailable" and be no more usable.
      ({ res } = await this.requestWorkshop(workshopId, userId, role, auth));
    } catch (err) {
      console.warn("[authz] teamSeatTemplate: the workshop probe FAILED", {
        workshopId,
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
      // Including 404. A workshop that does not exist cannot supply a template, and the
      // caller must not create a team in it — but this is reported as "unavailable" rather
      // than "invalid" because the CALLER's own ownership check runs first and would already
      // have refused a workshop they cannot reach. Reaching here with a 404 means the row
      // vanished between the two probes, which a retry resolves.
      console.warn("[authz] teamSeatTemplate: the workshop probe was non-OK", {
        workshopId,
        userId,
        role,
        status: res.status,
        elapsedMs: Date.now() - started,
      });
      return "unavailable";
    }

    const data = (await res.json().catch(() => null)) as {
      workshop?: { maxTeamSize?: unknown };
    } | null;
    if (!data || typeof data !== "object" || !data.workshop) {
      // A 200 whose body we cannot read is an incomplete hop, not a determined answer — the
      // same reading `ownsWorkshop` gives an unparseable body.
      console.warn(
        "[authz] teamSeatTemplate: the workshop probe returned an unreadable body",
        { workshopId, userId, elapsedMs: Date.now() - started }
      );
      return "unavailable";
    }

    const maxTeamSize = data.workshop.maxTeamSize;
    if (!isValidMaxTeamSize(maxTeamSize)) {
      // THE READ COMPLETED and the stored value is unusable — absent on a workshop written
      // before the field existed, or out of range because `num(body.maxTeamSize, 6)` accepted
      // a value nothing validated (workshop/src/routes.ts, now gated). PERMANENT until
      // somebody patches the workshop, which is why this is not "unavailable": a 503 with
      // Retry-After would tell an operator to wait for something that will never change.
      console.warn(
        "[authz] teamSeatTemplate: the workshop's maxTeamSize is missing or out of range",
        {
          workshopId,
          userId,
          // The VALUE and its type, because "which bad value" is the whole diagnosis and a
          // team-size number is not sensitive. Bounded: coerced to a short string.
          maxTeamSize: String(maxTeamSize).slice(0, 32),
          valueType: typeof maxTeamSize,
          min: MIN_TEAM_SIZE,
          max: MAX_TEAM_MEMBERS,
        }
      );
      return "invalid";
    }

    return maxTeamSize;
  }
}
