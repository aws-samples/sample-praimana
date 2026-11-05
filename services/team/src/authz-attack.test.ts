import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createTeamRoutes } from "./routes.js";
import type {
  AdmitOutcome,
  Invitation,
  InvitationRepository,
  Team,
  TeamMember,
  TeamMemberRepository,
  TeamRepository,
  UserView,
  UsersReadModel,
  AuditRepository,
  AuditEntryWrite,
  AuditEntryRead,
} from "./domain.js";
import { isInactiveMembership } from "./domain.js";
import type { WorkshopAccess, WorkshopDirectory, WorkshopRef } from "./authz.js";

/**
 * ADVERSARIAL HTTP-SURFACE TESTS from a pre-deploy security review of the teams directory,
 * reactivation and former-members.
 *
 * A SEPARATE FILE from routes.test.ts, deliberately: that suite pins the CONTRACT of each route.
 * This one models the ATTACKER, and the threat model is specific — every service route is mapped
 * ANY/GET behind a Cognito JWT authorizer that does NO role scoping, and the browser holds its own
 * token. So the portal BFF is not a security boundary: every test here calls the SERVICE directly
 * with a valid low-privilege identity, which is exactly what an attacker can do.
 *
 * Tests named "DEFECT" asserted the BROKEN behaviour as observed, so the report could not drift
 * from the code. Fixing a defect FAILS its test BY DESIGN, and those tests are then RE-POINTED at
 * the correct behaviour — never deleted, never weakened. SEVEN have been re-pointed for the
 * review's fixes: three in the first pass (the scope cap, the reactivation subject-role gate and
 * the cursor shape check), three in the second (the audit-reason sanitiser and the two actor-sub
 * disclosures on the roster) and one in the third (the raw actorIds on /v1/audit/users/:userId).
 * Each says in its own comment what it used to assert, what fixed it, and why the new expectation
 * is the right one — so nobody can "simplify" a fix back into a leak without reading why it exists.
 *
 * ⚠ ONE OF THEM WAS RE-POINTED BY RENAME RATHER THAN BY INVERSION — the no-invitation-row
 * reactivation, where 200 is the CORRECT answer and the DEFECT name was the thing that was wrong. Its
 * comment carries the reasoning, because the intuitive fix would re-break a deliberate decision.
 *
 * ONE KNOWN-OPEN ITEM DELIBERATELY REMAINS, still passing, still asserting an accepted residual
 * risk: the unaudited-but-successful reactivation. The `audited: false` CloudWatch alarm was declared
 * OUT OF SCOPE, so that gap is real and pinned rather than fixed, and it may not be
 * re-pointed until the underlying gap actually closes.
 *
 * It is now named "ACCEPTED RESIDUAL", not "DEFECT". The distinction is the point: a DEFECT name is
 * a promise that someone should fix it, and this one was declined on purpose. NO test in this file
 * or in directory-security.test.ts is named DEFECT any more — a label that cries defect at a fixed
 * or accepted item teaches the next reader to distrust every label, and then the real one is
 * missed.
 */

const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

/**
 * Console spies are asserted on in this file (the unevidenced-reactivation counter, the scope
 * truncation warn). Restored between tests so a spy cannot silence a later test's diagnostics or
 * leak call records into it — a mocked `console.warn` that outlives its test is a cross-test
 * dependency, and this file runs its cases in a loop.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function asUser(identity: { id: string; email?: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
    ...(identity.email ? { "x-identity-email": identity.email } : {}),
  };
}

// ─── In-memory fakes ────────────────────────────────────────────────────────

class FakeTeams implements TeamRepository {
  /**
   * SET the seat cap. Not exercised by this file's tests, which predate the
   * cap — present so the fake satisfies the interface rather than to model behaviour.
   */
  async setSeatCap(): Promise<boolean> {
    return true;
  }

  constructor(readonly rows: Team[] = []) {}
  /** Every `listDirectory` call, so a test can assert what the ROUTE asked the store for —
   *  in particular that the authorization SCOPE and the SEARCH reached the store at all. */
  readonly directoryCalls: Array<{
    limit?: number;
    cursor?: string;
    search?: string;
    workshopIds?: readonly string[];
  }> = [];
  async getById(id: string) {
    return this.rows.find((t) => t.id === id) ?? null;
  }
  async getByInviteCode(inviteCode: string) {
    return this.rows.find((t) => t.inviteCode === inviteCode) ?? null;
  }
  async listByWorkshop(workshopId: string) {
    return this.rows.filter((t) => t.workshopId === workshopId);
  }
  async put(team: Team) {
    this.rows.push(team);
    return team;
  }
  /**
   * MIRRORS THE REAL REPOSITORY'S FILTERING AND PAGING, because those are the mechanisms the
   * route's behaviour depends on and a fake that returned every row would let a route that
   * drops the scope or the needle pass every test:
   *
   *   - `workshopIds` UNDEFINED means unrestricted; an EMPTY ARRAY means "sees nothing" and
   *     returns no teams. That polarity is the whole safety property — the other reading turns
   *     "owns no workshops" into "sees every team on the platform".
   *   - `search` is a CASE-INSENSITIVE substring match on the team NAME, matching what the
   *     store's two-form `contains` workaround achieves. Case-insensitive here on purpose: a
   *     route that forwarded the needle unchanged and a route that dropped it are then
   *     distinguishable.
   *   - `limit` + `cursor` page over a STABLE order (the row order), and the cursor names the
   *     LAST ROW RETURNED — so a test can prove paging neither loses nor duplicates a team.
   *
   * The cursor's shape deliberately matches the real one's key `{workshopId, id}`, so a route
   * that inspected or rebuilt it would fail here too.
   */
  async listDirectory(
    opts: {
      limit?: number;
      cursor?: string;
      search?: string;
      workshopIds?: readonly string[];
    } = {}
  ) {
    this.directoryCalls.push(opts);

    // "Sees nothing" — never a fall-through to everything.
    if (opts.workshopIds && opts.workshopIds.length === 0) return { teams: [] };

    let rows = this.rows;
    if (opts.workshopIds) {
      const scope = new Set(opts.workshopIds);
      rows = rows.filter((t) => scope.has(t.workshopId));
    }
    const needle = opts.search?.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
    }

    let from = 0;
    if (opts.cursor) {
      try {
        const key = JSON.parse(Buffer.from(opts.cursor, "base64url").toString()) as {
          workshopId: string;
          id: string;
        };
        const at = rows.findIndex(
          (t) => t.workshopId === key.workshopId && t.id === key.id
        );
        // A cursor naming a row the filter no longer matches restarts at the beginning,
        // exactly as the real store treats a malformed one.
        from = at === -1 ? 0 : at + 1;
      } catch {
        from = 0;
      }
    }

    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 100);
    const page = rows.slice(from, from + limit);
    const hasMore = from + limit < rows.length;
    const last = page[page.length - 1];

    return {
      teams: page,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ workshopId: last.workshopId, id: last.id })
            ).toString("base64url")
          : undefined,
    };
  }
}

/**
 * A DIFFERENT ISO instant on every call, so "removedAt did not move on a second removal"
 * is a real assertion rather than one that passes because two `new Date()` calls landed in
 * the same millisecond. Same trick as FAKE_ACCEPTED_AT / FAKE_REVOKED_AT below.
 */
let fakeRemovedAtTick = 0;
const FAKE_REMOVED_AT = () =>
  new Date(Date.UTC(2026, 7, 4, 1, 0, ++fakeRemovedAtTick)).toISOString();

/**
 * In-memory TeamMemberRepository — MIRRORING THE REAL ONE'S INVERTED DEFAULT.
 *
 * ── WHY THIS FAKE'S SHAPE IS PART OF THE TEST ──
 *
 * Member removal used to be a HARD DELETE and this fake used to `splice` the row out. It now
 * DEACTIVATES: the row survives with `status: INACTIVE` so the removal can be reversed and so
 * the roster can show who was removed. The objection to a soft-delete flag was that it "needs
 * every reader to filter it, and missing one silently restores access", and that objection is
 * answered in the REPOSITORY: `get()` returns NULL for a deactivated row and `listByTeam()`
 * omits it, so every authorization path already treats an inactive membership as no
 * membership with no change to any of them.
 *
 * SO THIS FAKE MUST DO THE SAME, or the route tests would be asserted against a repository
 * the platform does not have — and "a removed member gets 403" would pass here while the real
 * service granted access. `get`/`listByTeam`/`listByUser` filter; the `IncludingInactive`
 * variants do not.
 *
 * BOTH FLIPS ARE CONDITIONAL, like the store's ConditionExpressions, because the route's
 * idempotency depends on the boolean they return and NOT on a read-before-write: a fake that
 * always returned true would hide a double audit entry on a retried removal.
 *
 * `rows` is still exposed so a test can assert the row SURVIVED rather than only that a route
 * answered 200 — which is the whole behaviour change.
 */
class FakeMembers implements TeamMemberRepository {
  /**
   * ADMIT. The real one is a TransactWriteItems that also moves the team's
   * `memberCount` under a cap ConditionExpression; this file's tests predate the cap and are
   * about other rules, so it admits unconditionally and reports the idempotent case honestly.
   * Cap behaviour is covered where the fake models the seat ledger.
   */
  async admit(member: TeamMember): Promise<AdmitOutcome> {
    if (this.failWrites) throw this.failWrites;
    const existing = this.rows.find(
      (m) => m.teamId === member.teamId && m.userId === member.userId
    );
    if (existing) return "already-member";
    this.rows.push(member);
    return "admitted";
  }

  constructor(readonly rows: TeamMember[] = []) {}
  /**
   * Set to make deactivate()/reactivate() throw, reproducing a real store failure (throttle,
   * timeout, AccessDenied). The real repository RETHROWS those — only a
   * ConditionalCheckFailedException is benign — so the routes must surface a 5xx rather than
   * reporting an access change that did not happen.
   */
  failWrites?: unknown;

  async get(teamId: string, userId: string) {
    const row = await this.getIncludingInactive(teamId, userId);
    // THE LOAD-BEARING LINE, mirroring the real repository: deactivated is not a member.
    if (row && isInactiveMembership(row.status)) return null;
    return row;
  }
  async getIncludingInactive(teamId: string, userId: string) {
    return this.rows.find((m) => m.teamId === teamId && m.userId === userId) ?? null;
  }
  async listByTeam(teamId: string) {
    return (await this.listByTeamIncludingInactive(teamId)).filter(
      (m) => !isInactiveMembership(m.status)
    );
  }
  async listByTeamIncludingInactive(teamId: string) {
    return this.rows.filter((m) => m.teamId === teamId);
  }
  async listByUser(userId: string) {
    return this.rows
      .filter((m) => m.userId === userId)
      .filter((m) => !isInactiveMembership(m.status));
  }
  /**
   * UPSERT BY (teamId, userId), because that is what DynamoDB's PutItem does.
   *
   * This used to `push` unconditionally, which was indistinguishable from an upsert while
   * removal was a HARD DELETE: the delete spliced the row out, so a re-add always created the
   * only row for that key. Now that the removal KEEPS an INACTIVE row, pushing would leave TWO
   * rows for one key — a state the real table cannot hold — and every `find()`-based read
   * would return the stale INACTIVE one, so re-adding a removed member would silently not
   * take effect. Two former-members tests caught exactly that.
   *
   * A REAL RE-ADD REPLACES THE ROW, which is also why it correctly clears the removal stamp:
   * the new row is written whole, with no `status`, so the person is ACTIVE again with a fresh
   * `joinedAt`. That is the invitation path's behaviour, and it is DIFFERENT from
   * reactivation, which preserves the original row and its role.
   */
  async put(member: TeamMember) {
    const i = this.rows.findIndex(
      (m) => m.teamId === member.teamId && m.userId === member.userId
    );
    if (i === -1) this.rows.push(member);
    else this.rows[i] = member;
    return member;
  }
  async deactivate(
    teamId: string,
    userId: string,
    removedBy: string,
    removedByRole: string
  ) {
    if (this.failWrites) throw this.failWrites;
    const row = this.rows.find((m) => m.teamId === teamId && m.userId === userId);
    // Conditional, exactly like `attribute_exists(teamId) AND #status <> :inactive`: no row
    // or already INACTIVE is a no-op that reports false, so `removedAt` records the FIRST
    // removal and never moves and the route writes ONE audit entry per withdrawal.
    if (!row || isInactiveMembership(row.status)) return false;
    row.status = "INACTIVE";
    row.removedAt = FAKE_REMOVED_AT();
    row.removedBy = removedBy;
    row.removedByRole = removedByRole;
    // `role` and `joinedAt` are deliberately UNTOUCHED — that is what reactivation restores.
    return true;
  }
  async reactivate(teamId: string, userId: string, reactivatedBy: string): Promise<AdmitOutcome> {
    if (this.failWrites) throw this.failWrites;
    const row = this.rows.find((m) => m.teamId === teamId && m.userId === userId);
    // Conditional, like `attribute_exists(teamId) AND #status = :inactive`. An absent row
    // reports false and NEVER upserts — fabricating a membership here would model a store
    // that lets the route add an arbitrary user to an arbitrary team.
    if (!row || !isInactiveMembership(row.status)) return "already-member";
    row.status = "ACTIVE";
    row.reactivatedAt = FAKE_REMOVED_AT();
    row.reactivatedBy = reactivatedBy;
    // `removedAt`/`removedBy` are NOT cleared: they are the record of the removal that
    // happened. `status` is the only field that says what holds now.
    return "admitted";
  }
}

/**
 * A DIFFERENT ISO instant on every call, so "acceptedAt did not move" is a real
 * assertion rather than one that passes because two `new Date()` calls landed in the
 * same millisecond. Deliberately monotonic and deliberately not the wall clock: a
 * re-stamping implementation is then guaranteed to change the value, and the test
 * cannot flake on timing.
 */
let fakeAcceptedAtTick = 0;
const FAKE_ACCEPTED_AT = () =>
  new Date(Date.UTC(2026, 7, 2, 0, 0, ++fakeAcceptedAtTick)).toISOString();

/** The same trick for `revokedAt`, so "revokedAt did not move on a second removal" is a
 *  real assertion rather than one that passes on millisecond collision. */
let fakeRevokedAtTick = 0;
const FAKE_REVOKED_AT = () =>
  new Date(Date.UTC(2026, 7, 4, 0, 0, ++fakeRevokedAtTick)).toISOString();

/** And for `workshopRevokedAt` — a distinct hour from FAKE_REVOKED_AT so the two breadcrumbs
 *  are never confusable in a failure message. */
let fakeWorkshopRevokedAtTick = 0;
const FAKE_WORKSHOP_REVOKED_AT = () =>
  new Date(Date.UTC(2026, 7, 4, 2, 0, ++fakeWorkshopRevokedAtTick)).toISOString();

