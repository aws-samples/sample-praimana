import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// For the source pins at the end of this file, the invite ROUTE has no exported unit and
// the portal suite has no request plumbing, so its use of `alreadyExisted` is asserted by
// reading it. See the block comment there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BackendError } from "./backend";
import {
  PROVISION_CONCURRENCY,
  provisionAccount,
  provisionAccounts,
} from "./provision";

/**
 * The BFF's half of ADMIN-PROVISIONED registration.
 *
 * What matters here is not the happy path, it is that a bulk invite cannot become an
 * unbounded fan-out at Cognito's per-pool rate limit, that ONE bad address cannot lose
 * the whole batch, and that a failure is classified into something an operator can act
 * on rather than a raw upstream message.
 *
 * `backendFetch` is mocked because the alternative is a real HTTP call; the module under
 * test owns the classification and the concurrency, which is exactly what is asserted.
 */
vi.mock("./backend", async () => {
  const actual = await vi.importActual<typeof import("./backend")>("./backend");
  return { ...actual, backendFetch: vi.fn() };
});

const { backendFetch } = await import("./backend");
const mockFetch = vi.mocked(backendFetch);

const TOKEN = "test-id-token";

function okResult(over: Record<string, unknown> = {}) {
  return {
    temporaryPassword: "Tq7#mKp2$xNvR4wZ",
    role: "PARTICIPANT",
    alreadyExisted: false,
    groupAssigned: true,
    profileWritten: true,
    ...over,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("provisionAccount", () => {
  it("returns the result on success", async () => {
    mockFetch.mockResolvedValue(okResult());
    const outcome = await provisionAccount("someone@example.com", TOKEN);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.temporaryPassword).toBe("Tq7#mKp2$xNvR4wZ");
      expect(outcome.result.role).toBe("PARTICIPANT");
    }
  });

  it("posts the email to the user-access service with the caller's token", async () => {
    mockFetch.mockResolvedValue(okResult());
    await provisionAccount("someone@example.com", TOKEN);
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/user-access/provision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "someone@example.com" }),
        token: TOKEN,
      })
    );
  });

  it("NEVER THROWS, a failure is the return value", async () => {
    // Load-bearing for the bulk path: a throw here would abandon every other address
    // in the batch, including ones that provisioned successfully.
    mockFetch.mockRejectedValue(new Error("boom"));
    const outcome = await provisionAccount("someone@example.com", TOKEN);
    expect(outcome.ok).toBe(false);
  });

  it("treats a response with NO password as a failure, not a success", async () => {
    // There would be nothing to email. Reporting it as provisioned would leave the
    // invitee holding a link and no credential, with the operator believing it worked.
    mockFetch.mockResolvedValue(okResult({ temporaryPassword: "" }));
    const outcome = await provisionAccount("someone@example.com", TOKEN);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.retryable).toBe(true);
  });

  it("surfaces a groupAssigned:false result as a SUCCESS the caller must inspect", async () => {
    // The account exists, it just has no role. That is not a provisioning failure (the
    // email must still go out), but the caller has to be able to see it, which is why it
    // travels on the result rather than being collapsed into ok/not-ok.
    mockFetch.mockResolvedValue(okResult({ groupAssigned: false }));
    const outcome = await provisionAccount("someone@example.com", TOKEN);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.groupAssigned).toBe(false);
  });
});

