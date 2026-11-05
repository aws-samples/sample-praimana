import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient, MutationObserver } from "@tanstack/query-core";

/**
 * WHAT HAPPENS WHEN TWO ACCESS-AFFECTING REQUESTS OVERLAP.
 *
 * ── WHY THIS RUNS AGAINST THE REAL MutationObserver ──
 * The behaviour under test IS react-query's: which callback fires, in what order, and what
 * the shared mutation state holds while a second request is in flight. A hand-rolled stand-in
 * would be asserting my model of react-query rather than react-query, and the whole point of
 * these cases is that the real library's single-observer semantics are not what the page's
 * callbacks assume. So the harness drives a genuine `MutationObserver` from
 * `@tanstack/query-core` (the same instance `trpc.<x>.useMutation` builds on) with a
 * controllable `mutationFn`, and the page's `onSuccess`/`onSettled` bodies are transcribed
 * faithfully around it.
 *
 * DETERMINISM. No sleeps as synchronisation and no randomness: every request is resolved
 * explicitly by the test, in an order the test chooses, and `flush()` drains the
 * microtask/notify queue. Same result on every run and there is no seed to record.
 *
 * ── WHAT THIS CANNOT COVER ──
 * The `disabled={pending}` attribute on the confirm button, which is the FIRST line of
 * defence against a double-click, is a DOM property. There is no DOM environment in this
 * suite, so its effect is pinned structurally below and flagged as needing a browser.
 * What is covered here is the layer underneath it: what the state machine does when a
 * second request reaches it anyway, which is the case that survives a slow render, a
 * synthetic click, or the operator route these tests actually found.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const ADMIN_PAGE = "../app/admin/page.tsx";
const TEAM_PAGE = "../app/w/[workshopId]/t/[teamId]/team/page.tsx";
const DIALOG = "../components/ConfirmActionDialog.tsx";

/** Drain react-query's notify queue. Deterministic: no wall-clock dependency. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// ─── The team page's removal state machine ──────────────────────────────────────

/**
 * A faithful transcription of the team page's removal state and mutation callbacks -
 * `pendingRemoval`, `removing`, `removeOutcome`, `removalLabelRef`,
 * `removalSucceededRef`, and the three callbacks on `trpc.team.removeMember.useMutation`.
 *
 * Only the transport is substituted, and only so the test can decide WHEN each request
 * answers. Everything that decides what the operator sees is the page's own logic.
 */
