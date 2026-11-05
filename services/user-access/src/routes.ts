import { Hono } from "hono";
import {
  edgeIdentityMiddleware,
  emitAccessAuditMetric,
  requireIdentity,
} from "@praimana/service-shared";
import {
  canAdministerUser,
  canGrantRole,
  canManageUsers,
  generateTemporaryPassword,
  liveInvitationKeys,
  meetsPasswordPolicy,
  normalizeAuditReason,
  resolveRoleFromInvitations,
  roleFromGroups,
  usernameRejectionReason,
  type AuditRepository,
  type EventPublisher,
  type InvitationReader,
  type ProfileStore,
  type RandomBytes,
  type Role,
  type UserDirectory,
} from "./domain.js";

/**
 * User Access routes — the Cognito ADMIN-WRITE surface, mounted at /v1/user-access.
 *
 * TWO routes: POST /provision creates the Cognito account for an address that already
 * holds an invitation, and POST /access disables or re-enables an existing account.
 * They live in one service because they face the identical constraint and need the
 * identical IAM — see the header comment in domain.ts.
 *
 * ── WHY A SERVICE AND NOT A CALL FROM THE PORTAL'S ROUTE HANDLER ──
 * The portal's BFF runs in Next.js with no AWS credentials for this account and no
 * business holding `cognito-idp:AdminCreateUser`. The identity service has the
 * business case but cannot make the call at all (it is in the VPC — see domain.ts).
 * This function is out of the VPC and carries that one permission.
 *
 * ── THE ORDERING, AND WHY IT IS FORCED ──
 * The sequence is: the invitation row is stored FIRST (by the team service, before
 * this route is ever called) → then AdminCreateUser → then our email.
 *
 * That order is not a preference, it is a REQUIREMENT of how the gate works. The
 * pre-signup trigger fires on `PreSignUp_AdminCreateUser` too — it has no
 * triggerSource check — so it reads the invitations table on this very call and
 * throws "Registration is by invitation only." when there is no live row. Verified
 * against the live dev pool: AdminCreateUser for an un-invited address is REFUSED and
 * no account is created; seeding the invitation first makes the same call succeed.
 *
 * Two consequences worth stating plainly:
 *   1. Creating the account before the row would fail 100% of the time. The gate is
 *      not something this code has to re-implement — it is something this code
 *      depends on, and must not bypass.
 *   2. A UserLambdaValidationException from AdminCreateUser therefore means OUR
 *      sequencing is wrong (the row is missing or already expired), not that the
 *      operator did something wrong. It is reported distinctly for that reason.
 *
 * ── WHY THE ACCOUNT IS COMPLETED HERE AND NOT IN A TRIGGER ──
 * PostConfirmation does NOT fire on the admin-create path — not on creation, and not
 * when the user completes their forced password change and the account reaches
 * CONFIRMED. Observed on a real user pool: zero log events, no group, no profile row.
 * The @types/aws-lambda PostConfirmation event agrees at the type level — its only
 * two sources are PostConfirmation_ConfirmSignUp and
 * PostConfirmation_ConfirmForgotPassword; there is no admin-create equivalent to
 * widen that guard to.
 *
 * So the group assignment, the profile row and the user.created event happen HERE,
 * synchronously, immediately after the account exists. The account is therefore
 * COMPLETE from the moment it is created rather than at some later first sign-in —
 * which also means an invited user never exists in a window with no role. The
 * post-confirmation trigger is left untouched and still owns the self-signup path.
 */

export interface UserAccessDeps {
  directory: UserDirectory;
  invitations: InvitationReader;
  profiles: ProfileStore;
  events: EventPublisher;
  audit: AuditRepository;
  random: RandomBytes;
  /** A fresh deadline for one Cognito call. Injected so tests need no timers. */
  deadline: () => AbortSignal;
}

/**
 * Who may reach the admin-write surface AT ALL — a coarse FLOOR, and nothing more.
 *
 * ⚠ THIS SET IS WIDER THAN ROLE_GRANTS AND IS NOT THE ESCALATION BOUNDARY. An earlier
 * version of this comment claimed the set "mirrors ROLE_GRANTS — a role that can grant
 * no role can provision no account", and that was FALSE OF THIS VERY SET:
 * ROLE_GRANTS.JUDGE is empty and ROLE_GRANTS.EXECUTIVE is ["PARTICIPANT"], yet both
 * roles are listed below. It also claimed the worst a caller could do was "materialise
 * an account for a role they were already permitted to invite", which silently assumed
 * the invitation row had been written by the SAME caller — nothing here reads
 * `invitedBy`. Both claims are corrected rather than deleted because the next reader
 * would otherwise trust them: they described a boundary that did not exist, and a
 * JUDGE could provision an ADMIN account and receive its temporary password. The
 * PER-ROLE check now lives in the /provision handler (canGrantRole) and is the actual
 * boundary; see the note on ROLE_GRANTS in domain.ts for the whole exploit.
 *
 * KEPT AS A SEPARATE, WIDER SET ON PURPOSE. Its job is to refuse the roles that have no
 * business on this surface AT ALL before the body is parsed, before the invitation
 * lookup, and — because it is middleware — for any route added here later, which would
 * otherwise inherit nothing. PARTICIPANT is deliberately absent.
 *
 * It is NOT derived from ROLE_GRANTS, and narrowing it to match would be the wrong
 * move: /access is mounted behind this same floor and is narrowed further by
 * canManageUsers, so this set answers "may this role make account changes?" and not
 * "may this role hand out a role?". Two questions, two gates. What it must never again
 * be mistaken for is the second one.
 */
const PROVISIONER_ROLES = new Set([
  "ADMIN",
  "FACILITATOR",
  "EXECUTIVE",
  "JUDGE",
]);

function canProvision(role: string | null | undefined): boolean {
  return !!role && PROVISIONER_ROLES.has(role);
}

/**
 * Longest raw email string this route will look at.
 *
 * A payload bound, not a business rule — usernameRejectionReason() applies the real
 * 128-character limit. Set at 2x so a padded value still reaches the validator that
 * produces the specific message, while an absurd megabyte string is refused before
 * any regex runs over it.
 */
const MAX_RAW_EMAIL_LENGTH = 256;

/**
 * Longest raw `userId` POST /access will look at.
 *
 * A Cognito sub is a 36-character UUID. 64 leaves room for a differently-shaped
 * subject (the post-confirmation trigger's `sub || ulid()` fallback produces 26-char
 * ULID keys, which have no Cognito account and resolve to a 404 here) while refusing
 * a padded value before it reaches a Cognito filter string.
 */
