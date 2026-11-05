/**
 * User Access bounded context — the ONE place that performs Cognito ADMIN WRITES.
 *
 * WHY THIS SERVICE EXISTS AT ALL, given the identity service already owns users:
 * a `cognito-idp` call cannot be made from inside the VPC. This pool has a
 * managed-login DOMAIN assigned, and "the existence of a user pool domain prevents
 * completion of any user pool requests that transit a VPC endpoint" — so PrivateLink
 * is not an option, and with no NAT there is no other egress. A cognito-idp call from
 * IdentityFunction HANGS and then fails. That is not a hypothetical: an endpoint once
 * existed for the post-confirmation trigger's AdminAddUserToGroup and silently left
 * every confirmed user in NO group (see the note above BedrockRuntimeEndpoint in
 * the infrastructure CloudFormation template).
 *
 * So this function runs OUTSIDE the VPC, reaching the public cognito-idp endpoint
 * over TLS + SigV4, exactly like NotifyFunction and the two Cognito triggers do for
 * their own dependencies. It is deliberately ONE function rather than one per
 * operation: provisioning an account and disabling an account face the identical
 * constraint and need the identical IAM, and splitting them would mean two roles with
 * `cognito-idp:Admin*` instead of one.
 *
 * Everything here depends on PORTS (the interfaces below), never on an AWS SDK type.
 * The composition root (app.ts) supplies the adapters; tests supply fakes. That is
 * what makes the provisioning SEQUENCE — the part with the interesting failure
 * semantics — testable without a user pool.
 */

/** The platform roles this service will assign. Mirrors the Cognito groups. */
export const VALID_ROLES = [
  "ADMIN",
  "FACILITATOR",
  "EXECUTIVE",
  "PARTICIPANT",
  "JUDGE",
] as const;
export type Role = (typeof VALID_ROLES)[number];

/**
 * Single-role precedence (lower index wins), collapsing an email's several
 * invitations to the one highest-privilege platform role.
 *
 * A FOURTH copy of a contract that already exists in
 * cognito-postconfirmation/src/handler.ts, team/src/routes.ts and
 * service-shared/edge-identity.ts, for the same reason as those: these are bundled
 * Lambdas that take no dependency on `@praimana/shared`. All of them must
 * agree with the Cognito group `Precedence` values in the all-in-one template.
 */
export const ROLE_PRECEDENCE = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
  "EXECUTIVE",
  "PARTICIPANT",
] as const;

/**
 * The one authoritative role for a set of Cognito GROUP names, or null when none of
 * them is a role we recognise.
 *
 * ⚠ NULL RATHER THAN A PARTICIPANT FALLBACK, and the difference is the whole point.
 * `collapseCognitoGroups` in @praimana/shared and `collapseGroupsToRole` in
 * service-shared both degrade to PARTICIPANT, which is correct for THEIR question —
 * "what may this caller do?", where the least-privileged answer is the safe one.
 *
 * This function answers the opposite question: "what role is the TARGET of an
 * administrative action?". Defaulting an unreadable target to PARTICIPANT would make
 * every account whose groups we cannot parse administrable by a FACILITATOR — the
 * least-privileged answer is the DANGEROUS one here. So an unknown target role is
 * reported as unknown, and the caller refuses the action (see the access route).
 */
export function roleFromGroups(groups: readonly string[]): Role | null {
  for (const role of ROLE_PRECEDENCE) {
    if (groups.includes(role)) return role;
  }
  return null;
}

// ─── Who may hand out which role ────────────────────────────────────────────

/**
 * WHICH PLATFORM ROLES A ROLE MAY HAND OUT — the privilege boundary on PROVISIONING.
 *
 * A deliberate LOCAL COPY of ROLE_GRANTS in the shared constants/roles module,
 * for the same reason as ROLE_PRECEDENCE and USER_ADMIN_GRANTS: this is a bundled
 * Lambda that takes no dependency on that package. The Team service keeps a third copy
 * (its own routes.ts) for the same reason. The shared copy drives what the invite
 * dropdowns OFFER; these two are the ENFORCEMENT, and domain.test.ts asserts the whole
 * matrix so they cannot drift.
 *
 * ── WHY THIS TABLE IS CONSULTED HERE AT ALL, WHEN THE ROW ALREADY CARRIES THE ROLE ──
 * Because the row's role is only tamper-proof with respect to THIS REQUEST — it says
 * nothing about who wrote it. The route resolves the role from the invitation and
 * nothing reads `invitedBy`, so a caller who merely passed the coarse surface gate
 * could materialise an account for a role SOMEBODY ELSE was authorized to grant, and
 * the response hands back that account's live temporary password. Since the pool
 * became AllowAdminCreateUserOnly, provisioning is not bookkeeping about a grant —
 * it CREATES THE ACCOUNT AND MINTS ITS CREDENTIAL — so the caller must be entitled to
 * the role in its own right, not merely entitled to create some account.
 *
 * That was a live escalation, not a hypothetical: JUDGE and EXECUTIVE both passed
 * canProvision, so either could guess an address holding a pending ADMIN invitation
 * (a normal state — the portal's invite route leaves the row and sends no email when
 * provisioning fails, and a row with no `expiresAt` never expires), receive the ADMIN
 * account's temporary password, and — the pool being MfaConfiguration: ON with no
 * factor yet enrolled — complete NEW_PASSWORD_REQUIRED into MFA_SETUP and enrol their
 * own authenticator. Checked BEFORE generateTemporaryPassword for that reason: no
 * credential may exist for a request that is going to be refused.
 *
 * ── THREE MATRICES IN THIS SERVICE, AND THE DISTINCTION IS LOAD-BEARING ──
 *   PROVISIONER_ROLES (routes.ts) — may this role cause ANY account to be created?
 *     A coarse floor on the whole surface, applied before the body is parsed and
 *     before the invitation lookup.
 *   ROLE_GRANTS (here) — may this role hand out THIS role? Forward-looking: the
 *     invitee has NO ACCOUNT YET, so granting a PEER is harmless — a facilitator
 *     staffing a workshop with a second facilitator takes nothing from anyone.
 *   USER_ADMIN_GRANTS (below) — may this role act on an EXISTING account? That
 *     reaches into an account already in use, so a PEER is a lateral attack.
 * NONE of the three is derived from another, and they must not be: the comment on
 * ROLE_GRANTS in the shared constants/roles module explains at length why a single table cannot answer
 * all three questions, and a derivation would silently propagate the next widening of
 * one into the other two.
 *
 * Read as: key = the caller's role, value = the roles they may hand out.
 *   ADMIN       → anything, another ADMIN included.
 *   FACILITATOR → everything EXCEPT ADMIN. A facilitator staffs workshops but must
 *                 not be able to manufacture a peer with full platform access.
 *   EXECUTIVE   → PARTICIPANT only. A sponsor may bring in their own builders, not
 *                 fellow observers.
 *   JUDGE       → NOTHING (judging is an assignment, not a club that grows
 *                 itself).
 *   PARTICIPANT → NOTHING. An empty list is the closed case, so "no entry" and "empty
 *                 entry" must behave identically.
 */
