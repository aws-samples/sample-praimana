import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import {
  INVITABLE_PLATFORM_ROLES,
  TEAM_ROLES,
  USER_ADMIN_GRANTS,
  isReadOnlyRole,
  type UserRole,
} from "@praimana/shared";

/**
 * RESTORING A FORMER MEMBER, the mutation's three callbacks, the outcome sentence, the
 * provenance line on a former-members row, and the nulls that row must never blank.
 *
 * ── WHY THE CONCURRENCY HALF RUNS AGAINST THE REAL MutationObserver ──
 * The behaviour under test IS react-query's: which callback fires, in what order, and what
 * the shared state holds while a second request is in flight. A hand-rolled stand-in would
 * assert my model of react-query rather than react-query, and the whole point of these cases
 * is that the library's single-observer semantics are not what a naive page assumes. So this
 * harness drives a genuine `MutationObserver` from `@tanstack/query-core` (the same instance
 * `trpc.team.reactivateMember.useMutation` builds on) with a controllable `mutationFn`, and
 * the page's `onSuccess`/`onError`/`onSettled` bodies are transcribed faithfully around it.
 * Only the transport is substituted, and only so the test decides WHEN each request answers.
 * Same convention, and the same `flush()`, as lib/access-action-concurrency.test.ts.
 *
 * DETERMINISM. No sleeps as synchronisation and no randomness: every request is resolved
 * explicitly by the test, in an order the test chooses, and `flush()` drains the
 * microtask/notify queue. Same result on every run, and there is no seed to record.
 *
 * ── WHY THE REST IS MIRRORED PLUS PINNED ──
 * `removedByLabel`, `teamRoleLabel` and the row's label/initial logic are module-private or
 * inline inside a "use client" page. The portal suite runs `environment: "node"` with
 * `include: ["src/**\/*.test.ts"]` and no jsdom, no happy-dom and no @testing-library, so a
 * rendered-component test here is not inconvenient, it is not executable. Each behaviour is
 * therefore covered twice: a MIRROR (driven from the real shared role tables where one
 * exists, so it tracks the table rather than a hardcoded copy) and a SOURCE PIN against
 * COMMENT-STRIPPED code so the mirror cannot silently stop describing the page.
 *
 * Comment-stripping is load-bearing on THIS file specifically. The page's own design note
 * contains the sentence `"Never joined" would be this screen asserting a falsehood`, so a
 * pin asserting the string "never joined" is absent would FAIL against raw source and pass
 * against code, the exact false-green/false-red the helper exists to prevent.
 *
 * ── WHAT THIS CANNOT COVER ──
 *   • `disabled={isRestoring}` on the row's button and `disabled={pending}` on the dialog's
 *     confirm are DOM properties. They are the FIRST line of defence against a double-click
 *     and there is no guard inside `onConfirm`; both are pinned structurally and flagged as
 *     needing a browser.
 *   • Real rendering: `sr-only`, `truncate`, `aria-hidden`, `break-words`, the contrast
 *     figures in the class strings, and whether the Disclosure's `notice` slot is genuinely
 *     visible while collapsed. The notice's PLACEMENT is pinned in the source and its
 *     visibility-while-collapsed is asserted against the Disclosure component's own
 *     contract, not observed.
 *   • Focus. `returnToFallback` / `fallbackFocus` need a document; only the ref they read is
 *     exercised here. lib/confirm-dialog-focus.test.ts owns that surface.
 *   • React scheduling and commit order. The harness models state as plain fields.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const TEAM_PAGE = "../app/w/[workshopId]/t/[teamId]/team/page.tsx";
const TEAM_ROUTER = "./trpc/routers/team.ts";
const DIALOG = "../components/ConfirmActionDialog.tsx";
const DISCLOSURE = "../components/Disclosure.tsx";

const SOURCE = readCode(TEAM_PAGE);

/**
 * The restore mutation's callbacks, and the restore dialog, sliced out of the comment-stripped
 * page.
 *
 * REGION SLICING IS NOT TIDINESS HERE, it is what makes several pins below able to fail. The
 * removal flow one-for-one mirrors this one, so the page contains TWO of nearly every string a
 * pin would match: two `kind: "partial"`, two `?? "That person"`-shaped label lookups, two
 * `if (wasPending)` blocks. A file-wide `toContain` is satisfied by the REMOVAL's copy and
 * therefore cannot detect a regression in the RESTORE's, which mutation testing confirmed:
 * three pins written file-wide passed against a deliberately broken restore path and only
 * failed once scoped here.
 */
