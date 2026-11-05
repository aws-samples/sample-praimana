import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canAdministerUser,
  isReadOnlyRole,
  isUserDeactivated,
  USER_ADMIN_GRANTS,
  type UserRole,
} from "@praimana/shared";

/**
 * WHO IS OFFERED THE TWO ACCESS-AFFECTING CONTROLS, Disable/Restore on the Administration
 * directory, and Remove on a team roster.
 *
 * ── WHY THIS FILE IS SHAPED LIKE THIS ──
 * Both gates live inside "use client" page components: the Administration row's is a private
 * `reason` ternary in app/admin/page.tsx, and the roster's is an inline
 * `canRemoveMembers && !isSelf` in the team page. The portal suite runs in `node` with no
 * jsdom, no @testing-library and no happy-dom, `vitest.config.ts` says
 * `environment: "node"` and `include: ["src/**\/*.test.ts"]`, so a rendered-component test
 * is not merely inconvenient here, it is not executable at all.
 *
 * So each gate is covered TWICE, and the two halves do different jobs:
 *
 *   1. A MIRROR of the composition, driven from the real shared predicates and the real
 *      USER_ADMIN_GRANTS table. This is where the matrix is proved, including the lateral
 *      cases that matter (a FACILITATOR must never be offered the control on an ADMIN or on
 *      a fellow FACILITATOR), and it is derived rather than hardcoded, so it tracks the
 *      table if the table changes. Same convention as lib/admin-scope.test.ts.
 *   2. A SOURCE PIN on the real page, so the mirror cannot silently stop describing it.
 *      A mirror alone would keep passing while the page it mirrors was rewritten; these
 *      assertions fail if the composition, the predicate, or the compared field changes.
 *      Same convention as the structural half of lib/idle-timeout.test.ts.
 *
 * NEITHER HALF is a security boundary and this file does not pretend otherwise. Every
 * service route is mapped ANY behind a JWT authorizer that does no role scoping and the
 * browser holds its own token, so what is asserted here is what the operator is OFFERED.
 * The user-access service re-resolves the target's role from Cognito Groups and re-applies
 * USER_ADMIN_GRANTS, and requireTeamWrite refuses a read-only caller regardless, those are
 * asserted in their own suites, against the HTTP surface that actually enforces them.
 */

const ALL_ROLES = Object.keys(USER_ADMIN_GRANTS) as UserRole[];

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * The CODE of a file, with comments stripped.
 *
 * Load-bearing for these pages specifically: both carry long design notes that name the
 * very identifiers being asserted (`isUserDeactivated`, `member.userId`, `returnToFallback`)
 * in prose. Matching raw source would let a comment satisfy an assertion about behaviour,
 * which is worse than no assertion. The `(?<!:)` keeps a `https://` in a string from
 * swallowing the rest of its line.
 */
const readCode = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const ADMIN_PAGE = "../app/admin/page.tsx";
const TEAM_PAGE = "../app/w/[workshopId]/t/[teamId]/team/page.tsx";

// ─── The Administration row's gate ──────────────────────────────────────────────

/**
 * Mirrors the `reason` ternary in app/admin/page.tsx (UserRow).
 *
 * Returns the sentence explaining why the row is inactionable, or `null`, and `null` is
 * the whole point: the page renders the Disable/Restore button on exactly
 * `reason === null`, so this function IS the gate.
 */
function inactionableReason(
  actorRole: string | null | undefined,
  user: { hasAccount: boolean; isSelf: boolean; role: string | undefined }
): string | null {
  return !user.hasAccount
    ? "No sign-in account, profile record only"
    : user.isSelf
      ? "This is you, you cannot change your own access"
      : !canAdministerUser(actorRole, user.role)
        ? `Your role cannot manage a ${user.role}`
        : null;
}

/** The predicate the page derives from it: is the access control rendered on this row? */
const offersAccessControl = (
  actorRole: string | null | undefined,
  user: { hasAccount: boolean; isSelf: boolean; role: string | undefined }
) => inactionableReason(actorRole, user) === null;

/** An ordinary other-person row holding `role`, so only the matrix decides. */
const otherRow = (role: string | undefined) => ({
  hasAccount: true,
  isSelf: false,
  role,
});