class FakeInvitations implements InvitationRepository {
  accepted: Array<{ teamId: string; email: string; acceptedBy?: string }> = [];
  /** Every markRevoked ATTEMPT, so a test can assert the removal route asked for the right
   *  (teamId, email) even when there was no row to flip. */
  markRevokedCalls: Array<{ teamId: string; email: string; revokedBy: string }> = [];
  /**
   * Set to make accept() throw, reproducing a store failure (throttle, timeout,
   * AccessDenied). The real repository RETHROWS those — only a
   * ConditionalCheckFailedException is swallowed as benign — so every caller on a
   * path that must not fail has to prove it absorbs this.
   */
  acceptThrows?: Error;
  /**
   * Set to make markRevoked() throw. The real repository rethrows anything that is not a
   * ConditionalCheckFailedException, and the removal route must ABSORB it and report
   * `invitationRevokeComplete: false` rather than failing a removal that already happened.
   */
  markRevokedThrows?: Error;
  constructor(readonly rows: Invitation[] = []) {}
  async get(teamId: string, email: string) {
    return (
      this.rows.find((i) => i.teamId === teamId && i.email === email.toLowerCase()) ?? null
    );
  }
  async listByEmail(email: string) {
    return this.rows.filter((i) => i.email === email.toLowerCase());
  }
  async getByTokenHash(tokenHash: string) {
    return this.rows.find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async listByTeam(teamId: string) {
    return this.rows.filter((i) => i.teamId === teamId);
  }
  async put(invitation: Invitation) {
    // Mirrors the DynamoDB impl, which lower-cases email on write.
    const stored = { ...invitation, email: invitation.email.toLowerCase() };
    // OVERWRITES AT THE KEY, because a real PutCommand does: the table is
    // (teamId HASH, email RANGE), so re-inviting an address REPLACES its row rather than
    // adding a second one. This fake used to `push` unconditionally, which made
    // `listByEmail`/`get` return the STALE row for an address that had been re-invited —
    // so a re-invitation after a removal looked as if it had not reset the status. That is
    // the whole "re-admission is an explicit act" path, and a fake that appends would have
    // let a broken implementation of it pass.
    const i = this.rows.findIndex(
      (r) => r.teamId === stored.teamId && r.email === stored.email
    );
    if (i === -1) this.rows.push(stored);
    else this.rows[i] = stored;
    return stored;
  }
  /**
   * Mirrors DynamoInvitationRepository.accept, including the two properties the
   * routes depend on:
   *
   *   - IDEMPOTENT. An already-ACCEPTED row is left ALONE — status, acceptedAt and
   *     acceptedBy all keep their first values — and the call reports false. A fake
   *     that re-stamped would let a route that re-stamps pass its tests.
   *   - Returns whether THIS call did the flip, so "first acceptance" is
   *     distinguishable from "nothing to do" without a read.
   *
   * `accepted` still records every ATTEMPT (including the no-ops), so a test can
   * assert on what the route asked for as well as on what changed.
   */
  async accept(teamId: string, email: string, acceptedBy?: string) {
    if (this.acceptThrows) throw this.acceptThrows;
    this.accepted.push({ teamId, email, acceptedBy });
    const row = this.rows.find(
      (i) => i.teamId === teamId && i.email === email.toLowerCase()
    );
    if (!row) return false;
    if (row.status === "ACCEPTED") return false;
    row.status = "ACCEPTED";
    row.acceptedAt = FAKE_ACCEPTED_AT();
    if (acceptedBy) row.acceptedBy = acceptedBy;
    return true;
  }
  async revoke(teamId: string, email: string) {
    const i = this.rows.findIndex(
      (inv) => inv.teamId === teamId && inv.email === email.toLowerCase()
    );
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
  /**
   * Mirrors DynamoInvitationRepository.markRevoked, including the three properties the
   * removal route depends on:
   *
   *   - THE ROW SURVIVES. It is flipped, not deleted, because it is also the record of who
   *     invited this person and when they accepted. A fake that deleted would let the
   *     former-members view's provenance tests pass against an implementation that destroys
   *     it.
   *   - IDEMPOTENT. An already-REVOKED row is left ALONE — revokedAt keeps its first value —
   *     and the call reports false.
   *   - NO UPSERT. A missing row reports false rather than fabricating a REVOKED invitation
   *     for an address nobody invited (which is what the store's attribute_exists guards).
   */
  async markRevoked(teamId: string, email: string, revokedBy: string) {
    if (this.markRevokedThrows) throw this.markRevokedThrows;
    this.markRevokedCalls.push({ teamId, email, revokedBy });
    const row = this.rows.find(
      (i) => i.teamId === teamId && i.email === email.toLowerCase()
    );
    if (!row) return false;
    if (row.status === "REVOKED") return false;
    row.status = "REVOKED";
    row.revokedAt = FAKE_REVOKED_AT();
    row.revokedBy = revokedBy;
    return true;
  }
  /**
   * Mirrors DynamoInvitationRepository.clearWorkshop — see the fuller note on the copy in
   * routes.test.ts. The properties that matter to the specs in THIS file are that only
   * `workshopId` is removed (never blanked), that `status` and the provenance survive, and
   * that a row with nothing to clear reports FALSE — which is what the withdrawal route's
   * metric guard depends on.
   */
  async clearWorkshop(teamId: string, email: string, revokedBy: string) {
    const row = this.rows.find(
      (i) => i.teamId === teamId && i.email === email.toLowerCase()
    );
    if (!row) return false;
    if (!row.workshopId) return false;
    delete row.workshopId;
    row.workshopRevokedAt = FAKE_WORKSHOP_REVOKED_AT();
    row.workshopRevokedBy = revokedBy;
    return true;
  }
}

class FakeUsers implements UsersReadModel {
  constructor(private readonly rows: UserView[] = []) {}
  async get(id: string) {
    return this.rows.find((u) => u.id === id) ?? null;
  }
  async upsert() {}
  async delete() {}
}

class FakeWorkshops implements WorkshopAccess {
  /**
   * The workshop's team-size TEMPLATE, read once at team creation.
   *
   * Returns the platform ceiling here so existing tests are unaffected by the cap: they are
   * about ownership and authorization, not seats. Tests that exercise the cap set their own
   * value, and the "unavailable" case has its own dedicated test — a fake that returned
   * "unavailable" by default would make every creation test assert a 503.
   */
  async teamSeatTemplate(): Promise<number | "unavailable" | "invalid"> {
    return 10;
  }

  /** How many times the cross-service ownership probe was made. Asserted at 0 on
   *  every path that must decide locally — the ADMIN short-circuit and every
   *  non-staff role, both of which keep the Team → Workshop call graph shallow. */
  calls = 0;
  /**
   * ⚠ TWO FLAGS, and the second one is a TEST SEAM rather than a new behaviour.
   *
   * `ownsTeamWorkshop` answers "do you own the workshop of THIS TEAM" (used by `canRead`, i.e. gate
   * 2); `ownsWorkshop` answers "do you own the workshop with THIS ID" (used by the mint path's
   * `mayGrantWorkshop` and now by the withdrawal gate). They were one flag, so no test could tell
   * which predicate a route consulted — which is precisely what the platform-scope tests need to
   * assert, since gate 2 is deliberately SKIPPED there while the ownership gate is not.
   *
   * `ownsNamed` DEFAULTS TO `owns`, so every pre-existing call site is unaffected.
   */
  constructor(
    private readonly owns = false,
    private readonly ownsNamed = owns
  ) {}
  async ownsTeamWorkshop() {
    this.calls++;
    return this.owns;
  }
  async ownsWorkshop() {
    this.calls++;
    return this.ownsNamed;
  }
}

/**
 * The TEAMS DIRECTORY's Workshop-context port.
 *
 * Both call COUNTS are recorded because the directory route's two invariants are about which
 * branch asks WHAT: an ADMIN must never ask for a SCOPE (that is the hop that would recurse
 * Team → Workshop → Team for the non-owning roles), and a FACILITATOR must never need the
 * name fan-out (their scope hop already returned names).
 *
 * `scope` set to "unavailable" models the hop failing, which the route MUST answer as a 503
 * rather than as an empty directory — an empty page is indistinguishable from a correct one.
 */
class FakeWorkshopDirectory implements WorkshopDirectory {
  scopeCalls = 0;
  nameCalls: string[][] = [];
  constructor(
    private readonly scope: WorkshopRef[] | "unavailable" = [],
    private readonly names: Record<string, string> = {}
  ) {}
  async listOwnedWorkshops() {
    this.scopeCalls++;
    return this.scope;
  }
  async resolveWorkshopNames(ids: readonly string[]) {
    this.nameCalls.push([...ids]);
    // Ids with no entry are ABSENT from the map, like the real client's best-effort contract —
    // so the route has to render them as null rather than assuming a hit.
    return Object.fromEntries(
      ids.filter((id) => this.names[id] !== undefined).map((id) => [id, this.names[id]])
    );
  }
}

// ─── Builders ───────────────────────────────────────────────────────────────

const team = (over: Partial<Team> = {}): Team => ({
  workshopId: "w1",
  id: "t1",
  name: "Team One",
  description: null,
  inviteCode: "CODE1234",
  repoUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/**
 * Records audit entries in memory. `failing` models the store being unavailable, which the
 * routes must survive without failing the action they were recording.
 */
class FakeAudit implements AuditRepository {
  readonly entries: AuditEntryRead[] = [];
  /**
   * A DISTINCT, MONOTONIC instant per recorded entry, mirroring the real store's
   * `<ISO>#<ulid>` sort key — the ULID suffix exists because two actions in the same
   * millisecond would otherwise collide and silently overwrite one another.
   *
   * Load-bearing for the former-members tests: "one row per person, their MOST RECENT
   * removal" is only a real assertion if two removals of the same person have different
   * timestamps AND a deterministic order.
   */
  private tick = 0;
  constructor(private readonly failing = false) {}
  async record(entry: AuditEntryWrite) {
    if (this.failing) return false;
    const occurredAt = new Date(
      Date.UTC(2026, 7, 4, 0, 0, ++this.tick)
    ).toISOString();
    this.entries.push({ ...entry, occurredAt, at: `${occurredAt}#${this.tick}` });
    return true;
  }
  async listBySubject(subjectId: string) {
    return this.entries.filter((e) => e.subjectId === subjectId).reverse();
  }
  /**
   * Mirrors the real store's teamId-index Query: NEWEST FIRST, and NO action filter — the
   * route is what filters to MEMBER_REMOVED, because a store-side FilterExpression is
   * applied after the Limit and would return short pages. A fake that filtered here would
   * let a route that forgot to filter pass.
   *
   * `limit` is applied AFTER the reverse, like ScanIndexForward: false + Limit does.
   */
  async listByTeam(teamId: string, limit = 50) {
    return this.entries
      .filter((e) => e.teamId === teamId)
      .reverse()
      .slice(0, limit);
  }
}

const invitation = (over: Partial<Invitation> = {}): Invitation => ({
  teamId: "t1",
  email: "invitee@example.com",
  status: "PENDING",
  invitedBy: "admin",
  sentAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function build(
  over: Partial<{
    teams: FakeTeams;
    members: FakeMembers;
    invitations: FakeInvitations;
    users: FakeUsers;
    workshops: WorkshopAccess;
    events: InMemoryPublisher;
    audit: AuditRepository;
    workshopDirectory: FakeWorkshopDirectory;
  }> = {}
) {
  const deps = {
    teams: over.teams ?? new FakeTeams([team()]),
    members: over.members ?? new FakeMembers([]),
    invitations: over.invitations ?? new FakeInvitations([]),
    users: over.users ?? new FakeUsers([]),
    workshops: over.workshops ?? new FakeWorkshops(false),
    events: over.events ?? new InMemoryPublisher(),
    audit: over.audit ?? new FakeAudit(),
    // Defaults to an EMPTY owned-workshop scope, which is the restrictive answer: a
    // FACILITATOR in a test that did not set one up sees no teams rather than all of them.
    workshopDirectory: over.workshopDirectory ?? new FakeWorkshopDirectory([]),
  };
  return { app: createTeamRoutes(deps), deps };
}


// ═══ ATTACK 1 — CROSS-TENANT LEAK VIA THE DIRECTORY ══════════════════════════════════

describe("ATTACK: cross-tenant leak via GET /v1/teams/directory", () => {
  /** Two facilitators' worlds: w1 is f1's, w2 belongs to somebody else entirely. */
  const twoTenants = () =>
    new FakeTeams([
      team({ workshopId: "w1", id: "mine-1", name: "Alpha Mine" }),
      team({ workshopId: "w2", id: "theirs-1", name: "Alpha Theirs" }),
      team({ workshopId: "w2", id: "theirs-2", name: "Beta Theirs" }),
    ]);

  const asFacilitator = { id: "f1", email: "f1@example.com", role: "FACILITATOR" };

  it("a FORGED CURSOR naming another tenant's partition does not leak their teams", async () => {
    // The cursor is base64url(JSON({workshopId,id})) and its shape is documented in the
    // repository, so an attacker can hand-craft one. It must be a POSITION and never a
    // CAPABILITY: the scope is re-resolved from the caller's identity on every request and ANDed
    // into the store filter, so a forged start key cannot widen what comes back.
    const teams = twoTenants();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]),
    });

    const forged = Buffer.from(
      JSON.stringify({ workshopId: "w2", id: "theirs-1" })
    ).toString("base64url");

    const res = await app.request(
      `/v1/teams/directory?cursor=${encodeURIComponent(forged)}`,
      { headers: asUser(asFacilitator) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Nothing from w2, whatever the cursor said.
    expect(body.teams.map((t: { workshopId: string }) => t.workshopId)).not.toContain("w2");
    // And the SCOPE still reached the store — the forged cursor did not displace it.
    expect(teams.directoryCalls[0].workshopIds).toEqual(["w1"]);
  });

  it("a cursor MINTED BY AN ADMIN and replayed by a FACILITATOR is re-scoped, not honoured", async () => {
    // The privilege-transfer form of the same attack: the minting caller can see BOTH tenants
    // and the replaying one owns only w1, so if the cursor carried its scope with it, replaying
    // it would widen the facilitator's page. It must not — the scope comes from the token,
    // never the cursor.
    //
    // ⚠ THE ADMIN NOW NEEDS AN EXPLICIT SCOPE to mint the cursor at all. Previously their
    // scan was UNRESTRICTED, so `build({ teams })` with the default empty scope was enough;
    // scoped to what they own, an admin owning nothing pages nothing and mints no cursor. Given
    // BOTH workshops here, which keeps the attack's shape intact — a wider caller's cursor
    // replayed by a narrower one — rather than degrading it to two equal scopes.
    const adminTeams = twoTenants();
    const { app: adminApp } = build({
      teams: adminTeams,
      workshopDirectory: new FakeWorkshopDirectory([
        { id: "w1", name: "W One" },
        { id: "w2", name: "W Two" },
      ]),
    });
    const adminPage = await adminApp.request("/v1/teams/directory?limit=1", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });
    const adminCursor = (await adminPage.json()).nextCursor as string;
    expect(adminCursor).toBeTruthy();

    const teams = twoTenants();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]),
    });

    const res = await app.request(
      `/v1/teams/directory?cursor=${encodeURIComponent(adminCursor)}`,
      { headers: asUser(asFacilitator) }
    );

    const body = await res.json();
    expect(body.teams.map((t: { workshopId: string }) => t.workshopId)).not.toContain("w2");
    expect(teams.directoryCalls[0].workshopIds).toEqual(["w1"]);
  });

  it("a cursor replayed AFTER ownership was revoked returns only what the caller owns NOW", async () => {
    // The revoked-ownership replay. A facilitator pages while owning w1 and w2, loses w2, then
    // resubmits their earlier cursor. Authorization is re-derived per request, so the second page
    // must be narrower — a cursor cannot be a snapshot of a permission.
    const before = twoTenants();
    const { app: beforeApp } = build({
      teams: before,
      workshopDirectory: new FakeWorkshopDirectory([
        { id: "w1", name: "W One" },
        { id: "w2", name: "W Two" },
      ]),
    });
    const page1 = await beforeApp.request("/v1/teams/directory?limit=1", {
      headers: asUser(asFacilitator),
    });
    const cursor = (await page1.json()).nextCursor as string;

    // Ownership of w2 is gone.
    const after = twoTenants();
    const { app: afterApp } = build({
      teams: after,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]),
    });

    const res = await afterApp.request(
      `/v1/teams/directory?cursor=${encodeURIComponent(cursor)}`,
      { headers: asUser(asFacilitator) }
    );

