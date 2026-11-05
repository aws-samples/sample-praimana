import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/server-token";
import { backendFetch } from "@/lib/backend";
import { provisionAccounts, type ProvisionResult } from "@/lib/provision";
import { runPaced } from "@/lib/send-pacer";
import { requiresWorkshop } from "@/lib/invite-form";
import { auditLog } from "@/lib/audit-logger";
import { inviteRateLimiter } from "@/lib/rate-limit";
import {
  canGrantRole,
  isPlatformScopedRole,
  INVITABLE_PLATFORM_ROLES,
  PLATFORM_INVITATION_TEAM_ID,
  TEAM_ROLES,
} from "@praimana/shared";
import { inviteBodySchema } from "@/lib/invite-body";

/**
 * THE INVITE FLOW, END TO END, AND WHY IT IS IN THIS ORDER.
 *
 * Self-service sign-up is OFF on the user pool (`AllowAdminCreateUserOnly: true`,
 * a security requirement). An invitation row therefore no
 * longer results in an account by itself, the account must be ADMIN-CREATED, and this
 * route is what causes that. Three steps, and the order is forced:
 *
 *   1. STORE the invitation row      → the team service, which re-checks the grant
 *                                      matrix and mints the link token.
 *   2. PROVISION the Cognito account → the out-of-VPC user-access service, the one
 *                                      holder of cognito-idp:AdminCreateUser.
 *   3. EMAIL the recipient           → notify, with the link AND the temporary
 *                                      password.
 *
 * Step 1 before step 2 because the PRE-SIGNUP TRIGGER is still the invite-only gate
 * and it fires on the admin-create path too: it reads the invitations table during the
 * AdminCreateUser call and refuses when there is no live row. Verified on the live dev
 * pool, no row means no account. So the row is a precondition of the create, not a
 * record of it.
 *
 * Step 2 before step 3 because an email carrying a temporary password for an account
 * that does not exist is worse than no email at all: every sign-in attempt would be
 * refused as a credential failure, and the recipient has no way to know the fault is
 * ours. A recipient who gets NO email still has an invitation an operator can re-send.
 *
 * The consequence, stated plainly: a provisioning failure leaves the invitation row in
 * place and sends NO email to that address, and the response reports it per address.
 * The operator's fix is to re-invite, which is safe, an existing account is a benign
 * re-invite, and the provisioning path re-asserts the group and the profile row, so a
 * re-invite also REPAIRS a partially-provisioned account.
 */

// Where the invite link points. Same app for everyone: the recipient signs in for the
// first time in this BROWSER app, and the post-sign-in landing routes by role -
// participants to /welcome with their team join code and the desktop download, staff to
// the workshop list.
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3001";

// How long the invite link stays usable, for the email copy only. The ENFORCED
// window lives on the invitation row (team service mints expiresAt); this is just
// the number we tell the recipient, so it must match INVITE_TTL_HOURS there.
const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS || 24);

// Human-readable role for the email copy ("Participant · Builder", or "Judge").
function roleLabel(platformRole?: string, teamRole?: string): string {
  const platform =
    INVITABLE_PLATFORM_ROLES.find((r) => r.role === platformRole)?.label ??
    platformRole ??
    "Participant";
  const team = teamRole
    ? TEAM_ROLES.find((r) => r.role === teamRole)?.label ?? teamRole
    : undefined;
  return team ? `${platform} · ${team}` : platform;
}

// The first-sign-in link for a recipient: this app's /join/<token> page, which
// resolves the token server-side and renders the SIGN-IN form with the invited email
// locked in, ready for the temporary password from this same email.
//
// It used to render a sign-up form. With `AllowAdminCreateUserOnly: true` on the pool
// there is no self-signup to render, the account already exists by the time this link
// is sent, so the recipient's first action is a sign-in, not a registration.
//
// Why route through our own page rather than sending people to /login:
//   - The token makes the link UNGUESSABLE, so it can't be forged from a known
//     address the way a bare login link can.
//   - /join can say "this invitation expired" instead of dropping the recipient on a
//     form that refuses them for reasons they can't see.
//   - The email never travels in the URL, /join reads it back from the token.
//
// The token carries NO privilege: it does not admit the sign-in (the temporary
// password does), and the role was resolved server-side from the invitation row at
// provisioning time.
function buildInviteUrl(token: string): string {
  return `${APP_URL}/join/${encodeURIComponent(token)}`;
}

