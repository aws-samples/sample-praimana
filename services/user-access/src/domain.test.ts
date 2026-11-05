import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  AUDIT_REASON_MAX,
  MAX_USERNAME_LENGTH,
  PASSWORD_POLICY,
  ROLE_PRECEDENCE,
  TEMP_PASSWORD_LENGTH,
  generateTemporaryPassword,
  canAdministerUser,
  canGrantRole,
  canManageUsers,
  isAcceptedInvitation,
  isExpired,
  isRevokedInvitation,
  liveInvitationKeys,
  meetsPasswordPolicy,
  normalizeAuditReason,
  roleFromGroups,
  resolveRoleFromInvitations,
  usernameRejectionReason,
  type RandomBytes,
} from "./domain.js";

/**
 * The temporary password generator is the one piece of this change whose failure is
 * both silent and total: a password that misses the pool policy makes EVERY
 * AdminCreateUser fail with InvalidPasswordException, and a password that is
 * predictable hands out accounts. Neither shows up in a smoke test of one invite.
 *
 * So the suite below does three distinct jobs, and they are not interchangeable:
 *   1. pins the policy CONSTANTS against the template's PasswordPolicy;
 *   2. asserts the policy holds over MANY draws, not one (a generator that satisfies
 *      it 99% of the time passes a single-sample test);
 *   3. asserts the properties a "looks random" eyeball check misses — the guaranteed
 *      characters are shuffled, and the output is not a function of position.
 */

const realRandom: RandomBytes = (size) => new Uint8Array(randomBytes(size));

describe("PASSWORD_POLICY", () => {
  it("matches the pool policy declared in the infrastructure CloudFormation template", () => {
    // If this fails, either the template changed or this constant did, and every
    // provisioning call is about to be rejected by Cognito. The numbers are asserted
    // literally on purpose: reading them from the template is not possible here, so
    // this test IS the link between the two files.
    expect(PASSWORD_POLICY).toEqual({
      minimumLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: true,
    });
  });

  it("generates comfortably longer than the minimum, since the value travels in email", () => {
    expect(TEMP_PASSWORD_LENGTH).toBeGreaterThan(PASSWORD_POLICY.minimumLength);
  });
});