const ROLE_GRANTS: Record<string, readonly string[]> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: ["PARTICIPANT"],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * The roles `inviterRole` may hand out, or null when the role is not in the table.
 *
 * `Object.hasOwn` BEFORE the index, for the same reason as administrableRoles below —
 * and this is not a theoretical concern here either: the caller's role arrives from a
 * token's group claim, i.e. from outside, and a bare `ROLE_GRANTS[role]` also finds
 * INHERITED properties. `"constructor"` resolves to Object's constructor, which is
 * truthy, so a `!grantable` guard passes it through and `.includes` then throws — a
 * 500 where a 403 belongs. That exact bug was found and fixed once already in this
 * file; the guard is written the same way so it cannot come back in a second table.
 */
function grantableRoles(
  inviterRole: string | null | undefined
): readonly string[] | null {
  if (!inviterRole) return null;
  if (!Object.hasOwn(ROLE_GRANTS, inviterRole)) return null;
  return ROLE_GRANTS[inviterRole];
}

/**
 * True if `inviterRole` may hand out `targetRole` — i.e. may cause an account to be
 * created for it.
 *
 * Fails CLOSED on an absent or unrecognised role on EITHER side, and the target half
 * matters as much as the actor half: the target role comes from a stored invitation
 * row, so a row carrying a role this table does not know (a role added to the platform
 * without a decision here, or a corrupt value) must refuse rather than fall through to
 * a permissive default. resolveRoleFromInvitations happens to collapse an unknown
 * `platformRole` to PARTICIPANT today; this predicate does not rely on that, because
 * "unreachable because of what the caller happens to pass" is not a property of an
 * authorization predicate.
 */
export function canGrantRole(
  inviterRole: string | null | undefined,
  targetRole: string | null | undefined
): boolean {
  if (!targetRole) return false;
  const grantable = grantableRoles(inviterRole);
  if (!grantable) return false;
  return grantable.includes(targetRole);
}

// ─── Who may administer an existing account ─────────────────────────────────

/**
 * WHICH ROLES MAY ADMINISTER AN EXISTING USER'S ACCOUNT — the privilege boundary on
 * disable/enable.
 *
 * A deliberate LOCAL COPY of USER_ADMIN_GRANTS in
 * the shared constants/roles module, for the same reason as ROLE_PRECEDENCE
 * above: this is a bundled Lambda that takes no dependency on that package. The
 * shared copy drives what the Administration screen OFFERS; this one is the
 * ENFORCEMENT, and domain.test.ts asserts the whole matrix so the two cannot drift.
 *
 * Deliberately NOT the same table as ROLE_GRANTS (immediately above) or
 * PROVISIONER_ROLES, which answer "whom may I INVITE?" — a forward-looking offer to
 * somebody with no account yet. This reaches into an account already in use, so acting
 * on a PEER is a lateral attack: one facilitator could disable another mid-workshop. A
 * FACILITATOR may therefore act only on STRICTLY LOWER roles — never an ADMIN, never
 * another FACILITATOR. The one cell where the two tables differ is exactly that:
 * ROLE_GRANTS lets a FACILITATOR grant FACILITATOR, this table does not.
 *
 * ADMIN may act on peers, because the top of the tree has to be able to revoke a
 * compromised or departed admin. Two guards make that safe and NEITHER is expressible
 * here, because both need state a pure predicate cannot see — the access route
 * enforces both:
 *   - no self-action (an admin must not lock themselves out),
 *   - never the LAST ENABLED ADMIN (that leaves nobody able to administer anything).
 */
const USER_ADMIN_GRANTS: Record<string, readonly string[]> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: [],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * The roles `actorRole` may administer, or null when the role is not in the table.
 *
 * `Object.hasOwn` BEFORE the index, and it is not defensive padding: the actor's role
 * arrives from a token's group claim, i.e. from outside, and a bare
 * `USER_ADMIN_GRANTS[role]` also finds INHERITED properties. `"constructor"` resolves
 * to Object's constructor — truthy, so a `!administrable` guard passes it through, and
 * the caller then either throws (`.includes` is not a function → a 500 where a 403
 * belongs) or reads `.length` as 1 and concludes the role may administer somebody.
 *
 * Not reachable today, because every producer of this value collapses the claim to one
 * of five literals. Guarded anyway: "unreachable because of what the caller happens to
 * pass" is not a property of an authorization predicate, and this is the shape of
 * fail-open that survives a refactor of the caller.
 */
function administrableRoles(
  actorRole: string | null | undefined
): readonly string[] | null {
  if (!actorRole) return null;
  if (!Object.hasOwn(USER_ADMIN_GRANTS, actorRole)) return null;
  return USER_ADMIN_GRANTS[actorRole];
}