// "24 hours" / "1 hour", the expiry phrase for the email copy.
function expiryText(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export async function POST(req: Request) {
  /**
   * ⚠ THE BEARER COMES FROM THE JWE COOKIE, NOT FROM THE SESSION OBJECT. It used to read
   * `session?.accessToken`, which required copying the Cognito ID token onto the session, and in
   * Auth.js v5 the session object is also the body of the public `GET /api/auth/session` that every
   * page fetches. Same value, read one tier lower.
   */
  const [session, token] = await Promise.all([auth(), getAccessToken(req)]);
  /**
   * ⚠ BOTH, EXPLICITLY. The old `if (!session?.accessToken)` made the session's presence implicit
   * in the token's, one read, so one check. Now that identity and bearer come from two calls, the
   * bearer alone must not authorize: everything below reads `session.user` for the role gate.
   */
  if (!token || !session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── RATE LIMITING ──────────────────────────────────────────────────────────────────────────
  // Cap invite requests per authenticated user. The invite route creates accounts and sends
  // emails, both are expensive, externally visible side effects that must not be repeatable
  // at will. Keyed on user id so one abusive session cannot exhaust the limit for others.
  //
  // ⚠ BEFORE THE BODY IS READ, DELIBERATELY. `req.json()` buffers the whole request; a caller
  // already over their limit must not be able to make this process parse megabytes first. The
  // cheapest refusal has to come first or the limiter is not bounding the expensive part.
  /**
   * ⚠ NO SHARED `"anonymous"` BUCKET. The gate above checks the bearer and the session, not
   * `session.user?.id`, so a session carrying a token but no id would have fallen into one bucket
   * shared by every such caller, where one of them exhausts the allowance for all of them, and a
   * limiter becomes a denial-of-service primitive against legitimate users. `cognito-verify.ts`
   * requires `sub`, so this should be unreachable; keying on a value that has not been asserted is
   * the part worth removing.
   */
  const userId = session.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rateLimitResult = inviteRateLimiter.check(userId);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: "Too many invite requests. Please try again shortly." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateLimitResult.retryAfterMs / 1000)),
        },
      }
    );
  }

  // ── PARSE AND VALIDATE the request body with a strict Zod schema ──
  //
  // This is the fix for the unrestricted resource consumption finding: without a schema,
  // an attacker could send thousands of emails in one request, exhausting Cognito's
  // pool-wide admin quota and causing an auth outage for all users. The schema enforces:
  //   - `emails` must be an array (not an object or other type)
  //   - Each email must be a valid-shaped string ≤ 254 chars
  //   - The array is capped at MAX_BULK_ROWS (80), matching the bulk-CSV path
  //   - No unknown keys are accepted (`.strict()`)
  //
  // ⚠ AND IT RUNS BEFORE EVERY SIDE EFFECT, the invitation write, the Cognito provisioning and
  // the SES send all happen below. An oversized request must store nothing, provision nothing
  // and email nobody, which is only true if the parse is above all three.
  let body: z.infer<typeof inviteBodySchema>;
  try {
    const raw = await req.json();
    body = inviteBodySchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        // zod v4: ZodError exposes .issues (v3's .errors alias was removed).
        { error: "Invalid request body", details: err.issues.map((e) => e.message) },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { emails, email, teamId, teamName, inviteCode, platformRole, teamRole, workshopId } = body;

  /**
   * ⚠ ONE ENTRY PER ADDRESS, CASE-INSENSITIVELY, AND THE DUPLICATES USED TO SURVIVE.
   *
   * This was `emails || (email ? [email] : [])`, i.e. the caller's array verbatim. Every list
   * below that drives a side effect is derived from THIS one, `sendable`, `provisionAccounts`,
   * `emailable`, `runPaced`, and each filters with a `.has()` against a lower-cased Map, which
   * is true for every copy. So 80 identical entries passed every filter and produced 80 Cognito
   * `AdminCreateUser` attempts plus 80 invitation emails, each carrying a live join link, to a
   * single address. `inviteBodySchema` now REFUSES such a body outright; this collapse is the
   * second layer, and it also covers the `email` singular form and any future caller of this
   * handler.
   *
   * Keyed on the lower-cased address but STORING the original, because the original casing is what
   * gets emailed and what the invitation row carries, lower-casing the recipient would change
   * what the person sees in the "to" line. The key is the same identity `tokenByEmail` and
   * `provisionByEmail` use, so a collapse here cannot disagree with a lookup there.
   *
   * ⚠ FIRST OCCURRENCE WINS, WHICH `new Map(pairs)` WOULD NOT GIVE, that keeps the LAST value for
   * a repeated key, so `["Ada@example.com", "ada@example.com"]` would survive at the first spelling's POSITION
   * with the second spelling's CASING. Harmless but incoherent, and a test caught the claim in
   * this comment being false of the code. The explicit loop makes position and spelling agree.
   */
  const bySpelling = new Map<string, string>();
  for (const candidate of emails || (email ? [email] : [])) {
    const key = candidate.toLowerCase();
    if (!bySpelling.has(key)) bySpelling.set(key, candidate);
  }
  const recipients: string[] = [...bySpelling.values()];
  if (recipients.length === 0) {
    return NextResponse.json({ error: "emails is required" }, { status: 400 });
  }

  // TWO SHAPES, decided by the ROLE and not by what the caller happened to send.
  //
  // A platform-scoped invitation (admin, facilitator, judge) has no team: those
  // roles aren't members of one, so there is no team name or join code to ask for
  // or to put in the email. A team-scoped one (participant, executive) must name
  // the team, because the invitation is what puts them on it.
  //
  // Deriving the scope from the role rather than from "did they send a teamId?"
  // means the two cannot disagree: a caller who sends a role and a stale teamId
  // gets the row the role implies, not a hybrid.
  const requestedRole = platformRole || "PARTICIPANT";
  const isPlatformInvite = isPlatformScopedRole(requestedRole);

  if (!isPlatformInvite && (!teamId || !teamName || !inviteCode)) {
    return NextResponse.json(
      {
        error: `Inviting someone as ${requestedRole} needs a team, teamId, teamName and inviteCode are required.`,
      },
      { status: 400 }
    );
  }

  // A role that must name a WORKSHOP and doesn't is refused HERE, before step 1 -
  // symmetrically with the team check above, and for a sharper reason. The Team service
  // refuses it too and is the boundary that counts, but this route has three side
  // effects in a forced order (store the row → create the Cognito account → email the
  // temporary password), and the temporary password exists nowhere but that email. So
  // a request that is going to be refused must be refused before ANY of them: the
  // alternative is discovering it after the row is written, which for a bulk invite
  // leaves the operator reconciling which addresses got how far.
  if (requiresWorkshop(requestedRole) && !String(workshopId ?? "").trim()) {
    return NextResponse.json(
      {
        error: `Inviting someone as ${requestedRole} needs a workshop, a ${requestedRole.toLowerCase()} with no workshop can't see or score anything.`,
      },
      { status: 400 }
    );
  }

  /**
   * The sentinel is the invitations table's partition key for a team-less row; see
   * PLATFORM_INVITATION_TEAM_ID. The team service validates the pairing again and is the
   * boundary that counts.
   *
   * ⚠ SPELLED OUT AS A STATEMENT RATHER THAN A TERNARY, AND THAT IS THE ZOD SCHEMA'S DOING.
   * `teamId` used to arrive from an untyped destructure, so `string | undefined` was invisible;
   * now that the body is parsed it is honestly optional, and the guard above, which already
   * refuses a team-scoped invite with no `teamId`, is a compound early return that TypeScript
   * cannot carry through the boolean `isPlatformInvite`. The third branch is therefore
   * UNREACHABLE in practice and is written out anyway, because the alternative is a `!`
   * assertion that would silently become wrong if that guard were ever loosened.
   */
  let targetTeamId: string;
  if (isPlatformInvite) {
    targetTeamId = PLATFORM_INVITATION_TEAM_ID;
  } else if (teamId) {
    targetTeamId = teamId;
  } else {
    return NextResponse.json(
      { error: "teamId is required for a team invitation" },
      { status: 400 }
    );
  }

  // Re-check the grant matrix here, against the SESSION's role rather than
  // anything the client sent. The Team service checks this too and is the real
  // boundary, but this route also triggers the invitation EMAIL, so without a
  // check here a tampered request would be refused by the backend only after the
  // BFF had already decided to act, and any future divergence between the two
  // paths would silently become a hole. Defense in depth, and it keeps the error
  // message accurate for the UI.
  //
  // An omitted platformRole means PARTICIPANT downstream, so the default is what
  // gets validated, not "no role requested" (requestedRole above applies it).
  if (!canGrantRole(session.user?.role, requestedRole)) {
    auditLog({
      event: "authz.invite.denied",
      actor: { id: session.user?.id, role: session.user?.role },
      target: { requestedRole, recipientCount: recipients.length, teamId: targetTeamId },
      outcome: "denied",
      reason: `Role "${session.user?.role}" attempted to grant "${requestedRole}", refused by grant matrix`,
    });
    return NextResponse.json(
      { error: `Your role cannot invite someone as ${requestedRole}.` },
      { status: 403 }
    );
  }

  // Store invitations in DynamoDB. Forward the chosen platform role and (for
  // participants) the team role so the team service records them and applies the
  // team role on join.
  //
  // The response carries each invitation's freshly-minted link TOKEN, the only
  // time the raw token is ever readable (the table keeps just its hash), so the
  // links must be built from this response and nowhere else.
  let created: Array<{ email?: string; token?: string; expiresAt?: string }>;
  try {
    const stored = await backendFetch(`/v1/teams/${encodeURIComponent(targetTeamId)}/invitations`, {
      method: "POST",
      body: JSON.stringify({
        emails: recipients,
        platformRole,
        // A team role is meaningless without a team, don't send a stray
        // LEAD/BUILDER along with a facilitator invitation. (The team service drops
        // it for non-participants too; this keeps the request honest.)
        teamRole: isPlatformInvite ? undefined : teamRole,
        // THE WORKSHOP a JUDGE invitation grants, sent ONLY for a role that REQUIRES
        // one, and decided by the ROLE rather than by what the caller happened to send,
        // for exactly the reason `isPlatformInvite` above is: the two cannot then
        // disagree.
        //
        // Both of the other two cases are handled by NOT sending it, and both matter:
        //   ADMIN / FACILITATOR, the Team service 400s a named workshop on these
        //     (their access is not workshop-shaped). The team workspace's invite form
        //     sends its route's `workshopId` on every invitation, so forwarding it
        //     blindly would break inviting a facilitator from a team page, a form the
        //     operator filled in correctly, refused for a field they never saw.
        //   PARTICIPANT / EXECUTIVE, the Team service DERIVES it from the team and only
        //     ever compares a client value against its own. Sending it buys nothing and
        //     turns a stale value into a 400, so it is dropped.
        //
        // The rule itself is NOT reproduced here beyond that one question: the Team
        // service owns the full table AND the check that the caller is entitled to the
        // workshop they named, which needs the Workshop service and cannot be done from
        // a BFF. `requiresWorkshop` is the same helper the two invite forms block on, so
        // there is one definition of "does this role owe us a workshop".
        ...(requiresWorkshop(requestedRole) && workshopId ? { workshopId } : {}),
      }),
      token,
    });
    created = stored?.invitations ?? [];
  } catch (err) {
    console.error(
      "Failed to store invitations:",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json({ error: "Failed to store invitations" }, { status: 500 });
  }

  // Pair each recipient with their OWN token (emails are lowercased on store, so
  // match on the normalized form). A recipient whose token is missing gets no
  // email rather than a link that would 404, the invitation is stored either way
  // and can be re-sent.
  const tokenByEmail = new Map<string, string>(
    created
      .filter((inv): inv is { email: string; token: string } => !!inv.email && !!inv.token)
      .map((inv) => [inv.email.toLowerCase(), inv.token])
  );

  // Send one email per recipient so each link carries that recipient's own email.
  // Delivery goes through the notify service (SES in prod, console log in dev).
  // A send failure does NOT fail the request, the invitation is already stored and
  // can be re-sent; we just report how many emails went out.
  const label = roleLabel(platformRole, teamRole);
  const inviterName = session?.user?.name || undefined;

  // What the email is FOR, in log lines and warnings, "team Alpha" or "the
  // platform". A platform invite has no team name to report.
  const scopeLabel = isPlatformInvite ? "the platform" : `team ${teamName}`;

  const sendable = recipients.filter((to) => tokenByEmail.has(to.toLowerCase()));
  const missing = recipients.length - sendable.length;
  if (missing > 0) {
    console.warn(
      /**
       * ⚠ `scopeLabel` IS A FIELD, NOT PART OF THE MESSAGE. It contains a caller-supplied team
       * name; interpolated into the text it could carry CRLF and forge a second log record. The
       * two uses at :420 and :428 were already structured, this is the same shape, applied to
       * the two that were not. The schema now also refuses control characters, so this is the
       * second of two independent fixes rather than the only one.
       */
      `[INVITE] ${missing}/${recipients.length} invitations came back without a link token, stored but not emailed`,  // nosemgrep: unsafe-formatstring
      { scope: scopeLabel }
    );
  }

  // ── STEP 2: PROVISION the Cognito account for each recipient. ──
  //
  // AFTER the row (the pre-signup gate reads it during AdminCreateUser) and BEFORE the
  // email (which must carry the temporary password this returns). See the module
  // header for why neither order is negotiable.
  //
  // Bounded concurrency, Cognito's admin APIs are rate-limited per POOL, and the
  // same throttle would block a real user's sign-in, so a bulk invite must not fan out
  // unboundedly. See PROVISION_CONCURRENCY.
  //
  // Only `sendable` addresses are provisioned: an address whose token did not come back
  // cannot be emailed, so creating its account would leave a credential nobody
  // receives. Its invitation row is stored and an operator can re-send.
  const provisioned = await provisionAccounts(sendable, token);

  // ⚠ THE MAP HOLDS LIVE CREDENTIALS. It is request-scoped, never logged, and never
  // serialised into the response, the only read is the email body below. Keyed on the
  // lowercased address, matching how the invitation was stored.
  const provisionByEmail = new Map<string, ProvisionResult>();
  const provisionFailures: { email: string; reason: string; retryable: boolean }[] = [];
  // Accounts that exist but have NO ROLE. Called out separately because the person CAN
  // sign in and will then be refused a session, the ghost-account failure, and the
  // operator needs to know to re-invite to repair it.
  const roleless: string[] = [];

  for (const outcome of provisioned) {
    if (outcome.ok) {
      provisionByEmail.set(outcome.email.toLowerCase(), outcome.result);
      if (!outcome.result.groupAssigned) {
        roleless.push(outcome.email);
      }
    } else {
      provisionFailures.push(outcome.failure);
    }
  }

  if (provisionFailures.length > 0) {
    // Structured, with the reason as a discrete field: the reasons are
    // upstream-influenced strings and must never act as format specifiers. No address
    // local part and no credential.
    console.error("[INVITE] account provisioning failed", {
      failed: provisionFailures.length,
      of: sendable.length,
      scope: scopeLabel,
      reasons: provisionFailures.map((f) => f.reason),
    });
  }
  if (roleless.length > 0) {
    // The alarm-worthy one: these accounts can sign in and cannot get a session.
    console.error(
      "[INVITE] provisioned accounts have NO ROLE GROUP, re-invite to repair",
      { count: roleless.length, scope: scopeLabel }
    );
  }

  // Only addresses with a real, usable account are emailed. Emailing the rest would
  // hand out a temporary password for an account that does not exist, and every
  // sign-in attempt would be reported to them as a credential failure.
  const emailable = sendable.filter((to) => provisionByEmail.has(to.toLowerCase()));

  // Two templates, because the copy differs in substance and not just in wording:
  // team-invite says "join the team X" and names it in the subject, which would be
  // a lie (or an empty string) for someone being made a facilitator.
  // registration-invite is the team-less one and already existed for exactly this.
  const notifyPath = isPlatformInvite
    ? "/v1/notify/registration-invite"
    : "/v1/notify/team-invite";

  // ── STEP 3: EMAIL each recipient their link AND their temporary password. ──
  //
  // ⚠ PACED, NOT PARALLEL, and this was a real defect, not a precaution.
  //
  // This was `Promise.allSettled(emailable.map(...))`: an unbounded fan-out against SES's
  // `MaxSendRate` of 1.0/sec (sandbox, this account). Inviting five people issued five simultaneous
  // sends, four were throttled, and the SDK's three retries rescue a small batch but not a large
  // one. A lost send is NOT a lost email, it takes the account's temporary password with it, since
  // `provision.ts` mints that once and stores it nowhere, so the operator must RE-INVITE.
  //
  // `runPaced` returns the same `PromiseSettledResult[]` shape, so the accounting below is
  // unchanged. See lib/send-pacer.ts for why a rate needs a gap rather than a concurrency limit.
  const results = await runPaced(emailable, (to) =>
    backendFetch(notifyPath, {
        method: "POST",
        body: JSON.stringify({
          to,
          // `actionUrl` is what both routes read (team-invite accepts inviteUrl as a
          // back-compat alias); sending the canonical name keeps one shape here.
          actionUrl: buildInviteUrl(tokenByEmail.get(to.toLowerCase())!),
          roleLabel: label,
          inviterName,
          // The expiry is enforced on the invitation ROW either way, so both
          // templates must state it, an invited facilitator whose link lapses
          // silently is the same dead end as an invited participant's.
          expiryText: expiryText(INVITE_TTL_HOURS),
          // ⚠ THE TEMPORARY PASSWORD, on its only journey, AND ONLY FOR A NEW ACCOUNT.
          //
          // The account was admin-created with it and this email is the sole delivery: it
          // is not stored, not logged, and not recoverable, so an email that fails to send
          // means the operator must RE-INVITE rather than resend. `!` is safe -
          // `emailable` is filtered on this map having the key.
          //
          // ── OMITTED WHEN THE ACCOUNT ALREADY EXISTED, AND THE OMISSION IS THE FIX ──
          //
          // The failure this prevents: a participant who was removed from a team and then
          // re-invited received an email containing a temporary password, despite having
          // long been registered with a password of their own.
          //
          // The password in that email was NEVER LIVE. `provisionAccount` catches
          // `UsernameExistsException` and returns `alreadyExisted: true` WITHOUT resetting
          // the credential, deliberately, because "the existing account may be in active
          // use with a password its owner chose, and silently replacing it would lock them
          // out" (user-access/src/adapters.ts). Cognito confirms it: the account stayed
          // CONFIRMED rather than dropping to FORCE_CHANGE_PASSWORD. So the generated
          // password was minted, printed, and applied to nothing.
          //
          // That makes this a TRUST defect rather than a lockout: the recipient is handed a
          // credential that silently does not work, and the only way to discover that is to
          // try it and be told "incorrect email or password", indistinguishable from
          // mistyping it. Worse, it invites them to abandon a working password for a dead
          // one, and it puts a real-looking credential in a mailbox for no reason.
          //
          // `alreadyExisted` was already on `ProvisionResult` and simply not consulted
          // here. The notify templates already handle the field being absent: `introLines`
          // switches the copy to "Sign in below, if you don't know your password, use
          // 'Forgot password?'", which is the correct instruction for someone who has an
          // account. So the fix is to stop sending it, not to add a branch downstream.
          ...(provisionByEmail.get(to.toLowerCase())!.alreadyExisted
            ? {}
            : {
                temporaryPassword: provisionByEmail.get(to.toLowerCase())!
                  .temporaryPassword,
              }),
          ...(isPlatformInvite ? {} : { teamName }),
        }),
        token,
      })
  );

  const emailed = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - emailed;
  if (failed > 0) {
    // An email that failed to send is NOT merely re-sendable any more, and that is a
    // real change from the self-signup model: the temporary password was in that email
    // and exists nowhere else. The operator must RE-INVITE (which re-provisions and
    // mints a fresh password), not "resend".
    console.warn(
      // Structured for the same reason as the line above: the scope carries a caller-supplied name.
      `[INVITE] ${failed}/${results.length} invite emails failed to send, re-invite those addresses (the temporary password is not recoverable)`,  // nosemgrep: unsafe-formatstring
      { scope: scopeLabel }
    );
  }

  // ── AUDIT: Log the invitation issuance on the success path. ──
  auditLog({
    event: "account.invite.issued",
    actor: { id: session.user?.id, role: session.user?.role },
    target: { teamId: targetTeamId, requestedRole, workshopId },
    outcome: "success",
    metadata: {
      recipientCount: recipients.length,
      provisioned: provisionByEmail.size,
      emailed,
      provisionFailures: provisionFailures.length,
      isPlatformInvite,
    },
  });

  // The response reports the three stages separately, because "sent: 5" alone would
  // hide a batch where two accounts failed to provision. `provisioned` is the count of
  // real accounts; `emailed` is how many people can actually act on them.
  //
  // Deliberately omits every temporary password, and reports failures as an address +
  // an operator-facing reason with no credential in it.
  return NextResponse.json({
    success: true,
    sent: recipients.length,
    provisioned: provisionByEmail.size,
    emailed,
    // Present only when something needs attention, so the happy path's shape is
    // unchanged for existing callers.
    ...(provisionFailures.length > 0
      ? { provisionFailures: provisionFailures.map((f) => ({ email: f.email, reason: f.reason, retryable: f.retryable })) }
      : {}),
    // Accounts that exist with no role. Surfaced so the UI can say "re-invite to
    // repair" rather than reporting a clean success for someone who cannot sign in.
    ...(roleless.length > 0 ? { rolelessAccounts: roleless } : {}),
  });
}
