import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import {
  edgeIdentityMiddleware,
  emitAccessAuditMetric,
  emitMetric,
  emitSeatLedgerDriftMetric,
  requireIdentity,
  type EventPublisher,
} from "@praimana/service-shared";
import type { AuditRepository, Team } from "./domain.js";
import {
  normalizeBatchProgress,
  type BulkBatch,
  type BulkBatchRepository,
} from "./bulk-batch.js";
// The service's SINGLE local copy of the platform team-size ceiling, in its own
// module so three files here share one copy rather than declaring three — see team-size.ts for
// why the count matters to the drift test.
import { MAX_TEAM_MEMBERS, isValidMaxTeamSize } from "./team-size.js";
// The join code's generator and the ambiguity error its lookup can raise. Its own module so
// the CSPRNG mapping is unit-testable without standing up a route — see invite-code.ts for why
// the previous ULID-prefix expression carried no entropy at all.
import {
  AmbiguousInviteCodeError,
  MAX_INVITE_CODE_ATTEMPTS,
  generateInviteCode,
} from "./invite-code.js";

// Single-role precedence (lower index wins), collapsing an email's several
// invitations to the one highest-privilege platform role. Kept local (a tiny
// constant) to avoid a cross-package dep; mirrors ROLE_PRECEDENCE in
// service-shared/edge-identity.ts and the Cognito group Precedence in the
// all-in-one template — one contract, three copies that must agree.
const PLATFORM_ROLE_PRECEDENCE = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
  "EXECUTIVE",
  "PARTICIPANT",
] as const;

/**
 * WHICH PLATFORM ROLES A ROLE MAY GRANT BY INVITATION — the privilege-escalation
 * boundary for this service.
 *
 * An invitation row is authoritative: the Cognito pre-signup trigger reads it to
 * admit a signup and post-confirmation reads it to assign the Cognito GROUP. So
 * writing `platformRole` is equivalent to granting that role. This route previously
 * took the value straight from the request body unchecked, which let any
 * authenticated user (a PARTICIPANT included) mint an `ADMIN` invitation for an
 * address they control and register a fully privileged second account.
 *
 * A deliberate COPY of ROLE_GRANTS in the shared constants/roles module —
 * bundled Lambdas don't take a dep on that package (same reason as
 * PLATFORM_ROLE_PRECEDENCE above). The front-end uses that table to build the
 * dropdown; this one is the enforcement, and the UI's copy is only a convenience.
 * Never rely on the client having filtered: the dropdown narrows what's OFFERED,
 * this decides what's ALLOWED. routes.test.ts asserts the whole matrix so the two
 * copies can't drift.
 */
const ROLE_GRANTS: Record<string, readonly string[]> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: ["PARTICIPANT"],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * The `teamId` on an invitation that grants a PLATFORM role and no team.
 *
 * A deliberate COPY of PLATFORM_INVITATION_TEAM_ID in
 * the shared constants/roles module — bundled Lambdas don't take a dep on that
 * package (same reason as ROLE_GRANTS and PLATFORM_ROLE_PRECEDENCE above). The
 * front-end uses that copy to build the invite form; this one is what actually keys
 * the row, so if the two ever disagree the portal would write rows this service
 * treats as a real team and vice versa. Change both.
 *
 * The value exists because `teamId` is the invitations table's PARTITION KEY and
 * DynamoDB will not store an item without one — there is no such thing as a
 * team-less row, only a row whose teamId means "no team".
 */
const PLATFORM_INVITATION_TEAM_ID = "PLATFORM";

/** True when this teamId is the platform sentinel rather than a real team. */
function isPlatformScope(teamId: string): boolean {
  return teamId === PLATFORM_INVITATION_TEAM_ID;
}

/**
 * ── ⚠ WITHDRAWAL IS AS OWNERSHIP-SCOPED AS GRANTING ──────────────────────────
 *
 * THE ASYMMETRY THIS CLOSES. Minting a workshop-scoped invitation requires the caller to OWN the
 * workshop they name: `mayGrantWorkshop` on the POST path short-circuits for ADMIN and otherwise
 * probes `ownsWorkshop`, so a FACILITATOR hands out judging entitlements only for their own
 * experiences. Both WITHDRAWAL paths for the same attribute checked the role matrix and never the
 * workshop:
 *
 *   · DELETE /teams/:teamId/invitations/:email/workshop  — clears `workshopId`
 *   · DELETE /teams/:teamId/invitations/:email           — revokes a still-PENDING row
 *
 * Every JUDGE row lives at the PLATFORM sentinel (`WORKSHOP_POLICY.JUDGE = "REQUIRED"`), gate 2 is
 * deliberately skipped at platform scope, and `ROLE_GRANTS.FACILITATOR` contains JUDGE — so gates 1
 * and 3 both pass for any facilitator, and the skipped gate 2 was the only ownership-bearing one.
 * The result: ANY facilitator could strip the judging entitlement from ANY judge on the platform,
 * including judges of experiences owned by other facilitators or admins. Since
 * `GET /entitlements/workshops` reads `invitation.workshopId` and every judging read and write is
 * gated on that entitlement, clearing the attribute IS the whole of that judge's access — enough to
 * disable a competitor's judging panel and block results quorum. Recon needed no extra privilege:
 * `GET /teams/PLATFORM/invitations` returns the email and workshopId of every grantable row.
 *
 * ⚠ THE ADMIN BRANCH IS WIDER HERE THAN ON THE MINT PATH, AND THAT IS CORRECT RATHER THAN LAX.
 * `mayGrantWorkshop` gates its ADMIN short-circuit on a KNOWN CALLER EMAIL, because there the
 * unidentified-admin case would defeat the self-invitation gate and an admin could invite THEMSELVES
 * into a stranger's judging. Withdrawal cannot escalate anybody: it only ever removes access, so
 * there is no self-grant to defend against and no reason to make an admin's identity a precondition.
 *
 * ⚠ SCOPED TO `WORKSHOP_POLICY === "REQUIRED"` ROWS, WHICH IS WHAT MAKES IT EXACTLY SYMMETRIC WITH
 * THE MINT PATH — and getting this wrong breaks a legitimate flow. `mayGrantWorkshop` is called from
 * ONE arm of the grant switch, the REQUIRED arm (JUDGE), because that is the only arm where the
 * CALLER NAMES the workshop. For a DERIVED role (EXECUTIVE, PARTICIPANT) the workshopId comes from
 * the TEAM, not from the request, and gate 2 has already established the caller's standing in that
 * team — so ownership was never asked on the way in and must not be asked on the way out. Requiring
 * it would stop an executive or a team-scoped facilitator from withdrawing their OWN team's
 * invitations, which is a working feature and not what this defect is about.
 *
 * ⚠ FAIL-CLOSED, and `.catch(() => false)` for the same reason the mint path gives: this is an
 * authorization gate and it must not depend on a collaborator's internal error discipline. A probe
 * that cannot answer is a refusal.
 *
 * Returns a 403 Response to return, or null when the withdrawal may proceed. A row with no
 * `workshopId`, or one whose role does not name its own workshop, spends no hop.
 */
async function refuseUnownedWorkshopWithdrawal(
  workshops: WorkshopAccess,
  c: Context,
  workshopId: string | null | undefined,
  grantedRole: string,
  actorId: string,
  actorRole: string
): Promise<Response | null> {
  if (!workshopId) return null;
  if (workshopPolicyFor(grantedRole) !== "REQUIRED") return null;
  if (actorRole === "ADMIN") return null;

  const owns = await workshops
    .ownsWorkshop(workshopId, actorId, actorRole, c)
    .catch(() => false);
  if (owns) return null;

  // The same shape as the sibling gates' refusals. It names the reason without naming the OWNER —
  // "who owns this experience" is not this route's answer to give.
  return c.json(
    {
      error:
        "Forbidden: you can only withdraw a judging entitlement for an experience you own",
      code: "WORKSHOP_NOT_OWNED",
    },
    403
  );
}

/**
 * Collapse a set of invitation rows to the SINGLE HIGHEST-PRIVILEGE platform role they carry.
 *
 * `PLATFORM_ROLE_PRECEDENCE` order, lower index wins, and an unrecognised role ranks LAST so a
 * typo cannot outrank a real role. An absent `platformRole` reads as PARTICIPANT, the default
 * this service applies everywhere else it reads the field.
 *
 * HIGHEST PRIVILEGE, NOT NEWEST, and that is the property the callers depend on: a role
 * assignment must not be decided by invitation ordering. Same shape as the inline `rank`/
 * `reduce` in GET /invitations/lookup-by-email — hoisted here because the reactivation gate
 * needs it too, and two copies of "which of these rows wins" is how the signup path and the
 * refusal gate drift into disagreeing about what somebody is.
 *
 * ⚠ TAKES THE ROWS IT IS GIVEN AND FILTERS NOTHING. Whether REVOKED/expired rows count is the
 * CALLER's decision, because it depends on whether the answer decides a GRANT or a REFUSAL —
 * see the reactivation gate, which passes every row on purpose.
 */
function highestPlatformRole(
  rows: readonly { platformRole?: string }[]
): string {
  const rank = (r: string) => {
    const i = (PLATFORM_ROLE_PRECEDENCE as readonly string[]).indexOf(r);
    return i === -1 ? PLATFORM_ROLE_PRECEDENCE.length : i;
  };
  return rows.reduce(
    (acc, row) => {
      const role = row.platformRole || "PARTICIPANT";
      return rank(role) < rank(acc) ? role : acc;
    },
    "PARTICIPANT" as string
  );
}

/**
 * Cap on how many invitation rows the reactivation gate will weigh as evidence.
 *
 * `listByEmail` is a single-partition Query on the email-index GSI and the repository does NOT
 * follow pagination, so the STORE already truncates its own answer at 1MB — which means an
 * unbounded row count is not merely a memory question, it is a signal that the evidence in hand
 * may be INCOMPLETE. That matters here and nowhere else on this route, because this lookup
 * decides a REFUSAL: dropping rows can drop the very row that would have refused, so an
 * over-large set is answered 503 (see the gate) rather than collapsed.
 *
 * 50 because an address is invited to a handful of teams — the same order of magnitude as
 * MAX_MEMBERSHIPS (25) and MAX_WORKSHOP_IDS (50) elsewhere in this file — so any real subject is
 * far inside it and hitting it means something is wrong rather than busy.
 */
const MAX_SUBJECT_INVITATIONS = 50;

/**
 * The `seatCap` assumed for a team row that carries none at all, when this file needs to reason
 * about one (the invitation gate below).
 *
 * ONLY REACHED BY A LEGACY ROW — a team created before the seat-cap change, whose creation never seeded
 * the field. A NEW team always has one, because creation REFUSES (503) rather than defaulting
 * when the workshop template cannot be read (the fail-closed rule that `"unavailable"` is
 * never a permissive default).
 *
 * The platform ceiling rather than a narrower guess: the alternative is that such a row's cap
 * is unknowable and every join to it is refused — a lockout on three live teams to enforce a
 * limit none of them is near. The repository applies the SAME fallback when it lazily
 * initialises the ledger, so this file and the store agree about a legacy row. A facilitator
 * narrows it with PATCH; the one-time backfill sets the real per-workshop value.
 */
const LEGACY_TEAM_SEAT_CAP = MAX_TEAM_MEMBERS;

/**
 * A role's row from one of this file's grant matrices, or [] — and the ONE place any of
 * them is read.
 *
 * ── ⚠ WHY A HELPER AND NOT A PLAIN INDEX ──────────────────────────────────────
 *
 * A plain `TABLE[role]` walks the PROTOTYPE CHAIN, so for every matrix in this file
 * `TABLE["constructor"]` is a FUNCTION, `TABLE["__proto__"]` is an object and
 * `TABLE["hasOwnProperty"]` is a function — all TRUTHY. That defeated the guards these
 * predicates already had, in three different ways depending on the shape of the check, and the
 * shapes disagreed about which way they broke:
 *
 *   `!!row && row.length > 0`   → a FUNCTION has a `length` (its arity), so
 *                                 `canInvite("constructor")` returned TRUE. That is gate 1 of
 *                                 the route deciding who may MINT INVITATION ROWS, i.e. who
 *                                 may hand out a platform role. FAILED OPEN.
 *   `row.includes(target)`      → a function has no `.includes`, so `canGrantRole` and
 *                                 `canSeeUser` THREW a TypeError out of an authorization
 *                                 predicate — a 500 where a 403 belongs.
 *   `?? "FORBIDDEN"`            → never fired, because a prototype hit is not nullish, so
 *                                 `workshopPolicyFor`'s fail-closed default was unreachable.
 *
 * ⚠ NOT REACHABLE FROM ANY LIVE CALL SITE TODAY, and that is worth stating precisely rather
 * than leaning on. Both token paths produce `role` via `collapseGroupsToRole`, which can only
 * emit the five declared literals (service-shared/src/edge-identity.ts). The only way to
 * deliver `"constructor"` is the internal-hop header path, which believes `x-identity-role`
 * verbatim and requires INTERNAL_SERVICE_TOKEN. Hardened anyway, for the reason the shared
 * package's own copy gives: "unreachable because of what the caller happens to pass" is not a
 * property of an authorization predicate, and this is the shape of fail-open that survives a
 * refactor of the caller.
 *
 * A DELIBERATE COPY of `grantRow` in service-shared/src/roles.ts:206-214 — bundled Lambdas take
 * no dep on that package, the same idiom as the matrices themselves. `Array.isArray` as well as
 * the own-property check, so an own property whose value is somehow not an array still yields
 * the closed case instead of reaching a caller that will call `.includes` on it.
 */
function grantRow(
  table: Readonly<Record<string, readonly string[]>>,
  role: string | null | undefined
): readonly string[] {
  if (!role) return [];
  if (!Object.prototype.hasOwnProperty.call(table, role)) return [];
  const row = table[role];
  return Array.isArray(row) ? row : [];
}

/**
 * True if `inviterRole` may grant `targetRole`. Fails CLOSED — an absent or
 * unrecognised inviter role grants nothing.
 */
function canGrantRole(inviterRole: string, targetRole: string): boolean {
  return grantRow(ROLE_GRANTS, inviterRole).includes(targetRole);
}

/**
 * Bulk-provisioning ceilings, mirroring the BFF's `MAX_BULK_ROWS` / `MAX_NEW_TEAMS_PER_FILE`.
 * ⚠ DUPLICATED ON PURPOSE: this Lambda is bundled without the portal's modules, and
 * a bound only the client enforces is not a bound. If one moves, both must.
 */
const BULK_MAX_ROWS = 80;
const BULK_MAX_TEAMS = 20;

/**
 * True if the role may issue invitations at all (can grant at least one role).
 *
 * ⚠ Through `grantRow`, not a plain index — this is the predicate that returned TRUE for
 * `"constructor"` (a function's `length` is its arity, which is 1). See grantRow's note.
 */
function canInvite(role: string): boolean {
  return grantRow(ROLE_GRANTS, role).length > 0;
}

/**
 * WHERE AN INVITATION'S `workshopId` COMES FROM, PER GRANTED ROLE — the fourth gate
 * on POST /teams/:teamId/invitations. The rule (stated below) is implemented here, not re-decided.
 *
 *   REQUIRED   the caller MUST name a workshop, and must be ENTITLED to it. Absent
 *              → 400. This is the JUDGE case, and it is the whole point: an
 *              invitation is what makes someone a judge, and a judge with no
 *              workshop can see nothing and score nothing. They register
 *              successfully and land on a dead end — the same silent dead end the
 *              PARTICIPANT/EXECUTIVE platform-scope check already refuses.
 *   DERIVED    the SERVER takes it from the team the invitation is for. A client
 *              value that disagrees is a 400, never a value we honour: this is an
 *              access grant, and it must not come from the request body.
 *   FORBIDDEN  the role's access is not workshop-shaped, so a workshopId on the row
 *              would be a grant nothing reads and a claim nothing enforces. ADMIN is
 *              platform-wide by definition; FACILITATOR sees the workshops they
 *              CREATE (by design), which is why §H can defer
 *              CO-FACILITATOR without the role arriving here by accident.
 *
 * A Record with a FAIL-CLOSED lookup below rather than an if/else chain, so adding a
 * platform role means deciding this question rather than inheriting whichever branch
 * happened to be last. Gate 3 has already refused any role not in ROLE_GRANTS by the
 * time this is read, so an absent entry is unreachable today — it resolves to
 * FORBIDDEN anyway, because refusing a grant is the narrow answer.
 */
type WorkshopPolicy = "REQUIRED" | "DERIVED" | "FORBIDDEN";

const WORKSHOP_POLICY: Record<string, WorkshopPolicy> = {
  ADMIN: "FORBIDDEN",
  FACILITATOR: "FORBIDDEN",
  JUDGE: "REQUIRED",
  EXECUTIVE: "DERIVED",
  PARTICIPANT: "DERIVED",
};

/**
 * The workshop rule for a granted role. Unknown roles get no workshop grant.
 *
 * ⚠ `Object.prototype.hasOwnProperty.call` BEFORE the index, because `?? "FORBIDDEN"` cannot
 * do this job on its own: a prototype hit is not nullish, so the fail-closed default was
 * unreachable for an inherited key. Not `grantRow`, whose closed case is an empty ARRAY —
 * this table's values are strings, and the closed case here is the FORBIDDEN literal.
 */
function workshopPolicyFor(platformRole: string): WorkshopPolicy {
  if (!Object.prototype.hasOwnProperty.call(WORKSHOP_POLICY, platformRole)) {
    return "FORBIDDEN";
  }
  return WORKSHOP_POLICY[platformRole] ?? "FORBIDDEN";
}

/**
 * Why a FORBIDDEN role must not name a workshop, in the words an operator needs. Kept
 * per role because "platform-wide by definition" and "you see what you create" are
 * different facts, and an administrator who mis-sends one of these deserves the real
 * reason rather than a generic refusal they will read as a bug.
 */
const WORKSHOP_FORBIDDEN_REASON: Record<string, string> = {
  ADMIN: "an ADMIN's access is platform-wide already",
  FACILITATOR: "a FACILITATOR sees the workshops they create",
};

/**
 * Roles that may reach the user DIRECTORY — the Administration screen's population.
 *
 * A deliberate COPY of the keys of USER_ADMIN_GRANTS in
 * the shared constants/roles module (bundled Lambdas take no dep on that
 * package — same reason as ROLE_GRANTS above), and deliberately NOT canInvite():
 * canInvite is true for EXECUTIVE and JUDGE, who may bring people in but have no
 * business enumerating who exists. It is also NOT the STAFF_ROLES in authz.ts, which
 * answers a different question ("may you reach a team you don't belong to, in a
 * workshop you own"). The two sets happen to be equal today; keeping them separate is
 * what stops a change to one silently redefining the other.
 */
const USER_DIRECTORY_ROLES = new Set(["ADMIN", "FACILITATOR"]);

/** True if the role may look up directory context about OTHER users. */
function canReadDirectory(role: string): boolean {
  return USER_DIRECTORY_ROLES.has(role);
}

/**
 * WHICH ROLES A ROLE MAY KNOW ABOUT — the visibility matrix, for resolving an AUDIT
 * ACTOR's name.
 *
 * A deliberate COPY of USER_VISIBILITY_GRANTS in
 * the shared constants/roles module — bundled Lambdas take no dep on that package,
 * the same idiom as ROLE_GRANTS and USER_DIRECTORY_ROLES above. The identity service
 * enforces this matrix on the user directory; this copy enforces it on the one field in
 * this service that names another account, and routes.test.ts asserts the whole matrix so
 * the two cannot drift.
 *
 * DELIBERATELY NOT any of the three matrices already in this file. ROLE_GRANTS answers
 * "whom may I INVITE", USER_DIRECTORY_ROLES answers "may I browse the directory at all";
 * this answers "whom may I KNOW ABOUT", and conflating it with either would be wrong in
 * both directions — a FACILITATOR may grant FACILITATOR and may see one, an EXECUTIVE may
 * grant PARTICIPANT and may see nobody.
 *
 * ADMINS ARE INVISIBLE TO A FACILITATOR, and that cell is the reason this exists here.
 * Removals on this platform are performed by staff, and the platform's only ADMIN performs
 * most administrative acts — so resolving an actor's name unconditionally would print that
 * admin's name onto rows a facilitator is looking at, which is exactly the reconnaissance
 * identity's /admin/user-names was built to prevent (see its comment: knowing WHICH
 * accounts hold full platform access is itself the reconnaissance step).
 */
const USER_VISIBILITY_GRANTS: Record<string, readonly string[]> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: [],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * True if `actorRole` may learn the identity of an account whose role is `targetRole`.
 *
 * Fails CLOSED on either side being absent or unrecognised — which for a VISIBILITY rule
 * means an account of an unknown role is HIDDEN rather than shown. Mirrors canSeeUser in
 * @praimana/shared exactly, including that direction: if a new, more privileged role
 * is ever added and this table is not updated, it stays hidden until someone decides
 * otherwise. The opposite default would expose it the day it was created.
 */
function canSeeUser(
  callerRole: string | undefined,
  targetRole: string | undefined
): boolean {
  if (!callerRole || !targetRole) return false;
  // ⚠ Through `grantRow`: a plain index made this THROW a TypeError on an inherited key
  // (a function has no `.includes`), turning a refusal into a 500. See grantRow's note.
  return grantRow(USER_VISIBILITY_GRANTS, callerRole).includes(targetRole);
}

/**
 * Cap on how many FORMER MEMBERS one team's list may report.
 *
 * The list is a ROSTER VIEW, not a paginated log: it sits beside "Members (7)" on a team
 * page, and a team is tens of people whose removals are single digits per programme. 50
 * distinct people is far more than any real team will produce and still bounds both the
 * response size and the per-person read-model lookups below.
 *
 * `truncated` is REPORTED rather than the tail being silently dropped — a list that is
 * quietly short reads as "nobody else was removed", which on an audit-derived view is the
 * one wrong answer worth guarding against. The full per-person history remains at
 * GET /audit/users/:userId.
 */
const MAX_FORMER_MEMBERS = 50;

/**
 * How many audit entries to READ in order to build that list.
 *
 * Larger than MAX_FORMER_MEMBERS because entries are deduplicated per person afterwards:
 * someone removed, re-invited and removed again contributes several entries and one row.
 * 100 is the audit store's own clamp (see clampAuditLimit), so this asks for the most a
 * single Query will return and never silently pages.
 */
const FORMER_MEMBER_AUDIT_SCAN = 100;

/**
 * Cap on how many ids/emails one directory-context request may carry.
 *
 * Matches MAX_HYDRATE_IDS in the identity service, because the BFF drives both from
 * the SAME page of users — a mismatch would let one leg succeed while the other 400s,
 * and the page would render half its columns with no obvious cause.
 */
const MAX_CONTEXT_KEYS = 100;

/*
 * ⚠ `MAX_DIRECTORY_WORKSHOP_NAMES = 25` WAS HERE AND IS GONE, because the fan-out it capped is gone:
 * it bounded the ADMIN branch's per-workshop name probes, and an admin scoped to the workshops they
 * OWN gets every name back from `listOwnedWorkshops` in the same hop (see the note at its old call
 * site below). ROLES.md records it as dead code that should go, and it was the repo's only lint error
 * once linting was working again.
 *
 * ⚠ THE NUMBER MOVED RATHER THAN VANISHED. `resolveWorkshopNames` is deliberately retained on
 * `WorkshopDirectory` and does NOT cap itself — its own header says "the fan-out is bounded by the
 * CALLER" — so it is now an unbounded `Promise.all` over whatever a future caller passes. Deleting the
 * only recorded value of that bound would have left the next caller to invent one, so the 25 and its
 * reasoning now live on the method itself in workshop-directory.http.ts.
 */

/**
 * Cap on the `search` needle the TEAMS DIRECTORY accepts, in characters.
 *
 * Matches the BFF's own `z.string().trim().max(100)` on `admin.listUsers`, so a needle that
 * passes the form always fits here. It bounds what can be pushed into a store FilterExpression
 * from a URL: DynamoDB caps an expression at 4KB, and a pathological needle is the one input on
 * this route that a caller controls the SIZE of. TRUNCATED rather than refused — a search is a
 * convenience over a list that is reachable unfiltered, and 400-ing a long paste would be a
 * worse answer than matching its first 100 characters.
 */
const MAX_DIRECTORY_SEARCH = 100;

/**
 * Cap on how many WORKSHOP IDS the TEAMS DIRECTORY's authorization SCOPE may carry.
 *
 * THE OTHER HALF OF THE SAME 4KB BUDGET MAX_DIRECTORY_SEARCH above bounds, and it was the
 * unbounded one. The FACILITATOR scope became `workshopId IN (:w0 … :wN)` in a store
 * FilterExpression with no cap anywhere: `listOwnedWorkshops` returns whatever the Workshop
 * service sends and its `listByOwner` is an unbounded Query, so the ceiling was "how many
 * workshops has this person created". DynamoDB accepts at most 100 `IN` operands and caps a
 * whole expression at 4KB, and with 26-character ULIDs that arrives at 91 owned workshops WITH
 * a full-length needle and 98 without (measured in directory-security.test.ts). Past it the
 * facilitator's own directory is a hard 500, permanently, for the platform's most senior
 * users — and the search makes it worse, so a facilitator at 91-97 workshops has a directory
 * that works until they type in the search box.
 *
 * 50, matching `MAX_WORKSHOP_IDS` in GET /entitlements/workshops (declared inside that
 * handler, hence a sibling here rather than a shared import — the two are ONE rule, "how many
 * workshop ids may one response's scope carry", and must be changed together). Half of
 * DynamoDB's 100-operand limit, so the expression stays comfortably inside 4KB whatever the
 * needle is.
 *
 * TRUNCATION IS REPORTED as `scopeTruncated: true`, using the same idiom
 * /entitlements/workshops uses for its own cap. Not optional: a silently-capped scope is a
 * silently-short directory, which is the exact lie the 503 branch on this route exists to
 * prevent.
 */
const MAX_DIRECTORY_SCOPE_IDS = 50;

/**
 * How many DISTINCT workshops one invitation batch may NAME.
 *
 * This bounds an east-west fan-out sized by a request body, which is the specific
 * thing gate 4 below could otherwise introduce: each newly-named workshop costs one
 * ownership probe against the Workshop service, so an `invitees` array carrying a
 * thousand distinct ids would be a thousand hops from one request. The probes are
 * memoised per id AND issued sequentially rather than fanned out, so the worst case is
 * MAX_INVITE_WORKSHOPS × EAST_WEST_TIMEOUT_MS (4 × 800ms = 3.2s) — comfortably inside
 * the 29s gateway timeout, and bounded whatever the body says.
 *
 * FOUR because the real operation is "invite these judges to THIS workshop": the
 * portal's picker sends one workshop for the whole batch, so one is the expected count
 * and four is headroom for a hand-built `invitees` array. Raising it is a
 * load-shedding decision, not a tuning knob — it directly multiplies how long one
 * request can hold a Lambda while a dependency is slow.
 */
const MAX_INVITE_WORKSHOPS = 4;

/**
 * Cap on how many invitees ONE `POST /teams/:teamId/invitations` request may carry.
 *
 * ⚠ THE SIBLING CAP ABOVE BOUNDS DISTINCT WORKSHOPS, NOT PEOPLE, and the difference is the whole
 * reason this exists. `MAX_INVITE_WORKSHOPS` keeps the ownership PROBES bounded; a batch of 100,000
 * addresses all naming ONE workshop passes it untouched, because the probe is memoised per id. So the
 * request stayed authorization-cheap while the write stayed unbounded.
 *
 * 200 because the real operation is a roster paste — the portal's picker sends tens, and a facilitator
 * seeding a cohort by hand might reach three figures. Far above any legitimate use, far below a batch
 * that could throttle the invitations table that `cognito-presignup` reads on every registration.
 *
 * ⚠ THIS IS A LOAD-SHEDDING BOUND, NOT A TUNING KNOB. Raising it directly multiplies both the
 * concurrent writes one request can issue and the number of live registration grants it can mint in
 * one call — and at platform scope neither gate 2 nor gate 5 is there to catch the difference.
 */
const MAX_INVITEES_PER_REQUEST = 200;

/**
 * How many invitation rows are written CONCURRENTLY once the batch is accepted.
 *
 * A bare `Promise.all` over the whole batch issues every `PutItem` at once, so a request at the cap
 * arrives at DynamoDB as a 200-wide burst — the shape most likely to trip a throttle on a table whose
 * availability the registration path depends on. Writing in slices of 25 keeps the burst flat and
 * costs a few extra round-trips at the top of the range, which nobody notices on an invite action.
 *
 * 25 matches `BatchWriteItem`'s own per-call ceiling: not because this uses it, but because it is the
 * width AWS itself considers a reasonable single bite of this table.
 */
const INVITE_WRITE_CONCURRENCY = 25;

/**
 * One requested invitee, as the request body carries them. Hoisted to module scope so
 * the workshop resolver below can be typed against the same shape the route parses,
 * rather than re-declaring it and letting the two drift.
 *
 * `workshopId` is what the CLIENT asked for and is never trusted as-is: for a JUDGE it
 * is validated against the caller's entitlement, for a PARTICIPANT/EXECUTIVE it is
 * compared against the server-derived value and refused if it disagrees, and for an
 * ADMIN/FACILITATOR its presence is itself the error.
 */
interface Invitee {
  email: string;
  platformRole?: string;
  teamRole?: string;
  workshopId?: string;
}

/**
 * Gate 4's outcome: one resolved workshopId per invitee (positionally, so duplicate
 * addresses in a batch cannot collide), or the refusal to return verbatim.
 *
 * A discriminated result rather than a throw, because every branch here is a
 * deliberate 400/403 the caller needs the message of — an exception would have to be
 * caught and re-classified at the call site, which is where the status would drift.
 */
type WorkshopResolution =
  | { workshopIds: (string | undefined)[] }
  | { error: string; status: 400 | 403 };

/** Split a comma-separated query param into trimmed, non-empty values. */
function idList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Cap on the operator-supplied audit `reason`, in characters.
 *
 * 200, matching AUDIT_REASON_MAX in the shared types/audit module and the copy in
 * the user-access service — a bundled Lambda, same local-copy reason as ROLE_GRANTS
 * above. The portal's input is capped at the same number, so a reason that fits the form
 * always fits the row.
 *
 * TRUNCATED rather than refused: losing the tail of a note is a smaller loss than losing
 * the audit entry, and an operator's removal must not fail over the length of a comment.
 */
const AUDIT_REASON_MAX = 200;

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
 * Module-level so the pattern is compiled once rather than per removal. Safe to share
 * despite the `g` flag because `String#replace` resets `lastIndex` — nothing here calls
 * `.test`/`.exec` on it, which is what would carry state between requests.
 */
const AUDIT_REASON_CONTROL_RUN = /\p{C}+/gu;

/**
 * A stored audit `reason`, or undefined when there is nothing worth storing.
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
 * Measured and sliced in CODE POINTS. `.length`/`.slice` count a surrogate pair twice
 * and can cut one in half, which writes a lone surrogate into an append-only row that no
 * later write can repair — it renders as a replacement character in the trail forever.
 * Whitespace-only collapses to undefined so the row carries no attribute at all rather
 * than an empty string the UI would render as an empty "Reason:" line.
 *
 * ── CONVERGED WITH normalizeAuditReason in services/user-access/src/domain.ts ──
 *
 * The two write the SAME `praimana-audit` table and are behaviourally IDENTICAL: that
 * copy briefly diverged (it trimmed and capped but sanitised nothing) and has been brought
 * back in step, so a reader of the trail may assume EVERY `reason` on it is control-free
 * regardless of which service recorded the row. They remain separate copies for the same
 * reason AUDIT_REASON_MAX is copied — bundled Lambdas take no dependency on packages/shared
 * — so a change to the rule here belongs in both, and neither may be edited alone.
 */
