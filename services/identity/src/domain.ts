/**
 * Identity bounded context — owns the users PROFILE store. Authentication is
 * native Amazon Cognito: Cognito owns credentials + tokens, and the platform
 * role lives in Cognito Groups. This service no longer stores passwords or mints
 * tokens; the profile row is written by the Cognito post-confirmation trigger and
 * read back here. Other services get identity from the gateway-injected Cognito
 * claims (authN) or from a users read-model synced via `user.*` events.
 */
import { isUserDeactivated, type UserStatus } from "@praimana/shared";
import { isProfileComplete } from "@praimana/service-shared";

export type UserRole = "ADMIN" | "FACILITATOR" | "EXECUTIVE" | "PARTICIPANT" | "JUDGE";

const USER_ROLES: readonly UserRole[] = [
  "ADMIN",
  "FACILITATOR",
  "EXECUTIVE",
  "PARTICIPANT",
  "JUDGE",
];

/**
 * Narrow the edge identity's `role` (typed as a bare string) to a UserRole,
 * falling back to PARTICIPANT — the LEAST privileged role.
 *
 * A cast would compile just as well and be wrong: it would let an unrecognised
 * value flow into a stored row and from there into anything that trusts the store.
 * Failing closed here mirrors what edgeIdentityMiddleware already does when it
 * can't parse the groups claim, so the two agree on the safe default.
 */
export function toUserRole(role: string | undefined): UserRole {
  return USER_ROLES.includes(role as UserRole) ? (role as UserRole) : "PARTICIPANT";
}

export interface User {
  id: string; // the Cognito sub
  email: string;
  /**
   * Display name. DERIVED from firstName + lastName via displayName() — never
   * accepted from a client. Kept as a stored field because other contexts read it
   * from the users read-model (populated off the `user.*` events), so the parts
   * could be introduced without touching them.
   */
  name: string;
  /** Mandatory profile fields, collected at sign-up. See @praimana/shared. */
  firstName?: string;
  lastName?: string;
  organization?: string;
  role: UserRole;
  authProvider?: string; // "COGNITO"
  /**
   * Platform access, FOR DISPLAY ONLY. ABSENT MEANS ACTIVE.
   *
   * ⚠ A MIRROR OF COGNITO, NOT THE AUTHORITY, and this service is the reason the mirror
   * exists at all: it serves the Administration directory and has no Cognito client and
   * no Cognito IAM, so without a copy the screen could not show who is disabled or offer
   * a way to reverse it. Enforcement is AdminDisableUser/AdminEnableUser, performed by
   * the user-access service, which is also the only writer of this field.
   *
   * NEVER AN AUTHORIZATION INPUT. Nothing here reads it to decide access and nothing
   * should start — that single rule is what keeps a lagging mirror a display bug rather
   * than an access bug, in BOTH directions. Never test `!== "ACTIVE"`: use
   * isUserDeactivated() from @praimana/shared, which tests for the deny value so
   * that rows predating the field read as active and need no backfill.
   *
   * Typed as the shared UserStatus so the two cannot drift; the full reasoning, the
   * rejected statusVersion counter, and the residual already-issued-token window are
   * documented on that type in shared/types/user.ts.
   */
  status?: UserStatus;
  createdAt: string;
  updatedAt: string;
}

/** Public projection — what leaves the service. */
export type PublicUser = User & {
  /**
   * Whether all three mandatory profile fields are present. Computed here rather
   * than left to each caller: the portal's completion gate and the profile form
   * both need the answer, and two independent re-derivations of "complete" is
   * exactly how a user ends up in a redirect loop.
   */
  profileComplete: boolean;
};

export function toPublic(user: User): PublicUser {
  return { ...user, profileComplete: isProfileComplete(user) };
}

// A Cognito `sub` is a UUID. Every real account's profile row is keyed by it.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if this row's id looks like a Cognito `sub`, i.e. there is plausibly a real
 * Cognito account behind it.
 *
 * This exists because the post-confirmation trigger writes its profile row with
 * `id = sub || ulid()`. That fallback is a reasonable choice there — better a row
 * with a synthetic key than a dropped profile — but it produces rows that no
 * Cognito admin API can ever act on, because there is no user with that id. One
 * such row exists in the dev table today (a ULID, from a probe).
 *
 * The Administration screen uses this to mark those rows non-actionable UP FRONT,
 * rather than offering a Revoke button that can only ever fail. It is a
 * presentation hint, not a security check: the write path must STILL handle
 * UserNotFoundException, since a row can also be orphaned by a user deleted
 * directly in Cognito, and that row's id is a perfectly well-formed UUID.
 */