describe("who is offered Disable/Restore on an Administration row", () => {
  it("offers it exactly where USER_ADMIN_GRANTS does, for EVERY actor and target", () => {
    // Derived from the table rather than a hardcoded list, so a deliberate change to the
    // matrix moves this test with it and an ACCIDENTAL divergence in the page's
    // composition does not. This is the assertion the whole file exists for.
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        const permitted = (
          USER_ADMIN_GRANTS[actor] as readonly string[]
        ).includes(target);
        expect(
          offersAccessControl(actor, otherRow(target)),
          `${actor} acting on ${target}`
        ).toBe(permitted);
      }
    }
  });

  it("NEVER offers a FACILITATOR the control on an ADMIN row", () => {
    // Reconnaissance-then-escalation in one click: a facilitator who could disable an
    // admin could remove the only role able to undo it. (Admins are additionally invisible
    // to a facilitator in the directory, USER_VISIBILITY_GRANTS, so this is the second
    // of two independent reasons the row must carry no button.)
    expect(offersAccessControl("FACILITATOR", otherRow("ADMIN"))).toBe(false);
    expect(inactionableReason("FACILITATOR", otherRow("ADMIN"))).toContain(
      "cannot manage"
    );
  });

  it("NEVER offers a FACILITATOR the control on ANOTHER FACILITATOR, the lateral attack", () => {
    // The entire reason USER_ADMIN_GRANTS is a separate table from ROLE_GRANTS: inviting a
    // peer is harmless, but disabling one mid-workshop is a takeover. `strictly lower` is
    // the rule, and "peer" is the case a matrix written from ROLE_GRANTS would get wrong.
    expect(offersAccessControl("FACILITATOR", otherRow("FACILITATOR"))).toBe(false);
  });

  it("offers a FACILITATOR the control on a JUDGE, an EXECUTIVE and a PARTICIPANT", () => {
    // The positive half, asserted so a fix for the two cases above cannot be "deny
    // everything", which would silently restore the defect this screen was built to fix
    // (a facilitator shown an explanation with no action).
    expect(offersAccessControl("FACILITATOR", otherRow("JUDGE"))).toBe(true);
    expect(offersAccessControl("FACILITATOR", otherRow("EXECUTIVE"))).toBe(true);
    expect(offersAccessControl("FACILITATOR", otherRow("PARTICIPANT"))).toBe(true);
  });

  it("offers EXECUTIVE, JUDGE and PARTICIPANT the control on NOBODY", () => {
    // Belt and braces, they cannot reach /admin at all (canManageUsers, plus the
    // middleware route gate), but an empty grant list must behave identically to a
    // missing one, and a row-level gate that fell open for them would be reachable the
    // moment someone widened the route.
    for (const actor of ["EXECUTIVE", "JUDGE", "PARTICIPANT"] as const) {
      for (const target of ALL_ROLES) {
        expect(
          offersAccessControl(actor, otherRow(target)),
          `${actor} acting on ${target}`
        ).toBe(false);
      }
    }
  });

  it("offers it to nobody on their OWN row, including an ADMIN acting on themselves", () => {
    // ADMIN may administer ADMIN, so the matrix alone WOULD offer this. The self-exclusion
    // is what stops an admin locking themselves out of the screen they are standing on,
    // and the user-access service refuses it independently (SELF_ACTION_REFUSED).
    for (const actor of ALL_ROLES) {
      expect(
        offersAccessControl(actor, { hasAccount: true, isSelf: true, role: actor }),
        actor
      ).toBe(false);
    }
    expect(
      inactionableReason("ADMIN", { hasAccount: true, isSelf: true, role: "ADMIN" })
    ).toContain("This is you");
  });

  it("offers it to nobody on a row with NO SIGN-IN ACCOUNT, whatever the matrix says", () => {
    // A profile row with no Cognito account behind it (the post-confirmation trigger's
    // `sub || ulid()` fallback) has nothing to disable, so the button would 404 or worse
    // act on a ULID that is not a sub.
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        expect(
          offersAccessControl(actor, { hasAccount: false, isSelf: false, role: target }),
          `${actor} acting on account-less ${target}`
        ).toBe(false);
      }
    }
  });

  it("fails CLOSED on an unknown or absent role on EITHER side", () => {
    // An unknown TARGET matters as much as an unknown actor: if a more privileged role is
    // added and USER_ADMIN_GRANTS is not updated, those accounts must be untouchable until
    // someone makes a deliberate decision, not administrable by default.
    expect(offersAccessControl("ADMIN", otherRow("SUPERUSER"))).toBe(false);
    expect(offersAccessControl("ADMIN", otherRow(undefined))).toBe(false);
    expect(offersAccessControl("ADMIN", otherRow(""))).toBe(false);
    expect(offersAccessControl(undefined, otherRow("PARTICIPANT"))).toBe(false);
    expect(offersAccessControl(null, otherRow("PARTICIPANT"))).toBe(false);
    expect(offersAccessControl("SUPERUSER", otherRow("PARTICIPANT"))).toBe(false);
  });

  it("gates the control on the SAME condition that suppresses the explanation", () => {
    // The defect this screen was rebuilt to fix: a row that explained why it was
    // inactionable while offering no action. The two must be exact complements, an
    // explanation AND a button on one row is a contradiction, and neither is a dead row.
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        for (const hasAccount of [true, false]) {
          for (const isSelf of [true, false]) {
            const user = { hasAccount, isSelf, role: target };
            const explained = inactionableReason(actor, user) !== null;
            expect(
              offersAccessControl(actor, user),
              `${actor}/${target} hasAccount=${hasAccount} isSelf=${isSelf}`
            ).toBe(!explained);
          }
        }
      }
    }
  });
});