function normalizeAuditReason(reason: unknown): string | undefined {
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

/**
 * The parsed JSON body, or undefined when there is none.
 *
 * For routes whose body is entirely OPTIONAL. `c.req.json()` REJECTS on an empty body,
 * and a DELETE with no body is the normal case for every caller this route already has —
 * so an unguarded parse would turn those into 500s. Returns undefined for a missing,
 * empty or unparseable body: the caller treats that as "the optional field is absent",
 * which is the only reading that keeps an optional field optional.
 *
 * Deliberately NOT used for routes with a REQUIRED body — those answer a 400 naming the
 * problem, and swallowing a parse failure there would hide a real client bug.
 */
async function readOptionalJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * CloudWatch namespace and metric name for the SEAT-LEDGER DRIFT signal.
 *
 * A namespace of this service's own rather than ACCESS_METRIC_NAMESPACE: that one answers "did
 * an access change go unrecorded?" and is shared with user-access because both write the same
 * audit table. This answers a completely different question about a completely different table,
 * and folding it in would make the access alarm fire on a bookkeeping problem.
 *
 * ⚠ MUST MATCH the Namespace/MetricName on any alarm watching it. A typo does not fail
 * anything — it means the alarm watches a metric nobody publishes and stays permanently OK.
 * NO ALARM IS DEFINED YET; see the follow-up in the report.
 */
const TEAM_METRIC_NAMESPACE = "Praimana/Teams";
const SEAT_LEDGER_DRIFT_METRIC = "SeatLedgerDrift";

/**
 * COMPARE the team row's `memberCount` against the roster we just counted, and emit 1 when
 * they disagree.
 *
 * ── WHAT THIS IS FOR, AND WHAT IT IS NOT FOR ──
 *
 * `memberCount` is NOT a cache that is expected to drift and be repaired — it IS the seat
 * ledger, and it only ever moves inside the same transaction as the membership row it counts.
 * So under the current code it CANNOT diverge by any interleaving. This metric exists to catch
 * exactly one thing: A FUTURE WRITE PATH THAT TOUCHES `team-members` WITHOUT GOING THROUGH THE
 * REPOSITORY.
 *
 * It will ALSO fire, legitimately and temporarily, for:
 *   - a team whose ledger has not been initialised yet (absent `memberCount` — SKIPPED below
 *     rather than reported, because absent is not drift, it is un-migrated);
 *   - a removal whose ledger decrement was refused (the repository logs that case and this
 *     confirms it).
 *
 * ── ABSENT IS SKIPPED, NOT REPORTED AS DRIFT ──
 *
 * A row with no `memberCount` is a legacy row awaiting the backfill, which is a KNOWN state
 * with a KNOWN remedy — reporting it as drift would fire the metric for all three live teams on
 * the first roster read and train everyone to ignore it. `admit()` initialises such a row on
 * first join, and the backfill script closes the rest.
 *
 * ── EMITS 0 ON AGREEMENT ──
 *
 * So the metric EXISTS in a healthy account. Without it "no data" and "no drift" are identical
 * at the alarm, and a deploy that broke the emission entirely would read as a permanently
 * healthy platform. Same reasoning, and same precedent, as emitAccessAuditMetric's 0.
 *
 * NEVER THROWS and never awaits — `emitMetric` swallows, by contract, because this sits inside
 * a roster read that must not fail over a bookkeeping observation. IDS ONLY in the properties;
 * the counts are numbers, not dimensions (an unbounded dimension is disallowed as a metric dimension).
 */
function reportSeatLedgerDrift(
  team: { id: string; workshopId: string; memberCount?: number },
  rosterCount: number
): void {
  // Un-migrated, not drifted. See the note above.
  if (typeof team.memberCount !== "number") return;

  const drifted = team.memberCount !== rosterCount;
  if (drifted) {
    console.warn(
      "[team] SEAT LEDGER DRIFT — the team's memberCount disagrees with its roster",
      {
        metric: SEAT_LEDGER_DRIFT_METRIC,
        teamId: team.id,
        workshopId: team.workshopId,
        memberCount: team.memberCount,
        rosterCount,
      }
    );
  }
  emitMetric({
    namespace: TEAM_METRIC_NAMESPACE,
    name: SEAT_LEDGER_DRIFT_METRIC,
    value: drifted ? 1 : 0,
    properties: {
      teamId: team.id,
      memberCount: team.memberCount,
      rosterCount,
      event: drifted
        ? "seat ledger DRIFTED — a writer bypassed the repository, or a decrement was refused"
        : "seat ledger agrees with the roster",
    },
    source: "team",
  });
}
import type {
  TeamRepository,
  TeamMemberRepository,
  InvitationRepository,
  UsersReadModel,
  AuditEntryRead,
} from "./domain.js";
import {
  isAcceptedInvitation,
  isInactiveMembership,
  isRevokedInvitation,
  isSpentInvitation,
  MEMBERSHIP_ACTIVE,
  MEMBERSHIP_INACTIVE,
} from "./domain.js";
import {
  hashInviteToken,
  inviteExpiry,
  isExpired,
  mintInviteToken,
} from "./invite-token.js";
import {
  canRead,
  canReadTeamContent,
  canWrite,
  canWriteTeamContent,
  isStaffRole,
  mayHoldTeamMembership,
  requireTeamAdministration,
  requireTeamRead,
  requireTeamWrite,
  type WorkshopAccess,
  type WorkshopDirectory,
} from "./authz.js";

/**
 * Team service routes. Note the constructor-style dependency injection: the routes
 * depend on INTERFACES (TeamRepository, TeamMemberRepository, InvitationRepository,
 * WorkshopAccess, UsersReadModel, EventPublisher) passed in, never on concrete
 * DynamoDB/HTTP classes. This is the Dependency Inversion seam — wiring lives in
 * app.ts, and tests pass in-memory fakes.
 *
 * Mounted under basePath /v1 so it is a drop-in for the monolith's /v1/teams/*,
 * /v1/workshops/:id/teams and /v1/teams/:id/invitations routes (strangler-fig).
 */
export interface TeamDeps {
  teams: TeamRepository;
  members: TeamMemberRepository;
  invitations: InvitationRepository;
  workshops: WorkshopAccess;
  users: UsersReadModel;
  events: EventPublisher;
  /** Append-only record of who removed whom, and who changed whose access. */
  audit: AuditRepository;
  /**
   * Workshop-context reads the TEAMS DIRECTORY needs — the caller's owned workshops (its
   * authorization SCOPE) and workshop names (display). A SEPARATE port from `workshops`
   * above; see WorkshopDirectory in authz.ts for why the two are not one interface.
   */
  workshopDirectory: WorkshopDirectory;
  /**
   * The bulk-upload audit trail. OPTIONAL, and that is a deployment fact rather than a preference:
   * bulk provisioning is gated behind `EnableBulkProvision`, so an environment without it has no
   * table to write to. Absent ⇒ the accept path refuses rather than running a job it cannot record.
   */
  bulkBatches?: BulkBatchRepository;
}

export function createTeamRoutes(deps: TeamDeps) {
  const team = new Hono().basePath("/v1");

  // Paths that authenticate on their OWN credential instead of a caller identity.
  //
  // /invitations/lookup-by-token is reached by an anonymous visitor who just
  // clicked an emailed invite link: they have no account yet (that's the point of
  // the link), so there is no token to present and requiring one would make the
  // route unusable. Its credential is the 256-bit invite token in the query — the
  // route returns data ONLY to someone already holding it, and 404s otherwise.
  // Everything it discloses is about the invitation that token names, which the
  // holder was emailed anyway.
  const PUBLIC_PATHS = new Set(["/v1/invitations/lookup-by-token"]);

  // Every other request must carry a gateway-injected identity (authN at edge).
  // Skipping is keyed on the resolved path (not registration order) so adding
  // routes above or below this line can't silently change who is authenticated.
  const requireAuth = edgeIdentityMiddleware();
  team.use("*", async (c, next) => {
    if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) return next();
    return requireAuth(c, next);
  });

  // Load a team's LIVE members, each enriched with the user's name/email. The names
  // come from the LOCAL users read-model (event-synced from Identity), NOT a
  // cross-service read of the users table — that's the whole point of the service boundary.
  //
  // `withEmail` is the data-minimisation switch, defaulted to the SAFE value so a
  // future caller that forgets the argument discloses less rather than more. Email
  // is the only PII in this projection; see the roster route below for who gets it.
  //
  // ── ENUMERATED, NEVER SPREAD. THIS USED TO BE `...m`, AND THAT WAS THE BUG. ──
  //
  // A SPREAD IS AN ALLOWLIST THAT SILENTLY GROWS. This projection was written when a membership
  // row held four attributes, and it kept emitting whatever the row grew into — no edit here,
  // nothing to review. The row has since gained the removal and REACTIVATION breadcrumbs, two of
  // which (`removedBy`, `reactivatedBy`) are raw Cognito subs of the OPERATORS who acted.
  //
  // Why `listByTeam` did NOT save it, which is what made this look narrower than it was: an
  // INACTIVE row is refused at the repository, so a removed member never reaches here. But
  // REACTIVATION flips `status` back to ACTIVE and deliberately does NOT clear the breadcrumb
  // (domain.ts: the row says "restored then removed again", and `status` is the only field that
  // says what holds NOW). So a RESTORED membership is ACTIVE, passes the repository filter, and
  // arrived here still carrying `removedAt`/`removedBy`/`removedByRole`/`reactivatedBy`.
  //
  // THE AUDIENCE IS THE WIDEST OF THE TWO LEAKS. The one caller is the `?withMembers=1` fan-out
  // below, and its member-filtered branch admits any PARTICIPANT on a team in the workshop — so a
  // participant on a team with ONE restored member could read the subs of the operators who
  // removed and restored them. Unlike the roster's version of this defect there was no visibility
  // gate being contradicted, because this route applies none at all.
  //
  // THE FIX IS OMISSION, NOT A GATE. This projection serves the LIVE ROSTER: no removal history
  // belongs in it in any form, for any caller, so there is nothing to decide per-caller and no
  // `callerRole` is threaded in. `removedAt`, `removedBy`, `removedByRole`, `reactivatedAt` and
  // `reactivatedBy` are ABSENT — an absent key discloses nothing, not even that something is
  // being withheld. The surface that legitimately shows removal history is
  // GET /teams/:teamId/members (see `loadTeamMembersIncludingInactive`), where it IS gated, and
  // the authoritative record is the audit trail.
  async function loadTeamMembers(teamId: string, withEmail = false) {
    const members = await deps.members.listByTeam(teamId);
    if (members.length === 0) return [];

    return Promise.all(
      members.map(async (m) => {
        const user = await deps.users.get(m.userId);
        return {
          // Every field this response emits is listed. A future attribute on TeamMember reaches
          // the fan-out only when someone adds it HERE and states why a live roster needs it.
          teamId: m.teamId,
          userId: m.userId,
          role: m.role,
          joinedAt: m.joinedAt,
          /**
           * ALWAYS THE SAME VALUE ON THIS PATH, and emitted anyway for two reasons.
           *
           * `listByTeam` returns active rows only, so this is ACTIVE for every row here. It is
           * kept because it crosses a service boundary and no consumer should have a field
           * disappear from under it — grepped, and no reader of the `?withMembers=1` payload
           * branches on it today (the portal reads `userId`, `role` and `user`), so this is
           * belt-and-braces rather than a requirement.
           *
           * NORMALISED rather than passed through, and that is the security-relevant half: a
           * never-removed row carries NO status attribute while a RESTORED one carries the
           * literal "ACTIVE", so forwarding `m.status` made the mere PRESENCE of the key a
           * removal breadcrumb — the same disclosure in a subtler form. Derived through the
           * shared `isInactiveMembership` rather than hardcoded to ACTIVE so it still tells the
           * truth if the repository's active-only guarantee ever regresses, and so there is no
           * second local copy of what INACTIVE means.
           */
          status: isInactiveMembership(m.status)
            ? MEMBERSHIP_INACTIVE
            : MEMBERSHIP_ACTIVE,
          user: {
            id: m.userId,
            name: user?.name || "Unknown",
            // Spread-or-omit rather than `email: undefined`: this object is
            // JSON.stringify'd into the response, and an explicit undefined would
            // vanish anyway — but omitting it at the source means the address is
            // never read out of the read-model on a path not entitled to it.
            ...(withEmail ? { email: user?.email } : {}),
          },
        };
      })
    );
  }

  /**
   * The team's roster INCLUDING DEACTIVATED members, each carrying its removal metadata —
   * the FROZEN CONTRACT for `trpc.team.listMembers`.
   *
   * A SEPARATE function from `loadTeamMembers` above rather than a flag on it, and that is
   * the safer shape by construction: `loadTeamMembers` has three other callers (the
   * `?withMembers=1` fan-out and both roster branches) which all want the LIVE team and all
   * derive `_count.members` from its length. A boolean parameter would put "should this
   * include people who are not members?" one forgotten argument away from inflating every
   * member count on the platform — the same reasoning as the repository naming its dangerous
   * reads explicitly instead of taking an `includeInactive` flag.
   *
   * ── `removedByName` IS VISIBILITY-GATED, ON THE SAME MATRIX AS former-members ──
   *
   * Decided from `removedByRole`, which the ROW stores as the role AT THE TIME — so it costs
   * no lookup and cannot be answered from a directory that has since changed. A FACILITATOR
   * reading this roster must not learn an ADMIN's name: removals are performed by staff and
   * this platform's only ADMIN performs most administrative acts, so resolving the actor
   * unconditionally would print that name onto rows a facilitator is looking at — exactly the
   * reconnaissance USER_VISIBILITY_GRANTS exists to prevent. `null` means "not shown to you",
   * as identity's /admin/user-names reports `hidden: true`.
   *
   * The ROLE is disclosed even when the NAME is not, for the same reason former-members
   * discloses it: "removed by a Facilitator" names no account, and suppressing it would leave a
   * row that says a removal happened and refuses to say by whom in any form.
   *
   * ── THE ROW IS ENUMERATED, NEVER SPREAD, AND THAT IS A SECURITY RULE ──
   *
   * The projection below lists every field it emits. It used to `{ ...m }` and that is exactly
   * how the gate above came to be defeated in the payload it applied to — see the note at the
   * return statement. THE RULE: this function must never spread a stored row, because a spread
   * is an allowlist that grows silently and a membership row accumulates operator identifiers.
   *
   * BOUNDED by the roster itself — a team is tens of people — and the per-actor lookup is
   * MEMOISED across the roster, because one operator typically removed everybody and the
   * unmemoised version was one read-model Get per inactive member.
   */
  async function loadTeamMembersIncludingInactive(
    teamId: string,
    callerRole: string,
    withEmail = false
  ) {
    const members = await deps.members.listByTeamIncludingInactive(teamId);
    if (members.length === 0) return [];

    // Request-scoped: this Map dies with the request, so there is no cross-request cache to
    // bound or evict. Keyed on the actor's sub, so a roster where one facilitator removed six
    // people costs one lookup rather than six.
    const actorNames = new Map<string, string | null>();
    const actorName = async (actorId: string): Promise<string | null> => {
      const memoised = actorNames.get(actorId);
      if (memoised !== undefined) return memoised;
      // Best-effort: an actor whose read-model row is missing (a staff account deleted since)
      // resolves to null, which the UI renders as unknown. It must not drop the member.
      const resolved =
        (await deps.users.get(actorId).catch(() => null))?.name ?? null;
      actorNames.set(actorId, resolved);
      return resolved;
    };

    return Promise.all(
      members.map(async (m) => {
        const user = await deps.users.get(m.userId).catch(() => null);
        const inactive = isInactiveMembership(m.status);

        // Resolved ONLY for an inactive row and ONLY when the matrix permits it, so an active
        // member's row makes no extra lookup and a hidden actor is never read at all.
        const actorVisible =
          inactive && !!m.removedBy && canSeeUser(callerRole, m.removedByRole);

        return {
          // ── ENUMERATED, NEVER SPREAD. `...m` WAS THE BUG. ──
          //
          // A SPREAD IS AN ALLOWLIST THAT SILENTLY GROWS. This projection was written when a
          // membership row held four attributes; the row has since gained TWO OPERATOR
          // IDENTIFIERS — `removedBy` and `reactivatedBy`, both raw Cognito subs — and a
          // spread admitted each of them to this response the moment it was added to the
          // stored shape, with no edit here and nothing to review. The gate on the DERIVED
          // `removedByName` was therefore defeated inside the very object it applied to: a
          // FACILITATOR reading an ADMIN's removal was refused the name and handed the sub
          // beside it, which is the correlatable identifier USER_VISIBILITY_GRANTS exists to
          // withhold.
          //
          // So every field is listed. A future attribute on TeamMember reaches this response
          // only when someone adds it HERE and states why the roster needs it — the same
          // field-by-field construction GET /teams/:teamId/former-members has always used,
          // which is why that route never had this defect.
          teamId: m.teamId,
          userId: m.userId,
          /** The PRESERVED team role — survives a removal, which is what reactivation restores. */
          role: m.role,
          joinedAt: m.joinedAt,
          /**
           * ALWAYS PRESENT AND NEVER ABSENT, even though the stored attribute is optional:
           * the frozen contract types it `"ACTIVE" | "INACTIVE"`, and every row written before
           * the field existed carries no attribute. Normalising here means the client branches
           * on a closed union rather than on a possibly-undefined string — and it means an
           * absent status renders as ACTIVE, which is what it means.
           */
          status: inactive ? MEMBERSHIP_INACTIVE : MEMBERSHIP_ACTIVE,
          /** Null on an active member — there is no removal to date. */
          removedAt: inactive ? (m.removedAt ?? null) : null,
          /** Null when not visible to THIS caller, or when the actor has no read-model row. */
          removedByName: actorVisible ? await actorName(m.removedBy!) : null,
          /** The actor's role AT THE TIME. Disclosed even when the name is not. */
          removedByRole: inactive ? (m.removedByRole ?? null) : null,
          /**
           * THE REMOVING OPERATOR'S SUB, CARRIED ONLY WHEN THE CALLER MAY SEE THAT ACCOUNT.
           *
           * Gated on the SAME `actorVisible` computed above — reused rather than recomputed, so
           * the identifier and the name can never disagree about who is visible. The field is
           * OMITTED (spread-or-nothing) rather than sent as null, for the reason `withEmail` is
           * on the user projection: an absent key cannot be mistaken for a value, and a caller
           * who is not entitled to the account learns nothing about whether one is being
           * withheld from this row versus absent from the store.
           *
           * Present at all because the portal's Reactivate flow and an operator triaging a
           * removal legitimately correlate the actor across surfaces — but only for a caller
           * already permitted the actor's identity.
           */
          ...(actorVisible ? { removedBy: m.removedBy } : {}),
          /**
           * WHEN the membership was last restored. A TIMESTAMP, not an identifier: it names no
           * account, so it needs no visibility gate and every caller gets it.
           *
           * Spread-or-omit, which reproduces EXACTLY what the old spread emitted — present on a
           * row that has been restored, absent on one that never was. Deliberately NOT normalised
           * to `null` like `removedAt` above: that would add a key to every row of a frozen
           * contract, and this projection's job today is to stop shipping two fields, not to
           * start shipping a third.
           */
          ...(m.reactivatedAt ? { reactivatedAt: m.reactivatedAt } : {}),
          //
          // `reactivatedBy` IS DELIBERATELY ABSENT FROM THIS PROJECTION.
          //
          // It is the restoring operator's raw sub, and unlike `removedBy` it CANNOT be gated:
          // there is deliberately no `reactivatedByRole` on the row (see domain.ts — "no surface
          // renders it"), so there is no stored historical role to decide visibility from, and
          // deriving one from today's directory would answer a historical question with current
          // data. This route is reachable by any MEMBER of the team, so an ungated sub here was
          // disclosed to PARTICIPANTS — the widest audience of the two leaks.
          //
          // Omitted rather than gated because nothing consumes it: grepped across the portal
          // and desktop (the tRPC roster mapper, the team page, the desktop BoardView) and
          // no reader references the field. The authoritative record of WHO restored a
          // membership is the MEMBER_RESTORED audit entry, which carries the actor AND their
          // role at the time and is gated by GET /audit/users/:userId's directory check.
          user: {
            id: m.userId,
            name: user?.name || "Unknown",
            ...(withEmail ? { email: user?.email } : {}),
          },
        };
      })
    );
  }

  // Teams the authenticated user has already joined. Backs the desktop "My Teams"
  // view: if this returns teams, show them with a Join button on top; otherwise
  // the desktop falls back to the invite-code join screen.
  /**
   * THE CALLER'S ENTITLED WORKSHOP IDS — `E(self)`.
   *
   * Backs `GET /v1/workshops` for JUDGE / EXECUTIVE / PARTICIPANT, who own no workshop
   * row and therefore got an EMPTY LIST from the Workshop service's
   * `listByOwner(id)`. The reported bug was an EXECUTIVE signing in and seeing no
   * experiences at all.
   *
   * WHY THIS LIVES HERE. `E(self)` is the union of two facts and Team owns both:
   * invitations naming a workshop (`invitations`/`email-index`) and workshops reached
   * through team membership (`team-members`/`userId-index` → `teams`/`id-index`).
   * Workshop must not read those tables, so it asks the context that owns them and
   * resolves the rows itself. The Workshop-local
   * projection cannot answer a LIST at all.
   *
   * NO REQUEST PARAMETERS, deliberately — not a `userId`, not an `email`, not a
   * filter. Both halves key on the caller's own VERIFIED claims, so there is nothing
   * to tamper with and no way to enumerate another subject's entitlements. Same
   * property as /teams/mine and /invitations/mine.
   *
   * ── THE FAILURE SEMANTICS ARE THE POINT ──
   * "Could not determine" must never be returned as "you have none". Answering 200
   * with an empty list when a lookup failed is precisely the defect class to avoid:
   * a fail-closed catch reported an infrastructure fault as an
   * authorization answer. So every undetermined case is a 503 the caller can retry:
   *
   *   - EITHER half throws            → 503 (no partial unions)
   *   - the email claim is absent      → 503, NOT an empty invitation half
   *
   * That email case is not theoretical. The invitation half keys on `email` while the
   * membership half keys on `sub`, and the trusted-internal-hop path can produce
   * `email: ""`. A JUDGE is invitation-only (WORKSHOP_POLICY.JUDGE = "REQUIRED", and
   * they are never a team member), so an empty email claim would make BOTH halves
   * return nothing and the union look like a definite "no workshops".
   */
  team.get("/entitlements/workshops", async (c) => {
    const { id, email } = requireIdentity(c);

    // Undetermined, not empty. See the note above: for an invitation-only role this
    // would otherwise be indistinguishable from a real answer.
    if (!email) {
      console.warn("[team] entitlements: no email claim — cannot resolve invitations", {
        userId: id,
      });
      return c.json(
        {
          error: "Entitlements cannot be determined for this session.",
          code: "ENTITLEMENTS_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // BOUNDS: ≤25 memberships resolved to teams, ≤50 distinct workshop ids.
    // `truncated` is reported rather than silently dropping the tail — a list that is
    // quietly short reads as "you are not in that workshop".
    const MAX_MEMBERSHIPS = 25;
    const MAX_WORKSHOP_IDS = 50;

    let invitations;
    let memberships;
    try {
      // Both halves in parallel: they are independent single-partition Queries on
      // indexes that already exist (no new GSI).
      [invitations, memberships] = await Promise.all([
        deps.invitations.listByEmail(email.toLowerCase()),
        deps.members.listByUser(id),
      ]);
    } catch (err) {
      console.error("[team] entitlements: a half failed — refusing a partial union", {
        userId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        {
          error: "Entitlements cannot be determined right now.",
          code: "ENTITLEMENTS_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // ── Half 1: workshops named directly on an invitation ──
    // `inv.workshopId` and NOT the invitation's team's workshop: the granted workshop
    // is what the row says. A JUDGE's row has workshopId with a PLATFORM teamId, so
    // filtering platform-scoped rows out here (as /invitations/mine does, for its own
    // good reasons) would drop the ONLY entitlement a judge has.
    //
    // ⚠ A WITHDRAWN OR LAPSED GRANT GRANTS NOTHING, and the absence of this filter was a
    // live authorization defect: this route used to add `inv.workshopId` from ANY row,
    // whatever its status. So a REVOKED invitation still returned its workshop — and
    // `DELETE /teams/:teamId/members/:userId` calls `markRevoked` precisely to withdraw
    // that grant, which means removing someone handed their workshop straight back.
    //
    // The same predicate pair every OTHER reader of this table already applies — see
    // /invitations/lookup-by-email below, the pre-signup trigger's isInvited, and
    // user-access's resolveRoleFromInvitations / liveInvitationKeys. This route was the one
    // reader that did not, which is the shape of bug that survives review: the rule was
    // never in dispute, it was just missing from one place.
    //
    // ACCEPTED ROWS STILL COUNT, and that is not an oversight. A row is ACCEPTED the moment
    // its holder first signs in, so excluding them would revoke every registered judge's
    // entitlement. PENDING rows count too: a newly-invited judge must see
    // the workshop BEFORE they redeem, so an ACCEPTED-only allowlist would break the grant
    // it exists to deliver. The filter is on the two TERMINAL states, never an allowlist of
    // the live ones — a new status added later must not silently start granting access.
    const ids = new Set<string>();
    for (const inv of invitations) {
      if (isRevokedInvitation(inv.status) || isExpired(inv.expiresAt)) continue;
      if (typeof inv.workshopId === "string" && inv.workshopId) {
        ids.add(inv.workshopId);
      }
    }

    // ── Half 2: workshops reached through team membership ──
    // teamMembers stores only teamId, so each is resolved to its team to read
    // workshopId (the teams table's partition key). Bounded, and a failure here is
    // still "undetermined" rather than a short answer.
    const capped = memberships.slice(0, MAX_MEMBERSHIPS);
    let truncated = memberships.length > MAX_MEMBERSHIPS;
    try {
      const teams = await Promise.all(capped.map((m) => deps.teams.getById(m.teamId)));
      for (const t of teams) {
        // A dangling membership (team deleted) contributes nothing and is not an error.
        if (t?.workshopId) ids.add(t.workshopId);
      }
    } catch (err) {
      console.error("[team] entitlements: membership resolution failed", {
        userId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        {
          error: "Entitlements cannot be determined right now.",
          code: "ENTITLEMENTS_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // Deduped by the Set above BEFORE the cap, so an executive on two teams in one
    // workshop plus an invitation naming it counts once and does not eat the budget.
    let workshopIds = [...ids];
    if (workshopIds.length > MAX_WORKSHOP_IDS) {
      workshopIds = workshopIds.slice(0, MAX_WORKSHOP_IDS);
      truncated = true;
    }

    if (truncated) {
      console.warn("[team] entitlements: result truncated", {
        userId: id,
        returned: workshopIds.length,
        memberships: memberships.length,
      });
    }

    return c.json({ workshopIds, truncated });
  });

  team.get("/teams/mine", async (c) => {
    const { id } = requireIdentity(c);

    const memberships = await deps.members.listByUser(id);
    if (memberships.length === 0) {
      return c.json({ teams: [] });
    }

    // teamMembers only stores teamId (not the workshopId sort key), so resolve
    // each team by id. Hackathon scale: a handful of teams.
    const teams = await Promise.all(
      memberships.map(async (m) => {
        const teamItem = await deps.teams.getById(m.teamId);
        if (!teamItem) return null;
        return { ...teamItem, role: m.role, joinedAt: m.joinedAt };
      })
    );

    return c.json({ teams: teams.filter(Boolean) });
  });

  /**
   * THE TEAMS DIRECTORY — every team the caller may enumerate, paginated and searchable.
   *
   * Owner: *"show teams like how we are showing users in administration with search and
   * list"*. Deliberately shaped as the mirror image of identity's `GET /v1/admin/users`:
   * `limit`, `cursor`, `search`, one page plus an opaque `nextCursor`. Same screen, different
   * noun, so it pages and searches identically.
   *
   * WHY IT HAS TO EXIST. There was no cross-workshop teams list at all:
   * `GET /workshops/:workshopId/teams` is one partition and `/teams/mine` is the caller's own
   * memberships. An operator asking "which team is X on?" had to already know the workshop.
   *
   * ── DECISION 1 — AUTHORIZATION: THE DIRECTORY ROLES, THEN THE OWNED-WORKSHOP SCOPE ──
   *
   * `canReadDirectory` (ADMIN + FACILITATOR) is the coarse gate, the SAME set that already
   * gates `/directory/user-ids` and `/directory/invited-by` and that identity's `canManageUsers`
   * admits for the users directory. Then, per role:
   *
   *   ADMIN        ⚠ ONLY teams in workshops they OWN, exactly like a FACILITATOR, AND THIS ROW
   *                USED TO SAY THE OPPOSITE. It read: every team, with no scope
   *                restriction and no hop for it. Both halves are now wrong — there IS a scope
   *                restriction and it DOES cost the hop (`listOwnedWorkshops`), which is why
   *                `scopeTruncated` below is reachable for an admin. The admin-scoping rule
   *                (an admin sees no other experience's teams, scores or anything else) supersedes that
   *                earlier line, and ROLES.md records the contradiction rather than hiding it. An admin
   *                who CREATED an experience still sees its teams — they are its owner.
   *   FACILITATOR  ONLY teams in workshops they OWN. The owner-scope rule again:
   *                a facilitator sees the workshops they created, not those other facilitators
   *                created — the row for FACILITATOR reads `all teams iff owner` for
   *                `/:id/teams`, and a cross-workshop list is that rule applied to every
   *                workshop rather than one. Following the established rule rather than inventing one:
   *                without it this route is a CROSS-TENANT LEAK, handing one facilitator every
   *                other facilitator's team names and sizes.
   *   anyone else  403. NOT a filtered list, which is where this deliberately diverges from
   *                `/workshops/:workshopId/teams` — that route answers a PARTICIPANT with
   *                "the teams you are on" because that is a truthful, narrower answer the
   *                portal consumes. Here there is no narrower reading to give: "the teams you
   *                are on" is already `/teams/mine`, and answering it twice in two shapes is
   *                how two views drift. So this matches `/audit/users/:userId` and both
   *                `/directory/*` routes: a role that cannot browse a directory is refused it.
   *
   * THE SCOPE IS APPLIED IN THE REPOSITORY, not here — `listDirectory({ workshopIds })`. Same
   * reasoning identity states for `visibleRoles`: the only method able to enumerate teams is
   * also the one that applies the restriction, so a future route cannot forget it. An empty
   * scope returns nothing rather than everything (see the repository).
   *
   * AN OWNER'S SCOPE IS UNDETERMINABLE ⇒ 503, NEVER AN EMPTY DIRECTORY. The scope comes
   * from a hop, and "we could not ask" returned as "you own no workshops" is the same lie as
   * the 403 that said "not the owner" when a probe had timed out — it would render a
   * plausible, empty, wrong page. The failure-semantics rule, applied here.
   *
   * ⚠ "AN OWNER'S", NOT "A FACILITATOR'S", WHICH IS WHAT THIS SAID. An ADMIN now takes
   * the same `listOwnedWorkshops` hop, so the 503 branch is theirs too — an admin's directory now
   * depends on the Workshop service being reachable, where it used to need no hop at all. That is a
   * real cost of the scoping and ROLES.md lists it as one; scoping the sentence to facilitators
   * implied an admin could never be the caller who gets this 503.
   *
   * ── DECISION 2 — SEARCH SCOPE: TEAM NAME, IN THE STORE ──
   *
   * Matched in the STORE so it finds teams on any page rather than only the one in hand.
   * Identity wrote the reason down and it transfers unchanged: filtering the loaded page in the
   * browser silently misses everyone past page 1, which is tolerable when skimming and wrong
   * precisely when the reason you are searching is to act on something specific. ANDed with the
   * workshop scope in the repository, so search can never widen what the scope allows.
   *
   * TEAM NAME ONLY. The workshop's NAME is the Workshop context's data — this table stores only
   * `workshopId` — so matching on it would mean denormalising a name this service does not own,
   * or resolving names before filtering, which cannot be a store filter and so would break
   * pagination. Workshop names are resolved for the rows RETURNED (display), and a caller who
   * wants one workshop's teams has `/workshops/:workshopId/teams`. DynamoDB's `contains` is
   * case-SENSITIVE with no `lower()`; the repository carries the same two-form workaround
   * identity already uses rather than repeating the problem.
   *
   * ── DECISION 3 — PAGINATION: A BOUNDED SCAN, AND THE BOUND IS REPORTED ──
   *
   * A Scan, stated plainly: `teams` is (workshopId HASH, id RANGE) with two point-lookup GSIs,
   * so there is no index-backed way to enumerate across workshops. An earlier design review
   * against a constant-partition GSI for the identical ADMIN workshops list — it funnels every
   * create through one index partition and duplicates the table, for an ordering nothing
   * needs — applies verbatim here.
   *
   * ⚠ AND AN EARLIER DESIGN NOTE WAS AGAINST THIS ROUTE EXISTING AT ALL: *"a global teams Scan would
   * be a second enumeration surface for no new capability"*. Noted rather than omitted, because
   * a note that quotes the supporting clause and drops the contradicting one is worse than
   * none. It is SUPERSEDED for this cross-workshop READ: the platform now needs
   * a capability the drill-down cannot provide — cross-workshop search, and answering
   * "which team is X on?" without already knowing the workshop, which is the answer being
   * looked for. §D#4's other decisions stand.
   *
   * Bounded at MAX_DIRECTORY_SCAN_ROUND_TRIPS × (limit + 1) rows per request, never the table.
   * REVISIT AT 5,000 TEAMS — the volume trip-wire, which binds SOONER here than it
   * does on `workshops`: one workshop holds many teams, so `teams` is the strictly LARGER of
   * the two (an earlier version of this comment said "strictly smaller", which was backwards).
   * NOT on a p99: the inherited latency trip-wire is replaced with `ScannedCount /
   * Count` over 10:1 and "hit the trip cap with LastEvaluatedKey still set", because this
   * route's cost does not grow with the table — its COMPLETENESS does — and its p99.9 is
   * dominated by a 2500ms east-west timeout rather than by the Scan. At those trip-wires the
   * GSI becomes the better trade. Hitting the round-trip cap hands back a CURSOR rather than
   * silently truncating, so a short page is honestly short and "Next" is live — including when
   * the page came back EMPTY, which the repository covers by falling back to the scan's own
   * LastEvaluatedKey (there is no returned row to derive a cursor from in that state).
   *
   * ── WHAT EACH ROW CARRIES, AND WHY NO SECOND CALL PER ROW ──
   *
   * Team name, workshop id + name, MEMBER COUNT and created date. The count comes from
   * `listByTeam` — the repository read that OMITS inactive rows — so a removed person is not
   * counted. Deliberately not a hand-rolled status filter here: the default read already
   * refuses deactivated rows at every one of its call sites, and re-implementing the rule on
   * this route is how the two drift into disagreeing about what a roster is.
   */
  team.get("/teams/directory", async (c) => {
    const { id: callerId, role } = requireIdentity(c);

    if (!canReadDirectory(role)) {
      return c.json(
        { error: "Forbidden: your role cannot browse the teams directory" },
        403
      );
    }

    // ── The authorization SCOPE, resolved before any store read ────────────────
    //
    // THE IDS OF THE WORKSHOPS THE CALLER OWNS — for an ADMIN exactly as for a FACILITATOR.
    //
    // ⚠ THE `role !== "ADMIN"` GUARD THAT USED TO WRAP THIS BLOCK WAS THE WIDEST ADMIN GRANT ON
    // THE PLATFORM, AND IT IS GONE. An ADMIN skipped the scope entirely and left
    // `workshopIds` UNDEFINED, which the repository reads as "no restriction" — so the teams
    // directory returned EVERY team on the platform, in every experience, owned by anyone. That
    // is the one shape the admin-scoping rule refuses: an admin is scoped to the experiences they
    // OWN. Both roles now take the same path, and `undefined` is no longer reachable here (the
    // repository still honours it, so nothing downstream needed changing).
    //
    // ⚠ THE CYCLE ARGUMENT SURVIVES THE CHANGE, and it is worth re-stating because it used to
    // rest on ADMIN not making this hop at all: `GET /v1/workshops` answers ADMIN and FACILITATOR
    // from `listByOwner` with NO hop of its own, and only JUDGE/EXECUTIVE/PARTICIPANT call back
    // into Team for E(self). Those three are 403'd above by `canReadDirectory`, so Team → Workshop
    // → Team is still unreachable from here — now because of what the CALLEE does for both owner
    // roles rather than because one of them skipped the call.
    let workshopIds: string[] | undefined;
    // The name map comes free with the scope — the same hop returns id AND name, so the page
    // makes no second east-west call. True for an ADMIN too now, which is why the separate
    // ADMIN name fan-out that used to sit below this block is gone.
    let workshopNames: Record<string, string> = {};
    // TRUE when the scope was capped, so the page below is scoped to only SOME of the caller's
    // workshops. Reported in the body — see MAX_DIRECTORY_SCOPE_IDS for why silence here would
    // be the same lie the 503 branch above exists to prevent. ⚠ Now reachable for an ADMIN as
    // well: an admin who owns more than the cap gets a SHORT page, where before they got every
    // team unscoped. That is a narrowing, and the flag is what stops it being a silent one.
    let scopeTruncated = false;

    {
      const owned = await deps.workshopDirectory.listOwnedWorkshops(callerId, role, c);
      if (owned === "unavailable") {
        // 503 and not an empty list. See the header: an empty directory is indistinguishable
        // from a correct one, so "undetermined" must not be rendered as an answer.
        console.warn("[team] teams directory: owned-workshop scope unavailable — 503, not empty", {
          userId: callerId,
          role,
        });
        return c.json(
          {
            error:
              "The teams directory can't be loaded right now. This is a temporary problem, not a change to your access.",
            code: "DIRECTORY_SCOPE_UNAVAILABLE",
          },
          503,
          { "Retry-After": "2" }
        );
      }
      // CAPPED, and the cap is REPORTED. `owned` comes from another service's response body
      // via an unbounded `listByOwner` Query, and every id becomes an `IN` operand in a store
      // FilterExpression that DynamoDB caps at 100 operands / 4KB — so an uncapped scope is a
      // permanent 500 on the directory for a facilitator who has created enough workshops. See
      // MAX_DIRECTORY_SCOPE_IDS for the measured thresholds (91 with a needle, 98 without).
      //
      // WHICH ids survive is the order the Workshop service returned them in. Deliberately not
      // sorted or prioritised: there is no ranking that makes one of a facilitator's own
      // workshops more relevant than another, and inventing one would make the truncation look
      // considered when it is arbitrary. `scopeTruncated` is what tells the caller the page is
      // scoped to part of their estate.
      scopeTruncated = owned.length > MAX_DIRECTORY_SCOPE_IDS;
      const scoped = scopeTruncated ? owned.slice(0, MAX_DIRECTORY_SCOPE_IDS) : owned;
      workshopIds = scoped.map((w) => w.id);
      // Built from the CAPPED list, not from `owned`: a row outside the scope cannot appear on
      // the page, so its name is never read — and keying the map on an untrusted response's
      // full length would be the one collection on this branch still sized by the callee.
      workshopNames = Object.fromEntries(scoped.map((w) => [w.id, w.name]));

      if (scopeTruncated) {
        // Ids only, and COUNTS rather than the ids themselves. Warn and
        // not error: the page is correct for the workshops it covers, and the caller is told.
        console.warn("[team] teams directory: owned-workshop scope TRUNCATED — the page is short", {
          userId: callerId,
          role,
          owned: owned.length,
          scoped: workshopIds.length,
        });
      }
    }

    const limitParam = c.req.query("limit");
    const parsedLimit = limitParam ? Number(limitParam) : undefined;
    // A non-numeric limit is IGNORED rather than 400'd — it comes from a URL and the repository
    // clamps whatever it gets, so there is no unbounded read to protect against. Same
    // treatment, for the same reason, as identity's /admin/users.
    const limit =
      parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

    // TRUNCATED, not refused — see MAX_DIRECTORY_SEARCH. Sliced in CODE POINTS so a needle
    // ending in an emoji cannot be cut into a lone surrogate, which `contains` would then
    // match nothing at all with (the same reason normalizeAuditReason measures this way).
    const rawSearch = c.req.query("search")?.trim();
    const search = rawSearch
      ? [...rawSearch].slice(0, MAX_DIRECTORY_SEARCH).join("")
      : undefined;

    const page = await deps.teams.listDirectory({
      limit,
      cursor: c.req.query("cursor"),
      search,
      // Passed through even when undefined, so the repository — not this route — decides what
      // "no restriction" means. An empty ARRAY reaches it as "sees nothing", which it honours.
      workshopIds,
    });

    // ── Workshop names ─────────────────────────────────────────────────────────
    //
    // ⚠ NOTHING TO DO HERE ANY MORE, AND THAT IS THE POINT. An ADMIN used to skip the ownership
    // scope, so their page could contain workshops they had never read and their names had to be
    // fanned out separately (`resolveWorkshopNames`, capped at 25, best-effort). Now that an admin
    // is scoped to the workshops they OWN, every workshop that can appear on the page came back
    // from `listOwnedWorkshops` WITH its name — so the map is already complete, for both owner
    // roles, at no extra hop.
    //
    // ⚠ `resolveWorkshopNames` therefore has NO CALLER LEFT. Deliberately not deleted from
    // `WorkshopDirectory`: the interface, its HTTP implementation and its own tests are all still
    // correct, and removing them is a separate cleanup that would touch every test fake. It is
    // dead code, not wrong code — but it should go, and this is the note saying so.
    //
    // Its cap, MAX_DIRECTORY_WORKSHOP_NAMES, existed only for this call site and HAS been deleted —
    // it was unreferenced, which lint reported as an error the moment linting was fixed. The bound
    // did NOT go with it: `resolveWorkshopNames` now enforces its own, MAX_WORKSHOP_NAME_PROBES,
    // because "bounded by the caller" with no caller left is an unbounded east-west fan-out that the
    // next caller would have inherited. Same 25, now guaranteed by the method that issues the
    // requests instead of by the one that used to call it — and tested, which it never was here.

    // ── Member counts ─────────────────────────────────────────────────────────
    //
    // One Query per team on the page, against a table this service owns, bounded by the page
    // size (clamped at MAX_DIRECTORY_PAGE_SIZE in the repository) — the same shape as the
    // roster route's `?withMembers=1` fan-out, and the reason each row needs no second call
    // from the client.
    //
    // `listByTeam` and NOT `listByTeamIncludingInactive`: the count means the LIVE team, and
    // the default read already omits deactivated rows. Counting a removed person would be a
    // regression of the one good property the old hard delete had.
    const teams = await Promise.all(
      page.teams.map(async (t) => {
        // Best-effort PER TEAM: a roster read that fails leaves that row with a null count
        // rather than dropping the team or failing the page. Null and not 0 — "we could not
        // count" and "nobody is on this team" are different facts, and 0 is a number an
        // operator would act on.
        const members = await deps.members.listByTeam(t.id).catch(() => null);
        return {
          id: t.id,
          name: t.name,
          workshopId: t.workshopId,
          /** Null when the name could not be resolved — see resolveWorkshopNames. */
          workshopName: workshopNames[t.workshopId] ?? null,
          /** ACTIVE members only. Null when the roster read failed. */
          memberCount: members ? members.length : null,
          createdAt: t.createdAt,
        };
      })
    );

    return c.json({
      teams,
      /** Opaque — pass back unmodified. Absent on the last page. */
      nextCursor: page.nextCursor,
      /**
       * TRUE when the caller owns more workshops than MAX_DIRECTORY_SCOPE_IDS, so this page —
       * and every page reachable from its cursor — covers only the first 50 of them.
       *
       * ALWAYS PRESENT, and false is the ordinary case for BOTH owner roles: a caller — admin or
       * facilitator — who owns 50 or fewer workshops gets a complete page.
       *
       * ⚠ THIS SAID "an ADMIN's scope is unrestricted", AND THAT IS NO LONGER TRUE.
       * The same function says so 140 lines above ("Now reachable for an ADMIN as well: an admin who
       * owns more than the cap gets a SHORT page, where before they got every team unscoped"), so
       * the two halves of one handler disagreed about the rule that decides this field. An ADMIN is
       * scoped to the workshops they OWN like any other owner role, which is exactly what makes this
       * flag reachable for them — the sentence that claimed otherwise was the reason to think it
       * never could be.
       *
       * Reported rather than inferred for the same reason /entitlements/workshops reports
       * `truncated`: a quietly-capped scope is a quietly-short directory, and "this team does not
       * exist" is what an operator would otherwise conclude. The alternative — refusing the
       * request — would be worse: the page IS correct for the workshops it covers.
       */
      scopeTruncated,
    });
  });

  /**
   * The teams in a workshop — SCOPED TO WHAT THE CALLER MAY SEE.
   *
   * This route had NO authorization at all, not even requireIdentity, and the leak
   * was CONFIRMED EXPLOITABLE against a deployed stack: a gateway authorizer claim
   * for an unrelated PARTICIPANT (a member of nothing) returned HTTP 200 with the
   * team name and full roster, and `?withMembers=1` additionally returned every
   * member's EMAIL. Those addresses came back blank only because the users
   * read-model happened to be empty — the code applied no protection, so a
   * populated environment returns real addresses to any signed-in stranger who can
   * name a workshop id. Workshop ids are not a secret: they leak through
   * /invitations/mine, the admin filter and desktop settings.
   *
   * DECIDED ENTIRELY FROM TEAM-OWNED DATA, with ONE exception. Membership is ours
   * (teamMembers) and so is teams-in-a-workshop (teams, partition key workshopId),
   * so the filtered answer needs no hop at all. Only the OWNER branch asks another
   * context, because ownerId is the Workshop service's column and nothing else.
   *
   * Two branches, in this order — the order is the design, cheapest and most
   * local first:
   *
   *   2. STAFF who owns W       → every team. One bounded hop, staff roles only.
   *   3. everyone else          → only the teams in W they are a MEMBER of.
   *
   * ⚠ THERE USED TO BE A BRANCH 1 — `ADMIN → every team, no I/O` — and it was removed
   * when an admin became scoped to the experiences they own. The numbering of the
   * survivors is left alone on purpose: branch 2 and branch 3 are named in the tests and in
   * the roster route below, and renumbering them would silently invalidate those references.
   *
   * Branch 3 returns a FILTERED LIST, not a 403, and that is deliberate: "the teams
   * you are on" is the truthful answer for a participant or an executive, and it is
   * what the portal's team views and the desktop's team picker actually consume. A
   * 403 would be both less true and more breaking. A caller who is a member of
   * nothing in this workshop gets an empty list — which is also the honest answer,
   * and it discloses nothing about whether the workshop exists.
   *
   * Branch 2 is gated on the STAFF role BEFORE the hop, mirroring canRead's own
   * `isStaffRole && ownsTeamWorkshop` shape in authz.ts. That is not a micro-
   * optimisation, it is what keeps the call graph shallow: ownsWorkshop resolves
   * ownership by calling the Workshop service's GET /v1/workshops/:id, which (once
   * gated) may itself ask us back about membership. Restricting the probe to the only
   * two roles that can own a workshop at all — see WORKSHOP_CREATOR_ROLES in
   * shared/types/user.ts — means a PARTICIPANT/EXECUTIVE/JUDGE roster
   * read makes NO east-west call whatsoever, and the staff path terminates because
   * the membership question we get asked back is answered from our own tables (see
   * GET /workshops/:workshopId/membership below), never by calling Workshop again.
   */
  team.get("/workshops/:workshopId/teams", async (c) => {
    const { id: callerId, role } = requireIdentity(c);
    const workshopId = c.req.param("workshopId");

    const teams = await deps.teams.listByWorkshop(workshopId);

    // `seesAllTeams` also decides who may see EMAIL addresses below, because it is
    // exactly the "owns this workshop" set.
    //
    // ⚠ THE `role === "ADMIN" ||` SHORT-CIRCUIT WAS REMOVED. It handed any
    // admin every team in ANY experience — and, via the same flag, every member's EMAIL
    // ADDRESS. An admin now resolves through the ownership probe like a facilitator;
    // `isStaffRole` admits them, so an owner-admin is unaffected and a non-owner admin
    // falls to branch 3 and sees only teams they are a member of, which for an ADMIN is
    // structurally none.
    const seesAllTeams =
      isStaffRole(role) &&
      (await deps.workshops.ownsWorkshop(workshopId, callerId, role, c));

    let visible = teams;
    if (!seesAllTeams) {
      // Branch 3 — intersect the workshop's teams with the caller's memberships.
      // Both sides are single-partition Queries on tables we own (teams by
      // workshopId, team-members via userId-index), so this adds one local read and
      // no hop. Set membership is O(1) per team rather than a nested scan.
      const memberships = await deps.members.listByUser(callerId);
      const mine = new Set(memberships.map((m) => m.teamId));
      visible = teams.filter((t) => mine.has(t.id));
    }

    /**
     * `?count=1` — the WORKSHOP-WIDE team total, opt-in and separate from the list.
     *
     * The Workshop service needs this for the experiences page's "N teams" subtitle, and
     * it cannot use `teams.length` from this response because the response is FILTERED:
     * a participant or EXECUTIVE sees only their own teams, so counting it would report
     * "1 team" for a workshop that has five. That number is not wrong about them but is
     * wrong about the workshop, and it looks plausible enough to be believed.
     *
     * Widening the COUNT while keeping the LIST filtered is deliberate, not a shortcut.
     * They disclose different things: a count is an aggregate ("this experience has 2
     * teams"), while the list is a roster naming which people are in which team. An
     * EXECUTIVE is entitled to the experience and needs the aggregate to read the page;
     * they remain refused the roster. Nothing here reveals a team's name, id or members
     * to a caller who could not already see them.
     *
     * Opt-in so the default response shape is unchanged for every existing caller.
     */
    const countField =
      c.req.query("count") === "1" ? { teamCount: teams.length } : {};

    // `?withMembers=1` folds each team's members (and a _count) into the response
    // so the admin BFF's workshop detail view makes ONE call instead of a
    // /members request per team (the N+1). Enrichment runs in parallel across teams.
    //
    // EMAIL IS MINIMISED, NOT REFUSED. The parameter stays legal on the filtered
    // branch and simply omits the address, rather than 400-ing: the portal's
    // workshop.getById fans out to this route with withMembers=1 inside a
    // Promise.all (portal/src/lib/trpc/routers/workshop.ts:33-37), and a participant
    // reaches that on their own team's Phases page — so refusing the parameter would
    // reject the whole fan-out and break a page for exactly the people branch 3
    // exists to keep working. They still get names and counts, which is what the UI
    // renders; the address, which it does not render for them, is what stays behind.
    if (c.req.query("withMembers") === "1" && visible.length > 0) {
      const enriched = await Promise.all(
        visible.map(async (t) => {
          try {
            const members = await loadTeamMembers(t.id, seesAllTeams);
            // THE SEAT-LEDGER DRIFT CHECK. This is the one read that holds both
            // numbers, which is why it lives here rather than on a schedule.
            reportSeatLedgerDrift(t, members.length);
            return { ...t, members, _count: { members: members.length } };
          } catch {
            return { ...t, members: [], _count: { members: 0 } };
          }
        })
      );
      return c.json({ teams: enriched, ...countField });
    }

    return c.json({ teams: visible, ...countField });
  });

  /**
   * Is the caller a member of ANY team in this workshop? — the MEMBERSHIP branch of
   * the Workshop service's read gate, answered by the context that owns the data.
   *
   * This exists because gating GET /v1/workshops/:id on owner-or-ADMIN alone would
   * 403 every participant and break the desktop app, which reads that route (plus
   * /assistants and /phases) to set a workspace up. Participants are legitimately
   * entitled to the workshop they are building in, and the fact that makes them
   * entitled — team membership — lives HERE, in teamMembers, not in Workshop.
   *
   * TWO INVARIANTS, both load-bearing:
   *
   *   1. It is answered from THIS service's own tables ONLY: teams by workshopId,
   *      then the caller's memberships via userId-index. It does not touch
   *      deps.workshops, so it CANNOT call the Workshop service even by accident —
   *      which is what closes the Team → Workshop → Team cycle by construction
   *      rather than by everyone remembering not to create it.
   *   2. It answers only about the CALLER. There is deliberately no `?userId=`
   *      parameter: an entitlement probe that takes a subject is an enumeration
   *      oracle, and it would let anyone map who is in which workshop.
   *
   * Cheap on purpose: two Queries, no fan-out per team, no user read-model lookups.
   * It returns a bare boolean because that is the whole question — no team names, no
   * ids, nothing the caller could not already get from the roster route above.
   */
  team.get("/workshops/:workshopId/membership", async (c) => {
    const { id: callerId } = requireIdentity(c);
    const workshopId = c.req.param("workshopId");

    const [teams, memberships] = await Promise.all([
      deps.teams.listByWorkshop(workshopId),
      deps.members.listByUser(callerId),
    ]);

    const mine = new Set(memberships.map((m) => m.teamId));
    const isMember = teams.some((t) => mine.has(t.id));

    return c.json({ isMember });
  });

  /**
   * Create a team in a workshop — STAFF ONLY.
   *
   * This route had NO authorization beyond requireIdentity, and it USED TO make the
   * caller the team LEAD unconditionally. Together that meant any authenticated
   * user — a read-only EXECUTIVE, a JUDGE, a PARTICIPANT already on a team — could
   * POST a team into ANY workshop id they could name and be its lead. Team
   * membership is what canRead/canWrite in authz.ts are decided from, so
   * self-appointing as LEAD of a team in someone else's workshop was a way to
   * manufacture read/write access to that workshop's team surface.
   *
   * BOTH halves are now closed: the ownership gate below, and the auto-LEAD insert
   * removed entirely (see the note where it used to be). A new team starts with NO
   * members — the creator is staff setting the workshop up, not a participant.
   *
   * The gate is ownership, not membership, and it cannot be the usual
   * canRead/canWrite helpers: those take a teamId and resolve the workshop THROUGH
   * it, and the team does not exist yet. So it asks the Workshop context directly.
   *
   * Participants are not shut out of teams — they JOIN one with an invite code
   * (POST /teams/join), which is the path that enforces workshop membership rules.
   */
  team.post("/workshops/:workshopId/teams", async (c) => {
    const { id, role } = requireIdentity(c);
    const workshopId = c.req.param("workshopId");

    // A global ADMIN may create a team anywhere. Everyone else must own the
    // workshop — which for a FACILITATOR is the normal case and for
    // EXECUTIVE/JUDGE/PARTICIPANT is never true, since they cannot create
    // workshops at all.
    if (role !== "ADMIN") {
      const owns = await deps.workshops.ownsWorkshop(workshopId, id, role, c);
      if (!owns) {
        return c.json(
          { error: "Forbidden: only the workshop owner can create teams" },
          403
        );
      }
    }

    const body = await c.req.json();

    // ── THE SEAT CAP IS SEEDED HERE, FROM THE WORKSHOP TEMPLATE ────────────────────────
    //
    // `Workshop.maxTeamSize` is read ONCE, on this write path, and copied onto the team row as
    // `seatCap`. From that moment it is TEAM'S OWN DATA: no membership path ever consults the
    // workshop again, and a later workshop patch does not touch existing teams (§G — which is
    // what makes grandfathering unreachable rather than granted, since no migration removes
    // anybody).
    //
    // ⚠ WHY THE TEMPLATE CANNOT BE READ ON THE JOIN PATH INSTEAD, which is the obvious
    // alternative and is STRUCTURALLY IMPOSSIBLE rather than merely slow. Team would call
    // `GET /v1/workshops/:id` re-presenting the JOINER's token (the only pattern the gateway
    // accepts). `requireWorkshopRead` then runs: not ADMIN, not the owner, so it asks Team
    // whether the caller is a member of a team in that workshop — and a joiner is not yet a
    // member of any, so 403. THE FIRST JOIN INTO A WORKSHOP, the common case, could never read
    // its own cap. This route is staff-only, so its caller passes that gate locally.
    //
    // ⚠ AND WHY IT IS READ *BEFORE* THE ROW IS WRITTEN. The fail-closed rule: `"unavailable"`
    // never becomes a permissive default. A team row written first and capped afterwards would
    // leave a team with NO seatCap whenever the hop failed — and `memberCount < seatCap` is
    // FALSE when `seatCap` is absent, so that team would refuse every join with no way for a
    // participant to tell why. Refusing to create it is the honest failure.
    const template = await deps.workshops.teamSeatTemplate(
      workshopId,
      id,
      role,
      c
    );

    if (template === "unavailable") {
      // TRANSIENT — the hop could not be COMPLETED (timeout, non-2xx, unreadable body) — so a
      // retry genuinely changes the answer and `Retry-After` is truthful. NO TEAM ROW IS
      // WRITTEN. Same shape and same reasoning as the reactivation route's SUBJECT_UNAVAILABLE.
      console.warn(
        "[team] refused a team creation — the workshop's team-size template is unavailable",
        { workshopId, userId: id }
      );
      return c.json(
        {
          error:
            "The experience's settings are unavailable, so the team cannot be created right now. Try again shortly.",
          code: "WORKSHOP_TEMPLATE_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    if (template === "invalid") {
      // The read COMPLETED and the stored value is unusable — absent on a workshop written
      // before the field existed, or out of range because the create/patch routes did not
      // validate it until now. PERMANENT until somebody patches the workshop, so this is a 409
      // rather than a 503: `Retry-After` would tell an operator to wait for something that will
      // never change, which is the distinction the reactivation route already draws between an
      // unresolvable address and a definite absent row.
      //
      // The message names the remedy and the range, because the person hitting this is the
      // facilitator who owns the workshop and can fix it in one edit.
      console.warn(
        "[team] refused a team creation — the workshop's maxTeamSize is missing or out of range",
        { workshopId, userId: id }
      );
      return c.json(
        {
          error:
            `This experience has no valid maximum team size, so a team cannot be created in it. ` +
            `Set its maximum team size to a whole number between 2 and ${MAX_TEAM_MEMBERS}.`,
          code: "WORKSHOP_TEMPLATE_INVALID",
        },
        409
      );
    }

    const teamId = ulid();

    // ── THE JOIN CODE: FROM THE CSPRNG, AND RE-DRAWN IF IT IS ALREADY IN USE ──────────────
    //
    // This was `ulid().slice(0, 8).toUpperCase()`, which carried NO entropy — the first 8
    // characters of a ULID are its millisecond timestamp, so the code was a pure function of
    // the creation time at ~256 ms granularity and every team created in the same bulk upload
    // got the SAME code. See invite-code.ts for the full reasoning, including why the retry
    // below is a narrowing rather than mutual exclusion.
    let inviteCode = generateInviteCode();
    for (let attempt = 1; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt += 1) {
      // A GSI query on the join path's own index. Cheap, and only on the creation path.
      //
      // ⚠ AN AMBIGUOUS ANSWER IS "TAKEN", NOT AN ERROR. `getByInviteCode` now THROWS when the
      // index holds more than one row for a code (legacy duplicates from the old generator), and
      // letting that propagate would turn team CREATION into a 500 over a code we are about to
      // throw away anyway. Two matches is the strongest possible "this code is in use".
      let taken: boolean;
      try {
        taken = (await deps.teams.getByInviteCode(inviteCode)) !== null;
      } catch (err) {
        if (!(err instanceof AmbiguousInviteCodeError)) throw err;
        taken = true;
      }
      if (!taken) break;
      // WARN and not silent: at 40 bits this should never be seen, so seeing it means either
      // an extraordinary coincidence or that somebody has narrowed the alphabet or the length.
      console.warn("[team] invite code collided on creation — re-drawing", {
        workshopId,
        attempt,
      });
      inviteCode = generateInviteCode();
    }

    const now = new Date().toISOString();

    const item = await deps.teams.put({
      workshopId,
      id: teamId,
      name: body.name,
      description: body.description || null,
      inviteCode,
      repoUrl: body.repoUrl || null,
      createdAt: now,
      updatedAt: now,
      // Validated by `teamSeatTemplate` to be an integer in [2, MAX_TEAM_MEMBERS] — the two
      // refusals above are the only other outcomes, so this is never a coerced or defaulted
      // number.
      seatCap: template,
      // ── THE LEDGER STARTS AT ZERO, EXPLICITLY ──
      //
      // A new team is empty (the creator is deliberately NOT added — see the note below), and
      // writing the 0 is what makes the FIRST join work: `memberCount < seatCap` evaluates
      // FALSE for an ABSENT attribute, so omitting it here would make every new team refuse
      // its first member and rely on the repository's legacy-row repair path to notice. Absent
      // is not zero (see Team.memberCount); a team that has never been joined must still carry
      // a real count.
      memberCount: 0,
    });

    // A NEW TEAM STARTS EMPTY. The creator is deliberately NOT added as a member.
    //
    // It used to insert the creator as LEAD here, which was wrong in the only case
    // this route now permits. The route is STAFF-ONLY (see the authorization note
    // above): the caller is an ADMIN or the workshop's owning FACILITATOR, i.e. the
    // person SETTING UP the workshop, not a participant who will build in this team.
    // So the row it wrote was a facilitator masquerading as a team member — it made
    // the roster read "Members (1) — LEAD" before anyone had joined, put staff into
    // participant-facing member lists, and pre-assigned a LEAD that the actual team
    // never chose.
    //
    // NO AUTHORIZATION IS LOST BY REMOVING IT. canRead/canWrite (authz.ts) grant
    // access on `isStaffRole(role) && ownsTeamWorkshop(...)` INDEPENDENTLY of
    // membership, so the creating facilitator keeps full read and write on the team
    // without a row here — verified against that predicate, not assumed. Membership
    // is now what it claims to be: people who joined with the invite code.
    //
    // Participants become members via POST /teams/join (invite code), which is also
    // where the FIRST joiner gets LEAD if that is wanted — a decision for the team,
    // not a side effect of an admin clicking "create".

    await deps.events.publish({
      source: "team-service",
      type: "team.created",
      detail: { teamId, workshopId, createdBy: id },
    });

    return c.json({ team: item }, 201);
  });

  /**
   * ── ENQUEUE A BULK PROVISIONING JOB ─────────────────────────────────────────────────────
   *
   * Takes an ALREADY-VALIDATED plan as JSON and publishes it. It does not create anything: the
   * worker does, so this route's whole job is to answer "may you?" and hand the work on.
   *
   * ⚠ WHY THE ENQUEUE LIVES HERE AND NOT IN THE BFF. The portal has no AWS SDK — services own AWS,
   * the BFF orchestrates over HTTP — so publishing from there would need `sqs:SendMessage` on the
   * Amplify compute role plus a new dependency. This service already has `deps.events.publish`, so
   * routing the enqueue through it costs NO new IAM anywhere.
   *
   * ⚠ AND THE AUTHORIZATION GATE IS BYTE-IDENTICAL TO TEAM CREATION, deliberately: this job creates
   * teams, so "may you set up this experience?" must have exactly one answer. A second spelling is
   * how the two drift.
   */
  team.post("/workshops/:workshopId/bulk-provision", async (c) => {
    /**
     * ⚠ `email` COMES FROM THE VERIFIED IDENTITY, NOT FROM A HEADER — and reading the header is a bug
     * this route actually shipped with. It read `c.req.header("x-identity-email")`, which is only
     * populated on the internal-hop path (path 3); a facilitator uploading through the gateway
     * arrives on path 1, where the email is a CLAIM. So `requestedBy.email` was published as `""`,
     * and the worker — whose one promise to the operator is "we'll email you the outcome" — logged
     * "no requester email — report NOT sent" and sent nothing. The upload had also failed, so the
     * person who most needed that email got silence instead.
     *
     * `requireIdentity` resolves the email from whichever path authenticated the request, which is
     * the only reason it exists.
     */
    const { id, role, email } = requireIdentity(c);
    const workshopId = c.req.param("workshopId");

    if (role !== "ADMIN") {
      const owns = await deps.workshops.ownsWorkshop(workshopId, id, role, c);
      if (!owns) {
        return c.json(
          { error: "Forbidden: only the experience owner can bulk provision teams" },
          403
        );
      }
    }

    const body = await c.req.json().catch(() => null);
    const plan = body?.plan;

    /**
     * ⚠ SHAPE-CHECKED HERE TOO, even though the BFF validated the CSV. The BFF is not a boundary —
     * every route is `Method: ANY` behind an authorizer with no scoping, so a caller can reach this
     * directly. An unbounded or malformed plan would be published to a queue and then handed to a
     * worker that creates accounts, which is the last place to discover it is wrong.
     */
    if (!plan || !Array.isArray(plan.teams) || !Array.isArray(plan.members)) {
      return c.json({ error: "plan.teams and plan.members are required" }, 400);
    }
    if (plan.teams.length === 0 || plan.members.length === 0) {
      return c.json({ error: "The plan is empty — nothing to provision." }, 400);
    }
    // The same ceilings the BFF enforces. Re-stated rather than imported: this service
    // is bundled without the portal's modules, and a bound a caller can exceed is not a bound.
    if (plan.members.length > BULK_MAX_ROWS || plan.teams.length > BULK_MAX_TEAMS) {
      return c.json(
        {
          error: `A plan may name at most ${BULK_MAX_TEAMS} teams and ${BULK_MAX_ROWS} members.`,
        },
        400
      );
    }

    /**
     * ⚠ THE EVENT CARRIES AN IDENTITY, NEVER A CREDENTIAL.
     *
     * The worker needs to act with the caller's authority, and the obvious way — forwarding their
     * bearer — would leave a live token at rest in the queue for up to 14 days, replayed on redrive
     * and copied into the DLQ. Instead the worker asserts this identity with the internal service
     * token, the same mechanism every east-west call already uses.
     *
     * ⚠ Addresses in the plan ARE PII at rest here. Accepted because the alternative is a plan store
     * the platform does not have — and the reason the queue must not be readable beyond the worker.
     */
    const batchId = ulid();

    /**
     * ── ⚠ THE AUDIT ROW IS WRITTEN BEFORE THE EVENT IS PUBLISHED, AND THE ORDER IS THE DESIGN ──
     *
     * `EventBridgePublisher.publish` deliberately SWALLOWS its errors so a bus hiccup never fails the
     * originating write. That is right for a projection event and dangerous here: publish-then-record
     * would mean a batch that was never queued still gets a row, and — worse — a silent publish
     * failure would leave "accepted" on the operator's screen with nothing anywhere disagreeing.
     *
     * Recording first inverts both. If the row cannot be written the upload is REFUSED, because a job
     * that creates accounts and sends email must not run unobservably. If the row is written and the
     * publish then fails silently, the row stays `queued` and the portal shows it as stalled — which
     * is the only mechanism by which a swallowed publish becomes visible to anyone.
     *
     * ⚠ AND NO ROW MEANS NO UPLOAD. A 503 here is honest: this environment has bulk provisioning
     * switched on without the table it records into, which is a deployment mistake, not the
     * operator's.
     */
    if (!deps.bulkBatches) {
      console.error("[team] bulk provisioning is enabled but has no audit store — refusing", {
        workshopId,
        requestedBy: id,
      });
      return c.json(
        { error: "Bulk upload is not fully configured on this environment." },
        503
      );
    }

    const batch: BulkBatch = {
      batchId,
      workshopId,
      status: "queued",
      requestedBy: { id, email },
      requested: { teams: plan.teams.length, members: plan.members.length },
      createdAt: new Date().toISOString(),
    };

    try {
      await deps.bulkBatches.create(batch);
    } catch (err) {
      console.error("[team] could not record the bulk batch — upload REFUSED", {
        batchId,
        workshopId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { error: "The upload could not be recorded, so it was not started. Please try again." },
        503
      );
    }

    await deps.events.publish({
      source: "team-service",
      type: "bulk-provision.requested",
      detail: {
        batchId,
        workshopId,
        plan,
        requestedBy: { id, role, email },
      },
    });

    console.log("[team] bulk provisioning queued", {
      batchId,
      workshopId,
      teams: plan.teams.length,
      members: plan.members.length,
      requestedBy: id,
    });

    // 202: accepted, not done. The worker reports the outcome by email and by
    // advancing the audit row this route just wrote.
    return c.json({ batchId, queued: true }, 202);
  });

  /**
   * ── THE BULK UPLOAD AUDIT TRAIL (READ) ──────────────────────────────────────────────────
   *
   * Every upload for this experience, newest first: when it arrived, how much it asked for, what
   * happened, and the named failures.
   *
   * ⚠ THE GATE IS THE SAME ONE THAT GUARDS THE UPLOAD ITSELF. This row names the addresses of
   * everyone in somebody's file, which is PII — so "may you read the audit trail?" must have exactly
   * the same answer as "may you upload one?", not a laxer one because it is a read.
   */
  team.get("/workshops/:workshopId/bulk-provision/batches", async (c) => {
    const { id, role } = requireIdentity(c);
    const workshopId = c.req.param("workshopId");

    if (role !== "ADMIN") {
      const owns = await deps.workshops.ownsWorkshop(workshopId, id, role, c);
      if (!owns) {
        return c.json(
          { error: "Forbidden: only the experience owner can view bulk upload history" },
          403
        );
      }
    }

    /**
     * ⚠ AN EMPTY LIST, NOT A 503, WHEN THE FEATURE IS OFF — and this is the one place where that
     * asymmetry with the accept path is correct. There is nothing to show and nothing at risk: the
     * panel renders "no uploads yet", which is TRUE of an environment that cannot accept one. The
     * accept path refuses because it would otherwise create accounts unobservably; a read has no such
     * consequence.
     */
    if (!deps.bulkBatches) return c.json({ batches: [] });

    // Bounded: this is a recent-activity panel, not an archive. 25 covers any plausible session.
    const batches = await deps.bulkBatches.listByWorkshop(workshopId, 25);
    return c.json({ batches });
  });

  /**
   * ── THE BULK UPLOAD AUDIT TRAIL (PROGRESS) ──────────────────────────────────────────────
   *
   * How the worker reports what it is doing. Called three times per batch at most: picked up,
   * finished, or could-not-run.
   *
   * ⚠ WHY THE WORKER GOES THROUGH THIS ROUTE INSTEAD OF WRITING THE TABLE ITSELF. The table is Team's
   * data, and the worker already holds `lambda:InvokeFunction` on this function — so routing the
   * write here costs NO new IAM and keeps one writer, while a DynamoDB grant on the worker would add
   * a second service that can rewrite an audit row.
   *
   * ⚠ AND THE GATE IS THE SAME AGAIN. The worker asserts the uploading facilitator's identity, so it
   * passes the ownership check exactly as they would — no bypass, no "internal" exemption. A caller
   * who cannot upload to this experience cannot touch its audit rows either.
   */
  team.patch("/workshops/:workshopId/bulk-provision/batches/:batchId", async (c) => {
    const { id, role } = requireIdentity(c);
    const workshopId = c.req.param("workshopId");
    const batchId = c.req.param("batchId");

    if (role !== "ADMIN") {
      const owns = await deps.workshops.ownsWorkshop(workshopId, id, role, c);
      if (!owns) {
        return c.json({ error: "Forbidden: only the experience owner can update a batch" }, 403);
      }
    }

    if (!deps.bulkBatches) return c.json({ error: "Bulk upload is not configured here." }, 503);

    const body = await c.req.json().catch(() => null);
    const progress = normalizeBatchProgress(body);
    if (!progress) {
      return c.json({ error: "A valid status is required." }, 400);
    }

    const applied = await deps.bulkBatches.update(workshopId, batchId, progress);
    if (!applied) {
      // The row does not exist. NOT created here — see the repository note on why an upsert would
      // manufacture an audit record for a batch nobody accepted.
      return c.json({ error: "No such batch." }, 404);
    }

    return c.json({ batchId, status: progress.status });
  });

  team.post("/teams/join", async (c) => {
    const { id, email, role } = requireIdentity(c);
    const { inviteCode } = await c.req.json();

    if (!inviteCode) {
      return c.json({ error: "inviteCode is required" }, 400);
    }

    // LAYER 2 of requirement (b): an ADMIN, FACILITATOR or JUDGE may not become
    // a team member, so this route cannot be their way in.
    //
    // 403 here, not the 400 the invitation route answers: the caller is not naming a wrong
    // scope, they are attempting an action their role may not perform at all.
    //
    // FROM THE VERIFIED TOKEN ROLE, never from the invitation row this join will go on to
    // read. A stored `platformRole` is a record of what someone was offered — it can
    // predate a role change and it was written by a different actor — so it is evidence,
    // not authority.
    //
    // BEFORE ANY STORE READ, which is both the cheapest order and the least disclosing: a
    // refused caller learns nothing about whether the code they presented is real. It also
    // sits before the idempotent "already a member" short-circuit deliberately — the rule
    // is a property of the ROLE, so it must not become satisfiable by already having the
    // row it exists to prevent. The migration audit found ZERO such rows, so no legitimate
    // caller is affected today; if one ever appeared, this refuses to help it grow.
    if (!mayHoldTeamMembership(role)) {
      return c.json(
        {
          error:
            "Your role is platform-wide and cannot join a team. Ask an admin if you need team access.",
        },
        403
      );
    }

    // ⚠ AN AMBIGUOUS CODE IS REFUSED, NOT GUESSED. The lookup used to query the
    // GSI with `Limit: 1` and hand back whichever duplicate DynamoDB surfaced, which could join
    // — or, more often, wrongly REFUSE — someone against a team they were never invited to. Only
    // legacy rows can still collide (see invite-code.ts), and for those a clear "ask for a fresh
    // code" beats a coin flip. The operator log is what makes the affected teams findable.
    let teamItem: Team | null;
    try {
      teamItem = await deps.teams.getByInviteCode(inviteCode);
    } catch (err) {
      if (err instanceof AmbiguousInviteCodeError) {
        console.error("[team] join refused — this code is shared by more than one team", {
          matches: err.matches,
          userId: id,
        });
        return c.json(
          {
            error:
              "This code matches more than one team, so we can't tell which one you mean. Ask your facilitator for a fresh code.",
            code: "INVITE_CODE_AMBIGUOUS",
          },
          409
        );
      }
      throw err;
    }
    if (!teamItem) {
      return c.json({ error: "Invalid invite code" }, 404);
    }

    // Already a member — idempotent join.
    if (await deps.members.get(teamItem.id, id)) {
      return c.json({ team: teamItem });
    }

    // Only users invited by an admin (an invitation row for their email on this
    // team) may join — a valid invite code alone is not enough. This prevents
    // joining a team you weren't added to (e.g. via a guessed/shared code).
    const invitation = email ? await deps.invitations.get(teamItem.id, email) : null;
    if (!invitation) {
      return c.json(
        {
          error:
            "You have not been invited to this team. Ask your facilitator to add your email.",
        },
        403
      );
    }

    // AN INVITATION IS A ONE-SHOT GRANT, AND A SPENT ONE ADMITS NOBODY.
    //
    // This route checked only that a row EXISTED (`if (!invitation)` above) and never its
    // STATUS, which made a removed member's surviving invitation a standing permission to
    // return. VERIFIED EXPLOITABLE against the deployed stack: a FACILITATOR removed a
    // participant (membership row deleted, MEMBER_REMOVED audited — all correct), the
    // ACCEPTED invitation row survived, GET /invitations/mine handed the removed person the
    // team's live inviteCode, and POST /teams/join with that code answered HTTP 200 and
    // re-created the membership as BUILDER. An operator removes someone, the audit says
    // removed, and the person puts themselves back with nothing recording the rejoin.
    //
    // THE IDENTICAL HOLE WAS ALREADY CLOSED FOR REGISTRATION in
    // services/cognito-presignup/src/handler.ts — see the `isAccepted` note there. The
    // reasoning transfers VERBATIM: an ACCEPTED row means the person already redeemed the
    // grant, so it can never legitimately authorise a second redemption, and re-admitting
    // someone is an EXPLICIT ACT — an operator with grant authority issues a fresh
    // invitation, which writes a new PENDING row. That handler closed the registration door;
    // this closes the team-membership one, and REVOKED is the status the removal now writes.
    //
    // PLACED AFTER the idempotent "already a member" short-circuit above, and that order is
    // load-bearing in the OTHER direction from the role gate: a CURRENT member's re-join
    // must keep returning 200 even though their row is ACCEPTED (the portal calls join on
    // the workshop page, and every returning member's row is ACCEPTED by definition). They
    // already have the access — nothing is granted — so the short-circuit answers first.
    //
    // ABSENT STATUS IS NOT SPENT — see isSpentInvitation. Rows predating the field stay
    // joinable, so no backfill is needed and no legitimate first join is broken.
    if (isSpentInvitation(invitation.status)) {
      // Logged: this is either a real attempt to walk back into a team someone was removed
      // from, or a client re-submitting a stale code, and an operator investigating the
      // former needs to see it. Ids only — no address, which is PII.
      console.warn("[team] refused a join on a SPENT invitation", {
        teamId: teamItem.id,
        userId: id,
        status: invitation.status,
      });
      // 403, and DELIBERATELY THE SAME SHAPE as the "not invited" refusal above rather than
      // a distinct code: the two are the same answer from the caller's side — this code does
      // not admit you — and a separate message would tell someone probing which of the two
      // states their address is in. The message points at the only real remedy, which is a
      // person with grant authority issuing a new invitation.
      return c.json(
        {
          error:
            "This invitation is no longer valid. Ask your facilitator to invite you again.",
        },
        403
      );
    }

    // ── THE SEAT CAP ────────────────────────────────────────────────────────────
    //
    // `admit` rather than `put`: ONE TransactWriteItems that writes the membership row and
    // increments the team's seat ledger under `memberCount < seatCap`. The cap is enforced in
    // the REPOSITORY and not here, deliberately — see §B and the interface note. A route-level
    // "count the roster, then write" loses the race it appears to win: two joiners at 9/10
    // both read 9, both decide there is a seat, and both write.
    //
    // `teamItem.workshopId` is in scope from the invite-code lookup above, which is why THIS
    // path needs no extra read for the counter's key.
    const outcome = await deps.members.admit(
      {
        teamId: teamItem.id,
        userId: id,
        // Honor the team role the inviter picked; fall back to BUILDER for legacy
        // invitations (or non-participant invites) that carry no team role.
        role: invitation.teamRole || "BUILDER",
        joinedAt: new Date().toISOString(),
      },
      teamItem.workshopId
    );

    if (outcome === "full") {
      // 409, and the message names the limit rather than the arithmetic: the participant can
      // do nothing about it themselves, so the only useful content is who to ask.
      //
      // NOT a 403. The caller's invitation is valid and their role is permitted — the team is
      // simply at capacity, which is a state of the resource rather than a judgement about
      // them. A 403 would send them looking for a permissions problem that does not exist.
      console.warn("[team] refused a join — the team is at its seat cap", {
        teamId: teamItem.id,
        userId: id,
        seatCap: teamItem.seatCap,
        memberCount: teamItem.memberCount,
      });
      return c.json(
        {
          error:
            "This team is full. Ask your facilitator to raise its size or add you to another team.",
          code: "TEAM_FULL",
        },
        409
      );
    }

    // "already-member" reaching here means a row exists that the ACTIVE-only `get` above did
    // NOT return — i.e. an INACTIVE one, from a removal. It is NOT an error and NOT a grant:
    // re-admitting through this path would REPLACE the row whole and destroy the preserved
    // `role`/`joinedAt` the soft delete exists to protect (a LEAD would return a BUILDER).
    // Restoring them is the audited reactivation route, by an operator.
    //
    // The response is the same 200 shape as a successful join, which is honest about what the
    // caller can act on — they have no access either way and no retry will change that — while
    // the log line is what makes the case findable. The spent-invitation gate above already
    // refuses the common form of this (a removal revokes the invitation), so reaching here
    // means a row that was deactivated without its invitation being withdrawn.
    if (outcome === "already-member") {
      console.warn(
        "[team] join found an INACTIVE membership row — not re-admitting; a restoration is an operator action",
        { teamId: teamItem.id, userId: id }
      );
      return c.json({ team: teamItem });
    }

    // Mark the invitation for this user's email as accepted. Idempotent at the store
    // (a second join does not move acceptedAt) and a no-op when there is no row.
    //
    // CAUGHT, NOT PROPAGATED, and this is the deliberate choice: the membership row
    // above is the effect the caller asked for and it is already written. A status
    // update that fails must not turn a successful join into a 500 — the person would
    // be on the team and told they were not. The row is reconciled by the next
    // sign-in's accept (see POST /invitations/mine/accept), so this is recoverable
    // rather than lost. Logged so it is not silent, which is the failure mode the
    // repository's old bare `catch {}` had.
    try {
      await deps.invitations.accept(teamItem.id, email, id);
    } catch (err) {
      console.error("[team] could not mark the invitation accepted on join", {
        teamId: teamItem.id,
        userId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await deps.events.publish({
      source: "team-service",
      type: "member.joined",
      detail: { teamId: teamItem.id, workshopId: teamItem.workshopId, userId: id },
    });

    return c.json({ team: teamItem });
  });

  /**
   * The team's People list — INCLUDING DEACTIVATED MEMBERS, which is the point.
   *
   * Owner: "we shouldnt remove the user from the list as it might be missing for audit can we
   * make it inactive and show it in the members list to show he was joined but later removed".
   * This is the route that renders that, and each member carries `status`, `removedAt`,
   * `removedByName` and `removedByRole` per the frozen contract — enough for the roster to show
   * an inactive member WITH a Reactivate action, which an audit entry alone cannot support
   * (see the note on former-members below).
   *
   * THE ONLY CALLER OF THE `IncludingInactive` VARIANT. Every other `listByTeam` reader —
   * member counts, the `?withMembers=1` fan-out, the directory's user-id resolution, the
   * workshop roster — keeps the ACTIVE-ONLY default, so a removed person appears here and
   * nowhere else. That asymmetry is deliberate and is what keeps counts and access correct.
   *
   * Gated on team READ (the ADMINISTRATION predicate) exactly as before, because rosters carry
   * names and email addresses and a guessed teamId would otherwise dump another team's
   * membership. Unchanged by this route learning about inactive rows: a former member is the
   * same person, about the same team, and the caller could have read all of it the day before
   * the removal.
   */
  team.get("/teams/:teamId/members", async (c) => {
    const teamId = c.req.param("teamId");
    const { role: callerRole } = requireIdentity(c);
    const denied = await requireTeamRead(c, deps.members, deps.workshops, teamId);
    if (denied) return denied;

    // Emails INCLUDED here, opted in explicitly rather than by default. requireTeamRead
    // resolves to exactly the set entitled to them — a member of THIS team, staff who
    // owns its workshop, or ADMIN — which is the same rule the roster route's
    // withMembers branch applies, reached by a different route. This is the team's own
    // People list; a team that cannot see its own members' addresses cannot contact
    // them, and the portal's team page renders the field.
    //
    // `callerRole` is passed for the ONE visibility decision on this route — whether the
    // REMOVING OPERATOR's name may be shown — not for the roster itself. See the helper.
    const members = await loadTeamMembersIncludingInactive(teamId, callerRole, true);

    /**
     * SEAT LEDGER DRIFT — reported here because this is the one route that has
     * already paid for the roster.
     *
     * `memberCount` moves in the SAME transaction as the membership row, so under this
     * service's own writes it cannot drift. This exists to catch the one thing the design
     * cannot prevent: a future write path that touches `team-members` without going through
     * `admit`/`deactivate`/`reactivate`, leaving the ledger wrong and refusing joins to a team
     * that has room.
     *
     * FIRE AND FORGET, and deliberately not awaited: the roster is already computed and the
     * caller is owed it. `.catch()` swallows because a failed observability read must not turn a
     * served roster into a 500 — the metric going quiet is itself the signal (it emits 0 on
     * agreement, so silence means the emitter stopped running).
     */
    void deps.teams
      .getById(teamId)
      .then((team) => {
        if (!team) return;
        emitSeatLedgerDriftMetric({
          teamId,
          // ACTIVE only. `members` includes INACTIVE rows (removals keep the row) and
          // the ledger counts actives, so comparing raw lengths would report drift on every
          // team that has ever removed somebody.
          actualActive: members.filter((m) => !isInactiveMembership(m.status)).length,
          ledgerCount: typeof team.memberCount === "number" ? team.memberCount : null,
          source: "team",
        });
      })
      .catch(() => {});

    return c.json({ members });
  });

  /**
   * Authorization probe for callers that talk to the model directly (e.g. the AI
   * service's HttpTeamAccess, which never reaches this service for the completion
   * itself). Returns whether the caller may read and/or write this team, so those
   * callers can enforce membership + read-only rules using the SAME guards.
   *
   * ── FOUR BOOLEANS, TWO PAIRS, AND THE OLD PAIR DID NOT CHANGE MEANING ──
   *
   *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
   *                                    workshop, or ADMIN. Unchanged, on purpose.
   *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
   *
   * ADDING fields rather than redefining the existing two is what makes this deployable
   * without a flag day, and both alternatives break in a rolling deploy:
   *
   *   - redefine `canRead` to mean member-only ⇒ every consumer still on the old field
   *     starts 403-ing facilitators the moment Team ships, before any consumer is
   *     updated.
   *   - ship the consumers FIRST ⇒ they read `canReadContent` from a Team that does not
   *     send it yet, `!!undefined` is false, and EVERY MEMBER is 403'd on every content
   *     surface.
   *
   * So: TEAM DEPLOYS FIRST, then the five consumers. An unmigrated consumer keeps today's
   * behaviour (wide — not yet narrowed, which is safe), and every consumer reads the
   * narrow field only once Team is guaranteed to send it. The five are collaboration, ai,
   * source, evaluation and workshop; routes.test.ts asserts all four booleans here, and a
   * DRIFT TEST in each consumer asserts it reads the narrow field — a forgotten consumer
   * is the only way this leaves a hole.
   *
   * The content pair costs no extra east-west hop: canReadTeamContent is one teamMembers
   * Get against a table this service owns, and it makes no cross-service call by
   * construction (see its signature note in authz.ts).
   *
   * ── `?withWorkshop=1` — THE TEAM'S WORKSHOP, OPT-IN ──
   *
   * WHY THIS ROUTE CARRIES IT. `Submission.workshopId` was `body.workshopId || null`: the
   * CALLER wrote the value the new judge-scoping guard rests on, which violates the rule that
   * a scoping value must not come from the client and makes that guard worthless. It has to be SERVER-DERIVED, and
   * only this context can derive it — `Team.workshopId` is the teams table's PARTITION KEY,
   * and the Evaluation service must not read that table. §G(a) rules the answer travels on
   * the probe Evaluation ALREADY makes, so scoping the write costs no new hop.
   *
   * OPT-IN VIA A QUERY PARAMETER rather than always present, which is a deliberate
   * REFINEMENT of §G(a) ("gains workshopId, returned only when canRead is true") and not a
   * departure from it — it is still returned only when `canRead` is true, and now only when
   * asked. Two reasons, both concrete:
   *
   *   1. This is the probe FIVE services make on almost every route they serve. Resolving
   *      the workshop is one more store read (`teams`/`id-index`), so making it
   *      unconditional would put it on collaboration, ai, source and workshop traffic that
   *      has no use for it. Same idiom, same reasoning as `?withMembers=1` and
   *      `?withCounts=1` elsewhere in this file: the expensive half is asked for.
   *   2. The four-boolean response shape is a contract five services read and a dozen tests
   *      assert exactly. Leaving it byte-identical unless asked means this change is INERT
   *      for every consumer but the one that needs it.
   *
   * `workshopId: null` WHEN `canRead` IS FALSE, per §G(a). The one caller gates on
   * `canWrite` (which implies `canRead`) before it looks at the field, so a refused caller
   * never reads it — and a caller who may not read the team has no business learning which
   * workshop it belongs to.
   *
   * THE KEY IS ALWAYS PRESENT WHEN ASKED, INCLUDING AS NULL, AND THAT IS LOAD-BEARING. An
   * older Team service ignores the parameter and omits the field, so the consumer reads
   * ABSENT as "this hop cannot answer" → 503, never as "this team has no workshop" → a row
   * written with a null scope. A null scope is exactly the legacy shape the scoring guard
   * must refuse forever afterwards, so manufacturing new ones during a rolling deploy would
   * be creating tomorrow's SUBMISSION_SCOPE_UNKNOWN. **DEPLOY ORDER IS TEAM FIRST, THEN
   * EVALUATION** — the same order and the same reason as the membership rule's.
   *
   * A THROW FROM THE LOOKUP IS DELIBERATELY NOT CAUGHT HERE. Returning null on failure
   * would report an infrastructure fault as the determined answer "this team has no
   * workshop", which is the class of defect that told a workshop's owner they were not its
   * owner (the "told the owner they were not the owner" defect). Letting it 500 is what makes the consumer read it as
   * "unavailable" and answer 503. Only callers that opted in are affected.
   */
  team.get("/teams/:teamId/access", async (c) => {
    const teamId = c.req.param("teamId");
    const { id, role } = requireIdentity(c);

    const read = await canRead(deps.members, deps.workshops, teamId, id, role, c);
    const write = read
      ? await canWrite(deps.members, deps.workshops, teamId, id, role, c)
      : false;

    // Computed INDEPENDENTLY of the pair above and deliberately not gated on `read`:
    // the two predicates answer different questions, and chaining them would couple the
    // rules the member-only split exists to keep apart. It costs one local Get.
    const readContent = await canReadTeamContent(deps.members, teamId, id, role);
    const writeContent = readContent
      ? await canWriteTeamContent(deps.members, teamId, id, role)
      : false;

    const body: Record<string, unknown> = {
      canRead: read,
      canWrite: write,
      canReadContent: readContent,
      canWriteContent: writeContent,
    };

    if (c.req.query("withWorkshop") === "1") {
      // One bounded local Query (`teams`/`id-index`, Limit 1) and only for a caller who
      // may read the team. A dangling teamId resolves to null, which the consumer reads
      // as "no such team" — see the note above for why absent and null differ.
      const team = read ? await deps.teams.getById(teamId) : null;
      body.workshopId = team?.workshopId ?? null;
    }

    return c.json(body);
  });

  /**
   * PATCH a team's SEAT CAP — the only mutable field this route accepts.
   *
   * ── WHY THIS ROUTE EXISTS AT ALL ──
   *
   * §D makes `seatCap` the team's OWN data, seeded from the workshop template at creation and
   * never re-read. That is what makes the cap enforceable without an east-west hop on the join
   * path — and it means a facilitator who wants a bigger (or smaller) team than the template
   * has no way to say so, because a WORKSHOP patch deliberately does not touch existing teams.
   * This is that way.
   *
   * ── THE ONE REFUSAL THAT MAKES THE INVARIANT HOLD ──
   *
   *   seatCap < memberCount  ⇒  409, NAMING THE COUNT.
   *
   * Without it, lowering a cap would create exactly the over-cap team §G says cannot come into
   * existence — and the remedy would have to be either grandfathering (a team allowed to
   * exceed its own cap forever) or a migration that REMOVES PEOPLE. Refusing the write makes
   * both unreachable: no migration removes anyone, because the state that would need one cannot
   * be reached. The operator's remedy is to remove a member first, which is audited.
   *
   * ⚠ THE COUNT IS NAMED IN THE MESSAGE deliberately. "You cannot set 4" is not actionable;
   * "this team has 6 members" is the fact that explains it, and the operator cannot see it from
   * the cap they tried to set.
   *
   * ⚠ REFUSED AT THE STORE, not by a read-before-write. `setSeatCap` carries
   * `memberCount <= :cap` as a ConditionExpression, so a `PATCH` racing an `admit()` cannot
   * slip through the window between reading the count and writing the cap. The read below is
   * only for the ERROR MESSAGE; the condition is the enforcement.
   *
   * ── AUTHORIZATION: THE ADMINISTRATION WRITE PREDICATE ──
   *
   * `requireTeamWrite` — an ADMIN, or a FACILITATOR who owns the workshop, and never a
   * read-only EXECUTIVE. The same guard as member removal and reactivation, and the same
   * reasoning: a team's SIZE is a property of the person↔team relationship an
   * operator administers, not content the team authored. Deliberately NOT the content
   * predicate, which would 403 the owning facilitator — the only person who should be setting
   * this.
   *
   * ⚠ A PARTICIPANT MEMBER IS REFUSED, which is worth being explicit about because
   * `requireTeamWrite` admits members: `canWrite` = `canRead` AND not read-only, and a
   * PARTICIPANT member passes `canRead`. So a team member CAN raise their own team's cap up to
   * the platform ceiling. That is accepted rather than overlooked — the ceiling is the real
   * control, the action is bounded by it, and the alternative (a staff-only gate) would mean a
   * team cannot grow without a facilitator present, which is the friction the invite-code flow
   * exists to avoid. It is called out for `senior-qa` as a boundary worth probing.
   */
  team.patch("/teams/:teamId", async (c) => {
    const teamId = c.req.param("teamId");

    const denied = await requireTeamWrite(c, deps.members, deps.workshops, teamId);
    if (denied) return denied;

    // Read TOLERANTLY, like the removal's optional reason: an unparseable body is a 400 here
    // (unlike there) because this route's entire payload is the field being set — there is no
    // "no body" case that means anything.
    const rawBody = await readOptionalJson(c);
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return c.json({ error: "a JSON object body is required" }, 400);
    }
    const seatCap = (rawBody as Record<string, unknown>).seatCap;

    // ⚠ A 400, NEVER A COERCION. `Number(body.seatCap)` would turn "8" into 8 and "" into 0,
    // and the workshop service's own `num(v, fallback)` already demonstrated where that leads:
    // a non-numeric value silently became the DEFAULT and an out-of-range one was stored
    // verbatim. `isValidMaxTeamSize` refuses anything that is not an integer in
    // [2, MAX_TEAM_MEMBERS] — including NaN, Infinity and 6.5, the last of which would make
    // `memberCount < seatCap` admit a seventh member into a six-seat team.
    if (!isValidMaxTeamSize(seatCap)) {
      return c.json(
        {
          error: `seatCap must be a whole number between 2 and ${MAX_TEAM_MEMBERS}`,
        },
        400
      );
    }

    // The full key: `teams` is (workshopId HASH, id RANGE), so the Update needs both halves.
    const team = await deps.teams.getById(teamId);
    if (!team) {
      // Reachable when the row is deleted between the authorization gate and here. The gate
      // itself does not prove the row exists — an ADMIN short-circuits it entirely.
      return c.json({ error: "Team not found" }, 404);
    }

    const updated = await deps.teams.setSeatCap(team.workshopId, teamId, seatCap);
    if (!updated) {
      // The condition refused. Re-read to report the CURRENT count rather than the one from
      // the row above, which is already stale by definition — the whole reason the condition
      // is at the store is that this value moves under us.
      //
      // Best-effort: if the re-read fails we still refuse, we just cannot name the number.
      // Refusing without the detail beats a 500 on a request that was correctly rejected.
      const fresh = await deps.teams.getById(teamId).catch(() => null);
      const memberCount = fresh?.memberCount ?? team.memberCount;
      console.warn("[team] refused a seatCap change — it is below the live member count", {
        teamId,
        requested: seatCap,
        memberCount,
      });
      return c.json(
        {
          error:
            typeof memberCount === "number"
              ? `This team has ${memberCount} member${memberCount === 1 ? "" : "s"}, so its ` +
                `size cannot be set to ${seatCap}. Remove a member first.`
              : `This team's size cannot be set to ${seatCap} because it has more members than that. ` +
                `Remove a member first.`,
          code: "SEAT_CAP_BELOW_MEMBER_COUNT",
          ...(typeof memberCount === "number" ? { memberCount } : {}),
          requested: seatCap,
        },
        409
      );
    }

    // The stored cap, echoed so a client need not re-read to render it. `memberCount` comes
    // from the pre-write row and is NOT re-read: it is not what this route changed, and one
    // more Query on a write path to refresh a number the client did not ask about would be
    // waste. It may be stale by a join, which is true of any count the moment it is returned.
    return c.json({ success: true, seatCap, memberCount: team.memberCount });
  });

  /**
   * THERE IS NO ADMIN CONTENT ROUTE, AND THAT IS THE DECISION — NOT AN OMISSION.
   *
   * An audited ADMIN break-glass route (`POST /teams/:teamId/content-access`) was built here
   * and then REMOVED: investigations are an EXECUTIVE's job, not an admin's. Recorded at the site where a reader will look for it, because
   * "why can an admin not read a team's content for an investigation?" is a question this
   * file will be asked, and the answer is a deliberate rule rather than a gap.
   *
   * INVESTIGATION IS AN EXECUTIVE'S JOB. EXECUTIVE is a team-scoped role that CAN hold a
   * membership row, and `canWriteTeamContent` refuses a read-only role while
   * `canReadTeamContent` admits it — so an executive who is a MEMBER of a team reads that
   * team's content and can alter none of it. That is narrower than break-glass was: the
   * access is scoped to one team by a durable membership row, rather than an ambient
   * platform-wide power gated only on a written reason.
   *
   * THE OPERATIONAL CONSEQUENCE, stated rather than smoothed over: a team with NO EXECUTIVE
   * member has nobody who can read its content for an investigation. Staffing a team with an
   * executive is now the control, and it is an operational requirement.
   */

  // ⚠ ROSTER ADMINISTRATION, NOT A TEAM WRITE. This was `requireTeamWrite`, and
  // the comment here asserted that guard "403s a read-only EXECUTIVE" — true, and beside the
  // point, because it ALSO admitted every ordinary PARTICIPANT member: `canRead`'s first
  // branch is an unconditional membership lookup and only EXECUTIVE is read-only. So any
  // teammate could remove any other, against ROLES.md:126 and against this route's own
  // description of its guard. `requireTeamAdministration` is the staff-and-owns branch alone —
  // see its note in authz.ts for why narrowing `canRead` in place was not an option.
  team.delete("/teams/:teamId/members/:userId", async (c) => {
    const teamId = c.req.param("teamId");
    const userId = c.req.param("userId");
    const { id: actorId, role: actorRole } = requireIdentity(c);

    const denied = await requireTeamAdministration(c, deps.workshops, teamId);
    if (denied) return denied;

    // An OPTIONAL operator note, for the audit entry. Read from the BODY rather than a
    // query parameter: it is free text that may name a person, and a query string lands
    // in gateway access logs and browser history, neither of which should hold it.
    //
    // Read AFTER the authorization gate and tolerantly: a DELETE with no body at all is
    // the normal case (every existing caller sends none), so a parse failure must be an
    // absent reason and never a 400 — refusing the removal over an unparseable optional
    // note would break the callers this route already has.
    const rawBody = await readOptionalJson(c);
    const reason = normalizeAuditReason(
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).reason
        : undefined
    );

    // Read the team BEFORE the delete, for the audit entry's teamName.
    //
    // Denormalised into the entry rather than resolved when the trail is read: a team can
    // be renamed or deleted, and an audit line that says "removed from (deleted team)" has
    // lost the fact it existed to record. Best-effort — a missing name must not stop the
    // removal.
    //
    // ⚠ IT NOW ALSO SUPPLIES THE SEAT LEDGER'S KEY. `teams` is keyed
    // (workshopId HASH, id RANGE), so freeing the seat needs `team.workshopId` — which makes
    // this read load-bearing for the DECREMENT, not only for a cosmetic audit field. It stays
    // BEST-EFFORT anyway, and the failure mode is stated where it is handled below: a removal
    // an operator asked for must never be blocked by bookkeeping.
    const team = await deps.teams.getById(teamId).catch(() => null);

    // WHEN THEY JOINED, and WHETHER THERE IS ANYTHING TO REMOVE.
    //
    // `getIncludingInactive` — the DANGEROUS-BY-NAME variant — and that is required here
    // rather than convenient: `get()` answers null for an already-INACTIVE row, so using it
    // would make a repeated removal look like a removal of a never-member and write a SECOND
    // MEMBER_REMOVED entry for one withdrawal. This is not an authorization read (the write
    // guard above already decided that); it is asking whether a row exists in either state.
    //
    // `joinedAt` is copied into the audit entry below. The row now survives the removal so
    // this is no longer the only place it exists, but the entry pins joinedAt AS AT THIS
    // REMOVAL — a person removed twice has one row carrying only the LATEST join. See
    // AuditEntryWrite.joinedAt.
    //
    // Best-effort on the READ: a store failure must not stop a removal an operator asked for.
    // Absent is reported as absent rather than invented.
    const existingMembership = await deps.members
      .getIncludingInactive(teamId, userId)
      .catch(() => null);

    // The removed person's ADDRESS, resolved BEFORE the delete, because the invitation that
    // admits them is keyed on (teamId, EMAIL) and this route is given a SUB.
    //
    // From the local users read-model — the same event-synced projection loadTeamMembers
    // enriches a roster from — and NOT from a cross-service read of Identity's users table,
    // which this context must never touch (see domain.ts's header). A read-model row that
    // has not landed yet, or carries no email, means the revocation below is
    // UNADDRESSABLE: reported, never silently skipped.
    //
    // Best-effort on the READ so a read-model failure cannot fail a removal an operator
    // asked for — the access change is the effect that matters and it happens either way.
    const removedEmail = (
      await deps.users.get(userId).catch(() => null)
    )?.email;

    // ── DEACTIVATE, KEEPING THE ROW (owner: "keep the user with inactive state for audit
    //    and can be make active later") ──────────────────────────────────────────────
    //
    // THIS WAS A HARD DELETE, and the reason it was is worth keeping because it is the
    // objection this design had to answer rather than dismiss: a soft-delete flag "needs
    // every reader to filter it, and missing one silently restores access". True — and
    // services/docs/src/authz.ts reads this table DIRECTLY, bypassing this service
    // entirely (it runs in a private subnet with no route to our API), so it could not even
    // be fixed from here.
    //
    // WHAT CHANGED IS WHERE THE FILTER LIVES, not whether one is needed. It is in the
    // REPOSITORY, once: `members.get()` returns NULL for an inactive row and `listByTeam()`
    // omits it. Every authorization path already treats null as "not a member", so an
    // INACTIVE membership grants nothing at every call site with ZERO changes to any of them —
    // and forgetting to handle inactive DENIES rather than grants. Docs, the one bypassing
    // reader, checks the status itself and is pinned by a test. See the note on
    // TeamMemberRepository in domain.ts.
    //
    // REACTIVATION IS WHY THE ROW MUST SURVIVE. An audit entry is a historical record of an
    // act; it cannot be "reactivated", and the trail is append-only by IAM so it cannot be
    // amended either. Current state has to live on the row. The trail still records WHO DID
    // WHAT; the row records WHAT IS TRUE NOW.
    //
    // CONDITIONAL AT THE STORE (`#status <> :inactive`), so a repeated removal is a no-op
    // there rather than re-stamping `removedAt` — see the repository. `false` here means the
    // row was already INACTIVE or absent, which is what makes the audit write below skip.
    //
    // NOT best-effort: this IS the access change the operator asked for. A failure throws and
    // Hono answers 5xx, because reporting `success: true` on a removal that did not happen
    // would leave someone with full access and nobody looking for them. Everything after this
    // line is best-effort BECAUSE this line succeeded.
    //
    // ── AND IT FREES THE SEAT, IN THE SAME TRANSACTION ──
    //
    // `team?.workshopId ?? ""` is the honest expression of a best-effort read feeding a
    // required key. An EMPTY workshopId cannot match any `teams` item, so the ledger item's
    // condition fails and the repository falls back to flipping the ROW ALONE — the removal
    // takes effect and the team's `memberCount` over-counts by one until reconciled, which the
    // repository logs and the drift metric reports.
    //
    // THAT IS THE DELIBERATE DIRECTION TO BE WRONG IN, and it is worth being explicit because
    // the alternative looks tidier: refusing the removal when the team row cannot be read would
    // mean a transient store blip leaves somebody with access an operator has decided to
    // withdraw, with the operator told it failed. An over-count refuses one join that could
    // have been allowed. One of those is a security outcome and the other is an inconvenience.
    const deactivated = await deps.members.deactivate(
      teamId,
      userId,
      actorId,
      actorRole,
      team?.workshopId ?? ""
    );

    // ── REVOKE THE INVITATION THAT ADMITS THEM ──────────────────────────────────
    //
    // Otherwise the row is a STANDING PERMISSION TO RETURN. The membership row is gone and
    // the removal is audited, but the invitation survives with `status: ACCEPTED` — and
    // POST /teams/join used to accept any existing row, so the removed person re-presented
    // the team's invite code and re-created their own membership. Verified end to end
    // against the deployed stack; the join gate above is the other half of the fix, and both
    // are needed (that gate refuses a spent row, this is what makes the row spent).
    //
    // PRECEDENT, deliberately reused rather than reinvented: DISABLING A USER ALREADY
    // REVOKES THEIR PENDING INVITATIONS, for exactly this reason — see
    // services/user-access/src/routes.ts (the "WHY DISABLING REVOKES PENDING
    // INVITATIONS" note and revokeLiveInvitations). Same shape here: the effect that matters
    // has already happened, so this step is best-effort and REPORTED rather than allowed to
    // fail the request, and re-admission is an EXPLICIT ACT by someone with grant authority
    // — never a side effect of anything.
    //
    // FLIPPED TO A TERMINAL STATUS, NOT DELETED (by design), which is where this
    // differs from the disable path. That path deletes because a PENDING row is nothing but
    // a live credential; here the row is also the record of who invited this person and when
    // they accepted — the same reason the revoke route refuses to delete an ACCEPTED row —
    // and the former-members view derives `joinedAt` from that `acceptedAt`. Deleting would
    // erase history to fix an access bug.
    //
    // NO NEW AUDIT ACTION. The MEMBER_REMOVED entry written below already carries the actor,
    // their role at the time, the team and the reason; the revocation is a consequence of
    // that one act at that one instant, not a separate administrative decision, and the row
    // itself records `revokedAt`/`revokedBy`. A second action would put two entries in the
    // trail for one operator click and make every reader de-duplicate them.
    let invitationRevoked = false;
    // False when we could not establish that no live grant remains — an address we could
    // not resolve, or a store failure. Distinguished from `invitationRevoked` because "there
    // was nothing to revoke" and "we could not check" are different facts and only one of
    // them is safe.
    let invitationRevokeComplete = true;
    if (!removedEmail) {
      invitationRevokeComplete = false;
      console.error(
        "[team] REMOVED a member but could not resolve their address — an invitation may still admit them",
        { teamId, subjectId: userId, actorId }
      );
    } else {
      try {
        invitationRevoked = await deps.invitations.markRevoked(
          teamId,
          removedEmail,
          actorId
        );
        // A FALSE here is BENIGN and does not spoil completeness: it means there was no
        // invitation row for this member on this team (they joined before invitations were
        // required), or it was already REVOKED — which is what makes a repeated removal
        // idempotent. Either way no live grant remains.
      } catch (err) {
        invitationRevokeComplete = false;
        // LOUD, because the guarantee this step exists to provide has not been met: the
        // membership row is gone but a live invitation may still let this person rejoin.
        // Ids only — never the address.
        console.error(
          "[team] the invitation revoke FAILED — the removed member may be able to rejoin",
          {
            teamId,
            subjectId: userId,
            actorId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }

    // WHO DID THIS. Owner: "for both we need audit trail like whose action was that".
    // Until now this route deleted the row and published `member.left` carrying only
    // {teamId, userId} — NO ACTOR — so the question was unanswerable from anywhere. The
    // membership row was the only trace the person had ever been on the team, and the
    // delete removed it.
    //
    // AWAITED but never allowed to fail the removal: the access change has already happened,
    // so throwing here would have the operator retry a completed action, unsure whether
    // anything happened. The repository logs and returns false; `audited` tells the caller what
    // is known. A false here is worth an alarm — it means an access change happened with no
    // record of who made it.
    //
    // ONLY WHEN THIS CALL ACTUALLY WITHDREW ACCESS (`deactivated`). One withdrawal, one entry:
    // a retried removal of an already-INACTIVE member changed nothing, and an entry for it
    // would claim a second removal that did not occur — which the former-members view reads as
    // the most recent one and would render with the wrong actor and timestamp. Same judgement
    // as the reactivation route's skip, and the same reason the store makes both flips
    // conditional rather than trusting a read-before-write.
    const audited = deactivated
      ? await deps.audit.record({
          subjectId: userId,
          action: "MEMBER_REMOVED",
          actorId,
          actorRole,
          teamId,
          teamName: team?.name,
          reason,
          // Copied off the row read above. Spread-or-omit rather than `joinedAt: undefined`:
          // the row must carry NO attribute when the membership could not be read, so a reader
          // can tell "unknown" from a value.
          ...(existingMembership?.joinedAt
            ? { joinedAt: existingMembership.joinedAt }
            : {}),
        })
      : // Nothing changed, so there is nothing to record — and `audited: false` here means
        // "no entry was needed", NOT "an entry was lost". The two are distinguished by
        // `removed` in the response below.
        false;

    // THE ALARM THE COMMENT ABOVE RELIES ON — it did not originally exist.
    // Watched by UnauditedAccessChangeAlarm in the all-in-one template.
    //
    // INSIDE `if (deactivated)`, AND THAT PLACEMENT IS THE WHOLE CORRECTNESS OF IT. On the
    // no-op branch `audited` is ALSO false — a retried removal of an already-INACTIVE
    // member writes no second entry by design — so emitting outside this guard would fire
    // the alarm on a double-clicked remove button, which is harmless, frequent, and
    // exactly how an alarm becomes noise nobody reads. Only a REAL withdrawal that went
    // unrecorded is the signal.
    //
    // A 0 is emitted on the audited path too, so the metric exists in a healthy account
    // and "no data" stays distinguishable from "no failures".
    if (deactivated) {
      emitAccessAuditMetric({
        action: "MEMBER_REMOVED",
        audited,
        subjectId: userId,
        actorId,
        teamId,
        source: "team",
      });
    }

    // PUBLISHED ONLY ON A REAL CHANGE, for the same reason the audit entry is: `member.left`
    // asserts the person left, and consumers may act on it (a notification, a projection
    // decrement). Re-publishing it for a retried removal that changed nothing would double any
    // such effect. Kept AFTER the audit write so the durable record precedes the notification.
    if (deactivated) {
      await deps.events.publish({
        source: "team-service",
        type: "member.left",
        // actorId added: a consumer could not previously tell a self-departure from a
        // removal by staff, which are different events with the same shape.
        detail: { teamId, userId, actorId },
      });
    }

    return c.json({
      success: true,
      /**
       * TRUE when THIS call withdrew the access — the membership went ACTIVE → INACTIVE.
       *
       * FALSE means there was nothing to withdraw: already removed, or never a member. Both
       * are a 200, because the caller's intent ("this person must not have access") holds
       * either way and an operator retrying a removal should not be told it failed. This flag
       * is what distinguishes that from a first removal, and it is also why `audited: false`
       * on such a call means "no entry was needed" rather than "an entry was lost".
       *
       * DELIBERATELY NOT A 404 for a never-member: the route is idempotent by intent, and a
       * 404 would make the portal's remove button error on a double-click.
       */
      removed: deactivated,
      audited,
      /**
       * TRUE when this call withdrew the invitation that admitted the removed person.
       * FALSE is the NORMAL case for a member who holds no invitation row at all, so it is
       * not on its own a problem — read it together with the flag below.
       */
      invitationRevoked,
      /**
       * FALSE means we could NOT establish that no live grant remains: the address could
       * not be resolved, or the store write failed. Surfaced rather than folded into the
       * count for the same reason user-access surfaces `invitationsRevokeComplete` — the
       * whole point of the step is that no un-redeemed credential is left behind, and an
       * operator removing someone needs to know when that is not guaranteed. Worth an
       * alarm; not a failure, because the removal itself took effect.
       */
      invitationRevokeComplete,
    });
  });

  /**
   * REACTIVATE a removed member — restore the membership the removal deactivated.
   *
   * Owner: "we need to keep the user with inactive state for audit and can be make active
   * later". This is the "later". It is the NEW FACT THAT REVERSES A REMOVAL, which is why the
   * removal had to stop being a hard delete: an audit entry is a historical record of an act
   * and cannot be reactivated, and the trail is append-only by IAM so it cannot be amended
   * either. Current state lives on the membership row; the trail records who did what.
   *
   * ── AUTHORIZATION: THE SAME PEOPLE WHO MAY REMOVE MAY REACTIVATE ──
   *
   * `requireTeamAdministration` — byte-for-byte the guard on the DELETE above: an ADMIN or a
   * FACILITATOR, and in either case only one who OWNS this team's workshop. Deliberately the
   * same and not narrower: removal and its reversal are one operator capability, and a rule
   * where staff can withdraw access but not restore it would make every mistaken removal
   * permanent and un-fixable by the person who made it.
   *
   * ⚠ THIS WAS `requireTeamWrite`, and the sentence above was already written
   * as though it were true. It was not: that predicate admits any non-EXECUTIVE MEMBER, so an
   * ordinary PARTICIPANT could reactivate a teammate the owning facilitator had just removed —
   * undoing a staff decision from inside the team. Both halves of the pair moved together,
   * because a guard on the removal alone would leave the reversal as the bypass.
   *
   * Deliberately NOT the CONTENT predicate. The person↔team RELATIONSHIP is
   * administrable while the team's authored content is member-only, and this is a relationship
   * change — the same axis as the removal it reverses. A content gate would 403 the workshop's
   * owning facilitator, who is precisely the person who performed the removal.
   *
   * ── `mayHoldTeamMembership` IS CONSULTED, AND IT IS NOT REDUNDANT ──
   *
   * Checked against the SUBJECT's platform role, not the caller's. The row being
   * restored was written at some point in the past, and requirement (b) — an ADMIN,
   * FACILITATOR or JUDGE may NEVER hold a team-membership row — was enforced on the three
   * WRITE paths at the time. A row predating that change, or belonging to someone whose role
   * has since been RAISED to facilitator, is exactly the legacy case this route could otherwise
   * launder back into a live membership. A membership row is the WHOLE of team
   * content authorization, so restoring one for a staff account hands them the ambient content
   * access the member-only rule removed — in a form no role check downstream can see.
   *
   * ⚠ THE SUBJECT'S ROLE IS RESOLVED BY `listByEmail` ACROSS EVERY SCOPE, over EVERY row
   * regardless of status or expiry, collapsed by PLATFORM_ROLE_PRECEDENCE. A team-keyed `get`
   * made this gate DEAD CODE — staff invitations only ever exist at PLATFORM scope — and a
   * status filter would make it dead again, because the removal this route reverses flips the
   * subject's own row to REVOKED. The full reasoning is at the gate; read it before touching
   * either the key or the filter.
   *
   * ── IDEMPOTENCY AND THE 404, WHICH ARE DIFFERENT ANSWERS ──
   *
   *   INACTIVE row → flipped to ACTIVE, audited. 200.
   *   ACTIVE row   → 200, `reactivated: true`, and NO SECOND AUDIT ENTRY. The caller's intent
   *                  ("this person should have access") already holds, and an entry would
   *                  claim a restoration that did not happen.
   *   NO ROW       → 404. NOT a silent create: re-admitting someone who was never on the team
   *                  is an INVITATION, and the store's `attribute_exists` refuses the upsert
   *                  independently so this cannot be bypassed by a caller racing the read.
   *
   * The flip is CONDITIONAL AT THE STORE, like the invitation flips, so two concurrent calls
   * cannot both "succeed" — exactly one gets `true` and writes the single audit entry.
   */
  team.post("/teams/:teamId/members/:userId/reactivate", async (c) => {
    const teamId = c.req.param("teamId");
    const userId = c.req.param("userId");
    const { id: actorId, role: actorRole } = requireIdentity(c);

    const denied = await requireTeamAdministration(c, deps.workshops, teamId);
    if (denied) return denied;

    // An OPTIONAL operator note, for the audit entry. Same treatment as the removal's: read
    // from the BODY rather than the query string (free text that may name a person must not
    // land in gateway access logs or browser history), read AFTER the authorization gate, and
    // read TOLERANTLY so a missing or malformed optional field cannot fail the operation.
    const rawBody = await readOptionalJson(c);
    const reason = normalizeAuditReason(
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).reason
        : undefined
    );

    // THE DANGEROUS-BY-NAME READ, and this is one of its two legitimate callers: the whole
    // question is whether a DEACTIVATED row exists, which `get()` deliberately cannot answer
    // (it returns null for exactly those). It is NOT used as an authorization source — the
    // write guard above already decided that, and nothing below treats this row as a grant.
    const existing = await deps.members.getIncludingInactive(teamId, userId);
    if (!existing) {
      // 404, not a create. Re-admitting a never-member is an invitation, and inventing a
      // membership row here would bypass every invitation gate — including the workshop-scope
      // and role checks that decide whether this person may be on a team at all.
      return c.json(
        {
          error:
            "This person has no membership on this team. Invite them instead of reactivating.",
        },
        404
      );
    }

    // ── REQUIREMENT (b), CHECKED ON THE SUBJECT — a legacy row must not be
    //    laundered back into a live staff membership ─────────────────────────────────
    //
    // An ADMIN, FACILITATOR or JUDGE may NEVER hold a team-membership row, because
    // that row is the WHOLE of team-content authorization. Requirement (b) is enforced
    // on the three membership WRITE paths, and THIS IS A FOURTH — it makes a row ACTIVE, which
    // is the effect those three exist to prevent.
    //
    // ⚠ THE SUBJECT'S ROLE IS NOT AVAILABLE AS A VERIFIED CLAIM, and that is the honest
    // constraint here. `mayHoldTeamMembership` is documented as taking the VERIFIED TOKEN ROLE
    // and never a stored value — but the subject is not the caller, so there is no token for
    // them. The local users read-model deliberately DROPS `role` (see toUserView in
    // user-projection: "copying it into a read-model invites a reader to authorize against a
    // stale copy"), and reading Identity's users table is forbidden to this context.
    //
    // So the best LOCAL evidence is the invitations issued to their ADDRESS — resolved
    // ACROSS EVERY SCOPE (see below), with the service-wide `|| "PARTICIPANT"` default. Used to
    // REFUSE and never to grant, which is the safe direction for evidence: a row saying
    // FACILITATOR is enough to stop a restoration, while a row saying nothing does not
    // authorize one — the write guard above did that.
    //
    // ⚠ WHAT THIS DOES NOT CLOSE, stated rather than implied: if someone's role was RAISED
    // OUT OF BAND — the Cognito console, `create-admin.mjs --force` — no invitation row records
    // it, so the collapse below still says PARTICIPANT and this check allows the restoration.
    // Closing it needs the subject's CURRENT role, which means an east-west hop to Identity: a
    // new cross-service dependency on a write path, not taken here. The residual case is a
    // pre-existing membership-rule violation either way — such a person's ORIGINAL row was equally
    // illegitimate, and the rule already states that hand-deletion, not code, is the remedy. THE REAL
    // CLOSURE IS A SCHEDULED RECONCILIATION DETECTOR (a job that finds membership rows whose
    // holder's Cognito group may not hold one), which is a revisit-later item and deliberately
    // not this change.
    //
    // ── WHY AN UNRESOLVABLE ADDRESS IS A 503 AND AN ABSENT ROW IS NOT ────────────────
    //
    // THE JUSTIFICATION IS TRANSIENCE, NOT "no evidence". An earlier version of this comment
    // said "a grant decided on no evidence is a grant decided on nothing", which was wrong on
    // its own terms — twenty lines below it, a subject with no invitation row IS granted. The
    // two cases are different KINDS of unknown:
    //
    //   ADDRESS UNRESOLVABLE  the lookup could not be PERFORMED. The usual cause is a lagging
    //                         read-model projection, so a RETRY CHANGES THE ANSWER — which is
    //                         what makes 503 + Retry-After truthful rather than a stall.
    //   NO INVITATION ROW     the lookup COMPLETED and returned a definite negative. A 503 here
    //                         would be PERMANENT for that subject and `Retry-After` would be a
    //                         lie: every retry answers identically, and the operator would be
    //                         told to wait for something that will never change.
    //
    // So the absent-row path stays a 200 (and is COUNTED — see the warn below the gate), and
    // this one refuses. Same underlying read-model gap the removal reports as
    // `invitationRevokeComplete: false`.
    const subjectEmail = (await deps.users.get(userId).catch(() => null))?.email;
    if (!subjectEmail) {
      console.warn(
        "[team] refused a reactivation — the subject's address could not be resolved, so their role is unknown",
        { teamId, subjectId: userId, actorId }
      );
      return c.json(
        {
          error:
            "This person's account details are unavailable, so their membership cannot be restored right now. Try again shortly.",
          code: "SUBJECT_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // ── THE LOOKUP IS BY EMAIL ACROSS EVERY SCOPE, AND THAT IS THE FIX ────────────────
    //
    // This gate was DEAD CODE. It resolved the subject's role with
    // `invitations.get(teamId, subjectEmail)` — keyed on the TEAM being reactivated — but the
    // invitation route REFUSES to write a team-scoped invitation for an ADMIN, FACILITATOR or
    // JUDGE (gate 3's `mayHoldTeamMembership(requested)` check, 400), and `teamId` is the
    // invitations table's PARTITION KEY. So those rows exist ONLY at
    // PLATFORM_INVITATION_TEAM_ID. The team-keyed lookup therefore ALWAYS returned null for
    // exactly the population this gate exists to refuse, `|| "PARTICIPANT"` was applied, and
    // reactivating a FACILITATOR/JUDGE/ADMIN subject answered 200 and wrote MEMBER_RESTORED —
    // where requirement (b) requires 403. That membership row IS team-content
    // authorization, including in `services/docs`, which reads this table directly and
    // cannot be corrected from this service.
    //
    // `listByEmail` (the email-index GSI, already used by five routes here) and NOT a two-scope
    // `get`: two gets would still miss a LEGACY VIOLATING ROW at a third `teamId`, which
    // may exist — and a gate that covers the two scopes we happen to know
    // about is the same class of bug as the one being fixed.
    //
    // ⚠⚠ EVERY ROW IS WEIGHED — NO STATUS FILTER, NO EXPIRY FILTER. THIS IS DELIBERATE AND IT
    // IS THE MOST MISREADABLE LINE IN THIS ROUTE, so do not "align" it with
    // `resolveRoleFromInvitations` (user-access/src/domain.ts), which drops REVOKED and expired
    // rows. That function decides a GRANT — a withdrawn grant must not confer a role — so its
    // safe direction is to IGNORE dead rows. This decides a REFUSAL, which INVERTS the safe
    // direction: a REVOKED FACILITATOR invitation is still evidence that this subject is staff,
    // and ignoring it would let the refusal be evaded by the row simply being dead.
    //
    // CRITICALLY: THE REMOVAL ROUTE FLIPS THE SUBJECT'S OWN ROW TO REVOKED (markRevoked, in the
    // DELETE above). Every subject this route serves has been removed, so a status filter here
    // would discard the most likely row of all and make this gate dead again for precisely the
    // population it exists to protect against. An expiry filter fails the same way: invitations
    // lapse in 24h and a removal being reversed weeks later is normal.
    let subjectInvitations;
    try {
      subjectInvitations = await deps.invitations.listByEmail(subjectEmail);
    } catch (err) {
      // TRANSIENT, so 503 for the same reason the unresolvable address is: the lookup could not
      // be PERFORMED, and a retry changes the answer. Never a 200 — the store failing is not
      // evidence that the subject is a participant.
      console.warn(
        "[team] refused a reactivation — the subject's invitations could not be read, so their role is unknown",
        {
          teamId,
          subjectId: userId,
          actorId,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }
      );
      return c.json(
        {
          error:
            "This person's account details are unavailable, so their membership cannot be restored right now. Try again shortly.",
          code: "SUBJECT_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // BOUNDED, AND OVERFLOW IS A 503 RATHER THAN A TRUNCATION. Truncating a refusal gate's
    // evidence can silently drop the one row that would have refused, so "more rows than we
    // will weigh" must not resolve to "nothing found" — see MAX_SUBJECT_INVITATIONS. It is also
    // the honest answer: `listByEmail` does not follow the store's own pagination, so past this
    // point we do not know what we are not seeing.
    if (subjectInvitations.length > MAX_SUBJECT_INVITATIONS) {
      console.warn(
        "[team] refused a reactivation — too many invitations to weigh, so the subject's role is undetermined",
        {
          teamId,
          subjectId: userId,
          actorId,
          rows: subjectInvitations.length,
          max: MAX_SUBJECT_INVITATIONS,
        }
      );
      return c.json(
        {
          error:
            "This person's account details are unavailable, so their membership cannot be restored right now. Try again shortly.",
          code: "SUBJECT_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // Collapsed by PLATFORM_ROLE_PRECEDENCE — HIGHEST PRIVILEGE WINS, never newest. A subject
    // holding a PARTICIPANT row for this team and a FACILITATOR row at platform scope is
    // STAFF, and the refusal has to see the more privileged of the two. Absent platformRole
    // reads as PARTICIPANT, the same default this service applies everywhere else it reads the
    // field (the invite gates, the revoke gate, the directory column) — so a legacy member
    // whose row predates the field stays restorable.
    const subjectRole = highestPlatformRole(subjectInvitations);
    if (!mayHoldTeamMembership(subjectRole)) {
      // 403, not the invitation route's 400: that one names a wrong SCOPE the caller can
      // correct by inviting to the platform instead, whereas there is no corrected form of
      // this request — the account may not hold a team membership at all.
      console.warn(
        "[team] refused a reactivation — the subject's role may not hold team membership",
        { teamId, subjectId: userId, actorId, subjectRole }
      );
      return c.json(
        {
          error:
            "This person's role is platform-wide and cannot hold team membership. They keep their access without being a team member.",
        },
        403
      );
    }

    // ── NO ROW AT ANY SCOPE: STILL A 200, AND NOW COUNTABLE ───────────────────────────
    //
    // REFUSING HERE WAS CONSIDERED AND REJECTED, on what a refusal gets wrong rather than on
    // convenience:
    //
    //   IT DETECTS ALMOST NOTHING. Every membership row on this platform was written through a
    //   path that already checked `mayHoldTeamMembership` against the VERIFIED TOKEN ROLE, and there is no role-change route on the platform. So an absent
    //   invitation is overwhelmingly an ordinary member — one who joined by invite code before
    //   invitations were required, or whose PENDING row was DELETED when their account was
    //   disabled, or whose row was deleted by the revoke route.
    //   THE FALLBACK IS WORSE THAN THE PROBLEM. With no reactivation, re-admitting the person
    //   means re-inviting them — which goes through `members.put`, and that REPLACES THE ROW
    //   WHOLE, destroying the preserved team role (a LEAD comes back a BUILDER) that the soft
    //   delete exists to protect. It also requires the SUBJECT to sign in, so an operator cannot
    //   do it on their behalf during an incident.
    //
    // BUT IT IS NOT SILENT. The uncovered case — an out-of-band promotion via the Cognito
    // console or `create-admin.mjs --force`, which writes no invitation row — is real, and its
    // remedy is hand-deletion of the membership row. This counter is what makes
    // one findable. It is a structured warn with a STABLE EVENT NAME an alarm can be built on by
    // log-metric filter.
    //
    // A REAL EMF HELPER NOW EXISTS — `emitMetric` in service-shared, added for the unaudited
    // access-change alarm below — so the "if a metrics helper lands, move this to it" note that
    // used to be here is discharged in principle but DELIBERATELY NOT ACTED ON in this change.
    // Three tests assert this exact console.warn shape (`metric` field, ids only), and rewriting
    // an unrelated counter's emission while shipping an alarm would mean re-pointing assertions
    // that are not what this change is about. Kept as a follow-up so the migration is reviewed on
    // its own; the name does not change either way.
    //
    // IDS ONLY — no email, no team name, no unbounded dimension. `metric`
    // is the dimension-free counter name; the ids are log fields for the investigation, not
    // metric dimensions.
    if (subjectInvitations.length === 0) {
      console.warn("[team] reactivation: the subject's role is UNEVIDENCED — no invitation at any scope", {
        metric: "ReactivateSubjectRoleUnevidenced",
        teamId,
        subjectId: userId,
        actorId,
      });
    }

    // Read ONCE, before the flip, and used for the audit entry's `teamName`, the event's
    // `workshopId` AND the seat ledger's key — three uses, one Query, on a write path where a
    // second read of the same row would be pure waste.
    //
    // ⚠ NO LONGER MERELY COSMETIC. The restoration is an ADMISSION, so it
    // consumes a seat and the ledger Update needs `workshopId` — see the refusal below for what
    // happens when this read comes back empty. Unlike the removal, a missing team row here must
    // NOT be papered over: a removal that cannot find its team still has an access change to
    // apply, whereas a restoration that cannot check the cap would be GRANTING access without
    // the limit that governs it, which is the direction that must fail closed.
    const teamRow = await deps.teams.getById(teamId).catch(() => null);

    if (!teamRow) {
      // 503 and NO FLIP. TRANSIENT — the row exists (this route's whole subject is a membership
      // on it) so a failed read is a store problem a retry resolves, which makes `Retry-After`
      // truthful. Reusing SUBJECT_UNAVAILABLE's shape and status, which this route already uses
      // for exactly this class of "could not be performed" failure.
      //
      // FAILING CLOSED IS THE POINT: without the team row there is no `seatCap` to check, and
      // restoring somebody into a team that may be full is precisely what §C refuses.
      console.warn(
        "[team] refused a reactivation — the team could not be read, so its seat cap is unknown",
        { teamId, subjectId: userId, actorId }
      );
      return c.json(
        {
          error:
            "This team's details are unavailable, so the membership cannot be restored right now. Try again shortly.",
          code: "TEAM_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }

    // CONDITIONAL AT THE STORE, and now CAP-CHECKED in the same transaction:
    // restoring somebody into a full team is refused rather than squeezed in.
    //
    //   "admitted"       the flip happened and a seat was consumed.
    //   "already-member" the row was already ACTIVE. There is no "no row" case left, because
    //                    the read above 404'd it and the store's `attribute_exists` refuses an
    //                    upsert even if the row vanished between the two.
    //   "full"           refused — see below.
    //
    // NOT best-effort: this route's entire purpose IS the flip, so a store failure must reach
    // the caller as a 5xx rather than being reported as a restoration that did not happen.
    const outcome = await deps.members.reactivate(
      teamId,
      userId,
      actorId,
      teamRow.workshopId
    );

    if (outcome === "full") {
      // 409 NAMING THE CAP, because the operator CAN act on this: raise the team's seatCap
      // (PATCH /teams/:teamId), or remove somebody else first. That is why the message is
      // specific where the participant-facing join refusal is not.
      //
      // NO AUDIT ENTRY AND NO EVENT: nothing changed. The row is still INACTIVE and the person
      // still has no access, so recording a restoration would be a false fact in the trail.
      console.warn(
        "[team] refused a reactivation — the team is at its seat cap",
        {
          teamId,
          subjectId: userId,
          actorId,
          seatCap: teamRow.seatCap,
          memberCount: teamRow.memberCount,
        }
      );
      return c.json(
        {
          error:
            `This team is full (${teamRow.seatCap ?? MAX_TEAM_MEMBERS} members), so this ` +
            `membership cannot be restored. Raise the team's size or remove another member first.`,
          code: "TEAM_FULL",
        },
        409
      );
    }

    // TRUE only when THIS call performed the flip — the same meaning the previous boolean
    // carried, so every branch below is unchanged. Kept as a named boolean rather than
    // comparing the outcome three times, because "did this call change anything" is the
    // question the audit entry, the metric and the event all ask.
    const flipped = outcome === "admitted";

    // ONE RESTORATION, ONE ENTRY. A second call changed nothing, so an entry for it would
    // record a restoration that did not occur — and `GET /audit/users/:userId` is read during
    // investigations, where a duplicated grant is a misleading fact. Same judgement as the
    // removal's audit skip.
    //
    // AWAITED but never allowed to fail the reactivation: the access change has already
    // happened, so throwing here would have the operator retry a completed action. `audited`
    // reports what is known — false after a real flip is worth an alarm, because access was
    // GRANTED with no record of who granted it.
    const audited = flipped
      ? await deps.audit.record({
          subjectId: userId,
          action: "MEMBER_RESTORED",
          actorId,
          actorRole,
          teamId,
          // Denormalised for the same reason the removal denormalises it: a team can be
          // renamed or deleted, and an entry saying "restored to (deleted team)" has lost the
          // fact it recorded. Non-optional now — the route refuses above when the team cannot
          // be read, because the seat cap has to be checked before access is granted.
          teamName: teamRow.name,
          reason,
          // WHICH membership was restored, not when the restoration happened (that is
          // `occurredAt`). Spread-or-omit so absent stays absent rather than becoming a value.
          ...(existing.joinedAt ? { joinedAt: existing.joinedAt } : {}),
        })
      : false;

    // THE ALARM THE COMMENT ABOVE RELIES ON — it did not originally exist, which is what made an untraceable GRANT the platform's only known-open
    // defect. Watched by UnauditedAccessChangeAlarm in the all-in-one template.
    //
    // INSIDE `if (flipped)`, for the same reason as the removal's and it matters MORE here:
    // reactivation is the route an operator retries, and `audited: false` on an
    // already-ACTIVE member means "no entry was needed" (see the response field's comment).
    // Emitting there would page on a duplicate click.
    //
    // RECOVERABLE WHEN IT DOES FIRE, and the alarm's runbook says so: reactivate() writes
    // `reactivatedBy` onto the membership row in the SAME UpdateCommand as the status flip
    // (repository.dynamo.ts) and it ran above, before the audit call — so the actor
    // survives on the row even when the trail entry does not. That is NOT true of the
    // platform disable/enable path in user-access, which is why the runbook has two halves.
    if (flipped) {
      emitAccessAuditMetric({
        action: "MEMBER_RESTORED",
        audited,
        subjectId: userId,
        actorId,
        teamId,
        source: "team",
      });
    }

    // ── THE INVITATION STAYS REVOKED, AND THAT IS DELIBERATE ──────────────
    //
    // Nothing here touches the invitation the removal withdrew. Confirmed deliberately:
    // REACTIVATION IS THE GRANT. The membership row is what authorizes team access — it
    // is the whole of it — so restoring the row restores the access, and the
    // invitation is not needed for that.
    //
    // Un-revoking it would ALSO reopen last commit's verified exploit: an invitation row is
    // what POST /teams/join and the sign-in accept path read, so a live row is a standing
    // permission to REGISTER and to re-add oneself. REVOKED is a TERMINAL status precisely so
    // that path stays closed, and only a person with grant authority issuing a FRESH
    // invitation re-opens it. A reactivated member needs neither: they are already a member,
    // and the join route's idempotent short-circuit answers 200 for them without consulting
    // the invitation at all.
    //
    // The consequence, stated rather than left to be discovered: a reactivated person's
    // invitation row still reads REVOKED, so the Administration screen shows their invitation
    // as withdrawn while their membership is live. Those two facts are both true — the grant
    // WAS withdrawn, and their access was later restored by a different act.

    if (flipped) {
      // The SAME event the two join paths publish, so a consumer cannot tell how someone
      // arrived on a team — the roster gained a member either way, which is what a projection
      // or a notification cares about. Published only on a real flip, so a retried call does
      // not duplicate any downstream effect.
      await deps.events.publish({
        source: "team-service",
        type: "member.joined",
        detail: {
          teamId,
          workshopId: teamRow.workshopId,
          userId,
          // Distinguishes a restoration from a fresh join for any consumer that cares, without
          // a second event type that every existing consumer would have to learn.
          actorId,
          restored: true,
        },
      });
    }

    return c.json({
      /**
       * ALWAYS TRUE on a 200 — the FROZEN CONTRACT's shape, and it reports the caller's intent
       * having been achieved rather than whether this particular call did the work. An
       * already-active member is a success: they have access, which is what was asked for.
       * `audited` is what distinguishes a real flip (audited) from a no-op (not).
       */
      reactivated: true as const,
      /**
       * THE PRESERVED TEAM ROLE, read off the row rather than reconstructed — a reactivated
       * LEAD returns as LEAD. This is the field the row surviving the removal exists to
       * protect: the previous hard delete destroyed it, so a re-added member came back as
       * whatever their next invitation happened to say.
       */
      role: existing.role,
      /**
       * FALSE when no entry was written. On an idempotent no-op that is correct and expected;
       * after a REAL flip it means access was granted with no record of who granted it, which
       * is worth an alarm.
       */
      audited,
    });
  });

  /**
   * FORMER MEMBERS of a team — people who were on the roster and were removed.
   *
   * Owner: "we shouldnt remove the user from the list as it might be missing for audit can
   * we make it inactive and show it in the members list to show he was joined but later
   * removed".
   *
   * ── STILL DERIVED FROM THE AUDIT TRAIL, AND THAT IS NOW A CHOICE BETWEEN TWO SOURCES ──
   *
   * This route was built when removal was a HARD DELETE, so the trail was the ONLY place the
   * history lived and there was nothing to decide. Removal now keeps the row as INACTIVE, so
   * the same question is answerable from either store — and the answer is THIS ONE STAYS ON
   * THE TRAIL while the ROSTER carries the rows. Both, with each answering what only it can:
   *
   *   PRE-SHIP REMOVALS EXIST ONLY HERE, and that is decisive. Every removal performed before
   *   this change hard-deleted its row; those rows are GONE and there is no backfill (the
   *   trail is append-only by IAM, and the deleted rows cannot be reconstructed from it —
   *   `joinedAt` is the only field that was copied across). Switching this route to read
   *   inactive rows would silently DROP that entire history from the operator's view, which is
   *   the one outcome the requirements rule out.
   *
   *   THE TRAIL CARRIES WHAT THE ROW DOES NOT: the `reason`, and one entry PER REMOVAL. A row
   *   holds only the LATEST removal, so a person removed in March and again in August has one
   *   row and two entries — and "who removed them in March, and why" is answerable only here.
   *
   *   THE ROW CARRIES WHAT THE TRAIL CANNOT: CURRENT STATE, and therefore a REACTIVATE ACTION.
   *   An audit entry is a historical record of an act; it cannot be reactivated, so a UI
   *   rendering only trail entries has nothing to flip. That is why the ROSTER
   *   (GET /teams/:teamId/members) is where an inactive member appears with a Reactivate
   *   button, via listByTeamIncludingInactive — not here.
   *
   * SO THE TWO SURFACES DIVIDE BY QUESTION, not by store: this one is the REMOVAL HISTORY of a
   * team (append-only, complete, includes people whose rows no longer exist), and the roster is
   * the CURRENT MEMBERSHIP of a team (live, actionable, one row per person). Serving both from
   * one source would lose either the pre-ship history or the ability to act.
   *
   * The cost of this route's choice, stated plainly and unchanged: it is only as complete as
   * the trail, so a removal whose audit write failed (`audited: false`) does not appear here.
   * That is the documented reason `audited: false` is worth an alarm. The roster now covers
   * that gap for any post-ship removal — the row is written first and unconditionally, so a
   * lost audit entry no longer means a lost former member.
   *
   * ── AUTHORIZATION: THE ADMINISTRATION PREDICATE (requireTeamRead) ──
   *
   * This is ROSTER METADATA about the person↔team RELATIONSHIP — who was on this team and
   * when — not content the team AUTHORED. The relationship is administrable
   * and the content is member-only, and every other roster surface in that table
   * (`Team roster`, `Workshop roster`, `Member removal`) sits on the administration
   * predicate. So: a member of this team, staff who owns its workshop, or an ADMIN. A MEMBER
   * sees it too, which is the point — it renders beside their own People list.
   *
   * Deliberately NOT requireTeamContentRead: that would 403 the workshop's owning
   * facilitator, who is precisely the person who performed the removal and needs to see it.
   * And deliberately NOT canReadDirectory (which gates GET /audit/users/:userId) — that
   * route answers "everything ever done about this PERSON" across every team and includes
   * platform-access changes, so it is directory-shaped; this one is scoped to a single team
   * a caller already has read on, and shows only removals from it.
   *
   * ── NAMES: RESOLVED AT READ TIME, AND THE ACTOR'S IS VISIBILITY-GATED ──
   *
   * The trail stores IDS and not names, on purpose (see the note on AuditEntry in
   * shared/types/audit.ts): a stored name freezes at the moment of the action
   * and is a second copy of PII in a table that is never deleted.
   *
   * THE ACTOR'S NAME IS GATED ON THE SAME MATRIX the Administration screen honours, so a
   * FACILITATOR reading this cannot learn an ADMIN's name. It is decided from `actorRole` —
   * which the entry ALREADY STORES as the role AT THE TIME — so it costs no lookup and
   * cannot be answered from a stale directory. `removedByName: null` means "not shown to
   * you", exactly as identity's /admin/user-names reports `hidden: true`.
   *
   * THE SUBJECT'S name and address come from this service's own users read-model, the same
   * projection GET /teams/:teamId/members enriches the LIVE roster from, and are disclosed
   * to the same set: requireTeamRead is exactly the set already entitled to a member's
   * address (see that route's comment). A former member is the same person, about the same
   * team, and the caller could have read all of it the day before the removal. Per
   * requirement (b) an ADMIN/FACILITATOR/JUDGE may never hold a team-membership row, so a
   * former MEMBER is a PARTICIPANT or EXECUTIVE by construction — there is no privileged
   * account to disclose on this side, which is why the subject needs no role gate and the
   * actor does.
   *
   * ── SHAPE NOTES ──
   *
   * ONE ROW PER PERSON, their MOST RECENT removal. Someone removed, re-invited and removed
   * again has several entries and one row; the newest is the current state of the
   * relationship, and the full history stays at GET /audit/users/:userId.
   *
   * A PERSON WHO IS A MEMBER AGAIN IS NOT LISTED. They appear on the live roster, and
   * showing them in both would say the relationship both ended and did not. This is the
   * check that makes "re-adding a removed person" render correctly.
   */
  team.get("/teams/:teamId/former-members", async (c) => {
    const teamId = c.req.param("teamId");
    const { role: callerRole } = requireIdentity(c);

    const denied = await requireTeamRead(c, deps.members, deps.workshops, teamId);
    if (denied) return denied;

    // One single-partition Query on the teamId-index GSI, newest first. Bounded by
    // FORMER_MEMBER_AUDIT_SCAN, which is the audit store's own clamp — so this asks for the
    // most one Query returns and never silently pages.
    const entries = await deps.audit.listByTeam(teamId, FORMER_MEMBER_AUDIT_SCAN);

    // Newest-first per person, keyed on subjectId. `Map` preserves insertion order and the
    // query is already sorted, so the FIRST entry seen for a subject is their most recent
    // removal and later ones are skipped — no comparison, no sort.
    const latestBySubject = new Map<string, AuditEntryRead>();
    for (const entry of entries) {
      // The store returns every action for the team (see listByTeam on why it does not
      // filter), so the action check is HERE. Only a removal makes someone a former member.
      if (entry.action !== "MEMBER_REMOVED") continue;
      if (!entry.subjectId) continue;
      if (latestBySubject.has(entry.subjectId)) continue;
      if (latestBySubject.size >= MAX_FORMER_MEMBERS) break;
      latestBySubject.set(entry.subjectId, entry);
    }

    const truncated = latestBySubject.size >= MAX_FORMER_MEMBERS;
    if (truncated) {
      console.warn("[team] former-members list truncated", {
        teamId,
        returned: latestBySubject.size,
        scanned: entries.length,
      });
    }

    const resolved = await Promise.all(
      [...latestBySubject.values()].map(async (entry) => {
        // A person who has since REJOINED belongs on the live roster, not here. One local
        // Get per former member against a table this service owns, bounded by
        // MAX_FORMER_MEMBERS.
        if (await deps.members.get(teamId, entry.subjectId)) return null;

        // Best-effort: a read-model row that has not landed yet (or was never written)
        // must leave the entry in the list with an unresolved name rather than dropping
        // the removal. The removal is the fact; the name is decoration on it.
        const user = await deps.users.get(entry.subjectId).catch(() => null);

        // The one visibility decision on this route, taken from the STORED historical role.
        const actorVisible = canSeeUser(callerRole, entry.actorRole);

        return {
          userId: entry.subjectId,
          /** null when the read-model has no row for them yet — "unknown", not "hidden". */
          name: user?.name ?? null,
          email: user?.email ?? null,
          removedAt: entry.occurredAt,
          /** null when this caller may not learn about that account — see the header. */
          removedByName: actorVisible
            ? // Resolved from the same read-model. Still null if the actor has no row (a
              // staff account deleted since), which the UI renders as unknown.
              ((await deps.users.get(entry.actorId).catch(() => null))?.name ?? null)
            : null,
          /**
           * The actor's role AT THE TIME. Disclosed even when the NAME is not: "removed by
           * an Admin" is what the audit entry is FOR, and it names no account. Suppressing
           * it would leave a row that says a removal happened and refuses to say by whom in
           * any form, which is not a trail.
           */
          removedByRole: entry.actorRole,
          reason: entry.reason ?? null,
          /**
           * WHEN THEY JOINED, from the membership row copied into the entry at removal time
           * — see AuditEntryWrite.joinedAt for why it has to be denormalised.
           *
           * NULL, not invented, for entries written before that field existed: the table is
           * append-only so there is no backfill, and the invitation's `acceptedAt` is
           * deliberately NOT substituted (one invitation row carries one acceptedAt while a
           * person can be removed and re-added several times, so attributing it to a
           * particular removal would be a guess rendered as a fact). A client must render
           * null as "join date unknown" and never as "never joined".
           */
          joinedAt: entry.joinedAt ?? null,
        };
      })
    );

    return c.json({
      formerMembers: resolved.filter(Boolean),
      /** True when the bound was hit — the full history is at GET /audit/users/:userId. */
      truncated,
    });
  });

  /**
   * The audit trail for ONE PERSON — every access-affecting action taken about them.
   *
   * Gated on the USER DIRECTORY roles (ADMIN + FACILITATOR), not on team read: this answers
   * "who removed this person, and when" across every team and includes platform-access
   * changes, so it is directory-shaped rather than team-shaped. A participant must not be
   * able to enumerate administrative actions, including ones taken about themselves — that
   * is a conversation with a facilitator, not a self-service API.
   *
   * Ids only, never names: the resolution to names happens in the BFF through the same
   * visibility-honouring helper the Users tab uses, so a FACILITATOR reading a trail still
   * cannot learn an ADMIN's NAME.
   *
   * ── `actorId` IS VISIBILITY-GATED, AND THE OLD COMMENT ABOVE WAS TRUE ONLY OF THE NAME ──
   *
   * This route used to hand `listBySubject`'s rows back verbatim (`c.json({ entries })`), which
   * shipped `actorId` — the raw Cognito sub of the operator who performed each action — to any
   * caller `canReadDirectory` admits. That set is ADMIN + FACILITATOR, so a FACILITATOR could
   * name any subject, read the trail, and harvest the subs of the ADMINs who acted on them.
   * Withholding the NAME while shipping the IDENTIFIER beside it is exactly the defect the
   * roster had (see loadTeamMembersIncludingInactive), and this route is WORSE to sweep: it is
   * DIRECTORY-shaped, so nothing scopes it to teams the caller already has read on.
   *
   * Not fully escalatable to a name — identity's /admin/user-names and /admin/users?ids= both
   * apply canSeeUser — but a stable correlatable identifier for the accounts holding full
   * platform access is itself the reconnaissance step USER_VISIBILITY_GRANTS exists to stop.
   *
   * `actorId` is now carried only when `canSeeUser(callerRole, entry.actorRole)` holds, decided
   * from the role the entry ALREADY STORES as the role AT THE TIME — so it costs no lookup and
   * cannot be answered from a directory that has since changed. It is OMITTED rather than
   * nulled, matching the roster fix: an absent key discloses nothing, not even that a value is
   * being withheld, whereas `actorId: null` tells a facilitator "an account you may not see
   * did this", which is half the answer they were refused.
   *
   * `actorRole` STAYS DISCLOSED regardless, for the same reason former-members and the roster
   * disclose `removedByRole`: "performed by a Facilitator" names no account, and suppressing it
   * would leave an entry that says an action happened and refuses to say by whom in any form,
   * which is not a trail.
   *
   * NO `actorName` IS RESOLVED HERE, deliberately, and that is a difference from
   * former-members rather than an oversight. Nothing renders one: grepped across the portal
   * and desktop and this route has NO consumer at all today (no tRPC procedure reads it —
   * the only reference is a comment pointing at it as the full per-person history). Adding a
   * read-model fan-out for symmetry would mean up to `clampAuditLimit`'s 100 lookups per
   * request in service of no renderer, so the name resolution stays where its caller lives.
   * When a UI does need it, resolve it in the BFF through the shared canSeeUser helper the
   * Users tab already uses — the same place the header above always said it belonged.
   *
   * ── THE ROW IS ENUMERATED, NEVER SPREAD ──
   *
   * Every field is listed below. A spread is an allowlist that grows silently, and this is a
   * stored row on an append-only table that has already gained fields twice (`joinedAt`, and
   * `occurredAt`/`at` from the store) — so a future attribute reaches this response only when
   * someone adds it HERE and states why the trail needs it.
   */
  team.get("/audit/users/:userId", async (c) => {
    // `id` is needed as well now: the ownership scope below is the CALLER's, not the subject's.
    const { id: callerId, role: callerRole } = requireIdentity(c);
    if (!canReadDirectory(callerRole)) {
      return c.json(
        { error: "Forbidden: your role cannot read the audit trail" },
        403
      );
    }

    const userId = c.req.param("userId");
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) ? limitParam : undefined;

    // Bounded by the store's own clamp into [1, 100] — see clampAuditLimit. The projection
    // below is therefore at most 100 objects and makes no lookups of its own.
    const entries = await deps.audit.listBySubject(userId, limit);

    /**
     * ── ⚠ THE OWNERSHIP SCOPE, WHICH THIS ROUTE DID NOT HAVE ────────────────────────────────────
     *
     * `canReadDirectory` above admits ADMIN and FACILITATOR and that was the ONLY check: any
     * facilitator could read any user's full membership and invitation history, including teams in
     * experiences they have nothing to do with. Same stale premise as `/directory/user-ids`, which was
     * scoped earlier — this route was left behind and recorded as known gap #3 in ROLES.md.
     *
     * ⚠ THE SCOPE IS DECIDED PER ENTRY, BY WHAT THE ENTRY IS ABOUT, and the trail has two kinds:
     *
     *   TEAM-SCOPED  — MEMBER_REMOVED, MEMBER_RESTORED. They carry `teamId`, so they belong to an
     *                  experience and are scoped to it exactly like every other read on this platform:
     *                  visible iff the caller OWNS that experience. ADMIN included — an admin is an
     *                  ordinary owner role.
     *
     *   ACCOUNT-LEVEL — ACCESS_DISABLED, ACCESS_ENABLED, ENTITLEMENT_REVOKED. No `teamId`, and
     *                  therefore NO EXPERIENCE TO OWN. These are account-lifecycle acts, which is the
     *                  ADMIN's remit rather than a facilitator's, so they are ADMIN-only. That is not
     *                  a hole in the experience scoping: the admin-scoping rule (no other experience's
     *                  teams or scores) is about EXPERIENCES, and disabling an account is not one.
     *
     * ⚠ THIS LAST LINE IS A POLICY CHOICE AND SHOULD BE CONFIRMED. ROLES.md called this gap "worth a
     * decision" precisely because there is no ownership to test on an account-level entry. Two facts
     * make it safe to land: the alternative (showing them to any facilitator) is the status quo being
     * fixed, and this route has NO CONSUMER today — nothing in the portal or desktop reads it — so if
     * the policy is wrong it is wrong in a response nobody renders yet.
     *
     * BOUNDED: ONE east-west hop for the caller's owned experiences, then local `getById` per DISTINCT
     * teamId on the page. Not one hop per entry — that would be up to 100 from a single request.
     */
    const owned = await deps.workshopDirectory.listOwnedWorkshops(callerId, callerRole, c);
    if (owned === "unavailable") {
      // 503, never a filtered list. An audit trail silently missing entries is worse than one that
      // says it cannot be read — the fail-closed rule, and the same call the teams directory makes.
      console.warn("[team] audit trail: owned-workshop scope unavailable — 503, not a short trail", {
        userId: callerId,
        role: callerRole,
      });
      return c.json(
        {
          error:
            "The audit trail can't be loaded right now. This is a temporary problem, not a change to your access.",
          code: "AUDIT_SCOPE_UNAVAILABLE",
        },
        503,
        { "Retry-After": "2" }
      );
    }
    const ownedWorkshopIds = new Set(owned.map((w) => w.id));

    // Distinct team ids only: two entries about the same team cost one lookup, and the page is
    // already clamped to 100 entries.
    const teamWorkshop = new Map<string, string | null>();
    for (const teamId of new Set(entries.map((e) => e.teamId).filter((t): t is string => !!t))) {
      const row = await deps.teams.getById(teamId).catch(() => null);
      // A team that cannot be read is UNSCOPEABLE, so its entries are withheld — fail closed. Null
      // here is not "no workshop", it is "we could not establish which experience this belongs to".
      teamWorkshop.set(teamId, row?.workshopId ?? null);
    }

    const visible = entries.filter((entry) => {
      if (entry.teamId === undefined) {
        // Account-level. See the note above: ADMIN's remit.
        return callerRole === "ADMIN";
      }
      const workshopId = teamWorkshop.get(entry.teamId);
      return !!workshopId && ownedWorkshopIds.has(workshopId);
    });

    return c.json({
      entries: visible.map((entry) => ({
        subjectId: entry.subjectId,
        /** `<ISO>#<ulid>`, the sort key. Kept: it is the stable identity of an entry. */
        at: entry.at,
        occurredAt: entry.occurredAt,
        action: entry.action,
        /** The actor's role AT THE TIME. Never gated — see the header on why. */
        actorRole: entry.actorRole,
        /**
         * THE ACTING OPERATOR'S SUB, ONLY WHEN THIS CALLER MAY LEARN OF THAT ACCOUNT.
         *
         * Spread-or-omit, not `null`, and the key's very ABSENCE is the point — see the header.
         * Fails CLOSED through canSeeUser: an entry whose stored `actorRole` is absent or
         * unrecognised (a role retired since, or a row predating the field) withholds the sub.
         */
        ...(canSeeUser(callerRole, entry.actorRole)
          ? { actorId: entry.actorId }
          : {}),
        /**
         * Team fields, absent on the platform-access actions — spread-or-omit so a
         * MEMBER_REMOVED entry still carries them and an ACCESS_DISABLED entry does not grow
         * two null keys that would imply a scope the change never had.
         */
        ...(entry.teamId !== undefined ? { teamId: entry.teamId } : {}),
        ...(entry.teamName !== undefined ? { teamName: entry.teamName } : {}),
        /** Operator free-text, sanitised and capped at the write path (normalizeAuditReason). */
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        /**
         * WHEN THEY HAD JOINED, as at this action. Omitted rather than nulled for entries
         * written before the field existed — the table is append-only so there is no backfill,
         * and a reader must render absence as "join date unknown", NEVER as "never joined".
         */
        ...(entry.joinedAt !== undefined ? { joinedAt: entry.joinedAt } : {}),
      })),
    });
  });

  // --- Invitations (owned by the Team context: the invitations table) ---------

  /**
   * Pending invitations for a team — or, at the PLATFORM sentinel, the team-less
   * invitations that grant a platform role.
   *
   * These expose the EMAIL ADDRESSES of everyone invited, so at TEAM scope the gate
   * is team read, like the roster above.
   *
   * At PLATFORM scope `canRead` cannot be the gate: there is no team to be a member
   * of, so it passes only via ADMIN's short-circuit in authz.ts. That would leave a
   * FACILITATOR able to CREATE and REVOKE platform invitations (both gates below
   * exempt the sentinel) but unable to LIST them — so the one thing they could not do
   * is find the mistyped address they need to revoke. Revoke-by-email would still
   * work, making this un-FINDABLE rather than un-revocable, which during an incident
   * is the same thing. This is the third leg of the asymmetry the DELETE gate's
   * comment describes, and it must move with the other two.
   *
   * So at platform scope the gate is the invite matrix instead, per ROW: you see an
   * invitation only if you could have granted the role it carries. A FACILITATOR
   * sees FACILITATOR/JUDGE rows but not ADMIN ones; a JUDGE sees only JUDGE; an
   * EXECUTIVE (who may grant nothing platform-scoped) sees an empty list rather than
   * a 403, because "nothing here for you" is the truthful answer. That makes the
   * list agree exactly with the Revoke control the portal renders from the same
   * matrix, so no row appears with a button the DELETE route would refuse.
   */
  team.get("/teams/:teamId/invitations", async (c) => {
    const teamId = c.req.param("teamId");
    const { role } = requireIdentity(c);

    if (isPlatformScope(teamId)) {
      if (!canInvite(role)) {
        return c.json({ error: "Forbidden: your role cannot invite users" }, 403);
      }
    } else {
      const denied = await requireTeamRead(c, deps.members, deps.workshops, teamId);
      if (denied) return denied;
    }

    const invitations = await deps.invitations.listByTeam(teamId);

    const visible = isPlatformScope(teamId)
      ? invitations.filter((inv) =>
          canGrantRole(role, inv.platformRole || "PARTICIPANT")
        )
      : invitations;

    // tokenHash never leaves the service. It is the only stored form of the link
    // token and a SHA-256 of 256 bits is not reversible, so this is not a live
    // exposure — but a secret-derived value has no business in a list payload the
    // BFF doesn't read, and omitting it now means a future consumer can't start
    // depending on it.
    return c.json({
      invitations: visible.map(({ tokenHash: _tokenHash, ...inv }) => inv),
    });
  });

  /**
   * GATE 4 — resolve the WORKSHOP each invitee's row will carry, or refuse the batch.
   *
   * The rules per role are WORKSHOP_POLICY; this is their enforcement, and it answers
   * three separate questions that are easy to conflate:
   *
   *   1. Is a workshop required, derived or forbidden for the role being granted?
   *   2. For a DERIVED role, what does the SERVER say it is? (the team's own
   *      workshopId — never the client's value, which is only ever compared)
   *   3. For a REQUIRED role, is the CALLER ENTITLED to the workshop they named?
   *
   * QUESTION 3 IS THE ESCALATION BOUNDARY, and without it the feature is a
   * self-service privilege grant. `ROLE_GRANTS` lets some non-ADMIN roles hand out
   * JUDGE, and an invitation row is authoritative — the Cognito pre-signup trigger
   * admits a signup on it and post-confirmation reads the role off it. So an inviter
   * who could name ANY workshop id could mint themselves an invitation into a workshop
   * they have nothing to do with, register the second account, and arrive inside it.
   * A FACILITATOR or EXECUTIVE must OWN the workshop they name. ⚠ AN ADMIN NEED NOT, because
   * inviting people into experiences is platform user administration — but that grant is load-
   * bearing on the SELF-INVITATION GATE in gate 3, without which it is this very escalation with
   * a role instead of a guessed id. Neither is safe alone; see mayGrantWorkshop below.
   *
   * IT FAILS CLOSED, and the failure mode is the one that matters: `ownsWorkshop`
   * returns false — not "unknown" — for a timeout, a 5xx, a non-JSON body or a missing
   * ownerId (see workshop-access.http.ts), and it carries
   * `AbortSignal.timeout(EAST_WEST_TIMEOUT_MS)` so a Workshop service answering slowly
   * cannot pin this Lambda for the full gateway timeout. A degraded Workshop service
   * therefore makes judge invitations REFUSED (403), never silently granted. That is
   * the correct direction for a write that hands out access.
   *
   * BOUNDED: at most MAX_INVITE_WORKSHOPS distinct workshops per request, and the
   * probes are MEMOISED per id and issued SEQUENTIALLY — one ownership answer is
   * reused across every invitee naming that workshop, and the batch cannot fan out.
   *
   */
  async function resolveInviteWorkshops(
    c: Context,
    teamId: string,
    invitees: Invitee[],
    // Passed in rather than owned, so gate 4 (workshop derivation) and gate 5 (the seat cap)
    // share ONE read of the team row. See the route's `loadTeamRow`.
    loadTeamRow: () => Promise<Team | null>
  ): Promise<WorkshopResolution> {
    const { id: callerId, role, email: callerEmail } = requireIdentity(c);

    // The team's OWN workshop, loaded at most once and only if some invitee actually
    // needs a DERIVED value. A platform-scoped batch never touches the teams table.
    let derived: string | undefined;
    const derivedWorkshopId = async (): Promise<string | undefined> => {
      // A dangling teamId reads as "no workshop to derive", which the caller below
      // turns into a 400 rather than a row with no grant — gate 2 already proved the
      // caller may see this team, so a missing row here is a data problem, not an
      // authorization one.
      derived = (await loadTeamRow())?.workshopId;
      return derived;
    };

    // Memoised ownership answers, keyed by workshopId. Request-scoped: this closure
    // dies with the request, so there is no cross-request cache to bound or evict.
    const ownership = new Map<string, boolean>();
    const mayGrantWorkshop = async (workshopId: string): Promise<boolean> => {
      /**
       * ── AN ADMIN MAY NAME ANY EXPERIENCE, PROVIDED WE KNOW WHO THEY ARE ──────────────
       *
       * The rule: an admin may invite any user to any experience from the administration tab,
       * as a facilitator does, but may never add themselves to an experience. Inviting people INTO experiences is platform user administration —
       * the same category as `ROLE_GRANTS` and the user directory, where ADMIN is intentionally
       * platform-wide — so ownership is the wrong question for an admin here.
       *
       * ⚠ THIS GRANT IS SAFE ONLY BECAUSE OF THE SELF-INVITATION GATE IN GATE 3, and the two must
       * be read together. This branch was previously REMOVED precisely because it
       * was an escalation: an invitation row is authoritative at signup, so an admin naming any
       * workshop could invite THEMSELVES as a JUDGE and walk into a stranger's judging. What
       * changed is not the risk assessment but the mitigation — the self-invite is now refused, so
       * what remains is an admin inviting OTHER people, which is their job.
       *
       * ⚠ GATED ON A KNOWN CALLER EMAIL, AND THAT IS THE FAIL-CLOSED PART. `EdgeIdentity.email`
       * defaults to `""` when the claim is absent (edge-identity.ts), and with no caller email the
       * self-invitation gate CANNOT FIRE — so the escalation would be wide open again. Rather than
       * refuse the admin outright, an unidentified caller falls through to the ownership probe
       * below: they can still invite into experiences they own, which is what a FACILITATOR gets.
       * The wide grant is what is withheld, not the feature.
       */
      if (role === "ADMIN" && callerEmail.trim() !== "") return true;

      const memoised = ownership.get(workshopId);
      if (memoised !== undefined) return memoised;

      if (ownership.size >= MAX_INVITE_WORKSHOPS) {
        // Refused rather than probed: the cap is the bound on the fan-out, so it must
        // deny the (n+1)th id instead of quietly allowing it through unchecked.
        return false;
      }

      // One bounded, fail-closed hop. Sequential by construction — each awaited
      // before the next invitee is considered.
      //
      // `.catch(() => false)` is belt-and-braces, not dead code: the HTTP
      // implementation already swallows timeouts, 5xx, non-JSON and connect errors
      // into `false`, but this is an ESCALATION gate and it must not depend on a
      // collaborator's internal discipline to stay closed. Without it a throwing
      // implementation escapes as an unhandled 500, which is still safe (nothing is
      // written) but tells an operator nothing about WHICH way it failed — and it
      // would put an authorization outcome at the mercy of the framework's error
      // handler. A denial here is a denial, and it is reported as one.
      const owns = await deps.workshops
        .ownsWorkshop(workshopId, callerId, role, c)
        .catch(() => false);
      ownership.set(workshopId, owns);
      return owns;
    };

    const workshopIds: (string | undefined)[] = [];

    for (const inv of invitees) {
      const requested = inv.platformRole || "PARTICIPANT";
      // Trimmed and emptiness-checked: a `workshopId: ""` or "   " from a client is
      // "not supplied", never a workshop, and must not satisfy a REQUIRED role.
      const named = typeof inv.workshopId === "string" ? inv.workshopId.trim() : "";

      switch (workshopPolicyFor(requested)) {
        case "FORBIDDEN": {
          if (named) {
            const why =
              WORKSHOP_FORBIDDEN_REASON[requested] ??
              "that role's access is not workshop-scoped";
            return {
              error: `A ${requested} invitation must not name a workshop — ${why}.`,
              status: 400,
            };
          }
          workshopIds.push(undefined);
          break;
        }

        case "DERIVED": {
          // Gate 3 has already refused these roles at platform scope, so there is
          // always a real team to derive from by the time we get here.
          const fromTeam = await derivedWorkshopId();
          if (!fromTeam) {
            return {
              error: `Cannot determine the workshop for this team, so a ${requested} invitation cannot be scoped to one.`,
              status: 400,
            };
          }
          // A client value that DISAGREES is an error, not something to override
          // silently: the caller believes they are inviting into a different
          // workshop, and quietly writing ours would grant access they did not
          // intend. An equal value is simply redundant and allowed.
          if (named && named !== fromTeam) {
            return {
              error: `A ${requested} invitation takes its workshop from the team — remove workshopId or set it to this team's workshop.`,
              status: 400,
            };
          }
          workshopIds.push(fromTeam);
          break;
        }

        case "REQUIRED": {
          if (!named) {
            return {
              error: `A ${requested} invitation must name a workshop — choose the workshop this ${requested.toLowerCase()} will work on.`,
              status: 400,
            };
          }
          if (!(await mayGrantWorkshop(named))) {
            // 403, not 404: the caller may well be allowed to grant the role, and
            // this is a permission failure about the workshop. Deliberately does NOT
            // say whether the workshop exists — an operator gets the actionable half
            // ("you don't own it"), an attacker learns nothing about which ids are
            // real. The workshop id is not echoed back for the same reason.
            return {
              error: `Forbidden: you cannot invite into a workshop you do not own.`,
              status: 403,
            };
          }
          workshopIds.push(named);
          break;
        }
      }
    }

    return { workshopIds };
  }

  /**
   * GATE 5 — WOULD THIS BATCH OVERSUBSCRIBE THE TEAM'S SEATS?
   *
   * Returns a refusal to answer with, or `null` to proceed. Shaped like the other gates'
   * helpers: it decides, and the route reports.
   *
   *   activeMembers + livePendingInvitations + batchSize > seatCap  ⇒  409
   *
   * ── WHAT COUNTS AS A RESERVED SEAT, AND WHAT DOES NOT ──
   *
   *   COUNTED  ACTIVE members (`listByTeam`, which already omits INACTIVE rows via the
   *            repository — so a removed person does not hold a seat, which is correct
   *            because the removal freed it in the ledger).
   *   COUNTED  PENDING invitations, REGARDLESS OF `expiresAt`. See the call site: an expired
   *            PENDING row can still admit, so it still holds a seat.
   *   NOT      ACCEPTED rows. The person is either already an active member (counted once,
   *            above) or was removed (their row was flipped to REVOKED by the removal).
   *            Counting them too would double-count every member who joined by invitation,
   *            which is all of them.
   *   NOT      REVOKED rows. The grant was withdrawn; it cannot admit anyone.
   *
   * ── EVERY FAILURE HERE IS A REFUSAL, NOT A PASS ──
   *
   * `listByTeam` (invitations) THROWS rather than returning a truncated list
   * (InvitationQueryBoundExceeded), and the roster read can fail too. Both are answered 503,
   * never "no reservations found": this gate decides a REFUSAL, and dropping rows from a
   * refusal gate's evidence can drop the very rows that would have refused. That is the same
   * rule the reactivation gate applies to MAX_SUBJECT_INVITATIONS, for the same reason.
   *
   * ⚠ A team row that cannot be read is ALSO a 503 rather than an assumed cap. There is no
   * safe default for a seat limit — see the note on LEGACY_TEAM_SEAT_CAP for the one place a
   * cap is inferred, which is a row that genuinely has none rather than a row we failed to
   * read.
   */
  async function checkInvitationSeats(
    teamId: string,
    batchSize: number,
    team: Team | null
  ): Promise<{ body: Record<string, unknown>; status: 409 | 503 } | null> {
    const unavailable = {
      body: {
        error:
          "This team's remaining places could not be checked, so the invitations were not sent. Try again shortly.",
        code: "TEAM_SEATS_UNAVAILABLE",
      },
      status: 503 as const,
    };

    let activeMembers: number;
    let pending: number;
    try {
      // The team row is PASSED IN, already read once for gate 4's workshop derivation — see
      // `loadTeamRow`. The remaining two reads are sequential rather than a Promise.all: they
      // are on tables this service owns, on a path that already made an east-west hop, and the
      // first miss short-circuits the second.
      if (!team) {
        // Gate 2 already proved the caller may SEE this team, so a missing row here is a
        // store problem or a deletion racing the request — transient either way.
        console.warn(
          "[team] invitation seat gate: the team could not be read, so its cap is unknown",
          { teamId }
        );
        return unavailable;
      }
      activeMembers = (await deps.members.listByTeam(teamId)).length;
      const invitations = await deps.invitations.listByTeam(teamId);
      // NOT filtered by expiry — see the call site's note on why an expired PENDING row still
      // holds a seat. `isSpentInvitation` is the shared predicate for ACCEPTED-or-REVOKED, so
      // this cannot drift from what the rest of the service calls a live grant.
      pending = invitations.filter((inv) => !isSpentInvitation(inv.status)).length;
    } catch (err) {
      console.warn(
        "[team] invitation seat gate: could not read the team's seats — refusing the batch",
        {
          teamId,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }
      );
      return unavailable;
    }

    const seatCap = team.seatCap ?? LEGACY_TEAM_SEAT_CAP;
    const requested = activeMembers + pending + batchSize;
    if (requested <= seatCap) return null;

    const available = Math.max(0, seatCap - activeMembers - pending);
    console.warn("[team] refused an invitation batch — it would oversubscribe the team", {
      teamId,
      seatCap,
      activeMembers,
      pending,
      batchSize,
      available,
    });
    return {
      body: {
        // NAMES THE ARITHMETIC, because the inviter can act on every term of it: they can send
        // fewer, revoke a pending invitation, or ask for the team's size to be raised. This is
        // the "correctable mistake at the moment of the mistake" §F is built around, so a
        // generic refusal would waste the one advantage the gate has.
        error:
          `This team has ${available} place${available === 1 ? "" : "s"} left ` +
          `(${seatCap} seats, ${activeMembers} member${activeMembers === 1 ? "" : "s"}, ` +
          `${pending} invitation${pending === 1 ? "" : "s"} pending) and you invited ` +
          `${batchSize}. No invitations were sent.`,
        code: "TEAM_SEATS_EXHAUSTED",
        // Machine-readable so the portal can render a seat counter without parsing prose.
        seatCap,
        activeMembers,
        pendingInvitations: pending,
        available,
      },
      status: 409 as const,
    };
  }

  /**
   * Create invitations for a team.
   *
   * FIVE gates, in this order, all BEFORE any write reaches DynamoDB:
   *
   *   1. Can the caller invite at all?  (canInvite — PARTICIPANT cannot)
   *   2. Can they see this team?        (canRead — blocks the IDOR where any
   *      authenticated user invited into a team by guessing its id)
   *   3. May they grant EACH requested role?  (canGrantRole, per invitee)
   *   4. Which WORKSHOP does each row carry, and may the caller grant it?
   *      (resolveInviteWorkshops — required for JUDGE, derived for
   *      PARTICIPANT/EXECUTIVE, forbidden for ADMIN/FACILITATOR)
   *   5. Would the batch OVERSUBSCRIBE the team's seats? (checkInvitationSeats,
   *      advisory, not the invariant; see that helper)
   *
   * Ordering is deliberate: the cheap role checks run before the cross-service
   * workshop-ownership hops, and the whole batch is validated before ANY row is
   * persisted — so a mixed request (one legal invitee, one privilege-escalating
   * one, or one naming a workshop the caller does not own) writes nothing rather
   * than partially succeeding. There is no partial-success story for granting
   * roles, and none for granting workshops either.
   *
   * Gate 2 is `canRead`, NOT `canWrite`, and that exception is intentional: an
   * EXECUTIVE is a read-only role for team CONTENT, but per the role matrix a
   * sponsor may still bring in fellow observers and their own participants.
   * Inviting is not a team-content mutation. Gate 3 is what keeps that safe —
   * an executive can only ever hand out EXECUTIVE or PARTICIPANT.
   *
   * PLATFORM-SCOPED INVITATIONS (`:teamId` = PLATFORM_INVITATION_TEAM_ID) SKIP
   * GATE 2, and that is the one subtlety here. Gate 2 exists to stop an IDOR on a
   * real teamId — it asks "may you see THIS team?". The sentinel is not a team:
   * `canRead` would resolve it to no membership and no workshop, so only ADMIN
   * would pass (via its short-circuit in authz.ts) and a FACILITATOR — who may
   * grant FACILITATOR, JUDGE, EXECUTIVE and PARTICIPANT per the matrix — would be
   * 403'd on every platform invitation. There is nothing to protect: the sentinel
   * is a constant, not a guessable id, so there is no object to reference
   * indirectly. Gates 1 and 3 are the real boundary for these rows, and gate 3
   * still decides role-by-role what may be handed out.
   *
   * GATE 4 IS NOT EXEMPTED AT PLATFORM SCOPE — it is where the sentinel's remaining
   * gap is closed. The only role that reaches a workshop through a platform-scoped
   * row is JUDGE, and gate 4 requires it to name one AND requires the caller to be
   * entitled to it, so the sentinel is no longer a way to hand out a role with no
   * scope at all.
   *
   * The same exemption is applied to the DELETE below, deliberately in the same
   * change: exempting only this route would make platform invitations easy to
   * create and impossible to revoke for exactly the roles that create most of them.
   */
  team.post("/teams/:teamId/invitations", async (c) => {
    const { id, role, email: callerEmail } = requireIdentity(c);
    const teamId = c.req.param("teamId");
    const body = await c.req.json();

    // Gate 1: roles that may grant nothing are refused outright, before we read
    // the body's roles or touch another service.
    if (!canInvite(role)) {
      return c.json({ error: "Forbidden: your role cannot send invitations" }, 403);
    }

    // Two accepted shapes (backward-compatible). See the Invitee interface at the
    // top of this file for what a per-recipient entry may carry.
    //   { emails: string[] }                                       — legacy, defaults
    //   { emails, platformRole?, teamRole?, workshopId? }           — one set for the batch
    //   { invitees: [{ email, platformRole?, teamRole?, workshopId? }] } — per recipient
    let invitees: Invitee[];
    if (Array.isArray(body.invitees) && body.invitees.length > 0) {
      invitees = body.invitees;
    } else if (Array.isArray(body.emails) && body.emails.length > 0) {
      invitees = body.emails.map((email: string) => ({
        email,
        platformRole: body.platformRole,
        teamRole: body.teamRole,
        // One workshop for the whole batch, which is what the portal's picker sends:
        // "invite these judges to THIS workshop". Gate 4 still validates it once per
        // distinct id, so the batch form is no cheaper in authorization than the
        // per-recipient one — only in typing.
        workshopId: body.workshopId,
      }));
    } else {
      return c.json({ error: "emails array (or invitees) is required" }, 400);
    }

    /**
     * ── ⚠ THE BATCH SIZE, WHICH WAS THE ONE UNBOUNDED INPUT ON THIS ROUTE ────────────────────
     *
     * `emails`/`invitees` had NO length cap anywhere, and the write below is a `Promise.all` of one
     * `mintInviteToken()` plus one `PutItem` per entry. This file caps five other things
     * (MAX_INVITE_WORKSHOPS 4, MAX_DIRECTORY_SCOPE_IDS 50, MAX_DIRECTORY_SEARCH 100,
     * MAX_CONTEXT_KEYS, FORMER_MEMBER_AUDIT_SCAN); this was the gap.
     *
     * ⚠ AND THE SEAT CAP DOES NOT COVER IT, WHICH IS WHY THIS IS NOT REDUNDANT. Gate 5 bounds a
     * team-scoped batch against the roster — but it is deliberately SKIPPED at platform scope (the
     * sentinel has no roster and no `seatCap`), and gate 2 is skipped there too. So at platform scope
     * the only remaining limit was the request body's size.
     *
     * WHAT THAT COST, concretely: a FACILITATOR who owns one experience could post 100k addresses to
     * the platform sentinel, all `platformRole: "JUDGE"`, all naming their own workshop.
     * `mayGrantWorkshop` memoises per workshop id, so the ownership probe stayed at ONE east-west hop
     * regardless of batch size — the authorization cost did not grow with the damage. That is 100k
     * concurrent writes from one Lambda into the invitations table, which is the table
     * `cognito-presignup` reads on EVERY registration: throttling it is a platform-wide registration
     * outage, not merely a slow request. Plus 100k live registration grants, each authoritative at
     * signup.
     *
     * REFUSED WHOLESALE, and BEFORE gate 2's hop and every write — so an over-sized call changes
     * nothing at all. That matches gates 3-5, which are already all-or-nothing: a partially-applied
     * invitation batch cannot be un-sent.
     */
    if (invitees.length > MAX_INVITEES_PER_REQUEST) {
      // Counts, never the addresses (the no-unbounded-dimension convention, applied in this file
      // already for the truncated directory scope).
      console.warn("[team] invitation batch refused — over the per-request cap", {
        userId: id,
        role,
        requested: invitees.length,
        cap: MAX_INVITEES_PER_REQUEST,
        platformScope: isPlatformScope(teamId),
      });
      return c.json(
        {
          error: `You can invite at most ${MAX_INVITEES_PER_REQUEST} people in one request. Send the rest in another.`,
          code: "TOO_MANY_INVITEES",
          cap: MAX_INVITEES_PER_REQUEST,
        },
        400
      );
    }

    // Gate 2: the caller must be able to SEE this team (a member, or staff who OWNS the
    // team's workshop — ⚠ no longer "or ADMIN", which stopped being a branch of `canRead`
    // when ADMIN was scoped to owned experiences). Without this, `teamId` is an unvalidated path param
    // and anyone could seed invitations into a team they've merely guessed. Skipped
    // for the platform sentinel — see the header comment for why that is safe.
    if (
      !isPlatformScope(teamId) &&
      !(await canRead(deps.members, deps.workshops, teamId, id, role, c))
    ) {
      return c.json({ error: "Forbidden: not a member of this team" }, 403);
    }

    // Gate 3: validate EVERY requested role before persisting ANY of them. An
    // omitted platformRole means PARTICIPANT — the same default the write below
    // applies — so it must be checked against the matrix too, otherwise a
    // PARTICIPANT-by-omission would slip past a role the caller can't grant.
    for (const inv of invitees) {
      const requested = inv.platformRole || "PARTICIPANT";
      if (!canGrantRole(role, requested)) {
        return c.json(
          { error: `Forbidden: your role cannot grant ${requested}` },
          403
        );
      }

      // A PARTICIPANT or EXECUTIVE needs a team, so refuse them at platform scope —
      // 400, not 403: the caller may well be allowed to grant the role, they just
      // haven't said where. Without this the row stores cleanly and the person
      // registers successfully, then lands on /welcome with no team and no join
      // code and nothing to explain why. A silent dead end is worse than a refusal.
      if (isPlatformScope(teamId) && (requested === "PARTICIPANT" || requested === "EXECUTIVE")) {
        return c.json(
          {
            error: `A ${requested} invitation must name a team — invite them from the team instead.`,
          },
          400
        );
      }

      // THE MIRROR IMAGE, and the FIRST of requirement (b)'s three layers.
      //
      // The check above refuses a team-scoped role with no team. This one refuses a
      // PLATFORM-scoped role WITH a team: an ADMIN, FACILITATOR or JUDGE must never hold a
      // team-membership row, because that row is the only thing that grants
      // access to a team's private content — so a facilitator invited "to a team" would
      // regain, through the front door, exactly the ambient access the member-only rule removed.
      //
      // Refusing it HERE is what stops the row existing in the first place. The other two
      // layers (POST /teams/join and POST /invitations/mine/accept) guard the membership
      // WRITE, but a stored invitation naming a real team for a facilitator is a trap
      // waiting for someone to add a fourth path — and it renders in the portal's
      // invitation list as a team invitation that can never be taken up.
      //
      // 400, NOT 403, and the distinction is the operator's: the caller may well be
      // allowed to grant this role (a FACILITATOR granting FACILITATOR passes gate 3),
      // they have named the wrong SCOPE. Same reasoning and same status as the check
      // above. Keyed on `requested`, which is the role being GRANTED — not on the
      // caller's own role, which is a different question already answered by gate 3.
      if (!isPlatformScope(teamId) && !mayHoldTeamMembership(requested)) {
        return c.json(
          {
            error: `A ${requested} is invited to the platform, not to a team — invite them without a team instead.`,
          },
          400
        );
      }

      /**
       * ── NOBODY INVITES THEMSELVES ────────────────────────────────────────
       *
       * ⚠ THIS IS THE ONLY THING STANDING BETWEEN THE ADMIN'S CROSS-EXPERIENCE INVITE AND A
       * SELF-SERVICE PRIVILEGE GRANT. The requirement has two halves: an admin may invite any user
       * to any experience, as a facilitator does, but may never add themselves. `mayGrantWorkshop`
       * grants the first half back to an ADMIN; this gate is the second half, and without it that
       * grant is exactly the escalation `resolveInviteWorkshops`' header describes — an
       * invitation row is authoritative at signup, so minting one for yourself as a JUDGE in a
       * stranger's experience and then registering IS arriving inside their judging.
       *
       * APPLIED TO EVERY ROLE, NOT JUST ADMIN, and that is a deliberate widening of the ask.
       * A FACILITATOR self-inviting as a JUDGE into an experience they own would be scoring their
       * own event — a judging-integrity problem rather than an escalation, but refused by the same
       * one-line rule, and no legitimate flow needs a self-invitation: the first admin is seeded,
       * and everyone else is invited by somebody.
       *
       * COMPARED ON THE TOKEN'S VERIFIED `email` CLAIM, never on anything the request supplied
       * twice — the same discipline as the accept route's `isOwnInvitation` below.
       *
       * ⚠ WHAT THIS DOES NOT STOP, STATED PLAINLY: an admin using a SECOND ADDRESS THEY CONTROL.
       * `admin+judge@example.com` is a different string and real accounts are commonly
       * plus-addressed, so normalising plus-tags would break real accounts while still not
       * catching a separate mailbox. Email equality is therefore a guard against the easy,
       * accidental and auditable case — not a proof of non-self-dealing. The real mitigation is
       * that every invitation is attributed and audited.
       *
       * 403 rather than 400: the caller is not being told they filled the form in wrong, they are
       * being refused an action. `SELF_INVITATION_REFUSED` so the portal can say precisely why.
       */
      const inviteeEmail = typeof inv.email === "string" ? inv.email.trim().toLowerCase() : "";
      if (callerEmail && inviteeEmail && inviteeEmail === callerEmail.trim().toLowerCase()) {
        return c.json(
          {
            error:
              "You can't invite yourself. Ask another administrator to invite you if you need a role in an experience.",
            code: "SELF_INVITATION_REFUSED",
          },
          403
        );
      }
    }

    /**
     * ONE read of the team row for the whole request, shared by gate 4 (workshop derivation)
     * and gate 5 (the seat cap). Both need the same row, and this route already made an
     * east-west hop — two independent `getById` calls was a second Query for a row already in
     * hand. The pre-existing "derives ONCE for a whole batch" test counts these reads and is
     * what caught the regression.
     *
     * A FAILED read memoises as `null` rather than retrying: both gates treat an unreadable row
     * as a refusal, so a retry inside one request would spend the caller's latency on the same
     * answer. A platform-scoped batch never calls this at all.
     */
    let teamRowLoaded = false;
    let teamRow: Team | null = null;
    const loadTeamRow = async (): Promise<Team | null> => {
      if (!teamRowLoaded) {
        teamRowLoaded = true;
        teamRow = await deps.teams.getById(teamId).catch(() => null);
      }
      return teamRow;
    };

    const resolved = await resolveInviteWorkshops(c, teamId, invitees, loadTeamRow);
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    // Positional, matching `invitees` index for index — NOT keyed on email, because a
    // batch may legitimately name the same address twice and a map would silently give
    // the second row the first one's workshop.
    const { workshopIds } = resolved;

    // ── GATE 5: SEATS. INVITATIONS RESERVE THEM, AND THE REFUSAL FALLS ON THE INVITER ──
    //
    // Refuse the WHOLE BATCH with 409 when
    //   activeMembers + livePendingInvitations + |batch| > seatCap
    //
    // ⚠ THIS IS ADVISORY, NOT THE INVARIANT, and saying so is the point rather than a caveat.
    // The invariant is held by the counter in `admit()` and by nothing else; two inviters racing
    // here can over-issue, and that is DELIBERATE. Telling an inviter "this team has 2 seats and
    // you named 5" is a correctable mistake at the moment of the mistake. Telling an invited
    // person "the team is full" after they were promised a seat and registered an account is
    // not. So this gate optimises for catching the common, honest error early and accepts that
    // it cannot be airtight.
    //
    // ALL-OR-NOTHING, matching gates 3 and 4: a batch that would overflow writes NOTHING rather
    // than the first N that fit. Partially honouring an invite list would leave the inviter to
    // work out which addresses got through by reading the response.
    //
    // ⚠ PENDING COUNTS AS RESERVED *REGARDLESS OF `expiresAt`*, and that is not an oversight.
    // An EXPIRED PENDING ROW CAN STILL ADMIT: `expiresAt` bounds the invite LINK and the
    // REGISTRATION window (enforced in the pre-signup trigger), and GET /invitations/mine
    // deliberately does not apply it to a team join — see that route's note, "a participant who
    // registered on day one and joins on day three" is a legitimate flow. A row that can still
    // admit still holds a seat, so filtering by expiry here would under-count reservations and
    // hand out seats twice.
    //
    // SKIPPED AT PLATFORM SCOPE: the sentinel is not a team, it has no roster and no seatCap,
    // and its invitation partition grows with every platform invitation ever issued.
    if (!isPlatformScope(teamId)) {
      const seatCheck = await checkInvitationSeats(
        teamId,
        invitees.length,
        await loadTeamRow()
      );
      if (seatCheck) return c.json(seatCheck.body, seatCheck.status);
    }

    const sentAtDate = new Date();
    const now = sentAtDate.toISOString();
    const expiresAt = inviteExpiry(sentAtDate);

    /**
     * ── ⚠ GATE 6: AUTHORIZE AGAINST THE ROW THAT ALREADY EXISTS ─────────────────
     *
     * THE DEFECT. `deps.invitations.put` is an unconditional `PutCommand` on key (teamId, email) and
     * nothing upstream read the existing row, so an invitation for an address that already had one was
     * SILENTLY REPLACED: new tokenHash, status reset to PENDING, `invitedBy` set to the caller,
     * platformRole/workshopId overwritten, and acceptedAt/acceptedBy/revokedAt/revokedBy destroyed.
     *
     * ⚠ BOTH CHECKS THE SIBLING DELETE DOCUMENTS AS LOAD-BEARING WERE BYPASSABLE ON THIS PATH. That
     * route validates `canGrantRole(role, existing.platformRole)` against the STORED role — its own
     * comment says "an EXECUTIVE who could delete an ADMIN's invitation could quietly cancel the
     * onboarding of someone senior to them" — and refuses to touch a terminal row. POST validated only
     * the REQUESTED role (gate 3). With gate 2 skipped at platform scope by design, a FACILITATOR could
     * POST /teams/PLATFORM/invitations {"emails":["pending-admin@corp"],"platformRole":"FACILITATOR"}
     * and overwrite that address's pending ADMIN grant. The invitations table is authoritative at
     * signup — `cognito-presignup` admits on it and `cognito-postconfirmation` takes the Cognito group
     * from it — so the account would then be created as FACILITATOR, the genuine invitee's emailed link
     * would stop working (its hash was replaced), and the record of who granted the original role would
     * be gone.
     *
     * ⚠ A PRE-VALIDATION GATE, NOT A CHECK INSIDE `writeInvitee`, AND THAT IS THE POINT. Gates 3, 4
     * and 5 are all-or-nothing: a mixed batch persists NOTHING. Doing this per-row inside the write
     * loop would have made a partially-written batch the normal outcome of a refusal, so it runs
     * entirely before the first write, like the others.
     *
     * ⚠ IT MUST *NOT* BLOCK EVERY OVERWRITE. Re-inviting a REVOKED row is the documented way to
     * re-admit someone (`/access` says so: "re-admission is an explicit act, i.e. a fresh
     * invitation"), and re-sending a PENDING invitation is ordinary. So this keys on the STORED ROLE
     * and on the ACCEPTED status, never on "a row exists".
     *
     * WHY ACCEPTED IS REFUSED OUTRIGHT: that row is the audit record of a REDEEMED grant, and
     * replacing it destroys `acceptedAt` — "the one fact the field exists to record", per
     * `InvitationRepository.accept`. It also achieves nothing a caller could want: the platform role
     * is read from this row at POSTCONFIRMATION, i.e. once, at signup, so rewriting it cannot promote
     * an account that already exists. 409 rather than 403, matching the DELETE's gate 4 — the request
     * is well-formed and the caller is permitted, the row is simply in a state this does not apply to.
     *
     * ORDERED LAST among the gates: it is the only one that reads N rows, and every gate before it is
     * either local or already-paid-for, so no request that a cheaper gate would refuse pays for these
     * reads. Sliced at `INVITE_WRITE_CONCURRENCY` for the same reason the write loop is — a batch at
     * the cap must not arrive as one 200-wide burst against the table `cognito-presignup` reads on
     * every registration.
     */
    for (let start = 0; start < invitees.length; start += INVITE_WRITE_CONCURRENCY) {
      const slice = invitees.slice(start, start + INVITE_WRITE_CONCURRENCY);
      const existingRows = await Promise.all(
        // Lower-cased to match what `writeInvitee` writes and what the store keys on — comparing a
        // caller's spelling against a lower-cased key would silently find no row and admit the
        // overwrite this gate exists to refuse.
        slice.map((inv) => deps.invitations.get(teamId, inv.email.toLowerCase()))
      );

      for (const existing of existingRows) {
        if (!existing) continue;

        if (isAcceptedInvitation(existing.status)) {
          return c.json(
            {
              error:
                "That address has already accepted an invitation here. Change their access instead of re-inviting them.",
              code: "INVITATION_ALREADY_ACCEPTED",
            },
            409
          );
        }

        // Against the role on the ROW, never the one the caller sent — gate 3 already validated
        // that. Absent platformRole means PARTICIPANT, the default POST itself applies.
        const storedRole = existing.platformRole || "PARTICIPANT";
        if (!canGrantRole(role, storedRole)) {
          return c.json(
            {
              error: `Forbidden: your role cannot replace an existing ${storedRole} invitation`,
              code: "INVITATION_OUTRANKS_CALLER",
            },
            403
          );
        }
      }
    }

    // Each invitee gets their OWN token, so one recipient forwarding their email
    // can't let someone else register — the link only ever resolves to the address
    // it was minted for. The RAW token is returned here (and nowhere else, ever
    // again) purely so the caller can build that recipient's link; only the hash
    // is persisted.
    /**
     * ⚠ WRITTEN IN BOUNDED SLICES, NOT AS ONE `Promise.all` OVER THE WHOLE BATCH.
     *
     * This was `await Promise.all(invitees.map(...))`, which issues every `PutItem` simultaneously —
     * so a batch at the cap arrived at DynamoDB as one 200-wide burst against the table
     * `cognito-presignup` reads on EVERY registration. The per-request cap above bounds the TOTAL;
     * this bounds the INSTANTANEOUS width, and they are different failure modes: 200 writes are fine,
     * 200 writes at the same instant are the shape that trips a throttle.
     *
     * Order is preserved — `items` ends up in `invitees` order, which `workshopIds[i]` below already
     * depends on — and `i` is still the index into the ORIGINAL array, not into the slice.
     *
     * Failure semantics are UNCHANGED from `Promise.all`: the first rejection propagates and the
     * request 500s. Rows written before it stay written, exactly as before. That is pre-existing (see
     * the type-confusion note on `inv.email`) and deliberately not altered here — making this
     * transactional is a separate change with its own design question, and quietly swallowing errors
     * per row would be worse than the current loud failure.
     */
    const items: Awaited<ReturnType<typeof writeInvitee>>[] = [];
    for (let start = 0; start < invitees.length; start += INVITE_WRITE_CONCURRENCY) {
      const slice = invitees.slice(start, start + INVITE_WRITE_CONCURRENCY);
      const written = await Promise.all(
        slice.map((inv, offset) => writeInvitee(inv, start + offset))
      );
      items.push(...written);
    }

    async function writeInvitee(inv: Invitee, i: number) {
      {
        // WHICH PLATFORM ROLES MAY CARRY A TEAM ROLE.
        //
        // This used to be PARTICIPANT only, to stop "a Judge/Executive invite carrying a
        // stray LEAD/BUILDER" — right when every team role was a BUILDING role, and a
        // judge tagged BUILDER was simply false. EXECUTIVE and COACH were then added to
        // TEAM_ROLES precisely so a non-builder can hold an honest team role, at which
        // point this gate started contradicting them: an executive invited to a team was
        // offered no team role at all and the field was silently dropped.
        //
        // EXECUTIVE is now allowed. A JUDGE still is not: a judge evaluates a workshop
        // rather than sitting in one team, their invitation is workshop-scoped
        // (WORKSHOP_POLICY.JUDGE = "REQUIRED"), and a team role on that row would be a
        // grant nothing reads. ADMIN/FACILITATOR likewise — platform-wide, no team seat.
        //
        // Absent platformRole means PARTICIPANT, as everywhere else in this service.
        const effectivePlatformRole = inv.platformRole || "PARTICIPANT";
        const mayHoldTeamRole =
          effectivePlatformRole === "PARTICIPANT" ||
          effectivePlatformRole === "EXECUTIVE";
        const { token, tokenHash } = mintInviteToken();
        // Resolved by gate 4 above and taken from THERE, never from `inv` — for a
        // DERIVED role the client's value has already been rejected if it disagreed,
        // and for a FORBIDDEN one this is deliberately undefined.
        const grantedWorkshopId = workshopIds[i];
        const stored = await deps.invitations.put({
          teamId,
          // Recorded explicitly so a reader (or a human reading a table dump)
          // doesn't have to know the sentinel to know what this row is.
          scope: isPlatformScope(teamId) ? "PLATFORM" : "TEAM",
          email: inv.email.toLowerCase(),
          status: "PENDING",
          invitedBy: id,
          sentAt: now,
          tokenHash,
          expiresAt,
          ...(inv.platformRole ? { platformRole: inv.platformRole } : {}),
          ...(mayHoldTeamRole && inv.teamRole ? { teamRole: inv.teamRole } : {}),
          // Spread-or-omit rather than `workshopId: undefined`: a FORBIDDEN role's
          // row must have NO attribute at all, not an empty one that a later reader
          // could mistake for a grant. DynamoDB would also reject `undefined`.
          ...(grantedWorkshopId ? { workshopId: grantedWorkshopId } : {}),
        });
        // Hand back the raw token, WITHOUT the hash: the caller has no use for the
        // digest and it should not travel further than the table.
        const { tokenHash: _omit, ...rest } = stored;
        return { ...rest, token };
      }
    }

    return c.json({ invitations: items }, 201);
  });

  /**
   * REVOKE a pending invitation — the missing half of the invite flow.
   *
   * Until this route existed, granting a role by invitation was easy and taking it
   * back was impossible: nothing anywhere deleted an invitation row. A mistyped
   * address or an invite sent to the wrong person stayed redeemable indefinitely
   * (rows created before invite-link expiry have no `expiresAt` at all, which
   * isExpired() treats as never expiring), and the row is exactly what the Cognito
   * pre-signup trigger consults to admit a signup. An un-revocable grant is the
   * asymmetry this closes.
   *
   * The SAME three gates as sending, in the same order, plus a fourth:
   *
   *   1. canInvite      — a role that cannot grant cannot un-grant.
   *   2. canRead        — blocks the IDOR on `:teamId`, exactly as on POST.
   *   3. canGrantRole   — against the role ON THE ROW being revoked.
   *   4. status PENDING — an ACCEPTED row is an audit record, never destroyed.
   *
   * Gate 3 is the subtle one and it is checked against the STORED platformRole, not
   * anything the caller sends. Revoking is not inherently safer than granting: an
   * EXECUTIVE who could delete an ADMIN's invitation could quietly cancel the
   * onboarding of someone senior to them. Whoever may hand out a role may withdraw
   * that same role, and no other.
   *
   * Gate 4 draws the line at redemption. Once accepted, the person has a real
   * account whose privileges live in Cognito — deleting the row would not remove
   * their access, it would only destroy the evidence of who granted it. Revoking an
   * existing USER's access is a different operation against a different system.
   */
  team.delete("/teams/:teamId/invitations/:email", async (c) => {
    const { id, role } = requireIdentity(c);
    const teamId = c.req.param("teamId");
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();

    // Gate 1.
    if (!canInvite(role)) {
      return c.json(
        { error: "Forbidden: your role cannot manage invitations" },
        403
      );
    }

    // Gate 2 — skipped at platform scope, for the same reason as on POST and
    // NECESSARILY in step with it. `canRead("PLATFORM", …)` passes only for ADMIN,
    // so leaving this in place while POST exempts the sentinel would let a
    // FACILITATOR create platform invitations they could never withdraw: a
    // mistyped address would stay redeemable until it expired, and the row is what
    // the pre-signup trigger admits a signup on. Easy to grant, impossible to
    // revoke is the asymmetry this pairing avoids.
    if (
      !isPlatformScope(teamId) &&
      !(await canRead(deps.members, deps.workshops, teamId, id, role, c))
    ) {
      return c.json({ error: "Forbidden: not a member of this team" }, 403);
    }

    // Read before deleting — gates 3 and 4 both need the stored row, and a 404
    // here is more honest than a delete that silently matched nothing.
    const existing = await deps.invitations.get(teamId, email);
    if (!existing) {
      return c.json({ error: "Invitation not found" }, 404);
    }

    // Gate 3 — against the role on the ROW. Absent platformRole means PARTICIPANT,
    // matching the default POST applies when it writes the row.
    const grantedRole = existing.platformRole || "PARTICIPANT";
    if (!canGrantRole(role, grantedRole)) {
      return c.json(
        { error: `Forbidden: your role cannot revoke a ${grantedRole} invitation` },
        403
      );
    }

    // Gate 3b — OWNERSHIP, for a row that carries a workshop. Same gap and same reasoning as on the
    // /workshop clear route: revoking a foreign owner's still-PENDING JUDGE invitation destroys the
    // same access, so it needs the same check. A row with no workshopId is unaffected and spends no
    // hop — which is every ordinary team or platform invitation.
    const notOwned = await refuseUnownedWorkshopWithdrawal(
      deps.workshops,
      c,
      existing.workshopId,
      grantedRole,
      id,
      role
    );
    if (notOwned) return notOwned;

    // Gate 4 — a row in a TERMINAL status is history and is never DELETED.
    //
    // Widened from `=== "ACCEPTED"` to both terminal statuses with the removal fix, and the
    // REVOKED half matters as much: that row is what a removal left behind precisely so the
    // provenance survives (who invited them, when they accepted), and the former-members view
    // reads `joinedAt` from the audit entry recorded alongside it. Letting this route DELETE a
    // REVOKED row would destroy that record — and it would grant nothing back, because
    // deleting it also removes the only evidence the grant was withdrawn.
    //
    // Two messages, because the remedies differ and an operator needs the actionable one.
    // 409 for both: the request is well-formed and the caller is permitted, the row is simply
    // in a state this operation does not apply to.
    if (isSpentInvitation(existing.status)) {
      return c.json(
        {
          error: isRevokedInvitation(existing.status)
            ? "This invitation was already withdrawn when the member was removed. Send a fresh invitation to re-admit them."
            : "This invitation has already been accepted. Remove the member or revoke their account access instead.",
        },
        409
      );
    }

    const removed = await deps.invitations.revoke(teamId, email);
    if (!removed) {
      // Lost a race with another revoke/accept between the read and the delete.
      return c.json({ error: "Invitation not found" }, 404);
    }

    // Audited as an event, not just a log line: this withdraws a privilege grant,
    // so who revoked what for whom is worth keeping outside CloudWatch retention.
    await deps.events.publish({
      source: "team-service",
      type: "invitation.revoked",
      detail: {
        teamId,
        email,
        platformRole: grantedRole,
        revokedBy: id,
        revokedAt: new Date().toISOString(),
      },
    });

    return c.json({ revoked: true, email });
  });

  /**
   * WITHDRAW THE WORKSHOP ENTITLEMENT on an invitation — and NOTHING ELSE.
   *
   * ── WHY A SEPARATE ROUTE EXISTS AT ALL ──
   *
   * There was NO way to withdraw a REGISTERED judge's workshop access. A JUDGE's access lives
   * ENTIRELY in `invitation.workshopId` — WORKSHOP_POLICY.JUDGE is "REQUIRED", a judge is never
   * a team member, and GET /entitlements/workshops reads the field straight off the row — and
   * the only route that touched an invitation's lifecycle from the admin side was the DELETE
   * above, which answers 409 on an ACCEPTED row. So `DELETE
   * /v1/teams/PLATFORM/invitations/judge@example.com` returned 409, the row kept its
   * `workshopId`, and the entitlement stood indefinitely.
   *
   * ⚠ THE 409 IS CORRECT AND THIS ROUTE DOES NOT RELAX IT. Read the DELETE's gate 4: that row
   * IS the audit record — it is what a removal deliberately left behind so the provenance
   * survives, and the former-members view reads `joinedAt` from the audit entry recorded
   * alongside it. DELETING it would destroy history to fix an access bug, and would grant
   * nothing back either, because deleting also removes the only evidence the grant was
   * withdrawn. That refusal stays exactly as it is.
   *
   * WHAT THIS DOES INSTEAD IS CLEAR ONE ATTRIBUTE. The row survives, its `status` survives, its
   * `acceptedAt`/`acceptedBy`/`invitedBy`/`sentAt`/`platformRole` all survive. Only the
   * entitlement field goes, plus a breadcrumb saying who took it and when. That is the whole
   * justification for a separate route rather than a widened DELETE: the two operations destroy
   * different amounts, and only one of them destroys history.
   *
   * ── METHOD AND PATH ──
   *
   * DELETE on `…/invitations/:email/workshop` — the entitlement is a SUBRESOURCE of the
   * invitation and DELETE is the verb that removes one, needs no body, and is idempotent by
   * definition (which this route is, at the store). PATCH with a body was the alternative and is
   * worse here: there is exactly one field and exactly one legal value for it, so a body would
   * be a shape to validate and a way to express requests this route must refuse. It needs NO
   * new gateway mapping — `InvitationByEmail` in the all-in-one template is
   * `/v1/teams/{teamId}/invitations/{proxy+}` with `Method: ANY`, and `{proxy+}` is greedy, so
   * `judge@example.com/workshop` matches. (That greediness is why the path is a suffix on the
   * existing route rather than a new prefix: an unmapped route exists in the Lambda, passes
   * every test, and returns the gateway's 404 in production.)
   *
   * ── THE SAME FOUR GATES AS THE DELETE, IN THE SAME ORDER, WITH GATE 4 INVERTED ──
   *
   *   1. canInvite      — a role that cannot grant cannot un-grant.
   *   2. canRead        — blocks the IDOR on `:teamId`, exactly as on POST and DELETE, and
   *                       SKIPPED at platform scope for the documented reason (see below).
   *   3. canGrantRole   — against the role ON THE ROW, never anything the caller sends.
   *   4. status         — INVERTED: this route works on a TERMINAL row, which is its reason to
   *                       exist. No status is refused.
   *
   * GATE 4'S INVERSION IS THE POINT. DELETE refuses a terminal row because DELETING destroys
   * the audit record; clearing `workshopId` destroys nothing, so the same reasoning that makes
   * that refusal right makes this permission right. An ACCEPTED row is precisely the case this
   * route was built for — a judge who has redeemed their invitation and is reading the workshop
   * today — and refusing it here would reproduce P1-2 under a new path.
   *
   * A REVOKED ROW IS ALSO ACCEPTED, not refused, and that is deliberate DEFENCE IN DEPTH rather
   * than an oversight: GET /entitlements/workshops already filters REVOKED and expired rows, so
   * such a row grants nothing TODAY — but that is one reader applying one predicate, and this
   * route's whole purpose is that the FIELD is what carries the grant. Clearing it makes every
   * reader, including a future one that forgets the status filter, see no entitlement. The same
   * reason the store REMOVEs the attribute instead of blanking it.
   *
   * GATE 2 IS SKIPPED AT PLATFORM SCOPE, AND IT MUST BE — read the DELETE's gate 2 comment,
   * which this pairs with. `canRead("PLATFORM", …)` resolves the sentinel to no membership and
   * no workshop, so it passes only via ADMIN's short-circuit in authz.ts. Leaving it in would
   * let a FACILITATOR create platform invitations (POST exempts the sentinel) whose entitlement
   * they could never withdraw — and every JUDGE row lives at PLATFORM scope, so gate 2 would
   * make this route unreachable for exactly the population P1-2 is about. Gates 1 and 3 are the
   * real boundary for these rows, and gate 3 still decides role by role what may be withdrawn.
   *
   * ── FAILURE SEMANTICS ──
   *
   * The row is read with `invitations.get` — a POINT GET on (teamId, email), NOT `listByEmail`
   * or `listByTeam`. Those two are the paged, bounded reads that THROW
   * `InvitationQueryBoundExceeded` rather than truncate, and this route deliberately calls
   * neither. `get` throwing on a real store failure is NOT caught here: Hono answers 5xx and
   * NOTHING has been written, which is the fail-closed direction for a route that withdraws
   * access. A catch that turned a store failure into a 200 would tell an operator the
   * entitlement was gone when it was not.
   */
  team.delete("/teams/:teamId/invitations/:email/workshop", async (c) => {
    const { id: actorId, role: actorRole } = requireIdentity(c);
    const teamId = c.req.param("teamId");
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();

    // Gate 1 — byte-for-byte the DELETE's, including the message: a caller who cannot manage
    // invitations gets the same answer whichever of the two they tried.
    if (!canInvite(actorRole)) {
      return c.json(
        { error: "Forbidden: your role cannot manage invitations" },
        403
      );
    }

    // Gate 2 — skipped at platform scope, NECESSARILY in step with POST and DELETE. See the
    // header: leaving it in would make every JUDGE row (all of which are platform-scoped)
    // un-withdrawable by a FACILITATOR who could have granted it.
    if (
      !isPlatformScope(teamId) &&
      !(await canRead(deps.members, deps.workshops, teamId, actorId, actorRole, c))
    ) {
      return c.json({ error: "Forbidden: not a member of this team" }, 403);
    }

    // Read before writing — gate 3 needs the stored row, and a 404 is more honest than a
    // clear that silently matched nothing. Not caught: see the header's failure semantics.
    const existing = await deps.invitations.get(teamId, email);
    if (!existing) {
      return c.json({ error: "Invitation not found" }, 404);
    }

    // Gate 3 — against the role on the ROW, never anything the caller sent. Whoever may hand
    // out a role may withdraw that same role's entitlement and no other: an EXECUTIVE who
    // could clear an ADMIN's or a JUDGE's workshop would be withdrawing access they were never
    // able to grant. Absent platformRole means PARTICIPANT, the default POST applies when it
    // writes the row and the same default the DELETE's gate 3 uses.
    const grantedRole = existing.platformRole || "PARTICIPANT";
    if (!canGrantRole(actorRole, grantedRole)) {
      return c.json(
        {
          error: `Forbidden: your role cannot revoke a ${grantedRole} workshop entitlement`,
        },
        403
      );
    }

    // Gate 3b — OWNERSHIP OF THE ROW'S OWN WORKSHOP, the check the mint path makes and this route
    // did not. See `refuseUnownedWorkshopWithdrawal`: gates 1 and 3 both pass for any FACILITATOR
    // holding a JUDGE row, and gate 2 is skipped at platform scope, so without this a facilitator
    // could strip any judge's entitlement anywhere on the platform. Ordered AFTER gate 3 because
    // that one is local and this one costs an east-west hop.
    const notOwned = await refuseUnownedWorkshopWithdrawal(
      deps.workshops,
      c,
      existing.workshopId,
      grantedRole,
      actorId,
      actorRole
    );
    if (notOwned) return notOwned;

    // Gate 4 is DELIBERATELY ABSENT — see the header. There is no status this route refuses,
    // because clearing one attribute destroys no history. The DELETE's gate 4 remains right
    // for the DELETE, and this is not a relaxation of it: that route still refuses to destroy
    // a terminal row, and nothing below can destroy one.

    /**
     * EVERYTHING THIS ROUTE NEEDS OFF THE ROW, COPIED OUT BEFORE THE WRITE.
     *
     * ⚠ NOT READ BACK OFF `existing` AFTERWARDS, and that is a correctness rule rather than a
     * style choice. `existing` is a row a repository handed us and the interface promises
     * nothing about whether it is a private snapshot or a live reference the write mutates — the
     * DynamoDB implementation deserialises a fresh object, the in-memory one mutates in place.
     * Reading `existing.workshopId` after the clear therefore produced the RIGHT value in
     * production and `undefined` in a test, which is the worst shape a bug can have: correct
     * where it is hard to observe and wrong where it is easy to dismiss as the fake's fault.
     *
     * Copying the primitives out removes the aliasing question for every field at once, so this
     * cannot come back the next time a field is added to the event or the entry.
     */
    const withdrawnWorkshopId = existing.workshopId;
    const rowStatus = existing.status;

    /**
     * WHO THE WITHDRAWAL IS ABOUT — and the honest constraint on naming them.
     *
     * ⚠ `AuditEntryWrite.subjectId` is ALWAYS A USER ID (it is the audit table's partition key,
     * and it was deliberately narrowed back to that after the removed break-glass action put a
     * TEAM id there). This route is keyed on an EMAIL, because that is the invitations table's
     * range key, and THIS SERVICE HAS NO EMAIL → SUB RESOLUTION: the local users read-model is
     * keyed on `id` with no email index, and reading Identity's users table is forbidden to
     * this context (see domain.ts's header).
     *
     * So the best LOCAL evidence is `acceptedBy` — the sub of whoever performed the acceptance.
     * For every ACCEPTED row this platform produces that IS the invitee: registration is
     * admin-provisioned and the portal calls POST /invitations/mine/accept on each sign-in,
     * which passes the CALLER's own verified sub. That is the P1-2 population exactly — a
     * registered judge.
     *
     * ⚠ THE RESIDUAL, STATED RATHER THAN IMPLIED: on a row reconciled by staff through
     * PATCH /invitations/:email/accept, `acceptedBy` is the STAFF MEMBER, not the invitee (that
     * route's own comment says so). An entry keyed on it would then land in the reconciler's
     * partition. Closing it needs the subject's sub, which means an east-west hop to Identity's
     * email-index ON A WRITE PATH — a new cross-service dependency this service has already
     * declined for the analogous problem (see the reactivation gate's "WHAT THIS DOES NOT
     * CLOSE"), and an architecture call rather than a decision for this change. FLAGGED, not
     * silently absorbed: the row's own `workshopRevokedBy` is unconditional and unambiguous, so
     * nothing about WHO ACTED depends on this field being precise.
     *
     * AN ABSENT `acceptedBy` — a PENDING row, or one accepted before the field existed — leaves
     * NO subject at all, and there is no id to invent. Handled explicitly below rather than
     * defaulted, because a wrong partition key on an append-only table cannot be corrected.
     */
    const auditSubjectId = existing.acceptedBy;

    // CONDITIONAL AT THE STORE on the attribute still existing, so a retried withdrawal is a
    // no-op there rather than re-stamping `workshopRevokedAt` — and two concurrent calls
    // resolve to exactly one winner, so they cannot both write an audit entry for one
    // withdrawal. `false` means there was no entitlement to withdraw (already cleared, or a
    // role for which a workshop is FORBIDDEN); the row's existence was established above, so
    // there is no "no row" case left to disambiguate.
    //
    // AFTER every read off `existing` and BEFORE everything that reports on the outcome, which
    // is the ordering the snapshot note above exists to make safe.
    //
    // NOT best-effort: this IS the access change the operator asked for. A store failure
    // throws and Hono answers 5xx, because reporting success on a withdrawal that did not
    // happen would leave a judge reading a workshop with nobody looking for them.
    const cleared = await deps.invitations.clearWorkshop(teamId, email, actorId);

    // ONE WITHDRAWAL, ONE ENTRY, and only when there is a subject to key it on.
    //
    // AWAITED but never allowed to fail the withdrawal: the entitlement is already gone, so
    // throwing here would have the operator retry a completed action. `audit.record` returns
    // false rather than throwing by contract; `audited` reports what is known and is NOT
    // swallowed — it is in the response body and it feeds the metric below.
    //
    // GUARDED ON `cleared`, so a retried withdrawal of an already-cleared entitlement writes
    // no second entry: it changed nothing, and an entry for it would claim a withdrawal that
    // did not occur. Same judgement as the removal's and the reactivation's audit skips.
    const audited =
      cleared && auditSubjectId
        ? await deps.audit.record({
            subjectId: auditSubjectId,
            action: "ENTITLEMENT_REVOKED",
            actorId,
            actorRole,
            // The team the invitation was issued against. OMITTED at platform scope rather than
            // carrying the sentinel: `teamId` on an entry means "this action was about that
            // team", and "PLATFORM" is not a team — the platform-access actions leave it absent
            // for the same reason. Spread-or-omit so absent stays absent.
            ...(isPlatformScope(teamId) ? {} : { teamId }),
            // No `teamName` lookup and no `joinedAt`: this is not a membership change, so a
            // team's name would be decoration and `joinedAt` would be a field about a
            // relationship this action does not touch. A read for either would be a store call
            // on a write path in service of nothing.
          })
        : false;

    // THE ALARM'S DATAPOINT — UnauditedAccessChangeAlarm in the all-in-one template, watching
    // the EMPTY dimension set (the aggregate across every action), so ENTITLEMENT_REVOKED is
    // covered by it the moment this emits with no change to the alarm.
    //
    // ⚠ INSIDE `cleared && auditSubjectId`, AND BOTH CONJUNCTS ARE LOAD-BEARING — read the
    // warning on AccessAuditMetric.audited in service-shared/metrics.ts before moving this.
    //
    //   `cleared`         — on the idempotent no-op branch `audited` is ALSO false, because no
    //                       entry was NEEDED. Emitting there would fire the alarm on a
    //                       double-clicked Revoke button: harmless, frequent, and exactly how
    //                       an alarm becomes noise nobody reads.
    //   `auditSubjectId`  — an entry that was never WRITABLE is not an entry that was LOST, and
    //                       the alarm's runbook opens by sending the operator to the audit
    //                       table's throttles, which would be a false trail. It is a DEFINITE
    //                       negative, not a transient one: a retry answers identically. So it
    //                       is counted separately below, on the same structured-warn idiom this
    //                       file already uses for ReactivateSubjectRoleUnevidenced, rather than
    //                       being folded into a signal that means "the trail lost a write".
    //
    // A 0 is emitted on the audited path too, so the metric exists in a healthy account and
    // "no data" stays distinguishable from "no failures".
    if (cleared && auditSubjectId) {
      emitAccessAuditMetric({
        action: "ENTITLEMENT_REVOKED",
        audited,
        subjectId: auditSubjectId,
        actorId,
        // Absent at platform scope, matching the audit entry above and the helper's contract
        // ("Which team, on the two team actions. Absent for platform-wide access changes").
        ...(isPlatformScope(teamId) ? {} : { teamId }),
        source: "team",
      });
    } else if (cleared) {
      // A REAL withdrawal with NO trail entry, for a reason that is not a store failure. Not
      // silent, and not the alarm: a structured warn with a STABLE EVENT NAME and a `metric`
      // field an alarm can be built on by log-metric filter, which is the idiom this file
      // already uses for the reactivation gate's unevidenced-role counter.
      //
      // IDS ONLY — no email, no workshop id (no unbounded metric dimension, and the
      // address is the subject's PII). `actorId` is here because the actor is the one thing
      // that IS known, and it is also on the row.
      console.warn(
        "[team] withdrew a workshop entitlement with NO trail entry — the invitation names no subject sub",
        {
          metric: "EntitlementRevokeSubjectUnknown",
          teamId,
          actorId,
          platformRole: grantedRole,
          // The status AS IT WAS when read — from the snapshot, not off `existing`. See above.
          status: rowStatus,
        }
      );
    }

    // PUBLISHED ONLY ON A REAL CHANGE, for the same reason the audit entry is: a consumer may
    // act on it, and re-publishing for a retried call that changed nothing would double any
    // such effect. Kept AFTER the audit write so the durable record precedes the notification.
    //
    // Its own type rather than reusing `invitation.revoked`: that event asserts the whole
    // invitation was withdrawn, and a consumer reading it for this would conclude the person
    // may no longer register. Published for the same reason the DELETE publishes its own — this
    // withdraws a privilege grant, and who withdrew what for whom is worth keeping outside
    // CloudWatch retention.
    if (cleared) {
      await deps.events.publish({
        source: "team-service",
        type: "invitation.workshop_revoked",
        detail: {
          teamId,
          email,
          platformRole: grantedRole,
          // The workshop whose access was withdrawn — captured BEFORE the clear, see above.
          workshopId: withdrawnWorkshopId,
          revokedBy: actorId,
          revokedAt: new Date().toISOString(),
        },
      });
    }

    return c.json({
      /**
       * TRUE when THIS call withdrew the entitlement.
       *
       * FALSE means there was nothing to withdraw — the row carries no `workshopId`, because it
       * was already cleared or because the granted role never had one. Both are a 200: the
       * caller's intent ("this person must not have access to that workshop") holds either way,
       * and an operator retrying a withdrawal should not be told it failed. A 404 here would
       * make a Revoke button error on a double-click. This flag is what distinguishes that from
       * a first withdrawal, and it is why `audited: false` on such a call means "no entry was
       * needed" rather than "an entry was lost".
       */
      revoked: cleared,
      /**
       * FALSE when no trail entry was written. On an idempotent no-op that is correct and
       * expected; after a REAL withdrawal it means access was withdrawn with no record of who
       * did it, which is worth an alarm — read together with `auditSubjectResolved` below,
       * which says WHICH of the two reasons applies.
       */
      audited,
      /**
       * FALSE when the invitation named no subject sub, so no entry COULD be keyed (see the
       * note on `auditSubjectId`). Surfaced rather than folded into `audited` because "the
       * trail lost a write" and "there was no partition to write to" are different facts and
       * only one of them is a store problem. Present on every branch so the response shape
       * does not depend on which path answered.
       */
      auditSubjectResolved: !!auditSubjectId,
      email,
    });
  });

  /**
   * Mark an invitation ACCEPTED.
   *
   * Scoped to the caller's OWN verified email, with one exception: team STAFF may
   * accept on someone's behalf, which is how a facilitator reconciles a roster.
   * Everyone else accepting an arbitrary address was a straightforward
   * authorization hole: `:email` is a path param, so any authenticated user could
   * flip any invitation on any team to ACCEPTED — burning a pending invite the real
   * recipient still needed, and doing it for teams they cannot even see.
   *
   * ── ⚠ "STAFF" MEANS `requireTeamAdministration`, NOT `requireTeamWrite` ──────────────────
   *
   * A SECURITY FINDING (high): the invitation-accept-on-behalf route, gated by
   * requireTeamWrite, admitted any ordinary team member, who could permanently burn
   * teammates' pending invitations. Verified: the guard did not mean what this comment said.
   *
   * `requireTeamWrite` excludes read-only roles and then calls `canRead`, whose FIRST
   * branch is an unconditional `members.get(teamId, userId)` — so every ordinary
   * PARTICIPANT member satisfied it. A member could list the team's pending
   * invitations (GET …/invitations needs only membership) and flip any of them.
   *
   * That is not recoverable by the victim: ACCEPTED is terminal in three places —
   * POST /teams/join refuses a spent invitation, DELETE …/invitations/:email answers
   * 409 on a spent row, and re-inviting the address is refused with
   * INVITATION_ALREADY_ACCEPTED — so a burned invite needs staff intervention.
   *
   * `requireTeamAdministration` is the predicate this route always described: staff
   * AND ownership of the team's workshop, the same guard the member-removal pair uses
   * after being gated the same wrong way. The sibling DELETE on this very resource
   * requires canInvite plus canGrantRole, which was the other clue that WRITE was
   * never the intended bar here.
   *
   * Accepting does NOT grant anything by itself (membership comes from POST
   * /teams/join, which re-checks the invitation, and the platform role comes from
   * the Cognito post-confirmation trigger), so this is integrity, not escalation.
   * It is still the caller's own row to flip or nobody's.
   */
  team.patch("/teams/:teamId/invitations/:email/accept", async (c) => {
    const teamId = c.req.param("teamId");
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();
    const { id: callerId, email: callerEmail } = requireIdentity(c);

    // Comparison on the token's verified email claim — never on anything the
    // request supplied twice.
    const isOwnInvitation =
      !!callerEmail && callerEmail.toLowerCase() === email;

    if (!isOwnInvitation) {
      const denied = await requireTeamAdministration(c, deps.workshops, teamId);
      if (denied) return denied;
    }

    // `acceptedBy` is WHO PERFORMED THE ACCEPTANCE, which for the staff-reconciliation
    // branch above is the staff member and not the invitee. That is the honest record:
    // the field is about the action, and an audit reader looking at a row a facilitator
    // reconciled should see the facilitator. Previously nothing was passed at all, so
    // every row accepted through this route recorded nobody.
    //
    // Errors are NOT swallowed here, unlike on the join and sign-in paths: this route's
    // entire purpose IS the flip, so a caller who is told `success` when the write
    // failed has been lied to about the only thing they asked for. Hono's error handler
    // turns a throw into a 500, which is the correct answer for "we could not do it".
    const flipped = await deps.invitations.accept(teamId, email, callerId);

    // `accepted` distinguishes "this call did it" from "there was nothing to do" — an
    // absent row or one already ACCEPTED. `success: true` is kept for the existing
    // callers, and is still truthful in both cases: the row is ACCEPTED or was never
    // there, and neither is a failure of this request.
    return c.json({ success: true, accepted: flipped });
  });

  /**
   * ACCEPT the caller's OWN invitation(s) — the first-sign-in flip.
   *
   * ── WHY THIS ROUTE EXISTS ──
   *
   * Registration is ADMIN-PROVISIONED now (`AllowAdminCreateUserOnly: true` on the
   * pool), and that silently removed the only thing that ever marked an invitation
   * accepted. In the old self-signup flow the invitee's own registration drove it; with
   * the account created by an admin there is no such moment, so a FACILITATOR could
   * complete the ENTIRE journey — Cognito account CONFIRMED, group assigned, profile
   * row written — and their invitation still read `status: PENDING`, `acceptedAt: null`.
   * Confirmed live. The Administration screen showed "Pending" for someone who had
   * plainly accepted.
   *
   * ── WHY FIRST SIGN-IN AND NOT PROVISIONING TIME ──
   *
   * Flipping it inside the user-access service right after AdminCreateUser would have
   * been one line in one place, and it would have made the field LIE. `acceptedAt` is an
   * audit fact meaning "this person took up the grant" — which is exactly why the revoke
   * gate refuses to delete an ACCEPTED row (see the DELETE above: the row is the
   * evidence someone redeemed it, and their access by then lives in Cognito). Stamping
   * it when an ADMIN creates the account would assert that the invitee acted at a moment
   * they had not yet seen the email, and would make every provisioned-but-never-used
   * account un-revocable. So the flip belongs at the first moment the PERSON
   * demonstrably acted, and signing in is that moment.
   *
   * ── THE THREE PROPERTIES THAT MAKE IT SAFE ON A SIGN-IN PATH ──
   *
   *   1. IDEMPOTENT. The portal calls this on every sign-in, not just the first, so the
   *      write is conditional AT THE STORE (`#status <> ACCEPTED`, see
   *      DynamoInvitationRepository.accept) — `acceptedAt` records the FIRST
   *      acceptance and never moves. Not a read-then-write, which would race two
   *      concurrent sign-ins into two different timestamps.
   *   2. NEVER FAILS THE SIGN-IN. Every failure is absorbed and reported in the body as
   *      a count, never as a status. A user who cannot sign in because a status update
   *      errored is a far worse defect than a stale status — and the next sign-in
   *      retries it for free, precisely because the operation is idempotent.
   *   3. SCOPED TO THE CALLER BY CONSTRUCTION. The addresses come from the VERIFIED
   *      token's email claim via listByEmail — there is no path parameter and no body,
   *      so there is nothing to tamper with and no way to accept someone else's row.
   *      That is what lets it need no authorization beyond authentication: the only
   *      rows it can reach are the caller's own.
   *
   * WORKS AT THE PLATFORM SENTINEL, which is the reported case. It accepts by
   * (teamId, email) taken FROM THE ROW rather than from a team lookup, so a
   * `teamId = "PLATFORM"` row is flipped exactly like a real team's — a facilitator or
   * judge has no team, and a route that resolved a team first would have skipped
   * precisely the rows this defect was reported about.
   *
   * Bounded by how many invitations one address holds (a handful), and sequential
   * rather than fanned out: these are single-item conditional writes on one partition
   * key, and a Promise.all over them would only add write pressure to the same rows in
   * exchange for nothing on a path measured in one round trip.
   */
  team.post("/invitations/mine/accept", async (c) => {
    const { id, email, role } = requireIdentity(c);
    if (!email) {
      // A token with no email claim cannot be matched to an invitation. Not an error:
      // there is genuinely nothing to accept, and this must never be the reason a
      // sign-in reports a failure.
      //
      // `membershipSkipped: 0` / `revoked: 0` on this and the error path below so the
      // response SHAPE is the same on every branch — a client that reads a field should not
      // have to know which internal path answered it.
      return c.json({
        accepted: 0,
        alreadyAccepted: 0,
        failed: 0,
        membershipSkipped: 0,
        revoked: 0,
        capRefused: 0,
      });
    }

    let rows;
    try {
      rows = await deps.invitations.listByEmail(email.toLowerCase());
    } catch (err) {
      // Reported as a failure count with a 200, NOT as a 5xx. The portal calls this
      // during sign-in and treats any rejection as fatal to nothing — but returning a
      // 500 would still surface in its logs as a failed request on the happy path, and
      // there is nothing the user or the client can do about it.
      console.error("[team] could not list invitations to accept at sign-in", {
        userId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({
        accepted: 0,
        alreadyAccepted: 0,
        failed: 1,
        membershipSkipped: 0,
        revoked: 0,
        capRefused: 0,
      });
    }

    let accepted = 0;
    let alreadyAccepted = 0;
    let failed = 0;
    // How many TEAM-scoped rows were flipped WITHOUT a membership write because the
    // caller's role may not hold one. Reported in the body so the outcome is observable
    // rather than inferred from a roster that never grew — otherwise this is precisely the
    // silent branch an operator would have to read the source to understand.
    let membershipSkipped = 0;
    // How many rows were skipped because the grant had been WITHDRAWN (a removal). Counted
    // separately from `alreadyAccepted` so a revocation is never misreported as an
    // acceptance, and so "this person keeps signing in against a withdrawn invitation" is
    // visible rather than something an operator has to infer.
    let revoked = 0;
    // How many rows could NOT be taken up because the team is at its seat cap (condition 7).
    // Those rows are left PENDING on purpose — see the branch that increments
    // this — so the count is "invitations still waiting for a seat", not a failure. Reported
    // in the body because a silent branch on the sign-in path is one an operator would have to
    // read the source to understand, and because it is the ONLY signal that somebody is
    // repeatedly signing in against a team that has no room for them.
    let capRefused = 0;

    // LAYER 3 of requirement (b) — THE ONE THAT WOULD BE MISSED, and the front
    // door a facilitator actually walks through.
    //
    // This route runs on EVERY sign-in and, since it learned to write membership, it is a
    // membership-granting path that no role check guarded. A facilitator holding a
    // team-scoped invitation row (issued before the invitation gate above existed, or by a
    // caller that bypassed it) became a full member of that team the first time they signed
    // in — silently, with no request they made saying so, and with exactly the ambient
    // content access the member-only rule removes.
    //
    // Hoisted out of the loop: one verified role decides every row, and reading it once
    // makes it plain that the decision is the CALLER's role and not any row's.
    const mayJoin = mayHoldTeamMembership(role);

    for (const row of rows) {
      // A REVOKED ROW IS SKIPPED ENTIRELY — no membership write, and NO status flip.
      //
      // LAYER 4, and it is not hypothetical: this route WRITES MEMBERSHIP, so with the
      // removal-driven revocation in place it is the second way back into a team a removed
      // person could take. The old `row.status === "ACCEPTED"` skip below would NOT have
      // caught a REVOKED row — the equality is against one literal — so the loop would have
      // fallen through, found no membership row (it was just deleted), written a fresh one,
      // and re-flipped the invitation to ACCEPTED on the removed person's very next sign-in.
      // Automatically, with no request from anyone saying so.
      //
      // NOT FOLDED INTO the ACCEPTED branch below, because the two outcomes differ. That one
      // reports `alreadyAccepted` and is a benign no-op on a redeemed grant; this one is a
      // WITHDRAWN grant, and calling it "already accepted" would misreport a revocation as
      // an acceptance in the counts an operator reads. `continue` BEFORE the try block, so
      // the row never reaches either write.
      //
      // The status is deliberately NOT re-flipped: REVOKED is TERMINAL, and only a person
      // with grant authority issuing a FRESH invitation (a new PENDING row) re-admits
      // someone. That is the same rule the join gate enforces.
      if (isRevokedInvitation(row.status)) {
        revoked++;
        console.warn(
          "[team] skipped a REVOKED invitation at sign-in — the grant was withdrawn",
          { teamId: row.teamId, userId: id }
        );
        continue;
      }

      // Skipped BEFORE the write when the row already says ACCEPTED. The store's
      // condition makes this correct either way — this only avoids a pointless
      // conditional write on every subsequent sign-in, which for a returning user is
      // every request to this route.
      if (isAcceptedInvitation(row.status)) {
        alreadyAccepted++;
        continue;
      }

      try {
        // ── 1. MEMBERSHIP FIRST, for TEAM-scoped rows only ──────────────────────
        //
        // Accepting a TEAM invitation has to make the invitee a MEMBER. This route
        // used to only flip the status, which left exactly the reported state: the
        // invitation read "Accepted" while the roster read "Members (0)". The person
        // was told they were on the team and was not on it.
        //
        // WHY THE ORDER MATTERS, and it is not cosmetic. The status flip is what makes
        // this row skipped on every later sign-in (`row.status === "ACCEPTED"` above).
        // So if the status were flipped first and the membership write then failed, the
        // row would be permanently ACCEPTED and the person permanently not a member —
        // nothing would ever retry it. Writing membership first means a failure leaves
        // the row PENDING and the NEXT sign-in reconciles it, which is the property
        // this whole route exists to provide.
        //
        // Platform-scoped rows (teamId = "PLATFORM") are skipped: a facilitator, judge
        // or executive has no team to join, and the sentinel is not a real team id.
        // Their acceptance is the status flip alone, exactly as before.
        //
        // ── AND SO ARE TEAM ROWS FOR A ROLE THAT MAY NOT HOLD MEMBERSHIP ──
        //
        // THE STATUS STILL FLIPS. Skipping the whole row instead would leave it PENDING
        // for ever, so the Administration screen would show "Pending" for a facilitator
        // who has plainly signed in — reintroducing, for exactly these three roles, the
        // defect this route was built to fix. The invitation was real and the person did
        // take it up; what they do not get is the membership row.
        //
        // The ORDERING NOTE above still holds and is why this is safe: membership-first
        // exists so a FAILED membership write leaves the row PENDING for the next sign-in
        // to retry. Here there is no failure to retry — the write is refused by a rule
        // that will give the same answer every time — so flipping the status is correct
        // rather than a lost reconciliation. Logged once per row, at warn, because a
        // team-scoped invitation for a platform role is a data problem someone should fix
        // at the source (the invitation gate now refuses to create one).
        if (!isPlatformScope(row.teamId) && !mayJoin) {
          membershipSkipped++;
          console.warn(
            "[team] accepted a team invitation WITHOUT membership — the role is platform-wide",
            { teamId: row.teamId, userId: id, role }
          );
        } else if (!isPlatformScope(row.teamId)) {
          // Idempotent by READ-THEN-SKIP rather than an unconditional write: this runs on
          // every sign-in, and a blind write would reset `joinedAt` each time, destroying
          // the record of when they actually joined. Same reasoning as the store's
          // conditional accept — see property 1 above. `admit` is ALSO conditional at the
          // store, so this read is an optimisation and not the correctness argument.
          const existing = await deps.members.get(row.teamId, id);
          if (!existing) {
            // ── THE COUNTER NEEDS THE TEAM'S `workshopId`, WHICH THIS PATH DOES NOT HAVE ──
            //
            // `teams` is keyed (workshopId HASH, id RANGE), so the ledger Update needs both
            // halves — and unlike POST /teams/join (which resolved the team by invite code and
            // has the whole row in hand) this loop holds only `row.teamId`.
            //
            // ⚠ SO THIS IS ONE EXTRA READ PER PENDING ROW ON THE SIGN-IN PATH: a `Limit: 1`
            // Query on `id-index`. Stated plainly because sign-in is the most latency-sensitive
            // path in the platform. It is bounded by the number of PENDING invitations one address holds
            // (a handful, and each is consumed on first success, so the steady state for a
            // returning user is ZERO — the `isAcceptedInvitation` skip above short-circuits
            // before reaching here).
            //
            // ⚠ `row.workshopId` IS NOT USABLE FOR THIS. It is the invitation's WORKSHOP GRANT
            // (present only for a JUDGE, per WORKSHOP_POLICY) and NOT the team's workshop, so
            // using it would send the increment at a key that mostly does not exist — the
            // ledger would silently never move. It is still passed to the EVENT below, which is
            // its existing meaning and is deliberately unchanged.
            const teamRow = await deps.teams.getById(row.teamId).catch(() => null);
            if (!teamRow) {
              // Counted as a failure, not silently skipped: the row stays PENDING and the next
              // sign-in retries, which is exactly the reconciliation property the
              // membership-first ordering exists to provide. A team that cannot be resolved is
              // either deleted or a transient read failure, and neither is something to
              // fabricate an admission for.
              failed++;
              console.warn(
                "[team] could not resolve the team for a pending invitation at sign-in — leaving it PENDING",
                { teamId: row.teamId, userId: id }
              );
              continue;
            }

            const outcome = await deps.members.admit(
              {
                teamId: row.teamId,
                userId: id,
                // Honour the team role the inviter chose; BUILDER for older invitations
                // that carry none. Identical fallback to POST /teams/join, deliberately:
                // two ways into a team must not produce two different roles.
                role: row.teamRole || "BUILDER",
                joinedAt: new Date().toISOString(),
              },
              teamRow.workshopId
            );

            // ── A CAP REFUSAL AT SIGN-IN LEAVES THE ROW PENDING (condition 7) ──
            //
            // 200, `capRefused` in the body, and THE STATUS IS NOT FLIPPED. Every part of that
            // is deliberate:
            //
            //   NOT A THROW. This route runs on every sign-in. A 5xx here would make a full
            //   team break the sign-in of someone who has other, perfectly valid invitations.
            //
            //   THE ROW STAYS PENDING, which is the whole rule. Flipping it to ACCEPTED
            //   would make the `isAcceptedInvitation` skip above bypass this row FOREVER — so
            //   when a seat is later freed, the person's next sign-in would not take it and
            //   NOTHING would ever retry. A freed seat would be permanently unreachable for
            //   the very person holding the invitation for it. Leaving it PENDING means the
            //   next sign-in after a removal admits them for free.
            //
            //   `continue`, so no `accepted`/`alreadyAccepted` count moves. The invitation was
            //   neither accepted nor spent; it is still waiting, and reporting it as accepted
            //   would be the same lie in the counters that the status flip would be in the row.
            if (outcome === "full") {
              capRefused++;
              console.warn(
                "[team] a pending invitation could not be taken up — the team is at its seat cap; row left PENDING for a later sign-in",
                { teamId: row.teamId, userId: id }
              );
              continue;
            }

            // "already-member" means an INACTIVE row exists — the ACTIVE-only `get` above
            // returned null for it. NOT re-admitted, for the reason POST /teams/join gives:
            // it would replace the row and destroy the preserved role. The status flip below
            // still proceeds, because the invitation WAS taken up and leaving it PENDING would
            // make the Administration screen show "Pending" for somebody who has plainly
            // signed in — the same judgement as the `membershipSkipped` branch above.
            if (outcome === "already-member") {
              console.warn(
                "[team] sign-in accept found an INACTIVE membership row — not re-admitting; a restoration is an operator action",
                { teamId: row.teamId, userId: id }
              );
            } else {
              // Same event the invite-code path publishes, so downstream consumers cannot
              // tell the two routes apart — a team gained a member either way.
              await deps.events.publish({
                source: "team-service",
                type: "member.joined",
                detail: { teamId: row.teamId, workshopId: row.workshopId, userId: id },
              });
            }
          }
        }

        // ── 2. THEN the status flip ─────────────────────────────────────────────
        // (teamId, email) FROM THE ROW: `row.teamId` is the sentinel for a platform
        // invitation and a real id for a team one, and both are the table's partition
        // key, so one call shape serves both. `id` is the caller's own verified sub —
        // the person accepting IS the invitee on this path.
        const flipped = await deps.invitations.accept(row.teamId, row.email, id);
        if (flipped) accepted++;
        else alreadyAccepted++;
      } catch (err) {
        failed++;
        // Logged with identifiers only — no address, which is PII, and the caller's sub
        // is enough to correlate. Never rethrown: see property 2 above.
        console.error("[team] could not accept an invitation at sign-in", {
          teamId: row.teamId,
          userId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Counts rather than the rows themselves: the client's only job is to fire this and
    // move on, and echoing invitation rows here would duplicate /invitations/mine with
    // no gate of its own to keep in step.
    //
    // `membershipSkipped`, `revoked` and `capRefused` are ADDITIVE — the three original fields
    // keep their meaning, so the portal's current reader (trpc/routers/team.ts, which types
    // exactly those three) is unaffected and needs no coordinated deploy. They are here so
    // "accepted but not a member", "signed in against a withdrawn grant" and "still waiting
    // for a seat" are REPORTED outcomes rather than things an operator has to deduce from a
    // roster that did not grow.
    return c.json({
      accepted,
      alreadyAccepted,
      failed,
      membershipSkipped,
      revoked,
      capRefused,
    });
  });

  /**
   * Every invitation issued to the AUTHENTICATED caller's own email, resolved to the team
   * it belongs to — and, WHERE IT IS STILL ACTIONABLE, that team's JOIN CODE.
   *
   * This backs the web app's post-registration welcome page: a freshly-registered
   * participant has no membership yet (registration deliberately does not auto-join), so
   * the code must come from the invitation, not from /teams/mine.
   *
   * The email comes from the verified token (never a query param or body), so a caller can
   * only ever see rows for teams THEY were invited to — there is no input to tamper with.
   * `joined` lets the UI distinguish "here's your code" from "you're already in".
   *
   * ── TWO SUPPRESSIONS, BOTH ADDED WITH THE REJOIN FIX ──
   *
   * This route returned EVERY row it found, each carrying `inviteCode` unconditionally, and
   * that made it the ENABLING HALF OF THE REJOIN verified against the deployed stack: a
   * participant removed from a team still got that team back from this route, with its live
   * invite code, and POST /teams/join accepted it.
   *
   *   1. A ROW IS RETURNED ONLY IF THE CALLER STILL HAS A RELATIONSHIP TO THE TEAM —
   *      they are a MEMBER, or their invitation is still LIVE (not spent). A removed
   *      person's ACCEPTED row and a REVOKED row are both dropped: reporting a team
   *      somebody is not on and has no live invitation to is telling them about a team
   *      they have no current connection with, and it is what put the rejoin card on
   *      their screen in the first place.
   *   2. `inviteCode` IS RETURNED ONLY WHILE THE INVITATION IS LIVE. The code is a
   *      TEAM-WIDE shared secret and the second factor of a join (the first being the
   *      invitation row), so it goes only to someone who still needs it to get IN. A
   *      MEMBER does not: they are already on the team, and their card renders the
   *      "Joined" badge rather than a code to type. DEFENCE IN DEPTH on top of (1) —
   *      if the row filter is ever loosened, the credential still does not travel.
   *
   * ⚠ CONTRACT CHANGE FOR THE PORTAL: `inviteCode` is now `string | null`. A joined
   * member gets null, so the welcome page must render its "Joined" state rather than an
   * empty code box. `codeAvailable` is supplied so the UI can branch on a boolean rather
   * than on a null.
   *
   * EXPIRY IS DELIBERATELY NOT PART OF "LIVE" HERE. `expiresAt` bounds the invite LINK and
   * the REGISTRATION window (enforced in the pre-signup trigger, which is the one place it
   * cannot be bypassed). Applying it to a team join would refuse a participant who
   * registered on day one and joins their team on day three — a legitimate flow, and a
   * lockout rather than a leak. See the note on the join gate.
   */
  team.get("/invitations/mine", async (c) => {
    const { id, email } = requireIdentity(c);
    if (!email) {
      // A token with no email claim can't be matched to an invitation. Empty (not
      // an error) so the welcome page renders its "ask your facilitator" state.
      return c.json({ invitations: [] });
    }

    const invitations = await deps.invitations.listByEmail(email.toLowerCase());
    if (invitations.length === 0) {
      return c.json({ invitations: [] });
    }

    const resolved = await Promise.all(
      invitations.map(async (inv) => {
        // Platform-scoped invitations have no team to report, and this route's whole
        // payload is team-shaped (name, workshop, JOIN CODE) because it backs the
        // participant welcome page. Skipped rather than returned with nulls: the
        // people who hold these rows (admin/facilitator/judge) don't land on that
        // page at all — landingPathForRole sends them to the workshop list — so a
        // team-less entry there would only render an empty card with no join code.
        if (isPlatformScope(inv.teamId)) return null;

        const teamItem = await deps.teams.getById(inv.teamId);
        // Skip invitations whose team was deleted — a dangling row must not break
        // the whole page.
        if (!teamItem) return null;

        const joined = !!(await deps.members.get(teamItem.id, id));
        // Computed ONCE and used for both suppressions, so the row filter and the code
        // filter cannot drift into disagreeing about what "spent" means.
        const spent = isSpentInvitation(inv.status);

        // Suppression 1 — see the header. A caller who is neither on the team nor holds
        // a live invitation to it hears nothing about it.
        if (spent && !joined) return null;

        return {
          teamId: teamItem.id,
          teamName: teamItem.name,
          workshopId: teamItem.workshopId,
          // Suppression 2 — null once the invitation is spent, whether by acceptance or
          // by the removal-driven revocation.
          inviteCode: spent ? null : teamItem.inviteCode,
          /** So the UI branches on a boolean rather than probing for null. */
          codeAvailable: !spent,
          platformRole: inv.platformRole || "PARTICIPANT",
          teamRole: inv.teamRole || null,
          status: inv.status,
          joined,
        };
      })
    );

    return c.json({ invitations: resolved.filter(Boolean) });
  });

  // Resolve the roles an email was invited with, keyed by the invite CODE (not a
  // teamId — the registration flow only knows the code from the link). This is
  // how the admin app's pre-auth register route learns the AUTHORITATIVE platform
  // role for an invitee without trusting anything the browser submits: the role
  // lives on the server-stored invitation, created only by an authenticated
  // admin/facilitator.
  //
  // NOT reachable from the internet: no gateway route maps it (only
  // /v1/invitations/{mine,lookup-by-token} are mapped), so the sole way in is
  // in-process or from inside the VPC. It is NOT protected by the gateway stripping
  // x-internal-token — nothing strips that header at the AWS edge; see
  // shared/edge-identity.ts. It also sits behind requireAuth like every other
  // non-public route. Returns 404 (not the roles) when there's no matching
  // invitation, so a guessed code + email reveals nothing.
  team.get("/invitations/lookup", async (c) => {
    /**
     * ⚠ AN IN-SERVICE ROLE GUARD, BECAUSE THE COMMENT ABOVE DESCRIBES A CONTROL THAT LIVES IN ANOTHER
     * REPOSITORY. "No gateway route maps it" is true and is the primary defence — but it is a line of
     * CloudFormation in the `infrastructure` repo, and a single `/{proxy+}` mapping added there (a very
     * ordinary change) converts this route from unreachable to open with nothing in THIS repo failing.
     * The comment even says so: unreachability comes from "the absent gateway route, NOT from any
     * x-internal-token header stripping".
     *
     * ⚠ AND THIS REPO'S TWO SOURCES OF TRUTH DISAGREE ABOUT IT. ROLES.md states as a blanket property
     * that "every service route is mapped behind a JWT authorizer" — if that sentence is right, this
     * route was already reachable by any authenticated caller, PARTICIPANT included. Rather than
     * resolve a documentation dispute, this makes the outcome the same either way.
     *
     * `canReadDirectory` (ADMIN + FACILITATOR) is the right set: the payload is invitation
     * administration — it resolves the AUTHORITATIVE platform role for an address — which is exactly
     * what the two directory routes already gate on. Verified safe to add: NOTHING calls this route.
     * `cognito-presignup` reads DynamoDB directly rather than calling it (its handler says why), the
     * portal only uses the token-keyed `lookup-by-token`, and a sweep of services, portal and desktop
     * finds no other caller. Every existing test here already presents ADMIN.
     */
    const { role } = requireIdentity(c);
    if (!canReadDirectory(role)) {
      return c.json(
        {
          error: "Forbidden: only an administrator or facilitator may resolve an invitation",
          code: "INVITATION_LOOKUP_FORBIDDEN",
        },
        403
      );
    }

    const inviteCode = c.req.query("inviteCode");
    const email = c.req.query("email")?.toLowerCase();
    if (!inviteCode || !email) {
      return c.json({ error: "inviteCode and email are required" }, 400);
    }

    // ⚠ AMBIGUITY COLLAPSES INTO THIS ROUTE'S EXISTING 404, deliberately — unlike the join
    // route's distinct 409. This route's whole design is that a guessed code plus an email
    // reveals nothing (see its header, and the canSeeUser refusal below, which reuses the same
    // 404 for the same reason). A distinct status here would confirm that the presented code IS
    // a real one held by two teams, which is more than the caller is entitled to learn. The
    // operator log carries the fact instead.
    let teamItem: Team | null;
    try {
      teamItem = await deps.teams.getByInviteCode(inviteCode);
    } catch (err) {
      if (err instanceof AmbiguousInviteCodeError) {
        console.error(
          "[team] invitation lookup refused — this code is shared by more than one team",
          { matches: err.matches }
        );
        return c.json({ error: "No matching invitation" }, 404);
      }
      throw err;
    }
    if (!teamItem) {
      return c.json({ error: "No matching invitation" }, 404);
    }

    const invitation = await deps.invitations.get(teamItem.id, email);
    if (!invitation) {
      return c.json({ error: "No matching invitation" }, 404);
    }

    // Default to PARTICIPANT for legacy invitations that predate role capture.
    const resolvedRole = invitation.platformRole || "PARTICIPANT";

    /**
     * ⚠ THE VISIBILITY MATRIX, NOT JUST THE COARSE DIRECTORY GATE.
     *
     * `canReadDirectory` answers "may you administer invitations at all" — {ADMIN, FACILITATOR}. It
     * does NOT answer "may you learn that THIS address holds ADMIN", and this route was answering the
     * second question with the first one's gate. `USER_VISIBILITY_GRANTS` states the platform's own
     * rule: a FACILITATOR sees every role EXCEPT ADMIN, because "a facilitator has no business
     * enumerating who holds full platform access … knowing WHICH accounts are the valuable ones to
     * phish or socially engineer is itself the reconnaissance step". The identity service enforces
     * that matrix per row; these team routes did not.
     *
     * ⚠ THE SAME 404 AS THE NO-INVITATION CASE, deliberately. A distinct 403 would confirm that a row
     * EXISTS and is merely hidden, which is most of the fact being withheld — the route's own header
     * already applies that reasoning ("Returns 404 (not the roles) when there's no matching
     * invitation, so a guessed code + email reveals nothing").
     */
    if (!canSeeUser(role, resolvedRole)) {
      return c.json({ error: "No matching invitation" }, 404);
    }

    return c.json({
      teamId: teamItem.id,
      workshopId: teamItem.workshopId,
      email: invitation.email,
      platformRole: resolvedRole,
      teamRole: invitation.teamRole || null,
    });
  });

  // Resolve the AUTHORITATIVE platform role for an email, keyed by EMAIL alone
  // (no invite code). This backs the native-Cognito invite-only signup gate: the
  // pre-signup trigger allows account creation only when the email has at least
  // one invitation an admin/facilitator issued, and takes the role from it. The
  // browser never supplies the role, so it stays tamper-proof.
  //
  // Deliberately UNMAPPED in API Gateway (an unauthenticated email-probing endpoint
  // on the internet is exactly what it must not be), which is also why the
  // pre-signup trigger reads the invitations table directly instead of calling this
  // — see cognito-presignup/src/handler.ts. Its unreachability comes from the
  // absent gateway route, NOT from any x-internal-token header stripping at the
  // edge, which does not exist (see shared/edge-identity.ts). Returns 404 when the
  // email has no invitation, so probing an un-invited address reveals nothing.
  //
  // It also sits behind requireAuth like every other non-public route, so it is not
  // anonymous even if it is ever mapped. That is asserted in routes.test.ts's
  // "anonymous reachability" block rather than left to be inferred from the middleware,
  // because the consequence of getting it wrong is an open email-probing endpoint.
  team.get("/invitations/lookup-by-email", async (c) => {
    /**
     * ⚠ THE SAME IN-SERVICE GUARD, AND THIS IS THE ROUTE THAT NEEDED IT MOST. Keyed on EMAIL ALONE
     * with no invite code, it answers "does this address hold an invitation, and at what platform
     * role?" — an email-to-privilege enumeration oracle if it is ever reachable. Its own comment calls
     * that out ("an unauthenticated email-probing endpoint on the internet is exactly what it must not
     * be") and then rests the control entirely on an absent gateway mapping in another repository.
     *
     * The 404-on-miss is good and limits this to CONFIRMED hits — but confirming "this address is an
     * ADMIN" is precisely the reconnaissance step for a targeted phishing attempt, and this platform
     * has already had one branded-email relay finding (notify's SENDER_ROLES).
     *
     * Safe to add for the same verified reason as the route above: no caller exists. The pre-signup
     * trigger deliberately reads the invitations table directly INSTEAD of calling this, which its
     * handler documents — so the signup gate this route was written for does not use it.
     */
    const { role } = requireIdentity(c);
    if (!canReadDirectory(role)) {
      return c.json(
        {
          error: "Forbidden: only an administrator or facilitator may resolve an invitation",
          code: "INVITATION_LOOKUP_FORBIDDEN",
        },
        403
      );
    }

    const email = c.req.query("email")?.toLowerCase();
    if (!email) {
      return c.json({ error: "email is required" }, 400);
    }

    const all = await deps.invitations.listByEmail(email);
    // Lapsed invitations do not admit a sign-up. Filtering here (rather than only
    // on the /join page) is what makes the 24h expiry unbypassable: a recipient who
    // skips the emailed link and goes straight to the Hosted UI is still gated on
    // a LIVE invitation row.
    //
    // REVOKED rows are excluded too, and only REVOKED — this route resolves the role for a
    // signup, so it must agree with the pre-signup trigger about which rows are LIVE (see
    // isInvited there, which now refuses both terminal statuses). A withdrawn grant must not
    // be what decides someone's platform role. ACCEPTED rows are deliberately still
    // considered: a row is ACCEPTED the moment its holder signs in, and this is the lookup
    // that tells the system what role they hold, so excluding them would leave an existing
    // user's role unresolvable.
    const invitations = all.filter(
      (inv) => !isExpired(inv.expiresAt) && !isRevokedInvitation(inv.status)
    );
    if (invitations.length === 0) {
      // Same 404 whether the email was never invited or its invite lapsed — the
      // caller learns nothing about addresses it doesn't already control.
      return c.json({ error: "No matching invitation" }, 404);
    }

    // An email can be invited to several teams. Collapse to the single highest-
    // privilege platform role (same precedence the rest of the system uses) so the
    // Cognito group assignment can't be under-privileged by invitation ordering.
    //
    // The LIVE rows only — filtered above, because this decides a GRANT. The reactivation
    // gate calls the same collapse over EVERY row, because it decides a refusal; the shared
    // helper takes the rows it is given for exactly that reason.
    const best = highestPlatformRole(invitations);

    /**
     * ⚠ THE VISIBILITY MATRIX, AND THIS IS THE ROUTE THAT NEEDED IT MOST.
     *
     * Keyed on EMAIL ALONE with no invite code, this answers "does this address hold an invitation,
     * and at what platform role?" — the route's own comment calls it "an email-to-privilege
     * enumeration oracle". `canReadDirectory` gates WHETHER you may resolve invitations; it does not
     * gate WHICH roles you may learn about, and `USER_VISIBILITY_GRANTS` says a FACILITATOR must not
     * learn that an account holds ADMIN ("knowing WHICH accounts are the valuable ones to phish or
     * socially engineer is itself the reconnaissance step"). Confirming "this address is an ADMIN" is
     * precisely that step — and this platform has already had one branded-email relay finding, which
     * is what makes the pairing more than theoretical.
     *
     * ⚠ THE SAME 404 AS THE NO-INVITATION CASE. The route already returns 404 rather than the roles
     * when nothing matches, "so a guessed code + email reveals nothing"; a distinct 403 here would
     * undo that by confirming the row exists. Withheld, not merely unlabelled.
     *
     * Uses this service's LOCAL copy of the matrix — the one already relied on for audit-actor
     * resolution — rather than adding a fourth table to keep in step.
     */
    if (!canSeeUser(role, best)) {
      return c.json({ error: "No matching invitation" }, 404);
    }

    return c.json({ email, platformRole: best });
  });

  // Resolve an invite LINK's token to the address it was issued to, so the /join
  // page can show whose invite it is, whether it has lapsed, and prefill the
  // Hosted UI — without ever accepting an email from the URL.
  //
  // Keyed on the token's SHA-256: the raw token is never stored, so this is a
  // digest comparison, not a secret lookup. 256 bits of entropy means guessing is
  // not a threat model; a wrong token simply 404s.
  //
  // UNAUTHENTICATED by design (see PUBLIC_PATHS above) — the visitor has no
  // account yet, so the invite token itself is the credential. Unlike its
  // lookup-by-email/lookup-by-code siblings, this route cannot be used to probe an
  // address: you must already hold the secret it is keyed on, and it reveals only
  // that invitation. It is therefore the one lookup* route safe to map in the
  // gateway.
  team.get("/invitations/lookup-by-token", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "token is required" }, 400);
    }

    const invitation = await deps.invitations.getByTokenHash(
      hashInviteToken(token)
    );
    if (!invitation) {
      return c.json({ error: "No matching invitation" }, 404);
    }

    // A lapsed link gets a DISTINCT, machine-readable answer rather than a 404:
    // unlike a bad token, the visitor demonstrably held a real invite, so the page
    // should say "this expired, ask for another" instead of "not found". Safe to
    // disclose — they already possess the token this is keyed on.
    if (isExpired(invitation.expiresAt)) {
      return c.json(
        { error: "This invitation has expired", code: "INVITE_EXPIRED" },
        410
      );
    }

    /**
     * ── ⚠ A SPENT INVITATION ANSWERS WITH ITS STATUS AND NOTHING ELSE ─────────────────────
     *
     * A SECURITY FINDING (medium): the unauthenticated invite-token lookup returned a
     * team's live join code, the invitee's email and platform role even for REVOKED and
     * ACCEPTED invitations. Verified: only expiry was checked, and status was reported back rather
     * than acted on.
     *
     * Revoked and accepted rows are retained FOREVER on purpose — they are the provenance
     * record — so a removed member's original /join/<token> email kept resolving indefinitely
     * and kept handing out the team's CURRENT join code, another person's address and their
     * platform role, to a caller with no session at all.
     *
     * The authenticated sibling (GET /invitations/mine) already does the opposite: it nulls
     * inviteCode once the invitation is spent, with a comment stating the credential must not
     * travel. An unauthenticated route has strictly less standing to disclose it.
     *
     * ⚠ THE TWO SPENT CASES ANSWER DIFFERENTLY, AND THAT IS DELIBERATE — a blanket 410 would
     * have broken a working journey. The /join page has a dedicated ACCEPTED branch that
     * redirects to /login ("this person has finished setting up their account, so the temporary
     * password in their invitation email is spent"), and it reads ONLY `status` to do it. So
     * ACCEPTED keeps a 200 carrying just that field, and REVOKED — which the page has no branch
     * for and would otherwise fall through to a sign-up form with an undefined email — gets the
     * 410 the page already renders as a dead end.
     */
    if (isSpentInvitation(invitation.status)) {
      if (invitation.status === "ACCEPTED") {
        return c.json({ status: invitation.status });
      }
      return c.json(
        { error: "This invitation is no longer valid", code: "INVITE_REVOKED" },
        410
      );
    }

    const teamItem = await deps.teams.getById(invitation.teamId);

    return c.json({
      email: invitation.email,
      teamId: invitation.teamId,
      // A dangling teamId (team deleted after inviting) must not 500 the page.
      teamName: teamItem?.name ?? null,
      /**
       * ⚠ `inviteCode` IS GONE FROM THIS RESPONSE ENTIRELY, not merely nulled when spent.
       *
       * It is the team's live join credential and this route is unauthenticated, so the
       * question is not "when may it travel" but "why was it here at all" — and NO CONSUMER
       * EVER READ IT. The only two callers are the portal's /join page, which uses email,
       * teamName and status, and the observability canary, which asserts a 404 for a sentinel
       * token. Withholding it only for spent rows would have left the same credential on the
       * same unauthenticated route for every pending one.
       */
      platformRole: invitation.platformRole || "PARTICIPANT",
      teamRole: invitation.teamRole || null,
      status: invitation.status,
      expiresAt: invitation.expiresAt ?? null,
    });
  });

  // --- Directory context for the Administration screen -----------------------
  //
  // Two endpoints, both read-only, both gated on canReadDirectory. They exist because
  // the Administration screen asks TEAM-context questions about IDENTITY-context rows,
  // and neither service can answer alone:
  //
  //   "which users are in team X / workshop Y?"  → only this service knows
  //   "what is that user's name and role?"       → only Identity knows
  //
  // So the BFF composes: resolve here, hydrate there. The alternative — teaching
  // Identity about teams, or this service about the users table — would put one
  // context's data behind the other's API, which is the coupling the split exists to
  // avoid (see the header comment on domain.ts).

  /**
   * The user ids belonging to a team, or to every team in a workshop.
   *
   * Backs the Administration screen's TEAM and WORKSHOP filters. Returns bare ids and
   * nothing else — no names, no emails, no roles — because the caller must still put
   * them through Identity's visibility filter, and a name returned here would be a
   * name that bypassed it.
   *
   * `workshopId` fans out across the workshop's teams and DEDUPLICATES: one person can
   * be on several teams in a workshop, and a duplicated id would hydrate to a
   * duplicated row on screen.
   *
   * ── ⚠ THE OWNERSHIP CHECK BELOW WAS ADDED BECAUSE THIS ROUTE'S ORIGINAL
   * JUSTIFICATION STOPPED BEING TRUE ──────────────────────────────────────────────────
   *
   * It read: "NOT gated on canRead/requireTeamRead, deliberately … for a FACILITATOR filtering
   * the directory would mean they could only filter by teams in workshops they personally own,
   * while THE DIRECTORY ITSELF ALREADY SHOWS THEM EVERY USER ON THE PLATFORM bar admins. The
   * filter would then be narrower than the list it filters, which reads as a bug. What this
   * discloses is a SUBSET of ids the caller can already enumerate through the directory."
   *
   * That reasoning was sound WHEN WRITTEN and its premise is now false. The teams directory
   * became ownership-scoped, so a FACILITATOR can no longer enumerate another
   * owner's teams — while this route still told them WHO IS IN THEM. Bare ids, no names or
   * emails, so it is an ASSOCIATION leak rather than a PII one ("these people are in that
   * experience you do not own") — but that association is exactly what `seesAllTeams` now
   * refuses, and one route must not undo another's gate.
   *
   * ⚠ THE OBJECTION IT RAISED IS REAL AND IS ACCEPTED: a facilitator's workshop FILTER is now
   * narrower than the user LIST it filters, because Identity's visibility rule is role-based
   * (a facilitator sees every non-admin) while this is ownership-based. That asymmetry is
   * deliberate — the list discloses WHO EXISTS, which is user administration; the filter would
   * disclose WHO IS WHERE, which is experience data.
   *
   * ⚠ ADMIN IS DELIBERATELY LEFT PLATFORM-WIDE. User administration is
   * the one area where ADMIN is intentionally not experience-scoped (see ROLES.md's ⚙ rows),
   * and an admin can already list every experience for the invite picker.
   */
  team.get("/directory/user-ids", async (c) => {
    const { id: callerId, role } = requireIdentity(c);
    if (!canReadDirectory(role)) {
      return c.json(
        { error: "Forbidden: your role cannot browse the user directory" },
        403
      );
    }

    const teamId = c.req.query("teamId");
    const workshopId = c.req.query("workshopId");

    // Exactly one, not both: two filters would have to be AND-ed or OR-ed and the
    // caller has no way to say which. The UI narrows workshop → team, so a request
    // carrying both is a client bug worth surfacing rather than guessing at.
    if (!!teamId === !!workshopId) {
      return c.json(
        { error: "exactly one of teamId or workshopId is required" },
        400
      );
    }

    /**
     * ⚠ A FACILITATOR MUST OWN WHAT THEY NAME. See the note above for why this arrived late.
     *
     * ⚠ RESOLVED THROUGH THE THREE-VALUED `listOwnedWorkshops`, NOT `ownsWorkshop`, and that is
     * the fail-closed-semantics point rather than a style choice. `ownsWorkshop` is FAIL-CLOSED by contract —
     * a timeout, a 5xx or a non-JSON body all read as "not the owner" (workshop-access.http.ts) —
     * so using it here would answer a Workshop brownout with 403 "not yours", which is the
     * undetermined-reported-as-denied defect that cost this platform a day. `listOwnedWorkshops`
     * distinguishes "you own none" from "we could not ask", so the brownout is a 503 with
     * Retry-After and the caller is told to try again rather than told they lack access.
     *
     * It is also the SAME source the teams directory on this very screen uses, so the filter and
     * the list cannot disagree about which workshops a facilitator owns.
     *
     * ⚠ THE FULL LIST IS USED, UNCAPPED, WHICH IS SAFE HERE AND WOULD NOT BE THERE. The directory
     * caps at MAX_DIRECTORY_SCOPE_IDS because every id becomes an `IN` operand in a DynamoDB
     * FilterExpression; this is a single set membership test in memory, so capping it would
     * REFUSE a facilitator their 51st workshop for no reason.
     */
    if (role !== "ADMIN") {
      const owned = await deps.workshopDirectory.listOwnedWorkshops(callerId, role, c);
      if (owned === "unavailable") {
        console.warn("[team] directory user-ids: ownership scope unavailable — 503, not 403", {
          userId: callerId,
          role,
        });
        return c.json(
          {
            error:
              "We couldn't check your experiences just now. This is a temporary problem, not a change to your access.",
            code: "DIRECTORY_SCOPE_UNAVAILABLE",
          },
          503,
          { "Retry-After": "2" }
        );
      }
      const ownedIds = new Set(owned.map((w) => w.id));

      // For a teamId the workshop comes from OUR OWN table — one local read, no second hop. A
      // dangling teamId resolves to no workshop and is refused: the caller cannot prove
      // ownership of a team that is not there, and 403 discloses less than 404 about which
      // team ids exist.
      const target = workshopId ?? (await deps.teams.getById(teamId!).catch(() => null))?.workshopId;

      if (!target || !ownedIds.has(target)) {
        return c.json(
          {
            error: "Forbidden: you can only filter by experiences you own",
            code: "DIRECTORY_SCOPE_FORBIDDEN",
          },
          403
        );
      }
    }

    let teamIds: string[];
    if (teamId) {
      teamIds = [teamId];
    } else {
      const teams = await deps.teams.listByWorkshop(workshopId!);
      teamIds = teams.map((t) => t.id);
    }

    // An empty answer for a workshop with no teams — not a fall-through to
    // "everyone", which the caller must also be careful not to do with this result.
    if (teamIds.length === 0) {
      return c.json({ userIds: [], teamIds: [] });
    }

    const rosters = await Promise.all(
      teamIds.map((id) => deps.members.listByTeam(id))
    );

    const userIds = [...new Set(rosters.flat().map((m) => m.userId))];

    return c.json({ userIds, teamIds });
  });

  /**
   * WHO INVITED each of these people — the "Invited by" column.
   *
   * Keyed on EMAIL, not on user id, and that is forced rather than preferred: an
   * invitation row's only link to the person is `email` (the invitations table is
   * (teamId, email) with an email-index GSI). `acceptedBy` carries a sub, but it is
   * absent on every PENDING row — which can be every row in the table — so a
   * sub-keyed join would leave the column empty for everyone.
   *
   * `invitedBy` comes back as a BARE SUB. Resolving it to a name is Identity's job
   * (GET /v1/admin/user-names), and it must stay Identity's job: the inviter is
   * subject to the SAME visibility rule as anyone else, so a facilitator looking at a
   * participant invited by an admin must see "Not shown" rather than that admin's
   * name. Returning a name from here would route around the only code that knows the
   * rule.
   *
   * `basis` says WHETHER THE ANSWER IS A RECORD OR AN INFERENCE:
   *   ACCEPTED        — the invitation this person actually redeemed. Authoritative.
   *   EARLIEST_INVITE — no redeemed row, so this is the first person who invited them.
   *                     A reasonable answer and usually the right one, but a guess: an
   *                     administrator deciding whether to revoke someone's access
   *                     should know the difference.
   * An administrator acting on inferred provenance deserves to be told it is inferred,
   * so this is surfaced rather than smoothed over.
   */
  team.get("/directory/invited-by", async (c) => {
    const { role } = requireIdentity(c);
    if (!canReadDirectory(role)) {
      return c.json(
        { error: "Forbidden: your role cannot browse the user directory" },
        403
      );
    }

    // Lower-cased because invitations are stored lower-cased (see the invite routes),
    // and the key echoed back is the caller's own spelling so it can be matched to the
    // row it asked about without the caller having to re-normalise.
    const emails = idList(c.req.query("emails"));

    if (emails.length === 0) return c.json({ invitedBy: {} });
    if (emails.length > MAX_CONTEXT_KEYS) {
      return c.json(
        { error: `too many emails — at most ${MAX_CONTEXT_KEYS} per request` },
        400
      );
    }

    const entries = await Promise.all(
      emails.map(async (email) => {
        // One lookup per email rather than a Scan: email-index is a GSI with
        // Projection ALL, so each is a Query on a partition of (usually) one row.
        const rows = await deps.invitations.listByEmail(email.toLowerCase());
        if (rows.length === 0) return [email, null] as const;

        // A redeemed row is the record of what actually happened, so it wins over any
        // number of earlier offers.
        const accepted = rows.find((r) => r.status === "ACCEPTED");
        const chosen =
          accepted ??
          // Earliest by sentAt — the first person who brought them in. Rows with no
          // sentAt sort last rather than crashing the comparison.
          [...rows].sort((a, b) => (a.sentAt || "").localeCompare(b.sentAt || ""))[0];

        if (!chosen?.invitedBy) return [email, null] as const;

        /**
         * ⚠ THE VISIBILITY MATRIX APPLIED TO THE SUBJECT'S OWN ROLE.
         *
         * This route accepts up to MAX_CONTEXT_KEYS arbitrary addresses per call and answers with
         * invitation provenance for each, gated only on the coarse `canReadDirectory`. So a
         * FACILITATOR could confirm the existence of, and map the onboarding of, ANY address —
         * including the platform's admins. `USER_VISIBILITY_GRANTS` withholds exactly that: a
         * facilitator "has no business enumerating who holds full platform access".
         *
         * OMITTED, NOT NULLED — the same treatment as an address with no invitation at all, so a
         * withheld row is indistinguishable from an unknown one. `null` would confirm "this address
         * exists and I am not telling you", which is most of the fact being withheld.
         *
         * ⚠ WHAT THIS DOES *NOT* CLOSE, stated so the next reader does not assume otherwise. It
         * withholds rows about accounts the caller may not see; it does NOT scope the answer to
         * experiences the caller OWNS, so a facilitator can still map provenance for non-admin
         * addresses in another owner's experience. Doing that properly means resolving each row's
         * team to its workshop and comparing against `listOwnedWorkshops` — and platform-scoped rows
         * have no workshop to compare at all, so it is a contract change for whatever renders this,
         * not a local edit. ROLES.md already lists this route's coarse gating as a known gap; this
         * narrows the sharpest edge of it without changing the shape callers depend on.
         */
        if (!canSeeUser(role, chosen.platformRole || "PARTICIPANT")) {
          return [email, null] as const;
        }

        return [
          email,
          {
            inviterId: chosen.invitedBy,
            basis: accepted ? "ACCEPTED" : "EARLIEST_INVITE",
            // The scope the invitation was issued under, so the column can say
            // "invited to the platform" vs "invited to a team" without a second call.
            scope: isPlatformScope(chosen.teamId) ? "PLATFORM" : "TEAM",
            teamId: isPlatformScope(chosen.teamId) ? null : chosen.teamId,
            sentAt: chosen.sentAt ?? null,
          },
        ] as const;
      })
    );

    // Emails with no invitation are omitted rather than mapped to null — someone can
    // exist without an invitation row (the bootstrap admin, or a row whose invitation
    // was revoked after acceptance), and "we have no record" is what an absent key
    // means everywhere else in this API.
    const invitedBy = Object.fromEntries(
      entries.filter(([, v]) => v !== null)
    );

    return c.json({ invitedBy });
  });

  return team;
}