describe("generateTemporaryPassword", () => {
  // 500 draws: enough that a class missed even 1-in-100 times fails reliably, and
  // fast enough (~ms) to run on every commit.
  const DRAWS = 500;

  it("satisfies the pool policy on EVERY draw, not just typically", () => {
    for (let i = 0; i < DRAWS; i++) {
      const password = generateTemporaryPassword(realRandom);
      expect(meetsPasswordPolicy(password), password.length.toString()).toBe(true);
    }
  });

  it("contains all four required character classes explicitly", () => {
    // meetsPasswordPolicy is the same logic, so assert the classes directly too —
    // otherwise a bug shared by both would pass unnoticed.
    for (let i = 0; i < DRAWS; i++) {
      const p = generateTemporaryPassword(realRandom);
      expect(/[A-Z]/.test(p), p).toBe(true);
      expect(/[a-z]/.test(p), p).toBe(true);
      expect(/[0-9]/.test(p), p).toBe(true);
      expect(/[^A-Za-z0-9]/.test(p), p).toBe(true);
    }
  });

  it("is exactly the requested length", () => {
    expect(generateTemporaryPassword(realRandom).length).toBe(TEMP_PASSWORD_LENGTH);
    expect(generateTemporaryPassword(realRandom, 16).length).toBe(16);
  });

  it("never returns the same password twice", () => {
    // Not a proof of entropy, but it catches the catastrophic regressions: a seeded
    // generator, a cached value, or a constant.
    const seen = new Set<string>();
    for (let i = 0; i < DRAWS; i++) seen.add(generateTemporaryPassword(realRandom));
    expect(seen.size).toBe(DRAWS);
  });

  it("SHUFFLES the guaranteed characters instead of leaving them in positions 0-3", () => {
    // The construction takes one character per required class first. Without the
    // shuffle, position 0 would ALWAYS be uppercase and position 3 always a symbol —
    // which narrows the effective search space and is invisible to a policy check.
    let uppercaseFirst = 0;
    let symbolFourth = 0;
    for (let i = 0; i < DRAWS; i++) {
      const p = generateTemporaryPassword(realRandom);
      if (/[A-Z]/.test(p[0])) uppercaseFirst++;
      if (/[^A-Za-z0-9]/.test(p[3])) symbolFourth++;
    }
    // Both would be exactly DRAWS if the shuffle were missing. A generous bound
    // (80%) keeps this from flaking while still failing loudly on no shuffle at all.
    expect(uppercaseFirst).toBeLessThan(DRAWS * 0.8);
    expect(symbolFourth).toBeLessThan(DRAWS * 0.8);
  });

  it("excludes the ambiguous glyphs a recipient would mis-transcribe", () => {
    // O/0 and l/I/1 in a password the user must copy from an email produce
    // NotAuthorizedException, which the UI reports as "Incorrect email or password"
    // for enumeration reasons — an unfalsifiable dead end.
    for (let i = 0; i < DRAWS; i++) {
      expect(generateTemporaryPassword(realRandom)).not.toMatch(/[O0lI1]/);
    }
  });

  it("refuses a length below the pool minimum rather than emitting a doomed password", () => {
    // A caller asking for 8 characters is a bug. Failing here beats one
    // InvalidPasswordException per invite with no clue as to why.
    expect(() =>
      generateTemporaryPassword(realRandom, PASSWORD_POLICY.minimumLength - 1)
    ).toThrow(/at least/);
  });

  it("does not silently produce a biased password when the entropy source misbehaves", () => {
    // A source stuck at 0xff yields no byte below the rejection limit, so sampling
    // must give up loudly. Silently falling back to `byte % max` (or looping forever)
    // are the two ways this is normally got wrong.
    const stuck: RandomBytes = (size) => new Uint8Array(size).fill(0xff);
    expect(() => generateTemporaryPassword(stuck)).toThrow(/entropy source/);
  });

  it("draws UNBIASED indices — no character class is starved or over-represented", () => {
    // With a `byte % max` implementation and a 76-character alphabet, the first 52
    // characters of the alphabet would appear ~1.33x as often as the rest. Over
    // enough draws that skew is measurable, and this test is what would catch a
    // "simplification" back to modulo.
    const counts = new Map<string, number>();
    const SAMPLES = 4000;
    for (let i = 0; i < SAMPLES; i++) {
      for (const ch of generateTemporaryPassword(realRandom)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const expected = (SAMPLES * TEMP_PASSWORD_LENGTH) / counts.size;
    // Every character within 40% of the uniform expectation. A 1.33x modulo bias
    // shows as a >30% split between the two halves of the alphabet, so this bound
    // catches it while tolerating ordinary sampling noise at this sample size.
    for (const [ch, n] of counts) {
      expect(n, `${ch} appeared ${n} times, expected ~${expected.toFixed(0)}`)
        .toBeGreaterThan(expected * 0.6);
      expect(n, `${ch} appeared ${n} times, expected ~${expected.toFixed(0)}`)
        .toBeLessThan(expected * 1.4);
    }
  });
});

describe("meetsPasswordPolicy", () => {
  it("rejects a password missing each required class in turn", () => {
    // Each of these is otherwise long enough — the missing class is the only fault.
    expect(meetsPasswordPolicy("abcdefghijk2!")).toBe(false); // no uppercase
    expect(meetsPasswordPolicy("ABCDEFGHIJK2!")).toBe(false); // no lowercase
    expect(meetsPasswordPolicy("ABCdefghijk!!")).toBe(false); // no digit
    expect(meetsPasswordPolicy("ABCdefghijk22")).toBe(false); // no symbol
  });

  it("enforces the minimum length at the boundary, both sides", () => {
    const short = "Ab3!" + "c".repeat(PASSWORD_POLICY.minimumLength - 5);
    const atMin = "Ab3!" + "c".repeat(PASSWORD_POLICY.minimumLength - 4);
    expect([...short].length).toBe(PASSWORD_POLICY.minimumLength - 1);
    expect([...atMin].length).toBe(PASSWORD_POLICY.minimumLength);
    expect(meetsPasswordPolicy(short)).toBe(false);
    expect(meetsPasswordPolicy(atMin)).toBe(true);
  });

  it("measures length in CODE POINTS, so an astral character counts once", () => {
    // `.length` would count a surrogate pair as 2 and call an 11-character password
    // long enough. Same reasoning as the profile validator's character counting.
    const withAstral = "Ab3!" + "\u{1F600}".repeat(8); // 12 code points, 20 code units
    expect(withAstral.length).toBeGreaterThan(PASSWORD_POLICY.minimumLength);
    expect([...withAstral].length).toBe(12);
    expect(meetsPasswordPolicy(withAstral)).toBe(true);
    const tooShort = "Ab3!" + "\u{1F600}".repeat(7); // 11 code points
    expect(tooShort.length).toBeGreaterThan(PASSWORD_POLICY.minimumLength);
    expect(meetsPasswordPolicy(tooShort)).toBe(false);
  });
});

describe("usernameRejectionReason", () => {
  it("accepts an ordinary address", () => {
    expect(usernameRejectionReason("someone@example.com")).toBeNull();
  });

  it("accepts the plus-addressed form the platform's own test accounts use", () => {
    // user+judge-1@example.com must not be refused — several real invitations use
    // exactly this shape.
    expect(usernameRejectionReason("user+judge-1@example.com")).toBeNull();
  });

  it("rejects an empty address", () => {
    expect(usernameRejectionReason("")).toMatch(/required/);
  });

  it("enforces the 128-character pool limit on BOTH sides of the boundary", () => {
    // Cognito answers InvalidParameterException past this, which without the check
    // would surface as a 500 on a route the operator believes succeeded.
    const domain = "@example.com";
    const atLimit =
      "a".repeat(MAX_USERNAME_LENGTH - domain.length) + domain;
    expect([...atLimit].length).toBe(MAX_USERNAME_LENGTH);
    expect(usernameRejectionReason(atLimit)).toBeNull();
    expect(usernameRejectionReason("a" + atLimit)).toMatch(/128 characters or fewer/);
  });

  it("counts the length in CODE POINTS, not UTF-16 code units", () => {
    // An address of astral characters would be over the limit by `.length` and under
    // it by the count Cognito applies — refusing it would reject an address the pool
    // accepts.
    const astral = "\u{1F600}".repeat(60) + "@example.com";
    expect(astral.length).toBeGreaterThan(MAX_USERNAME_LENGTH);
    expect([...astral].length).toBeLessThan(MAX_USERNAME_LENGTH);
    expect(usernameRejectionReason(astral)).toBeNull();
  });

  it("rejects whitespace and control characters the pool refuses", () => {
    // Written as \u ESCAPES, not literal control characters: a literal NUL or DEL in
    // a source file is invisible in review and is silently dropped by some editors and
    // copy-paste paths, which would leave this asserting nothing.
    const rejected = [
      "some one@example.com", // space
      "someone@example.com\n", // newline
      "\tsomeone@example.com", // tab
      "someone\u0000@example.com", // NUL
      "someone@example.com\u007f", // DEL
      "someone\u001b@example.com", // ESC
      "someone\u0085@example.com", // NEL, in the C1 block \s does not cover
      "someone\u00a0@example.com", // NBSP — whitespace \s DOES cover
    ];
    for (const bad of rejected) {
      expect(usernameRejectionReason(bad), JSON.stringify(bad)).toMatch(
        /spaces or control characters/
      );
    }
  });

  it("rejects a value with no @ at all", () => {
    expect(usernameRejectionReason("notanemail")).toMatch(/must contain @/);
  });
});

describe("resolveRoleFromInvitations", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const future = "2026-08-02T12:00:00.000Z";
  const past = "2026-07-31T12:00:00.000Z";

  it("returns NULL when there is no invitation at all", () => {
    // Distinct from the post-confirmation trigger's PARTICIPANT fallback, and the
    // difference is the point: that trigger runs on an already-confirmed user and
    // must not refuse, while this runs BEFORE an account exists, where "no
    // invitation" means "do not create one".
    expect(resolveRoleFromInvitations([], now)).toBeNull();
  });

  it("returns NULL when every invitation has expired", () => {
    expect(
      resolveRoleFromInvitations(
        [{ platformRole: "ADMIN", expiresAt: past }],
        now
      )
    ).toBeNull();
  });

  it("collapses several invitations to the HIGHEST-privilege live role", () => {
    // Otherwise the group assignment would depend on invitation ordering.
    expect(
      resolveRoleFromInvitations(
        [
          { platformRole: "PARTICIPANT", expiresAt: future },
          { platformRole: "FACILITATOR", expiresAt: future },
          { platformRole: "JUDGE", expiresAt: future },
        ],
        now
      )
    ).toBe("FACILITATOR");
  });

  it("IGNORES an expired high-privilege invitation in favour of a live lower one", () => {
    // The security-relevant direction: a lapsed ADMIN invite must not still mint an
    // admin because a live PARTICIPANT one exists alongside it.
    expect(
      resolveRoleFromInvitations(
        [
          { platformRole: "ADMIN", expiresAt: past },
          { platformRole: "PARTICIPANT", expiresAt: future },
        ],
        now
      )
    ).toBe("PARTICIPANT");
  });

  it("defaults a row with no platformRole to PARTICIPANT (least privilege)", () => {
    expect(
      resolveRoleFromInvitations([{ expiresAt: future }], now)
    ).toBe("PARTICIPANT");
  });

  it("degrades an UNRECOGNISED role to PARTICIPANT rather than passing it through", () => {
    // A corrupted or future role name must never reach AdminAddUserToGroup — there is
    // no such group, so the call would fail and leave a role-less account.
    expect(
      resolveRoleFromInvitations(
        [{ platformRole: "SUPERUSER", expiresAt: future }],
        now
      )
    ).toBe("PARTICIPANT");
  });

  it("treats a row with NO expiresAt as still valid (legacy rows stay redeemable)", () => {
    expect(resolveRoleFromInvitations([{ platformRole: "JUDGE" }], now)).toBe(
      "JUDGE"
    );
  });

  it("IGNORES a REVOKED invitation — a withdrawn grant decides no role", () => {
    // The Team service flips a removed member's invitation to REVOKED rather than deleting
    // it, so this row shape genuinely reaches here. Filtering on expiry alone would let a
    // grant that has been TAKEN AWAY decide which role a newly-provisioned account gets, and
    // it would vote with whatever privilege it carried.
    expect(
      resolveRoleFromInvitations(
        [{ platformRole: "FACILITATOR", status: "REVOKED", expiresAt: future }],
        now
      )
    ).toBeNull();
  });

  it("prefers a live LOWER role over a REVOKED higher one", () => {
    // The security-relevant direction, exactly as for the expired case above: a withdrawn
    // FACILITATOR grant must not still mint a facilitator because a live PARTICIPANT
    // invitation exists alongside it.
    expect(
      resolveRoleFromInvitations(
        [
          { platformRole: "FACILITATOR", status: "REVOKED", expiresAt: future },
          { platformRole: "PARTICIPANT", status: "PENDING", expiresAt: future },
        ],
        now
      )
    ).toBe("PARTICIPANT");
  });

  it("still resolves an ACCEPTED row — that is an existing user's live role", () => {
    // ONLY revoked is excluded. A row is ACCEPTED the moment its holder signs in, and this is
    // the lookup that says what role they hold — so excluding ACCEPTED would make every
    // existing user's role unresolvable. The pre-signup trigger applies the stricter rule for
    // NEW registrations; this answers a different question.
    expect(
      resolveRoleFromInvitations(
        [{ platformRole: "JUDGE", status: "ACCEPTED", expiresAt: future }],
        now
      )
    ).toBe("JUDGE");
  });

  it("uses the same precedence order as the Cognito group Precedence values", () => {
    // Four copies of this contract exist (see domain.ts). This asserts THIS one, and
    // its order is what the template's Precedence 0..4 encodes.
    expect([...ROLE_PRECEDENCE]).toEqual([
      "ADMIN",
      "FACILITATOR",
      "JUDGE",
      "EXECUTIVE",
      "PARTICIPANT",
    ]);
  });
});

describe("isExpired", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  it("treats a MISSING expiry as not expired, so legacy rows stay valid", () => {
    expect(isExpired(undefined, now)).toBe(false);
  });

  it("treats an UNPARSEABLE expiry as expired — corruption fails closed", () => {
    expect(isExpired("not-a-date", now)).toBe(true);
  });

  it("is expired exactly AT the boundary, not just after it", () => {
    expect(isExpired("2026-08-01T12:00:00.000Z", now)).toBe(true);
    expect(isExpired("2026-08-01T12:00:00.001Z", now)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The GRANT matrix — may this role hand out THIS role, i.e. cause an account
// for it to be created?
// ════════════════════════════════════════════════════════════════════════════

/**
 * WHY THIS TABLE EXISTS IN THIS SERVICE, AND WHY IT IS A THIRD ONE.
 *
 * `ROLE_GRANTS` in domain.ts is a deliberate LOCAL COPY of the table in
 * the shared constants/roles module (the Team service keeps a third), because this
 * is a bundled Lambda with no dependency on that package. It was added to close a
 * confirmed HIGH escalation: POST /provision resolved the invitee's role from the
 * invitation row and never compared it against the CALLER's grant authority, so a JUDGE
 * — who may grant nothing — could provision an ADMIN account for a guessed address and
 * receive its live temporary password in the response.
 *
 * The route tests exercise the matrix THROUGH the HTTP surface, which is what proves the
 * gate is wired and that no credential is minted on a refusal. These test the predicate
 * DIRECTLY, which is what makes an omission visible: the cells are enumerated
 * exhaustively, so a role added to one copy and not the other fails here rather than in
 * production.
 */
describe("canGrantRole — the full matrix, cell by cell", () => {
  const ROLES = ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"];

  /**
   * The EXPECTED table, restated independently of the implementation — deriving it from
   * ROLE_GRANTS would make this tautological. This is the contract as
   * the shared constants/roles module documents it.
   */
  const EXPECTED: Record<string, readonly string[]> = {
    ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
    // A peer FACILITATOR is allowed — the invitee has NO ACCOUNT YET, so staffing a
    // workshop with a second facilitator takes nothing from anyone. An ADMIN is not: a
    // facilitator must not be able to manufacture full platform access.
    FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
    // A sponsor may bring in their own builders, not fellow observers.
    EXECUTIVE: ["PARTICIPANT"],
    // NOTHING. This is the cell the escalation lived in.
    JUDGE: [],
    PARTICIPANT: [],
  };

  it("covers every inviter role, so a new role cannot be added without a decision here", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
  });

  for (const inviter of ROLES) {
    for (const target of ROLES) {
      const allowed = EXPECTED[inviter].includes(target);
      it(`${inviter} → ${target} is ${allowed ? "ALLOWED" : "REFUSED"}`, () => {
        expect(canGrantRole(inviter, target)).toBe(allowed);
      });
    }
  }

  it("differs from the ADMINISTER matrix in exactly the peer-facilitator cell", () => {
    // Stated as an assertion because it is the whole reason these are two tables and not
    // one. Granting a peer is forward-looking and harmless; acting on an existing peer
    // account is a lateral attack.
    expect(canGrantRole("FACILITATOR", "FACILITATOR")).toBe(true);
    expect(canAdministerUser("FACILITATOR", "FACILITATOR")).toBe(false);
    // And the other direction: an EXECUTIVE may create a participant but may never touch
    // an existing one.
    expect(canGrantRole("EXECUTIVE", "PARTICIPANT")).toBe(true);
    expect(canAdministerUser("EXECUTIVE", "PARTICIPANT")).toBe(false);
  });

  it("is WIDER than nothing but NARROWER than PROVISIONER_ROLES for JUDGE", () => {
    // The floor in routes.ts admits a JUDGE onto the surface; this predicate is what
    // refuses them every role. If these two ever agree again, the escalation is back.
    for (const target of ROLES) {
      expect(canGrantRole("JUDGE", target), target).toBe(false);
    }
  });

  it("FAILS CLOSED on an absent or unrecognised role on EITHER side", () => {
    // The TARGET half is the one that is easy to forget, and it matters as much: the
    // target role comes from a STORED ROW, so a row carrying a role nobody decided about
    // must refuse rather than fall through.
    for (const bad of [null, undefined, "", "  ", "SUPERUSER", "admin", "Admin"]) {
      expect(canGrantRole(bad, "PARTICIPANT"), `inviter=${bad}`).toBe(false);
      expect(canGrantRole("ADMIN", bad), `target=${bad}`).toBe(false);
    }
  });

  it("is CASE-SENSITIVE, matching the Cognito group names exactly", () => {
    expect(canGrantRole("Admin", "PARTICIPANT")).toBe(false);
    expect(canGrantRole("ADMIN", "participant")).toBe(false);
  });

  it("cannot be widened by a prototype-chain key", () => {
    // The inviter role comes from a token claim, i.e. from outside, and the table is a
    // plain object literal — a bare index would find an inherited function.
    // `"constructor"` is truthy, so a `!grantable` guard would pass it through and
    // `.includes` would throw: a 500 where a 403 belongs. `Object.hasOwn` is what stops
    // that, and this is the assertion that keeps it there.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(canGrantRole(key, "PARTICIPANT"), key).toBe(false);
      expect(canGrantRole("ADMIN", key), key).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The account-administration matrix, and the invitation-revocation predicates
// ════════════════════════════════════════════════════════════════════════════

/**
 * WHY THE MATRIX IS ASSERTED HERE AS WELL AS AT THE ROUTE.
 *
 * `USER_ADMIN_GRANTS` in domain.ts is a deliberate LOCAL COPY of the table in
 * the shared constants/roles module, because this is a bundled Lambda with no
 * dependency on that package. The two copies must agree, and a drift that ADDS a
 * permission is invisible until it is exploited — nothing fails when they disagree, the
 * screen simply offers something the service allows, or refuses something it offers.
 *
 * The route tests exercise the matrix THROUGH the HTTP surface, which is what proves the
 * gate is wired. These test the predicate DIRECTLY, which is what makes an omission
 * visible: the cells are enumerated exhaustively over the cross product, so a role added
 * to one copy and not the other fails here rather than in production.
 */
describe("canAdministerUser — the full matrix, cell by cell", () => {
  const ROLES = ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"];

  /**
   * The EXPECTED table, restated independently of the implementation.
   *
   * Written out rather than derived from USER_ADMIN_GRANTS, which would make this test
   * tautological — it would pass whatever the table said. This is the contract as
   * the shared constants/roles module documents it.
   */
  const EXPECTED: Record<string, readonly string[]> = {
    // Peers included: the top of the tree has to be able to revoke a compromised or
    // departed admin. The self-action and last-admin guards make that safe, and both
    // live at the route because the predicate cannot see the state they need.
    ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
    // STRICTLY LOWER only. Not an ADMIN, and NOT another FACILITATOR — acting on a peer
    // is a lateral attack: one facilitator could disable another mid-workshop, or take
    // over their workshops.
    FACILITATOR: ["JUDGE", "EXECUTIVE", "PARTICIPANT"],
    // Nobody. An empty list is the closed case, so "no entry" and "empty entry" must
    // behave identically.
    JUDGE: [],
    EXECUTIVE: [],
    PARTICIPANT: [],
  };

  it("covers every actor role, so a new role cannot be added without a decision here", () => {
    // If a sixth role appears, this fails and forces the two tables plus this expectation
    // to be updated together rather than one of the three being missed.
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
  });

  for (const actor of ROLES) {
    for (const target of ROLES) {
      const allowed = EXPECTED[actor].includes(target);
      it(`${actor} → ${target} is ${allowed ? "ALLOWED" : "REFUSED"}`, () => {
        expect(canAdministerUser(actor, target)).toBe(allowed);
      });
    }
  }

  it("differs from the INVITE matrix in the two places that matter", () => {
    // Stated as an assertion because it is the whole reason this is a separate table.
    // ROLE_GRANTS lets a FACILITATOR grant FACILITATOR (staffing a workshop with a peer
    // takes nothing from anyone) and lets an EXECUTIVE grant PARTICIPANT. Neither may
    // touch an EXISTING account of that role.
    expect(canAdministerUser("FACILITATOR", "FACILITATOR")).toBe(false);
    expect(canAdministerUser("EXECUTIVE", "PARTICIPANT")).toBe(false);
  });

  it("FAILS CLOSED on an absent or unrecognised role on EITHER side", () => {
    // Both halves, because the target half is the one that is easy to forget. An unknown
    // TARGET matters as much as an unknown actor: if a new, more privileged role ships
    // and this table is not updated, nobody may touch those accounts until somebody
    // decides deliberately.
    for (const bad of [null, undefined, "", "  ", "SUPERUSER", "admin", "Admin"]) {
      expect(canAdministerUser(bad, "PARTICIPANT"), `actor=${bad}`).toBe(false);
      expect(canAdministerUser("ADMIN", bad), `target=${bad}`).toBe(false);
    }
  });

  it("is CASE-SENSITIVE, matching the Cognito group names exactly", () => {
    // The group names are uppercase in the template and the claim carries them verbatim.
    // A case-insensitive comparison would be a second, looser spelling of the contract.
    expect(canAdministerUser("Admin", "PARTICIPANT")).toBe(false);
    expect(canAdministerUser("ADMIN", "participant")).toBe(false);
  });

  it("cannot be widened by a prototype-chain key", () => {
    // The table is a plain object literal, so a lookup of an inherited property name
    // would find a function rather than undefined. `includes` on it would throw — or
    // worse, a truthy check would pass. Asserted because the actor role comes from a
    // token claim, i.e. from outside.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(canAdministerUser(key, "PARTICIPANT"), key).toBe(false);
    }
  });
});

describe("canManageUsers — the coarse directory gate", () => {
  it("admits exactly ADMIN and FACILITATOR", () => {
    expect(canManageUsers("ADMIN")).toBe(true);
    expect(canManageUsers("FACILITATOR")).toBe(true);
  });

  it("refuses the roles that may reach the provisioning FLOOR but not administer", () => {
    // EXECUTIVE and JUDGE pass canProvision — the coarse floor on the whole surface —
    // and must not pass this. A route that reused the provisioning gate would let a judge
    // disable a participant. What either may actually provision is a separate question
    // answered per role by canGrantRole, which grants a JUDGE nothing at all.
    for (const role of ["EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
      expect(canManageUsers(role), role).toBe(false);
    }
  });

  it("refuses an absent or unrecognised role", () => {
    for (const role of [null, undefined, "", "SUPERUSER"]) {
      expect(canManageUsers(role), String(role)).toBe(false);
    }
  });
});

describe("roleFromGroups — the TARGET's role, and why it may be null", () => {
  it("returns the single group when there is one", () => {
    expect(roleFromGroups(["FACILITATOR"])).toBe("FACILITATOR");
  });

  it("collapses MULTIPLE groups to the HIGHEST-privilege one", () => {
    // An account in both ADMIN and PARTICIPANT is an ADMIN. Taking the other group would
    // let a facilitator disable an administrator.
    expect(roleFromGroups(["PARTICIPANT", "ADMIN"])).toBe("ADMIN");
    expect(roleFromGroups(["PARTICIPANT", "JUDGE"])).toBe("JUDGE");
    expect(roleFromGroups(["EXECUTIVE", "FACILITATOR", "PARTICIPANT"])).toBe(
      "FACILITATOR"
    );
  });

  it("returns NULL — not PARTICIPANT — for no recognisable group", () => {
    // ⚠ THE OPPOSITE POLARITY TO EVERY OTHER COLLAPSE ON THE PLATFORM, and deliberately
    // so. collapseCognitoGroups and collapseGroupsToRole both degrade to PARTICIPANT
    // because they answer "what may this CALLER do?", where least-privileged is safe.
    // This answers "what role is the TARGET?", where least-privileged is DANGEROUS: a
    // PARTICIPANT fallback would hand every account with unparseable groups to a
    // facilitator. The route refuses on null.
    expect(roleFromGroups([])).toBeNull();
    expect(roleFromGroups(["SUPERUSER"])).toBeNull();
    expect(roleFromGroups(["admin"])).toBeNull();
  });
});

describe("isAcceptedInvitation", () => {
  it("is TRUE only when ACCEPTED is positively asserted", () => {
    expect(isAcceptedInvitation("ACCEPTED")).toBe(true);
  });

  it("treats an ABSENT status as NOT accepted, so a legacy row is still revocable", () => {
    // THE CRITICAL POLARITY, and the same one isExpired uses. Rows written before
    // `status` existed have no attribute. Treating those as accepted would leave a REAL
    // live grant un-revoked at exactly the moment somebody's access is being withdrawn —
    // and the oldest rows are the ones most likely to have been forgotten.
    expect(isAcceptedInvitation(undefined)).toBe(false);
    expect(isAcceptedInvitation("")).toBe(false);
    expect(isAcceptedInvitation("PENDING")).toBe(false);
  });

  it("compares case-INSENSITIVELY, matching the pre-signup trigger", () => {
    // The string is a cross-service contract carried in three separate bundles. A casing
    // difference must not silently reopen the bypass documented on
    // cognito-presignup/src/handler.ts.
    for (const status of ["accepted", " Accepted ", "AcCePtEd"]) {
      expect(isAcceptedInvitation(status), status).toBe(true);
    }
  });
});

describe("liveInvitationKeys — what a disable must destroy", () => {
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const PAST = "2020-01-01T00:00:00.000Z";
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  it("returns the composite key of every live, unredeemed row", () => {
    // The FULL key. The invitations table is keyed (teamId, email), so a delete missing
    // either half matches nothing and would report a clean revoke of nothing.
    const { keys, unaddressable } = liveInvitationKeys(
      [
        { teamId: "t1", email: "a@example.com", status: "PENDING", expiresAt: FUTURE },
        { teamId: "PLATFORM", email: "a@example.com", expiresAt: FUTURE },
      ],
      now
    );
    expect(keys).toEqual([
      { teamId: "t1", email: "a@example.com" },
      { teamId: "PLATFORM", email: "a@example.com" },
    ]);
    expect(unaddressable).toBe(0);
  });

  it("excludes EXPIRED rows — they admit nothing, so there is no credential to destroy", () => {
    const { keys } = liveInvitationKeys(
      [{ teamId: "t1", email: "a@example.com", expiresAt: PAST }],
      now
    );
    expect(keys).toEqual([]);
  });

  it("excludes ACCEPTED rows — that row is the audit record of a redeemed grant", () => {
    // Deleting it would destroy the record and remove no access: by then their access
    // lives in Cognito, which the disable has just switched off.
    const { keys } = liveInvitationKeys(
      [{ teamId: "t1", email: "a@example.com", status: "ACCEPTED", expiresAt: FUTURE }],
      now
    );
    expect(keys).toEqual([]);
  });

  it("counts a live row missing HALF its key as UNADDRESSABLE, not as absent", () => {
    // Such a row cannot be deleted at all, but it is still a live grant. Reporting a
    // complete sweep while leaving one behind would be the wrong answer to the one
    // question this step exists to answer.
    const { keys, unaddressable } = liveInvitationKeys(
      [
        { email: "a@example.com", expiresAt: FUTURE },
        { teamId: "t1", expiresAt: FUTURE },
        { teamId: "", email: "a@example.com", expiresAt: FUTURE },
      ],
      now
    );
    expect(keys).toEqual([]);
    expect(unaddressable).toBe(3);
  });

  it("does NOT count an expired row with a broken key as unaddressable", () => {
    // It is not a live grant, so there is nothing left behind and nothing to report.
    const { unaddressable } = liveInvitationKeys(
      [{ email: "a@example.com", expiresAt: PAST }],
      now
    );
    expect(unaddressable).toBe(0);
  });

  it("excludes REVOKED rows — for the same reason as ACCEPTED ones", () => {
    // The Team service now flips a removed member's invitation to REVOKED rather than
    // deleting it, because the row is also the record of who invited them and when they
    // accepted (and the former-members view reads provenance from it). So it is HISTORY, not
    // a live credential: deleting it here would destroy the record of a grant that was
    // deliberately withdrawn, and would remove no access.
    const { keys, unaddressable } = liveInvitationKeys(
      [{ teamId: "t1", email: "a@example.com", status: "REVOKED", expiresAt: FUTURE }],
      now
    );
    expect(keys).toEqual([]);
    // And NOT unaddressable: nothing about it is un-revoked, so it must not make a clean
    // sweep report as incomplete — which would raise an alarm for a row that is fine.
    expect(unaddressable).toBe(0);
  });

  it("still returns the live rows alongside a REVOKED one", () => {
    // Per-row, so a withdrawn grant on one team does not stop a genuinely live credential on
    // another from being destroyed — which is the entire purpose of the sweep.
    const { keys } = liveInvitationKeys(
      [
        { teamId: "t1", email: "a@example.com", status: "REVOKED", expiresAt: FUTURE },
        { teamId: "t2", email: "a@example.com", status: "PENDING", expiresAt: FUTURE },
      ],
      now
    );
    expect(keys).toEqual([{ teamId: "t2", email: "a@example.com" }]);
  });
});

describe("isRevokedInvitation", () => {
  it("is TRUE only when REVOKED is positively asserted", () => {
    expect(isRevokedInvitation("REVOKED")).toBe(true);
  });

  it("treats an ABSENT status as NOT revoked, so a legacy row is still revocable", () => {
    // THE SAME CRITICAL POLARITY as isAcceptedInvitation and isExpired. Treating a
    // status-less row as revoked would leave a REAL live grant un-revoked at exactly the
    // moment somebody's access is being withdrawn.
    expect(isRevokedInvitation(undefined)).toBe(false);
    expect(isRevokedInvitation("")).toBe(false);
    expect(isRevokedInvitation("PENDING")).toBe(false);
  });

  it("does NOT conflate REVOKED with ACCEPTED", () => {
    // Two separate row states and two separate facts. The Team service's revoke route gives a
    // DIFFERENT remedy for each ("remove the member" vs "send a fresh invitation"), so a
    // predicate that answered both would make that message impossible to choose.
    expect(isRevokedInvitation("ACCEPTED")).toBe(false);
    expect(isAcceptedInvitation("REVOKED")).toBe(false);
  });

  it("compares case-INSENSITIVELY, matching the two Cognito triggers", () => {
    // Four copies of this literal exist (here, both triggers, and the Team service's domain)
    // because three of the four bundle standalone. A casing difference must not decide whether
    // a withdrawn grant can still mint an account.
    for (const status of ["revoked", " Revoked ", "ReVoKeD"]) {
      expect(isRevokedInvitation(status), status).toBe(true);
    }
  });
});

describe("normalizeAuditReason", () => {
  it("keeps a reasonable reason verbatim, trimmed", () => {
    expect(normalizeAuditReason("  left the programme  ")).toBe("left the programme");
  });

  it("collapses an absent or whitespace-only reason to undefined", () => {
    // The row carries no attribute at all, rather than an empty string the UI would
    // render as an empty "Reason:" line — worse than no line, because it reads as data
    // that failed to load.
    for (const value of [undefined, null, "", "   ", "\n\t ", 42, {}, []]) {
      expect(normalizeAuditReason(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("TRUNCATES at the cap rather than refusing", () => {
    // Losing the tail of a note is a smaller loss than losing the entry, and an access
    // change the operator has decided on must not fail over the length of a comment.
    const stored = normalizeAuditReason("x".repeat(500)) as string;
    expect(stored).toHaveLength(AUDIT_REASON_MAX);
  });

  it("keeps a reason of EXACTLY the cap intact", () => {
    const exact = "x".repeat(AUDIT_REASON_MAX);
    expect(normalizeAuditReason(exact)).toBe(exact);
  });

  it("measures and cuts in CODE POINTS, so no surrogate pair is halved", () => {
    // `.length`/`.slice` count a surrogate pair twice and can cut one in half, writing a
    // lone surrogate into the row that renders as a replacement character in the trail.
    // Measured the same way usernameRejectionReason and the profile validator measure.
    const stored = normalizeAuditReason("\u{1F600}".repeat(250)) as string;
    expect([...stored]).toHaveLength(AUDIT_REASON_MAX);
    expect(stored).toBe("\u{1F600}".repeat(AUDIT_REASON_MAX));
  });

  it("matches AUDIT_REASON_MAX in the shared types, which the portal's input is capped at", () => {
    // A reason that fits the form must always fit the row. Asserted literally because
    // reading the other file is not possible here, so this test IS the link between them.
    expect(AUDIT_REASON_MAX).toBe(200);
  });

  /**
   * ── CONTROL SANITISATION, CONVERGED WITH THE TEAM SERVICE'S COPY ──
   *
   * WHAT THE DEFECT WAS. This function checked type, trimmed and capped length, and sanitised
   * NOTHING — while the team service's verbatim twin (routes.ts:496) had been fixed to strip
   * controls. Both write the SAME `praimana-audit` table, so a reason recorded on THESE
   * platform-access routes (POST /access, disable/enable) could still carry a newline, a NUL or
   * U+202E into an append-only row that is never deleted. The divergence was in the safe
   * direction only by accident of which route got fixed first.
   *
   * WHY IT MATTERS ON A TABLE NOBODY CAN CORRECT. A raw newline forges a second LINE in every
   * renderer that prints the trail as text (a CSV export, a CloudWatch line, a terminal);
   * U+202E RIGHT-TO-LEFT OVERRIDE makes the RENDERED reason differ from the stored one; a NUL
   * truncates the string in a C-backed consumer. None of it is FORGERY — actorId, actorRole and
   * occurredAt come from the verified token and the store's clock — but it is permanent
   * pollution of a record that exists to be read during an incident.
   *
   * These cases MIRROR the team service's (authz-attack.test.ts, "the hostile reason reaches
   * the trail with NO control characters" and the three after it). They are asserted here at
   * the FUNCTION rather than through a route because that is where this copy lives and where a
   * future edit to one copy and not the other would show up.
   *
   * DO NOT "SIMPLIFY" THIS BY EXEMPTING CHARACTERS. The whole of category C is one rule with no
   * holes; an exemption list is what ages badly and how U+2066 or the next bidi control nobody
   * remembered gets back in. The accepted cost is pinned as KNOWN in its own test below.
   */
  it("strips EVERY category-C code point — controls, NUL and bidi overrides", () => {
    const stored = normalizeAuditReason(
      "legit disable\n2026-01-01T00:00:00.000Z ACCESS_ENABLED by ADMIN alice\u202Egnittes\u0000  "
    ) as string;

    // Not one code point of category C survives: controls, format (where every bidi override
    // lives), surrogates, private-use, unassigned.
    expect(stored).not.toMatch(/\p{C}/u);
    expect(stored).not.toContain("\n");
    expect(stored).not.toContain("\u202E");
    expect(stored).not.toContain("\u0000");
    // Every one of the operator's words survives, and the two clauses stay TWO.
    expect(stored).toBe(
      "legit disable 2026-01-01T00:00:00.000Z ACCESS_ENABLED by ADMIN alice gnittes"
    );
  });

  it("collapses a control RUN to ONE SPACE, so padding cannot buy budget", () => {
    // Asserted as a LENGTH and not only as a string: a 200-character run contributes exactly
    // ONE code point. Were it 200 spaces, the whole AUDIT_REASON_MAX budget would be spendable
    // on characters the sanitiser was about to remove.
    expect(normalizeAuditReason("a" + "\n".repeat(200) + "b")).toBe("a b");
    expect([...(normalizeAuditReason("a" + "\n".repeat(200) + "b") as string)]).toHaveLength(3);

    // REPLACED, NOT DELETED. Deleting would fuse two clauses into one word the operator never
    // wrote — a small lie in a record whose only job is to be true.
    expect(normalizeAuditReason("a\nb")).toBe("a b");
    expect(normalizeAuditReason("first clause\r\n\t\tsecond clause")).toBe(
      "first clause second clause"
    );
  });

  it("SANITISES BEFORE TRUNCATING, so control padding cannot spend the budget", () => {
    // THE ORDER IS LOAD-BEARING. Trim-and-cap first would let 400 leading control characters
    // consume the whole 200-code-point budget, and the operator's real note would be truncated
    // away by padding they did not choose. Asserted below the bound, AT it, and one PAST it.
    //
    // ⚠ PADDED WITH NUL, NOT WITH `\n`, AND THAT IS THE WHOLE TEST. `String#trim` strips
    // `\n` (it is whitespace), so a newline-padded reason survives even the UNSANITISED
    // implementation — a version of this test written with `\n` PASSES against the defect and
    // proves nothing. U+0000 and U+202E are NOT trimmable, so only sanitise-then-trim-then-
    // measure gets these right. Verified by running these cases against the old function.
    const PAD = "\u0000".repeat(400);
    expect(normalizeAuditReason(PAD + "the real reason")).toBe("the real reason");
    expect(normalizeAuditReason("\u202E".repeat(400) + "the real reason")).toBe(
      "the real reason"
    );

    const atLimit = normalizeAuditReason(PAD + "a".repeat(AUDIT_REASON_MAX));
    expect(atLimit).toBe("a".repeat(AUDIT_REASON_MAX));

    // And the cap is NOT weakened by the fix: 201 real code points still truncate to 200.
    const overLimit = normalizeAuditReason(PAD + "a".repeat(AUDIT_REASON_MAX + 1)) as string;
    expect([...overLimit]).toHaveLength(AUDIT_REASON_MAX);
    expect(overLimit).toBe("a".repeat(AUDIT_REASON_MAX));
  });

  it("PRESERVES ordinary internal whitespace — a space is not a control character", () => {
    // The opposite regression to the defect, and why the rule is "category C" and not
    // "whitespace": an operator's sentence must come back the way they wrote it.
    expect(normalizeAuditReason("a b")).toBe("a b");
    expect(normalizeAuditReason("left  the   programme")).toBe("left  the   programme");
    // A control run ADJACENT to a real space yields BOTH — one for the run, one the operator
    // typed. Specified, not a rough edge: collapsing the pair would rewrite real spacing.
    expect(normalizeAuditReason("disabled\u202E after\u0000 review")).toBe(
      "disabled  after  review"
    );
  });

  it("collapses a CONTROL-ONLY reason to undefined, because sanitising precedes the trim", () => {
    // A reason made entirely of control characters becomes spaces, trims to "" and returns
    // undefined — so the ROW carries no `reason` attribute rather than a string of blanks the
    // audit UI renders as an empty "Reason:" line. The whitespace-only cases are pinned above;
    // these are the ones that only pass because the sanitiser runs FIRST.
    for (const nothing of ["\n\n\t \u202E", " \u202E\n", "\u200B", "\u0000\u0000"]) {
      expect(normalizeAuditReason(nothing), JSON.stringify(nothing)).toBeUndefined();
    }
  });

  it("KNOWN AND ACCEPTED: a ZWJ emoji sequence SPLITS; VS16, skin tones and flags do not", () => {
    // ── A PINNED KNOWN CONSEQUENCE, NOT A BUG. DO NOT "FIX" IT BY ADDING AN EXEMPTION. ──
    //
    // U+200D ZERO WIDTH JOINER is category Cf, so a ZWJ sequence is split into its parts.
    // Pinned so it is a known behaviour rather than a surprise in a support ticket, and pinned
    // as ACCEPTED because the alternative is an exemption list — the thing that ages badly, that
    // a reviewer cannot check at a glance, and that is how the next forgotten bidi control gets
    // through. This field is a short operator note on an access change, not a message body: a
    // split emoji is legible and harmless; a hole in the rule is not.
    expect(normalizeAuditReason("\u{1F469}\u200D\u{1F4BB}")).toBe("\u{1F469} \u{1F4BB}");
    expect(normalizeAuditReason("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} disabled")).toBe(
      "\u{1F468} \u{1F469} \u{1F467} disabled"
    );

    // THE COST IS BOUNDED, measured against this runtime rather than assumed: U+FE0F VARIATION
    // SELECTOR-16 is Mn, skin-tone modifiers and regional indicators are So, combining marks are
    // Mn. None is in category C, so all of these survive code point for code point.
    for (const intact of [
      "❤️", // red heart + VS16
      "\u{1F44D}\u{1F3FF}", // thumbs up + skin-tone modifier
      "\u{1F1EC}\u{1F1E7}", // regional indicators GB
      "\u{1F642}", // plain emoji
      "1️⃣", // VS16 + combining enclosing keycap
      "é", // combining acute
    ]) {
      const stored = normalizeAuditReason(`ok ${intact}`) as string;
      expect(stored, JSON.stringify(intact)).toBe(`ok ${intact}`);
      // And no lone surrogate was introduced: re-encoding through UTF-8 is lossless.
      expect(Buffer.from(stored, "utf8").toString("utf8"), JSON.stringify(intact)).toBe(stored);
    }
  });
});
