import { describe, it, expect } from "vitest";
import {
  isReadOnlyRole,
  READ_ONLY_ROLES,
  canSignInToWebApp,
  canAccessStaffScreens,
  landingPathForRole,
  canGrantRole,
  canInvite,
  invitableRolesFor,
  canAdministerUser,
  canManageUsers,
  canSeeUser,
  isPlatformScopedRole,
  platformRolesByLabel,
  visibleRolesFor,
  INVITABLE_PLATFORM_ROLES,
  ROLE_GRANTS,
  ROLE_PRECEDENCE,
  USER_ADMIN_GRANTS,
  USER_VISIBILITY_GRANTS,
} from "@praimana/shared";
// The render sites' own derivation of "which role will this form submit". Imported here so
// the ADMIN-is-never-pre-selected assertion tests what the forms actually do, rather than
// re-deriving it and agreeing with itself.
import { submittedPlatformRole } from "./invite-form";

// Every platform role, taken from the canonical precedence list so a newly added
// role is automatically swept into the matrix tests below rather than silently
// skipped.
const ALL_ROLES = [...ROLE_PRECEDENCE];

/**
 * Keys every JS object inherits from Object.prototype. Not roles, but a plain index
 * lookup returns something TRUTHY for each, which is the defect these pin.
 */
const INHERITED_KEYS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

// The read-only rule is the single source of truth shared by the UI (useRole),
// the admin BFF, and the backend (mirrored in authz.ts). These tests pin the
// contract so a role can't silently gain or lose write access.
describe("isReadOnlyRole", () => {
  it("treats EXECUTIVE as read-only", () => {
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
  });

  it("treats write roles as NOT read-only", () => {
    for (const role of ["ADMIN", "FACILITATOR", "PARTICIPANT", "JUDGE"]) {
      expect(isReadOnlyRole(role)).toBe(false);
    }
  });

  it("is safe for absent/unknown roles (default: not read-only, guarded elsewhere)", () => {
    expect(isReadOnlyRole(undefined)).toBe(false);
    expect(isReadOnlyRole(null)).toBe(false);
    expect(isReadOnlyRole("")).toBe(false);
    expect(isReadOnlyRole("SOMETHING_NEW")).toBe(false);
  });

  it("exposes EXECUTIVE in the canonical list", () => {
    expect(READ_ONLY_ROLES).toContain("EXECUTIVE");
  });
});

// Sign-in vs. staff access are two SEPARATE gates: every invited person registers
// and signs in through this browser app (that's the invite flow), but only staff
// may reach the workshop/team-management screens. A participant holds a real
// session confined to /welcome. These tests pin both halves so a change to one
// can't silently widen the other.
describe("web app access gates", () => {
  it("lets every recognised role sign in, participants included", () => {
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
      expect(canSignInToWebApp(role)).toBe(true);
    }
  });

  it("fails closed on an absent or unrecognised role", () => {
    for (const role of [undefined, null, "", "SOMETHING_NEW"]) {
      expect(canSignInToWebApp(role)).toBe(false);
      expect(canAccessStaffScreens(role)).toBe(false);
    }
  });

  it("keeps PARTICIPANT out of the staff screens", () => {
    expect(canAccessStaffScreens("PARTICIPANT")).toBe(false);
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE"]) {
      expect(canAccessStaffScreens(role)).toBe(true);
    }
  });

  it("lands participants on the onboarding page and staff on the workshop list", () => {
    expect(landingPathForRole("PARTICIPANT")).toBe("/welcome");
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE"]) {
      expect(landingPathForRole(role)).toBe("/experiences");
    }
  });

  it("lands an unknown role on the onboarding page, never the staff screens", () => {
    expect(landingPathForRole(undefined)).toBe("/welcome");
    expect(landingPathForRole("SOMETHING_NEW")).toBe("/welcome");
  });
});

// ─── The invitation grant matrix ────────────────────────────────────────────