    const body = await res.json();
    expect(body.teams.map((t: { workshopId: string }) => t.workshopId)).not.toContain("w2");
    expect(after.directoryCalls[0].workshopIds).toEqual(["w1"]);
  });

  it("a SEARCH cannot be used to confirm the existence of another tenant's team", async () => {
    // A search is the natural oracle: type a rival's team name and see whether a row comes back.
    // The needle is ANDed with the scope in the store, so a name that exists ONLY in w2 must
    // return an empty page — indistinguishable from a name that exists nowhere.
    const teams = twoTenants();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]),
    });

    const hit = await app.request("/v1/teams/directory?search=Beta%20Theirs", {
      headers: asUser(asFacilitator),
    });
    const miss = await app.request("/v1/teams/directory?search=NoSuchTeamAnywhere", {
      headers: asUser(asFacilitator),
    });

    expect((await hit.json()).teams).toEqual([]);
    expect((await miss.json()).teams).toEqual([]);
    // Same answer for "exists elsewhere" and "does not exist" — no oracle.
  });

  it("an EMPTY, BLANK-ID and WHITESPACE-ID workshop scope all reach the store as a RESTRICTION", async () => {
    // THE EMPTY-SCOPE INVERSION, at the route. `undefined` must be reachable ONLY for an ADMIN;
    // for a FACILITATOR every degenerate scope has to stay a restriction, because the alternative
    // reading turns "owns no workshops" into "every team on the platform".
    for (const owned of [
      [] as WorkshopRef[],
      [{ id: "", name: "blank id" }],
      [{ id: "   ", name: "whitespace id" }],
    ]) {
      const teams = twoTenants();
      const { app } = build({
        teams,
        workshopDirectory: new FakeWorkshopDirectory(owned),
      });

      const res = await app.request("/v1/teams/directory", {
        headers: asUser(asFacilitator),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.teams, JSON.stringify(owned)).toEqual([]);
      // The decisive assertion: NOT undefined. Undefined would mean "unrestricted".
      expect(teams.directoryCalls[0].workshopIds, JSON.stringify(owned)).not.toBeUndefined();
    }
  });

  it("the FACILITATOR branch never reaches resolveWorkshopNames — no name-probe oracle", async () => {
    // `resolveWorkshopNames` issues one GET /v1/workshops/:id per id. If a facilitator's branch
    // could reach it with ids from a page, a resolved-vs-absent name would be an existence oracle
    // for workshops they cannot see. Their names come free with the scope hop instead.
    const workshopDirectory = new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]);
    const { app } = build({ teams: twoTenants(), workshopDirectory });

    await app.request("/v1/teams/directory", { headers: asUser(asFacilitator) });

    expect(workshopDirectory.nameCalls).toEqual([]);
  });

  it("an ADMIN sees every team in the workshops THEY OWN, and nothing from the ones they do not", async () => {
    /**
     * ⚠ REPLACES A TEST OF THE OPPOSITE PROPERTY. It read "workshopName resolution is
     * DISPLAY-ONLY: an unresolved name never changes which teams appear" and asserted that an
     * ADMIN with every name lookup failing STILL received all three teams across BOTH tenants,
     * with `workshopName: null`. The display claim it defended is still sound — a route that
     * dropped un-named rows would hide teams during a Workshop brownout — but the scenario is
     * unreachable now that names arrive with the ownership scope in a single hop, so there is no
     * "unresolved name" state left to construct through the route.
     *
     * WHAT REPLACES IT IS THE AUTHORIZATION PROPERTY THAT MATTERS MORE, and which this file
     * previously asserted only for a FACILITATOR: an admin scoped to w1 gets w1's teams and NOT
     * the other tenant's. The old test is, read today, a description of the leak that the
     * admin-scoping change closed — it asserted an admin receiving `theirs-1` and `theirs-2`.
     */
    const teams = twoTenants();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    const body = await res.json();
    expect(body.teams.map((t: { id: string }) => t.id)).toEqual(["mine-1"]);
    // The scope reached the STORE rather than being applied after the read.
    expect(teams.directoryCalls[0].workshopIds).toEqual(["w1"]);
    // And the name came free with it — no second hop, no null.
    expect(body.teams[0].workshopName).toBe("W One");
  });
});

// ═══ ATTACK 2 — DIRECTORY ROLE GATE AND UNBOUNDED READS ══════════════════════════════

describe("ATTACK: GET /v1/teams/directory role gate and read bounds", () => {
  const many = () =>
    new FakeTeams(
      Array.from({ length: 250 }, (_, i) =>
        team({ workshopId: "w1", id: `t${String(i).padStart(3, "0")}`, name: `Team ${i}` })
      )
    );

  /**
   * An owned-workshop scope covering `many()`'s single workshop.
   *
   * ⚠ EVERY ADMIN CASE IN THIS BLOCK NEEDS ONE, AND THE FAILURE MODE IS
   * VACUOUS PASSES RATHER THAN FAILURES. An admin used to scan UNRESTRICTED, so `build({ teams:
   * many() })` gave them all 250 rows. Now they are scoped to what they own, and the default
   * scope is empty — so the page comes back EMPTY, and assertions of the form "at most 100
   * rows" or "status 200" are satisfied by nothing at all. Two tests here (the member-count
   * fan-out bound and the trailing-space role) would have gone green while testing air.
   *
   * `toBeGreaterThanOrEqual(1)` in the clamp test is the only reason any of this surfaced as a
   * red suite. Kept, and imitated: a bound on a fan-out is only meaningful if something fanned.
   */
  const ownsW1 = () => new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]);

  it("403s JUDGE, EXECUTIVE and PARTICIPANT — a refusal, NOT a filtered list", async () => {
    // The divergence from /workshops/:workshopId/teams is deliberate and is a security property:
    // a filtered list would make this route a second, differently-gated answer to "which teams am
    // I on", which is where two views drift apart. Asserted with the caller as a real MEMBER of a
    // team, which is the case most likely to be "helpfully" allowed through.
    for (const role of ["JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      const teams = many();
      const { app } = build({
        teams,
        members: new FakeMembers([
          { teamId: "t000", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
        ]),
        workshops: new FakeWorkshops(true),
      });

      const res = await app.request("/v1/teams/directory", {
        headers: asUser({ id: "u1", email: "u@example.com", role }),
      });

      expect(res.status, role).toBe(403);
      // Refused BEFORE the store, so a disqualified caller learns nothing about how many exist.
      expect(teams.directoryCalls, role).toHaveLength(0);
    }
  });

  it("an UNKNOWN or CASE-VARIED role is refused — canReadDirectory is an ALLOW-list", async () => {
    // The polarity that matters when a sixth role is added to the platform: it is refused until
    // someone decides otherwise, rather than admitted the day it is created. Case variations are
    // included because the role is compared with Set.has, so "Admin" must not pass.
    //
    // NOT included: a TRAILING-SPACE "ADMIN ". That is admitted, but the reason is HTTP rather than
    // authorization — header values are whitespace-trimmed before the middleware sees them (RFC 9110
    // §5.5), so the role really is "ADMIN" by the time canReadDirectory runs. Asserted separately
    // below so the distinction is on the record rather than looking like a case-folding bug.
    for (const role of ["CO_FACILITATOR", "SUPERADMIN", "admin", "Admin", "ADMIN_READONLY"]) {
      const teams = many();
      const { app } = build({ teams });

      const res = await app.request("/v1/teams/directory", {
        headers: asUser({ id: "u1", email: "u@example.com", role }),
      });

      expect(res.status, role).toBe(403);
      expect(teams.directoryCalls, role).toHaveLength(0);
    }
  });

  it("a trailing-space role is HTTP-trimmed, not case-folded — and only on the internal-hop path", async () => {
    // Documented rather than filed as a defect. `x-identity-role: "ADMIN "` is admitted as ADMIN
    // because the header value is trimmed in transport, so no comparison was weakened. It also only
    // matters on the trusted-internal-hop path, which requires the shared secret AND is inert in the
    // deployed topology (INTERNAL_SERVICE_TOKEN is unset on every deployed function, and the
    // deployed role comes from the gateway's verified `cognito:groups` claim rather than a header).
    const { app } = build({ teams: many(), workshopDirectory: ownsW1() });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "u1", email: "u@example.com", role: "ADMIN " }),
    });

    expect(res.status).toBe(200);
  });

  it("CLAMPS every hostile `limit` to at most 100 rows, whatever the query string says", async () => {
    // The route forwards any finite Number and relies on the repository's clamp, so the boundary
    // has to be proven END TO END on the HTTP surface — that is where the attacker is.
    const cases = [
      "limit=10000",
      "limit=1e9",
      "limit=-5",
      "limit=0",
      "limit=2.7",
      "limit=NaN",
      "limit=Infinity",
      "limit=99999999999999999999",
      "limit=0x64",
      "limit=%20100%20",
    ];

    for (const qs of cases) {
      const { app } = build({ teams: many(), workshopDirectory: ownsW1() });

      const res = await app.request(`/v1/teams/directory?${qs}`, {
        headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
      });

      expect(res.status, qs).toBe(200);
      const body = await res.json();
      expect(body.teams.length, qs).toBeLessThanOrEqual(100);
      expect(body.teams.length, qs).toBeGreaterThanOrEqual(1);
    }
  });

  it("a DUPLICATED ?limit= takes ONE value and is still clamped", async () => {
    // Hono's `c.req.query` returns the FIRST value for a repeated key. Asserted so a
    // parameter-pollution trick cannot smuggle a second, larger value past the clamp.
    const { app } = build({ teams: many(), workshopDirectory: ownsW1() });

    const res = await app.request("/v1/teams/directory?limit=1&limit=10000", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect((await res.json()).teams).toHaveLength(1);
  });

  it("an ARRAY-VALUED limit param is ignored and the default page applies", async () => {
    // `?limit[]=5` is a different key entirely, so `limit` is absent — which must default rather
    // than produce NaN. This is the input that would reach the repository's UNCLAMPED NaN path if
    // the route's `Number.isFinite` guard were ever dropped — see the store-level test in
    // directory-security.test.ts that documents where that guard actually lives.
    const { app } = build({ teams: many(), workshopDirectory: ownsW1() });

    const res = await app.request("/v1/teams/directory?limit[]=99999", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).teams).toHaveLength(50);
  });

  it("BOUNDS the member-count fan-out at the page size — one Query per row and no more", async () => {
    // The route fans out `listByTeam` once per team on the page. Bounded by the CLAMPED page size,
    // so `limit=10000` must not become 10,000 Queries from one request. Counted at the repository.
    let queries = 0;
    class CountingMembers extends FakeMembers {
      async listByTeam(teamId: string) {
        queries++;
        return super.listByTeam(teamId);
      }
    }

    const { app } = build({ teams: many(), members: new CountingMembers([]), workshopDirectory: ownsW1() });

    await app.request("/v1/teams/directory?limit=10000", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(queries).toBeLessThanOrEqual(100);
    // NOT VACUOUS: something actually fanned out. Without this, an empty page passes the bound.
    expect(queries).toBeGreaterThan(0);
  });

  it("makes NO workshop-name fan-out for an ADMIN either — the name-probe oracle is closed for BOTH owner roles", async () => {
    /**
     * ⚠ THIS TEST USED TO BOUND A FAN-OUT THAT NO LONGER EXISTS. It read "BOUNDS the east-west
     * workshop-name fan-out at 25 for an ADMIN" and asserted `nameCalls` had exactly one entry of at
     * most `MAX_DIRECTORY_WORKSHOP_NAMES` ids — a real bound on a real hazard: a page spanning 100
     * workshops was 100 concurrent hops onto the Workshop service from one request. (That constant is
     * itself now deleted — unreferenced once this call site went, and the repo's only lint error. Its
     * 25 lives on `resolveWorkshopNames` for whoever calls it next.)
     *
     * Scoping ADMIN to owned experiences removed the CAUSE. An admin's page could span workshops they had
     * never read, so their names had to be fetched separately; scoped to what they OWN, every
     * workshop that can appear came back from the scope hop WITH its name. `resolveWorkshopNames`
     * has no caller left.
     *
     * SO THE ASSERTION INVERTS RATHER THAN RELAXES, and it becomes the stronger property the
     * FACILITATOR case above already had — see "the FACILITATOR branch never reaches
     * resolveWorkshopNames — no name-probe oracle". That oracle (a resolved-vs-absent name
     * revealing whether a workshop exists) is now closed for EVERY role, not just for the one
     * that was never allowed to probe. A regression that reinstated the fan-out would fail here.
     */
    const teams = new FakeTeams(
      Array.from({ length: 100 }, (_, i) =>
        team({ workshopId: `w${i}`, id: `t${i}`, name: `Team ${i}` })
      )
    );
    // Owns all 100, so the page is FULL — the fan-out would have been at its worst here.
    const workshopDirectory = new FakeWorkshopDirectory(
      Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, name: `W${i}` }))
    );
    const { app } = build({ teams, workshopDirectory });

    const res = await app.request("/v1/teams/directory?limit=100", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    const body = await res.json();
    // ⚠ 50 AND NOT 100, because MAX_DIRECTORY_SCOPE_IDS caps the ownership scope at 50 ids and
    // an admin is now subject to that cap like anyone else — so an admin owning 100 workshops
    // sees teams from 50 of them and is TOLD so. Asserted here as well as in
    // adr0004-deploy-conditions.test.ts because this is the file where a silently short page
    // would read as a leak being closed rather than as a page being truncated.
    expect(body.teams).toHaveLength(50);
    expect(body.scopeTruncated).toBe(true);
    expect(workshopDirectory.nameCalls).toEqual([]);
    // And the names arrived anyway, from the ONE hop that also carried the authorization scope.
    expect(body.teams.every((t: { workshopName: string | null }) => t.workshopName !== null)).toBe(
      true
    );
  });

  it("a per-row roster failure leaves a NULL count rather than failing or dropping the page", async () => {
    // Best-effort per team, and null rather than 0: "we could not count" and "nobody is on this
    // team" are different facts and 0 is a number an operator would act on. Also proves one bad
    // row cannot take out an operator's directory during an incident.
    class BrokenMembers extends FakeMembers {
      async listByTeam(teamId: string) {
        if (teamId === "t001") throw new Error("ProvisionedThroughputExceededException");
        return super.listByTeam(teamId);
      }
    }
    const { app } = build({ teams: many(), members: new BrokenMembers([]), workshopDirectory: ownsW1() });

    const res = await app.request("/v1/teams/directory?limit=3", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const broken = body.teams.find((t: { id: string }) => t.id === "t001");
    expect(broken.memberCount).toBeNull();
    expect(body.teams).toHaveLength(3);
  });

  it("BOUNDS the FACILITATOR's owned-workshop SCOPE at 50 and REPORTS the truncation", async () => {
    for (const ownedCount of [120, 400]) {
      const teams = new FakeTeams([team({ workshopId: "w0", id: "t1" })]);
      const owned = Array.from({ length: ownedCount }, (_, i) => ({
        id: `w${i}`,
        name: `W${i}`,
      }));
      const { app } = build({ teams, workshopDirectory: new FakeWorkshopDirectory(owned) });

      const res = await app.request("/v1/teams/directory", {
        headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
      });

      // 200, NOT the 500 an uncapped `IN` list would have produced downstream.
      expect(res.status, String(ownedCount)).toBe(200);
      // The bound, asserted at the id count actually handed to the store.
      expect(teams.directoryCalls[0].workshopIds, String(ownedCount)).toHaveLength(50);
      // And REPORTED. A silently-capped scope is a silently-short directory, which is the same
      // class of lie as the 503-vs-empty branch above: the operator types a team name, gets
      // nothing, and concludes the team does not exist. Paging cannot fix it either — every page
      // reachable from this cursor runs against the same capped scope.
      expect((await res.json()).scopeTruncated, String(ownedCount)).toBe(true);
    }
  });

  it("does NOT claim truncation for a scope INSIDE the cap, at the boundary and below", async () => {
    // The negative control the inverted assertion above needs. "Always report truncated" would
    // satisfy every assertion in the previous test and train an operator to ignore the notice —
    // which costs us the one render where it means something. 50 is the boundary and is NOT
    // truncated (the cap is inclusive, so no facilitator is short by one).
    for (const ownedCount of [1, 49, 50]) {
      const teams = new FakeTeams([team({ workshopId: "w0", id: "t1" })]);
      const owned = Array.from({ length: ownedCount }, (_, i) => ({
        id: `w${i}`,
        name: `W${i}`,
      }));
      const { app } = build({ teams, workshopDirectory: new FakeWorkshopDirectory(owned) });

      const res = await app.request("/v1/teams/directory", {
        headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
      });

      expect(res.status, String(ownedCount)).toBe(200);
      expect(teams.directoryCalls[0].workshopIds, String(ownedCount)).toHaveLength(ownedCount);
      expect((await res.json()).scopeTruncated, String(ownedCount)).toBe(false);
    }
  });
});

// ═══ ATTACK 3 — PRIVILEGE ESCALATION VIA REACTIVATE ══════════════════════════════════