export function hasCognitoAccount(user: Pick<User, "id">): boolean {
  return UUID_RE.test(user.id);
}

/**
 * Administration projection — what the user-management screen sees about SOMEONE
 * ELSE. Deliberately NOT PublicUser: profileComplete is about steering the owner of
 * an account through their own sign-up, and means nothing to an administrator
 * looking at a list.
 */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  organization?: string;
  createdAt: string;
  /** False for a row with no Cognito account behind it — see hasCognitoAccount. */
  hasAccount: boolean;
  /**
   * True when this row IS the caller. Computed server-side because the client
   * comparison is the one that would be got wrong, and every write path refuses a
   * self-action anyway — this just lets the UI say so before the click.
   */
  isSelf: boolean;
  /**
   * Platform access, so the row can render an "Access disabled" badge.
   *
   * ALWAYS PRESENT on this projection, unlike on the stored row where absence means
   * active. Normalised here rather than left for the client to interpret: a UI that had
   * to know "undefined means ACTIVE" is a UI that gets it wrong once and then shows every
   * pre-existing account as disabled. The stored asymmetry exists for the rolling-deploy
   * reason documented on UserStatus; it stops at this boundary.
   *
   * A DISPLAY MIRROR of Cognito's own flag, never an authorization input — see the field
   * on User above.
   */
  status: UserStatus;
}

export function toAdminUser(user: User, callerId: string): AdminUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    organization: user.organization,
    createdAt: user.createdAt,
    hasAccount: hasCognitoAccount(user),
    isSelf: user.id === callerId,
    // isUserDeactivated, not `user.status ?? "ACTIVE"`: the shared predicate tests for
    // the DENY value, so any other stored value — absent, empty, a typo, a
    // partially-written attribute — reads as ACTIVE. That fails OPEN on garbage, which is
    // the right direction for a badge whose wrong answer would otherwise be "every
    // account on the platform is disabled".
    status: isUserDeactivated(user) ? "DEACTIVATED" : "ACTIVE",
  };
}

/** One page of users, plus an opaque cursor for the next. */
export interface UserPage {
  users: User[];
  /**
   * Opaque continuation token, absent on the last page. Callers MUST treat this as
   * a opaque string and pass it back unmodified — it encodes a DynamoDB
   * LastEvaluatedKey, and there is no guarantee it stays that shape.
   */
  nextCursor?: string;
}

