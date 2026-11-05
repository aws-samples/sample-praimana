import { describe, it, expect, vi } from "vitest";
// ⚠ `@praimana/service-shared`, NOT `@praimana/shared`, AND THE DISTINCTION IS WHY THIS
// TEST WAS TESTING NOTHING. This repo's `shared` carries only the three-way intersection
// (phase-progress, support, types/user) — so importing this symbol from `@praimana/shared` resolved to
// `undefined` and the assertion degraded silently instead of erroring. The ROUTE imports it from
// `service-shared`, so the test must
// read the same source: a test asserting a limit from a different copy than the route enforces is a
// test that cannot fail when they disagree.
import { canSeePlatformSpend } from "@praimana/service-shared";
import { createIdentityRoutes } from "./routes.js";
import { CachedCostReader } from "./cost.dynamo.js";
import type { CostReader, CostSnapshot, User, UserPage, UserRepository } from "./domain.js";

/**
 * ── WHAT THE PLATFORM COSTS TO RUN ─────────────────────────────────────────────────────────
 *
 * An estimated daily and overall spend, visible to admins only.
 *
 * Three properties, in order of how much damage getting them wrong would do:
 *
 *   1. ⚠ ADMIN ONLY, which is NARROWER than the router it sits on. `/v1/admin` middleware admits ADMIN and
 *      FACILITATOR; spend is for ADMIN alone. This is the first route on that router that needs its own check,
 *      so it is also the first that could silently inherit too much.
 *   2. ⚠ A FAILED READ IS NEVER A ZERO. "$0.00" is a plausible, wrong number that reads as good news — the
 *      same defect class as a health page showing OK because the check failed.
 *   3. ⚠ THE CACHE IS THE FEATURE'S BUDGET. Cost Explorer bills $0.01 per request against a platform that
 *      spends ~$1/day, so an uncached panel refreshed twenty times costs ~40% of what it reports. A test that
 *      counts calls is the only thing standing between that and a "harmless" refactor.
 */

const INTERNAL_TOKEN = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;

const asUser = (role: string) => ({
  "content-type": "application/json",
  "x-internal-token": INTERNAL_TOKEN,
  "x-identity-id": "a1",
  "x-identity-role": role,
});

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

const snapshot = (over: Partial<CostSnapshot> = {}): CostSnapshot => ({
  currency: "USD",
  monthToDate: 13.42,
  dailyAverage: 0.84,
  yesterday: 1.08,
  projectedMonth: 26.04,
  byService: [{ label: "AWS Lambda", amount: 4.2 }],
  daily: [{ label: "2026-08-16", amount: 1.08 }],
  taggedTotal: null,
  /**
   * ⚠ RELATIVE TO NOW, NEVER A LITERAL STAMP. This once read a literal timestamp, which made the
   * default snapshot FRESH for six hours after it was written and permanently stale thereafter — so
   * "asks Cost Explorer ONCE for two reads inside the window" passed on the day it was written and failed
   * every run once the window moved past it, blaming `CachedCostReader` for a clock the fixture had lost.
   *
   * A default snapshot means "just fetched", because that is the precondition every test here shares
   * except the two that want age — and those two say so, overriding `asOf` with an explicit
   * `Date.now() - 7h`. Staleness is a property a test opts into, not one the calendar imposes.
   */
  asOf: new Date().toISOString(),
  ...over,
});

class FakeCost implements CostReader {
  calls = 0;
  constructor(private readonly behaviour: CostSnapshot | "throws" = snapshot()) {}
  async read(): Promise<CostSnapshot> {
    this.calls += 1;
    if (this.behaviour === "throws") throw new Error("AccessDeniedException");
    return this.behaviour;
  }
}

const build = (cost?: CostReader | "none") =>
  createIdentityRoutes({
    users: new NoUsers(),
    ...(cost && cost !== "none" ? { cost } : {}),
  });

const get = (app: ReturnType<typeof build>, role = "ADMIN") =>
  app.request("/v1/admin/cost", { headers: asUser(role) });

describe("who may see the spend", () => {
  it("serves an ADMIN", async () => {
    const res = await get(build(new FakeCost()));
    expect(res.status).toBe(200);
    expect((await res.json()).monthToDate).toBe(13.42);
  });

  it("⚠ 403s a FACILITATOR — the one route on this router narrower than the router", async () => {
    /**
     * The whole point of the feature's gate. A facilitator passes the `/v1/admin` middleware, so if this route
     * had no check of its own it would serve them — and nothing else on the router would have looked wrong.
     */
    const cost = new FakeCost();
    const res = await get(build(cost), "FACILITATOR");
    expect(res.status).toBe(403);
    // And it did not even ask Cost Explorer, so a refused request cannot cost a cent.
    expect(cost.calls).toBe(0);
  });

  for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
    it(`403s a ${role}`, async () => {
      expect((await get(build(new FakeCost()), role)).status).toBe(403);
    });
  }

  it("requires authentication", async () => {
    expect((await build(new FakeCost()).request("/v1/admin/cost")).status).toBe(401);
  });

  it("⚠ the predicate is ADMIN alone, and is the one the UI and the route share", () => {
    expect(canSeePlatformSpend("ADMIN")).toBe(true);
    for (const role of ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT", "", null, undefined]) {
      expect(canSeePlatformSpend(role as string), String(role)).toBe(false);
    }
  });
});

