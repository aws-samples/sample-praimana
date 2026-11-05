import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createUserAccessRoutes } from "./routes.js";
import {
  meetsPasswordPolicy,
  type AuditEntryWrite,
  type AuditRepository,
  type EventPublisher,
  type InvitationReader,
  type InvitationRow,
  type ProfileStore,
  type ProfileWrite,
  type RandomBytes,
  type Role,
  type UserDirectory,
  type UserStatus,
} from "./domain.js";

/**
 * Route-level tests for the provisioning sequence.
 *
 * Every port is faked, so nothing here touches Cognito, DynamoDB or EventBridge —
 * which is the point of the ports existing. What is being tested is the SEQUENCE and
 * its failure semantics, and those are the parts that cannot be checked by inspecting
 * one AWS call:
 *
 *   - the ORDERING contract (the invitation must already exist; the role comes from
 *     the row and never from the request);
 *   - IDEMPOTENCY (a re-invite must not 500, and must not clobber a profile);
 *   - the distinction between a benign UsernameExistsException and a
 *     UserLambdaValidationException, which means our own sequencing is broken;
 *   - that a partial provisioning is REPORTED rather than presented as success —
 *     the ghost-account failure this whole change exists to remove;
 *   - that the temporary password never appears anywhere but the response.
 *
 * Authentication uses the trusted-internal-hop path (x-internal-token +
 * x-identity-*), the same edgeIdentityMiddleware the deployed service runs, so no
 * Cognito JWKS fetch is needed. Mirrors notify/src/routes.test.ts.
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

const ADMIN = asUser({ id: "admin-1", role: "ADMIN" });

// ─── Fakes ──────────────────────────────────────────────────────────────────

class FakeDirectory implements UserDirectory {
  readonly created: { email: string; temporaryPassword: string }[] = [];
  readonly groups: { username: string; group: Role }[] = [];
  /** Set to make createUser reject with an error carrying this `name`. */
  createError: string | null = null;
  /** Set to make createUser report the account as pre-existing. */
  alreadyExists = false;
  /** Set to make addToGroup reject. */
  groupError: string | null = null;
  subOnCreate: string | null = "11111111-2222-3333-4444-555555555555";
  subOnLookup: string | null = "11111111-2222-3333-4444-555555555555";
  lookups = 0;

  async createUser(input: {
    email: string;
    temporaryPassword: string;
    signal: AbortSignal;
  }) {
    // Asserted rather than ignored: every Cognito call must carry a deadline, and a
    // fake that shrugs at a missing one would let that regress silently.
    expect(input.signal, "createUser called with no AbortSignal").toBeInstanceOf(
      AbortSignal
    );
    if (this.createError) throw named(this.createError);
    this.created.push({
      email: input.email,
      temporaryPassword: input.temporaryPassword,
    });
    return this.alreadyExists
      ? { sub: null, alreadyExisted: true }
      : { sub: this.subOnCreate, alreadyExisted: false };
  }

  async addToGroup(input: {
    username: string;
    group: Role;
    signal: AbortSignal;
  }) {
    expect(input.signal, "addToGroup called with no AbortSignal").toBeInstanceOf(
      AbortSignal
    );
    if (this.groupError) throw named(this.groupError);
    this.groups.push({ username: input.username, group: input.group });
  }

  async findSub(input: { email: string; signal: AbortSignal }) {
    expect(input.signal, "findSub called with no AbortSignal").toBeInstanceOf(
      AbortSignal
    );
    this.lookups++;
    return this.subOnLookup;
  }

  // ── The access surface ────────────────────────────────────────────────────
  //
  // Modelled as a MAP OF ACCOUNTS keyed by sub, not as a pair of flags, so the
  // interesting properties are real rather than stipulated: the target is genuinely
  // looked up, `enabled` genuinely persists across calls (which is what makes the
  // idempotency test meaningful), and the group list is genuinely per-account (so a
  // test cannot accidentally pass because every account shares one role).

  /** Accounts this pool contains, by sub. */
  readonly accounts = new Map<
    string,
    { username: string; email: string; enabled: boolean; groups: string[] }
  >();
  /** Every setEnabled call, in order — including the no-ops. */
  readonly enableCalls: { username: string; enabled: boolean }[] = [];
  /** Set to make findByUserId reject with an error carrying this `name`. */
  findError: string | null = null;
  /** Set to make listGroups reject. */
  groupsError: string | null = null;
  /** Set to make setEnabled reject. */
  setEnabledError: string | null = null;
  /** Set to make hasOtherEnabledAdmin reject — the truncated/unanswerable case. */
  otherAdminError: string | null = null;
  /** How many times the last-admin guard was consulted. */
  otherAdminChecks = 0;

  /** Seed one account. Returns the sub so a test can act on it. */
  seed(account: {
    sub: string;
    username?: string;
    email?: string;
    enabled?: boolean;
    groups?: string[];
  }): string {
    this.accounts.set(account.sub, {
      username: account.username ?? `user-${account.sub}`,
      email: account.email ?? `${account.sub}@example.com`,
      enabled: account.enabled ?? true,
      groups: account.groups ?? ["PARTICIPANT"],
    });
    return account.sub;
  }

  async findByUserId(input: { userId: string; signal: AbortSignal }) {
    expect(input.signal, "findByUserId called with no AbortSignal").toBeInstanceOf(
      AbortSignal
    );
    if (this.findError) throw named(this.findError);
    const account = this.accounts.get(input.userId);
    if (!account) return null;
    return {
      username: account.username,
      email: account.email,
      enabled: account.enabled,
    };
  }

  async listGroups(input: { username: string; signal: AbortSignal }) {
    expect(input.signal, "listGroups called with no AbortSignal").toBeInstanceOf(
      AbortSignal
    );
    if (this.groupsError) throw named(this.groupsError);
    for (const account of this.accounts.values()) {
      if (account.username === input.username) return [...account.groups];
    }
    // An account Cognito knows but that is in no group. Mirrors the real API, which
    // answers an empty list rather than an error.
    return [];
  }

  async setEnabled(input: {
    username: string;
    enabled: boolean;
    signal: AbortSignal;
  }) {
    expect(input.signal, "setEnabled called with no AbortSignal").toBeInstanceOf(
      AbortSignal
    );
    if (this.setEnabledError) throw named(this.setEnabledError);
    // RECORDED BEFORE the state change and recorded even when the account is already in
    // the requested state, mirroring Cognito: AdminDisableUser on a disabled account
    // succeeds and changes nothing. A fake that skipped the no-op would let an
    // implementation that added a read-before-write (and a 409) pass the idempotency
    // test.
    this.enableCalls.push({ username: input.username, enabled: input.enabled });
    for (const account of this.accounts.values()) {
      if (account.username === input.username) account.enabled = input.enabled;
    }
  }

  async hasOtherEnabledAdmin(input: {
    excludingUsername: string;
    signal: AbortSignal;
  }) {
    expect(
      input.signal,
      "hasOtherEnabledAdmin called with no AbortSignal"
    ).toBeInstanceOf(AbortSignal);
    this.otherAdminChecks++;
    if (this.otherAdminError) throw named(this.otherAdminError);
    // Answered from the seeded accounts rather than from a flag, so "the last admin" is
    // a property of the fixture an assertion can trust.
    for (const account of this.accounts.values()) {
      if (account.username === input.excludingUsername) continue;
      if (account.enabled && account.groups.includes("ADMIN")) return true;
    }
    return false;
  }
}

class FakeInvitations implements InvitationReader {
  rows: InvitationRow[] = [];
  error: Error | null = null;
  /** Every revoke call, in order. */
  readonly revoked: { teamId: string; email: string }[] = [];
  /** Set to make revoke reject — a store failure, which the real one RETHROWS. */
  revokeError: Error | null = null;

  async listByEmail(_email: string): Promise<InvitationRow[]> {
    if (this.error) throw this.error;
    return this.rows;
  }

  /**
   * Mirrors DynamoInvitationReader.revoke: deletes the row and reports whether THIS
   * call did it. A missing row is a benign false — that is what makes a repeated
   * disable idempotent, so a fake that returned true unconditionally would hide a
   * count inflated by keys that matched nothing.
   */
  async revoke(teamId: string, email: string): Promise<boolean> {
    if (this.revokeError) throw this.revokeError;
    this.revoked.push({ teamId, email });
    const i = this.rows.findIndex(
      (row) => row.teamId === teamId && row.email === email.toLowerCase()
    );
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
}

class FakeProfiles implements ProfileStore {
  readonly writes: ProfileWrite[] = [];
  error: Error | null = null;
  /** Every status mirror write, in order. */
  readonly statuses: { userId: string; status: UserStatus; actorId: string }[] = [];
  /** Subs that HAVE a profile row. setStatus reports false for anything else. */
  readonly rows = new Set<string>();
  /** Set to make setStatus reject — a real store failure, which the real one RETHROWS. */
  statusError: Error | null = null;

  async upsertProvisioned(profile: ProfileWrite): Promise<void> {
    if (this.error) throw this.error;
    this.writes.push(profile);
  }

  async setStatus(input: {
    userId: string;
    status: UserStatus;
    actorId: string;
  }): Promise<boolean> {
    if (this.statusError) throw this.statusError;
    this.statuses.push(input);
    // Mirrors the adapter's ConditionExpression: no row means no mirror, reported as
    // false rather than fabricating a row with nothing but an id and a status.
    return this.rows.has(input.userId);
  }
}

class FakeAudit implements AuditRepository {
  readonly entries: AuditEntryWrite[] = [];
  /**
   * Set to make record() report a FAILED write. Deliberately a flag and not a throw:
   * the port's contract is that record NEVER throws, so a fake that threw would be
   * testing an impossible failure mode and would let a route that does not tolerate a
   * false pass anyway.
   */
  constructor(private readonly failing = false) {}