/**
 * True if `actorRole` may administer an account whose CURRENT role is `targetRole`.
 *
 * Fails CLOSED on an absent or unrecognised role on EITHER side. An unknown TARGET
 * matters as much as an unknown actor: if a new, more privileged role is added and
 * this table is not updated, nobody may touch those accounts until somebody makes a
 * deliberate decision here — which is why roleFromGroups returns null rather than
 * guessing PARTICIPANT.
 */
export function canAdministerUser(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined
): boolean {
  if (!targetRole) return false;
  const administrable = administrableRoles(actorRole);
  if (!administrable) return false;
  return administrable.includes(targetRole);
}

/**
 * True if the role may reach the account-administration surface at all — i.e. may
 * administer at least one role. ADMIN and FACILITATOR only.
 *
 * A COARSE gate, applied before any lookup so an EXECUTIVE probing the route is
 * refused without costing three Cognito calls. It is NOT the boundary: what either
 * may do to an INDIVIDUAL account is still decided per target by canAdministerUser.
 */
export function canManageUsers(role: string | null | undefined): boolean {
  const administrable = administrableRoles(role);
  return !!administrable && administrable.length > 0;
}

// ─── Cognito username rules ──────────────────────────────────────────────────

/**
 * Cognito's hard ceiling on a username, in characters.
 *
 * Not ours to tune: the pool rejects anything longer with an
 * InvalidParameterException, and an unvalidated address would surface that as a 500
 * from a route the operator believes succeeded. Checked here so the caller gets a
 * clean 400 naming the problem.
 */
export const MAX_USERNAME_LENGTH = 128;

/**
 * Why an address cannot be used as a Cognito username, or null when it can.
 *
 * Deliberately NOT a full RFC-5322 email validator. This is the transport check that
 * keeps a malformed value from reaching AdminCreateUser — length, and the whitespace
 * or control characters the pool refuses. Whether the address can receive mail is a
 * different question, answered by SES, and the invitation flow already treats an
 * undeliverable invite as a recorded-but-unsent one.
 *
 * The `@` check is here because an address without one is never a mistake worth
 * creating an account for, and the pool's UsernameAttributes is [email].
 */
export function usernameRejectionReason(email: string): string | null {
  if (!email) return "an email address is required";
  // Measured in CODE POINTS, matching how the profile validator measures its
  // fields — `.length` would count a surrogate pair twice and reject an address
  // Cognito would have accepted.
  if ([...email].length > MAX_USERNAME_LENGTH) {
    return `email address must be ${MAX_USERNAME_LENGTH} characters or fewer`;
  }
  // \s covers space, tab, newline and the Unicode separators; the explicit ranges
  // cover the control characters \s does not (NUL..US, DEL, and the C1 block).
  // Cognito answers InvalidParameterException for any of them. Written as \u
  // ESCAPES rather than literal control characters so the source stays greppable and
  // a copy-paste cannot silently drop one.
  // eslint-disable-next-line no-control-regex -- matching control characters IS the check here
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(email)) {
    return "email address must not contain spaces or control characters";
  }
  if (!email.includes("@")) {
    return "email address must contain @";
  }
  return null;
}

// ─── Temporary password generation ───────────────────────────────────────────

/**
 * The pool's password policy, restated here as the generator's contract.
 *
 * MUST match `Policies.PasswordPolicy` on UserPool in
 * the infrastructure CloudFormation template. If the two drift, every
 * AdminCreateUser fails with InvalidPasswordException — which is why
 * temp-password.test.ts asserts these numbers explicitly rather than only asserting
 * that generated passwords "look strong".
 */
export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: true,
} as const;

/**
 * Length of the temporary password we generate.
 *
 * 24, not the policy minimum of 12. This value travels in an email and lives until
 * the recipient's first sign-in, so it is worth more than the floor — 24 characters
 * from the ~76-character alphabet below is ~150 bits of entropy, which puts offline
 * guessing out of reach even if a mailbox is later compromised. The cost is a longer
 * string to copy, and the recipient copies rather than types it.
 */
export const TEMP_PASSWORD_LENGTH = 24;

/**
 * The character pools, one per policy requirement.
 *
 * Ambiguous glyphs are deliberately EXCLUDED from the letter and digit pools —
 * O/0, l/I/1 — because a recipient who mis-transcribes one gets
 * NotAuthorizedException, which the UI (correctly, for enumeration reasons) reports
 * as "Incorrect email or password". That is an unfalsifiable dead end for someone
 * holding a password they believe is right. The symbol set is restricted to
 * characters that survive an HTML email body and a shell paste without escaping.
 */
const UPPERCASE = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O
const LOWERCASE = "abcdefghijkmnpqrstuvwxyz"; // no l, o
const DIGITS = "23456789"; // no 0, 1
const SYMBOLS = "!#$%&*+-=?@^_";

/**
 * A source of cryptographically secure random bytes.
 *
 * Injected as a port rather than calling `crypto` directly so a test can prove the
 * REJECTION-SAMPLING and shuffle logic against a controlled stream — the two places
 * a hand-rolled generator introduces bias. Production passes node:crypto's
 * randomBytes (see password.ts).
 */
export type RandomBytes = (size: number) => Uint8Array;

/**
 * One uniformly-random index in [0, max), by rejection sampling.
 *
 * `byte % max` is the obvious version and it is BIASED: with max=76, the 256 byte
 * values map to 76 buckets unevenly, so some characters are ~1.3x likelier than
 * others. That is a real (if modest) entropy loss in the one value this whole flow's
 * secrecy rests on. Rejection sampling discards the ragged tail instead.
 *
 * Bounded: draws in 32-byte batches and gives up after MAX_SAMPLING_BATCHES rather
 * than looping forever if the injected source ever returns a constant. The
 * probability of needing even a second batch is under 1e-5 for our alphabet sizes,
 * so the bound is unreachable in practice and exists to make "unreachable" true by
 * construction rather than by argument.
 */
const MAX_SAMPLING_BATCHES = 8;
const SAMPLING_BATCH_SIZE = 32;