function teamPageHarness() {
  const client = new QueryClient();
  const settle = new Map<string, (value: { success: true; audited: boolean }) => void>();
  const invalidations: string[] = [];

  const state = {
    pendingRemoval: null as { userId: string; name: string } | null,
    removing: null as string | null,
    removeOutcome: null as { kind: string; message: string } | null,
  };
  const removalLabelsRef = { current: new Map<string, string>() };
  const currentRemovalRef = { current: null as string | null };
  const removalSucceededRef = { current: false };

  // Generics pinned so `variables` is typed on every callback. react-query widens it to
  // `TVariables | undefined`, so each callback still guards, and that guard is both what
  // satisfies the types and the behaviour under test.
  const observer = new MutationObserver<
    { success: true; audited: boolean },
    Error,
    { userId: string }
  >(client, {
    mutationFn: (variables) =>
      new Promise<{ success: true; audited: boolean }>((resolve) => {
        settle.set(variables.userId, resolve);
      }),
    onSuccess: (result, variables) => {
      if (!variables) return;
      const isCurrent = variables.userId === currentRemovalRef.current;
      const name = removalLabelsRef.current.get(variables.userId) ?? "The member";
      if (isCurrent) removalSucceededRef.current = true;
      state.removeOutcome = result.audited
        ? { kind: "confirmed", message: `${name} is no longer a member of Team X.` }
        : {
            kind: "partial",
            message: `${name} was removed from Team X, but the action could not be written to the audit trail.`,
          };
      if (isCurrent) state.pendingRemoval = null;
      invalidations.push("team.getById");
    },
    onError: (error, variables) => {
      if (!variables) return;
      const isCurrent = variables.userId === currentRemovalRef.current;
      const name = removalLabelsRef.current.get(variables.userId) ?? "The member";
      state.removeOutcome = {
        kind: "failed",
        message: error.message || `${name} was not removed.`,
      };
      if (isCurrent) state.pendingRemoval = null;
    },
    onSettled: (_data, _error, variables) => {
      if (!variables) return;
      if (variables.userId === currentRemovalRef.current) {
        state.removing = null;
        currentRemovalRef.current = null;
      }
      removalLabelsRef.current.delete(variables.userId);
    },
  });

  return {
    state,
    removalSucceededRef,
    invalidations,
    /** The Remove button on a roster row. */
    clickRemove(userId: string, name: string) {
      removalSucceededRef.current = false;
      state.pendingRemoval = { userId, name };
    },
    /** Whether that row's Remove button is disabled, `isRemoving` in the row. */
    rowDisabled(userId: string) {
      return state.removing === userId;
    },
    /** Whether the dialog's confirm button is disabled, the `pending` prop. */
    confirmDisabled() {
      return state.removing === state.pendingRemoval?.userId;
    },
    /** The dialog's Confirm. */
    async confirm() {
      const target = state.pendingRemoval;
      if (!target) throw new Error("no dialog open");
      removalLabelsRef.current.set(target.userId, target.name);
      currentRemovalRef.current = target.userId;
      state.removing = target.userId;
      state.removeOutcome = null;
      observer.mutate({ userId: target.userId }).catch(() => {});
      await flush();
    },
    /** The dialog's Cancel/Close/Escape/backdrop, all one path. */
    dismiss() {
      const wasPending = state.removing === state.pendingRemoval?.userId;
      if (wasPending) {
        state.removeOutcome = {
          kind: "unknown",
          message: `The request to remove ${state.pendingRemoval?.name} was sent but the result was never seen. Reload the page.`,
        };
      }
      state.pendingRemoval = null;
    },
    async respond(userId: string, audited = true) {
      settle.get(userId)!({ success: true, audited });
      await flush();
    },
    inFlight() {
      return Array.from(settle.keys());
    },
  };
}

describe("a single removal, confirmed once", () => {
  it("sends exactly one request and reports it as confirmed", async () => {
    const h = teamPageHarness();
    h.clickRemove("alice", "Alice");
    await h.confirm();

    expect(h.inFlight()).toEqual(["alice"]);
    expect(h.confirmDisabled()).toBe(true);
    expect(h.rowDisabled("alice")).toBe(true);

    await h.respond("alice");
    expect(h.state.removeOutcome).toEqual({
      kind: "confirmed",
      message: "Alice is no longer a member of Team X.",
    });
    expect(h.state.pendingRemoval).toBeNull();
    expect(h.state.removing).toBeNull();
    expect(h.invalidations).toEqual(["team.getById"]);
  });

  it("disables ONLY the row being removed, not the rest of the roster", async () => {
    // `removing` is a userId, not a boolean. A boolean would grey out every Remove button
    // on the roster for the duration of one request, which reads as the page having failed
    // and is the behaviour the `revoking === inv.email` precedent exists to avoid.
    const h = teamPageHarness();
    h.clickRemove("alice", "Alice");
    await h.confirm();

    expect(h.rowDisabled("alice")).toBe(true);
    expect(h.rowDisabled("bob")).toBe(false);
    expect(h.rowDisabled("carol")).toBe(false);
  });

  it("clears the previous outcome when a new confirm is issued", async () => {
    // A stale success sitting above the roster while a second removal is in flight would be
    // read as that removal's result.
    const h = teamPageHarness();
    h.clickRemove("alice", "Alice");
    await h.confirm();
    await h.respond("alice");
    expect(h.state.removeOutcome?.kind).toBe("confirmed");

    h.clickRemove("bob", "Bob");
    await h.confirm();
    expect(h.state.removeOutcome).toBeNull();
  });
});