/**
 * ROLE_GRANTS decides who may hand out which platform role by invitation. It is a
 * privilege-escalation boundary, not display logic: an invitation row is what the
 * Cognito pre-signup trigger consults to admit a registration and what
 * post-confirmation consults to assign the Cognito GROUP. So "may grant ADMIN"
 * means "may create an admin".
 *
 * The Team service holds a deliberate copy (the team service's `routes.ts`,
 * asserted by its own routes.test.ts) because bundled Lambdas take no dependency
 * on this package. These tests pin THIS copy; the two suites together are what
 * keep them from drifting.
 */
describe("canGrantRole", () => {
  it("lets an ADMIN grant every role, including ADMIN", () => {
    for (const target of ROLE_PRECEDENCE) {
      expect(canGrantRole("ADMIN", target), `ADMIN → ${target}`).toBe(true);
    }
  });

  it("lets a FACILITATOR grant everything EXCEPT ADMIN", () => {
    for (const target of ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      expect(canGrantRole("FACILITATOR", target), `FACILITATOR → ${target}`).toBe(true);
    }
    // The one that matters: a facilitator must not be able to manufacture a peer
    // with full platform access.
    expect(canGrantRole("FACILITATOR", "ADMIN")).toBe(false);
  });

  it("limits an EXECUTIVE to PARTICIPANT only, not fellow observers", () => {
    // EXECUTIVE was withdrawn from the allowed set: an executive
    // minting another executive grows a read-only role nobody staffed deliberately,
    // and since registration became admin-provisioned each invitation creates a real
    // Cognito account rather than merely recording a permission.
    expect(canGrantRole("EXECUTIVE", "PARTICIPANT")).toBe(true);
    for (const target of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE"]) {
      expect(canGrantRole("EXECUTIVE", target), `EXECUTIVE → ${target}`).toBe(false);
    }
  });

  it("lets a JUDGE grant NOTHING, judging is an assignment, not a club", () => {
    // Judges could previously recruit fellow judges. Withdrawn; a judge is
    // now as closed as a participant.
    for (const target of ["ADMIN", "FACILITATOR", "EXECUTIVE", "PARTICIPANT", "JUDGE"]) {
      expect(canGrantRole("JUDGE", target), `JUDGE → ${target}`).toBe(false);
    }
  });

  it("lets a PARTICIPANT grant NOTHING, not even another participant", () => {
    for (const target of ROLE_PRECEDENCE) {
      expect(canGrantRole("PARTICIPANT", target), `PARTICIPANT → ${target}`).toBe(false);
    }
  });

  it("fails closed on absent or unrecognised roles", () => {
    expect(canGrantRole(undefined, "PARTICIPANT")).toBe(false);
    expect(canGrantRole(null, "PARTICIPANT")).toBe(false);
    expect(canGrantRole("", "PARTICIPANT")).toBe(false);
    expect(canGrantRole("SUPERUSER", "PARTICIPANT")).toBe(false);
    // An unrecognised TARGET is refused too, so junk never reaches the table.
    expect(canGrantRole("ADMIN", "ROOT")).toBe(false);
    expect(canGrantRole("ADMIN", undefined)).toBe(false);
  });

  it("never grants a role outside the known set", () => {
    // Guards against a future edit adding a typo'd role to a grant list.
    for (const [inviter, grantable] of Object.entries(ROLE_GRANTS)) {
      for (const target of grantable) {
        expect(ROLE_PRECEDENCE, `${inviter} → ${target}`).toContain(target);
      }
    }
  });
});

describe("canInvite", () => {
  it("is true for every role that can grant something", () => {
    // JUDGE dropped out of this set, its grant list is now empty, so
    // canInvite() must read it as closed exactly like PARTICIPANT.
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE"]) {
      expect(canInvite(role), role).toBe(true);
    }
  });

  it("is false for a PARTICIPANT and for unknown/absent roles", () => {
    expect(canInvite("PARTICIPANT")).toBe(false);
    expect(canInvite(undefined)).toBe(false);
    expect(canInvite("SUPERUSER")).toBe(false);
  });

  it("agrees with ROLE_GRANTS rather than hardcoding a list", () => {
    for (const [role, grantable] of Object.entries(ROLE_GRANTS)) {
      expect(canInvite(role), role).toBe(grantable.length > 0);
    }
  });
});