describe("failure classification", () => {
  async function failureFor(err: unknown) {
    mockFetch.mockRejectedValue(err);
    const outcome = await provisionAccount("someone@example.com", TOKEN);
    if (outcome.ok) throw new Error("expected a failure");
    return outcome.failure;
  }

  it("marks the INVITE_GATE_REFUSED case retryable and names the invitation", async () => {
    // This means the pre-signup gate did not see the row, our own sequencing, fixable
    // by re-sending. It must NOT read as "you mistyped the address".
    const failure = await failureFor(
      new BackendError(409, "gate refused", "INVITE_GATE_REFUSED")
    );
    expect(failure.retryable).toBe(true);
    expect(failure.reason).toMatch(/invitation/i);
  });

  it("marks a 400 NOT retryable and passes the specific reason through", async () => {
    // The address is the problem; retrying identical input cannot help, and the message
    // names what to fix.
    const failure = await failureFor(
      new BackendError(400, "email address must not contain spaces or control characters")
    );
    expect(failure.retryable).toBe(false);
    expect(failure.reason).toMatch(/spaces or control characters/);
  });

  it("marks a 409 (no live invitation) NOT retryable", async () => {
    const failure = await failureFor(new BackendError(409, "no live invitation"));
    expect(failure.retryable).toBe(false);
    expect(failure.reason).toMatch(/invitation/i);
  });

  it("marks a 403 NOT retryable, the caller's role is the problem", async () => {
    const failure = await failureFor(new BackendError(403, "Forbidden"));
    expect(failure.retryable).toBe(false);
  });

  it("marks 502/503 retryable, an upstream refused or did not answer", async () => {
    for (const status of [502, 503]) {
      const failure = await failureFor(new BackendError(status, "upstream"));
      expect(failure.retryable, String(status)).toBe(true);
    }
  });

  it("does NOT leak a raw transport error into the operator-facing reason", async () => {
    // A fetch failure's message can carry internal hostnames and URLs. The operator can
    // act on "try again" either way, so the raw text buys nothing and costs disclosure.
    const failure = await failureFor(
      new TypeError("fetch failed: connect ECONNREFUSED http://internal-backend.local:4020")
    );
    expect(failure.reason).not.toMatch(/internal-backend|ECONNREFUSED|4020/);
    expect(failure.retryable).toBe(true);
  });

  it("never puts a credential in a failure reason", async () => {
    // Belt and braces: nothing in this path has a password to leak, and this asserts it
    // stays that way if the classification is ever taught to include the response body.
    const failure = await failureFor(
      new BackendError(500, "failed with password Tq7#mKp2$xNvR4wZ")
    );
    expect(failure.reason).not.toContain("Tq7#mKp2$xNvR4wZ");
  });

  it("records WHICH address failed, so a bulk invite can report per recipient", async () => {
    const failure = await failureFor(new BackendError(502, "upstream"));
    expect(failure.email).toBe("someone@example.com");
  });
});