describe("the UNKNOWN path, dismissing while a request is in flight", () => {
  it("reports UNKNOWN rather than implying nothing happened", async () => {
    // Dismissal stays available while pending on purpose: backendFetch passes no
    // AbortSignal, so locking the dialog until the mutation settles would trap an operator
    // in a modal during exactly the incident they opened it for.
    const h = teamPageHarness();
    h.clickRemove("alice", "Alice");
    await h.confirm();
    h.dismiss();

    expect(h.state.removeOutcome?.kind).toBe("unknown");
    expect(h.state.removeOutcome?.message).toContain("Reload the page");
    expect(h.state.pendingRemoval).toBeNull();
  });

  it("does NOT cancel the request, the effect may still land", async () => {
    // The honest part of the design, and the reason the message says "reload" rather than
    // "try again": the DELETE is already on its way to a service that will act on it.
    const h = teamPageHarness();
    h.clickRemove("alice", "Alice");
    await h.confirm();
    h.dismiss();

    expect(h.inFlight()).toEqual(["alice"]);
  });
});

// ─── DEFECT: overlapping requests share one set of correlation slots ─────────────

/**
 * ⚠ THE ASSERTIONS IN THIS BLOCK CURRENTLY FAIL, AND THAT IS THE POINT.
 *
 * They state the invariant the screens must hold, not the behaviour they have. Written the
 * other way round, asserting the misattribution as expected, they would pass today and
 * then FAIL when the defect was fixed, which is a test that defends a bug.
 *
 * THE REACHABLE OPERATOR SEQUENCE. Every step is a supported interaction, and no step is a
 * double-click or a synthetic event:
 *
 *   1. Confirm a removal for Alice. The request is in flight and unanswered.
 *   2. Dismiss the dialog. Supported and documented, the outcome is recorded as UNKNOWN
 *      and the dialog closes. Alice's request is NOT cancelled (no AbortSignal).
 *   3. Open Remove on Bob and confirm. Bob's row was never disabled (pending is keyed on
 *      Alice's userId), so nothing anywhere prevents this.
 *   4. ALICE'S RESPONSE ARRIVES, while Bob's is still in flight.
 *
 * At step 4 the page has ONE mutation instance and ONE set of callbacks, and every piece of
 * correlation state, `removalLabelRef`, `removalSucceededRef`, `pendingRemoval`,
 * `removing`, has already been overwritten by Bob's submit. react-query does not queue or
 * discard the first request: both `mutationFn`s run and both callback sets fire (verified
 * against the real MutationObserver, which is why this harness uses it).
 *
 * THE FIX belongs to senior-developer, not here: `onSuccess`/`onError`/`onSettled` receive
 * the resolved `variables` as an argument, so each callback can compare the answering
 * userId against the current one and ignore a response that is not for the dialog on
 * screen. The label should travel per-request rather than through a single-slot ref.
 */
