import type {
  PostConfirmationTriggerEvent,
  PostConfirmationTriggerHandler,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { ulid } from "ulid";
// The ONE EMF writer, previously a local copy in this file. Moved to service-shared when
// the team and user-access services needed the same thing:
// three copies of a helper whose dimension-set trick is this subtle is three chances to
// publish a metric no alarm matches.
//
// THE ONE CROSS-PACKAGE IMPORT IN THIS FILE, and it is deliberate rather than a
// relaxation of the "bundled Lambdas take no dep on a shared package" rule that keeps
// ROLE_PRECEDENCE and isExpired() duplicated below. `emitMetric` is a pure function over
// console.log with no module-level client, so it carries none of the cost that rule
// exists to avoid.
//
// ⚠ A DEEP IMPORT, NOT THE PACKAGE BARREL, AND THAT IS MEASURED RATHER THAN STYLISTIC.
// `@praimana/service-shared` re-exports health.ts, which imports Hono — so pulling
// this in through the barrel bundled the whole HTTP framework into a Cognito trigger that
// serves no HTTP: 6.5kb → 11.3kb minified (esbuild --analyze attributed 12kb of the
// unminified graph to hono/*). Importing the module directly leaves the bundle at 6.9kb.
// Keep it a deep import; the barrel is the right entry point for the SERVICES, which all
// use Hono anyway.
import { emitMetric } from "@praimana/service-shared/src/metrics.js";

/**
 * Cognito POST-CONFIRMATION trigger — runs once, after the user confirms
 * (email + MFA).
 *
 * ⚠ WHICH PATH THIS SERVES, AFTER REGISTRATION BECAME ADMIN-PROVISIONED ⚠
 *
 * This trigger serves the SELF-SIGNUP path only, and that path is currently OFF
 * (`AllowAdminCreateUserOnly: true` on the pool). It is retained deliberately, not left
 * behind: if that flag is ever flipped back — an AWS-internal mitigation flipped it once
 * already — this is what assigns the role
 * group and writes the profile row for a self-registered user. Deleting it would leave
 * that path silently creating ghost accounts.
 *
 * IT DOES NOT AND CANNOT SERVE THE ADMIN-CREATE PATH. Measured on the live dev pool: an
 * admin-created user completing their forced password change reaches
 * `UserStatus: CONFIRMED` and this function produces ZERO log events, no group, no
 * profile row. PostConfirmation is tied to the confirm-signup flow and is simply not
 * invoked. The types agree — a PostConfirmationTriggerEvent has exactly two sources,
 * `PostConfirmation_ConfirmSignUp` and `PostConfirmation_ConfirmForgotPassword`, so
 * there is no admin-create source to widen the guard below to. Relaxing that guard would
 * change nothing on the admin path.
 *
 * The admin path does this work SYNCHRONOUSLY in the user-access service instead,
 * immediately after AdminCreateUser succeeds — so the account is complete from the
 * moment it exists rather than at some later sign-in. That service is the reference for
 * the admin path; this file remains the reference for the self-signup path, and the two
 * must keep agreeing about the role resolution and the profile row's shape.
 *
 * It reconstitutes the side effects the identity service used to do inline at
 * registration:
 *   1. Resolve the authoritative platform role from the invitation (by email,
 *      reading the invitations table directly — same seam as the pre-signup gate;
 *      see that handler for why the HTTP lookup was dropped).
 *   2. Assign the user to the matching Cognito GROUP → drives the cognito:groups
 *      claim that is now the role source of truth.
 *   3. Write the profile row to praimana-users (profile store, keyed by the
 *      Cognito sub).
 *   4. Publish user.created so every other context refreshes its users read-model
 *      (unchanged event fabric).
 *
 * Failures here are logged but NOT thrown: the user is already confirmed, and
 * throwing would only surface a confusing post-signup error without un-confirming
 * them. The role group + profile can be reconciled out-of-band if a step fails.
 */

const VALID_ROLES = [
  "ADMIN",
  "FACILITATOR",
  "EXECUTIVE",
  "PARTICIPANT",
  "JUDGE",
] as const;
type Role = (typeof VALID_ROLES)[number];

// Single-role precedence (lower index wins), collapsing an email's several
// invitations to the one highest-privilege platform role. Mirrors
// PLATFORM_ROLE_PRECEDENCE in team/src/routes.ts, ROLE_PRECEDENCE in
// service-shared/edge-identity.ts, and the Cognito group Precedence in the
// all-in-one template — one contract, four copies that must agree.
const ROLE_PRECEDENCE = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
  "EXECUTIVE",
  "PARTICIPANT",
] as const;