describe("ATTACK: POST /v1/teams/:teamId/members/:userId/reactivate", () => {
  const REMOVED = (over: Partial<TeamMember> = {}): TeamMember => ({
    teamId: "t1",
    userId: "victim",
    role: "LEAD",
    joinedAt: "2026-08-02T09:00:00.000Z",
    status: "INACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "fac",
    removedByRole: "FACILITATOR",
    ...over,
  });

  const USERS = [
    { id: "victim", name: "A Victim", email: "victim@example.com" },
    { id: "fac", name: "Facilitator One", email: "f@example.com" },
  ];

  const post = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    body?: unknown
  ) =>
    app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser(identity),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("REFUSES to CREATE a membership for a never-member — no privilege-grant primitive", async () => {
    // The most dangerous shape this route could have: an UpdateCommand upserts, so without
    // `attribute_exists` it would be a way to add an ARBITRARY user to an ARBITRARY team, bypassing
    // every invitation gate — the workshop scope, the role matrix, the platform-role rules. 404,
    // and NOTHING written, asserted on the rows and on the audit trail.
    const members = new FakeMembers([]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(404);
    expect(members.rows).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("a read-only EXECUTIVE cannot reactivate, even one who is a MEMBER of the team", async () => {
    // The read-only asymmetry, on the path most likely to be treated as "just restoring what was
    // already there". An executive who could reactivate could re-admit anyone to a team they may
    // only observe. Membership is granted here on purpose, so the refusal is provably the ROLE and
    // not a failed ownership probe.
    const members = new FakeMembers([
      REMOVED(),
      { teamId: "t1", userId: "exec", role: "EXECUTIVE", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await post(app, { id: "exec", email: "e@example.com", role: "EXECUTIVE" });

    expect(res.status).toBe(403);
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(audit.entries).toHaveLength(0);
  });

  it("a FACILITATOR who does NOT own the workshop cannot reactivate — the cross-tenant write", async () => {
    // The write-side sibling of attack 1. `requireTeamWrite` resolves to ADMIN, a member, or staff
    // who OWNS the workshop — so a facilitator naming another tenant's teamId must be refused, and
    // must not have flipped the row on the way to the refusal.
    const members = new FakeMembers([REMOVED()]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      // Does not own it.
      workshops: new FakeWorkshops(false),
    });

    const res = await post(app, { id: "rival", email: "r@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(403);
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(audit.entries).toHaveLength(0);
  });

  it("the RESTORED team role comes off the ROW and cannot be influenced by the request", async () => {
    // The preserved `teamRole` is the field the surviving row exists to protect, so the question is
    // whether an attacker can UPGRADE it on the way back in — LEAD is the role a team's own tooling
    // treats as privileged. Every injection surface is tried at once: body fields and query string.
    const members = new FakeMembers([REMOVED({ role: "BUILDER" })]);
    const { app } = build({
      members,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request(
      "/v1/teams/t1/members/victim/reactivate?role=LEAD&teamRole=LEAD",
      {
        method: "POST",
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        body: JSON.stringify({ role: "LEAD", teamRole: "LEAD", status: "ACTIVE" }),
      }
    );

    expect(res.status).toBe(200);
    // The row's own role, unchanged — never the requested one.
    expect((await res.json()).role).toBe("BUILDER");
    expect(members.rows[0].role).toBe("BUILDER");
  });

  it("IDEMPOTENT under double-submit: one flip, ONE audit entry, ONE event", async () => {
    // At-least-once delivery and a double-clicking operator produce the same request twice. A
    // second audit entry would claim a restoration that did not happen, and
    // GET /audit/users/:userId is read during investigations where a duplicated grant is a
    // misleading fact. Asserted on all three observable effects.
    const members = new FakeMembers([REMOVED()]);
    const audit = new FakeAudit();
    const events = new InMemoryPublisher();
    const { app } = build({
      members,
      audit,
      events,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const first = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    const second = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ reactivated: true, audited: true });
    // The no-op reports audited: false, which is how a real flip stays distinguishable.
    expect(await second.json()).toMatchObject({ reactivated: true, audited: false });
    expect(audit.entries.filter((e) => e.action === "MEMBER_RESTORED")).toHaveLength(1);
    expect(events.published.filter((e) => e.type === "member.joined")).toHaveLength(1);
  });

  it("CONCURRENT reactivations resolve to exactly ONE audited restoration", async () => {
    // The store flip is conditional (`#status = :inactive`), so two racing calls cannot both
    // "succeed". Driven through the HTTP surface with Promise.all so the requests interleave rather
    // than being serialised by the test. Eight, not two, so a lost race is more likely to show.
    const members = new FakeMembers([REMOVED()]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json()));
    // Exactly one call did the work and wrote the entry.
    expect(bodies.filter((b) => b.audited === true)).toHaveLength(1);
    expect(audit.entries.filter((e) => e.action === "MEMBER_RESTORED")).toHaveLength(1);
  });

  it("REFUSES reactivation for a subject whose platform role is FACILITATOR/JUDGE/ADMIN, through their PLATFORM-scoped row", async () => {
    // ── RE-POINTED, BY INVERSION. This test was "DEFECT (high): reactivation SUCCEEDS for a
    // subject whose platform role is FACILITATOR/JUDGE/ADMIN, because their invitation is
    // PLATFORM-scoped" and asserted 200 with a MEMBER_RESTORED entry, over its own comment saying
    // "the correct answer is 403 — this is the assertion a fix must invert". Inverted.
    //
    // WHY THE GATE WAS DEAD, kept because the fixture is the finding. The route resolved the
    // subject's role with `invitations.get(teamId, subjectEmail)` — keyed on the TEAM being
    // reactivated. But a FACILITATOR / JUDGE / ADMIN invitation CANNOT be team-scoped: the
    // invitation route refuses it with a 400 ("A FACILITATOR is invited to the platform, not to a
    // team", gate 3 / mayHoldTeamMembership), and `teamId` is the invitations PARTITION KEY, so
    // their row exists ONLY at PLATFORM. The team-keyed lookup therefore always returned null for
    // exactly the population the gate exists to refuse, `|| "PARTICIPANT"` was applied, and the
    // restoration was admitted. The pre-existing test in routes.test.ts passed only because its
    // fixture put a `platformRole: "FACILITATOR"` row at teamId "t1" — a state the service refuses
    // to write, so it proved nothing about a reachable state.
    //
    // THE FIXTURE HERE IS PLATFORM-SCOPED DELIBERATELY: it is the only shape that can exist, which
    // is what made this an exploitable hole rather than a theoretical one. The fix is `listByEmail`
    // across every scope (routes.ts:2041-2101), so this row is now seen and weighed.
    //
    // The impact this closes: a legacy INACTIVE row belonging to somebody who is now a FACILITATOR
    // or JUDGE was laundered back into a LIVE membership — which is now the WHOLE of
    // team-content authorization, including in `services/docs`, which reads the table directly
    // and cannot be corrected from this service.
    for (const subjectRole of ["FACILITATOR", "JUDGE", "ADMIN"]) {
      const members = new FakeMembers([REMOVED()]);
      const audit = new FakeAudit();
      const { app } = build({
        members,
        audit,
        users: new FakeUsers(USERS),
        invitations: new FakeInvitations([
          // The ONLY shape the platform will actually write for these roles.
          invitation({
            teamId: "PLATFORM",
            email: "victim@example.com",
            platformRole: subjectRole,
            status: "ACCEPTED",
          }),
        ]),
        workshops: new FakeWorkshops(true),
      });

      const res = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

      // 403, not the invitation route's 400: there is no corrected form of this request — the
      // account may not hold a team membership at all.
      expect(res.status, subjectRole).toBe(403);
      // A refusal that had already flipped the row would be the whole bug wearing a 403.
      expect(members.rows[0].status, subjectRole).toBe("INACTIVE");
      // NO audit entry of ANY action: a refused restoration did not happen, and an entry saying
      // it did is a misleading fact on the exact report an investigation reads.
      expect(audit.entries, subjectRole).toHaveLength(0);
    }
  });

  it("ALLOWS reactivation when the subject has NO invitation row at all — the CORRECT answer, not an oversight", async () => {
    // ── RE-POINTED BY RENAME ONLY. The assertions were RIGHT and the NAME was wrong: this was
    // filed as "DEFECT (high): reactivation SUCCEEDS when the subject has NO invitation row at
    // all". 200 is CORRECT here and refusing was explicitly REJECTED, so what changed
    // is the name and this comment — not the expectation.
    //
    // ⚠⚠ DO NOT "FIX" THIS TO A 403 OR A 503. The intuitive answer is wrong, and the reasoning is
    // recorded here because the next person to read the file will have the same intuition the
    // original test name had.
    //
    // WHY THE ADJACENT 503 IS NOT AN INCONSISTENCY. The two cases look like one epistemic state
    // ("we have no evidence about this person's role") and are not:
    //
    //   UNRESOLVABLE ADDRESS   a lookup that could not be PERFORMED. Usually a lagging read-model
    //                          projection, so A RETRY CHANGES THE ANSWER — which is what makes 503
    //                          + Retry-After truthful. Asserted directly in the next test.
    //   ABSENT INVITATION ROW  a lookup that COMPLETED and returned a DEFINITE NEGATIVE. A 503
    //                          here would be PERMANENT for that subject and `Retry-After` would be
    //                          a LIE — every retry answers identically, and the operator is told to
    //                          wait for something that will never change.
    //
    // WHY REFUSING WAS REJECTED, on what a refusal gets wrong rather than on convenience:
    //
    //   IT DETECTS ALMOST NOTHING. Every membership row on this platform was written through a path
    //   that already checked `mayHoldTeamMembership` against the VERIFIED TOKEN ROLE, and there is
    //   no role-change route on the platform. An absent invitation is overwhelmingly an ordinary
    //   member — one who joined by invite code before invitations were required, or whose PENDING
    //   row was deleted when their account was disabled, or whose row the revoke route deleted.
    //   THE FALLBACK IS WORSE THAN THE PROBLEM. With no reactivation, re-admitting the person means
    //   re-inviting them — which goes through `members.put`, and that REPLACES THE ROW WHOLE,
    //   DESTROYING the preserved team role (a LEAD comes back a BUILDER) that the soft delete
    //   exists to protect. It also requires the SUBJECT to sign in, so an operator cannot do it on
    //   their behalf during an incident.
    //
    // NOT SILENT, THOUGH — the uncovered case (an out-of-band promotion via the Cognito console or
    // `create-admin.mjs --force`, which writes no invitation row) is counted, asserted below.
    const members = new FakeMembers([REMOVED({ role: "LEAD" })]);
    const { app } = build({
      members,
      users: new FakeUsers(USERS),
      invitations: new FakeInvitations([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(members.rows[0].status).toBe("ACTIVE");
    // THE PRESERVED TEAM ROLE, read off the surviving row — this is the thing the refusal's
    // re-invite fallback would have destroyed, so it is the load-bearing half of the rule and
    // not a detail of the response shape.
    expect(await res.json()).toMatchObject({ reactivated: true, role: "LEAD" });
    expect(members.rows[0].role).toBe("LEAD");
  });

  it("COUNTS the unevidenced reactivation with ids only — never the subject's address", async () => {
    // The answer above is a 200, so the uncovered case (an OUT-OF-BAND promotion, which writes no
    // invitation row) has to be FINDABLE rather than refused. Its remedy is
    // hand-deletion of the membership row, and this counter is what makes one findable at all.
    //
    // IDS ONLY: no email, no team name, no unbounded dimension. The
    // subject's ADDRESS is resolved on this very path — `deps.users.get(userId).email` — so it is
    // in scope and one careless spread away from the log stream.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      users: new FakeUsers(USERS),
      invitations: new FakeInvitations([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(res.status).toBe(200);

    const hit = warn.mock.calls.find(
      (c) => (c[1] as { metric?: string })?.metric === "ReactivateSubjectRoleUnevidenced"
    );
    expect(hit).toBeDefined();
    expect(hit![1]).toEqual({
      metric: "ReactivateSubjectRoleUnevidenced",
      teamId: "t1",
      subjectId: "victim",
      actorId: "fac",
    });
    // The address is not in the log line in ANY field, asserted on the serialised record rather
    // than field by field so a future added field cannot smuggle it in.
    expect(JSON.stringify(hit![1])).not.toContain("@");  // nosemgrep: no-stringify-keys
    expect(JSON.stringify(hit![1])).not.toContain("victim@example.com");  // nosemgrep: no-stringify-keys
  });

  it("does NOT count a reactivation that HAD evidence — the counter tracks the uncovered case only", async () => {
    // The negative control. A counter that fires on every restoration cannot be alarmed on, so
    // "always warn" would satisfy the test above and destroy its value.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      users: new FakeUsers(USERS),
      invitations: new FakeInvitations([
        invitation({ teamId: "t1", email: "victim@example.com", platformRole: "PARTICIPANT" }),
      ]),
      workshops: new FakeWorkshops(true),
    });

    expect((await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })).status).toBe(
      200
    );
    expect(
      warn.mock.calls.some(
        (c) => (c[1] as { metric?: string })?.metric === "ReactivateSubjectRoleUnevidenced"
      )
    ).toBe(false);
  });

  it("503s rather than guessing when the subject's ADDRESS cannot be resolved", async () => {
    // The one place absent evidence IS refused, asserted so the inconsistency with the two tests
    // above is on the record as a contrast rather than an accident of fixtures.
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      // No read-model row for the subject.
      users: new FakeUsers([{ id: "fac", name: "Facilitator One", email: "f@example.com" }]),
      workshops: new FakeWorkshops(true),
    });

    const res = await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SUBJECT_UNAVAILABLE");
    expect(members.rows[0].status).toBe("INACTIVE");
  });

  it("does NOT un-revoke the invitation — the rejoin exploit stays closed after a restoration", async () => {
    // The prior verified exploit (fixed in bc6d30a) was a removed member rejoining on a still-live
    // ACCEPTED invitation. Reactivation must not reopen it: the membership row is the grant, so the
    // invitation stays REVOKED and both POST /teams/join and the sign-in accept keep refusing it.
    const members = new FakeMembers([REMOVED()]);
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "victim@example.com", status: "REVOKED" }),
    ]);
    const { app } = build({
      members,
      invitations,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    await post(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(invitations.rows[0].status).toBe("REVOKED");
  });

  it("a MALFORMED or hostile body cannot fail, divert, or pollute the operation", async () => {
    // The body is an OPTIONAL operator note read AFTER the authorization gate. A hostile body must
    // not become a 400 on a legitimate restoration, must not smuggle a field, and must not reach
    // Object.prototype.
    for (const body of [
      "not json at all",
      "[]",
      '"a string"',
      "null",
      '{"reason":{"$ne":null}}',
      '{"reason":["a","b"]}',
      '{"__proto__":{"role":"LEAD"}}',
      '{"constructor":{"prototype":{"role":"LEAD"}}}',
    ]) {
      const members = new FakeMembers([REMOVED({ role: "BUILDER" })]);
      const { app } = build({
        members,
        users: new FakeUsers(USERS),
        workshops: new FakeWorkshops(true),
      });

      const res = await app.request("/v1/teams/t1/members/victim/reactivate", {
        method: "POST",
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        body,
      });

      expect(res.status, body).toBe(200);
      expect((await res.json()).role, body).toBe("BUILDER");
      // Nothing on Object.prototype was polluted by a crafted body.
      expect(({} as Record<string, unknown>).role, body).toBeUndefined();
    }
  });

  it("an ANONYMOUS caller is 401'd before the row is touched", async () => {
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({ members, users: new FakeUsers(USERS) });

    const res = await app.request("/v1/teams/t1/members/victim/reactivate", { method: "POST" });

    expect(res.status).toBe(401);
    expect(members.rows[0].status).toBe("INACTIVE");
  });
});

// ═══ ATTACK 4 — AUDIT INTEGRITY ══════════════════════════════════════════════════════

describe("ATTACK: audit integrity on the two access-changing routes", () => {
  const REMOVED = (over: Partial<TeamMember> = {}): TeamMember => ({
    teamId: "t1",
    userId: "victim",
    role: "LEAD",
    joinedAt: "2026-08-02T09:00:00.000Z",
    status: "INACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "fac",
    removedByRole: "FACILITATOR",
    ...over,
  });
  const ACTIVE = (over: Partial<TeamMember> = {}): TeamMember => ({
    teamId: "t1",
    userId: "victim",
    role: "LEAD",
    joinedAt: "2026-08-02T09:00:00.000Z",
    ...over,
  });
  const USERS = [
    { id: "victim", name: "A Victim", email: "victim@example.com" },
    { id: "fac", name: "Facilitator One", email: "f@example.com" },
  ];

  /**
   * Every `UnauditedAccessChanges` EMF record emitted during one test, newest last.
   *
   * Parsed out of `console.log` because that IS the transport: the helper writes one
   * Embedded Metric Format line to stdout and CloudWatch Logs turns it into the metric
   * (no PutMetricData call, nothing to stub, no IAM). So asserting on the line is
   * asserting on the metric — there is no other observable.
   */
  function captureUnauditedMetrics(): Array<Record<string, unknown>> {
    const records: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line !== "string") return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // Not an EMF record.
      }
      if ("UnauditedAccessChanges" in parsed) records.push(parsed);
    });
    return records;
  }

  /**
   * -- RE-POINTED: THIS WAS `ACCEPTED RESIDUAL: an access-GRANTING reactivation
   *    succeeds UNAUDITED when the audit write fails, and no alarm exists` ------------------
   *
   * WHAT THE RESIDUAL WAS, and it was never a defect in the route. `audit.record` does not throw
   * by contract; it returns false. So a reactivation whose audit write failed answered 200 with
   * the membership already ACTIVE and `audited: false` — access GRANTED with no record of who
   * granted it. The route's own comment conceded it: "false after a real flip is worth an alarm,
   * because access was GRANTED with no record of who granted it".
   *
   * The 200 was ACCEPTED then and is STILL CORRECT NOW, unchanged: the membership
   * row is the authorization fact and it is already flipped, so failing the request would have
   * the operator retry a completed action. What did not exist was the alarm that comment leaned
   * on — no metric, no EMF line, no CloudWatch alarm anywhere in the template. It was declared
   * out of scope while four disclosure fixes shipped, which is why the test was
   * named ACCEPTED RESIDUAL rather than DEFECT (a DEFECT label is a promise someone will fix it,
   * and this was declined on purpose).
   *
   * WHAT CLOSED IT. `emitAccessAuditMetric` in
   * the services' shared metrics module publishes `Praimana/AccessChanges /
   * UnauditedAccessChanges`, dimensioned by `Action`, and UnauditedAccessChangeAlarm in
   * the infrastructure template watches it at > 0 over 5 minutes.
   *
   * SO THIS TEST NOW ASSERTS THE EMISSION RATHER THAN ITS ABSENCE. The two observable facts it
   * always asserted are UNCHANGED and still assert here — the 200, and the flip having happened
   * unaudited. The third is new: the signal exists. Nothing was weakened; one expectation was
   * added and the "no alarm exists" claim in the name was retired because it became false.
   *
   * Reachability, kept from the original because it is still the honest framing: an attacker
   * cannot fail the audit PutItem on demand. They can choose the MOMENT — the audit table is
   * separate with its own throttling, so a burst of writes or any DynamoDB throttle produces
   * this state. Opportunistic rather than on-demand, which is why it was medium, and why an
   * alarm rather than a redesign was the right answer.
   */
  it("an access-GRANTING reactivation still succeeds UNAUDITED when the audit write fails — and now EMITS the alarm's metric", async () => {
    const records = captureUnauditedMetrics();
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      // The store is unavailable.
      audit: new FakeAudit(true),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    // UNCHANGED, AND DELIBERATELY SO: access granted, nothing recorded, 200.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reactivated: true, audited: false });
    expect(members.rows[0].status).toBe("ACTIVE");

    // NEW: the signal the old name said did not exist.
    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(1);
    expect(records[0].Action).toBe("MEMBER_RESTORED");
    // The actor is on the line, which is what makes the alarm actionable — and it is also
    // recoverable from the membership row (`reactivatedBy`), which is why the runbook calls
    // the team half RECOVERABLE and the user-access half not.
    expect(records[0].actorId).toBe("fac");
    expect(records[0].subjectId).toBe("victim");
    expect(members.rows[0].reactivatedBy).toBe("fac");
  });

  it("the same holds for a REMOVAL — reported, not failed, and metered", async () => {
    // The symmetric case, asserted so the report can say the behaviour is consistent rather than one
    // route being wrong. An unaudited removal is less dangerous than an unaudited grant (access was
    // withdrawn, not given) and the INACTIVE row is itself a durable trace of it — but it is the
    // same lost fact about who acted, so it feeds the same metric under its own Action.
    const records = captureUnauditedMetrics();
    const members = new FakeMembers([ACTIVE()]);
    const { app } = build({
      members,
      audit: new FakeAudit(true),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true, audited: false });
    // The row is still the durable trace, which the reactivation case also has.
    expect(members.rows[0].status).toBe("INACTIVE");

    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(1);
    expect(records[0].Action).toBe("MEMBER_REMOVED");
    expect(records[0].actorId).toBe("fac");
  });

  /**
   * ⚠ THE ASSERTION THAT KEEPS THE ALARM WORTH HAVING. Read this before changing where
   * either route emits.
   *
   * On BOTH team routes `audited: false` is AMBIGUOUS: it is what a lost audit write returns,
   * and it is ALSO what an idempotent no-op returns. A reactivation of an already-ACTIVE member
   * writes no second entry BY DESIGN (one restoration, one entry — a duplicate would claim a
   * restoration that did not occur, and GET /audit/users/:userId is read during investigations),
   * and reports false to mean "no entry was NEEDED". Removal has the same property.
   *
   * A double-clicked button produces that every time. Emitting there would page on a harmless
   * duplicate click, and an alarm that fires on harmless things is an alarm everyone learns to
   * ignore — which is strictly worse than no alarm, because it also looks like coverage. So both
   * routes emit INSIDE their real-flip branch, and this test is what stops that regressing.
   */
  it("does NOT emit on an idempotent no-op, even though the no-op also reports audited: false", async () => {
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      // AVAILABLE. The first call is audited normally; the second finds nothing to do.
      audit: new FakeAudit(),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const reactivate = () =>
      app.request("/v1/teams/t1/members/victim/reactivate", {
        method: "POST",
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      });

    // The spy starts AFTER the real flip, so anything captured below can only have come from
    // the no-op — no arithmetic on counts, no chance of attributing the first call's datapoint
    // to the second.
    const first = await reactivate();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ audited: true });

    const records = captureUnauditedMetrics();
    const second = await reactivate();

    // The no-op's own contract, unchanged: a 200 reporting audited: false.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ reactivated: true, audited: false });
    // And NO datapoint of either polarity — not a 1 (which would page) and not a 0 (which
    // would misreport a successful audit that never happened).
    expect(records).toEqual([]);
  });

  it("does NOT emit on a repeated REMOVAL of an already-INACTIVE member", async () => {
    // The symmetric no-op. Same reasoning as above; asserted separately because the two routes
    // guard on different flags (`deactivated` vs `flipped`) and a regression in one would not
    // show in the other.
    const members = new FakeMembers([ACTIVE()]);
    const { app } = build({
      members,
      audit: new FakeAudit(),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const remove = () =>
      app.request("/v1/teams/t1/members/victim", {
        method: "DELETE",
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      });

    const first = await remove();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ removed: true, audited: true });

    const records = captureUnauditedMetrics();
    const second = await remove();

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ removed: false, audited: false });
    expect(records).toEqual([]);
  });

  it("emits the SUCCESS datapoint (0) when the audit write lands, so the metric exists in a healthy account", async () => {
    // Without this, "no data" and "no failures" are identical at the alarm and a deploy that
    // broke the emission entirely would read as a permanently healthy platform.
    const records = captureUnauditedMetrics();
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      audit: new FakeAudit(),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audited: true });
    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(0);
    expect(records[0].Action).toBe("MEMBER_RESTORED");
  });

  it("the emitted metric carries NO EMAIL and no unbounded dimension", async () => {
    // No workshopId/userId as a metric dimension: `Action` has four possible values for the life of the platform, so
    // it is a legal dimension. A userId is unbounded by definition and an email is also a
    // DISCLOSURE — this platform has already shipped two fixes for operator identifiers leaking
    // into places they should not be. Ids live in the log PROPERTIES, searchable in Logs
    // Insights, and never in Dimensions.
    const records = captureUnauditedMetrics();
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      audit: new FakeAudit(true),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    await app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({ reason: "contact victim@example.com about this" }),
    });

    expect(records).toHaveLength(1);
    const line = JSON.stringify(records[0]);  // nosemgrep: no-stringify-keys
    // Neither the actor's address (which the route holds) nor the subject's (which the users
    // read-model holds), and not the operator's free-text reason, which may name a person.
    expect(line).not.toContain("@");
    expect(line).not.toContain("victim@example.com");
    expect(line).not.toContain("f@example.com");
    expect(line).not.toContain("contact");

    // ONE dimension, and it is Action. Asserted on the EMF directive itself so a future
    // dimension added at the call site fails here.
    const directive = (
      records[0] as unknown as {
        _aws: { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
      }
    )._aws.CloudWatchMetrics[0];
    for (const set of directive.Dimensions) {
      expect(set.every((key) => key === "Action")).toBe(true);
    }
  });

  it("publishes BOTH dimension sets, which is the only reason the Dimensions-less alarm matches", async () => {
    // ⚠ THE SILENT-FAILURE MODE. CloudWatch treats each dimension COMBINATION as its own
    // metric and an alarm must match one EXACTLY, so a metric published only under {Action}
    // would leave UnauditedAccessChangeAlarm — which declares no Dimensions on purpose, to
    // watch the aggregate — permanently OK through the exact failure it exists to catch.
    // Nothing at runtime would report that; only this assertion does.
    //
    // The namespace and metric name are asserted against the LITERAL strings the template
    // uses, for the same reason. metrics.test.ts pins the exported constants; this pins what
    // the ROUTE actually emits.
    const records = captureUnauditedMetrics();
    const members = new FakeMembers([REMOVED()]);
    const { app } = build({
      members,
      audit: new FakeAudit(true),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    await app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    const directive = (
      records[0] as unknown as {
        _aws: {
          CloudWatchMetrics: Array<{
            Namespace: string;
            Dimensions: string[][];
            Metrics: Array<{ Name: string; Unit: string }>;
          }>;
        };
      }
    )._aws.CloudWatchMetrics[0];

    expect(directive.Dimensions).toEqual(expect.arrayContaining([[], ["Action"]]));
    expect(directive.Dimensions).toHaveLength(2);
    expect(directive.Namespace).toBe("Praimana/AccessChanges");
    expect(directive.Metrics).toEqual([
      { Name: "UnauditedAccessChanges", Unit: "Count" },
    ]);
  });

  // ── THE FIFTH ACTION: ENTITLEMENT_REVOKED ─────────
  //
  // Withdrawing a JUDGE's WORKSHOP entitlement is an access change on the same metric, under its
  // own Action, and it inherits every property the four above are pinned for. The three specs
  // below cover the emission, the no-op guard the metric's own contract warns about, and the
  // second guard this action has and the others do not.

  /** An ACCEPTED, registered judge holding w1 — the P1-2 population. */
  const JUDGE_ROW = (over: Partial<Invitation> = {}): Invitation =>
    invitation({
      teamId: "PLATFORM",
      email: "judge@example.com",
      scope: "PLATFORM",
      status: "ACCEPTED",
      acceptedAt: "2026-08-02T00:00:00.000Z",
      acceptedBy: "judge-1",
      platformRole: "JUDGE",
      workshopId: "w1",
      ...over,
    });

  /**
   * ⚠ THE FIXTURES BELOW PASS `new FakeWorkshops(false, true)`, AND THE SECOND FLAG IS LOAD-BEARING.
   * Withdrawing a JUDGE entitlement now requires the caller to OWN the named
   * experience — the check the mint path always made and this route did not, which let any
   * facilitator strip any judge's entitlement platform-wide.
   *
   * `(false, true)` = "not resolvable through any team (so gate 2 would refuse if it ran at platform
   * scope, which it must not), but the owner of w1 (so the new ownership gate passes)". These tests
   * are about AUDIT INTEGRITY, so the authorization fixture has to let the withdrawal through —
   * otherwise they would silently start asserting a 403 and stop testing the audit trail at all. The
   * ownership gate has its own tests in routes.test.ts.
   */
  const withdrawEntitlement = (app: ReturnType<typeof build>["app"]) =>
    app.request("/v1/teams/PLATFORM/invitations/judge%40example.com/workshop", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

  it("an UNAUDITED entitlement withdrawal succeeds and EMITS the alarm's metric", async () => {
    // The same shape as the reactivation and removal cases above: the access change has already
    // taken effect (the field is gone), so the 200 is correct and the loss is signalled rather
    // than turned into a failure. RECOVERABLE when it fires, and the runbook says so:
    // `clearWorkshop` writes `workshopRevokedBy` onto the invitation row in the SAME
    // UpdateExpression as the removal and BEFORE the audit call, so the actor survives on the
    // row even when the trail entry does not — the team half's property, not user-access's.
    const records = captureUnauditedMetrics();
    const invitations = new FakeInvitations([JUDGE_ROW()]);
    const { app } = build({
      invitations,
      // The store is unavailable.
      audit: new FakeAudit(true),
      workshops: new FakeWorkshops(false, true),
    });

    const res = await withdrawEntitlement(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      revoked: true,
      audited: false,
      auditSubjectResolved: true,
    });
    // The withdrawal stands.
    expect(invitations.rows[0].workshopId).toBeUndefined();

    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(1);
    expect(records[0].Action).toBe("ENTITLEMENT_REVOKED");
    expect(records[0].actorId).toBe("fac");
    expect(records[0].subjectId).toBe("judge-1");
    // No `teamId` at platform scope — the sentinel is not a team, matching the helper's
    // contract and the audit entry's own omission.
    expect(records[0]).not.toHaveProperty("teamId");
    // The actor is recoverable from the row, which is what the runbook's step 3 relies on.
    expect(invitations.rows[0].workshopRevokedBy).toBe("fac");
    // And no address anywhere on the line, even though this route is keyed on one.
    expect(JSON.stringify(records[0])).not.toContain("@");  // nosemgrep: no-stringify-keys
  });

  it("emits the SUCCESS datapoint (0) for a withdrawal whose audit write LANDS", async () => {
    const records = captureUnauditedMetrics();
    const { app } = build({
      invitations: new FakeInvitations([JUDGE_ROW()]),
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(false, true),
    });

    const res = await withdrawEntitlement(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true, audited: true });
    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(0);
    expect(records[0].Action).toBe("ENTITLEMENT_REVOKED");
  });

  it("does NOT emit on a repeated withdrawal, even though the no-op also reports audited: false", async () => {
    // The third route with this hazard, and the reason the metric's own doc comment carries a
    // warning: `audited: false` is what a lost write returns AND what an idempotent no-op
    // returns. A double-clicked Revoke button produces the second every time, and paging on it
    // is how an alarm becomes noise nobody reads. Asserted separately from the member routes
    // because all three guard on different flags.
    const invitations = new FakeInvitations([JUDGE_ROW()]);
    const { app } = build({
      invitations,
      // AVAILABLE: the first call is audited normally; the second finds nothing to do.
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(false, true),
    });

    // The spy starts AFTER the real withdrawal, so anything captured below can only have come
    // from the no-op.
    const first = await withdrawEntitlement(app);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revoked: true, audited: true });

    const records = captureUnauditedMetrics();
    const second = await withdrawEntitlement(app);

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ revoked: false, audited: false });
    // Neither polarity: not a 1 (which would page) and not a 0 (which would misreport a
    // successful audit that never happened).
    expect(records).toEqual([]);
  });

  it("does NOT emit when the row named no subject — that entry was never WRITABLE, not lost", async () => {
    // ⚠ THE SECOND GUARD, which this action has and the member routes do not. A PENDING row
    // carries no `acceptedBy`, so there is no user partition to key an append-only entry on —
    // a DEFINITE negative where a retry answers identically. The alarm's runbook opens by
    // sending an operator to the audit table's throttles, which would be a false trail here.
    // Counted instead by a structured warn with a stable `metric` name, the same idiom this
    // service uses for ReactivateSubjectRoleUnevidenced.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = captureUnauditedMetrics();
    const invitations = new FakeInvitations([
      JUDGE_ROW({ status: "PENDING", acceptedAt: undefined, acceptedBy: undefined }),
    ]);
    const audit = new FakeAudit();
    const { app } = build({ invitations, audit, workshops: new FakeWorkshops(false, true) });

    const res = await withdrawEntitlement(app);

    // The withdrawal HAPPENED — this is not a refusal.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      revoked: true,
      audited: false,
      auditSubjectResolved: false,
    });
    expect(invitations.rows[0].workshopId).toBeUndefined();
    expect(audit.entries).toEqual([]);
    // No alarm datapoint of either polarity.
    expect(records).toEqual([]);
    // But NOT silent: the counter an alarm can be built on, ids only and no address.
    const line = warn.mock.calls.find(
      (call) =>
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as { metric?: string }).metric === "EntitlementRevokeSubjectUnknown"
    );
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain("@");
    warn.mockRestore();
  });

  /**
   * -- RE-POINTED: THIS WAS `DEFECT (low): the audit `reason` keeps NEWLINES, NULL
   *    BYTES and BIDI OVERRIDES intact` -----------------------------------------------------
   *
   * WHAT THE DEFECT WAS. `normalizeAuditReason` trimmed and truncated to 200 code points and did
   * nothing else -- no control stripping, no newline collapse. So an operator-supplied reason
   * reached the APPEND-ONLY trail still carrying:
   *
   *   - a newline plus a plausible fake entry, forging a second LINE in any renderer that prints
   *     the trail as text (a CSV export, a CloudWatch line, a terminal),
   *   - U+202E RIGHT-TO-LEFT OVERRIDE, which visually reverses what follows so the RENDERED
   *     reason differs from the stored one,
   *   - a NUL byte, which truncates the string in a C-backed consumer.
   *
   * The old test asserted each of those SURVIVED, so the report could not drift from the code.
   * LOW because the actor must already hold team-write and the STRUCTURED fields (actorId,
   * actorRole, occurredAt) are unforgeable -- pollution rather than forgery, but permanent.
   *
   * WHAT FIXED IT. `normalizeAuditReason` (routes.ts:496-507) now replaces each RUN of `\p{C}`
   * with ONE SPACE, BEFORE the trim and before the length is measured.
   *
   * WHY THE NEW EXPECTATIONS ARE THE RIGHT ONES -- each is a decision, not an accident:
   *
   *   - REPLACED, NOT DELETED. Deleting fuses words: `"a\nb"` would become `"ab"`, two clauses
   *     silently turned into one word the operator never wrote, which is its own small lie in a
   *     record whose only job is to be true.
   *   - A RUN, NOT A CODE POINT. 200 control characters become ONE space, not 200 spaces, so
   *     padding cannot buy budget.
   *   - SANITISE BEFORE MEASURING. Otherwise 200 control characters ahead of the note spend the
   *     whole AUDIT_REASON_MAX budget on characters about to be removed, and the operator's real
   *     words are truncated away by padding they did not choose.
   *   - ORDINARY SPACING UNTOUCHED. A space is not category C, so a two-clause reason keeps its
   *     spacing exactly. An over-eager sanitiser that collapsed real spacing would rewrite the
   *     operator's sentence -- the opposite regression, and equally a defect.
   *
   * DO NOT "SIMPLIFY" THIS BY EXEMPTING CHARACTERS. The whole of category C is one rule with no
   * holes; an exemption list is what ages badly, what a reviewer cannot check at a glance, and how
   * U+2066 or the next bidi control nobody remembered gets back in. The accepted cost of that
   * choice is pinned as KNOWN in its own test below.
   */
  const removeWithReason = async (reason: unknown) => {
    const members = new FakeMembers([ACTIVE()]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({ reason }),
    });
    expect(res.status).toBe(200);
    expect(audit.entries).toHaveLength(1);
    return audit.entries[0];
  };

  it("the hostile reason reaches the trail with NO control characters", async () => {
    // The DEFECT test's exact payload, asserted from the attacker's side: neither the forged trail
    // LINE nor the bidi override nor the NUL survives into the append-only row.
    const entry = await removeWithReason(
      "legit removal\n2026-01-01T00:00:00.000Z MEMBER_REMOVED by ADMIN alice\u202Egnittes\u0000  "
    );

    const stored = entry.reason!;
    // Not one code point of category C survives -- controls, format (where every bidi override
    // lives), surrogates, private-use, unassigned.
    expect(stored).not.toMatch(/\p{C}/u);
    expect(stored).not.toContain("\n");
    expect(stored).not.toContain("\u202E");
    expect(stored).not.toContain("\u0000");
    // The operator's words all survive and the two clauses stay TWO.
    expect(stored).toBe(
      "legit removal 2026-01-01T00:00:00.000Z MEMBER_REMOVED by ADMIN alice gnittes"
    );
    // Unchanged, and never the forgeable part: the structured fields come from the verified token.
    expect(entry.actorId).toBe("fac");
    expect(entry.actorRole).toBe("FACILITATOR");
  });

  it("a control RUN collapses to ONE SPACE, so padding cannot buy budget", async () => {
    // THE PROPERTY THAT MAKES THE CAP UNGAMEABLE, asserted as a LENGTH and not only as a string: a
    // 200-character control run contributes exactly ONE code point to the measured reason. Were it
    // 200 spaces, the whole AUDIT_REASON_MAX budget would be spendable on characters the sanitiser
    // was about to remove.
    const run = await removeWithReason("a" + "\n".repeat(200) + "b");
    expect(run.reason).toBe("a b");
    expect([...run.reason!]).toHaveLength(3);

    // Two clauses stay two rather than being fused -- see the header on why deleting would lie.
    expect((await removeWithReason("a\nb")).reason).toBe("a b");
    expect((await removeWithReason("first clause\r\n\t\tsecond clause")).reason).toBe(
      "first clause second clause"
    );

    // ORDER, asserted AT the bound and one PAST it. Sanitising before measuring means any amount of
    // padding costs nothing, so a reason of exactly 200 real code points arrives WHOLE behind 400
    // newlines -- and 201 real points still truncates to 200, so the cap is not weakened by the fix.
    expect((await removeWithReason("\n".repeat(400) + "the real reason")).reason).toBe(
      "the real reason"
    );
    const atLimit = await removeWithReason("\n".repeat(400) + "a".repeat(200));
    expect(atLimit.reason).toBe("a".repeat(200));
    const overLimit = await removeWithReason("\n".repeat(400) + "a".repeat(201));
    expect([...overLimit.reason!]).toHaveLength(200);
    expect(overLimit.reason).toBe("a".repeat(200));
  });

  it("ordinary internal spacing is PRESERVED -- a space is not a control character", async () => {
    // The opposite regression to the defect, and why the rule is "category C" and not "whitespace":
    // an operator's sentence must come back the way they wrote it.
    expect((await removeWithReason("a b")).reason).toBe("a b");
    expect((await removeWithReason("left  the   programme")).reason).toBe(
      "left  the   programme"
    );
    // A control run ADJACENT to a real space yields BOTH -- one space for the run, one the operator
    // typed. Specified behaviour, not a rough edge: collapsing the pair would mean rewriting real
    // spacing, which this sanitiser deliberately does not do.
    expect((await removeWithReason("restored\u202E after\u0000 review")).reason).toBe(
      "restored  after  review"
    );
  });

  it("a whitespace-only or control-only reason stores NO attribute at all", async () => {
    // Sanitised BEFORE the trim, so a reason made entirely of control characters collapses to
    // spaces, trims to "" and returns undefined. The ROW then carries no `reason` attribute rather
    // than a string of blanks the audit UI renders as an empty "Reason:" line.
    for (const nothing of ["", "   ", "\n\n\t \u202E", " \u202E\n", "\u200B", "\u0000\u0000"]) {
      expect((await removeWithReason(nothing)).reason, JSON.stringify(nothing)).toBeUndefined();
    }
  });

  it("KNOWN AND ACCEPTED: a ZWJ emoji sequence SPLITS; VS16, skin tones and flags do not", async () => {
    // -- A PINNED KNOWN CONSEQUENCE, NOT A BUG. DO NOT "FIX" IT BY ADDING AN EXEMPTION. --
    //
    // U+200D ZERO WIDTH JOINER is category Cf, so a ZWJ sequence is split into its parts. Pinned so
    // it is a known behaviour rather than a surprise in a support ticket -- and pinned as ACCEPTED
    // because the alternative is an exemption list, which is the thing that ages badly, that a
    // reviewer cannot check at a glance, and that is how the next bidi control nobody remembered
    // gets through. This field is a short operator note on an access change, not a message body: a
    // split emoji is legible and harmless; a hole in the rule is not.
    expect((await removeWithReason("\u{1F469}\u200D\u{1F4BB}")).reason).toBe(
      "\u{1F469} \u{1F4BB}"
    );
    expect((await removeWithReason("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} left")).reason).toBe(
      "\u{1F468} \u{1F469} \u{1F467} left"
    );

    // THE COST IS BOUNDED, measured against this runtime rather than assumed: U+FE0F VARIATION
    // SELECTOR-16 is Mn, skin-tone modifiers and regional indicators are So, combining marks are
    // Mn. None is in category C, so all of these survive code point for code point.
    for (const intact of [
      "❤️", // red heart + VS16
      "\u{1F44D}\u{1F3FF}", // thumbs up + skin-tone modifier
      "\u{1F1EC}\u{1F1E7}", // regional indicators GB
      "\u{1F642}", // plain emoji
      "1️⃣", // keycap: VS16 + combining enclosing keycap
      "é", // combining acute
    ]) {
      const stored = (await removeWithReason(`ok ${intact}`)).reason;
      expect(stored, JSON.stringify(intact)).toBe(`ok ${intact}`);
      // And no lone surrogate was introduced: re-encoding through UTF-8 is lossless.
      expect(Buffer.from(stored!, "utf8").toString("utf8"), JSON.stringify(intact)).toBe(stored);
    }
  });

  it("the reason IS bounded at 200 code points and cannot be used to bloat the trail", async () => {
    // The bound that does hold, measured in CODE POINTS so a surrogate pair cannot be cut in half —
    // a lone surrogate would be written into an append-only row that no later write can repair.
    const members = new FakeMembers([ACTIVE()]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({ reason: "\u{1F600}".repeat(5000) }),
    });

    const stored = audit.entries[0].reason!;
    expect([...stored]).toHaveLength(200);
    // No lone surrogate: re-encoding through UTF-8 is lossless.
    expect(Buffer.from(stored, "utf8").toString("utf8")).toBe(stored);
  });

  it("the audit ACTOR is always the VERIFIED token identity, never a body, query or header value", async () => {
    // The one thing that must be unforgeable on an audit entry. Every plausible spoof surface is
    // supplied at once; the recorded actor must still be the token's sub and its group-derived role,
    // and the subject and action must come from the path and the route.
    const members = new FakeMembers([ACTIVE()]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    await app.request("/v1/teams/t1/members/victim?actorId=boss&actorRole=ADMIN", {
      method: "DELETE",
      headers: {
        ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        "x-actor-id": "boss",
        "x-actor-role": "ADMIN",
      },
      body: JSON.stringify({
        actorId: "boss",
        actorRole: "ADMIN",
        subjectId: "someone-else",
        action: "MEMBER_RESTORED",
      }),
    });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorId: "fac",
      actorRole: "FACILITATOR",
      subjectId: "victim",
      action: "MEMBER_REMOVED",
    });
  });
});

