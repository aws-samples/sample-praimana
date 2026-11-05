// ── ⚠ THE APP_URL GUARD, WHICH EXISTS BECAUSE THE BUG ALREADY HAPPENED ───────────────────
//
// The worker's first deployment set APP_URL from the template's `DomainName` — the API's domain. Every
// invite link would have pointed at api.<host>/join/<token>, where /join does not exist. Eighteen
// people would have received a dead link, and because each invitation token is SINGLE-USE the only
// recovery is revoking and re-inviting all of them.
//
// ⚠ NO TEST COULD HAVE CAUGHT IT: no fake can tell one hostname from another. It was found by reading
// the DEPLOYED environment variable. These tests pin the guard that now refuses it, so the same
// mistake cannot be made twice.

import { describe, it, expect } from "vitest";
import { applyPlan } from "./apply";

const identity = { id: "u-fac", email: "fac@example.com", role: "FACILITATOR" };
const plan = {
  teams: [{ teamKey: "a", teamName: "Aurora", memberCount: 1 }],
  members: [
    { line: 2, teamName: "Aurora", teamKey: "a", email: "a@example.com", platformRole: "PARTICIPANT" },
  ],
};

describe("it refuses before creating anything", () => {
  it.each([
    ["unset", ""],
    ["localhost", "http://localhost:3001"],
    ["127.0.0.1", "http://127.0.0.1:3001"],
    // ⚠ THE ONE THAT ACTUALLY SHIPPED.
    ["the API domain", "https://api.ai.example.test"],
  ])("refuses %s", async (_label, appUrl) => {
    await expect(applyPlan("w1", plan, identity, appUrl)).rejects.toThrow(/nothing was created/i);
  });

  it("names the portal as where /join lives, so the fix is obvious", async () => {
    await expect(applyPlan("w1", plan, identity, "https://api.example.com")).rejects.toThrow(/PORTAL/);
  });

  /**
   * ⚠ THE api.* RULE IS A HEURISTIC AND WOULD REFUSE A PORTAL GENUINELY HOSTED AT api.*. That is the
   * safe direction: a refusal is a config error fixed in a minute, where the alternative is eighteen
   * dead links and eighteen burned single-use tokens.
   */
  it("accepts a normal portal origin (and then fails later, on the real work)", async () => {
    // Reaching the team-list read means the guard passed — which is all this asserts.
    await expect(applyPlan("w1", plan, identity, "https://ai.example.com")).rejects.toThrow(
      /Could not read this experience|teams/i
    );
  });
});