describe("invitableRolesFor", () => {
  it("offers a facilitator every role except Admin", () => {
    expect(invitableRolesFor("FACILITATOR").map((r) => r.role)).toEqual([
      "PARTICIPANT",
      "JUDGE",
      "EXECUTIVE",
      "FACILITATOR",
    ]);
  });

  it("offers a judge nothing, so the UI hides the invite form entirely", () => {
    expect(invitableRolesFor("JUDGE")).toEqual([]);
  });

  it("offers a participant nothing, so the UI can hide the invite form", () => {
    expect(invitableRolesFor("PARTICIPANT")).toEqual([]);
    expect(invitableRolesFor(undefined)).toEqual([]);
  });

  it("preserves INVITABLE_PLATFORM_ROLES display order and stays consistent with canGrantRole", () => {
    const offered = invitableRolesFor("ADMIN").map((r) => r.role);
    expect(offered).toEqual(INVITABLE_PLATFORM_ROLES.map((r) => r.role));
    // Anything offered must be grantable, the dropdown can never show a role the
    // backend would 403.
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
      for (const offeredRole of invitableRolesFor(role)) {
        expect(canGrantRole(role, offeredRole.role), `${role} → ${offeredRole.role}`).toBe(true);
      }
    }
  });
});

/**
 * The DISPLAY order of the platform-role dropdown, which is meant to be
 * alphabetical, and the guarantee that making it alphabetical did not change what an
 * invite form SENDS.
 *
 * The two used to be in direct tension: every invite form derived its pre-selected role
 * from `invitableRolesFor(role)[0]`, so "sort the roles alphabetically" and "leave the
 * default alone" could only both hold if the sort happened to a COPY at the render site.
 *
 * THAT TENSION IS NOW GONE, and it was resolved in the safer direction: the platform
 * role is now a MANDATORY choice with a "Select a role…"
 * placeholder, so neither invite form pre-selects anything at all. `[0]` is no longer a
 * default anybody reads, see lib/invite-form.ts and its tests, which pin "nothing
 * pre-selected" directly.
 *
 * These tests are kept, and their SUBJECT has changed rather than relaxed. What they now
 * pin is that INVITABLE_PLATFORM_ROLES' order is stable and that sorting is
 * non-destructive, the array is still the canonical list every screen reads roles and
 * labels out of, and `platformRolesByLabel` still mutating it in place would reorder the
 * options on every screen from a call that looks read-only. The one assertion that has
 * become STRONGER rather than obsolete is "Admin is not the pre-selected role": it used
 * to hold because Admin happened not to sort first in the source array; it now holds
 * because there is no pre-selected role to be Admin.
 */
