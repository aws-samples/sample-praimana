import { Hono } from "hono";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  routeTemplate,
  type SendQuota,
} from "@praimana/service-shared";
import {
  MAX_FEEDBACK_MESSAGE,
  MAX_FEEDBACK_SUBJECT,
  checkFeedbackReport,
} from "@praimana/shared";
import {
  PROFILE_FIELDS,
  canManageUsers,
  canSeePlatformSpend,
  canSeeUser,
  displayName,
  normalizeProfileField,
  validateProfile,
  visibleRolesFor,
} from "@praimana/service-shared";
import { ulid } from "ulid";
import {
  toAdminUser,
  toPublic,
  toUserRole,
  toVisibleReport,
  type FeedbackNotifier,
  type FeedbackRepository,
  type CostReader,
  type PlatformHealthReader,
  type User,
  type UserRepository,
} from "./domain.js";

/**
 * Identity service routes.
 *
 * Authentication moved to native Amazon Cognito: Cognito owns credentials, MFA,
 * and token issuance, and the platform ROLE lives in Cognito Groups
 * (cognito:groups claim). The old email/password register + login endpoints (and
 * the bcrypt hashing + HS256 SignJWT that backed them) were removed — this
 * service no longer mints tokens.
 *
 * What remains: this service owns the users PROFILE store. The profile row is
 * written by the Cognito post-confirmation trigger; here we expose read access
 * to the caller's own profile. Identity is derived from the gateway (Cognito
 * JWT) via edgeIdentityMiddleware — no token parsing here.
 */
export interface IdentityDeps {
  users: UserRepository;
  /**
   * Feedback and bug reports.
   *
   * OPTIONAL so this service still composes where it is not wired, and so the existing tests need no new
   * fake. The routes answer 503 rather than throwing when it is absent — the honest answer for "this
   * deployment cannot do that", as distinct from "you may not".
   */
  feedback?: FeedbackRepository;
  /**
   * Per-reporter send accounting for POST /v1/auth/feedback. OPTIONAL for the same reason as
   * `feedback` and `notifier`: this service still composes where it is not wired, and the existing
   * tests need no new fake.
   *
   * ⚠ WHY IT IS METERED *HERE* AND NOT ONLY IN notify. This route reaches notify by DIRECT LAMBDA
   * CALL with a synthesised `{ id: "system", role: "ADMIN" }` identity, so notify's own per-sender
   * quota would meter every reporter on the platform against ONE bucket called "system" — one
   * person could exhaust it for everybody, and nobody would be attributable. The real caller is
   * only knowable at this end. (A security finding, medium: /v1/auth/feedback reached the same
   * SES sink through a synthesised ADMIN identity.)
   */
  feedbackQuota?: SendQuota;
  /**
   * Tells staff a report arrived. OPTIONAL: without it a report is still stored and still visible in the
   * inbox — the notification is an addition to the record, never a precondition for it.
   */
  notifier?: FeedbackNotifier;
  /**
   * Reads platform health (CloudWatch alarm states).
   *
   * OPTIONAL for the same reason as the two above: the service must still compose where it is not wired, and
   * the route answers 503 — "this deployment cannot tell you" — rather than throwing or, far worse, claiming
   * everything is fine.
   */
  health?: PlatformHealthReader;
  /**
   * What the platform costs to run. OPTIONAL, same contract as the two above: absent ⇒ 503, never a zero.
   */
  cost?: CostReader;
}

/**
 * Cap on a report's message.
 *
 * ⚠ RE-EXPORTED FROM THE SHARED PACKAGE, NOT DECLARED HERE — and it WAS declared here, as a second
 * `= 8_000`. Two literals with the same value is the drift `shared/constants/support.test.ts`
 * says is impossible ("the form's maxLength, the BFF's zod check and the service's refusal all read this
 * one number"); it was only true of three of the four. Editing the shared one would have moved the form and
 * left the refusal behind, so a reporter would be invited to write more than the service stores.
 *
 * The name stays exported because it is part of this module's surface already.
 */
export { MAX_FEEDBACK_MESSAGE };

/** How many reports one Administration page load may pull. Clamped in the repository as well. */
const MAX_FEEDBACK_PAGE = 100;

/**
 * Every ADMIN and FACILITATOR email, for the new-report notification.
 *
 * ⚠ BOUNDED, AND THE BOUND IS THE INTERESTING PART. It reads ONE page of users rather than walking the
 * cursor: staff accounts are a handful on any real deployment, and an unbounded walk on a report-filing
 * path would let the slowest possible read sit between a participant pressing Send and getting an answer.
 * If a deployment ever had more staff than one page, the honest consequence is that some are not emailed —
 * and the report is still stored and still in the inbox, which is why that is acceptable and why it is
 * written down rather than left to be discovered.
 *
 * ⚠ NEVER THROWS. A failed user read must not fail the report; it degrades to "nobody was emailed".
 */