describe("two removals overlapping, one dialog, one shared mutation", () => {
  let h: ReturnType<typeof teamPageHarness>;

  beforeEach(async () => {
    h = teamPageHarness();
    h.clickRemove("alice", "Alice");
    await h.confirm();
    h.dismiss(); // step 2, supported
    h.clickRemove("bob", "Bob");
    await h.confirm(); // step 3, nothing blocks it
  });

  it("permits both requests to be in flight at once", async () => {
    // Not a defect in itself, just the precondition, and proof that react-query neither
    // queues nor drops the first request.
    expect(h.inFlight().sort()).toEqual(["alice", "bob"]);
  });

  it("attributes Alice's response to ALICE, not to whoever was confirmed last", async () => {
    // `removalLabelRef` is a single slot overwritten at submit and read when the response
    // lands. The notice is the only durable record of the action and is explicitly designed
    // to outlive the row, so naming the wrong person makes it worse than absent: nobody
    // learns Alice was removed, and Bob is reported as removed before he is.
    await h.respond("alice");

    expect(h.state.removeOutcome?.message).toContain("Alice");
  });

  it("leaves Bob's still-pending dialog OPEN when Alice's response lands", async () => {
    // onSuccess sets pendingRemoval to null unconditionally, so Bob's confirmation is torn
    // out from under the operator by a different request's answer, with a green "removed"
    // notice above the roster while Bob's own DELETE is still unanswered.
    await h.respond("alice");
    expect(h.state.pendingRemoval).not.toBeNull();
  });

  it("keeps Bob's per-row pending guard UP while Bob's request is in flight", async () => {
    // onSettled clears `removing` unconditionally. That guard is the ONLY thing standing
    // between the operator and a second DELETE for Bob, and it is released by an unrelated
    // request settling. The team service's delete is unconditional and records a
    // MEMBER_REMOVED audit entry every time (the team service's `routes.ts`:996-1017), so
    // a second submit is a second recorded removal of an already-removed member.
    await h.respond("alice");

    expect(h.state.removing).toBe("bob");
    expect(h.rowDisabled("bob")).toBe(true);
  });

  it("does not let a SECOND DELETE for Bob be issued without an operator retry", async () => {
    // Answers the question that was asked directly: can the UI produce a duplicate
    // MEMBER_REMOVED WITHOUT the operator deliberately retrying an unknown outcome? Today
    // it can, Bob's button is live again, Bob's dialog is closed, and the notice on screen
    // says a removal succeeded, so a duplicate is what a reasonable operator would then do.
    await h.respond("alice");

    expect(h.confirmDisabled() || h.state.pendingRemoval === null).toBe(true);
    expect(h.rowDisabled("bob")).toBe(true);
  });

  it("does not report a green CONFIRMED for a request that has not answered", async () => {
    // The worst reading of the same cause: Alice's success paints "Bob is no longer a
    // member" in green while Bob's request is still outstanding and may yet 403 or time
    // out. If it then fails, the failure overwrites the success, but in between the
    // operator has been told something untrue about Bob and may act on it.
    await h.respond("alice");

    const claimsBobRemoved =
      h.state.removeOutcome?.kind === "confirmed" &&
      h.state.removeOutcome.message.includes("Bob");
    expect(claimsBobRemoved, "green 'Bob removed' while Bob is unanswered").toBe(false);
    expect(h.inFlight()).toContain("bob");
  });

  it("does not set removalSucceededRef from a DIFFERENT request", async () => {
    // `returnToFallback` reads this ref at cleanup. Alice's success sets it, so Bob's
    // dialog, closed by that same callback, treats Bob's trigger as doomed and sends
    // focus to the Members heading, even though Bob's row is still on the roster with a
    // live Remove button that focus should have returned to.
    await h.respond("alice");
    expect(h.removalSucceededRef.current).toBe(false);
  });
});

// ─── The same defect on the Administration screen ───────────────────────────────