// ═══ ATTACK 5 — ACTOR-IDENTITY DISCLOSURE ════════════════════════════════════════════

describe("ATTACK: actor-identity disclosure on the roster, former-members and the trail", () => {
  const USERS = [
    { id: "victim", name: "A Victim", email: "victim@example.com" },
    { id: "boss", name: "Root Admin", email: "boss@example.com" },
    { id: "fac", name: "Facilitator One", email: "f@example.com" },
  ];

  const removedByAdmin = (): TeamMember => ({
    teamId: "t1",
    userId: "victim",
    role: "LEAD",
    joinedAt: "2026-08-02T09:00:00.000Z",
    status: "INACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "boss",
    removedByRole: "ADMIN",
  });

  it("suppresses the ADMIN actor's NAME from a FACILITATOR — server-side, from the STORED role", async () => {
    // The anti-reconnaissance control: knowing WHICH accounts hold full platform access is itself
    // the reconnaissance step. Decided from `removedByRole` on the ROW (the role AT THE TIME), so it
    // costs no lookup and cannot be answered from a directory that has since changed.
    const { app } = build({
      members: new FakeMembers([removedByAdmin()]),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    const row = (await res.json()).members[0];
    expect(row.removedByName).toBeNull();
    // The ROLE is still disclosed — "removed by an Admin" names no account.
    expect(row.removedByRole).toBe("ADMIN");
  });

  it("the NAME suppression CANNOT be lifted by a query param or a header", async () => {
    // The gate must be server-side and unconditional. Every plausible bypass is tried against the
    // same row; none may produce the name. The x-identity-role-override cases matter because the
    // trusted-hop path DOES read x-identity-role — so only the exact header name must be honoured.
    const attempts: Array<{ qs: string; headers: Record<string, string> }> = [
      { qs: "?includeActorNames=1", headers: {} },
      { qs: "?resolveNames=true", headers: {} },
      { qs: "?callerRole=ADMIN", headers: {} },
      { qs: "?role=ADMIN", headers: {} },
      { qs: "", headers: { "x-identity-role-override": "ADMIN" } },
      { qs: "", headers: { "x-caller-role": "ADMIN" } },
      { qs: "", headers: { "x-admin": "1" } },
      { qs: "?withEmail=1", headers: {} },
    ];

    for (const { qs, headers } of attempts) {
      const { app } = build({
        members: new FakeMembers([removedByAdmin()]),
        users: new FakeUsers(USERS),
        workshops: new FakeWorkshops(true),
      });

      const res = await app.request(`/v1/teams/t1/members${qs}`, {
        headers: {
          ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
          ...headers,
        },
      });

      const row = (await res.json()).members[0];
      expect(row.removedByName, `${qs} ${JSON.stringify(headers)}`).toBeNull();
    }
  });

  /**
   * -- RE-POINTED: THESE WERE THE TWO `DEFECT (medium)` ACTOR-SUB LEAKS ----------
   *
   * WHAT THE DEFECTS WERE. `loadTeamMembersIncludingInactive` returned `{ ...m, removedByName }`.
   * A SPREAD IS AN ALLOWLIST THAT SILENTLY GROWS: the projection was written when a membership row
   * held four attributes and it kept emitting whatever the row grew into, with no edit here and
   * nothing to review. The row has since gained TWO RAW OPERATOR SUBS, and both rode out:
   *
   *   1. `removedBy` -- the removing operator's Cognito sub. Only the DERIVED `removedByName` was
   *      gated, so a FACILITATOR was refused the ADMIN's NAME and handed their unique, stable
   *      IDENTIFIER in the same JSON object. That defeats the stated purpose of the gate: the
   *      control exists so a facilitator cannot learn WHICH ACCOUNTS HOLD FULL PLATFORM ACCESS,
   *      and a sub identifies the account precisely, never changes, and is the join key on every
   *      other surface. MEDIUM rather than high only because identity's /admin/user-names and
   *      /admin/users?ids= both apply canSeeUser, so the sub could not be turned into a name there.
   *   2. `reactivatedBy` -- the restoring operator's sub, and worse, because it CANNOT be gated:
   *      there is deliberately no `reactivatedByRole` on the row (domain.ts: "no surface renders
   *      it"), so no stored historical role exists to decide visibility from, and deriving one from
   *      today's directory would answer a historical question with current data. This route admits
   *      any MEMBER of the team, so the sub reached PARTICIPANTS -- the widest audience of the two.
   *
   * The old tests asserted `row.removedBy === "boss"` and `row.reactivatedBy === "boss"`, i.e. the
   * leaks as OBSERVED, so the report could not drift from the code.
   *
   * WHAT FIXED IT (routes.ts:732-850). The projection now ENUMERATES every field it emits:
   *
   *   - `removedBy` is carried ONLY under the SAME `actorVisible` gate as `removedByName` -- the
   *     one variable is REUSED rather than recomputed, so the identifier and the name can never
   *     disagree about who is visible.
   *   - `reactivatedBy` is omitted ENTIRELY, for every caller. Omission rather than a gate because
   *     nothing consumes it (grepped across the portal and desktop) and because there is no
   *     role to gate on. The authoritative record of who restored a membership is the
   *     MEMBER_RESTORED audit entry, which carries the actor AND their role at the time.
   *
   * WHY ABSENCE AND NOT `null`. Asserted as `Object.keys(...)` NOT CONTAINING the key, deliberately:
   * `=== undefined` passes for a key present with an undefined value, and more importantly an ABSENT
   * key discloses nothing -- not even that something is being withheld from this row rather than
   * missing from the store. A `removedBy: null` beside a `removedByName: null` would tell a
   * facilitator "there is an actor here you are not allowed to see", which is itself the
   * reconnaissance signal.
   *
   * DO NOT "SIMPLIFY" THIS BACK TO A SPREAD. The exact-key assertions below are what turn a future
   * attribute on TeamMember into a failing test rather than a silent disclosure.
   */
  it("the ROSTER withholds the hidden ADMIN's SUB from a FACILITATOR, and gives an ADMIN both", async () => {
    // BOTH DIRECTIONS OF THE MATRIX IN ONE TEST, so this cannot pass by withholding the field from
    // everybody -- which would be an availability regression dressed up as a fix. The attacker's
    // actual goal on this route is a stable, correlatable identifier for an account holding full
    // platform access; it is no longer in the payload under any key.
    const { app } = build({
      members: new FakeMembers([removedByAdmin()]),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
    });

    const asFacilitator = await app.request("/v1/teams/t1/members", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    const hiddenRaw = await asFacilitator.text();
    const hidden = JSON.parse(hiddenRaw).members[0];
    // The name is suppressed, as it always was...
    expect(hidden.removedByName).toBeNull();
    // ...and the sub is now ABSENT rather than sitting beside it. THE KEY ITSELF IS GONE -- an
    // absent key cannot be mistaken for a value and discloses nothing about what is withheld.
    expect(Object.keys(hidden)).not.toContain("removedBy");
    expect("removedBy" in hidden).toBe(false);
    // Nowhere in the serialised row under ANY key or nesting -- the check the spread failed.
    expect(JSON.stringify(hidden)).not.toContain("boss");
    // ON THE WIRE, not merely after a parse.
    expect(hiddenRaw).not.toContain("boss");
    // The ROLE is still disclosed: "removed by an Admin" names no account, and suppressing it would
    // leave a row that says a removal happened and refuses to say by whom in any form.
    expect(hidden.removedByRole).toBe("ADMIN");

    const asAdmin = await app.request("/v1/teams/t1/members", {
      headers: asUser({ id: "boss", email: "boss@example.com", role: "ADMIN" }),
    });
    const shown = (await asAdmin.json()).members[0];
    // A caller entitled to the account gets BOTH, from the SAME gate.
    expect(shown.removedByName).toBe("Root Admin");
    expect(shown.removedBy).toBe("boss");
    expect(Object.keys(shown)).toContain("removedBy");
  });

  it("the NAME/SUB gate cannot be split — no query param or header yields one without the other", async () => {
    // THE GATE IS ONE VARIABLE, and this is what pins that. `actorVisible` is computed once and
    // reused for both fields, so there is no request shape that produces the sub while the name is
    // suppressed. Every bypass the name-suppression test tries is tried again here against the
    // IDENTIFIER, because the identifier is the part that was actually leaking.
    const attempts: Array<{ qs: string; headers: Record<string, string> }> = [
      { qs: "?includeActorNames=1", headers: {} },
      { qs: "?resolveNames=true", headers: {} },
      { qs: "?callerRole=ADMIN", headers: {} },
      { qs: "?role=ADMIN", headers: {} },
      { qs: "?removedBy=1", headers: {} },
      { qs: "", headers: { "x-identity-role-override": "ADMIN" } },
      { qs: "", headers: { "x-caller-role": "ADMIN" } },
      { qs: "", headers: { "x-admin": "1" } },
      { qs: "?withEmail=1", headers: {} },
    ];

    for (const { qs, headers } of attempts) {
      const { app } = build({
        members: new FakeMembers([removedByAdmin()]),
        users: new FakeUsers(USERS),
        workshops: new FakeWorkshops(true),
      });

      const res = await app.request(`/v1/teams/t1/members${qs}`, {
        headers: {
          ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
          ...headers,
        },
      });

      const label = `${qs} ${JSON.stringify(headers)}`;
      const raw = await res.text();
      const row = JSON.parse(raw).members[0];
      expect(row.removedByName, label).toBeNull();
      expect(Object.keys(row), label).not.toContain("removedBy");
      expect(raw, label).not.toContain("boss");
    }
  });

  it("the roster carries NO reactivatedBy — not for a PARTICIPANT, not for an ADMIN", async () => {
    // THE WIDEST-AUDIENCE LEAK, CLOSED BY OMISSION. Asserted for the PARTICIPANT (admitted purely
    // by membership -- the widest reader of this route, and the caller the old DEFECT test used) AND
    // for an ADMIN, so the answer is "this field is not on this surface" rather than "it depends".
    // An ADMIN who needs to know who restored a membership reads the AUDIT TRAIL, which carries the
    // actor and their role at the time and is directory-gated.
    const restoredByAdmin: TeamMember = {
      teamId: "t1",
      userId: "victim",
      role: "LEAD",
      joinedAt: "2026-08-02T09:00:00.000Z",
      status: "ACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "boss",
      removedByRole: "ADMIN",
      reactivatedAt: "2026-08-05T10:00:00.000Z",
      reactivatedBy: "boss",
    };

    for (const caller of [
      { id: "nosy", email: "n@example.com", role: "PARTICIPANT" },
      { id: "boss", email: "boss@example.com", role: "ADMIN" },
    ]) {
      const { app } = build({
        members: new FakeMembers([
          restoredByAdmin,
          { teamId: "t1", userId: "nosy", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
        ]),
        users: new FakeUsers(USERS),
        // Not staff and not the owner -- the PARTICIPANT is admitted purely by membership.
        workshops: new FakeWorkshops(caller.role === "ADMIN"),
      });

      const res = await app.request("/v1/teams/t1/members", {
        headers: asUser(caller),
      });
      expect(res.status, caller.role).toBe(200);
      const row = (await res.json()).members.find(
        (m: { userId: string }) => m.userId === "victim"
      );
      expect(Object.keys(row), caller.role).not.toContain("reactivatedBy");
      expect("reactivatedBy" in row, caller.role).toBe(false);
      // The TIMESTAMP stays -- it names no account, so there is nothing to withhold. It is also not
      // a new disclosure on THIS route: the row already says, non-null and to every reader, that a
      // removal happened (`removedAt`, `removedByRole`). This is the surface that legitimately shows
      // removal history; the fan-out below is the one where no such history belongs at all.
      expect(row.reactivatedAt, caller.role).toBe("2026-08-05T10:00:00.000Z");
    }
  });

  it("a PARTICIPANT reading a restored member's row learns NO operator identifier at all", async () => {
    // The full row as the widest audience sees it, pinned as a KEY SET rather than as two absences.
    // A future attribute added to the stored TeamMember row fails THIS assertion instead of quietly
    // appearing in the response -- which is precisely the property the spread destroyed.
    const restoredByAdmin: TeamMember = {
      teamId: "t1",
      userId: "victim",
      role: "LEAD",
      joinedAt: "2026-08-02T09:00:00.000Z",
      status: "ACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "boss",
      removedByRole: "ADMIN",
      reactivatedAt: "2026-08-05T10:00:00.000Z",
      reactivatedBy: "boss",
    };

    const { app } = build({
      members: new FakeMembers([
        restoredByAdmin,
        { teamId: "t1", userId: "nosy", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      ]),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(false),
    });

    const res = await app.request("/v1/teams/t1/members", {
      headers: asUser({ id: "nosy", email: "n@example.com", role: "PARTICIPANT" }),
    });

    const raw = await res.text();
    const row = JSON.parse(raw).members.find(
      (m: { userId: string }) => m.userId === "victim"
    );
    expect(Object.keys(row).sort()).toEqual([
      "joinedAt",
      "reactivatedAt",
      "removedAt",
      "removedByName",
      "removedByRole",
      "role",
      "status",
      "teamId",
      "user",
      "userId",
    ]);
    // The admin's sub appears nowhere in the payload, on the wire.
    expect(JSON.stringify(row)).not.toContain("boss");
    expect(raw).not.toContain("boss");
  });

  /**
   * -- THE SECOND LEAK SITE, AND THE ONE WITH THE REACHABLE WIDE AUDIENCE ------------------
   *
   * `loadTeamMembers` -- the ACTIVE-ONLY loader behind `?withMembers=1` -- ALSO built its rows with
   * `{ ...m }`, and the reason that looked safe was the repository: an INACTIVE row is refused by
   * `listByTeam`, so a removed member's metadata never reaches it.
   *
   * REACTIVATION IS THE CASE THAT DEFEATS THAT ARGUMENT. Restoring a membership flips `status` back
   * to ACTIVE and deliberately does NOT clear the removal breadcrumb (domain.ts: the row says
   * "restored then removed again", and `status` is the only field that says what holds NOW). So a
   * restored row is ACTIVE, passes the filter, and arrived here carrying `removedBy` AND
   * `reactivatedBy`. Unlike the roster there was no gate being contradicted, because this path
   * applies none at all -- and its member-filtered branch admits any PARTICIPANT to the teams they
   * are on, which is the request the portal's workshop.getById fan-out makes on that participant's
   * own team pages with no elevated privilege anywhere in it.
   *
   * THE FIX IS OMISSION, NOT A GATE: a LIVE roster has no reason to carry removal history for
   * anyone, so no `callerRole` is threaded in and there is no per-caller decision to get wrong.
   */
  it("the ?withMembers=1 fan-out leaks NO operator identifier to a PARTICIPANT on a team with a RESTORED member", async () => {
    // THE SPECIFIC REACHABLE CASE, driven through the route an ordinary participant actually hits.
    const restoredByAdmin: TeamMember = {
      teamId: "t1",
      userId: "victim",
      role: "LEAD",
      joinedAt: "2026-08-02T09:00:00.000Z",
      status: "ACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "boss",
      removedByRole: "ADMIN",
      reactivatedAt: "2026-08-05T10:00:00.000Z",
      reactivatedBy: "boss",
    };

    const { app } = build({
      teams: new FakeTeams([team({ workshopId: "w1", id: "t1" })]),
      members: new FakeMembers([
        restoredByAdmin,
        { teamId: "t1", userId: "nosy", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      ]),
      users: new FakeUsers(USERS),
      // Not staff and not the workshop owner: the participant reaches branch 3, the
      // member-filtered list, purely because they are on t1.
      workshops: new FakeWorkshops(false),
    });

    const res = await app.request("/v1/workshops/w1/teams?withMembers=1", {
      headers: asUser({ id: "nosy", email: "n@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.teams.map((t: { id: string }) => t.id)).toEqual(["t1"]);

    const restored = body.teams[0].members.find(
      (m: { userId: string }) => m.userId === "victim"
    );
    // ABSENT, not null: the caller cannot even tell removal metadata exists on this row.
    for (const key of [
      "removedBy",
      "reactivatedBy",
      "removedByRole",
      "removedAt",
      "reactivatedAt",
      "removedByName",
    ]) {
      expect(Object.keys(restored), key).not.toContain(key);
    }
    // NOWHERE IN THE WHOLE PAYLOAD, under any key or nesting or team.
    expect(raw).not.toContain("boss");
    // And no operator NAME rode in either -- nothing on this path resolves an actor at all.
    expect(raw).not.toContain("Root Admin");

    // THE COUNT STILL COUNTS THEM. A restored member is genuinely ACTIVE, so suppressing their
    // history must not suppress the person: an under-count would be a functional regression
    // smuggled in behind a security fix, and reads as a working feature.
    expect(body.teams[0]._count).toEqual({ members: 2 });
    expect(
      body.teams[0].members.map((m: { userId: string }) => m.userId).sort()
    ).toEqual(["nosy", "victim"]);
  });

  it("`status` PRESENCE is not itself a breadcrumb — a never-removed and a RESTORED row are shape-identical", async () => {
    // -- THE SUBTLE HALF OF THE SAME LEAK, AND ITS OWN TEST BECAUSE IT IS EASY TO UNDO --
    //
    // A NEVER-REMOVED row carries NO `status` attribute at all, while a RESTORED one carries the
    // literal "ACTIVE". So forwarding `m.status` raw made the mere PRESENCE OF THE KEY say "this
    // membership was removed and restored" -- the same disclosure in a subtler form, and one that
    // survives deleting every id field. It is now DERIVED through the shared `isInactiveMembership`
    // (routes.ts:678-680) rather than passed through or hardcoded to ACTIVE: derived so it still
    // tells the truth if the repository's active-only guarantee ever regresses, and shared so there
    // is no second local copy of what INACTIVE means.
    //
    // Anyone "simplifying" `status: isInactiveMembership(m.status) ? ... : ...` back to `m.status`
    // fails this test, which is the entire point of pinning it separately.
    const RESTORED: TeamMember = {
      teamId: "t1",
      userId: "victim",
      role: "LEAD",
      joinedAt: "2026-08-02T09:00:00.000Z",
      status: "ACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "boss",
      removedByRole: "ADMIN",
      reactivatedAt: "2026-08-05T10:00:00.000Z",
      reactivatedBy: "boss",
    };
    const NEVER_REMOVED: TeamMember = {
      teamId: "t1",
      userId: "nosy",
      role: "BUILDER",
      joinedAt: "2026-01-01T00:00:00.000Z",
    };
    // THE PREMISE, asserted rather than assumed: the two STORED rows really do differ in whether
    // the attribute exists. Without this the test could pass against fixtures that were already
    // identical, which is how a pin quietly stops pinning anything.
    expect("status" in NEVER_REMOVED).toBe(false);
    expect(RESTORED.status).toBe("ACTIVE");

    const { app } = build({
      teams: new FakeTeams([team({ workshopId: "w1", id: "t1" })]),
      members: new FakeMembers([RESTORED, NEVER_REMOVED]),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(false),
    });

    const res = await app.request("/v1/workshops/w1/teams?withMembers=1", {
      headers: asUser({ id: "nosy", email: "n@example.com", role: "PARTICIPANT" }),
    });

    const rows = (await res.json()).teams[0].members as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // Both report ACTIVE, because both ARE active.
    expect(rows.map((m) => m.status)).toEqual(["ACTIVE", "ACTIVE"]);
    // IDENTICAL KEY SETS: nothing about a row's history is inferable from its shape.
    const shapes = rows.map((m) => Object.keys(m).sort().join(","));
    expect(shapes[0]).toBe(shapes[1]);
    // And the shape is the enumerated one, so this cannot pass by both rows growing a new field.
    expect(shapes[0]).toBe("joinedAt,role,status,teamId,user,userId");
  });

  it("FORMER-MEMBERS leaks no actor id — the field-by-field construction the roster should copy", async () => {
    // The CONTROL for the two defects above, and the reason they are defects rather than an accepted
    // design: this route answers the same question about the same actor and discloses the ROLE
    // without the IDENTIFIER, because it builds its row explicitly instead of spreading.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "boss",
      actorRole: "ADMIN",
      teamId: "t1",
    });

    const { app } = build({
      members: new FakeMembers([]),
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
      audit,
    });

    const res = await app.request("/v1/teams/t1/former-members", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    const row = (await res.json()).formerMembers[0];
    expect(row.removedByName).toBeNull();
    expect(row.removedByRole).toBe("ADMIN");
    // No actor identifier anywhere on the row.
    expect(Object.keys(row)).not.toContain("actorId");
    expect(JSON.stringify(row)).not.toContain("boss");
  });

  it("the FACILITATOR cannot pivot a leaked sub through /v1/audit/users/:sub", async () => {
    // Checking whether the leak CHAINS. This route IS open to a FACILITATOR (canReadDirectory), so
    // the question is whether querying the ADMIN's sub as a SUBJECT reveals anything about them. It
    // returns entries where they are the subject — actions taken ABOUT them — which for a
    // never-removed admin is empty. Recorded so the escalation path is assessed rather than assumed.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "boss",
      actorRole: "ADMIN",
      teamId: "t1",
    });

    const { app } = build({
      // OWNS w1, the default `team()`'s experience — required since the trail became
      // ownership-scoped. `build()` defaults to an EMPTY scope (the restrictive answer), so
      // without this every team-scoped entry is withheld and these tests would assert the
      // absence of a sub in a response that had no entries at all: vacuously true.
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
      users: new FakeUsers(USERS),
      audit,
    });

    const res = await app.request("/v1/audit/users/boss", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    // Nothing about the admin — the trail is keyed on the SUBJECT and they are an ACTOR.
    expect((await res.json()).entries).toEqual([]);
  });

  /**
   * ── RE-POINTED (second pass): THIS WAS `DEFECT (low): /v1/audit/users/:userId
   *    discloses raw actorIds to a FACILITATOR` ──────────────────────────────────────────────
   *
   * WHAT THE DEFECT WAS. The route ended `return c.json({ entries })` — every stored AuditEntry
   * field handed back verbatim, `actorId` included. Its own header said "Ids only, never names:
   * the resolution to names happens in the BFF through the same visibility-honouring helper",
   * which was true of the NAME and silent about the ID. The old test asserted
   * `entries[0].actorId === "boss"` so the report could not drift from the code.
   *
   * WHY IT WAS WORSE THAN THE ROSTER LEAK IT MATCHES. `canReadDirectory` admits FACILITATOR, and
   * this route is DIRECTORY-shaped: nothing scopes it to teams the caller already has read on,
   * so a facilitator could sweep any subject's trail and harvest the subs of every ADMIN who
   * ever acted on them. LOW because the sub is not escalatable to a name (identity's
   * /admin/user-names and /admin/users?ids= both apply canSeeUser), but a stable correlatable
   * identifier for the accounts holding full platform access is itself the reconnaissance step
   * USER_VISIBILITY_GRANTS exists to stop.
   *
   * WHAT FIXED IT. The route now builds each entry FIELD BY FIELD and carries `actorId` only
   * when `canSeeUser(callerRole, entry.actorRole)` holds — the same gate, from the same stored
   * historical role, as former-members and the roster.
   *
   * WHY THE NEW EXPECTATIONS ARE THE RIGHT ONES:
   *
   *   - OMITTED, NOT NULL. `actorId: null` would still tell a facilitator "an account you may
   *     not see did this", which is half the answer they were refused. An absent key discloses
   *     nothing, not even that something is being withheld. Asserted as `"actorId" in entry ===
   *     false` and via Object.keys, because `=== undefined` passes for a present-but-undefined
   *     key.
   *   - `actorRole` STAYS. "Performed by an Admin" names no account and is what the entry is
   *     FOR; suppressing it would leave a row that says an action happened and refuses to say by
   *     whom in any form.
   */
  it("the trail withholds an ADMIN actor's sub from a FACILITATOR, keeping the ROLE", async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "boss",
      actorRole: "ADMIN",
      teamId: "t1",
    });

    const { app } = build({
      // OWNS w1, the default `team()`'s experience — required since the trail became
      // ownership-scoped. `build()` defaults to an EMPTY scope (the restrictive answer), so
      // without this every team-scoped entry is withheld and these tests would assert the
      // absence of a sub in a response that had no entries at all: vacuously true.
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
      users: new FakeUsers(USERS),
      audit,
    });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    // The raw payload first: the sub must not appear ANYWHERE, under any key.
    const text = await res.clone().text();
    expect(text).not.toContain("boss");

    const entries = (await res.json()).entries;
    // The KEY IS ABSENT — the assertion the old defect test's inverse could not make.
    expect("actorId" in entries[0]).toBe(false);
    expect(Object.keys(entries[0])).not.toContain("actorId");
    // The role survives, so "removed by an Admin" is still renderable.
    expect(entries[0].actorRole).toBe("ADMIN");
    // And the rest of the entry is intact — this is a suppression, not a mangling.
    expect(entries[0]).toMatchObject({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      teamId: "t1",
    });
  });

  it("an ADMIN reading the SAME entries gets the sub — the gate is per-caller, not a deletion", async () => {
    // The control on the fix: withholding for everyone would be a different defect (the trail
    // exists to be correlated during an incident), so the ADMIN case proves the field is gated
    // rather than dropped.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "boss",
      actorRole: "ADMIN",
      teamId: "t1",
    });

    const { app } = build({
      // OWNS w1, the default `team()`'s experience — required since the trail became
      // ownership-scoped. `build()` defaults to an EMPTY scope (the restrictive answer), so
      // without this every team-scoped entry is withheld and these tests would assert the
      // absence of a sub in a response that had no entries at all: vacuously true.
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
      users: new FakeUsers(USERS),
      audit,
    });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin2", email: "a@example.com", role: "ADMIN" }),
    });

    const entries = (await res.json()).entries;
    expect(entries[0].actorId).toBe("boss");
    expect(entries[0].actorRole).toBe("ADMIN");
  });

  it("former-members is gated on team READ — an outsider cannot read a team's removal history", async () => {
    // The IDOR check on a route whose rows carry names AND email addresses. A stranger naming a
    // teamId must be refused, whatever their platform role, including a FACILITATOR who does not own
    // the workshop.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });

    for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE", "FACILITATOR"]) {
      const { app } = build({
        members: new FakeMembers([]),
        users: new FakeUsers(USERS),
        // Not a member, and not the owner.
        workshops: new FakeWorkshops(false),
        audit,
      });

      const res = await app.request("/v1/teams/t1/former-members", {
        headers: asUser({ id: "outsider", email: "o@example.com", role }),
      });

      expect(res.status, role).toBe(403);
    }
  });
});