function randomIndex(random: RandomBytes, max: number): number {
  if (max <= 0 || max > 256) {
    throw new Error(`randomIndex: max must be in 1..256, got ${max}`);
  }
  // The largest multiple of `max` that fits in a byte. Values at or above it are the
  // biased tail and get discarded.
  const limit = Math.floor(256 / max) * max;
  for (let batch = 0; batch < MAX_SAMPLING_BATCHES; batch++) {
    const bytes = random(SAMPLING_BATCH_SIZE);
    for (const byte of bytes) {
      if (byte < limit) return byte % max;
    }
  }
  throw new Error(
    "randomIndex: exhausted random batches without an unbiased sample — the entropy source is not behaving"
  );
}

function pick(random: RandomBytes, pool: string): string {
  return pool[randomIndex(random, pool.length)];
}

/**
 * Generate a temporary password that satisfies the pool policy BY CONSTRUCTION.
 *
 * The construction, and why it is this shape:
 *   1. Take one character from each required class, so the policy cannot be missed.
 *   2. Fill the rest from the combined alphabet.
 *   3. Fisher-Yates shuffle, so the guaranteed characters are not always in
 *      positions 0-3. Without the shuffle, the first four positions would leak the
 *      class layout and the effective search space would shrink.
 *
 * The alternative — generate randomly and retry until the policy happens to be
 * satisfied — has an unbounded worst case and no better distribution. This has
 * neither problem.
 *
 * ⚠ THE RETURN VALUE IS A SECRET. It must never be logged, stored, returned in an
 * API response, or attached to a trace/metric. It has exactly two destinations: the
 * AdminCreateUser call and the invitation email. The route that uses it is written to
 * keep it out of every other path — see routes.ts.
 */
export function generateTemporaryPassword(
  random: RandomBytes,
  length: number = TEMP_PASSWORD_LENGTH
): string {
  if (length < PASSWORD_POLICY.minimumLength) {
    // A caller asking for a shorter password than the pool accepts is a bug, and
    // failing here is far better than an InvalidPasswordException per invite.
    throw new Error(
      `temporary password length must be at least ${PASSWORD_POLICY.minimumLength}`
    );
  }

  const required = [UPPERCASE, LOWERCASE, DIGITS, SYMBOLS];
  const alphabet = required.join("");

  const chars: string[] = required.map((pool) => pick(random, pool));
  while (chars.length < length) {
    chars.push(pick(random, alphabet));
  }

  // Fisher-Yates, drawing each swap index from the same unbiased source.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(random, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

/**
 * Whether a password satisfies the pool policy. Exported for the generator's own
 * tests and as a self-check on the provisioning path — a generated password that
 * fails this is a code defect, and catching it before the Cognito call turns an
 * opaque per-invite failure into one loud error.
 */
export function meetsPasswordPolicy(password: string): boolean {
  if ([...password].length < PASSWORD_POLICY.minimumLength) return false;
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) return false;
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) return false;
  if (PASSWORD_POLICY.requireNumbers && !/[0-9]/.test(password)) return false;
  // Cognito's symbol class is everything non-alphanumeric in its documented set;
  // testing "not a letter, not a digit" is the honest way to express it without
  // pinning a list that could drift from the service's.
  if (PASSWORD_POLICY.requireSymbols && !/[^A-Za-z0-9]/.test(password)) {
    return false;
  }
  return true;
}

// ─── Ports ──────────────────────────────────────────────────────────────────

/** An invitation row, as much of it as this service reads. */
export interface InvitationRow {
  /**
   * The row's PARTITION KEY — a real team id, or the PLATFORM sentinel for a
   * role-only invitation. Read (rather than only `platformRole`) because revoking a
   * row needs its full key, and DynamoDB has no other way to address it.
   */
  teamId?: string;
  /** The row's SORT KEY, stored lower-cased. */
  email?: string;
  /**
   * PENDING / ACCEPTED. Absent on rows written before the field existed — which
   * counts as NOT accepted; see isAcceptedInvitation for why the polarity is forced.
   */
  status?: string;
  platformRole?: string;
  /** ISO-8601. Absent on invitations that predate invite-link expiry. */
  expiresAt?: string;
}

/**
 * Reads the invitation(s) an admin stored for an address.
 *
 * This is how the platform role is resolved, and it is the TAMPER-PROOF-ROLE
 * INVARIANT: the role comes from a server-stored row an authorized inviter wrote,
 * never from anything the caller of this service sent. Same seam the pre-signup gate
 * and the post-confirmation trigger use.
 */
export interface InvitationReader {
  listByEmail(email: string): Promise<InvitationRow[]>;
  /**
   * REVOKE one un-redeemed invitation, deleting the row outright.
   *
   * Deleting is the point rather than a shortcut, and the reasoning is the Team
   * service's (see InvitationRepository.revoke there): the ROW **IS** the permission
   * to register. The Cognito pre-signup trigger admits any email holding a live,
   * unredeemed row and post-confirmation reads `platformRole` off it, so flipping a
   * status field would leave the grant intact for every reader that did not learn the
   * new status. While the row exists, the grant exists.
   *
   * Returns TRUE only when THIS call deleted a row, so a caller can report a real
   * count rather than the number of rows it hoped to delete. Missing rows are benign
   * — that is what makes disabling an already-disabled user idempotent.
   *
   * THROWS on a real store failure (throttle, timeout, AccessDenied). Deliberately
   * not swallowed: the caller decides, and the disable route reports a partial revoke
   * instead of claiming a clean one.
   */
  revoke(teamId: string, email: string): Promise<boolean>;
}

/**
 * True when an invitation has already been redeemed.
 *
 * MIRRORS isAccepted() in cognito-presignup/src/handler.ts, and the two must agree:
 * that handler's header comment documents the exact bypass this closes. An ACCEPTED
 * row is the audit record of a redeemed grant, so it never legitimately authorises a
 * second registration, and revoking one would destroy that record.
 *
 * ABSENT STATUS IS NOT ACCEPTED — the same fail-open-on-absence polarity as isExpired,
 * for the same reason: rows written before `status` existed have no attribute, and
 * treating those as accepted would leave a real live grant un-revoked at exactly the
 * moment somebody's access is being withdrawn. Compared case-insensitively because
 * the string is a cross-service contract carried in three bundles.
 */