function adminPageHarness() {
  const client = new QueryClient();
  const settle = new Map<string, (v: AccessResponse) => void>();
  interface AccessResponse {
    userId: string;
    enabled: boolean;
    invitationsRevoked: number;
    invitationsRevokeComplete: boolean;
    audited: boolean;
  }

  const state = {
    pendingAccess: null as { userId: string; name: string; enable: boolean } | null,
    submittingAccess: null as string | null,
    accessOutcome: null as { kind: string; message: string } | null,
  };
  const accessLabelsRef = { current: new Map<string, string>() };
  const currentAccessRef = { current: null as string | null };

  const observer = new MutationObserver<AccessResponse, Error, { userId: string }>(client, {
    mutationFn: (variables) =>
      new Promise<AccessResponse>((resolve) => {
        settle.set(variables.userId, resolve);
      }),
    onSuccess: (result, variables) => {
      if (!variables) return;
      const isCurrent = variables.userId === currentAccessRef.current;
      const name = accessLabelsRef.current.get(variables.userId) ?? "That account";
      if (result.enabled) {
        state.accessOutcome = {
          kind: result.audited ? "confirmed" : "partial",
          message: `${name} can sign in again.`,
        };
      } else {
        const gaps: string[] = [];
        if (!result.invitationsRevokeComplete) gaps.push("an invitation survived");
        if (!result.audited) gaps.push("it was not audited");
        state.accessOutcome = {
          kind: gaps.length === 0 ? "confirmed" : "partial",
          message: `${name} can no longer sign in.${gaps.length ? ` However, ${gaps.join(" Also, ")}` : ""}`,
        };
      }
      if (isCurrent) state.pendingAccess = null;
    },
    onSettled: (_data, _error, variables) => {
      if (!variables) return;
      if (variables.userId === currentAccessRef.current) {
        state.submittingAccess = null;
        currentAccessRef.current = null;
      }
      accessLabelsRef.current.delete(variables.userId);
    },
  });

  return {
    state,
    openDialog(userId: string, name: string, enable: boolean) {
      state.pendingAccess = { userId, name, enable };
    },
    rowDisabled(userId: string) {
      return state.submittingAccess === userId;
    },
    async confirm() {
      const target = state.pendingAccess!;
      accessLabelsRef.current.set(target.userId, target.name);
      currentAccessRef.current = target.userId;
      state.submittingAccess = target.userId;
      state.accessOutcome = null;
      observer.mutate({ userId: target.userId }).catch(() => {});
      await flush();
    },
    dismiss() {
      const wasPending = state.submittingAccess === state.pendingAccess?.userId;
      if (wasPending) {
        state.accessOutcome = {
          kind: "unknown",
          message: `The request for ${state.pendingAccess?.name} was sent but the result was never seen.`,
        };
      }
      state.pendingAccess = null;
    },
    async respond(userId: string, over: Partial<AccessResponse> = {}) {
      settle.get(userId)!({
        userId,
        enabled: false,
        invitationsRevoked: 1,
        invitationsRevokeComplete: true,
        audited: true,
        ...over,
      });
      await flush();
    },
    inFlight() {
      return Array.from(settle.keys());
    },
  };
}

describe("two access changes overlapping on the Administration screen", () => {
  /** The same supported four-step sequence as the roster block above. */
  const overlapped = async () => {
    const h = adminPageHarness();
    h.openDialog("alice", "Alice", false);
    await h.confirm();
    h.dismiss();
    h.openDialog("bob", "Bob", false);
    await h.confirm();
    return h;
  };

  it("attributes a SURVIVING-CREDENTIAL warning to the person it is actually about", async () => {
    // ⚠ CURRENTLY FAILS. The sharpest consequence of the shared correlation slot: this
    // message names which specific guarantee failed. Alice's surviving-invitation warning is
    // printed against Bob's name, so nobody goes looking for ALICE's live credential, the
    // one that lets a locked-out person re-register under a new sub, and Bob is reported as
    // having one he does not have.
    const h = await overlapped();

    await h.respond("alice", { invitationsRevokeComplete: false });

    expect(h.state.accessOutcome?.kind).toBe("partial");
    expect(h.state.accessOutcome?.message).toContain("an invitation survived");
    expect(h.state.accessOutcome?.message).toContain("Alice");
  });

  it("keeps Bob's per-row pending guard UP when only ALICE's request has settled", async () => {
    // ⚠ CURRENTLY FAILS. A disable is not idempotent in its side effects: the user-access
    // service revokes invitations and writes an ACCESS_DISABLED audit entry on every call.
    const h = await overlapped();
    expect(h.rowDisabled("bob")).toBe(true);

    await h.respond("alice");

    expect(h.rowDisabled("bob")).toBe(true);
    expect(h.inFlight()).toContain("bob");
  });

  it("leaves Bob's dialog open when Alice's response lands", async () => {
    // ⚠ CURRENTLY FAILS.
    const h = await overlapped();

    await h.respond("alice");
    expect(h.state.pendingAccess).not.toBeNull();
  });

  it("does not disable an unrelated row while one change is in flight", async () => {
    // The correct half, asserted so a fix for the above cannot be "make pending global" -
    // that would fix the correlation bug by breaking the directory.
    const h = adminPageHarness();
    h.openDialog("alice", "Alice", false);
    await h.confirm();

    expect(h.rowDisabled("alice")).toBe(true);
    expect(h.rowDisabled("bob")).toBe(false);
  });
});