/**
 * ── ⚠ GROUPED BY ROLE, BECAUSE ONE SHARED `To:` HEADER LEAKS ACROSS TIERS ────────────────────
 *
 * A SECURITY FINDING (low): the feedback notification exposed every ADMIN's email address to
 * FACILITATOR recipients through the shared SES To: header, contrary to the directory
 * visibility matrix.
 *
 * This returned ONE flat list of both roles, which became a single SES send with every address in
 * Destination.ToAddresses — so every facilitator read every admin's address out of the header.
 * That is the exact fact USER_VISIBILITY_GRANTS.FACILITATOR withholds: it lists FACILITATOR,
 * JUDGE, EXECUTIVE and PARTICIPANT and omits ADMIN, because "a facilitator has no business
 * enumerating who holds full platform access. Knowing WHICH accounts are the valuable ones to
 * phish or socially engineer is itself the reconnaissance step."
 *
 * ⚠ THE NOTIFIER ALREADY HONOURED THAT RULE IN THE BODY — it withholds the reporter's address
 * when canSeeUser("FACILITATOR", reportedByRole) is false, described in its own comment as
 * closing "the SECOND CHANNEL of the inbox disclosure". The header was the first channel, still
 * open.
 *
 * ⚠ AND THE FIX IS ONE SEND PER AUDIENCE, NOT Bcc. Bcc would have meant changing notify's
 * transport for every caller — invitations included, which are single-recipient and legitimately
 * addressed — and "undisclosed recipients" changes how mail clients and filters treat a branded
 * platform email. Splitting the send keeps every recipient list inside one visibility tier, which
 * is what the matrix actually asks for: admins may see admins, and facilitators may see
 * facilitators (USER_VISIBILITY_GRANTS.FACILITATOR includes FACILITATOR). Two SES calls instead
 * of one, on a staff-sized list.
 */
async function staffEmailsByRole(
  users: UserRepository
): Promise<Array<{ role: string; emails: string[] }>> {
  try {
    const page = await users.list({ limit: MAX_FEEDBACK_PAGE, visibleRoles: ["ADMIN", "FACILITATOR"] });
    const groups = new Map<string, string[]>();
    for (const u of page.users) {
      const email = u.email;
      if (typeof email !== "string" || !email.includes("@")) continue;
      // A row whose role is missing or unexpected goes in its own bucket rather than being
      // folded into either tier: mixing it with admins would disclose them, and mixing it with
      // facilitators would guess. Its own send discloses nobody.
      const role = typeof u.role === "string" && u.role ? u.role : "UNKNOWN";
      const bucket = groups.get(role);
      if (bucket) bucket.push(email);
      else groups.set(role, [email]);
    }
    return [...groups.entries()].map(([role, emails]) => ({ role, emails }));
  } catch {
    return [];
  }
}

/**
 * Cap on how many ids one request may hydrate or resolve.
 *
 * Matches BatchGetItem's own 100-key limit, so a request that would need chunking is
 * refused rather than quietly turning into several round-trips. It is also a real
 * bound on the work an authenticated caller can ask for by typing a longer URL.
 */
const MAX_HYDRATE_IDS = 100;

