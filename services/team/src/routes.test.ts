import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createTeamRoutes } from "./routes.js";
import { hashInviteToken, inviteExpiry } from "./invite-token.js";
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
import { MAX_TEAM_MEMBERS } from "./team-size.js";
import { AmbiguousInviteCodeError, isWellFormedInviteCode } from "./invite-code.js";
import type { WorkshopAccess, WorkshopDirectory, WorkshopRef } from "./authz.js";

/**
 * Route-level tests for the Team service. Every dependency is injected — the
 * routes never see DynamoDB or an HTTP client — which is exactly what the DIP
 * seam in domain.ts/authz.ts exists for.
 *
 * Authentication uses the trusted-internal-hop path (x-internal-token +
 * x-identity-*), the same edgeIdentityMiddleware the deployed service runs, so no
 * Cognito JWKS fetch is needed.
 */
const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
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
  /**
   * MODELS THE REAL REPOSITORY'S AMBIGUITY REFUSAL. The store queries the
   * `inviteCode-index` GSI, which cannot enforce uniqueness, and now THROWS rather than
   * returning an arbitrary duplicate. A fake that silently returned the first match would let a
   * route that mishandles the throw pass every test.
   */
  async getByInviteCode(inviteCode: string) {
    const matches = this.rows.filter((t) => t.inviteCode === inviteCode);
    if (matches.length > 1) {
      throw new AmbiguousInviteCodeError(inviteCode, matches.length);
    }
    return matches[0] ?? null;
  }
  async listByWorkshop(workshopId: string) {
    return this.rows.filter((t) => t.workshopId === workshopId);
  }
  async put(team: Team) {
    this.rows.push(team);
    return team;
  }
  /**
   * CONDITIONAL, like the store's `memberCount <= :cap OR attribute_not_exists(memberCount)`.
   *
   * A fake that always succeeded would let a route that never checks the count pass every
   * test — and the whole of the seat-cap patch rule is that refusal. The `attribute_not_exists` disjunct
   * is mirrored too: a legacy row with NO `memberCount` accepts any valid cap, because
   * `memberCount <= :cap` evaluates FALSE for an absent attribute and without the disjunct a
   * facilitator could never set a cap on a pre-existing team.
   */
  async setSeatCap(workshopId: string, id: string, seatCap: number) {
    const row = this.rows.find((t) => t.workshopId === workshopId && t.id === id);
    if (!row) return false;
    if (typeof row.memberCount === "number" && row.memberCount > seatCap) {
      return false;
    }
    row.seatCap = seatCap;
    row.updatedAt = new Date().toISOString();
    return true;
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
  constructor(readonly rows: TeamMember[] = []) {}
  /**
   * Set to make deactivate()/reactivate() throw, reproducing a real store failure (throttle,
   * timeout, AccessDenied). The real repository RETHROWS those — only a
   * ConditionalCheckFailedException is benign — so the routes must surface a 5xx rather than
   * reporting an access change that did not happen.
   */
  failWrites?: unknown;
  /**
   * THE TEAMS STORE, so the SEAT LEDGER can be modelled.
   *
   * ── WHY THIS COUPLING EXISTS IN A FAKE, AND WHY IT IS NOT OPTIONAL DECORATION ──
   *
   * The real `admit`/`deactivate`/`reactivate` are ONE `TransactWriteItems` spanning
   * `team-members` AND `teams`: the membership row and the team's `memberCount` move together,
   * and the cap is a ConditionExpression on the TEAM item. A fake that only held member rows
   * could not express "full" at all, so every cap test would pass VACUOUSLY — which is exactly
   * the failure mode this repo's own comments warn about for the invitation flips.
   *
   * Wired by `build()` so every existing test gets it for free. Left `undefined` when a test
   * uses this class standalone, in which case `admit` models the store faithfully: no team row
   * means the ledger item's condition fails and the initialisation cannot repair it, which the
   * real repository answers "full".
   */
  teams?: FakeTeams;

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
  /**
   * ADMIT — the seat ledger, modelled faithfully enough that a cap test cannot pass vacuously.
   *
   * The real implementation is ONE `TransactWriteItems`: the membership row is Put under
   * `attribute_not_exists(userId)` while the team's `memberCount` is incremented under
   * `memberCount < seatCap`. Two outcomes therefore mean two DIFFERENT things, and conflating
   * them is the defect the seat-ledger design calls out — reporting "team full" to somebody who is
   * already on the team.
   *
   *   member-item condition fails  →  "already-member"   (idempotent; the route answers 200)
   *   team-item condition fails    →  "full"             (the route answers 409 TEAM_FULL)
   *
   * `this.teams` absent models a store with no team row at all: the ledger item's condition
   * cannot be satisfied and lazy initialisation has nothing to read, which the real repository
   * reports as "full" rather than inventing a seat.
   */
  async admit(member: TeamMember, workshopId: string): Promise<AdmitOutcome> {
    if (this.failWrites) throw this.failWrites;

    // Member-item condition first, matching the transaction: an existing row (ACTIVE or
    // INACTIVE) fails `attribute_not_exists(userId)` before the cap is ever considered.
    const existing = this.rows.find(
      (m) => m.teamId === member.teamId && m.userId === member.userId
    );
    if (existing) return "already-member";

    const team = this.teams?.rows.find(
      (t) => t.id === member.teamId && t.workshopId === workshopId
    );
    if (!team) return "full";

    // LAZY INIT, exactly as the repository does it: a row predating the counter has its
    // `memberCount` derived from the live roster, NOT defaulted to 0 — `if_not_exists(…, 0) + 1`
    // would let a 4-member legacy team climb to seatCap + 4.
    const active = this.rows.filter(
      (m) => m.teamId === member.teamId && !isInactiveMembership(m.status)
    ).length;
    const count = typeof team.memberCount === "number" ? team.memberCount : active;
    const cap = typeof team.seatCap === "number" ? team.seatCap : MAX_TEAM_MEMBERS;

    if (count >= cap) return "full";

    team.memberCount = count + 1;
    this.rows.push(member);
    return "admitted";
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

/** And for `workshopRevokedAt`, so "it did not move on a second entitlement withdrawal" is a
 *  real assertion. A distinct hour from FAKE_REVOKED_AT so the two breadcrumbs are never
 *  confusable in a failure message. */
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
  /** Every clearWorkshop ATTEMPT, so a test can assert the route asked for the right
   *  (teamId, email) and passed the ACTOR from the token — even when there was nothing to
   *  clear. */
  clearWorkshopCalls: Array<{ teamId: string; email: string; revokedBy: string }> = [];
  /**
   * Set to make clearWorkshop() throw. The real repository rethrows anything that is not a
   * ConditionalCheckFailedException, and the withdrawal route must let it reach the caller as
   * a 5xx rather than reporting an entitlement withdrawal that did not happen.
   */
  clearWorkshopThrows?: Error;
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
   * Mirrors DynamoInvitationRepository.clearWorkshop, including the four properties the
   * entitlement-withdrawal route depends on:
   *
   *   - ONLY `workshopId` GOES. `delete` rather than `= ""`, because the store issues
   *     `REMOVE workshopId` and `Invitation.workshopId`'s contract is that ABSENT means "no
   *     grant". A fake that blanked it would let an implementation that blanks pass, and a
   *     future reader testing presence rather than truthiness would then see a grant.
   *   - `status`, `acceptedAt`, `acceptedBy` and the provenance are UNTOUCHED. That is the
   *     whole difference from markRevoked, and the reason the route may work on a terminal row
   *     the DELETE refuses.
   *   - IDEMPOTENT. A row with no `workshopId` is left ALONE — `workshopRevokedAt` keeps its
   *     first value — and the call reports false, mirroring
   *     `attribute_exists(workshopId)` at the store. A fake that always returned true would
   *     hide a second audit entry and a second metric on a double-clicked Revoke.
   *   - NO UPSERT. A missing row reports false rather than fabricating one carrying
   *     `workshopRevokedBy` and no invitation (what the store's `attribute_exists(teamId)`
   *     guards).
   */
  async clearWorkshop(teamId: string, email: string, revokedBy: string) {
    if (this.clearWorkshopThrows) throw this.clearWorkshopThrows;
    this.clearWorkshopCalls.push({ teamId, email, revokedBy });
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

  /**
   * WIRE THE SEAT LEDGER. `admit` is ONE transaction spanning `team-members` AND
   * `teams`, so the members fake needs the teams fake to model the cap at all — without this
   * every `admit` finds no team row and reports "full", refusing every legitimate join.
   *
   * Done here rather than in each test so all ~900 existing tests get it for free, and so a
   * test that overrides only `members` or only `teams` still ends up with a consistent pair.
   */
  deps.members.teams = deps.teams;

  return { app: createTeamRoutes(deps), deps };
}

// ─── POST /v1/teams/join ────────────────────────────────────────────────────

describe("POST /v1/teams/join", () => {
  it("requires an inviteCode", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown invite code", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }) },
      body: JSON.stringify({ inviteCode: "NOPE" }),
    });
    expect(res.status).toBe(404);
  });

  it("REFUSES a valid invite code when the caller has no invitation for that team", async () => {
    // This is the rule the invite code alone must NOT be enough to satisfy: codes
    // get shared/guessed, so joining also requires an admin-created invitation row
    // for the caller's email. If this 403 ever becomes a 200, anyone holding a
    // leaked 8-char code can walk into a team.
    const invitations = new FakeInvitations([]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", email: "uninvited@example.com", role: "PARTICIPANT" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(res.status).toBe(403);
    expect(members.rows).toHaveLength(0);
  });

  it("refuses when the token carries no email claim (nothing to match an invitation on)", async () => {
    const invitations = new FakeInvitations([invitation()]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", role: "PARTICIPANT" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(res.status).toBe(403);
    expect(members.rows).toHaveLength(0);
  });

  it("joins an invited user with the team role the inviter chose", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "lead@example.com", teamRole: "LEAD" }),
    ]);
    const members = new FakeMembers([]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members, events });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", email: "lead@example.com", role: "PARTICIPANT" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(res.status).toBe(200);
    expect(members.rows[0]).toMatchObject({ teamId: "t1", userId: "u1", role: "LEAD" });
    expect(invitations.accepted).toEqual([
      { teamId: "t1", email: "lead@example.com", acceptedBy: "u1" },
    ]);
    expect(events.published.map((e) => e.type)).toEqual(["member.joined"]);
  });

  it("defaults to BUILDER for an invitation that carries no team role", async () => {
    // Legacy invitations (and non-participant invites) have no teamRole; they must
    // still be joinable rather than landing a member with role=undefined.
    const invitations = new FakeInvitations([invitation({ email: "old@example.com" })]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", email: "old@example.com", role: "PARTICIPANT" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(members.rows[0].role).toBe("BUILDER");
  });

  // ── Requirement (b) layer 2: a platform-wide role cannot join ─────────────

  it("403s an ADMIN, FACILITATOR or JUDGE, and writes no membership row", async () => {
    // A membership row is the ONLY thing that grants access to a team's
    // private content, so these three roles must be structurally unable to hold one. This
    // is the invite-code door.
    //
    // 403 here (not the invitation route's 400): the caller is not naming a wrong scope,
    // they are attempting an action their role may not perform at all.
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE"]) {
      // A REAL invitation for their address, so the refusal cannot be mistaken for the
      // pre-existing "you were not invited" 403 — everything else about this request is
      // legitimate, and only the role is disqualifying.
      const invitations = new FakeInvitations([
        invitation({ email: "staff@example.com", teamRole: "LEAD" }),
      ]);
      const members = new FakeMembers([]);
      const { app } = build({ invitations, members });

      const res = await app.request("/v1/teams/join", {
        method: "POST",
        headers: { ...asUser({ id: `u-${role}`, email: "staff@example.com", role }) },
        body: JSON.stringify({ inviteCode: "CODE1234" }),
      });

      expect(res.status, role).toBe(403);
      expect((await res.json()).error).toMatch(/platform-wide/i);
      expect(members.rows, role).toHaveLength(0);
    }
  });

  it("refuses BEFORE reading the store, so a refused caller cannot probe invite codes", async () => {
    // Ordering as a measured property. A repository that throws when touched proves the
    // gate runs first: a disqualified role must learn nothing about whether the code they
    // presented is real.
    const teams: TeamRepository = {
      setSeatCap: async () => true,
      getById: async () => null,
      getByInviteCode: async () => {
        throw new Error("the store must not be reached for a disqualified role");
      },
      listByWorkshop: async () => [],
      put: async (t) => t,
      listDirectory: async () => {
        throw new Error("the store must not be reached for a disqualified role");
      },
    };
    const members = new FakeMembers([]);
    const { app } = build({ teams: teams as unknown as FakeTeams, members });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(res.status).toBe(403);
    expect(members.rows).toHaveLength(0);
  });

  it("refuses a disqualified role EVEN IF they somehow already hold a membership row", async () => {
    // The rule is a property of the ROLE, so it must not become satisfiable by already
    // having the row it exists to prevent — otherwise one legacy row would be permanently
    // self-justifying, and the idempotent-join short-circuit would be the way to use it.
    // The migration audit found zero such rows; this refuses to help one grow.
    const members = new FakeMembers([
      { teamId: "t1", userId: "f1", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ members, events });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(res.status).toBe(403);
    expect(events.published).toHaveLength(0);
  });

  it("STILL LETS a PARTICIPANT and an EXECUTIVE join — the rule is narrow", async () => {
    // The half that must not break: these two ARE the team-scoped roles. If this ever
    // fails, nobody can join a team at all.
    for (const role of ["PARTICIPANT", "EXECUTIVE"]) {
      const invitations = new FakeInvitations([
        invitation({ email: "member@example.com", teamRole: "BUILDER" }),
      ]);
      const members = new FakeMembers([]);
      const { app } = build({ invitations, members });

      const res = await app.request("/v1/teams/join", {
        method: "POST",
        headers: { ...asUser({ id: `u-${role}`, email: "member@example.com", role }) },
        body: JSON.stringify({ inviteCode: "CODE1234" }),
      });

      expect(res.status, role).toBe(200);
      expect(members.rows, role).toHaveLength(1);
    }
  });

  it("is idempotent for an existing member and does not re-publish member.joined", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const events = new InMemoryPublisher();
    // No invitation row at all: an existing member must not be locked out of a
    // repeated join just because their invitation was cleaned up.
    const { app } = build({ members, events, invitations: new FakeInvitations([]) });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }) },
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    expect(res.status).toBe(200);
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].role).toBe("LEAD");
    expect(events.published).toHaveLength(0);
  });
});

// ─── THE REJOIN: a removed member must not put themselves back ───────────────

/**
 * THE REPORTED, VERIFIED-EXPLOITABLE BUG.
 *
 * Reproduced end to end against the deployed stack before this suite existed:
 *
 *   1. A FACILITATOR removed a PARTICIPANT from a team. Membership row deleted,
 *      MEMBER_REMOVED audited — both correct.
 *   2. The INVITATION ROW SURVIVED with `status: ACCEPTED`, `teamRole: BUILDER`.
 *   3. GET /invitations/mine still returned that team to the removed person, INCLUDING the
 *      team's live `inviteCode`.
 *   4. POST /teams/join checked only that an invitation row EXISTED (`if (!invitation)`) and
 *      never its STATUS.
 *   5. POST /teams/join with that code as that user: HTTP 200, membership re-created as
 *      BUILDER, and NOTHING recording the rejoin.
 *
 * An operator removes someone, the audit says removed, and the person puts themselves back.
 *
 * THE SAME HOLE WAS ALREADY CLOSED FOR REGISTRATION in cognito-presignup's `isAccepted` —
 * the reasoning transfers verbatim and is cited at the gate. These tests pin all three
 * halves of the fix (the join gate, the removal-driven revocation, the inviteCode
 * suppression) plus the fourth path the revocation opened up (the sign-in flip).
 *
 * THE MOST IMPORTANT TEST IN HERE IS NOT THE EXPLOIT ONE. It is "a legitimate FIRST join
 * still works": a gate that refuses everybody passes every exploit test and breaks
 * onboarding for every participant on the platform.
 */
describe("POST /v1/teams/join — a SPENT invitation admits nobody", () => {
  const join = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    inviteCode = "CODE1234"
  ) =>
    app.request("/v1/teams/join", {
      method: "POST",
      headers: { ...asUser(identity) },
      body: JSON.stringify({ inviteCode }),
    });

  it("REFUSES the reported scenario: a removed member re-presenting the real invite code", async () => {
    // THE EXACT STATE STEP 2 LEFT BEHIND: an ACCEPTED invitation and NO membership row.
    const invitations = new FakeInvitations([
      invitation({
        email: "removed@example.com",
        teamRole: "BUILDER",
        status: "ACCEPTED",
        acceptedAt: "2026-08-02T10:00:00.000Z",
      }),
    ]);
    const members = new FakeMembers([]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members, events });

    const res = await join(app, {
      id: "removed-sub",
      email: "removed@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(403);
    // THE ASSERTION THAT MATTERS: no membership row. A 403 with a row written would be the
    // same bug with a worse status code.
    expect(members.rows).toHaveLength(0);
    // No `member.joined` either — a consumer's membership read-model must not learn about a
    // join that was refused.
    expect(events.published).toHaveLength(0);
  });

  it("REFUSES a REVOKED invitation — the status the removal now writes", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "removed@example.com", status: "REVOKED" }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    const res = await join(app, {
      id: "removed-sub",
      email: "removed@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(403);
    expect(members.rows).toHaveLength(0);
  });

  it("matches the status case-INSENSITIVELY — the string crosses three bundles", async () => {
    // cognito-presignup and user-access each carry their own copy of these literals because
    // they bundle standalone. A casing difference must not be the thing that decides whether
    // a removed person can rejoin, which is why the predicate normalises.
    for (const status of ["accepted", "Accepted", " ACCEPTED ", "revoked", "Revoked"]) {
      const invitations = new FakeInvitations([
        invitation({ email: "removed@example.com", status }),
      ]);
      const members = new FakeMembers([]);
      const { app } = build({ invitations, members });

      const res = await join(app, {
        id: "removed-sub",
        email: "removed@example.com",
        role: "PARTICIPANT",
      });

      expect(res.status, status).toBe(403);
      expect(members.rows, status).toHaveLength(0);
    }
  });

  it("does NOT disclose which of the two refusals fired", async () => {
    // A distinct message per state would tell someone probing whether their address holds a
    // spent row or no row at all. Both answers are "this code does not admit you".
    const spent = build({
      invitations: new FakeInvitations([
        invitation({ email: "removed@example.com", status: "ACCEPTED" }),
      ]),
      members: new FakeMembers([]),
    });
    const absent = build({
      invitations: new FakeInvitations([]),
      members: new FakeMembers([]),
    });

    const spentRes = await join(spent.app, {
      id: "u1",
      email: "removed@example.com",
      role: "PARTICIPANT",
    });
    const absentRes = await join(absent.app, {
      id: "u1",
      email: "removed@example.com",
      role: "PARTICIPANT",
    });

    expect(spentRes.status).toBe(absentRes.status);
    // Neither body names the status, the team, or whether a row exists.
    const body = JSON.stringify(await spentRes.json());
    expect(body).not.toContain("ACCEPTED");
    expect(body).not.toContain("REVOKED");
  });

  // ── THE HALF THAT MUST NOT BREAK ──────────────────────────────────────────

  it("STILL ADMITS a legitimate FIRST join on a PENDING invitation", async () => {
    // THE MOST IMPORTANT TEST IN THIS FILE. A gate that refuses everyone passes every
    // exploit test above and breaks onboarding for every participant on the platform. This
    // is the normal path: an operator invites someone, they present the code once, they join.
    const invitations = new FakeInvitations([
      invitation({ email: "new@example.com", teamRole: "BUILDER", status: "PENDING" }),
    ]);
    const members = new FakeMembers([]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members, events });

    const res = await join(app, {
      id: "new-sub",
      email: "new@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]).toMatchObject({
      teamId: "t1",
      userId: "new-sub",
      role: "BUILDER",
    });
    expect(events.published.map((e) => e.type)).toEqual(["member.joined"]);
  });

  it("STILL ADMITS a join on a row whose status is ABSENT — legacy rows keep working", async () => {
    // The fail-OPEN-on-absence polarity, and it is the same deliberate asymmetry as
    // isExpired and as the pre-signup trigger's two predicates. Rows written before `status`
    // existed carry no attribute; treating those as spent would be a LOCKOUT, which is worse
    // than the leak. No backfill is needed precisely because this holds.
    const invitations = new FakeInvitations([
      // Cast because `status` is required on the type — the point is a row that predates it.
      invitation({ email: "legacy@example.com", status: undefined as unknown as string }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    const res = await join(app, {
      id: "legacy-sub",
      email: "legacy@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    expect(members.rows).toHaveLength(1);
  });

  it("STILL returns 200 for a CURRENT member whose row is ACCEPTED — the idempotent re-join", async () => {
    // WHY THE GATE SITS AFTER THE MEMBERSHIP SHORT-CIRCUIT. Every returning member's row is
    // ACCEPTED by definition, and the portal calls join from the workshop page — so putting
    // the status check first would 403 every existing member trying to re-enter their own
    // team. They already have the access; nothing is being granted.
    const invitations = new FakeInvitations([
      invitation({ email: "member@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      {
        teamId: "t1",
        userId: "member-sub",
        role: "LEAD",
        joinedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members, events });

    const res = await join(app, {
      id: "member-sub",
      email: "member@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    // Unchanged: no second row, and joinedAt is not re-stamped.
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].joinedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(events.published).toHaveLength(0);
  });

  it("ADMITS a removed person again once an operator issues a FRESH invitation", async () => {
    // RE-ADMISSION IS AN EXPLICIT ACT, and this is what makes the gate a gate rather than a
    // permanent ban. A new invitation overwrites the (teamId, email) row with a PENDING one,
    // which is exactly what POST /teams/:teamId/invitations writes.
    const invitations = new FakeInvitations([
      invitation({ email: "readmitted@example.com", status: "REVOKED" }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({
      invitations,
      members,
      workshops: new FakeWorkshops(true),
    });

    // Refused while the row is REVOKED.
    const before = await join(app, {
      id: "readmitted-sub",
      email: "readmitted@example.com",
      role: "PARTICIPANT",
    });
    expect(before.status).toBe(403);

    // An operator with grant authority re-invites them through the real route.
    const reinvite = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: {
        ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        emails: ["readmitted@example.com"],
        platformRole: "PARTICIPANT",
        teamRole: "BUILDER",
      }),
    });
    expect(reinvite.status).toBe(201);

    // And now the join succeeds.
    const after = await join(app, {
      id: "readmitted-sub",
      email: "readmitted@example.com",
      role: "PARTICIPANT",
    });
    expect(after.status).toBe(200);
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]).toMatchObject({ userId: "readmitted-sub", role: "BUILDER" });
  });
});

// ─── GET /v1/teams/:teamId/access ───────────────────────────────────────────

describe("GET /v1/teams/:teamId/access", () => {
  /**
   * ── THE CONTRACT FIVE SERVICES READ, ASSERTED IN FULL ──
   *
   * This answers FOUR booleans, and every case below asserts ALL FOUR with
   * toEqual rather than toMatchObject. That is deliberate: a missing field reads as `false`
   * at every consumer (`!!undefined`), so a partial assertion would pass against a response
   * that silently denies every member on every content surface. Exact-shape equality is the
   * only assertion that catches a dropped field.
   *
   *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
   *                                    workshop, or ADMIN. UNCHANGED.
   *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
   */
  it("reports all four for a member with a write role", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ members });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    // A member passes BOTH predicates — which is the case that must keep working, and the
    // one that breaks if the consumers are deployed before Team.
    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: true,
      canWriteContent: true,
    });
  });

  it("reports read WITHOUT write for an EXECUTIVE member, on BOTH pairs", async () => {
    // This probe is what all five consumers' HttpTeamAccess reads, so the read/write
    // asymmetry has to survive the JSON boundary, not just the in-process guard. A
    // `canWrite: true` (or `canWriteContent: true`) here would hand a read-only role write
    // access in five services.
    const members = new FakeMembers([
      { teamId: "t1", userId: "exec", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ members });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "exec", email: "e@b.c", role: "EXECUTIVE" }),
    });

    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: false,
      canReadContent: true,
      canWriteContent: false,
    });
  });

  it("reports none of the four for an outsider", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "outsider", email: "o@b.c", role: "PARTICIPANT" }),
    });
    expect(await res.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  it("reports ADMINISTRATION wide but CONTENT closed for a non-member ADMIN", async () => {
    // ── THE PREDICATE SPLIT, AT THE WIRE ──
    //
    // Before this change the response was `{canRead: true, canWrite: true}` and that was
    // the WHOLE answer, so every consumer granted an admin the team's board, chat, AI
    // threads and code. The administration pair still gates the roster, member removal and
    // invitations; the content pair is what the member-only change closed.
    //
    // ⚠ THE ADMINISTRATION PAIR IS NOW OWNERSHIP-SCOPED TOO, so this admin needs
    // to OWN t1's experience to get `canRead: true` — hence `FakeWorkshops(true)`, which this
    // test did not need when ADMIN short-circuited unconditionally. The non-owner case is the
    // new test immediately below. The split this test is about is unchanged: administration
    // open, content closed, for the same caller in one response.
    const { app } = build({ members: new FakeMembers([]), workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  it("reports EVERYTHING CLOSED for an ADMIN who does not own the experience", async () => {
    // The other half of the admin-scoping change, and the one with no precedent in this file: an
    // admin outside the experience is not merely denied its CONTENT but its
    // ADMINISTRATION as well — no roster, no member removal, no invitations. All four flags
    // false, which is the same answer an unrelated participant gets.
    const { app } = build({ members: new FakeMembers([]), workshops: new FakeWorkshops(false) });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(await res.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  it("reports the same split for a FACILITATOR who owns the workshop", async () => {
    const { app } = build({
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "fac", email: "f@b.c", role: "FACILITATOR" }),
    });

    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  it("reports nothing for a JUDGE, on both pairs", async () => {
    // Judging is untouched by the member-only change: canRead already returned false for a JUDGE on
    // every team, so this row of the matrix is identical before and after.
    const { app } = build({
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "judge", email: "j@b.c", role: "JUDGE" }),
    });

    expect(await res.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  /**
   * ── A REMOVED (INACTIVE) MEMBER GETS NOTHING FROM THE PROBE FIVE SERVICES READ ──
   *
   * THE SINGLE MOST IMPORTANT ASSERTION OF THE REACTIVATION CHANGE. Removal used to hard-delete
   * the row; it now keeps it as INACTIVE so the removal can be reversed. `/access` is the ONE
   * question collaboration, ai, source, evaluation and workshop ask about a team, so if a
   * deactivated row answered `true` here, a removed person would keep the board, the chat, the
   * AI threads, the commits and the phase notes in FIVE services at once — from one wrong
   * boolean, with no other test on the platform noticing.
   *
   * It answers false because `members.get()` returns NULL for an inactive row and every
   * predicate behind this route already treats null as "not a member". There is no status check
   * in this route, in authz.ts, or in any consumer — that is the design, and this is what pins
   * it. All four booleans with `toEqual`, exact shape: a dropped field reads as `false` at every
   * consumer, so only exact-shape equality catches the inverse mistake.
   */
  it("reports NONE of the four for a REMOVED member — via get() answering null", async () => {
    const members = new FakeMembers([
      {
        teamId: "t1",
        userId: "u1",
        role: "BUILDER",
        joinedAt: "2026-01-01T00:00:00.000Z",
        status: "INACTIVE",
        removedAt: "2026-08-04T10:00:00.000Z",
        removedBy: "fac",
        removedByRole: "FACILITATOR",
      },
    ]);
    const { app } = build({ members });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    // Byte-for-byte the outsider's answer — the row may as well not exist.
    expect(await res.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
    });
    // And the row is still THERE. This is what distinguishes the assertion from the old hard
    // delete: access is denied while the history survives, which is the entire point.
    expect(members.rows).toHaveLength(1);
  });

  it("reports all four AGAIN once the member is REACTIVATED", async () => {
    // The reverse direction, through the same probe: reactivation is what RESTORES access, so
    // the flip has to be visible at the contract the five consumers read. Asserted as a
    // SEQUENCE on one repository so it cannot pass by testing two unrelated fixtures.
    const members = new FakeMembers([
      {
        teamId: "t1",
        userId: "u1",
        role: "BUILDER",
        joinedAt: "2026-01-01T00:00:00.000Z",
        status: "INACTIVE",
        removedAt: "2026-08-04T10:00:00.000Z",
        removedBy: "fac",
        removedByRole: "FACILITATOR",
      },
    ]);
    const { app } = build({ members });
    const probe = async () => {
      const res = await app.request("/v1/teams/t1/access", {
        headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
      });
      return res.json();
    };

    expect(await probe()).toMatchObject({ canReadContent: false });

    await members.reactivate("t1", "u1", "admin");

    expect(await probe()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: true,
      canWriteContent: true,
    });
  });

  it("requires authentication", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/t1/access");
    expect(res.status).toBe(401);
  });

  // ── `?withWorkshop=1` ──────────────────────────────────────
  //
  // WHY THIS ROUTE CARRIES THE WORKSHOP. `Submission.workshopId` was `body.workshopId ||
  // null`, so the CALLER wrote the field the Evaluation service's new judge-scoping guard
  // rests on — a client-supplied scoping value, and a scope a participant can name is not a
  // scope. Only this context can derive it (`Team.workshopId` is the teams table's PARTITION
  // KEY), and the answer travels on the probe Evaluation ALREADY makes so that
  // scoping the write costs no new hop.
  //
  // THE FOUR-BOOLEAN SHAPE MUST STAY BYTE-IDENTICAL WITHOUT THE PARAMETER. Five services
  // read this response and a dozen assertions above use exact-shape `toEqual`; the opt-in is
  // what makes this change inert for the four consumers that have no use for the workshop.

  it("omits workshopId ENTIRELY unless asked — the shape five services read is untouched", async () => {
    // Exact-shape equality, so an unconditional field would fail here. That is the point:
    // the four-boolean contract is what collaboration, ai, source and workshop parse.
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({
      members,
      teams: new FakeTeams([team({ id: "t1", workshopId: "w-real" })]),
    });

    const res = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: true,
      canWriteContent: true,
    });
  });

  it("returns the team's workshop when asked, alongside the unchanged four", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({
      members,
      teams: new FakeTeams([team({ id: "t1", workshopId: "w-real" })]),
    });

    const res = await app.request("/v1/teams/t1/access?withWorkshop=1", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: true,
      canWriteContent: true,
      workshopId: "w-real",
    });
  });

  it("returns workshopId NULL — and the key PRESENT — for a caller who may not read the team", async () => {
    // §G(a): returned only when `canRead` is true. A caller refused the team has no business
    // learning which workshop it belongs to.
    //
    // THE KEY MUST STILL BE PRESENT, and that is the load-bearing half. The consumer
    // distinguishes ABSENT ("this Team is too old to answer" → 503) from NULL ("no such
    // team" → 404), and it does so with an `in` check. Omitting the key here would make a
    // refused caller indistinguishable from an old deploy.
    const { app } = build({
      members: new FakeMembers([]),
      teams: new FakeTeams([team({ id: "t1", workshopId: "w-real" })]),
    });

    const res = await app.request("/v1/teams/t1/access?withWorkshop=1", {
      headers: asUser({ id: "outsider", email: "o@b.c", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
      workshopId: null,
    });
    expect("workshopId" in body).toBe(true);
  });

  it("returns workshopId NULL — key present — for a teamId that does not exist", async () => {
    // An ADMIN passes canRead for any team, so the lookup happens and returns nothing. The
    // consumer answers 404 rather than storing a null scope.
    const { app } = build({ members: new FakeMembers([]), teams: new FakeTeams([]), workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t-ghost/access?withWorkshop=1", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.canRead).toBe(true);
    expect(body.workshopId).toBeNull();
    expect("workshopId" in body).toBe(true);
  });

  it("does NOT read the teams table unless the parameter is present", async () => {
    // The reason it is opt-in: this probe is made on almost every route five services serve,
    // and resolving the workshop is one more store read. Asserted on the store, because a
    // response-shape assertion cannot see a wasted Query.
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const teams = new FakeTeams([team({ id: "t1", workshopId: "w-real" })]);
    let getByIdCalls = 0;
    const originalGetById = teams.getById.bind(teams);
    teams.getById = async (id: string) => {
      getByIdCalls += 1;
      return originalGetById(id);
    };
    const { app } = build({ members, teams });

    await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });
    expect(getByIdCalls).toBe(0);

    await app.request("/v1/teams/t1/access?withWorkshop=1", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });
    expect(getByIdCalls).toBe(1);
  });

  it("ignores any value other than exactly `1`", async () => {
    // Same idiom as `?withMembers=1` and `?withCounts=1` elsewhere in this file: an exact
    // match, so `withWorkshop=true` or `withWorkshop=0` does not half-enable it.
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({
      members,
      teams: new FakeTeams([team({ id: "t1", workshopId: "w-real" })]),
    });

    for (const value of ["0", "true", "yes", ""]) {
      const res = await app.request(`/v1/teams/t1/access?withWorkshop=${value}`, {
        headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
      });
      expect("workshopId" in ((await res.json()) as object)).toBe(false);
    }
  });

  it("does not let a REMOVED member learn the workshop either", async () => {
    // The inactive-row rule reaches this field too, because it is gated on the same
    // `canRead` that `members.get()` answers null for. A removed person gets the outsider's
    // answer on all five fields.
    const members = new FakeMembers([
      {
        teamId: "t1",
        userId: "u1",
        role: "BUILDER",
        joinedAt: "2026-01-01T00:00:00.000Z",
        status: "INACTIVE",
        removedAt: "2026-08-04T10:00:00.000Z",
        removedBy: "fac",
        removedByRole: "FACILITATOR",
      },
    ]);
    const { app } = build({
      members,
      teams: new FakeTeams([team({ id: "t1", workshopId: "w-real" })]),
    });

    const res = await app.request("/v1/teams/t1/access?withWorkshop=1", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
      workshopId: null,
    });
  });
});

// ─── There is NO admin content route, and that is asserted ──────────────────
//
// An audited ADMIN break-glass route (POST /v1/teams/:teamId/content-access) was built and
// then REMOVED — investigation is an EXECUTIVE's job, and an executive
// who is a MEMBER of the team is already the right instrument. Its tests went
// with it.
//
// This block is what remains: proof the route is GONE rather than merely untested. Without
// it, re-adding an ambient admin content path would break no test in this service, and the
// `/access` suite above would keep passing because it asks a different question.

describe("POST /v1/teams/:teamId/content-access — REMOVED, and stays removed", () => {
  it("404s for an ADMIN with a perfectly-formed break-glass request", async () => {
    // Addressed exactly as the removed route wanted it — ADMIN token, reason in the body —
    // so a 404 can only mean the route does not exist. A 403 would mean it came back with a
    // stricter gate; a 200 would mean ambient admin content access is back.
    const audit = new FakeAudit();
    const { app } = build({ audit, teams: new FakeTeams([team({ id: "t1", name: "5 Stars" })]) });

    const res = await app.request("/v1/teams/t1/content-access", {
      method: "POST",
      headers: {
        ...asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "abuse report #4412" }),
    });

    expect(res.status).toBe(404);
    // And nothing was recorded, because nothing happened. TEAM_CONTENT_ACCESSED is no longer
    // a writable action at all — the union in domain.ts no longer contains it.
    expect(audit.entries).toHaveLength(0);
  });

  it("leaves an EXECUTIVE MEMBER as the investigation path, over the SAME team", async () => {
    // The replacement, asserted end-to-end through the probe five services read rather than
    // in the predicate alone: read yes, write no, scoped to the one team they belong to.
    // If this ever returns canReadContent: false, removing break-glass left the platform with
    // no investigation path at all, and that is the failure this test exists to name.
    const members = new FakeMembers([
      { teamId: "t1", userId: "exec", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ members });

    const mine = await app.request("/v1/teams/t1/access", {
      headers: asUser({ id: "exec", email: "e@example.com", role: "EXECUTIVE" }),
    });
    expect(await mine.json()).toEqual({
      canRead: true,
      canWrite: false,
      canReadContent: true,
      canWriteContent: false,
    });

    // ── AND IT IS SCOPED BY MEMBERSHIP, NOT BY ROLE ──
    //
    // The property that makes this narrower than break-glass was: the same executive gets
    // nothing on a team they are not a member of. A role-scoped grant would answer `true`
    // here and would be an ambient platform-wide power wearing a different name.
    const other = await app.request("/v1/teams/t2/access", {
      headers: asUser({ id: "exec", email: "e@example.com", role: "EXECUTIVE" }),
    });
    expect(await other.json()).toEqual({
      canRead: false,
      canWrite: false,
      canReadContent: false,
      canWriteContent: false,
    });
  });
});

// ─── Which routes are anonymous, and which are not ──────────────────────────
//
// Every route in this service sits behind a blanket requireAuth middleware, with ONE
// exception listed in PUBLIC_PATHS. That exception is the whole reason this block
// exists: a reader auditing "is everything authenticated?" should find the answer
// asserted, not inferred from middleware registration order — and adding a route above
// or below that middleware must not be able to change it silently.

describe("anonymous reachability", () => {
  /** Routes that MUST 401 without credentials. */
  const authenticated = [
    "/v1/teams/mine",
    "/v1/workshops/w1/teams",
    "/v1/workshops/w1/membership",
    "/v1/teams/t1/members",
    "/v1/teams/t1/access",
    "/v1/teams/t1/invitations",
    "/v1/invitations/mine",
    // The first-sign-in accept. Its whole safety story is "it can only reach the
    // CALLER's own rows, because the address comes from the verified token" — which is
    // only true if there IS a verified token. An anonymous POST reaching the handler
    // would resolve to no email and no rows today, but asserting the 401 is what stops
    // a later change making the email readable from somewhere else.
    "/v1/invitations/mine/accept",
    // The two internal lookups. Both are deliberately UNMAPPED in the gateway, so
    // they are not reachable from the internet today — this asserts they are not
    // anonymous EITHER, so mapping one later cannot turn it into an open
    // email-probing endpoint by omission. Defence in depth, not the primary control.
    "/v1/invitations/lookup?inviteCode=CODE1234&email=a@b.c",
    "/v1/invitations/lookup-by-email?email=a@b.c",
    "/v1/directory/user-ids?teamId=t1",
    "/v1/directory/invited-by?emails=a@b.c",
  ];

  it.each(authenticated)("401s %s without credentials", async (path) => {
    const { app } = build();
    const res = await app.request(path);
    expect(res.status).toBe(401);
  });

  it("leaves lookup-by-token anonymous ON PURPOSE — the token IS the credential", async () => {
    // The one exception, and it is correct: the visitor has no account yet (that is
    // what the emailed link is for), so there is no token to present and requiring one
    // would make the route unusable. The 256-bit invite token in the query is the
    // credential — the route answers only someone already holding it, discloses only
    // the invitation that token names, and 404s otherwise. Unlike its lookup-by-email
    // sibling it cannot be used to probe whether an address was invited, which is why
    // it is the only one of the three safe to map in the gateway.
    const { app } = build();
    const res = await app.request("/v1/invitations/lookup-by-token?token=not-a-real-token");

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("keys the public exemption on the resolved PATH, not on registration order", async () => {
    // PUBLIC_PATHS is matched against the request's pathname, so a route registered
    // after the middleware cannot inherit the exemption by accident, and a near-miss
    // path does not get it either.
    const { app } = build();
    for (const path of [
      "/v1/invitations/lookup-by-token/extra",
      "/v1/invitations/lookup-by-tokens?token=x",
    ]) {
      const res = await app.request(path);
      expect(res.status).not.toBe(200);
    }
  });
});

/**
 * ── ⚠ THE SAME MATRIX ON THE OTHER TWO DIRECTORY ANSWERS ──────────────────────────
 *
 * Three team-service routes answered the same class of question about caller-supplied identifiers
 * while gating only on the coarse `canReadDirectory`, with no per-row visibility filter. The
 * `lookup-by-email` block below covers the sharpest one; these cover its two siblings.
 */
describe("GET /v1/invitations/lookup — the visibility matrix", () => {
  const lookup = (app: ReturnType<typeof build>["app"], role: string) =>
    app.request("/v1/invitations/lookup?inviteCode=CODE1234&email=boss@example.com", {
      headers: asUser({ id: "caller", email: "c@example.com", role }),
    });

  it("⚠ WITHHOLDS an ADMIN row from a FACILITATOR — and its teamId and workshopId with it", async () => {
    // This route returned platformRole, teamId AND workshopId for any (code, email) pair, including
    // teams and experiences the caller does not own.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "boss@example.com", platformRole: "ADMIN" }),
    ]);
    const { app } = build({ invitations, teams: new FakeTeams([team()]) });

    const res = await lookup(app, "FACILITATOR");

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("ADMIN");
    // The workshop id must not leak either — it is half of the cross-tenant mapping.
    expect(body).not.toContain("w1");
    expect(JSON.parse(body)).toEqual({ error: "No matching invitation" });
  });

  it("still answers a FACILITATOR for a role it may see", async () => {
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "boss@example.com", platformRole: "JUDGE" }),
    ]);
    const { app } = build({ invitations, teams: new FakeTeams([team()]) });

    const res = await lookup(app, "FACILITATOR");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ platformRole: "JUDGE" });
  });

  it("an ADMIN still sees an ADMIN row", async () => {
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "boss@example.com", platformRole: "ADMIN" }),
    ]);
    const { app } = build({ invitations, teams: new FakeTeams([team()]) });

    expect((await lookup(app, "ADMIN")).status).toBe(200);
  });

  it("treats a legacy row with no platformRole as PARTICIPANT, and still answers", async () => {
    // The default the rest of the service applies. A legacy row must not become invisible.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "boss@example.com", platformRole: undefined }),
    ]);
    const { app } = build({ invitations, teams: new FakeTeams([team()]) });

    const res = await lookup(app, "FACILITATOR");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ platformRole: "PARTICIPANT" });
  });
});

describe("GET /v1/directory/invited-by — the visibility matrix", () => {
  const invitedBy = (app: ReturnType<typeof build>["app"], role: string, emails: string) =>
    app.request(`/v1/directory/invited-by?emails=${encodeURIComponent(emails)}`, {
      headers: asUser({ id: "caller", email: "c@example.com", role }),
    });

  it("⚠ OMITS an ADMIN address from a FACILITATOR's answer, as if it had no invitation", async () => {
    /**
     * This route takes up to 100 arbitrary addresses per call and returned inviter provenance for
     * every one of them. OMITTED rather than nulled: an absent key already means "we have no record"
     * everywhere else in this API, so a withheld row is indistinguishable from an unknown one.
     */
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "boss@example.com",
        platformRole: "ADMIN",
        invitedBy: "the-other-admin",
        sentAt: "2026-08-01T00:00:00.000Z",
      }),
      invitation({
        teamId: "t1",
        email: "player@example.com",
        platformRole: "PARTICIPANT",
        invitedBy: "fac-1",
        sentAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await invitedBy(app, "FACILITATOR", "boss@example.com,player@example.com");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { invitedBy: Record<string, unknown> };
    // The visible address still resolves — the route is scoped, not disabled.
    expect(body.invitedBy).toHaveProperty("player@example.com");
    expect(body.invitedBy).not.toHaveProperty("boss@example.com");
    // And the admin's correlatable id is nowhere on the response.
    expect(JSON.stringify(body)).not.toContain("the-other-admin");
  });

  it("an ADMIN still resolves every address", async () => {
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "boss@example.com",
        platformRole: "ADMIN",
        invitedBy: "the-other-admin",
        sentAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await invitedBy(app, "ADMIN", "boss@example.com");

    const body = (await res.json()) as { invitedBy: Record<string, { inviterId: string }> };
    expect(body.invitedBy["boss@example.com"].inviterId).toBe("the-other-admin");
  });
});

// ─── GET /v1/invitations/lookup-by-email (the signup gate) ──────────────────

describe("GET /v1/invitations/lookup-by-email", () => {
  it("400s without an email", async () => {
    const { app } = build();
    const res = await app.request("/v1/invitations/lookup-by-email", {
      headers: asUser({ id: "svc", role: "ADMIN" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s an un-invited address", async () => {
    const { app } = build();
    const res = await app.request(
      "/v1/invitations/lookup-by-email?email=nobody@example.com",
      { headers: asUser({ id: "svc", role: "ADMIN" }) }
    );
    expect(res.status).toBe(404);
  });

  it("404s when every invitation for the email has LAPSED", async () => {
    // The 24h expiry is only unbypassable because it is enforced HERE, on the
    // invitation row, and not just on the /join page: a recipient who skips the
    // emailed link and goes straight to the Hosted UI still hits this gate.
    const invitations = new FakeInvitations([
      invitation({ email: "late@example.com", expiresAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/invitations/lookup-by-email?email=late@example.com",
      { headers: asUser({ id: "svc", role: "ADMIN" }) }
    );

    // Same 404 as "never invited" — the caller must learn nothing about addresses
    // it doesn't already control.
    expect(res.status).toBe(404);
  });

  it("still admits an invitation with NO expiresAt (pre-dates the field)", async () => {
    const invitations = new FakeInvitations([invitation({ email: "legacy@example.com" })]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/invitations/lookup-by-email?email=legacy@example.com",
      { headers: asUser({ id: "svc", role: "ADMIN" }) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: "legacy@example.com",
      platformRole: "PARTICIPANT",
    });
  });

  it("collapses several invitations to the HIGHEST-privilege platform role", async () => {
    // An email invited to several teams must not end up under-privileged just
    // because of row ordering — this feeds the Cognito group assignment.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "multi@example.com", platformRole: "PARTICIPANT" }),
      invitation({ teamId: "t2", email: "multi@example.com", platformRole: "FACILITATOR" }),
      invitation({ teamId: "t3", email: "multi@example.com", platformRole: "JUDGE" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/invitations/lookup-by-email?email=multi@example.com",
      { headers: asUser({ id: "svc", role: "ADMIN" }) }
    );

    expect(await res.json()).toMatchObject({ platformRole: "FACILITATOR" });
  });

  it("picks ADMIN over everything, whatever the row order", async () => {
    for (const order of [
      ["ADMIN", "PARTICIPANT"],
      ["PARTICIPANT", "ADMIN"],
    ]) {
      const invitations = new FakeInvitations(
        order.map((platformRole, i) =>
          invitation({ teamId: `t${i}`, email: "boss@example.com", platformRole })
        )
      );
      const { app } = build({ invitations });
      const res = await app.request(
        "/v1/invitations/lookup-by-email?email=boss@example.com",
        { headers: asUser({ id: "svc", role: "ADMIN" }) }
      );
      expect(await res.json()).toMatchObject({ platformRole: "ADMIN" });
    }
  });

  it("does not let an UNRECOGNISED platformRole outrank a real one", async () => {
    // rank() maps anything off the precedence list to the end, so a typo'd or
    // future role can never be treated as more privileged than PARTICIPANT.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "odd@example.com", platformRole: "SUPER_ADMIN" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/invitations/lookup-by-email?email=odd@example.com",
      { headers: asUser({ id: "svc", role: "ADMIN" }) }
    );

    expect(await res.json()).toMatchObject({ platformRole: "PARTICIPANT" });
  });

  it("lower-cases the queried email before matching", async () => {
    const invitations = new FakeInvitations([invitation({ email: "mixed@example.com" })]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/invitations/lookup-by-email?email=MiXeD@Example.com",
      { headers: asUser({ id: "svc", role: "ADMIN" }) }
    );

    expect(res.status).toBe(200);
  });

  /**
   * ── ⚠ THE VISIBILITY MATRIX, NOT JUST THE DIRECTORY GATE ──────────────────────────
   *
   * `canReadDirectory` answers "may you resolve invitations at all" ({ADMIN, FACILITATOR}). It does
   * NOT answer "may you learn that THIS address holds ADMIN" — and this route, keyed on EMAIL ALONE
   * with no invite code, answered the second question with the first one's gate. Its own comment calls
   * it "an email-to-privilege enumeration oracle".
   *
   * `USER_VISIBILITY_GRANTS` is the platform's stated rule: a FACILITATOR sees every role except
   * ADMIN, because "a facilitator has no business enumerating who holds full platform access …
   * knowing WHICH accounts are the valuable ones to phish or socially engineer is itself the
   * reconnaissance step". The identity service enforces it per row; these team routes did not.
   */
  describe("the platform's own user-visibility matrix", () => {
    const lookup = (app: ReturnType<typeof build>["app"], role: string) =>
      app.request("/v1/invitations/lookup-by-email?email=boss@example.com", {
        headers: asUser({ id: "caller", email: "c@example.com", role }),
      });

    it("⚠ WITHHOLDS an ADMIN grant from a FACILITATOR, with the SAME 404 as an unknown address", async () => {
      // The 404 shape is the assertion, not just the refusal: a distinct 403 would confirm the row
      // exists and is merely hidden, which is most of the fact being withheld.
      const invitations = new FakeInvitations([
        invitation({ teamId: "t1", email: "boss@example.com", platformRole: "ADMIN" }),
      ]);
      const { app } = build({ invitations });

      const res = await lookup(app, "FACILITATOR");

      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("ADMIN");
      // Byte-for-byte the un-invited answer, so the two are indistinguishable.
      expect(JSON.parse(body)).toEqual({ error: "No matching invitation" });
    });

    it("still answers a FACILITATOR about the roles it MAY see", async () => {
      // NOT VACUOUS: without this the refusal above would pass on a route that 404'd everything,
      // which would break the directory rather than scope it.
      for (const visible of ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
        const invitations = new FakeInvitations([
          invitation({ teamId: "t1", email: "boss@example.com", platformRole: visible }),
        ]);
        const { app } = build({ invitations });

        const res = await lookup(app, "FACILITATOR");

        expect(res.status, visible).toBe(200);
        expect(await res.json(), visible).toMatchObject({ platformRole: visible });
      }
    });

    it("an ADMIN still sees every role, including other ADMINs", async () => {
      const invitations = new FakeInvitations([
        invitation({ teamId: "t1", email: "boss@example.com", platformRole: "ADMIN" }),
      ]);
      const { app } = build({ invitations });

      const res = await lookup(app, "ADMIN");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ platformRole: "ADMIN" });
    });

    it("⚠ applies to the COLLAPSED role, not to any single row", async () => {
      /**
       * The route reduces every live invitation for an address to its highest-privilege role, and
       * THAT is the fact being disclosed. Checking a single row would leak the admin grant of an
       * address that also holds a visible one — which is the common case for a real admin, since they
       * were probably invited to a team as well.
       */
      const invitations = new FakeInvitations([
        invitation({ teamId: "t1", email: "boss@example.com", platformRole: "PARTICIPANT" }),
        invitation({ teamId: "t2", email: "boss@example.com", platformRole: "ADMIN" }),
      ]);
      const { app } = build({ invitations });

      expect((await lookup(app, "FACILITATOR")).status).toBe(404);
      // The admin sees the collapsed answer, which proves the fixture really does hold both.
      expect(await (await lookup(app, "ADMIN")).json()).toMatchObject({ platformRole: "ADMIN" });
    });

    it("fails CLOSED on an unrecognised caller role", async () => {
      // `canSeeUser` reads its row from the matrix and an unknown role has none, so it grants
      // nothing. Belt-and-braces: `canReadDirectory` already refuses such a caller.
      const invitations = new FakeInvitations([
        invitation({ teamId: "t1", email: "boss@example.com", platformRole: "PARTICIPANT" }),
      ]);
      const { app } = build({ invitations });

      const res = await lookup(app, "SUPER_ADMIN");

      expect(res.status).toBe(403);
    });
  });
});

// ─── GET /v1/invitations/lookup-by-token (unauthenticated by design) ────────

describe("GET /v1/invitations/lookup-by-token", () => {
  it("is reachable WITHOUT any credential — the token IS the credential", async () => {
    // The visitor has no account yet (that's the point of the link), so requiring a
    // caller identity would make the route unusable. If this route ever falls under
    // edgeIdentityMiddleware, every invite link 401s.
    const { token, tokenHash } = { token: "raw-token", tokenHash: hashInviteToken("raw-token") };
    const invitations = new FakeInvitations([
      invitation({ tokenHash, expiresAt: inviteExpiry() }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      `/v1/invitations/lookup-by-token?token=${encodeURIComponent(token)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      email: "invitee@example.com",
      teamId: "t1",
      teamName: "Team One",
      platformRole: "PARTICIPANT",
    });
    // ⚠ AND NO `inviteCode`, ASSERTED RATHER THAN JUST NOT EXPECTED. It used to be here, and it
    // is the team's live join credential on an UNAUTHENTICATED route — see the route comment.
    // toMatchObject ignores extra keys, so dropping the expectation would not have noticed its
    // return; `not.toHaveProperty` does.
    expect(body).not.toHaveProperty("inviteCode");
  });

  it("400s without a token", async () => {
    const { app } = build();
    expect((await app.request("/v1/invitations/lookup-by-token")).status).toBe(400);
  });

  it("404s a wrong token rather than revealing anything", async () => {
    const invitations = new FakeInvitations([
      invitation({ tokenHash: hashInviteToken("the-real-token"), expiresAt: inviteExpiry() }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/lookup-by-token?token=guessed");
    expect(res.status).toBe(404);
  });

  it("matches on the token's HASH, not the stored value (raw tokens are never stored)", async () => {
    // Presenting the stored digest instead of the raw token must NOT work — the
    // route hashes its input, so a table dump yields nothing redeemable.
    const raw = "the-real-token";
    const digest = hashInviteToken(raw);
    const invitations = new FakeInvitations([
      invitation({ tokenHash: digest, expiresAt: inviteExpiry() }),
    ]);
    const { app } = build({ invitations });

    expect((await app.request(`/v1/invitations/lookup-by-token?token=${digest}`)).status).toBe(
      404
    );
    expect((await app.request(`/v1/invitations/lookup-by-token?token=${raw}`)).status).toBe(200);
  });

  it("answers a LAPSED link with 410 + INVITE_EXPIRED, not 404", async () => {
    // Deliberately distinct from a bad token: the visitor demonstrably held a real
    // invite, so the /join page must be able to say "this expired, ask for another"
    // instead of "not found". Machine-readable code so the page can branch.
    const invitations = new FakeInvitations([
      invitation({
        tokenHash: hashInviteToken("stale"),
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/lookup-by-token?token=stale");
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "INVITE_EXPIRED" });
  });

  it("survives a dangling teamId (team deleted after inviting)", async () => {
    // A deleted team must not 500 the /join page — teamName goes null.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "gone",
        tokenHash: hashInviteToken("orphan"),
        expiresAt: inviteExpiry(),
      }),
    ]);
    const { app } = build({ invitations, teams: new FakeTeams([]) });

    const res = await app.request("/v1/invitations/lookup-by-token?token=orphan");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ teamName: null });
    expect(body).not.toHaveProperty("inviteCode");
  });

  /**
   * ── ⚠ SPENT ROWS ANSWER WITH THEIR STATUS AND NOTHING ELSE ──────────────────────────────
   *
   * FOUND IN A SECURITY REVIEW (Medium): the unauthenticated invite-token lookup returned a
   * team's live join code, the invitee's email and platform role for REVOKED and ACCEPTED
   * invitations. Only expiry was checked; status was reported back rather than acted on.
   *
   * Revoked and accepted rows are kept forever on purpose (provenance), so a removed member's
   * original invite email kept resolving — and kept handing out the team's CURRENT join code,
   * another person's address and their platform role, to a caller with no session.
   */
  it("REVEALS NOTHING but the status for an ACCEPTED invitation", async () => {
    const invitations = new FakeInvitations([
      invitation({
        status: "ACCEPTED",
        tokenHash: hashInviteToken("spent"),
        expiresAt: inviteExpiry(),
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/lookup-by-token?token=spent");

    // 200 with the status alone, because the /join page's ACCEPTED branch redirects to /login
    // and reads only this field. A 410 here would have shown "this invitation has expired" to
    // somebody who simply already has an account.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ACCEPTED" });
  });

  it("410s for a REVOKED invitation, disclosing nothing", async () => {
    const invitations = new FakeInvitations([
      invitation({
        status: "REVOKED",
        tokenHash: hashInviteToken("revoked"),
        expiresAt: inviteExpiry(),
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/lookup-by-token?token=revoked");

    // The page has no REVOKED branch and would otherwise fall through to a sign-up form with
    // an undefined email, so this reuses the dead end it already renders for a 410.
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: "This invitation is no longer valid", code: "INVITE_REVOKED" });
    for (const leaked of ["email", "inviteCode", "platformRole", "teamRole", "teamId", "teamName"]) {
      expect(body).not.toHaveProperty(leaked);
    }
  });
});

// ─── POST /v1/teams/:teamId/invitations ─────────────────────────────────────

/**
 * ── ⚠ GATE 6: THE EXISTING ROW IS AUTHORIZED AGAINST BEFORE IT IS REPLACED ──────────
 *
 * `deps.invitations.put` is an unconditional Put on key (teamId, email) and nothing upstream read the
 * row it was about to replace. So an invitation for an address that already had one was SILENTLY
 * OVERWRITTEN: new tokenHash, status back to PENDING, `invitedBy` reset to the caller,
 * platformRole/workshopId replaced, acceptedAt/acceptedBy/revokedAt/revokedBy destroyed.
 *
 * ⚠ BOTH CHECKS THE SIBLING DELETE CALLS LOAD-BEARING WERE BYPASSABLE HERE. That route validates
 * `canGrantRole` against the STORED role ("an EXECUTIVE who could delete an ADMIN's invitation could
 * quietly cancel the onboarding of someone senior to them") and refuses a terminal row. POST validated
 * only the REQUESTED role. Gate 2 is skipped at platform scope by design, so a FACILITATOR could
 * overwrite a pending ADMIN grant with a FACILITATOR one — and since `cognito-presignup` admits on
 * this table and `cognito-postconfirmation` takes the Cognito group from it, the account would then be
 * created at the LOWER role, the real invitee's emailed link would stop working (its hash was
 * replaced), and the provenance of the original grant would be gone.
 *
 * ⚠ THE SELF-INVITATION GATE MEANS THIS IS NOT SELF-ESCALATION. The impact is hijack/downgrade of
 * SOMEONE ELSE'S grant plus destruction of access-change provenance, which is why these tests assert
 * on the surviving row rather than on the attacker's own role.
 */
describe("POST /v1/teams/:teamId/invitations — gate 6, the row that already exists", () => {
  const invite = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    body: Record<string, unknown>,
    teamId = "PLATFORM"
  ) =>
    app.request(`/v1/teams/${teamId}/invitations`, {
      method: "POST",
      headers: { ...asUser(identity), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("REFUSES a FACILITATOR overwriting a pending ADMIN invitation, and the row SURVIVES", async () => {
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "pending-admin@example.com",
        scope: "PLATFORM",
        status: "PENDING",
        platformRole: "ADMIN",
        invitedBy: "the-real-admin",
        tokenHash: "the-original-hash",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "fac-1", email: "f@example.com", role: "FACILITATOR" },
      { emails: ["pending-admin@example.com"], platformRole: "FACILITATOR" }
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("INVITATION_OUTRANKS_CALLER");
    // ⚠ THE ASSERTIONS THAT MATTER: the grant, the inviter and the LINK all survive intact.
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0].platformRole).toBe("ADMIN");
    expect(invitations.rows[0].invitedBy).toBe("the-real-admin");
    expect(invitations.rows[0].tokenHash).toBe("the-original-hash");
  });

  it("REFUSES overwriting an ACCEPTED row, so acceptedAt is never destroyed", async () => {
    /**
     * An accepted row is the audit record of a REDEEMED grant, and `acceptedAt` is "the one fact the
     * field exists to record" (InvitationRepository.accept). Overwriting it also achieves nothing a
     * caller could want: the platform role is read from this row at POSTCONFIRMATION — once, at
     * signup — so rewriting it cannot promote an account that already exists.
     *
     * 409, not 403: the caller IS permitted, the row is simply in a state this does not apply to —
     * the same distinction the DELETE's gate 4 draws.
     */
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "joined@example.com",
        scope: "PLATFORM",
        status: "ACCEPTED",
        acceptedAt: "2026-08-01T00:00:00.000Z",
        acceptedBy: "joined-sub",
        platformRole: "PARTICIPANT",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "admin-1", email: "a@example.com", role: "ADMIN" },
      { emails: ["joined@example.com"], platformRole: "FACILITATOR" }
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("INVITATION_ALREADY_ACCEPTED");
    expect(invitations.rows[0].status).toBe("ACCEPTED");
    expect(invitations.rows[0].acceptedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(invitations.rows[0].platformRole).toBe("PARTICIPANT");
  });

  it("⚠ STILL allows re-inviting a REVOKED row — re-admission is the documented flow", async () => {
    // The regression this guards. Blocking every overwrite would have broken re-admission, which
    // `/access` names explicitly ("re-admission is an explicit act, i.e. a fresh invitation").
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "returning@example.com",
        scope: "PLATFORM",
        status: "REVOKED",
        // FACILITATOR rather than PARTICIPANT: gate 3 refuses a PARTICIPANT/EXECUTIVE at platform
        // scope with a 400 (they need a team), which would mask the gate under test.
        platformRole: "FACILITATOR",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "admin-1", email: "a@example.com", role: "ADMIN" },
      { emails: ["returning@example.com"], platformRole: "FACILITATOR" }
    );

    expect(res.status).toBe(201);
    expect(invitations.rows[0].status).toBe("PENDING");
  });

  it("⚠ STILL allows RE-SENDING a pending invitation the caller may grant", async () => {
    // Ordinary operator behaviour ("they didn't get the email"), and it must keep working.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "waiting@example.com",
        scope: "PLATFORM",
        status: "PENDING",
        platformRole: "FACILITATOR",
        tokenHash: "old-hash",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "fac-1", email: "f@example.com", role: "FACILITATOR" },
      { emails: ["waiting@example.com"], platformRole: "FACILITATOR" }
    );

    expect(res.status).toBe(201);
    // A fresh token, which is the point of re-sending.
    expect(invitations.rows[0].tokenHash).not.toBe("old-hash");
  });

  it("is ALL-OR-NOTHING: one protected address in a batch writes NOTHING", async () => {
    /**
     * Gates 3, 4 and 5 all refuse the whole batch rather than the offending row, so that a mixed
     * batch never leaves the caller working out which addresses got through by reading the response.
     * Gate 6 matches them — which is why it is a pre-validation pass and not a check inside the
     * write loop.
     */
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "pending-admin@example.com",
        scope: "PLATFORM",
        status: "PENDING",
        platformRole: "ADMIN",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "fac-1", email: "f@example.com", role: "FACILITATOR" },
      {
        emails: ["fine@example.com", "pending-admin@example.com", "also-fine@example.com"],
        platformRole: "FACILITATOR",
      }
    );

    expect(res.status).toBe(403);
    // The two innocent addresses were NOT written.
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0].platformRole).toBe("ADMIN");
  });

  it("matches the stored row case-INSENSITIVELY on the address", async () => {
    // The store keys on a lower-cased email; a caller's spelling must not be able to miss the row
    // and slip past the gate.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "pending-admin@example.com",
        scope: "PLATFORM",
        status: "PENDING",
        platformRole: "ADMIN",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "fac-1", email: "f@example.com", role: "FACILITATOR" },
      { emails: ["Pending-Admin@Example.COM"], platformRole: "FACILITATOR" }
    );

    expect(res.status).toBe(403);
    expect(invitations.rows[0].platformRole).toBe("ADMIN");
  });

  it("an ADMIN may still replace a pending FACILITATOR row — the matrix decides, not the row's mere existence", async () => {
    // The two-sided form: the gate must ALLOW as well as refuse, or a blanket-deny implementation
    // would pass every assertion above.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "staff@example.com",
        scope: "PLATFORM",
        status: "PENDING",
        platformRole: "FACILITATOR",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await invite(
      app,
      { id: "admin-1", email: "a@example.com", role: "ADMIN" },
      { emails: ["staff@example.com"], platformRole: "FACILITATOR" }
    );

    expect(res.status).toBe(201);
  });
});

describe("POST /v1/teams/:teamId/invitations", () => {
  it("400s when neither emails nor invitees is supplied", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the RAW token but never the stored hash", async () => {
    // The digest has no use downstream and must not travel past the table; the raw
    // token is returned exactly once, so the caller can build the link.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["New@Example.com"] }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { invitations: Array<Record<string, unknown>> };
    const [item] = body.invitations;
    expect(item.token).toEqual(expect.any(String));
    expect(item).not.toHaveProperty("tokenHash");
    // …and the token that came back is the pre-image of what was stored.
    expect(invitations.rows[0].tokenHash).toBe(hashInviteToken(item.token as string));
  });

  it("gives each invitee their OWN token", async () => {
    // One recipient forwarding their email must not let someone else register: a
    // link only ever resolves to the address it was minted for.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["a@example.com", "b@example.com"] }),
    });

    const body = (await res.json()) as { invitations: Array<{ token: string }> };
    expect(new Set(body.invitations.map((i) => i.token)).size).toBe(2);
    expect(new Set(invitations.rows.map((r) => r.tokenHash)).size).toBe(2);
  });

  it("lower-cases stored emails so lookups can't miss on case", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["MiXeD@Example.COM"] }),
    });

    expect(invitations.rows[0].email).toBe("mixed@example.com");
  });

  it("stamps every new invitation with an expiry", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["x@example.com"] }),
    });

    const { expiresAt } = invitations.rows[0];
    expect(expiresAt).toBeTruthy();
    expect(Date.parse(expiresAt as string)).toBeGreaterThan(Date.now());
  });

  it("DROPS teamRole for a platform role that holds no team seat (JUDGE)", async () => {
    // A JUDGE evaluates a workshop rather than sitting in one team, and their invitation
    // is workshop-scoped, so a team role on that row would be a grant nothing reads —
    // and would then be applied on join. Narrowed from "non-participant" once EXECUTIVE
    // was allowed to hold one; see the test below.
    //
    // ── MOVED TO THE PLATFORM SENTINEL ──
    //
    // The judge invitee used to be sent at TEAM scope (`/v1/teams/t1/invitations`) alongside
    // the participant, which requirement (b) layer 1 now refuses with a 400: a JUDGE is
    // invited to the PLATFORM, not to a team. So the two invitees are now sent as two
    // requests to the two scopes that are legal for them. The RULE UNDER TEST is unchanged
    // and is still what this asserts — a judge's row carries no teamRole, a participant's
    // does — and it is now exercised on the only path that can still produce a judge row.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    // The judge: PLATFORM scope, naming the workshop gate 4 requires. An ADMIN may name any.
    await app.request("/v1/teams/PLATFORM/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          {
            email: "judge@example.com",
            platformRole: "JUDGE",
            teamRole: "LEAD",
            workshopId: "w1",
          },
        ],
      }),
    });

    // The participant: TEAM scope, as before.
    await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "builder@example.com", platformRole: "PARTICIPANT", teamRole: "LEAD" },
        ],
      }),
    });

    const judge = invitations.rows.find((r) => r.email === "judge@example.com");
    const builder = invitations.rows.find((r) => r.email === "builder@example.com");
    expect(judge?.teamRole).toBeUndefined();
    expect(judge?.platformRole).toBe("JUDGE");
    expect(builder?.teamRole).toBe("LEAD");
  });

  it("KEEPS teamRole for an EXECUTIVE — they do hold a team seat", async () => {
    // Owner, Test 4: "team invite when executive selected dropdown not showing to select
    // team role". Two halves caused that — the picker was gated to PARTICIPANT in the UI,
    // and this service dropped the value for any non-participant. EXECUTIVE and COACH
    // were added to TEAM_ROLES precisely so a non-builder can hold an honest team role,
    // which those gates then contradicted.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "exec@example.com", platformRole: "EXECUTIVE", teamRole: "EXECUTIVE" },
          { email: "coach@example.com", platformRole: "EXECUTIVE", teamRole: "COACH" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const exec = invitations.rows.find((r) => r.email === "exec@example.com");
    const coach = invitations.rows.find((r) => r.email === "coach@example.com");
    expect(exec?.teamRole).toBe("EXECUTIVE");
    expect(coach?.teamRole).toBe("COACH");
    // The workshop is still SERVER-DERIVED for an EXECUTIVE (WORKSHOP_POLICY.EXECUTIVE =
    // "DERIVED"), so allowing a team role must not have loosened that.
    expect(exec?.workshopId).toBe("w1");
  });

  it("keeps teamRole when no platformRole is given (defaults to participant)", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["x@example.com"], teamRole: "LEAD" }),
    });

    expect(invitations.rows[0].teamRole).toBe("LEAD");
    expect(invitations.rows[0].platformRole).toBeUndefined();
  });
});

// ─── DELETE /v1/teams/:teamId/invitations/:email ────────────────────────────

describe("DELETE invitations/:email — revoking a pending grant", () => {
  it("deletes the ROW, because the row IS the permission to register", async () => {
    // Not a status flip: the Cognito pre-signup trigger admits any email with a
    // live row. While the row exists, the grant exists.
    const invitations = new FakeInvitations([invitation({ platformRole: "PARTICIPANT" })]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations/invitee@example.com", {
      method: "DELETE",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(invitations.rows).toHaveLength(0);
  });

  it("matches on a case-different address, as the stored row is lower-cased", async () => {
    const invitations = new FakeInvitations([invitation({ email: "mixed@example.com" })]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations/MiXeD%40Example.COM", {
      method: "DELETE",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(invitations.rows).toHaveLength(0);
  });

  it("404s an address with no invitation rather than reporting a false success", async () => {
    const { app } = build({ invitations: new FakeInvitations([]), workshops: new FakeWorkshops(true) });
    const res = await app.request("/v1/teams/t1/invitations/nobody@example.com", {
      method: "DELETE",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });
    expect(res.status).toBe(404);
  });

  it("gate 1: a PARTICIPANT cannot revoke — a role that can't grant can't un-grant", async () => {
    const invitations = new FakeInvitations([invitation()]);
    // Member of the team, so it is specifically the ROLE gate being exercised.
    const members = new FakeMembers([
      { teamId: "t1", userId: "p1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });

    const res = await app.request("/v1/teams/t1/invitations/invitee@example.com", {
      method: "DELETE",
      headers: asUser({ id: "p1", email: "p@b.c", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(invitations.rows).toHaveLength(1);
  });

  it("gate 2: blocks the IDOR — a facilitator who can't see the team can't revoke in it", async () => {
    const invitations = new FakeInvitations([invitation()]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false),
    });

    const res = await app.request("/v1/teams/t1/invitations/invitee@example.com", {
      method: "DELETE",
      headers: asUser({ id: "outsider", email: "o@b.c", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
    expect(invitations.rows).toHaveLength(1);
  });

  it("gate 3: a FACILITATOR cannot revoke an ADMIN invitation", async () => {
    // The mirror of the grant matrix. Revoking is not inherently safer than
    // granting — cancelling a senior person's onboarding is its own harm.
    const invitations = new FakeInvitations([
      invitation({ email: "boss@example.com", platformRole: "ADMIN" }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations/boss@example.com", {
      method: "DELETE",
      headers: asUser({ id: "f1", email: "f@b.c", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
    expect(invitations.rows).toHaveLength(1);
  });

  it("gate 3: an EXECUTIVE cannot revoke a JUDGE invitation, but can revoke a PARTICIPANT's", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "judge@example.com", platformRole: "JUDGE" }),
      invitation({ email: "player@example.com", platformRole: "PARTICIPANT" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "e1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });
    const headers = asUser({ id: "e1", email: "e@b.c", role: "EXECUTIVE" });

    const denied = await app.request("/v1/teams/t1/invitations/judge@example.com", {
      method: "DELETE",
      headers,
    });
    const allowed = await app.request("/v1/teams/t1/invitations/player@example.com", {
      method: "DELETE",
      headers,
    });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(invitations.rows.map((r) => r.email)).toEqual(["judge@example.com"]);
  });

  it("gate 3: an absent platformRole is treated as PARTICIPANT, matching what POST writes", async () => {
    const invitations = new FakeInvitations([invitation({ platformRole: undefined })]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "e1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });

    const res = await app.request("/v1/teams/t1/invitations/invitee@example.com", {
      method: "DELETE",
      headers: asUser({ id: "e1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(200);
  });

  it("gate 4: refuses to destroy an ACCEPTED invitation — that row is the audit record", async () => {
    const invitations = new FakeInvitations([
      invitation({ status: "ACCEPTED", platformRole: "PARTICIPANT" }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/invitations/invitee@example.com", {
      method: "DELETE",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(res.status).toBe(409);
    expect(invitations.rows).toHaveLength(1);
  });

  it("publishes invitation.revoked with who did it and which role was withdrawn", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "judge@example.com", platformRole: "JUDGE" }),
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, events, workshops: new FakeWorkshops(true) });

    await app.request("/v1/teams/t1/invitations/judge@example.com", {
      method: "DELETE",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    const published = events.published.find((e) => e.type === "invitation.revoked");
    expect(published?.detail).toMatchObject({
      teamId: "t1",
      email: "judge@example.com",
      platformRole: "JUDGE",
      revokedBy: "admin",
    });
  });

  it("does NOT publish when the revoke was refused", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "boss@example.com", platformRole: "ADMIN" }),
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, events, workshops: new FakeWorkshops(true) });

    await app.request("/v1/teams/t1/invitations/boss@example.com", {
      method: "DELETE",
      headers: asUser({ id: "f1", email: "f@b.c", role: "FACILITATOR" }),
    });

    expect(events.published.filter((e) => e.type === "invitation.revoked")).toHaveLength(0);
  });
});

// ─── DELETE /v1/teams/:teamId/invitations/:email/workshop ────────────────────

/**
 * WITHDRAWING A WORKSHOP ENTITLEMENT.
 *
 * ⚠ READ THIS BEFORE "TIDYING" EITHER ROUTE INTO THE OTHER. There are two revoke routes on one
 * invitation and the difference is what each DESTROYS:
 *
 *   DELETE …/invitations/:email           deletes the ROW. Gate 4 REFUSES a terminal row,
 *                                         because that row is the audit record. Tests above.
 *   DELETE …/invitations/:email/workshop  removes ONE ATTRIBUTE. Gate 4 INVERTS — a terminal
 *                                         row is exactly what it is for. Tests here.
 *
 * The whole reason this route exists is that a JUDGE's workshop access lives entirely in
 * `invitation.workshopId`, so an ACCEPTED row was an un-revocable grant: the DELETE answered
 * 409 (correctly) and nothing else touched the field. Every spec below is either a gate mirrored
 * from the DELETE — which must keep answering identically, since a caller who cannot grant a
 * role must not be able to withdraw its entitlement either — or the inversion itself.
 */
describe("DELETE invitations/:email/workshop — withdrawing a workshop entitlement", () => {
  /** An ACCEPTED, registered judge holding w1 — the P1-2 population, exactly. */
  const acceptedJudge = (over: Partial<Invitation> = {}) =>
    invitation({
      teamId: "PLATFORM",
      email: "judge@example.com",
      scope: "PLATFORM",
      status: "ACCEPTED",
      acceptedAt: "2026-08-02T00:00:00.000Z",
      acceptedBy: "judge-1",
      platformRole: "JUDGE",
      workshopId: "w1",
      invitedBy: "admin",
      ...over,
    });

  const withdraw = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    path = "/v1/teams/PLATFORM/invitations/judge%40example.com/workshop"
  ) => app.request(path, { method: "DELETE", headers: asUser(identity) });

  /**
   * ── ⚠ GATE 3b: WITHDRAWAL IS AS OWNERSHIP-SCOPED AS GRANTING ─────────────────────
   *
   * THE ASYMMETRY THESE CLOSE. Minting a JUDGE invitation requires the caller to own the workshop
   * they name (`mayGrantWorkshop` → `ownsWorkshop`). Both withdrawal paths checked the ROLE MATRIX
   * and never the WORKSHOP. Every JUDGE row is platform-scoped, gate 2 is deliberately skipped
   * there, and `ROLE_GRANTS.FACILITATOR` contains JUDGE — so gates 1 and 3 both passed for any
   * facilitator and the skipped gate 2 was the only ownership-bearing one.
   *
   * ⚠ WHY IT MATTERED MORE THAN "A FACILITATOR DID SOMETHING UNTIDY": `GET /entitlements/workshops`
   * reads `invitation.workshopId`, and every judging read and write is gated on that entitlement. So
   * clearing the attribute IS the whole of that judge's access — enough for one facilitator to
   * disable a competitor's judging panel and block results quorum. The recon needed no extra
   * privilege either: `GET /teams/PLATFORM/invitations` hands over the email and workshopId of every
   * row whose role the caller may grant.
   */
  describe("gate 3b: ownership of the row's own workshop", () => {
    it("REFUSES a FACILITATOR who does not own the judge's experience", async () => {
      const invitations = new FakeInvitations([acceptedJudge()]);
      // Owns nothing: `ownsWorkshop("w1")` is false.
      const { app } = build({ invitations, workshops: new FakeWorkshops(false, false) });

      const res = await withdraw(app, { id: "other-fac", email: "o@example.com", role: "FACILITATOR" });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("WORKSHOP_NOT_OWNED");
      // The half that matters: the entitlement SURVIVES, so the judge can still score.
      expect(invitations.rows[0].workshopId).toBe("w1");
    });

    it("ALLOWS the FACILITATOR who does own it — the same predicate the mint path uses", async () => {
      // NOT VACUOUS: without this the refusal above would pass on a route that refused every
      // facilitator, which would break the withdrawal feature rather than scope it.
      const invitations = new FakeInvitations([acceptedJudge()]);
      const { app } = build({ invitations, workshops: new FakeWorkshops(false, true) });

      const res = await withdraw(app, { id: "owner-fac", email: "o@example.com", role: "FACILITATOR" });

      expect(res.status).toBe(200);
      expect(invitations.rows[0].workshopId).toBeUndefined();
    });

    it("REFUSES when the ownership probe THROWS — fail-closed, like the mint path", async () => {
      // An authorization gate must not depend on a collaborator's error discipline. A probe that
      // cannot answer is a refusal, not a pass.
      const invitations = new FakeInvitations([acceptedJudge()]);
      const workshops = new FakeWorkshops(false, false);
      workshops.ownsWorkshop = async () => {
        throw new Error("workshop service unreachable");
      };
      const { app } = build({ invitations, workshops });

      const res = await withdraw(app, { id: "f1", email: "f@example.com", role: "FACILITATOR" });

      expect(res.status).toBe(403);
      expect(invitations.rows[0].workshopId).toBe("w1");
    });

    it("lets an ADMIN withdraw without owning anything, and spends NO probe", async () => {
      /**
       * ⚠ WIDER THAN THE MINT PATH'S ADMIN BRANCH, DELIBERATELY. `mayGrantWorkshop` gates its ADMIN
       * short-circuit on a KNOWN CALLER EMAIL, because there an unidentified admin would defeat the
       * self-invitation gate and could invite THEMSELVES into a stranger's judging. Withdrawal
       * cannot escalate anyone — it only removes access — so there is no self-grant to defend
       * against and no reason to make identity a precondition. Note the empty email.
       */
      const invitations = new FakeInvitations([acceptedJudge()]);
      const workshops = new FakeWorkshops(false, false);
      const { app } = build({ invitations, workshops });

      const res = await withdraw(app, { id: "admin-1", email: "", role: "ADMIN" });

      expect(res.status).toBe(200);
      expect(invitations.rows[0].workshopId).toBeUndefined();
      expect(workshops.calls, "an admin decides locally — no east-west hop").toBe(0);
    });

    it("does NOT apply to a DERIVED row, and spends no probe on one", async () => {
      /**
       * ⚠ THE REGRESSION THIS GUARDS, and it is the reason the gate keys on WORKSHOP_POLICY rather
       * than on "the row has a workshopId". For a DERIVED role (EXECUTIVE, PARTICIPANT) the workshop
       * comes from the TEAM, not from the request, and gate 2 has already established the caller's
       * standing in that team — ownership was never asked on the way IN, so asking it on the way OUT
       * would stop an executive withdrawing their own team's invitations. A first draft of this fix
       * did exactly that and broke two existing tests.
       */
      const invitations = new FakeInvitations([
        invitation({
          teamId: "t1",
          email: "player@example.com",
          status: "ACCEPTED",
          acceptedBy: "player-1",
          platformRole: "PARTICIPANT",
          workshopId: "w1",
        }),
      ]);
      const members = new FakeMembers([
        { teamId: "t1", userId: "e1", role: "EXECUTIVE", joinedAt: "2026-01-01T00:00:00.000Z" },
      ]);
      const workshops = new FakeWorkshops(false, false);
      const { app } = build({ invitations, members, workshops });

      const res = await withdraw(
        app,
        { id: "e1", email: "e@b.c", role: "EXECUTIVE" },
        "/v1/teams/t1/invitations/player%40example.com/workshop"
      );

      expect(res.status).toBe(200);
      expect(invitations.rows[0].workshopId).toBeUndefined();
    });

    it("applies to the plain REVOKE route too, for a still-PENDING judge row", async () => {
      // The same gap on the sibling: revoking a foreign owner's PENDING judge invitation destroys
      // the same access, so it needs the same check.
      const invitations = new FakeInvitations([
        acceptedJudge({ status: "PENDING", acceptedAt: undefined, acceptedBy: undefined }),
      ]);
      const { app } = build({ invitations, workshops: new FakeWorkshops(false, false) });

      const res = await withdraw(
        app,
        { id: "other-fac", email: "o@example.com", role: "FACILITATOR" },
        "/v1/teams/PLATFORM/invitations/judge%40example.com"
      );

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("WORKSHOP_NOT_OWNED");
      expect(invitations.rows[0].status).toBe("PENDING");
    });

    it("the plain REVOKE route still works for the owner", async () => {
      const invitations = new FakeInvitations([
        acceptedJudge({ status: "PENDING", acceptedAt: undefined, acceptedBy: undefined }),
      ]);
      const { app } = build({ invitations, workshops: new FakeWorkshops(false, true) });

      const res = await withdraw(
        app,
        { id: "owner-fac", email: "o@example.com", role: "FACILITATOR" },
        "/v1/teams/PLATFORM/invitations/judge%40example.com"
      );

      expect(res.status).toBe(200);
    });
  });

  it("clears workshopId and leaves the row, its status and its acceptedAt intact", async () => {
    // THE CORE CONTRACT. Only the entitlement field goes — everything that makes the row an
    // audit record survives, which is the entire justification for a route separate from the
    // DELETE rather than a relaxation of its gate 4.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const { app } = build({ invitations });

    const res = await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      revoked: true,
      audited: true,
      auditSubjectResolved: true,
      email: "judge@example.com",
    });

    // The row SURVIVES — not deleted, not flipped.
    expect(invitations.rows).toHaveLength(1);
    const row = invitations.rows[0];
    // Gone, and ABSENT rather than blanked: `Invitation.workshopId`'s contract is that absent
    // means "no grant", and a reader testing presence rather than truthiness must see nothing.
    expect(row.workshopId).toBeUndefined();
    expect("workshopId" in row).toBe(false);
    // The provenance, untouched.
    expect(row.status).toBe("ACCEPTED");
    expect(row.acceptedAt).toBe("2026-08-02T00:00:00.000Z");
    expect(row.acceptedBy).toBe("judge-1");
    expect(row.invitedBy).toBe("admin");
    expect(row.platformRole).toBe("JUDGE");
    // And the row's own breadcrumb, which is what keeps the actor recoverable when the audit
    // write fails — see the metric spec below.
    expect(row.workshopRevokedBy).toBe("admin-1");
    expect(row.workshopRevokedAt).toBeTruthy();
  });

  it("WORKS ON AN ACCEPTED ROW — the case the DELETE refuses with 409", async () => {
    // THE INVERSION, asserted as a pair on the SAME row so the two routes' answers cannot
    // drift apart unnoticed. This is P1-2: without the second call there is no way to withdraw
    // a registered judge's workshop access at all.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const { app } = build({ invitations });
    const admin = { id: "admin-1", role: "ADMIN" };

    const deleted = await app.request(
      "/v1/teams/PLATFORM/invitations/judge%40example.com",
      { method: "DELETE", headers: asUser(admin) }
    );
    expect(deleted.status).toBe(409);
    // Refused and NOTHING written — which is what makes that refusal safe.
    expect(invitations.rows[0].workshopId).toBe("w1");

    const cleared = await withdraw(app, admin);
    expect(cleared.status).toBe(200);
    expect(invitations.rows[0].workshopId).toBeUndefined();
    // The row the DELETE was protecting is still there, complete.
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0].status).toBe("ACCEPTED");
  });

  it("also works on a REVOKED row — defence in depth, since the FIELD carries the grant", async () => {
    // A REVOKED row grants nothing TODAY because /entitlements/workshops filters both terminal
    // statuses — but that is ONE reader applying ONE predicate, and this route's premise is
    // that the FIELD is the grant. Clearing it makes every reader, including a future one that
    // forgets the status filter, see no entitlement.
    const invitations = new FakeInvitations([
      acceptedJudge({
        status: "REVOKED",
        revokedAt: "2026-08-05T00:00:00.000Z",
        revokedBy: "admin-0",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(invitations.rows[0].workshopId).toBeUndefined();
    // The earlier revocation's breadcrumb is NOT disturbed — two withdrawals of different
    // things, both recorded.
    expect(invitations.rows[0].status).toBe("REVOKED");
    expect(invitations.rows[0].revokedAt).toBe("2026-08-05T00:00:00.000Z");
    expect(invitations.rows[0].revokedBy).toBe("admin-0");
  });

  it("audits it as ENTITLEMENT_REVOKED with the ACTOR FROM THE TOKEN", async () => {
    // The actor is the caller's verified sub and role — never a body field, never a query
    // param, and there is nothing on this route to supply one with.
    //
    // `FakeWorkshops(false, true)` makes the caller the owner of w1 so the ownership gate
    // ("gate 3b") admits the withdrawal — this test is about what gets AUDITED, not about who may
    // withdraw, and a fixture that 403s would leave it asserting nothing.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const audit = new FakeAudit();
    const { app } = build({ invitations, audit, workshops: new FakeWorkshops(false, true) });

    const res = await withdraw(app, {
      id: "fac-9",
      email: "f@example.com",
      role: "FACILITATOR",
    });

    expect(res.status).toBe(200);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      // Keyed on the invitation's `acceptedBy` — the best sub this context can resolve from an
      // EMAIL-keyed row. See the note at the call site for the staff-reconciled residual.
      subjectId: "judge-1",
      action: "ENTITLEMENT_REVOKED",
      actorId: "fac-9",
      actorRole: "FACILITATOR",
    });
    // No `teamId` at platform scope: the sentinel is not a team, and an entry saying otherwise
    // would imply a scope the change does not have.
    expect(audit.entries[0].teamId).toBeUndefined();
  });

  it("carries the teamId on a TEAM-scoped row, so the entry says which team it was about", async () => {
    const invitations = new FakeInvitations([
      invitation({
        teamId: "t1",
        email: "exec@example.com",
        status: "ACCEPTED",
        acceptedBy: "exec-1",
        platformRole: "EXECUTIVE",
        workshopId: "w1",
      }),
    ]);
    const audit = new FakeAudit();
    const { app } = build({ invitations, audit, workshops: new FakeWorkshops(true) });

    const res = await withdraw(
      app,
      { id: "admin-1", role: "ADMIN" },
      "/v1/teams/t1/invitations/exec%40example.com/workshop"
    );

    expect(res.status).toBe(200);
    expect(audit.entries[0]).toMatchObject({
      subjectId: "exec-1",
      action: "ENTITLEMENT_REVOKED",
      teamId: "t1",
    });
  });

  it("reports audited: false WITHOUT swallowing it when the trail write fails", async () => {
    // `audit.record` returns false rather than throwing, by contract. The withdrawal has
    // already taken effect, so the 200 is correct and deliberate — but the loss is REPORTED in
    // the body rather than absorbed, and the actor survives on the row regardless.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const { app } = build({ invitations, audit: new FakeAudit(true) });

    const res = await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      revoked: true,
      audited: false,
      auditSubjectResolved: true,
    });
    // The withdrawal stands, and WHO did it is still recoverable from the row.
    expect(invitations.rows[0].workshopId).toBeUndefined();
    expect(invitations.rows[0].workshopRevokedBy).toBe("admin-1");
  });

  it("IDEMPOTENT: a second call is 200 with NO second audit entry", async () => {
    // Operators retry — a double-click, a client retry, uncertainty about whether the first
    // landed. The store's `attribute_exists(workshopId)` makes the second call a no-op, so
    // `workshopRevokedAt` records the FIRST withdrawal and never moves, and a second entry
    // (which would claim a withdrawal that did not occur) is never written.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const audit = new FakeAudit();
    const { app } = build({ invitations, audit });
    const admin = { id: "admin-1", role: "ADMIN" };

    const first = await withdraw(app, admin);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revoked: true, audited: true });
    const firstStamp = invitations.rows[0].workshopRevokedAt;
    expect(audit.entries).toHaveLength(1);

    const second = await withdraw(app, admin);

    // 200, not 404: the caller's intent already holds, and erroring on a double-click would
    // make the portal's Revoke button fail for a completed action.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      revoked: false,
      // FALSE meaning "no entry was NEEDED", not "an entry was lost" — `revoked` is what
      // distinguishes the two.
      audited: false,
      auditSubjectResolved: true,
    });
    // STILL ONE entry, and the first withdrawal's timestamp did not move.
    expect(audit.entries).toHaveLength(1);
    expect(invitations.rows[0].workshopRevokedAt).toBe(firstStamp);
  });

  it("gate 1: a PARTICIPANT cannot withdraw — a role that can't grant can't un-grant", async () => {
    // Mirrored from the DELETE's gate 1, including the message. A member of the team, so it is
    // specifically the ROLE gate being exercised rather than team read.
    //
    // ⚠ THE MESSAGE AND THE ABSENT READ ARE THE ASSERTIONS, not just the 403 — and that is a
    // mutation finding, not belt-and-braces. Gate 1 is OUTCOME-IMPLIED by gate 3: `canInvite`
    // is `grantable.length > 0` and `canGrantRole` needs `grantable.includes(target)`, so a role
    // that fails gate 1 can never pass gate 3 and the status is 403 either way. Deleting gate 1
    // therefore SURVIVED a status-only assertion. What it actually changes is (a) which refusal
    // an operator is told — a PARTICIPANT would get "not a member of this team" or a per-role
    // message instead of the truth, and (b) whether a caller who may grant NOTHING can make this
    // route touch the store at all. Both are pinned here.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "t1",
        email: "exec@example.com",
        status: "ACCEPTED",
        acceptedBy: "exec-1",
        platformRole: "EXECUTIVE",
        workshopId: "w1",
      }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "p1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });
    // Any read at all is a gate-1 bypass: the refusal must land before the store is consulted.
    let reads = 0;
    const realGet = invitations.get.bind(invitations);
    invitations.get = async (teamId: string, email: string) => {
      reads += 1;
      return realGet(teamId, email);
    };

    const res = await withdraw(
      app,
      { id: "p1", email: "p@b.c", role: "PARTICIPANT" },
      "/v1/teams/t1/invitations/exec%40example.com/workshop"
    );

    expect(res.status).toBe(403);
    // GATE 1's OWN message, byte-for-byte the DELETE's, so a caller who tried either route gets
    // the same answer — and so a later gate answering in its place is visible here.
    expect((await res.json()) as { error: string }).toEqual({
      error: "Forbidden: your role cannot manage invitations",
    });
    expect(reads).toBe(0);
    expect(invitations.rows[0].workshopId).toBe("w1");
  });

  it("gate 2: blocks the IDOR — a non-member on a TEAM-scoped id cannot withdraw in it", async () => {
    // FakeWorkshops(false) refuses ownership and the caller is on no team, so `canRead` fails:
    // `:teamId` is an unvalidated path param without this, and any facilitator could reach into
    // a team they merely guessed the id of.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "t1",
        email: "exec@example.com",
        status: "ACCEPTED",
        acceptedBy: "exec-1",
        platformRole: "EXECUTIVE",
        workshopId: "w1",
      }),
    ]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false),
    });

    const res = await withdraw(
      app,
      { id: "outsider", email: "o@b.c", role: "FACILITATOR" },
      "/v1/teams/t1/invitations/exec%40example.com/workshop"
    );

    expect(res.status).toBe(403);
    expect(invitations.rows[0].workshopId).toBe("w1");
  });

  it("gate 2 is SKIPPED at platform scope, so a FACILITATOR can withdraw what they could grant", async () => {
    // ⚠ THE PAIRING WITH POST AND DELETE. `canRead("PLATFORM", …)` passes only for ADMIN, and
    // every JUDGE row is platform-scoped — so leaving gate 2 in would make this route
    // unreachable for exactly the population P1-2 is about, and would leave a FACILITATOR able
    // to grant a judge a workshop they could never take back.
    //
    // Deliberately a member of NO team, so `ownsTeamWorkshop` is false and this would 403 if the
    // team-read gate still ran for the sentinel.
    //
    // ⚠ THE SECOND FLAG IS WHAT KEEPS THIS TEST ABOUT GATE 2. Withdrawal now also
    // requires ownership of the NAMED experience — see "gate 3b" — so a single-flag fake can no
    // longer distinguish "gate 2 ran" from "the ownership gate refused". `(false, true)` separates
    // them: not resolvable through a team, but the owner of w1. Without the split this test would
    // pass for the wrong reason, or fail while gate 2 was behaving correctly.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false, true),
    });

    const res = await withdraw(app, { id: "f1", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(invitations.rows[0].workshopId).toBeUndefined();
  });

  it("gate 3: a FACILITATOR cannot withdraw an ADMIN's entitlement", async () => {
    // The mirror of the grant matrix, against the STORED role. Withdrawing is not inherently
    // safer than granting: quietly stripping a senior person's access is its own harm.
    const invitations = new FakeInvitations([
      acceptedJudge({
        email: "boss@example.com",
        platformRole: "ADMIN",
        acceptedBy: "boss-1",
      }),
    ]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await withdraw(
      app,
      { id: "f1", email: "f@b.c", role: "FACILITATOR" },
      "/v1/teams/PLATFORM/invitations/boss%40example.com/workshop"
    );

    expect(res.status).toBe(403);
    expect(invitations.rows[0].workshopId).toBe("w1");
  });

  it("gate 3: an EXECUTIVE cannot withdraw a JUDGE's, but can withdraw a PARTICIPANT's", async () => {
    // The two-sided form, so the gate is proven to REFUSE and to ALLOW from one caller — a
    // blanket-deny implementation would pass a refusal-only test.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "t1",
        email: "judge@example.com",
        status: "ACCEPTED",
        acceptedBy: "judge-1",
        platformRole: "JUDGE",
        workshopId: "w1",
      }),
      invitation({
        teamId: "t1",
        email: "player@example.com",
        status: "ACCEPTED",
        acceptedBy: "player-1",
        platformRole: "PARTICIPANT",
        workshopId: "w1",
      }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "e1", role: "EXECUTIVE", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });
    const executive = { id: "e1", email: "e@b.c", role: "EXECUTIVE" };

    const denied = await withdraw(
      app,
      executive,
      "/v1/teams/t1/invitations/judge%40example.com/workshop"
    );
    const allowed = await withdraw(
      app,
      executive,
      "/v1/teams/t1/invitations/player%40example.com/workshop"
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    // Judge's grant intact; participant's gone.
    expect(invitations.rows[0].workshopId).toBe("w1");
    expect(invitations.rows[1].workshopId).toBeUndefined();
  });

  it("gate 3: an absent platformRole is treated as PARTICIPANT, matching what POST writes", async () => {
    const invitations = new FakeInvitations([
      invitation({
        teamId: "t1",
        email: "legacy@example.com",
        status: "ACCEPTED",
        acceptedBy: "legacy-1",
        platformRole: undefined,
        workshopId: "w1",
      }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "e1", role: "EXECUTIVE", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });

    const res = await withdraw(
      app,
      { id: "e1", email: "e@b.c", role: "EXECUTIVE" },
      "/v1/teams/t1/invitations/legacy%40example.com/workshop"
    );

    expect(res.status).toBe(200);
    expect(invitations.rows[0].workshopId).toBeUndefined();
  });

  it("404s an address with no invitation, and writes nothing", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations });

    const res = await withdraw(
      app,
      { id: "admin-1", role: "ADMIN" },
      "/v1/teams/PLATFORM/invitations/nobody%40example.com/workshop"
    );

    expect(res.status).toBe(404);
    // NO UPSERT: a row carrying `workshopRevokedBy` and no invitation would be provenance for
    // a grant that never existed.
    expect(invitations.rows).toHaveLength(0);
    expect(invitations.clearWorkshopCalls).toEqual([]);
  });

  it("matches on a case-different address, as the stored row is lower-cased", async () => {
    const invitations = new FakeInvitations([
      acceptedJudge({ email: "mixed@example.com", acceptedBy: "mixed-1" }),
    ]);
    const { app } = build({ invitations });

    const res = await withdraw(
      app,
      { id: "admin-1", role: "ADMIN" },
      "/v1/teams/PLATFORM/invitations/MiXeD%40Example.COM/workshop"
    );

    expect(res.status).toBe(200);
    expect(invitations.rows[0].workshopId).toBeUndefined();
    // The store is asked for the LOWER-CASED address, which is the only form the table holds.
    expect(invitations.clearWorkshopCalls).toEqual([
      { teamId: "PLATFORM", email: "mixed@example.com", revokedBy: "admin-1" },
    ]);
  });

  it("a row with NO workshopId is a 200 no-op with no entry — nothing to withdraw", async () => {
    // A FACILITATOR's row, for which a workshop is FORBIDDEN, so there was never a grant. The
    // same branch a double-click takes, reached from a different starting state.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "fac@example.com",
        status: "ACCEPTED",
        acceptedBy: "fac-1",
        platformRole: "FACILITATOR",
      }),
    ]);
    const audit = new FakeAudit();
    const { app } = build({ invitations, audit });

    const res = await withdraw(
      app,
      { id: "admin-1", role: "ADMIN" },
      "/v1/teams/PLATFORM/invitations/fac%40example.com/workshop"
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: false, audited: false });
    expect(audit.entries).toEqual([]);
    // No breadcrumb either: nothing happened, so the row says nothing happened.
    expect(invitations.rows[0].workshopRevokedBy).toBeUndefined();
  });

  it("reports auditSubjectResolved: false when the row names no subject sub — and still withdraws", async () => {
    // A PENDING row has no `acceptedBy`, so there is no user partition to key an append-only
    // entry on and no id to invent. The WITHDRAWAL still happens (it is the access change the
    // operator asked for) and the row's own `workshopRevokedBy` still records who did it — the
    // loss is only the trail entry, and it is REPORTED rather than absorbed.
    const invitations = new FakeInvitations([
      acceptedJudge({ status: "PENDING", acceptedAt: undefined, acceptedBy: undefined }),
    ]);
    const audit = new FakeAudit();
    const { app } = build({ invitations, audit });

    const res = await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      revoked: true,
      audited: false,
      auditSubjectResolved: false,
    });
    expect(invitations.rows[0].workshopId).toBeUndefined();
    expect(invitations.rows[0].workshopRevokedBy).toBe("admin-1");
    // No entry, because there was no subject to key one on — never a fabricated partition.
    expect(audit.entries).toEqual([]);
  });

  it("publishes invitation.workshop_revoked with who did it and which workshop went", async () => {
    // Its OWN event type, not `invitation.revoked`: that one asserts the whole invitation was
    // withdrawn, and a consumer reading it for this would conclude the person may no longer
    // register.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, events });

    await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(
      events.published.filter((e) => e.type === "invitation.revoked")
    ).toHaveLength(0);
    const published = events.published.find(
      (e) => e.type === "invitation.workshop_revoked"
    );
    expect(published?.detail).toMatchObject({
      teamId: "PLATFORM",
      email: "judge@example.com",
      platformRole: "JUDGE",
      // Read off the row BEFORE the clear, so the event says WHAT was withdrawn.
      workshopId: "w1",
      revokedBy: "admin-1",
    });
  });

  it("does NOT publish when the withdrawal was refused, nor on a no-op", async () => {
    const invitations = new FakeInvitations([
      acceptedJudge({
        email: "boss@example.com",
        platformRole: "ADMIN",
        acceptedBy: "boss-1",
      }),
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, events, workshops: new FakeWorkshops(true) });

    // Refused by gate 3.
    await withdraw(
      app,
      { id: "f1", email: "f@b.c", role: "FACILITATOR" },
      "/v1/teams/PLATFORM/invitations/boss%40example.com/workshop"
    );
    expect(
      events.published.filter((e) => e.type === "invitation.workshop_revoked")
    ).toHaveLength(0);

    // And the idempotent no-op: one publish for the real withdrawal, none for the retry.
    const admin = { id: "admin-1", role: "ADMIN" };
    await withdraw(
      app,
      admin,
      "/v1/teams/PLATFORM/invitations/boss%40example.com/workshop"
    );
    await withdraw(
      app,
      admin,
      "/v1/teams/PLATFORM/invitations/boss%40example.com/workshop"
    );
    expect(
      events.published.filter((e) => e.type === "invitation.workshop_revoked")
    ).toHaveLength(1);
  });

  it("FAILS CLOSED on a store failure — 5xx, never a 200 claiming the access is gone", async () => {
    // The real repository rethrows anything that is not a ConditionalCheckFailedException. A
    // caught-and-reported-as-success withdrawal would tell an operator the judge lost access
    // while they kept reading the workshop.
    const invitations = new FakeInvitations([acceptedJudge()]);
    invitations.clearWorkshopThrows = new Error("ProvisionedThroughputExceededException");
    const events = new InMemoryPublisher();
    const audit = new FakeAudit();
    const { app } = build({ invitations, events, audit });

    const res = await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(res.status).toBe(500);
    // Nothing written, nothing published, nothing recorded.
    expect(invitations.rows[0].workshopId).toBe("w1");
    expect(audit.entries).toEqual([]);
    expect(events.published).toEqual([]);
  });

  it("does NOT read listByEmail or listByTeam, whose bound THROWS rather than truncating", async () => {
    // ⚠ Both paged reads refuse rather than truncate (InvitationQueryBoundExceeded), so a
    // route that used one would have to fail closed on a throw. This route uses a POINT GET on
    // (teamId, email) and needs neither — pinned so a future "reuse the list we already have"
    // refactor has to confront that.
    const invitations = new FakeInvitations([acceptedJudge()]);
    const boom = new Error("InvitationQueryBoundExceeded");
    invitations.listByEmail = async () => {
      throw boom;
    };
    invitations.listByTeam = async () => {
      throw boom;
    };
    const { app } = build({ invitations });

    const res = await withdraw(app, { id: "admin-1", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(invitations.rows[0].workshopId).toBeUndefined();
  });
});

// ─── GET /v1/invitations/mine ───────────────────────────────────────────────

describe("GET /v1/invitations/mine", () => {
  it("takes the email from the verified token, not from the query string", async () => {
    // There is no input to tamper with here: a caller can only ever see codes for
    // teams THEY were invited to. A `?email=` override would leak invite codes.
    const invitations = new FakeInvitations([
      invitation({ email: "mine@example.com" }),
      invitation({ teamId: "t2", email: "someone-else@example.com" }),
    ]);
    const teams = new FakeTeams([team(), team({ id: "t2", inviteCode: "SECRET99" })]);
    const { app } = build({ invitations, teams });

    const res = await app.request("/v1/invitations/mine?email=someone-else@example.com", {
      headers: asUser({ id: "u1", email: "mine@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { invitations: Array<{ teamId: string }> };
    expect(body.invitations.map((i) => i.teamId)).toEqual(["t1"]);
  });

  it("returns an empty list (not an error) when the token has no email claim", async () => {
    // The welcome page renders its "ask your facilitator" state off an empty list;
    // a 4xx here would show it an error screen instead.
    const { app } = build();
    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invitations: [] });
  });

  it("reports `joined` so the UI can tell 'here's your code' from 'you're already in'", async () => {
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "mine@example.com" }),
      invitation({ teamId: "t2", email: "mine@example.com" }),
    ]);
    const teams = new FakeTeams([team(), team({ id: "t2", inviteCode: "CODE2" })]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, teams, members });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "u1", email: "mine@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      invitations: Array<{ teamId: string; joined: boolean }>;
    };
    expect(body.invitations).toEqual([
      expect.objectContaining({ teamId: "t1", joined: true }),
      expect.objectContaining({ teamId: "t2", joined: false }),
    ]);
  });

  it("skips a dangling invitation whose team was deleted", async () => {
    // One bad row must not break the whole welcome page.
    const invitations = new FakeInvitations([
      invitation({ teamId: "gone", email: "mine@example.com" }),
      invitation({ teamId: "t1", email: "mine@example.com" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "u1", email: "mine@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { invitations: Array<{ teamId: string }> };
    expect(body.invitations.map((i) => i.teamId)).toEqual(["t1"]);
  });

  // ── THE inviteCode LEAK, AND THE TEAM A REMOVED PERSON SHOULD NOT SEE ─────
  //
  // This route returned every row it found, each carrying `inviteCode` unconditionally,
  // which made it the ENABLING HALF of the verified rejoin: the removed person's own
  // welcome page handed them the team's live code, and POST /teams/join accepted it. Both
  // suppressions are pinned here.

  it("does NOT return a team the caller was REMOVED from, and leaks no inviteCode", async () => {
    // THE REPORTED PAYLOAD. Before the fix this answered with the team AND `inviteCode:
    // "CODE1234"` — a live credential handed to someone with no current relationship to the
    // team.
    const invitations = new FakeInvitations([
      invitation({ email: "removed@example.com", status: "REVOKED" }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "removed-sub", email: "removed@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ invitations: [] });
    // Belt and braces on the whole payload: the code must not appear anywhere in it.
    expect(JSON.stringify(body)).not.toContain("CODE1234");
  });

  it("does NOT return a team whose invitation is ACCEPTED when the caller is not a member", async () => {
    // The state the verified exploit ran against — the removal deleted the membership row
    // and left the invitation ACCEPTED. This must be dropped even before the removal starts
    // writing REVOKED, because rows written before that change are in exactly this shape.
    const invitations = new FakeInvitations([
      invitation({ email: "removed@example.com", status: "ACCEPTED" }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "removed-sub", email: "removed@example.com", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({ invitations: [] });
  });

  it("STILL returns the code for a LIVE (PENDING) invitation — the welcome page's whole job", async () => {
    // The half that must not break. A freshly-provisioned participant has no membership yet,
    // so this route is the ONLY place their join code comes from.
    const invitations = new FakeInvitations([
      invitation({ email: "new@example.com", status: "PENDING" }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "new-sub", email: "new@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      invitations: Array<{ teamId: string; inviteCode: string | null; codeAvailable: boolean }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]).toMatchObject({
      teamId: "t1",
      inviteCode: "CODE1234",
      codeAvailable: true,
      joined: false,
    });
  });

  it("STILL LISTS a team the caller is a MEMBER of, but WITHOUT the code", async () => {
    // A member's row is ACCEPTED by definition, so suppression 1 must not drop it — they
    // need the card to render its "Joined" badge. Suppression 2 still withholds the code:
    // they are already in, so they have no use for it, and it is a team-wide shared secret.
    const invitations = new FakeInvitations([
      invitation({ email: "member@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "member-sub", role: "BUILDER", joinedAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const { app } = build({ invitations, members });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "member-sub", email: "member@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      invitations: Array<{
        teamId: string;
        inviteCode: string | null;
        codeAvailable: boolean;
        joined: boolean;
      }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]).toMatchObject({
      teamId: "t1",
      inviteCode: null,
      codeAvailable: false,
      joined: true,
    });
    expect(JSON.stringify(body)).not.toContain("CODE1234");
  });

  it("STILL returns a code on a row with an ABSENT status — legacy rows keep working", async () => {
    // Same fail-open-on-absence polarity as the join gate. A row predating `status` must not
    // silently stop handing its holder a join code they still need.
    const invitations = new FakeInvitations([
      invitation({
        email: "legacy@example.com",
        status: undefined as unknown as string,
      }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "legacy-sub", email: "legacy@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      invitations: Array<{ inviteCode: string | null }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].inviteCode).toBe("CODE1234");
  });

  it("drops only the SPENT team, keeping the caller's other live invitation", async () => {
    // Per-row, not all-or-nothing: someone removed from one team and freshly invited to
    // another must still get the second team's code.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "mine@example.com", status: "REVOKED" }),
      invitation({ teamId: "t2", email: "mine@example.com", status: "PENDING" }),
    ]);
    const teams = new FakeTeams([team(), team({ id: "t2", inviteCode: "CODE2222" })]);
    const { app } = build({ invitations, teams, members: new FakeMembers([]) });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "u1", email: "mine@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      invitations: Array<{ teamId: string; inviteCode: string | null }>;
    };
    expect(body.invitations).toEqual([
      expect.objectContaining({ teamId: "t2", inviteCode: "CODE2222" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("CODE1234");
  });
});

// ─── GET /v1/teams/mine ─────────────────────────────────────────────────────

describe("GET /v1/teams/mine", () => {
  it("returns only the caller's memberships, with their team role folded in", async () => {
    const teams = new FakeTeams([team(), team({ id: "t2", name: "Team Two" })]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "LEAD", joinedAt: "2026-01-02T00:00:00.000Z" },
      { teamId: "t2", userId: "other", role: "BUILDER", joinedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const { app } = build({ teams, members });

    const res = await app.request("/v1/teams/mine", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { teams: Array<{ id: string; role: string }> };
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toMatchObject({ id: "t1", role: "LEAD" });
  });

  it("drops memberships whose team no longer exists instead of returning nulls", async () => {
    // The desktop "My Teams" view branches on whether this list is empty, so a null
    // entry would render a broken card rather than the join screen.
    const members = new FakeMembers([
      { teamId: "vanished", userId: "u1", role: "LEAD", joinedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const { app } = build({ teams: new FakeTeams([]), members });

    const res = await app.request("/v1/teams/mine", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({ teams: [] });
  });
});

// ─── GET /v1/teams/directory ─────────────────────────────────────────────────

/**
 * THE TEAMS DIRECTORY — the cross-workshop teams list, mirroring identity's
 * GET /v1/admin/users.
 *
 * Four things are pinned here, each of which type-checks and lints perfectly in its broken
 * form, and each of which was deliberately mutation-tested against a NAMED test in this block:
 *
 *   1. THE AUTHORIZATION, INCLUDING ITS NEGATIVE. The directory roles gate who may enumerate
 *      at all, and the owned-workshop SCOPE is what stops one facilitator reading another's
 *      teams. Dropping the scope leaves a route that returns 200 with plausible data — a
 *      cross-tenant leak that no type or lint rule can see.
 *   2. THE SEARCH IS APPLIED IN THE STORE. A route that dropped the needle would return
 *      everything, which on page 1 of a small table looks exactly like a working search.
 *   3. PAGINATION NEITHER LOSES NOR DUPLICATES A TEAM, and the cursor is stable.
 *   4. MEMBER COUNTS EXCLUDE INACTIVE MEMBERS. An inflated count reads as a working feature.
 */
describe("GET /v1/teams/directory", () => {
  /** Three teams across two workshops — w1 owned by f1, w2 owned by somebody else. */
  const directoryTeams = () =>
    new FakeTeams([
      team({ workshopId: "w1", id: "t1", name: "Team Phoenix" }),
      team({ workshopId: "w1", id: "t2", name: "Team Griffin" }),
      team({ workshopId: "w2", id: "t3", name: "Team Phoenix Rising" }),
    ]);

  /**
   * An owned-workshop scope covering BOTH of `directoryTeams()`'s workshops.
   *
   * ⚠ NEEDED BY EVERY ADMIN CASE BELOW. An admin's directory read used to be
   * UNRESTRICTED, so these tests — about SEARCH, CURSORS and MEMBER COUNTS rather than about
   * authorization — got all three rows for free. Scoped to what they own, an admin owning
   * nothing gets an empty page and those assertions would fail (or, worse, pass vacuously).
   *
   * BOTH workshops, so the visible row set is EXACTLY what it was before the change and each
   * test's real subject is untouched. A scope of just w1 would silently drop t3 and turn a
   * paging test into an authorization test.
   */
  const ownsBothWorkshops = () =>
    new FakeWorkshopDirectory([
      { id: "w1", name: "Workshop One" },
      { id: "w2", name: "Workshop Two" },
    ]);

  interface DirectoryBody {
    teams: Array<{
      id: string;
      name: string;
      workshopId: string;
      workshopName: string | null;
      memberCount: number | null;
      createdAt: string;
    }>;
    nextCursor?: string;
  }

  // ── 1. AUTHORIZATION ──────────────────────────────────────────────────────

  it("an ADMIN sees ONLY teams in workshops THEY OWN — not another owner's", async () => {
    /**
     * ⚠ THE EXACT OPPOSITE OF WHAT THIS PREVIOUSLY ASSERTED, AND IT CONTRADICTS THE
     * READ-MATRIX RULE ON PURPOSE. The old test read "an ADMIN sees EVERY team, across workshops they
     * do not own" and cited the read-matrix rule (an admin sees every workshop's teams and users,
     * including those other users created) as its justification, adding "w2 is somebody
     * else's workshop and must still appear".
     *
     * The admin-scoping rule replaced that: an admin sees no other experience's teams, scores
     * or anything else — except experiences the admin created. So ownership, not the
     * platform role, decides — and ⚠ THE READ-MATRIX RULE AS ORIGINALLY WRITTEN IS NOW WRONG
     * and the behaviour here supersedes it. Recorded here
     * because this test is the one a reader will hit first when they wonder what happened to it.
     *
     * THIS WAS THE WIDEST GRANT ON THE PLATFORM. `workshopIds` left undefined meant "no
     * restriction" at the store, so the response was every team in every experience owned by
     * anyone — with, on the sibling roster route, every member's email address.
     */
    const teams = directoryTeams();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectoryBody;
    expect(body.teams.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    // t3 is in w2, which this ADMIN does not own. Same assertion, word for word, as the
    // FACILITATOR case below — which is the point of the change.
    expect(body.teams.map((t) => t.id)).not.toContain("t3");
  });

  it("an ADMIN's page is SCOPED AT THE STORE — the unrestricted scan is gone", async () => {
    // ⚠ INVERTED. This asserted `workshopIds` UNDEFINED, reasoning that "the scope must be
    // ABSENT and not an empty array: an empty array means 'sees nothing' at the store, so
    // passing one for an ADMIN would return an empty directory". That reasoning is still true
    // ABOUT the store — which is exactly why an admin now gets a LIST rather than nothing:
    // absent and empty are still different, and an admin who owns nothing correctly sees
    // nothing.
    //
    // WHERE the restriction runs is the property worth keeping: at the STORE, not as a
    // post-filter in the route, so no out-of-scope row is ever read into this process.
    const teams = directoryTeams();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
    });

    await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(teams.directoryCalls).toHaveLength(1);
    expect(teams.directoryCalls[0].workshopIds).toEqual(["w1"]);
  });

  it("an ADMIN now MAKES the owned-workshop hop — and it still cannot recurse Team → Workshop → Team", async () => {
    /**
     * ⚠ INVERTED FROM `scopeCalls === 0`, AND THIS IS THE ONE WHERE THE INVERSION HAD TO BE
     * ARGUED RATHER THAN JUST APPLIED. The old test's reasoning was sound and is worth keeping
     * intact: `GET /v1/workshops` answers ADMIN and FACILITATOR from `listByOwner` with no hop,
     * but answers the other three roles by calling BACK into Team for `E(self)` — so a scope hop
     * on a path Workshop might itself be asking about is the cycle the no-scope-for-owners rule closes. Its
     * conclusion, "an ADMIN needs no scope, so it must not ask for one", is what expired.
     *
     * THE CYCLE IS STILL CLOSED, BUT FOR A DIFFERENT REASON, and the difference matters to
     * whoever touches this next. It used to be closed because the ADMIN branch made no call at
     * all. It is now closed because the CALLEE resolves BOTH owner roles locally from its own
     * row, and because `canReadDirectory` 403s JUDGE/EXECUTIVE/PARTICIPANT — the three roles
     * whose `GET /v1/workshops` DOES call back into Team — before any hop is issued.
     *
     * ⚠ SO THIS TEST IS NOW A TRIPWIRE ON A CROSS-SERVICE ASSUMPTION IT CANNOT SEE. If the
     * Workshop service ever stops answering an ADMIN locally, one hop becomes a cycle on a
     * single Lambda pool and nothing in THIS repo fails. The assertion below is that the hop
     * happens exactly ONCE per request, which is the most this side can check.
     */
    const workshopDirectory = new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]);
    const { app } = build({ teams: directoryTeams(), workshopDirectory });

    await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(workshopDirectory.scopeCalls).toBe(1);
    // And no name fan-out on top of it — the one hop carried both the scope and the names.
    expect(workshopDirectory.nameCalls).toEqual([]);
  });

  it("a FACILITATOR sees ONLY teams in workshops they own — NOT another owner's teams", async () => {
    // THE NEGATIVE, and the reason the scope exists. The read-matrix rule: "facilitors should see the
    // workshops they created not other facilitators created". Without the scope this route
    // hands one facilitator every other facilitator's team names and sizes.
    const teams = directoryTeams();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectoryBody;
    expect(body.teams.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    // t3 is in w2, which this facilitator does not own.
    expect(body.teams.map((t) => t.id)).not.toContain("t3");
  });

  it("passes the FACILITATOR's owned-workshop ids to the STORE, not a post-filter", async () => {
    // Where the restriction runs is the property, not just what it returns: identity's stated
    // rule is that the only method able to enumerate is also the one that applies the
    // restriction, so a future route cannot forget it. A post-filter in the route would also
    // have already shipped out-of-scope rows into this process.
    const teams = directoryTeams();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
    });

    await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(teams.directoryCalls[0].workshopIds).toEqual(["w1"]);
  });

  it("a FACILITATOR who owns NOTHING sees NOTHING — an empty scope is not 'unrestricted'", async () => {
    // The polarity that matters. An empty owned-workshop list must reach the store as "sees
    // nothing"; the other reading turns "owns no workshops" into "every team on the platform".
    const teams = directoryTeams();
    const { app } = build({ teams, workshopDirectory: new FakeWorkshopDirectory([]) });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f9", email: "f9@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as DirectoryBody).teams).toEqual([]);
    expect(teams.directoryCalls[0].workshopIds).toEqual([]);
  });

  it("403s every role outside the DIRECTORY set, without touching the store", async () => {
    // Deliberately NOT a filtered list, which is where this diverges from
    // /workshops/:workshopId/teams: "the teams you are on" is already /v1/teams/mine, and
    // answering it twice in two shapes is how two views drift. Refused BEFORE the store, so a
    // disqualified caller learns nothing about how many teams exist.
    // SOMETHING_NEW is in the list on purpose: canReadDirectory is an ALLOW-list, so a role
    // added to the platform without editing it is refused rather than admitted.
    for (const role of ["PARTICIPANT", "EXECUTIVE", "JUDGE", "SOMETHING_NEW"]) {
      const teams = directoryTeams();
      const { app } = build({ teams });

      const res = await app.request("/v1/teams/directory", {
        headers: asUser({ id: "u1", email: "u@example.com", role }),
      });

      expect(res.status, role).toBe(403);
      expect((await res.json()).error, role).toMatch(/cannot browse the teams directory/i);
      expect(teams.directoryCalls, role).toHaveLength(0);
    }
  });

  it("401s a request carrying NO role at all, before the route runs", async () => {
    // Refused one layer earlier than the 403 above, by edgeIdentityMiddleware: an empty role
    // header is not a trusted identity at all. Asserted separately so the two failure modes
    // stay distinguishable — a route-level 403 would mean the middleware had ADMITTED a
    // role-less caller, which is the more serious of the two.
    const teams = directoryTeams();
    const { app } = build({ teams });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "u1", email: "u@example.com", role: "" }),
    });

    expect(res.status).toBe(401);
    expect(teams.directoryCalls).toHaveLength(0);
  });

  it("503s — never an empty list — when a FACILITATOR's scope cannot be determined", async () => {
    // "Could not determine" returned as "you own nothing" is the defect class to avoid: a
    // fail-closed catch reporting an infrastructure fault as an authorization answer. An empty
    // directory is indistinguishable from a correct one, so it must not be the answer.
    const teams = directoryTeams();
    const { app } = build({
      teams,
      workshopDirectory: new FakeWorkshopDirectory("unavailable"),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    const body = (await res.json()) as { code?: string; teams?: unknown };
    expect(body.code).toBe("DIRECTORY_SCOPE_UNAVAILABLE");
    // And it did NOT fall through to a store read, which would be an unscoped enumeration.
    expect(teams.directoryCalls).toHaveLength(0);
  });

  it("requires an identity — an anonymous caller is 401'd before any store read", async () => {
    const teams = directoryTeams();
    const { app } = build({ teams });

    const res = await app.request("/v1/teams/directory");

    expect(res.status).toBe(401);
    expect(teams.directoryCalls).toHaveLength(0);
  });

  // ── 2. SERVER-SIDE SEARCH ─────────────────────────────────────────────────

  it("matches by team NAME, and the needle reaches the STORE", async () => {
    // In the store rather than over the loaded page: a client-side filter finds nobody past
    // page 1, which is wrong precisely when you are searching in order to act on something.
    const teams = directoryTeams();
    const { app } = build({ teams, workshopDirectory: ownsBothWorkshops() });

    const res = await app.request("/v1/teams/directory?search=griffin", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    const body = (await res.json()) as DirectoryBody;
    expect(body.teams.map((t) => t.id)).toEqual(["t2"]);
    // THE assertion this test exists for: a route that dropped the needle would return all
    // three teams, and on a three-row table that is indistinguishable from a working search.
    expect(teams.directoryCalls[0].search).toBe("griffin");
  });

  it("matches case-INSENSITIVELY, which DynamoDB's `contains` does not do on its own", async () => {
    const { app } = build({ teams: directoryTeams(), workshopDirectory: ownsBothWorkshops() });

    for (const needle of ["phoenix", "PHOENIX", "Phoenix", "PhOeNiX"]) {
      const res = await app.request(`/v1/teams/directory?search=${needle}`, {
        headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
      });
      const body = (await res.json()) as DirectoryBody;
      expect(body.teams.map((t) => t.id).sort(), needle).toEqual(["t1", "t3"]);
    }
  });

  it("ANDs the search with the workshop scope — search never widens what the scope allows", async () => {
    // "Team Phoenix Rising" matches the needle but lives in a workshop this facilitator does
    // not own. If search could widen the scope it would be a way to confirm that another
    // owner's team exists.
    const { app } = build({
      teams: directoryTeams(),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
    });

    const res = await app.request("/v1/teams/directory?search=phoenix", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    const body = (await res.json()) as DirectoryBody;
    expect(body.teams.map((t) => t.id)).toEqual(["t1"]);
  });

  it("TRUNCATES an over-long needle rather than refusing the search", async () => {
    // A search is a convenience over a list that is reachable unfiltered, so 400-ing a long
    // paste is the worse answer. The cap bounds what can be pushed into a store expression.
    const teams = directoryTeams();
    const { app } = build({ teams });

    const res = await app.request(`/v1/teams/directory?search=${"x".repeat(500)}`, {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(teams.directoryCalls[0].search).toHaveLength(100);
  });

  it("treats a whitespace-only needle as NO search rather than as a filter", async () => {
    const teams = directoryTeams();
    const { app } = build({ teams, workshopDirectory: ownsBothWorkshops() });

    const res = await app.request("/v1/teams/directory?search=%20%20", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(((await res.json()) as DirectoryBody).teams).toHaveLength(3);
    expect(teams.directoryCalls[0].search).toBeUndefined();
  });

  // ── 3. PAGINATION ─────────────────────────────────────────────────────────

  it("pages with a stable cursor, losing and duplicating NOTHING", async () => {
    const { app } = build({ teams: directoryTeams(), workshopDirectory: ownsBothWorkshops() });
    const headers = asUser({ id: "a1", email: "a@example.com", role: "ADMIN" });

    const seen: string[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that never terminates fails the test rather than hanging it.
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({ limit: "2" });
      if (cursor) qs.set("cursor", cursor);
      const res = await app.request(`/v1/teams/directory?${qs}`, { headers });
      const body = (await res.json()) as DirectoryBody;
      seen.push(...body.teams.map((t) => t.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeUndefined();
    // Every team exactly once — no gap at the page boundary, no repeat of the last row.
    expect(seen.sort()).toEqual(["t1", "t2", "t3"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns NO cursor on a complete last page, so 'Next' is not offered onto nothing", async () => {
    const { app } = build({ teams: directoryTeams(), workshopDirectory: ownsBothWorkshops() });

    const res = await app.request("/v1/teams/directory?limit=50", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    const body = (await res.json()) as DirectoryBody;
    expect(body.teams).toHaveLength(3);
    expect(body.nextCursor).toBeUndefined();
  });

  it("forwards the cursor OPAQUELY — it is never parsed or rebuilt in the route", async () => {
    const teams = directoryTeams();
    const { app } = build({ teams, workshopDirectory: ownsBothWorkshops() });
    const headers = asUser({ id: "a1", email: "a@example.com", role: "ADMIN" });

    const first = (await (
      await app.request("/v1/teams/directory?limit=1", { headers })
    ).json()) as DirectoryBody;
    await app.request(
      `/v1/teams/directory?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      { headers }
    );

    expect(teams.directoryCalls[1].cursor).toBe(first.nextCursor);
  });

  it("ignores a non-numeric limit instead of 400ing — the store clamps whatever it gets", async () => {
    // Same treatment as identity's /admin/users, for the stated reason: the value comes from a
    // URL and there is no unbounded read to protect against.
    const teams = directoryTeams();
    const { app } = build({ teams });

    const res = await app.request("/v1/teams/directory?limit=banana", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(teams.directoryCalls[0].limit).toBeUndefined();
  });

  // ── 4. MEMBER COUNTS ──────────────────────────────────────────────────────

  it("counts ACTIVE members only — an INACTIVE member is EXCLUDED", async () => {
    // The count means the LIVE team. It comes from `listByTeam`, the repository read that omits
    // deactivated rows, and NOT from a status filter written here — re-implementing the rule on
    // this route is how the two drift into disagreeing about what a roster is.
    const members = new FakeMembers([
      { teamId: "t1", userId: "live1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t1", userId: "live2", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      {
        teamId: "t1",
        userId: "removed",
        role: "BUILDER",
        joinedAt: "2026-01-01T00:00:00.000Z",
        status: "INACTIVE",
        removedAt: "2026-02-01T00:00:00.000Z",
        removedBy: "a1",
        removedByRole: "ADMIN",
      },
    ]);
    const { app } = build({ teams: directoryTeams(), members, workshopDirectory: ownsBothWorkshops() });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    const body = (await res.json()) as DirectoryBody;
    const t1 = body.teams.find((t) => t.id === "t1")!;
    // TWO, not three. A count of 3 means the inactive row was counted and a removed person is
    // being presented as a member.
    expect(t1.memberCount).toBe(2);
    // The row SURVIVES the removal, so this is a real exclusion rather than an absent row.
    expect(members.rows).toHaveLength(3);
  });

  it("reports a count of 0 for an empty team, and NULL when the roster could not be read", async () => {
    // Null and not 0: "we could not count" and "nobody is on this team" are different facts,
    // and 0 is a number an operator would act on.
    const members = new FakeMembers([]);
    const failing = Object.create(members) as FakeMembers;
    failing.listByTeam = async () => {
      throw new Error("throttled");
    };
    const { app } = build({ teams: directoryTeams(), members, workshopDirectory: ownsBothWorkshops() });

    const ok = (await (
      await app.request("/v1/teams/directory", {
        headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
      })
    ).json()) as DirectoryBody;
    expect(ok.teams.every((t) => t.memberCount === 0)).toBe(true);

    const { app: appFailing } = build({ teams: directoryTeams(), members: failing, workshopDirectory: ownsBothWorkshops() });
    const degraded = (await (
      await appFailing.request("/v1/teams/directory", {
        headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
      })
    ).json()) as DirectoryBody;
    // The page still lists every team — a count that cannot be read must not drop a row.
    expect(degraded.teams).toHaveLength(3);
    expect(degraded.teams.every((t) => t.memberCount === null)).toBe(true);
  });

  // ── ROW SHAPE ─────────────────────────────────────────────────────────────

  it("carries workshop name and created date, so a row needs no second call", async () => {
    // The name comes from the OWNERSHIP SCOPE now, not from a separate lookup — so it is the
    // first constructor argument rather than the second. Previously an admin's page was
    // unscoped and names had to be fanned out, which is what the `{ w1: "Workshop One" }` names
    // map here used to be for.
    const { app } = build({
      teams: new FakeTeams([team({ workshopId: "w1", id: "t1", name: "Team Phoenix" })]),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(((await res.json()) as DirectoryBody).teams[0]).toEqual({
      id: "t1",
      name: "Team Phoenix",
      workshopId: "w1",
      workshopName: "Workshop One",
      memberCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("carries a workshop name for EVERY listed row — the null-name state is now unreachable", async () => {
    /**
     * ⚠ REPLACES "renders an unresolvable workshop name as NULL and still lists the team". That
     * test constructed a page whose names had ALL failed to resolve and asserted the rows
     * survived with `workshopName: null` — best-effort by contract, so a Workshop brownout could
     * not take out a directory an operator opened during an incident.
     *
     * THE STATE IT DESCRIBED CANNOT BE REACHED THROUGH THIS ROUTE ANY MORE. Names arrive in the
     * SAME hop as the authorization scope, and the scope is what decides which rows appear — so
     * a row can only be on the page if its workshop was in the scope, and every scope entry
     * carries its name. There is no separate lookup left to fail.
     *
     * ⚠ THE ROUTE STILL RENDERS `?? null`, AND THAT IS DELIBERATE DEFENSIVE CODE rather than a
     * live path: a team row whose `workshopId` is absent (the cleared-workshop state) would land
     * there. Not asserted through the route because the store filter cannot return such a row
     * for a scoped caller — noted so nobody deletes the fallback thinking it is dead.
     */
    const { app } = build({
      teams: directoryTeams(),
      workshopDirectory: ownsBothWorkshops(),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    const body = (await res.json()) as DirectoryBody;
    expect(body.teams).toHaveLength(3);
    expect(body.teams.every((t) => t.workshopName !== null)).toBe(true);
    expect(body.teams.every((t) => t.workshopId !== "")).toBe(true);
  });

  it("makes NO name fan-out for an ADMIN — their scope hop already returned names", async () => {
    /**
     * ⚠ REPLACES "DEDUPLICATES the workshop-name fan-out and bounds it", which asserted exactly
     * ONE `resolveWorkshopNames` call carrying `["w1","w2"]` — two teams in one workshop costing
     * one lookup rather than two.
     *
     * There is no fan-out to deduplicate now: the ADMIN branch that needed it is gone, so this
     * becomes the same assertion the FACILITATOR case below has always made. Both owner roles,
     * one hop, no name probe — which also closes the existence oracle a per-id name lookup
     * represents (see authz-attack.test.ts).
     */
    const workshopDirectory = ownsBothWorkshops();
    const { app } = build({ teams: directoryTeams(), workshopDirectory });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(workshopDirectory.nameCalls).toEqual([]);
    // ONE hop total, and the names came back on it.
    expect(workshopDirectory.scopeCalls).toBe(1);
    const body = (await res.json()) as DirectoryBody;
    expect(body.teams.map((t) => t.workshopName).sort()).toEqual([
      "Workshop One",
      "Workshop One",
      "Workshop Two",
    ]);
  });

  it("makes NO name fan-out for a FACILITATOR — their scope hop already returned names", async () => {
    const workshopDirectory = new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]);
    const { app } = build({ teams: directoryTeams(), workshopDirectory });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(workshopDirectory.nameCalls).toHaveLength(0);
    const body = (await res.json()) as DirectoryBody;
    expect(body.teams.every((t) => t.workshopName === "Workshop One")).toBe(true);
  });

  it("makes no name fan-out for an EMPTY page", async () => {
    const workshopDirectory = new FakeWorkshopDirectory([], { w1: "Workshop One" });
    const { app } = build({ teams: new FakeTeams([]), workshopDirectory });

    await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(workshopDirectory.nameCalls).toHaveLength(0);
  });

  it("does NOT leak the invite code — a live credential has no business on a list", async () => {
    // The Team row carries `inviteCode`, and anyone holding one plus an invitation can join.
    // The projection is explicit field-by-field rather than a spread precisely so a new column
    // on Team cannot arrive on this list by accident.
    const { app } = build({ teams: directoryTeams() });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(JSON.stringify(await res.json())).not.toContain("CODE1234");
  });
});

// ─── GET /v1/teams/:teamId/members ──────────────────────────────────────────

describe("GET /v1/teams/:teamId/members", () => {
  it("enriches members from the LOCAL users read-model and falls back to 'Unknown'", async () => {
    // Names come from the event-synced read-model, never a cross-service read of
    // Identity's users table. A member the read-model hasn't caught up on yet must
    // still appear — just without a name.
    const members = new FakeMembers([
      { teamId: "t1", userId: "known", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t1", userId: "unsynced", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "known", name: "Ada Lovelace", email: "ada@example.com" },
    ]);
    const { app } = build({ members, users });

    const res = await app.request("/v1/teams/t1/members", {
      headers: asUser({ id: "known", email: "ada@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      members: Array<{ userId: string; user: { name: string; email?: string } }>;
    };
    expect(body.members).toEqual([
      expect.objectContaining({ user: { id: "known", name: "Ada Lovelace", email: "ada@example.com" } }),
      expect.objectContaining({ user: { id: "unsynced", name: "Unknown", email: undefined } }),
    ]);
  });

  /**
   * ── THE ROSTER IS THE ONE SURFACE THAT SHOWS INACTIVE MEMBERS. THAT IS THE POINT. ──
   *
   * Owner: "we shouldnt remove the user from the list ... show it in the members list to show
   * he was joined but later removed". This route reads `listByTeamIncludingInactive` — the
   * DANGEROUS-BY-NAME variant — and it is the ONLY caller of it. Every other reader of the
   * roster (member counts, the `?withMembers=1` fan-out, the workshop roster, the directory's
   * id resolution) keeps the ACTIVE-ONLY default, and other tests below pin that asymmetry.
   *
   * The four added fields are the FROZEN CONTRACT the portal is built against:
   *   status: "ACTIVE" | "INACTIVE"   — always present, never absent
   *   removedAt: string | null
   *   removedByName: string | null    — null when not visible to the caller
   *   removedByRole: string | null
   */
  const ROSTER_ACTIVE: TeamMember = {
    teamId: "t1",
    userId: "live",
    role: "BUILDER",
    joinedAt: "2026-08-01T00:00:00.000Z",
  };
  const ROSTER_REMOVED: TeamMember = {
    teamId: "t1",
    userId: "gone",
    role: "LEAD",
    joinedAt: "2026-08-02T00:00:00.000Z",
    status: "INACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "fac",
    removedByRole: "FACILITATOR",
  };
  const ROSTER_USERS = [
    { id: "live", name: "Ada Lovelace", email: "ada@example.com" },
    { id: "gone", name: "Removed Person", email: "gone@example.com" },
    { id: "fac", name: "Facilitator One", email: "f@example.com" },
  ];

  const roster = async (
    identity: { id: string; email?: string; role: string },
    members: TeamMember[]
  ) => {
    const { app } = build({
      members: new FakeMembers(members),
      users: new FakeUsers(ROSTER_USERS),
      workshops: new FakeWorkshops(true),
    });
    const res = await app.request("/v1/teams/t1/members", {
      headers: asUser(identity),
    });
    return (await res.json()) as { members: RosterRow[] };
  };

  interface RosterRow {
    userId: string;
    role: string;
    status: string;
    removedAt: string | null;
    removedByName: string | null;
    removedByRole: string | null;
    /** Present ONLY for a caller who may see that account — see the projection tests below. */
    removedBy?: string;
    reactivatedAt?: string;
    user: { id: string; name: string; email?: string };
  }

  it("LISTS a removed member, with the removal metadata the Reactivate action needs", async () => {
    // The requirement, directly. An inactive member appears WITH current state, which
    // is exactly what an audit entry cannot carry — the trail records that an act happened, it
    // cannot be reactivated. This row is what a Reactivate button can act on.
    const body = await roster({ id: "fac", email: "f@example.com", role: "FACILITATOR" }, [
      ROSTER_ACTIVE,
      ROSTER_REMOVED,
    ]);

    expect(body.members.map((m) => m.userId)).toEqual(["live", "gone"]);

    const [live, gone] = body.members;
    expect(live).toMatchObject({
      status: "ACTIVE",
      // NULL on an active member, not absent and not a stale value: there is no removal.
      removedAt: null,
      removedByName: null,
      removedByRole: null,
    });
    expect(gone).toMatchObject({
      status: "INACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedByName: "Facilitator One",
      removedByRole: "FACILITATOR",
    });
    // The PRESERVED TEAM ROLE survives on the inactive row — this is what reactivation
    // restores, and the hard delete used to destroy it.
    expect(gone.role).toBe("LEAD");
    // Still enriched like any other member, so the UI renders a name and not an id.
    expect(gone.user).toMatchObject({ name: "Removed Person", email: "gone@example.com" });
  });

  it("normalises an ABSENT status to ACTIVE — the closed union the contract promises", async () => {
    // Every membership row written before this field existed carries NO status attribute. The
    // contract types it `"ACTIVE" | "INACTIVE"`, so the route must normalise rather than pass
    // undefined through: a client branching on a possibly-undefined string is a client that
    // renders a legacy member as neither. And absence means ACTIVE, which is what it IS —
    // reading it as INACTIVE would show the whole platform as removed.
    expect(ROSTER_ACTIVE.status).toBeUndefined();
    const body = await roster({ id: "live", email: "ada@example.com", role: "PARTICIPANT" }, [
      ROSTER_ACTIVE,
    ]);
    expect(body.members[0].status).toBe("ACTIVE");
  });

  it("HIDES the removing ADMIN's NAME from a FACILITATOR, but still discloses the ROLE", async () => {
    // The same visibility matrix former-members honours, applied to the one field on this
    // route that names another account. Removals are performed by staff and this platform's
    // only ADMIN performs most administrative acts, so resolving the actor unconditionally
    // would print that admin's name onto rows a facilitator is looking at — the reconnaissance
    // USER_VISIBILITY_GRANTS exists to prevent. The ROLE is still disclosed: "removed by an
    // Admin" names no account, and suppressing it would leave a row that says a removal
    // happened and refuses to say by whom in any form.
    const removedByAdmin: TeamMember = {
      ...ROSTER_REMOVED,
      removedBy: "boss",
      removedByRole: "ADMIN",
    };
    const body = await roster({ id: "fac", email: "f@example.com", role: "FACILITATOR" }, [
      removedByAdmin,
    ]);

    expect(body.members[0]).toMatchObject({
      status: "INACTIVE",
      removedByName: null,
      removedByRole: "ADMIN",
    });
  });

  it("shows the removing ADMIN's name to another ADMIN", async () => {
    // The other side of the matrix, so the test above cannot pass by hiding every actor.
    const body = await roster({ id: "boss", email: "b@example.com", role: "ADMIN" }, [
      { ...ROSTER_REMOVED, removedBy: "fac", removedByRole: "FACILITATOR" },
    ]);
    expect(body.members[0].removedByName).toBe("Facilitator One");
  });

  it("keeps the roster intact when the removing actor has no read-model row", async () => {
    // Best-effort resolution: a staff account deleted since must leave the member on the
    // roster with an unresolved actor name, never drop the member. The removal is the fact;
    // the name is decoration on it.
    const body = await roster({ id: "boss", email: "b@example.com", role: "ADMIN" }, [
      { ...ROSTER_REMOVED, removedBy: "vanished", removedByRole: "FACILITATOR" },
    ]);
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({
      removedByName: null,
      removedByRole: "FACILITATOR",
    });
  });

  /**
   * ── THE PROJECTION IS ENUMERATED, SO THE NAME SUPPRESSION IS NOT DEFEATED BESIDE ITSELF ──
   *
   * This route used to build its row as `{ ...m, ... }`. The spread carried every attribute of
   * the STORED membership row, so a caller refused the removing ADMIN's NAME was handed that
   * admin's raw Cognito SUB in the same JSON object — the correlatable, never-changing identifier
   * USER_VISIBILITY_GRANTS exists to withhold. `reactivatedBy` was worse: no `reactivatedByRole`
   * exists to gate on, and this route admits any MEMBER, so a PARTICIPANT could read it.
   *
   * The corresponding DEFECT tests in authz-attack.test.ts asserted both leaks. They now FAIL,
   * which is the correct outcome; these are the positive assertions.
   *
   * A SPREAD IS AN ALLOWLIST THAT GROWS SILENTLY, which is the general rule these tests pin: the
   * exact-key assertion below fails when a future attribute on TeamMember starts reaching this
   * response without anyone deciding it should.
   */
  it("carries NO removedBy for a FACILITATOR reading an ADMIN's removal, while an ADMIN gets it", async () => {
    // THE test for this fix, both directions of the matrix so it cannot pass by omitting the
    // field from everybody.
    const removedByAdmin: TeamMember = {
      ...ROSTER_REMOVED,
      removedBy: "boss",
      removedByRole: "ADMIN",
    };

    const asFacilitator = await roster(
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      [removedByAdmin]
    );
    const hidden = asFacilitator.members[0];
    expect(hidden.removedByName).toBeNull();
    // ABSENT, not null: an absent key cannot be mistaken for a value, and the identifier is not
    // anywhere in the serialised row either.
    expect(Object.keys(hidden)).not.toContain("removedBy");
    expect(JSON.stringify(hidden)).not.toContain("boss");
    // The ROLE is still disclosed — "removed by an Admin" names no account.
    expect(hidden.removedByRole).toBe("ADMIN");

    const asAdmin = await roster({ id: "boss", email: "b@example.com", role: "ADMIN" }, [
      { ...ROSTER_REMOVED, removedBy: "fac", removedByRole: "FACILITATOR" },
    ]);
    const shown = asAdmin.members[0];
    // A caller entitled to the account gets BOTH, from the SAME gate — so the name and the id can
    // never disagree about who is visible.
    expect(shown.removedByName).toBe("Facilitator One");
    expect(shown.removedBy).toBe("fac");
  });

  it("NEVER carries reactivatedBy — not for a PARTICIPANT, not for an ADMIN", async () => {
    // Omitted for EVERY caller, because it cannot be gated: there is deliberately no
    // `reactivatedByRole` on the row (domain.ts: "no surface renders it"), so there is no stored
    // historical role to decide visibility from. The PARTICIPANT case is the widest audience —
    // requireTeamRead admits any member of the team.
    const restoredByAdmin: TeamMember = {
      teamId: "t1",
      userId: "gone",
      role: "LEAD",
      joinedAt: "2026-08-02T00:00:00.000Z",
      status: "ACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "boss",
      removedByRole: "ADMIN",
      reactivatedAt: "2026-08-05T10:00:00.000Z",
      reactivatedBy: "boss",
    };

    for (const caller of [
      { id: "live", email: "ada@example.com", role: "PARTICIPANT" },
      { id: "boss", email: "b@example.com", role: "ADMIN" },
    ]) {
      const body = await roster(caller, [ROSTER_ACTIVE, restoredByAdmin]);
      const row = body.members.find((m) => m.userId === "gone")!;
      expect(Object.keys(row), caller.role).not.toContain("reactivatedBy");
      // `reactivatedAt` is a TIMESTAMP, not an identifier, so it stays for everybody.
      expect(row.reactivatedAt, caller.role).toBe("2026-08-05T10:00:00.000Z");
    }
  });

  it("ships EXACTLY the enumerated fields — a new stored attribute cannot leak in silently", async () => {
    // THE GUARD ON THE RULE, not just on today's two identifiers. A future field added to
    // TeamMember reaches this response only if someone adds it HERE, and this assertion is what
    // makes forgetting that a failing test rather than a silent disclosure. Modelled on the
    // former-members contract test, which has always pinned its key set.
    //
    // A row carrying EVERY optional attribute, read by a caller who may see none of them.
    const everything: TeamMember = {
      teamId: "t1",
      userId: "gone",
      role: "LEAD",
      joinedAt: "2026-08-02T00:00:00.000Z",
      status: "INACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "boss",
      removedByRole: "ADMIN",
      reactivatedAt: "2026-08-03T10:00:00.000Z",
      reactivatedBy: "boss",
    };

    const body = await roster({ id: "fac", email: "f@example.com", role: "FACILITATOR" }, [everything]);
    expect(Object.keys(body.members[0]).sort()).toEqual([
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
    // No operator sub anywhere in the payload, under any key.
    expect(JSON.stringify(body.members[0])).not.toContain("boss");  // nosemgrep: no-stringify-keys
  });

  it("keeps the FROZEN CONTRACT's fields for a caller who may see the actor", async () => {
    // The other half of the exact-key assertion: enumerating must not have DROPPED anything the
    // portal reads. `removedBy` joins the set for an entitled caller and nothing else changes.
    const body = await roster({ id: "boss", email: "b@example.com", role: "ADMIN" }, [ROSTER_REMOVED]);
    expect(Object.keys(body.members[0]).sort()).toEqual([
      "joinedAt",
      "removedAt",
      "removedBy",
      "removedByName",
      "removedByRole",
      "role",
      "status",
      "teamId",
      "user",
      "userId",
    ]);
    // And the values the portal's roster and Reactivate action are built against are unchanged.
    expect(body.members[0]).toMatchObject({
      teamId: "t1",
      userId: "gone",
      role: "LEAD",
      joinedAt: "2026-08-02T00:00:00.000Z",
      status: "INACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedByName: "Facilitator One",
      removedByRole: "FACILITATOR",
    });
    expect(body.members[0].user).toMatchObject({
      id: "gone",
      name: "Removed Person",
      email: "gone@example.com",
    });
  });

  it("omits reactivatedAt entirely on a row that was never restored", async () => {
    // Spread-or-omit reproduces exactly what the old spread emitted — present when set, absent
    // otherwise. Deliberately NOT normalised to null like `removedAt`: that would add a key to
    // every row of a frozen contract, which this fix's job was not.
    const body = await roster({ id: "fac", email: "f@example.com", role: "FACILITATOR" }, [
      ROSTER_ACTIVE,
    ]);
    expect(Object.keys(body.members[0])).not.toContain("reactivatedAt");
  });
});

/**
 * ── THE SAME DEFECT ON THE LIVE-ROSTER LOADER, WHICH HAD THE WIDER AUDIENCE ──
 *
 * `loadTeamMembers` — the ACTIVE-ONLY loader behind the `?withMembers=1` fan-out — also built its
 * rows with `{ ...m }`, and the reason that looked safe was `listByTeam`: an INACTIVE row is
 * refused at the repository, so a removed member's metadata never reaches it.
 *
 * REACTIVATION IS THE CASE THAT DEFEATS THAT ARGUMENT. Restoring a membership flips `status` back
 * to ACTIVE and deliberately does NOT clear the removal breadcrumb (domain.ts: the row says
 * "restored then removed again", which is true, and `status` is the only field that says what
 * holds NOW). So a restored row is ACTIVE, passes the filter, and arrived carrying `removedBy` and
 * `reactivatedBy` — two raw operator subs.
 *
 * AND THIS ROUTE'S AUDIENCE IS WIDER THAN THE ROSTER'S. The fan-out's member-filtered branch
 * admits any PARTICIPANT to the teams they are on, so a participant on a team with one restored
 * member could read the subs of the operators who removed and restored them. Unlike the roster
 * there was no gate being contradicted here, because this path applies none at all.
 *
 * THE FIX IS OMISSION RATHER THAN A GATE, and these tests pin that: a LIVE roster has no reason to
 * carry removal history for anyone, so the fields are ABSENT for every caller and there is no
 * per-caller decision to get wrong. An absent key discloses nothing, not even that something is
 * being withheld.
 */
describe("GET /v1/workshops/:workshopId/teams?withMembers=1 — the live-roster projection", () => {
  /**
   * A REACTIVATED membership, exactly as the store leaves one: ACTIVE again, with BOTH
   * breadcrumbs still on the row. Written as a literal rather than by calling deactivate() +
   * reactivate() so the fixture states the stored shape being defended against, and cannot be
   * quietly narrowed by a change to the fake's write path.
   */
  const RESTORED: TeamMember = {
    teamId: "t1",
    userId: "u-restored",
    role: "LEAD",
    joinedAt: "2026-08-01T00:00:00.000Z",
    status: "ACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "boss",
    removedByRole: "ADMIN",
    reactivatedAt: "2026-08-05T10:00:00.000Z",
    reactivatedBy: "fac",
  };
  const NEVER_REMOVED: TeamMember = {
    teamId: "t1",
    userId: "u-plain",
    role: "BUILDER",
    joinedAt: "2026-08-02T00:00:00.000Z",
  };
  const WITH_MEMBERS_USERS = [
    { id: "u-restored", name: "Ada Lovelace", email: "ada@example.com" },
    { id: "u-plain", name: "Grace Hopper", email: "grace@example.com" },
    { id: "boss", name: "Root Admin", email: "boss@example.com" },
    { id: "fac", name: "Facilitator One", email: "f@example.com" },
  ];

  interface FanOutRow {
    teamId: string;
    userId: string;
    role: string;
    joinedAt: string;
    status: string;
    user: { id: string; name: string; email?: string };
  }

  /** Returns the RAW body text too — the leak assertions must hold on the wire, not on a parse. */
  const fanOut = async (
    identity: { id: string; email?: string; role: string },
    members: TeamMember[],
    ownsWorkshop = false
  ) => {
    const { app } = build({
      teams: new FakeTeams([team({ id: "t1" })]),
      members: new FakeMembers(members),
      users: new FakeUsers(WITH_MEMBERS_USERS),
      workshops: new FakeWorkshops(ownsWorkshop),
    });
    const res = await app.request("/v1/workshops/w1/teams?withMembers=1", {
      headers: asUser(identity),
    });
    const raw = await res.text();
    return {
      res,
      raw,
      body: JSON.parse(raw) as {
        teams: Array<{
          id: string;
          members: FanOutRow[];
          _count: { members: number };
        }>;
      },
    };
  };

  it("leaks NO operator sub to a PARTICIPANT on a team with a REACTIVATED member", async () => {
    // THE SPECIFIC REACHABLE CASE. A participant who is a MEMBER of t1 — so the member-filtered
    // branch returns the team rather than 403-ing — reading a team that contains one restored
    // membership. This is the exact request the portal's workshop.getById fan-out makes on that
    // participant's own team pages, with no elevated privilege anywhere in it.
    const { res, raw, body } = await fanOut(
      { id: "u-plain", email: "grace@example.com", role: "PARTICIPANT" },
      [RESTORED, NEVER_REMOVED]
    );

    expect(res.status).toBe(200);
    expect(body.teams.map((t) => t.id)).toEqual(["t1"]);

    const restored = body.teams[0].members.find((m) => m.userId === "u-restored")!;
    // ABSENT, not null: the caller cannot even tell removal metadata exists on this row.
    expect(Object.keys(restored)).not.toContain("removedBy");
    expect(Object.keys(restored)).not.toContain("removedByRole");
    expect(Object.keys(restored)).not.toContain("removedAt");
    expect(Object.keys(restored)).not.toContain("reactivatedBy");
    expect(Object.keys(restored)).not.toContain("reactivatedAt");
    // NOWHERE IN THE PAYLOAD, under any key or nesting — the check the spread failed. Both subs:
    // "boss" removed and "fac" restored, and a participant is entitled to neither account.
    expect(raw).not.toContain("boss");
    expect(raw).not.toContain('"fac"');
    // And no operator's NAME rode in either — nothing on this path resolves an actor at all.
    expect(raw).not.toContain("Root Admin");
    expect(raw).not.toContain("Facilitator One");
  });

  it("keeps EXACTLY the fields the portal and desktop read on a restored row", async () => {
    // The other half: enumerating must not have DROPPED anything a consumer reads. Grepped
    // before choosing the list — the portal's workshop detail page reads `_count.members`,
    // `m.userId`, `m.role` and `m.user.{name,email}`; its PeopleTab reads the same plus
    // `team.name`; the desktop BoardView types Member as `{ userId, user: { id, name }, role }`.
    // `teamId`, `joinedAt` and `status` are kept because they crossed the boundary before.
    const { body } = await fanOut(
      { id: "u-plain", email: "grace@example.com", role: "PARTICIPANT" },
      [RESTORED, NEVER_REMOVED]
    );

    const restored = body.teams[0].members.find((m) => m.userId === "u-restored")!;
    expect(Object.keys(restored).sort()).toEqual([
      "joinedAt",
      "role",
      "status",
      "teamId",
      "user",
      "userId",
    ]);
    expect(restored).toMatchObject({
      teamId: "t1",
      userId: "u-restored",
      // THE PRESERVED TEAM ROLE. A restored LEAD is still a LEAD, and the fan-out renders it.
      role: "LEAD",
      joinedAt: "2026-08-01T00:00:00.000Z",
      status: "ACTIVE",
    });
    // Enriched from the read-model like any other member, so the UI shows a name not an id.
    // Email OMITTED: this is the member-filtered branch, which is not entitled to addresses.
    expect(restored.user).toEqual({ id: "u-restored", name: "Ada Lovelace" });
    // The count is the array length and the restored member is genuinely ACTIVE, so they count.
    expect(body.teams[0]._count).toEqual({ members: 2 });
  });

  it("carries the SAME key set for an ADMIN — the omission is unconditional, not a gate", async () => {
    // No `callerRole` is threaded into this projection, deliberately: a LIVE roster has no reason
    // to disclose removal history to ANYBODY, so there is no per-caller decision that could be
    // got wrong. Asserted from the most privileged caller, who would be the one to receive the
    // fields if a gate had been added instead — and who still does not.
    // `true` = owns w1. Required because an admin who does not own the experience
    // gets a FILTERED list rather than the roster, so the "most privileged caller" this test
    // needs is now an OWNING admin.
    const { raw, body } = await fanOut(
      { id: "boss", email: "boss@example.com", role: "ADMIN" },
      [RESTORED, NEVER_REMOVED],
      true
    );

    const restored = body.teams[0].members.find((m) => m.userId === "u-restored")!;
    // THE SAME SIX KEYS a PARTICIPANT got. The one field this route does vary by caller is
    // EMAIL, and it varies inside `user` — which is where the minimisation switch has always
    // lived, and is asserted immediately below.
    expect(Object.keys(restored).sort()).toEqual([
      "joinedAt",
      "role",
      "status",
      "teamId",
      "user",
      "userId",
    ]);
    expect(restored.user).toEqual({
      id: "u-restored",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    // The removal breadcrumb is still absent, and the restoring operator's sub is not in the
    // payload — an ADMIN who needs to know who restored a membership reads the AUDIT TRAIL,
    // which carries the actor AND their role at the time and is directory-gated.
    expect(Object.keys(restored)).not.toContain("removedBy");
    expect(Object.keys(restored)).not.toContain("reactivatedBy");
    expect(raw).not.toContain('"fac"');
  });

  it("normalises status so the KEY's presence is not itself a removal breadcrumb", async () => {
    // THE SUBTLE HALF OF THE SAME LEAK. A never-removed row carries NO status attribute, while a
    // RESTORED one carries the literal "ACTIVE" — so forwarding `m.status` would have made the
    // mere PRESENCE of the key say "this membership was removed and restored", disclosing the
    // fact without disclosing the field. Both rows must be INDISTINGUISHABLE in shape here.
    expect(NEVER_REMOVED.status).toBeUndefined();
    expect(RESTORED.status).toBe("ACTIVE");

    const { body } = await fanOut(
      { id: "u-plain", email: "grace@example.com", role: "PARTICIPANT" },
      [RESTORED, NEVER_REMOVED]
    );

    const rows = body.teams[0].members;
    expect(rows.map((m) => m.status)).toEqual(["ACTIVE", "ACTIVE"]);
    // Identical key sets, so nothing about a row's history is inferable from its shape.
    const [a, b] = rows.map((m) => Object.keys(m).sort().join(","));
    expect(a).toBe(b);
  });
});

/**
 * ── COUNTS AND EVERY OTHER ROSTER READER EXCLUDE INACTIVE MEMBERS ──
 *
 * The asymmetry that makes the change safe: exactly ONE route shows inactive members, and
 * every other reader keeps `listByTeam`'s active-only default. A removed person appearing in a
 * COUNT would be a regression of the hard delete's one genuinely good property — and counts
 * are derived from the array length, so a route switched to the IncludingInactive variant
 * inflates them silently.
 */
describe("inactive members are excluded from counts and every other roster reader", () => {
  const LIVE: TeamMember = {
    teamId: "t1",
    userId: "live",
    role: "BUILDER",
    joinedAt: "2026-08-01T00:00:00.000Z",
  };
  const REMOVED: TeamMember = {
    teamId: "t1",
    userId: "gone",
    role: "BUILDER",
    joinedAt: "2026-08-02T00:00:00.000Z",
    status: "INACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "fac",
    removedByRole: "FACILITATOR",
  };

  it("the WORKSHOP ROSTER counts and lists only ACTIVE members", async () => {
    // `_count.members` is `members.length`, so this asserts both at once. A facilitator
    // planning a workshop reading "2 members" for a team of 1 is the visible bug.
    const { app } = build({
      teams: new FakeTeams([team({ id: "t1" })]),
      members: new FakeMembers([LIVE, REMOVED]),
      users: new FakeUsers([
        { id: "live", name: "Ada", email: "ada@example.com" },
        { id: "gone", name: "Removed", email: "gone@example.com" },
      ]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/workshops/w1/teams?withMembers=1", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    const body = (await res.json()) as {
      teams: Array<{
        id: string;
        members: Array<{ userId: string }>;
        _count: { members: number };
      }>;
    };
    expect(body.teams[0]._count.members).toBe(1);
    expect(body.teams[0].members.map((m) => m.userId)).toEqual(["live"]);
  });

  it("GET /teams/mine omits a team the caller was REMOVED from", async () => {
    // `listByUser` is filtered for the same reason `get` is: this is "teams this person is
    // on", and a team they were removed from is not one. Leaving it in would put a team on
    // their own home screen that every content surface then 403s them from — a worse
    // experience than not showing it, and a support ticket rather than a lockout report.
    const { app } = build({
      teams: new FakeTeams([team({ id: "t1" }), team({ id: "t2", inviteCode: "CODE2" })]),
      members: new FakeMembers([
        { ...REMOVED, userId: "u1" },
        { teamId: "t2", userId: "u1", role: "BUILDER", joinedAt: "2026-08-01T00:00:00.000Z" },
      ]),
    });

    const res = await app.request("/v1/teams/mine", {
      headers: asUser({ id: "u1", email: "u1@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { teams: Array<{ id: string }> };
    expect(body.teams.map((t) => t.id)).toEqual(["t2"]);
  });

  it("the WORKSHOP MEMBERSHIP probe reports NOT a member after a removal", async () => {
    // The membership branch of the Workshop service's read gate. It reads `listByUser`, so an
    // unfiltered version would keep a removed person entitled to the whole workshop.
    const { app } = build({
      teams: new FakeTeams([team({ id: "t1" })]),
      members: new FakeMembers([{ ...REMOVED, userId: "u1" }]),
    });

    const res = await app.request("/v1/workshops/w1/membership", {
      headers: asUser({ id: "u1", email: "u1@example.com", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toMatchObject({ isMember: false });
  });
});

// ─── AUTHORIZATION: the invitation privilege-escalation boundary ─────────────

/**
 * These tests exist because `POST /v1/teams/:teamId/invitations` once took
 * `platformRole` straight from the request body with NO authorization check, and
 * `GET` of the roster/invitations plus `DELETE` of a member had no check either.
 *
 * Why that was severe rather than untidy: an invitation row is the authoritative
 * input to the Cognito PRE-SIGNUP trigger (which decides who may register at all)
 * and the POST-CONFIRMATION trigger (which assigns the Cognito GROUP). Writing
 * `platformRole: "ADMIN"` therefore *grants* admin. Any authenticated user —
 * including a PARTICIPANT who belongs to no team — could mint that row for an
 * address they controlled and register a second, fully privileged account. The
 * route is browser-reachable: the all-in-one template maps it `Method: ANY` under
 * the default Cognito JWT authorizer, so "authenticated" was the only barrier.
 *
 * Each test below is written to FAIL against the unguarded implementation.
 */

const MEMBER_T1 = (userId: string): TeamMember => ({
  teamId: "t1",
  userId,
  role: "BUILDER",
  joinedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * A caller who IS a member of t1 — isolates the role matrix from membership.
 *
 * `ownsWorkshops` exists for the JUDGE row of the workshop matrix (gate 4): a JUDGE
 * invitation must name a workshop the caller is ENTITLED to, so a test that only wants
 * to prove the ROLE matrix lets a facilitator grant JUDGE has to satisfy that too.
 * Defaulted to false so it is opt-in and no existing test silently gains ownership.
 */
function buildWithMember(userId: string, ownsWorkshops = false) {
  const invitations = new FakeInvitations([]);
  const { app } = build({
    members: new FakeMembers([MEMBER_T1(userId)]),
    invitations,
    workshops: new FakeWorkshops(ownsWorkshops),
  });
  return { app, invitations };
}

/**
 * The workshop a role-matrix test must name, if any — gate 4's REQUIRED column.
 *
 * Derived from the role rather than spelled out per call so the matrix sweeps stay
 * sweeps: adding a role to `WORKSHOP_POLICY`'s REQUIRED set means adding it here, not
 * rewriting every loop. "w1" is `team()`'s workshop throughout this file.
 */
const workshopArgFor = (platformRole: string) =>
  platformRole === "JUDGE" ? { workshopId: "w1" } : {};

/**
 * The SCOPE a role-matrix test must invite at — requirement (b)'s counterpart to
 * workshopArgFor above.
 *
 * ADMIN, FACILITATOR and JUDGE may not hold a team-membership row, so a TEAM-scoped
 * invitation for one of them is now a 400. They are invited at the PLATFORM sentinel;
 * EXECUTIVE and PARTICIPANT keep the real team.
 *
 * Derived from the role rather than spelled out per call, for the same reason
 * workshopArgFor is: the matrix sweeps stay sweeps, and adding a role to
 * TEAM_MEMBERSHIP_DENIED_ROLES means changing this one line rather than rewriting every
 * loop. Mirrors PLATFORM_SCOPED_ROLES / mayHoldTeamMembership deliberately — if the two
 * ever disagree, these sweeps fail, which is the point.
 */
const scopeFor = (platformRole: string) =>
  ["ADMIN", "FACILITATOR", "JUDGE"].includes(platformRole) ? "PLATFORM" : "t1";

function invitePost(
  app: ReturnType<typeof build>["app"],
  identity: { id: string; email?: string; role: string },
  body: unknown
) {
  return app.request("/v1/teams/t1/invitations", {
    method: "POST",
    headers: asUser(identity),
    body: JSON.stringify(body),
  });
}

/** invitePost, at the scope the GRANTED role requires. See scopeFor above. */
function invitePostAtScope(
  app: ReturnType<typeof build>["app"],
  identity: { id: string; email?: string; role: string },
  platformRole: string,
  body: Record<string, unknown>
) {
  return app.request(`/v1/teams/${scopeFor(platformRole)}/invitations`, {
    method: "POST",
    headers: asUser(identity),
    body: JSON.stringify(body),
  });
}

describe("POST invitations — who may grant which platform role", () => {
  it("REFUSES a PARTICIPANT outright: they may not invite even another participant", async () => {
    // The closed case. A participant grants nothing at all, so this is refused
    // before the body's roles are even considered.
    const { app, invitations } = buildWithMember("p1");

    const res = await invitePost(
      app,
      { id: "p1", email: "p@example.com", role: "PARTICIPANT" },
      { emails: ["friend@example.com"], platformRole: "PARTICIPANT" }
    );

    expect(res.status).toBe(403);
    // Nothing persisted — the gate runs before any write.
    expect(invitations.rows).toEqual([]);
  });

  it("BLOCKS the escalation: a PARTICIPANT cannot mint themselves an ADMIN invite", async () => {
    // The original exploit, verbatim: this returned 201 and stored a live ADMIN
    // invitation that the pre-signup trigger would then honour.
    const { app, invitations } = buildWithMember("attacker");

    const res = await invitePost(
      app,
      { id: "attacker", email: "attacker@example.com", role: "PARTICIPANT" },
      { invitees: [{ email: "attacker+2@example.com", platformRole: "ADMIN" }] }
    );

    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("stops a FACILITATOR from manufacturing an ADMIN peer", async () => {
    // Facilitators staff workshops, so they invite most roles — but granting full
    // platform access is reserved for an existing admin.
    const { app, invitations } = buildWithMember("fac");

    const res = await invitePost(
      app,
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      { emails: ["new-admin@example.com"], platformRole: "ADMIN" }
    );

    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("lets a FACILITATOR grant every NON-admin role", async () => {
    // Each role is now invited at the scope requirement (b) permits —
    // PLATFORM for FACILITATOR and JUDGE, the team for EXECUTIVE and PARTICIPANT. This
    // used to send all four at TEAM scope, which now 400s the first two. The RULE UNDER
    // TEST (the grant matrix) is unchanged; only where a legal invitation is addressed is.
    for (const platformRole of ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      // Owns the workshop, so the JUDGE row clears gate 4's entitlement check and this
      // test still measures the ROLE matrix rather than the workshop one.
      const { app, invitations } = buildWithMember("fac", true);
      const res = await invitePostAtScope(
        app,
        { id: "fac", email: "f@example.com", role: "FACILITATOR" },
        platformRole,
        {
          emails: [`${platformRole.toLowerCase()}@example.com`],
          platformRole,
          ...workshopArgFor(platformRole),
        }
      );
      expect(res.status, `FACILITATOR → ${platformRole}`).toBe(201);
      expect(invitations.rows[0].platformRole).toBe(platformRole);
    }
  });

  it("REFUSES 400 for a platform-wide role invited to a TEAM — requirement (b) layer 1", async () => {
    // ── THE NEW GATE, ON ITS OWN ──
    //
    // A membership row is the ONLY thing that grants access to a team's
    // private content, so an ADMIN/FACILITATOR/JUDGE must never be able to hold one. This
    // is the first of three layers: refuse the invitation, so the row that would later be
    // taken up never exists.
    //
    // 400, not 403: the caller MAY grant these roles (a FACILITATOR granting FACILITATOR
    // passes the matrix — the sweep above proves it at PLATFORM scope), they have named the
    // wrong SCOPE. The message says so, because an operator has to be able to fix it.
    for (const platformRole of ["ADMIN", "FACILITATOR", "JUDGE"]) {
      const { app, invitations } = buildWithMember("admin", true);
      const res = await invitePost(
        app,
        { id: "admin", email: "a@example.com", role: "ADMIN" },
        {
          emails: [`${platformRole.toLowerCase()}@example.com`],
          platformRole,
          ...workshopArgFor(platformRole),
        }
      );
      expect(res.status, `ADMIN → ${platformRole} at TEAM scope`).toBe(400);
      expect((await res.json()).error).toMatch(/invited to the platform, not to a team/i);
      // NOTHING PERSISTED — the gate runs inside the pre-write validation loop, so a
      // refused batch writes no rows at all.
      expect(invitations.rows).toEqual([]);
    }
  });

  it("still allows EXECUTIVE and PARTICIPANT at TEAM scope — the rule is narrow", async () => {
    // The other half of the same gate. These two ARE the team-scoped roles, so narrowing
    // them would stop anyone being invited to a team at all — which is the failure mode a
    // deny-list keyed on three named roles exists to avoid.
    for (const platformRole of ["EXECUTIVE", "PARTICIPANT"]) {
      const { app, invitations } = buildWithMember("admin");
      const res = await invitePost(
        app,
        { id: "admin", email: "a@example.com", role: "ADMIN" },
        { emails: [`${platformRole.toLowerCase()}@example.com`], platformRole }
      );
      expect(res.status, `ADMIN → ${platformRole} at TEAM scope`).toBe(201);
      expect(invitations.rows[0].platformRole).toBe(platformRole);
    }
  });

  it("still allows an OMITTED platformRole at TEAM scope (it defaults to PARTICIPANT)", async () => {
    // The default must not be caught by the new gate: an omitted role means PARTICIPANT,
    // which may hold membership. If this ever 400s, the most common invitation on the
    // platform has been broken.
    const { app, invitations } = buildWithMember("admin");
    const res = await invitePost(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      { emails: ["someone@example.com"] }
    );
    expect(res.status).toBe(201);
    expect(invitations.rows).toHaveLength(1);
  });

  it("limits an EXECUTIVE to PARTICIPANT only — not fellow observers", async () => {
    // An executive is a read-only role for team CONTENT but may still bring in their
    // own builders — which is why the invitation route is gated on team READ, not
    // write. EXECUTIVE was withdrawn from the allowed set: an executive
    // minting another executive is lateral growth of a read-only role nobody staffed
    // deliberately, and post-provisioning each invitation creates a real account.
    for (const allowed of ["PARTICIPANT"]) {
      const { app } = buildWithMember("exec");
      const res = await invitePost(
        app,
        { id: "exec", email: "e@example.com", role: "EXECUTIVE" },
        { emails: ["someone@example.com"], platformRole: allowed }
      );
      expect(res.status, `EXECUTIVE → ${allowed}`).toBe(201);
    }
    for (const denied of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE"]) {
      const { app, invitations } = buildWithMember("exec");
      const res = await invitePost(
        app,
        { id: "exec", email: "e@example.com", role: "EXECUTIVE" },
        { emails: ["someone@example.com"], platformRole: denied }
      );
      expect(res.status, `EXECUTIVE → ${denied}`).toBe(403);
      expect(invitations.rows).toEqual([]);
    }
  });

  it("REFUSES a JUDGE outright — judging is an assignment, not a self-growing club", async () => {
    // Withdrawn: a judge used to be able to grant JUDGE. It matters more
    // than it looks, because since registration became admin-provisioned an
    // invitation CREATES a Cognito account — so this entry was an account-creation
    // grant, not just a permission record.
    const { app, invitations } = buildWithMember("judge");
    const refused = await invitePost(
      app,
      { id: "judge", email: "j@example.com", role: "JUDGE" },
      { emails: ["cojudge@example.com"], platformRole: "JUDGE" }
    );
    expect(refused.status).toBe(403);
    expect(invitations.rows).toHaveLength(0);

    for (const denied of ["ADMIN", "FACILITATOR", "EXECUTIVE", "PARTICIPANT"]) {
      const { app: app2, invitations } = buildWithMember("judge");
      const res = await invitePost(
        app2,
        { id: "judge", email: "j@example.com", role: "JUDGE" },
        { emails: ["x@example.com"], platformRole: denied }
      );
      expect(res.status, `JUDGE → ${denied}`).toBe(403);
      expect(invitations.rows).toEqual([]);
    }
  });

  it("lets an ADMIN grant anything, including another ADMIN", async () => {
    // AMENDED exactly as the FACILITATOR sweep above: each role is invited at
    // the scope requirement (b) permits. The matrix itself is unchanged — an ADMIN may
    // still grant all five.
    for (const platformRole of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      // ⚠ `FakeWorkshops(true)` IS NOW REQUIRED FOR THE JUDGE ROW. The old comment here read
      // "No FakeWorkshops(true) needed for the JUDGE row: an ADMIN may name any workshop
      // without an ownership probe" — that exemption was removed, so an admin
      // must own the workshop they name like everyone else. The MATRIX under test is unchanged:
      // an ADMIN may still grant all five roles.
      const { app, invitations } = buildWithMember("admin", true);
      const res = await invitePostAtScope(
        app,
        { id: "admin", email: "a@example.com", role: "ADMIN" },
        platformRole,
        { emails: ["someone@example.com"], platformRole, ...workshopArgFor(platformRole) }
      );
      expect(res.status, `ADMIN → ${platformRole}`).toBe(201);
      expect(invitations.rows[0].platformRole).toBe(platformRole);
    }
  });

  it("checks an OMITTED platformRole against the matrix too (it defaults to PARTICIPANT)", async () => {
    // A JUDGE may grant only JUDGE. Omitting the role means PARTICIPANT — the same
    // default the write applies — so it must be refused, not waved through as
    // "nothing requested".
    const { app, invitations } = buildWithMember("judge");
    const res = await invitePost(
      app,
      { id: "judge", email: "j@example.com", role: "JUDGE" },
      { emails: ["someone@example.com"] }
    );
    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("validates the WHOLE batch before writing any of it", async () => {
    // A mixed request must be all-or-nothing: there is no partial-success story for
    // granting roles, and a half-written batch would leave a live escalation row.
    const { app, invitations } = buildWithMember("fac");

    const res = await invitePost(
      app,
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      {
        invitees: [
          { email: "legit@example.com", platformRole: "PARTICIPANT" },
          { email: "sneaky@example.com", platformRole: "ADMIN" },
        ],
      }
    );

    expect(res.status).toBe(403);
    // Critically: NOT even the legal first invitee was stored.
    expect(invitations.rows).toEqual([]);
  });

  it("fails CLOSED on an unrecognised inviter role", async () => {
    const { app, invitations } = buildWithMember("weird");
    const res = await invitePost(
      app,
      { id: "weird", email: "w@example.com", role: "SUPERUSER" },
      { emails: ["x@example.com"], platformRole: "PARTICIPANT" }
    );
    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("refuses an unrecognised TARGET role rather than storing it", async () => {
    // An unknown role in the table would resolve to PARTICIPANT at signup, but
    // storing junk invites drift; the matrix only ever admits known roles.
    const { app, invitations } = buildWithMember("admin");
    const res = await invitePost(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      { emails: ["x@example.com"], platformRole: "ROOT" }
    );
    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });
});

describe("Team-scoped routes require team access (IDOR)", () => {
  it("REFUSES invitations into a team the caller cannot see", async () => {
    // teamId is an unvalidated path param; without this gate an ADMIN-less
    // outsider could seed invitations into any team whose id they guessed.
    // FakeWorkshops(false) = does not own the workshop; FakeMembers([]) = not a member.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await invitePost(
      app,
      { id: "outsider", email: "o@example.com", role: "FACILITATOR" },
      { emails: ["x@example.com"], platformRole: "PARTICIPANT" }
    );

    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("does not leak a team's pending invitation EMAILS to an outsider", async () => {
    const invitations = new FakeInvitations([invitation({ email: "secret@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await app.request("/v1/teams/t1/invitations", {
      headers: asUser({ id: "outsider", email: "o@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("secret@example.com");
  });

  it("does not leak a team's ROSTER to an outsider", async () => {
    const { app } = build({
      members: new FakeMembers([MEMBER_T1("insider")]),
      users: new FakeUsers([{ id: "insider", name: "Ada", email: "ada@example.com" }]),
    });

    const res = await app.request("/v1/teams/t1/members", {
      headers: asUser({ id: "outsider", email: "o@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("ada@example.com");
  });

  it("REFUSES member removal by an outsider, and publishes no member.left", async () => {
    const members = new FakeMembers([MEMBER_T1("victim")]);
    const events = new InMemoryPublisher();
    const { app } = build({ members, events });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "outsider", email: "o@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    // The victim is still on the team and no downstream projection was told otherwise.
    expect(await members.get("t1", "victim")).not.toBeNull();
    expect(events.published).toEqual([]);
  });

  it("REFUSES member removal by a read-only EXECUTIVE who IS a member", async () => {
    // Distinct from the outsider case: this caller passes canRead and is stopped
    // only by the read-only rule. Removing a member is a content mutation, unlike
    // sending an invitation.
    const members = new FakeMembers([MEMBER_T1("exec"), MEMBER_T1("victim")]);
    const { app } = build({ members });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "exec", email: "e@example.com", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(403);
    expect(await members.get("t1", "victim")).not.toBeNull();
  });

  /**
   * ⚠ INVERTED, AND THE OLD ASSERTION WAS THE BUG.
   *
   * This test read "still lets a legitimate member remove a teammate" and asserted a 200 for a
   * PARTICIPANT member removing a peer, justified as "the guards must not break the real
   * workflow". That is not the real workflow: ROLES.md:126 gives "Remove or reactivate a
   * member" to ADMIN and FACILITATOR who own the team's experience, with an explicit ✗ for
   * PARTICIPANT — and the route's own header claimed its guard already meant that. The test
   * was pinning the defect in place, which is why the report found it live.
   *
   * Kept as a NEGATIVE with the fixture unchanged so the inversion is legible in the diff.
   */
  it("REFUSES member removal by a PARTICIPANT teammate", async () => {
    const members = new FakeMembers([MEMBER_T1("lead"), MEMBER_T1("victim")]);
    const events = new InMemoryPublisher();
    const { app } = build({ members, events });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "lead", email: "l@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    // The ACT, not merely the status: the victim keeps the row that is the whole of their
    // content authorization, and nothing downstream was told otherwise.
    expect(await members.get("t1", "victim")).not.toBeNull();
    expect(events.published).toEqual([]);
  });

  it("lets the FACILITATOR who owns the workshop remove a member", async () => {
    // The other half of the inversion: the capability has to still exist for the people
    // ROLES.md gives it to, or the fix would simply have removed the feature.
    const members = new FakeMembers([MEMBER_T1("victim")]);
    const events = new InMemoryPublisher();
    const { app } = build({
      members,
      events,
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "facilitator", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(await members.get("t1", "victim")).toBeNull();
    expect(events.published.map((e) => e.type)).toContain("member.left");
  });

  /**
   * ── ROSTER ADMINISTRATION IS STAFF-AND-OWNS, ON BOTH HALVES OF THE PAIR ────────────────────
   *
   * The removal and its reversal moved to `requireTeamAdministration` together, because a guard
   * on the removal alone would leave the reactivate route as the bypass: a PARTICIPANT could
   * simply undo the owning facilitator's decision from inside the team.
   */
  describe("roster administration (DELETE + reactivate) is staff-and-owns only", () => {
    const INACTIVE_VICTIM: TeamMember = {
      ...MEMBER_T1("victim"),
      status: "INACTIVE",
    };

    /**
     * The subject must be resolvable in the users read-model, or the route answers 503 on
     * its requirement-(b) check rather than reaching the flip — see the long note at
     * that gate on why an unresolvable ADDRESS is transient and an absent invitation row is
     * not. Seeded so these tests exercise the guard and not that gate.
     */
    const victimUser = new FakeUsers([
      { id: "victim", email: "victim@example.com", name: "Victim" } as UserView,
    ]);

    it("REFUSES reactivate by a PARTICIPANT teammate", async () => {
      const members = new FakeMembers([MEMBER_T1("lead"), INACTIVE_VICTIM]);
      const { app } = build({ members, users: victimUser });

      const res = await app.request("/v1/teams/t1/members/victim/reactivate", {
        method: "POST",
        headers: asUser({ id: "lead", email: "l@example.com", role: "PARTICIPANT" }),
      });

      expect(res.status).toBe(403);
      // `get()` returns null for an INACTIVE row by design, so the assertion has to go
      // through the including-inactive read or it would pass vacuously.
      expect(
        (await members.getIncludingInactive("t1", "victim"))?.status
      ).toBe("INACTIVE");
    });

    it("lets the owning FACILITATOR reactivate", async () => {
      const members = new FakeMembers([INACTIVE_VICTIM]);
      const { app } = build({
        members,
        users: victimUser,
        workshops: new FakeWorkshops(true),
      });

      const res = await app.request("/v1/teams/t1/members/victim/reactivate", {
        method: "POST",
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      });

      expect(res.status).toBe(200);
      expect(
        (await members.getIncludingInactive("t1", "victim"))?.status
      ).toBe("ACTIVE");
    });

    it("REFUSES staff who do NOT own the team's workshop, on both routes", async () => {
      // The second half of the guard. `isStaffRole` alone is not the rule — ADMIN is
      // scoped to the experiences they own, and this guard must not
      // reintroduce the ambient platform-wide power that change removed.
      for (const role of ["ADMIN", "FACILITATOR"]) {
        const members = new FakeMembers([MEMBER_T1("victim")]);
        const { app } = build({ members, workshops: new FakeWorkshops(false) });

        const removed = await app.request("/v1/teams/t1/members/victim", {
          method: "DELETE",
          headers: asUser({ id: "outsider", email: "o@example.com", role }),
        });
        expect(removed.status, `${role} not owning the workshop`).toBe(403);

        const reactivated = await app.request(
          "/v1/teams/t1/members/victim/reactivate",
          { method: "POST", headers: asUser({ id: "outsider", email: "o@example.com", role }) }
        );
        expect(reactivated.status, `${role} not owning the workshop`).toBe(403);

        expect(await members.get("t1", "victim")).not.toBeNull();
      }
    });

    it("REFUSES a JUDGE and an EXECUTIVE outright, without an ownership hop", async () => {
      // Neither is staff, so the local role check must refuse before the east-west call —
      // the same local-check-first ordering the evaluation service's scoring guard uses.
      for (const role of ["JUDGE", "EXECUTIVE"]) {
        const members = new FakeMembers([MEMBER_T1("victim")]);
        const workshops = new FakeWorkshops(true);
        const { app } = build({ members, workshops });

        const res = await app.request("/v1/teams/t1/members/victim", {
          method: "DELETE",
          headers: asUser({ id: role.toLowerCase(), email: "x@example.com", role }),
        });

        expect(res.status, role).toBe(403);
        expect(workshops.calls, `${role} must cost no ownership hop`).toBe(0);
      }
    });

    it("does not withdraw the victim's workshop entitlement on a refused removal", async () => {
      // The removal handler also flips the invitation to REVOKED, which is what withdraws
      // workshop entitlement and makes re-joining refuse as spent. A guard that returned 403
      // AFTER that write would leave the damage the report described.
      const members = new FakeMembers([MEMBER_T1("lead"), MEMBER_T1("victim")]);
      const invitations = new FakeInvitations([]);
      const { app } = build({ members, invitations });

      const res = await app.request("/v1/teams/t1/members/victim", {
        method: "DELETE",
        headers: asUser({ id: "lead", email: "l@example.com", role: "PARTICIPANT" }),
      });

      expect(res.status).toBe(403);
      // The ATTEMPT list, not a resulting state: it records every markRevoked call the route
      // made, so an empty one proves the write was never even asked for.
      expect(invitations.markRevokedCalls).toEqual([]);
    });
  });

  it("lets an ADMIN who OWNS the experience reach a team they are not a member of", async () => {
    // ⚠ RETITLED AND RE-FIXTURED. It read "lets a global ADMIN reach a team they are not a
    // member of", justified as "canRead short-circuits for ADMIN, so platform administration
    // keeps working without membership rows". The short-circuit is gone; what
    // survives is the part that mattered — administration does not require a MEMBERSHIP row,
    // which it must not, since ADMIN and FACILITATOR are refused one outright.
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await invitePost(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      { emails: ["x@example.com"], platformRole: "PARTICIPANT" }
    );

    expect(res.status).toBe(201);
  });

  it("REFUSES an ADMIN on a team in an experience they do not own", async () => {
    // The negative that did not exist before, because it was not possible before: the admin
    // role alone reached every team. Now it reaches none — an admin outside the experience is
    // refused exactly like an unrelated participant.
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false),
    });

    const res = await invitePost(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      { emails: ["x@example.com"], platformRole: "PARTICIPANT" }
    );

    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("lets a FACILITATOR who OWNS the workshop invite without being a member", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await invitePost(
      app,
      { id: "owner", email: "o@example.com", role: "FACILITATOR" },
      { emails: ["x@example.com"], platformRole: "PARTICIPANT" }
    );

    expect(res.status).toBe(201);
  });
});

// ─── ADMINISTRATION STAYS OPEN TO A NON-MEMBER OWNER ───────────────

describe("the ADMINISTRATION surfaces still serve a non-member ADMIN who OWNS the experience", () => {
  /**
   * ── THE OTHER HALF OF THE REQUIREMENT, AND THE REASON canRead WAS NOT MADE MEMBER-ONLY ──
   *
   * The member-only rule makes CONTENT member-only. It does NOT touch the person↔team RELATIONSHIP, and it
   * must not: making canRead member-only would have 403'd everyone on
   * DELETE /teams/:teamId/members/:userId, which — combined with requirement (b), under which
   * staff cannot be members — would mean NOBODY could remove anyone from a team, and the
   * audited MEMBER_REMOVED path would be unreachable.
   *
   * ⚠ EVERY CASE BELOW NOW USES `FakeWorkshops(true)`, AND THE CHANGE IS NOT COSMETIC. They
   * used to use `false`: no membership row AND no workshop ownership, passing purely on the
   * administration predicate's unconditional ADMIN branch. That branch was removed,
   * so what these tests now prove is narrower and is the right property: an admin
   * administers a team WITHOUT A MEMBERSHIP ROW — which they must, since ADMIN and FACILITATOR
   * are refused one outright — but only in an experience they OWN.
   *
   * The dangerous direction is unchanged: if any of these ever 403s, nobody can remove a member
   * and the audit path is unreachable. The NEW risk this file cannot see is the orphan case —
   * an experience whose owner is deactivated, or a team whose workshopId was cleared, now has
   * no administrator at all. Tracked as a recovery gap, not asserted here.
   */
  const ADMIN = { id: "admin", email: "a@example.com", role: "ADMIN" };

  it("MEMBER REMOVAL still works, and is still audited", async () => {
    // The load-bearing one. This is the route the whole "additive, not a narrowing"
    // decision exists to protect.
    const members = new FakeMembers([MEMBER_T1("victim")]);
    const audit = new FakeAudit();
    const events = new InMemoryPublisher();
    const { app } = build({ members, audit, events, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser(ADMIN),
    });

    expect(res.status).toBe(200);
    expect(await members.get("t1", "victim")).toBeNull();
    // The audited path is REACHABLE — the thing that would have been lost.
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: "MEMBER_REMOVED",
      actorId: "admin",
      actorRole: "ADMIN",
    });
    expect(events.published.map((e) => e.type)).toContain("member.left");
  });

  it("the TEAM ROSTER still lists members WITH their email addresses", async () => {
    // Administering people requires being able to see who they are. The roster is the
    // relationship, not the team's work product.
    const { app } = build({
      members: new FakeMembers([MEMBER_T1("insider")]),
      users: new FakeUsers([{ id: "insider", name: "Ada", email: "ada@example.com" }]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members", { headers: asUser(ADMIN) });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ada@example.com");
  });

  it("the WORKSHOP ROSTER still returns every team, with members and emails", async () => {
    const { app } = build({
      teams: new FakeTeams([team({ id: "t1" }), team({ id: "t2", inviteCode: "CODE2" })]),
      members: new FakeMembers([MEMBER_T1("insider")]),
      users: new FakeUsers([{ id: "insider", name: "Ada", email: "ada@example.com" }]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/workshops/w1/teams?withMembers=1", {
      headers: asUser(ADMIN),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: Array<{ id: string }> };
    // Both teams, not just ones they are a member of — the OWNER branch of the roster gate.
    expect(body.teams.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("INVITATIONS can still be listed, created and revoked", async () => {
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "pending@example.com" }),
    ]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const list = await app.request("/v1/teams/t1/invitations", { headers: asUser(ADMIN) });
    expect(list.status).toBe(200);

    const create = await invitePost(app, ADMIN, {
      emails: ["new@example.com"],
      platformRole: "PARTICIPANT",
    });
    expect(create.status).toBe(201);

    const revoke = await app.request("/v1/teams/t1/invitations/pending@example.com", {
      method: "DELETE",
      headers: asUser(ADMIN),
    });
    expect(revoke.status).toBe(200);
  });

  it("the per-user AUDIT TRAIL is still readable", async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
    const { app } = build({ audit, workshops: new FakeWorkshops(false) });

    const res = await app.request("/v1/audit/users/victim", { headers: asUser(ADMIN) });
    expect(res.status).toBe(200);
  });

  it("a FACILITATOR who OWNS the workshop keeps the same administration access", async () => {
    // Not only ADMIN: the workshop owner administers their own workshop's teams, which is
    // the normal case and the one a narrowing would have broken most visibly.
    const members = new FakeMembers([MEMBER_T1("victim")]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(audit.entries).toHaveLength(1);
  });
});

// ─── PATCH /v1/teams/:teamId/invitations/:email/accept ───────────────────────

describe("PATCH invitations/:email/accept — scoped to the caller's own email", () => {
  const acceptAs = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    email: string
  ) =>
    app.request(`/v1/teams/t1/invitations/${encodeURIComponent(email)}/accept`, {
      method: "PATCH",
      headers: asUser(identity),
    });

  it("lets a caller accept their OWN invitation without any team membership", async () => {
    // The normal path: a freshly-registered invitee has no membership row yet, so a
    // team-access gate alone would lock them out of their own invitation.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptAs(
      app,
      { id: "u1", email: "me@example.com", role: "PARTICIPANT" },
      "me@example.com"
    );

    expect(res.status).toBe(200);
    // acceptedBy is the CALLER's sub — who performed the acceptance. It used to be
    // passed as nothing at all, so every row accepted through this route recorded
    // no actor.
    expect(invitations.accepted).toEqual([
      { teamId: "t1", email: "me@example.com", acceptedBy: "u1" },
    ]);
    expect(invitations.rows[0].acceptedBy).toBe("u1");
  });

  it("matches the email case-insensitively on both sides", async () => {
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptAs(
      app,
      { id: "u1", email: "Me@Example.COM", role: "PARTICIPANT" },
      "ME@EXAMPLE.com"
    );

    expect(res.status).toBe(200);
    expect(invitations.accepted[0].email).toBe("me@example.com");
  });

  it("403s an outsider accepting SOMEONE ELSE's invitation, and flips nothing", async () => {
    // :email is a path param. Without the scope check any authenticated user could
    // burn any pending invitation on any team — including teams they cannot see.
    const invitations = new FakeInvitations([invitation({ email: "victim@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptAs(
      app,
      { id: "attacker", email: "attacker@example.com", role: "PARTICIPANT" },
      "victim@example.com"
    );

    expect(res.status).toBe(403);
    expect(invitations.accepted).toEqual([]);
    expect(invitations.rows[0].status).toBe("PENDING");
  });

  it("403s a caller whose token carries NO email claim", async () => {
    // Nothing to compare against must never read as "matches".
    const invitations = new FakeInvitations([invitation({ email: "victim@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptAs(app, { id: "u1", role: "PARTICIPANT" }, "victim@example.com");

    expect(res.status).toBe(403);
    expect(invitations.accepted).toEqual([]);
  });

  it("lets team STAFF accept on a member's behalf (roster reconciliation)", async () => {
    const invitations = new FakeInvitations([invitation({ email: "someone@example.com" })]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true), // FACILITATOR owns this team's workshop
    });

    const res = await acceptAs(
      app,
      { id: "facilitator", email: "f@example.com", role: "FACILITATOR" },
      "someone@example.com"
    );

    expect(res.status).toBe(200);
    // The STAFF member's sub, not the invitee's. acceptedBy is "who performed the
    // acceptance", so a row a facilitator reconciled must name the facilitator —
    // attributing the action to the invitee would be a false audit record.
    expect(invitations.accepted).toEqual([
      { teamId: "t1", email: "someone@example.com", acceptedBy: "facilitator" },
    ]);
  });

  it("lets a global ADMIN accept on anyone's behalf", async () => {
    const invitations = new FakeInvitations([invitation({ email: "someone@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]), workshops: new FakeWorkshops(true) });

    const res = await acceptAs(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      "someone@example.com"
    );

    expect(res.status).toBe(200);
  });

  it("403s a read-only EXECUTIVE accepting someone else's invitation", async () => {
    // Flipping another person's invitation is a write, and EXECUTIVE never writes —
    // even though they can read the team.
    const invitations = new FakeInvitations([invitation({ email: "someone@example.com" })]);
    const { app } = build({
      invitations,
      members: new FakeMembers([MEMBER_T1("exec")]),
    });

    const res = await acceptAs(
      app,
      { id: "exec", email: "e@example.com", role: "EXECUTIVE" },
      "someone@example.com"
    );

    expect(res.status).toBe(403);
    expect(invitations.accepted).toEqual([]);
  });

  it("still lets a read-only EXECUTIVE accept their OWN invitation", async () => {
    // The read-only rule is about other people's data; their own invitation is theirs.
    const invitations = new FakeInvitations([invitation({ email: "exec@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptAs(
      app,
      { id: "exec", email: "exec@example.com", role: "EXECUTIVE" },
      "exec@example.com"
    );

    expect(res.status).toBe(200);
  });

  it("requires authentication", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/t1/invitations/x%40example.com/accept", {
      method: "PATCH",
    });
    expect(res.status).toBe(401);
  });

  it("surfaces a store failure rather than reporting a success it did not achieve", async () => {
    // This route's ENTIRE purpose is the flip, so unlike the join and sign-in paths
    // (which absorb the failure because they have another effect to deliver) a caller
    // told `success` when the write failed has been lied to about the only thing they
    // asked for. The repository rethrows a real store error — only a
    // ConditionalCheckFailedException is benign — and it must not be swallowed here.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    invitations.acceptThrows = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptAs(
      app,
      { id: "u1", email: "me@example.com", role: "PARTICIPANT" },
      "me@example.com"
    );

    expect(res.status).toBe(500);
    expect(invitations.rows[0].status).toBe("PENDING");
  });
});

// ─── POST /v1/invitations/mine/accept — THE FIRST-SIGN-IN FLIP (defect 1) ─────
//
// THE DEFECT THIS CLOSES. Registration became ADMIN-PROVISIONED
// (`AllowAdminCreateUserOnly: true` on the pool), which silently removed the only thing
// that ever marked an invitation accepted — in the old self-signup flow the invitee's own
// registration drove it. Confirmed live: user+facilitator-1@example.com completed the
// WHOLE journey (Cognito account CONFIRMED, FACILITATOR group assigned, profile row
// written) and the invitation row was still `status: PENDING`, `acceptedAt: null`. The
// Administration screen read "Pending" for someone who had plainly accepted.
//
// WHY FIRST SIGN-IN AND NOT PROVISIONING TIME. `acceptedAt` is an audit fact meaning
// "this person took up the grant" — which is exactly why the revoke gate refuses to
// delete an ACCEPTED row. Stamping it when an ADMIN creates the account would assert the
// invitee acted before they had seen the email, and would make every
// provisioned-but-never-used account un-revocable.
//
// The properties these tests pin, each of which is a way the route could be wrong:
//
//   caller / situation                | outcome
//   ----------------------------------|---------------------------------------------
//   PENDING row, own email            | flipped once, acceptedBy = caller's sub
//   called TWICE (every sign-in)      | acceptedAt does NOT move; no second write
//   PLATFORM sentinel row             | flipped — the REPORTED case (facilitator)
//   store throws                      | 200, failed counted, sign-in unaffected
//   listByEmail throws                | 200, failed counted, sign-in unaffected
//   token with no email claim         | 200, nothing accepted, no error
//   someone else's rows               | unreachable — no input to tamper with
//   unauthenticated                   | 401

describe("POST /v1/invitations/mine/accept — the first-sign-in flip", () => {
  const PLATFORM = "PLATFORM";

  const acceptMine = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string }
  ) =>
    app.request("/v1/invitations/mine/accept", {
      method: "POST",
      headers: asUser(identity),
    });

  it("flips the caller's PENDING invitation and records who accepted it", async () => {
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    expect(invitations.rows[0].status).toBe("ACCEPTED");
    expect(invitations.rows[0].acceptedAt).toBeTruthy();
    // The invitee's own sub: on this path the person accepting IS the invitee.
    expect(invitations.rows[0].acceptedBy).toBe("sub-1");
  });

  // ── Accepting a TEAM invitation must also make the invitee a MEMBER ──────────
  //
  // THE REPORTED BUG: the invitation read "Accepted" and the roster read
  // "Members (0)". This route only flipped the status, so a participant who accepted
  // at sign-in was told they were on the team and was not on it. The invite-CODE path
  // (POST /teams/join) always wrote the row; this one never did.

  it("adds the invitee as a MEMBER of the team, with the invited team role", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "me@example.com", teamId: "t1", teamRole: "LEAD" }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    await acceptMine(app, { id: "sub-1", email: "me@example.com", role: "PARTICIPANT" });

    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]).toMatchObject({
      teamId: "t1",
      userId: "sub-1",
      // The role the INVITER chose — not a default. Getting this wrong silently
      // demotes (or promotes) everyone who joins by accepting rather than by code.
      role: "LEAD",
    });
    expect(members.rows[0].joinedAt).toBeTruthy();
  });

  it("falls back to BUILDER when the invitation carries no team role", async () => {
    // Legacy rows predate teamRole. Must match POST /teams/join's fallback exactly:
    // two ways into a team that disagreed about the role would be worse than either.
    const invitations = new FakeInvitations([
      invitation({ email: "me@example.com", teamId: "t1", teamRole: undefined }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    await acceptMine(app, { id: "sub-1", email: "me@example.com", role: "PARTICIPANT" });

    expect(members.rows[0]).toMatchObject({ role: "BUILDER" });
  });

  it("does NOT create a membership row for a PLATFORM invitation", async () => {
    // The sentinel is not a real team id. A facilitator/judge/executive has no team to
    // join, and writing "PLATFORM" into teamMembers would invent a team that does not
    // exist — and would then appear in rosters and access checks keyed on it.
    const invitations = new FakeInvitations([
      invitation({ email: "fac@example.com", teamId: PLATFORM, teamRole: undefined }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    const res = await acceptMine(app, {
      id: "sub-f",
      email: "fac@example.com",
      role: "FACILITATOR",
    });

    // Still accepted — the status flip is the whole of a platform acceptance.
    expect(await res.json()).toEqual({ accepted: 1, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    expect(invitations.rows[0].status).toBe("ACCEPTED");
    expect(members.rows).toHaveLength(0);
  });

  it("publishes member.joined so consumers cannot tell the two join paths apart", async () => {
    const invitations = new FakeInvitations([
      invitation({
        email: "me@example.com",
        teamId: "t1",
        teamRole: "BUILDER",
        workshopId: "w1",
      }),
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members: new FakeMembers([]), events });

    await acceptMine(app, { id: "sub-1", email: "me@example.com", role: "PARTICIPANT" });

    expect(events.published).toEqual([
      {
        source: "team-service",
        type: "member.joined",
        detail: { teamId: "t1", workshopId: "w1", userId: "sub-1" },
      },
    ]);
  });

  it("does not duplicate the membership row when the invitee is ALREADY a member", async () => {
    // This route runs on EVERY sign-in. A blind put would append a second row (or
    // reset joinedAt on a real store), destroying the record of when they joined.
    const invitations = new FakeInvitations([
      invitation({ email: "me@example.com", teamId: "t1", teamRole: "LEAD" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "sub-1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members, events });

    await acceptMine(app, { id: "sub-1", email: "me@example.com", role: "PARTICIPANT" });

    expect(members.rows).toHaveLength(1);
    // The EXISTING row is left exactly as it was — not upgraded to the invited role,
    // and joinedAt untouched. A role change is an explicit action, not a side effect
    // of signing in again.
    expect(members.rows[0]).toMatchObject({
      role: "BUILDER",
      joinedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(events.published).toHaveLength(0);
  });

  it("leaves the invitation PENDING when the MEMBERSHIP write fails, so it retries", async () => {
    // THE ORDERING GUARANTEE, and the reason membership is written BEFORE the status
    // flip. The flip is what makes this row skipped on every later sign-in, so if it
    // happened first and membership then failed, the person would be permanently
    // ACCEPTED and permanently not a member with nothing to retry it. Failing here must
    // leave the row PENDING.
    const invitations = new FakeInvitations([
      invitation({ email: "me@example.com", teamId: "t1", teamRole: "LEAD" }),
    ]);
    const members = new FakeMembers([]);
    // STUBS `admit`, NOT `put`: the membership write is `admit` (one
    // TransactWriteItems spanning the row and the seat ledger). Stubbing `put` left this test
    // injecting a failure into a method the route no longer calls, so it asserted the retry
    // hook against a write that had actually SUCCEEDED. The rule is unchanged — a failed
    // membership write must leave the invitation PENDING — only the seam moved.
    members.admit = async () => {
      throw new Error("dynamo unavailable");
    };
    const { app } = build({ invitations, members });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    // Reported as a failure count with a 200 — a sign-in must never fail over this.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, alreadyAccepted: 0, failed: 1, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    // The retry hook: still PENDING, so the next sign-in tries again.
    expect(invitations.rows[0].status).toBe("PENDING");
    expect(invitations.rows[0].acceptedAt).toBeFalsy();
  });

  it("IS IDEMPOTENT — a second sign-in does not move acceptedAt", async () => {
    // The property that makes this safe to call on EVERY sign-in rather than only the
    // first. A re-stamping implementation would destroy the one fact acceptedAt exists
    // to record, and would do it on every visit for the rest of the account's life.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });
    const identity = { id: "sub-1", email: "me@example.com", role: "PARTICIPANT" };

    const first = await acceptMine(app, identity);
    expect(await first.json()).toEqual({ accepted: 1, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    const acceptedAt = invitations.rows[0].acceptedAt;
    expect(acceptedAt).toBeTruthy();

    const second = await acceptMine(app, identity);

    expect(second.status).toBe(200);
    // Reported as "nothing to do", NOT as a second acceptance.
    expect(await second.json()).toEqual({ accepted: 0, alreadyAccepted: 1, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    // THE assertion this whole block exists for. FAKE_ACCEPTED_AT() returns a distinct
    // instant per call, so a re-stamp is guaranteed to change this value — the test
    // cannot pass by two writes landing in the same millisecond.
    expect(invitations.rows[0].acceptedAt).toBe(acceptedAt);
    expect(invitations.rows[0].acceptedBy).toBe("sub-1");
  });

  it("does not even ATTEMPT a write for an already-ACCEPTED row", async () => {
    // Correctness does not depend on this (the store's condition is what guarantees
    // idempotency), but a returning user hits this route on every sign-in and a
    // pointless conditional write per row per sign-in is pure load on one partition key.
    const invitations = new FakeInvitations([
      invitation({
        email: "me@example.com",
        status: "ACCEPTED",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        acceptedBy: "sub-1",
      }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    expect(await res.json()).toEqual({ accepted: 0, alreadyAccepted: 1, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    expect(invitations.accepted).toEqual([]);
    expect(invitations.rows[0].acceptedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  // ── THE FOURTH PATH BACK IN — this route WRITES MEMBERSHIP ────────────────
  //
  // It "looked safe" because it skipped ACCEPTED rows, but that skip was an equality against
  // ONE literal. Once the removal started writing REVOKED, a REVOKED row would have fallen
  // straight through it: the loop finds no membership row (it was just deleted), writes a
  // fresh one, and re-flips the invitation to ACCEPTED — on the removed person's very next
  // sign-in, automatically, with nobody having asked for it. Covered by a test rather than
  // assumed, because this is the same class of path as the join gate.

  it("CANNOT re-add a removed member — a REVOKED row writes no membership and no flip", async () => {
    const invitations = new FakeInvitations([
      invitation({
        email: "removed@example.com",
        status: "REVOKED",
        teamRole: "BUILDER",
        revokedAt: "2026-08-04T00:00:00.000Z",
        revokedBy: "fac",
      }),
    ]);
    const members = new FakeMembers([]);
    const events = new InMemoryPublisher();
    const { app } = build({ invitations, members, events });

    const res = await acceptMine(app, {
      id: "removed-sub",
      email: "removed@example.com",
      role: "PARTICIPANT",
    });

    // 200 — this route never fails a sign-in — but reported as `revoked`, NOT as
    // `alreadyAccepted`: a withdrawn grant misreported as an acceptance is a lie in the one
    // number an operator would read.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accepted: 0,
      alreadyAccepted: 0,
      failed: 0,
      membershipSkipped: 0,
      revoked: 1, capRefused: 0 });

    // THE ASSERTIONS THAT MATTER.
    expect(members.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
    // The status is NOT moved back out of REVOKED — it is terminal. Only a fresh invitation
    // from someone with grant authority re-admits them.
    expect(invitations.rows[0].status).toBe("REVOKED");
    expect(invitations.rows[0].revokedAt).toBe("2026-08-04T00:00:00.000Z");
    // Not even attempted, so the store's own condition is never relied on as the only guard.
    expect(invitations.accepted).toEqual([]);
  });

  it("matches REVOKED case-insensitively, and still processes the caller's other rows", async () => {
    // Per-row: a withdrawn grant on one team must not stop a legitimate PENDING invitation
    // to another from being taken up on the same sign-in.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "me@example.com", status: "revoked" }),
      invitation({ teamId: "t2", email: "me@example.com", status: "PENDING" }),
    ]);
    const teams = new FakeTeams([team(), team({ id: "t2", inviteCode: "CODE2222" })]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, teams, members });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    expect(await res.json()).toEqual({
      accepted: 1,
      alreadyAccepted: 0,
      failed: 0,
      membershipSkipped: 0,
      revoked: 1, capRefused: 0 });
    // Exactly ONE membership row, for the team whose invitation is live.
    expect(members.rows.map((m) => m.teamId)).toEqual(["t2"]);
  });

  it("flips a PLATFORM-scoped invitation — the REPORTED case", async () => {
    // A FACILITATOR/JUDGE/ADMIN invitation lives at the PLATFORM sentinel, not a real
    // team, and this is exactly the row that was found stuck on Pending. A
    // route that resolved a team first (as /invitations/mine does, which SKIPS platform
    // rows) would have missed precisely these.
    const invitations = new FakeInvitations([
      invitation({
        teamId: PLATFORM,
        scope: "PLATFORM",
        email: "facilitator-1@example.com",
        platformRole: "FACILITATOR",
      }),
    ]);
    // Not a member of any team and not a workshop owner — FakeWorkshops(false) — so a
    // team-access gate anywhere on this path would 403 the very case it must serve.
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false),
    });

    const res = await acceptMine(app, {
      id: "sub-fac",
      email: "facilitator-1@example.com",
      role: "FACILITATOR",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    expect(invitations.rows[0].status).toBe("ACCEPTED");
    expect(invitations.rows[0].acceptedBy).toBe("sub-fac");
    // The sentinel was used as the partition key verbatim, not resolved to a team.
    expect(invitations.accepted).toEqual([
      { teamId: PLATFORM, email: "facilitator-1@example.com", acceptedBy: "sub-fac" },
    ]);
  });

  it("accepts EVERY row for the address, across team and platform scope", async () => {
    // An address can hold several invitations (a team one plus a platform one, or two
    // teams). Flipping only the first would leave the others reading Pending forever,
    // since this route is the only thing that ever flips them now.
    //
    // ── AMENDED, and the amendment is the point of the test ──
    //
    // The caller here is a JUDGE, so the TEAM-scoped row's membership write is now SKIPPED
    // (requirement (b) layer 3) while BOTH rows still flip to ACCEPTED. What this used to
    // assert — `membershipSkipped` did not exist and the team row silently made this judge
    // a MEMBER of t1 — was exactly the front door the member-only rule closes: a platform-wide role
    // acquiring, at first sign-in, the one row that now grants content access.
    //
    // The `accepted: 2` half is UNCHANGED and must stay so: a row left PENDING for ever
    // would reintroduce, for these three roles, the "shows Pending after they signed in"
    // defect this whole route was built to fix.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "me@example.com" }),
      invitation({ teamId: PLATFORM, email: "me@example.com", platformRole: "JUDGE" }),
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ invitations, members });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "JUDGE",
    });

    expect(await res.json()).toEqual({
      accepted: 2,
      alreadyAccepted: 0,
      failed: 0,
      // One TEAM-scoped row was accepted WITHOUT membership. Reported rather than silent.
      membershipSkipped: 1,
      revoked: 0, capRefused: 0 });
    expect(invitations.rows.map((r) => r.status)).toEqual(["ACCEPTED", "ACCEPTED"]);
    // THE ASSERTION THAT MATTERS: no membership row exists, so no content predicate
    // anywhere can answer "yes" for this judge.
    expect(members.rows).toHaveLength(0);
  });

  it("matches the token's email case-insensitively", async () => {
    // Rows are stored lower-cased; a token claim carrying mixed case must still find
    // them, or a user whose IdP reports "Me@Example.com" is never marked accepted.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "Me@Example.COM",
      role: "PARTICIPANT",
    });

    expect(await res.json()).toEqual({ accepted: 1, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    expect(invitations.rows[0].status).toBe("ACCEPTED");
  });

  it("DOES NOT FAIL THE SIGN-IN when the store write fails", async () => {
    // The single most important property here. A user who cannot sign in because a
    // status update errored is a far worse defect than a stale status — and because the
    // operation is idempotent, the next sign-in retries it for free.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    invitations.acceptThrows = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    // Reported as a COUNT, not as a status — the client has nothing to do about it.
    expect(await res.json()).toEqual({ accepted: 0, alreadyAccepted: 0, failed: 1, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    // And nothing was quietly marked accepted.
    expect(invitations.rows[0].status).toBe("PENDING");
  });

  it("DOES NOT FAIL THE SIGN-IN when the invitation LOOKUP fails", async () => {
    // The other half of the same rule: the read can fail too, and it is on the same
    // sign-in path. Reported the same way for the same reason.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    invitations.listByEmail = async () => {
      throw new Error("dynamo unavailable");
    };
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, alreadyAccepted: 0, failed: 1, membershipSkipped: 0, revoked: 0, capRefused: 0 });
  });

  it("counts a partial failure per row rather than abandoning the batch", async () => {
    // One unwritable row must not stop the others being recorded. The failure is
    // reported so it is not silent, and the successful flips still stand.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "me@example.com" }),
      invitation({ teamId: PLATFORM, email: "me@example.com", platformRole: "JUDGE" }),
    ]);
    const realAccept = invitations.accept.bind(invitations);
    let call = 0;
    invitations.accept = async (teamId, email, acceptedBy) => {
      if (++call === 1) throw new Error("throttled");
      return realAccept(teamId, email, acceptedBy);
    };
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "JUDGE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accepted: 1,
      alreadyAccepted: 0,
      failed: 1,
      // AMENDED: the caller is a JUDGE and row 0 is TEAM-scoped, so its
      // membership write was skipped (requirement (b) layer 3) BEFORE its status flip then
      // failed. Counted anyway, and that is the honest reading — the counter means "rows
      // for which we deliberately wrote no membership", which is true of this row whether
      // or not the subsequent flip succeeded. The row stays PENDING and the next sign-in
      // re-skips it identically, so the count is stable rather than drifting.
      membershipSkipped: 1,
      revoked: 0, capRefused: 0 });
    expect(invitations.rows[0].status).toBe("PENDING");
    expect(invitations.rows[1].status).toBe("ACCEPTED");
  });

  it("does nothing, without error, for a token carrying no email claim", async () => {
    // There is genuinely nothing to accept. It must never be the reason a sign-in
    // reports a failure.
    const invitations = new FakeInvitations([invitation({ email: "me@example.com" })]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, { id: "sub-1", role: "PARTICIPANT" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    expect(invitations.accepted).toEqual([]);
    expect(invitations.rows[0].status).toBe("PENDING");
  });

  it("answers 200 with nothing accepted for a caller who holds no invitation", async () => {
    // The bootstrap admin, or anyone whose row was cleaned up. Not a 404: the caller
    // asked us to reconcile their own rows and we did, there just were none.
    const invitations = new FakeInvitations([
      invitation({ email: "someone-else@example.com" }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await acceptMine(app, {
      id: "sub-1",
      email: "me@example.com",
      role: "PARTICIPANT",
    });

    expect(await res.json()).toEqual({ accepted: 0, alreadyAccepted: 0, failed: 0, membershipSkipped: 0, revoked: 0, capRefused: 0 });
    // Untouched — the route can only ever reach rows matching the TOKEN's email.
    expect(invitations.rows[0].status).toBe("PENDING");
  });

  it("cannot be pointed at SOMEONE ELSE's invitation", async () => {
    // Scoped to the caller BY CONSTRUCTION: the address comes from the verified token
    // claim via listByEmail, and there is no path parameter and no body to tamper with.
    // That is what lets this route need no authorization beyond authentication — so the
    // absence of any input is itself the control, and worth asserting.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com" }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    // Every shape an attacker would reach for: a body, and a query parameter.
    const withBody = await app.request("/v1/invitations/mine/accept", {
      method: "POST",
      headers: asUser({ id: "attacker", email: "attacker@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ email: "victim@example.com", teamId: "t1" }),
    });
    const withQuery = await app.request(
      "/v1/invitations/mine/accept?email=victim%40example.com",
      {
        method: "POST",
        headers: asUser({
          id: "attacker",
          email: "attacker@example.com",
          role: "PARTICIPANT",
        }),
      }
    );

    expect(withBody.status).toBe(200);
    expect(withQuery.status).toBe(200);
    expect(invitations.accepted).toEqual([]);
    expect(invitations.rows[0].status).toBe("PENDING");
  });

  it("requires authentication", async () => {
    const { app } = build();
    const res = await app.request("/v1/invitations/mine/accept", { method: "POST" });
    expect(res.status).toBe(401);
  });

  // ── Requirement (b) layer 3 — THE LAYER THAT WOULD BE MISSED ───────────────
  //
  // This route runs on EVERY sign-in and, since it learned to write membership, it was a
  // membership-GRANTING path with no role check on it. A facilitator holding a team-scoped
  // invitation row became a full member of that team the first time they signed in —
  // silently, without asking, and with exactly the ambient content access the member-only rule removes.
  // The invitation gate (layer 1) now refuses to create such a row, but rows created before
  // it existed, or by any future path that forgets, still arrive here.

  describe("a platform-wide role accepts WITHOUT gaining membership", () => {
    it.each(["ADMIN", "FACILITATOR", "JUDGE"])(
      "%s: flips the row to ACCEPTED and writes NO membership row",
      async (role) => {
        // ── BOTH HALVES ARE THE ASSERTION ──
        //
        // No membership row (the security property), AND the row still flips (the
        // reconciliation property). Skipping the whole row instead would leave it PENDING
        // for ever and the Administration screen would show "Pending" for someone who had
        // plainly signed in — reintroducing, for these three roles, the exact defect this
        // route exists to fix.
        const invitations = new FakeInvitations([
          invitation({ teamId: "t1", email: "staff@example.com", teamRole: "LEAD" }),
        ]);
        const members = new FakeMembers([]);
        const events = new InMemoryPublisher();
        const { app } = build({ invitations, members, events });

        const res = await acceptMine(app, {
          id: "sub-staff",
          email: "staff@example.com",
          role,
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          accepted: 1,
          alreadyAccepted: 0,
          failed: 0,
          // Observable rather than silent: an operator can see "accepted but not a member"
          // without deducing it from a roster that did not grow.
          membershipSkipped: 1,
          revoked: 0, capRefused: 0 });

        // THE SECURITY PROPERTY. Read-model filtering would NOT satisfy this: the row would
        // survive and members.get would still return it, so every content predicate would
        // answer "yes" for this caller.
        expect(members.rows).toHaveLength(0);
        expect(await members.get("t1", "sub-staff")).toBeNull();

        // THE RECONCILIATION PROPERTY.
        expect(invitations.rows[0].status).toBe("ACCEPTED");
        expect(invitations.rows[0].acceptedBy).toBe("sub-staff");

        // No member.joined either — a downstream projection must not be told a team gained
        // a member it did not gain.
        expect(events.published).toHaveLength(0);
      }
    );

    it("keys the decision on the TOKEN role, never on the invitation's platformRole", async () => {
      // ── A STORED VALUE IS NOT AN AUTHORIZATION SOURCE ──
      //
      // The row says PARTICIPANT and the verified token says FACILITATOR. The membership
      // write must be refused, because what matters is who is presenting at the door — not
      // what a row written by someone else, possibly before a role change, claims they
      // were offered. An implementation reading `row.platformRole` would pass every other
      // test in this block and fail this one.
      const invitations = new FakeInvitations([
        invitation({ teamId: "t1", email: "fac@example.com", platformRole: "PARTICIPANT" }),
      ]);
      const members = new FakeMembers([]);
      const { app } = build({ invitations, members });

      const res = await acceptMine(app, {
        id: "sub-fac",
        email: "fac@example.com",
        role: "FACILITATOR",
      });

      expect((await res.json()).membershipSkipped).toBe(1);
      expect(members.rows).toHaveLength(0);
      expect(invitations.rows[0].status).toBe("ACCEPTED");
    });

    it("STILL writes membership for a PARTICIPANT and an EXECUTIVE", async () => {
      // The half that must not break. If this fails, first sign-in no longer puts anyone on
      // a team and the reported "Accepted but Members (0)" defect is back for everyone.
      for (const role of ["PARTICIPANT", "EXECUTIVE"]) {
        const invitations = new FakeInvitations([
          invitation({ teamId: "t1", email: "member@example.com", teamRole: "BUILDER" }),
        ]);
        const members = new FakeMembers([]);
        const { app } = build({ invitations, members });

        const res = await acceptMine(app, {
          id: `sub-${role}`,
          email: "member@example.com",
          role,
        });

        expect((await res.json()).membershipSkipped, role).toBe(0);
        expect(members.rows, role).toHaveLength(1);
        expect(members.rows[0].role).toBe("BUILDER");
      }
    });

    it("counts only TEAM rows — a PLATFORM row is not a skipped membership", async () => {
      // A platform-scoped row never had a membership write to skip, so counting it would
      // make the number mean "rows a platform role accepted" rather than "team rows we
      // deliberately did not join", and an operator reading it would chase a non-problem on
      // every facilitator sign-in.
      const invitations = new FakeInvitations([
        invitation({
          teamId: PLATFORM,
          email: "fac@example.com",
          platformRole: "FACILITATOR",
        }),
      ]);
      const members = new FakeMembers([]);
      const { app } = build({ invitations, members });

      const res = await acceptMine(app, {
        id: "sub-fac",
        email: "fac@example.com",
        role: "FACILITATOR",
      });

      expect(await res.json()).toEqual({
        accepted: 1,
        alreadyAccepted: 0,
        failed: 0,
        membershipSkipped: 0,
        revoked: 0, capRefused: 0 });
      expect(members.rows).toHaveLength(0);
    });
  });
});

// ─── Platform-scoped invitations ────────────────────────────────────────────

describe("Platform-scoped invitations (teamId = PLATFORM)", () => {
  const PLATFORM = "PLATFORM";

  // The gate this pair of tests exists for: canRead("PLATFORM", …) can only ever
  // pass for ADMIN (it resolves to no membership and no owned workshop), so a
  // FACILITATOR must be exempted from it on BOTH routes. Exempting only the create
  // side would ship a grant that its own author cannot withdraw.
  it("lets a FACILITATOR create a platform invitation — and REVOKE it again", async () => {
    const invitations = new FakeInvitations([]);
    // Deliberately NOT a member of any team and NOT the owner of any workshop:
    // FakeWorkshops(false) refuses ownership, so if the team-read gate still ran
    // for the sentinel this would 403.
    const { app } = build({ invitations, members: new FakeMembers([]) });
    const facilitator = asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" });

    // Grants FACILITATOR, not JUDGE, and the change is deliberate: this test's premise
    // is a caller who owns NOTHING, which is what makes it prove the scope exemption.
    // A JUDGE invitation now additionally has to name a workshop the caller is entitled
    // to (gate 4), so using one here would force `FakeWorkshops(true)` and destroy the
    // premise. FACILITATOR is FORBIDDEN a workshop, so it needs no entitlement and the
    // "owns nothing" setup stands. The judge-at-platform-scope case is covered in the
    // workshop-matrix block below, where entitlement is the subject rather than a
    // prerequisite.
    const created = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: facilitator,
      body: JSON.stringify({
        invitees: [{ email: "new.judge@example.com", platformRole: "FACILITATOR" }],
      }),
    });
    expect(created.status).toBe(201);
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0].teamId).toBe(PLATFORM);
    expect(invitations.rows[0].scope).toBe("PLATFORM");

    const revoked = await app.request(
      `/v1/teams/${PLATFORM}/invitations/new.judge%40example.com`,
      { method: "DELETE", headers: facilitator }
    );
    expect(revoked.status).toBe(200);
    expect(invitations.rows).toHaveLength(0);
  });

  it("still refuses a role the caller may not grant (gate 3 is unaffected)", async () => {
    // The scope exemption drops the TEAM-READ gate only. A facilitator minting an
    // ADMIN invitation must still be refused, or the sentinel would be a way around
    // the privilege-escalation boundary entirely.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({
        invitees: [{ email: "peer@example.com", platformRole: "ADMIN" }],
      }),
    });

    expect(res.status).toBe(403);
    expect(invitations.rows).toHaveLength(0);
  });

  it("still refuses a PARTICIPANT, who may grant nothing at any scope", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "p1", email: "p@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ emails: ["x@example.com"] }),
    });

    expect(res.status).toBe(403);
    expect(invitations.rows).toHaveLength(0);
  });

  it.each(["PARTICIPANT", "EXECUTIVE"])(
    "400s a %s at platform scope — those roles need a team, and a team-less one is a dead end",
    async (role) => {
      // Without this the row stores fine and the person registers fine, then lands
      // on a welcome page with no team and no join code and nothing explaining why.
      const invitations = new FakeInvitations([]);
      const { app } = build({ invitations });

      const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
        method: "POST",
        headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
        body: JSON.stringify({
          invitees: [{ email: "someone@example.com", platformRole: role }],
        }),
      });

      expect(res.status).toBe(400);
      expect(invitations.rows).toHaveLength(0);
    }
  );

  it("marks a real team's invitation scope TEAM, so the field is never just decoration", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["builder@example.com"] }),
    });

    expect(invitations.rows[0].scope).toBe("TEAM");
  });

  it("omits platform invitations from /invitations/mine, which is team-shaped", async () => {
    // The payload is name + workshop + JOIN CODE for the welcome page. A platform
    // row has no team to fill those in, so it is skipped rather than returned as a
    // card full of nulls.
    const invitations = new FakeInvitations([
      invitation({ teamId: PLATFORM, email: "staff@example.com", platformRole: "FACILITATOR" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "s1", email: "staff@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).invitations).toEqual([]);
  });

  // The LIST leg of the same asymmetry the create/revoke pair above covers. Without
  // the sentinel exemption here a FACILITATOR could mint a platform invitation and
  // withdraw one by address, but never see the list — so the address they mistyped
  // would be the one thing they could not find.
  const platformRows = () =>
    new FakeInvitations([
      invitation({ teamId: PLATFORM, email: "a@example.com", platformRole: "ADMIN" }),
      invitation({ teamId: PLATFORM, email: "f@example.com", platformRole: "FACILITATOR" }),
      invitation({ teamId: PLATFORM, email: "j@example.com", platformRole: "JUDGE" }),
    ]);

  const listPlatformAs = (role: string) =>
    build({ invitations: platformRows(), members: new FakeMembers([]) }).app.request(
      `/v1/teams/${PLATFORM}/invitations`,
      { headers: asUser({ id: "u1", email: "u@example.com", role }) }
    );

  it("lets an ADMIN list every platform invitation", async () => {
    const res = await listPlatformAs("ADMIN");
    expect(res.status).toBe(200);
    const emails = (await res.json()).invitations.map((i: any) => i.email);
    expect(emails.sort()).toEqual(["a@example.com", "f@example.com", "j@example.com"]);
  });

  it("shows a FACILITATOR the rows they could have granted, and hides the ADMIN one", async () => {
    // Not a member of any team and not a workshop owner — so this passes only
    // because the sentinel skips the team-read gate.
    const res = await listPlatformAs("FACILITATOR");
    expect(res.status).toBe(200);
    const emails = (await res.json()).invitations.map((i: any) => i.email);
    // Filtered by the SAME matrix the Revoke control is drawn from, so a visible
    // row is always one the DELETE route would accept.
    expect(emails.sort()).toEqual(["f@example.com", "j@example.com"]);
  });

  it("REFUSES a JUDGE, who may now grant nothing at all", async () => {
    // Not an empty list — a 403, the same closed case as PARTICIPANT. The gate is
    // canInvite(), and a judge's grant set is empty, so there is a
    // real permission failure to report rather than "nothing here for you". Contrast
    // the EXECUTIVE case immediately below, which stays 200-with-empty because an
    // executive CAN still invite, just never to a platform role.
    const res = await listPlatformAs("JUDGE");
    expect(res.status).toBe(403);
  });

  it("returns an EXECUTIVE an empty list, not a 403 — they grant nothing at platform scope", async () => {
    // "Nothing here for you" is the truthful answer: an executive may invite, just
    // never to a platform role, so there is no permission failure to report.
    const res = await listPlatformAs("EXECUTIVE");
    expect(res.status).toBe(200);
    expect((await res.json()).invitations).toEqual([]);
  });

  it("refuses a PARTICIPANT, who may not invite at all", async () => {
    const res = await listPlatformAs("PARTICIPANT");
    expect(res.status).toBe(403);
  });

  it("never returns tokenHash", async () => {
    // The only stored form of the link token. Not reversible, but it has no business
    // in a payload the BFF doesn't read — and omitting it now stops a future consumer
    // depending on it.
    const invitations = new FakeInvitations([
      invitation({ teamId: PLATFORM, email: "j@example.com", platformRole: "JUDGE", tokenHash: "deadbeef" }),
    ]);
    const { app } = build({ invitations, members: new FakeMembers([]) });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      headers: asUser({ id: "a", email: "a@b.c", role: "ADMIN" }),
    });

    const [row] = (await res.json()).invitations;
    expect(row.email).toBe("j@example.com");
    expect(row).not.toHaveProperty("tokenHash");
  });

  it("still gates a REAL team's invitation list on team membership", async () => {
    // The exemption must not leak into team scope: a non-member asking for t1's
    // invitations is still the IDOR the team-read gate exists to stop.
    const invitations = new FakeInvitations([invitation({ teamId: "t1" })]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false),
    });

    const res = await app.request("/v1/teams/t1/invitations", {
      headers: asUser({ id: "outsider", email: "o@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
  });
});

// ─── GATE 4: Invitation.workshopId ──────────────────────────────────────────
//
// The rule: a judge must belong to a workshop, so a judge user cannot be created without
// selecting one.
//
// Before this gate, `Invitation` had no workshopId field AT ALL, so a judge invitation
// granted visibility of NOTHING: the person registered successfully, received the JUDGE
// Cognito group, and could then see no workshop and score nothing. A silent dead end —
// the same one the platform-scope check already refuses for PARTICIPANT and EXECUTIVE.
//
// The matrix these tests pin, one describe per row
// (the workshop-scoped-visibility rule):
//
//   platformRole | scope    | workshopId
//   -------------|----------|-------------------------------------------------
//   PARTICIPANT  | TEAM     | server-DERIVED; a client value that disagrees → 400
//   EXECUTIVE    | TEAM     | server-DERIVED
//   JUDGE        | PLATFORM | REQUIRED; absent → 400; not entitled → 403
//   FACILITATOR  | PLATFORM | FORBIDDEN → 400
//   ADMIN        | PLATFORM | FORBIDDEN → 400

describe("gate 4: workshopId per role — REQUIRED for a JUDGE", () => {
  const PLATFORM = "PLATFORM";

  /** An inviter who owns nothing unless told otherwise, and belongs to no team. */
  const buildPlatform = (owns = false) => {
    const invitations = new FakeInvitations([]);
    const { app, deps } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(owns),
    });
    return { app, invitations, workshops: deps.workshops as FakeWorkshops };
  };

  const inviteJudge = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    extra: Record<string, unknown> = {}
  ) =>
    app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser(identity),
      body: JSON.stringify({
        invitees: [{ email: "judge@example.com", platformRole: "JUDGE", ...extra }],
      }),
    });

  it("400s a JUDGE invitation that names NO workshop — the reported defect", async () => {
    // THE defect in one test. This returned 201 before gate 4 and stored a row with no
    // workshop at all, which is how a judge ended up able to see and score nothing.
    const { app, invitations } = buildPlatform();

    const res = await inviteJudge(app, { id: "admin", email: "a@example.com", role: "ADMIN" });

    expect(res.status).toBe(400);
    expect(invitations.rows).toEqual([]);
    // The message names the missing thing rather than saying "bad request" — an
    // operator has to be able to fix this without reading the source.
    expect((await res.json()).error).toMatch(/must name a workshop/i);
  });

  it("stores the named workshop on the row when an ADMIN supplies one", async () => {
    // `true` = the admin owns w-alpha. Required because the admin's exemption
    // from the ownership probe was removed. The subject here is the stored ROW's shape.
    const { app, invitations } = buildPlatform(true);

    const res = await inviteJudge(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      { workshopId: "w-alpha" }
    );

    expect(res.status).toBe(201);
    expect(invitations.rows[0].workshopId).toBe("w-alpha");
    // Still a platform-scoped row: the workshop is a GRANT, not a team.
    expect(invitations.rows[0].teamId).toBe(PLATFORM);
    expect(invitations.rows[0].scope).toBe("PLATFORM");
  });

  it.each(["", "   "])(
    "treats workshopId %j as NOT SUPPLIED rather than as a workshop",
    async (blank) => {
      // An empty or whitespace id must not satisfy a REQUIRED role: DynamoDB would
      // store it, and every later reader would see an attribute that grants nothing
      // while looking like a grant.
      const { app, invitations } = buildPlatform();

      const res = await inviteJudge(
        app,
        { id: "admin", email: "a@example.com", role: "ADMIN" },
        { workshopId: blank }
      );

      expect(res.status).toBe(400);
      expect(invitations.rows).toEqual([]);
    }
  );

  it("400s a JUDGE with no workshop at TEAM scope too — the rule is the ROLE's", async () => {
    // The requirement is a property of the ROLE, not of the sentinel. A judge invited
    // from a team page still gets their scope from an explicit choice, because a judge
    // is not a member of the team and would otherwise inherit a grant nobody made.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, members: new FakeMembers([MEMBER_T1("admin")]) });

    const res = await invitePost(
      app,
      { id: "admin", email: "a@example.com", role: "ADMIN" },
      { emails: ["judge@example.com"], platformRole: "JUDGE" }
    );

    expect(res.status).toBe(400);
    expect(invitations.rows).toEqual([]);
  });

  it("accepts the batch `workshopId` form, which is what the portal picker sends", async () => {
    // { emails: [...], platformRole, workshopId } — one workshop for the whole batch.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, members: new FakeMembers([]), workshops: new FakeWorkshops(true) });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        emails: ["j1@example.com", "j2@example.com"],
        platformRole: "JUDGE",
        workshopId: "w-alpha",
      }),
    });

    expect(res.status).toBe(201);
    expect(invitations.rows.map((r) => r.workshopId)).toEqual(["w-alpha", "w-alpha"]);
  });
});

describe("gate 4: THE ESCALATION BOUNDARY — the inviter must be entitled", () => {
  const PLATFORM = "PLATFORM";

  // Why this gate exists at all: an invitation row is authoritative — the Cognito
  // pre-signup trigger admits a signup on it and post-confirmation reads the role off
  // it — so anyone who may grant JUDGE and may name ANY workshop id can mint themselves
  // an invitation into a workshop they have nothing to do with, register the second
  // account, and arrive inside it. Naming a workshop must therefore require being
  // entitled to it, or the field is a self-service access grant.

  const inviteJudgeAs = (
    identity: { id: string; email?: string; role: string },
    owns: boolean,
    workshopId = "w-someone-elses",
    // The address being INVITED. Defaults to a third party, so every pre-existing caller of this
    // helper keeps testing what it meant to test; pass the caller's own address to exercise the
    // self-invitation gate.
    inviteeEmail = "judge@example.com"
  ) => {
    const invitations = new FakeInvitations([]);
    const { app, deps } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(owns),
    });
    return {
      invitations,
      workshops: deps.workshops as FakeWorkshops,
      res: app.request(`/v1/teams/${PLATFORM}/invitations`, {
        method: "POST",
        headers: asUser(identity),
        body: JSON.stringify({
          invitees: [{ email: inviteeEmail, platformRole: "JUDGE", workshopId }],
        }),
      }),
    };
  };

  it("403s a FACILITATOR naming a workshop they do NOT own", async () => {
    const { res, invitations } = inviteJudgeAs(
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      false
    );

    expect((await res).status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("allows a FACILITATOR naming a workshop they DO own", async () => {
    const { res, invitations } = inviteJudgeAs(
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      true,
      "w-mine"
    );

    expect((await res).status).toBe(201);
    expect(invitations.rows[0].workshopId).toBe("w-mine");
  });

  it("lets an ADMIN name ANY workshop — inviting OTHER people into experiences is administration", async () => {
    /**
     * ⚠ THIS ASSERTION HAS NOW FLIPPED TWICE IN ONE DAY, AND BOTH TURNS ARE RECORDED BECAUSE THE
     * SECOND ONE IS NOT A REVERT. Read them in order or this test looks like churn:
     *
     *   1. ORIGINALLY 201 with `workshops.calls === 0` — "lets an ADMIN name ANY workshop,
     *      WITHOUT an ownership probe". Unconditional, and the header above explains why that is
     *      an escalation: an invitation row is authoritative at signup, so an admin could mint one
     *      for A JUDGE IN ANY EXPERIENCE, register, and arrive inside a stranger's judging.
     *   2. THEN 403, when ADMIN was scoped to the experiences it owns.
     *   3. NOW 201 AGAIN — but for a different reason, and with the escalation closed by a
     *      different mechanism. The rule: an admin may invite any user to any experience from
     *      the administration tab, as a facilitator does, BUT MAY NEVER ADD THEMSELVES to an
     *      experience.
     *
     * SO THE THING THAT MADE STEP 1 DANGEROUS WAS NEVER "an admin can name any workshop" — it was
     * "an admin can name any workshop AND put themselves in it". Ownership was one way to block
     * that and it blocked the legitimate half too. The self-invitation gate blocks the dangerous
     * half only, which is why the invitee here is SOMEBODY ELSE (`judge@example.com`) and why the
     * companion test below — an admin naming the same workshop for THEIR OWN address — must 403.
     * ⚠ NEITHER TEST IS MEANINGFUL WITHOUT THE OTHER; they are the two halves of one rule.
     *
     * `workshops.calls === 0` returns as an assertion for the same reason it was there in step 1:
     * "allowed" and "allowed without asking anyone" are different properties, and an admin's
     * invite path is hop-free again.
     */
    const { res, invitations, workshops } = inviteJudgeAs(
      { id: "admin", email: "admin@example.com", role: "ADMIN" },
      false,
      "w-not-mine"
    );

    expect((await res).status).toBe(201);
    expect(invitations.rows[0].workshopId).toBe("w-not-mine");
    expect(workshops.calls).toBe(0);
  });

  it("REFUSES AN ADMIN INVITING THEMSELVES into a workshop they do not own", async () => {
    // ⚠ THE OTHER HALF, AND THE ONLY THING MAKING THE TEST ABOVE SAFE. Same caller, same
    // workshop, same role being granted — the ONE difference is that the invitee address is the
    // caller's own, which is the full escalation: mint a JUDGE row for yourself in a stranger's
    // experience, register on it, arrive inside their judging.
    const { res, invitations, workshops } = inviteJudgeAs(
      { id: "admin", email: "admin@example.com", role: "ADMIN" },
      false,
      "w-not-mine",
      "admin@example.com"
    );

    const response = await res;
    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "SELF_INVITATION_REFUSED",
    });
    expect(invitations.rows).toEqual([]);
    // Refused LOCALLY, from the token — no hop spent discovering a self-grant.
    expect(workshops.calls).toBe(0);
  });

  it("REFUSES A SELF-INVITATION CASE-INSENSITIVELY and ignoring surrounding whitespace", async () => {
    // Invitations are stored lower-cased, so a comparison that was not case-insensitive would be
    // bypassed by the SAME address typed with a capital letter — and the row would then be found
    // by the caller's own lower-cased lookups at signup. Whitespace for the same reason: a
    // trailing space is invisible in a form field.
    const { res, invitations } = inviteJudgeAs(
      { id: "admin", email: "Admin@Example.com", role: "ADMIN" },
      false,
      "w-not-mine",
      "  admin@example.COM  "
    );

    expect((await res).status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("still REFUSES a FACILITATOR naming a workshop they do not own", async () => {
    // The admin's exemption is an ADMIN exemption. A facilitator's escalation route is unchanged
    // and still closed by the ownership probe — asserted so the two roles cannot be conflated by
    // someone reading only the test above.
    const { res, invitations, workshops } = inviteJudgeAs(
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      false,
      "w-not-mine"
    );

    expect((await res).status).toBe(403);
    expect(invitations.rows).toEqual([]);
    expect(workshops.calls).toBe(1);
  });

  it("REFUSES A FACILITATOR INVITING THEMSELVES even into a workshop they DO own", async () => {
    // ⚠ WIDER THAN THE REQUIREMENT, DELIBERATELY, and this is the test that says so. The
    // requirement was about an admin; the gate applies to every role. A facilitator self-inviting
    // as a JUDGE into their OWN experience is not an escalation — they already own it — but it is
    // scoring your own event, and no legitimate flow needs a self-invitation: the first admin is
    // seeded and everyone else is invited by somebody.
    const { res, invitations } = inviteJudgeAs(
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      true,
      "w-mine",
      "f@example.com"
    );

    expect((await res).status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("FAILS CLOSED when the ownership probe throws — refused, never granted", async () => {
    // The Workshop service being unreachable must not make a judge invitation
    // succeed unscoped or succeed unverified. `ownsWorkshop` already reads a timeout,
    // a 5xx and a non-JSON body as "not the owner" (workshop-access.http.ts, bounded by
    // AbortSignal.timeout(EAST_WEST_TIMEOUT_MS)); this pins that a THROWN error is
    // refused too rather than escaping as a 500 that hides which way it failed.
    class ExplodingWorkshops implements WorkshopAccess {
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

      async ownsTeamWorkshop(): Promise<boolean> {
        throw new Error("workshop service unreachable");
      }
      async ownsWorkshop(): Promise<boolean> {
        throw new Error("workshop service unreachable");
      }
    }
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new ExplodingWorkshops(),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({
        invitees: [{ email: "j@example.com", platformRole: "JUDGE", workshopId: "w1" }],
      }),
    });

    // A 403, not a 500: the denial is REPORTED as a denial rather than escaping as an
    // unhandled error. Both are safe (nothing is written either way), but only one tells
    // an operator at 3am that the invitation was refused rather than that the service
    // broke.
    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
  });

  it("MEMOISES the probe: one workshop named twice costs ONE hop", async () => {
    // The bound that keeps a batch from fanning out across the east-west hop. Two
    // invitees, one workshop, one ownership answer reused.
    const invitations = new FakeInvitations([]);
    const { app, deps } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({
        invitees: [
          { email: "j1@example.com", platformRole: "JUDGE", workshopId: "w-mine" },
          { email: "j2@example.com", platformRole: "JUDGE", workshopId: "w-mine" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    expect((deps.workshops as FakeWorkshops).calls).toBe(1);
  });

  it("BOUNDS the fan-out: more distinct workshops than the cap are refused, not probed", async () => {
    // MAX_INVITE_WORKSHOPS is 4. A body naming five distinct ids must be refused rather
    // than costing five hops — the cap is what stops a request body sizing an
    // east-west fan-out, so it has to DENY the overflow rather than wave it through.
    const invitations = new FakeInvitations([]);
    const { app, deps } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({
        invitees: [1, 2, 3, 4, 5].map((n) => ({
          email: `j${n}@example.com`,
          platformRole: "JUDGE",
          workshopId: `w-${n}`,
        })),
      }),
    });

    expect(res.status).toBe(403);
    expect(invitations.rows).toEqual([]);
    // Never more probes than the cap allows, whatever the body asked for.
    expect((deps.workshops as FakeWorkshops).calls).toBeLessThanOrEqual(4);
  });
});

describe("gate 4: workshopId is FORBIDDEN for ADMIN and FACILITATOR", () => {
  const PLATFORM = "PLATFORM";

  // Both are deliberate design decisions, and they are different facts: an ADMIN's access is
  // platform-wide by definition, and a FACILITATOR sees the workshops they CREATE. The
  // scope rule also relies on this specifically — forbidding the field on FACILITATOR rows is
  // what stops the deferred CO-FACILITATOR role arriving by accident.
  const inviteStaff = (platformRole: string, extra: Record<string, unknown> = {}) => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, members: new FakeMembers([]) });
    return {
      invitations,
      res: app.request(`/v1/teams/${PLATFORM}/invitations`, {
        method: "POST",
        headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
        body: JSON.stringify({
          invitees: [{ email: "staff@example.com", platformRole, ...extra }],
        }),
      }),
    };
  };

  it.each(["ADMIN", "FACILITATOR"])(
    "400s a %s invitation that names a workshop",
    async (platformRole) => {
      const { res, invitations } = inviteStaff(platformRole, { workshopId: "w1" });

      expect((await res).status).toBe(400);
      expect(invitations.rows).toEqual([]);
    }
  );

  it.each(["ADMIN", "FACILITATOR"])(
    "still creates a %s invitation with NO workshop, and stores no such attribute",
    async (platformRole) => {
      // The backward-compatibility half: these invitations must keep working exactly
      // as before, so the form must never demand a workshop for them.
      const { res, invitations } = inviteStaff(platformRole);

      expect((await res).status).toBe(201);
      // No attribute AT ALL, not an empty one — absent means "no workshop grant", and a
      // present-but-empty value is the thing a later reader could misread as a grant.
      expect(invitations.rows[0]).not.toHaveProperty("workshopId");
    }
  );

  it("explains WHY per role, so an operator is not left guessing", async () => {
    const admin = await inviteStaff("ADMIN", { workshopId: "w1" }).res;
    expect((await admin.json()).error).toMatch(/platform-wide/i);

    const fac = await inviteStaff("FACILITATOR", { workshopId: "w1" }).res;
    expect((await fac.json()).error).toMatch(/workshops they create/i);
  });
});

describe("gate 4: workshopId is SERVER-DERIVED for PARTICIPANT and EXECUTIVE", () => {
  // These roles are team-scoped and already 400 at platform scope, so the workshop is
  // never a question the client answers: it is the team's own workshopId. Derived rather
  // than trusted because this is an access grant, and an access grant must not come from
  // a request body.

  const inviteToTeam = (
    platformRole: string,
    extra: Record<string, unknown> = {},
    teams = new FakeTeams([team()])
  ) => {
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      teams,
      members: new FakeMembers([MEMBER_T1("admin")]),
    });
    return {
      invitations,
      res: app.request("/v1/teams/t1/invitations", {
        method: "POST",
        headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
        body: JSON.stringify({
          invitees: [{ email: "member@example.com", platformRole, ...extra }],
        }),
      }),
    };
  };

  it.each(["PARTICIPANT", "EXECUTIVE"])(
    "stamps a %s row with the TEAM's workshop, with nothing supplied by the client",
    async (platformRole) => {
      const { res, invitations } = inviteToTeam(platformRole);

      expect((await res).status).toBe(201);
      // "w1" is team()'s workshopId — taken from the team, not from the request.
      expect(invitations.rows[0].workshopId).toBe("w1");
    }
  );

  it.each(["PARTICIPANT", "EXECUTIVE"])(
    "400s a %s whose client-supplied workshopId DISAGREES with the team's",
    async (platformRole) => {
      // Refused rather than silently overridden. The caller believes they are inviting
      // into w-elsewhere; quietly writing w1 would grant access they did not intend,
      // and quietly honouring w-elsewhere would let the body pick the grant.
      const { res, invitations } = inviteToTeam(platformRole, {
        workshopId: "w-elsewhere",
      });

      expect((await res).status).toBe(400);
      expect(invitations.rows).toEqual([]);
    }
  );

  it.each(["PARTICIPANT", "EXECUTIVE"])(
    "accepts a %s whose client value AGREES — redundant, not wrong",
    async (platformRole) => {
      const { res, invitations } = inviteToTeam(platformRole, { workshopId: "w1" });

      expect((await res).status).toBe(201);
      expect(invitations.rows[0].workshopId).toBe("w1");
    }
  );

  it("derives ONCE for a whole batch rather than per invitee", async () => {
    // The team lookup is memoised, so a batch is one read regardless of size. Counted
    // rather than asserted in prose: an N+1 on the teams table is exactly what deriving
    // at READ time would have cost, and the design chose stored-at-write to avoid it.
    let reads = 0;
    class CountingTeams extends FakeTeams {
      async getById(id: string) {
        reads++;
        return super.getById(id);
      }
    }
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      teams: new CountingTeams([team()]),
      members: new FakeMembers([MEMBER_T1("admin")]),
    });

    // ⚠ THE CALLER'S EMAIL IS DELIBERATELY NOT IN THE LIST. It used to be `a@example.com` inviting
    // `["a@example.com", …]` — an accidental SELF-INVITATION, which gate 3 refuses,
    // so this test 403'd on its fixture rather than on its subject. The subject is
    // the MEMOISED team read; the addresses are incidental and now say so.
    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "admin@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        emails: ["a@example.com", "b@example.com", "c@example.com"],
        platformRole: "PARTICIPANT",
      }),
    });

    expect(res.status).toBe(201);
    expect(invitations.rows).toHaveLength(3);
    expect(reads).toBe(1);
  });

  it("400s rather than storing an unscoped row when the team cannot be resolved", async () => {
    // A dangling teamId (team deleted between the read gate and this one). Gate 2 has
    // already proved the caller may see this team, so this is a data problem — and the
    // honest answer is a refusal, not a row with no grant on it.
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      teams: new FakeTeams([]),
      members: new FakeMembers([MEMBER_T1("admin")]),
    });

    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({ emails: ["x@example.com"], platformRole: "PARTICIPANT" }),
    });

    expect(res.status).toBe(400);
    expect(invitations.rows).toEqual([]);
  });

  it("leaves a LEGACY row's absent workshopId alone on every read path", async () => {
    // Backward compatibility, stated as a test rather than as a hope: rows written
    // before this field existed have no workshopId, and absent must mean "no workshop
    // grant" without breaking any read. /invitations/mine is the richest of them.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "legacy@example.com", platformRole: "PARTICIPANT" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/invitations/mine", {
      headers: asUser({ id: "u1", email: "legacy@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(200);
    const [row] = (await res.json()).invitations;
    // The route reports the TEAM's workshop (it always did); the point is that a row
    // with no stored workshopId does not break or invent one.
    expect(row.teamId).toBe("t1");
    expect(invitations.rows[0]).not.toHaveProperty("workshopId");
  });
});

describe("gate 4: BATCH ATOMICITY — one bad invitee writes nothing", () => {
  const PLATFORM = "PLATFORM";

  // The same all-or-nothing property gate 3 has, extended to the workshop rules. There
  // is no partial-success story for granting a role and none for granting a workshop:
  // a half-written batch leaves live grants the operator did not think they had sent.

  it("writes NOTHING when a LATER invitee names a workshop the caller does not own", async () => {
    // The ordering that matters: the legal invitee comes FIRST, so an implementation
    // that validated-then-wrote per invitee would have already persisted it.
    const invitations = new FakeInvitations([]);
    class OwnsOnlyMine implements WorkshopAccess {
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

      calls = 0;
      async ownsTeamWorkshop(): Promise<boolean> {
        return false;
      }
      async ownsWorkshop(workshopId: string): Promise<boolean> {
        this.calls++;
        return workshopId === "w-mine";
      }
    }
    const { app } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new OwnsOnlyMine(),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({
        invitees: [
          { email: "legit@example.com", platformRole: "JUDGE", workshopId: "w-mine" },
          { email: "sneaky@example.com", platformRole: "JUDGE", workshopId: "w-theirs" },
        ],
      }),
    });

    expect(res.status).toBe(403);
    // Critically: NOT even the legal first invitee was stored.
    expect(invitations.rows).toEqual([]);
  });

  it("writes NOTHING when a later invitee is a JUDGE with no workshop at all", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, members: new FakeMembers([]), workshops: new FakeWorkshops(true) });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "ok@example.com", platformRole: "JUDGE", workshopId: "w1" },
          { email: "unscoped@example.com", platformRole: "JUDGE" },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(invitations.rows).toEqual([]);
  });

  it("writes NOTHING when a later invitee is a FACILITATOR naming a workshop", async () => {
    // The FORBIDDEN direction of the same property.
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, members: new FakeMembers([]), workshops: new FakeWorkshops(true) });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "judge@example.com", platformRole: "JUDGE", workshopId: "w1" },
          { email: "fac@example.com", platformRole: "FACILITATOR", workshopId: "w1" },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(invitations.rows).toEqual([]);
  });

  it("gives each row of a MIXED, fully legal batch its own correct workshop", async () => {
    // The positive case, and it pins that the resolution is POSITIONAL: a REQUIRED role's
    // named workshop and a FORBIDDEN role's absent one must not be swapped or shared.
    //
    // ── MOVED TO PLATFORM SCOPE ──
    //
    // This used to be one TEAM-scoped batch of JUDGE + PARTICIPANT + ADMIN, which spanned
    // all three WORKSHOP_POLICY values at once. Requirement (b) layer 1 now 400s the JUDGE
    // and ADMIN rows at team scope, and no single scope can still carry all three policies:
    // REQUIRED/FORBIDDEN roles are platform-scoped, DERIVED roles are team-scoped. So the
    // batch is split in two, and BOTH halves keep a genuine positional mix — the property
    // under test is that resolution is per-index, and one batch spanning two policies is
    // enough to prove it. The DERIVED half is the following test.
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([MEMBER_T1("admin")]), workshops: new FakeWorkshops(true),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "judge@example.com", platformRole: "JUDGE", workshopId: "w-judged" },
          { email: "boss@example.com", platformRole: "ADMIN" },
          { email: "fac@example.com", platformRole: "FACILITATOR" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const byEmail = new Map(invitations.rows.map((r) => [r.email, r]));
    expect(byEmail.get("judge@example.com")?.workshopId).toBe("w-judged");
    // FORBIDDEN rows carry NO attribute — not the judge's workshop leaking sideways, and
    // not an empty string a later reader could mistake for a grant.
    expect(byEmail.get("boss@example.com")).not.toHaveProperty("workshopId");
    expect(byEmail.get("fac@example.com")).not.toHaveProperty("workshopId");
  });

  it("DERIVES the workshop per row for a team-scoped batch", async () => {
    // The DERIVED half of the split above: at TEAM scope the two roles that may hold
    // membership both take the workshop from the TEAM, server-side. Kept as its own test
    // rather than folded away, because "derived from the team, never from the request" is
    // the half of gate 4 that stops a client granting itself a workshop.
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([MEMBER_T1("admin")]),
    });

    const res = await app.request("/v1/teams/t1/invitations", {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "builder@example.com", platformRole: "PARTICIPANT" },
          { email: "boss@example.com", platformRole: "EXECUTIVE" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const byEmail = new Map(invitations.rows.map((r) => [r.email, r]));
    expect(byEmail.get("builder@example.com")?.workshopId).toBe("w1");
    expect(byEmail.get("boss@example.com")?.workshopId).toBe("w1");
  });

  it("keeps the SAME address twice from collapsing onto one workshop", async () => {
    // Resolution is positional rather than keyed on email precisely so a batch naming
    // one address twice cannot give the second row the first one's workshop. A map
    // keyed on email would pass every other test in this file and fail this one.
    //
    // MOVED TO PLATFORM SCOPE, same reason as the test above: the JUDGE row is
    // no longer legal at team scope. The pairing is now REQUIRED + FORBIDDEN, which still
    // yields two DIFFERENT resolved values for one address — "w-judged" then absent — so
    // the assertion still fails against an email-keyed implementation.
    //
    // ASSERTED ON THE RESPONSE, NOT ON THE STORE, and that is a CORRECTION rather than a
    // relaxation. It used to read `invitations.rows.map(r => r.workshopId)` and expect TWO
    // rows — a state real DynamoDB cannot hold: the table is (teamId HASH, email RANGE), so
    // two writes for one address are one row, and the second PutCommand OVERWRITES the
    // first. The old assertion only passed because the in-memory fake `push`ed instead of
    // overwriting at the key; fixing the fake to match the store surfaced it.
    //
    // The response is the STRONGER place to assert the property anyway: it carries one item
    // per invitee POSITIONALLY, so an email-keyed resolver gives both items "w-judged" and
    // this fails — which is the drift the test exists to catch. The store's single surviving
    // row is checked too, so the overwrite is pinned rather than merely tolerated.
    const invitations = new FakeInvitations([]);
    const { app } = build({
      invitations,
      members: new FakeMembers([MEMBER_T1("admin")]), workshops: new FakeWorkshops(true),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
      body: JSON.stringify({
        invitees: [
          { email: "dup@example.com", platformRole: "JUDGE", workshopId: "w-judged" },
          { email: "dup@example.com", platformRole: "ADMIN" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invitations: Array<{ workshopId?: string }>;
    };
    expect(body.invitations.map((i) => i.workshopId)).toEqual([
      "w-judged",
      undefined,
    ]);
    // One row at the key, and it is the LAST write — the ADMIN row, which carries no
    // workshop grant at all.
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0].workshopId).toBeUndefined();
  });

  it("runs gate 3 BEFORE gate 4, so a refused ROLE costs no east-west hop", async () => {
    // Ordering as a measured property, not a comment. A batch whose role the caller
    // cannot grant must be refused without ever probing workshop ownership — otherwise
    // an unauthorized caller could make this service call another one.
    const invitations = new FakeInvitations([]);
    const { app, deps } = build({
      invitations,
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request(`/v1/teams/${PLATFORM}/invitations`, {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      // ADMIN is not grantable by a FACILITATOR — gate 3 refuses the batch.
      body: JSON.stringify({
        invitees: [{ email: "x@example.com", platformRole: "ADMIN", workshopId: "w1" }],
      }),
    });

    expect(res.status).toBe(403);
    expect((deps.workshops as FakeWorkshops).calls).toBe(0);
    expect(invitations.rows).toEqual([]);
  });
});

// ─── GET /v1/workshops/:workshopId/teams — THE CONFIRMED ROSTER LEAK (P0-2) ──
//
// This route had NO authorization whatsoever, not even requireIdentity. The leak was
// CONFIRMED EXPLOITABLE against a deployed stack: a direct Lambda invoke carrying a
// gateway authorizer claim for an unrelated PARTICIPANT — "outsider-nobody", a member
// of nothing — returned HTTP 200 with the team name and roster, and `?withMembers=1`
// additionally returned every member's EMAIL. The addresses came back blank only
// because the users read-model was empty; the code applied no protection, so
// a populated environment hands real addresses to any signed-in stranger.
//
// The truth table these tests pin:
//
//   caller                  | teams returned        | member email in withMembers
//   ------------------------|-----------------------|----------------------------
//   unauthenticated         | 401, handler not run  | —
//   ADMIN                   | all (no hop)          | yes
//   FACILITATOR, owner      | all                   | yes
//   FACILITATOR, non-owner  | only their own teams  | no
//   PARTICIPANT / EXECUTIVE | only their own teams  | no
//   JUDGE                   | only their own teams  | no
//   member of nothing in W  | empty list            | —
//
// Every test below is written to FAIL against the unguarded implementation.

describe("GET /v1/workshops/:workshopId/teams — roster visibility", () => {
  /** Two teams in w1, one in an unrelated workshop w9. */
  const threeTeams = () =>
    new FakeTeams([
      team({ id: "t1", name: "Team One" }),
      team({ id: "t2", name: "Team Two" }),
      team({ id: "t9", name: "Other Workshop Team", workshopId: "w9" }),
    ]);

  /** u-insider is on t1 only. Nobody else is on anything. */
  const roster = () =>
    new FakeMembers([
      { teamId: "t1", userId: "u-insider", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t2", userId: "u-other", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);

  const directory = () =>
    new FakeUsers([
      { id: "u-insider", name: "Ada Lovelace", email: "ada@example.com" },
      { id: "u-other", name: "Grace Hopper", email: "grace@example.com" },
    ]);

  const get = (
    app: ReturnType<typeof build>["app"],
    user: { id: string; email?: string; role: string },
    query = ""
  ) => app.request(`/v1/workshops/w1/teams${query}`, { headers: asUser(user) });

  const teamIds = async (res: Response) =>
    ((await res.json()) as { teams: Array<{ id: string }> }).teams.map((t) => t.id).sort();

  it("REFUSES an unauthenticated caller — the handler is never reached", async () => {
    // The floor. Before this change the route sat behind gateway authN only, so an
    // in-VPC or unmapped-route caller reached the handler with no identity at all.
    const { app } = build({ teams: threeTeams(), members: roster() });
    const res = await app.request("/v1/workshops/w1/teams");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("Team One");
  });

  it("CLOSES THE CONFIRMED LEAK: an unrelated PARTICIPANT gets an empty list, not the roster", async () => {
    // The exploit, reproduced exactly as it was found — same role, same "member of
    // nothing" posture. This returned 200 with team names and the full roster.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(app, { id: "outsider-nobody", email: "o@example.com", role: "PARTICIPANT" });

    expect(res.status).toBe(200);
    expect(await teamIds(res)).toEqual([]);
  });

  it("leaks no team NAME to an unrelated participant, even with withMembers=1", async () => {
    // Names and addresses are what actually escaped. Asserted on the raw body so a
    // future shape change cannot smuggle either through a field these tests don't read.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(
      app,
      { id: "outsider-nobody", email: "o@example.com", role: "PARTICIPANT" },
      "?withMembers=1"
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("Team One");
    expect(body).not.toContain("Team Two");
    expect(body).not.toContain("ada@example.com");
    expect(body).not.toContain("grace@example.com");
    expect(JSON.parse(body)).toEqual({ teams: [] });
  });

  it("gives a MEMBER only the teams they are on — not the whole workshop", async () => {
    // The branch that keeps participants working. u-insider is on t1, so they see t1
    // and NOT t2 — sharing a workshop is not sharing a roster.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(app, { id: "u-insider", email: "ada@example.com", role: "PARTICIPANT" });

    expect(res.status).toBe(200);
    expect(await teamIds(res)).toEqual(["t1"]);
  });

  it("never returns a team from a DIFFERENT workshop, even one the caller is on", async () => {
    // The filter is an intersection, not a substitution: membership elsewhere must
    // not pull a foreign workshop's team into this workshop's answer.
    const members = new FakeMembers([
      { teamId: "t9", userId: "u-elsewhere", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const { app } = build({ teams: threeTeams(), members, workshops: new FakeWorkshops(false) });

    const res = await get(app, { id: "u-elsewhere", email: "e@example.com", role: "PARTICIPANT" });

    expect(await teamIds(res)).toEqual([]);
  });

  it.each(["PARTICIPANT", "EXECUTIVE", "JUDGE"])(
    "scopes a %s to their own teams WITHOUT any cross-service hop",
    async (role) => {
      // No non-staff role can own a workshop, so probing ownership for one would be a
      // hop that can only ever answer "no" — and it is the hop that would create the
      // Team → Workshop → Team cycle. It must not happen at all.
      const workshops = new FakeWorkshops(true);
      const { app } = build({ teams: threeTeams(), members: roster(), workshops });

      const res = await get(app, { id: "u-insider", email: "a@example.com", role });

      expect(res.status).toBe(200);
      expect(await teamIds(res)).toEqual(["t1"]);
      expect(workshops.calls).toBe(0);
    }
  );

  it("gives an ADMIN every team ONLY in a workshop they own, and CONSULTS ownership to find out", async () => {
    // ⚠ INVERTED. This asserted every team with `workshops.calls === 0` — "ADMIN is decided from
    // the token alone … an admin roster read must not depend on the Workshop service being up".
    // It now does depend on it, which is the cost of scoping the role; the branch is
    // now the same `isStaffRole && ownsWorkshop` one a facilitator takes.
    const owns = new FakeWorkshops(true);
    const { app } = build({ teams: threeTeams(), members: new FakeMembers([]), workshops: owns });

    const res = await get(app, { id: "admin", email: "a@b.c", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(await teamIds(res)).toEqual(["t1", "t2"]);
    expect(owns.calls).toBe(1);
  });

  it("scopes an ADMIN who does NOT own this workshop to their own teams — which is NONE", async () => {
    // ⚠ THE LEAK THIS CLOSED, ASSERTED DIRECTLY. `seesAllTeams` used to be
    // `role === "ADMIN" || (isStaffRole && ownsWorkshop)`, so any admin got every team in any
    // workshop AND — via the same flag under `?withMembers=1` — every member's EMAIL ADDRESS.
    //
    // The filtered branch intersects with the caller's MEMBERSHIPS, and an ADMIN is refused a
    // membership row outright (the member-only requirement), so the honest answer for a non-owning
    // admin is the EMPTY LIST. Not a 403: the route answers "the teams you can see here", and
    // that is a truthful, non-disclosing zero.
    const { app } = build({
      teams: threeTeams(),
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(app, { id: "admin", email: "a@b.c", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(await teamIds(res)).toEqual([]);
  });

  it("gives the workshop OWNER every team, even as a member of none of them", async () => {
    const { app } = build({
      teams: threeTeams(),
      members: new FakeMembers([]),
      workshops: new FakeWorkshops(true),
    });

    const res = await get(app, { id: "f1", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await teamIds(res)).toEqual(["t1", "t2"]);
  });

  it("scopes a FACILITATOR who does NOT own this workshop to their own teams", async () => {
    // Facilitators see what they created. A facilitator running a different workshop
    // is, for this workshop, just another user — the owner check is per-workshop, not
    // a blanket staff pass.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(app, { id: "u-insider", email: "f2@example.com", role: "FACILITATOR" });

    expect(await teamIds(res)).toEqual(["t1"]);
  });

  it("returns an EMPTY list for a workshop with no teams rather than falling through", async () => {
    const { app } = build({ teams: new FakeTeams([]), workshops: new FakeWorkshops(true) });
    const res = await get(app, { id: "admin", email: "a@b.c", role: "ADMIN" });
    expect(await teamIds(res)).toEqual([]);
  });

  // ── withMembers: email is minimised, not refused ───────────────────────────

  it("DISCLOSES member emails to an OWNING ADMIN under withMembers=1", async () => {
    // The capability that must survive: the admin workshop-detail view renders addresses, and
    // this is the call that supplies them. ⚠ `FakeWorkshops(true)` is required — email
    // disclosure rides on `seesAllTeams`, which is now the ownership set rather than
    // "ADMIN or the owner". The non-owning case is asserted two tests up: no teams, so no
    // addresses.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(true),
    });

    const res = await get(app, { id: "admin", email: "a@b.c", role: "ADMIN" }, "?withMembers=1");
    const body = (await res.json()) as {
      teams: Array<{ id: string; members: Array<{ user: { email?: string } }> }>;
    };

    const t1 = body.teams.find((t) => t.id === "t1")!;
    expect(t1.members[0].user.email).toBe("ada@example.com");
  });

  it("DISCLOSES member emails to the workshop OWNER under withMembers=1", async () => {
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(true),
    });

    const res = await get(app, { id: "f1", email: "f@example.com", role: "FACILITATOR" }, "?withMembers=1");
    const body = (await res.json()) as {
      teams: Array<{ id: string; members: Array<{ user: { email?: string } }> }>;
    };

    expect(body.teams.find((t) => t.id === "t1")!.members[0].user.email).toBe("ada@example.com");
  });

  it("OMITS email on the member-filtered branch — for the caller's OWN team", async () => {
    // The minimisation, and the case that proves it is about the BRANCH rather than
    // about the row: this is Ada's own team and her own address, and it is still
    // omitted, because the branch is not entitled to the field. Names and counts
    // survive, which is what the UI on that path actually renders.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(
      app,
      { id: "u-insider", email: "ada@example.com", role: "PARTICIPANT" },
      "?withMembers=1"
    );
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      teams: Array<{ id: string; members: Array<{ user: { name: string; email?: string } }>; _count: { members: number } }>;
    };

    expect(res.status).toBe(200);
    expect(body.teams.map((t) => t.id)).toEqual(["t1"]);
    expect(body.teams[0]._count).toEqual({ members: 1 });
    expect(body.teams[0].members[0].user.name).toBe("Ada Lovelace");
    expect(body.teams[0].members[0].user).not.toHaveProperty("email");
    // Belt and braces: no address anywhere in the payload, whatever the shape.
    expect(raw).not.toContain("ada@example.com");
  });

  it("accepts withMembers=1 on the filtered branch rather than 400-ing it", async () => {
    // The portal's workshop.getById fans out to this route with withMembers=1 inside
    // a Promise.all, and a participant reaches that on their own team's pages.
    // Refusing the parameter would reject the whole fan-out and break the page for
    // exactly the people the filtered branch exists to keep working.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(
      app,
      { id: "u-insider", email: "ada@example.com", role: "PARTICIPANT" },
      "?withMembers=1"
    );

    expect(res.status).toBe(200);
  });

  it("does not enrich members for teams the caller cannot see", async () => {
    // The filter runs BEFORE enrichment, so a hidden team costs no read-model
    // lookups and cannot leak through the members array of a team that was excluded.
    const { app } = build({
      teams: threeTeams(),
      members: roster(),
      users: directory(),
      workshops: new FakeWorkshops(false),
    });

    const res = await get(
      app,
      { id: "u-insider", email: "ada@example.com", role: "PARTICIPANT" },
      "?withMembers=1"
    );
    const body = await res.text();

    expect(body).not.toContain("Grace Hopper");
    expect(body).not.toContain("u-other");
  });
});

// ─── GET /v1/workshops/:workshopId/membership ───────────────────────────────
//
// The membership half of the Workshop service's read gate, answered by the context
// that owns teamMembers. Its two invariants are structural: it consults no
// WorkshopAccess (so it cannot recurse into Workshop), and it answers only about the
// CALLER (so it is not an enumeration oracle).

describe("GET /v1/workshops/:workshopId/membership", () => {
  const threeTeams = () =>
    new FakeTeams([
      team({ id: "t1" }),
      team({ id: "t2" }),
      team({ id: "t9", workshopId: "w9" }),
    ]);

  const roster = () =>
    new FakeMembers([
      { teamId: "t1", userId: "u-insider", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t9", userId: "u-elsewhere", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);

  const ask = (
    app: ReturnType<typeof build>["app"],
    user: { id: string; email?: string; role: string },
    query = ""
  ) => app.request(`/v1/workshops/w1/membership${query}`, { headers: asUser(user) });

  it("requires authentication", async () => {
    const { app } = build({ teams: threeTeams(), members: roster() });
    const res = await app.request("/v1/workshops/w1/membership");
    expect(res.status).toBe(401);
  });

  it("says YES for a member of a team in the workshop", async () => {
    const { app } = build({ teams: threeTeams(), members: roster() });
    const res = await ask(app, { id: "u-insider", email: "a@example.com", role: "PARTICIPANT" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isMember: true });
  });

  it("says NO for someone on a team in a DIFFERENT workshop", async () => {
    const { app } = build({ teams: threeTeams(), members: roster() });
    const res = await ask(app, { id: "u-elsewhere", email: "e@example.com", role: "PARTICIPANT" });
    expect(await res.json()).toEqual({ isMember: false });
  });

  it("says NO for a member of nothing, and for a workshop with no teams", async () => {
    const { app } = build({ teams: threeTeams(), members: roster() });
    expect(
      await (await ask(app, { id: "nobody", email: "n@example.com", role: "PARTICIPANT" })).json()
    ).toEqual({ isMember: false });

    const { app: empty } = build({ teams: new FakeTeams([]), members: roster() });
    expect(
      await (await ask(empty, { id: "u-insider", email: "a@example.com", role: "PARTICIPANT" })).json()
    ).toEqual({ isMember: false });
  });

  it("NEVER consults the Workshop service — the no-recursion invariant, by construction", async () => {
    // This is the route the Workshop service's read gate calls. If it could ask
    // Workshop anything, gating GET /v1/workshops/:id would create
    // Team → Workshop → Team on one Lambda pool: self-amplifying under load,
    // deadlocking concurrency rather than degrading. Asserted for BOTH answers, so
    // neither the hit nor the miss path can grow a hop later.
    const workshops = new FakeWorkshops(true);
    const { app } = build({ teams: threeTeams(), members: roster(), workshops });

    await ask(app, { id: "u-insider", email: "a@example.com", role: "PARTICIPANT" });
    await ask(app, { id: "nobody", email: "n@example.com", role: "PARTICIPANT" });
    await ask(app, { id: "admin", email: "a@b.c", role: "ADMIN" });

    expect(workshops.calls).toBe(0);
  });

  it("IGNORES a ?userId= parameter — it answers only about the caller", async () => {
    // An entitlement probe that accepts a subject is an enumeration oracle: it would
    // let any signed-in user map who is in which workshop. The answer must track the
    // verified token and nothing else.
    const { app } = build({ teams: threeTeams(), members: roster() });

    const spoofed = await ask(
      app,
      { id: "nobody", email: "n@example.com", role: "PARTICIPANT" },
      "?userId=u-insider"
    );
    expect(await spoofed.json()).toEqual({ isMember: false });

    const honest = await ask(
      app,
      { id: "u-insider", email: "a@example.com", role: "PARTICIPANT" },
      "?userId=nobody"
    );
    expect(await honest.json()).toEqual({ isMember: true });
  });
});

// ─── POST /v1/workshops/:workshopId/teams ───────────────────────────────────

describe("POST /v1/workshops/:workshopId/teams — creating a team is staff-only", () => {
  const createAs = (
    app: ReturnType<typeof build>["app"],
    user: { id: string; email: string; role: string }
  ) =>
    app.request("/v1/workshops/w1/teams", {
      method: "POST",
      headers: asUser(user),
      body: JSON.stringify({ name: "New Team" }),
    });

  it.each(["PARTICIPANT", "EXECUTIVE", "JUDGE"])(
    "refuses a %s, who cannot own a workshop",
    async (role) => {
      // This route makes its caller the team LEAD unconditionally, and team
      // membership is what canRead/canWrite are decided from — so an unguarded
      // create is a way to manufacture access to any workshop id you can name.
      const teams = new FakeTeams([]);
      const members = new FakeMembers([]);
      const { app } = build({ teams, members, workshops: new FakeWorkshops(false) });

      const res = await createAs(app, { id: "u1", email: "u@example.com", role });

      expect(res.status).toBe(403);
      expect(teams.rows).toHaveLength(0);
      expect(members.rows).toHaveLength(0);
    }
  );

  it("refuses a FACILITATOR who does not own THIS workshop", async () => {
    const teams = new FakeTeams([]);
    const { app } = build({ teams, workshops: new FakeWorkshops(false) });

    const res = await createAs(app, { id: "f2", email: "f2@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(403);
    expect(teams.rows).toHaveLength(0);
  });

  it("allows the FACILITATOR who owns the workshop, and creates the team EMPTY", async () => {
    // The creator is NOT added as a member. Owner: "there should be no members in
    // team yet" — a facilitator creating a team is staff setting the workshop up, not
    // a participant who will build in it. The old behaviour inserted them as LEAD,
    // which showed "Members (1) — LEAD" on a roster nobody had joined and
    // pre-assigned a lead the actual team never chose.
    const teams = new FakeTeams([]);
    const members = new FakeMembers([]);
    const { app } = build({ teams, members, workshops: new FakeWorkshops(true) });

    const res = await createAs(app, { id: "f1", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(201);
    expect(teams.rows).toHaveLength(1);
    expect(members.rows).toHaveLength(0);
  });

  it("leaves the creating FACILITATOR able to ADMINISTER the team, but not read its CONTENT", async () => {
    // THE REASON REMOVING THE MEMBER ROW IS SAFE, asserted rather than reasoned about.
    // canRead grants access on `isStaffRole(role) && ownsTeamWorkshop(...)`
    // INDEPENDENTLY of membership, so an empty roster must not lock the owner out of
    // the team they just made. If the administration half ever fails, the auto-LEAD insert
    // was load-bearing after all and removing it broke authorization.
    //
    // ── AMENDED ──
    //
    // This used to assert `{canRead: true, canWrite: true}` and that was the WHOLE answer,
    // so the creating facilitator also got the team's board, chat, AI threads and code. The
    // administration half is unchanged and is what keeps the roster, invitations and member
    // removal working for them; the CONTENT half is now false, which is the whole member-only rule in one
    // assertion. And note requirement (b): they cannot fix this by joining their own team.
    const teams = new FakeTeams([]);
    const members = new FakeMembers([]);
    const { app } = build({ teams, members, workshops: new FakeWorkshops(true) });

    await createAs(app, { id: "f1", email: "f@example.com", role: "FACILITATOR" });
    const teamId = teams.rows[0].id;

    const res = await app.request(`/v1/teams/${teamId}/access`, {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      canRead: true,
      canWrite: true,
      canReadContent: false,
      canWriteContent: false,
    });
  });

  it("allows a global ADMIN without consulting workshop ownership", async () => {
    // FakeWorkshops(false) would refuse ownership; ADMIN must short-circuit before
    // the cross-service hop, matching canRead's own ADMIN branch.
    const teams = new FakeTeams([]);
    const { app } = build({ teams, workshops: new FakeWorkshops(false) });

    const res = await createAs(app, { id: "admin", email: "a@b.c", role: "ADMIN" });

    expect(res.status).toBe(201);
    expect(teams.rows).toHaveLength(1);
  });

  it("requires authentication", async () => {
    const { app } = build();
    const res = await app.request("/v1/workshops/w1/teams", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

// ─── GET /v1/directory/user-ids ─────────────────────────────────────────────────
//
// Backs the Administration screen's TEAM and WORKSHOP filters. It answers a
// TEAM-context question ("who is in team X") for an IDENTITY-context screen, which is
// why it returns bare ids: names and roles are Identity's to disclose, behind its own
// visibility rule.

describe("GET /v1/directory/user-ids", () => {
  const roster = () =>
    new FakeMembers([
      { teamId: "t1", userId: "u1", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t1", userId: "u2", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t2", userId: "u2", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t2", userId: "u3", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);

  const twoTeams = () =>
    new FakeTeams([team({ id: "t1" }), team({ id: "t2" }), team({ id: "t9", workshopId: "w9" })]);

  it("returns a team's member ids", async () => {
    const { app } = build({ members: roster(), teams: twoTeams() });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { userIds: string[]; teamIds: string[] };
    expect(body.userIds.sort()).toEqual(["u1", "u2"]);
    expect(body.teamIds).toEqual(["t1"]);
  });

  it("fans out across a workshop's teams and DEDUPLICATES shared members", async () => {
    // u2 is on both t1 and t2. A duplicated id would hydrate to a duplicated row on
    // screen, and the fix belongs here rather than in every consumer.
    const { app } = build({ members: roster(), teams: twoTeams() });
    const res = await app.request("/v1/directory/user-ids?workshopId=w1", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    const body = (await res.json()) as { userIds: string[]; teamIds: string[] };
    expect(body.userIds.sort()).toEqual(["u1", "u2", "u3"]);
    expect(body.teamIds.sort()).toEqual(["t1", "t2"]);
  });

  it("returns an EMPTY list for a workshop with no teams — not everyone", async () => {
    // The caller uses this result as a filter, so an empty answer that reads as "no
    // filter" would turn an empty workshop into the whole directory.
    const { app } = build({ members: roster(), teams: twoTeams() });
    const res = await app.request("/v1/directory/user-ids?workshopId=w-empty", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userIds: [], teamIds: [] });
  });

  it("returns an empty list for a team with no members", async () => {
    const { app } = build({ members: new FakeMembers([]), teams: twoTeams() });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    const body = (await res.json()) as { userIds: string[] };
    expect(body.userIds).toEqual([]);
  });

  /**
   * ⚠ INVERTED, AND THE OLD COMMENT IS WORTH READING AS THE CAUSE. It said: "A
   * FACILITATOR must be able to filter by ANY team, not only teams in workshops they own: THE
   * DIRECTORY ALREADY SHOWS THEM EVERY NON-ADMIN USER, so a filter gated on workshop ownership
   * would be narrower than the list it filters."
   *
   * Sound when written; its premise died when the teams directory became ownership-scoped.
   * A facilitator can no longer enumerate another owner's teams — and this route was
   * still telling them who is IN them. Bare ids, so an ASSOCIATION leak rather than a PII one,
   * but that association is precisely what `seesAllTeams` now refuses.
   *
   * The objection stands and is accepted: the filter IS now narrower than the user list. The list
   * discloses who EXISTS (user administration, role-based); the filter would disclose who is
   * WHERE (experience data, ownership-based).
   */
  it("REFUSES a FACILITATOR filtering a team in a workshop they do NOT own", async () => {
    const { app } = build({
      members: roster(),
      teams: twoTeams(),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w-other", name: "Not t1's" }]),
    });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "facil", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("DIRECTORY_SCOPE_FORBIDDEN");
  });

  it("lets a FACILITATOR filter a team in a workshop they DO own", async () => {
    // The positive half. `twoTeams()`'s t1 lives in w1, which this facilitator owns.
    const { app } = build({
      members: roster(),
      teams: twoTeams(),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Theirs" }]),
    });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "facil", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { userIds: string[] }).userIds.sort()).toEqual(["u1", "u2"]);
  });

  it("REFUSES a FACILITATOR naming a workshopId they do not own", async () => {
    const { app } = build({
      members: roster(),
      teams: twoTeams(),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Theirs" }]),
    });
    const res = await app.request("/v1/directory/user-ids?workshopId=w-someone-elses", {
      headers: asUser({ id: "facil", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
  });

  it("⚠ 503s rather than 403s when the ownership scope cannot be determined", async () => {
    // The access-decision rule, applied to a filter: "could not ask" must not be reported as "not yours". This is
    // WHY the check uses the three-valued `listOwnedWorkshops` rather than the fail-closed
    // `ownsWorkshop`, which collapses a brownout into `false`.
    const { app } = build({
      members: roster(),
      teams: twoTeams(),
      workshopDirectory: new FakeWorkshopDirectory("unavailable"),
    });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "facil", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { code: string }).code).toBe("DIRECTORY_SCOPE_UNAVAILABLE");
  });

  it("leaves an ADMIN platform-wide, with NO ownership hop", async () => {
    // ⚠ THE RULE, and the one area where ADMIN is deliberately not experience-scoped:
    // user administration (ROLES.md's ⚙ rows). Asserted on the hop COUNT as well as the status,
    // because "allowed" and "allowed without asking" are different properties — and an admin
    // filter that made a Workshop hop would 503 during a brownout for no benefit.
    const workshopDirectory = new FakeWorkshopDirectory([]);
    const { app } = build({ members: roster(), teams: twoTeams(), workshopDirectory });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "boss", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { userIds: string[] }).userIds.sort()).toEqual(["u1", "u2"]);
    expect(workshopDirectory.scopeCalls).toBe(0);
  });

  // canInvite would be the wrong gate here: it is true for EXECUTIVE and JUDGE, who
  // may bring people in but must not enumerate the directory.
  it("refuses JUDGE, EXECUTIVE and PARTICIPANT with 403", async () => {
    for (const role of ["JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      const { app } = build({ members: roster(), teams: twoTeams() });
      const res = await app.request("/v1/directory/user-ids?teamId=t1", {
        headers: asUser({ id: "someone", role }),
      });
      expect(res.status, role).toBe(403);
    }
  });

  it("fails closed on an unrecognised role", async () => {
    const { app } = build({ members: roster(), teams: twoTeams() });
    const res = await app.request("/v1/directory/user-ids?teamId=t1", {
      headers: asUser({ id: "someone", role: "SUPERUSER" }),
    });
    expect(res.status).toBe(403);
  });

  it("requires exactly one of teamId or workshopId", async () => {
    const { app } = build({ members: roster(), teams: twoTeams() });
    for (const qs of ["", "?teamId=t1&workshopId=w1"]) {
      const res = await app.request(`/v1/directory/user-ids${qs}`, {
        headers: asUser({ id: "admin", role: "ADMIN" }),
      });
      expect(res.status, qs || "(neither)").toBe(400);
    }
  });

  it("requires authentication", async () => {
    const { app } = build({ members: roster(), teams: twoTeams() });
    const res = await app.request("/v1/directory/user-ids?teamId=t1");
    expect(res.status).toBe(401);
  });
});

// ─── GET /v1/directory/invited-by ───────────────────────────────────────────────

describe("GET /v1/directory/invited-by", () => {
  it("reports the inviter's SUB, never a resolved name", async () => {
    // The inviter is subject to the same visibility rule as anyone else, so only
    // Identity may turn this sub into a name. Returning a name here would route around
    // the one place that knows the rule.
    const invitations = new FakeInvitations([
      invitation({ email: "p1@example.com", invitedBy: "admin-sub" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/directory/invited-by?emails=p1@example.com", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitedBy: Record<string, { inviterId: string; basis: string }>;
    };
    expect(body.invitedBy["p1@example.com"].inviterId).toBe("admin-sub");
    expect(JSON.stringify(body)).not.toContain("name");
  });

  // A table with NO accepted rows leaves EARLIEST_INVITE as the only path that
  // fires — which is exactly why the distinction has to be reported.
  it("marks a PENDING-only answer as inferred, not recorded", async () => {
    const invitations = new FakeInvitations([
      invitation({
        email: "p1@example.com",
        invitedBy: "second-inviter",
        sentAt: "2026-02-01T00:00:00.000Z",
        teamId: "t2",
      }),
      invitation({
        email: "p1@example.com",
        invitedBy: "first-inviter",
        sentAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/directory/invited-by?emails=p1@example.com", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    const body = (await res.json()) as {
      invitedBy: Record<string, { inviterId: string; basis: string }>;
    };
    // EARLIEST wins among un-redeemed offers: the first person who brought them in.
    expect(body.invitedBy["p1@example.com"]).toMatchObject({
      inviterId: "first-inviter",
      basis: "EARLIEST_INVITE",
    });
  });

  it("prefers the ACCEPTED row over an earlier PENDING one, and says so", async () => {
    const invitations = new FakeInvitations([
      invitation({
        email: "p1@example.com",
        invitedBy: "earlier-but-unredeemed",
        sentAt: "2026-01-01T00:00:00.000Z",
      }),
      invitation({
        email: "p1@example.com",
        invitedBy: "the-one-they-used",
        sentAt: "2026-03-01T00:00:00.000Z",
        teamId: "t2",
        status: "ACCEPTED",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/directory/invited-by?emails=p1@example.com", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    const body = (await res.json()) as {
      invitedBy: Record<string, { inviterId: string; basis: string }>;
    };
    expect(body.invitedBy["p1@example.com"]).toMatchObject({
      inviterId: "the-one-they-used",
      basis: "ACCEPTED",
    });
  });

  it("reports PLATFORM scope with no teamId, and TEAM scope with one", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "facil@example.com", teamId: "PLATFORM", invitedBy: "admin-sub" }),
      invitation({ email: "p1@example.com", teamId: "t1", invitedBy: "admin-sub" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/directory/invited-by?emails=facil@example.com,p1@example.com",
      { headers: asUser({ id: "admin", role: "ADMIN" }) }
    );

    const body = (await res.json()) as {
      invitedBy: Record<string, { scope: string; teamId: string | null }>;
    };
    expect(body.invitedBy["facil@example.com"]).toMatchObject({
      scope: "PLATFORM",
      teamId: null,
    });
    expect(body.invitedBy["p1@example.com"]).toMatchObject({
      scope: "TEAM",
      teamId: "t1",
    });
  });

  it("matches case-insensitively but echoes the caller's own spelling back", async () => {
    // Invitations are stored lower-cased; the key has to be the spelling the caller
    // asked with, or they cannot match the answer to the row they asked about.
    const invitations = new FakeInvitations([
      invitation({ email: "p1@example.com", invitedBy: "admin-sub" }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/directory/invited-by?emails=P1@Example.COM", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    const body = (await res.json()) as { invitedBy: Record<string, unknown> };
    expect(Object.keys(body.invitedBy)).toEqual(["P1@Example.COM"]);
  });

  // The bootstrap admin has no invitation row, and neither does anyone whose row was
  // cleaned up after acceptance. An absent key is "we have no record", which is what
  // it means everywhere else in this API.
  it("OMITS an email with no invitation rather than mapping it to null", async () => {
    const { app } = build({ invitations: new FakeInvitations([]) });
    const res = await app.request("/v1/directory/invited-by?emails=nobody@example.com", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invitedBy: {} });
  });

  it("omits a row whose invitedBy is missing", async () => {
    const invitations = new FakeInvitations([
      invitation({ email: "p1@example.com", invitedBy: "" }),
    ]);
    const { app } = build({ invitations });
    const res = await app.request("/v1/directory/invited-by?emails=p1@example.com", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(await res.json()).toEqual({ invitedBy: {} });
  });

  it("answers an empty emails list with an empty map", async () => {
    const { app } = build();
    const res = await app.request("/v1/directory/invited-by?emails=", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invitedBy: {} });
  });

  it("rejects more than 100 emails with a 400", async () => {
    const { app } = build();
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`).join(",");
    const res = await app.request(`/v1/directory/invited-by?emails=${many}`, {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(400);
  });

  it("refuses JUDGE, EXECUTIVE and PARTICIPANT with 403", async () => {
    for (const role of ["JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      const { app } = build();
      const res = await app.request("/v1/directory/invited-by?emails=p1@example.com", {
        headers: asUser({ id: "someone", role }),
      });
      expect(res.status, role).toBe(403);
    }
  });

  it("requires authentication", async () => {
    const { app } = build();
    const res = await app.request("/v1/directory/invited-by?emails=p1@example.com");
    expect(res.status).toBe(401);
  });
});

/**
 * REMOVING A MEMBER, AND THE AUDIT TRAIL BEHIND IT.
 *
 * Owner: "there are 2 things like removing the user from a team and totally disabling user
 * access for both we need audit trail like whose action was that".
 *
 * This route had NO test coverage at all, and no audit: it deleted the membership row —
 * the only trace the person had ever been on the team — and published `member.left`
 * carrying `{teamId, userId}` with NO ACTOR. "Who removed this person?" was unanswerable
 * from the database, the events, or the logs.
 *
 * ── AND THE REMOVAL IS A DEACTIVATION, NOT A DELETE ──
 *
 * Owner: "keep the user with inactive state for audit and can be make active later". The row
 * SURVIVES with `status: INACTIVE`. Access is unchanged — `members.get()` answers null for such
 * a row, so every predicate refuses a removed person exactly as before — and the tests that
 * assert "no access after removal" all still pass through that mechanism rather than through an
 * absent row. The ones that asserted the ROW WAS GONE are inverted below, each with a comment
 * naming what it used to assert.
 */
describe("DELETE /v1/teams/:teamId/members/:userId — removal is audited", () => {
  const remove = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    userId = "victim"
  ) =>
    app.request(`/v1/teams/t1/members/${userId}`, {
      method: "DELETE",
      headers: asUser(identity),
    });

  it("records WHO removed WHOM, from which team", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t1", userId: "fac", role: "LEAD", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, audited: true });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      // The actor's role AT THE TIME — a historical fact, so it is stored rather than
      // re-derived from a directory that may since have changed.
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
  });

  it("denormalises the team NAME, so the trail survives a rename or deletion", async () => {
    const teams = new FakeTeams([team({ id: "t1", name: "5 Stars" })]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ teams, members, audit, workshops: new FakeWorkshops(true) });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    // Resolved at read time it would say "(deleted team)" — losing the fact it recorded.
    expect(audit.entries[0].teamName).toBe("5 Stars");
  });

  it("STILL REMOVES the member when the audit write fails, and says so", async () => {
    // THE ORDERING GUARANTEE. The row is already deleted by the time the audit is
    // attempted, so throwing here would make the operator retry and get "not a member" —
    // leaving them unsure whether anything happened. `audited: false` is how the caller
    // learns an access change went unrecorded, which is worth an alarm but not a failure.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit(true); // failing store
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, audited: false });
    // The removal HAPPENED — that is the point.
    expect(await members.get("t1", "victim")).toBeNull();
  });

  it("records an operator-supplied REASON from the request body", async () => {
    // Read from the BODY rather than a query parameter: the reason is free text that may
    // name a person, and a query string lands in gateway access logs and browser history.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: { ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }), "content-type": "application/json" },
      body: JSON.stringify({ reason: "  left the programme  " }),
    });

    expect(res.status).toBe(200);
    expect(audit.entries[0].reason).toBe("left the programme");
  });

  it("still removes when the request carries NO BODY AT ALL", async () => {
    // THE REGRESSION THIS GUARDS. `c.req.json()` REJECTS on an empty body, and a DELETE
    // with no body is what every caller that predates the reason field sends — so an
    // unguarded parse would turn all of them into 500s. The reason is optional, and an
    // optional field must not be able to fail the operation.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(audit.entries[0].reason).toBeUndefined();
    expect(await members.get("t1", "victim")).toBeNull();
  });

  it("still removes when the body is UNPARSEABLE, treating the reason as absent", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: { ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }), "content-type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(200);
    expect(audit.entries[0].reason).toBeUndefined();
  });

  it("TRUNCATES an over-long reason in code points rather than failing the removal", async () => {
    // Losing the tail of a note is a smaller loss than losing the entry — and the entry is
    // append-only, so a lone surrogate written by a UTF-16 slice could never be repaired.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: { ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }), "content-type": "application/json" },
      // 250 astral-plane characters: 250 code points, 500 UTF-16 units.
      body: JSON.stringify({ reason: "\u{1F600}".repeat(250) }),
    });

    expect(res.status).toBe(200);
    const stored = audit.entries[0].reason as string;
    expect([...stored]).toHaveLength(200);
    expect(stored).toBe("\u{1F600}".repeat(200));
  });

  it("ignores a non-string reason rather than coercing it", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: { ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }), "content-type": "application/json" },
      body: JSON.stringify({ reason: { nested: "object" } }),
    });

    expect(res.status).toBe(200);
    expect(audit.entries[0].reason).toBeUndefined();
  });

  /**
   * ── THE STORED REASON CARRIES NO CONTROL CHARACTERS ──
   *
   * The trail is APPEND-ONLY and never deleted, so a newline, a NUL or a bidi override written
   * here is permanent: the newline forges a second LINE in any renderer that prints the trail as
   * text, U+202E makes the RENDERED reason differ from the stored one, and a NUL truncates the
   * string in a C-backed consumer. Not forgery — the structured fields come from the verified
   * token — but permanent pollution of a record read during an incident.
   *
   * The corresponding DEFECT test in authz-attack.test.ts asserted every one of these survived.
   * It now FAILS, which is the correct outcome; these are the positive assertions.
   */
  const removeWithReason = async (reason: string) => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: {
        ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason }),
    });
    expect(res.status).toBe(200);
    return audit.entries[0];
  };

  it("STRIPS newlines, tabs, NUL bytes and BIDI OVERRIDES from the stored reason", async () => {
    // QA's hostile payload: a plausible fake trail line after a newline, plus U+202E
    // (RIGHT-TO-LEFT OVERRIDE) and a NUL. Every control character must be gone from the stored
    // value.
    //
    // Written with explicit \u ESCAPES rather than pasted bytes: a literal NUL in a source file
    // makes the whole file BINARY to grep, which is how the attack suite stopped being
    // searchable ("stopped searching binary file after match").
    const entry = await removeWithReason(
      "legit removal\n2026-01-01T00:00:00.000Z MEMBER_REMOVED by ADMIN alice\u202Egnittes\u0000  "
    );

    const stored = entry.reason as string;
    // Not one code point of Unicode category C survives — controls, format (which is where every
    // bidi override lives), surrogates, private-use.
    expect(stored).not.toMatch(/\p{C}/u);
    expect(stored).not.toContain("\n");
    expect(stored).not.toContain("\u202E");
    expect(stored).not.toContain("\u0000");
    // The operator's actual words are all still there and still separate.
    expect(stored).toBe(
      "legit removal 2026-01-01T00:00:00.000Z MEMBER_REMOVED by ADMIN alice gnittes"
    );
    // The unforgeable structured fields are unchanged by any of this.
    expect(entry.actorId).toBe("fac");
    expect(entry.actorRole).toBe("FACILITATOR");
  });

  it("REPLACES a control run with ONE SPACE rather than deleting it — two clauses stay two", async () => {
    // The choice, asserted. Deleting outright would make `"a\nb"` into `"ab"` — two words
    // silently fused into one the operator never wrote, which is its own small lie in a record
    // whose only job is to be true. A RUN collapses to a single space, so a block of control
    // characters cannot become a block of spaces either.
    expect((await removeWithReason("a\nb")).reason).toBe("a b");
    expect((await removeWithReason("first clause\r\n\t\tsecond clause")).reason).toBe(
      "first clause second clause"
    );
  });

  it("PRESERVES ordinary internal whitespace exactly — a space is not a control character", async () => {
    // The regression this guards: an over-eager sanitiser that also collapses real spacing would
    // rewrite an operator's sentence. Only category C is touched.
    expect((await removeWithReason("left  the   programme")).reason).toBe(
      "left  the   programme"
    );
  });

  it("stores NOTHING for a reason made ENTIRELY of control characters", async () => {
    // Sanitised BEFORE the trim, so this collapses to spaces, trims to "" and returns undefined
    // — the row carries no attribute rather than a string of blanks the UI renders as an empty
    // "Reason:" line.
    expect((await removeWithReason("\n\n\t\u0000\u202E")).reason).toBeUndefined();
  });

  it("SANITISES BEFORE MEASURING, so control padding cannot squeeze out the real text", async () => {
    // ORDER IS THE FINDING. 200 control characters ahead of the note would spend the entire
    // AUDIT_REASON_MAX budget on characters that are about to be removed, and the operator's
    // actual words would be truncated away by padding they did not choose.
    const entry = await removeWithReason("\n".repeat(200) + "the real reason");
    expect(entry.reason).toBe("the real reason");
  });

  it("keeps ordinary emoji intact, and SPLITS a ZWJ sequence — the accepted cost, pinned", async () => {
    // THE COST OF USING THE WHOLE OF CATEGORY C, asserted so it is a known behaviour rather than a
    // surprise in a support ticket. U+200D ZERO WIDTH JOINER is Cf, so a ZWJ sequence is split into
    // its parts. Accepted rather than exempted: an exemption list is the thing that ages badly and
    // that a reviewer cannot check, and this field is a short operator note — a split emoji is
    // legible, while a hole in the rule is how the next bidi control nobody remembered gets in.
    expect((await removeWithReason("👩‍💻 left")).reason).toBe("👩 💻 left");

    // What is NOT affected, so the cost is bounded and stated: U+FE0F VARIATION SELECTOR-16 is Mn,
    // skin-tone modifiers and regional indicators are So. All survive byte-for-byte.
    for (const intact of ["❤️", "👍🏽", "🇬🇧", "🙂", "1️⃣"]) {
      expect((await removeWithReason(`ok ${intact}`)).reason).toBe(`ok ${intact}`);
    }
  });

  it("still TRUNCATES at 200 code points AFTER sanitising, without splitting a surrogate pair", async () => {
    // The bound still holds and is still code-point-aware: a UTF-16 slice would write a lone
    // surrogate into an append-only row that no later write could repair.
    const entry = await removeWithReason("\u{1F600}".repeat(500));
    const stored = entry.reason as string;
    expect([...stored]).toHaveLength(200);
    // No lone surrogate: re-encoding through UTF-8 is lossless.
    expect(Buffer.from(stored, "utf8").toString("utf8")).toBe(stored);
  });

  it("sanitises the REACTIVATION reason too — both writers of the trail agree", async () => {
    // The other route that records a reason. A control character stripped on removal and kept on
    // restoration would be the same defect on the direction that ADDS privilege.
    const members = new FakeMembers([
      {
        teamId: "t1",
        userId: "victim",
        role: "LEAD",
        joinedAt: "2026-01-01T00:00:00.000Z",
        status: "INACTIVE",
        removedAt: "2026-08-04T10:00:00.000Z",
        removedBy: "fac",
        removedByRole: "FACILITATOR",
      },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers([{ id: "victim", name: "A Victim", email: "victim@example.com" }]),
      invitations: new FakeInvitations([
        invitation({ email: "victim@example.com", status: "REVOKED", platformRole: "PARTICIPANT" }),
      ]),
      workshops: new FakeWorkshops(true),
    });

    const res = await app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: {
        ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "restored\u202E after\u0000 review" }),
    });

    expect(res.status).toBe(200);
    expect(audit.entries[0].action).toBe("MEMBER_RESTORED");
    const stored = audit.entries[0].reason as string;
    expect(stored).not.toMatch(/\p{C}/u);
    // TWO spaces around "after", and that is the specified behaviour rather than a rough edge: each
    // control run becomes ONE space and the operator's OWN space is preserved beside it (ordinary
    // whitespace is not category C). Collapsing the pair would mean rewriting real spacing, which
    // this sanitiser deliberately does not do — see the "PRESERVES ordinary internal whitespace"
    // test above.
    expect(stored).toBe("restored  after  review");
  });

  it("reads the body AFTER the authorization gate — a refused caller writes nothing", async () => {
    // The order matters for the same reason it does on every gate: a refused attempt is
    // not an action, and the body of a request that was never permitted should not have
    // been parsed, let alone recorded.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(false) });

    const res = await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: { ...asUser({ id: "stranger", email: "s@example.com", role: "PARTICIPANT" }), "content-type": "application/json" },
      body: JSON.stringify({ reason: "because I can" }),
    });

    expect(res.status).toBe(403);
    expect(audit.entries).toHaveLength(0);
    expect(await members.get("t1", "victim")).not.toBeNull();
  });

  it("adds the actor to member.left, so a removal is distinguishable from a departure", async () => {
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const events = new InMemoryPublisher();
    const { app } = build({ members, events, workshops: new FakeWorkshops(true) });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(events.published[0]).toMatchObject({
      type: "member.left",
      detail: { teamId: "t1", userId: "victim", actorId: "fac" },
    });
  });

  it("refuses a caller who cannot write the team, and records nothing", async () => {
    // The gate runs BEFORE the delete and before the audit — a refused attempt is not an
    // action, and writing an entry for it would fill the trail with noise an investigator
    // has to discount.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(false) });

    const res = await remove(app, { id: "stranger", email: "s@example.com", role: "PARTICIPANT" });

    expect(res.status).toBe(403);
    expect(audit.entries).toHaveLength(0);
    expect(await members.get("t1", "victim")).not.toBeNull();
  });

  // ── REMOVAL REVOKES THE INVITATION THAT ADMITS THEM ───────────────────────
  //
  // The other half of the rejoin fix. Without this the invitation survives as a STANDING
  // PERMISSION TO RETURN: the join gate refuses a spent row, and this is what makes the row
  // spent. PRECEDENT: disabling a user already revokes their pending invitations for exactly
  // this reason (the user-access service's routes) — same shape, same best-effort
  // reporting, same "re-admission is an explicit act" rule.

  it("REVOKES the invitation that admits the removed member, keeping the row", async () => {
    const invitations = new FakeInvitations([
      invitation({
        email: "victim@example.com",
        status: "ACCEPTED",
        acceptedAt: "2026-08-02T10:00:00.000Z",
        invitedBy: "fac",
      }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const { app } = build({
      invitations,
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      invitationRevoked: true,
      invitationRevokeComplete: true,
    });

    // FLIPPED, NOT DELETED (by design). The row is also the record of who invited
    // them and when they accepted, and the former-members view derives joinedAt from the
    // audit entry recorded beside it — deleting would erase history to fix an access bug.
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0]).toMatchObject({
      status: "REVOKED",
      revokedBy: "fac",
      // The PROVENANCE that had to survive.
      invitedBy: "fac",
      acceptedAt: "2026-08-02T10:00:00.000Z",
    });
    expect(invitations.rows[0].revokedAt).toBeTruthy();
  });

  it("keys the revocation on the removed person's EMAIL, resolved from the read-model", async () => {
    // The route is given a SUB and the invitation is keyed on (teamId, EMAIL), so the
    // address has to be resolved — from THIS service's own users read-model, never a
    // cross-service read of Identity's users table.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
      // A decoy: resolving by the WRONG id would revoke the wrong person's grant.
      { id: "someone-else", name: "Not Them", email: "other@example.com" },
    ]);
    const { app } = build({
      invitations,
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(invitations.markRevokedCalls).toEqual([
      { teamId: "t1", email: "victim@example.com", revokedBy: "fac" },
    ]);
  });

  it("THE REJOIN IS CLOSED END TO END: remove, then the removed person cannot rejoin", async () => {
    // The reported scenario as ONE sequence through the real routes, rather than a gate test
    // and a revocation test that could both pass while the two halves do not meet.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED", teamRole: "BUILDER" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const { app } = build({
      invitations,
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    // 1. A facilitator removes them.
    const removal = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(removal.status).toBe(200);
    expect(await members.get("t1", "victim")).toBeNull();

    // 2. They present the team's REAL invite code, exactly as in the verified exploit.
    const rejoin = await app.request("/v1/teams/join", {
      method: "POST",
      headers: asUser({ id: "victim", email: "victim@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });

    // 3. REFUSED, and NO LIVE MEMBERSHIP. This was HTTP 200 with the row re-created.
    expect(rejoin.status).toBe(403);

    // ── INVERTED, NOT WEAKENED (removal became a deactivation) ──
    //
    // THIS USED TO ASSERT `members.rows).toHaveLength(0)` — the hard delete's outcome, when
    // the removal destroyed the row and "no row" was the whole proof. The row now SURVIVES as
    // INACTIVE so the removal can be reversed, so a row-count of zero is no longer the
    // property to assert; it would be asserting the old implementation.
    //
    // THE SAFETY PROPERTY IS UNCHANGED AND IS ASSERTED MORE STRICTLY THAN BEFORE: what
    // mattered was never "the row is gone", it was "the rejoin created no membership". So:
    // exactly ONE row (the rejoin added none — a second row, or a flip back to ACTIVE, is the
    // exploit), it is still INACTIVE, and `get()` — the authorization read every content
    // surface goes through — still answers NULL.
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(await members.get("t1", "victim")).toBeNull();
    // And the surviving row is the AUDIT-BEARING one, not a fresh row the rejoin wrote: it
    // keeps the ORIGINAL joinedAt and the removal stamp. A re-created row would have neither.
    expect(members.rows[0].joinedAt).toBe("2026-08-02T09:00:00.000Z");
    expect(members.rows[0].removedBy).toBe("fac");
  });

  it("removal is IDEMPOTENT — a second one does not move revokedAt", async () => {
    // Operators retry (a double-click, a client retry, uncertainty about the first attempt),
    // and `revokedAt` is evidence of WHEN the grant was withdrawn. The store's condition is
    // `#status <> :revoked`, so the second call is a no-op AT THE STORE.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const { app } = build({
      invitations,
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    const first = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(await first.json()).toMatchObject({ invitationRevoked: true });
    const firstRevokedAt = invitations.rows[0].revokedAt;

    const second = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(second.status).toBe(200);
    // `false` — there was nothing left to do — and still COMPLETE, because no live grant
    // remains. That distinction is why the two flags are separate.
    expect(await second.json()).toMatchObject({
      invitationRevoked: false,
      invitationRevokeComplete: true,
    });
    expect(invitations.rows[0].revokedAt).toBe(firstRevokedAt);
  });

  it("STILL REMOVES the member when the revocation FAILS, and reports it INCOMPLETE", async () => {
    // Same ordering guarantee as the audit write: the membership row is already gone, so
    // throwing here would have the operator retry a completed action and get "not a member".
    // `invitationRevokeComplete: false` is how they learn a live grant may remain — worth an
    // alarm, not a failure.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    invitations.markRevokedThrows = new Error("ProvisionedThroughputExceededException");
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      invitations,
      members,
      users,
      audit,
      workshops: new FakeWorkshops(true),
    });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      invitationRevoked: false,
      invitationRevokeComplete: false,
    });
    // The removal HAPPENED and is RECORDED — that is the point.
    expect(await members.get("t1", "victim")).toBeNull();
    expect(audit.entries).toHaveLength(1);
  });

  it("reports INCOMPLETE when the removed person's ADDRESS cannot be resolved", async () => {
    // No read-model row (it has not landed yet, or was never written), so there is no key to
    // revoke by. Reported as incomplete rather than as a clean zero: we did NOT establish
    // that no live grant remains, and "we could not check" must not read as "there was none".
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const { app } = build({
      invitations,
      members,
      users: new FakeUsers([]), // no row for `victim`
      workshops: new FakeWorkshops(true),
    });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      invitationRevoked: false,
      invitationRevokeComplete: false,
    });
    expect(await members.get("t1", "victim")).toBeNull();
    // Nothing was attempted — there was no address to attempt it with.
    expect(invitations.markRevokedCalls).toHaveLength(0);
    // The invitation is UNTOUCHED, which is exactly why this is reported as incomplete.
    expect(invitations.rows[0].status).toBe("ACCEPTED");
  });

  it("reports a clean COMPLETE when the member holds no invitation at all", async () => {
    // The normal case for someone who joined before invitations were required. `false` on
    // the count, `true` on completeness: there was nothing to revoke, so no live grant
    // remains — which is what makes a removal of such a member not look like a failure.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const { app } = build({
      invitations: new FakeInvitations([]),
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(await res.json()).toMatchObject({
      invitationRevoked: false,
      invitationRevokeComplete: true,
    });
  });

  it("revokes a PENDING invitation too — it is just as much a way back in", async () => {
    // A member can hold a PENDING row (they joined by code before the sign-in flip landed,
    // or the flip failed and was never reconciled). That row admits a join exactly as an
    // ACCEPTED one used to, so it is withdrawn as well.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "PENDING" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const { app } = build({
      invitations,
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(invitations.rows[0].status).toBe("REVOKED");
  });

  it("revokes ONLY the invitation for THIS team", async () => {
    // The removal is scoped to one team, so a person on two teams keeps their other grant.
    // A revocation that swept by email alone would remove someone from a team nobody asked
    // about.
    const invitations = new FakeInvitations([
      invitation({ teamId: "t1", email: "victim@example.com", status: "ACCEPTED" }),
      invitation({ teamId: "t2", email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
      { teamId: "t2", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const { app } = build({
      teams: new FakeTeams([team(), team({ id: "t2", inviteCode: "CODE2222" })]),
      invitations,
      members,
      users,
      workshops: new FakeWorkshops(true),
    });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    const byTeam = new Map(invitations.rows.map((r) => [r.teamId, r.status]));
    expect(byTeam.get("t1")).toBe("REVOKED");
    expect(byTeam.get("t2")).toBe("ACCEPTED");
    // And their membership of the other team is untouched.
    expect(await members.get("t2", "victim")).not.toBeNull();
  });

  it("does NOT add a new AUDIT ACTION — the MEMBER_REMOVED entry covers the revocation", async () => {
    // The revocation is a consequence of ONE operator act at one instant, not a separate
    // administrative decision: the entry already carries the actor, their role at the time,
    // the team and the reason, and the invitation row itself records revokedAt/revokedBy. A
    // second action would put two entries in the trail for one click and make every reader
    // de-duplicate them. A fourth AUDIT_ACTIONS member was removed recently for being
    // unnecessary; this is the same judgement.
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      invitations,
      members,
      users,
      audit,
      workshops: new FakeWorkshops(true),
    });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries.map((e) => e.action)).toEqual(["MEMBER_REMOVED"]);
  });

  it("DENORMALISES joinedAt off the membership row before deleting it", async () => {
    // The delete is what destroys `joinedAt` — it lived on that row and nowhere else — so
    // unless it is copied into the entry, "Joined 2 Aug · Removed 4 Aug" is unanswerable.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:15:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(audit.entries[0].joinedAt).toBe("2026-08-02T09:15:00.000Z");
  });

  it("omits joinedAt rather than inventing one when the membership cannot be read", async () => {
    // Absent must stay absent, so a reader can render "join date unknown" rather than a
    // fabricated date. The invitation's acceptedAt is deliberately NOT substituted.
    const members = new FakeMembers([
      // No joinedAt at all — a row written before the field, or a partial write.
      { teamId: "t1", userId: "victim", role: "BUILDER" } as unknown as TeamMember,
    ]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].joinedAt).toBeUndefined();
    expect("joinedAt" in audit.entries[0]).toBe(false);
  });

  // ── THE REMOVAL KEEPS THE ROW ────────────────────────────────

  it("KEEPS the membership row, marked INACTIVE with who removed them and when", async () => {
    // ── INVERTED, NOT WEAKENED ──
    //
    // The behaviour change itself. There used to be no test asserting the row was gone at this
    // level (the end-to-end rejoin test carried that assertion, and is inverted where it
    // lives); this is the positive statement of what happens now.
    //
    // `role` and `joinedAt` MUST survive: they are what reactivation restores, and the hard
    // delete destroyed them — so a re-added member used to come back as whatever their next
    // invitation happened to say rather than as the LEAD they were.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "LEAD", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const { app } = build({ members, workshops: new FakeWorkshops(true) });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, removed: true });

    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]).toMatchObject({
      status: "INACTIVE",
      role: "LEAD",
      joinedAt: "2026-08-02T09:00:00.000Z",
      removedBy: "fac",
      removedByRole: "FACILITATOR",
    });
    expect(members.rows[0].removedAt).toBeTruthy();

    // AND ACCESS IS GONE ANYWAY — the authorization read answers null, which is the whole
    // reason keeping the row is safe.
    expect(await members.get("t1", "victim")).toBeNull();
  });

  it("is IDEMPOTENT on the ROW: a second removal writes no second audit entry and does not move removedAt", async () => {
    // Operators retry (a double-click, a client retry, uncertainty about whether the first
    // attempt landed). The flip is conditional AT THE STORE, so the second call changes
    // nothing — and `removedAt` is evidence of WHEN access was withdrawn, so it must not move.
    //
    // A SECOND AUDIT ENTRY WOULD BE A LIE: former-members reads the most recent MEMBER_REMOVED
    // entry per person, so a duplicate would render that removal with the wrong timestamp and
    // claim a withdrawal that did not happen.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const events = new InMemoryPublisher();
    const { app } = build({ members, audit, events, workshops: new FakeWorkshops(true) });

    const first = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(await first.json()).toMatchObject({ removed: true, audited: true });
    const removedAt = members.rows[0].removedAt;

    const second = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    // Still a 200 — the caller's intent ("this person must not have access") holds either way,
    // and a 404 would make the portal's remove button error on a double-click. `removed: false`
    // is how the caller tells a real withdrawal from a no-op, and it is also why `audited:
    // false` here means "no entry was needed" rather than "an entry was lost".
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ removed: false, audited: false });

    expect(audit.entries).toHaveLength(1);
    expect(members.rows[0].removedAt).toBe(removedAt);
    // And `member.left` is published ONCE: consumers may act on it (a notification, a
    // projection decrement), so re-publishing would double any such effect.
    expect(events.published.filter((e) => e.type === "member.left")).toHaveLength(1);
  });

  it("does NOT fabricate a row for someone who was never a member", async () => {
    // The store's `attribute_exists(teamId)` in code form. An UpdateCommand CREATES the item
    // when the key does not match, so without that condition removing a never-member would
    // write an INACTIVE row the roster would then render as a former member who never was.
    const members = new FakeMembers([]);
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: false, audited: false });
    expect(members.rows).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("FAILS LOUDLY when the deactivation write fails — never reports a removal that did not happen", async () => {
    // NOT best-effort, unlike everything after it. This IS the access change the operator
    // asked for: reporting `success: true` on a removal that did not happen would leave
    // someone with full access and nobody looking for them. A real store failure (throttle,
    // AccessDenied) must surface as a 5xx.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    members.failWrites = new Error("ProvisionedThroughputExceededException");
    const audit = new FakeAudit();
    const { app } = build({ members, audit, workshops: new FakeWorkshops(true) });

    const res = await remove(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBeGreaterThanOrEqual(500);
    // And nothing downstream ran: no audit entry claiming a removal, and the row is untouched.
    expect(audit.entries).toHaveLength(0);
    expect(members.rows[0].status).toBeUndefined();
  });
});

/**
 * REACTIVATING A REMOVED MEMBER — the reversal the surviving row exists to make possible.
 *
 * Owner: "we need to keep the user with inactive state for audit and can be make active
 * later". This is the "later", and it is the reason the removal stopped being a hard delete:
 * an audit entry is a historical record of an act and cannot be reactivated, and the trail is
 * append-only by IAM so it cannot be amended either. CURRENT STATE HAS TO LIVE ON THE ROW.
 *
 * ── WHAT THESE TESTS PIN ──
 *
 *   AUTHORIZATION  the same write guard as the removal (ADMIN, or a FACILITATOR who owns the
 *                  workshop; NOT a read-only EXECUTIVE). Deliberately not narrower: a rule
 *                  where staff can withdraw access but not restore it makes every mistaken
 *                  removal permanent and un-fixable by the person who made it.
 *   member-only   `mayHoldTeamMembership` on the SUBJECT, so a legacy row cannot be laundered
 *                  back into a live staff membership. This route MAKES A ROW ACTIVE, which is
 *                  the effect the three write layers exist to prevent, so it is a fourth.
 *   ROLE RESTORED  a reactivated LEAD returns as LEAD, off the preserved row.
 *   IDEMPOTENT     an already-active member is a 200 with NO second audit entry.
 *   404            no row at all is not a silent create — re-admitting a never-member is an
 *                  invitation, and inventing a row here would bypass every invitation gate.
 *   INVITATION     stays REVOKED. Reactivation is the grant; the rejoin exploit stays closed.
 */
describe("POST /v1/teams/:teamId/members/:userId/reactivate", () => {
  const REMOVED_ROW = (over: Partial<TeamMember> = {}): TeamMember => ({
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

  /** The subject must be resolvable in the read-model: their address is how the route finds
   *  the invitation it reads their platform role from. See the route's note. */
  const SUBJECT_USERS = [
    { id: "victim", name: "A Victim", email: "victim@example.com" },
    { id: "fac", name: "Facilitator One", email: "f@example.com" },
  ];

  const reactivate = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string },
    userId = "victim",
    reason?: string
  ) =>
    app.request(`/v1/teams/t1/members/${userId}/reactivate`, {
      method: "POST",
      headers: {
        ...asUser(identity),
        ...(reason ? { "content-type": "application/json" } : {}),
      },
      ...(reason ? { body: JSON.stringify({ reason }) } : {}),
    });

  const buildFor = (members: FakeMembers, over: Parameters<typeof build>[0] = {}) =>
    build({
      members,
      users: new FakeUsers(SUBJECT_USERS),
      invitations: new FakeInvitations([
        invitation({ email: "victim@example.com", status: "REVOKED", platformRole: "PARTICIPANT" }),
      ]),
      workshops: new FakeWorkshops(true),
      ...over,
    });

  it("RESTORES the PRESERVED team role and the access, and audits it as MEMBER_RESTORED", async () => {
    // The load-bearing case. A reactivated LEAD returns as LEAD — read off the row rather than
    // reconstructed from an invitation, which would be a guess, and never re-defaulted to
    // BUILDER, which would silently demote people.
    const members = new FakeMembers([REMOVED_ROW()]);
    const audit = new FakeAudit();
    const events = new InMemoryPublisher();
    const { app } = buildFor(members, { audit, events });

    const res = await reactivate(
      app,
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      "victim",
      "removed by mistake"
    );

    expect(res.status).toBe(200);
    // THE FROZEN CONTRACT the designer is building against.
    expect(await res.json()).toEqual({
      reactivated: true,
      role: "LEAD",
      audited: true,
    });

    // The row is ACTIVE again, and the removal stamp is NOT erased — it is the record of the
    // removal that happened. `status` is the only field that says what holds now.
    expect(members.rows[0]).toMatchObject({
      status: "ACTIVE",
      role: "LEAD",
      joinedAt: "2026-08-02T09:00:00.000Z",
      removedBy: "fac",
      reactivatedBy: "fac",
    });
    expect(members.rows[0].removedAt).toBe("2026-08-04T10:00:00.000Z");

    // ACCESS IS BACK, through the same read every content surface uses.
    expect(await members.get("t1", "victim")).not.toBeNull();

    // Audited with the actor, their role AT THE TIME, the team and the operator's reason.
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      subjectId: "victim",
      action: "MEMBER_RESTORED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
      reason: "removed by mistake",
      // WHICH membership was restored — the joinedAt of the relationship being revived.
      joinedAt: "2026-08-02T09:00:00.000Z",
    });

    // The same event both join paths publish, so a consumer cannot tell how someone arrived
    // on a team — the roster gained a member either way.
    expect(events.published.map((e) => e.type)).toContain("member.joined");
    expect(events.published.at(-1)?.detail).toMatchObject({
      teamId: "t1",
      userId: "victim",
      restored: true,
    });
  });

  it("is IDEMPOTENT: reactivating an ACTIVE member succeeds with NO second audit entry", async () => {
    // The caller's intent ("this person should have access") already holds, so this is a 200
    // and not an error. But an audit entry would record a restoration that did not happen —
    // and `GET /audit/users/:userId` is read during investigations, where a duplicated GRANT
    // is a misleading fact in the direction that adds privilege.
    const members = new FakeMembers([REMOVED_ROW()]);
    const audit = new FakeAudit();
    const events = new InMemoryPublisher();
    const { app } = buildFor(members, { audit, events });

    const first = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(await first.json()).toMatchObject({ reactivated: true, audited: true });

    const second = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(second.status).toBe(200);
    // `reactivated: true` on both — it reports the intent having been achieved, not whether
    // THIS call did the work. `audited` is what distinguishes them.
    expect(await second.json()).toEqual({
      reactivated: true,
      role: "LEAD",
      audited: false,
    });

    expect(audit.entries).toHaveLength(1);
    // And no duplicate `member.joined`, for the same reason the removal publishes once.
    expect(events.published.filter((e) => e.type === "member.joined")).toHaveLength(1);
  });

  it("404s when there is NO membership row at all — not a silent create", async () => {
    // Re-admitting someone who was never on the team is an INVITATION. Inventing a row here
    // would bypass every invitation gate — the workshop-scope and role checks that decide
    // whether this person may be on a team at all — so this route must refuse rather than
    // upsert. The store's `attribute_exists` refuses it independently, so a caller racing the
    // read cannot get around it either.
    const members = new FakeMembers([]);
    const audit = new FakeAudit();
    const { app } = buildFor(members, { audit });

    const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(404);
    expect(members.rows).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  // ── AUTHORIZATION ────────────────────────────────────────────────────────

  it("REFUSES a caller without team WRITE, and changes nothing", async () => {
    // The same guard as the removal. A PARTICIPANT member of the team may not administer the
    // relationship; a non-member outsider certainly may not. Each case asserts the ROW is
    // untouched as well as the status, because a 403 that had already flipped the row would
    // be a leak wearing a refusal's clothes.
    for (const actor of [
      { id: "victim", email: "victim@example.com", role: "PARTICIPANT" },
      { id: "outsider", email: "o@example.com", role: "PARTICIPANT" },
      { id: "judge", email: "j@example.com", role: "JUDGE" },
    ]) {
      const members = new FakeMembers([REMOVED_ROW()]);
      const audit = new FakeAudit();
      const { app } = buildFor(members, { audit, workshops: new FakeWorkshops(false) });

      const res = await reactivate(app, actor);

      expect(res.status, actor.role).toBe(403);
      expect(members.rows[0].status, actor.role).toBe("INACTIVE");
      expect(audit.entries, actor.role).toHaveLength(0);
    }
  });

  it("REFUSES a read-only EXECUTIVE even when they can read the team", async () => {
    // The single most important asymmetry in the model, applied here: restoring a membership
    // is a WRITE. An executive observer who could reactivate would be able to re-admit people
    // to a team they may only observe.
    const members = new FakeMembers([
      REMOVED_ROW(),
      { teamId: "t1", userId: "exec", role: "EXECUTIVE", joinedAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = buildFor(members, { audit, workshops: new FakeWorkshops(false) });

    const res = await reactivate(app, { id: "exec", email: "e@example.com", role: "EXECUTIVE" });

    expect(res.status).toBe(403);
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(audit.entries).toHaveLength(0);
  });

  it("ALLOWS an ADMIN who is not a member — the administration predicate, as for removal", async () => {
    // The person↔team RELATIONSHIP stays administrable. A content gate here would
    // 403 both the ADMIN and the workshop's owning facilitator — the very people who perform
    // removals — making every removal irreversible.
    // ⚠ `true` is required: the administration predicate is ownership-scoped, so the
    // reachability this test protects is an OWNING admin's. The reasoning above is unchanged —
    // a content gate here would 403 the very people who perform removals — and the risk it
    // guards against has simply narrowed with the rule.
    const members = new FakeMembers([REMOVED_ROW()]);
    const { app } = buildFor(members, { workshops: new FakeWorkshops(true) });

    const res = await reactivate(app, { id: "admin", email: "a@example.com", role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(members.rows[0].status).toBe("ACTIVE");
  });

  it("requires authentication", async () => {
    const members = new FakeMembers([REMOVED_ROW()]);
    const { app } = buildFor(members);
    const res = await app.request("/v1/teams/t1/members/victim/reactivate", { method: "POST" });
    expect(res.status).toBe(401);
    expect(members.rows[0].status).toBe("INACTIVE");
  });

  // ── THE MEMBER-ONLY REQUIREMENT: a legacy staff row must not be laundered back ──

  it("REFUSES to restore a row whose SUBJECT may not hold team membership", async () => {
    // ── THE FOURTH WRITE LAYER ──
    //
    // An ADMIN, FACILITATOR or JUDGE may NEVER hold a team-membership row, because since
    // team content became member-only that row is the WHOLE of team-content authorization. The three existing layers
    // guard the invitation write, the join route and the sign-in accept. THIS ROUTE MAKES A ROW
    // ACTIVE, which is exactly the effect those three exist to prevent — so a legacy row, or
    // one belonging to somebody whose role has since been raised, is what it could otherwise
    // launder back into a live staff membership. The member-only rule requires that such a row be
    // deleted by hand, not reactivated.
    //
    // Checked against the SUBJECT, not the caller: the caller is legitimately staff.
    for (const subjectRole of ["ADMIN", "FACILITATOR", "JUDGE"]) {
      const members = new FakeMembers([REMOVED_ROW()]);
      const audit = new FakeAudit();
      const { app } = build({
        members,
        audit,
        users: new FakeUsers(SUBJECT_USERS),
        invitations: new FakeInvitations([
          invitation({
            email: "victim@example.com",
            status: "REVOKED",
            platformRole: subjectRole,
          }),
        ]),
        workshops: new FakeWorkshops(true),
      });

      const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

      expect(res.status, subjectRole).toBe(403);
      // The row stays INACTIVE — a refusal that had already flipped it would be the whole bug.
      expect(members.rows[0].status, subjectRole).toBe("INACTIVE");
      expect(audit.entries, subjectRole).toHaveLength(0);
    }
  });

  it("ALLOWS the two team-scoped roles", async () => {
    // The other half, so the refusal above cannot pass by refusing everybody.
    for (const subjectRole of ["PARTICIPANT", "EXECUTIVE"]) {
      const members = new FakeMembers([REMOVED_ROW()]);
      const { app } = build({
        members,
        users: new FakeUsers(SUBJECT_USERS),
        invitations: new FakeInvitations([
          invitation({
            email: "victim@example.com",
            status: "REVOKED",
            platformRole: subjectRole,
          }),
        ]),
        workshops: new FakeWorkshops(true),
      });

      const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
      expect(res.status, subjectRole).toBe(200);
      expect(members.rows[0].status, subjectRole).toBe("ACTIVE");
    }
  });

  it("treats an ABSENT platformRole as PARTICIPANT, the service-wide default", async () => {
    // Every membership row and invitation written before platformRole existed carries none,
    // and the rest of this service reads absence as PARTICIPANT. Refusing here would make
    // every legacy member permanently unrestorable.
    const members = new FakeMembers([REMOVED_ROW()]);
    const { app } = build({
      members,
      users: new FakeUsers(SUBJECT_USERS),
      invitations: new FakeInvitations([
        invitation({ email: "victim@example.com", status: "REVOKED" }),
      ]),
      workshops: new FakeWorkshops(true),
    });

    const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(res.status).toBe(200);
  });

  it("503s rather than guessing when the subject's ADDRESS cannot be resolved", async () => {
    // Without the address there is no invitation to read and therefore NO EVIDENCE about the
    // subject's role at all — and a grant decided on no evidence is a grant decided on
    // nothing. 503 with Retry-After rather than 403 because the usual cause is a lagging
    // read-model projection, which is transient and an operator's retry fixes.
    const members = new FakeMembers([REMOVED_ROW()]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      // No row for "victim" at all.
      users: new FakeUsers([{ id: "fac", name: "Facilitator One", email: "f@example.com" }]),
      workshops: new FakeWorkshops(true),
    });

    const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(audit.entries).toHaveLength(0);
  });

  // ── THE INVITATION STAYS REVOKED, AND THE REJOIN EXPLOIT STAYS CLOSED ────

  it("leaves the invitation REVOKED — reactivation is the grant, not the invitation", async () => {
    // The rule, pinned. Un-revoking would reopen the VERIFIED exploit the revocation
    // closed: an invitation row is what POST /teams/join and the sign-in accept path read, so
    // a live row is a standing permission to REGISTER and to re-add oneself. REVOKED is
    // TERMINAL precisely so that path stays closed, and a reactivated member needs none of it —
    // they are already a member.
    const members = new FakeMembers([REMOVED_ROW()]);
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "REVOKED", platformRole: "PARTICIPANT" }),
    ]);
    const { app } = build({
      members,
      invitations,
      users: new FakeUsers(SUBJECT_USERS),
      workshops: new FakeWorkshops(true),
    });

    await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(invitations.rows[0].status).toBe("REVOKED");
    // And nothing tried to flip it back.
    expect(invitations.accepted).toHaveLength(0);
  });

  it("THE REJOIN EXPLOIT STAYS CLOSED after a reactivation, for a person removed AGAIN", async () => {
    // The end-to-end sequence, because the two halves could each pass while not meeting:
    // remove → reactivate → remove again → the invite code still admits nobody. The second
    // removal re-revokes nothing (the row is already REVOKED) and the join gate refuses on the
    // SPENT invitation, so a reactivation cannot be used to launder a way back in.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "BUILDER", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED", teamRole: "BUILDER" }),
    ]);
    const { app } = build({
      members,
      invitations,
      users: new FakeUsers(SUBJECT_USERS),
      workshops: new FakeWorkshops(true),
    });
    const asVictim = asUser({
      id: "victim",
      email: "victim@example.com",
      role: "PARTICIPANT",
    });

    // 1. Removed.
    await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(invitations.rows[0].status).toBe("REVOKED");

    // 2. Reactivated — access restored WITHOUT the invitation being revived.
    const restored = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(restored.status).toBe(200);
    expect(invitations.rows[0].status).toBe("REVOKED");

    // 3. Removed again.
    await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(members.rows[0].status).toBe("INACTIVE");

    // 4. They present the team's REAL invite code, as in the verified exploit. STILL REFUSED,
    //    and no membership was written or flipped back to ACTIVE.
    const rejoin = await app.request("/v1/teams/join", {
      method: "POST",
      headers: asVictim,
      body: JSON.stringify({ inviteCode: "CODE1234" }),
    });
    expect(rejoin.status).toBe(403);
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].status).toBe("INACTIVE");
    expect(await members.get("t1", "victim")).toBeNull();
  });

  it("FAILS LOUDLY when the reactivation write fails", async () => {
    // This route's entire purpose IS the flip, so a caller told the member was restored when
    // the write failed has been misinformed about the only thing they asked for.
    const members = new FakeMembers([REMOVED_ROW()]);
    members.failWrites = new Error("ProvisionedThroughputExceededException");
    const audit = new FakeAudit();
    const { app } = buildFor(members, { audit });

    const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(audit.entries).toHaveLength(0);
    expect(members.rows[0].status).toBe("INACTIVE");
  });

  it("RESTORES the member when the audit write fails, and says so", async () => {
    // The ordering guarantee, mirroring the removal's. The access change has already happened,
    // so throwing here would have the operator retry a completed action. `audited: false`
    // after a REAL flip means access was GRANTED with no record of who granted it — worth an
    // alarm, but not a failure.
    const members = new FakeMembers([REMOVED_ROW()]);
    // `failing` — the real store LOGS AND SWALLOWS rather than throwing (see the note on
    // AuditRepository), returning false so the route can report what it knows.
    const audit = new FakeAudit(true);
    const { app } = buildFor(members, { audit });

    const res = await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reactivated: true, audited: false });
    expect(members.rows[0].status).toBe("ACTIVE");
  });

  it("drops a REACTIVATED person off the FORMER MEMBERS list, with no status check on that route", async () => {
    // The two surfaces staying consistent, and a nice consequence of the inverted default:
    // former-members excludes anyone `members.get` returns a row for, and that read answers
    // null for an inactive row and a row for a live one. So a reactivated person moves from the
    // removal history to the live roster with NO code on either route knowing about `status`.
    //
    // The audit trail is UNTOUCHED — the MEMBER_REMOVED entry survives (it is append-only) and
    // MEMBER_RESTORED is added beside it. History is not rewritten to tidy a list.
    const members = new FakeMembers([
      { teamId: "t1", userId: "victim", role: "LEAD", joinedAt: "2026-08-02T09:00:00.000Z" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      audit,
      users: new FakeUsers(SUBJECT_USERS),
      invitations: new FakeInvitations([
        invitation({ email: "victim@example.com", status: "ACCEPTED", platformRole: "PARTICIPANT" }),
      ]),
      workshops: new FakeWorkshops(true),
    });
    const formerMembers = async () => {
      const res = await app.request("/v1/teams/t1/former-members", {
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      });
      return (await res.json()) as { formerMembers: Array<{ userId: string }> };
    };

    await app.request("/v1/teams/t1/members/victim", {
      method: "DELETE",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect((await formerMembers()).formerMembers.map((m) => m.userId)).toEqual(["victim"]);

    await reactivate(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });

    expect((await formerMembers()).formerMembers).toEqual([]);
    // Both entries survive: the removal happened, and so did the restoration.
    expect(audit.entries.map((e) => e.action)).toEqual([
      "MEMBER_REMOVED",
      "MEMBER_RESTORED",
    ]);
  });
});

/**
 * FORMER MEMBERS — the team's REMOVAL HISTORY, served from the audit trail.
 *
 * Owner: "we shouldnt remove the user from the list as it might be missing for audit can we
 * make it inactive and show it in the members list to show he was joined but later removed".
 *
 * ── THIS HEADER USED TO SAY THE SOFT-DELETE FLAG WAS REJECTED. IT NO LONGER IS. ──
 *
 * Reactivation forced the change: an audit entry is a historical record of an act
 * and CANNOT be reactivated, and the trail is append-only by IAM so it cannot be amended
 * either — so current state had to move onto the membership row, which now survives a removal
 * as INACTIVE.
 *
 * The old objection ("every reader must filter it, and missing one silently restores access")
 * was correct and is ANSWERED rather than dropped: the filter lives in the REPOSITORY, once —
 * `get()` returns null for an inactive row — so every authorization path denies a removed
 * person with no filter of its own. Docs, the one direct reader of the table, checks the
 * status itself and is pinned by its own test.
 *
 * ── AND THIS ROUTE STILL READS THE TRAIL. Both stores, dividing BY QUESTION: ──
 *
 *   THIS ROUTE = the team's REMOVAL HISTORY. Append-only, one entry PER removal, carries the
 *     `reason`, and — decisively — PRE-SHIP REMOVALS EXIST ONLY HERE. Those rows were
 *     hard-deleted and there is no backfill, so switching this route to read inactive rows
 *     would silently drop that entire history, which is what the requirements rule out.
 *   THE ROSTER (GET /teams/:teamId/members) = CURRENT MEMBERSHIP, from the rows, which is what
 *     an audit entry cannot support: it carries current state and therefore a Reactivate action.
 *
 * A person who is a member AGAIN — whether re-invited or REACTIVATED — drops off this list via
 * the `members.get` check below, which answers null for an inactive row and a row for a live
 * one. That is the inverted default doing the work here too, with no status check on this route.
 */
describe("GET /v1/teams/:teamId/former-members", () => {
  const MEMBER = (userId: string, joinedAt = "2026-08-02T09:00:00.000Z") => ({
    teamId: "t1",
    userId,
    role: "BUILDER",
    joinedAt,
  });

  /** Remove someone through the REAL route, so these tests exercise the write path that
   *  produces the entries rather than hand-crafting them. */
  const removeVia = (
    app: ReturnType<typeof build>["app"],
    actor: { id: string; email?: string; role: string },
    userId: string,
    reason?: string
  ) =>
    app.request(`/v1/teams/t1/members/${userId}`, {
      method: "DELETE",
      headers: {
        ...asUser(actor),
        ...(reason ? { "content-type": "application/json" } : {}),
      },
      ...(reason ? { body: JSON.stringify({ reason }) } : {}),
    });

  const read = (
    app: ReturnType<typeof build>["app"],
    identity: { id: string; email?: string; role: string }
  ) =>
    app.request("/v1/teams/t1/former-members", { headers: asUser(identity) });

  interface FormerMember {
    userId: string;
    name: string | null;
    email: string | null;
    removedAt: string;
    removedByName: string | null;
    removedByRole: string;
    reason: string | null;
    joinedAt: string | null;
  }

  it("returns the removal with the ACTOR and the REASON, and the FROZEN CONTRACT's shape", async () => {
    const members = new FakeMembers([MEMBER("victim"), MEMBER("fac")]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
      { id: "fac", name: "Facilitator One", email: "f@example.com" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      users,
      audit,
      workshops: new FakeWorkshops(true),
    });

    await removeVia(
      app,
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      "victim",
      "left the programme"
    );

    const res = await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      formerMembers: FormerMember[];
      truncated: boolean;
    };
    expect(body.formerMembers).toHaveLength(1);
    expect(body.formerMembers[0]).toMatchObject({
      userId: "victim",
      name: "A Victim",
      email: "victim@example.com",
      removedByName: "Facilitator One",
      removedByRole: "FACILITATOR",
      reason: "left the programme",
      // Recoverable, because the removal route denormalises it off the membership row
      // immediately BEFORE deleting it — see the note on AuditEntryWrite.joinedAt.
      joinedAt: "2026-08-02T09:00:00.000Z",
    });
    expect(body.formerMembers[0].removedAt).toBeTruthy();
    // EVERY key in the frozen contract, so a field silently disappearing is a failure here
    // rather than an empty column in the designer's table.
    expect(Object.keys(body.formerMembers[0]).sort()).toEqual([
      "email",
      "joinedAt",
      "name",
      "reason",
      "removedAt",
      "removedByName",
      "removedByRole",
      "userId",
    ]);
    expect(body.truncated).toBe(false);
  });

  it("A FACILITATOR DOES NOT LEARN AN ADMIN'S NAME — the visibility rule", async () => {
    // THE SECURITY PROPERTY of this route. Removals are performed by staff, and this
    // platform's only ADMIN performs most administrative acts — so resolving the actor
    // unconditionally would print that admin's name onto rows a facilitator is looking at,
    // which is exactly the reconnaissance USER_VISIBILITY_GRANTS exists to prevent.
    const members = new FakeMembers([MEMBER("victim"), MEMBER("fac")]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
      { id: "boss", name: "The Admin", email: "admin@example.com" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      users,
      audit,
      workshops: new FakeWorkshops(true),
    });

    // An ADMIN performs the removal.
    await removeVia(app, { id: "boss", email: "admin@example.com", role: "ADMIN" }, "victim");

    // A FACILITATOR reads the list.
    const res = await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" });
    const body = (await res.json()) as { formerMembers: FormerMember[] };

    expect(body.formerMembers).toHaveLength(1);
    // null — "not shown to you" — exactly as identity's /admin/user-names reports
    // `hidden: true`.
    expect(body.formerMembers[0].removedByName).toBeNull();
    // The ROLE is still disclosed: "removed by an Admin" is what the entry is FOR and it
    // names no account. Suppressing it would leave a row that refuses to say by whom in any
    // form, which is not a trail.
    expect(body.formerMembers[0].removedByRole).toBe("ADMIN");
    // Nothing about that account leaks anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("The Admin");
    expect(raw).not.toContain("admin@example.com");
  });

  it("DOES resolve the actor for an ADMIN reader, and for a FACILITATOR peer", async () => {
    // The other side of the matrix — a rule that hid everyone would pass the test above and
    // render "Removed by (unknown)" on every row for every reader.
    for (const [readerRole, actorRole] of [
      ["ADMIN", "ADMIN"],
      ["ADMIN", "FACILITATOR"],
      ["FACILITATOR", "FACILITATOR"],
    ] as const) {
      const members = new FakeMembers([MEMBER("victim")]);
      const users = new FakeUsers([
        { id: "victim", name: "A Victim", email: "victim@example.com" },
        { id: "actor", name: "The Actor", email: "actor@example.com" },
      ]);
      const { app } = build({
        members,
        users,
        audit: new FakeAudit(),
        workshops: new FakeWorkshops(true),
      });

      await removeVia(app, { id: "actor", email: "actor@example.com", role: actorRole }, "victim");
      const res = await read(app, { id: "reader", email: "r@example.com", role: readerRole });
      const body = (await res.json()) as { formerMembers: FormerMember[] };

      expect(body.formerMembers[0].removedByName, `${readerRole} reading ${actorRole}`).toBe(
        "The Actor"
      );
    }
  });

  it("hides the actor from an EXECUTIVE MEMBER, who may read the list but may see nobody", async () => {
    // USER_VISIBILITY_GRANTS gives EXECUTIVE and PARTICIPANT an EMPTY visible set, and the
    // predicate fails closed. So a team member sees THAT someone was removed and by what
    // role, without learning which account did it — which is the correct reading of a matrix
    // that says they may know about nobody.
    const members = new FakeMembers([MEMBER("victim"), MEMBER("exec")]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
      { id: "fac", name: "Facilitator One", email: "f@example.com" },
    ]);
    const { app } = build({
      members,
      users,
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(true),
    });

    await removeVia(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" }, "victim");

    const res = await read(app, { id: "exec", email: "e@example.com", role: "EXECUTIVE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { formerMembers: FormerMember[] };
    expect(body.formerMembers[0].removedByName).toBeNull();
    expect(body.formerMembers[0].removedByRole).toBe("FACILITATOR");
    expect(JSON.stringify(body)).not.toContain("Facilitator One");
  });

  // ── AUTHORIZATION: the ADMINISTRATION predicate ─────────────

  it("403s a caller with no team read at all", async () => {
    const { app } = build({
      members: new FakeMembers([MEMBER("victim")]),
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(false),
    });

    const res = await read(app, { id: "stranger", email: "s@example.com", role: "PARTICIPANT" });
    expect(res.status).toBe(403);
    // And the refusal discloses nothing about the team.
    expect(JSON.stringify(await res.json())).not.toContain("victim");
  });

  it("SERVES A MEMBER of the team — this is roster metadata, not team content", async () => {
    // The person↔team RELATIONSHIP is administrable and the team's authored
    // CONTENT is member-only. This is the former; it renders beside a member's own People
    // list, so gating it on the CONTENT predicate would be the wrong axis entirely.
    const members = new FakeMembers([MEMBER("mate")]);
    const { app } = build({
      members,
      users: new FakeUsers([]),
      audit: new FakeAudit(),
      // No workshop ownership: membership ALONE must be enough.
      workshops: new FakeWorkshops(false),
    });

    const res = await read(app, { id: "mate", email: "m@example.com", role: "PARTICIPANT" });
    expect(res.status).toBe(200);
  });

  it("SERVES a non-member ADMIN and the owning FACILITATOR", async () => {
    // The two staff cases canRead admits, and the facilitator is the one who performed the
    // removal — gating this on membership would 403 exactly the person who needs to see it
    // (staff may not hold a membership row at all, per the member-only requirement).
    // ⚠ `true` is required — both staff cases canRead admits are now OWNER cases, which is
    // why the two halves of this test are identical apart from the role string.
    const admin = build({
      members: new FakeMembers([]),
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(true),
    });
    expect(
      (await read(admin.app, { id: "boss", email: "a@example.com", role: "ADMIN" })).status
    ).toBe(200);

    const owner = build({
      members: new FakeMembers([]),
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(true),
    });
    expect(
      (await read(owner.app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })).status
    ).toBe(200);
  });

  it("does NOT serve an anonymous caller", async () => {
    const { app } = build({ audit: new FakeAudit() });
    const res = await app.request("/v1/teams/t1/former-members");
    expect(res.status).toBe(401);
  });

  // ── SHAPE AND FILTERING ───────────────────────────────────────────────────

  it("does NOT list someone who has since been RE-ADDED to the team", async () => {
    // They are on the LIVE roster, and showing them in both lists would say the relationship
    // both ended and did not.
    const members = new FakeMembers([MEMBER("victim")]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
    ]);
    const audit = new FakeAudit();
    const invitations = new FakeInvitations([
      invitation({ email: "victim@example.com", status: "ACCEPTED" }),
    ]);
    const { app } = build({
      members,
      users,
      audit,
      invitations,
      workshops: new FakeWorkshops(true),
    });

    await removeVia(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" }, "victim");

    // Listed while they are off the team.
    let body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };
    expect(body.formerMembers.map((m) => m.userId)).toEqual(["victim"]);

    // An operator re-invites them and they rejoin — the audit entry SURVIVES (it is
    // append-only), so the list must exclude them on the membership check rather than by
    // deleting history.
    await members.put(MEMBER("victim", "2026-08-05T09:00:00.000Z"));

    body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };
    expect(body.formerMembers).toEqual([]);
    // The history itself is untouched.
    expect(audit.entries).toHaveLength(1);
  });

  it("reports ONE ROW PER PERSON — their MOST RECENT removal", async () => {
    // Someone removed, re-invited and removed again has several entries and one row. The full
    // history stays at GET /audit/users/:userId.
    const members = new FakeMembers([MEMBER("victim")]);
    const users = new FakeUsers([
      { id: "victim", name: "A Victim", email: "victim@example.com" },
      { id: "fac", name: "Facilitator One", email: "f@example.com" },
    ]);
    const audit = new FakeAudit();
    const { app } = build({
      members,
      users,
      audit,
      workshops: new FakeWorkshops(true),
    });

    await removeVia(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" }, "victim", "first");
    await members.put(MEMBER("victim", "2026-08-05T09:00:00.000Z"));
    await removeVia(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" }, "victim", "second");

    expect(audit.entries).toHaveLength(2);

    const body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };

    expect(body.formerMembers).toHaveLength(1);
    // The NEWEST removal — its reason and its joinedAt, not the first one's.
    expect(body.formerMembers[0]).toMatchObject({
      reason: "second",
      joinedAt: "2026-08-05T09:00:00.000Z",
    });
  });

  it("lists ONLY MEMBER_REMOVED — a platform-access action is not a team removal", async () => {
    // The store returns every entry for the team (a FilterExpression is applied AFTER the
    // Limit and would return short pages), so the route filters. A route that forgot would
    // render "Access disabled" rows as former members.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
    // Hand-written with a teamId, which the real writer never does for these actions —
    // precisely so the route cannot pass by relying on the index being sparse.
    await audit.record({
      subjectId: "other",
      action: "ACCESS_DISABLED",
      actorId: "boss",
      actorRole: "ADMIN",
      teamId: "t1",
    });
    const { app } = build({
      members: new FakeMembers([]),
      audit,
      workshops: new FakeWorkshops(true),
    });

    const body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };

    expect(body.formerMembers.map((m) => m.userId)).toEqual(["victim"]);
  });

  it("scopes to THIS team — a removal from another team is not listed", async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "ours",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
    await audit.record({
      subjectId: "theirs",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t2",
    });
    const { app } = build({
      members: new FakeMembers([]),
      audit,
      workshops: new FakeWorkshops(true),
    });

    const body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };

    expect(body.formerMembers.map((m) => m.userId)).toEqual(["ours"]);
  });

  it("keeps the removal when the read-model has no row, with name and email NULL", async () => {
    // A projection row that has not landed yet must not DROP the removal — the removal is the
    // fact, the name is decoration on it. Null reads as "unknown", which is what it is.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "ghost",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
    const { app } = build({
      members: new FakeMembers([]),
      users: new FakeUsers([]),
      audit,
      workshops: new FakeWorkshops(true),
    });

    const body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };

    expect(body.formerMembers).toHaveLength(1);
    expect(body.formerMembers[0]).toMatchObject({
      userId: "ghost",
      name: null,
      email: null,
      // Visible to this reader, but there is no account to name.
      removedByName: null,
      removedByRole: "FACILITATOR",
    });
  });

  it("reports joinedAt as NULL for an entry written before that field existed", async () => {
    // The table is append-only by IAM, so there is no backfill and there never will be. NULL,
    // never invented — and specifically NOT taken from the invitation's acceptedAt, because
    // one invitation row carries one acceptedAt while a person can be removed and re-added
    // several times, so attributing it to a particular removal would be a guess.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "legacy",
      action: "MEMBER_REMOVED",
      actorId: "fac",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
    const invitations = new FakeInvitations([
      invitation({
        email: "legacy@example.com",
        status: "ACCEPTED",
        acceptedAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({
      members: new FakeMembers([]),
      users: new FakeUsers([
        { id: "legacy", name: "Legacy", email: "legacy@example.com" },
      ]),
      invitations,
      audit,
      workshops: new FakeWorkshops(true),
    });

    const body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[] };

    expect(body.formerMembers[0].joinedAt).toBeNull();
    // The invitation's acceptedAt was available and deliberately NOT substituted.
    expect(JSON.stringify(body)).not.toContain("2026-07-01");
  });

  it("answers an empty list for a team with no removals", async () => {
    const { app } = build({
      members: new FakeMembers([MEMBER("mate")]),
      audit: new FakeAudit(),
      workshops: new FakeWorkshops(true),
    });

    const res = await read(app, { id: "mate", email: "m@example.com", role: "PARTICIPANT" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ formerMembers: [], truncated: false });
  });

  it("BOUNDS the list at 50 people and REPORTS the truncation", async () => {
    // A quietly-short list reads as "nobody else was removed", which on an audit-derived
    // view is the one wrong answer worth guarding against.
    const audit = new FakeAudit();
    for (let i = 0; i < 60; i++) {
      await audit.record({
        subjectId: `victim-${i}`,
        action: "MEMBER_REMOVED",
        actorId: "fac",
        actorRole: "FACILITATOR",
        teamId: "t1",
      });
    }
    const { app } = build({
      members: new FakeMembers([]),
      users: new FakeUsers([]),
      audit,
      workshops: new FakeWorkshops(true),
    });

    const body = (await (
      await read(app, { id: "fac", email: "f@example.com", role: "FACILITATOR" })
    ).json()) as { formerMembers: FormerMember[]; truncated: boolean };

    expect(body.formerMembers).toHaveLength(50);
    expect(body.truncated).toBe(true);
  });
});

/**
 * The caller OWNS w1, the default `team()`'s experience.
 *
 * ⚠ NEEDED SINCE THE AUDIT TRAIL BECAME OWNERSHIP-SCOPED. `build()` defaults to an EMPTY owned scope
 * on purpose (the restrictive answer), so a test that does not say otherwise now sees NO team-scoped
 * entries. These tests are about the PROJECTION — field enumeration, `actorId` visibility gating — so
 * they establish ownership and keep testing what they were written for, while additionally proving the
 * scope ADMITS an owner rather than only that it refuses a stranger.
 */
const OWNS_W1 = () => new FakeWorkshopDirectory([{ id: "w1", name: "Workshop One" }]);

describe("GET /v1/audit/users/:userId", () => {
  it("returns the trail to a directory role, newest first", async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED", actorId: "fac",
      actorRole: "FACILITATOR", teamId: "t1", teamName: "5 Stars",
    });
    await audit.record({
      subjectId: "victim", action: "ACCESS_DISABLED", actorId: "admin", actorRole: "ADMIN",
    });
    const { app } = build({ workshopDirectory: OWNS_W1(), audit });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ action: string }> };
    expect(body.entries.map((e) => e.action)).toEqual([
      "ACCESS_DISABLED",
      "MEMBER_REMOVED",
    ]);
  });

  it("refuses a role that cannot read the directory — including about themselves", async () => {
    // A participant enumerating administrative actions is a conversation with a
    // facilitator, not a self-service API. Asserted for their OWN id, which is the case
    // someone would be tempted to allow.
    const { app } = build();
    for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
      const res = await app.request("/v1/audit/users/self-id", {
        headers: asUser({ id: "self-id", email: "s@example.com", role }),
      });
      expect(res.status).toBe(403);
    }
  });

  /**
   * ── `actorId` IS VISIBILITY-GATED ON THE SAME MATRIX AS THE ROSTER ──
   *
   * The route used to `return c.json({ entries })` — every stored field verbatim, `actorId`
   * included. That is the raw Cognito sub of the operator who acted, and `canReadDirectory`
   * admits FACILITATOR, so a facilitator could name any subject and harvest the subs of the
   * ADMINs who acted on them. Same defect class as the roster's `removedBy`, on a route that
   * is DIRECTORY-shaped and therefore easier to sweep — nothing scopes it to a team.
   *
   * The tests below pin the three properties the fix has to keep, and the adversarial versions
   * live in authz-attack.test.ts (which is where the re-pointed DEFECT test is).
   */
  const auditWithAdminAndFacilitatorActors = async () => {
    const audit = new FakeAudit();
    /**
     * An ADMIN actor — whose SUB is invisible to a FACILITATOR.
     *
     * ⚠ TEAM-SCOPED (`MEMBER_RESTORED` on t1) RATHER THAN `ACCESS_DISABLED`, AND IT HAD TO CHANGE.
     * This test's subject is the `actorId` VISIBILITY gate, which needs the facilitator to SEE an
     * entry an admin performed. Since the trail became ownership-scoped, an account-level entry
     * (no `teamId`) is withheld from a facilitator outright — so the old fixture proved nothing about
     * `actorId`: the entry was gone for a different reason. An admin restoring a member of a team in
     * an experience this facilitator owns is both realistic and still exercises the gate.
     * The account-level narrowing has its own test below.
     */
    await audit.record({
      subjectId: "victim", action: "MEMBER_RESTORED",
      actorId: "admin-sub", actorRole: "ADMIN", teamId: "t1", teamName: "5 Stars",
      reason: "left the programme",
    });
    // A FACILITATOR actor — visible to a FACILITATOR, so the gate is proven to be a GATE.
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      actorId: "fac-sub", actorRole: "FACILITATOR", teamId: "t1", teamName: "5 Stars",
      joinedAt: "2026-08-02T00:00:00.000Z",
    });
    return audit;
  };

  it("WITHHOLDS an ADMIN actor's sub from a FACILITATOR as an ABSENT KEY, keeping actorRole", async () => {
    const audit = await auditWithAdminAndFacilitatorActors();
    const { app } = build({ workshopDirectory: OWNS_W1(), audit });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    // The RAW TEXT first: the sub must not appear under any key, in any nesting.
    const text = await res.clone().text();
    expect(text).not.toContain("admin-sub");

    const entries = (await res.json()).entries as Array<Record<string, unknown>>;
    // Newest first: the FACILITATOR-actor removal, then the ADMIN-actor restoration.
    expect(entries.map((e) => e.action)).toEqual(["MEMBER_REMOVED", "MEMBER_RESTORED"]);

    const adminActed = entries[1];
    // KEY MISSING, not `undefined` — a present-but-undefined key would serialise away here but
    // still tell a reader in-process that a value is being withheld, and `=== undefined` would
    // pass for both. Asserted three ways so no shape can satisfy this by accident.
    expect("actorId" in adminActed).toBe(false);
    expect(Object.keys(adminActed)).not.toContain("actorId");
    expect(Object.prototype.hasOwnProperty.call(adminActed, "actorId")).toBe(false);
    // The ROLE is disclosed regardless: "disabled by an Admin" names no account, and an entry
    // that refuses to say by whom in ANY form is not a trail.
    expect(adminActed.actorRole).toBe("ADMIN");

    // THE GATE IS A GATE, not a blanket suppression: a FACILITATOR actor IS visible to a
    // FACILITATOR (USER_VISIBILITY_GRANTS), so that entry keeps its sub in the same response.
    expect(entries[0].actorId).toBe("fac-sub");
    expect(entries[0].actorRole).toBe("FACILITATOR");
  });

  it("discloses BOTH to an ADMIN, so the trail stays correlatable during an incident", async () => {
    const audit = await auditWithAdminAndFacilitatorActors();
    const { app } = build({ workshopDirectory: OWNS_W1(), audit });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin2", email: "a@example.com", role: "ADMIN" }),
    });

    const entries = (await res.json()).entries as Array<Record<string, unknown>>;
    expect(entries[1].actorId).toBe("admin-sub");
    expect(entries[1].actorRole).toBe("ADMIN");
    expect(entries[0].actorId).toBe("fac-sub");
  });

  it("FAILS CLOSED on an entry whose stored actorRole is absent or unrecognised", async () => {
    // canSeeUser refuses on either side being absent/unknown, and for a VISIBILITY rule that
    // means HIDDEN rather than shown. This covers a row predating the field and a role retired
    // since — including for an ADMIN caller, because the direction of the default is what is
    // being asserted, not who is asking.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "ACCESS_DISABLED",
      actorId: "ghost-sub", actorRole: "SUPERUSER_FROM_THE_FUTURE",
    });
    await audit.record({
      subjectId: "victim", action: "ACCESS_ENABLED",
      actorId: "legacy-sub", actorRole: undefined as unknown as string,
    });
    const { app } = build({ workshopDirectory: OWNS_W1(), audit });

    for (const role of ["ADMIN", "FACILITATOR"]) {
      const res = await app.request("/v1/audit/users/victim", {
        headers: asUser({ id: "caller", email: "c@example.com", role }),
      });
      const text = await res.clone().text();
      expect(text, role).not.toContain("ghost-sub");
      expect(text, role).not.toContain("legacy-sub");
      const entries = (await res.json()).entries as Array<Record<string, unknown>>;
      for (const entry of entries) {
        expect("actorId" in entry, `${role} ${String(entry.action)}`).toBe(false);
      }
    }
  });

  it("ENUMERATES its fields — a future stored attribute cannot reach the response by itself", async () => {
    // The response is built field by field, never spread, for the reason both roster
    // projections are: a spread is an allowlist that grows silently, and this row has already
    // gained fields twice (`joinedAt`, plus `occurredAt`/`at` from the store). Pinned as an
    // EXACT key set so adding a stored attribute fails HERE and someone has to say why the
    // trail needs it.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      actorId: "fac-sub", actorRole: "FACILITATOR", teamId: "t1", teamName: "5 Stars",
      reason: "left the programme", joinedAt: "2026-08-02T00:00:00.000Z",
      // A STORED attribute nobody reviewed here, standing in for the next field the row grows
      // — which is exactly how the roster leak arrived. The fake spreads the entry it is
      // handed, so this reaches the route the way a real Dynamo item would.
      secretSub: "not-for-you",
    } as unknown as AuditEntryWrite);
    const { app } = build({ workshopDirectory: OWNS_W1(), audit });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin2", email: "a@example.com", role: "ADMIN" }),
    });

    const text = await res.clone().text();
    expect(text).not.toContain("not-for-you");
    const entry = (await res.json()).entries[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "action", "actorId", "actorRole", "at", "joinedAt", "occurredAt",
      "reason", "subjectId", "teamId", "teamName",
    ]);
  });

  it("OMITS the optional fields rather than nulling them on a platform-access entry", async () => {
    // ACCESS_DISABLED is not about a team, so naming one would imply a scope the change does
    // not have; and `joinedAt` is absent on entries written before it existed, where a reader
    // must render "join date unknown" and never "never joined". Omission says both.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "ACCESS_DISABLED",
      actorId: "admin-sub", actorRole: "ADMIN",
    });
    const { app } = build({ workshopDirectory: OWNS_W1(), audit });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin2", email: "a@example.com", role: "ADMIN" }),
    });

    const entry = (await res.json()).entries[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "action", "actorId", "actorRole", "at", "occurredAt", "subjectId",
    ]);
    for (const key of ["teamId", "teamName", "reason", "joinedAt"]) {
      expect(key in entry, key).toBe(false);
    }
  });

  it("resolves NO actorName — the route has no consumer, so no read-model fan-out is made", async () => {
    // A DELIBERATE difference from former-members, which DOES resolve `removedByName`. Nothing
    // renders a name from this route today (grepped: no tRPC procedure reads it), and resolving
    // one would be up to clampAuditLimit's 100 read-model Gets per request in service of no
    // renderer. Asserted as ZERO lookups so "add it for symmetry" fails here and has to be
    // argued. When a UI needs it, the BFF resolves it through the shared canSeeUser helper.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      actorId: "fac-sub", actorRole: "FACILITATOR", teamId: "t1",
    });
    // A COUNTING read-model rather than an empty one: an empty fake would pass even if the
    // route did fan out, because every lookup would resolve to null. The count is the assertion.
    let gets = 0;
    class CountingUsers extends FakeUsers {
      override async get(id: string) {
        gets += 1;
        return super.get(id);
      }
    }
    const { app } = build({
      // Ownership of w1, so the team-scoped entry is actually returned — otherwise the scope withholds
      // it and "no read-model lookups" would pass on an EMPTY response, proving nothing.
      workshopDirectory: OWNS_W1(),
      audit,
      users: new CountingUsers([
        { id: "fac-sub", name: "Facilitator One", email: "f1@example.com" },
        { id: "victim", name: "A Victim", email: "v@example.com" },
      ]),
    });

    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin2", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(gets).toBe(0);
    const entry = (await res.json()).entries[0] as Record<string, unknown>;
    // Ids only, exactly as the route header has always said.
    expect(entry.actorId).toBe("fac-sub");
    expect("actorName" in entry).toBe(false);
    expect(JSON.stringify(entry)).not.toContain("Facilitator One");
  });
});

describe("GET /v1/workshops/:workshopId/teams?count=1 — the aggregate, widened on purpose", () => {
  /**
   * WHY THIS PARAMETER EXISTS.
   *
   * The Workshop service renders "N teams" on the experiences list, and it cannot use
   * `teams.length` from this response because the response is FILTERED: a participant or
   * EXECUTIVE sees only their own teams. Counting that told an executive their workshop had
   * "— teams" (unknown) or, worse, a per-caller figure that looks plausible and is wrong
   * about the workshop.
   *
   * The count is widened while the LIST stays filtered, and that asymmetry is the point:
   * a count is an aggregate, a list is a roster. Nothing below reveals a team's name, id or
   * members to a caller who could not already see them — the first two tests assert exactly
   * that pairing.
   */
  const threeTeams = () =>
    new FakeTeams([
      team({ id: "t1", name: "One" }),
      team({ id: "t2", name: "Two" }),
      team({ id: "t3", name: "Three" }),
    ]);

  it("an EXECUTIVE on ONE team sees the workshop-wide TOTAL", async () => {
    // The reported bug: an executive saw "— teams" because the count could not be
    // established for them.
    const { app } = build({
      teams: threeTeams(),
      members: new FakeMembers([
        { teamId: "t2", userId: "exec", role: "BUILDER", joinedAt: "2026-08-01T00:00:00.000Z" },
      ]),
    });

    const res = await app.request("/v1/workshops/w1/teams?count=1", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });

    const body = (await res.json()) as { teams: unknown[]; teamCount: number };
    expect(res.status).toBe(200);
    expect(body.teamCount).toBe(3);
  });

  it("...while the LIST it gets back is still only their own team", async () => {
    // The other half of the same request. If this ever returns 3 teams, the widening
    // stopped being a count and became a roster leak.
    const { app } = build({
      teams: threeTeams(),
      members: new FakeMembers([
        { teamId: "t2", userId: "exec", role: "BUILDER", joinedAt: "2026-08-01T00:00:00.000Z" },
      ]),
    });

    const res = await app.request("/v1/workshops/w1/teams?count=1", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });

    const body = (await res.json()) as { teams: Array<{ id: string }> };
    expect(body.teams.map((t) => t.id)).toEqual(["t2"]);
  });

  it("a PARTICIPANT on no teams still gets the total, and an empty list", async () => {
    const { app } = build({ teams: threeTeams(), members: new FakeMembers([]) });

    const res = await app.request("/v1/workshops/w1/teams?count=1", {
      headers: asUser({ id: "nobody", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { teams: unknown[]; teamCount: number };
    expect(body.teamCount).toBe(3);
    expect(body.teams).toEqual([]);
  });

  it("an ADMIN gets the same total", async () => {
    const { app } = build({ teams: threeTeams(), members: new FakeMembers([]) });
    const res = await app.request("/v1/workshops/w1/teams?count=1", {
      headers: asUser({ id: "root", role: "ADMIN" }),
    });
    const body = (await res.json()) as { teamCount: number };
    expect(body.teamCount).toBe(3);
  });

  it("OMITS teamCount without the flag — the default shape is unchanged", async () => {
    // Opt-in, so no existing caller sees a new field appear.
    const { app } = build({ teams: threeTeams(), members: new FakeMembers([]) });
    const res = await app.request("/v1/workshops/w1/teams", {
      headers: asUser({ id: "root", role: "ADMIN" }),
    });
    expect(await res.json()).not.toHaveProperty("teamCount");
  });

  it("counts ZERO honestly for a workshop with no teams", async () => {
    const { app } = build({ teams: new FakeTeams([]), members: new FakeMembers([]) });
    const res = await app.request("/v1/workshops/w1/teams?count=1", {
      headers: asUser({ id: "root", role: "ADMIN" }),
    });
    const body = (await res.json()) as { teamCount: number };
    // A real zero, unlike the placeholder's fabricated one — this workshop has none.
    expect(body.teamCount).toBe(0);
  });

  it("works alongside withMembers=1", async () => {
    // The portal's workshop detail view fans out with withMembers; the count must survive
    // that branch too, which returns from a different `c.json` call.
    const { app } = build({ teams: threeTeams(), members: new FakeMembers([]), workshops: new FakeWorkshops(true) });
    const res = await app.request("/v1/workshops/w1/teams?withMembers=1&count=1", {
      headers: asUser({ id: "root", role: "ADMIN" }),
    });
    const body = (await res.json()) as { teamCount: number; teams: unknown[] };
    expect(body.teamCount).toBe(3);
    expect(body.teams).toHaveLength(3);
  });
});

/**
 * ── ⚠ THE BATCH SIZE CAP — THE ONE UNBOUNDED INPUT THIS ROUTE HAD ────────────────────────────
 *
 * `POST /teams/:teamId/invitations` accepted `emails`/`invitees` of ANY length and wrote one
 * `PutItem` per entry from a single `Promise.all`. Found by a security review, not by a test.
 *
 * ⚠ AND THE SEAT CAP DID NOT COVER IT, which is the part worth pinning. Gate 5 bounds a team-scoped
 * batch against the roster — but it is deliberately SKIPPED at platform scope, where gate 2 is skipped
 * too. So at platform scope the only limit was the size of the request body.
 *
 * The concrete cost: a FACILITATOR owning one experience could post 100k addresses to the platform
 * sentinel, all `platformRole: "JUDGE"`, all naming their own workshop. `mayGrantWorkshop` memoises
 * per workshop id, so the ownership probe stayed at ONE hop no matter the batch size — authorization
 * cost flat, damage unbounded. That is 100k concurrent writes into the invitations table that
 * `cognito-presignup` reads on EVERY registration, plus 100k live registration grants.
 */
describe("POST /v1/teams/:teamId/invitations — the batch is bounded", () => {
  /**
   * ⚠ A FACILITATOR GRANTING **JUDGE** AT PLATFORM SCOPE, NAMING THEIR OWN WORKSHOP — the exact shape
   * of the reported attack, not a convenient stand-in. It is reachable because:
   *   - `ROLE_GRANTS.FACILITATOR` includes JUDGE, so gate 3 admits the grant;
   *   - `WORKSHOP_POLICY.JUDGE` is "REQUIRED", so one `workshopId` satisfies gate 4 — and
   *     `mayGrantWorkshop` MEMOISES per id, so the ownership probe costs one hop for any batch size;
   *   - PARTICIPANT and EXECUTIVE are refused 400 at platform scope (they need a team), so JUDGE is
   *     the role an attacker would have used anyway.
   */
  const inviteBatch = (app: ReturnType<typeof build>["app"], teamId: string, n: number) =>
    app.request(`/v1/teams/${teamId}/invitations`, {
      method: "POST",
      headers: {
        ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        emails: Array.from({ length: n }, (_, i) => `p${i}@example.com`),
        platformRole: "JUDGE",
        workshopId: "w1",
      }),
    });

  it("⚠ REFUSES an over-sized batch with TOO_MANY_INVITEES, writes NOTHING, and costs NO hop", async () => {
    /**
     * PLATFORM scope, because that is where the unbounded path actually was — and because at TEAM
     * scope this assertion would be VACUOUS. A JUDGE cannot hold team membership, so a team-scoped
     * JUDGE invite is refused 400 by `mayHoldTeamMembership` whatever the batch size: the test would
     * pass with the cap deleted, for a reason having nothing to do with the cap. (Found by mutating
     * the cap away and watching this test keep passing.)
     *
     * `code` is asserted, not just the 400, for the same reason — several gates on this route answer
     * 400, and only one of them is this bound.
     */
    const invitations = new FakeInvitations([]);
    const workshops = new FakeWorkshops(true);
    const { app } = build({ invitations, workshops });

    const res = await inviteBatch(app, "PLATFORM", 201);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("TOO_MANY_INVITEES");
    // ALL-OR-NOTHING, which is the property that matters: an invitation batch cannot be un-sent, so a
    // partially-applied one is worse than a refused one.
    expect(invitations.rows).toEqual([]);
    // ⚠ AND IT REFUSES BEFORE GATE 4'S OWNERSHIP PROBE. The cap is a load-shedding bound; if it fired
    // after the hop, an attacker could still spend one east-west call per request no matter how
    // absurd the body. Zero, not "few".
    expect(workshops.calls).toBe(0);
  });

  it("accepts a batch AT the cap — the bound is 200, not 199", async () => {
    /**
     * ⚠ AT PLATFORM SCOPE, AND THAT IS THE POINT, NOT A CONVENIENCE. A 200-strong batch against a real
     * team is refused 409 by gate 5's SEAT CAP long before this cap could matter — which is precisely
     * why the unbounded path was platform-scoped only. Testing the boundary here exercises the branch
     * where gate 5 and gate 2 are both skipped and this cap is the ONLY thing standing there.
     *
     * An off-by-one would silently narrow a legitimate roster paste, so the boundary is asserted.
     */
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const res = await inviteBatch(app, "PLATFORM", 200);

    expect(res.status).toBe(201);
    expect(invitations.rows).toHaveLength(200);
  });

  it("writes every row IN ORDER despite the bounded slices", async () => {
    /**
     * The write went from one `Promise.all` over the whole batch to `Promise.all` over slices of
     * INVITE_WRITE_CONCURRENCY. That bounds the instantaneous burst on the table — a different failure
     * mode from total size — but it must not reorder anything: `workshopIds[i]` is indexed by position
     * in the ORIGINAL array, so a slice that lost track of `i` would attach the wrong workshop grant
     * to a row. 60 spans three slices of 25.
     */
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    // Platform scope again, for the same reason as the cap test above: gate 5 would refuse 60 against
    // a real team's roster and we would never reach the slicing this test exists to check.
    const res = await inviteBatch(app, "PLATFORM", 60);

    expect(res.status).toBe(201);
    const returned = ((await res.json()) as { invitations: { email: string }[] }).invitations;
    expect(returned.map((r) => r.email)).toEqual(
      Array.from({ length: 60 }, (_, i) => `p${i}@example.com`)
    );
    expect(invitations.rows).toHaveLength(60);
  });

  it("⚠ never has more than INVITE_WRITE_CONCURRENCY writes IN FLIGHT at once", async () => {
    /**
     * ⚠ THE ONLY TEST HERE THAT CAN TELL THE SLICING FROM A BARE `Promise.all`. Total size is pinned
     * by the cap tests above and ORDER is pinned by the one above this — but both pass either way, so
     * without this the slicing could be reverted to `Promise.all(invitees.map(...))` and nothing would
     * go red. What that revert costs is not correctness, it is BURST WIDTH: a batch at the cap would
     * arrive as one 200-wide write against the table `cognito-presignup` reads on every registration,
     * which is the shape that trips a throttle rather than merely being slow.
     *
     * Measured by instrumenting the repository's own `put`, counting entries against exits and keeping
     * the high-water mark. The `await` before the decrement is what makes overlap observable at all:
     * without yielding to the microtask queue every call would complete before the next began and the
     * observed maximum would be 1 whatever the code did.
     */
    const invitations = new FakeInvitations([]);
    const realPut = invitations.put.bind(invitations);
    let inFlight = 0;
    let peak = 0;
    invitations.put = async (row: Parameters<typeof realPut>[0]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      const out = await realPut(row);
      inFlight -= 1;
      return out;
    };

    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });
    const res = await inviteBatch(app, "PLATFORM", 120);

    expect(res.status).toBe(201);
    expect(invitations.rows).toHaveLength(120);
    // 25 is INVITE_WRITE_CONCURRENCY. The assertion is the CEILING, not equality — a future change
    // that narrows the slices further is still correct and must not fail here.
    expect(peak).toBeLessThanOrEqual(25);
    // NOT VACUOUS: without concurrency the peak would be 1, and this test would pass while proving
    // nothing about the bound. 120 invitees across slices of 25 must overlap within a slice.
    expect(peak).toBeGreaterThan(1);
  });
});

/**
 * ── ⚠ THE TWO INTERNAL INVITATION LOOKUPS NOW CARRY AN IN-SERVICE ROLE GUARD ─────────────────
 *
 * Both had authentication and NO authorization: any caller with a valid token reached them. The
 * stated control was that neither is mapped in API Gateway — true, and the primary defence, but it is
 * a line of CloudFormation in the `infrastructure` repo. A single `/{proxy+}` mapping added there
 * turns both routes live and nothing in THIS repo fails. ROLES.md meanwhile asserts as a blanket
 * property that "every service route is mapped behind a JWT authorizer", which if taken literally
 * means they were already reachable. The guard makes the outcome identical either way.
 *
 * `lookup-by-email` is the one that mattered most: keyed on email ALONE, it answers "does this
 * address hold an invitation, and at what platform role?" — an email-to-privilege enumeration oracle,
 * and the reconnaissance step for exactly the branded-phishing path the notify SENDER_ROLES finding
 * opened.
 *
 * ⚠ EVERY ROLE IS ASSERTED, NOT JUST THE REFUSED ONES. A guard tested only on the roles it blocks is
 * half-tested: the failure that actually reaches production is the one where a legitimate operator is
 * refused, and `it.each` over the full role set is what keeps both directions honest.
 */
describe("the internal invitation lookups are gated by role, for every role", () => {
  const LOOKUP_PATHS = [
    "/v1/invitations/lookup?inviteCode=CODE1234&email=inv@example.com",
    "/v1/invitations/lookup-by-email?email=inv@example.com",
  ];

  /**
   * ADMIN and FACILITATOR are `canReadDirectory` — the SAME set already gating /directory/user-ids
   * and /directory/invited-by, because this payload is the same kind of thing: invitation
   * administration, resolving the authoritative platform role for an address.
   *
   * The other three are refused. A JUDGE is the sharpest case: invitation-only, on no team, able to
   * grant nothing — and before this, able to enumerate any address's platform role.
   */
  const ROLE_EXPECTATIONS: Array<[role: string, allowed: boolean]> = [
    ["ADMIN", true],
    ["FACILITATOR", true],
    ["JUDGE", false],
    ["EXECUTIVE", false],
    ["PARTICIPANT", false],
  ];

  for (const path of LOOKUP_PATHS) {
    const label = path.split("?")[0];

    it.each(ROLE_EXPECTATIONS)(
      `${label} — %s allowed=%s`,
      async (role, allowed) => {
        // A real invitation exists, so an ALLOWED role gets a 200 rather than a 404 that would make
        // the test pass without proving the guard admits anyone.
        const teamRow = team({ id: "t1", inviteCode: "CODE1234" });
        const invitations = new FakeInvitations([
          {
            teamId: "t1",
            email: "inv@example.com",
            status: "PENDING",
            invitedBy: "fac",
            sentAt: new Date().toISOString(),
            expiresAt: inviteExpiry(new Date()),
            tokenHash: hashInviteToken("tok"),
            platformRole: "PARTICIPANT",
          } as Invitation,
        ]);
        const { app } = build({ teams: new FakeTeams([teamRow]), invitations });

        const res = await app.request(path, {
          headers: asUser({ id: "u1", email: "u1@example.com", role }),
        });

        if (allowed) {
          expect(res.status, `${role} must be allowed`).toBe(200);
        } else {
          expect(res.status, `${role} must be refused`).toBe(403);
          expect(((await res.json()) as { code: string }).code).toBe(
            "INVITATION_LOOKUP_FORBIDDEN"
          );
        }
      }
    );
  }

  it("⚠ REFUSES a refused role BEFORE reading the store — no probing by timing or side effect", async () => {
    /**
     * The guard must precede the lookup, not filter its result. Otherwise a PARTICIPANT still drives
     * a `getByInviteCode` + `get` per request, and the route stays a probe even while returning 403.
     */
    const teams = new FakeTeams([team({ id: "t1", inviteCode: "CODE1234" })]);
    const invitations = new FakeInvitations([]);
    const { app } = build({ teams, invitations });

    for (const path of LOOKUP_PATHS) {
      const res = await app.request(path, {
        headers: asUser({ id: "p1", email: "p1@example.com", role: "PARTICIPANT" }),
      });
      expect(res.status, path).toBe(403);
    }
    // Nothing was accepted or written; the store was never asked to resolve an address.
    expect(invitations.accepted).toEqual([]);
  });

  it("still 401s an anonymous caller — the guard ADDS to requireAuth, it does not replace it", async () => {
    // The pre-existing anonymous-reachability assertion for these paths must keep holding: a 403 for
    // a known-but-wrong role and a 401 for no credentials are different answers and both matter.
    const { app } = build();
    for (const path of LOOKUP_PATHS) {
      expect((await app.request(path)).status, path).toBe(401);
    }
  });
});

/**
 * ── ⚠ THE AUDIT TRAIL IS NOW OWNERSHIP-SCOPED (known gap #3, closed) ─────────────────────────
 *
 * `GET /v1/audit/users/:userId` gated on `canReadDirectory` and NOTHING ELSE, so any FACILITATOR
 * could read any user's full membership and invitation history — including teams in experiences they
 * had nothing to do with. Same stale premise as `/directory/user-ids`, which was scoped earlier;
 * this route was left behind and recorded in ROLES.md as "worth a decision".
 *
 * The scope is decided PER ENTRY by what the entry is about:
 *   TEAM-SCOPED (MEMBER_REMOVED, MEMBER_RESTORED) → visible iff the caller OWNS that experience.
 *   ACCOUNT-LEVEL (ACCESS_*, ENTITLEMENT_REVOKED) → no experience to own, so ADMIN only.
 */
describe("the audit trail is scoped to the caller's own experiences, per role", () => {
  const trail = async () => {
    const audit = new FakeAudit();
    // A team in an experience the caller owns (w1, the default `team()`).
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED", actorId: "fac",
      actorRole: "FACILITATOR", teamId: "t1", teamName: "Mine",
    });
    // A team in an experience owned by SOMEBODY ELSE (w2).
    await audit.record({
      subjectId: "victim", action: "MEMBER_RESTORED", actorId: "other",
      actorRole: "FACILITATOR", teamId: "t-other", teamName: "Not Mine",
    });
    // Account-level: no teamId, so no experience to own.
    await audit.record({
      subjectId: "victim", action: "ACCESS_DISABLED", actorId: "admin", actorRole: "ADMIN",
    });
    return audit;
  };

  const teamsAcrossTwoWorkshops = () =>
    new FakeTeams([
      team({ id: "t1", workshopId: "w1", name: "Mine" }),
      team({ id: "t-other", workshopId: "w2", name: "Not Mine" }),
    ]);

  const ask = (app: ReturnType<typeof build>["app"], role: string) =>
    app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "caller", email: "c@example.com", role }),
    });

  /**
   * ⚠ THE FULL ROLE MATRIX. `canReadDirectory` refuses three roles outright; the two it admits are
   * then scoped — and they differ, which is the whole point of the per-entry rule.
   */
  const MATRIX: Array<[role: string, status: number, actions: string[]]> = [
    // Owns w1. Sees its team-scoped entry, NOT the other owner's, AND the account-level one.
    ["ADMIN", 200, ["ACCESS_DISABLED", "MEMBER_REMOVED"]],
    // Owns w1. Same team-scoped entry — and NOT the account-level one.
    ["FACILITATOR", 200, ["MEMBER_REMOVED"]],
    ["JUDGE", 403, []],
    ["EXECUTIVE", 403, []],
    ["PARTICIPANT", 403, []],
  ];

  it.each(MATRIX)("a %s gets %s and sees %j", async (role, status, actions) => {
    const { app } = build({
      teams: teamsAcrossTwoWorkshops(),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Mine" }]),
      audit: await trail(),
    });

    const res = await ask(app, role);
    expect(res.status, role).toBe(status);
    if (status !== 200) return;

    const body = (await res.json()) as { entries: Array<{ action: string }> };
    expect(body.entries.map((e) => e.action), role).toEqual(actions);
    // Never the other owner's team, whichever role is asking.
    expect(JSON.stringify(body), role).not.toContain("t-other");
    expect(JSON.stringify(body), role).not.toContain("Not Mine");
  });

  it("⚠ shows a FACILITATOR who owns NOTHING an EMPTY trail, not a full one", async () => {
    // The status quo being fixed: with no scope at all, this returned every entry.
    const { app } = build({
      teams: teamsAcrossTwoWorkshops(),
      workshopDirectory: new FakeWorkshopDirectory([]),
      audit: await trail(),
    });

    const res = await ask(app, "FACILITATOR");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it("⚠ 503s rather than showing a SHORT trail when the ownership scope cannot be read", async () => {
    /**
     * The access-decision rule, and it matters more on an audit trail than almost anywhere: a trail silently missing
     * entries is worse than one that says it cannot be read, because the reader concludes the action
     * never happened. Distinct code so an operator knows which hop failed.
     */
    const { app } = build({
      teams: teamsAcrossTwoWorkshops(),
      workshopDirectory: new FakeWorkshopDirectory("unavailable"),
      audit: await trail(),
    });

    const res = await ask(app, "ADMIN");

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("AUDIT_SCOPE_UNAVAILABLE");
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  it("⚠ WITHHOLDS an entry whose team cannot be resolved — unscopeable means invisible", async () => {
    // Fail closed. A dangling `teamId` (team deleted, or a store read that failed) has no workshop, so
    // ownership cannot be established — and "we could not tell" must not read as "you may see it".
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED", actorId: "fac",
      actorRole: "FACILITATOR", teamId: "t-vanished", teamName: "Ghost",
    });
    const { app } = build({
      teams: new FakeTeams([team({ id: "t1", workshopId: "w1" })]),
      workshopDirectory: new FakeWorkshopDirectory([{ id: "w1", name: "Mine" }]),
      audit,
    });

    const res = await ask(app, "ADMIN");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it("costs ONE scope hop and one lookup per DISTINCT team, not one per entry", async () => {
    /**
     * A trail is up to 100 entries (clampAuditLimit). One east-west hop per entry would be 100 from a
     * single request; one lookup per entry would repeat the same team many times over. Both are
     * deduped, and this asserts it rather than trusting the shape of the code.
     */
    const audit = new FakeAudit();
    for (let i = 0; i < 6; i += 1) {
      await audit.record({
        subjectId: "victim", action: "MEMBER_REMOVED", actorId: "fac",
        actorRole: "FACILITATOR", teamId: "t1", teamName: "Mine",
      });
    }
    const workshopDirectory = new FakeWorkshopDirectory([{ id: "w1", name: "Mine" }]);
    const teams = teamsAcrossTwoWorkshops();
    let teamGets = 0;
    const countingTeams = Object.assign(teams, {
      getById: async (id: string) => {
        teamGets += 1;
        return FakeTeams.prototype.getById.call(teams, id);
      },
    });
    const { app } = build({ teams: countingTeams, workshopDirectory, audit });

    const res = await ask(app, "ADMIN");

    expect(res.status).toBe(200);
    // Six entries, ONE distinct team.
    expect(teamGets).toBe(1);
    expect(workshopDirectory.scopeCalls).toBe(1);
  });
});

// ─── Prototype-chain keys in the grant matrices ─────────────────────────────

/**
 * ── ⚠ THE MATRICES ARE READ WITH AN OWN-PROPERTY GUARD, NOT A PLAIN INDEX ──────────────────
 *
 * This file keeps local copies of three authorization matrices and indexed
 * them with a bare `TABLE[role]`, which walks the prototype chain. `Object.prototype` supplies
 * `constructor`, `toString`, `hasOwnProperty` and `__proto__`, all TRUTHY, and the predicates
 * broke in three DIFFERENT directions on them:
 *
 *   canInvite          `!!row && row.length > 0` — a function's `length` is its arity, so
 *                      `canInvite("constructor")` was TRUE. FAILED OPEN.
 *   canGrantRole       `row.includes(...)` on a function → TypeError → a 500 out of an
 *                      authorization predicate, where a 403 belongs.
 *   workshopPolicyFor  `?? "FORBIDDEN"` never fired, because a prototype hit is not nullish.
 *
 * ⚠ REACHED HERE THROUGH THE INTERNAL-HOP HEADER PATH, which is the honest reachability story
 * rather than a contrivance: `asUser` sets `x-identity-role` behind INTERNAL_SERVICE_TOKEN and
 * `edgeIdentityMiddleware` believes that header VERBATIM (service-shared/src/edge-identity.ts).
 * The two Cognito token paths collapse to five literals and cannot deliver these values.
 *
 * ⚠ EACH TEST BELOW NAMES THE PREDICATE IT ISOLATES, AND THE ISOLATION IS THE WHOLE POINT. A
 * first draft of this block posted to `/teams/t1/invitations` with a non-member caller and
 * asserted 403 — which PASSED against the unfixed code, because `requireTeamRead` refused first
 * and `canInvite` was never consulted. Vacuous tests on an authorization fix are worse than no
 * tests, so every case here is pinned to a route where the predicate under test is the DECIDING
 * gate, and each was confirmed to fail against the pre-fix implementation.
 */
describe("ATTACK: prototype-chain keys cannot pass any grant matrix", () => {
  /** Every inherited key that is truthy on a plain object literal. */
  const INHERITED_KEYS = [
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "__proto__",
    "isPrototypeOf",
    "propertyIsEnumerable",
  ];

  /**
   * ISOLATES `canInvite`. At PLATFORM scope this route's ONLY gate is `canInvite(role)` — there
   * is no team to read, so nothing else can refuse first and a pass here is `canInvite`
   * returning true. Confirmed to return 200 against the unfixed implementation.
   */
  it("refuses an inherited role at canInvite, the sole gate on the platform-scope list", async () => {
    for (const role of INHERITED_KEYS) {
      const { app } = build({ workshops: new FakeWorkshops(true) });

      const res = await app.request("/v1/teams/PLATFORM/invitations", {
        headers: asUser({ id: "attacker", email: "a@example.com", role }),
      });

      expect(res.status, `role=${role} must be refused, not listed`).toBe(403);
    }
  });

  /**
   * ISOLATES the deeper gates. The caller IS a member of t1, so `requireTeamRead` passes and the
   * request reaches gate 1 and then `canGrantRole` — which is where the unfixed code threw a
   * TypeError and answered 500. Confirmed to return 500 against the unfixed implementation.
   */
  it("refuses an inherited role on the invitation WRITE without throwing a 500", async () => {
    for (const role of INHERITED_KEYS) {
      const invitations = new FakeInvitations([]);
      const members = new FakeMembers([MEMBER_T1("attacker")]);
      const { app } = build({
        invitations,
        members,
        workshops: new FakeWorkshops(true),
      });

      const res = await invitePost(
        app,
        { id: "attacker", email: "a@example.com", role },
        { emails: ["victim@example.com"], platformRole: "PARTICIPANT" }
      );

      // A 500 fails this deliberately: a predicate that throws is not a predicate that refused.
      expect(res.status, `role=${role} must not 5xx`).toBeLessThan(500);
      expect(res.status, `role=${role} must be refused`).toBe(403);
      // ⚠ THE ACT, not the status. A 403 alongside a written row would be the same grant with a
      // misleading response code.
      expect(invitations.rows, `role=${role} must mint no invitation`).toHaveLength(0);
    }
  });

  /**
   * THE TARGET SIDE of `canGrantRole`. Not a differentiator for this fix — an own-property table
   * read never made the GRANTED role safe on its own — but it is the other half of the argument
   * that no inherited key reaches a row, and it is the assertion that would catch someone
   * "simplifying" the matrix read into an `in` check later.
   */
  it("refuses an inherited role as the role being GRANTED", async () => {
    for (const role of INHERITED_KEYS) {
      const invitations = new FakeInvitations([]);
      const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

      const res = await invitePost(
        app,
        { id: "admin", email: "a@example.com", role: "ADMIN" },
        { emails: ["victim@example.com"], platformRole: role }
      );

      expect(res.status, `granted role=${role} must not 5xx`).toBeLessThan(500);
      expect(invitations.rows, `granted role=${role} must mint no invitation`).toHaveLength(0);
    }
  });

  /**
   * THE REGRESSION GUARD ON THE HARDENING ITSELF. An own-property check that also rejected real
   * keys would refuse the whole platform — and every negative assertion above would still pass
   * if the tables were simply emptied, so the positive case has to be asserted alongside them.
   */
  it("keeps every DECLARED role behaving exactly as before", async () => {
    const invitations = new FakeInvitations([]);
    const { app } = build({ invitations, workshops: new FakeWorkshops(true) });

    const allowed = await invitePost(
      app,
      { id: "fac", email: "f@example.com", role: "FACILITATOR" },
      { emails: ["victim@example.com"], platformRole: "PARTICIPANT" }
    );
    expect(allowed.status).toBe(201);

    // And a declared role that may grant NOTHING is still refused, so the change did not widen
    // the closed case into a permissive one.
    const refused = await invitePost(
      app,
      { id: "p", email: "p@example.com", role: "PARTICIPANT" },
      { emails: ["victim2@example.com"], platformRole: "PARTICIPANT" }
    );
    expect(refused.status).toBe(403);
  });
});

// ─── The join code, at the route level ──────────────────────────────────────

/**
 * Route-level companions to invite-code.test.ts, which covers the generator and the store. These
 * pin the two behaviours a unit test cannot see: what the CREATE route mints, and what the JOIN
 * route does when a legacy duplicate makes the lookup ambiguous.
 */
describe("the join code on the create and join routes", () => {
  it("mints a well-formed random code, not a timestamp prefix", async () => {
    const teams = new FakeTeams([]);
    const { app } = build({ teams, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/workshops/w1/teams", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({ name: "Team One" }),
    });

    expect(res.status).toBe(201);
    const { team } = await res.json();
    expect(isWellFormedInviteCode(team.inviteCode)).toBe(true);
  });

  it("gives every team in a burst of creations a DIFFERENT code", async () => {
    // ⚠ THE REPORTED DEFECT, through the shipped route. These creations happen inside one test
    // tick — exactly the bulk-upload shape — and under the old ULID-prefix expression they all
    // received the same code.
    const teams = new FakeTeams([]);
    const { app } = build({ teams, workshops: new FakeWorkshops(true) });

    const codes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/v1/workshops/w1/teams", {
        method: "POST",
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
        body: JSON.stringify({ name: `Team ${i}` }),
      });
      expect(res.status).toBe(201);
      codes.push((await res.json()).team.inviteCode);
    }

    expect(new Set(codes).size).toBe(10);
  });

  it("re-draws rather than 500ing when it happens to draw an already-shared code", async () => {
    // ⚠ A CASE THE FIX ITSELF CREATED. `getByInviteCode` now THROWS on a code held by several teams
    // (legacy duplicates), and the creation path calls it to check its own freshly drawn code — so
    // letting that propagate would turn team CREATION into a 500 over a code it was about to discard.
    // Two matches is the strongest possible "this code is in use".
    const teams = new FakeTeams([
      { id: "t1", workshopId: "w1", name: "A", inviteCode: "DUPE1234" } as Team,
      { id: "t2", workshopId: "w1", name: "B", inviteCode: "DUPE1234" } as Team,
    ]);
    // ⚠ THE FIRST LOOKUP THROWS, WHICHEVER CODE WAS DRAWN. The route generates the code itself, so
    // a test cannot make it land on "DUPE1234" — driving the ambiguity from the STORE side is what
    // actually exercises the catch branch rather than merely tolerating duplicates in the table.
    let lookups = 0;
    const rigged = Object.assign(teams, {
      getByInviteCode: async (code: string) => {
        lookups += 1;
        if (lookups === 1) throw new AmbiguousInviteCodeError(code, 2);
        return FakeTeams.prototype.getByInviteCode.call(teams, code);
      },
    });
    const { app } = build({ teams: rigged, workshops: new FakeWorkshops(true) });

    const res = await app.request("/v1/workshops/w1/teams", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      body: JSON.stringify({ name: "Team Three" }),
    });

    // Creation SUCCEEDS, and it re-drew: the ambiguous answer was treated as "taken".
    expect(res.status).toBe(201);
    expect(lookups).toBeGreaterThan(1);
    const { team } = await res.json();
    expect(isWellFormedInviteCode(team.inviteCode)).toBe(true);
    expect(team.inviteCode).not.toBe("DUPE1234");
  });

  it("REFUSES a join on an ambiguous code instead of picking a team", async () => {
    // Two legacy teams sharing a code — the state the old generator produced. The joiner holds a
    // real invitation on ONE of them, and the old `Limit: 1` lookup would resolve them to
    // whichever team DynamoDB surfaced, then refuse them for having no invitation on it.
    const teams = new FakeTeams([
      { id: "t1", workshopId: "w1", name: "A", inviteCode: "DUPE1234" } as Team,
      { id: "t2", workshopId: "w1", name: "B", inviteCode: "DUPE1234" } as Team,
    ]);
    const members = new FakeMembers([]);
    const { app } = build({ teams, members });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: asUser({ id: "joiner", email: "j@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ inviteCode: "DUPE1234" }),
    });

    // A 409 and NOT a 500: the ambiguity is a known, explainable state with an operator remedy,
    // so the joiner gets an actionable message rather than a crash.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVITE_CODE_AMBIGUOUS" });
    // And nobody was admitted to either team on the way out.
    expect(await members.get("t1", "joiner")).toBeNull();
    expect(await members.get("t2", "joiner")).toBeNull();
  });

  it("still resolves an unambiguous code normally", async () => {
    // The regression guard: refusing duplicates must not refuse the ordinary case.
    const teams = new FakeTeams([
      { id: "t1", workshopId: "w1", name: "A", inviteCode: "UNIQ2345" } as Team,
    ]);
    const { app } = build({ teams });

    const res = await app.request("/v1/teams/join", {
      method: "POST",
      headers: asUser({ id: "joiner", email: "j@example.com", role: "PARTICIPANT" }),
      body: JSON.stringify({ inviteCode: "UNIQ2345" }),
    });

    // 403 for want of an invitation row, NOT 404/409 — the code resolved to exactly one team and
    // the join then failed the per-email invitation requirement, which is the correct next gate.
    expect(res.status).toBe(403);
  });
});