const TABLE_USERS = process.env.TABLE_USERS || "praimana-users";
const TABLE_INVITATIONS =
  process.env.TABLE_INVITATIONS || "praimana-invitations";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "praimana-events";

/**
 * CloudWatch namespace for this trigger's own custom metrics. Matches the
 * Namespace on the alarms in the infrastructure CloudFormation template — change
 * both or the alarm silently watches a metric nobody publishes.
 */
const METRIC_NAMESPACE =
  process.env.METRIC_NAMESPACE || "Praimana/CognitoPostConfirmation";

/** Metric name shared with the CloudWatch alarm in the all-in-one template. */
const METRIC_GROUP_ASSIGN_FAILED = "GroupAssignmentFailures";

/** Log-line prefix, so the emitted EMF record reads the same as this file's other logs. */
const METRIC_SOURCE = "cognito-postconfirm";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const idp = new CognitoIdentityProviderClient({});
const events = new EventBridgeClient({});

interface InvitationRow {
  platformRole?: string;
  /** ISO-8601. Absent on invitations that predate invite-link expiry. */
  expiresAt?: string;
  /**
   * PENDING / ACCEPTED / REVOKED. Absent on rows written before the field existed, which
   * counts as PENDING — see isRevoked for why the polarity is forced that way.
   */
  status?: string;
}

/**
 * True when an invitation's grant was WITHDRAWN.
 *
 * `REVOKED` is written by the Team service when a member is REMOVED from a team; the row is
 * flipped rather than deleted because it is also the record of who invited them and when
 * they accepted. MIRRORS isRevoked() in cognito-presignup/src/handler.ts and
 * isRevokedInvitation() in team/src/domain.ts — three copies because these Lambdas bundle
 * standalone, and they must agree.
 *
 * WHY IT IS READ HERE. This handler resolves the AUTHORITATIVE PLATFORM ROLE from the
 * invitation rows for an address, and it filtered only on expiry — so a withdrawn grant
 * would still have voted on the Cognito GROUP a self-registering user is put in, and it
 * would have voted with whatever privilege it carried. The role must come from a grant that
 * is still standing.
 *
 * ABSENT/unrecognised is NOT revoked, matching isExpired's polarity above and for the same
 * reason: rows predating the field must keep working. Compared case-insensitively because
 * the string is a cross-service contract carried in separate bundles.
 */
function isRevoked(status: string | undefined): boolean {
  return typeof status === "string" && status.trim().toUpperCase() === "REVOKED";
}

/**
 * Mirrors isExpired() in team/src/invite-token.ts and the pre-signup trigger —
 * duplicated because this Lambda bundles standalone. Missing expiresAt = not
 * expired (legacy rows stay valid); unparseable = expired (fails closed).
 */
function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at <= now;
}

/**
 * The authoritative platform role for this email, from the invitation(s) an
 * admin/facilitator stored — never from anything the client sent.
 *
 * Reads the invitations table directly via the email-index GSI (see the pre-signup
 * handler for why the Team service HTTP lookup was dropped). Expired invitations
 * are ignored, matching the gate that let this user in; an email invited to
 * several teams collapses to the highest-privilege role so group assignment can't
 * be under-privileged by invitation ordering.
 *
 * Falls back to PARTICIPANT (least privilege) on any failure — the user is already
 * confirmed at this point, so refusing outright isn't an option, and
 * over-privileging on error would be far worse than under-privileging.
 */