export function isAcceptedInvitation(status: string | undefined): boolean {
  return typeof status === "string" && status.trim().toUpperCase() === "ACCEPTED";
}

/**
 * True when an invitation's grant was WITHDRAWN.
 *
 * `REVOKED` is written by the Team service when a member is REMOVED from a team (see
 * `markRevoked` there). The row is FLIPPED rather than deleted — unlike the PENDING revoke
 * this service performs, which deletes — because it is also the record of who invited them
 * and when they accepted, and the team's former-members view reads provenance from it.
 *
 * TWO CALLERS HERE, and it matters to both:
 *
 *   resolveRoleFromInvitations — a withdrawn grant must not decide the platform ROLE a
 *     newly-provisioned account is given. It filtered on expiry alone, so a REVOKED row
 *     would still have voted, with whatever privilege it carried.
 *   liveInvitationKeys — a REVOKED row is not a live credential, so disabling someone must
 *     not try to DELETE it. Doing so would destroy the provenance the flip exists to keep,
 *     and would remove the only evidence the grant was withdrawn.
 *
 * MIRRORS isRevoked() in cognito-presignup/src/handler.ts and cognito-postconfirmation, and
 * isRevokedInvitation() in team/src/domain.ts. Same ABSENT-IS-NOT-REVOKED polarity and same
 * case-insensitive comparison as isAcceptedInvitation, for the same reasons.
 */
export function isRevokedInvitation(status: string | undefined): boolean {
  return typeof status === "string" && status.trim().toUpperCase() === "REVOKED";
}

/**
 * The invitations that are still LIVE CREDENTIALS for an address — un-expired and
 * unredeemed — and so must be revoked when that person's access is withdrawn.
 *
 * WHY REVOKING IS PART OF DISABLING (deactivating a user also revokes their pending
 * invitations): an unredeemed invitation is a live credential.
 * Left in place, a disabled person can register AGAIN through the invite-only gate and
 * receive a BRAND-NEW Cognito sub — at which point every record keyed on the old sub,
 * the disable itself included, no longer applies to them. Cognito's disabled flag is
 * per-account, and that would be a different account.
 *
 * The same admission-by-stale-row bypass is described in full on
 * cognito-presignup/src/handler.ts (the `isAccepted` note); this closes the other half
 * of it from the revocation side.
 *
 * Rows with no `teamId` or no `email` are counted as `unaddressable` rather than
 * silently dropped: those two are the table's composite key, so such a row cannot be
 * deleted at all — but it is still a live grant, so the caller must be able to report
 * an INCOMPLETE revoke rather than a clean one. Reporting a complete sweep while
 * leaving a live credential behind would be the wrong answer to the one question this
 * step exists to answer.
 */
export function liveInvitationKeys(
  rows: readonly InvitationRow[],
  now: number
): {
  keys: { teamId: string; email: string }[];
  unaddressable: number;
} {
  const keys: { teamId: string; email: string }[] = [];
  let unaddressable = 0;

  for (const row of rows) {
    if (isExpired(row.expiresAt, now)) continue;
    if (isAcceptedInvitation(row.status)) continue;
    // Neither is a REVOKED row, and for the SAME reason as ACCEPTED: it is history rather
    // than a live credential, and deleting it would destroy the record of a grant that was
    // deliberately withdrawn (plus the provenance the team's former-members view reads).
    // Skipped BEFORE the key check below so it never counts as `unaddressable` — nothing
    // about it is un-revoked, so it must not make a clean sweep report as incomplete.
    if (isRevokedInvitation(row.status)) continue;
    if (!row.teamId || !row.email) {
      unaddressable++;
      continue;
    }
    keys.push({ teamId: row.teamId, email: row.email });
  }

  return { keys, unaddressable };
}

/** The profile row this service writes for a newly-provisioned account. */
export interface ProfileWrite {
  id: string;
  email: string;
  role: Role;
}

/**
 * Platform access, as MIRRORED onto the profile row. Cognito is the authority.
 *
 * Mirrors UserStatus in the shared types/user module — a bundled Lambda, same
 * local-copy reason as everything else here. Read that field's doc comment before
 * changing anything: this value is a DISPLAY MIRROR and must never become an
 * authorization input.
 */
export type UserStatus = "ACTIVE" | "DEACTIVATED";

/**
 * The users profile store, as this service needs it.
 *
 * `upsertProvisioned` is deliberately NOT a full-item put. A provisioning call may
 * run a SECOND time for an address that already has a row — an admin re-inviting
 * someone who has since filled in their name and organisation — and a `PutCommand`
 * would silently erase those fields. See the adapter for the UpdateCommand that
 * makes it a merge.
 */
export interface ProfileStore {
  upsertProvisioned(profile: ProfileWrite): Promise<void>;
  /**
   * Mirror an account's access state onto its profile row, FOR DISPLAY ONLY.
   *
   * The identity service serves the Administration directory and has no Cognito
   * client and no Cognito IAM, so without this copy the screen could not show who is
   * disabled or offer a way to reverse it. Cognito's own disabled flag remains the
   * only thing that stops a sign-in — see UserStatus above.
   *
   * Returns TRUE when a row was actually updated. FALSE means there was no profile
   * row to mirror onto (a Cognito account with no row, which the provisioning path
   * can produce when the sub could not be resolved), which is a stale-badge problem
   * and NOT a reason to fail an access change that Cognito has already applied.
   *
   * MUST NOT be a blind put: the row carries the user's own firstName/lastName/
   * organization, and this write has no business with any of them.
   *
   * ── `accessChangedBy` / `accessChangedAt`: THE ROW'S OWN BREADCRUMB ──
   *
   * The audit trail remains the authoritative record. This is the fallback for when the
   * trail is the thing that failed: `audit.record` returns false rather than throwing, so
   * an access change can take effect with `audited: false` and — before these two fields —
   * the operator's identity existed NOWHERE. Cognito records no actor on
   * AdminDisableUser/AdminEnableUser beyond CloudTrail, and the profile row carried none,
   * so an unaudited disable was permanently unattributable.
   *
   * That was the asymmetry worth closing: the TEAM service's equivalents already write
   * `removedBy` / `reactivatedBy` onto the membership row in the same UpdateCommand as the
   * status flip, so a removal survives its own audit failure. This makes the platform-access
   * path behave the same way.
   *
   * ⚠ NOT AN AUTHORIZATION INPUT, and never to be read as one — same rule as `status`
   * itself. It is a display and forensics field. Nothing may branch on it.
   *
   * NOT CLEARED on a later change: each write overwrites with the most recent actor, which
   * is what "who put the account in the state it is in NOW" means. History is the trail's
   * job, not the row's.
   */
  setStatus(input: {
    userId: string;
    status: UserStatus;
    /** The sub of the operator making the change — from the verified token, never a body. */
    actorId: string;
  }): Promise<boolean>;
}

