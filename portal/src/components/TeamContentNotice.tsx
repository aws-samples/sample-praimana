"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useIsReadOnly } from "@/lib/useRole";

/**
 * THE TWO REASONS A TEAM-CONTENT PAGE HAS NOTHING TO SHOW, and why they must never look
 * alike.
 *
 * The four team-content surfaces are member-only, so a facilitator, judge or
 * admin who is not on the team gets 403 from the board, the chat, the AI threads, the
 * code and the insights. That 403 is a RULE, and the operator's correct next action is to
 * carry on with the roster on the Team tab. A 500 or a dropped connection on the same
 * page is a FAULT, and the correct next action is to retry and then escalate. An
 * interface that renders both as the same red panel teaches an operator to read a working
 * rule as an outage during the incident when they can least afford to.
 *
 * So the two states are separated on three axes at once, none of them colour:
 *
 *   RULE   `border-dashed`, gray, "visible to team members", role="status".
 *   FAULT  solid red card, "couldn't load", role="alert", and a Try again button.
 *
 * The dashed-gray border is deliberately the idiom this codebase already uses for "there
 * is legitimately nothing here" (the team page's empty roster, the Administration screen's
 * empty search, the Submit stub), and the red card is deliberately RouteError's, so both
 * faces are already familiar before an operator reads a word of them.
 *
 * WHY NOT LITERALLY RouteError. It is the body of an `error.tsx` segment boundary: it takes
 * the segment's `reset()` and Next's `digest`, and it fills `min-h-screen`. Rendered inside
 * the team workspace shell it would push the tabs, including the Team tab that is the way
 * out, off the top of a laptop screen. The boundary still exists and still uses
 * RouteError for a THROWN render error; this is for a query that answered.
 *
 * NEITHER FACE IS A TOAST. Both persist until the operator navigates: a page that has no
 * content is not a transient confirmation, and nothing here auto-dismisses.
 */

/**
 * Shared geometry AND the announcement contract, so the two faces cannot drift apart in
 * size, position, or how loudly they interrupt.
 *
 * The role is derived from the tone rather than passed, because the pairing is the
 * decision: a rule announces politely (role="status") and a fault interrupts
 * (role="alert"). Letting a caller choose would let one page announce a working rule as
 * an emergency, which is the confusion this whole component exists to prevent. Same
 * split, same reasoning, as ActionOutcome's `assertive` table.
 *
 * The role sits on the element that MOUNTS with the message inside it, so the whole
 * notice is announced once when the page settles, not word by word as it renders.
 */