const MAX_RAW_USER_ID_LENGTH = 64;

/**
 * Longest raw `reason` POST /access will look at, before normalization.
 *
 * A PAYLOAD bound, distinct from AUDIT_REASON_MAX (200), which is the storage rule.
 * Set at 4x so a slightly-over reason is still TRUNCATED into the entry — losing the
 * tail of a note is a smaller loss than losing the entry — while a megabyte of text is
 * refused before anything iterates its code points.
 */
const MAX_RAW_REASON_LENGTH = 800;

/**
 * How many invitation rows one address's revoke-on-disable may delete.
 *
 * An email legitimately holds at most one row per team plus one platform-scoped row
 * (the table is keyed (teamId, email)), so single digits is the real population and 25
 * is generous headroom. It bounds a fan-out sized by STORED DATA rather than by the
 * request, which is the thing worth bounding here: without it, an address that had
 * been invited to hundreds of teams would turn one disable into hundreds of sequential
 * DeleteItems and blow the function's 15s timeout — leaving the account disabled in
 * Cognito with the operator seeing a failure.
 *
 * Deletes are issued SEQUENTIALLY, not fanned out: 25 point deletes against a
 * single-partition key are milliseconds each, and a fan-out would trade that for burst
 * capacity on a table the sign-in path reads.
 */
const MAX_INVITATIONS_REVOKED = 25;

