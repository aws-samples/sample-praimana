import type {
  PreSignUpTriggerEvent,
  PreSignUpTriggerHandler,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Cognito PRE-SIGNUP trigger — the invite-only gate.
 *
 * ⚠ STATUS AS OF THE ADMIN-PROVISIONED REGISTRATION CHANGE: this trigger is STILL LIVE
 * AND STILL LOAD-BEARING. It is not dormant, and it must not be deleted.
 *
 * Self-service sign-up is now OFF (`AllowAdminCreateUserOnly: true` on the pool), so
 * the `PreSignUp_SignUp` source no longer occurs — Cognito refuses the SignUp API before
 * any trigger runs. But this handler has NO triggerSource check, which turns out to be
 * exactly right: it also fires on `PreSignUp_AdminCreateUser`, so it gates the
 * ADMIN-CREATE path too. Verified against the live dev pool — AdminCreateUser for an
 * address with no invitation is refused with "Registration is by invitation only." and
 * NO account is created; seeding a live invitation first makes the same call succeed.
 *
 * Two consequences that other code depends on, stated here because this is where the
 * behaviour lives:
 *
 *   1. The invitation ROW MUST EXIST BEFORE AdminCreateUser is called. The provisioning
 *      sequence in the portal's /api/invite route stores the row first for this reason,
 *      and the user-access service treats a UserLambdaValidationException from
 *      AdminCreateUser as an internal sequencing bug rather than a user error.
 *   2. Nothing else needs to re-implement invite-only checking on the admin path. The
 *      user-access service checks it too, but as a way to produce a better message and
 *      a distinct status — not because this gate can be skipped.
 *
 * Do NOT delete this handler if the self-signup path ever looks unreachable: it is the
 * defence in depth if `AllowAdminCreateUserOnly` is ever flipped back (an AWS-internal
 * mitigation flipped that flag once already), and removing a security control because it
 * appears unused is how it comes back missing.
 *
 * Replaces the invitation check that used to live in the identity service's
 * POST /v1/auth/register. This trigger runs BEFORE the user is created: it checks
 * whether the email was INVITED (by an admin/facilitator) and THROWS if there is no
 * live match — which Cognito surfaces as a failed sign-up or a failed admin-create.
 * No invitation → no account, exactly as before.
 *
 * The gate is keyed on EMAIL alone. There is no signup code: the invite is a
 * server-stored record an admin/facilitator created for a specific address (the
 * team join code is a separate thing, used to join a team, not to authenticate).
 * The role itself is resolved (again, by email) in the post-confirmation trigger —
 * never trusted from the client — preserving the tamper-proof-role invariant.
 *
 * WHY READ DYNAMODB DIRECTLY, not the Team service's /invitations/lookup-by-email?
 * That route is deliberately unmapped in API Gateway (its lookup* siblings are
 * internal-only and must stay unreachable from the browser), so the HTTP hop this
 * trigger used to make 404'd for EVERY address and the gate failed closed on all
 * of them — nobody could register. The role and table permission this needs were
 * already provisioned (TABLE_INVITATIONS in the environment, dynamodb:Query on the
 * table AND its indexes in CognitoTriggerRole), so the direct read is what the
 * infrastructure was built for. It also drops a network hop from the signup path.
 *
 * The trade-off accepted knowingly: this handler and the Team service now both
 * know the invitations table's shape. The alternative — exposing the internal
 * lookup through the gateway — would put an unauthenticated email-probing
 * endpoint on the internet, which is worse. `expiresAt` handling is mirrored from
 * team/src/invite-token.ts and the two must agree; see the comment on isExpired.
 */

const TABLE_INVITATIONS =
  process.env.TABLE_INVITATIONS || "praimana-invitations";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface InvitationRow {
  teamId?: string;
  email?: string;
  status?: string;
  /** ISO-8601. Absent on invitations that predate invite-link expiry. */
  expiresAt?: string;
}

/**
 * True when an invitation's link has lapsed. MIRRORS isExpired() in
 * services/team/src/invite-token.ts — the two definitions must agree, and are
 * duplicated only because this Lambda bundles standalone (no workspace deps, see
 * package.json). A MISSING expiresAt counts as NOT expired so invitations created
 * before this field stay redeemable; an unparseable one IS expired (corruption
 * fails closed).
 */
export function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at <= now;
}

/**
 * True when an invitation has already been redeemed.
 *
 * ABSENT STATUS IS NOT ACCEPTED, and the polarity matters as much as it does for
 * isExpired: rows written before `status` existed have no attribute, and treating those as
 * accepted would refuse every legacy invitation. So this tests for the deny value.
 *
 * Compared case-insensitively because this handler is a standalone bundle that cannot import
 * the Team service's constants — the string is a cross-service contract carried in two
 * places, and a casing difference must not silently reopen the bypass this closes.
 */
export function isAccepted(status: string | undefined): boolean {
  return typeof status === "string" && status.trim().toUpperCase() === "ACCEPTED";
}