async function resolveRole(email: string): Promise<Role> {
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_INVITATIONS,
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": email },
      })
    );

    // LIVE means un-expired AND not withdrawn. The revoked half was added with the
    // removal-driven revocation: a REVOKED row survives (it is provenance), so filtering
    // only on expiry would let a grant that has been taken away decide which Cognito group
    // a self-registering user lands in. Both predicates fail OPEN on an absent value, so
    // legacy rows are unaffected.
    const now = Date.now();
    const live = ((res.Items as InvitationRow[]) ?? []).filter(
      (row) => !isExpired(row.expiresAt, now) && !isRevoked(row.status)
    );
    if (live.length === 0) return "PARTICIPANT";

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
  } catch (err) {
    console.error("[cognito-postconfirm] role lookup failed", {
      table: TABLE_INVITATIONS,
      error: err instanceof Error ? err.message : String(err),
    });
    return "PARTICIPANT";
  }
}

export const handler: PostConfirmationTriggerHandler = async (
  event: PostConfirmationTriggerEvent
) => {
  // Only act on the confirm-signup source, NOT on forgot-password confirmations.
  //
  // This guard is CORRECT AND UNCHANGED, and it was checked rather than assumed while
  // moving registration to admin-provisioning. Two things it must keep doing:
  //
  //   - Keep ignoring `PostConfirmation_ConfirmForgotPassword`. A password reset must not
  //     re-run role assignment and the profile write: it would re-resolve the role from
  //     whatever invitations happen to be live, which for a long-standing user could
  //     silently CHANGE their role — a privilege change triggered by clicking "forgot
  //     password".
  //   - Not be widened for the admin-create path. There is no admin-create source on this
  //     trigger (see the file header): the function is never invoked on that path at all,
  //     so widening the check would add a branch that cannot execute while removing the
  //     forgot-password protection above.
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
    return event;
  }

  const attrs = event.request.userAttributes ?? {};
  const sub = attrs.sub;
  const email = (attrs.email || "").toLowerCase();

  // The three MANDATORY profile fields, as the sign-up form submitted them to
  // Cognito. Deliberately duplicated (normalise + derive, rather than importing
  // @praimana/shared) because this Lambda bundles standalone — the same
  // reason isExpired() is duplicated above. The contract that must hold is only
  // that a blank value stays blank, so the identity service's completeness gate
  // still asks the user for it rather than reading a whitespace string as filled.
  const norm = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
  const firstName = norm(attrs.given_name);
  const lastName = norm(attrs.family_name);
  const organization = norm(attrs["custom:organization"]);

  // `name` is DERIVED from the parts. Falls back to the legacy attributes and then
  // the email so the row always has something displayable, matching displayName()
  // in @praimana/shared.
  const name =
    [firstName, lastName].filter(Boolean).join(" ") ||
    norm(attrs.name) ||
    norm(attrs["custom:name"]) ||
    email;

  const role = await resolveRole(email);

  // 1. Assign the Cognito group (role authority).
  //
  // This is the step whose SILENT failure hid a real outage for the entire life of
  // the deployment: a cognito-idp VPC endpoint made every AdminAddUserToGroup call
  // fail, and because the catch only logged, confirmed users landed in NO group
  // (→ no cognito:groups claim → treated as PARTICIPANT) with nothing alarming.
  //
  // The fix is NOT to throw. The user is already confirmed here, so throwing would
  // surface a confusing post-signup error without un-confirming them — the
  // behaviour below (log, carry on, let the user finish signing up) is correct and
  // deliberately unchanged. What was missing is a SIGNAL: the metric emitted on
  // failure is alarmed on in the infrastructure CloudFormation template, so the same
  // bug now pages instead of hiding. A success datapoint is emitted too, so the
  // metric exists in a healthy account and "no data" is distinguishable from
  // "no failures".
  try {
    await idp.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        GroupName: role,
      })
    );
    emitMetric({
      namespace: METRIC_NAMESPACE,
      name: METRIC_GROUP_ASSIGN_FAILED,
      value: 0,
      dimensions: { Role: role },
      source: METRIC_SOURCE,
    });
  } catch (err) {
    console.error("[cognito-postconfirm] add-to-group failed", {
      role,
      error: err instanceof Error ? err.message : String(err),
    });
    // Dimensioned by role only — the error string is caller/AWS-influenced and
    // would create unbounded metric cardinality; it stays in the log line above.
    // Namespace, metric name and BOTH dimension sets are byte-for-byte what the local
    // copy of emitMetric published, so CognitoGroupAssignmentFailureAlarm keeps matching
    // across this refactor.
    emitMetric({
      namespace: METRIC_NAMESPACE,
      name: METRIC_GROUP_ASSIGN_FAILED,
      value: 1,
      dimensions: { Role: role },
      source: METRIC_SOURCE,
    });
  }

  // 2. Write the profile row (keyed by the Cognito sub).
  //
  // AN UPDATE, NOT A PUT — changed while auditing this handler for re-run safety.
  //
  // The old full-item PutCommand was safe only because this trigger fires exactly once
  // per account, which is no longer something to rely on: the same users table is now
  // also written by the user-access service at provisioning time, and by the identity
  // service's PATCH /me when the user fills in their profile. A full-item Put would
  // silently erase whichever of those landed first — most damagingly the three mandatory
  // profile fields, after which the completeness gate would send the user back to a form
  // they had already completed.
  //
  // So each attribute is written for a stated reason:
  //   - `email`, `role`, `authProvider`, `updatedAt` are SET. Role is authoritative here
  //     (resolved from the invitation, never from the client).
  //   - `createdAt` uses if_not_exists, so an existing row keeps its original timestamp.
  //   - firstName / lastName / organization and `name` are written ONLY when the sign-up
  //     form actually supplied them, via if_not_exists so a value the user has since
  //     edited is never overwritten by the stale attribute Cognito still holds. Storing
  //     "" is avoided for the original reason: it would make the field LOOK present to
  //     anything checking for the key rather than for content, and the profile gate would
  //     stop asking.
  const id = sub || ulid();
  const now = new Date().toISOString();

  // Built as a list of "SET" fragments so the optional fields are genuinely absent from
  // the expression rather than set to a placeholder.
  const sets = [
    "#email = :email",
    "#role = :role",
    "#authProvider = :authProvider",
    "#updatedAt = :updatedAt",
    "#createdAt = if_not_exists(#createdAt, :now)",
    "#name = if_not_exists(#name, :name)",
  ];
  const names: Record<string, string> = {
    "#email": "email",
    "#role": "role",
    "#authProvider": "authProvider",
    "#updatedAt": "updatedAt",
    "#createdAt": "createdAt",
    "#name": "name",
  };
  const values: Record<string, string> = {
    ":email": email,
    ":role": role,
    ":authProvider": "COGNITO",
    ":updatedAt": now,
    ":now": now,
    ":name": name,
  };
  for (const [key, value] of [
    ["firstName", firstName],
    ["lastName", lastName],
    ["organization", organization],
  ] as const) {
    if (!value) continue;
    sets.push(`#${key} = if_not_exists(#${key}, :${key})`);
    names[`#${key}`] = key;
    values[`:${key}`] = value;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_USERS,
        Key: { id },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    console.error("[cognito-postconfirm] profile write failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Publish user.created so read-models sync.
  try {
    await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: EVENT_BUS_NAME,
            Source: "identity-service",
            DetailType: "user.created",
            Detail: JSON.stringify({ id, name, email, role }),
          },
        ],
      })
    );
  } catch (err) {
    console.error("[cognito-postconfirm] event publish failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return event;
};