const restoreRegion = (from: string, to: string, after = 0) => {
  const start = SOURCE.indexOf(from, after);
  const end = SOURCE.indexOf(to, start);
  expect(start, `region start not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `region end not found: ${to}`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
};

const REACTIVATE_MUTATION = restoreRegion(
  "const reactivateMember = trpc.team.reactivateMember.useMutation({",
  /* End-marker. It was `const [showInvitations, ...]`, which moved when that state was
     hoisted to sit beside its now-deferred query. `showMembers` is the equivalent line
     that stays put, and it must be CODE, not a comment: readCode() strips comments
     before any of these regions are cut, so a comment anchor can never match. */
  "const [showMembers, setShowMembers]"
);
const REACTIVATE_ON_SUCCESS = restoreRegion(
  "const reactivateMember = trpc.team.reactivateMember.useMutation({",
  "onError: (err, variables) => {",
  SOURCE.indexOf("const reactivateMember =")
);
// The restore dialog is the LAST element on the page, and <ConfirmActionDialog /> is
// self-closing, so the region runs from its guard to end of file. Anchored on the guard
// rather than on a line number, which a one-line edit above would invalidate silently.
const RESTORE_DIALOG = SOURCE.slice(
  SOURCE.indexOf("{pendingRestore && (", SOURCE.indexOf("{pendingRemoval && ("))
);

/** Drain react-query's notify queue. Deterministic: no wall-clock dependency. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// ─── The restore state machine, transcribed ──────────────────────────────────────

/** What `team.reactivateMember` resolves to, see the BFF's return in routers/team.ts. */
interface ReactivateResult {
  reactivated: true;
  /** The PRESERVED team role, or "" from a service version that does not send it. */
  role: string;
  audited: boolean;
}

/** Mirrors `teamRoleLabel`, driven from the REAL TEAM_ROLES table, not a copy of it. */
const teamRoleLabel = (teamRole: string): string =>
  TEAM_ROLES.find((r) => r.role === teamRole)?.label ?? teamRole;

/**
 * A faithful transcription of the team page's RESTORE state and mutation callbacks -
 * `pendingRestore`, `restoring`, `restoreOutcome`, `restoreLabelsRef`, `currentRestoreRef`,
 * `restoreSucceededRef`, and the three callbacks on
 * `trpc.team.reactivateMember.useMutation`.
 *
 * The team name is fixed to "Team X" so assertions read about the person rather than about
 * interpolation, and invalidations are recorded as strings so both lists can be asserted.
 */
function restoreHarness(teamName = "Team X") {
  const client = new QueryClient();
  const settle = new Map<string, (value: ReactivateResult) => void>();
  const fail = new Map<string, (error: Error) => void>();
  /** Every cache key this flow invalidated, in order, so both lists can be asserted. */
  const invalidations: string[] = [];

  const state = {
    pendingRestore: null as { userId: string; name: string; email: string | null } | null,
    restoring: null as string | null,
    restoreOutcome: null as { kind: string; message: string } | null,
  };
  const restoreLabelsRef = { current: new Map<string, string>() };
  const currentRestoreRef = { current: null as string | null };
  const restoreSucceededRef = { current: false };

  // Generics pinned so `variables` is typed on every callback. react-query widens it to
  // `TVariables | undefined`, so each callback guards first, and that guard is both what
  // satisfies the types and part of the behaviour under test.
  const observer = new MutationObserver<
    ReactivateResult,
    Error,
    { teamId: string; userId: string; reason?: string }
  >(client, {
    mutationFn: (variables) =>
      new Promise<ReactivateResult>((resolve, reject) => {
        settle.set(variables.userId, resolve);
        fail.set(variables.userId, reject);
      }),
    onSuccess: (result, variables) => {
      if (!variables) return;
      const isCurrent = variables.userId === currentRestoreRef.current;
      const name = restoreLabelsRef.current.get(variables.userId) ?? "That person";
      const where = teamName;

      if (isCurrent) restoreSucceededRef.current = true;

      const asRole = result.role
        ? ` Their team role is unchanged: ${teamRoleLabel(result.role)}.`
        : "";

      state.restoreOutcome = result.audited
        ? {
            kind: "confirmed",
            message: `${name} is a member of ${where} again.${asRole}`,
          }
        : {
            kind: "partial",
            message: `${name} has access to ${where}.${asRole} No audit entry was written for this action, so there is no record of who restored it; this is also what a repeat request on someone who already had access looks like, and the two cannot be told apart from here. Report it.`,
          };

      if (isCurrent) state.pendingRestore = null;

      // BOTH lists, unconditionally, a stale response moved that person too.
      invalidations.push("team.getById");
      invalidations.push("team.listFormerMembers");
    },
    onError: (err, variables) => {
      if (!variables) return;
      const isCurrent = variables.userId === currentRestoreRef.current;
      const name = restoreLabelsRef.current.get(variables.userId) ?? "That person";
      state.restoreOutcome = {
        kind: "failed",
        message:
          err.message ||
          `${name} was not restored and still has no access to this team. Try again, and reload the page if it keeps failing.`,
      };
      if (isCurrent) state.pendingRestore = null;
    },
    onSettled: (_data, _err, variables) => {
      if (!variables) return;
      if (variables.userId === currentRestoreRef.current) {
        state.restoring = null;
        currentRestoreRef.current = null;
      }
      restoreLabelsRef.current.delete(variables.userId);
    },
  });

  return {
    state,
    restoreSucceededRef,
    invalidations,
    /** The "Restore access" button on a former-members row. */
    clickRestore(userId: string, name: string, email: string | null = `${userId}@x.test`) {
      restoreSucceededRef.current = false;
      state.pendingRestore = { userId, name, email };
    },
    /** Whether THAT row's Restore button is disabled, `isRestoring` in the row. */
    rowDisabled(userId: string) {
      return state.restoring === userId;
    },
    /** Whether the dialog's confirm button is disabled, the `pending` prop. */
    confirmDisabled() {
      return state.restoring === state.pendingRestore?.userId;
    },
    /** The dialog's Confirm. */
    async confirm(reason = "") {
      const target = state.pendingRestore;
      if (!target) throw new Error("no dialog open");
      restoreLabelsRef.current.set(target.userId, target.name);
      currentRestoreRef.current = target.userId;
      state.restoring = target.userId;
      state.restoreOutcome = null;
      observer
        .mutate({
          teamId: "team-1",
          userId: target.userId,
          reason: reason.trim() || undefined,
        })
        .catch(() => {});
      await flush();
    },
    /** The dialog's Cancel/Close/Escape/backdrop, all one path. */
    dismiss() {
      const wasPending = state.restoring === state.pendingRestore?.userId;
      if (wasPending) {
        state.restoreOutcome = {
          kind: "unknown",
          message: `The request to restore ${state.pendingRestore?.name} was sent but the result was never seen. Reload the page to check whether they are a member again before trying once more.`,
        };
      }
      state.pendingRestore = null;
    },
    async respond(userId: string, over: Partial<ReactivateResult> = {}) {
      settle.get(userId)!({ reactivated: true, role: "LEAD", audited: true, ...over });
      await flush();
    },
    async refuse(userId: string, message: string) {
      fail.get(userId)!(new Error(message));
      await flush();
    },
    inFlight() {
      return Array.from(settle.keys());
    },
  };
}

// ─── The happy path, and the negative controls the races need ────────────────────

describe("a single restoration, confirmed once", () => {
  it("sends one request, reports it as confirmed, and names the preserved role", async () => {
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();

    expect(h.inFlight()).toEqual(["alice"]);
    expect(h.confirmDisabled()).toBe(true);
    expect(h.rowDisabled("alice")).toBe(true);

    await h.respond("alice", { role: "LEAD", audited: true });
    expect(h.state.restoreOutcome).toEqual({
      kind: "confirmed",
      message:
        "Alice is a member of Team X again. Their team role is unchanged: Lead.",
    });
    expect(h.state.pendingRestore).toBeNull();
    expect(h.state.restoring).toBeNull();
  });

  it("disables ONLY the row being restored, not the whole former-members list", async () => {
    // `restoring` is a userId, not a boolean. A boolean would grey out every Restore button
    // for the duration of one request, which reads as the page having failed, the same
    // reason `revoking === inv.email` is keyed rather than flagged.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();

    expect(h.rowDisabled("alice")).toBe(true);
    expect(h.rowDisabled("bob")).toBe(false);
    expect(h.rowDisabled("carol")).toBe(false);
  });

  it("clears the previous outcome when a new confirm is issued", async () => {
    // A stale success sitting under the Former members heading while a second restoration is
    // in flight would be read as that restoration's result, and this one reports ACCESS
    // GRANTED, which is not a thing to be wrong about.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    await h.respond("alice");
    expect(h.state.restoreOutcome?.kind).toBe("confirmed");

    h.clickRestore("bob", "Bob");
    await h.confirm();
    expect(h.state.restoreOutcome).toBeNull();
  });

  it("surfaces the service's own refusal message rather than a generic failure", async () => {
    // Three of the service's refusals are specific enough to act on: the read-only 403, the
    // 404 that says to INVITE them rather than restore, and the 403 that says their role is
    // platform-wide and cannot hold team membership. Replacing any of those with "failed"
    // would send an operator to the wrong remedy.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    await h.refuse("alice", "No membership row for this user, invite them instead");

    expect(h.state.restoreOutcome?.kind).toBe("failed");
    expect(h.state.restoreOutcome?.message).toContain("invite them instead");
    expect(h.state.pendingRestore).toBeNull();
    expect(h.state.restoring).toBeNull();
  });

  it("falls back to a message that says NOTHING WAS GRANTED on a silent transport failure", async () => {
    // The direction matters: on this action the safe reading is "no access was given", so a
    // retry is a safe next step. A fallback that said "the result is unknown" would be the
    // dismissal path's wording and would discourage the retry that is actually correct here.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    await h.refuse("alice", "");

    expect(h.state.restoreOutcome?.message).toBe(
      "Alice was not restored and still has no access to this team. Try again, and reload the page if it keeps failing."
    );
  });
});

describe("the UNKNOWN path, dismissing while a request is in flight", () => {
  it("reports UNKNOWN, names the person, and says to RELOAD before retrying", async () => {
    // Dismissal stays available while pending on purpose: backendFetch passes no AbortSignal,
    // so locking the dialog until the mutation settles would trap an operator in a modal.
    // The instruction is "reload", not "try again", because a second click answers 200 with
    // `audited: false`, indistinguishable from an unrecorded real restoration, so a retry
    // manufactures a false incident report.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    h.dismiss();

    expect(h.state.restoreOutcome?.kind).toBe("unknown");
    expect(h.state.restoreOutcome?.message).toContain("Alice");
    expect(h.state.restoreOutcome?.message).toContain("Reload the page");
    expect(h.state.restoreOutcome?.message).toContain("before trying once more");
    expect(h.state.pendingRestore).toBeNull();
  });

  it("does NOT cancel the request, the access may still be granted", async () => {
    // The honest part of the design, and the reason the message says "reload": the request is
    // already on its way to a service that will act on it.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    h.dismiss();

    expect(h.inFlight()).toEqual(["alice"]);
  });

  it("the page's RESTORE dialog reports the unknown outcome on a pending dismiss", () => {
    // SCOPED TO THE RESTORE DIALOG. Mutation testing caught this: disabling the restore's
    // `if (wasPending)` branch, so a mid-flight dismiss says nothing at all and the operator
    // is left believing no request was sent, left the REMOVAL's identical block in the file,
    // so a file-wide pin passed against the broken page.
    expect(RESTORE_DIALOG).toContain("onDismiss={(wasPending) => {");
    expect(RESTORE_DIALOG).toContain("if (wasPending) {");
    expect(RESTORE_DIALOG).toContain("setRestoreOutcome({");
    expect(RESTORE_DIALOG).toContain('kind: "unknown",');
    expect(RESTORE_DIALOG).toContain(
      "The request to restore ${pendingRestore.name} was sent but the result was never seen."
    );
    // "Reload", not "try again", a second click answers 200 with `audited: false`.
    expect(RESTORE_DIALOG).toContain("Reload the page to check whether they are a member again");
    expect(RESTORE_DIALOG).not.toMatch(/if \(false/);
    // The dialog closes either way; the outcome is what is conditional.
    expect(RESTORE_DIALOG).toContain("setPendingRestore(null);");
  });

  it("records NOTHING when the dialog is dismissed before a confirm", async () => {
    // The negative control: an operator who opens the dialog and changes their mind has
    // taken no action, and an "unknown outcome" notice for a request that was never sent
    // would have them reload a page for nothing.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    h.dismiss();

    expect(h.state.restoreOutcome).toBeNull();
    expect(h.inFlight()).toEqual([]);
  });
});

// ─── The four races, each mirroring one solved in the removal flow ────────────────

/**
 * THE REACHABLE OPERATOR SEQUENCE. Every step is a supported interaction; no step is a
 * double-click or a synthetic event:
 *
 *   1. Confirm a restore for Alice. The request is in flight and unanswered.
 *   2. Dismiss the dialog. Supported and documented, the outcome is recorded UNKNOWN and
 *      the dialog closes. Alice's request is NOT cancelled (no AbortSignal).
 *   3. Open Restore on Bob and confirm. Bob's row was never disabled (the guard is keyed on
 *      Alice's userId), so nothing anywhere prevents this.
 *   4. ALICE'S RESPONSE ARRIVES, while Bob's is still in flight.
 *
 * At step 4 the page has ONE mutation instance and ONE set of callbacks, and every piece of
 * shared state has already been overwritten by Bob's submit. react-query neither queues nor
 * discards the first request: both `mutationFn`s run and both callback sets fire, verified
 * against the real MutationObserver, which is why this harness uses it.
 */
describe("two restorations overlapping, one dialog, one shared mutation", () => {
  let h: ReturnType<typeof restoreHarness>;

  beforeEach(async () => {
    h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    h.dismiss(); // step 2, supported
    h.clickRestore("bob", "Bob");
    await h.confirm(); // step 3, nothing blocks it
  });

  it("permits both requests to be in flight at once", async () => {
    // Not a defect in itself, the precondition, and proof that react-query neither queues
    // nor drops the first request.
    expect(h.inFlight().sort()).toEqual(["alice", "bob"]);
  });

  it("attributes Alice's response to ALICE, not to whoever was confirmed last", async () => {
    // RACE 1, map-keyed labels, not a single slot. A single slot is overwritten at Bob's
    // submit and read when Alice's answer lands, so Alice's restoration renders under Bob's
    // name. On THIS direction that is worse than losing the notice entirely: it reports
    // ACCESS GRANTED to someone it is not true of, and the notice is deliberately built to
    // outlive the row, so the operator has no reason to look again.
    await h.respond("alice", { role: "BUILDER" });

    expect(h.state.restoreOutcome?.message).toContain("Alice");
    expect(h.state.restoreOutcome?.message).not.toContain("Bob");
  });

  it("leaves Bob's still-pending dialog OPEN when Alice's response lands", async () => {
    // RACE 2, a stale response must not close the current dialog. Unconditionally,
    // `setPendingRestore(null)` tears Bob's confirmation out from under the operator and
    // pairs it with a green "restored" notice while Bob's own request is unanswered and may
    // yet 403 (role may not hold team membership) or 404 (no membership row, invite, do not
    // restore).
    await h.respond("alice");
    expect(h.state.pendingRestore).not.toBeNull();
    expect(h.state.pendingRestore?.userId).toBe("bob");
  });

  it("does not set restoreSucceededRef from a DIFFERENT request", async () => {
    // The other half of RACE 2. `returnToFallback` reads this ref in the dialog's unmount
    // cleanup, so Alice's success would make Bob's dialog treat its trigger as doomed and
    // send focus to the Former members heading, even though Bob's row is still listed with
    // a live Restore button focus should have returned to.
    await h.respond("alice");
    expect(h.restoreSucceededRef.current).toBe(false);
  });

  it("keeps Bob's per-row guard UP while Bob's request is in flight", async () => {
    // RACE 3, the guard is released only for the CURRENT request. `restoring` is the only
    // thing between the operator and a second request, and released unconditionally an
    // earlier request settling re-arms a button whose own request is still in flight. This
    // matters MORE here than on the removal: a duplicate restore answers 200 with
    // `audited: false`, which is indistinguishable from an unrecorded real restoration, so
    // a double-click manufactures a false incident report.
    await h.respond("alice");

    expect(h.state.restoring).toBe("bob");
    expect(h.rowDisabled("bob")).toBe(true);
    expect(h.inFlight()).toContain("bob");
  });

  it("does not report a green CONFIRMED for a request that has not answered", async () => {
    // The worst reading of RACE 1: "Bob is a member of Team X again" in green while Bob's
    // request is outstanding. If it then fails, the failure overwrites the success, but in
    // between the operator has been told Bob has access, and may stop chasing it.
    await h.respond("alice");

    const claimsBobRestored =
      h.state.restoreOutcome?.kind === "confirmed" &&
      h.state.restoreOutcome.message.includes("Bob");
    expect(claimsBobRestored, "green 'Bob restored' while Bob is unanswered").toBe(false);
  });

  it("still INVALIDATES BOTH LISTS for the stale response", async () => {
    // RACE 4, the invalidation is unconditional, and deliberately so. Alice really is a
    // member again, so both server-owned lists really are stale regardless of which request
    // answered: she leaves Former members (the route omits anyone who is a member again) and
    // joins the roster. Skipping this for a stale answer leaves the two lists disagreeing
    // about where she is, or losing her from both.
    await h.respond("alice");

    expect(h.invalidations).toContain("team.getById");
    expect(h.invalidations).toContain("team.listFormerMembers");
  });

  it("still REPORTS the stale request's own outcome, the operator is owed it", async () => {
    // The line the fix must not cross. A stale answer must not touch the dialog, the focus
    // ref or another row's guard, but it MUST still say what happened: a restoration the
    // operator asked for either landed or did not, and silence is the one answer that is
    // never true.
    await h.respond("alice", { audited: false });

    expect(h.state.restoreOutcome).not.toBeNull();
    expect(h.state.restoreOutcome?.message).toContain("Alice");
  });
});

describe("both lists are invalidated in BOTH directions", () => {
  it("a restore invalidates the roster AND the former-members list", async () => {
    // One action moves a person BETWEEN two server-owned lists. Splicing either by hand
    // would let them drift, visible in both (the relationship both ended and did not) or in
    // neither (lost entirely). Both Disclosure counts come from these responses for free.
    const h = restoreHarness();
    h.clickRestore("alice", "Alice");
    await h.confirm();
    await h.respond("alice");

    expect(h.invalidations).toEqual(["team.getById", "team.listFormerMembers"]);
  });

  it("a REMOVAL invalidates the former-members list too, in the page's source", () => {
    // The other direction, and the only edit the new section required of the existing removal
    // flow: the removal is now a SOFT DELETE, so the person leaves the roster and appears in
    // Former members in the same act. Refreshing one and not the other makes them vanish from
    // the screen entirely until something else happens to refetch.
    //
    // Pinned in the source rather than mirrored, because the removal's harness is
    // access-action-concurrency.test.ts's and this assertion is about the page.
    const removalSuccess = SOURCE.slice(
      SOURCE.indexOf("const removeMember = trpc.team.removeMember.useMutation({"),
      SOURCE.indexOf("onError: (err, variables) => {")
    );
    expect(removalSuccess).toContain("utils.team.getById.invalidate({ teamId, workshopId })");
    expect(removalSuccess).toContain("utils.team.listFormerMembers.invalidate({ teamId })");
  });

  it("the restore's onSuccess invalidates both, and OUTSIDE the isCurrent guard", () => {
    // The shape that makes the stale-response case above true of the page and not only of
    // the harness. If either invalidate moved inside `if (isCurrent)`, a stale answer would
    // leave both lists showing a person who has already moved.
    const restoreSuccess = SOURCE.slice(
      SOURCE.indexOf("const reactivateMember = trpc.team.reactivateMember.useMutation({"),
      SOURCE.indexOf("onError: (err, variables) => {", SOURCE.indexOf("reactivateMember"))
    );
    expect(restoreSuccess).toContain("utils.team.getById.invalidate({ teamId, workshopId })");
    expect(restoreSuccess).toContain("utils.team.listFormerMembers.invalidate({ teamId })");
    // The two conditional statements are the dialog close and the focus ref, and nothing else.
    expect(restoreSuccess.match(/if \(isCurrent\)/g)).toHaveLength(2);
    const afterLastGuard = restoreSuccess.slice(
      restoreSuccess.lastIndexOf("if (isCurrent)")
    );
    expect(afterLastGuard).toContain("listFormerMembers.invalidate");
  });
});

describe("the correlation shape in the page, so the harness cannot drift from it", () => {
  // The harnesses above are TRANSCRIPTIONS: they can be made to agree with a regressed page
  // and would then pass while the screen misnames people. These are the checks that cannot.

  it("gives every callback the ANSWERING request's identity", () => {
    expect(SOURCE).toContain("onSuccess: (result, variables) => {");
    expect(SOURCE).toContain("onError: (err, variables) => {");
    expect(SOURCE).toContain("onSettled: (_data, _err, variables) => {");
  });

  it("recovers the label from a MAP keyed by the answering userId", () => {
    expect(SOURCE).toContain("restoreLabelsRef = useRef<Map<string, string>>(new Map())");
    expect(SOURCE).toContain("restoreLabelsRef.current.set(pendingRestore.userId");
    // SCOPED TO THE RESTORE MUTATION, not the file. Mutation testing caught this: replacing
    // the restore's per-request lookup with `pendingRestore?.name`, the single-slot defect
    // this whole block exists to prevent, left the REMOVAL's identical `.get(variables.userId)`
    // in place, so a file-wide pin passed against the broken page.
    expect(REACTIVATE_ON_SUCCESS).toContain(
      'restoreLabelsRef.current.get(variables.userId) ?? "That person"'
    );
    expect(REACTIVATE_MUTATION).toContain("restoreLabelsRef.current.delete(variables.userId)");
    // The label must NOT be read from the state the next submit overwrites. This is the
    // mutation the harness's misattribution case models, asserted at the source too because
    // the harness is a transcription and could be edited to agree with a regressed page.
    expect(REACTIVATE_MUTATION).not.toContain("pendingRestore?.name");
    expect(REACTIVATE_MUTATION).not.toContain("pendingRestore.name");
    // No single-slot label ref anywhere in the file, a revert that reintroduces one fails
    // here even if the harness above were edited to match it.
    expect(SOURCE).not.toMatch(/LabelRef\.current(?!\s*\.)/);
  });

  it("correlates against currentRestoreRef before touching shared state", () => {
    expect(SOURCE).toContain(
      "const isCurrent = variables.userId === currentRestoreRef.current;"
    );
    expect(SOURCE).toContain("if (isCurrent) restoreSucceededRef.current = true;");
    expect(SOURCE).toContain("if (isCurrent) setPendingRestore(null);");
    expect(SOURCE).toContain(
      "if (variables.userId === currentRestoreRef.current) {"
    );
  });

  it("sets both refs BEFORE mutate, so no response can arrive unidentifiable", () => {
    const onConfirm = SOURCE.slice(
      SOURCE.indexOf("restoreLabelsRef.current.set(pendingRestore.userId"),
      SOURCE.indexOf("reactivateMember.mutate({")
    );
    expect(onConfirm).toContain("currentRestoreRef.current = pendingRestore.userId;");
    expect(onConfirm).toContain("setRestoring(pendingRestore.userId);");
    expect(onConfirm).toContain("setRestoreOutcome(null);");
  });

  it("keeps the restore's state SEPARATE from the removal's", () => {
    // The two mutations can be in flight at once (nothing on either path cancels the other),
    // so one `submitting` slot or one outcome would let a removal's answer release a
    // restore's guard or overwrite its notice.
    for (const pair of [
      ["pendingRemoval", "pendingRestore"],
      ["removing", "restoring"],
      ["removeOutcome", "restoreOutcome"],
      ["currentRemovalRef", "currentRestoreRef"],
      ["removalSucceededRef", "restoreSucceededRef"],
      ["removalLabelsRef", "restoreLabelsRef"],
    ] as const) {
      for (const name of pair) {
        expect(SOURCE, `${name} must exist as its own slot`).toContain(name);
      }
    }
    // The restore's callbacks never write the removal's state, and vice versa.
    const restoreBlock = SOURCE.slice(
      SOURCE.indexOf("const reactivateMember = trpc.team.reactivateMember.useMutation({"),
      SOURCE.indexOf("const [showInvitations, setShowInvitations]")
    );
    expect(restoreBlock).not.toContain("setRemoveOutcome");
    expect(restoreBlock).not.toContain("setPendingRemoval");
    expect(restoreBlock).not.toContain("setRemoving(");
  });

  it("disables the row's own trigger and the dialog's confirm, pinned, not exercised", () => {
    // DOM properties, and the FIRST line of defence against a double-click. There is no
    // guard inside `onConfirm` (asserted below), so anything that gets past these reaches
    // the service. Whether they hold depends on React having re-rendered between two click
    // events, which this suite cannot observe.
    expect(SOURCE).toContain("disabled={isRestoring}");
    expect(SOURCE).toContain("pending={restoring === pendingRestore.userId}");
    expect(readCode(DIALOG)).toContain("disabled={pending}");
  });

  it("does NOT guard onConfirm itself against a second invocation", () => {
    // Documenting the absence, not asserting it is correct, the same shape as the removal's
    // note in access-action-concurrency.test.ts. This is the hole the overlapping cases above
    // walk through.
    const onConfirm = SOURCE.slice(
      SOURCE.indexOf("restoreLabelsRef.current.set(pendingRestore.userId"),
      SOURCE.indexOf("onDismiss={(wasPending) => {", SOURCE.indexOf("pendingRestore.name}'s"))
    );
    expect(onConfirm).toContain("reactivateMember.mutate({");
    expect(onConfirm).not.toContain("if (restoring");
  });
});

// ─── The ambiguous `audited: false` ──────────────────────────────────────────────

/**
 * The outcome sentence, extracted from the harness so the wording can be asserted without
 * driving a request for every case.
 */
const restoreMessage = (name: string, where: string, result: ReactivateResult) => {
  const asRole = result.role
    ? ` Their team role is unchanged: ${teamRoleLabel(result.role)}.`
    : "";
  return result.audited
    ? { kind: "confirmed" as const, message: `${name} is a member of ${where} again.${asRole}` }
    : {
        kind: "partial" as const,
        message: `${name} has access to ${where}.${asRole} No audit entry was written for this action, so there is no record of who restored it; this is also what a repeat request on someone who already had access looks like, and the two cannot be told apart from here. Report it.`,
      };
};

describe("audited: false is TRUE UNDER TWO READINGS, and claims neither", () => {
  const ambiguous = restoreMessage("Alice", "Team X", {
    reactivated: true,
    role: "LEAD",
    audited: false,
  });

  it("is PARTIAL, not confirmed, and not failed", () => {
    // Not CONFIRMED: in one reading access was granted with NO record of who granted it, and
    // that is the direction that adds privilege. Not FAILED: a retry cannot write the missing
    // entry and would only repeat a request that already achieved its intent, and that
    // repeat answers `audited: false` again, so a failure framing produces a loop.
    expect(ambiguous.kind).toBe("partial");
  });

  it("states the fact that is TRUE IN BOTH readings, they have access", () => {
    // "is a member again" would assert a FLIP happened, which is only the first reading.
    // "has access to" is true whether this call did the work or found it already done.
    expect(ambiguous.message).toContain("Alice has access to Team X.");
    expect(ambiguous.message).not.toContain("is a member of Team X again");
  });

  it("names the gap that is TRUE IN BOTH readings, no entry for THIS action", () => {
    expect(ambiguous.message).toContain("No audit entry was written for this action");
    expect(ambiguous.message).toContain("no record of who restored it");
  });

  it("asks for a REPORT, because one reading is a real incident", () => {
    // A partial with no next step is a partial nobody actions.
    expect(ambiguous.message).toContain("Report it.");
  });

  it("does NOT assert 'they already had access' as fact", () => {
    // Guessing the benign reading would talk an operator out of reporting the serious one.
    // The sentence offers it as a possibility ("this is ALSO what a repeat request … looks
    // like") and says the two cannot be told apart, which is the BFF's own position.
    expect(ambiguous.message).toContain("cannot be told apart");
    expect(ambiguous.message).not.toMatch(/they already had access\b(?!.*looks like)/);
    expect(ambiguous.message).not.toMatch(/no change was needed/i);
    expect(ambiguous.message).not.toMatch(/nothing happened/i);
    expect(ambiguous.message).not.toMatch(/already a member/i);
  });

  it("does NOT assert an unrecorded restoration as fact either", () => {
    // The other half. Asserting it would send an operator chasing an incident that may not
    // exist, on a screen whose amber panels have to keep meaning something.
    expect(ambiguous.message).not.toMatch(/was restored but/i);
    expect(ambiguous.message).not.toMatch(/access was granted with no record/i);
    expect(ambiguous.message).not.toMatch(/unrecorded restoration/i);
  });

  it("is a single well-formed sentence run, not a mangled concatenation", () => {
    // Assert the SHAPE rather than the whole string, so the wording can be improved without
    // breaking this: no doubled punctuation, no double spaces where the role clause meets
    // the audit clause, and no lower-case sentence start after a full stop.
    expect(ambiguous.message).not.toMatch(/\.\./);
    expect(ambiguous.message).not.toMatch(/\s{2}/);
    expect(ambiguous.message).not.toMatch(/\.\s+[a-z]/);
    expect(ambiguous.message).not.toContain("undefined");
  });

  it("is CONFIRMED and says the one thing that changed when the entry WAS written", () => {
    // The negative control. Without it, "always partial" would satisfy every case above and
    // teach the operator that the amber panel means nothing.
    const clean = restoreMessage("Alice", "Team X", {
      reactivated: true,
      role: "LEAD",
      audited: true,
    });
    expect(clean.kind).toBe("confirmed");
    expect(clean.message).toBe(
      "Alice is a member of Team X again. Their team role is unchanged: Lead."
    );
    expect(clean.message).not.toContain("Report it");
    expect(clean.message).not.toContain("audit");
  });

  it("names the person, since the notice outlives the row it is about", () => {
    // The row is gone on success, the service omits anyone who is a member again, so a
    // message saying "that person" would be unattributable by the time it is read.
    expect(ambiguous.message.startsWith("Alice ")).toBe(true);
  });

  it("the page reads `audited` STRICTLY at the BFF, so an absent field is not a success", () => {
    // The page cannot report a gap it is never told about. `=== true` rather than `?? true`
    // is what makes an older service version report the gap rather than hide it.
    const router = readCode(TEAM_ROUTER);
    const reactivate = router.slice(
      router.indexOf("reactivateMember: protectedProcedure"),
      router.indexOf("listFormerMembers: protectedProcedure")
    );
    expect(reactivate).toContain("audited: data.audited === true");
    expect(reactivate).toContain('role: typeof data.role === "string" ? data.role : ""');
  });

  it("the page's RESTORE branch reports partial on the audit gap, not confirmed", () => {
    // SCOPED TO THE RESTORE CALLBACK. Mutation testing caught this one: flipping the restore's
    // `kind: "partial"` to `"confirmed"`, which paints "they have access" in GREEN with no
    // mention that the grant is unrecorded, left the REMOVAL's identical `kind: "partial"` in
    // the file, so a file-wide pin passed against the broken page. The two flows mirror each
    // other almost line for line, which is exactly what makes file-wide pins useless here.
    expect(REACTIVATE_ON_SUCCESS).toContain("result.audited");
    expect(REACTIVATE_ON_SUCCESS).toContain('kind: "confirmed",');
    expect(REACTIVATE_ON_SUCCESS).toContain('kind: "partial",');
    expect(REACTIVATE_ON_SUCCESS).toContain("cannot be told apart from here. Report it.");
    // The audit-gap message and the partial kind must be the SAME branch. Asserted by
    // position: the confirmed kind belongs to the `result.audited ?` arm and the partial to
    // the `:` arm, so the partial must be the LAST of the two and must precede the gap wording.
    const confirmed = REACTIVATE_ON_SUCCESS.indexOf('kind: "confirmed",');
    const partial = REACTIVATE_ON_SUCCESS.indexOf('kind: "partial",');
    const gapWording = REACTIVATE_ON_SUCCESS.indexOf("No audit entry was written");
    expect(partial).toBeGreaterThan(confirmed);
    expect(gapWording).toBeGreaterThan(partial);
    // And exactly one of each, a second "confirmed" would mean both arms report clean.
    expect(REACTIVATE_ON_SUCCESS.match(/kind: "confirmed",/g)).toHaveLength(1);
    expect(REACTIVATE_ON_SUCCESS.match(/kind: "partial",/g)).toHaveLength(1);
  });
});

describe("the role clause", () => {
  it("names the PRESERVED role through teamRoleLabel, from the real TEAM_ROLES table", () => {
    // The reassuring detail and the whole point of the row surviving the removal: a LEAD
    // comes back a LEAD, where the old hard delete destroyed the role and a re-added member
    // returned as whatever their next invitation happened to say.
    for (const definition of TEAM_ROLES) {
      const { message } = restoreMessage("Alice", "Team X", {
        reactivated: true,
        role: definition.role,
        audited: true,
      });
      expect(message, definition.role).toContain(
        `Their team role is unchanged: ${definition.label}.`
      );
    }
  });

  it("renders the LABEL for LEAD, not the raw code", () => {
    // Spelled out so the derived loop above cannot pass by teamRoleLabel becoming the
    // identity function.
    expect(teamRoleLabel("LEAD")).toBe("Lead");
    expect(
      restoreMessage("Alice", "Team X", { reactivated: true, role: "LEAD", audited: true })
        .message
    ).toContain("Their team role is unchanged: Lead.");
  });

  it("falls back to the RAW CODE for a role it does not recognise", () => {
    // An unrecognised code is still a fact. "restored as MENTOR" is readable where "restored
    // as undefined" is a defect, and a future service role must not blank the clause.
    const { message } = restoreMessage("Alice", "Team X", {
      reactivated: true,
      role: "MENTOR",
      audited: true,
    });
    expect(message).toContain("Their team role is unchanged: MENTOR.");
    expect(message).not.toContain("undefined");
  });

  it("says NOTHING ABOUT ROLE when the service sent an empty string", () => {
    // `""` from a service version that does not send `role`. The clause is dropped entirely
    // rather than rendered with a hole in it, and the sentence must still end cleanly.
    const clean = restoreMessage("Alice", "Team X", {
      reactivated: true,
      role: "",
      audited: true,
    });
    expect(clean.message).toBe("Alice is a member of Team X again.");
    expect(clean.message).not.toContain("team role");

    const ambiguous = restoreMessage("Alice", "Team X", {
      reactivated: true,
      role: "",
      audited: false,
    });
    expect(ambiguous.message).toContain("Alice has access to Team X. No audit entry");
    expect(ambiguous.message).not.toContain("team role");
    // The join most likely to produce a double space or a missing one.
    expect(ambiguous.message).not.toMatch(/\s{2}/);
    expect(ambiguous.message).not.toMatch(/\.\./);
  });

  it("NEVER lets the string 'undefined' into the message, on any role value", () => {
    // The one-character version of this defect is `teamRoleLabel(result.role)` called
    // without the truthiness guard, or `result.role!`. Both type-check.
    for (const role of ["", "LEAD", "BUILDER", "MENTOR", "lead", " "]) {
      for (const audited of [true, false]) {
        const { message } = restoreMessage("Alice", "Team X", {
          reactivated: true,
          role,
          audited,
        });
        expect(message, `role=${JSON.stringify(role)} audited=${audited}`).not.toContain(
          "undefined"
        );
        expect(message).not.toContain("null");
      }
    }
  });

  it("the page guards the clause on truthiness and uses teamRoleLabel", () => {
    expect(SOURCE).toContain(
      "const asRole = result.role ? ` Their team role is unchanged: ${teamRoleLabel(result.role)}.` : \"\";"
    );
    // teamRoleLabel, never roleLabel, the latter renders a PLATFORM role with a team role
    // hanging off it, so passing a team role alone would produce "Participant · Lead"
    // and assert a platform role the response never mentioned.
    expect(SOURCE).not.toContain("roleLabel(result.role)");
    expect(SOURCE).toContain("function teamRoleLabel(teamRole: string): string {");
    expect(SOURCE).toContain("TEAM_ROLES.find((r) => r.role === teamRole)?.label ?? teamRole");
  });
});

// ─── removedByLabel ──────────────────────────────────────────────────────────────

/** Mirrors `roleLabel` with one argument, driven from the REAL platform role table. */
const platformLabel = (role: string): string =>
  INVITABLE_PLATFORM_ROLES.find((r) => r.role === role)?.label ?? role ?? "Participant";

/** Mirrors `removedByLabel` in the team page. */
function removedByLabel(removedByName: string | null, removedByRole: string): string {
  const role = removedByRole ? platformLabel(removedByRole) : "";
  const article = /^[AEIOU]/i.test(role) ? "an" : "a";

  if (removedByName) {
    return role ? `Removed by ${removedByName} (${role})` : `Removed by ${removedByName}`;
  }

  return role
    ? `Removed by ${article} ${role}, name not shown`
    : "Removed by someone whose name is not shown";
}

describe("who removed them, never blank, in any combination", () => {
  it("names the person AND the role at the time", () => {
    // The role stays alongside the name: it is the role AT THE TIME of the removal, which is
    // what the audit entry recorded and is not answerable from today's directory.
    expect(removedByLabel("Grace Hopper", "FACILITATOR")).toBe(
      "Removed by Grace Hopper (Facilitator)"
    );
  });

  it("SUPPRESSED name + role → 'Removed by a Facilitator, name not shown'", () => {
    // The suppression case, and the highest-value one here. A FACILITATOR reading a removal
    // an ADMIN performed gets null, because learning which accounts hold full platform access
    // is itself the reconnaissance step USER_VISIBILITY_GRANTS exists to stop. `removedByRole`
    // is ALWAYS present, which is what makes the role renderable either way, and a row that
    // says a removal happened and then refuses to say by whom IN ANY FORM is not a trail.
    expect(removedByLabel(null, "FACILITATOR")).toBe(
      "Removed by a Facilitator, name not shown"
    );
    // The wording is borrowed from InvitedByNote's "Not shown" on purpose, and it says the
    // name was WITHHELD rather than missing.
    expect(removedByLabel(null, "FACILITATOR")).toContain("name not shown");
    expect(removedByLabel(null, "FACILITATOR")).not.toContain("unknown");
  });

  it("agrees the ARTICLE with the label, for every real platform role", () => {
    // "an Admin" / "an Executive" vs "a Facilitator". Cheap, and a mis-agreeing article on a
    // line an operator reads all shift is the kind of thing that makes a screen feel wrong.
    // Derived from the real table so a new role gets the right article automatically.
    expect(removedByLabel(null, "ADMIN")).toBe("Removed by an Admin, name not shown");
    expect(removedByLabel(null, "EXECUTIVE")).toBe(
      "Removed by an Executive, name not shown"
    );
    expect(removedByLabel(null, "FACILITATOR")).toBe(
      "Removed by a Facilitator, name not shown"
    );
    expect(removedByLabel(null, "JUDGE")).toBe("Removed by a Judge, name not shown");
    expect(removedByLabel(null, "PARTICIPANT")).toBe(
      "Removed by a Participant, name not shown"
    );

    for (const definition of INVITABLE_PLATFORM_ROLES) {
      const expected = /^[AEIOU]/i.test(definition.label) ? "an" : "a";
      expect(
        removedByLabel(null, definition.role),
        `${definition.role} → ${definition.label}`
      ).toBe(`Removed by ${expected} ${definition.label}, name not shown`);
    }
  });

  it("covers every role in USER_ADMIN_GRANTS, since any of them can be an actor", () => {
    // Derived from the matrix rather than a hardcoded list: whoever can act is whoever can
    // appear on this line, so the two lists must not part company.
    for (const actor of Object.keys(USER_ADMIN_GRANTS) as UserRole[]) {
      const suppressed = removedByLabel(null, actor);
      const named = removedByLabel("Grace Hopper", actor);
      expect(suppressed, actor).toMatch(/^Removed by an? .+, name not shown$/);
      expect(named, actor).toMatch(/^Removed by Grace Hopper \(.+\)$/);
      // Never a dangling article and never a blank tail.
      expect(suppressed, actor).not.toMatch(/Removed by an? +-/);
    }
  });

  it("falls back to the RAW CODE for an unrecognised role, rather than to a guess", () => {
    // An unknown role is still a fact about who acted, and it is the value an operator can
    // quote. A default of "Participant" here would UNDERSTATE the actor's privilege on an
    // audit line, which is the wrong direction to be wrong in.
    expect(removedByLabel(null, "SUPERUSER")).toBe(
      "Removed by a SUPERUSER, name not shown"
    );
    expect(removedByLabel("Grace Hopper", "SUPERUSER")).toBe(
      "Removed by Grace Hopper (SUPERUSER)"
    );
  });

  it("EMPTY role + null name → the unnamed-someone fallback, never a dangling article", () => {
    // An empty role is not in the frozen contract, but it costs one branch to render it as an
    // unnamed someone rather than as "Removed by a " with nothing after it, which reads as a
    // half-rendered row and loses the only fact the line still has (that a removal happened).
    expect(removedByLabel(null, "")).toBe("Removed by someone whose name is not shown");
    expect(removedByLabel(null, "")).not.toBe("Removed by a ");
    expect(removedByLabel(null, "")).not.toMatch(/Removed by an? *$/);
    expect(removedByLabel(null, "").trim()).toBe(removedByLabel(null, ""));
  });

  it("EMPTY role + a name → the name alone, with no empty parenthesis", () => {
    // "Removed by Grace Hopper ()" is the concatenation defect this branch exists to avoid.
    expect(removedByLabel("Grace Hopper", "")).toBe("Removed by Grace Hopper");
    expect(removedByLabel("Grace Hopper", "")).not.toContain("()");
  });

  it("is NEVER blank and NEVER ends mid-clause, across the whole matrix", () => {
    // The invariant the line exists for, asserted over every combination rather than
    // case-by-case: a trail that will not say by whom in any form is not a trail.
    const roles = [
      ...(Object.keys(USER_ADMIN_GRANTS) as string[]),
      "",
      "SUPERUSER",
      "unknown-role",
    ];
    for (const name of [null, "Grace Hopper", "Ada"]) {
      for (const role of roles) {
        const line = removedByLabel(name, role);
        expect(line.length, `${name}/${role}`).toBeGreaterThan("Removed by ".length);
        expect(line, `${name}/${role}`).toMatch(/^Removed by \S/);
        expect(line, `${name}/${role}`).not.toContain("undefined");
        expect(line, `${name}/${role}`).not.toContain("null");
        expect(line, `${name}/${role}`).not.toMatch(/\(\s*\)/);
        expect(line, `${name}/${role}`).not.toMatch(/\s{2}/);
      }
    }
  });

  it("the page's removedByLabel still has the shape this mirror describes", () => {
    expect(SOURCE).toContain(
      "const role = removedByRole ? roleLabel(removedByRole) : \"\";"
    );
    expect(SOURCE).toContain('const article = /^[AEIOU]/i.test(role) ? "an" : "a";');
    expect(SOURCE).toContain("`Removed by ${article} ${role}, name not shown`");
    expect(SOURCE).toContain('"Removed by someone whose name is not shown"');
    // Called with the row's two fields, not with a coerced value.
    expect(SOURCE).toContain("removedByLabel(fm.removedByName, fm.removedByRole)");
    // The BFF keeps the suppression as null rather than blanking it.
    const router = readCode(TEAM_ROUTER);
    expect(router).toContain("removedByName: string | null;");
    expect(router).toContain("removedByRole: string;");
  });
});

// ─── The row's other nulls ───────────────────────────────────────────────────────

/**
 * Mirrors the identity and date resolution at the top of a former-members row. The real
 * `formatInstantUtc` is imported by the page; here only the BRANCH is mirrored, with a stand-in
 * that returns "" for an unusable instant exactly as the real one does (its own behaviour is
 * asserted in lib/format-datetime.test.ts, which is where it belongs).
 */
interface FormerMember {
  userId: string;
  name: string | null;
  email: string | null;
  removedAt: string;
  removedByName: string | null;
  removedByRole: string;
  reason: string | null;
  joinedAt: string | null;
}

const instant = (iso: string | null | undefined) => {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : "01 Aug 2026 20:47 UTC";
};

function formerRow(fm: FormerMember) {
  const label = fm.name || fm.email || fm.userId;
  const nameUnknown = !fm.name && !fm.email;
  const removedAtText = instant(fm.removedAt);
  const joinedAtText = instant(fm.joinedAt);

  return {
    label,
    nameUnknown,
    initial: (label || "?")[0].toUpperCase(),
    /** The second identity line, only when it adds something `label` does not already say. */
    emailLine: fm.email && fm.email !== label ? fm.email : "",
    removedLine: removedAtText ? `Removed ${removedAtText}` : "Removed, date unknown",
    joinedLine: joinedAtText ? `joined ${joinedAtText}` : "join date unknown",
    reasonLine: fm.reason ? `“${fm.reason}”` : "",
    buttonAccessibleName: `Restore access to Team X for ${label}`,
  };
}

const former = (over: Partial<FormerMember> = {}): FormerMember => ({
  userId: "8b3f1c2e-4a5d-4e6f-9a7b-0c1d2e3f4a5b",
  name: "Alice Chen",
  email: "alice@example.test",
  removedAt: "2026-08-01T20:47:00.000Z",
  removedByName: "Grace Hopper",
  removedByRole: "FACILITATOR",
  reason: null,
  joinedAt: "2026-07-01T09:00:00.000Z",
  ...over,
});

describe("joinedAt: null is 'join date unknown' and NEVER 'never joined'", () => {
  it("renders 'join date unknown'", () => {
    // The audit entry itself PROVES this person was a member of this team; null only means
    // the removal predates the field being denormalised onto the entry, and the trail is
    // append-only so there is no backfill.
    expect(formerRow(former({ joinedAt: null })).joinedLine).toBe("join date unknown");
  });

  it("the phrase 'never joined' appears NOWHERE in the page's code", () => {
    // "Never joined" would be this screen asserting a FALSEHOOD about a real person, on the
    // one surface whose purpose is to be an accurate record.
    //
    // This pin is why comment-stripping is mandatory rather than tidy: the page's own design
    // note contains the words "Never joined", so this same assertion against RAW source
    // FAILS. Asserted both ways round to prove the helper is doing the work.
    expect(SOURCE).not.toMatch(/never joined/i);
    const raw = readFileSync(fileURLToPath(new URL(TEAM_PAGE, import.meta.url)), "utf8");
    expect(raw, "the comment discussing the phrase is expected to survive").toMatch(
      /Never joined/
    );
  });

  it("renders the date when there is a usable one", () => {
    expect(formerRow(former()).joinedLine).toBe("joined 01 Aug 2026 20:47 UTC");
  });

  it("degrades an UNPARSEABLE joinedAt the same way as an absent one", () => {
    for (const joinedAt of ["", "not-a-date", "0000-00-00"]) {
      expect(formerRow(former({ joinedAt })).joinedLine, joinedAt).toBe(
        "join date unknown"
      );
    }
  });

  it("still says the REMOVAL happened when its own date is unusable", () => {
    // "Removed" followed by nothing is the blank this row must never render, and
    // "Invalid Date" next to a real person makes a data gap look like a bug in the removal.
    expect(formerRow(former({ removedAt: "nonsense" })).removedLine).toBe(
      "Removed, date unknown"
    );
    expect(formerRow(former({ removedAt: "" })).removedLine).toBe(
      "Removed, date unknown"
    );
  });

  it("the page renders both dates through formatInstantUtc and states the null wording", () => {
    expect(SOURCE).toContain("const removedAtText = formatInstantUtc(fm.removedAt);");
    expect(SOURCE).toContain("const joinedAtText = formatInstantUtc(fm.joinedAt);");
    expect(SOURCE).toContain('"join date unknown"');
    expect(SOURCE).toContain('"Removed, date unknown"');
    // No ambient locale or clock on this page, a hydration mismatch guard.
    expect(SOURCE).not.toContain("toLocaleDateString");
    expect(SOURCE).not.toContain("toLocaleString");
  });
});

describe("name and email null, a bare sub is labelled, not passed off as a name", () => {
  it("falls back name → email → userId", () => {
    expect(formerRow(former()).label).toBe("Alice Chen");
    expect(formerRow(former({ name: null })).label).toBe("alice@example.test");
    expect(formerRow(former({ name: null, email: null })).label).toBe(
      "8b3f1c2e-4a5d-4e6f-9a7b-0c1d2e3f4a5b"
    );
  });

  it("treats an EMPTY STRING as absent, not as a name", () => {
    // `||` rather than `??`, deliberately: `""` is not a name and would render a blank cell,
    // which reads as a data problem and cannot be confirmed against in the dialog.
    expect(formerRow(former({ name: "" })).label).toBe("alice@example.test");
    expect(formerRow(former({ name: "", email: "" })).label).toBe(
      "8b3f1c2e-4a5d-4e6f-9a7b-0c1d2e3f4a5b"
    );
  });

  it("MARKS the row when the label is a bare id", () => {
    // A 36-character sub is legible AS an unknown only if it is labelled one. Without the
    // marker it looks like a name nobody can pronounce, and the row reads as corrupt rather
    // than as a removal whose subject could not be resolved.
    expect(formerRow(former({ name: null, email: null })).nameUnknown).toBe(true);
    expect(formerRow(former({ name: null })).nameUnknown).toBe(false);
    expect(formerRow(former()).nameUnknown).toBe(false);
    expect(formerRow(former({ name: "", email: "" })).nameUnknown).toBe(true);
  });

  it("does not repeat the email on the second line when it IS the label", () => {
    expect(formerRow(former({ name: null })).emailLine).toBe("");
    expect(formerRow(former()).emailLine).toBe("alice@example.test");
    expect(formerRow(former({ email: null })).emailLine).toBe("");
  });

  it("does NOT throw on the decorative initial when EVERY identity field is empty", () => {
    // `""[0]` is undefined and `.toUpperCase()` on it throws, which would take the whole
    // page down over a decorative circle. `|| "?"` is the guard, and this is the case that
    // exercises it: userId is `""` too, which is out of contract but cheap to survive.
    const empty: FormerMember = former({ userId: "", name: null, email: null });
    expect(() => formerRow(empty)).not.toThrow();
    expect(formerRow(empty).label).toBe("");
    expect(formerRow(empty).initial).toBe("?");
    expect(formerRow(empty).nameUnknown).toBe(true);
  });

  it("uppercases the initial from whatever label survived", () => {
    expect(formerRow(former()).initial).toBe("A");
    expect(formerRow(former({ name: null })).initial).toBe("A");
    expect(formerRow(former({ name: "élodie" })).initial).toBe("É");
    expect(formerRow(former({ name: null, email: null })).initial).toBe("8");
  });

  it("carries the label into the button's accessible name in full", () => {
    // A stack of identical "Restore access" buttons is unusable to a screen-reader operator,
    // and the name is also the reason no hover is needed to recover a truncated id.
    expect(formerRow(former()).buttonAccessibleName).toBe(
      "Restore access to Team X for Alice Chen"
    );
    expect(formerRow(former({ name: null, email: null })).buttonAccessibleName).toContain(
      "8b3f1c2e-4a5d-4e6f-9a7b-0c1d2e3f4a5b"
    );
  });

  it("renders the operator's note only when one was written", () => {
    // A "No reason recorded" line on every row would be noise on the common case; the
    // InvitedByNote precedent is that an absent line beats a line saying "unknown".
    expect(formerRow(former({ reason: null })).reasonLine).toBe("");
    expect(formerRow(former({ reason: "Left the programme" })).reasonLine).toBe(
      "“Left the programme”"
    );
  });

  it("the page composes the label and the marker exactly this way", () => {
    expect(SOURCE).toContain("const label = fm.name || fm.email || fm.userId;");
    expect(SOURCE).toContain("const nameUnknown = !fm.name && !fm.email;");
    expect(SOURCE).toContain('{(label || "?")[0].toUpperCase()}');
    expect(SOURCE).toContain("(name unknown)");
    expect(SOURCE).toContain("{fm.email && fm.email !== label && (");
    expect(SOURCE).toContain("{fm.reason && (");
    // `??` would let a "" through as a name.
    expect(SOURCE).not.toContain("fm.name ?? fm.email");
    // The dialog and the mutation both key on the row's userId, which is what the service
    // deletes and reactivates on.
    expect(SOURCE).toContain("setPendingRestore({");
    expect(SOURCE).toContain("userId: fm.userId,");
    expect(SOURCE).toContain("name: label,");
    expect(SOURCE).toContain("email: fm.email,");
  });

  it("the dialog says 'email unknown' rather than leaving a dangling separator", () => {
    // On THIS dialog the target line is the operator's only chance to notice they are about
    // to grant access to the wrong person, so silence there would read as "no more to say".
    expect(SOURCE).toContain(
      '{pendingRestore.email ? ` · ${pendingRestore.email}` : " · email unknown"}'
    );
  });
});

// ─── truncated ───────────────────────────────────────────────────────────────────

describe("the 50-row bound is surfaced, and where a collapsed panel can still show it", () => {
  it("the notice is rendered on `truncated`, and states the cap and where the rest is", () => {
    // A quietly-truncated removal history reads as "nobody else was removed", which is the
    // one wrong answer worth guarding against on an audit-derived view.
    expect(SOURCE).toContain("{formerMembersData?.truncated && (");
    expect(SOURCE).toContain("capped at the 50 most recently removed people");
    /* Sentence-cased when the em-dash before it became a full stop: the clause is now its own
       sentence. The pin is on the WORDS, so only the capital changed. */
    expect(SOURCE).toContain("There are more removals than are shown here");
    // Says where the rest is rather than implying there is none.
    expect(SOURCE).toContain("The complete\n                  history for one person is in their audit trail.");
  });

  it("sits in the Disclosure's `notice` slot, which renders OUTSIDE the collapsible panel", () => {
    // The placement is the point: collapsed, the heading reads "Former members (50)", which
    // an operator takes as complete. Asserted in two halves, the page puts it in `notice`,
    // and `notice` is rendered outside the `{open && ...}` panel in the component.
    const notice = SOURCE.slice(
      SOURCE.indexOf("notice={", SOURCE.indexOf('id="former-members"')),
      SOURCE.indexOf("{formerMembers.length === 0 ? (")
    );
    expect(notice).toContain("formerMembersData?.truncated");
    expect(notice).toContain("<ActionOutcome");

    const disclosure = readCode(DISCLOSURE);
    const noticeIndex = disclosure.indexOf("{notice}");
    const panelIndex = disclosure.indexOf("{open && (");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(panelIndex).toBeGreaterThan(noticeIndex);
    // And the panel, not the notice, is what unmounts when collapsed.
    expect(disclosure).toContain("{open && (");
  });

  it("the count is in the heading, so a closed panel still answers 'has anyone been removed'", () => {
    expect(SOURCE).toContain("count={formerMembers.length}");
    expect(readCode(DISCLOSURE)).toContain('typeof count === "number" &&');
  });

  it("the section starts CLOSED, which is exactly why the notice must sit outside it", () => {
    expect(SOURCE).toContain("useState(false)");
    expect(SOURCE).toContain("const [showFormerMembers, setShowFormerMembers] = useState(false);");
  });

  it("the BFF reads `truncated` strictly, so a stringy value cannot read either way", () => {
    const router = readCode(TEAM_ROUTER);
    expect(router).toContain("truncated: data.truncated === true");
  });

  it("survives the LAST former member being restored, so the outcome is not unmounted with the list", () => {
    // Restoring the last row empties this list, and a section that unmounted on `length === 0`
    // would take the notice reporting that very restoration down with it, the exact failure
    // ActionOutcome's placement exists to prevent, one level up.
    expect(SOURCE).toContain("{(formerMembers.length > 0 || restoreOutcome) && (");
    expect(SOURCE).toContain("Nobody is currently listed as removed from this team.");
  });

  it("says a FAILED history lookup out loud rather than omitting the section", () => {
    // The alternative is a page that states, by the absence of the section, that nobody has
    // ever been removed from this team, indistinguishable from a healthy team.
    expect(SOURCE).toContain("{formerMembersError && (");
    expect(SOURCE).toContain("this page cannot say");
    expect(SOURCE).toContain("whether anyone has been removed");
  });
});

// ─── Gating ──────────────────────────────────────────────────────────────────────

/**
 * Mirrors the Restore gate: `canRemoveMembers`, i.e. `!isReadOnly`, derived from the REAL
 * shared predicate exactly as lib/access-action-gating.test.ts derives the Remove gate.
 *
 * NO self-check, unlike Remove, appearing in your own team's former-members list requires
 * having been removed from it, which costs you the read access that loads this page.
 */
const offersRestore = (actorRole: string | null | undefined) => !isReadOnlyRole(actorRole);
const offersRemove = (actorRole: string | null | undefined, isSelf: boolean) =>
  !isReadOnlyRole(actorRole) && !isSelf;

describe("who is offered Restore, the SAME predicate as Remove", () => {
  const ALL_ROLES = Object.keys(USER_ADMIN_GRANTS) as UserRole[];

  it("agrees with READ_ONLY_ROLES for every role, rather than naming EXECUTIVE", () => {
    // Derived, so adding a second read-only role to the shared constant closes this control
    // for it automatically instead of leaving one screen behind.
    for (const actor of ALL_ROLES) {
      expect(offersRestore(actor), actor).toBe(!isReadOnlyRole(actor));
    }
  });

  it("hides it from a read-only EXECUTIVE", () => {
    // A courtesy, not the control: `requireTeamWrite` in the team service refuses the request
    // regardless, and its refusal renders in the outcome notice.
    expect(offersRestore("EXECUTIVE")).toBe(false);
  });

  it("offers it to every role that may Remove, on every OTHER person's row", () => {
    // The exact-complement assertion. A screen that offered Remove but hid Restore would
    // make every mistaken removal permanent for the person who made it.
    for (const actor of ALL_ROLES) {
      expect(offersRestore(actor), actor).toBe(offersRemove(actor, false));
    }
  });

  it("is offered on an unresolved session, matching Remove's direction of looseness", () => {
    // `useIsReadOnly` reads the session, which is empty on the first render. The looseness
    // fails in the right direction: an unentitled caller gets the service's own legible 403,
    // where hiding the control from someone entitled is invisible.
    expect(offersRestore(undefined)).toBe(true);
    expect(offersRestore(null)).toBe(true);
    expect(offersRestore("")).toBe(true);
    // And an unknown role is not treated as read-only either, same as Remove.
    expect(offersRestore("SUPERUSER")).toBe(true);
  });

  it("carries NO self-check, and that absence is deliberate", () => {
    // Documented rather than asserted as universally correct: the case is unreachable
    // (being in your own team's former-members list costs you the read access that loads this
    // page), so a guard for it would be a rule with no situation.
    const restoreButton = SOURCE.slice(
      SOURCE.indexOf("aria-label={`Restore access to ${team.name} for ${label}`}") - 400,
      SOURCE.indexOf("aria-label={`Restore access to ${team.name} for ${label}`}")
    );
    expect(restoreButton).toContain("{canRemoveMembers && (");
    expect(restoreButton).not.toContain("isSelf");
  });

  it("the page gates Restore on canRemoveMembers and introduces NO new role matrix", () => {
    expect(SOURCE).toContain("const isReadOnly = useIsReadOnly();");
    expect(SOURCE).toContain("const canRemoveMembers = !isReadOnly;");
    expect(SOURCE).toContain("{canRemoveMembers && (");
    // Remove keeps its self-check; the two gates differ by that clause only.
    expect(SOURCE).toContain("{canRemoveMembers && !isSelf && (");
    // No second predicate invented for this control, and no hand-rolled role comparison.
    expect(SOURCE).not.toContain("canRestoreMembers");
    expect(SOURCE).not.toMatch(/role\s*===\s*"(EXECUTIVE|ADMIN|FACILITATOR)"/);
    expect(SOURCE).not.toContain("READ_ONLY_ROLES");
    // The one EXECUTIVE literal in the page's code is the invite form's team-role gate,
    // which is a different question, asserted so this pin cannot be satisfied by accident.
    expect(SOURCE).toContain('platformRole === "PARTICIPANT" || platformRole === "EXECUTIVE"');
    expect((SOURCE.match(/EXECUTIVE/g) ?? []).length).toBe(1);
  });

  it("the BFF adds no fourth copy of the matrix on reactivateMember either", () => {
    // The gate is `requireTeamWrite` in the team service, byte-for-byte the guard on the
    // DELETE this reverses. A check in the BFF would be advisory (every service route is
    // mapped ANY behind a JWT authorizer with no role scoping, and the browser holds its own
    // token) and would silently go stale.
    const router = readCode(TEAM_ROUTER);
    const reactivate = router.slice(
      router.indexOf("reactivateMember: protectedProcedure"),
      router.indexOf("listFormerMembers: protectedProcedure")
    );
    expect(reactivate).not.toContain("isReadOnlyRole");
    expect(reactivate).not.toContain("USER_ADMIN_GRANTS");
    // A comparison against a ROLE NAME, which is what a smuggled-in matrix looks like. Named
    // roles rather than `/role\s*===\s*"/`, because the latter also matches
    // `typeof data.role === "string"`, the type guard that keeps the preserved team role from
    // arriving as a non-string, which is not a matrix and must stay.
    expect(reactivate).not.toMatch(
      /===\s*"(ADMIN|FACILITATOR|EXECUTIVE|JUDGE|PARTICIPANT)"/
    );
    expect(reactivate).toContain('typeof data.role === "string"');
    expect(reactivate).toContain("/reactivate");
    expect(reactivate).toContain('method: "POST"');
  });
});

