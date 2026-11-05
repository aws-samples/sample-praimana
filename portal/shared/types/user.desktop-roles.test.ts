import { describe, it, expect } from "vitest";
import {
  canSignInToDesktopApp,
  canAccessStaffScreens,
  DESKTOP_APP_ROLES,
  ROLE_PRECEDENCE,
} from "./user";

/**
 * ── WHO MAY SIGN IN TO THE DESKTOP APP ─────────────────────────────────────────────────────
 *
 * The desktop app is only for executives and participants; no other role may sign in to it.
 *
 * The test that matters most is the EXECUTIVE one: they are simultaneously staff (they reach the portal's
 * experience screens) and a desktop user, so the naive implementation — the complement of
 * `canAccessStaffScreens` — would lock every executive out of the app where their team's work lives.
 */
describe("canSignInToDesktopApp", () => {
  it("admits EXECUTIVE and PARTICIPANT", () => {
    expect(canSignInToDesktopApp("EXECUTIVE")).toBe(true);
    expect(canSignInToDesktopApp("PARTICIPANT")).toBe(true);
  });

  it("refuses ADMIN, FACILITATOR and JUDGE — they operate from the portal", () => {
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE"]) {
      expect(canSignInToDesktopApp(role), role).toBe(false);
    }
  });

  it("⚠ is NOT the complement of canAccessStaffScreens — an EXECUTIVE is both", () => {
    // The bug this pins: `!canAccessStaffScreens(role)` reads like the same rule and locks out every
    // executive, who is the one role that needs BOTH surfaces.
    expect(canAccessStaffScreens("EXECUTIVE")).toBe(true);
    expect(canSignInToDesktopApp("EXECUTIVE")).toBe(true);
  });

  it("fails closed on an absent or unrecognised role", () => {
    for (const role of [null, undefined, "", "SUPERUSER", "participant"]) {
      expect(canSignInToDesktopApp(role), String(role)).toBe(false);
    }
  });

  it("names only roles that actually exist", () => {
    // A typo here would silently refuse everybody, since the check is an includes() against this list.
    for (const role of DESKTOP_APP_ROLES) {
      expect(ROLE_PRECEDENCE).toContain(role);
    }
  });
});