/** A Cognito account, as much of it as this service needs to act on. */
export interface DirectoryAccount {
  /**
   * The value Cognito's admin APIs address this account BY.
   *
   * Taken from the directory rather than assumed to be the sub or the email: this
   * pool has UsernameAttributes [email], but Cognito assigns an internal username on
   * some creation paths, and an admin call against the wrong handle is an
   * UserNotFoundException on a route the operator believes worked.
   */
  username: string;
  /**
   * The account's email — the key an INVITATION row is stored under, which is why it
   * is read here rather than looked up separately. Lower-cased by the adapter to
   * match how the team service writes those rows.
   */
  email: string;
  /** Cognito's own enabled flag: the AUTHORITY on whether this account may sign in. */
  enabled: boolean;
}

/** Cognito admin operations. One port, so the whole set is faked in one place. */
export interface UserDirectory {
  /**
   * Create an account with a temporary password, suppressing Cognito's own email.
   * Resolves with `alreadyExisted: true` instead of throwing when the account is
   * already there — that is a benign re-invite, not a failure.
   */
  createUser(input: {
    email: string;
    temporaryPassword: string;
    signal: AbortSignal;
  }): Promise<{ sub: string | null; alreadyExisted: boolean }>;

  /** Put the account in its role group. Idempotent in Cognito itself. */
  addToGroup(input: {
    username: string;
    group: Role;
    signal: AbortSignal;
  }): Promise<void>;

  /** The account's `sub`, for the profile row's key. Null when not found. */
  findSub(input: { email: string; signal: AbortSignal }): Promise<string | null>;

  /**
   * The account behind a `sub`, or null when Cognito has none.
   *
   * The subject of an access change arrives as a sub (that is what the directory
   * lists and what every per-user record is keyed on), and everything the change
   * needs — the handle to act on, the email whose invitations must be revoked, and
   * the CURRENT enabled state — comes from this one read rather than from the
   * request.
   */
  findByUserId(input: {
    userId: string;
    signal: AbortSignal;
  }): Promise<DirectoryAccount | null>;

  /**
   * The Cognito GROUPS an account is in — the authoritative source of its platform
   * role.
   *
   * Read SERVER-SIDE for the target of every access change. Taking the target's role
   * from the request body would make the whole USER_ADMIN_GRANTS matrix bypassable by
   * lying about it: a FACILITATOR would simply claim their victim is a PARTICIPANT.
   *
   * Deliberately NOT the `role` on the profile row, even though this service can read
   * that table. The identity service documents that field as a DISPLAY CACHE which
   * goes stale, and a stale role here is an authorization decision made on the wrong
   * facts — an account promoted to ADMIN in Cognito but not yet mirrored would be
   * administrable by a facilitator.
   */
  listGroups(input: {
    username: string;
    signal: AbortSignal;
  }): Promise<string[]>;

  /**
   * Disable or enable an account. THIS is the enforcement — Cognito refuses to issue
   * tokens and refuses the refresh grant for a disabled user.
   *
   * IDEMPOTENT, and it must stay that way: AdminDisableUser on an already-disabled
   * account succeeds and changes nothing, so a duplicate request (a double-click, a
   * client retry) is a no-op rather than an error. Implementations must not add a
   * read-before-write that turns that into a 409.
   */
  setEnabled(input: {
    username: string;
    enabled: boolean;
    signal: AbortSignal;
  }): Promise<void>;

  /**
   * Is there an ENABLED account in the ADMIN group OTHER than this one?
   *
   * Exists for exactly one guard: refusing to disable the LAST enabled ADMIN, which
   * would leave the platform with nobody able to administer it — and nobody able to
   * undo the disable, since this surface is ADMIN/FACILITATOR-gated and a FACILITATOR
   * may not act on an ADMIN. USER_ADMIN_GRANTS names this as the caller's
   * responsibility precisely because the pure predicate cannot see this state.
   *
   * A BOOLEAN AND NOT A COUNT, deliberately. The guard's only question is "is there
   * somebody else?", so a count invites two mistakes a boolean cannot make: an
   * off-by-one about whether the subject is included, and — worse — an inability to
   * tell a TRUNCATED count from a real one. A count that stopped early would
   * under-report, and under-reporting here reads as "this is the last admin" and
   * refuses; over-reporting permits the lockout. The boolean short-circuits on the
   * first match instead, so the common case is one page and there is no threshold to
   * get wrong.
   *
   * Answered from COGNITO, not from the mirrored `status` on the profile rows. The
   * mirror can lag — a disable whose mirror write failed leaves a row reading ACTIVE —
   * and believing it would see an enabled admin who is not one, permitting the very
   * lockout this guard exists to prevent.
   *
   * `excludingUsername` is the SUBJECT of the action, excluded because the question is
   * about everyone else. It is a username rather than a sub because that is what
   * Cognito's group listing returns.
   *
   * MUST THROW rather than answer false if it cannot finish enumerating. The route
   * fails closed on the error, which is the only safe reading when the question is
   * "would this leave the platform unadministrable?".
   */
  hasOtherEnabledAdmin(input: {
    excludingUsername: string;
    signal: AbortSignal;
  }): Promise<boolean>;
}

