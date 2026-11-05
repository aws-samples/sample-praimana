import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import type {
  AuditEntryWrite,
  AuditRepository,
  DirectoryAccount,
  EventPublisher,
  InvitationReader,
  InvitationRow,
  ProfileStore,
  ProfileWrite,
  RandomBytes,
  Role,
  UserDirectory,
  UserStatus,
} from "./domain.js";

/**
 * The AWS adapters behind the ports in domain.ts. This is the ONLY file in the
 * service that knows an AWS SDK exists — routes.ts depends on the interfaces, which
 * is what lets the provisioning sequence be tested without a user pool.
 */

const TABLE_USERS = process.env.TABLE_USERS || "praimana-users";
const TABLE_INVITATIONS =
  process.env.TABLE_INVITATIONS || "praimana-invitations";
// Defaulted to the same literal the team service's repository defaults to. If those
// two ever drift, one writer's entries land in a table nothing reads — which is why
// the default is duplicated rather than invented.
const TABLE_AUDIT = process.env.TABLE_AUDIT || "praimana-audit";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "praimana-events";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";

/**
 * How long ONE cognito-idp call may take before it is abandoned.
 *
 * 3000ms, and the reasoning is unchanged even though it is no longer far looser than
 * EAST_WEST_TIMEOUT_MS: this is a call to a PUBLIC AWS endpoint from outside the VPC,
 * paying DNS + TLS + SigV4 on a cold container, not a warm Lambda answering an
 * authorization probe. AdminCreateUser also runs our pre-signup trigger
 * synchronously, so its latency includes a whole Lambda invocation plus a DynamoDB
 * query.
 *
 * (EAST_WEST_TIMEOUT_MS was 800ms when this comment was written and is now 2500ms —
 * raised once a first-call PrivateLink cost of 1802ms was measured, which is the same
 * cold-path effect this 3000ms was already sized for. The two numbers converging is
 * consistency, not coincidence; see apps/services/shared/src/east-west.ts.)
 *
 * The number that matters is the CEILING, not the typical case: three sequential
 * Cognito calls at 3s each is 9s, which still sits under the 15s function timeout
 * (Globals) and well under API Gateway's 29s. Without a timeout the failure mode is
 * the one this whole VPC story is about — a call that hangs rather than errors, held
 * open until the platform's outermost timeout, with an operator watching a spinner.
 */
const COGNITO_TIMEOUT_MS = 3000;

/** node:crypto's CSPRNG, as the RandomBytes port. */
export const cryptoRandomBytes: RandomBytes = (size: number) =>
  new Uint8Array(randomBytes(size));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const idp = new CognitoIdentityProviderClient({});
const events = new EventBridgeClient({});

/**
 * An AbortSignal that fires after COGNITO_TIMEOUT_MS.
 *
 * Exported so routes.ts uses ONE definition of the deadline for every Cognito call
 * rather than each call site inventing its own — and so a caller-supplied signal can
 * be composed in later without hunting for the timeouts.
 */
export function cognitoDeadline(): AbortSignal {
  return AbortSignal.timeout(COGNITO_TIMEOUT_MS);
}

/**
 * Row budget for one address's invitations, and the round-trip cap that bounds the read.
 *
 * DELIBERATELY THE SAME NUMBERS as the team service's `listByEmail`
 * (team/src/repository.dynamo.ts): both read the SAME `email-index` on the SAME table, so two
 * different budgets would mean two services disagreeing about how many rows one address may
 * legitimately have. Real answers are 1–5; 500 for one address is not a busy day, it is a
 * corrupted or abused table.
 */
const MAX_INVITATION_ROWS_PER_EMAIL = 500;
const MAX_INVITATION_QUERY_ROUND_TRIPS = 5;

/**
 * Raised when an invitation read cannot be completed within its bound.
 *
 * ⚠ THROWS RATHER THAN TRUNCATING, and that is the whole point of this class existing.
 *
 * `listByEmail` returns an array, which has exactly TWO honest channels: the array, or an
 * exception. A short array is indistinguishable from a complete answer at every call site — so
 * a silently truncated read here would drop invitation rows that BOTH callers use to decide
 * something. `POST /provision` resolves the role to grant from these rows, and the revoke path
 * counts them to tell an operator how many live credentials it destroyed. A missing row means a
 * role resolved from incomplete evidence, or a credential reported as revoked that was never
 * seen.
 *
 * Both call sites already fail closed on a throw — verified, not assumed: the provision path
 * answers 503 "Could not verify the invitation", and the revoke path reports
 * `{ revoked: 0, complete: false }`. So this needs no route change to be safe.
 *
 * `name` is set explicitly because bundlers mangle class names, and `name` is the
 * identification contract this file already relies on (see isConditionalCheckFailure).
 */