// ═══ ATTACK 6 — DOES THE SOFT DELETE REOPEN THE REJOIN EXPLOIT? (regression on bc6d30a) ══

describe("ATTACK: the soft delete must not reopen the rejoin exploit", () => {
  const TEAM = team({ workshopId: "w1", id: "t1", inviteCode: "JOINCODE" });
  const USERS = [{ id: "victim", name: "A Victim", email: "victim@example.com" }];

  /** Remove `victim` from t1 as the owning facilitator, then hand back the same app. */
  const removeThen = async (invitations: FakeInvitations, members: FakeMembers) => {
    const { app } = build({
      teams: new FakeTeams([TEAM]),
      members,
      invitations,
      users: new FakeUsers(USERS),
      workshops: new FakeWorkshops(true),
      // The directory read below is made as an ADMIN, who sees only the
      // workshops they OWN — without a scope the page is empty and the member-count assertion
      // has nothing to count. TEAM lives in w1.
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "W One" }]),
    });
    const removed = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(removed.status).toBe(200);
    return app;
  };

  const acceptedInvite = () =>
    new FakeInvitations([
      invitation({ teamId: "t1", email: "victim@example.com", status: "ACCEPTED" }),
    ]);
  const liveMember = () =>
    new FakeMembers([
      { teamId: "t1", userId: "victim", role: "LEAD", joinedAt: "2026-08-02T00:00:00.000Z" },
    ]);

  it("an INACTIVE row is NOT a membership: the join route's idempotent short-circuit does not fire", async () => {
    // THE EXACT WAY THE SOFT DELETE COULD HAVE REOPENED THE EXPLOIT. POST /teams/join
    // short-circuits to 200 for an existing member BEFORE the spent-invitation gate. If that check
    // used `getIncludingInactive` — or if `get()` returned the inactive row — a removed person would
    // be handed 200 and their membership treated as live, bypassing the gate entirely.
    //
    // The defence is the repository's inverted default (`get()` answers null for an inactive row),
    // which is why this is asserted from the OUTSIDE: the removed person must REACH the gate and be
    // refused, not be short-circuited to success.
    const invitations = acceptedInvite();
    const members = liveMember();

    const app = await removeThen(invitations, members);

    // The row survived as INACTIVE, and the invitation was revoked by the removal.
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(invitations.rows[0].status).toBe("REVOKED");

    const rejoin = await app.request("/v1/teams/join", {
      method: "POST",
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ inviteCode: "JOINCODE" }),
    });

    expect(rejoin.status).toBe(403);
    // Still INACTIVE — the refusal did not write a membership.
    expect(members.rows[0].status).toBe("INACTIVE");
  });

  it("the sign-in accept path cannot re-admit a removed person either", async () => {
    // The second door: POST /invitations/mine/accept WRITES membership and runs on every sign-in. A
    // REVOKED row must be skipped entirely — no membership write and no status re-flip — or the
    // removed person is back on the team automatically, with no request from anyone saying so.
    const invitations = acceptedInvite();
    const members = liveMember();

    const app = await removeThen(invitations, members);

    const signIn = await app.request("/v1/invitations/mine/accept", {
      method: "POST",
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
    });

    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ accepted: 0, revoked: 1 });
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(invitations.rows[0].status).toBe("REVOKED");
  });

  it("the INACTIVE row grants nothing on the authorization probe — all four booleans false", async () => {
    // The single most important consequence of the soft delete, checked through the route the five
    // consumer services actually call. If any of these were true, a removed person would keep access
    // to a content surface — and docs reads this table DIRECTLY, so it could not be fixed from here.
    const members = liveMember();
    const app = await removeThen(acceptedInvite(), members);

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  it("the INACTIVE row disappears from /teams/mine and from the workshop membership probe", async () => {
    // Two more readers of the same table, both of which would leak the removed person back into a
    // UI (their own home screen, and workshop entitlement) if the filter lived only in `get()`.
    const members = liveMember();
    const app = await removeThen(acceptedInvite(), members);

    const mine = await app.request("/v1/teams/mine", {
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
    });
    expect((await mine.json()).teams).toEqual([]);

    const membership = await app.request("/v1/workshops/w1/membership", {
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
    });
    expect((await membership.json()).isMember).toBe(false);
  });

  it("REACTIVATE then REMOVE AGAIN leaves the invite code admitting nobody — the full cycle", async () => {
    // The cycle the reversible removal introduces, driven end to end. The invitation is REVOKED by
    // the first removal, stays REVOKED across the restoration (the membership row is the grant), and
    // the second removal is a no-op on it. So at NO point in the cycle does a live credential exist.
    const invitations = acceptedInvite();
    const members = liveMember();
    const app = await removeThen(invitations, members);

    const restored = await app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(restored.status).toBe(200);
    // The preserved role came back.
    expect((await restored.json()).role).toBe("LEAD");
    expect(invitations.rows[0].status).toBe("REVOKED");

    // Removed again.
    await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(members.rows[0].status).toBe("INACTIVE");

    const rejoin = await app.request("/v1/teams/join", {
      method: "POST",
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ inviteCode: "JOINCODE" }),
    });
    expect(rejoin.status).toBe(403);
  });

  it("the DIRECTORY's member count excludes a removed person", async () => {
    // The one good property the hard delete had, which the soft delete had to preserve: a removed
    // person must not be counted. An inflated count reads as a working feature, which is why it is
    // asserted rather than assumed.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "LEAD", joinedAt: "2026-08-02T00:00:00.000Z" },
      { teamId: "t1", userId: "other", role: "BUILDER", joinedAt: "2026-08-02T00:00:00.000Z" },
    ]);
    const app = await removeThen(acceptedInvite(), members);

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect((await res.json()).teams[0].memberCount).toBe(1);
  });
});

