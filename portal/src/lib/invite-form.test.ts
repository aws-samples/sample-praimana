import { describe, it, expect } from "vitest";
import {
  invitableRolesFor,
  isPlatformScopedRole,
  platformRolesByLabel,
} from "@praimana/shared";
import {
  INVITE_BLOCKED_MESSAGE,
  NO_ROLE_SELECTED,
  inviteBlockedReason,
  recipientsIncludeSelf,
  requiresWorkshop,
  submittedPlatformRole,
} from "./invite-form";

/**
 * "The platform role dropdown must be mandatory and must show a placeholder rather than a
 * default", the second defect this file pins.
 *
 * The requirement has two halves and only one of them is visible: nothing pre-selected
 * (visible), and nothing sendable until a role is chosen (not visible, and the half that
 * matters, a form that looks blocked but posts anyway would send an invitation with no
 * role for the backend to reject with an opaque error).
 */

// The two real option sets, built the same way the two render sites build them.
const teamFormOptions = (role: string) => invitableRolesFor(role);
const staffFormOptions = (role: string) =>
  invitableRolesFor(role).filter((r) => isPlatformScopedRole(r.role));

describe("submittedPlatformRole", () => {
  it("selects NOTHING before the operator picks a role", () => {
    // THE defect. Both forms used to pre-select `invitableRolesFor(role)[0]`, Participant
    // on the team form, Judge on the staff form.
    expect(submittedPlatformRole(null, teamFormOptions("ADMIN"))).toBe(
      NO_ROLE_SELECTED
    );
    expect(submittedPlatformRole(undefined, staffFormOptions("ADMIN"))).toBe(
      NO_ROLE_SELECTED
    );
    expect(submittedPlatformRole("", staffFormOptions("FACILITATOR"))).toBe(
      NO_ROLE_SELECTED
    );
  });

  it("pre-selects nothing for ANY role, on EITHER form", () => {
    // Swept across every role rather than spot-checked, so a newly added role cannot
    // reintroduce a default on one screen only.
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
      expect(submittedPlatformRole(null, teamFormOptions(role)), role).toBe(
        NO_ROLE_SELECTED
      );
      expect(submittedPlatformRole(null, staffFormOptions(role)), role).toBe(
        NO_ROLE_SELECTED
      );
    }
  });

  it("never pre-selects ADMIN on the staff form, which is the dangerous case", () => {
    // The escalation the old comments were guarding against, now impossible by
    // construction rather than by array order: /admin's Invitations tab is the one form
    // that can mint another full platform administrator.
    const options = staffFormOptions("ADMIN");
    expect(options.map((r) => r.role)).toContain("ADMIN");
    expect(submittedPlatformRole(null, options)).not.toBe("ADMIN");
    expect(submittedPlatformRole(null, options)).toBe(NO_ROLE_SELECTED);
  });

  it("is unaffected by the ALPHABETICAL display order, where Admin sorts first", () => {
    // The display list is what the dropdown renders. Feeding it in must still yield no
    // selection, the property the old code needed a separate source array to hold.
    const displayed = platformRolesByLabel(staffFormOptions("ADMIN"));
    expect(displayed[0]?.role).toBe("ADMIN");
    expect(submittedPlatformRole(null, displayed)).toBe(NO_ROLE_SELECTED);
  });

  it("keeps a role the operator actually chose", () => {
    expect(submittedPlatformRole("JUDGE", teamFormOptions("ADMIN"))).toBe("JUDGE");
    expect(submittedPlatformRole("ADMIN", staffFormOptions("ADMIN"))).toBe("ADMIN");
  });

  it("DROPS a choice the inviter may not grant", () => {
    // Convenience, not the security boundary, the Team service re-applies ROLE_GRANTS
    // against the caller's token. But collapsing to "nothing chosen" means a tampered
    // <option> or a narrowed session produces a blocked form rather than a request the
    // backend refuses with an opaque error.
    expect(submittedPlatformRole("ADMIN", staffFormOptions("FACILITATOR"))).toBe(
      NO_ROLE_SELECTED
    );
    expect(submittedPlatformRole("PARTICIPANT", teamFormOptions("JUDGE"))).toBe(
      NO_ROLE_SELECTED
    );
    expect(submittedPlatformRole("SUPERUSER", teamFormOptions("ADMIN"))).toBe(
      NO_ROLE_SELECTED
    );
    // A PARTICIPANT may grant nothing, so no selection can ever survive.
    expect(submittedPlatformRole("PARTICIPANT", teamFormOptions("PARTICIPANT"))).toBe(
      NO_ROLE_SELECTED
    );
  });

  it("drops a TEAM-scoped choice on the staff form, which filters those out", () => {
    // /admin cannot send a PARTICIPANT invitation (it has no team to attach), so a stale
    // selection of one must not be submittable there.
    expect(submittedPlatformRole("PARTICIPANT", staffFormOptions("ADMIN"))).toBe(
      NO_ROLE_SELECTED
    );
  });

  it("uses the empty string, which is what a placeholder <option value=\"\"> reports", () => {
    // The render sites bind `value={platformRole}` against an `<option value="">`, so this
    // has to be exactly "" or the placeholder would not be the selected option and the
    // browser would fall back to showing the first real role.
    expect(NO_ROLE_SELECTED).toBe("");
  });
});