export class InvitationReadBoundExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationReadBoundExceeded";
  }
}

export class DynamoInvitationReader implements InvitationReader {
  /**
   * Every invitation for one address — PAGED AND BOUNDED.
   *
   * ── WHAT THIS USED TO DO ──
   *
   * One QueryCommand, `return res.Items` — no `Limit`, no `ExclusiveStartKey`, no
   * `LastEvaluatedKey`. So it returned one 1 MB page and silently dropped everything past it.
   * The identical defect was fixed in the team service's copy earlier today (backlog P2-2);
   * this is the same bug in the second service, and it feeds decisions rather than a display.
   *
   * A `Limit` is safe here for the reason it is safe there: this Query sends NO
   * `FilterExpression`, so `Limit` bounds rows RETURNED rather than rows examined, and cannot
   * produce a short page that looks complete.
   *
   * Over-fetches ONE past the budget on purpose: DynamoDB sets `LastEvaluatedKey` whenever a
   * Query stops on `Limit`, INCLUDING on the last matching row — so "a key came back" cannot
   * distinguish a complete answer from a truncated one. Seeing a row beyond the budget can.
   */
  async listByEmail(email: string): Promise<InvitationRow[]> {
    // One more than the budget — see the note above.
    const ceiling = MAX_INVITATION_ROWS_PER_EMAIL + 1;

    const found: InvitationRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let exhausted = false;

    for (let trip = 0; trip < MAX_INVITATION_QUERY_ROUND_TRIPS; trip++) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE_INVITATIONS,
          IndexName: "email-index",
          KeyConditionExpression: "email = :email",
          ExpressionAttributeValues: { ":email": email },
          // Only what is still missing, so a nearly-full read does not over-fetch.
          Limit: ceiling - found.length,
          ExclusiveStartKey: lastKey,
        })
      );

      found.push(...((res.Items as InvitationRow[]) ?? []));
      lastKey = res.LastEvaluatedKey;

      if (!lastKey) {
        // The authoritative "no more rows" signal.
        exhausted = true;
        break;
      }
      if (found.length >= ceiling) break;
    }

    // TWO INDEPENDENT INCOMPLETENESS SIGNALS, and both must refuse:
    //   found.length > budget — a row past the budget was SEEN, so rows are being left behind.
    //   !exhausted            — the round-trip cap stopped us while the store still reported
    //                           more. Not redundant with the first: a read can hit the trip cap
    //                           without ever reaching the budget.
    if (found.length > MAX_INVITATION_ROWS_PER_EMAIL || !exhausted) {
      throw new InvitationReadBoundExceeded(
        // NO PII: the partition key of this index IS an email, so the scope label is the INDEX
        // NAME rather than the value. Counts only.
        `invitation read exceeded its bound (scope=email-index, rows=${found.length}, ` +
          `budget=${MAX_INVITATION_ROWS_PER_EMAIL}, ` +
          `trips=${MAX_INVITATION_QUERY_ROUND_TRIPS}, exhausted=${exhausted}) ` +
          `— refusing to return a truncated list`
      );
    }

    return found;
  }

  /**
   * Delete one invitation row. Mirrors DynamoInvitationRepository.revoke in the team
   * service, down to the ReturnValues.
   *
   * ReturnValues: ALL_OLD is what distinguishes "deleted a row" from "the key matched
   * nothing" — a bare DeleteCommand succeeds either way, and the caller reports the
   * result as a COUNT to an operator withdrawing somebody's access. A count inflated
   * by keys that matched nothing would tell them credentials were destroyed that never
   * existed, which is precisely the fact they are checking.
   *
   * `email` is lower-cased because that is how the team service stores the sort key;
   * a case mismatch here would delete nothing and report a clean revoke.
   */
  async revoke(teamId: string, email: string): Promise<boolean> {
    const res = await ddb.send(
      new DeleteCommand({
        TableName: TABLE_INVITATIONS,
        Key: { teamId, email: email.toLowerCase() },
        ReturnValues: "ALL_OLD",
      })
    );
    return res.Attributes !== undefined;
  }
}

