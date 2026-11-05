import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createIdentityRoutes } from "./routes.js";
import type { User, UserPage, UserRepository } from "./domain.js";

/**
 * The trusted-internal-hop path (x-internal-token + x-identity-*) is how these
 * tests authenticate: it exercises the SAME edgeIdentityMiddleware the deployed
 * service runs, but without a Cognito JWKS fetch. The Bearer path is covered by
 * service-shared's own verifier; what matters here is the routes' behaviour once
 * an identity exists — and, just as much, which routes work without one.
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

/** In-memory UserRepository — the DIP seam domain.ts exists for. No AWS. */
class FakeUsers implements UserRepository {
  private readonly byId = new Map<string, User>();

  constructor(seed: User[] = []) {
    for (const u of seed) this.byId.set(u.id, u);
  }

  async getById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }
  async getByEmail(email: string): Promise<User | null> {
    return [...this.byId.values()].find((u) => u.email === email) ?? null;
  }
  /** ⚠ A FULL-ITEM REPLACE, exactly like the store's PutCommand — see updateProfile below. */
  async put(user: User): Promise<User> {
    this.byId.set(user.id, user);
    return user;
  }
  /**
   * MERGES, because the real implementation is an UpdateCommand with a SET expression over
   * only these five attributes.
   *
   * ⚠ THE MERGE IS THE WHOLE POINT OF THE FAKE. `put` above replaces the row, which
   * is what deleted `accessChangedBy`, `accessChangedAt` and `avatarUrl` on every
   * profile save. A fake that implemented this as another `set` would model the BUG and let the
   * regression test pass against the unfixed route.
   */
  async updateProfile(
    id: string,
    fields: {
      firstName: string;
      lastName: string;
      organization: string;
      name: string;
      updatedAt: string;
    }
  ): Promise<User> {
    const existing = this.byId.get(id);
    if (!existing) {
      // The real UpdateCommand would UPSERT here. The route never calls this without having
      // read a row, so a test that reaches this is exercising something it did not mean to.
      throw new Error("updateProfile called for an id with no row");
    }
    const merged = { ...existing, ...fields };
    this.byId.set(id, merged);
    return merged;
  }
  // Index-based paging over insertion order. Enough to exercise the route's cursor
  // pass-through; the real clamping and base64url encoding live in the DynamoDB
  // implementation and are its concern, not the route's.
  //
  // visibleRoles is honoured here — and applied BEFORE paging, as the real
  // FilterExpression is — because a fake that ignored it would let the route stop
  // passing it while every visibility test still went green.
  async list(
    opts: { limit?: number; cursor?: string; visibleRoles?: readonly string[] } = {}
  ): Promise<UserPage> {
    const all = [...this.byId.values()].filter(
      (u) => !opts.visibleRoles || opts.visibleRoles.includes(u.role)
    );
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 50;
    const slice = all.slice(start, start + limit);
    const end = start + slice.length;
    return {
      users: slice,
      nextCursor: end < all.length ? String(end) : undefined,
    };
  }
  // Deliberately UNFILTERED by role, mirroring the real repository: the ?ids= route
  // and /user-names both apply visibility to the RESULT, and a fake that filtered
  // here would make those route-level checks untestable — every visibility
  // assertion would pass because the rows never arrived, not because the route
  // dropped them.
  //
  // Unknown ids are absent rather than an error, and the result is NOT aligned with
  // the input order, both of which the real BatchGetItem does too.
  async listByIds(ids: readonly string[]): Promise<User[]> {
    return [...new Set(ids)]
      .map((id) => this.byId.get(id))
      .filter((u): u is User => !!u);
  }
}