describe("the Administration page still composes the gate this mirror describes", () => {
  // Structural, and deliberately so: the mirror above proves the MATRIX, these prove the
  // page is still the thing being mirrored. Without them the matrix tests would keep
  // passing against a page that had stopped consulting it.

  it("derives the row's gate from canAdministerUser, not from a local list of roles", () => {
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("!canAdminister(user.role)");
    // The hook that wraps the shared predicate, never a hand-rolled comparison.
    expect(source).toContain("useCanAdministerUser");
    // A literal role name inside the gate would be a second matrix.
    expect(source).not.toMatch(/user\.role\s*===\s*"(ADMIN|FACILITATOR)"/);
  });

  it("renders the access button on `!reason`, the same value that carries the explanation", () => {
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("{!reason && (");
    // And the three explanation branches are all still folded into that one value.
    expect(source).toContain("!user.hasAccount");
    expect(source).toContain("user.isSelf");
  });

  it("keys the pending state PER ROW, so one change does not disable the directory", () => {
    // `submittingAccess` is a userId, not a boolean: a boolean would grey out every
    // Disable button on the page for the duration of one request, which reads as the
    // screen having failed.
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("submitting={submittingAccess === user.id}");
    expect(source).toContain("pending={submittingAccess === pendingAccess.userId}");
  });
});

describe("per-row pending, as the page computes it", () => {
  // The arithmetic of the line pinned above, so the intent is asserted and not only the
  // spelling: a row is pending iff its OWN id is the one in flight.
  const isRowPending = (submitting: string | null, rowId: string) =>
    submitting === rowId;

  it("disables only the row whose request is in flight", () => {
    expect(isRowPending("user-a", "user-a")).toBe(true);
    expect(isRowPending("user-a", "user-b")).toBe(false);
  });

  it("disables nothing when no request is in flight", () => {
    expect(isRowPending(null, "user-a")).toBe(false);
  });

  it("does not confuse a row whose id is a PREFIX of the pending one", () => {
    // Strict equality, not startsWith/includes. Cognito subs are fixed-length UUIDs so
    // this is not reachable today, but the ULIDs elsewhere on this platform are not, and
    // a substring match would disable an unrelated row.
    expect(isRowPending("user-a-2", "user-a")).toBe(false);
  });
});

// ─── The team roster's Remove gate ──────────────────────────────────────────────

/** Mirrors `canRemoveMembers && !isSelf` in the team page's member row. */
const offersRemove = (
  actorRole: string | null | undefined,
  myUserId: string | undefined,
  member: { userId: string }
) => !isReadOnlyRole(actorRole) && !(!!myUserId && member.userId === myUserId);

describe("who is offered Remove on a team roster row", () => {
  it("hides it from a read-only EXECUTIVE", () => {
    // A courtesy, not the control, requireTeamWrite in the team service 403s them
    // regardless, and that refusal renders in the outcome notice. Asserted because the
    // opposite mistake (hiding it from someone entitled) is a defect that has already happened.
    expect(offersRemove("EXECUTIVE", "me", { userId: "them" })).toBe(false);
  });

  it("offers it to every role that is not read-only", () => {
    for (const actor of ALL_ROLES) {
      expect(
        offersRemove(actor, "me", { userId: "them" }),
        actor
      ).toBe(!isReadOnlyRole(actor));
    }
  });

  it("agrees with READ_ONLY_ROLES rather than naming EXECUTIVE itself", () => {
    // Derived, so adding a second read-only role to the shared constant closes this
    // control for it automatically instead of leaving one screen behind.
    for (const actor of ALL_ROLES) {
      expect(offersRemove(actor, "me", { userId: "them" }), actor).toBe(
        !isReadOnlyRole(actor)
      );
    }
  });

  it("NEVER offers it on the caller's own row", () => {
    // An operator who removes themselves loses the page they are standing on, and the team
    // service does not refuse a self-removal (it is the legitimate "leave the team" path),
    // so this gate is the only thing preventing it from this screen.
    expect(offersRemove("ADMIN", "me", { userId: "me" })).toBe(false);
    expect(offersRemove("FACILITATOR", "me", { userId: "me" })).toBe(false);
  });

  it("still offers it on OTHER rows while suppressing the caller's own", () => {
    expect(offersRemove("ADMIN", "me", { userId: "someone-else" })).toBe(true);
  });

  it("offers it on every row when the session has not resolved yet", () => {
    // `myUserId` is undefined on the first render. The alternative, treating "unknown
    // caller" as "every row might be me", would hide the control on a page load and show
    // it a beat later, which is a control that flickers into existence.
    expect(offersRemove("ADMIN", undefined, { userId: "me" })).toBe(true);
    expect(offersRemove("ADMIN", "", { userId: "" })).toBe(true);
  });
});