// ─── What the source guarantees, and what it does not ───────────────────────────

describe("the structural guards against a double-submit", () => {
  it("disables the dialog's confirm button the instant it is pressed", () => {
    // The first line of defence against a double-click, and the ONLY one, there is no
    // guard inside onConfirm. Whether it holds depends on React having re-rendered between
    // two click events, which this suite cannot observe. Pinned so it cannot be removed
    // silently; see the gaps note in the report.
    const source = readCode(DIALOG);
    expect(source).toContain("disabled={pending}");
  });

  it("disables each row's own trigger while ITS request is in flight", () => {
    const admin = readCode(ADMIN_PAGE);
    const team = readCode(TEAM_PAGE);
    expect(admin).toContain("disabled={submitting}");
    expect(team).toContain("disabled={isRemoving}");
  });

  it("does NOT guard onConfirm itself against a second invocation", () => {
    // Documenting the absence, not asserting it is correct. `onConfirm` calls `.mutate()`
    // unconditionally, so anything that gets past the disabled attribute reaches the
    // service. That is the hole the overlapping-request cases above walk through.
    const admin = readCode(ADMIN_PAGE);
    const confirmBody = admin.slice(
      admin.indexOf("onConfirm={(reason) => {"),
      admin.indexOf("onDismiss={(wasPending) => {")
    );
    expect(confirmBody).toContain("setUserAccess.mutate({");
    expect(confirmBody).not.toContain("if (submittingAccess");
  });

  it("gives every callback the ANSWERING request's identity, not a single shared slot", () => {
    // The inverse of what this test pinned while the defect was live. It asserted the
    // single-slot read at the line that caused the misattribution; that line is gone, so the
    // assertion is now that the correlating shape is present and the broken one cannot come
    // back, a rename or a revert that reintroduces a shared label slot fails here.
    //
    // Guarded at the SOURCE and not only through the harnesses above, because those are
    // transcriptions: they can be made to agree with a regressed page and would then pass
    // while the screen misnames people. This is the check that cannot drift.
    for (const [label, code] of [
      ["admin", readCode(ADMIN_PAGE)],
      ["team", readCode(TEAM_PAGE)],
    ] as const) {
      // Every callback that touches shared UI state receives `variables`.
      expect(code, `${label}: onSuccess must receive variables`).toContain(
        "onSuccess: (result, variables) => {"
      );
      expect(code, `${label}: onError must receive variables`).toContain(
        "onError: (err, variables) => {"
      );
      expect(code, `${label}: onSettled must receive variables`).toContain(
        "onSettled: (_data, _err, variables) => {"
      );
      // The label is recovered per-request, keyed by the id in `variables`.
      expect(code, `${label}: label must be looked up by the answering userId`).toContain(
        ".get(variables.userId)"
      );
      // No single-slot label ref survives anywhere in the file.
      expect(code, `${label}: a shared label slot must not return`).not.toMatch(
        /LabelRef\.current(?!\s*\.)/
      );
    }
  });
});