  async record(entry: AuditEntryWrite): Promise<boolean> {
    if (this.failing) return false;
    this.entries.push(entry);
    return true;
  }
}

class FakeEvents implements EventPublisher {
  readonly published: { id: string; email: string; role: Role }[] = [];
  error: Error | null = null;
  async publishUserCreated(user: { id: string; email: string; role: Role }) {
    if (this.error) throw this.error;
    this.published.push(user);
  }
}

/** An error shaped like an AWS SDK one: the `name` is the stable contract. */
function named(name: string): Error {
  const err = new Error(`${name} (fake)`);
  err.name = name;
  return err;
}

const realRandom: RandomBytes = (size) => new Uint8Array(randomBytes(size));

let directory: FakeDirectory;
let invitations: FakeInvitations;
let profiles: FakeProfiles;
let events: FakeEvents;
let audit: FakeAudit;
let app: ReturnType<typeof createUserAccessRoutes>;
/** Counts how many deadlines were minted — one per Cognito call. */
let deadlines: number;

/**
 * Build a router over the current fakes. Called by beforeEach for the default wiring,
 * and directly by the tests that need a FAILING audit store (which is a constructor
 * argument, so it cannot be flipped after the fact).
 */
function buildApp(overrides: { audit?: FakeAudit } = {}) {
  audit = overrides.audit ?? audit;
  return createUserAccessRoutes({
    directory,
    invitations,
    profiles,
    events,
    audit,
    random: realRandom,
    deadline: () => {
      deadlines++;
      // A real (already-armed) signal, so a handler that awaited it would still
      // behave — but long enough that no test races it.
      return AbortSignal.timeout(10_000);
    },
  });
}

beforeEach(() => {
  directory = new FakeDirectory();
  invitations = new FakeInvitations();
  profiles = new FakeProfiles();
  events = new FakeEvents();
  audit = new FakeAudit();
  deadlines = 0;
  app = buildApp();
});

const LIVE_INVITE: InvitationRow = {
  platformRole: "PARTICIPANT",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

async function provision(
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return app.request("/v1/user-access/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ─── The role gate ──────────────────────────────────────────────────────────

describe("who may provision an account", () => {
  it("refuses an anonymous caller", async () => {
    const res = await app.request("/v1/user-access/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com" }),
    });
    expect(res.status).toBe(401);
    expect(directory.created).toHaveLength(0);
  });

  it("refuses a PARTICIPANT — the role that may grant nothing", async () => {
    invitations.rows = [LIVE_INVITE];
    const res = await provision(asUser({ id: "p-1", role: "PARTICIPANT" }), {
      email: "someone@example.com",
    });
    expect(res.status).toBe(403);
    // The refusal must happen BEFORE any account is created, not after.
    expect(directory.created).toHaveLength(0);
  });

  it("refuses an unrecognised role (fails closed)", async () => {
    invitations.rows = [LIVE_INVITE];
    const res = await provision(asUser({ id: "x-1", role: "SUPERUSER" }), {
      email: "someone@example.com",
    });
    expect(res.status).toBe(403);
    expect(directory.created).toHaveLength(0);
  });

  /**
   * CHANGED, and deliberately not deleted: this case used to assert that all four of
   * ADMIN / FACILITATOR / EXECUTIVE / JUDGE received a 200 from provision, which is the
   * exact shape of the confirmed HIGH escalation — a JUDGE may grant NOTHING
   * (ROLE_GRANTS.JUDGE = []) and an EXECUTIVE only PARTICIPANT, yet both were let
   * through to a live temporary password for whatever role the invitation row named.
   * The old expectation encoded the vulnerability rather than a requirement.
   *
   * Split into the two questions the route now asks separately, because collapsing them
   * again is how the gate would be lost:
   *   - the FLOOR (canProvision) still admits all four onto the surface, and PARTICIPANT
   *     is still refused there. Asserted on a PARTICIPANT invitation, which is the only
   *     role all four may grant, so this case is about the floor and nothing else.
   *   - the PER-ROLE gate (canGrantRole) is asserted in its own matrix below.
   */
  it.each(["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE"])(
    "admits %s onto the surface for a role they may grant",
    async (role) => {
      // A PARTICIPANT invitation: within ROLE_GRANTS for every one of these four except
      // JUDGE, which is covered by the matrix below.
      invitations.rows = [LIVE_INVITE];
      const res = await provision(asUser({ id: "u-1", role }), {
        email: "someone@example.com",
      });
      expect(res.status).toBe(role === "JUDGE" ? 403 : 200);
    }
  );
});

// ─── The grant matrix: may this caller hand out THIS role? ───────────────────

/**
 * THE FIX FOR THE CONFIRMED HIGH ESCALATION, asserted through the HTTP surface.
 *
 * WHAT WAS WRONG. The handler resolved the role from the invitation row and never
 * compared it against the caller's own grant authority. The only gate was the coarse
 * PROVISIONER_ROLES floor — {ADMIN, FACILITATOR, EXECUTIVE, JUDGE} — so a JUDGE, who
 * may grant NOTHING, could POST an address holding a pending ADMIN invitation, receive
 * `200 {"temporaryPassword": "<live credential>", "role": "ADMIN"}`, and sign in: the
 * pool is MfaConfiguration: ON with no factor enrolled, so NEW_PASSWORD_REQUIRED leads
 * to MFA_SETUP and the attacker enrols their OWN authenticator. Full ADMIN takeover.
 *
 * The route is `ANY /v1/user-access/{proxy+}` behind an authorizer with no
 * AuthorizationScopes and the browser holds its own ID token, so the in-Lambda check is
 * the ONLY boundary — which is why every cell has to be provable here and not in the
 * BFF.
 *
 * The two properties that matter most are asserted by the ABSENCE OF AN EFFECT rather
 * than by the status code, because a route that 403'd after minting the password, or
 * after calling Cognito, would pass a status-only test: no Cognito call is made, and no
 * password appears in the body.
 */
describe("who may provision WHICH role — the ROLE_GRANTS matrix", () => {
  const ROLES = ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"];

  /**
   * The EXPECTED table, restated independently of the implementation.
   *
   * Written out rather than imported from domain.ts, which would make this tautological
   * — it would pass whatever the table said. This is the contract as
   * the shared constants/roles module documents it.
   */
  const EXPECTED: Record<string, readonly string[]> = {
    ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
    // NOT ADMIN: a facilitator must not be able to manufacture a peer with full
    // platform access. A peer FACILITATOR is fine — the invitee has no account yet, so
    // staffing a workshop takes nothing from anyone.
    FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
    // A sponsor may bring in their own builders and nothing else.
    EXECUTIVE: ["PARTICIPANT"],
    // NOTHING. This is the cell the escalation lived in.
    JUDGE: [],
    // Refused at the floor before this gate is ever consulted, and asserted anyway.
    PARTICIPANT: [],
  };

  it("covers every caller role, so a new role cannot be added without a decision here", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
  });

  for (const callerRole of ROLES) {
    for (const invitedRole of ROLES) {
      const allowed = EXPECTED[callerRole].includes(invitedRole);
      it(`${callerRole} provisioning a ${invitedRole} invitation is ${
        allowed ? "ALLOWED" : "REFUSED"
      }`, async () => {
        invitations.rows = [
          { platformRole: invitedRole, expiresAt: "2099-01-01T00:00:00.000Z" },
        ];

        const res = await provision(asUser({ id: "caller-1", role: callerRole }), {
          email: "target@example.com",
        });
        const text = await res.text();

        if (allowed) {
          expect(res.status, `${callerRole}→${invitedRole}`).toBe(200);
          expect(directory.created).toHaveLength(1);
          expect(directory.groups).toEqual([
            { username: "target@example.com", group: invitedRole },
          ]);
        } else {
          expect(res.status, `${callerRole}→${invitedRole}`).toBe(403);
          // NO COGNITO CALL. The refusal must precede every effect, not follow them.
          expect(directory.created, `${callerRole}→${invitedRole}`).toHaveLength(0);
          expect(directory.groups).toHaveLength(0);
          expect(profiles.writes).toHaveLength(0);
          expect(events.published).toHaveLength(0);
          // NO CREDENTIAL IN THE BODY. Asserted on the raw text rather than a parsed
          // field so a password leaking under any key name is caught.
          expect(text).not.toMatch(/temporaryPassword/);
        }
      });
    }
  }

  it("mints NO temporary password at all on a refusal", async () => {
    // The strongest form of the assertion, and the reason the check sits BEFORE
    // generateTemporaryPassword rather than after it: on a refused request the generator
    // must never run, so no credential exists even momentarily in a local that is
    // discarded. Proved by the RANDOM SOURCE never being drawn from — a route that
    // generated then discarded would consume bytes here.
    let draws = 0;
    app = createUserAccessRoutes({
      directory,
      invitations,
      profiles,
      events,
      audit,
      random: (size) => {
        draws++;
        return new Uint8Array(randomBytes(size));
      },
      deadline: () => AbortSignal.timeout(10_000),
    });
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];

    const res = await provision(asUser({ id: "judge-1", role: "JUDGE" }), {
      email: "pending-admin@example.com",
    });

    expect(res.status).toBe(403);
    expect(draws, "the password generator ran on a refused request").toBe(0);
  });