export function createUserAccessRoutes(deps: UserAccessDeps) {
  const app = new Hono().basePath("/v1/user-access");

  app.use("*", edgeIdentityMiddleware());

  // The role FLOOR for the WHOLE surface, as middleware rather than a per-handler
  // check: it runs before any body parsing, and a route added later inherits it
  // instead of inheriting nothing. Individual routes narrow it further — /access
  // requires canManageUsers, which is stricter than this.
  app.use("*", async (c, next) => {
    const { id, role } = requireIdentity(c);
    if (!canProvision(role)) {
      // Worth a log line: nothing in the UI calls this for a participant, so a
      // request from one is either a bug or someone probing.
      console.warn("[user-access] refused admin write for role without permission", {
        userId: id,
        role,
      });
      return c.json({ error: "Forbidden: your role cannot make account changes" }, 403);
    }
    return next();
  });

  /**
   * The DIRECTORY gate, narrowing the floor above for the access surface only.
   *
   * canProvision admits EXECUTIVE and JUDGE — as a FLOOR only; what either may actually
   * provision is decided per role by canGrantRole in the handler, which grants a JUDGE
   * nothing and an EXECUTIVE only PARTICIPANT. Neither may touch an EXISTING account at
   * all: USER_ADMIN_GRANTS gives them an empty list, so canManageUsers is false for
   * both. Different questions, different gates, and the comment on USER_ADMIN_GRANTS in
   * packages/shared spells out why they must not be derived from one another.
   *
   * Registered as PATH-SCOPED middleware rather than a check inside the handler so it
   * runs before the body is read, and so a second access-changing route added beside
   * this one inherits it.
   */
  app.use("/access", async (c, next) => {
    const { id, role } = requireIdentity(c);
    if (!canManageUsers(role)) {
      console.warn("[user-access] refused an access change for a non-directory role", {
        userId: id,
        role,
      });
      return c.json(
        { error: "Forbidden: your role cannot change another user's access" },
        403
      );
    }
    return next();
  });

  /**
   * POST /v1/user-access/provision — create the Cognito account for an INVITED
   * address, and return the temporary password to the caller so it can be emailed.
   *
   * ⚠ THE RESPONSE CARRIES A SECRET. `temporaryPassword` is returned exactly once and
   * exists nowhere else — it is not stored, not logged, and not recoverable. The only
   * sanctioned use is to put it straight into the invitation email (see the portal's
   * /api/invite route). It is returned rather than emailed from here because notify is
   * a separate bounded context that owns templating and SES, and duplicating that
   * here to avoid one hop would be worse.
   *
   * That is a deliberate trade-off, stated so it can be revisited: the secret crosses
   * one east-west hop over TLS between two of our own functions, authenticated by the
   * caller's own token. The alternative — this service calling notify directly —
   * shortens the secret's path by nothing (it is still one hop) and couples account
   * creation to email delivery, which would make an SES failure into a provisioning
   * failure.
   *
   * ── THE TWO ROLE GATES, BOTH ENFORCED HERE ──
   * This service is THE boundary, not defence in depth. The route is mapped
   * `ANY /v1/user-access/{proxy+}` behind the stack's DefaultAuthorizer, which carries
   * no AuthorizationScopes — the gateway authenticates the token and performs no role
   * scoping at all — and the browser holds its own ID token. So a check that lives only
   * in the portal's BFF is advisory, and the two below are what cannot be bypassed:
   *
   *   1. canProvision(callerRole) — the coarse FLOOR, as middleware above. May this role
   *      make account changes at all?
   *   2. canGrantRole(callerRole, ROLE FROM THE INVITATION ROW) — may this caller hand
   *      out THIS role? Enforced BEFORE the temporary password is generated, so a
   *      refused request never causes a credential to exist. This is the gate that was
   *      missing, and its absence let a JUDGE mint an ADMIN account's password.
   *
   * The role itself still comes from the stored row and NEVER from the request — that
   * invariant is necessary and was never sufficient, because the row says nothing about
   * who wrote it.
   */
  app.post("/provision", async (c) => {
    const caller = requireIdentity(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "a JSON body is required" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "a JSON object body is required" }, 400);
    }

    const raw = (body as Record<string, unknown>).email;
    if (typeof raw !== "string" || raw.length > MAX_RAW_EMAIL_LENGTH) {
      return c.json({ error: "email is required" }, 400);
    }
    // Lowercased to match how the team service stores an invitation's email and how
    // the pool's UsernameAttributes resolves it — a case mismatch here would look up
    // no invitation and refuse a legitimate invite.
    const email = raw.trim().toLowerCase();

    // Validated BEFORE the Cognito call so a malformed address is a clean 400 naming
    // the problem, rather than an InvalidParameterException surfacing as a 500 on a
    // route the operator believes succeeded.
    const rejection = usernameRejectionReason(email);
    if (rejection) {
      return c.json({ error: rejection }, 400);
    }

    // ── The role, from the invitation row. THE tamper-proof-role invariant: never
    // from this request. ──
    let rows;
    try {
      rows = await deps.invitations.listByEmail(email);
    } catch (err) {
      // FAIL CLOSED. A lookup we cannot make is not permission to create an account:
      // that would be a way to provision an un-invited address by making DynamoDB
      // unavailable.
      console.error("[user-access] invitation lookup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Could not verify the invitation" }, 503);
    }

    const role = resolveRoleFromInvitations(rows, Date.now());
    if (!role) {
      // No LIVE invitation. Refused here as well as by the pre-signup trigger — not
      // redundantly: reaching the trigger would create nothing but would report as a
      // UserLambdaValidationException, which this service treats as an internal
      // sequencing bug. Answering here keeps that signal meaningful and gives the
      // operator the actionable message.
      return c.json(
        { error: "No live invitation for that address — invite them first" },
        409
      );
    }

    // ── THE GRANT CHECK: may THIS caller hand out THIS role? ──
    //
    // The row's role is tamper-proof with respect to this REQUEST, and that is all it
    // is. Nothing here reads `invitedBy`, so without this check a caller who passed the
    // coarse floor above could materialise an account for a role somebody ELSE was
    // authorized to grant — and walk away with its temporary password, which the
    // response returns unconditionally. A JUDGE (who may grant nothing) guessing an
    // address that holds a pending ADMIN invitation was a full platform takeover: see
    // ROLE_GRANTS in domain.ts for the chain, MFA enrolment included.
    //
    // PLACED BEFORE generateTemporaryPassword DELIBERATELY, and the order is the point
    // rather than tidiness: a request that is going to be refused must never cause a
    // live credential to exist, not even in a local that is discarded. Everything below
    // this line assumes the caller is entitled to the role.
    if (!canGrantRole(caller.role, role)) {
      // Worth a log line, and worth ERROR rather than WARN unlike the floor above: every
      // UI path narrows the dropdown to the caller's own grantable roles and both the
      // portal's invite route and the Team service refuse the write, so a request that
      // reaches here cannot have come from the product. It is a direct call against the
      // service with a valid token — a probe of exactly this boundary. The target ROLE is
      // logged (an operator cannot investigate a refusal without knowing which rule
      // fired) and the address is NOT: the domain only, as everywhere else here.
      console.error(
        "[user-access] refused provisioning of a role the caller cannot grant",
        {
          requestedBy: caller.id,
          callerRole: caller.role,
          invitedRole: role,
          emailDomain: emailDomain(email),
        }
      );
      // 403 and NOT 404/409: the caller has already proved they hold a staff token, so
      // there is no enumeration to protect here that the floor above did not already
      // concede — and an operator whose role genuinely cannot staff this person needs to
      // be told that, not handed a message implying the invitation is missing. The
      // message names the role so the answer is actionable, and carries nothing else:
      // no password (none exists yet), no address.
      return c.json(
        { error: `Forbidden: your role cannot provision a ${role} account` },
        403
      );
    }

    // ── The temporary password. Generated here, held in one local, and passed to
    // exactly two places: the Cognito call and the response body. ──
    const temporaryPassword = generateTemporaryPassword(deps.random);
    // A self-check, not defensive padding: if the generator and the pool policy ever
    // drift, this turns a per-invite InvalidPasswordException into one loud, obvious
    // failure. The password itself is NOT included in the message.
    if (!meetsPasswordPolicy(temporaryPassword)) {
      console.error(
        "[user-access] generated temporary password does not satisfy the pool policy — check PASSWORD_POLICY against the template"
      );
      return c.json({ error: "Could not provision the account" }, 500);
    }

    // ── 1. Create the account. ──
    let created: { sub: string | null; alreadyExisted: boolean };
    try {
      created = await deps.directory.createUser({
        email,
        temporaryPassword,
        signal: deps.deadline(),
      });
    } catch (err) {
      const name = errorName(err);

      // The invite-only gate refused us, which means the invitation row is missing or
      // expired at the moment Cognito read it — despite the check above. That is a
      // sequencing bug on OUR side (a row written after this call, a clock skew, a
      // row that expired in between), and it is reported distinctly from a benign
      // re-invite so it is not mistaken for one.
      if (name === "UserLambdaValidationException") {
        console.error(
          "[user-access] the invite-only gate refused an account we believed was invited — the invitation row must exist BEFORE provisioning",
          { emailDomain: emailDomain(email), requestedBy: caller.id }
        );
        return c.json(
          {
            error:
              "The invitation could not be verified by the sign-up gate. Re-send the invitation and try again.",
            code: "INVITE_GATE_REFUSED",
          },
          409
        );
      }

      // Malformed for the pool despite our own validation (a rule we do not model).
      // A 400 rather than a 500: the input is the problem and the operator can fix it.
      if (name === "InvalidParameterException") {
        return c.json({ error: "That email address was rejected by the user pool" }, 400);
      }

      // A TimeoutError/AbortError from the deadline lands here too, and reads
      // correctly as "could not create": nothing was confirmed created, and a retry
      // (a re-invite) is safe because UsernameExistsException is handled as benign.
      console.error("[user-access] account creation failed", {
        errorName: name,
        error: err instanceof Error ? err.message : String(err),
        emailDomain: emailDomain(email),
      });
      // 502: an upstream we depend on refused or did not answer. The distinction from
      // the 409s above is what tells the operator whether to fix data or retry.
      return c.json({ error: "Could not create the account" }, 502);
    }

    // ── 2. The account's sub, which keys the profile row. ──
    // On a fresh create Cognito returns it in the response. On a re-invite
    // (alreadyExisted) it does not, so look it up — a profile row keyed on anything
    // other than the sub is invisible to /v1/auth/me, which resolves by the token's
    // subject. Any failure here is degradation, not a reason to fail the provisioning
    // that already succeeded.
    let sub = created.sub;
    if (!sub) {
      try {
        sub = await deps.directory.findSub({ email, signal: deps.deadline() });
      } catch (err) {
        console.error("[user-access] could not resolve the account's sub", {
          errorName: errorName(err),
          emailDomain: emailDomain(email),
        });
      }
    }

    /**
     * Set when this request is about to CHANGE a live account's role — i.e. the account
     * already existed and is not already in the group being added. Carries the role it is
     * changing FROM, because that is the fact the audit entry needs and the fact nothing
     * can recover once AdminAddUserToGroup has applied.
     *
     * Null on every fresh create and on every no-op re-assert, which is why the audit write
     * below is conditional: a provisioning that granted nothing new must not claim in the
     * trail that it did.
     */
    let roleChangeOnExistingAccount: { previousRole: Role | null } | null = null;

    // ── 2b. ⚠ THE EXISTING-ACCOUNT GATE. Only on the alreadyExisted branch. ──────────────
    //
    // Everything above this point is authorized by canGrantRole —
    // the FORWARD-LOOKING matrix, whose own documentation justifies a peer grant with "the
    // invitee has NO ACCOUNT YET, so granting a PEER is harmless" (domain.ts). On a fresh
    // create that reasoning holds exactly. On the alreadyExisted branch it does not hold at
    // all, and without this gate the branch ran anyway: `createUser` swallows UsernameExistsException as a
    // benign re-invite (adapters.ts) and step 3 below then called AdminAddUserToGroup on an
    // account ALREADY IN USE BY SOMEBODY.
    //
    // Adding a group to a live account is an ACCOUNT-ADMINISTRATION act, and this service
    // already has the matrix that governs those — USER_ADMIN_GRANTS via canAdministerUser,
    // enforced on /access and nowhere else. The one cell where the two matrices differ is
    // the whole exploit: ROLE_GRANTS lets a FACILITATOR grant FACILITATOR, USER_ADMIN_GRANTS
    // deliberately does not, because "acting on a PEER is a lateral attack: one facilitator
    // could disable another mid-workshop". So a facilitator could invite an EXISTING
    // participant/judge/executive at platformRole FACILITATOR, call /provision, and — since
    // collapseGroupsToRole takes the HIGHEST-PRECEDENCE group (service-shared/edge-identity.ts)
    // — silently promote that live account to their own level, which /access would have
    // refused with a 403. No group is ever removed here, so the path only ever escalated.
    //
    // ── THREE CASES, AND ONLY THE THIRD IS AUTHORIZED HERE ──
    //
    //   (a) THE GROUP IS ALREADY THERE → allowed, ungated. The documented repair action —
    //       "re-inviting is a repair (it re-asserts the group and the profile row) rather
    //       than a no-op" (adapters.ts). It changes NOTHING, so gating it would break a
    //       recovery path while preventing no privilege change whatsoever.
    //
    //   (b) THE ACCOUNT IS IN NO RECOGNISED GROUP AT ALL → allowed, on the forward matrix
    //       already checked above. This is the GHOST ACCOUNT the alreadyExisted branch
    //       exists to repair: created in Cognito, never grouped, and refused a session by
    //       the role gate, so there is no privilege on it to hijack. ⚠ AND IT CANNOT BE
    //       MANUFACTURED: no route on this platform removes a group ("No group is ever
    //       removed"), and sign-up is invite-only with the post-confirmation trigger
    //       assigning the group, so a groupless account is a partial-provisioning artefact
    //       rather than a state an attacker can put a live account into. Still AUDITED —
    //       it is a role grant onto an account that already existed.
    //
    //   (c) THE ACCOUNT HAS A REAL ROLE AND IT DIFFERS → the escalation this gate closes. Authorized
    //       with the existing-account matrix, and it takes BOTH directions:
    //         canAdministerUser(caller, currentRole) — may I act on this account at all?
    //         canAdministerUser(caller, role)        — may I confer THIS role on a live one?
    //       The second is the one that closes the exploit and the one that is easy to
    //       forget: canAdministerUser(FACILITATOR, PARTICIPANT) is TRUE, so the first check
    //       alone still lets a facilitator promote a participant's live account to
    //       FACILITATOR. USER_ADMIN_GRANTS.FACILITATOR omits FACILITATOR precisely so that
    //       the second check refuses it.
    //
    //   SELF-ACTION IS REFUSED in case (c), for parity with /access's GATE 2. It can only
    //   fire when the caller would be CHANGING their own role — self-promotion — because
    //   re-asserting their existing group takes case (a).
    //
    //   THE LAST-ADMIN GUARD IS DELIBERATELY ABSENT, and this is not the oversight the
    //   report took it for: /access needs it because a DISABLE can remove the final
    //   administrator. This path only ADDS a group, and a highest-precedence collapse means
    //   adding can only ever RAISE an effective role. It cannot reduce the number of enabled
    //   admins, so there is nothing for that guard to protect.
    //
    // FAIL CLOSED on an unreadable group list, exactly as /access does: a role we cannot
    // read is not a role we are permitted to act on, and the alternative is a bypass by
    // making Cognito unavailable.
    if (created.alreadyExisted) {
      let currentGroups: string[];
      try {
        currentGroups = await deps.directory.listGroups({
          username: email,
          signal: deps.deadline(),
        });
      } catch (err) {
        console.error(
          "[user-access] could not read an existing account's groups — refusing the group write",
          {
            errorName: errorName(err),
            error: err instanceof Error ? err.message : String(err),
            emailDomain: emailDomain(email),
            requestedBy: caller.id,
          }
        );
        return c.json(
          {
            error: "Could not verify that account's current role",
            code: "EXISTING_ACCOUNT_ROLE_UNVERIFIED",
          },
          502
        );
      }

      // CASE (a) — the group is already there. Checked against the RAW GROUP LIST rather
      // than the collapsed role: an account in both PARTICIPANT and FACILITATOR collapses to
      // FACILITATOR, and re-asserting PARTICIPANT there is genuinely a no-op even though the
      // collapsed role differs from `role`.
      if (!currentGroups.includes(role)) {
        // NULL, not a PARTICIPANT fallback — see roleFromGroups. Here that null is
        // MEANINGFUL rather than merely safe: it distinguishes case (b) from case (c).
        const currentRole = roleFromGroups(currentGroups);

        if (currentRole === null) {
          // CASE (b) — the ghost. Allowed on the forward matrix, and logged at INFO because
          // an operator repairing one wants to see that it happened.
          console.log(
            "[user-access] granting a role to an existing account that was in NO group (ghost repair)",
            {
              requestedBy: caller.id,
              callerRole: caller.role,
              requestedRole: role,
              emailDomain: emailDomain(email),
            }
          );
        } else {
          // CASE (c) — a real role change on a live account.
          if (sub && sub === caller.id) {
            return c.json(
              {
                error: "You cannot change your own platform role",
                code: "SELF_ACTION_REFUSED",
              },
              409
            );
          }

          // BOTH directions. See the case (c) note above for why the second is the one that
          // actually closes the escalation.
          if (
            !canAdministerUser(caller.role, currentRole) ||
            !canAdministerUser(caller.role, role)
          ) {
            // ERROR, not WARN: every product path reaches /provision for an address that has
            // no account, so a request that gets here and is refused is a direct call that
            // just tried to change a live account's role. The roles are logged and the
            // address is not — the same rule as everywhere else in this service.
            console.error(
              "[user-access] refused a role change on an EXISTING account — use the access surface",
              {
                requestedBy: caller.id,
                callerRole: caller.role,
                currentRole,
                requestedRole: role,
                emailDomain: emailDomain(email),
              }
            );
            return c.json(
              {
                error:
                  "That address already has an account, and your role cannot change an existing account's role",
                code: "EXISTING_ACCOUNT_FORBIDDEN",
              },
              403
            );
          }
        }

        // Authorized (case (b) or an allowed case (c)), and therefore AUDITED. A role grant
        // onto a live account must leave the same trail an enable/disable does; before this
        // it left one console.log line while /access wrote a row for a strictly smaller act.
        roleChangeOnExistingAccount = { previousRole: currentRole };
      }
    }

    // ── 3. The role group → the cognito:groups claim → the platform role. ──
    //
    // Reported in the response rather than only logged. This step failing is the
    // GHOST-ACCOUNT failure the whole change exists to remove: an account that can
    // sign in with no role. The caller must be able to tell a complete provisioning
    // from a partial one, because a partial one means "email them anyway, then
    // re-invite to repair" and the operator deserves to know which they got.
    let groupAssigned = true;
    try {
      await deps.directory.addToGroup({
        username: email,
        group: role,
        signal: deps.deadline(),
      });
    } catch (err) {
      groupAssigned = false;
      console.error("[user-access] group assignment failed", {
        role,
        errorName: errorName(err),
        error: err instanceof Error ? err.message : String(err),
        emailDomain: emailDomain(email),
      });
    }

    // ── 3b. THE TRAIL, for a role change on a LIVE account. ──────────────────────────────
    //
    // Only when a live account's role actually CHANGED — a fresh create is already fully
    // described by the provisioning log line, and a no-op re-assert changed nothing to
    // record. Written AFTER the group call and only when it succeeded, so the entry records
    // an act that happened rather than one that was attempted.
    //
    // `audited` travels in the response for the same reason /access reports it: an
    // unrecorded privilege change is worth an alarm, and the caller is the only one who can
    // see both halves. `record` never throws into the happy path (see AuditRepository).
    let roleChangeAudited: boolean | undefined;
    if (roleChangeOnExistingAccount && groupAssigned) {
      const previousRole = roleChangeOnExistingAccount.previousRole;
      if (sub) {
        roleChangeAudited = await deps.audit.record({
          subjectId: sub,
          action: "ROLE_GRANTED",
          actorId: caller.id,
          actorRole: caller.role,
          // The FROM and TO of the change, in the one free-text field the shape has. Not a
          // new column: the trail is append-only and shared with the team service's writer,
          // so a field only this writer sets would be absent on every other row.
          reason: normalizeAuditReason(
            `Role group ${role} added to an existing account (was ${previousRole ?? "no recognised group"})`
          ),
        });
      } else {
        // No sub means no partition key, so there is nowhere to write the entry — the
        // subject of an audit row IS the sub. Loud, because this is the one case where a
        // privilege change on a live account leaves no row.
        roleChangeAudited = false;
      }
      if (!roleChangeAudited) {
        console.error(
          "[user-access] a role change on an existing account was NOT recorded in the audit trail",
          {
            requestedBy: caller.id,
            callerRole: caller.role,
            previousRole,
            requestedRole: role,
            subjectResolved: !!sub,
            emailDomain: emailDomain(email),
          }
        );
      }
      // The same access-audit datapoint /access emits, so one alarm covers both writers.
      // Emitted INSIDE the real-change branch, which is the documented condition on this
      // helper: a no-op re-assert must not page anyone.
      emitAccessAuditMetric({
        action: "ROLE_GRANTED",
        audited: roleChangeAudited,
        subjectId: sub ?? "unresolved",
        actorId: caller.id,
        source: "user-access",
      });
    }

    // ── 4. The profile row, so the platform can SEE the account. ──
    // A merge, never a clobber — see DynamoProfileStore.upsertProvisioned. Skipped
    // when we have no sub, because a row under a synthetic key is worse than none:
    // it is unreachable by /me and shows up in the Administration list as an account
    // no admin API can act on.
    let profileWritten = false;
    if (sub) {
      try {
        await deps.profiles.upsertProvisioned({ id: sub, email, role });
        profileWritten = true;
      } catch (err) {
        console.error("[user-access] profile write failed", {
          errorName: errorName(err),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 5. user.created, so the five read-models sync. ──
    // Awaited, not fired and forgotten: an unobserved rejection here is a
    // read-model that silently never learns about the user. Its failure is logged and
    // does not fail the request — the row is the source of truth and a consumer can
    // be replayed.
    if (sub && profileWritten) {
      try {
        await deps.events.publishUserCreated({ id: sub, email, role });
      } catch (err) {
        console.error("[user-access] user.created publish failed", {
          errorName: errorName(err),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // One audit line per provisioning. Identifiers and the role only — never the
    // password, and not the local part of the address.
    console.log("[user-access] provisioned account", {
      role,
      alreadyExisted: created.alreadyExisted,
      groupAssigned,
      profileWritten,
      requestedBy: caller.id,
      emailDomain: emailDomain(email),
    });

    return c.json({
      // The ONE place this value is ever readable. See the route's header comment.
      temporaryPassword,
      role,
      /** True when the account was already there — a benign re-invite. */
      alreadyExisted: created.alreadyExisted,
      /**
       * False means the account exists but has NO ROLE. The caller should surface
       * that rather than reporting a clean success: the person can sign in and will
       * be refused a session by the role gate.
       */
      groupAssigned,
      profileWritten,
      /**
       * Present ONLY when this request changed a LIVE account's role — i.e. the account
       * already existed and was not already in the group. Absent on every fresh create and
       * on every no-op re-assert, so its presence alone tells the caller that a privilege
       * change happened on somebody's existing account.
       *
       * False means that change went UNRECORDED, which is the alarm's datapoint and worth
       * surfacing rather than swallowing — the same contract /access reports `audited` on.
       */
      ...(roleChangeAudited === undefined
        ? {}
        : { existingAccountRoleChanged: true, audited: roleChangeAudited }),
    });
  });

  /**
   * POST /v1/user-access/access — DISABLE or RE-ENABLE a person's platform access.
   *
   * Body: `{ userId, enabled, reason? }`. `userId` is the target's Cognito sub, which
   * is what the Administration directory lists and what every per-user record is keyed
   * on.
   *
   * ── THE MECHANISM, AND WHY IT IS COGNITO AND NOT A FLAG ──
   * AdminDisableUser / AdminEnableUser. Cognito refuses to issue tokens and refuses the
   * refresh grant for a disabled account, which is what actually stops somebody getting
   * in. The `status` attribute this route also writes onto the profile row is a DISPLAY
   * MIRROR and nothing enforces on it — see the field's doc comment in
   * the shared types/user module, which spells out why making it an authz input
   * would turn two harmless display bugs into two access bugs.
   *
   * RESIDUAL WINDOW, stated because it is not fixable here: a native JWT authorizer
   * validates a token offline and never consults Cognito, so an ALREADY-ISSUED token
   * keeps working until it expires (up to IdTokenValidity, 30 minutes; ~60s in the
   * portal, which revalidates its session). Shortening that means shortening the token
   * lifetime, not adding a per-request Cognito call to every route.
   *
   * ── THE THREE GATES, ALL ENFORCED HERE ──
   * This service is the boundary. The portal's tRPC layer is a BFF: every service route
   * is mapped ANY behind a JWT authorizer that does no role scoping, and the browser
   * holds its own ID token — so a check that lives only in the BFF is advisory. The
   * tRPC procedure keeps a copy as defence in depth; THIS is the one that cannot be
   * bypassed.
   *
   *   1. canAdministerUser(callerRole, TARGET'S CURRENT ROLE). The target's role is
   *      read from COGNITO GROUPS, never from the body — taking it from the request
   *      would make the matrix bypassable by a facilitator simply claiming their victim
   *      is a participant. Fails closed on an unknown role on either side.
   *   2. NO SELF-ACTION. An administrator must not lock themselves out.
   *   3. NEVER THE LAST ENABLED ADMIN. That leaves the platform with nobody able to
   *      administer it, and nobody able to undo it — a FACILITATOR may not act on an
   *      ADMIN, so the disable would be irreversible from the product.
   *
   * Guards 2 and 3 are named as the caller's responsibility by USER_ADMIN_GRANTS
   * itself, because the pure predicate cannot see either piece of state.
   *
   * ── THE ORDER OF EFFECTS, AND WHY ──
   *   1. Cognito disable/enable — the enforcement. Nothing else happens if it fails,
   *      because everything after it is bookkeeping ABOUT it.
   *   2. Revoke pending invitations (on DISABLE only) — see below.
   *   3. Mirror `status` onto the profile row, so the screen can show it.
   *   4. Audit.
   * Steps 2-4 are each best-effort and REPORTED rather than allowed to fail the
   * request: by then access has already changed, and a retry would report a confusing
   * second outcome for an operation that took effect the first time.
   *
   * ── WHY DISABLING REVOKES PENDING INVITATIONS ──
   * An unredeemed invitation is a LIVE CREDENTIAL: left in place, the
   * disabled person can register again through the invite-only gate and get a BRAND-NEW
   * Cognito sub — at which point every record keyed on the old sub, this disable
   * included, no longer applies to them. The same class of bypass is documented in full
   * on cognito-presignup/src/handler.ts (the `isAccepted` note). Re-enabling deliberately
   * does NOT resurrect them: re-admission is an explicit act, i.e. a fresh invitation.
   *
   * ── IDEMPOTENT ──
   * Disabling an already-disabled account SUCCEEDS. Cognito's own calls are idempotent,
   * a revoke of an already-deleted row is a benign false, and the mirror write is a
   * plain SET — so a double-click, a client retry or an at-least-once delivery converge
   * on the same state rather than a 409.
   */
  app.post("/access", async (c) => {
    const { id: actorId, role: actorRole } = requireIdentity(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "a JSON body is required" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "a JSON object body is required" }, 400);
    }
    const raw = body as Record<string, unknown>;

    const userId =
      typeof raw.userId === "string" && raw.userId.length <= MAX_RAW_USER_ID_LENGTH
        ? raw.userId.trim()
        : "";
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    // A STRICT boolean. Not `!!raw.enabled`, which would read a missing field, a typo'd
    // key, or the string "false" as a valid instruction — and the two directions of this
    // operation are not interchangeable, so a request that does not say which it means
    // must be refused rather than defaulted.
    if (typeof raw.enabled !== "boolean") {
      return c.json({ error: "enabled must be true or false" }, 400);
    }
    const enabled = raw.enabled;

    if (typeof raw.reason === "string" && raw.reason.length > MAX_RAW_REASON_LENGTH) {
      return c.json({ error: "reason is too long" }, 400);
    }
    // Trimmed, length-capped in CODE POINTS, and whitespace-only collapsed away. A
    // non-string is simply absent rather than coerced.
    const reason = normalizeAuditReason(raw.reason);

    // ── GATE 2, FIRST: no self-action. ──
    // Checked before any lookup because it needs none, and because an administrator who
    // clicks the wrong row deserves the specific answer rather than one that arrives
    // after three Cognito calls.
    if (userId === actorId) {
      return c.json(
        {
          error: "You cannot change your own platform access",
          code: "SELF_ACTION_REFUSED",
        },
        409
      );
    }

    // ── The TARGET, resolved server-side. ──
    // One read supplies everything the decision needs: the handle Cognito's admin APIs
    // address the account by, the email whose invitations must be revoked, and the
    // CURRENT enabled state. None of it comes from the request.
    let account;
    try {
      account = await deps.directory.findByUserId({
        userId,
        signal: deps.deadline(),
      });
    } catch (err) {
      // FAIL CLOSED. A lookup we cannot make is not permission to act: the alternative
      // would be a way to skip the role check by making Cognito unavailable.
      console.error("[user-access] target lookup failed", {
        errorName: errorName(err),
        error: err instanceof Error ? err.message : String(err),
        requestedBy: actorId,
      });
      return c.json({ error: "Could not look up that account" }, 502);
    }

    if (!account) {
      // Either a sub with no Cognito account (the post-confirmation trigger's
      // `sub || ulid()` fallback produces exactly these rows — see hasCognitoAccount in
      // the identity service, which marks them non-actionable in the UI) or an account
      // deleted directly in the console. Both are genuinely absent, and there is no
      // enumeration concern: the caller has already passed the directory gate.
      return c.json({ error: "No account for that user" }, 404);
    }

    // ── GATE 1: the ROLE matrix, against the target's CURRENT role from Cognito. ──
    let groups: string[];
    try {
      groups = await deps.directory.listGroups({
        username: account.username,
        signal: deps.deadline(),
      });
    } catch (err) {
      console.error("[user-access] target role lookup failed", {
        errorName: errorName(err),
        error: err instanceof Error ? err.message : String(err),
        requestedBy: actorId,
      });
      // Fail closed, for the same reason as the lookup above: an unreadable role is not
      // a role we are permitted to act on.
      return c.json({ error: "Could not verify that account's role" }, 502);
    }

    // NULL, not a PARTICIPANT fallback — see roleFromGroups. An account in no
    // recognisable group is refused rather than treated as the least privileged, because
    // here the least-privileged guess is the DANGEROUS one.
    const targetRole = roleFromGroups(groups);
    if (!canAdministerUser(actorRole, targetRole)) {
      // Worth a log line: the UI hides the control for these combinations, so a request
      // that reaches here is either a stale screen or somebody probing the matrix. The
      // target's role IS logged — an operator investigating a refusal cannot do it
      // without knowing which rule fired.
      console.warn("[user-access] refused an access change the role matrix forbids", {
        actorId,
        actorRole,
        subjectId: userId,
        targetRole,
      });
      return c.json(
        { error: "Forbidden: your role cannot change this user's access" },
        403
      );
    }

    // ── GATE 3: never the last enabled ADMIN. ──
    // Only on DISABLE, and only when the target IS an admin — the other combinations
    // cannot reduce the number of enabled admins, and asking anyway would put a
    // group-listing call on every ordinary participant disable.
    if (!enabled && targetRole === "ADMIN") {
      let hasOther: boolean;
      try {
        hasOther = await deps.directory.hasOtherEnabledAdmin({
          excludingUsername: account.username,
          signal: deps.deadline(),
        });
      } catch (err) {
        // FAIL CLOSED, and this is the most important of the three: proceeding on an
        // unanswered "is anyone else able to administer this platform?" is how the
        // platform becomes unadministrable. A refusal is recoverable; the lockout is not
        // recoverable from within the product.
        console.error("[user-access] last-admin check failed — refusing the disable", {
          errorName: errorName(err),
          error: err instanceof Error ? err.message : String(err),
          requestedBy: actorId,
        });
        return c.json(
          { error: "Could not verify that another administrator remains" },
          503
        );
      }

      if (!hasOther) {
        return c.json(
          {
            error:
              "This is the last administrator with access — grant another admin first",
            code: "LAST_ADMIN_REFUSED",
          },
          409
        );
      }
    }

    // ── 1. THE ENFORCEMENT. Everything below is bookkeeping about this. ──
    try {
      await deps.directory.setEnabled({
        username: account.username,
        enabled,
        signal: deps.deadline(),
      });
    } catch (err) {
      // A TimeoutError/AbortError from the deadline lands here and reads correctly as
      // "could not change": the call may or may not have applied, so nothing below runs
      // and the operator retries. The retry is safe because both Cognito calls are
      // idempotent.
      console.error("[user-access] access change failed", {
        errorName: errorName(err),
        error: err instanceof Error ? err.message : String(err),
        subjectId: userId,
        requestedBy: actorId,
      });
      return c.json({ error: "Could not change that account's access" }, 502);
    }

    // ── 2. Revoke the live invitations, ON DISABLE ONLY. ──
    // See the route header: an unredeemed invitation is a live credential and would let
    // a disabled person re-register under a new sub. Re-enabling does NOT restore them.
    let invitationsRevoked = 0;
    let invitationsRevokeComplete = true;
    if (!enabled) {
      const outcome = await revokeLiveInvitations(deps, account.email, userId);
      invitationsRevoked = outcome.revoked;
      invitationsRevokeComplete = outcome.complete;
    }

    // ── 3. The DISPLAY MIRROR, so the Administration screen can render the badge. ──
    // Never an authorization input. A failure here is a stale badge, not an access bug,
    // which is exactly why the mirror is allowed to be best-effort at all.
    let statusMirrored = false;
    try {
      statusMirrored = await deps.profiles.setStatus({
        userId,
        status: enabled ? "ACTIVE" : "DEACTIVATED",
        // WHO, onto the row — see the port's contract. This write happens BEFORE the audit
        // call below, and in the same UpdateCommand as the status, so the operator's
        // identity survives an audit failure instead of existing only in the entry that
        // did not get written. It is forensics and display only; nothing authorizes on it.
        actorId,
      });
      if (!statusMirrored) {
        // A conditional-check miss: the Cognito account has no profile row. Logged at
        // warn rather than error — it is a real inconsistency, but the access change
        // stands and the row is recreated by the next provisioning or profile save.
        console.warn("[user-access] no profile row to mirror the access change onto", {
          subjectId: userId,
        });
      }
    } catch (err) {
      console.error("[user-access] status mirror write failed", {
        errorName: errorName(err),
        error: err instanceof Error ? err.message : String(err),
        subjectId: userId,
      });
    }

    // ── 4. WHO DID THIS. ──
    // AWAITED but never allowed to fail the operation, mirroring the team service's
    // removal route exactly: access has already changed in Cognito and the invitations
    // are already gone, so throwing here would have the operator retry a completed
    // action. The repository logs and returns false; `audited` tells the caller what is
    // known. A false is worth an alarm — it means an access change happened with no
    // record of who made it.
    const action = enabled ? "ACCESS_ENABLED" : "ACCESS_DISABLED";
    const audited = await deps.audit.record({
      subjectId: userId,
      action,
      actorId,
      actorRole,
      reason,
    });

    /**
     * Whether THIS call actually changed the account's state, read off the state Cognito
     * reported BEFORE the setEnabled above. False means the account was already in the
     * requested state — a duplicate request, which succeeds by design.
     *
     * Hoisted out of the log line below because the metric now needs the same value, and
     * two independent expressions for "did anything change" is how they drift apart.
     */
    const changed = account.enabled !== enabled;

    // THE ALARM. `audited: false` here means platform sign-in access was withdrawn or
    // restored with no entry in the trail saying who did it.
    //
    // ── RECOVERABLE NOW, AND IT WAS NOT BEFORE ──
    //
    // This comment used to end "and unlike the team routes this is UNRECOVERABLE", because
    // the mirror write stamped no actor and Cognito records none beyond CloudTrail, so the
    // audit entry was the only place the operator's identity existed — an unaudited disable
    // was permanently unattributable. Step 3 above now writes `accessChangedBy` /
    // `accessChangedAt` onto the profile row, in the same UpdateCommand as the status and
    // BEFORE this audit call, so the identity survives the trail failing. The team routes
    // already worked this way (`removedBy` / `reactivatedBy` on the membership row); this
    // path was the odd one out.
    //
    // The alarm still matters and still fires: the row holds only the MOST RECENT actor, so
    // it answers "who put the account in the state it is in now" and not "what happened".
    // A lost entry is still a hole in the history — it is just no longer an anonymous one.
    // The remaining unrecoverable case is a lost entry whose row was later overwritten by a
    // subsequent change, which is why the signal is worth acting on promptly.
    //
    // GUARDED ON `changed`, matching the team routes: a re-issued disable of an
    // already-disabled account changed nothing, so an unrecorded one is not a lost fact
    // about anybody's access. Note this differs from the audit WRITE, which is deliberately
    // unconditional here — the trail records the operator's ACT (they asked for this, and
    // an attempt is worth recording) while the alarm reports a lost FACT. Only the second
    // needs the guard, and conflating them would page on a double-clicked toggle.
    //
    // Written as an explicit "was a fact lost" rather than a terser boolean expression: the
    // whole defect being closed is a subtle reading of what `audited: false` means, and a
    // reader must be able to see which of the two meanings this branch is reporting.
    const factLost = changed && !audited;
    emitAccessAuditMetric({
      action,
      // NOT the raw `audited`. On an unchanged call there was nothing to lose, so the
      // SUCCESS datapoint is what gets emitted — the metric still exists in a healthy
      // account, and "no data" stays distinguishable from "no failures".
      audited: !factLost,
      subjectId: userId,
      actorId,
      source: "user-access",
    });

    // One line per access change. Identifiers, roles and counts only — never the reason
    // text, which is operator free-text and may name a person, and never the address.
    console.log("[user-access] platform access changed", {
      subjectId: userId,
      targetRole,
      enabled,
      // False means the account was ALREADY in the requested state — a duplicate
      // request, which succeeds by design. Worth recording so a repeated click is
      // distinguishable from a real change when reading the log.
      changed,
      invitationsRevoked,
      statusMirrored,
      audited,
      actorId,
      actorRole,
    });

    return c.json({
      userId,
      enabled,
      /**
       * How many LIVE invitations were destroyed. Always 0 on an enable — re-admission
       * is a deliberate act (a fresh invitation), never a side effect of restoring
       * access to an account.
       */
      invitationsRevoked,
      /**
       * False when the revoke ran out of its bound or hit a store failure, so some live
       * invitation may survive. Surfaced rather than folded into the count: the whole
       * point of the revoke is that no un-redeemed credential is left behind, and an
       * operator withdrawing access needs to know when that is not guaranteed.
       */
      invitationsRevokeComplete,
      /** False means the access change is real but the screen's badge may lag. */
      statusMirrored,
      /**
       * False means the change HAPPENED and is UNRECORDED. Worth an alarm; not a
       * failure, because the change cannot be undone by refusing to report it.
       */
      audited,
    });
  });

  return app;
}

/**
 * Delete every LIVE invitation for an address — the revoke-on-disable step.
 *
 * Extracted so the route body stays readable, and returns BOTH the count and whether
 * the sweep was complete. Never throws: by the time it runs, Cognito has already
 * disabled the account, and a failure here must degrade into a reported partial rather
 * than a 500 on an operation that took effect.
 *
 * BOUNDED at MAX_INVITATIONS_REVOKED and issued SEQUENTIALLY. The bound is on stored
 * data rather than on the request, which is what makes it worth having: an address
 * invited to hundreds of teams would otherwise turn one disable into hundreds of
 * deletes and exhaust the function's timeout, leaving the account disabled in Cognito
 * with the operator looking at a failure.
 */
async function revokeLiveInvitations(
  deps: Pick<UserAccessDeps, "invitations">,
  email: string,
  subjectId: string
): Promise<{ revoked: number; complete: boolean }> {
  if (!email) {
    // No address on the Cognito account, so there is no key to look invitations up by.
    // Reported as INCOMPLETE rather than as a clean zero: we did not establish that
    // none exist, and "we could not check" must not read as "there were none".
    console.warn("[user-access] cannot revoke invitations — the account has no email", {
      subjectId,
    });
    return { revoked: 0, complete: false };
  }

  let rows;
  try {
    rows = await deps.invitations.listByEmail(email);
  } catch (err) {
    console.error("[user-access] invitation lookup failed during revoke", {
      errorName: errorName(err),
      error: err instanceof Error ? err.message : String(err),
      subjectId,
    });
    return { revoked: 0, complete: false };
  }

  // Un-expired AND unredeemed only. An ACCEPTED row is the audit record of a grant
  // somebody already redeemed — deleting it would destroy that record without removing
  // any access, since by then their access lives in Cognito.
  const { keys, unaddressable } = liveInvitationKeys(rows, Date.now());
  const capped = keys.slice(0, MAX_INVITATIONS_REVOKED);

  let revoked = 0;
  // Complete only if nothing was dropped by the bound AND no live row was missing half
  // of its composite key. Both leave a live credential in place, which is precisely what
  // this step exists to remove.
  let complete = capped.length === keys.length && unaddressable === 0;

  for (const key of capped) {
    try {
      if (await deps.invitations.revoke(key.teamId, key.email)) revoked++;
      // A false is BENIGN and does not spoil completeness: the row was already gone,
      // which is the same end state and is what makes a repeated disable idempotent.
    } catch (err) {
      complete = false;
      console.error("[user-access] could not revoke an invitation", {
        errorName: errorName(err),
        error: err instanceof Error ? err.message : String(err),
        subjectId,
        teamId: key.teamId,
      });
    }
  }

  if (!complete) {
    // Loud, because the guarantee this step exists to provide has not been met: a live
    // invitation may still admit a re-registration under a new sub.
    console.error(
      "[user-access] the invitation revoke was INCOMPLETE — a live invitation may remain",
      { subjectId, revoked, live: keys.length }
    );
  }

  return { revoked, complete };
}

/** An error's `name`, which is the stable contract on an AWS SDK error. */
function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : "";
}

/**
 * The DOMAIN half of an address, for log lines.
 *
 * An invitee's full address is personal data and there is no reason for it to sit in
 * CloudWatch: the domain is enough to tell "our own test accounts" from "a customer's
 * users" when reading a failure, and the caller's id is already logged for
 * correlation. Returns "" rather than the raw value when there is no @ to split on,
 * so a malformed input cannot leak through this function.
 */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}