function NoticePanel({
  tone,
  children,
}: {
  tone: "rule" | "fault";
  children: ReactNode;
}) {
  return (
    // The panel sits at a FIXED place, top-centre of the content area, one column width -
    // on all six pages, so an operator who has seen it once knows where to look the next
    // time without reading. max-w-md keeps the prose at a readable measure at 200% zoom.
    <div className="flex justify-center px-6 py-12">
      <div
        role={tone === "rule" ? "status" : "alert"}
        className={`w-full max-w-md rounded-lg p-6 text-center ${
          tone === "rule"
            ? "border border-dashed border-field-border bg-surface-1"
            : "border border-danger-border bg-danger-bg"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * "This surface belongs to the team, and you are not on it."
 *
 * NOT AN ERROR, and the whole point of the component is that it does not read as one. The
 * operator has done nothing wrong, nothing is broken, and there is a next action.
 *
 * role="status" rather than role="alert": this announces politely when the page settles
 * instead of interrupting, which is the same split ActionOutcome applies, assertive is for
 * the states that need answering now, and a rule does not.
 */
export function MemberOnlyNotice({
  /**
   * What is member-only, as a full sentence naming THIS surface in the operator's words
   * ("This team's board…"). Per-page rather than one generic string: an operator who has
   * pasted a link needs to know which door they are standing at, and "Access denied" tells
   * them nothing they cannot already see.
   */
  what,
  /** The Team tab for THIS team, the one section that is not member-only. */
  teamHref,
}: {
  what: string;
  teamHref: string;
}) {
  /**
   * WHICH NEXT ACTION TO PROMISE, and the trap this avoids.
   *
   * An EXECUTIVE is read-only but may perfectly well BE a member, two of the six current
   * members are executives, so read-only and non-member are independent facts and this
   * component must never treat one as evidence of the other. It is not consulted to decide
   * whether to show this notice at all (the server's 403 decides that); it decides only
   * whether the sentence may say "manage its roster", because offering a read-only observer
   * a management action they will be refused is the same defect in a smaller frame.
   */
  const readOnly = useIsReadOnly();

  return (
    <NoticePanel tone="rule">
      <h2 className="text-base font-semibold text-ink-muted">
        Visible to team members
      </h2>
      <p className="mt-2 text-sm text-ink-muted">{what}</p>
      <p className="mt-2 text-sm text-ink-muted">
        {readOnly
          ? "You can see who is on this team from the Team tab."
          : "You can see who is on this team, and manage its roster, from the Team tab."}
      </p>
      {/* A LINK, not a "go back". The operator may have arrived by pasted URL with no
          history to go back to, and the Team tab is the destination in either case. */}
      <Link
        href={teamHref}
        className="mt-5 inline-block rounded-md border border-field-border bg-surface-3 px-4 py-2 text-sm font-medium text-brand-text hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-brand"
      >
        Go to the Team tab
      </Link>
    </NoticePanel>
  );
}

/**
 * "Something is broken, and it is not you."
 *
 * The counterpart the separation above depends on: without this, every non-403 failure
 * would fall through to whichever empty state the page already had, "No team messages
 * yet." on a chat whose service is down, which is the most dangerous sentence on the
 * screen because it is indistinguishable from the truth.
 *
 * role="alert", because this one does need answering now.
 */
export function ContentLoadError({
  /**
   * What failed, named as a surface rather than an endpoint ("this team's chat"), so the
   * sentence still means something to an operator who does not know the service names.
   */
  what,
  /**
   * The SERVICE'S OWN message when there is one. It names the thing that actually broke,
   * which no sentence written here can; the same reason the team page shows the backend's
   * refusal verbatim in its outcome notice. Absent for a transport failure that produced
   * no message at all.
   */
  detail,
  onRetry,
  /**
   * A prop for the same reason it is one on Disclosure: this component renders both as a
   * whole page (under the layout's <h1>, so <h2>) and scoped INSIDE a section that already
   * has an <h3>, the ratings card, the document viewer. A hardcoded level would skip or
   * duplicate a rank there and leave a screen-reader operator with a broken outline on the
   * one panel that is telling them something is wrong.
   */
  headingLevel = 2,
}: {
  what: string;
  detail?: string;
  onRetry: () => void;
  headingLevel?: 2 | 4;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h4";

  return (
    <NoticePanel tone="fault">
      <Heading className="text-base font-semibold text-danger-text">
        Couldn&apos;t load {what}
      </Heading>
      {/* WHAT IT MEANS before what the machine said: the consequence, you are looking at
          missing data, not at a team that has none, is the part that changes what the
          operator does next, and a bare service message reads as an empty page with a
          caption.

          NO SPATIAL WORDS ("below", "above"): this panel renders both as a whole page and
          scoped inside a card, so any sentence that points at its own position is wrong in
          one of the two placements. The second clause is conditional for the same reason -
          "quote the message" must not be said when there is no message to quote, which is
          exactly the transport-failure case where an operator would then hunt for one. */}
      <p className="mt-2 text-sm text-danger-text">
        This is a failure to load, not an empty team, the data is missing, not absent.{" "}
        {detail
          ? "Try again; if it keeps failing, report it and quote the message here."
          : "Try again; if it keeps failing, check your connection and then report it."}
      </p>
      {detail && (
        // red-700 on red-50 is 6.05:1. NOT red-400 (2.14:1 on this surface), which is what a
        // de-emphasised detail line would reflexively get, this is the string an operator has
        // to quote to whoever they escalate to, so it has to survive glare and a wall display.
        // `break-words` because a service message can carry an unbroken URL or id, and a long
        // token must wrap rather than widen the panel.
        <p className="mt-2 break-words text-xs text-danger-text">{detail}</p>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 rounded-md bg-danger-text-strong px-4 py-2 text-sm font-medium text-brand-ink transition-colors hover:bg-danger-text-strong focus:outline-none focus:ring-2 focus:ring-danger-text focus:ring-offset-1"
      >
        Try again
      </button>
    </NoticePanel>
  );
}

/**
 * The SESSION EXPIRED while the page was open. Shown instead of a load error.
 *
 * ── THE SCREEN THIS REPLACES ──
 *
 * Reported live on `/w/:id/t/:id/phases` after an idle period:
 *
 *     Couldn't load this team's phases
 *     This is a failure to load, not an empty team, the data is missing, not absent.
 *     Try again; if it keeps failing, report it and quote the message here.
 *     Backend error: 401
 *     [Try again]
 *
 * Three things wrong with it, and none is cosmetic: it blamed the DATA when the data was
 * fine, it offered an action that CANNOT succeed (every retry sends the same dead token),
 * and it asked the user to report a bug that is just an expired login.
 *
 * ── WHY IT RENDERS AT ALL, RATHER THAN JUST REDIRECTING ──
 *
 * `Providers` already calls `signOut({ callbackUrl: "/login" })` when any query returns
 * UNAUTHORIZED, and that does fire. But it is an async network round trip while React renders
 * this tick, so there IS a window, and if the sign-out request itself fails, the user stays
 * here. This component is what they see during that window: an honest sentence and a working
 * manual escape, instead of a false one and a dead button.
 *
 * `aria-live="polite"` because the content changes under a user who did not navigate: a
 * screen-reader user who was reading the page needs to be told why it just changed.
 */
export function SessionExpiredNotice({ what }: { what: string }) {
  return (
    <div
      className="rounded-lg border bg-surface-3 p-8 text-center"
      role="status"
      aria-live="polite"
    >
      <p className="text-3xl" aria-hidden="true">
        🔒
      </p>
      <h2 className="mt-3 text-lg font-semibold text-ink">
        Your session has expired
      </h2>
      <p className="w-full mx-auto mt-2 max-w-md text-sm text-ink-subtle leading-relaxed">
        {/* Names the surface, so the sentence is about THIS page rather than a generic
            failure, and says plainly that nothing is wrong with the team's data, which is
            what the old error screen got backwards. */}
        You were signed out, so {what} could not be loaded. Nothing is wrong with your
        team&apos;s data, signing in again will bring you straight back.
      </p>
      <p className="mt-3 text-xs text-ink-subtle">
        Redirecting you to sign in…
      </p>
      {/* A LINK, not a button that calls signOut again. The automatic redirect is already in
          flight; this is the manual escape for the case where it failed, and a plain
          navigation cannot fail the same way an async sign-out call can. */}
      <a
        href="/login"
        className="mt-4 inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover"
      >
        Sign in
      </a>
    </div>
  );
}