describe("platformRolesByLabel", () => {
  it("orders an admin's options Admin → Executive → Facilitator → Judge → Participant", () => {
    // The literal required order, spelled out rather than computed,
    // so this test states the requirement instead of restating the implementation.
    expect(
      platformRolesByLabel(invitableRolesFor("ADMIN")).map((r) => r.label)
    ).toEqual(["Admin", "Executive", "Facilitator", "Judge", "Participant"]);
  });

  it("sorts whatever subset a role may grant, without inventing options", () => {
    // A facilitator may not grant ADMIN, so Admin must not appear just because it sorts
    // first alphabetically.
    expect(
      platformRolesByLabel(invitableRolesFor("FACILITATOR")).map((r) => r.label)
    ).toEqual(["Executive", "Facilitator", "Judge", "Participant"]);

    // A judge grants nothing, so there is no subset to sort.
    expect(platformRolesByLabel(invitableRolesFor("JUDGE"))).toEqual([]);

    // A participant may grant nothing, and an empty list must stay empty rather than
    // falling back to the full set.
    expect(platformRolesByLabel(invitableRolesFor("PARTICIPANT"))).toEqual([]);
  });

  // THE SOURCE ORDER, still pinned, but as the CANONICAL LIST rather than as a set of
  // defaults.
  //
  // These are no longer pre-selected values: the invite forms pre-select nothing (see
  // lib/invite-form.test.ts, which asserts that directly and for every role). What this
  // test now protects is that `platformRolesByLabel` sorts a COPY, if it ever sorted in
  // place, the constant would arrive here alphabetised and every expectation below would
  // shift by one, which is the mutation the next test also chases from the other side.
  //
  // Kept as literals rather than computed from the constant, so the test states an
  // expected order instead of agreeing with whatever the constant currently says.
  it("keeps INVITABLE_PLATFORM_ROLES in its documented source order", () => {
    const EXPECTED_FIRST: Record<string, string | undefined> = {
      ADMIN: "PARTICIPANT",
      FACILITATOR: "PARTICIPANT",
      EXECUTIVE: "PARTICIPANT",
      JUDGE: undefined, // grants nothing, like a participant
      PARTICIPANT: undefined, // grants nothing, so the list is empty
    };

    for (const [role, expected] of Object.entries(EXPECTED_FIRST)) {
      expect(invitableRolesFor(role)[0]?.role, `first offered for ${role}`).toBe(
        expected
      );
    }
  });

  // THE REGRESSION THIS WHOLE HELPER EXISTS TO PREVENT, restated for the world where
  // there is no default: ADMIN must never be the role an invite form arrives holding.
  //
  // It used to hold for a fragile reason, Admin happens to sit LAST in the source array,
  // so `[0]` was not Admin, which is why re-sorting that array was a privilege change
  // disguised as a cosmetic edit. It now holds for a structural one: no invite form
  // pre-selects anything, so there is nothing for an ordering to escalate. Asserted from
  // BOTH the source order and the alphabetical display order, since the display order is
  // the one where Admin genuinely comes first.
  it("never lets ADMIN be the role an invite form starts on", () => {
    const platformScoped = (role: string) =>
      invitableRolesFor(role).filter((r) => isPlatformScopedRole(r.role));

    // Alphabetically, Admin IS first, that is the whole hazard.
    expect(platformRolesByLabel(platformScoped("ADMIN"))[0]?.role).toBe("ADMIN");

    // And it is still not what either form submits untouched, because they submit nothing
    // untouched. `submittedPlatformRole(null, …)` is the render sites' derivation.
    for (const options of [
      platformScoped("ADMIN"),
      platformRolesByLabel(platformScoped("ADMIN")),
      invitableRolesFor("ADMIN"),
      platformRolesByLabel(invitableRolesFor("ADMIN")),
    ]) {
      expect(submittedPlatformRole(null, options)).toBe("");
      expect(submittedPlatformRole(null, options)).not.toBe("ADMIN");
    }

    // A facilitator cannot reach ADMIN by any route, sorted or not.
    expect(platformScoped("FACILITATOR").map((r) => r.role)).not.toContain("ADMIN");
    expect(submittedPlatformRole("ADMIN", platformScoped("FACILITATOR"))).toBe("");
  });

  it("leaves the caller's array, and the shared constant, unmutated", () => {
    // Array.prototype.sort sorts IN PLACE. Sorting the constant itself would reorder the
    // options on every screen in the app, from a call that looks read-only, and would
    // reorder the CANONICAL role list that roleLabel() and the invite API read too.
    const before = INVITABLE_PLATFORM_ROLES.map((r) => r.role);
    const input = invitableRolesFor("ADMIN");

    platformRolesByLabel(input);

    expect(input.map((r) => r.role)).toEqual(before);
    expect(INVITABLE_PLATFORM_ROLES.map((r) => r.role)).toEqual(before);
    expect(before[0]).toBe("PARTICIPANT");
  });

  /**
   * The Administration → Invitations tab, whose option list is the invitable roles
   * NARROWED to the platform-scoped ones (Admin/Facilitator/Judge, a participant or
   * executive invitation needs a team, so that screen filters them out).
   *
   * This was the sharpest case for the old default: an ADMIN's platform-scoped options are
   * Judge, Facilitator, Admin in source order, so `[0]` was JUDGE, the least privileged
   * of the three, while alphabetically "Admin" sorts first, so re-ordering the source
   * array would have made ADMIN the pre-selected role on the one form that can mint
   * another full platform administrator.
   *
   * The form now pre-selects NOTHING, which retires the hazard rather than balancing it
   * (pinned above in "never lets ADMIN be the role an invite form starts on", and in
   * lib/invite-form.test.ts). What is still worth pinning here is the OFFER: exactly the
   * three platform-scoped roles, alphabetical, and never Admin for a facilitator, the
   * display requirement, which is unchanged.
   */
  it("offers the staff-invite roles alphabetically, and never Admin to a facilitator", () => {
    const platformScoped = (role: string) =>
      invitableRolesFor(role).filter((r) => isPlatformScopedRole(r.role));

    // What the dropdown READS, which is the requirement.
    expect(platformRolesByLabel(platformScoped("ADMIN")).map((r) => r.label)).toEqual([
      "Admin",
      "Facilitator",
      "Judge",
    ]);
    // A facilitator still never sees Admin, however the list is sorted.
    expect(platformRolesByLabel(platformScoped("FACILITATOR")).map((r) => r.label)).toEqual([
      "Facilitator",
      "Judge",
    ]);

    // The narrowing itself: a team-scoped role must not reach this form, which has no team
    // to attach the invitation to.
    for (const role of ["ADMIN", "FACILITATOR"]) {
      for (const option of platformScoped(role)) {
        expect(isPlatformScopedRole(option.role), `${role} → ${option.role}`).toBe(true);
      }
    }
  });

  it("offers exactly the roles the inviter may grant, in a different order", () => {
    // Sorting must be a PERMUTATION, it may not add, drop or duplicate an option, or
    // the dropdown would show a role the backend then refuses.
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
      const offered = invitableRolesFor(role);
      const sorted = platformRolesByLabel(offered);
      expect(sorted).toHaveLength(offered.length);
      expect([...sorted].map((r) => r.role).sort()).toEqual(
        [...offered].map((r) => r.role).sort()
      );
      for (const option of sorted) {
        expect(canGrantRole(role, option.role), `${role} → ${option.role}`).toBe(true);
      }
    }
  });
});