describe("PREMISE CHECK for the reactivate finding", () => {
  it("the invitation route REFUSES a team-scoped FACILITATOR/JUDGE invitation — so no such row can exist", async () => {
    for (const role of ["FACILITATOR", "JUDGE", "ADMIN"]) {
      const invitations = new FakeInvitations([]);
      const { app } = build({ invitations, workshops: new FakeWorkshops(true) });
      const res = await app.request("/v1/teams/t1/invitations", {
        method: "POST",
        headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
        body: JSON.stringify({ emails: ["victim@example.com"], platformRole: role }),
      });
      expect(res.status, role).toBe(400);
      expect((await res.json()).error, role).toMatch(/invited to the platform, not to a team/i);
      expect(invitations.rows, role).toHaveLength(0);
    }
  });
});

/**
 * ── ⚠ ACCEPT-ON-BEHALF IS STAFF-ONLY, AND `requireTeamWrite` DID NOT MEAN THAT ────────────────
 *
 * FOUND IN A SECURITY REVIEW (High): the invitation-accept-on-behalf route, gated by
 * requireTeamWrite, admitted any ordinary team member, permanently burning teammates' pending
 * invitations. Verified against authz.ts before changing anything: `requireTeamWrite` excludes
 * read-only roles and then calls `canRead`, whose first branch is an unconditional
 * `members.get(teamId, userId)` — so every PARTICIPANT member satisfied a guard the route's own
 * header described as "team staff".
 *
 * ⚠ WHY THIS IS NOT MERELY UNTIDY. ACCEPTED is terminal in three places (join refuses a spent
 * invitation, DELETE answers 409, re-inviting answers INVITATION_ALREADY_ACCEPTED), so the victim
 * cannot undo it — a burned invitation needs staff intervention. And the addresses are readable by
 * the same attacker: GET …/invitations needs only membership.
 *
 * The whole route was covered by tests before this change and NONE of them failed when the guard
 * was tightened, because none exercised the on-behalf branch. That absence is why the escalation
 * survived, so these cases assert both directions.
 */