describe("a failed read is never a figure", () => {
  it("⚠ 503s rather than answering 0", async () => {
    const res = await get(build(new FakeCost("throws")));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("COST_READ_FAILED");
    expect(body.monthToDate).toBeUndefined();
  });

  it("⚠ says it is a failed query, not a spend of zero", async () => {
    const body = await (await get(build(new FakeCost("throws")))).json();
    expect(body.error).toMatch(/not a figure of zero/i);
  });

  it("does not leak the AWS error", async () => {
    const body = await (await get(build(new FakeCost("throws")))).json();
    expect(JSON.stringify(body)).not.toMatch(/AccessDenied/i);
  });

  it("503s when no reader is wired", async () => {
    const res = await get(build("none"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("COST_UNAVAILABLE");
  });

  it("⚠ passes a NULL tagged total through as null, not 0", async () => {
    // "Cost Explorer has no tag data" and "the tagged spend is nothing" are different facts, and only one of
    // them is true today. Flattening null to 0 would make the panel claim the platform costs nothing.
    const res = await get(build(new FakeCost(snapshot({ taggedTotal: null }))));
    expect((await res.json()).taggedTotal).toBeNull();
  });
});

/**
 * ── ⚠ THE CACHE, WHICH IS THERE TO BOUND A BILL ─────────────────────────────────────────────
 *
 * $0.01 per Cost Explorer request, and every paginated page counts as another. These tests count calls,
 * because the failure mode is invisible in behaviour: an uncached panel works perfectly and simply costs
 * money.
 */
describe("the cost cache", () => {
  const table = () => {
    const rows = new Map<string, unknown>();
    const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const kind = command.constructor.name;
      if (kind === "GetCommand") {
        const key = (command.input.Key as { id: string }).id;
        return rows.has(key) ? { Item: rows.get(key) } : {};
      }
      if (kind === "PutCommand") {
        const item = command.input.Item as { id: string };
        rows.set(item.id, item);
        return {};
      }
      throw new Error(`unexpected command ${kind}`);
    });
    return { send, rows } as unknown as { send: ReturnType<typeof vi.fn>; rows: Map<string, unknown> };
  };

  it("⚠ asks Cost Explorer ONCE for two reads inside the window", async () => {
    const db = table();
    const source = new FakeCost();
    const reader = new CachedCostReader(db as never, source);

    await reader.read();
    await reader.read();

    expect(source.calls, "the second read must come from the cache").toBe(1);
  });

  it("⚠ re-reads once the snapshot is older than the window", async () => {
    const db = table();
    // A snapshot stamped well in the past — the age is derived from `asOf`, so this is the real trigger.
    const stale = new FakeCost(snapshot({ asOf: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() }));
    const reader = new CachedCostReader(db as never, stale);

    await reader.read();
    await reader.read();

    expect(stale.calls).toBe(2);
  });

  it("⚠ serves the STALE snapshot when a refresh fails, rather than an error", async () => {
    /**
     * A cost figure that moves slowly is worth more stale than absent, and `asOf` travels with it so the
     * panel can say how old it is. This is the opposite call from the health page — and the difference is that
     * an old cost is still true, while an old "healthy" is a lie.
     */
    const db = table();
    let mode: "ok" | "throws" = "ok";
    const source: CostReader = {
      read: async () => {
        if (mode === "throws") throw new Error("LimitExceededException");
        return snapshot({ asOf: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() });
      },
    };
    const reader = new CachedCostReader(db as never, source);

    const first = await reader.read();
    mode = "throws";
    const second = await reader.read();

    expect(second.asOf).toBe(first.asOf);
    expect(second.monthToDate).toBe(first.monthToDate);
  });

  it("throws when there is nothing cached AND the read fails — no invented zero", async () => {
    const db = table();
    const reader = new CachedCostReader(db as never, new FakeCost("throws"));
    await expect(reader.read()).rejects.toThrow();
  });

  it("still answers when the CACHE ITSELF is unreadable", async () => {
    // A broken cache must cost freshness and money, never the panel.
    const db = { send: vi.fn().mockRejectedValue(new Error("ResourceNotFoundException")) };
    const source = new FakeCost();
    const reader = new CachedCostReader(db as never, source);

    const out = await reader.read();
    expect(out.monthToDate).toBe(13.42);
    expect(source.calls).toBe(1);
  });
});