// Administering an EXISTING account (change role / revoke access) is a stricter
// boundary than inviting someone new, and these tests exist mainly to stop the two
// from being "simplified" into one table. The distinguishing case is
// FACILITATOR → FACILITATOR: legal to INVITE, illegal to ADMINISTER.
describe("canAdministerUser", () => {
  it("lets an ADMIN administer every role, peers included", () => {
    for (const target of ALL_ROLES) {
      expect(canAdministerUser("ADMIN", target), target).toBe(true);
    }
  });

  it("lets a FACILITATOR administer only STRICTLY LOWER roles", () => {
    expect(canAdministerUser("FACILITATOR", "JUDGE")).toBe(true);
    expect(canAdministerUser("FACILITATOR", "EXECUTIVE")).toBe(true);
    expect(canAdministerUser("FACILITATOR", "PARTICIPANT")).toBe(true);
  });

  it("does NOT let a FACILITATOR touch an ADMIN", () => {
    expect(canAdministerUser("FACILITATOR", "ADMIN")).toBe(false);
  });

  // The whole reason USER_ADMIN_GRANTS is not ROLE_GRANTS. Inviting a peer
  // facilitator is harmless; disabling or demoting one mid-workshop is a lateral
  // attack.
  it("does NOT let a FACILITATOR touch ANOTHER FACILITATOR, even though they may invite one", () => {
    expect(canGrantRole("FACILITATOR", "FACILITATOR")).toBe(true);
    expect(canAdministerUser("FACILITATOR", "FACILITATOR")).toBe(false);
  });

  it("lets EXECUTIVE, JUDGE and PARTICIPANT administer nobody", () => {
    for (const actor of ["EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
      for (const target of ALL_ROLES) {
        expect(canAdministerUser(actor, target), `${actor} → ${target}`).toBe(false);
      }
    }
  });

  it("fails closed on an absent or unknown ACTOR role", () => {
    expect(canAdministerUser(undefined, "PARTICIPANT")).toBe(false);
    expect(canAdministerUser(null, "PARTICIPANT")).toBe(false);
    expect(canAdministerUser("", "PARTICIPANT")).toBe(false);
    expect(canAdministerUser("SUPERUSER", "PARTICIPANT")).toBe(false);
  });

  // An unknown TARGET matters just as much: if a new, more privileged role is added
  // and USER_ADMIN_GRANTS isn't updated, nobody may touch those accounts until
  // someone decides deliberately. Silently allowing it would be the escalation.
  it("fails closed on an absent or unknown TARGET role", () => {
    expect(canAdministerUser("ADMIN", undefined)).toBe(false);
    expect(canAdministerUser("ADMIN", null)).toBe(false);
    expect(canAdministerUser("ADMIN", "")).toBe(false);
    expect(canAdministerUser("ADMIN", "OWNER")).toBe(false);
  });

  it("agrees with USER_ADMIN_GRANTS rather than hardcoding a list", () => {
    for (const [actor, administrable] of Object.entries(USER_ADMIN_GRANTS)) {
      for (const target of ALL_ROLES) {
        expect(canAdministerUser(actor, target), `${actor} → ${target}`).toBe(
          (administrable as readonly string[]).includes(target)
        );
      }
    }
  });

  // Administering is never BROADER than inviting: every role someone may administer
  // must be one they could have granted. This holds today and should keep holding -
  // if it ever fails, the escalation is that revoking became a way to reach a role
  // you were not trusted to hand out.
  it("is never broader than the invitation matrix", () => {
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        if (canAdministerUser(actor, target)) {
          expect(canGrantRole(actor, target), `${actor} → ${target}`).toBe(true);
        }
      }
    }
  });
});