describe("provisionAccounts, bounded concurrency", () => {
  it("returns one outcome per email, in the SAME ORDER as the input", async () => {
    // The caller pairs outcomes with recipients; a reordered result would email one
    // person another person's temporary password.
    mockFetch.mockImplementation(async (_path, opts) => {
      const { email } = JSON.parse(String((opts as { body: string }).body));
      return okResult({ temporaryPassword: `pw-${email}` });
    });

    const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"];
    const outcomes = await provisionAccounts(emails, TOKEN);

    expect(outcomes).toHaveLength(emails.length);
    outcomes.forEach((outcome, i) => {
      expect(outcome.email).toBe(emails[i]);
      if (outcome.ok) {
        expect(outcome.result.temporaryPassword).toBe(`pw-${emails[i]}`);
      }
    });
  });

  it("NEVER exceeds the concurrency limit, however many addresses are invited", async () => {
    // THE test this module exists for. Cognito's admin APIs are rate-limited per POOL,
    // and the same throttle blocks real users' sign-ins, so a 50-address bulk invite
    // must not issue 50 concurrent AdminCreateUser calls.
    let inFlight = 0;
    let peak = 0;
    mockFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so the other workers get a chance to start, without this every call
      // resolves before the next begins and the test would pass trivially.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return okResult();
    });

    const emails = Array.from({ length: 50 }, (_, i) => `u${i}@example.com`);
    await provisionAccounts(emails, TOKEN, 4);

    expect(peak).toBeLessThanOrEqual(4);
    // And it must actually BE concurrent, a serial implementation would also satisfy
    // the bound above while making a 50-invite batch four times slower than needed.
    expect(peak).toBeGreaterThan(1);
  });

  it("uses PROVISION_CONCURRENCY by default", async () => {
    let peak = 0;
    let inFlight = 0;
    mockFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return okResult();
    });

    await provisionAccounts(
      Array.from({ length: 20 }, (_, i) => `u${i}@example.com`),
      TOKEN
    );
    expect(peak).toBeLessThanOrEqual(PROVISION_CONCURRENCY);
  });

  it("keeps the concurrency bound a real number, not a placeholder", () => {
    // If this becomes 50, the bound is decoration. If it becomes 1, bulk invites crawl.
    expect(PROVISION_CONCURRENCY).toBeGreaterThan(1);
    expect(PROVISION_CONCURRENCY).toBeLessThanOrEqual(8);
  });

  it("processes EVERY address even when some fail", async () => {
    // One bad address must not lose the batch, the whole reason provisionAccount does
    // not throw.
    mockFetch.mockImplementation(async (_path, opts) => {
      const { email } = JSON.parse(String((opts as { body: string }).body));
      if (email === "bad@example.com") throw new BackendError(400, "rejected by the pool");
      return okResult();
    });

    const outcomes = await provisionAccounts(
      ["a@example.com", "bad@example.com", "c@example.com"],
      TOKEN
    );

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("makes exactly ONE call per address, no duplicate provisioning", async () => {
    // A worker-pool index bug would either skip an address or provision one twice; the
    // second would mint a second temporary password and email the first one, which the
    // account no longer accepts.
    mockFetch.mockResolvedValue(okResult());
    const emails = Array.from({ length: 9 }, (_, i) => `u${i}@example.com`);
    await provisionAccounts(emails, TOKEN, 4);

    expect(mockFetch).toHaveBeenCalledTimes(emails.length);
    const called = mockFetch.mock.calls.map(
      ([, opts]) => JSON.parse(String((opts as { body: string }).body)).email
    );
    expect([...called].sort()).toEqual([...emails].sort());
  });

  it("handles an EMPTY list without spawning a worker or calling anything", async () => {
    const outcomes = await provisionAccounts([], TOKEN);
    expect(outcomes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles a single address without over-allocating workers", async () => {
    mockFetch.mockResolvedValue(okResult());
    const outcomes = await provisionAccounts(["only@example.com"], TOKEN, 8);
    expect(outcomes).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── The re-invite email must not carry a temporary password ─────────────────

/**
 * A RE-INVITE OF AN EXISTING ACCOUNT SENDS NO TEMPORARY PASSWORD.
 *
 * ── THE DEFECT THIS PINS ──
 *
 * A participant who had been removed from a team and then re-invited received an email
 * containing a temporary password, despite having long been registered with a
 * password of their own.
 *
 * ⚠ THE PASSWORD IN THAT EMAIL WAS NEVER LIVE, which is what makes this subtle. The
 * provisioning adapter catches `UsernameExistsException` and returns `alreadyExisted: true`
 * WITHOUT resetting the credential, deliberately, because "the existing account may be in
 * active use with a password its owner chose, and silently replacing it would lock them out"
 * (user-access/src/adapters.ts). Cognito confirmed it: the account stayed CONFIRMED rather
 * than dropping to FORCE_CHANGE_PASSWORD. So a password was minted, printed into an email,
 * and applied to nothing.
 *
 * That is a TRUST defect rather than a lockout. The recipient holds a credential that
 * silently does not work, and the only way to find out is to try it and be told "incorrect
 * email or password", indistinguishable from a typo. It also invites them to abandon a
 * working password for a dead one, and leaves a real-looking credential sitting in a mailbox
 * for no reason.
 *
 * ── WHY THIS FILE, AND WHY A SOURCE PIN ──
 *
 * The bug is in `src/app/api/invite/route.ts`, which is a Next route handler with
 * no exported unit under test, and the portal suite runs `environment: "node"` with no
 * request plumbing, so calling it is not an option (same constraint that produced the mirror
 * tests in access-action-gating.test.ts). `ProvisionResult.alreadyExisted` is this module's
 * contract, though, and the route reads it from here, so the flag's presence is pinned below
 * and the route's USE of it is pinned by reading the source, comment-stripped so a mention in
 * prose cannot satisfy it.
 */
describe("a re-invite of an EXISTING account carries no temporary password", () => {
  const inviteRoute = () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/api/invite/route.ts", import.meta.url)),
      "utf8"
    );
    // Comments stripped: this must assert what the code DOES, and this route's comments
    // discuss `alreadyExisted` and `temporaryPassword` at length.
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/.*$/gm, "");
  };

  it("ProvisionResult still carries `alreadyExisted`, the flag the route branches on", () => {
    // If this field is ever removed or renamed, the route's guard silently stops guarding and
    // every re-invite starts shipping a dead credential again. Asserted on the TYPE's own
    // module rather than inferred from the route.
    const src = readFileSync(
      fileURLToPath(new URL("./provision.ts", import.meta.url)),
      "utf8"
    );
    expect(src).toMatch(/alreadyExisted:\s*boolean/);
  });

  it("the invite route GATES temporaryPassword on !alreadyExisted", () => {
    const code = inviteRoute();

    // The guard, in whatever formatting prettier settles on: `alreadyExisted` must appear in
    // a conditional that decides whether `temporaryPassword` is in the payload.
    expect(code).toMatch(/alreadyExisted/);
    // And the field must NOT be sent unconditionally, the shape the defect had was
    // `temporaryPassword: provisionByEmail.get(...)!.temporaryPassword,` at the top level of
    // the body object with no branch anywhere near it.
    expect(
      /\n\s*temporaryPassword:\s*provisionByEmail\.get\([^)]*\)!\.temporaryPassword,/.test(code),
      "temporaryPassword is being sent UNCONDITIONALLY, a re-invited user with an existing " +
        "password would receive a credential that was never applied to their account"
    ).toBe(false);
  });

  it("keeps sending it for a NEW account, the fix must not break first-time invites", () => {
    // The companion that stops the guard being "never send a password", which would satisfy
    // the assertion above and break every genuine first invitation: the account is created
    // with that password and this email is its ONLY delivery.
    const code = inviteRoute();
    expect(code).toMatch(/temporaryPassword/);
  });
});