export class DynamoProfileStore implements ProfileStore {
  /**
   * Create-or-MERGE the profile row for a provisioned account.
   *
   * An UpdateCommand, NOT the PutCommand the post-confirmation trigger uses, and that
   * is the whole point of this method. Provisioning is re-runnable: an admin
   * re-inviting an address that already registered would, with a full-item put,
   * silently erase the firstName / lastName / organization that person filled in at
   * first login — and the profile-completeness gate would then bounce them back to
   * the form they already completed.
   *
   * So each attribute is written deliberately:
   *   - `email` and `role` are SET on every run. Both are authoritative here (role
   *     comes from the invitation row), and a re-invite at a higher role is a
   *     legitimate way to correct one.
   *   - `createdAt` uses if_not_exists, so the original provisioning time survives.
   *   - `name` uses if_not_exists with the email as the seed, so a display name the
   *     user has since set via PATCH /me is never clobbered — while a brand-new row
   *     still has something renderable.
   *   - firstName / lastName / organization are NOT TOUCHED AT ALL. They are the
   *     user's own data, collected at first login, and this service has no business
   *     with them. Their absence is what makes profileComplete false and drives the
   *     completion gate for a fresh account.
   */
  async upsertProvisioned(profile: ProfileWrite): Promise<void> {
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_USERS,
        Key: { id: profile.id },
        UpdateExpression: [
          "SET #email = :email",
          "#role = :role",
          "#authProvider = :authProvider",
          "#updatedAt = :updatedAt",
          "#createdAt = if_not_exists(#createdAt, :now)",
          "#name = if_not_exists(#name, :seedName)",
        ].join(", "),
        // Every one of these is a DynamoDB reserved word or close enough to warrant
        // the alias; expressed as names so the update can never be a string built
        // from input.
        ExpressionAttributeNames: {
          "#email": "email",
          "#role": "role",
          "#authProvider": "authProvider",
          "#updatedAt": "updatedAt",
          "#createdAt": "createdAt",
          "#name": "name",
        },
        ExpressionAttributeValues: {
          ":email": profile.email,
          ":role": profile.role,
          ":authProvider": "COGNITO",
          ":updatedAt": now,
          ":now": now,
          ":seedName": profile.email,
        },
      })
    );
  }

  /**
   * Mirror the access state onto an EXISTING profile row.
   *
   * CONDITIONAL ON THE ROW EXISTING, and that is the load-bearing part rather than a
   * nicety. An UpdateCommand CREATES the item when the key is absent, so without
   * `attribute_exists(id)` a disable against a sub with no profile row would fabricate
   * a row carrying nothing but an id and a status — a phantom account in the
   * Administration list that no other read can explain, and one that would show up as
   * "disabled" with no name, email or role beside it.
   *
   * A narrow SET of two attributes rather than a put, for the same reason
   * upsertProvisioned is: the row holds the user's own firstName / lastName /
   * organization, and an access change has no business with any of them. In particular
   * `role` is NOT touched — Cognito's group is the authority on that, and this write
   * knows nothing about it.
   *
   * Returns whether a row was updated, distinguished by the error DynamoDB returns: a
   * ConditionalCheckFailedException means "no such row", which is a stale-badge problem
   * and not a failure of the access change Cognito has already applied. Anything else
   * (throttle, timeout, AccessDenied) is a real store failure and is RETHROWN, so the
   * route can report the mirror as unwritten rather than treating a store outage as an
   * absent row.
   */
  async setStatus(input: {
    userId: string;
    status: UserStatus;
    actorId: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_USERS,
          Key: { id: input.userId },
          // FOUR attributes, and the two new ones are the row's own answer to "who did
          // this" — written in the SAME UpdateCommand as the status, so they cannot land
          // without it or it without them. That atomicity is the whole value: it is what
          // makes the breadcrumb trustworthy when the separate audit write is the thing
          // that failed. Same shape, and the same reason, as the team service writing
          // `removedBy` alongside the membership status flip.
          UpdateExpression:
            "SET #status = :status, #updatedAt = :updatedAt, " +
            "#accessChangedBy = :actorId, #accessChangedAt = :now",
          // `status` is a DynamoDB reserved word; the rest are aliased for
          // consistency with the merge above rather than out of necessity.
          ExpressionAttributeNames: {
            "#status": "status",
            "#updatedAt": "updatedAt",
            "#accessChangedBy": "accessChangedBy",
            "#accessChangedAt": "accessChangedAt",
          },
          ExpressionAttributeValues: {
            ":status": input.status,
            ":updatedAt": now,
            ":actorId": input.actorId,
            // The same instant as updatedAt, deliberately: two clocks for one write is
            // how a forensic reader ends up reconciling a millisecond of skew that never
            // meant anything.
            ":now": now,
          },
          ConditionExpression: "attribute_exists(id)",
        })
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) return false;
      throw err;
    }
  }
}