/**
 * True when an invitation's grant was WITHDRAWN.
 *
 * `REVOKED` is written by the Team service when a member is REMOVED from a team — see
 * `markRevoked` in services/team/src/repository.dynamo.ts. The row is FLIPPED rather
 * than deleted because it is also the record of who invited them and when they accepted, so
 * unlike a PENDING revoke (which deletes) the row SURVIVES — and a surviving row is a thing
 * this gate reads.
 *
 * WHY THIS GATE NEEDS TO KNOW. `isAccepted` alone answers false for a REVOKED row, so
 * without this predicate a withdrawn invitation would keep admitting a BRAND-NEW
 * registration through exactly the four-step bypass documented on `isInvited` below: their
 * Cognito account is deleted, the terminal row is still inside its expiry window, they
 * register again, and every record keyed on the old sub — the removal included — no longer
 * applies to them. A grant that has been taken away must not be a way to get an account.
 *
 * Same absent-is-not-terminal polarity and same case-insensitive comparison as `isAccepted`,
 * for the same reasons: rows predating the field must stay redeemable, and the string is a
 * cross-service contract carried in separate bundles where a casing difference must not
 * silently reopen a bypass.
 */
export function isRevoked(status: string | undefined): boolean {
  return typeof status === "string" && status.trim().toUpperCase() === "REVOKED";
}

/**
 * True if the email has at least one LIVE (un-expired) server-stored invitation.
 *
 * Queries the email-index GSI, the same access path the Team service's
 * listByEmail uses. Errors propagate to the caller, which fails closed.
 */
async function isInvited(email: string): Promise<boolean> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_INVITATIONS,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": email },
    })
  );

  const rows = (res.Items as InvitationRow[]) ?? [];
  if (rows.length === 0) return false;

  // An invitation admits a sign-up only if it is BOTH un-expired AND unredeemed.
  //
  // EXPIRY: an expired invite must not admit a sign-up even though the row still exists
  // (rows are kept as the ACCEPTED/audit record behind /invitations/mine, so they are never
  // deleted on expiry). Enforced HERE, not on the invite link, because the Hosted UI cannot
  // forward the link's token to this trigger — this is the one place the 24h window is
  // unbypassable.
  //
  // ALREADY ACCEPTED — the fix for a real bypass. `status` was declared on the row type
  // above and never read, so an ACCEPTED invitation kept admitting NEW registrations
  // forever. The path:
  //
  //   1. Someone registers on an invitation. The row flips to ACCEPTED and stays (it is the
  //      audit record of who granted them access, and the revoke route refuses to delete an
  //      accepted row for exactly that reason).
  //   2. Their Cognito account is later deleted — in the console, or it never existed (the
  //      `sub || ulid()` fallback produces profile rows with no account behind them).
  //   3. Their ACCEPTED row is still there, and — verified in the dev table — still inside
  //      its expiry window.
  //   4. They register again. This gate says yes. A brand-new account is created with a NEW
  //      Cognito sub, and every per-user record keyed on the old sub no longer applies to
  //      them.
  //
  // An accepted invitation means the person ALREADY REGISTERED, so it can never legitimately
  // authorise a second registration. Re-admitting someone is an explicit act: an admin
  // issues a fresh invitation, which writes a new PENDING row.
  //
  // REVOKED — the same bypass from the other direction. A withdrawn grant is now a
  // SURVIVING row: when a member is removed from a team the Team service flips their
  // invitation to REVOKED rather than deleting it (the row is also the record of who invited
  // them and when they accepted). `isAccepted` answers false for it, so without the second
  // predicate a removed person's withdrawn invitation would keep admitting a brand-new
  // registration through steps 2-4 above. A grant that was taken away must not be a way to
  // get an account.
  //
  // Matched case-INSENSITIVELY and against the value, not its absence: a row with no
  // `status` at all predates the field and must stay redeemable, exactly as a missing
  // `expiresAt` does. Same fail-open-on-absence rule as isExpired, for the same reason —
  // the alternative locks out every legacy invitation.
  const now = Date.now();
  return rows.some(
    (row) =>
      !isExpired(row.expiresAt, now) &&
      !isAccepted(row.status) &&
      !isRevoked(row.status)
  );
}

export const handler: PreSignUpTriggerHandler = async (
  event: PreSignUpTriggerEvent
) => {
  const attrs = event.request.userAttributes ?? {};
  const email = (attrs.email || "").toLowerCase();

  if (!email) {
    throw new Error("Email is required.");
  }

  let invited: boolean;
  try {
    invited = await isInvited(email);
  } catch (err) {
    // Fail closed: if the lookup can't be made we do NOT admit the sign-up. Logged
    // because this branch is indistinguishable from "not invited" to the user, and
    // a misconfigured table/permission would otherwise look like a wall of
    // legitimate refusals.
    console.error("[cognito-presignup] invitation lookup failed", {
      table: TABLE_INVITATIONS,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error("Registration is by invitation only.");
  }

  if (!invited) {
    // One message for "never invited" and "invite expired" alike: the sign-up form
    // is public, so it must not confirm whether an address was ever invited.
    throw new Error("Registration is by invitation only.");
  }

  // Do NOT auto-confirm — MFA/email verification still applies on the self-signup path,
  // and on the ADMIN-CREATE path these two fields are ignored by Cognito anyway (an
  // admin-created user starts in FORCE_CHANGE_PASSWORD regardless, and its
  // email_verified comes from the AdminCreateUser attributes — the provisioning code
  // sets it true because the invitation is the proof of the address).
  //
  // Left as false rather than made conditional on the trigger source: setting them true
  // would be a real weakening of the self-signup path for no gain on the admin path.
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;

  return event;
};