describe("canManageUsers", () => {
  it("admits ADMIN and FACILITATOR to the Administration area", () => {
    expect(canManageUsers("ADMIN")).toBe(true);
    expect(canManageUsers("FACILITATOR")).toBe(true);
  });

  // Narrower than canAccessStaffScreens, which admits these two as well, a judge
  // scores and an executive observes; neither manages accounts.
  it("keeps JUDGE and EXECUTIVE out, even though they reach the staff screens", () => {
    for (const role of ["JUDGE", "EXECUTIVE"]) {
      expect(canAccessStaffScreens(role), role).toBe(true);
      expect(canManageUsers(role), role).toBe(false);
    }
  });

  it("keeps participants and unknown/absent roles out", () => {
    expect(canManageUsers("PARTICIPANT")).toBe(false);
    expect(canManageUsers(undefined)).toBe(false);
    expect(canManageUsers(null)).toBe(false);
    expect(canManageUsers("SUPERUSER")).toBe(false);
  });

  it("agrees with USER_ADMIN_GRANTS rather than hardcoding a list", () => {
    for (const [role, administrable] of Object.entries(USER_ADMIN_GRANTS)) {
      expect(canManageUsers(role), role).toBe(administrable.length > 0);
    }
  });
});

// The directory VISIBILITY matrix, "whom may I know about", as opposed to
// USER_ADMIN_GRANTS' "whom may I act on". The two are close enough to be conflated
// by a later change, so these tests pin the specific places they DIVERGE.
describe("canSeeUser", () => {
  it("shows an ADMIN every role", () => {
    for (const target of ALL_ROLES) {
      expect(canSeeUser("ADMIN", target), target).toBe(true);
    }
  });

  it("hides ADMIN accounts from a FACILITATOR", () => {
    // The requirement this whole matrix exists for: enumerating who holds full
    // platform access is reconnaissance a facilitator never needs.
    expect(canSeeUser("FACILITATOR", "ADMIN")).toBe(false);
  });

  it("still shows a FACILITATOR their peers and juniors", () => {
    // Where visibility deliberately EXCEEDS authority. Deriving this matrix from
    // USER_ADMIN_GRANTS would hide a facilitator's own row and every peer's, making
    // the directory useless for "who is on this workshop".
    for (const target of ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      expect(canSeeUser("FACILITATOR", target), target).toBe(true);
      // ...and for a peer facilitator, seeing is explicitly NOT administering.
    }
    expect(canAdministerUser("FACILITATOR", "FACILITATOR")).toBe(false);
    expect(canSeeUser("FACILITATOR", "FACILITATOR")).toBe(true);
  });

  it("shows nobody to the roles that cannot reach the directory", () => {
    for (const actor of ["JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      for (const target of ALL_ROLES) {
        expect(canSeeUser(actor, target), `${actor} → ${target}`).toBe(false);
      }
    }
  });

  it("fails closed on absent and unrecognised roles on either side", () => {
    // For a visibility rule, failing closed means a row of an unknown role is HIDDEN.
    // The opposite default would expose a newly added privileged role the day it
    // was created.
    expect(canSeeUser(undefined, "PARTICIPANT")).toBe(false);
    expect(canSeeUser(null, "PARTICIPANT")).toBe(false);
    expect(canSeeUser("SUPERUSER", "PARTICIPANT")).toBe(false);
    expect(canSeeUser("ADMIN", "SUPERUSER")).toBe(false);
    expect(canSeeUser("ADMIN", undefined)).toBe(false);
  });

  // Visibility must never be NARROWER than authority: a role you may act on but
  // cannot see is an unusable, invisible action, the row would simply not be there.
  it("is never narrower than the administration matrix", () => {
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        if (canAdministerUser(actor, target)) {
          expect(canSeeUser(actor, target), `${actor} → ${target}`).toBe(true);
        }
      }
    }
  });
});