/**
 * True when DynamoDB refused a write because its ConditionExpression did not hold.
 *
 * Matched on `name`, the stable contract on an AWS SDK error, rather than on message
 * text or an `instanceof` against the modelled exception class — the doc client can
 * surface either the modelled type or a plain error with this name depending on the
 * SDK's middleware path, and this distinction decides whether a failure is benign.
 * Mirrors the same helper in team/src/repository.dynamo.ts.
 */
function isConditionalCheckFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "ConditionalCheckFailedException"
  );
}

export class CognitoUserDirectory implements UserDirectory {
  constructor(private readonly userPoolId: string = USER_POOL_ID) {
    if (!this.userPoolId) {
      // FAIL FAST at construction (cold start), not per request. A missing pool id
      // would otherwise surface as a ValidationException on the first invite, long
      // after the deploy that caused it.
      throw new Error("COGNITO_USER_POOL_ID is required for Cognito admin writes");
    }
  }

  async createUser(input: {
    email: string;
    temporaryPassword: string;
    signal: AbortSignal;
  }): Promise<{ sub: string | null; alreadyExisted: boolean }> {
    try {
      const res = await idp.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: input.email,
          TemporaryPassword: input.temporaryPassword,
          // SUPPRESS, because we send our own branded invitation (see
          // notify/templates/registration-invite.html). Cognito's default email is
          // unbranded, names the pool rather than the product, and would arrive
          // alongside ours — two emails, two different links, one confused invitee.
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: input.email },
            // The INVITATION is the proof of the address: an authenticated
            // admin/facilitator typed it, and only the holder of that mailbox
            // receives the temporary password. Requiring a second verification code
            // would add a step that proves the same fact.
            { Name: "email_verified", Value: "true" },
          ],
          // The three mandatory profile fields are deliberately NOT set here. They
          // are the user's own data, collected at first login and validated by the
          // identity service's PATCH /me; asking the admin to type them per invitee
          // would make bulk invites unusable and would store a guess as fact.
        }),
        { abortSignal: input.signal }
      );
      return {
        sub: res.User?.Attributes?.find((a) => a.Name === "sub")?.Value ?? null,
        alreadyExisted: false,
      };
    } catch (err) {
      // An account already there is a BENIGN re-invite, not a failure: an admin
      // re-sending an invitation must not 500. The rest of the sequence still runs,
      // which is what makes re-inviting a repair action (it re-asserts the group and
      // the profile row) rather than a no-op.
      //
      // NOTE the temporary password is NOT reset in this branch — deliberately. The
      // existing account may be in active use with a password its owner chose, and
      // silently replacing it would lock them out. A genuinely lost password is the
      // forgot-password flow's job.
      if (err instanceof UsernameExistsException) {
        return { sub: null, alreadyExisted: true };
      }
      throw err;
    }
  }

  async addToGroup(input: {
    username: string;
    group: Role;
    signal: AbortSignal;
  }): Promise<void> {
    // Idempotent in Cognito itself: adding a user to a group they are already in
    // succeeds and changes nothing, so a re-invite needs no read-before-write.
    await idp.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: this.userPoolId,
        Username: input.username,
        GroupName: input.group,
      }),
      { abortSignal: input.signal }
    );
  }

  async findSub(input: {
    email: string;
    signal: AbortSignal;
  }): Promise<string | null> {
    // ListUsers with a filter rather than AdminGetUser: the pool's username IS the
    // email for accounts created through this path, but Cognito assigns an internal
    // username for some creation paths, and a filtered list answers correctly for
    // both. Limit 1 bounds the response — this is a point lookup, and a filter that
    // somehow matched many would still cost one row.
    const res = await idp.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        // The email is quoted, and Cognito's filter syntax has no expression
        // language to escape into — a value containing a quote yields
        // InvalidParameterException rather than a widened filter. The caller has
        // already run usernameRejectionReason() over it.
        Filter: `email = "${input.email}"`,
        Limit: 1,
      }),
      { abortSignal: input.signal }
    );
    const user = res.Users?.[0];
    return user?.Attributes?.find((a) => a.Name === "sub")?.Value ?? null;
  }

  /**
   * The account behind a `sub`.
   *
   * ListUsers filtered on `sub`, not AdminGetUser: the admin get addresses an account
   * by USERNAME, and this pool's username is the email for accounts created through
   * the provisioning path but an internal value on others. The subject of an access
   * change is always a sub (that is what the directory lists and what every per-user
   * record is keyed on), so resolving sub → username here is what lets the rest of the
   * flow address the right account.
   *
   * `sub` is one of the few attributes Cognito allows in a filter, and it is an
   * EXACT-match prefix filter, so Limit 1 is a point lookup rather than a truncated
   * scan. The value is quoted the same way findSub quotes the email — Cognito's filter
   * syntax has no expression language to escape into, and a value carrying a quote
   * yields InvalidParameterException rather than a widened filter.
   */
  async findByUserId(input: {
    userId: string;
    signal: AbortSignal;
  }): Promise<DirectoryAccount | null> {
    const res = await idp.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Filter: `sub = "${input.userId}"`,
        Limit: 1,
      }),
      { abortSignal: input.signal }
    );

    const user = res.Users?.[0];
    if (!user?.Username) return null;

    return {
      username: user.Username,
      // Lower-cased to match how the team service stores an invitation's email. A case
      // mismatch would look up no invitations and report a clean revoke of nothing.
      email: (
        user.Attributes?.find((a) => a.Name === "email")?.Value ?? ""
      ).toLowerCase(),
      // Cognito's own flag. `Enabled` is optional on the modelled type; an ABSENT value
      // is read as ENABLED because that is the state of every account Cognito returns
      // without saying otherwise, and reading it as disabled would make an
      // already-disabled short-circuit skip a disable that never happened.
      enabled: user.Enabled !== false,
    };
  }

  async listGroups(input: {
    username: string;
    signal: AbortSignal;
  }): Promise<string[]> {
    // NOT PAGINATED, and that is a decision rather than an oversight: this platform is
    // single-role (see ROLE_PRECEDENCE) with five groups total, so one page of the
    // default 60 covers every account by construction. The caller collapses whatever
    // comes back by precedence, so an extra group could not change the answer anyway.
    const res = await idp.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: this.userPoolId,
        Username: input.username,
      }),
      { abortSignal: input.signal }
    );
    return (res.Groups ?? [])
      .map((g) => g.GroupName)
      .filter((name): name is string => !!name);
  }

  async setEnabled(input: {
    username: string;
    enabled: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    // IDEMPOTENT IN COGNITO ITSELF: both calls succeed against an account already in
    // the requested state and change nothing, so a duplicate request needs no
    // read-before-write — which would be a race between the read and the write anyway.
    const command = input.enabled
      ? new AdminEnableUserCommand({
          UserPoolId: this.userPoolId,
          Username: input.username,
        })
      : new AdminDisableUserCommand({
          UserPoolId: this.userPoolId,
          Username: input.username,
        });
    await idp.send(command, { abortSignal: input.signal });
  }

  /**
   * Whether any ENABLED ADMIN other than `excludingUsername` exists — the last-admin
   * guard's question.
   *
   * SHORT-CIRCUITS on the first match, so the common case (a platform with two admins)
   * costs one page and returns before reading the rest. Paginated with a hard cap
   * anyway, because "the group is small" is an assumption about data and the bound
   * should be a property of the code.
   *
   * If the pages run out before the group does, this THROWS rather than answering
   * false. False means "this is the last admin", which REFUSES the operation — so
   * answering it from a truncated read would block a legitimate disable while looking
   * like a considered decision. The error is honest and the route fails closed on it.
   */
  async hasOtherEnabledAdmin(input: {
    excludingUsername: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    let token: string | undefined;

    for (let page = 0; page < MAX_ADMIN_GROUP_PAGES; page++) {
      const res = await idp.send(
        new ListUsersInGroupCommand({
          UserPoolId: this.userPoolId,
          GroupName: "ADMIN",
          Limit: ADMIN_GROUP_PAGE_SIZE,
          NextToken: token,
        }),
        { abortSignal: input.signal }
      );

      for (const user of res.Users ?? []) {
        if (!user.Username || user.Username === input.excludingUsername) continue;
        // `Enabled !== false` for the same reason as findByUserId: an absent flag is an
        // enabled account. Reading it as disabled would make this answer false and
        // wrongly refuse — the recoverable direction, but still wrong.
        if (user.Enabled !== false) return true;
      }

      token = res.NextToken;
      if (!token) return false;
    }

    throw new Error(
      `hasOtherEnabledAdmin: the ADMIN group did not fit in ${MAX_ADMIN_GROUP_PAGES} pages of ${ADMIN_GROUP_PAGE_SIZE} — refusing to answer from a truncated read`
    );
  }
}

/**
 * ListUsersInGroup page size, and how many pages the last-admin guard may read.
 *
 * 60 is Cognito's own default and documented maximum for this call, so asking for more
 * would be silently clamped. Two pages (120 accounts) is far beyond any plausible
 * number of platform administrators — the guard exists because the real number is
 * usually ONE — and the scan short-circuits on the first enabled peer anyway. The
 * second page exists so "unreachable" is true by construction rather than by argument.
 */
const ADMIN_GROUP_PAGE_SIZE = 60;
const MAX_ADMIN_GROUP_PAGES = 2;

/**
 * Append-only audit store — the SECOND writer of praimana-audit, alongside the
 * team service's DynamoAuditRepository.
 *
 * A deliberate second implementation rather than a shared one, because the two live in
 * separately-bundled Lambdas that share no code. What they MUST share is the item
 * shape, and two properties of it are load-bearing:
 *
 * THE SORT KEY IS `<iso>#<ulid>`, NOT THE TIMESTAMP. Two administrative actions on the
 * same person within the same millisecond collide on a bare ISO instant, and PutItem
 * would SILENTLY OVERWRITE the earlier one — losing an audit entry, the one failure
 * this table cannot be permitted to have. The ULID suffix makes every key unique while
 * preserving lexicographic time order, so the trail Query still returns newest-first
 * with no in-memory sort. That is realistic here and not theoretical: disable-then-
 * re-enable is a two-click sequence an operator performs in one breath.
 *
 * NEVER THROWS OUT OF `record`. By the time this runs, Cognito has already applied the
 * access change and the invitations are already gone; failing the request would have the
 * operator retry a change that has taken effect. Returns false so the route can report
 * `audited: false` and an operator can act on it — see the port's contract in domain.ts.
 */
export class DynamoAuditRepository implements AuditRepository {
  async record(entry: AuditEntryWrite): Promise<boolean> {
    const occurredAt = new Date().toISOString();
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_AUDIT,
          Item: {
            ...entry,
            // Denormalised alongside the composite key so a reader never has to parse it.
            occurredAt,
            at: `${occurredAt}#${ulid()}`,
          },
          // Belt and braces on top of the unique sort key: refuse rather than overwrite
          // if a key somehow repeats. On an audit trail, losing a row silently is the
          // failure mode worth two lines of defence.
          ConditionExpression: "attribute_not_exists(subjectId)",
        })
      );
      return true;
    } catch (err) {
      // A ConditionalCheckFailed here means the (astronomically unlikely) same
      // subject+timestamp+ULID already exists. Everything else is a real store failure —
      // most plausibly a missing IAM grant, since this role's audit permission is
      // narrower than the shared execution role's. Both are logged and swallowed; see
      // the class note on why this must not throw.
      //
      // Identifiers only: the action, the subject and the actor. No reason text, which
      // is operator free-text and may name a person.
      console.error(
        "[user-access] AUDIT WRITE FAILED — the access change succeeded but is unrecorded",
        {
          action: entry.action,
          subjectId: entry.subjectId,
          actorId: entry.actorId,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }
      );
      return false;
    }
  }
}

export class EventBridgePublisher implements EventPublisher {
  async publishUserCreated(user: {
    id: string;
    email: string;
    role: Role;
  }): Promise<void> {
    await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: EVENT_BUS_NAME,
            // "identity-service" and not this service's own name ON PURPOSE: the
            // read-model consumers in five other contexts already filter on that
            // Source, and this event means exactly what theirs does. Renaming the
            // source would silently stop every one of them syncing.
            Source: "identity-service",
            DetailType: "user.created",
            Detail: JSON.stringify({
              id: user.id,
              name: user.email,
              email: user.email,
              role: user.role,
            }),
          },
        ],
      })
    );
  }
}