function profile(over: Partial<User> = {}): User {
  return {
    id: "u-1",
    email: "stored@example.com",
    name: "Stored Name",
    role: "PARTICIPANT",
    authProvider: "COGNITO",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const savedEnv = { ...process.env };
afterEach(() => {
  // /config reads env at REQUEST time, so leaking a value between tests would
  // make these order-dependent.
  process.env = { ...savedEnv, INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN };
});

// GET /v1/auth/config is deliberately registered ABOVE edgeIdentityMiddleware and
// its HttpApi route sets Authorizer: NONE — the desktop app points at an arbitrary
// server URL with no baked-in auth config, so it MUST be able to bootstrap the
// Hosted UI flow before it has any token at all. If a future change moves it below
// the middleware (or wraps the whole app), the desktop can never sign in again and
// nothing else in the system would notice. This test is that tripwire.
describe("GET /v1/auth/config (public discovery)", () => {
  it("answers without any credential", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/config");
    expect(res.status).toBe(200);
  });

  it("echoes the Cognito wiring from env and advertises the PKCE scopes", async () => {
    process.env.COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/pool";
    process.env.COGNITO_CLIENT_ID = "client-123";
    process.env.COGNITO_HOSTED_UI_DOMAIN = "auth.example.com";

    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/config");

    /**
     * ⚠ `toEqual` ON THE WHOLE BODY, AND IT STAYS THAT WAY. This is an UNAUTHENTICATED route, so the
     * exact-shape assertion is the control that stops a field being added to it without a decision —
     * which is exactly what it did when `supportEmail` was added: this test failed, deliberately.
     *
     * ⚠ IT ALREADY DID THAT JOB TWICE: it failed when `supportEmail` was added for the desktop's
     * mailto links, and again when that field was REMOVED once mailto was replaced with stored
     * reports. Both times the failure was correct — a change to what an unauthenticated route discloses
     * should never be silent.
     */
    expect(await res.json()).toEqual({
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      clientId: "client-123",
      hostedUiDomain: "auth.example.com",
      scopes: ["openid", "email", "profile"],
    });
  });

  it("returns empty strings rather than undefined when env is unset", async () => {
    delete process.env.COGNITO_ISSUER;
    delete process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_HOSTED_UI_DOMAIN;

    const app = createIdentityRoutes({ users: new FakeUsers() });
    const body = (await (await app.request("/v1/auth/config")).json()) as Record<
      string,
      unknown
    >;

    // A missing key would serialize away entirely and the desktop's config parse
    // would read `undefined` as "not configured yet" instead of "configured empty".
    expect(body.issuer).toBe("");
    expect(body.clientId).toBe("");
    expect(body.hostedUiDomain).toBe("");
    // ⚠ AND NO `supportEmail` KEY AT ALL. It existed for the desktop's mailto links and went with them;
    // asserting its ABSENCE is what stops it drifting back in unnoticed on a route that must stay public.
    expect(body).not.toHaveProperty("supportEmail");
  });
});

describe("GET /v1/auth/me", () => {
  it("rejects an unauthenticated caller", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("ignores x-identity-* headers presented WITHOUT the internal token", async () => {
    // Identity headers are only trusted alongside the shared secret. Without this
    // rule anyone could set three headers and become an ADMIN.
    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/me", {
      headers: {
        "x-identity-id": "attacker",
        "x-identity-role": "ADMIN",
      },
    });
    expect(res.status).toBe(401);
  });

  it("returns the stored profile row when one exists", async () => {
    const app = createIdentityRoutes({
      users: new FakeUsers([profile({ id: "u-1", name: "Ada", organization: "AWS" })]),
    });
    const res = await app.request("/v1/auth/me", {
      headers: asUser({ id: "u-1", email: "token@example.com", role: "ADMIN" }),
    });

    const body = (await res.json()) as { user: User };
    expect(res.status).toBe(200);
    expect(body.user.name).toBe("Ada");
    expect(body.user.organization).toBe("AWS");
  });

  it("falls back to the verified token claims when the profile row is missing", async () => {
    // The profile row is written by the Cognito post-confirmation trigger, so
    // there is a real window right after sign-up where it does not exist yet. The
    // caller must still get their identity back (id/email/role from the token)
    // rather than a 404 — otherwise the first page load after registering breaks.
    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/me", {
      headers: asUser({ id: "brand-new", email: "new@example.com", role: "JUDGE" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: "brand-new",
        email: "new@example.com",
        role: "JUDGE",
        // No stored fields, so the caller is told to complete their profile.
        profileComplete: false,
      },
    });
  });

  it("scopes the lookup to the CALLER's own id, never a client-supplied one", async () => {
    // /me takes the id from the verified identity only; there is no path or query
    // parameter to point it at someone else's profile.
    const app = createIdentityRoutes({
      users: new FakeUsers([
        profile({ id: "u-1", name: "Mine" }),
        profile({ id: "u-2", name: "Someone Else", email: "other@example.com" }),
      ]),
    });
    const res = await app.request("/v1/auth/me?id=u-2", {
      headers: asUser({ id: "u-1", email: "mine@example.com", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { user: User };
    expect(body.user.id).toBe("u-1");
    expect(body.user.name).toBe("Mine");
  });

  it("reports profileComplete=true once the fields are stored", async () => {
    // The portal's gate reads this flag rather than re-deriving "complete" from
    // the fields; two derivations is how a redirect loop happens.
    const app = createIdentityRoutes({
      users: new FakeUsers([
        profile({
          id: "u-1",
          firstName: "Ada",
          lastName: "Lovelace",
          organization: "AWS",
        }),
      ]),
    });
    const res = await app.request("/v1/auth/me", {
      headers: asUser({ id: "u-1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { user: User & { profileComplete: boolean } };
    expect(body.user.profileComplete).toBe(true);
  });

  it("reports profileComplete=false when the row has no profile row at all", async () => {
    // The token-claims fallback path must still tell the caller they're incomplete,
    // or a brand-new user would sail past the gate with nothing stored.
    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/me", {
      headers: asUser({ id: "brand-new", email: "new@example.com", role: "JUDGE" }),
    });

    const body = (await res.json()) as { user: { profileComplete: boolean } };
    expect(body.user.profileComplete).toBe(false);
  });
});

// ─── PATCH /v1/auth/me — the mandatory profile fields ───
//
// This endpoint is the REAL gate on first name / last name / organisation being
// present. The sign-up form validates too, but a client can skip the form and call
// here directly, so these tests are the ones that matter for the invariant.
describe("PATCH /v1/auth/me", () => {
  function patch(
    app: ReturnType<typeof createIdentityRoutes>,
    identity: { id: string; email?: string; role: string },
    body: unknown
  ) {
    return app.request("/v1/auth/me", {
      method: "PATCH",
      headers: { ...asUser(identity), "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const good = {
    firstName: "Ada",
    lastName: "Lovelace",
    organization: "Analytical Engines",
  };

  it("rejects an unauthenticated caller", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers() });
    const res = await app.request("/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(good),
    });
    expect(res.status).toBe(401);
  });

  /**
   * The access MIRROR must survive this endpoint.
   *
   * ⚠ IT IS NO LONGER A FULL-ITEM WRITE ON THIS PATH. It was, and carrying `status`
   * through explicitly is what kept this test passing — while FOUR other attributes were being
   * deleted on every save because nobody had enumerated them. An edit is now an UpdateCommand
   * over the profile fields only, so preservation is structural rather than a list somebody has
   * to maintain. The test stays exactly as it was: the property it asserts is still required, and
   * it now holds for a better reason.
   *
   * The window is narrow but real: a disabled account keeps API access on an already-issued token
   * for up to its lifetime (see the residual-window note on UserStatus), so the person can save
   * this form once after being disabled. Losing the mirror there would clear the "Access disabled"
   * badge PERMANENTLY while Cognito still refused them.
   */
  it("PRESERVES a mirrored DEACTIVATED status", async () => {
    const users = new FakeUsers([profile({ id: "u-1", status: "DEACTIVATED" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      good
    );

    expect(res.status).toBe(200);
    expect((await users.getById("u-1"))?.status).toBe("DEACTIVATED");
  });

  it("does NOT let the caller set their own status", async () => {
    // Platform access is not the account holder's to set. Only the user-access service
    // writes this field, and only after passing three server-side gates — so a body key
    // here must be ignored rather than merged, exactly as `role` and `email` are.
    const users = new FakeUsers([profile({ id: "u-1" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      { ...good, status: "DEACTIVATED" }
    );

    expect(res.status).toBe(200);
    expect((await users.getById("u-1"))?.status).toBeUndefined();
  });

  /**
   * ── ⚠ A PROFILE SAVE MUST NOT DELETE ATTRIBUTES OTHER SERVICES WROTE ─────────────────────
   *
   * The handler previously built a complete `User` and persisted it with a full-item
   * PutCommand, which REPLACES the item — so every attribute it did not restate was deleted. It
   * restated `status`, `email`, `role`, `authProvider` and `createdAt` (the test above is what
   * kept `status` on that list), and it silently dropped four others on every single save:
   *
   *   accessChangedBy / accessChangedAt  user-access's own record of WHO disabled or enabled the
   *     account, written straight onto this row as the fallback for when the separate audit write
   *     is the thing that failed. Not an authorization input — so nothing about access control
   *     was affected — but the route's own comment concedes a disabled account can save this form
   *     once on an already-issued token, which is exactly when somebody would want it gone.
   *
   *   avatarUrl  declared on the shared User type, and simply vanished from the UI when a user
   *     saved their own profile.
   *
   * ⚠ THESE ARE ASSERTED TOGETHER AND BY NAME, because the failure mode is an ENUMERATION
   * going stale: three services write to this row. The next attribute added by any of them must
   * be preserved too, and the assertion that catches that is the "nothing else changed" one at
   * the end rather than any per-field check.
   */
  it("PRESERVES attributes written by OTHER services — the ones the full-item Put deleted", async () => {
    // `accessChangedBy`/`accessChangedAt` are not declared on the shared `User` type at all —
    // user-access writes them and nobody reads them — so they are attached through a cast, which
    // is exactly how they exist on a real row.
    const stored = {
      ...profile({ id: "u-1" }),
      avatarUrl: "https://example.test/a.png",
      accessChangedBy: "admin-9",
      accessChangedAt: "2026-08-20T10:00:00.000Z",
    } as User;
    const users = new FakeUsers([stored]);

    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      good
    );

    expect(res.status).toBe(200);
    const after = (await users.getById("u-1")) as unknown as Record<string, unknown>;
    expect(after.avatarUrl).toBe("https://example.test/a.png");
    expect(after.accessChangedBy).toBe("admin-9");
    expect(after.accessChangedAt).toBe("2026-08-20T10:00:00.000Z");
  });

  it("changes ONLY the profile fields and updatedAt — nothing else on the row moves", async () => {
    // The generalisation of the test above, and the one that will catch the FIFTH attribute
    // somebody adds later. Written as a diff over the whole row rather than a list of fields,
    // because a list is the thing that went stale in the first place.
    const stored = {
      ...profile({ id: "u-1", name: "Stored Name" }),
      avatarUrl: "https://example.test/a.png",
      accessChangedBy: "admin-9",
      accessChangedAt: "2026-08-20T10:00:00.000Z",
      status: "DEACTIVATED",
    } as User;
    const users = new FakeUsers([stored]);

    await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      good
    );

    const after = (await users.getById("u-1")) as unknown as Record<string, unknown>;
    const before = stored as unknown as Record<string, unknown>;
    const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => before[key] !== after[key]
    );

    expect(moved.sort()).toEqual(
      ["firstName", "lastName", "name", "organization", "updatedAt"].sort()
    );
  });

  it("does not INVENT a status on a row it creates", async () => {
    // Absent means ACTIVE, and writing an explicit "ACTIVE" would be a second spelling of
    // the same fact for every new account — one that a future reader could be tempted to
    // test for, reintroducing the `!== "ACTIVE"` bug the polarity exists to avoid.
    const users = new FakeUsers();
    await patch(
      createIdentityRoutes({ users }),
      { id: "fresh", email: "fresh@example.com", role: "PARTICIPANT" },
      good
    );

    expect((await users.getById("fresh"))?.status).toBeUndefined();
  });

  it("saves the three fields and derives `name` from the parts", async () => {
    const users = new FakeUsers([profile({ id: "u-1", name: "Stored Name" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", email: "ada@example.com", role: "PARTICIPANT" },
      good
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: User & { profileComplete: boolean } };
    expect(body.user.firstName).toBe("Ada");
    expect(body.user.lastName).toBe("Lovelace");
    expect(body.user.organization).toBe("Analytical Engines");
    // `name` is DERIVED — the client never sends it, and the previously stored
    // value must not survive a profile update.
    expect(body.user.name).toBe("Ada Lovelace");
    expect(body.user.profileComplete).toBe(true);
  });

  it("normalises whitespace before storing", async () => {
    const users = new FakeUsers([profile({ id: "u-1" })]);
    await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      { firstName: "  Ada  ", lastName: "Lovelace", organization: "A   B" }
    );

    const stored = await users.getById("u-1");
    expect(stored?.firstName).toBe("Ada");
    expect(stored?.organization).toBe("A B");
    // A trailing space would otherwise render the header as "Ada  Lovelace".
    expect(stored?.name).toBe("Ada Lovelace");
  });

  it.each([
    ["firstName", { ...good, firstName: "" }],
    ["lastName", { ...good, lastName: "   " }],
    ["organization", { ...good, organization: undefined }],
  ])("rejects a missing %s with a per-field message", async (key, body) => {
    const users = new FakeUsers([profile({ id: "u-1" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      body
    );

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { fields: Record<string, string> };
    expect(payload.fields[key]).toBeDefined();
    // Nothing partially written on a rejected request.
    expect((await users.getById("u-1"))?.firstName).toBeUndefined();
  });

  it("treats a whitespace-only value as absent — the case the gate depends on", async () => {
    // If a space satisfied a mandatory field, the field would be mandatory in name
    // only and the completion gate would wave the user through with nothing stored.
    const users = new FakeUsers([profile({ id: "u-1" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      { firstName: " ", lastName: " ", organization: " " }
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-string values rather than coercing them into the row", async () => {
    const users = new FakeUsers([profile({ id: "u-1" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      { firstName: 42, lastName: { x: 1 }, organization: ["A"] }
    );
    expect(res.status).toBe(400);
    expect((await users.getById("u-1"))?.firstName).toBeUndefined();
  });

  it("rejects a body that isn't a JSON object", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers([profile({ id: "u-1" })]) });
    for (const body of ["not json", JSON.stringify([good]), JSON.stringify(null)]) {
      const res = await patch(app, { id: "u-1", role: "PARTICIPANT" }, body);
      expect(res.status, `accepted ${body}`).toBe(400);
    }
  });

  it("NEVER accepts a role from the body — that would be privilege escalation", async () => {
    const users = new FakeUsers([profile({ id: "u-1", role: "PARTICIPANT" })]);
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      { ...good, role: "ADMIN" }
    );

    expect(res.status).toBe(200);
    expect((await users.getById("u-1"))?.role).toBe("PARTICIPANT");
    const body = (await res.json()) as { user: User };
    expect(body.user.role).toBe("PARTICIPANT");
  });

  it("NEVER accepts an email from the body — Cognito owns it", async () => {
    // The invitation → role lookup keys on email, so letting a client rewrite it
    // would let them claim someone else's invited role on a later reconciliation.
    const users = new FakeUsers([profile({ id: "u-1", email: "real@example.com" })]);
    await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", email: "real@example.com", role: "PARTICIPANT" },
      { ...good, email: "attacker@example.com" }
    );

    expect((await users.getById("u-1"))?.email).toBe("real@example.com");
  });

  it("ignores unknown keys instead of merging them onto the row", async () => {
    const users = new FakeUsers([profile({ id: "u-1" })]);
    await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      { ...good, isSuperUser: true, id: "u-2" }
    );

    const stored = (await users.getById("u-1")) as unknown as Record<string, unknown>;
    expect(stored.isSuperUser).toBeUndefined();
    expect(stored.id).toBe("u-1");
    // The client-supplied id must not have created a second row.
    expect(await users.getById("u-2")).toBeNull();
  });

  it("writes only the CALLER's own row, ignoring a query id", async () => {
    const users = new FakeUsers([
      profile({ id: "u-1", name: "Mine" }),
      profile({ id: "u-2", name: "Someone Else", email: "other@example.com" }),
    ]);
    const app = createIdentityRoutes({ users });
    await app.request("/v1/auth/me?id=u-2", {
      method: "PATCH",
      headers: {
        ...asUser({ id: "u-1", role: "PARTICIPANT" }),
        "content-type": "application/json",
      },
      body: JSON.stringify(good),
    });

    expect((await users.getById("u-1"))?.name).toBe("Ada Lovelace");
    expect((await users.getById("u-2"))?.name).toBe("Someone Else");
  });

  it("CREATES the row when none exists yet, using the verified token claims", async () => {
    // The post-confirmation trigger fails soft by design, so a confirmed user can
    // reach the profile form with no row at all. A 404 here would strand them at
    // the completion gate forever.
    const users = new FakeUsers();
    const res = await patch(
      createIdentityRoutes({ users }),
      { id: "brand-new", email: "new@example.com", role: "JUDGE" },
      good
    );

    expect(res.status).toBe(200);
    const stored = await users.getById("brand-new");
    expect(stored?.email).toBe("new@example.com");
    expect(stored?.role).toBe("JUDGE");
    expect(stored?.authProvider).toBe("COGNITO");
    expect(stored?.createdAt).toBeTruthy();
  });

  it("preserves createdAt and advances updatedAt on an existing row", async () => {
    const users = new FakeUsers([
      profile({ id: "u-1", createdAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    await patch(
      createIdentityRoutes({ users }),
      { id: "u-1", role: "PARTICIPANT" },
      good
    );

    const stored = await users.getById("u-1");
    expect(stored?.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(stored?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("reports profileComplete=false for a row that predates these fields", async () => {
    // Rows written before this feature carry only name/email. They must read as
    // incomplete so the user is asked once, rather than being silently exempt.
    const users = new FakeUsers([profile({ id: "u-1", name: "Legacy User" })]);
    const app = createIdentityRoutes({ users });
    const res = await app.request("/v1/auth/me", {
      headers: asUser({ id: "u-1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { user: User & { profileComplete: boolean } };
    expect(body.user.profileComplete).toBe(false);
  });

  // ─── LENGTH AND CHARACTER RULES, AT THE REAL GATE ───
  //
  // The portal validates the same rules through the same shared module, but the
  // portal is skippable: anyone can PATCH this endpoint directly. So these are the
  // assertions that actually enforce the contract, and they are written against the
  // HTTP surface (status code + per-field message + nothing written) rather than
  // against the validator, which the shared suite already covers.
  describe("field rules", () => {
    /** Assert a body is refused with 400, a message on `key`, and no write. */
    async function expectRejected(
      body: Record<string, unknown>,
      key: string,
      match: RegExp
    ) {
      const users = new FakeUsers([profile({ id: "u-1" })]);
      const res = await patch(
        createIdentityRoutes({ users }),
        { id: "u-1", role: "PARTICIPANT" },
        body
      );

      expect(res.status, JSON.stringify(body)).toBe(400);
      const payload = (await res.json()) as {
        error: string;
        fields: Record<string, string>;
      };
      expect(payload.fields[key], JSON.stringify(body)).toMatch(match);
      // A rejected request must leave the row untouched — a partial write here would
      // be worse than the invalid value, because the row would then disagree with
      // both the old and the new rules.
      expect((await users.getById("u-1"))?.firstName).toBeUndefined();
    }

    /** Assert a body is accepted and the value stored verbatim (post-normalisation). */
    async function expectAccepted(body: Record<string, string>) {
      const users = new FakeUsers([profile({ id: "u-1" })]);
      const res = await patch(
        createIdentityRoutes({ users }),
        { id: "u-1", role: "PARTICIPANT" },
        body
      );

      expect(res.status, JSON.stringify(body)).toBe(200);
      const stored = await users.getById("u-1");
      expect(stored?.firstName).toBe(body.firstName);
      expect(stored?.lastName).toBe(body.lastName);
      expect(stored?.organization).toBe(body.organization);
    }

    // The four length boundaries, on every field. Off-by-one is the whole risk: a
    // wrong comparison would reject a legitimate 2-character name at the API even
    // though the form accepted it — the exact form/API disagreement that strands a
    // user mid-signup.
    const MIN = 2;
    const MAX = 25;

    it.each(["firstName", "lastName", "organization"] as const)(
      "%s: rejects 1 character (one below the minimum)",
      async (key) => {
        await expectRejected({ ...good, [key]: "a" }, key, /at least 2 characters/);
      }
    );

    it.each(["firstName", "lastName", "organization"] as const)(
      "%s: ACCEPTS exactly 2 characters",
      async (key) => {
        await expectAccepted({ ...good, [key]: "a".repeat(MIN) });
      }
    );

    it.each(["firstName", "lastName", "organization"] as const)(
      "%s: ACCEPTS exactly 25 characters",
      async (key) => {
        await expectAccepted({ ...good, [key]: "a".repeat(MAX) });
      }
    );

    it.each(["firstName", "lastName", "organization"] as const)(
      "%s: rejects 26 characters (one above the maximum)",
      async (key) => {
        await expectRejected(
          { ...good, [key]: "a".repeat(MAX + 1) },
          key,
          /25 characters or fewer/
        );
      }
    );

    it("measures the ceiling AFTER normalisation, so padding is not length", async () => {
      // 25 real characters wrapped in whitespace normalises to exactly 25 and must be
      // accepted. If the check ran on the raw string this would 400 and the user
      // would be told a value the form accepted is too long.
      await expectAccepted({
        ...good,
        firstName: "a".repeat(MAX),
        lastName: "b".repeat(MAX),
        organization: "c".repeat(MAX),
      });

      const users = new FakeUsers([profile({ id: "u-1" })]);
      const res = await patch(
        createIdentityRoutes({ users }),
        { id: "u-1", role: "PARTICIPANT" },
        { ...good, firstName: `   ${"a".repeat(MAX)}   ` }
      );
      expect(res.status).toBe(200);
      expect((await users.getById("u-1"))?.firstName).toBe("a".repeat(MAX));
    });

    it("rejects digits in a name but ACCEPTS them in the organisation", async () => {
      await expectRejected(
        { ...good, firstName: "Ada2" },
        "firstName",
        /can only contain letters/
      );
      await expectRejected(
        { ...good, lastName: "Lovelace1" },
        "lastName",
        /can only contain letters/
      );
      // The one asymmetry in the contract, asserted at the gate that enforces it.
      await expectAccepted({ ...good, organization: "Studio 54" });
      await expectAccepted({ ...good, organization: "3M" });
    });

    it("accepts real international names — an A-Z rule would lock these users out", async () => {
      // This is the assertion that matters most in this file. A regex narrowed to
      // [A-Za-z] would pass every other test here and refuse to let a large share of
      // real people save their own name.
      for (const [firstName, lastName] of [
        ["José", "García"],
        ["Anne-Marie", "O'Brien"],
        ["Jürgen", "Müller"],
        ["Ana María", "van der Berg"],
        ["Zoë", "St. John"],
        ["Иван", "Иванов"],
        ["田中", "太郎"],
        ["محمود", "عباس"],
      ] as const) {
        await expectAccepted({ firstName, lastName, organization: "Acme Ltd" });
      }
    });

    it("rejects special characters, including the injection-shaped ones", async () => {
      for (const value of [
        "Ada<script>",
        "Ada@example.com",
        "Ada;DROP TABLE",
        "Ada&Bob",
        "Ada_Bob",
        "Ada/Bob",
        "Ada|Bob",
      ]) {
        await expectRejected({ ...good, firstName: value }, "firstName", /./);
      }
    });

    it("rejects punctuation with no letter in it", async () => {
      await expectRejected(
        { ...good, lastName: "---" },
        "lastName",
        /at least one letter/
      );
      // Digits are allowed in an organisation, but digits alone are not a name.
      await expectRejected(
        { ...good, organization: "42" },
        "organization",
        /at least one letter/
      );
    });

    it("reports EVERY broken field at once, not just the first", async () => {
      // A form that fixes one error only to discover the next is three round trips
      // for one mistake.
      const users = new FakeUsers([profile({ id: "u-1" })]);
      const res = await patch(
        createIdentityRoutes({ users }),
        { id: "u-1", role: "PARTICIPANT" },
        { firstName: "a", lastName: "Bob9", organization: "x".repeat(26) }
      );

      expect(res.status).toBe(400);
      const payload = (await res.json()) as { fields: Record<string, string> };
      expect(Object.keys(payload.fields).sort()).toEqual([
        "firstName",
        "lastName",
        "organization",
      ]);
    });

    it("does not leak the submitted value back in the error message", async () => {
      // Error copy is for operators and users, not an echo chamber: reflecting the
      // input verbatim is how a 400 body becomes a reflection surface, and these
      // fields are PII.
      const users = new FakeUsers([profile({ id: "u-1" })]);
      const res = await patch(
        createIdentityRoutes({ users }),
        { id: "u-1", role: "PARTICIPANT" },
        { ...good, firstName: "Ada<script>alert(1)</script>" }
      );

      const raw = await res.text();
      expect(res.status).toBe(400);
      expect(raw).not.toContain("script");
      expect(raw).not.toContain("alert");
    });

    it("still reads an ALREADY-STORED invalid value as complete, so nobody is trapped", async () => {
      // The anti-lockout property, asserted at the API the portal's gate reads.
      //
      // This row was legal when written (1-character surname, 120-char org under the
      // old ceiling) and is not legal now. GET /me must still report
      // profileComplete=true — if it reported false, the portal would send the user
      // to the profile form, and PATCH would then refuse the stored value with no way
      // forward. Validation applies at the next WRITE, not retroactively to reads.
      const users = new FakeUsers([
        profile({
          id: "u-1",
          firstName: "Li",
          lastName: "S",
          organization: "Legacy Org 2 & Sons",
        }),
      ]);
      const res = await createIdentityRoutes({ users }).request("/v1/auth/me", {
        headers: asUser({ id: "u-1", role: "PARTICIPANT" }),
      });

      const body = (await res.json()) as { user: { profileComplete: boolean } };
      expect(res.status).toBe(200);
      expect(body.user.profileComplete).toBe(true);
    });
  });
});

// The Administration read surface. Unlike /v1/auth/me — where the subject is always
// the caller and the token IS the authorization — every route here reads someone
// else's account, so the role gate is the whole point of the group.
/**
 * ── ⚠ THE ADMIN SURFACE LEAVES A TRACE, IN BOTH DIRECTIONS ─────────────────────────
 *
 * This gate fronts the whole `/v1/admin` surface — including the bulk directory PII reads — and
 * recorded NOTHING. Two questions an incident responder could not answer from the platform's own
 * records: "which principal was refused which resource" (the 403s were invisible) and "who read the
 * user directory" (the successful reads wrote no entry at all, so a compromised staff account could
 * enumerate every account on the platform without leaving a mark).
 *
 * Logged on the GATE rather than in each handler, so a route added to this surface later is covered on
 * arrival — the same argument the gate itself makes for existing as middleware.
 */
describe("the /v1/admin surface is instrumented", () => {
  const admin = profile({
    id: "11111111-1111-4111-8111-111111111111",
    email: "admin@example.com",
    name: "An Admin",
    role: "ADMIN",
  });
  const participant = profile({
    id: "33333333-3333-4333-8333-333333333333",
    email: "p1@example.com",
    name: "Participant One",
    role: "PARTICIPANT",
  });

  function capture(method: "warn" | "log") {
    const lines: unknown[][] = [];
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    return lines;
  }

  afterEach(() => vi.restoreAllMocks());

  it("logs a REFUSED admin-surface request with the principal and the route", async () => {
    const warnings = capture("warn");
    const app = createIdentityRoutes({ users: new FakeUsers([admin, participant]) });

    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: participant.id, role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    const serialised = JSON.stringify(warnings);
    expect(serialised).toContain("refused an admin-surface request");
    expect(serialised).toContain(participant.id);
    expect(serialised).toContain("PARTICIPANT");
  });

  it("logs a SERVED privileged directory read — 'who read the user directory'", async () => {
    const logs = capture("log");
    const app = createIdentityRoutes({ users: new FakeUsers([admin, participant]) });

    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const serialised = JSON.stringify(logs);
    expect(serialised).toContain("privileged directory access");
    expect(serialised).toContain(admin.id);
  });

  it("⚠ keeps EMAIL ADDRESSES out of both lines", async () => {
    /**
     * The route being logged returns bulk PII, and the log must not become a second copy of it. Ids
     * and roles identify the ACTOR without republishing the directory — the same rule the notify
     * audit line follows ("keeps recipient ADDRESSES out of the logs").
     */
    const warnings = capture("warn");
    const logs = capture("log");
    const app = createIdentityRoutes({ users: new FakeUsers([admin, participant]) });

    await app.request("/v1/admin/users", { headers: asUser({ id: participant.id, role: "PARTICIPANT" }) });
    await app.request("/v1/admin/users", { headers: asUser({ id: admin.id, role: "ADMIN" }) });

    const serialised = JSON.stringify([...warnings, ...logs]);
    expect(serialised).not.toContain("admin@example.com");
    expect(serialised).not.toContain("p1@example.com");
  });
});

describe("GET /v1/admin/users", () => {
  const population = [
    profile({ id: "11111111-1111-4111-8111-111111111111", email: "admin@example.com", name: "An Admin", role: "ADMIN" }),
    profile({ id: "22222222-2222-4222-8222-222222222222", email: "facil@example.com", name: "A Facilitator", role: "FACILITATOR" }),
    profile({ id: "33333333-3333-4333-8333-333333333333", email: "p1@example.com", name: "Participant One", role: "PARTICIPANT" }),
  ];

  it("rejects an unauthenticated caller", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users");
    expect(res.status).toBe(401);
  });

  it("lets an ADMIN list every user", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).toEqual([
      "admin@example.com",
      "facil@example.com",
      "p1@example.com",
    ]);
  });

  // The visibility rule, and the reason it is enforced HERE rather than in the UI:
  // a facilitator must not learn that an admin account exists, so the row must never
  // be serialised at all. Filtering in the client would still ship the admin's name,
  // email and organisation to their browser.
  it("hides ADMIN rows from a FACILITATOR while still listing everyone else", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[1].id, role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { role: string; email: string }[] };
    expect(body.users.map((u) => u.role)).not.toContain("ADMIN");
    // Not an empty list — they still see themselves and their juniors, which is the
    // difference between this matrix and USER_ADMIN_GRANTS (a facilitator may not
    // ACT on a peer facilitator, but must still be able to SEE one).
    expect(body.users.map((u) => u.email)).toEqual([
      "facil@example.com",
      "p1@example.com",
    ]);
  });

  it("leaks nothing about a hidden ADMIN — not even a count or a spare cursor", async () => {
    // A pagination artefact is a side channel: if the admin row were filtered out of
    // an already-paged result, a facilitator asking for 3 rows would get 2 plus a
    // "next page" that proves a hidden row exists.
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users?limit=3", {
      headers: asUser({ id: population[1].id, role: "FACILITATOR" }),
    });

    const body = (await res.json()) as { users: unknown[]; nextCursor?: string };
    expect(body.users).toHaveLength(2);
    expect(body.nextCursor).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("admin@example.com");
  });

  // JUDGE and EXECUTIVE pass canAccessStaffScreens, so a gate built on "is staff"
  // would have let them enumerate every account on the platform.
  it("refuses JUDGE, EXECUTIVE and PARTICIPANT with 403", async () => {
    for (const role of ["JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      const app = createIdentityRoutes({ users: new FakeUsers(population) });
      const res = await app.request("/v1/admin/users", {
        headers: asUser({ id: "someone", role }),
      });
      expect(res.status, role).toBe(403);
    }
  });

  it("fails closed on a role it does not recognise", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: "someone", role: "SUPERUSER" }),
    });
    expect(res.status).toBe(403);
  });

  it("marks the caller's OWN row isSelf, so the UI can refuse a self-action before the click", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: { id: string; isSelf: boolean }[] };
    expect(body.users.find((u) => u.id === population[0].id)?.isSelf).toBe(true);
    expect(body.users.find((u) => u.id === population[2].id)?.isSelf).toBe(false);
  });

  // The post-confirmation trigger writes `id = sub || ulid()`, so a row can exist
  // with no Cognito account behind it. One such row is in the dev table today. It
  // must be flagged, not offered a Revoke button that can only ever fail.
  it("flags a row with a non-sub id as having no account", async () => {
    const ghost = profile({
      id: "01KYSCCAN9WWW9645AXBM45AH2", // a ULID, not a Cognito sub
      email: "nobody-probe@example.com",
      name: "Ghost Row",
    });
    const app = createIdentityRoutes({ users: new FakeUsers([population[0], ghost]) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: { id: string; hasAccount: boolean }[] };
    expect(body.users.find((u) => u.id === ghost.id)?.hasAccount).toBe(false);
    expect(body.users.find((u) => u.id === population[0].id)?.hasAccount).toBe(true);
  });

  /**
   * THE ACCESS BADGE. `status` is what lets the Administration screen render "Access
   * disabled" — and the whole reason the field is mirrored onto this table at all is that
   * this service has no Cognito client and no Cognito IAM, so without a copy the screen
   * could not show who is disabled or offer a way to reverse it.
   *
   * NOT AN AUTHORIZATION INPUT. Nothing in this service reads it to decide access, so a
   * wrong value here is a wrong badge and not a wrong permission — in BOTH directions.
   * That property is what makes a best-effort mirror acceptable, and it is asserted below
   * by the row still being listed and actionable while DEACTIVATED.
   */
  it("reports DEACTIVATED for a disabled account, so the row can render the badge", async () => {
    const disabled = profile({
      id: "44444444-4444-4444-8444-444444444444",
      email: "gone@example.com",
      status: "DEACTIVATED",
    });
    const app = createIdentityRoutes({ users: new FakeUsers([population[0], disabled]) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: { id: string; status: string }[] };
    expect(body.users.find((u) => u.id === disabled.id)?.status).toBe("DEACTIVATED");
  });

  it("normalises an ABSENT status to ACTIVE, so no legacy row renders as disabled", async () => {
    // THE CRITICAL CASE, and the reason this projection always carries the field while the
    // stored row may not. Every row written before `status` existed has no attribute; a
    // client left to interpret `undefined` gets it wrong once and then shows every
    // pre-existing account as disabled. The stored asymmetry stops at this boundary.
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: { status: string }[] };
    expect(body.users.map((u) => u.status)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
  });

  it("reads an UNRECOGNISED stored status as ACTIVE, failing OPEN on garbage", async () => {
    // Deliberate, and the cost is stated on isUserDeactivated: a typo'd or
    // partially-written attribute must not badge an account nobody deliberately disabled.
    // The blast radius of the opposite choice is every user on the platform.
    const odd = profile({
      id: "55555555-5555-4555-8555-555555555555",
      email: "odd@example.com",
      // Cast because the stored shape is UserStatus; the point of the test is that a row
      // carrying something else — hand-edited, half-written — does not read as disabled.
      status: "deactivated" as never,
    });
    const app = createIdentityRoutes({ users: new FakeUsers([odd]) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: { status: string }[] };
    expect(body.users[0].status).toBe("ACTIVE");
  });

  it("STILL LISTS a deactivated account — the badge is not a filter", async () => {
    // An administrator has to be able to find a disabled person to RE-ENABLE them. Hiding
    // the row would make the disable irreversible from the product, which is the same
    // failure the last-admin guard exists to prevent, arrived at from the other side.
    const disabled = profile({
      id: "66666666-6666-4666-8666-666666666666",
      email: "paused@example.com",
      status: "DEACTIVATED",
    });
    const app = createIdentityRoutes({ users: new FakeUsers([disabled]) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: { id: string; hasAccount: boolean }[] };
    expect(body.users).toHaveLength(1);
    // And still actionable: hasAccount is about whether a Cognito account exists, which a
    // disabled account still does.
    expect(body.users[0].hasAccount).toBe(true);
  });

  it("does NOT leak profileComplete — that is a self-service concern, not an admin one", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { users: Record<string, unknown>[] };
    for (const user of body.users) {
      expect(user).not.toHaveProperty("profileComplete");
    }
  });

  it("pages with limit and returns a cursor for the next page", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const first = (await (
      await app.request("/v1/admin/users?limit=2", {
        headers: asUser({ id: population[0].id, role: "ADMIN" }),
      })
    ).json()) as { users: { email: string }[]; nextCursor?: string };

    expect(first.users).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = (await (
      await app.request(`/v1/admin/users?limit=2&cursor=${first.nextCursor}`, {
        headers: asUser({ id: population[0].id, role: "ADMIN" }),
      })
    ).json()) as { users: { email: string }[]; nextCursor?: string };

    expect(second.users.map((u) => u.email)).toEqual(["p1@example.com"]);
    // Absent on the last page, which is how the client knows to stop.
    expect(second.nextCursor).toBeUndefined();
  });

  it("ignores a non-numeric limit rather than 400ing", async () => {
    // It arrives from a URL; the repository clamps whatever it gets, so there is no
    // unbounded read to defend against and an error page would be the worse answer.
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users?limit=all", {
      headers: asUser({ id: population[0].id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toHaveLength(3);
  });

  it("still serves the self-service routes — adding /v1/admin did not shadow /v1/auth", async () => {
    // Both routers are mounted on one root, so a mistake there would 404 /me.
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/auth/me", {
      headers: asUser({ id: population[2].id, role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
  });
});

// The ?ids= branch backs the team and workshop filters: "who is in team X" is only
// answerable in the Team context, so the BFF resolves member ids there and hydrates
// the profiles here. That makes it the branch where ids arrive STRAIGHT FROM THE
// REQUEST — the one an attacker reaches for, and the one whose visibility check is
// load-bearing rather than belt-and-braces.
describe("GET /v1/admin/users?ids= (filtered hydration)", () => {
  const admin = profile({
    id: "11111111-1111-4111-8111-111111111111",
    email: "admin@example.com",
    name: "An Admin",
    role: "ADMIN",
  });
  const facilitator = profile({
    id: "22222222-2222-4222-8222-222222222222",
    email: "facil@example.com",
    name: "A Facilitator",
    role: "FACILITATOR",
  });
  const participant = profile({
    id: "33333333-3333-4333-8333-333333333333",
    email: "p1@example.com",
    name: "Participant One",
    role: "PARTICIPANT",
  });
  const population = [admin, facilitator, participant];

  it("hydrates exactly the ids asked for, in no particular order", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/users?ids=${participant.id},${admin.id}`, {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email).sort()).toEqual([
      "admin@example.com",
      "p1@example.com",
    ]);
  });

  // THE test for this branch. A facilitator who has learned an admin's id by any
  // means — a guess, a log line, an invitation row — must not be able to read the row
  // back by naming it. The unfiltered path is protected in the store; this path is
  // protected only by the route, so it needs its own tripwire.
  it("returns ZERO rows to a FACILITATOR who names an ADMIN's id explicitly", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/users?ids=${admin.id}`, {
      headers: asUser({ id: facilitator.id, role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
    // Not a 403 or a 404 either — the answer to "does this account exist" must be
    // indistinguishable from the answer for an id that never existed.
    expect(JSON.stringify(body)).not.toContain("admin@example.com");
  });

  it("drops only the hidden ids from a MIXED request, keeping the rest", async () => {
    // The realistic shape: a team contains an admin and a participant, and the
    // facilitator filtering by that team should see the participant and never learn
    // the other member exists.
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(
      `/v1/admin/users?ids=${admin.id},${participant.id}`,
      { headers: asUser({ id: facilitator.id, role: "FACILITATOR" }) }
    );

    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).toEqual(["p1@example.com"]);
  });

  // An empty ids list is a legitimate answer — "the filter matched nobody" — and must
  // NOT fall through to listing everyone. Getting this wrong turns an empty team into
  // a full directory.
  it("returns nothing for an explicitly EMPTY ids list, not everything", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/users?ids=", {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
  });

  it("carries no cursor — the filtered result is one complete page", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/users?ids=${participant.id}`, {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    const body = (await res.json()) as { nextCursor?: string };
    expect(body.nextCursor).toBeUndefined();
  });

  it("ignores ids that do not exist rather than erroring", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(
      `/v1/admin/users?ids=${participant.id},99999999-9999-4999-8999-999999999999`,
      { headers: asUser({ id: admin.id, role: "ADMIN" }) }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).toEqual(["p1@example.com"]);
  });

  // REJECTED, not truncated. Silently dropping ids past the cap would render a
  // filtered list quietly missing people, and an administrator would conclude someone
  // is not on a team when they are.
  it("rejects more than 100 ids with a 400 instead of silently truncating", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const many = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(",");
    const res = await app.request(`/v1/admin/users?ids=${many}`, {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(400);
  });

  it("still applies the role gate — a PARTICIPANT cannot hydrate ids either", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/users?ids=${admin.id}`, {
      headers: asUser({ id: participant.id, role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
  });
});

// The "Invited by" column's second half. An invitation stores `invitedBy` as a bare
// Cognito sub and only this service can turn one into a name.
describe("GET /v1/admin/user-names", () => {
  const admin = profile({
    id: "11111111-1111-4111-8111-111111111111",
    email: "admin@example.com",
    name: "An Admin",
    role: "ADMIN",
  });
  const facilitator = profile({
    id: "22222222-2222-4222-8222-222222222222",
    email: "facil@example.com",
    name: "A Facilitator",
    role: "FACILITATOR",
  });
  const population = [admin, facilitator];

  it("resolves subs to display names for an ADMIN", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/user-names?ids=${facilitator.id}`, {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      names: { [facilitator.id]: { name: "A Facilitator" } },
    });
  });

  // The leak this endpoint exists to close. Every invitation in the dev table today
  // was sent by the platform's only ADMIN to PARTICIPANTs a facilitator MAY see — so
  // resolving the inviter's name unconditionally would print that admin's name on
  // rows a facilitator is looking at, handing over exactly the reconnaissance the row
  // filter was added to prevent.
  it("reports a hidden ADMIN inviter as hidden, with no name and no email", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/user-names?ids=${admin.id}`, {
      headers: asUser({ id: facilitator.id, role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // `hidden: true` rather than an omitted entry, so the client can say "Not shown"
    // instead of leaving a blank that reads as a data problem.
    expect(body).toEqual({ names: { [admin.id]: { hidden: true } } });
    expect(JSON.stringify(body)).not.toContain("admin@example.com");
    expect(JSON.stringify(body)).not.toContain("An Admin");
  });

  it("falls back to the email when a row has no display name yet", async () => {
    // A profile row written by the post-confirmation trigger before the user
    // completed their profile has an empty `name`. An empty string in the column is
    // worse than the email.
    const nameless = profile({
      id: "44444444-4444-4444-8444-444444444444",
      email: "nameless@example.com",
      name: "",
      role: "PARTICIPANT",
    });
    const app = createIdentityRoutes({ users: new FakeUsers([admin, nameless]) });
    const res = await app.request(`/v1/admin/user-names?ids=${nameless.id}`, {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(await res.json()).toEqual({
      names: { [nameless.id]: { name: "nameless@example.com" } },
    });
  });

  it("omits ids with no row — an inviter's account may have been deleted since", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(
      `/v1/admin/user-names?ids=99999999-9999-4999-8999-999999999999`,
      { headers: asUser({ id: admin.id, role: "ADMIN" }) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names: {} });
  });

  it("answers an empty ids list with an empty map", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request("/v1/admin/user-names?ids=", {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names: {} });
  });

  it("rejects more than 100 ids with a 400", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const many = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(",");
    const res = await app.request(`/v1/admin/user-names?ids=${many}`, {
      headers: asUser({ id: admin.id, role: "ADMIN" }),
    });

    expect(res.status).toBe(400);
  });

  it("inherits the admin router's role gate", async () => {
    const app = createIdentityRoutes({ users: new FakeUsers(population) });
    const res = await app.request(`/v1/admin/user-names?ids=${admin.id}`, {
      headers: asUser({ id: "someone", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
  });
});