describe("visibleRolesFor", () => {
  it("returns the matrix row, which is what the store filters on", () => {
    for (const [role, visible] of Object.entries(USER_VISIBILITY_GRANTS)) {
      expect(visibleRolesFor(role), role).toEqual(visible);
    }
  });

  it("returns an EMPTY list for absent and unrecognised roles", () => {
    // The identity repository must treat [] as "return no users". If it ever read
    // an empty list as "no filter to apply", this closed case would invert into
    // total exposure, which is why the emptiness is asserted here explicitly.
    expect(visibleRolesFor(undefined)).toEqual([]);
    expect(visibleRolesFor(null)).toEqual([]);
    expect(visibleRolesFor("SUPERUSER")).toEqual([]);
  });

  /**
   * INHERITED KEYS ARE UNRECOGNISED ROLES, and both functions must say so rather than
   * returning something truthy or throwing.
   *
   * A plain index walks the prototype chain, so before the own-property check
   * `USER_VISIBILITY_GRANTS["constructor"]` was a FUNCTION and `["__proto__"]` an object -
   * both TRUTHY, so neither the `if (!visible)` guard nor `?? []` fired:
   *
   *   visibleRolesFor("constructor") returned a function where the signature promises an
   *     array, and where the contract says [] means "see nobody". A caller spreading it or
   *     reading `.length` got nonsense instead of the closed case.
   *   canSeeUser("constructor", "ADMIN") threw `TypeError: visible.includes is not a
   *     function`, a 500 out of an authorization predicate.
   *
   * Not reachable from either live call site today (collapseGroupsToRole emits only the
   * five declared roles, and every gate exact-matches first), so this pins the closed case
   * for a FUTURE caller that passes a role straight from a claim, header or query
   * parameter, which is what eventually happens to a shared authz helper.
   *
   * `toEqual([])` alone would pass for a function, since vitest compares own enumerable
   * properties and a function has none, so the array-ness is asserted explicitly.
   */
  it("treats INHERITED object keys as unrecognised, never truthy and never throwing", () => {
    for (const key of INHERITED_KEYS) {
      const visible = visibleRolesFor(key);
      expect(Array.isArray(visible), `${key} must be an array`).toBe(true);
      expect(visible, key).toEqual([]);

      // The predicate must ANSWER, not throw, and the answer must be "no".
      for (const target of ALL_ROLES) {
        expect(() => canSeeUser(key, target)).not.toThrow();
        expect(canSeeUser(key, target), `${key} → ${target}`).toBe(false);
      }
      // And an inherited key as the TARGET is equally not a visible role.
      for (const actor of ALL_ROLES) {
        expect(() => canSeeUser(actor, key)).not.toThrow();
        expect(canSeeUser(actor, key), `${actor} → ${key}`).toBe(false);
      }
    }
  });
});