  it("spends NO Cognito deadline on a refusal", async () => {
    // The other half of "before any effect": a deadline is minted once per Cognito call,
    // so zero deadlines proves the refusal happened before the directory was touched.
    invitations.rows = [
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    deadlines = 0;

    const res = await provision(asUser({ id: "exec-1", role: "EXECUTIVE" }), {
      email: "staff@example.com",
    });

    expect(res.status).toBe(403);
    expect(deadlines).toBe(0);
  });

  it("refuses a JUDGE for EVERY role, including PARTICIPANT", async () => {
    // ROLE_GRANTS.JUDGE is empty — judging is an assignment, not a club that grows
    // itself. The floor still admits a JUDGE onto this
    // surface, so this gate is the only thing refusing them.
    for (const invitedRole of ROLES) {
      directory = new FakeDirectory();
      invitations = new FakeInvitations();
      profiles = new FakeProfiles();
      events = new FakeEvents();
      app = buildApp();
      invitations.rows = [
        { platformRole: invitedRole, expiresAt: "2099-01-01T00:00:00.000Z" },
      ];

      const res = await provision(asUser({ id: "judge-1", role: "JUDGE" }), {
        email: "target@example.com",
      });

      expect(res.status, `JUDGE→${invitedRole}`).toBe(403);
      expect(directory.created, `JUDGE→${invitedRole}`).toHaveLength(0);
    }
  });

  it("refuses an EXECUTIVE everything ABOVE participant", async () => {
    for (const invitedRole of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE"]) {
      directory = new FakeDirectory();
      invitations = new FakeInvitations();
      app = buildApp();
      invitations.rows = [
        { platformRole: invitedRole, expiresAt: "2099-01-01T00:00:00.000Z" },
      ];

      const res = await provision(asUser({ id: "exec-1", role: "EXECUTIVE" }), {
        email: "target@example.com",
      });

      expect(res.status, `EXECUTIVE→${invitedRole}`).toBe(403);
      expect(directory.created, `EXECUTIVE→${invitedRole}`).toHaveLength(0);
    }
  });

  it("refuses a FACILITATOR an ADMIN invitation but allows a peer FACILITATOR", async () => {
    // The one cell where ROLE_GRANTS and USER_ADMIN_GRANTS differ, asserted as a pair so
    // the two tables cannot be collapsed into one. Granting a PEER is harmless here (the
    // invitee has no account yet); manufacturing an ADMIN is not.
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    const refused = await provision(asUser({ id: "f-1", role: "FACILITATOR" }), {
      email: "pending-admin@example.com",
    });
    expect(refused.status).toBe(403);
    expect(directory.created).toHaveLength(0);

    invitations.rows = [
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    const allowed = await provision(asUser({ id: "f-1", role: "FACILITATOR" }), {
      email: "peer@example.com",
    });
    expect(allowed.status).toBe(200);
  });

  it("allows an ADMIN every role, peers included", async () => {
    for (const invitedRole of ROLES) {
      directory = new FakeDirectory();
      invitations = new FakeInvitations();
      profiles = new FakeProfiles();
      events = new FakeEvents();
      app = buildApp();
      invitations.rows = [
        { platformRole: invitedRole, expiresAt: "2099-01-01T00:00:00.000Z" },
      ];

      const res = await provision(ADMIN, { email: "target@example.com" });

      expect(res.status, `ADMIN→${invitedRole}`).toBe(200);
      expect(await res.json(), `ADMIN→${invitedRole}`).toMatchObject({
        role: invitedRole,
      });
    }
  });

  it("FAILS CLOSED on an unrecognised CALLER role", async () => {
    // Refused by the floor first, so this is belt-and-braces on the gate that would
    // decide if the floor were ever widened — and the direction of that failure is the
    // whole point of Object.hasOwn in grantableRoles.
    invitations.rows = [
      { platformRole: "PARTICIPANT", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    for (const role of ["SUPERUSER", "Admin", "admin"]) {
      const res = await provision(asUser({ id: "x-1", role }), {
        email: "target@example.com",
      });
      expect(res.status, role).toBe(403);
      expect(directory.created, role).toHaveLength(0);
    }
  });

  it("refuses a BLANK caller role as unauthenticated, before either gate", async () => {
    // 401 and not 403, and the distinction is real rather than a quirk worth papering
    // over: an HTTP header value is trimmed by the transport, so a whitespace-only role
    // arrives as an empty string and edgeIdentityMiddleware resolves NO IDENTITY at all
    // (`id && role`). There is no caller to evaluate a matrix against, so the honest
    // answer is "not authenticated". The predicate's own behaviour for a blank role is
    // asserted directly in domain.test.ts, where it fails closed to false.
    invitations.rows = [
      { platformRole: "PARTICIPANT", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    const res = await provision(asUser({ id: "x-1", role: "  " }), {
      email: "target@example.com",
    });
    expect(res.status).toBe(401);
    expect(directory.created).toHaveLength(0);
  });

  it("FAILS CLOSED on an unrecognised role ON THE INVITATION ROW", async () => {
    // resolveRoleFromInvitations collapses an unknown platformRole to PARTICIPANT today,
    // so this currently reaches the gate as PARTICIPANT and an ADMIN is allowed it. What
    // is asserted is the roles that must NOT get it: a row carrying a role nobody decided
    // about must not become a grant for a caller who could not have made it.
    invitations.rows = [
      { platformRole: "SUPERUSER", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    const res = await provision(asUser({ id: "judge-1", role: "JUDGE" }), {
      email: "target@example.com",
    });
    expect(res.status).toBe(403);
    expect(directory.created).toHaveLength(0);
  });

  it("cannot be widened by a PROTOTYPE-CHAIN role name", async () => {
    // The caller's role comes from a token's group claim, i.e. from outside, and
    // ROLE_GRANTS is a plain object literal — a bare index would find INHERITED
    // properties. `"constructor"` resolves to Object's constructor: truthy, so a
    // `!grantable` guard passes it through and `.includes` then throws, producing a 500
    // where a 403 belongs. That exact bug was found and fixed once in USER_ADMIN_GRANTS;
    // this asserts the second table did not reintroduce it.
    invitations.rows = [
      { platformRole: "PARTICIPANT", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    for (const role of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await provision(asUser({ id: "x-1", role }), {
        email: "target@example.com",
      });
      // 403, and specifically NOT 500 — the status is the assertion.
      expect(res.status, role).toBe(403);
      expect(directory.created, role).toHaveLength(0);
    }
  });

  it("does not reveal the temporary password or leak one into storage on a refusal", async () => {
    // The exploit's payload was the response BODY. Asserted across every durable sink as
    // well, because a route that refused late could still have written the row.
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];

    const res = await provision(asUser({ id: "judge-1", role: "JUDGE" }), {
      email: "pending-admin@example.com",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(Object.keys(body as object)).toEqual(["error"]);
    expect(JSON.stringify(body)).not.toMatch(/temporaryPassword/);
    expect(profiles.writes).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("names the ROLE in the refusal, and nothing else", async () => {
    // An operator whose role genuinely cannot staff this person needs an actionable
    // answer, not one implying the invitation is missing. The address must not be echoed.
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];

    const res = await provision(asUser({ id: "f-1", role: "FACILITATOR" }), {
      email: "pending-admin@example.com",
    });

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cannot provision a ADMIN account/);
    expect(body.error).not.toMatch(/pending-admin/);
  });

  it("is checked AFTER the invitation lookup, so a missing row is still a 409", async () => {
    // The two refusals are different facts and the operator's next action differs: 409
    // means "invite them first", 403 means "your role cannot". A gate that ran first
    // would tell a JUDGE with no invitation the wrong one.
    invitations.rows = [];
    const res = await provision(asUser({ id: "judge-1", role: "JUDGE" }), {
      email: "uninvited@example.com",
    });
    expect(res.status).toBe(409);
  });
});

// ─── Input validation, before any Cognito call ──────────────────────────────

describe("input validation", () => {
  it("rejects a missing email with a 400, not a 500", async () => {
    const res = await provision(ADMIN, {});
    expect(res.status).toBe(400);
    expect(directory.created).toHaveLength(0);
  });

  it("rejects a non-string email", async () => {
    const res = await provision(ADMIN, { email: { toString: "nope" } });
    expect(res.status).toBe(400);
  });

  it("rejects an absurdly long payload before running any regex over it", async () => {
    const res = await provision(ADMIN, { email: "a".repeat(5000) + "@example.com" });
    expect(res.status).toBe(400);
    expect(directory.created).toHaveLength(0);
  });

  it("turns a pool-invalid address into a 400 naming the problem", async () => {
    // Without this check Cognito answers InvalidParameterException, which would
    // surface as a 500 on a route the operator believes succeeded.
    invitations.rows = [LIVE_INVITE];
    const res = await provision(ADMIN, { email: "some one@example.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/spaces or control characters/),
    });
    expect(directory.created).toHaveLength(0);
  });

  it("rejects a too-long address at the pool's 128-character limit", async () => {
    invitations.rows = [LIVE_INVITE];
    const res = await provision(ADMIN, {
      email: "a".repeat(130) + "@example.com",
    });
    expect(res.status).toBe(400);
    expect(directory.created).toHaveLength(0);
  });

  it("LOWERCASES the address, matching how invitations are stored", async () => {
    // A case mismatch would look up no invitation and refuse a legitimate invite.
    invitations.rows = [LIVE_INVITE];
    await provision(ADMIN, { email: "  SomeOne@Example.COM  " });
    expect(directory.created[0].email).toBe("someone@example.com");
  });
});

// ─── The invitation is the authority ────────────────────────────────────────

describe("the role comes from the invitation, never from the request", () => {
  it("refuses with 409 when there is NO invitation for the address", async () => {
    invitations.rows = [];
    const res = await provision(ADMIN, { email: "uninvited@example.com" });
    expect(res.status).toBe(409);
    // The account must not be created — this is invite-only, enforced here as well as
    // by the pre-signup trigger.
    expect(directory.created).toHaveLength(0);
  });

  it("refuses when every invitation has EXPIRED", async () => {
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2020-01-01T00:00:00.000Z" },
    ];
    const res = await provision(ADMIN, { email: "lapsed@example.com" });
    expect(res.status).toBe(409);
    expect(directory.created).toHaveLength(0);
  });

  it("IGNORES a role supplied in the request body", async () => {
    // THE privilege-escalation test. A caller asking for ADMIN while the stored
    // invitation says PARTICIPANT must get PARTICIPANT.
    invitations.rows = [LIVE_INVITE];
    const res = await provision(ADMIN, {
      email: "someone@example.com",
      role: "ADMIN",
      platformRole: "ADMIN",
      group: "ADMIN",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "PARTICIPANT" });
    expect(directory.groups).toEqual([
      { username: "someone@example.com", group: "PARTICIPANT" },
    ]);
  });

  it("takes the HIGHEST-privilege live role when several invitations exist", async () => {
    invitations.rows = [
      { platformRole: "PARTICIPANT", expiresAt: "2099-01-01T00:00:00.000Z" },
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    const res = await provision(ADMIN, { email: "staff@example.com" });
    expect(await res.json()).toMatchObject({ role: "FACILITATOR" });
  });

  it("FAILS CLOSED with 503 when the invitation lookup itself fails", async () => {
    // Otherwise making DynamoDB unavailable would be a way to provision an
    // un-invited address.
    invitations.error = new Error("throttled");
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(503);
    expect(directory.created).toHaveLength(0);
  });
});

// ─── The happy path, and what "complete" means ──────────────────────────────

describe("a successful provisioning", () => {
  beforeEach(() => {
    invitations.rows = [{ platformRole: "JUDGE", expiresAt: "2099-01-01T00:00:00.000Z" }];
  });

  it("creates the account, assigns the group, writes the profile and publishes the event", async () => {
    // All four, because the whole point of doing this here rather than in the
    // (never-firing) PostConfirmation trigger is that the account is COMPLETE from
    // the moment it exists — no window where an invited user has no role.
    const res = await provision(ADMIN, { email: "judge@example.com" });
    expect(res.status).toBe(200);

    expect(directory.created).toHaveLength(1);
    expect(directory.groups).toEqual([
      { username: "judge@example.com", group: "JUDGE" },
    ]);
    expect(profiles.writes).toEqual([
      {
        id: "11111111-2222-3333-4444-555555555555",
        email: "judge@example.com",
        role: "JUDGE",
      },
    ]);
    expect(events.published).toEqual([
      {
        id: "11111111-2222-3333-4444-555555555555",
        email: "judge@example.com",
        role: "JUDGE",
      },
    ]);
  });

  it("reports the provisioning as complete", async () => {
    const res = await provision(ADMIN, { email: "judge@example.com" });
    expect(await res.json()).toMatchObject({
      role: "JUDGE",
      alreadyExisted: false,
      groupAssigned: true,
      profileWritten: true,
    });
  });

  it("gives EVERY Cognito call a deadline", async () => {
    // Three calls on the fresh-create path (create, group... and no sub lookup, since
    // the create returned one). Each fake asserts its own signal; this asserts the
    // deadlines were minted per call rather than one shared, already-elapsed signal.
    await provision(ADMIN, { email: "judge@example.com" });
    expect(deadlines).toBeGreaterThanOrEqual(2);
  });

  it("keys the profile row on the Cognito SUB, not the email", async () => {
    // A row keyed on anything else is invisible to GET /v1/auth/me, which resolves by
    // the token's subject — the account would exist and the platform still would not
    // see it.
    await provision(ADMIN, { email: "judge@example.com" });
    expect(profiles.writes[0].id).toBe("11111111-2222-3333-4444-555555555555");
  });
});

// ─── The temporary password ─────────────────────────────────────────────────

describe("the temporary password", () => {
  beforeEach(() => {
    invitations.rows = [LIVE_INVITE];
  });

  it("is returned to the caller, and is the SAME one given to Cognito", async () => {
    // If these differed, the emailed password would not work and the invitee would be
    // told their credentials are wrong on an account they cannot access.
    const res = await provision(ADMIN, { email: "someone@example.com" });
    const body = (await res.json()) as { temporaryPassword: string };
    expect(body.temporaryPassword).toBe(directory.created[0].temporaryPassword);
  });

  it("satisfies the pool policy", async () => {
    const res = await provision(ADMIN, { email: "someone@example.com" });
    const body = (await res.json()) as { temporaryPassword: string };
    expect(meetsPasswordPolicy(body.temporaryPassword)).toBe(true);
  });

  it("is DIFFERENT on every call", async () => {
    const first = (await (
      await provision(ADMIN, { email: "a@example.com" })
    ).json()) as { temporaryPassword: string };
    const second = (await (
      await provision(ADMIN, { email: "b@example.com" })
    ).json()) as { temporaryPassword: string };
    expect(first.temporaryPassword).not.toBe(second.temporaryPassword);
  });

  it("is NEVER written to the profile row or the event", async () => {
    // The two places it could leak into durable storage. Asserted by serialising the
    // whole recorded payload and searching for the secret, so a field added later is
    // covered without this test being updated.
    const res = await provision(ADMIN, { email: "someone@example.com" });
    const { temporaryPassword } = (await res.json()) as {
      temporaryPassword: string;
    };
    expect(JSON.stringify(profiles.writes)).not.toContain(temporaryPassword);
    expect(JSON.stringify(events.published)).not.toContain(temporaryPassword);
  });

  it("is not returned when the account could not be created", async () => {
    // A password for an account that does not exist is a secret with no purpose and
    // one more place for it to be logged.
    directory.createError = "InternalErrorException";
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/temporaryPassword/);
  });
});

// ─── Idempotency: re-inviting the same address ──────────────────────────────

describe("idempotency — an admin re-inviting the same address", () => {
  beforeEach(() => {
    invitations.rows = [LIVE_INVITE];
  });

  it("does NOT 500 when the account already exists", async () => {
    directory.alreadyExists = true;
    const res = await provision(ADMIN, { email: "existing@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyExisted: true });
  });

  it("still RE-ASSERTS the group and the profile row, so a re-invite repairs a partial one", async () => {
    // This is what makes re-inviting the operator's fix for a ghost account, rather
    // than a no-op that leaves it broken.
    directory.alreadyExists = true;
    await provision(ADMIN, { email: "existing@example.com" });
    expect(directory.groups).toHaveLength(1);
    expect(profiles.writes).toHaveLength(1);
  });

  it("LOOKS UP the sub when the create call did not return one", async () => {
    // AdminCreateUser returns no user on the already-exists path, and a profile row
    // under a synthetic key would be unreachable by /me.
    directory.alreadyExists = true;
    await provision(ADMIN, { email: "existing@example.com" });
    expect(directory.lookups).toBe(1);
    expect(profiles.writes[0].id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("produces the same outcome on a second identical call", async () => {
    const first = await provision(ADMIN, { email: "someone@example.com" });
    directory.alreadyExists = true;
    const second = await provision(ADMIN, { email: "someone@example.com" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Two group assertions, two profile merges — both idempotent operations by
    // construction (Cognito's add-to-group is a no-op when already a member, and the
    // profile write is an UpdateCommand merge, not a Put).
    expect(directory.groups.map((g) => g.group)).toEqual([
      "PARTICIPANT",
      "PARTICIPANT",
    ]);
  });

  it("does NOT skip the profile row for an existing account, so the row is repaired", async () => {
    directory.alreadyExists = true;
    await provision(ADMIN, { email: "existing@example.com" });
    expect(profiles.writes).toHaveLength(1);
  });
});

// ─── The existing-account gate ──────────────────────────────────────────────

/**
 * ── PROVISIONING AN ADDRESS THAT ALREADY HAS A LIVE ACCOUNT ────────────────────────────────
 *
 * /provision was previously gated ONLY by canGrantRole — the FORWARD-looking matrix
 * whose own documentation justifies a peer grant with "the invitee has NO ACCOUNT YET, so
 * granting a PEER is harmless". On the alreadyExisted branch that premise is false, and the
 * branch ran anyway: AdminAddUserToGroup executed against an account already in use, and
 * because collapseGroupsToRole takes the HIGHEST-precedence group, the victim was silently
 * PROMOTED. /access refuses exactly this act with USER_ADMIN_GRANTS, which is the matrix that
 * governs existing accounts and which this route never consulted.
 *
 * ⚠ THE CRITICAL CASE IS "FACILITATOR PROMOTES A PARTICIPANT TO FACILITATOR", and it is
 * critical because the OBVIOUS one-line fix does not catch it: canAdministerUser(FACILITATOR,
 * PARTICIPANT) is TRUE. Only checking the ROLE BEING CONFERRED as well refuses it. The test
 * named for that below is the one that must never be deleted.
 */
describe("provisioning an address that already has a LIVE account", () => {
  /** A live account at `email` in `groups`, whose sub the create path will resolve to. */
  function seedLiveAccount(email: string, groups: string[], sub = "victim-sub") {
    directory.alreadyExists = true;
    directory.subOnLookup = sub;
    directory.seed({ sub, username: email, email, groups });
    return sub;
  }

  const FACILITATOR = asUser({ id: "facilitator-1", role: "FACILITATOR" });

  it("refuses a FACILITATOR promoting an existing PARTICIPANT to FACILITATOR", async () => {
    // ⚠ THE ESCALATION, end to end. The invitation legitimately says FACILITATOR
    // (canGrantRole(FACILITATOR, FACILITATOR) is true — a facilitator may staff a peer from
    // scratch), the address already belongs to somebody, and the group write must not happen.
    invitations.rows = [
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("victim@example.com", ["PARTICIPANT"]);

    const res = await provision(FACILITATOR, { email: "victim@example.com" });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "EXISTING_ACCOUNT_FORBIDDEN" });
    // The ACT, not merely the status code: no group may have been added.
    expect(directory.groups).toHaveLength(0);
  });

  it("refuses it for an existing JUDGE and EXECUTIVE too — every role a facilitator may administer", async () => {
    // The first half of the check (may I act on this account?) passes for all three, so
    // these would all have escalated on a fix that only looked at the current role.
    for (const victimRole of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
      directory = new FakeDirectory();
      profiles = new FakeProfiles();
      app = buildApp();
      invitations.rows = [
        { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
      ];
      seedLiveAccount("victim@example.com", [victimRole]);

      const res = await provision(FACILITATOR, { email: "victim@example.com" });

      expect(res.status, `existing ${victimRole} must not be promoted`).toBe(403);
      expect(directory.groups, `no group write for an existing ${victimRole}`).toHaveLength(0);
    }
  });

  it("refuses a FACILITATOR acting on an existing ADMIN's account", async () => {
    // Both halves refuse this one: a facilitator may not administer an admin at all.
    invitations.rows = [
      { platformRole: "JUDGE", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("boss@example.com", ["ADMIN"]);

    const res = await provision(FACILITATOR, { email: "boss@example.com" });

    expect(res.status).toBe(403);
    expect(directory.groups).toHaveLength(0);
  });

  it("ALLOWS a FACILITATOR to grant a role they may confer on an existing account", async () => {
    // The gate must not become "no existing account may ever be touched". A facilitator
    // moving an existing PARTICIPANT to JUDGE is inside USER_ADMIN_GRANTS in both
    // directions, so it is permitted — and audited.
    invitations.rows = [
      { platformRole: "JUDGE", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("promotable@example.com", ["PARTICIPANT"]);

    const res = await provision(FACILITATOR, { email: "promotable@example.com" });

    expect(res.status).toBe(200);
    expect(directory.groups).toEqual([
      { username: "promotable@example.com", group: "JUDGE" },
    ]);
  });

  it("ALLOWS an ADMIN to act on a peer, because USER_ADMIN_GRANTS says an admin may", async () => {
    // Not an oversight and not a widening: ADMIN → ADMIN is in the matrix deliberately,
    // because the top of the tree has to be able to act on a compromised or departed admin.
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("other-admin@example.com", ["ADMIN"]);

    const res = await provision(ADMIN, { email: "other-admin@example.com" });

    expect(res.status).toBe(200);
    expect(directory.groups).toHaveLength(1);
  });

  it("refuses a caller changing their OWN role, mirroring /access's self-action gate", async () => {
    invitations.rows = [
      { platformRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    // The account the create path resolves to IS the caller's.
    seedLiveAccount("admin-1@example.com", ["PARTICIPANT"], "admin-1");

    const res = await provision(ADMIN, { email: "admin-1@example.com" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SELF_ACTION_REFUSED" });
    expect(directory.groups).toHaveLength(0);
  });

  it("still re-asserts a group the account ALREADY has, ungated", async () => {
    // Case (a). The documented repair for a partial provisioning, and it changes nothing —
    // gating it would break recovery while preventing no privilege change. A FACILITATOR
    // caller proves the allowance does not depend on being an admin.
    invitations.rows = [
      { platformRole: "JUDGE", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("already@example.com", ["JUDGE"]);

    const res = await provision(FACILITATOR, { email: "already@example.com" });

    expect(res.status).toBe(200);
    expect(directory.groups).toEqual([
      { username: "already@example.com", group: "JUDGE" },
    ]);
    // NOT audited: nothing changed, so the trail must not claim a role was granted.
    expect(audit.entries).toHaveLength(0);
  });

  it("repairs a GHOST account — one that exists in NO group", async () => {
    // Case (b). No privilege on it to hijack, and no route on this platform can put a live
    // account into this state, so the forward matrix is the right authority here.
    invitations.rows = [
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("ghost@example.com", []);

    const res = await provision(FACILITATOR, { email: "ghost@example.com" });

    expect(res.status).toBe(200);
    expect(directory.groups).toEqual([
      { username: "ghost@example.com", group: "FACILITATOR" },
    ]);
  });

  it("FAILS CLOSED when the account's current groups cannot be read", async () => {
    // Otherwise making Cognito unavailable is the bypass: an unreadable role would be
    // treated as no role, which is the one case the forward matrix alone governs.
    invitations.rows = [
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    seedLiveAccount("victim@example.com", ["PARTICIPANT"]);
    directory.groupsError = "InternalErrorException";

    const res = await provision(FACILITATOR, { email: "victim@example.com" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "EXISTING_ACCOUNT_ROLE_UNVERIFIED",
    });
    expect(directory.groups).toHaveLength(0);
  });

  it("does NOT gate a FRESH create — the forward matrix still governs those alone", async () => {
    // The regression that would matter most in the other direction: a facilitator staffing
    // a peer facilitator for an address with no account is the normal case and must not
    // start costing a group read or a 403.
    invitations.rows = [
      { platformRole: "FACILITATOR", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];

    const res = await provision(FACILITATOR, { email: "brand-new@example.com" });

    expect(res.status).toBe(200);
    expect(directory.groups).toEqual([
      { username: "brand-new@example.com", group: "FACILITATOR" },
    ]);
    expect(audit.entries).toHaveLength(0);
  });
});

// ─── The existing-account role change leaves a trail ────────────────────────

describe("a role change on an existing account is audited", () => {
  beforeEach(() => {
    invitations.rows = [
      { platformRole: "JUDGE", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    directory.alreadyExists = true;
    directory.subOnLookup = "victim-sub";
    directory.seed({
      sub: "victim-sub",
      username: "victim@example.com",
      email: "victim@example.com",
      groups: ["PARTICIPANT"],
    });
  });

  it("writes a ROLE_GRANTED entry naming the actor, the subject and both roles", async () => {
    // Before this the act left ONE console.log line, while /access wrote a row for the
    // strictly smaller act of toggling the same account's access.
    const res = await provision(ADMIN, { email: "victim@example.com" });

    expect(res.status).toBe(200);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      subjectId: "victim-sub",
      action: "ROLE_GRANTED",
      actorId: "admin-1",
      actorRole: "ADMIN",
    });
    // The FROM and the TO both have to be recoverable from the row, or the entry cannot
    // answer "what changed".
    expect(audit.entries[0].reason).toContain("JUDGE");
    expect(audit.entries[0].reason).toContain("PARTICIPANT");
  });

  it("reports the change and its audit outcome to the caller", async () => {
    const body = await (await provision(ADMIN, { email: "victim@example.com" })).json();
    expect(body).toMatchObject({ existingAccountRoleChanged: true, audited: true });
  });

  it("says nothing about a role change when there was none", async () => {
    // Absence is the signal here, so it is asserted rather than assumed.
    directory.alreadyExists = false;
    const body = await (await provision(ADMIN, { email: "fresh@example.com" })).json();
    expect(body).not.toHaveProperty("existingAccountRoleChanged");
    expect(body).not.toHaveProperty("audited");
  });

  it("reports audited:false rather than failing when the trail write fails", async () => {
    // The port's contract: record never throws, and a Cognito change that has ALREADY
    // applied must not be reported as a failure. The caller learns the fact was lost.
    app = buildApp({ audit: new FakeAudit(true) });
    const res = await provision(ADMIN, { email: "victim@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      existingAccountRoleChanged: true,
      audited: false,
    });
    // And the group write still happened — the trail failing does not undo the act.
    expect(directory.groups).toHaveLength(1);
  });

  it("does not write an entry when the group assignment itself failed", async () => {
    // Nothing changed, so there is nothing to record. An entry here would assert a
    // promotion that did not happen.
    directory.groupError = "InternalErrorException";
    const res = await provision(ADMIN, { email: "victim@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ groupAssigned: false });
    expect(audit.entries).toHaveLength(0);
  });
});

// ─── Failure semantics ──────────────────────────────────────────────────────

describe("failure semantics", () => {
  beforeEach(() => {
    invitations.rows = [LIVE_INVITE];
  });

  it("reports the invite GATE refusing us distinctly from a benign re-invite", async () => {
    // UserLambdaValidationException means the pre-signup trigger found no live
    // invitation at the moment Cognito read it — i.e. OUR sequencing is wrong (the
    // row must exist BEFORE this call). It must not be mistaken for "already there".
    directory.createError = "UserLambdaValidationException";
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVITE_GATE_REFUSED" });
  });

  it("maps a pool-level InvalidParameterException to a 400, not a 500", async () => {
    directory.createError = "InvalidParameterException";
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(400);
  });

  it("maps a TIMEOUT on the create call to a 502 and creates nothing", async () => {
    // What AbortSignal.timeout produces. It must read as "could not create" so a
    // retry (a re-invite) is the obvious next step.
    directory.createError = "TimeoutError";
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(502);
    expect(profiles.writes).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("REPORTS a failed group assignment instead of claiming success", async () => {
    // THE ghost-account case: the account exists and has no role, so the person can
    // sign in and be refused a session. The caller must be able to tell.
    directory.groupError = "ResourceNotFoundException";
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ groupAssigned: false });
  });

  it("still writes the profile row when the group assignment failed", async () => {
    // A visible account with no role is diagnosable from the Administration screen;
    // an invisible one is not. The row is the more valuable of the two.
    directory.groupError = "ResourceNotFoundException";
    await provision(ADMIN, { email: "someone@example.com" });
    expect(profiles.writes).toHaveLength(1);
  });

  it("REPORTS a failed profile write instead of claiming success", async () => {
    profiles.error = new Error("throttled");
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      groupAssigned: true,
      profileWritten: false,
    });
  });

  it("does NOT publish user.created when the profile row was not written", async () => {
    // The event tells five read-models a user exists. Publishing it with no row behind
    // it would seed those models with a user the source of truth does not have.
    profiles.error = new Error("throttled");
    await provision(ADMIN, { email: "someone@example.com" });
    expect(events.published).toHaveLength(0);
  });

  it("skips the profile row when NO sub could be resolved, rather than writing a synthetic key", async () => {
    // A row under a non-sub id is unreachable by /me and shows in the Administration
    // list as an account no admin API can act on — worse than no row.
    directory.alreadyExists = true;
    directory.subOnLookup = null;
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profileWritten: false });
    expect(profiles.writes).toHaveLength(0);
  });

  it("survives a user.created publish failure without failing the request", async () => {
    // The account is real and the row is written; a consumer can be replayed.
    events.error = new Error("bus unavailable");
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profileWritten: true });
  });

  it("does not fail provisioning when the sub LOOKUP throws", async () => {
    directory.alreadyExists = true;
    directory.findSub = async () => {
      throw named("TimeoutError");
    };
    const res = await provision(ADMIN, { email: "someone@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profileWritten: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/user-access/access — disable / re-enable a person's platform access
// ════════════════════════════════════════════════════════════════════════════

/**
 * The access surface's tests.
 *
 * WHAT THESE ARE FOR. This route is a privilege boundary, and a security review
 * confirmed two live vulnerabilities caused by exactly the mistake of trusting a
 * portal-layer check: every service route is mapped ANY behind a JWT authorizer that
 * does NO role scoping, and the browser holds its own ID token. So the checks asserted
 * below are not defence in depth — they are THE gate, and every one of them has to be
 * provable here rather than in the BFF.
 *
 * Four properties get the most attention, because each has a failure mode that a smoke
 * test of one disable would never surface:
 *
 *   1. The full USER_ADMIN_GRANTS matrix, including FAIL-CLOSED on an unknown role on
 *      EITHER side. The local copy in domain.ts exists because this is a bundled
 *      Lambda; without a matrix assertion the two copies drift silently, and a drift
 *      that ADDS a permission is invisible until it is exploited.
 *   2. The target's role is read SERVER-SIDE. A body-supplied role would make the
 *      whole matrix bypassable by a facilitator claiming their victim is a
 *      participant, and the wrong version type-checks perfectly.
 *   3. Pending invitations are revoked on disable and NOT restored on enable. An
 *      unredeemed invitation is a live credential: left behind, the disabled person
 *      re-registers and gets a NEW sub, at which point the disable does not apply to
 *      them. See cognito-presignup/src/handler.ts for the same bypass from the other
 *      side.
 *   4. Idempotency and audit degradation. Access has already changed by the time the
 *      audit is attempted, so a failing audit must be REPORTED and not thrown.
 */

/** A sub-shaped id. The real ones are UUIDs and the route length-caps the field. */
const TARGET_SUB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ACTOR_SUB = "99999999-8888-7777-6666-555555555555";

async function setAccess(
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return app.request("/v1/user-access/access", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** An admin whose sub is a real one, so the self-action test can be about identity. */
const REAL_ADMIN = asUser({ id: ACTOR_SUB, role: "ADMIN" });

/**
 * Seed a target plus a SECOND enabled admin, so the last-admin guard is satisfied by
 * the fixture and cannot be the reason an unrelated test fails.
 */
function seedTarget(groups: string[] = ["PARTICIPANT"], enabled = true): string {
  directory.seed({ sub: TARGET_SUB, groups, enabled, email: "target@example.com" });
  directory.seed({ sub: ACTOR_SUB, groups: ["ADMIN"], email: "actor@example.com" });
  profiles.rows.add(TARGET_SUB);
  return TARGET_SUB;
}

// ─── Gate 1: the role matrix ─────────────────────────────────────────────────

describe("who may change another user's access — the USER_ADMIN_GRANTS matrix", () => {
  /**
   * THE WHOLE MATRIX, asserted cell by cell.
   *
   * This is the test that keeps the local copy in domain.ts honest against
   * USER_ADMIN_GRANTS in the shared constants/roles module. Written as data rather
   * than as prose so a cell cannot be quietly omitted: every actor role is listed with
   * every target role and an explicit expectation, so a new role added to one copy and
   * not the other fails here rather than in production.
   */
  const MATRIX: Array<[actor: string, target: string, allowed: boolean]> = [
    // ADMIN → everyone, PEERS INCLUDED. The top of the tree has to be able to revoke a
    // compromised or departed admin.
    ["ADMIN", "ADMIN", true],
    ["ADMIN", "FACILITATOR", true],
    ["ADMIN", "JUDGE", true],
    ["ADMIN", "EXECUTIVE", true],
    ["ADMIN", "PARTICIPANT", true],
    // FACILITATOR → STRICTLY LOWER only. Not an ADMIN, and NOT ANOTHER FACILITATOR:
    // acting on a peer is a lateral attack — one facilitator could disable another
    // mid-workshop and take over their workshops.
    ["FACILITATOR", "ADMIN", false],
    ["FACILITATOR", "FACILITATOR", false],
    ["FACILITATOR", "JUDGE", true],
    ["FACILITATOR", "EXECUTIVE", true],
    ["FACILITATOR", "PARTICIPANT", true],
    // EXECUTIVE, JUDGE, PARTICIPANT → NOBODY. An empty list is the closed case.
    ["EXECUTIVE", "PARTICIPANT", false],
    ["EXECUTIVE", "EXECUTIVE", false],
    ["JUDGE", "PARTICIPANT", false],
    ["JUDGE", "JUDGE", false],
    ["PARTICIPANT", "PARTICIPANT", false],
  ];

  it.each(MATRIX)(
    "%s acting on %s → allowed=%s",
    async (actorRole, targetRole, allowed) => {
      seedTarget([targetRole]);
      // A second admin so the last-admin guard never decides this test.
      directory.seed({ sub: "spare-admin", groups: ["ADMIN"] });

      const res = await setAccess(asUser({ id: ACTOR_SUB, role: actorRole }), {
        userId: TARGET_SUB,
        enabled: false,
      });

      if (allowed) {
        expect(res.status, `${actorRole}→${targetRole}`).toBe(200);
        // The REFUSAL must be provable by the absence of an effect, not only by the
        // status: a route that 403'd after calling Cognito would pass a status-only test.
        expect(directory.enableCalls).toHaveLength(1);
      } else {
        expect(res.status, `${actorRole}→${targetRole}`).toBe(403);
        expect(directory.enableCalls).toHaveLength(0);
        expect(audit.entries).toHaveLength(0);
      }
    }
  );

  it("refuses an anonymous caller before any lookup", async () => {
    seedTarget();
    const res = await app.request("/v1/user-access/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TARGET_SUB, enabled: false }),
    });
    expect(res.status).toBe(401);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("FAILS CLOSED on an unrecognised ACTOR role", async () => {
    // A token whose groups we do not understand must administer nobody. This is the
    // half everyone remembers.
    seedTarget(["PARTICIPANT"]);
    const res = await setAccess(asUser({ id: ACTOR_SUB, role: "SUPERUSER" }), {
      userId: TARGET_SUB,
      enabled: false,
    });
    expect(res.status).toBe(403);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("FAILS CLOSED on an unrecognised TARGET role", async () => {
    // THE HALF THAT IS EASY TO GET WRONG, and the reason roleFromGroups returns null
    // rather than falling back to PARTICIPANT the way every other collapse on the
    // platform does. If a new, more privileged role is added and the matrix is not
    // updated, nobody may touch those accounts until somebody decides deliberately —
    // whereas a PARTICIPANT fallback would hand every such account to a facilitator.
    seedTarget(["SUPERUSER"]);
    const res = await setAccess(asUser({ id: ACTOR_SUB, role: "ADMIN" }), {
      userId: TARGET_SUB,
      enabled: false,
    });
    expect(res.status).toBe(403);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("FAILS CLOSED on a target in NO group at all", async () => {
    // Cognito answers an empty list for an account in no group — which the
    // post-confirmation outage produced for real (see the BedrockRuntimeEndpoint note in
    // the template). Such an account has no role, so no rule permits acting on it.
    seedTarget([]);
    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });
    expect(res.status).toBe(403);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("collapses MULTIPLE groups by precedence, so the HIGHEST role is the one protected", async () => {
    // An account in both ADMIN and PARTICIPANT is an ADMIN. Taking the other group would
    // let a facilitator disable an administrator — the escalation this collapse prevents.
    seedTarget(["PARTICIPANT", "ADMIN"]);
    const res = await setAccess(asUser({ id: ACTOR_SUB, role: "FACILITATOR" }), {
      userId: TARGET_SUB,
      enabled: false,
    });
    expect(res.status).toBe(403);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("refuses EXECUTIVE and JUDGE at the DIRECTORY gate, though both may provision", async () => {
    // The two gates are deliberately different sets: canProvision admits these roles
    // (they may invite, and provisioning only materialises a role they could grant),
    // canManageUsers does not (they have no business touching an existing account). A
    // route that reused the provisioning gate would let a judge disable a participant.
    for (const role of ["EXECUTIVE", "JUDGE"]) {
      seedTarget(["PARTICIPANT"]);
      const res = await setAccess(asUser({ id: ACTOR_SUB, role }), {
        userId: TARGET_SUB,
        enabled: false,
      });
      expect(res.status, role).toBe(403);
      const body = (await res.json()) as { error: string };
      // The message names the ACCESS surface, not provisioning — the two refusals are
      // different facts and an operator reading one deserves the right one.
      expect(body.error).toMatch(/cannot change another user's access/);
    }
    expect(directory.enableCalls).toHaveLength(0);
  });
});

// ─── The target's role is resolved SERVER-SIDE ───────────────────────────────

describe("the target's role comes from Cognito, never from the request", () => {
  it("IGNORES a role supplied in the body", async () => {
    // THE BYPASS THIS CLOSES. The target is a FACILITATOR, which a FACILITATOR may not
    // touch. A route that believed the body would allow it.
    seedTarget(["FACILITATOR"]);

    const res = await setAccess(asUser({ id: ACTOR_SUB, role: "FACILITATOR" }), {
      userId: TARGET_SUB,
      enabled: false,
      // Every plausible spelling an attacker would try.
      role: "PARTICIPANT",
      targetRole: "PARTICIPANT",
      platformRole: "PARTICIPANT",
      currentRole: "PARTICIPANT",
    });

    expect(res.status).toBe(403);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("READS the groups of the account the sub resolves to", async () => {
    // Proves the lookup is real rather than incidental: the group list is per-account in
    // the fake, so an implementation that read the WRONG account's groups would allow
    // this (the actor's own row is a plain ADMIN).
    seedTarget(["ADMIN"]);
    directory.seed({ sub: "spare-admin", groups: ["ADMIN"] });

    await setAccess(asUser({ id: ACTOR_SUB, role: "FACILITATOR" }), {
      userId: TARGET_SUB,
      enabled: false,
    });

    // A facilitator cannot touch an admin, and the only way to know the target is an
    // admin is to have read Cognito.
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("FAILS CLOSED when the role lookup itself fails", async () => {
    // An unreadable role is not a role we are permitted to act on. The alternative would
    // be a way to skip the matrix by making Cognito unavailable.
    seedTarget(["PARTICIPANT"]);
    directory.groupsError = "InternalErrorException";

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(502);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("FAILS CLOSED when the target lookup fails", async () => {
    seedTarget(["PARTICIPANT"]);
    directory.findError = "TimeoutError";

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(502);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("404s a sub with no Cognito account behind it", async () => {
    // The post-confirmation trigger's `sub || ulid()` fallback produces profile rows with
    // no account — one exists in the dev table. The UI marks them non-actionable, and the
    // write path must still answer honestly rather than 500.
    directory.seed({ sub: ACTOR_SUB, groups: ["ADMIN"] });
    const res = await setAccess(REAL_ADMIN, {
      userId: "01JQZK4T8N0000000000000000",
      enabled: false,
    });
    expect(res.status).toBe(404);
    expect(directory.enableCalls).toHaveLength(0);
  });
});

// ─── Gate 2: no self-action ──────────────────────────────────────────────────

describe("an administrator cannot change their OWN access", () => {
  it("refuses a self-disable with a distinct code", async () => {
    // An admin must not lock themselves out. USER_ADMIN_GRANTS names this as the
    // caller's responsibility precisely because the pure predicate cannot see it — the
    // matrix says ADMIN→ADMIN is allowed, and it is, just not on yourself.
    directory.seed({ sub: ACTOR_SUB, groups: ["ADMIN"] });
    directory.seed({ sub: "spare-admin", groups: ["ADMIN"] });

    const res = await setAccess(REAL_ADMIN, { userId: ACTOR_SUB, enabled: false });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SELF_ACTION_REFUSED" });
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("refuses a self-ENABLE too, not only a self-disable", async () => {
    // Enabling yourself is not obviously harmful, and it is still refused: the rule is
    // "you do not administer your own access", and a route that special-cased the
    // harmless direction would need a reason why. There is none — a disabled admin
    // cannot reach this route anyway (Cognito refuses them a token), so a self-enable
    // that succeeded would only ever be a no-op that muddies the audit trail.
    directory.seed({ sub: ACTOR_SUB, groups: ["ADMIN"] });

    const res = await setAccess(REAL_ADMIN, { userId: ACTOR_SUB, enabled: true });

    expect(res.status).toBe(409);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("checks self BEFORE spending any Cognito call", async () => {
    // An administrator who clicks their own row deserves the specific answer, not one
    // that arrives after three round trips. Asserted on the deadline count, which is
    // minted once per Cognito call.
    directory.seed({ sub: ACTOR_SUB, groups: ["ADMIN"] });
    deadlines = 0;

    await setAccess(REAL_ADMIN, { userId: ACTOR_SUB, enabled: false });

    expect(deadlines).toBe(0);
  });
});

// ─── Gate 3: never the last enabled ADMIN ────────────────────────────────────

describe("the LAST enabled ADMIN cannot be disabled", () => {
  it("refuses when the target is the only enabled admin", async () => {
    // This would leave the platform with nobody able to administer it — and nobody able
    // to undo it, since this surface is ADMIN/FACILITATOR-gated and a FACILITATOR may
    // not act on an ADMIN. The disable would be irreversible from the product.
    directory.seed({ sub: TARGET_SUB, groups: ["ADMIN"] });
    // The ACTOR is an admin too, but is not in the fake's account map as an enabled
    // ADMIN peer — this fixture is deliberately "one admin account in the pool".
    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LAST_ADMIN_REFUSED" });
    expect(directory.enableCalls).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("ALLOWS it when another enabled admin remains", async () => {
    directory.seed({ sub: TARGET_SUB, groups: ["ADMIN"] });
    directory.seed({ sub: "other-admin", groups: ["ADMIN"], enabled: true });
    profiles.rows.add(TARGET_SUB);

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(directory.enableCalls).toEqual([
      { username: `user-${TARGET_SUB}`, enabled: false },
    ]);
  });

  it("does NOT count a DISABLED admin as the one who remains", async () => {
    // The whole point of the guard: an admin account that is already disabled cannot
    // administer anything, so it is not a remaining administrator. Counting it would
    // permit the lockout while appearing to have checked.
    directory.seed({ sub: TARGET_SUB, groups: ["ADMIN"] });
    directory.seed({ sub: "dormant-admin", groups: ["ADMIN"], enabled: false });

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(409);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("FAILS CLOSED when the last-admin check cannot be answered", async () => {
    // The most important of the three fail-closed paths: proceeding on an unanswered
    // "is anyone else able to administer this platform?" is how the platform becomes
    // unadministrable. A refusal is recoverable; the lockout is not.
    directory.seed({ sub: TARGET_SUB, groups: ["ADMIN"] });
    directory.seed({ sub: "other-admin", groups: ["ADMIN"] });
    directory.otherAdminError = "TooManyRequestsException";

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(503);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("does NOT run the check when the target is not an ADMIN", async () => {
    // A group listing on every ordinary participant disable would be a Cognito call per
    // click for a question whose answer cannot change.
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(directory.otherAdminChecks).toBe(0);
  });

  it("does NOT run the check when ENABLING an admin", async () => {
    // Enabling cannot reduce the number of enabled admins.
    directory.seed({ sub: TARGET_SUB, groups: ["ADMIN"], enabled: false });
    profiles.rows.add(TARGET_SUB);

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(res.status).toBe(200);
    expect(directory.otherAdminChecks).toBe(0);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("the access change is IDEMPOTENT", () => {
  it("disabling an ALREADY-DISABLED account succeeds", async () => {
    // Assume at-least-once: a double-click, a client retry or a redelivery must converge
    // on the same state rather than answering 409. Cognito's own calls are idempotent, so
    // the route must not add a read-before-write that turns that into an error.
    seedTarget(["PARTICIPANT"], false);

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: TARGET_SUB, enabled: false });
    // The call is still MADE — the route does not skip it. Skipping would make the
    // response a claim about state it never asserted.
    expect(directory.enableCalls).toHaveLength(1);
  });

  it("enabling an ALREADY-ENABLED account succeeds", async () => {
    seedTarget(["PARTICIPANT"], true);

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true });
  });

  it("converges on the same state over repeated disables, and audits each attempt", async () => {
    seedTarget(["PARTICIPANT"]);

    for (let i = 0; i < 3; i++) {
      const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });
      expect(res.status, `attempt ${i}`).toBe(200);
    }

    expect(directory.accounts.get(TARGET_SUB)?.enabled).toBe(false);
    // THREE entries, not one. Each request IS an administrative action somebody took,
    // and the trail records actions rather than state transitions — "who kept trying to
    // disable this person" is a question an investigation may need. The table's
    // `<iso>#<ulid>` sort key exists so three actions in the same millisecond cannot
    // overwrite one another.
    expect(audit.entries).toHaveLength(3);
  });
});

// ─── Revoking pending invitations ────────────────────────────────────────────

describe("disabling REVOKES the person's live invitations", () => {
  /** A live (un-expired, unredeemed) invitation for the seeded target's address. */
  const live = (teamId: string): InvitationRow => ({
    teamId,
    email: "target@example.com",
    status: "PENDING",
    platformRole: "PARTICIPANT",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });

  it("deletes every live invitation and reports the count", async () => {
    // WHY THIS IS PART OF DISABLING: an unredeemed invitation is a LIVE
    // CREDENTIAL. Left in place, the disabled person registers again through the
    // invite-only gate and receives a BRAND-NEW Cognito sub — at which point every
    // record keyed on the old sub, this disable included, no longer applies to them.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [live("team-1"), live("team-2"), live("PLATFORM")];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      invitationsRevoked: 3,
      invitationsRevokeComplete: true,
    });
    // Addressed by the FULL composite key. The invitations table is keyed
    // (teamId, email), so a delete missing either half matches nothing and would report
    // a clean revoke of nothing.
    expect(invitations.revoked).toEqual([
      { teamId: "team-1", email: "target@example.com" },
      { teamId: "team-2", email: "target@example.com" },
      { teamId: "PLATFORM", email: "target@example.com" },
    ]);
  });

  it("does NOT delete an ACCEPTED invitation", async () => {
    // An ACCEPTED row is the audit record of a grant somebody already redeemed. Deleting
    // it would destroy that record and remove no access — by then their access lives in
    // Cognito, which this route has just switched off.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [
      { ...live("team-1"), status: "ACCEPTED" },
      live("team-2"),
    ];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await res.json()).toMatchObject({ invitationsRevoked: 1 });
    expect(invitations.revoked).toEqual([
      { teamId: "team-2", email: "target@example.com" },
    ]);
  });

  it("treats an ACCEPTED status case-INSENSITIVELY", async () => {
    // The string is a cross-service contract carried in three separate bundles, so a
    // casing difference must not silently reopen the bypass. Mirrors isAccepted() in the
    // pre-signup trigger, which compares the same way for the same reason.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [{ ...live("team-1"), status: " accepted " }];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await res.json()).toMatchObject({ invitationsRevoked: 0 });
    expect(invitations.revoked).toHaveLength(0);
  });

  it("does NOT bother deleting an EXPIRED invitation", async () => {
    // An expired row admits nothing — the pre-signup gate refuses it — so there is no
    // credential to destroy, and it is left as the record it is.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [{ ...live("team-1"), expiresAt: "2020-01-01T00:00:00.000Z" }];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await res.json()).toMatchObject({ invitationsRevoked: 0 });
  });

  it("treats a row with NO expiresAt as LIVE and revokes it", async () => {
    // The polarity that matters: rows written before invite-link expiry existed have no
    // attribute, and those are REAL live grants. Treating absence as expired would leave
    // the oldest credentials — the ones most likely to have been forgotten — in place.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [{ teamId: "team-1", email: "target@example.com" }];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await res.json()).toMatchObject({ invitationsRevoked: 1 });
  });

  it("ENABLING does NOT resurrect revoked invitations, and revokes nothing", async () => {
    // Re-admission is a DELIBERATE act — a fresh invitation — not a side effect of
    // restoring an account. A re-enable that recreated the old rows would hand back
    // credentials somebody decided to destroy.
    seedTarget(["PARTICIPANT"], false);
    invitations.rows = [];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ invitationsRevoked: 0 });
    expect(invitations.revoked).toHaveLength(0);
    expect(invitations.rows).toHaveLength(0);
  });

  it("does not revoke on ENABLE even when live invitations exist", async () => {
    // Somebody re-invited while the account was disabled. That invitation is a
    // deliberate act by an authorized inviter and this route must not undo it.
    seedTarget(["PARTICIPANT"], false);
    invitations.rows = [live("team-1")];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(await res.json()).toMatchObject({ invitationsRevoked: 0 });
    expect(invitations.rows).toHaveLength(1);
  });

  it("STILL DISABLES when the invitation lookup fails, and reports it INCOMPLETE", async () => {
    // Cognito has already refused this account tokens by the time the revoke runs.
    // Failing the request would have the operator retry an access change that took
    // effect, so the failure degrades into a reported partial instead.
    seedTarget(["PARTICIPANT"]);
    invitations.error = new Error("throttled");

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      invitationsRevoked: 0,
      invitationsRevokeComplete: false,
    });
    expect(directory.accounts.get(TARGET_SUB)?.enabled).toBe(false);
  });

  it("STILL DISABLES when a single revoke fails, and reports it INCOMPLETE", async () => {
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [live("team-1")];
    invitations.revokeError = new Error("AccessDeniedException");

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      invitationsRevoked: 0,
      invitationsRevokeComplete: false,
    });
    expect(directory.accounts.get(TARGET_SUB)?.enabled).toBe(false);
  });

  it("reports INCOMPLETE for a live row missing half its composite key", async () => {
    // Such a row cannot be addressed by a delete at all, but it is still a live grant.
    // Reporting a complete sweep while leaving one behind would be the wrong answer to
    // the one question this step exists to answer.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [
      { email: "target@example.com", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await res.json()).toMatchObject({
      invitationsRevoked: 0,
      invitationsRevokeComplete: false,
    });
  });

  it("BOUNDS the revoke and says so, rather than issuing an unbounded fan-out", async () => {
    // The bound is on STORED DATA, not on the request, which is what makes it worth
    // having: an address invited to hundreds of teams would otherwise turn one disable
    // into hundreds of sequential deletes and exhaust the 15s function timeout, leaving
    // the account disabled in Cognito with the operator looking at a failure.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = Array.from({ length: 40 }, (_, i) => live(`team-${i}`));

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitationsRevoked: number;
      invitationsRevokeComplete: boolean;
    };
    expect(body.invitationsRevoked).toBe(25);
    // The overflow is REPORTED, not silently dropped: live credentials remain.
    expect(body.invitationsRevokeComplete).toBe(false);
    expect(invitations.revoked).toHaveLength(25);
  });

  it("is idempotent across a repeated disable — the second revoke finds nothing", async () => {
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [live("team-1")];

    const first = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });
    const second = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await first.json()).toMatchObject({ invitationsRevoked: 1 });
    // A row already gone is a benign zero and does NOT spoil completeness: the end state
    // is the one that was asked for.
    expect(await second.json()).toMatchObject({
      invitationsRevoked: 0,
      invitationsRevokeComplete: true,
    });
  });
});

// ─── The display mirror ──────────────────────────────────────────────────────

describe("the profile row's status is a DISPLAY MIRROR", () => {
  it("writes DEACTIVATED on disable and ACTIVE on enable", async () => {
    // The identity service serves the Administration directory and has no Cognito client
    // or IAM, so without this copy the screen could not show who is disabled or offer a
    // way to reverse it.
    seedTarget(["PARTICIPANT"]);

    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });
    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(profiles.statuses).toEqual([
      { userId: TARGET_SUB, status: "DEACTIVATED", actorId: ACTOR_SUB },
      { userId: TARGET_SUB, status: "ACTIVE", actorId: ACTOR_SUB },
    ]);
  });

  /**
   * WHO CHANGED THE ACCESS, ON THE ROW — and this is a forensics control, not display.
   *
   * `audit.record` returns false rather than throwing, so an access change can take effect
   * with `audited: false`. Before `accessChangedBy` the operator's identity then existed
   * NOWHERE: Cognito records no actor on AdminDisableUser/AdminEnableUser beyond CloudTrail,
   * and this row carried none — an unaudited disable was permanently unattributable. The
   * team service's routes never had that hole, because `removedBy`/`reactivatedBy` are
   * written onto the membership row with the status flip; this path was the odd one out.
   *
   * ⚠ Asserted from the VERIFIED TOKEN, never from the request body. A caller-supplied actor
   * on a forensics field would let the one control on this path be forged, which is worse
   * than not having it.
   */
  it("stamps the ACTOR on the row, taken from the token and not the body", async () => {
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      // Ignored. If this ever wins, the field is forgeable and worthless.
      actorId: "11111111-2222-3333-4444-555555555555",
      accessChangedBy: "11111111-2222-3333-4444-555555555555",
    } as Record<string, unknown>);

    expect(res.status).toBe(200);
    expect(profiles.statuses).toHaveLength(1);
    expect(profiles.statuses[0].actorId).toBe(ACTOR_SUB);
    expect(profiles.statuses[0].actorId).not.toBe(
      "11111111-2222-3333-4444-555555555555"
    );
  });

  it("stamps the actor even when the AUDIT WRITE FAILS — the case it exists for", async () => {
    // The whole point. An unaudited access change is exactly when the trail cannot answer
    // "who did this", so the row has to. The mirror write runs BEFORE the audit call, so a
    // failing trail cannot prevent the breadcrumb.
    seedTarget(["PARTICIPANT"]);
    // The port's contract is that record() never THROWS, so the fake reports a failed
    // write via its constructor flag rather than by throwing — see FakeAudit.
    app = buildApp({ audit: new FakeAudit(true) });

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audited: false });
    // Unattributable before this change; recoverable now.
    expect(profiles.statuses[0].actorId).toBe(ACTOR_SUB);
  });

  it("writes the mirror AFTER Cognito, never instead of it", async () => {
    // Cognito is the authority. A route that mirrored the row and skipped the Cognito
    // call would render a convincing "Access disabled" badge over an account that can
    // still sign in — the worst possible failure here, and one only an ordering
    // assertion catches.
    seedTarget(["PARTICIPANT"]);
    directory.setEnabledError = "NotAuthorizedException";

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(502);
    expect(profiles.statuses).toHaveLength(0);
  });

  it("STILL CHANGES ACCESS when the mirror write fails, and reports the stale badge", async () => {
    // A failed mirror is a wrong badge, not an access bug — precisely because nothing
    // enforces on the field. That is why it is allowed to be best-effort at all.
    seedTarget(["PARTICIPANT"]);
    profiles.statusError = new Error("throttled");

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, statusMirrored: false });
    expect(directory.accounts.get(TARGET_SUB)?.enabled).toBe(false);
  });

  it("reports statusMirrored=false when there is no profile row to mirror onto", async () => {
    // A Cognito account with no profile row — which the provisioning path can produce
    // when the sub could not be resolved. The adapter's ConditionExpression refuses to
    // fabricate a row carrying nothing but an id and a status.
    directory.seed({ sub: TARGET_SUB, groups: ["PARTICIPANT"] });
    directory.seed({ sub: ACTOR_SUB, groups: ["ADMIN"] });
    // profiles.rows deliberately NOT populated.

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ statusMirrored: false });
  });
});

// ─── Audit ───────────────────────────────────────────────────────────────────

describe("every access change is audited", () => {
  it("records WHO did it, to WHOM, with the actor's role at the time", async () => {
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(asUser({ id: ACTOR_SUB, role: "FACILITATOR" }), {
      userId: TARGET_SUB,
      enabled: false,
      reason: "left the programme",
    });

    expect(await res.json()).toMatchObject({ audited: true });
    expect(audit.entries).toEqual([
      {
        subjectId: TARGET_SUB,
        action: "ACCESS_DISABLED",
        actorId: ACTOR_SUB,
        // The actor's role AT THE TIME — a historical fact, so it is stored rather than
        // re-derived from a directory that may since have changed.
        actorRole: "FACILITATOR",
        reason: "left the programme",
      },
    ]);
  });

  it("records ACCESS_ENABLED on the other direction", async () => {
    seedTarget(["PARTICIPANT"], false);

    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(audit.entries[0]).toMatchObject({
      subjectId: TARGET_SUB,
      action: "ACCESS_ENABLED",
      actorId: ACTOR_SUB,
      actorRole: "ADMIN",
    });
  });

  it("carries NO reason attribute when none was supplied", async () => {
    seedTarget(["PARTICIPANT"]);
    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });
    expect(audit.entries[0].reason).toBeUndefined();
  });

  it("collapses a whitespace-only reason to absent", async () => {
    // An empty string would render as an empty "Reason:" line in the trail — worse than
    // no line, because it reads as data that failed to load.
    seedTarget(["PARTICIPANT"]);
    await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      reason: "   \n\t ",
    });
    expect(audit.entries[0].reason).toBeUndefined();
  });

  it("TRUNCATES an over-long reason rather than failing the change", async () => {
    // Losing the tail of a note is a smaller loss than losing the entry, and an access
    // change the operator has decided on must not fail over the length of a comment.
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      reason: "x".repeat(500),
    });

    expect(res.status).toBe(200);
    expect(audit.entries[0].reason).toHaveLength(200);
  });

  it("refuses an absurd reason payload before doing any work", async () => {
    // A payload bound, distinct from the 200-character storage rule: a megabyte of text
    // is refused before anything iterates its code points.
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      reason: "x".repeat(5000),
    });

    expect(res.status).toBe(400);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("counts a multi-byte reason in CODE POINTS, so no surrogate pair is cut in half", async () => {
    // `.slice` on UTF-16 units can cut an emoji in half, writing a lone surrogate into
    // the row that renders as a replacement character in the trail. Measured the same way
    // usernameRejectionReason and the profile validator measure their fields.
    seedTarget(["PARTICIPANT"]);

    await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      // 250 astral-plane characters: 250 code points, 500 UTF-16 units.
      reason: "\u{1F600}".repeat(250),
    });

    const stored = audit.entries[0].reason as string;
    expect([...stored]).toHaveLength(200);
    // No lone surrogate survived the cut.
    expect(stored).toBe("\u{1F600}".repeat(200));
  });

  it("STILL CHANGES ACCESS when the audit write fails, and says so", async () => {
    // THE ORDERING GUARANTEE, mirroring the team service's removal route exactly. Cognito
    // has already applied the change and the invitations are already gone, so throwing
    // here would have the operator retry a completed action. `audited: false` is how the
    // caller learns an access change went unrecorded — worth an alarm, not a failure.
    seedTarget(["PARTICIPANT"]);
    invitations.rows = [
      {
        teamId: "team-1",
        email: "target@example.com",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ];
    app = buildApp({ audit: new FakeAudit(true) });

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      audited: false,
      // The effects HAPPENED — that is the point.
      invitationsRevoked: 1,
    });
    expect(directory.accounts.get(TARGET_SUB)?.enabled).toBe(false);
  });

  it("records NOTHING for a refused attempt", async () => {
    // A refused attempt is not an action, and an entry for it would fill the trail with
    // noise an investigator has to discount. Asserted across all three gates.
    seedTarget(["FACILITATOR"]);

    // Gate 1 — the matrix.
    await setAccess(asUser({ id: ACTOR_SUB, role: "FACILITATOR" }), {
      userId: TARGET_SUB,
      enabled: false,
    });
    // Gate 2 — self.
    await setAccess(REAL_ADMIN, { userId: ACTOR_SUB, enabled: false });

    expect(audit.entries).toHaveLength(0);
  });

  it("does NOT put the reason text in the audit response or in the entry's key fields", async () => {
    // The reason is operator free-text and may name a person. It belongs in the row and
    // nowhere else — not in the response body, which the browser sees, and not in a log
    // line (asserted by inspection of the route; the log itself carries ids only).
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      reason: "reported by Jane Doe",
    });

    expect(JSON.stringify(await res.json())).not.toContain("Jane Doe");
  });
});

// ─── The unaudited-access-change alarm ───────────────────────────────────────

/**
 * THE MACHINE-SIDE SIGNAL for an access change that took effect and was NOT recorded.
 *
 * WHY THIS PATH MATTERS MORE THAN THE TEAM SERVICE'S. On the team routes the actor
 * survives the lost audit write: `removedBy` / `reactivatedBy` are stamped onto the
 * membership row in the same UpdateCommand as the status flip. HERE THERE IS NO SUCH
 * FALLBACK — `upsertProvisioned` writes no actor and Cognito records none — so if this
 * audit write fails, the identity of whoever withdrew or restored someone's sign-in
 * access is GONE. That makes this alarm the ONLY control on this path, which is why its
 * wiring is asserted rather than assumed.
 *
 * The EMF line IS the transport (CloudWatch Logs parses it into the metric — no
 * PutMetricData call, no IAM, nothing to stub), so asserting on `console.log` is
 * asserting on the metric.
 */
describe("an UNRECORDED access change emits the alarm's metric", () => {
  /** Every `UnauditedAccessChanges` EMF record emitted during one test. */
  function captureUnauditedMetrics(): Array<Record<string, unknown>> {
    const records: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line !== "string") return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // Not an EMF record — the route's own plain log line.
      }
      if ("UnauditedAccessChanges" in parsed) records.push(parsed);
    });
    return records;
  }

  // The route logs unconditionally, so the spy must not outlive its test or it would
  // swallow a later test's diagnostics.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits 1 with Action ACCESS_DISABLED when the audit write fails on a real disable", async () => {
    const records = captureUnauditedMetrics();
    seedTarget(["PARTICIPANT"]);
    app = buildApp({ audit: new FakeAudit(true) });

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    // UNCHANGED: the change took effect and is reported, not failed.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, audited: false });

    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(1);
    expect(records[0].Action).toBe("ACCESS_DISABLED");
    expect(records[0].subjectId).toBe(TARGET_SUB);
    expect(records[0].actorId).toBe(ACTOR_SUB);
    // No team on a platform-wide change; absent stays absent.
    expect(records[0]).not.toHaveProperty("teamId");
  });

  it("emits 1 with Action ACCESS_ENABLED on the other direction", async () => {
    // Both directions, because the alarm is dimensioned by action and a direction that
    // never publishes would be a hole nothing else reveals. An unrecorded ENABLE is the
    // more serious of the two — it is a GRANT of sign-in access with no attributable actor.
    const records = captureUnauditedMetrics();
    seedTarget(["PARTICIPANT"], false);
    app = buildApp({ audit: new FakeAudit(true) });

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, audited: false });
    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(1);
    expect(records[0].Action).toBe("ACCESS_ENABLED");
  });

  it("emits the SUCCESS datapoint (0) when the audit write lands", async () => {
    // So the metric exists in a healthy account and "no data" stays distinguishable from
    // "no failures" — without this, a deploy that broke the emission reads as permanently
    // healthy.
    const records = captureUnauditedMetrics();
    seedTarget(["PARTICIPANT"]);

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(await res.json()).toMatchObject({ audited: true });
    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(0);
    expect(records[0].Action).toBe("ACCESS_DISABLED");
  });

  it("does NOT alarm when the account was ALREADY in the requested state", async () => {
    // ⚠ THE NOISE GUARD. A re-issued disable of an already-disabled account changes
    // nothing, so an unrecorded one is not a lost fact about anybody's access — and a
    // double-clicked toggle produces exactly this. Emitting a 1 here would page on a
    // harmless duplicate and train everyone to ignore the alarm.
    //
    // NOTE this differs from the audit WRITE, which is deliberately unconditional on this
    // route: the trail records the operator's ACT (they asked for it, and the attempt is
    // worth recording) while the alarm reports a lost FACT. The 0 below is the assertion
    // that the two were not conflated.
    const records = captureUnauditedMetrics();
    seedTarget(["PARTICIPANT"], false);
    app = buildApp({ audit: new FakeAudit(true) });

    const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(res.status).toBe(200);
    // The audit write still failed and is still reported as such...
    expect(await res.json()).toMatchObject({ audited: false });
    // ...but nothing was LOST, so the alarm does not see a datapoint.
    expect(records).toHaveLength(1);
    expect(records[0].UnauditedAccessChanges).toBe(0);
  });

  it("publishes BOTH dimension sets under the exact namespace the template's alarm watches", async () => {
    // ⚠ THE SILENT-FAILURE MODE. CloudWatch treats each dimension COMBINATION as its own
    // metric and an alarm must match one EXACTLY, so a metric published only under
    // {Action} would leave UnauditedAccessChangeAlarm — which declares no Dimensions on
    // purpose, to watch the aggregate — permanently OK through the very failure it exists
    // to catch. Asserted against the LITERAL strings in
    // the infrastructure CloudFormation template, because a mismatch breaks nothing at
    // runtime and is invisible in every other test.
    const records = captureUnauditedMetrics();
    seedTarget(["PARTICIPANT"]);
    app = buildApp({ audit: new FakeAudit(true) });

    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

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

    expect(directive.Namespace).toBe("Praimana/AccessChanges");
    expect(directive.Metrics).toEqual([
      { Name: "UnauditedAccessChanges", Unit: "Count" },
    ]);
    expect(directive.Dimensions).toEqual(expect.arrayContaining([[], ["Action"]]));
    expect(directive.Dimensions).toHaveLength(2);
  });

  it("carries NO email, NO reason text and no unbounded dimension", async () => {
    // The bounded-dimension rule (a dimension must have bounded values — `Action` has four for
    // the life of the platform, a userId has none) plus this platform's standing rule that
    // the reason is operator free-text which may name a person.
    const records = captureUnauditedMetrics();
    seedTarget(["PARTICIPANT"]);
    app = buildApp({ audit: new FakeAudit(true) });

    await setAccess(REAL_ADMIN, {
      userId: TARGET_SUB,
      enabled: false,
      reason: "reported by Jane Doe at jane@example.com",
    });

    const line = JSON.stringify(records[0]);  // nosemgrep: no-stringify-keys
    expect(line).not.toContain("@");
    expect(line).not.toContain("Jane Doe");
    // The target's own address, which the route holds from the directory read.
    expect(line).not.toContain("target@example.com");

    const directive = (
      records[0] as unknown as {
        _aws: { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
      }
    )._aws.CloudWatchMetrics[0];
    for (const set of directive.Dimensions) {
      expect(set.every((key) => key === "Action")).toBe(true);
    }
  });

  it("does NOT emit for a REFUSED attempt — no access changed, so nothing was lost", async () => {
    // Gate 1 refuses before Cognito is touched. An alarm datapoint here would report a
    // lost audit fact about an access change that never happened.
    const records = captureUnauditedMetrics();
    seedTarget(["FACILITATOR"]);

    const res = await setAccess(asUser({ id: ACTOR_SUB, role: "FACILITATOR" }), {
      userId: TARGET_SUB,
      enabled: false,
    });

    expect(res.status).toBe(403);
    expect(records).toEqual([]);
  });
});

// ─── Input validation ────────────────────────────────────────────────────────

describe("access input validation", () => {
  it("rejects a non-JSON body", async () => {
    const res = await app.request("/v1/user-access/access", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...REAL_ADMIN },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing userId", async () => {
    const res = await setAccess(REAL_ADMIN, { enabled: false });
    expect(res.status).toBe(400);
    expect(directory.enableCalls).toHaveLength(0);
  });

  it("rejects an absurdly long userId before it reaches a Cognito filter", async () => {
    const res = await setAccess(REAL_ADMIN, {
      userId: "a".repeat(500),
      enabled: false,
    });
    expect(res.status).toBe(400);
    expect(deadlines).toBe(0);
  });

  it("requires `enabled` to be a real boolean", async () => {
    // NOT `!!raw.enabled`. The two directions of this operation are not interchangeable,
    // so a request that does not say which it means must be refused rather than
    // defaulted — and a truthy string is exactly how a client bug becomes a silent
    // disable.
    seedTarget(["PARTICIPANT"]);
    for (const enabled of [undefined, null, "false", "true", 0, 1, {}, []]) {
      const res = await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled });
      expect(res.status, JSON.stringify(enabled)).toBe(400);
    }
    expect(directory.enableCalls).toHaveLength(0);
  });
});

// ─── Deadlines ───────────────────────────────────────────────────────────────

describe("every Cognito call on the access path carries a deadline", () => {
  it("mints one deadline per call, from the ONE shared definition", async () => {
    // Asserted as a COUNT rather than by inspecting each signal, because the fakes
    // already assert the presence of a signal per call (a missing one fails there). What
    // this adds is that no call bypassed the injected deadline factory — which is what
    // would happen if a new call site invented its own timeout, or none.
    seedTarget(["ADMIN"]);
    directory.seed({ sub: "other-admin", groups: ["ADMIN"] });
    deadlines = 0;

    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    // findByUserId + listGroups + hasOtherEnabledAdmin + setEnabled.
    expect(deadlines).toBe(4);
  });

  it("skips the last-admin call for a non-admin target, so an ordinary disable is 3 calls", async () => {
    seedTarget(["PARTICIPANT"]);
    deadlines = 0;

    await setAccess(REAL_ADMIN, { userId: TARGET_SUB, enabled: false });

    expect(deadlines).toBe(3);
  });
});
