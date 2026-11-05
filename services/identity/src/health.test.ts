import { describe, it, expect } from "vitest";
import { createIdentityRoutes } from "./routes.js";
import type { PlatformHealth, PlatformHealthReader, User, UserPage, UserRepository } from "./domain.js";

/**
 * ── PLATFORM HEALTH ────────────────────────────────────────────────────────────────────────
 *
 * A read-only platform health tab in Administration, visible only to admins and facilitators.
 *
 * ⚠ THE ONE RULE THESE TESTS EXIST FOR: A FAILED CHECK MUST NEVER READ AS HEALTHY.
 *
 * Every other property of a status page is cosmetic next to this. If the read throws and the route answers
 * 200 with an empty list, the panel renders "nothing wrong" during an outage — it converts a failure into a
 * reassurance, which is strictly worse than having no page. That is the authorization discipline (unavailable is
 * not permissive) applied to health, and it is the reassuring default that a later "simplification" reaches
 * for, which is why it is pinned from both ends: the route 503s, and the reader maps INSUFFICIENT_DATA to
 * UNKNOWN rather than OK.
 */

const INTERNAL_TOKEN = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;

function asUser(identity: { id: string; role: string }) {
  return {
    "content-type": "application/json",
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
  };
}

class NoUsers implements UserRepository {
  async getById() {
    return null;
  }
  async getByEmail() {
    return null;
  }
  async put(u: User) {
    return u;
  }
  /** Never exercised here — this stub exists for routes that do not touch the profile. */
  async updateProfile(): Promise<User> {
    throw new Error("updateProfile is not exercised by this suite");
  }
  async list(): Promise<UserPage> {
    return { users: [] };
  }
  async listByIds(): Promise<User[]> {
    return [];
  }
}

const HEALTHY: PlatformHealth = {
  overall: "OK",
  alarms: [
    { name: "api-5xx", state: "OK", description: "The edge API is returning server errors. Runbook…", reason: "within threshold", since: "2026-08-17T10:00:00.000Z" },
  ],
  checkedAt: "2026-08-17T12:00:00.000Z",
};

class FakeHealth implements PlatformHealthReader {
  constructor(private readonly behaviour: PlatformHealth | "throws" = HEALTHY) {}
  async read(): Promise<PlatformHealth> {
    if (this.behaviour === "throws") throw new Error("AccessDeniedException");
    return this.behaviour;
  }
}

const build = (health?: PlatformHealthReader | "none") =>
  createIdentityRoutes({
    users: new NoUsers(),
    ...(health && health !== "none" ? { health } : {}),
  });

const get = (app: ReturnType<typeof build>, role = "ADMIN") =>
  app.request("/v1/admin/platform-health", { headers: asUser({ id: "a1", role }) });

describe("GET /v1/admin/platform-health", () => {
  it("serves an ADMIN and a FACILITATOR — the intended audience", async () => {
    for (const role of ["ADMIN", "FACILITATOR"]) {
      const res = await get(build(new FakeHealth()), role);
      expect(res.status, role).toBe(200);
      const body = (await res.json()) as PlatformHealth;
      expect(body.overall).toBe("OK");
      expect(body.alarms).toHaveLength(1);
    }
  });

  for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
    it(`⚠ 403s a ${role} — health is a map of what is failing and where`, async () => {
      /**
       * Not secret, but only ever useful to somebody who can act on it, and reconnaissance for anybody else.
       * The gate is the /v1/admin router's middleware rather than this handler, which is why a route added
       * beside it cannot forget to check.
       */
      const res = await get(build(new FakeHealth()), role);
      expect(res.status).toBe(403);
    });
  }

  it("requires authentication at all", async () => {
    const res = await build(new FakeHealth()).request("/v1/admin/platform-health");
    expect(res.status).toBe(401);
  });

  it("⚠ 503s when the read FAILS — never 200 with an empty list", async () => {
    /**
     * The defect this forbids: a catch that returns `{ alarms: [] }` and a 200. The panel would render
     * "nothing wrong" while the platform burned, and nobody looking at it could tell the difference.
     */
    const res = await get(build(new FakeHealth("throws")));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("HEALTH_READ_FAILED");
    expect(body.alarms).toBeUndefined();
    expect(body.overall).toBeUndefined();
  });

  it("⚠ says the failure is about the CHECK, not about the platform", async () => {
    // A reader must not conclude "the platform is down" from "we could not ask". The wording is the whole
    // mitigation, so it is asserted rather than left to a future edit.
    const res = await get(build(new FakeHealth("throws")));
    const body = await res.json();
    expect(body.error).toMatch(/says nothing about whether the platform is healthy/i);
  });

  it("⚠ does not leak the AWS error into the response", async () => {
    // An AWS message carries an account id and a role ARN, and this body reaches a browser.
    const res = await get(build(new FakeHealth("throws")));
    expect(JSON.stringify(await res.json())).not.toMatch(/AccessDenied/i);
  });

  it("503s when no reader is wired, rather than throwing", async () => {
    const res = await get(build("none"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("HEALTH_UNAVAILABLE");
  });

  it("passes the reader's verdict through unchanged, including UNKNOWN", async () => {
    /**
     * ⚠ THE ROUTE MUST NOT "TIDY" A VERDICT. A handler that mapped UNKNOWN to OK because the list contained
     * no ALARM would erase exactly the state that means "nobody is watching this metric".
     */
    const degraded: PlatformHealth = {
      overall: "UNKNOWN",
      alarms: [
        { name: "canary-failed", state: "UNKNOWN", description: "", reason: "", since: null },
        { name: "api-5xx", state: "OK", description: "", reason: "", since: null },
      ],
      checkedAt: "2026-08-17T12:00:00.000Z",
    };
    const res = await get(build(new FakeHealth(degraded)));
    expect(await res.json()).toMatchObject({ overall: "UNKNOWN" });
  });

  it("is READ-ONLY — there is no write route beside it", async () => {
    // A read-only platform health tab. Nothing here may acknowledge, silence or reset an alarm: that
    // would be an operational action taken from a page whose audience includes facilitators.
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
      const res = await build(new FakeHealth()).request("/v1/admin/platform-health", {
        method,
        headers: asUser({ id: "a1", role: "ADMIN" }),
      });
      expect(res.status, method).not.toBe(200);
    }
  });
});