/**
 * THE TEAM VIEW'S DEFAULTS, what loads, what opens, and what waits to be asked for.
 *
 * Source assertions, in the idiom this file already uses: these are structural facts about
 * the page (which query is gated, which disclosure starts open) rather than behaviour a
 * harness can exercise without a DOM.
 */
describe("team view defaults", () => {
  it("DEFERS the invitations query until the section is opened", () => {
    // It used to run on mount, so every visit paid for a list nobody had asked to see -
    // and a PARTICIPANT, who may grant no roles at all, could never open it.
    const q = restoreRegion(
      "trpc.team.listInvitations.useQuery(",
      "const sentInvitations"
    );
    expect(q).toContain("enabled: showInvitations");
    // And explicitly NOT the always-on forms. Asserting only the positive let
    // `enabled: true` pass, because that region still mentioned `showInvitations`
    // elsewhere, the mutation survived and the test did not notice.
    expect(q).not.toMatch(/enabled:\s*true/);
  });

  it("opens MEMBERS by default and leaves INVITATIONS closed", () => {
    // The roster is what someone opens a team view to see; a collapsed default made the
    // page look like the team had no members.
    expect(SOURCE).toContain("useState(true)");
    const invites = restoreRegion(
      "const [showInvitations, setShowInvitations]",
      ";"
    );
    expect(invites).toContain("useState(false)");
    const members = restoreRegion("const [showMembers, setShowMembers]", ";");
    expect(members).toContain("useState(true)");
  });

  it("does NOT claim a count before the invitations have loaded", () => {
    // Deferring the fetch introduced a small lie: `?? []` made the collapsed heading read
    // "Invitations (0)" for data that had never been requested. Same class of bug as the
    // "0 teams" placeholder. `undefined` makes Disclosure omit the count entirely.
    expect(SOURCE).toContain("invitationsQuery.isSuccess ? sentInvitations.length : undefined");
    expect(SOURCE).toContain("count={invitationCount}");
  });

  it("puts the invite form behind a button rather than expanding it on arrival", () => {
    // A 170-line form used to sit ABOVE the roster, showing an action most viewers cannot
    // perform before the information they came for.
    expect(SOURCE).toContain("setShowInvitePanel");
    const panel = restoreRegion("const [showInvitePanel, setShowInvitePanel]", ";");
    expect(panel).toContain("useState(false)");
  });

  it("renders MEMBERS before INVITATIONS", () => {
    // Order is the whole point of the change: the roster first, the administrative record
    // after it.
    expect(SOURCE.indexOf('id="members"')).toBeGreaterThan(-1);
    expect(SOURCE.indexOf('id="members"')).toBeLessThan(SOURCE.indexOf('id="invitations"'));
  });
});