describe("ATTACK: PATCH /v1/teams/:teamId/invitations/:email/accept on behalf", () => {
  const accept = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    email = "invitee@example.com"
  ) =>
    app.request(`/v1/teams/t1/invitations/${encodeURIComponent(email)}/accept`, {
      method: "PATCH",
      headers: asUser(identity),
    });

  it("REFUSES an ordinary PARTICIPANT member — the escalation", async () => {
    // Membership is granted on purpose, so the refusal is provably the ROLE rather than a failed
    // membership lookup. This is the exact call the finding describes.
    const invitations = new FakeInvitations([invitation()]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "member", role: "MEMBER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({
      invitations,
      members,
      workshops: new FakeWorkshops(true),
    });

    const res = await accept(app, { id: "member", email: "member@example.com", role: "PARTICIPANT" });

    expect(res.status).toBe(403);
    // The row is untouched and the repository was never asked — a 403 that still flipped the
    // status would be the same bug with a different response code.
    expect(invitations.rows[0].status).toBe("PENDING");
    expect(invitations.accepted).toHaveLength(0);
  });

  it("still allows the facilitator who owns the workshop — roster reconciliation keeps working", async () => {
    // The capability the route exists for. Tightening a guard until the legitimate case breaks is
    // not a fix, so this is asserted alongside the refusal rather than left implied.
    const invitations = new FakeInvitations([invitation()]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await accept(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(invitations.rows[0].status).toBe("ACCEPTED");
  });

  it("still allows the invitee themselves, who is not staff and never was", async () => {
    // The primary path: no membership, no staff role, just a verified email that matches. It runs
    // BEFORE the guard, so a change to the guard must not disturb it.
    const invitations = new FakeInvitations([invitation()]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(false) });

    const res = await accept(app, {
      id: "u9",
      email: "invitee@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    expect(invitations.rows[0].status).toBe("ACCEPTED");
  });

  it("REFUSES a facilitator who does not own the team's workshop", async () => {
    // requireTeamAdministration is staff AND ownership. A facilitator from another workshop is
    // staff-by-role and must still be refused, or the fix would only have narrowed the hole.
    const invitations = new FakeInvitations([invitation()]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(false) });

    const res = await accept(app, { id: "other-fac", email: "of@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(403);
    expect(invitations.rows[0].status).toBe("PENDING");
    expect(invitations.accepted).toHaveLength(0);
  });
});