export function createIdentityRoutes(deps: IdentityDeps) {
  const identity = new Hono().basePath("/v1/auth");

  // Public discovery — NO identity required. The front-ends (notably the desktop
  // app, which connects to an arbitrary server URL and has no baked-in auth
  // config) fetch this to bootstrap the Cognito Hosted UI OAuth flow: the issuer,
  // the app client id, and the Hosted UI domain. Registered BEFORE the edge
  // middleware so it stays unauthenticated; the matching HttpApi route sets
  // Authorizer: NONE. Values come from env wired in the SAM template.
  identity.get("/config", (c) => {
    return c.json({
      issuer: process.env.COGNITO_ISSUER || "",
      clientId: process.env.COGNITO_CLIENT_ID || "",
      hostedUiDomain: process.env.COGNITO_HOSTED_UI_DOMAIN || "",
      // OAuth2 authorization-code + PKCE is the flow both front-ends use.
      scopes: ["openid", "email", "profile"],
      /**
       * ⚠ THERE IS NO `supportEmail` HERE ANY MORE, AND THAT IS THE POINT OF THE CHANGE.
       *
       * It was added so the desktop could build a `mailto:` for its profile-menu links, and
       * removed when reports moved into the database and the platform began emailing
       * staff itself. No client needs a support address now — there is nothing for a
       * client to address.
       *
       * Recorded rather than silently dropped because ADDING a field to this UNAUTHENTICATED route is a
       * decision (see the exact-shape test in routes.test.ts, which is what forces that conversation), and a
       * reader finding the field in git history should know it was withdrawn deliberately rather than lost.
       */
    });
  });

  // Every request past here carries a Cognito-verified identity injected at the edge.
  identity.use("*", edgeIdentityMiddleware());

  // The caller's own profile (name/org/role). Role is authoritative from the
  // token's group claim; the stored row carries display fields.
  identity.get("/me", async (c) => {
    const { id, email, role } = requireIdentity(c);
    const user = await deps.users.getById(id);
    if (!user) {
      // No profile row yet (e.g. post-confirmation trigger hasn't landed) —
      // fall back to the verified token claims so the caller still gets identity.
      // profileComplete is false, which is both true and useful: the caller is
      // sent to the profile form, and PATCH /me below will create the row.
      return c.json({ user: { id, email, role, profileComplete: false } });
    }
    return c.json({ user: toPublic(user) });
  });

  // Update the caller's OWN profile — first name, last name, organisation.
  //
  // This is the real gate on those three fields being present, not the sign-up
  // form: a client can always skip the form and call this endpoint directly, so
  // validation here is the control and validation in the form is only courtesy.
  // Both use validateProfile() from @praimana/shared so they cannot drift —
  // if they did, a user could be bounced to a form that then refuses to save.
  //
  // Deliberately NOT patchable here: `email` (Cognito owns it, and changing it
  // would break the invitation → role lookup) and `role` (authoritative from the
  // token's cognito:groups claim — accepting it from a body would be privilege
  // escalation by request). `name` is derived, never accepted.
  identity.patch("/me", async (c) => {
    const { id, email, role } = requireIdentity(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "a JSON body is required" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "a JSON object body is required" }, 400);
    }

    // Read only the three known keys. Anything else in the body is ignored rather
    // than merged, so no client can write an arbitrary attribute onto the row.
    const raw = body as Record<string, unknown>;
    const submitted: Record<string, string> = {};
    for (const field of PROFILE_FIELDS) {
      const value = raw[field.key];
      // A non-string (number, object, null) is treated as absent so it fails
      // validation with a clear message instead of being coerced into the row.
      submitted[field.key] =
        typeof value === "string" ? normalizeProfileField(value) : "";
    }

    const errors = validateProfile(submitted);
    if (Object.keys(errors).length > 0) {
      return c.json({ error: "invalid profile", fields: errors }, 400);
    }

    const existing = await deps.users.getById(id);
    const now = new Date().toISOString();

    // ── ⚠ AN EDIT IS AN UPDATE; ONLY A CREATE IS A PUT ─────────────────────────
    //
    // This route used to build a complete `User` and persist it with `users.put` on BOTH paths.
    // A DynamoDB Put REPLACES the item, so every attribute not restated above was deleted — and
    // although the old comment here shows the author knew that rule and carried `status`,
    // `email`, `role`, `authProvider` and `createdAt` through, attributes were still dropped
    // on every profile save: `accessChangedBy`, `accessChangedAt` (user-access's own forensic
    // breadcrumb for who disabled an account, written straight onto this row) and `avatarUrl`
    // (declared on the shared User type).
    //
    // The list-what-changes shape is the fix rather than a longer list-what-survives: three
    // services write to this row, so any enumeration of attributes to preserve is a bug waiting
    // for the next writer. See UserRepository.updateProfile.
    const profile = {
      firstName: submitted.firstName,
      lastName: submitted.lastName,
      organization: submitted.organization,
      // Derived, so `name` can never disagree with the parts it is built from.
      name: displayName(submitted),
      updatedAt: now,
    };

    if (existing) {
      const saved = await deps.users.updateProfile(id, profile);
      return c.json({ user: toPublic(saved) });
    }

    // ── THE CREATE. A full-item Put is CORRECT here: there is no row, so there is nothing to
    //    preserve, and every field the type requires has to be established.
    //
    // We create rather than 404 because there is a real window right after confirmation where
    // the post-confirmation trigger hasn't landed (or failed soft, as it is deliberately designed
    // to), and the user is standing in front of the profile form; refusing would leave them
    // permanently stuck at the completion gate with no way forward.
    //
    // Written field by field rather than by spreading the request, so adding a column to User can
    // never silently become client-writable.
    const next: User = {
      id, // the caller's own sub, from the verified identity
      // Cognito owns the email. The token claim is all there is on a create; never the body.
      email: email ?? "",
      // Authoritative from the token's cognito:groups claim.
      role: toUserRole(role),
      ...profile,
      authProvider: "COGNITO",
      createdAt: now,
    };

    const saved = await deps.users.put(next);
    return c.json({ user: toPublic(saved) });
  });

  /**
   * Administration surface — reading OTHER people's accounts, under its own
   * basePath rather than beside /v1/auth/me.
   *
   * The split is intentional. Everything under /v1/auth is "the caller acting on
   * themselves", which is why /me can safely take its subject from the token and
   * ignore the body entirely. /v1/admin is the opposite: the subject is someone
   * else, so every route here needs a privilege check that /v1/auth routes do not.
   * Keeping them in separate routers means a new route cannot land in the
   * self-service group and silently inherit no authorization at all.
   */
  const admin = new Hono().basePath("/v1/admin");

  admin.use("*", edgeIdentityMiddleware());

  // The role gate for the WHOLE admin surface, applied as middleware so it cannot
  // be forgotten on a route added later — the failure mode of a per-route check is
  // that the one route someone forgets is wide open.
  //
  // canManageUsers is the coarse gate (ADMIN + FACILITATOR). What either may do to
  // an INDIVIDUAL user is a separate, per-target decision: canAdministerUser for
  // acting on them (the write routes) and canSeeUser for whether they appear at all
  // (the list route). All three are distinct — see the three matrices in
  // @praimana/shared.
  admin.use("*", async (c, next) => {
    const { id, role } = requireIdentity(c);
    if (!canManageUsers(role)) {
      // ⚠ THE REFUSAL IS LOGGED. This gate fronts the whole `/v1/admin` surface,
      // including the bulk directory PII reads below, and it recorded nothing — so someone probing
      // for an admin endpoint they cannot reach produced an invisible run of 403s. Ids and role only,
      // never an address: the same rule the notify audit line follows.
      console.warn("[identity] refused an admin-surface request", {
        userId: id,
        role,
        routePath: routeTemplate(c.req.path),
        method: c.req.method,
      });
      return c.json({ error: "Forbidden: your role cannot manage users" }, 403);
    }

    /**
     * ── ⚠ AND THE SUCCESSFUL PRIVILEGED READ IS RECORDED TOO ────────────────────────────────────
     *
     * "Who read the user directory" was unanswerable from this platform's own records. The reads
     * beneath this gate — `GET /v1/admin/users`, `/v1/admin/user-names`, `/v1/admin/cost` — return
     * bulk PII and emitted no entry at all, so a compromised staff account could enumerate every
     * account on the platform without leaving a trace.
     *
     * ⚠ LOGGED ON THE GATE, NOT IN EACH HANDLER, so a route added to this surface later is covered
     * on arrival rather than when someone remembers. That is the same argument the gate itself makes
     * ("a route added later is covered automatically instead of being covered only if someone
     * remembers").
     *
     * ⚠ A LOG LINE, NOT AN AUDIT-TABLE ENTRY. The append-only audit trail records access CHANGES —
     * who granted or revoked what — and a read is not a change. Putting reads in it would dilute the
     * trail whose value is that every row is an access decision. This is the observability half.
     */
    console.log(
      JSON.stringify({
        message: "[identity] privileged directory access",
        userId: id,
        role,
        routePath: routeTemplate(c.req.path),
        method: c.req.method,
        event: "an admin-surface route was served",
      })
    );
    await next();
  });

  /**
   * Every user on the platform, paginated.
   *
   * A full listing is the point, not an oversight: an administrator has to be able
   * to find the person who needs their access revoked, and this platform has no
   * other view of "who exists" — team membership only shows people who joined a
   * team, and the invitations table only shows people who were invited (and says
   * nothing about whether they still have access).
   *
   * "Full", though, is relative to the CALLER. An ADMIN sees every account; a
   * FACILITATOR sees everything except ADMIN accounts, which are invisible to them
   * rather than merely un-actionable. The role list comes from the token's group
   * claim, never from a query parameter, so a facilitator cannot ask for admins by
   * hand-crafting a request.
   *
   * Rows are returned as AdminUser, which drops profileComplete (a self-service
   * concern) and adds hasAccount + isSelf so the client can render a row as
   * non-actionable without having to work out why.
   *
   * The stored `role` is a DISPLAY CACHE, not the authority — the live role is the
   * Cognito group, read per request from the token. They agree in practice because
   * the post-confirmation trigger writes both, and a role change must write both.
   * If they ever diverge, this list is the stale one.
   *
   * TWO BRANCHES, ONE ENVELOPE. Without `?ids=` this pages a Scan of the whole table.
   * With `?ids=` it hydrates exactly those profiles, which is how the team and
   * workshop filters work: "who is in team X" is answerable only in the Team context,
   * so the BFF resolves member ids there and passes them here. The filtered branch
   * returns NO nextCursor — a team is tens of people and the answer is one complete
   * page, which is honest rather than a cursor that promises a page that isn't coming.
   *
   * Both branches converge on the SAME visibility filter below. Two independently
   * filtered paths is how the one you forget becomes the hole — and the `?ids=` path
   * is the one an attacker would reach for, since it takes ids straight from the
   * request.
   */
  admin.get("/users", async (c) => {
    const { id, role } = requireIdentity(c);

    // The roles this caller may see at all. Derived from the token's group claim,
    // never from a query parameter. An unrecognised role yields [] — sees nobody.
    const visibleRoles = visibleRolesFor(role);

    const idsParam = c.req.query("ids");

    let users: User[];
    let nextCursor: string | undefined;

    if (idsParam !== undefined) {
      const ids = idsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // Rejected, not truncated. Silently dropping ids past the cap would render a
      // filtered list that is quietly missing people — the failure mode where an
      // administrator concludes someone is not on a team when they are.
      if (ids.length > MAX_HYDRATE_IDS) {
        return c.json(
          { error: `too many ids — at most ${MAX_HYDRATE_IDS} per request` },
          400
        );
      }

      // An explicit but EMPTY ids list means "the filter matched nobody", which is a
      // legitimate answer and must not fall through to listing everyone.
      users = ids.length === 0 ? [] : await deps.users.listByIds(ids);
    } else {
      const limitParam = c.req.query("limit");
      const parsedLimit = limitParam ? Number(limitParam) : undefined;
      // A non-numeric limit is ignored rather than 400'd — it comes from a URL, and
      // the repository clamps whatever it gets, so there is no unbounded read to
      // protect against.
      const limit =
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined;

      const page = await deps.users.list({
        limit,
        cursor: c.req.query("cursor"),
        visibleRoles,
        // Matched in the STORE, so it finds users on any page rather than only the one
        // in hand — which is the difference between a search that browses and one you
        // can act on. ANDed with visibleRoles in the repository, so it can never be a
        // way to confirm an account this caller may not see.
        search: c.req.query("search"),
      });
      users = page.users;
      nextCursor = page.nextCursor;
    }

    // THE one visibility filter. Redundant for the Scan branch (already filtered in
    // the store, which is where enumeration must be stopped) and load-bearing for the
    // ?ids= branch, where a facilitator could otherwise name an admin's id directly
    // and read the row back. Belt and braces on purpose: this is the line that has to
    // hold if either branch is later refactored.
    const visible = users.filter((u) => canSeeUser(role, u.role));

    return c.json({
      users: visible.map((u) => toAdminUser(u, id)),
      nextCursor,
    });
  });

  /**
   * Display names for a set of user ids — the "Invited by" column's second half.
   *
   * An invitation row stores `invitedBy` as a bare Cognito sub, and only this service
   * can turn a sub into a name. So the Team context reports WHO invited someone as an
   * id, and this resolves it.
   *
   * THE VISIBILITY RULE APPLIES TO INVITERS TOO, and this is the subtle half of
   * hiding admins from facilitators. Every invitation in the dev table today was sent
   * by the platform's only ADMIN to PARTICIPANTs a facilitator may see — so rendering
   * the inviter's name would print that admin's name on rows a facilitator is
   * looking at, handing over exactly the reconnaissance the row filter was added to
   * prevent. A hidden inviter is reported as `{ hidden: true }` and NOT as a missing
   * name, so the client can say "Not shown" rather than leaving a blank that reads as
   * a data problem.
   */
  admin.get("/user-names", async (c) => {
    const { role } = requireIdentity(c);

    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) return c.json({ names: {} });
    if (ids.length > MAX_HYDRATE_IDS) {
      return c.json(
        { error: `too many ids — at most ${MAX_HYDRATE_IDS} per request` },
        400
      );
    }

    const users = await deps.users.listByIds(ids);

    const names: Record<string, { name?: string; hidden?: boolean }> = {};
    for (const user of users) {
      names[user.id] = canSeeUser(role, user.role)
        ? { name: user.name || user.email }
        : // Nothing about them: not the name, not the email, not the role.
          { hidden: true };
    }

    // Ids with no row are simply absent — an inviter's account may have been deleted
    // since. The client renders that as unknown, which is what it is.
    return c.json({ names });
  });

  /**
   * ── FILE A REPORT ──────────────────────────────────────────────────────────────────────────
   *
   * THE RULE: feedback and bug reports are not emailed; they are stored in the database, and facilitators
   * and admins are notified and can see them under Administration.
   *
   * ⚠ ON THE `identity` ROUTER, NOT THE `admin` ONE. Any signed-in person may file a report — a
   * PARTICIPANT hitting a bug is the most important reporter there is, and putting this behind
   * `canManageUsers` would mean only administrators could report problems. Reading the inbox is the
   * privileged half, and that lives under /v1/admin below.
   *
   * ⚠ WHO IS REPORTING COMES FROM THE VERIFIED IDENTITY, NEVER THE BODY. A client-supplied reporter id
   * would let anyone file as somebody else, and "who hit this" being trustworthy is the entire value of an
   * inbox over an email folder.
   */
  identity.post("/feedback", async (c) => {
    const { id, email, role } = requireIdentity(c);

    if (!deps.feedback) {
      return c.json(
        {
          error: "Reporting isn't available in this environment.",
          code: "FEEDBACK_UNAVAILABLE",
        },
        503
      );
    }

    /**
     * ── ⚠ METERED PER REPORTER, BEFORE THE BODY IS PARSED OR ANYTHING IS WRITTEN ──────────────
     *
     * A SECURITY FINDING (medium): this route is gated only by requireIdentity — any
     * signed-in role, PARTICIPANT and JUDGE included — and each call costs a DynamoDB write, a
     * users-table read, and mail to every admin and facilitator. Recipients are server-derived and
     * the text is word-bounded, so it is not an open relay; what it was is unmetered.
     *
     * Ahead of `c.req.json()` deliberately, so a refused caller costs no body parsing — the same
     * ordering notify's middleware uses and the portal's limiter header argues for.
     *
     * The budget is deliberately small: a person filing more than a handful of reports an hour is
     * not reporting, and the honest answer to them is "later" rather than a mailbox full of staff
     * notifications.
     */
    if (deps.feedbackQuota) {
      const verdict = await deps.feedbackQuota.consume(id);
      if (!verdict.allowed) {
        console.warn("[identity] feedback quota exhausted", {
          userId: id,
          role,
          limit: verdict.limit,
        });
        c.header("Retry-After", String(verdict.retryAfterSeconds));
        return c.json(
          {
            error: "You have filed several reports already. Please try again later.",
            code: "FEEDBACK_QUOTA_EXHAUSTED",
            limit: verdict.limit,
            retryAfterSeconds: verdict.retryAfterSeconds,
          },
          429
        );
      }
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Body must be valid JSON.", code: "INVALID_BODY" }, 400);
    }

    const kind = body.kind === "BUG" ? "BUG" : body.kind === "FEEDBACK" ? "FEEDBACK" : null;
    if (!kind) {
      return c.json({ error: "kind must be BUG or FEEDBACK.", code: "KIND_INVALID" }, 400);
    }

    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";

    /**
     * ── ⚠ BOTH FIELDS, AGAINST THE SHARED BOUNDS ───────────────────────────────────────────
     *
     * THE BOUNDS: subject 5–15 words, description 20–200 words. `checkFeedbackReport` is
     * the SAME function the portal form, the portal BFF and the desktop form call — one definition of "how
     * many words is that", so a report the form accepted cannot be refused here, and the sentence the
     * reporter reads is the same sentence either way.
     *
     * ⚠ AND IT IS STILL CHECKED HERE, not merely in the clients. The clients are a courtesy that saves a
     * round trip; this is the refusal that counts, because a POST to this route need not come from either
     * form. An empty or one-word report is also indistinguishable from a misclick and costs an administrator
     * a read to discover it says nothing.
     *
     * The `code` is machine-readable and the `error` is the human sentence, which is the same contract the
     * rest of this file uses.
     */
    const problem = checkFeedbackReport({ subject, message });
    if (problem) {
      return c.json(
        {
          error: problem.message,
          code: problem.code,
          limits: {
            subject: { maxChars: MAX_FEEDBACK_SUBJECT },
            message: { maxChars: MAX_FEEDBACK_MESSAGE },
          },
        },
        400
      );
    }

    /**
     * Context, all optional and all bounded.
     *
     * ⚠ IDS AND A ROUTE, NEVER NAMES OR TEAM CONTENT. An administrator needs to find the rows; a report is
     * not a route around team-content isolation. Each value is trimmed and capped so a caller cannot use the context
     * fields as unbounded storage the message cap would otherwise have refused.
     */
    const text = (value: unknown, max = 200): string | null => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed ? trimmed.slice(0, max) : null;
    };

    const now = new Date().toISOString();
    const report = await deps.feedback.create({
      id: ulid(),
      kind,
      status: "NEW",
      subject,
      message,
      reportedById: id,
      reportedByEmail: email ?? "",
      reportedByRole: role,
      surface: body.surface === "desktop" ? "desktop" : "portal",
      version: text(body.version, 40),
      location: text(body.location),
      workshopId: text(body.workshopId, 64),
      teamId: text(body.teamId, 64),
      createdAt: now,
      // The sparse index key — present because the report is NEW. See the repository's header for why it
      // must be absent rather than null once acknowledged.
      unread: "NEW",
      acknowledgedAt: null,
      acknowledgedById: null,
    });

    /**
     * ── ⚠ EMAIL STAFF, AFTER THE REPORT IS SAFELY STORED, AND NEVER FAILING BECAUSE OF IT ─────
     *
     * THE RULE: the backend emails the current experience facilitators and admins.
     *
     * ⚠ AWAITED, NOT FIRE-AND-FORGET, and that is a Lambda constraint rather than a preference: the
     * runtime FREEZES the execution environment when the handler returns, so an un-awaited promise is
     * simply abandoned — often silently, sometimes completing on the next unrelated invocation. A
     * "background" send here would be a send that mostly does not happen.
     *
     * ⚠ AND IT CANNOT FAIL THE REQUEST. The row is already written. If notify is unreachable the reporter
     * still gets their 201, because the alternative is telling somebody their bug report failed when it
     * is sitting in the inbox — and they would file it again.
     *
     * The recipient list is read HERE rather than inside the notifier: this service owns the users table,
     * and a notifier that queried it would be a transport doing a lookup.
     */
    let notified = 0;
    if (deps.notifier) {
      try {
        // One send per visibility tier — see staffEmailsByRole. Sequential rather than
        // Promise.all: this is a handful of staff addresses on a path that already accepts being
        // slow enough to read the users table, and a partial failure is easier to reason about
        // when the sends do not interleave.
        for (const group of await staffEmailsByRole(deps.users)) {
          notified += await deps.notifier.notifyNewReport(report, group.emails);
        }
      } catch (err) {
        /**
         * ⚠ THE ROUTE DEFENDS ITSELF RATHER THAN TRUSTING THE PORT'S CONTRACT, and a test caught the
         * absence of this. `FeedbackNotifier` is documented "MUST NOT THROW" and the HTTP implementation
         * honours it — but a contract nothing enforces is a comment, and a future notifier that throws
         * would have turned a STORED report into a 500 for the person who filed it. They would file it
         * again, and the inbox would fill with duplicates of a report that landed the first time.
         *
         * The row is already written by this point. There is no failure here worth telling the reporter
         * about.
         */
        console.warn("[identity] feedback notification threw — the report is stored regardless", {
          reportId: report.id,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    // Ids only in the log line, and no message text: the body is user prose that may name people.
    console.log(
      JSON.stringify({
        message: "[identity] feedback report filed",
        reportId: report.id,
        kind,
        surface: report.surface,
        reportedById: id,
        notified,
      })
    );

    return c.json({ report }, 201);
  });

  /**
   * ── THE INBOX ─────────────────────────────────────────────────────────────────────────────
   *
   * Under the `admin` router, so it inherits the `canManageUsers` middleware gate (ADMIN + FACILITATOR) —
   * exactly the intended audience, and applied as middleware precisely so a route added later
   * cannot forget it.
   *
   * ⚠ `unreadCount` TRAVELS WITH THE LIST. The badge and the list are read together by one screen, so one
   * round trip answers both and the two cannot disagree — which they could if the browser combined two
   * responses taken a second apart.
   */
  admin.get("/feedback", async (c) => {
    if (!deps.feedback) {
      return c.json(
        { error: "Reporting isn't available in this environment.", code: "FEEDBACK_UNAVAILABLE" },
        503
      );
    }

    const requested = Number(c.req.query("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_FEEDBACK_PAGE) : undefined;

    const { role } = requireIdentity(c);

    const page = await deps.feedback.list({
      ...(limit ? { limit } : {}),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
    });

    // ⚠ THE VISIBILITY FILTER THIS READ WAS MISSING. It returned stored rows
    // verbatim — reporter sub, email and role — under a gate that admits FACILITATOR as well as
    // ADMIN, so a facilitator learned the identity of any ADMIN who had filed a report. Every
    // sibling read on this router already applied the matrix (`/admin/users` filters rows,
    // `/admin/user-names` answers `{hidden:true}`); the inbox was the one that did not.
    //
    // Per ROW rather than by dropping rows: a facilitator must still see and act on the report.
    return c.json({
      ...page,
      items: page.items.map((item) => toVisibleReport(item, role, canSeeUser)),
    });
  });

  /**
   * Mark one report as dealt with.
   *
   * ⚠ IDEMPOTENT, and the repository's ConditionExpression checks only that the row EXISTS. Two admins
   * clicking at once is the normal case; a conditional failure would raise an error about something that
   * is already true.
   */
  admin.post("/feedback/:id/acknowledge", async (c) => {
    if (!deps.feedback) {
      return c.json(
        { error: "Reporting isn't available in this environment.", code: "FEEDBACK_UNAVAILABLE" },
        503
      );
    }
    const { id: adminId, role } = requireIdentity(c);
    const report = await deps.feedback.acknowledge(
      c.req.param("id"),
      adminId,
      new Date().toISOString()
    );
    if (!report) return c.json({ error: "Report not found" }, 404);
    // ⚠ THE SAME PROJECTION AS THE LIST. This route returns the same row shape, so leaving it
    // unfiltered would make acknowledging a report the way to read the reporter the list had just
    // hidden — a one-click bypass of the filter above.
    return c.json({ report: toVisibleReport(report, role, canSeeUser) });
  });

  /**
   * ── PLATFORM HEALTH, READ-ONLY ────────────────────────────────────────────────────────────
   *
   * A read-only platform health tab in Administration, visible only to admins and facilitators.
   *
   * ⚠ ON THE `admin` ROUTER, so the audience is exactly the intended one and it is enforced by the
   * `canManageUsers` middleware rather than by this handler remembering to check. Health is not secret, but it
   * is a map of what is failing and where — the sort of thing that is only ever useful to the people who can
   * act on it, and is reconnaissance for everybody else.
   *
   * ⚠ A FAILED READ IS A 503, NEVER AN EMPTY LIST OR AN "OK". A health page that reports healthy because the
   * health CHECK failed is worse than no page at all: it converts an outage into a reassurance. Same
   * three-valued discipline as the authorization model — "cannot tell" is its own answer, and the panel says so.
   */
  admin.get("/platform-health", async (c) => {
    if (!deps.health) {
      return c.json(
        {
          error: "Health checks aren't available in this environment.",
          code: "HEALTH_UNAVAILABLE",
        },
        503
      );
    }

    try {
      return c.json(await deps.health.read());
    } catch (err) {
      /**
       * The commonest cause here will be IAM (`cloudwatch:DescribeAlarms` missing from the shared execution
       * role) and the second commonest a metrics-API timeout. Both are logged with the error NAME only — an
       * AWS message carries an account id and a role ARN, and this is a response body away from a browser.
       */
      console.warn("[identity] platform health could not be read", {
        error: err instanceof Error ? err.name : "unknown",
      });
      return c.json(
        {
          error:
            "The platform's health could not be read just now. This says nothing about whether the platform is healthy — only that the check did not complete.",
          code: "HEALTH_READ_FAILED",
        },
        503,
        { "Retry-After": "5" }
      );
    }
  });

  /**
   * ── WHAT THE PLATFORM COSTS TO RUN — ADMIN ONLY ───────────────────────────────────────────
   *
   * An estimated daily and overall spend, visible to admins only.
   *
   * ⚠ THIS ROUTE IS NARROWER THAN THE ROUTER IT SITS ON, which is the only one here that is. The `/v1/admin`
   * middleware admits ADMIN **and FACILITATOR** — right for users, teams and the report inbox, too wide for
   * spend: a facilitator runs an experience, and what the platform costs is an administrator's business. So there is
   * an explicit second check, and it is `canSeePlatformSpend` rather than an inline `role === "ADMIN"` so the
   * tab, the BFF and this route cannot disagree about who is admitted.
   *
   * ⚠ 403 AND NOT 404. A facilitator asking is not a mystery to be hidden — the tab is simply not offered to
   * them, and lying about the route's existence would make a UI bug indistinguishable from a permission one.
   */
  admin.get("/cost", async (c) => {
    const { role } = requireIdentity(c);
    if (!canSeePlatformSpend(role)) {
      return c.json(
        { error: "Only an administrator can see what the platform costs.", code: "FORBIDDEN" },
        403
      );
    }

    if (!deps.cost) {
      return c.json(
        { error: "Spend isn't available in this environment.", code: "COST_UNAVAILABLE" },
        503
      );
    }

    try {
      return c.json(await deps.cost.read());
    } catch (err) {
      /**
       * ⚠ A FAILED READ IS A 503, NEVER A ZERO. "$0.00" is a plausible, wrong number that reads as good news —
       * the same class of defect as a health page reporting OK because the check failed. The likely causes are
       * IAM (`ce:GetCostAndUsage`) and Cost Explorer not being enabled; both are logged by error NAME only,
       * since an AWS message carries an account id.
       */
      console.warn("[identity] spend could not be read", {
        error: err instanceof Error ? err.name : "unknown",
      });
      return c.json(
        {
          error:
            "The platform's spend could not be read just now. This is a problem with the cost query, not a figure of zero.",
          code: "COST_READ_FAILED",
        },
        503,
        { "Retry-After": "30" }
      );
    }
  });

  // Both routers under one root so the caller (app.ts / withHealth) still gets a
  // single app to serve.
  const root = new Hono();
  root.route("/", identity);
  root.route("/", admin);
  return root;
}