/** Domain events. Fire-and-forget is NOT permitted; the caller awaits and logs. */
export interface EventPublisher {
  publishUserCreated(user: {
    id: string;
    email: string;
    role: Role;
  }): Promise<void>;
}

// ─── Audit ──────────────────────────────────────────────────────────────────

/**
 * ONE AUDIT ENTRY — who did what to whom, for the access-affecting actions.
 *
 * A LOCAL COPY of AuditEntryWrite in team/src/domain.ts and of the AuditEntry shape in
 * the shared types/audit module, for the same reason as USER_ADMIN_GRANTS above.
 * The two writers must agree on the FIELD NAMES because they write the same table and
 * the portal renders one shape — a field spelled differently here simply never appears
 * in the trail, which is a silent loss on a record whose whole point is completeness.
 *
 * `teamId`/`teamName` are absent on these actions deliberately: disabling platform
 * access is not a team action, and a team named on such an entry would imply a scope
 * the change does not have.
 */
export interface AuditEntryWrite {
  /** WHO THE ACTION WAS ABOUT — the target's sub. The table's partition key. */
  subjectId: string;
  /**
   * ROLE_GRANTED was added with the existing-account gate on /provision, against
   * the same bar the team service's writer documents for its fourth and fifth actions: NO
   * EXISTING ACTION CAN EXPRESS IT. The ACCESS_* pair is about whether an account may sign in
   * at all; adding a Cognito group to a LIVE account changes what that account may DO, which
   * is a different fact. Before it, the group write on the alreadyExisted branch left one
   * console.log line while the strictly smaller act on /access wrote a row.
   *
   * ⚠ WRITTEN ONLY WHEN A LIVE ACCOUNT'S ROLE ACTUALLY CHANGED — never on a fresh create
   * (the provisioning log line already describes that in full) and never on a re-assert of a
   * group the account is already in, which changes nothing and must not claim in the trail
   * that it did.
   *
   * NOT MIRRORED in the shared types/audit module, for the reason ENTITLEMENT_REVOKED
   * documents there: nothing renders the trail's action label today, so the consequence is a
   * future UI showing this action unlabelled rather than any loss here.
   */
  action: "ACCESS_DISABLED" | "ACCESS_ENABLED" | "ROLE_GRANTED";
  /** WHO DID IT. Always a real signed-in principal, from the verified identity. */
  actorId: string;
  /** The actor's role AT THE TIME — a historical fact, so it is stored, not derived. */
  actorRole: string;
  /** Free-text, operator-supplied, optional. Length-capped at the write path. */
  reason?: string;
}

/**
 * APPEND-ONLY store for audit entries.
 *
 * NO update and NO delete, with the interface doing the enforcing rather than a
 * comment asking for restraint — and the IAM grant matches (PutItem only), so the rule
 * holds even for a caller that bypasses this interface.
 *
 * `record` MUST NOT THROW into its caller's happy path, mirroring the team service's
 * contract exactly. By the time it runs, Cognito has ALREADY applied the access change
 * and invitations are ALREADY revoked; failing the request would have the operator
 * retry a change that has taken effect, and neither of those is undone by an audit
 * problem. The implementation logs and swallows; the route reports what it knows via
 * `audited`, and a false there is worth an alarm — it means an access change happened
 * with no record of who made it.
 */
export interface AuditRepository {
  record(entry: AuditEntryWrite): Promise<boolean>;
}

/**
 * Cap on the operator-supplied `reason`, in characters.
 *
 * 200, matching AUDIT_REASON_MAX in the shared types/audit module — the portal's
 * input is capped at the same number, so a reason that fits the form always fits the
 * row. Enforced here rather than trusted from the BFF because the BFF is not a
 * boundary: every service route is reachable directly with a user's own token.
 *
 * TRUNCATED rather than refused. A 201-character reason is not a reason to fail an
 * access change the operator has decided on, and losing the tail of a note is a
 * smaller loss than losing the entry.
 */
export const AUDIT_REASON_MAX = 200;

/**
 * One RUN of Unicode "other" code points — the control, format, surrogate, private-use and
 * unassigned categories — matched as a run so a replacement cannot multiply.
 *
 * `\p{C}` (requires the `u` flag) is deliberately the WHOLE of category C rather than a
 * hand-listed set, because the hand-listed version is the one that ages badly: it covers
 * C0/C1 controls (newline, tab, NUL), and it covers every BIDI CONTROL — U+202A…U+202E and
 * U+2066…U+2069 are Cf — without anyone having to remember them. It also catches a LONE
 * SURROGATE (Cs), which is the one character class that cannot survive a round-trip through
 * UTF-8 at all.
 *
 * ── THE ACCEPTED COST, MEASURED RATHER THAN ASSUMED ──
 *
 * U+200D ZERO WIDTH JOINER is Cf, so a ZWJ EMOJI SEQUENCE IS SPLIT INTO ITS PARTS: a reason
 * containing "👩‍💻" stores "👩 💻". Verified against this runtime, along with what is NOT
 * affected — U+FE0F VARIATION SELECTOR-16 is Mn, skin-tone modifiers are So and regional
 * indicators are So, so "❤️", "👍🏽", "🇬🇧" and every plain emoji survive intact. Cn
 * (unassigned) is in the category too, so a code point newer than this runtime's Unicode
 * tables is also replaced.
 *
 * ACCEPTED rather than exempted, and deliberately: an EXEMPTION LIST is the thing that ages
 * badly and the thing a reviewer cannot check at a glance, whereas "the whole of category C"
 * is one rule with no holes. This field is a short operator note on an access change, not a
 * message body — a split emoji is legible and harmless, while a hole in the rule is how
 * U+2066 or the next bidi control nobody remembered gets through. Deny by default.
 *
 * Module-level so the pattern is compiled once rather than per request. Safe to share
 * despite the `g` flag because `String#replace` resets `lastIndex` — nothing here calls
 * `.test`/`.exec` on it, which is what would carry state between requests.
 */