describe("inviteBlockedReason", () => {
  it("blocks with NO_ROLE when a role has not been chosen", () => {
    // The new guard. Emails alone are not a sendable invitation any more.
    expect(inviteBlockedReason(NO_ROLE_SELECTED, 3)).toBe("NO_ROLE");
  });

  // FACILITATOR, not JUDGE, as the "some valid role" stand-in in the three tests below.
  // Their subject is the EMAILS rule, and JUDGE now carries a second requirement of its
  // own (a workshop) that would mask it, a judge with no addresses is blocked on the
  // workshop first, which is deliberate and covered in its own block further down. The
  // assertions are unchanged; only the role that isolates them is.
  it("still blocks with NO_EMAILS when there is nobody to invite", () => {
    expect(inviteBlockedReason("FACILITATOR", 0)).toBe("NO_EMAILS");
  });

  it("names the ROLE first when both are missing", () => {
    // Which is the empty form. The role is the field with no placeholder text of its own
    // to hint at it, so it leads.
    expect(inviteBlockedReason(NO_ROLE_SELECTED, 0)).toBe("NO_ROLE_OR_EMAILS");
  });

  it("is clear to send with a role and at least one address", () => {
    expect(inviteBlockedReason("FACILITATOR", 1)).toBeNull();
    expect(inviteBlockedReason("ADMIN", 20)).toBeNull();
  });

  it("treats a nonsense email count as NO emails, never as sendable", () => {
    // Fails closed on a count that could only arrive from a caller bug.
    expect(inviteBlockedReason("FACILITATOR", NaN)).toBe("NO_EMAILS");
    expect(inviteBlockedReason("FACILITATOR", -1)).toBe("NO_EMAILS");
  });

  it("has a message for every reason it can return", () => {
    // A reason with no message would render an empty explanation under a dead button.
    for (const reason of [
      "NO_ROLE",
      "NO_EMAILS",
      "NO_ROLE_OR_EMAILS",
      "NO_WORKSHOP",
    ] as const) {
      expect(INVITE_BLOCKED_MESSAGE[reason], reason).toBeTruthy();
    }
  });
});

/**
 * "A JUDGE invitation must NAME A WORKSHOP".
 *
 * A judge belongs to a workshop, so it must not be possible to create a judge user without
 * selecting one.
 *
 * The form half of a rule the Team service ENFORCES. Both halves matter for different
 * reasons: the service is the boundary, and this is what stops the operator filling in a
 * form that looks complete and getting an opaque 400 back.
 */