/** Repository interface (DIP). The routes depend on this, not on DynamoDB. */
export interface UserRepository {
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  /**
   * ⚠ FULL-ITEM REPLACE. Every attribute the supplied `user` does not restate is DELETED.
   *
   * Correct for a CREATE and wrong for an edit, which is why `updateProfile` exists beside it.
   * See that method's note for the attributes this destroyed on the profile-save path.
   */
  put(user: User): Promise<User>;
  /**
   * ── SET ONLY THE PROFILE FIELDS, LEAVING EVERY OTHER ATTRIBUTE ALONE ──────────
   *
   * `PATCH /v1/auth/me` previously built a complete `User` and persisted it with
   * `put`, i.e. a full-item PutCommand — and in DynamoDB a Put REPLACES the item, so every
   * attribute the handler did not restate was deleted. The handler carried `status`, `email`,
   * `role`, `authProvider` and `createdAt` through, and its comment shows the author knew the
   * rule ("an omitted field is a DELETED attribute"), but four attributes were still dropped on
   * every single profile save:
   *
   *   accessChangedBy / accessChangedAt — written onto this same row by user-access's setStatus
   *     UpdateCommand. They are the row's OWN fallback record of who disabled or enabled an
   *     account, for when the separate audit write is the thing that failed: "before these two
   *     fields … the operator's identity existed NOWHERE" (user-access/src/domain.ts). NOT an
   *     authorization input — that is stated there explicitly — so nothing about access control
   *     changed. What was lost was attributability, and the route's own comment concedes a
   *     disabled account keeps API access on an already-issued token long enough to save this
   *     form once, which is exactly the window in which someone has a motive to clear it.
   *
   *   avatarUrl — declared on the shared User type. Saving your own profile silently dropped
   *     it and the avatar simply vanished from the UI. This half is an ordinary data-loss bug
   *     and needs no security framing at all.
   *
   * ⚠ AN UpdateCommand, NOT "a Put that also lists those fields". A Put would fix today's
   * attributes and silently reintroduce the bug the moment another attribute is written to this
   * row by anyone — and TWO other services already write here. The whole class goes away by
   * naming what changes instead of naming what must survive.
   *
   * ⚠ AND THAT IS WHY THIS TAKES NO `User`. It takes exactly the fields the profile form owns.
   * `accessChangedBy` and `accessChangedAt` are not even declared on the shared `User` type —
   * they are written by user-access and read by nobody — so an interface in terms of `User`
   * could not have preserved them even in principle.
   *
   * Returns the row AFTER the update (ReturnValues: ALL_NEW), so the route can answer with the
   * whole profile without a second read.
   */
  updateProfile(
    id: string,
    fields: {
      firstName: string;
      lastName: string;
      organization: string;
      /** Derived from the parts by the caller, so the two cannot disagree. */
      name: string;
      updatedAt: string;
    }
  ): Promise<User>;
  /**
   * EVERY user on the platform, one page at a time. Backs the Administration
   * screen, which is the only caller that legitimately needs to see accounts other
   * than its own — so this is exposed behind a route that checks canManageUsers,
   * never from /me.
   *
   * Paginated rather than "return everything" because the underlying store has no
   * index that can list users (the table is keyed by the Cognito sub, and both GSIs
   * are point lookups by email/alias), so this is inherently a full table read.
   * A cursor keeps that read bounded and the page size honest as the platform grows.
   *
   * `visibleRoles` restricts the result to users holding one of those roles, and is
   * how "a FACILITATOR must not see ADMIN accounts" is enforced. It belongs on the
   * REPOSITORY rather than in the route so that the only method able to enumerate
   * users is also the one that applies the restriction — a route-level filter is one
   * a future route can forget. Omit it for no restriction; an EMPTY array means "see
   * nothing" and returns no users.
   */
  list(opts?: {
    limit?: number;
    cursor?: string;
    visibleRoles?: readonly string[];
    /**
     * Case-insensitive SUBSTRING match on name and email, applied in the STORE so it
     * matches across the whole table rather than only the page in hand.
     *
     * WHY THIS IS NOT A CLIENT-SIDE FILTER. The Administration screen already filters
     * the loaded page in the browser, which is fine for browsing and wrong for finding:
     * with more than one page of users, searching while viewing page 1 silently misses
     * everyone on page 2. That is tolerable when skimming and unacceptable when the
     * reason you are searching is to act on a specific person — the operator concludes
     * the account does not exist.
     *
     * BELONGS HERE, next to visibleRoles, for the same stated reason: the only method
     * able to enumerate users is also the one that applies every restriction, so a
     * future route cannot forget one. In particular the search filter is ANDed with
     * visibleRoles — it must never be a way to confirm the existence of an account the
     * caller may not see.
     *
     * COST, stated plainly: the table has no index that can list users, so this is
     * already a filtered Scan and search adds two more conditions to it. It does NOT
     * change the number of rows read, only how many are returned. At hackathon scale
     * that is one page; revisit alongside the same trip-wire as the existing Scan.
     */
    search?: string;
  }): Promise<UserPage>;
  /**
   * Profiles for a KNOWN set of ids, in one shot.
   *
   * Two callers, both on the Administration screen. A team or workshop filter
   * resolves to member ids in the Team context and hydrates the profiles here — that
   * direction is forced, because "who is in team X" has no answer in this table.
   * And the "Invited by" column resolves inviter subs to names.
   *
   * Ids that don't exist are simply absent from the result: an invitation can name an
   * inviter whose account was later deleted, and a membership can outlive a profile
   * row. Callers must handle a short result rather than assume index alignment.
   */
  listByIds(ids: readonly string[]): Promise<User[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEEDBACK AND BUG REPORTS
//
// ── ⚠ WHY THIS REPLACED A `mailto:` LINK, AND WHAT THAT COST ──
//
// The first version of "Report a bug" / "Give feedback" was a prefilled `mailto:`. The rule now: feedback
// and bug reports are not emailed by the reporter; they are stored in the database, and facilitators and
// admins are notified and can see them under Administration.
//
// The mailto had two real advantages that are now GIVEN UP, and they are worth naming so nobody
// rediscovers them as surprises:
//
//   1. ⚠ IT WORKED WHEN THE PLATFORM DID NOT. A report about "the site is down" could still be sent,
//      because the mail client is not this platform. An in-app form CANNOT submit during the outage it is
//      describing. That is the trade, and it is a real loss for the worst class of bug.
//   2. It needed no table, no route and no IAM.
//
// What it bought instead is worth more for every other class of report: the reports are IN ONE PLACE,
// nobody has to remember to forward them, and they cannot be lost in a personal inbox. A report that
// arrives is now visible to every admin rather than to whoever was on the To: line.
//
// ── ⚠ WHY THE IDENTITY SERVICE OWNS IT ──
//
// Chosen deliberately over a new service. This context already owns "people", and it already has the
// admin READ surface (`GET /v1/admin/users`) gated on exactly the rule the feedback inbox needs
// (`canManageUsers` → ADMIN + FACILITATOR). A dedicated service would be a cleaner boundary on paper and
// ten template resources — a Lambda, a role, a log group, gateway routes, a release artifact — for two
// routes over one small table.

/** What a report IS. A closed set, because it decides which prompt the form shows and how it is triaged. */
export type FeedbackKind = "BUG" | "FEEDBACK";

/**
 * Whether anyone has dealt with it yet.
 *
 * ⚠ TWO STATES, NOT THREE. "In progress" is a status somebody has to remember to move off, and an inbox
 * nobody grooms fills with stale middles. NEW means "no admin has looked at this"; ACKNOWLEDGED means
 * "somebody has". That is the whole question the counter answers.
 */
export type FeedbackStatus = "NEW" | "ACKNOWLEDGED";

export interface FeedbackReport {
  /** ULID, so the table's own key sorts by creation time. */
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  /**
   * The one-line summary (a subject input alongside the description).
   *
   * ⚠ BOUNDED IN WORDS *AND* CHARACTERS, by `checkFeedbackField("subject", …)` in the shared package — the
   * same function the two forms call, so the field the reporter was allowed to send is the field this
   * service accepts.
   *
   * ⚠ AND IT IS THE EMAIL'S SUBJECT LINE. That is what makes it worth a field of its own rather than a
   * first line convention: staff triage from a mail client, where a subject reading "A bug has been
   * reported" for every report is indistinguishable noise.
   */
  subject: string;
  /** What the reporter wrote. Bounded the same way — see FEEDBACK_MESSAGE_BOUNDS. */
  message: string;

  // ── Who and where, captured SERVER-SIDE from the verified identity ──
  //
  // ⚠ NOT FROM THE BODY. A client-supplied reporter id would let anyone file a report as somebody else,
  // and the whole value of an inbox is that "who hit this" is trustworthy.
  reportedById: string;
  reportedByEmail: string;
  reportedByRole: string;
  // ⚠ THESE THREE ARE NOT WHAT THE INBOX RETURNS. Every read projects the row through
  // `toVisibleReport`, which REMOVES the id and the email when the reading staff member may not
  // know who the reporter is — see VisibleFeedbackReport below. This interface is the STORED
  // shape; a route that returns it unprojected is the defect that was reported.

  /** Which app it came from — the first thing a triager needs. Client-supplied but a closed set. */
  surface: "portal" | "desktop";
  /** App/release version, when the surface knows it. Free text: it is a version string, not an enum. */
  version: string | null;
  /** The route or view the reporter was on. */
  location: string | null;
  /** Ids only, and only for context. Never names — see the note on the create route. */
  workshopId: string | null;
  teamId: string | null;

  createdAt: string;
  /**
   * ⚠ THE SPARSE-INDEX KEY, and it is the subtlest thing in this file.
   *
   * Present ONLY while `status === "NEW"`, holding the constant `"NEW"`. That makes the unread index
   * SPARSE: acknowledged rows leave it entirely, so counting unread reports is a Query over exactly the
   * unread ones rather than a Scan of the table with a filter.
   *
   * ⚠ IT MUST BE *ABSENT*, NOT NULL. DynamoDB REJECTS a write whose index key attribute is NULL — it does
   * not skip the index, it fails the whole request. The evaluation service's repository carries the same
   * warning after the same trap; `forStorage` below is the fix, and it is not optional.
   */
  unread?: "NEW";
  /** When an admin acknowledged it, and who. Null while NEW. */
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
}

/** The listing shape: newest first, plus the number still unread. */
export interface FeedbackPage {
  items: FeedbackReport[];
  nextCursor?: string;
  /**
   * ⚠ RETURNED WITH THE LIST RATHER THAN FROM A SECOND ROUTE. The badge and the list are read together by
   * the Administration screen, so one round trip answers both — and the two can never disagree about the
   * count, which they could if the browser combined two responses taken a second apart.
   */
  unreadCount: number;
}

/**
 * ── ONE REPORT, AS THE READING STAFF MEMBER IS ALLOWED TO SEE IT ────────────────────────────
 *
 * `GET /v1/admin/feedback` previously returned stored rows VERBATIM — and every row
 * carries `reportedById` (the reporter's raw Cognito sub), `reportedByEmail` and
 * `reportedByRole`, captured server-side at file time. The admin router admits ADMIN *and*
 * FACILITATOR, so a facilitator opening the inbox learned the email address, sub and role of any
 * ADMIN who had filed a bug — which is precisely what `USER_VISIBILITY_GRANTS` withholds, and
 * for a stated reason: "knowing WHICH accounts hold full platform access is itself the
 * reconnaissance step".
 *
 * ⚠ EVERY NEIGHBOURING READ ON THE SAME ROUTER ALREADY DID THIS. `GET /admin/users` filters rows
 * with `canSeeUser`, and `GET /admin/user-names` answers `{hidden:true}` instead of a name. The
 * inbox was the one read that skipped it, so this is applying the router's existing rule rather
 * than inventing one.
 *
 * ── WHY REDACT RATHER THAN DROP THE ROW ──
 *
 * A facilitator must still SEE that the report exists, and still be able to act on it — the
 * whole point of the inbox is that nothing is lost. Hiding the row would lose a real bug report;
 * hiding the reporter loses only the fact the matrix says to withhold. `reportedByRole` is KEPT
 * deliberately: a triager needs to know a report came from staff rather than a participant, and
 * the role alone does not identify anybody.
 *
 * ⚠ `reportedByHidden` IS A MARKER, NOT AN EMPTY STRING. The `{hidden:true}` shape at
 * `/admin/user-names` exists so a client can render "Not shown" rather than a blank that reads
 * as a data problem, and this mirrors it. Blanking the field would be indistinguishable from a
 * row filed before the field existed.
 */
export type VisibleFeedbackReport = Omit<
  FeedbackReport,
  "reportedById" | "reportedByEmail"
> & {
  /** Absent when the reader may not know who filed this. */
  reportedById?: string;
  /** Absent when the reader may not know who filed this. */
  reportedByEmail?: string;
  reportedByHidden?: boolean;
};

export function toVisibleReport(
  report: FeedbackReport,
  callerRole: string | undefined,
  canSee: (callerRole: string | undefined, targetRole: string | undefined) => boolean
): VisibleFeedbackReport {
  if (canSee(callerRole, report.reportedByRole)) return report;
  // ⚠ DESTRUCTURED OUT, NOT OVERWRITTEN WITH "". The keys are genuinely ABSENT from the JSON, so
  // a hidden reporter is distinguishable from a row filed before these fields existed — the same
  // reasoning as the `{hidden:true}` shape at /admin/user-names. An empty string would also be
  // rendered as an empty mailto by any client that did not check the marker first.
  const { reportedById: _id, reportedByEmail: _email, ...rest } = report;
  void _id;
  void _email;
  return { ...rest, reportedByHidden: true };
}

export interface FeedbackRepository {
  create(report: FeedbackReport): Promise<FeedbackReport>;
  /** Newest first. `limit` is clamped by the caller; the repository trusts it. */
  list(opts?: { limit?: number; cursor?: string }): Promise<FeedbackPage>;
  /** How many are still NEW. Counted via the sparse index, never a table Scan. */
  unreadCount(): Promise<number>;
  /**
   * Move a report to ACKNOWLEDGED. Returns null when there is no such report.
   *
   * ⚠ IDEMPOTENT. Acknowledging an already-acknowledged report succeeds and changes nothing: two admins
   * clicking at once is the normal case, and a conditional failure there would be an error message about
   * a thing that is already true.
   */
  acknowledge(id: string, adminId: string, at: string): Promise<FeedbackReport | null>;
}

/**
 * ── ⚠ TELLING STAFF A REPORT ARRIVED ───────────────────────────────────────────────────────
 *
 * THE RULE: the backend emails the current experience facilitators and admins — a revision of the earlier
 * "in-app counter only" choice. Both now exist: the badge answers
 * "is there anything new", the email means nobody has to be looking.
 *
 * ⚠ FROM THE BACKEND, WHICH IS THE WHOLE DIFFERENCE FROM THE `mailto:` THIS REPLACED. The reporter's own
 * mail client is no longer involved: they press Send in the app, the report is stored, and the platform
 * tells staff. So a report cannot be lost because somebody's client was misconfigured, and the reporter
 * never sees a staff address.
 *
 * ── ⚠ WHO IS NOTIFIED, AND THE ONE PLACE THIS IS LESS PRECISE THAN THE ASK ──
 *
 * Every ADMIN and FACILITATOR account. The ask said "the current experience facilitators", which would mean
 * the OWNER of the experience the reporter was in — and that id lives in the WORKSHOP context, which this
 * service has no client for and no east-west dependency on. Adding one for a notification would be a new
 * cross-service coupling, a new IAM grant and a new failure mode on a path that must not fail.
 *
 * So: all staff are told, and the report's `workshopId` is IN the email so a recipient can see at a glance
 * whether it concerns them. If per-experience routing is wanted later, the honest place for it is a
 * workshop lookup here, added deliberately.
 */
export interface FeedbackNotifier {
  /**
   * Tell staff about a new report. MUST NOT THROW — see the create route.
   *
   * Returns how many recipients it reached, for the log line only. A caller must not branch on it: zero
   * recipients is a configuration observation, not a failure of the report.
   */
  notifyNewReport(report: FeedbackReport, recipients: string[]): Promise<number>;
}

/**
 * ── ⚠ PLATFORM HEALTH, READ-ONLY ───────────────────────────────────────────────────────────
 *
 * A read-only platform health tab in Administration, visible only to admins and facilitators.
 *
 * ── WHAT IT IS, AND THE ONE DECISION THAT SHAPES EVERYTHING ELSE ──
 *
 * It reads CLOUDWATCH ALARM STATES and nothing else. No metric maths, no per-service dashboards rebuilt in
 * HTML. That is deliberate: twelve alarms already encode every judgement an operator would otherwise have to
 * make from raw metrics — what is abnormal, over what window, and what to do about it — and each carries an
 * `AlarmDescription` written as operator prose with a runbook. Rendering those is a page that AGREES with the
 * alarms that page whoever is on call. A second set of thresholds in the portal would eventually disagree
 * with the alarms, and then the page would be actively misleading.
 *
 * It also keeps the IAM ask to ONE read-only action, which matters more here than usual because every
 * function in this platform shares one execution role.
 *
 * ── ⚠ WHY THIS LIVES IN THE IDENTITY SERVICE, WHICH IS NOT OBVIOUSLY RIGHT ──
 *
 * Platform health is not identity's bounded context, and this is the pragmatic exception rather than a
 * precedent. The alternative — a fifteenth Lambda, its own zip in publish-artifacts.sh, its own template
 * resources and route — is a lot of moving parts for a read-only status panel, and identity is the only
 * service with an `/v1/admin` router already gated at exactly the intended audience (ADMIN + FACILITATOR,
 * by middleware, so a route added later cannot forget it).
 *
 * The port is what makes that defensible: nothing about this depends on identity's tables, so moving it is
 * moving one file and one route.
 */
export type HealthState = "OK" | "ALARM" | "UNKNOWN";

export interface HealthAlarm {
  /** The alarm name with the platform prefix stripped — "api-5xx", not "praimana-api-5xx". */
  name: string;
  state: HealthState;
  /** The operator prose from the alarm itself, including its runbook. May be empty. */
  description: string;
  /** Why CloudWatch put it in this state — the threshold sentence. May be empty. */
  reason: string;
  /** ISO instant the state last changed, or null if CloudWatch did not say. */
  since: string | null;
}

export interface PlatformHealth {
  /**
   * The worst state across all alarms.
   *
   * ⚠ `UNKNOWN` IS NOT `OK`, and that is the whole point of having three values. An alarm with insufficient
   * data is one nobody is being told about — treating it as healthy is how a page reports "all good" while
   * the metric behind it has stopped arriving. Same reasoning as the authorization decisions.
   */
  overall: HealthState;
  alarms: HealthAlarm[];
  /** When this was read. The page shows it, because a status panel with no timestamp is undatable. */
  checkedAt: string;
}

export interface PlatformHealthReader {
  /**
   * Read every platform alarm.
   *
   * MAY THROW — and unlike the feedback notifier, it SHOULD when it cannot read. A health page that renders
   * "OK" because the health check itself failed is worse than one that says it could not check; the route
   * turns a throw into a 503 with a code the panel can explain.
   */
  read(): Promise<PlatformHealth>;
}

/**
 * ── ⚠ WHAT THE PLATFORM COSTS TO RUN — ADMIN ONLY ──────────────────────────────────────────
 *
 * An estimated daily and overall spend, visible to admins only, based on the `ApplicationName` cost
 * allocation tag (`Praimana`).
 *
 * ── ⚠ THE TAG FILTER IS BUILT AND WILL READ ZERO UNTIL SOMEBODY ACTS ON IT ──
 *
 * Observed on a linked (member) account, before writing any of this:
 *
 *   · `ce:ListCostAllocationTags` → AccessDenied, "Linked account doesn't have access to cost allocation
 *     tags". In a Control Tower MEMBER account the tag can only be activated in the management/payer
 *     account, which the member account's credentials cannot reach.
 *   · `ce:GetTags --tag-key ApplicationName` → one value, the EMPTY string. Cost Explorer holds no tag data
 *     for that key at all, so every dollar is attributed to "untagged".
 *
 * So a tag-filtered total reads $0.00 until activation, and a panel that showed it as the answer would report that the
 * platform costs nothing. `taggedTotal` is therefore NULLABLE and the surface says which figure it is
 * showing — the ACCOUNT total, until the tag is activated. Two further facts about that, both of which make
 * an eventual switch-over look broken if they are not known:
 *
 *   · activation is NOT RETROACTIVE. Only usage after it takes effect is attributed, so the tagged series
 *     starts at the activation date and everything before it stays untagged forever.
 *
 * ⚠ AND THE ACCOUNT TOTAL IS NOT QUITE THE PLATFORM. An account may hold unrelated
 * stacks, and the SHARED account's artifact buckets are not counted at all. The number is
 * therefore "what this account spends", which is very nearly the platform and is stated as such rather than
 * dressed up as exact.
 */
export interface CostLine {
  /** A service name ("AWS Lambda") or a date ("2026-08-16"), depending on the series. */
  label: string;
  amount: number;
}

export interface CostSnapshot {
  currency: string;
  /** Total for the calendar month so far, across the whole account. */
  monthToDate: number;
  /** Mean of the last complete days available — the "estimated daily spend". */
  dailyAverage: number;
  /** The most recent complete day, or null when the month is one day old. */
  yesterday: number | null;
  /**
   * ⚠ ARITHMETIC, NOT AN AWS FORECAST: monthToDate + dailyAverage × days remaining. `GetCostForecast` is a
   * second billable request and refuses on thin data, and this figure is a sanity check rather than a
   * commitment — so it is computed here and LABELLED as an estimate at the surface.
   */
  projectedMonth: number;
  /** Biggest spenders first, month to date. */
  byService: CostLine[];
  /** Per-day amounts for the month so far, oldest first. */
  daily: CostLine[];
  /**
   * The slice attributable to this platform's `ApplicationName` tag, or NULL when Cost Explorer has no tag
   * data — which is the state today. Never 0 as a stand-in for "unknown": see the header.
   */
  taggedTotal: number | null;
  /** When the figures were fetched from Cost Explorer. Shown, because a cached number without an age lies. */
  asOf: string;
}

export interface CostReader {
  /**
   * The current snapshot, from cache when it is fresh enough.
   *
   * MAY THROW — the route turns that into a 503. A cost panel that renders $0.00 because the read failed is
   * the same defect as a health page that renders "OK" because the check failed.
   */
  read(): Promise<CostSnapshot>;
}
