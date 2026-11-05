import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ROLE_PRECEDENCE, canSignInToDesktopApp, canManageUsers } from "@praimana/shared";
import { isForbiddenPath } from "./route-gates";

/**
 * ── ⚠ EVERY MENU DESTINATION MUST BE REACHABLE BY THE ROLES OFFERED IT ─────────────────────
 *
 * This test exists because the SAME BUG has now happened three times:
 *
 *   1. The Submit tab was offered to team members while `isForbiddenPath` bounced every PARTICIPANT off it -
 *      which deadlocked the whole submission flow.
 *   2. `/how-it-works` was written FOR participants and would have redirected them to /welcome.
 *   3. `/desktop` hands somebody the installer, and would have done the same.
 *
 * Each time the offer and the gate were edited in different files by somebody who had both rules in mind and
 * still missed one. So this DERIVES the destinations from the menu source instead of listing them: a new
 * entry is covered the moment it is added, without anybody remembering this file exists.
 *
 * ⚠ WHAT IT CANNOT SEE: a destination built at runtime (a template literal with an id in it). Those are
 * deliberately excluded below rather than silently mismatched, and there are none in this menu today.
 */

const MENU = readFileSync(join(__dirname, "..", "components", "ProfileMenu.tsx"), "utf8");
/** Comments stripped: this file's own reasoning names routes it is not asserting. */
const code = MENU.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

/** Every static `href="/…"` the menu renders. */
function destinations(): string[] {
  return [...code.matchAll(/href="(\/[^"{}]*)"/g)].map((m) => m[1]);
}

/**
 * Roles that are OFFERED a given destination.
 *
 * ⚠ THIS IS A MODEL OF THE MENU'S CONDITIONS, NOT A DERIVATION OF THEM, parsing JSX conditionals is
 * fragile enough to be worse than useless. So the model is PINNED by the test below: if a gating expression
 * in the menu changes, that test fails and whoever changed it has to update this function. Mutation testing
 * is what exposed the need, flipping `/admin` to unconditional left this file green, because the model kept
 * insisting the gate was still there.
 */
function offeredTo(href: string): string[] {
  return ROLE_PRECEDENCE.filter((role) => {
    if (href === "/desktop") return canSignInToDesktopApp(role);
    if (href === "/admin") return canManageUsers(role);
    // Everything else in this menu is offered to every signed-in role.
    return true;
  });
}

describe("the profile menu's destinations", () => {
  const found = destinations();

  it("found the menu and its links", () => {
    // A scan that matched nothing would pass every assertion below. This is the canary.
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found).toContain("/profile");
    expect(found).toContain("/how-it-works");
    expect(found).toContain("/desktop");
    expect(found).toContain("/admin");
  });

  it("⚠ is REACHABLE by every role it is offered to, the bug this file exists for", () => {
    for (const href of found) {
      for (const role of offeredTo(href)) {
        expect(
          isForbiddenPath(href, role),
          `${role} is offered ${href} in the menu but the route gate refuses it`
        ).toBe(false);
      }
    }
  });

  it("⚠ specifically: a PARTICIPANT can open everything their own menu shows them", () => {
    /**
     * Called out separately from the loop because PARTICIPANT is the ONLY role `isForbiddenPath` confines by
     * default, so it is the only role this can be wrong for, and a loop over five roles would still pass
     * four times while the one that matters failed.
     */
    for (const href of found) {
      if (!offeredTo(href).includes("PARTICIPANT")) continue;
      expect(isForbiddenPath(href, "PARTICIPANT"), `a participant cannot open ${href}`).toBe(false);
    }
  });

  it("⚠ PINS the gating expressions `offeredTo` above assumes", () => {
    /**
     * Without this, the model and the menu drift and every assertion above becomes decorative. Verified by
     * mutation: making `/admin` unconditional in the menu left the rest of this file passing, because
     * `offeredTo` went on reporting a gate that was no longer there.
     *
     * Asserted as "the link appears inside its condition", which is the shape a JSX gate takes.
     */
    expect(
      code,
      "/admin must stay behind canManageUsers, see offeredTo()"
    ).toMatch(/\{canManageUsers && \([\s\S]{0,200}href="\/admin"/);
    expect(
      code,
      "/desktop must stay behind canSignInToDesktopApp, see offeredTo()"
    ).toMatch(/canSignInToDesktopApp\([^)]*\) && \([\s\S]{0,200}href="\/desktop"/);
    // And "How it works" must NOT be gated: it is for everyone, by choice over staff-only.
    expect(code).toMatch(/href="\/how-it-works"/);
    expect(code).not.toMatch(/canAccessStaffScreens[\s\S]{0,200}href="\/how-it-works"/);
  });

  it("the roles the model claims cannot manage users really cannot", () => {
    for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
      expect(canManageUsers(role), role).toBe(false);
    }
  });
});