describe("requiresWorkshop", () => {
  it("demands one for a JUDGE", () => {
    expect(requiresWorkshop("JUDGE")).toBe(true);
  });

  it("demands none for the roles the backend FORBIDS one on", () => {
    // ADMIN is platform-wide by definition; a FACILITATOR sees what they create. The
    // Team service 400s a workshopId on either, so a form that demanded one would be
    // permanently unsubmittable.
    expect(requiresWorkshop("ADMIN")).toBe(false);
    expect(requiresWorkshop("FACILITATOR")).toBe(false);
  });

  it("demands none for the roles whose workshop is SERVER-DERIVED", () => {
    // These come from the team the invitation is for, so there is nothing to ask.
    expect(requiresWorkshop("PARTICIPANT")).toBe(false);
    expect(requiresWorkshop("EXECUTIVE")).toBe(false);
  });

  it("demands none while NO role is chosen, so an untouched form asks nothing", () => {
    // Whether a workshop is owed is a function of the role, so before a role exists the
    // question does not. Showing a workshop picker on first paint would be asking
    // something that may not apply, the same defect the Team role sub-dropdown had.
    expect(requiresWorkshop(NO_ROLE_SELECTED)).toBe(false);
    expect(requiresWorkshop(null)).toBe(false);
    expect(requiresWorkshop(undefined)).toBe(false);
  });

  it("demands none for an unrecognised role", () => {
    // Fails toward "no extra field demanded" rather than toward an unsubmittable form.
    // Safe because it is not the boundary: an unknown role is refused by the grant
    // matrix long before the workshop rule would matter.
    expect(requiresWorkshop("SUPERUSER")).toBe(false);
  });
});

describe("the invite action is blocked until a WORKSHOP is chosen, for a JUDGE", () => {
  it("blocks a JUDGE with a role and addresses but no workshop", () => {
    // THE requirement. Everything else about the form is complete.
    expect(inviteBlockedReason("JUDGE", 3, "")).toBe("NO_WORKSHOP");
    expect(inviteBlockedReason("JUDGE", 3, undefined)).toBe("NO_WORKSHOP");
    expect(inviteBlockedReason("JUDGE", 3, null)).toBe("NO_WORKSHOP");
  });

  it("treats a whitespace-only workshop as NOT chosen", () => {
    // Fails closed on a value that could only arrive from a caller's own state, matching
    // how the Team service trims before deciding.
    expect(inviteBlockedReason("JUDGE", 1, "   ")).toBe("NO_WORKSHOP");
  });

  it("clears once a JUDGE has a role, a workshop and an address", () => {
    expect(inviteBlockedReason("JUDGE", 1, "w-alpha")).toBeNull();
  });

  it("still names the ROLE first when nothing at all is filled in", () => {
    // A workshop cannot be demanded before a role exists to demand it for.
    expect(inviteBlockedReason(NO_ROLE_SELECTED, 0, "")).toBe("NO_ROLE_OR_EMAILS");
    expect(inviteBlockedReason(NO_ROLE_SELECTED, 3, "")).toBe("NO_ROLE");
  });

  it("names the WORKSHOP before the emails for a judge missing both", () => {
    // Deliberate ordering: a judge with no workshop is the reported dead end, while an
    // empty address list is an obviously incomplete form.
    expect(inviteBlockedReason("JUDGE", 0, "")).toBe("NO_WORKSHOP");
  });

  it("demands NO workshop from any other role, however it is called", () => {
    // The backward-compatibility guarantee: existing ADMIN and FACILITATOR invitations
    // must keep working, and PARTICIPANT/EXECUTIVE derive theirs from the team. Swept
    // across all four rather than spot-checked, and across BOTH call shapes, the team
    // form passes two arguments and must not start demanding a third.
    for (const role of ["ADMIN", "FACILITATOR", "PARTICIPANT", "EXECUTIVE"]) {
      expect(inviteBlockedReason(role, 1), role).toBeNull();
      expect(inviteBlockedReason(role, 1, ""), role).toBeNull();
      expect(inviteBlockedReason(role, 1, undefined), role).toBeNull();
    }
  });

  it("keeps the two-argument call BLOCKING for a judge, not silently sendable", () => {
    // The one case where the default parameter has to fail closed: a call site that
    // forgets to pass the workshop must produce a blocked form, never a request the
    // backend refuses with an opaque error.
    expect(inviteBlockedReason("JUDGE", 3)).toBe("NO_WORKSHOP");
  });

  it("composes with the role guard: a judge is unsendable on first paint", () => {
    // End to end, as the render sites derive it, no role chosen, no workshop chosen.
    const onFirstPaint = submittedPlatformRole(null, staffFormOptions("ADMIN"));
    expect(inviteBlockedReason(onFirstPaint, 3, "")).toBe("NO_ROLE");
    // …and choosing Judge alone is still not enough.
    expect(inviteBlockedReason("JUDGE", 3, "")).toBe("NO_WORKSHOP");
  });
});