describe("the team page compares the field the membership row is KEYED on", () => {
  it("compares member.userId against the session id, never member.id", () => {
    // These two are equal ONLY because the BFF mapper sets `id: m.userId`
    // (lib/trpc/routers/team.ts:39), an incidental fact about a projection, not a
    // guarantee. `userId` is the Cognito sub the membership row is keyed on and the same
    // value NextAuth puts on session.user.id; `id` is a display convenience. If the mapper
    // ever carries a membership-row id instead, a comparison against `id` would silently
    // stop excluding the caller's own row and start offering an operator a Remove button
    // that deletes their own membership.
    const source = readCode(TEAM_PAGE);
    expect(source).toContain("member.userId === myUserId");
    expect(source).not.toMatch(/member\.id\s*===\s*myUserId/);
  });

  it("sends member.userId as the mutation's subject, matching the DELETE path segment", () => {
    // The route is DELETE /v1/teams/:teamId/members/:userId and the service deletes on
    // (teamId, userId). Opening the dialog on `member.id` would confirm the right person
    // and delete by the wrong key.
    const source = readCode(TEAM_PAGE);
    expect(source).toContain("setPendingRemoval({ userId: member.userId");
  });

  it("derives the read-only exclusion from the shared predicate", () => {
    const source = readCode(TEAM_PAGE);
    expect(source).toContain("useIsReadOnly");
    expect(source).toContain("const canRemoveMembers = !isReadOnly");
    // Not a hand-rolled role comparison, which is how one screen ends up disagreeing with
    // READ_ONLY_ROLES.
    expect(source).not.toMatch(/role\s*===\s*"EXECUTIVE"/);
  });

  it("gates the button on BOTH halves, not one", () => {
    const source = readCode(TEAM_PAGE);
    expect(source).toContain("canRemoveMembers && !isSelf");
  });
});

// ─── The disabled-row badge ─────────────────────────────────────────────────────

describe("the disabled-row state is driven by the shared predicate", () => {
  // isUserDeactivated's own polarity is asserted in lib/user-status.test.ts. What is
  // asserted here is that the Administration row CONSULTS it, the failure mode is
  // `status !== "ACTIVE"`, which type-checks perfectly and badges every row written before
  // the field existed as locked out.

  it("uses isUserDeactivated and never compares status to a literal", () => {
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("const deactivated = isUserDeactivated(user)");
    expect(source).not.toMatch(/status\s*!==\s*"ACTIVE"/);
    expect(source).not.toMatch(/status\s*===\s*"DEACTIVATED"/);
  });

  it("reads ACTIVE for a row with no status at all, the pre-field row", () => {
    // The case that decides whether this screen is usable at all on a rolling deploy: a
    // portal ahead of the identity service receives rows with no `status` attribute, and
    // the wrong polarity strikes through and badges "No access" on the entire directory.
    expect(isUserDeactivated({})).toBe(false);
    expect(isUserDeactivated({ status: undefined })).toBe(false);
    expect(isUserDeactivated({ status: null })).toBe(false);
    expect(isUserDeactivated({ status: "ACTIVE" })).toBe(false);
    expect(isUserDeactivated({ status: "DEACTIVATED" })).toBe(true);
  });

  it("drives the button's DIRECTION from the same value as the badge", () => {
    // `onChangeAccess(deactivated)`, the requested direction is the current state
    // inverted. If the badge and the direction came from different expressions, a row
    // could show "No access" above a button that asks to disable them again.
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("onClick={() => onChangeAccess(deactivated)}");
  });
});