/**
 * EVERY grant predicate in the shared table must read an INHERITED KEY as an unrecognised
 * role. All five read one of three matrices, and all five indexed them directly before
 * `grantRow`, which walks the PROTOTYPE CHAIN, so `table["constructor"]` is a FUNCTION and
 * `table["__proto__"]` an object, both TRUTHY.
 *
 * The two shapes of guard failed in OPPOSITE directions, which is why this is one block
 * rather than a note on the visibility test:
 *
 *   `!!row && row.length > 0` FAILED OPEN. A function has a `length` (its arity), so
 *     canInvite("constructor") and canManageUsers("hasOwnProperty") both returned TRUE -
 *     measured, not theorised. canInvite gates the route that writes `platformRole` on an
 *     invitation, and since registration became admin-provisioned an invitation CREATES a
 *     Cognito account; canManageUsers gates the Administration area.
 *   `row.includes(target)` THREW. `TypeError: … is not a function` out of an authorization
 *     predicate is a 500 where a refusal belongs.
 *
 * Not reachable today, every role reaching these comes from collapseGroupsToRole, which
 * emits only the five declared roles, so this pins the closed case for a future caller
 * that passes a role from a claim, header or query parameter. Two of the five failing OPEN
 * is why it was worth closing rather than documenting.
 */
describe("grant predicates reject inherited object keys", () => {
  const BOOLEAN_PAIRS = [
    ["canGrantRole", canGrantRole],
    ["canAdministerUser", canAdministerUser],
    ["canSeeUser", canSeeUser],
  ] as const;

  const BOOLEAN_SINGLES = [
    ["canInvite", canInvite],
    ["canManageUsers", canManageUsers],
  ] as const;

  it("refuses an inherited key as the ACTOR, in both directions, without throwing", () => {
    for (const key of INHERITED_KEYS) {
      for (const [name, fn] of BOOLEAN_SINGLES) {
        expect(() => fn(key), `${name}(${key})`).not.toThrow();
        // ⚠ THE FAIL-OPEN CASE. Before grantRow these returned true for "constructor"
        // and "hasOwnProperty", admitting an unknown role to a privilege boundary.
        expect(fn(key), `${name}(${key}) must be false`).toBe(false);
      }
      for (const [name, fn] of BOOLEAN_PAIRS) {
        for (const target of ALL_ROLES) {
          expect(() => fn(key, target), `${name}(${key},${target})`).not.toThrow();
          expect(fn(key, target), `${name}(${key} → ${target})`).toBe(false);
        }
      }
    }
  });

  it("refuses an inherited key as the TARGET for every real actor", () => {
    for (const key of INHERITED_KEYS) {
      for (const [name, fn] of BOOLEAN_PAIRS) {
        for (const actor of ALL_ROLES) {
          expect(() => fn(actor, key), `${name}(${actor},${key})`).not.toThrow();
          expect(fn(actor, key), `${name}(${actor} → ${key})`).toBe(false);
        }
      }
    }
  });

  it("still answers correctly for the DECLARED roles, this is not over-suppression", () => {
    // The companion to the two above: a fix that refused everything would pass them and
    // break the platform. ADMIN must still be able to grant, administer and see.
    expect(canInvite("ADMIN")).toBe(true);
    expect(canManageUsers("ADMIN")).toBe(true);
    expect(canGrantRole("ADMIN", "ADMIN")).toBe(true);
    expect(canAdministerUser("ADMIN", "PARTICIPANT")).toBe(true);
    expect(canSeeUser("ADMIN", "ADMIN")).toBe(true);
    // And the deliberate refusals stay refusals.
    expect(canGrantRole("FACILITATOR", "ADMIN")).toBe(false);
    expect(canSeeUser("FACILITATOR", "ADMIN")).toBe(false);
    expect(canInvite("PARTICIPANT")).toBe(false);
    expect(canManageUsers("JUDGE")).toBe(false);
  });

  it("agrees with canSeeUser for every pair", () => {
    for (const actor of [...ALL_ROLES, "SUPERUSER", undefined]) {
      const visible = visibleRolesFor(actor);
      for (const target of ALL_ROLES) {
        expect(visible.includes(target), `${actor} → ${target}`).toBe(
          canSeeUser(actor, target)
        );
      }
    }
  });
});