/**
 * The guard as the render sites actually consume it: both the button's `disabled` and the
 * submit handler read the SAME `inviteBlockedReason(...)` value, so they cannot disagree
 * about what is sendable, which is the bug where a disabled-looking button still posts.
 */
describe("the invite action is blocked until a role is chosen", () => {
  const canSend = (platformRole: string, emailCount: number) =>
    inviteBlockedReason(platformRole, emailCount) === null;

  it("refuses an invitation with no role, however many addresses are queued", () => {
    // The requirement in one line.
    expect(canSend(NO_ROLE_SELECTED, 1)).toBe(false);
    expect(canSend(NO_ROLE_SELECTED, 50)).toBe(false);
  });

  it("refuses an invitation with no addresses, however clear the role", () => {
    expect(canSend("ADMIN", 0)).toBe(false);
  });

  it("allows it once both are present", () => {
    expect(canSend("PARTICIPANT", 1)).toBe(true);
  });

  it("blocks every role the forms could arrive holding untouched", () => {
    // Composed end-to-end: what the render sites derive on first paint (no selection) fed
    // straight into the guard. This is the defect as a single expression.
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE"]) {
      const onFirstPaint = submittedPlatformRole(null, teamFormOptions(role));
      expect(canSend(onFirstPaint, 3), role).toBe(false);
      const staffFirstPaint = submittedPlatformRole(null, staffFormOptions(role));
      expect(canSend(staffFirstPaint, 3), role).toBe(false);
    }
  });
});

/**
 * The team page shows a Team role sub-dropdown only for a PARTICIPANT invitation, derived
 * from `platformRole === "PARTICIPANT"`. Removing the default introduced a third state
 * that logic had never seen, so it is pinned here.
 */
describe("the participant sub-form copes with no role chosen", () => {
  const isParticipantInvite = (platformRole: string) =>
    platformRole === "PARTICIPANT";

  it("hides the Team role picker until a role is actually chosen", () => {
    // The old code defaulted to PARTICIPANT, so this dropdown was visible from first
    // paint. Asking "which team role?" before anyone has said the invitee is a
    // participant is asking a question that may not apply.
    expect(isParticipantInvite(NO_ROLE_SELECTED)).toBe(false);
  });

  it("shows it once PARTICIPANT is chosen, and only then", () => {
    expect(isParticipantInvite("PARTICIPANT")).toBe(true);
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE"]) {
      expect(isParticipantInvite(role), role).toBe(false);
    }
  });

  it("sends no teamRole while no role is chosen", () => {
    // The request body does `teamRole: isParticipantInvite ? teamRole : undefined`, so
    // "nothing chosen" must not smuggle a team role onto a platform-scoped invitation.
    const teamRole = "BUILDER";
    const sent = isParticipantInvite(NO_ROLE_SELECTED) ? teamRole : undefined;
    expect(sent).toBeUndefined();
  });
});

/**
 * ── NOBODY INVITES THEMSELVES ────────────────────────────────────────────────────────────
 *
 * THE RULE: an admin can invite any user to any experience from the Administration tab, as a
 * facilitator does, but can never add themselves to an experience.
 *
 * ⚠ THIS FILE TESTS THE COURTESY, NOT THE BOUNDARY. The Team service refuses a self-invitation
 * with 403 `SELF_INVITATION_REFUSED` on the token's VERIFIED email claim, and that is the copy
 * that matters, it is also what makes an admin's "any experience" grant safe rather than an
 * escalation. What is asserted here is that an operator is TOLD before they fill in a whole form.
 */