const AUDIT_REASON_CONTROL_RUN = /\p{C}+/gu;

/**
 * A stored `reason`, or undefined when there is nothing worth storing.
 *
 * ── CONTROL CHARACTERS ARE REPLACED, NOT DELETED, AND NOT KEPT ──
 *
 * The trail is APPEND-ONLY and never deleted, so anything stored here is permanent. An
 * operator's note reaches an audit UI, a CSV export and a log line, and a raw newline forges
 * a second LINE in every renderer that prints the trail as text; U+202E reverses what
 * follows so the RENDERED reason differs from the stored one; a NUL truncates the string in
 * a C-backed consumer. None of that is FORGERY — the structured fields around it (actorId,
 * actorRole, action, occurredAt) come from the verified token and the store's own clock — but
 * it is permanent pollution of a record that exists to be read during an incident.
 *
 * Each RUN becomes ONE SPACE rather than being stripped, and that choice matters twice:
 *
 *   - Stripping fuses words. `"a\nb"` would become `"ab"`, which is two clauses silently
 *     turned into one word that the operator never wrote — a small lie in a record whose
 *     only job is to be true. One space keeps them two.
 *   - A RUN (not a code point) collapses, so 200 control characters cannot become 200
 *     spaces. Combined with the ordering below, padding cannot squeeze out the real text.
 *
 * ORDINARY INTERNAL WHITESPACE IS UNTOUCHED — a space is not in category C, so a two-clause
 * reason keeps its spacing exactly. Only control runs are rewritten.
 *
 * ── ORDER IS LOAD-BEARING: SANITISE, THEN TRIM, THEN MEASURE ──
 *
 * The length cap is applied LAST. A reason of 200 control characters followed by the real
 * note would otherwise spend the whole budget on characters that are about to be removed,
 * and the operator's actual text would be truncated away by padding they did not choose.
 *
 * Measured and sliced in CODE POINTS, matching how the profile validator and
 * usernameRejectionReason measure their fields: `.length`/`.slice` count a surrogate
 * pair twice and can cut one in half, which writes a lone surrogate into the row and
 * renders as a replacement character in the trail.
 *
 * Whitespace-only collapses to undefined so the row carries no attribute at all,
 * rather than an empty string the UI would render as an empty "Reason:" line.
 *
 * ── CONVERGED WITH normalizeAuditReason in the team service's routes ──
 *
 * The two write the SAME `praimana-audit` table and are behaviourally IDENTICAL again.
 * They stay separate copies for the same reason AUDIT_REASON_MAX is copied — bundled Lambdas
 * take no dependency on the shared package — so a change to either one belongs in both, and a
 * reader of the trail may now assume every `reason` on it is control-free regardless of which
 * service recorded it. Nothing else in the trail depends on which writer produced a row, and
 * that is the property this convergence buys.
 */
export function normalizeAuditReason(
  reason: unknown
): string | undefined {
  if (typeof reason !== "string") return undefined;
  // BEFORE the trim, so a reason that is nothing but control characters trims to "" and
  // returns undefined rather than storing a row of spaces.
  const sanitized = reason.replace(AUDIT_REASON_CONTROL_RUN, " ");
  const trimmed = sanitized.trim();
  if (!trimmed) return undefined;
  const points = [...trimmed];
  return points.length > AUDIT_REASON_MAX
    ? points.slice(0, AUDIT_REASON_MAX).join("")
    : trimmed;
}

// ─── Role resolution ────────────────────────────────────────────────────────

/**
 * Mirrors isExpired() in team/src/invite-token.ts and both Cognito triggers.
 * Missing expiresAt = not expired (legacy rows stay valid); unparseable = expired
 * (corruption fails closed).
 */
export function isExpired(
  expiresAt: string | undefined,
  now: number
): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at <= now;
}

/**
 * The authoritative platform role for an email, from its live invitation(s).
 *
 * Returns null when there is NO live invitation — and that distinction matters here
 * in a way it does not in the post-confirmation trigger. That trigger runs on an
 * already-confirmed user, so it must fall back to PARTICIPANT rather than refuse.
 * This runs BEFORE an account exists, so "no invitation" is a reason to refuse
 * outright: provisioning an account for an un-invited address is exactly what
 * invite-only forbids.
 *
 * An email invited to several teams collapses to the highest-privilege role, so the
 * group assignment cannot be under-privileged by invitation ordering.
 *
 * LIVE means un-expired AND NOT WITHDRAWN. The revoked half was added with the Team
 * service's removal-driven revocation: a REVOKED row SURVIVES (it is provenance), so
 * filtering on expiry alone would let a grant that has been taken away decide the role of a
 * newly-provisioned account — and it would vote with whatever privilege it carried. It also
 * keeps this in step with the pre-signup trigger, which now refuses both terminal statuses:
 * a mismatch would let this service believe it may provision an account the gate then
 * refuses, which is exactly the sequencing bug its UserLambdaValidationException branch
 * exists to report.
 */
export function resolveRoleFromInvitations(
  rows: readonly InvitationRow[],
  now: number
): Role | null {
  const live = rows.filter(
    (row) => !isExpired(row.expiresAt, now) && !isRevokedInvitation(row.status)
  );
  if (live.length === 0) return null;

  const rank = (r: string) => {
    const i = (ROLE_PRECEDENCE as readonly string[]).indexOf(r);
    return i === -1 ? ROLE_PRECEDENCE.length : i;
  };
  const best = live.reduce((acc, row) => {
    const role = row.platformRole || "PARTICIPANT";
    return rank(role) < rank(acc) ? role : acc;
  }, "PARTICIPANT" as string);

  return (VALID_ROLES as readonly string[]).includes(best)
    ? (best as Role)
    : "PARTICIPANT";
}