describe("recipientsIncludeSelf", () => {
  it("spots the caller's own address in the list", () => {
    expect(recipientsIncludeSelf(["a@example.com", "admin@example.com"], "admin@example.com")).toBe(true);
  });

  it("matches CASE-INSENSITIVELY and ignores surrounding whitespace", () => {
    // Mirrors the service's comparison exactly. A form comparing raw strings would let
    // "Admin@Example.com" past the button and into a 403 the operator cannot explain.
    expect(recipientsIncludeSelf(["  ADMIN@example.COM "], "admin@example.com")).toBe(true);
    expect(recipientsIncludeSelf(["admin@example.com"], "  Admin@Example.com  ")).toBe(true);
  });

  it("is false for a list without the caller", () => {
    expect(recipientsIncludeSelf(["someone@example.com", "other@example.com"], "admin@example.com")).toBe(false);
    expect(recipientsIncludeSelf([], "admin@example.com")).toBe(false);
  });

  it("⚠ CLAIMS NOTHING when the session carries no email", () => {
    // "We cannot tell" must not render as "you are inviting yourself", that would block a
    // legitimate invitation on a missing claim. The SERVICE still refuses an actual
    // self-invitation, and its own gate is guarded the same way.
    for (const missing of [undefined, null, "", "   "]) {
      expect(recipientsIncludeSelf(["admin@example.com"], missing), String(missing)).toBe(false);
    }
  });

  it("does NOT try to defeat plus-addressing, and that is deliberate", () => {
    // ⚠ THE LIMIT OF THIS CHECK, PINNED SO NOBODY MISTAKES IT FOR A PROOF. `admin+judge@example.com`
    // is a different address and this returns false, as does the service's gate. Normalising
    // plus-tags would break real accounts (this platform's own dev users are plus-addressed)
    // while still not catching a separate mailbox the same person controls. Email equality
    // guards the easy, accidental and auditable case; ATTRIBUTION AND AUDIT are the real
    // mitigation. Recorded in the portal BACKLOG.
    expect(recipientsIncludeSelf(["admin+judge@example.com"], "admin@example.com")).toBe(false);
  });
});

describe("inviteBlockedReason, the self-invitation reason", () => {
  it("blocks a complete, otherwise-valid judge invitation that includes the caller", () => {
    // Everything else is filled in correctly: role, workshop, one address. The ONLY problem is
    // whose address it is.
    expect(inviteBlockedReason("JUDGE", 1, "w1", true)).toBe("SELF_INVITE");
  });

  it("⚠ IS REPORTED BEFORE the missing experience, because it is the unfixable one", () => {
    // A self-invitation is refused no matter what else is filled in, so naming an experience
    // first sends the operator to fix the one thing that was not the problem, and they would
    // then hit the same 403 from the backend. Both are wrong here; SELF_INVITE must win.
    expect(inviteBlockedReason("JUDGE", 1, "", true)).toBe("SELF_INVITE");
  });

  it("still reports the MISSING ROLE first, that gate is about the form being incomplete", () => {
    // The role is checked before everything, unchanged: with no role chosen there is no
    // invitation to describe yet, self-addressed or otherwise.
    expect(inviteBlockedReason(NO_ROLE_SELECTED, 1, "w1", true)).toBe("NO_ROLE");
    expect(inviteBlockedReason(NO_ROLE_SELECTED, 0, "w1", true)).toBe("NO_ROLE_OR_EMAILS");
  });

  it("DEFAULTS TO NOT BLOCKING, so the team form's two-argument calls are unchanged", () => {
    // The fourth parameter has a default for the same reason the third did: existing call sites
    // pass fewer arguments and must keep behaving identically.
    expect(inviteBlockedReason("FACILITATOR", 1)).toBeNull();
    expect(inviteBlockedReason("JUDGE", 1, "w1")).toBeNull();
  });

  it("has an operator-facing message that says what to DO", () => {
    // The refusal is absolute, so a restatement of the rule leaves the operator stuck. The
    // message names the way forward: remove the address, ask someone else to invite you.
    const message = INVITE_BLOCKED_MESSAGE.SELF_INVITE;
    expect(message).toMatch(/remove your own address/i);
    expect(message).toMatch(/another administrator/i);
  });
});
