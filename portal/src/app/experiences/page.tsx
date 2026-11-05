"use client";

import Link from "next/link";
import { canSignInToDesktopApp } from "@praimana/shared";
import { trpc } from "@/lib/trpc/client";
import { useSession } from "next-auth/react";
import { ProfileMenu } from "@/components/ProfileMenu";
import { BrandMark } from "@/components/BrandMark";
import { SiteFooter } from "@/components/SiteFooter";
import { useCanManageUsers, useRole } from "@/lib/useRole";
import { DesktopAppCard } from "@/components/DesktopAppCard";
import {
  formatLabel,
  statusLabel,
  statusTone,
  teamCountLabel,
  workshopDate,
} from "@/lib/workshop-display";

/**
 * ── ⚠ THE ROW TRACK, SHARED BY THE SKELETON AND THE REAL LIST ───────────────────────────────
 *
 * One string, used by both, because the entire point of the skeleton is that the loaded rows
 * land on the SAME grid. Two copies of this template would drift and the page would jump on
 * load, which is the defect the skeleton exists to remove.
 *
 * ⚠ FIXED COLUMN WIDTHS, NOT `justify-between`. The previous cards laid their metadata out per
 * card with `flex … justify-between`, so "6 teams" sat at a different x-position in every card
 * and nothing lined up vertically. Explicit tracks mean status, format, teams and date form
 * four true columns down the page, which is the property that makes a list of 30 workshops
 * scannable rather than merely present.
 *
 * `minmax(0,1fr)` on the name column, not `1fr`: a bare `1fr` has `min-width:auto`, so a long
 * unbroken workshop name would refuse to shrink and push the metadata columns off the right
 * edge instead of truncating. This is the fix for that, not a style preference.
 *
 * MOBILE COLLAPSE (declared here, per the layout rules): below `md` the grid is a single
 * column, the metadata columns are hidden in the skeleton and re-flowed as an inline wrap in
 * the real row, because four numeric columns cannot align in 375px of width.
 *
 * ⚠ CROSS-AXIS ALIGNMENT IS DELIBERATELY *NOT* IN HERE, and that is not an oversight. The real
 * rows want `items-baseline`, so the status label, the workshop name and the numbers all sit on
 * one typographic baseline. The skeleton cannot use it: its cells are empty fixed-height bars,
 * and an empty box's baseline is its bottom margin edge rather than a text baseline, so
 * `items-baseline` aligned the bars by their bottoms and dropped the status dot ~7px below the
 * title bar, visible, and only in the placeholder. Each consumer therefore states its own
 * alignment, and the shared constant covers only the geometry that MUST match.
 */
const ROW_GRID =
  "grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-3.5 " +
  "md:grid-cols-[8rem_minmax(0,1fr)_6rem_5rem_7rem]";

export default function WorkshopsPage() {
  const { data: session, status: sessionStatus } = useSession();
  // NO EXECUTIVE SPECIAL CASE any more. There used to be an `isExecutive` branch that
  // disabled this query and rendered a separate team-first page, on the premise that
  // "executives don't own workshops", true, but the conclusion was wrong. They are
  // ENTITLED to workshops (invitation or team membership), and the list
  // route returns exactly that set. The special case was the only thing still hiding
  // it: an executive signing in saw "Teams / You have read-only access", and would
  // reasonably conclude the fix was not working.
  //
  // Their teams are still reachable, one click deeper, from the workshop they belong
  // to, and they now reach it the same way every other staff role does.
  // Whether to offer the Administration screen, which is now where BOTH creating
  // an experience and inviting staff live. Gated on canManageUsers, the rule for
  // /admin itself, rather than on canCreateWorkshops: the destination is the
  // Administration screen, so the gate has to be the destination's, or we'd offer
  // a link middleware would bounce. The two sets are identical today
  // (ADMIN + FACILITATOR), which is exactly why the wrong one would go unnoticed.
  const canManage = useCanManageUsers();
  /**
   * Who is offered the desktop app. Derived from the role rather than from "not an admin", so a
   * role added later is EXCLUDED until someone decides it belongs, the safe direction for an
   * offer to install software.
   */
  const role = useRole();
  /**
   * ⚠ THE SHARED PREDICATE, NOT AN INLINE ROLE TEST. This was
   * `role === "EXECUTIVE" || role === "PARTICIPANT"`, the same rule the DESKTOP now enforces at sign-in
   * (`canSignInToDesktopApp`), written out a second time. Two copies of "who is this app for" is how the
   * portal ends up offering an app the app itself refuses, which is the shape of the Submit-tab bug.
   * One function, with its own tests.
   */
  const canUseDesktop = canSignInToDesktopApp(role);

  const { data: workshops, isLoading } = trpc.workshop.list.useQuery(undefined, {
    enabled: !!session,
  });

  /**
   * "No experiences created yet" FLASHED ON EVERY LOGIN, and `isLoading` alone could not
   * prevent it.
   *
   * This query is `enabled: !!session`, and NextAuth resolves the session one round trip after
   * this component first paints. While it is unresolved the query is DISABLED, and a disabled
   * query is not loading, by react-query's definition, because nothing is in flight. So the
   * first render had `isLoading === false` and `workshops === undefined`, fell straight past
   * the guard below, and `!workshops?.length` rendered the empty state: an affirmative claim
   * that this account owns no experiences, shown to everyone, every time, for the few hundred
   * milliseconds before the session arrived and the real list replaced it.
   *
   * The empty state is the most consequential string on this page, for a new user it is
   * indistinguishable from the truth, so it must only appear once we have ASKED and been told
   * there is nothing. Three states, not two: waiting for the session and waiting for the list
   * are both "we do not know yet".
   *
   * Gated on NextAuth's own `status`, not on `session === undefined`: that is ALSO undefined
   * for a signed-out visitor, who would then sit on a spinner for ever instead of being
   * bounced by middleware. "loading" is the one state that means "still asking".
   */
  if (isLoading || sessionStatus === "loading") {
    return (
      /* ⚠ THE FULL CHROME RENDERS ON THIS BRANCH TOO, not just the loaded one below. The two
         returns are the same screen in two states, and giving only one of them the header, the
         heading and the footer is what made the page JUMP on load, everything appearing at once
         in different places, on the render path the comment above says everyone hits at login. */
      <div className="min-h-screen flex flex-col bg-canvas text-ink">
        {/* ── ⚠ A SKELETON, NOT A CENTRED "Loading experiences…" ────────────────────────────
            The old loading branch was a single centred line of text in an otherwise empty
            viewport, which does three things wrong at once: it throws away the layout it is
            about to render, it centres content that will land top-left, and the whole page
            therefore JUMPS when the data arrives, header, heading and list all appearing at
            once in different places.

            Rendering the real chrome plus placeholder rows means the only thing that changes
            on load is the row content. Nothing moves. The row count is a deliberate 3: enough
            to read as "a list is coming", few enough that a user with one workshop is not
            shown a phantom queue.

            `aria-hidden` on the bars with a single polite live region: a screen reader should
            hear "Loading experiences" once, not six empty divs. */}
        <header className="sticky top-0 z-40 border-b border-hairline bg-canvas px-6 py-4 flex items-center justify-between">
          <BrandMark as="h1" tagline priority />
          <div className="flex items-center gap-4">
            <ProfileMenu />
          </div>
        </header>

        <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-8">
          <h2 className="text-[28px] font-semibold tracking-heading-tight mb-6">Experiences</h2>
          <p className="sr-only" role="status">
            Loading experiences
          </p>
          <ul aria-hidden="true" className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
            {[0, 1, 2].map((row) => (
              <li key={row} className={`${ROW_GRID} animate-pulse md:items-center`}>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-surface-3" />
                  <span className="h-3 w-20 rounded bg-surface-3" />
                </div>
                <div className="min-w-0">
                  {/* Widths vary per row so the placeholder reads as text rather than as a
                      progress bar, and so it does not imply every name is the same length. */}
                  <span
                    className="block h-3.5 rounded bg-surface-3"
                    style={{ width: `${58 - row * 9}%` }}
                  />
                  <span
                    className="mt-2 block h-3 rounded bg-surface-2"
                    style={{ width: `${76 - row * 7}%` }}
                  />
                </div>
                <span className="hidden h-3 rounded bg-surface-3 md:block" />
                <span className="hidden h-3 rounded bg-surface-3 md:block" />
                <span className="hidden h-3 rounded bg-surface-3 md:block" />
              </li>
            ))}
          </ul>
        </main>

        <SiteFooter />
      </div>
    );
  }

  return (
    /* ── ⚠ THE REBRAND OPT-IN, AND WHY IT IS AN ATTRIBUTE AND NOT A GLOBAL ────────────────
       `` re-points the colour tokens defined in globals.css for this
       subtree only. /experiences is the agreed pilot for the Linear direction (DESIGN.md at
       the repo root); every other route keeps the light defaults, which are byte-identical
       to the greys they used before.

       It sits on the OUTERMOST element rather than on <main>, because the header and footer
       are inside the themed region, a themed page under an unthemed header is worse than
       either palette applied consistently.

       To promote this to the whole portal: move the `[]` block in
       globals.css into `:root` and delete this attribute. Nothing else here changes, which
       is the point of having done the token work first. */
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas px-6 py-4 flex items-center justify-between">
        {/* The product name was here as a bare <h1> with no logo, the mark now
            travels with it. Still the <h1>: "Experiences" below is the <h2>. */}
        <BrandMark as="h1" tagline priority />
        {/* No "Invite Users" and no "Create Experience" here any more: both are
            platform-administration actions and both now live on the Administration
            screen (Invitations and Experiences tabs). This page is the READING
            surface, "which experiences am I part of", and its header carries only
            identity. The Administration entry point itself is in ProfileMenu, so
            there is exactly one route to the management screens from every page. */}
        <div className="flex items-center gap-4">
          <ProfileMenu />
        </div>
      </header>

      {/* flex-1 so the footer is pushed to the bottom of the viewport rather than
          floating directly under a short list.

          ⚠ `w-full` IS LOAD-BEARING AND ITS ABSENCE WAS VISIBLE. As a flex item in a
          `flex-col` parent, `mx-auto` wins over the default `align-self: stretch`, so this
          element was sized to FIT ITS CONTENT rather than to `max-w-5xl`. The result: with a
          list, the grid filled the 5xl track and "Experiences" sat at the left margin; with
          an empty list, main collapsed to the width of the empty-state panel and the heading
          slid ~340px to the right. Same heading, two positions, decided by whether the query
          returned rows. `w-full` pins the track width in both states and `max-w-5xl` still
          caps it. */}
      <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-8">
        {/* Linear's `headline` step: 28px at weight 600 with -0.6px tracking. The negative
            tracking is not decoration, at display sizes default Inter spacing is what makes
            a heading read as a default, and it is most of the difference between this and the
            `text-2xl font-bold` it replaces. */}
        <h2 className="text-[28px] font-semibold tracking-heading-tight mb-6">Experiences</h2>

        {!workshops?.length ? (
          /* Dashed border kept: it is the one place the "nothing here yet" reading comes from
             the frame rather than the copy. `bg-surface-1` gives the panel its own surface so
             it reads as a defined region rather than as loose centred text, on a white canvas
             a dashed hairline alone is faint, and in the dark variant it is nearly invisible. */
          <div className="text-center py-12 border border-dashed border-hairline-strong bg-surface-1 rounded-xl">
            <p className="text-ink-muted">
              No experiences created yet.
            </p>
            <p className="text-sm text-ink-subtle mt-1">
              {canManage
                ? "Get started by creating your first experience."
                : "No experiences to show yet."}
            </p>
            {/* Deep-links to the Administration screen's Experiences tab rather than
                straight to /experiences/new. An empty list is the one moment this page
                MUST offer a way forward, but re-planting a create button here would
                give the platform two create entry points to keep in step, so the
                empty state points at the one that now owns the action. */}
            {canManage && (
              /* One of the "few intentional CTAs" DESIGN.md reserves the lavender accent for.
                 It is the only accent-filled element on the screen, which is what makes it
                 read as the single next action rather than as one more coloured chip. */
              <Link
                href="/admin?tab=experiences"
                className="mt-4 inline-block rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-brand-ink transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Create Experience
              </Link>
            )}
          </div>
        ) : (
          /* ── ⚠ A LIST, NOT THREE CARD COLUMNS ──────────────────────────────────────────────
             This was `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`, the three-equal-cards row.
             It was replaced for reasons specific to this screen, not for novelty:

               1. IT DOES NOT SCALE. Cards are ~180px tall, so a facilitator running eight
                  workshops scrolled to see half of them, and the answer to "which of my
                  experiences is live right now" was never on one screen.
               2. NOTHING ALIGNED. Each card positioned its own metadata with
                  `justify-between`, so team counts and dates sat at a different x in every
                  card. Comparing two workshops meant reading both rather than scanning a
                  column.
               3. CARD ELEVATION CLAIMED A HIERARCHY THAT IS NOT THERE. A card says "this is
                  a distinct object at a distinct level". These are homogeneous rows of one
                  collection. Hairline dividers say that; nine bordered panels do not.

             `<ul>`/`<li>` rather than a div grid, so the list is announced as a list with a
             count. `divide-y` supplies the row separation, which is why the rows themselves
             have no border and no background until hovered. */
          <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
            {workshops.map((workshop) => {
              const tone = statusTone(workshop.status);
              const date = workshopDate(workshop.createdAt);
              return (
                <li key={workshop.id}>
                  {/* ⚠ HOVER IS A SURFACE STEP, NOT A SHADOW. The card grid used
                      `hover:shadow-sm`; a shadow is the wrong instrument for a row in a list -
                      it lifts one item out of a flat collection, and it breaks outright in the
                      dark variant, where a drop shadow has nothing lighter than itself to fall
                      on. Moving one step up DESIGN.md's surface ladder works in both palettes.

                      `active:` gives the row a physical press, which nothing on this screen
                      had. `transition-colors`, not `transition-all`, so only the property
                      that changes is animated, and the duration is short because this is an
                      operational list, not a landing page. Both are disabled wholesale under
                      `prefers-reduced-motion` (see globals.css). */}
                  <Link
                    href={`/experiences/${workshop.id}`}
                    aria-label={`${workshop.name}, ${statusLabel(workshop.status)}`}
                    className={`${ROW_GRID} group md:items-baseline transition-colors duration-150 hover:bg-surface-1 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand`}
                  >
                    {/* Column 1, status. The dot alone was ambiguous (three colours, no
                        key); the dot plus its label is self-describing. `aria-hidden` on the
                        dot because the adjacent text already says it. */}
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          tone === "active"
                            ? "bg-status-active"
                            : tone === "pending"
                              ? "bg-status-pending"
                              : "bg-status-idle"
                        }`}
                      />
                      <span className="truncate text-xs text-ink-subtle">
                        {statusLabel(workshop.status)}
                      </span>
                    </span>

                    {/* Column 2, the thing the reader came for. `min-w-0` is what lets the
                        truncation below actually happen inside a grid track. */}
                    <span className="min-w-0">
                      {/* `text-balance` stops a long name leaving one orphaned word on its
                          own line. Weight 500, not 600: Linear's title step is a medium, and
                          the tight tracking carries the emphasis instead. */}
                      <span className="block truncate font-medium tracking-title-tight text-balance">
                        {workshop.name}
                      </span>
                      {/* One line, truncated, instead of the old two-line clamp. In a row the
                          description is orienting detail, not the payload, and a uniform
                          single line is what keeps every row the same height, which is what
                          makes the columns line up at all. */}
                      {workshop.description && (
                        <span className="mt-0.5 block truncate text-sm text-ink-subtle">
                          {workshop.description}
                        </span>
                      )}
                    </span>

                    {/* ── ⚠ THE METADATA GROUP, AND WHY IT IS `md:contents` ──────────────────
                        On desktop these three are separate grid tracks, so they must be direct
                        children of the row to line up down the page. On mobile the grid is one
                        column, so as direct children they stacked as three full-width lines -
                        format, then teams, then date, making every row four lines tall and a
                        two-workshop list fill the viewport.

                        `display: contents` above `md` dissolves this wrapper entirely: the
                        children become the row's own grid items and occupy tracks 3, 4 and 5.
                        Below `md` the wrapper is a real flex row and the three values sit on
                        one wrapping line. One markup tree, both behaviours, no duplication. */}
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 md:contents">
                      {/* Format, plain text in an aligned column rather than the old pill
                          badge. A pill on every row is decoration that draws the eye without
                          carrying information, and on desktop the column position already says
                          what the value means. */}
                      <span className="truncate text-xs text-ink-muted">
                        {formatLabel(workshop.format)}
                      </span>

                      {/* The numbers. `tabular-nums` is the point: with proportional figures a
                          column of "6 teams" / "12 teams" / "4 teams" does not align on the
                          digit, and neither do the dates. It is the one typographic setting
                          that makes a data column read as a column. */}
                      <span className="text-xs text-ink-tertiary tabular-nums md:text-right">
                        {teamCountLabel(workshop._count?.teams)}
                      </span>
                      <span className="text-xs text-ink-tertiary tabular-nums md:text-right">
                        {/* `date` is null for an unparseable or absent value, and renders as
                            nothing rather than as "Invalid Date". */}
                        {date}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {/* ── ⚠ THE DESKTOP DOWNLOAD, FOR THE ROLES THAT NEVER SEE /welcome ──────────────────
            `landingPathForRole` sends PARTICIPANT to `/welcome`, where the installer lives, and
            everybody else, ADMIN, FACILITATOR, EXECUTIVE, JUDGE, here. So an executive had no
            route to the desktop app at all. Reported as "we should also show desktop link to
            executives as well".

            Placed AFTER the list, not before it: this page answers "which experiences am I part
            of", and an optional download above that answer would displace the thing the reader
            came for. */}
        {/*
          ⚠ EXECUTIVES AND PARTICIPANTS ONLY. Only executives and participants see the desktop
          card, not every role.

          The desktop is where a TEAM MEMBER works, an executive observing their team, or a
          participant building. ADMIN, FACILITATOR and JUDGE run and judge the event from the
          portal; offering them an installer is an invitation to install something they have no
          use for, on the page they use most.

          ⚠ PARTICIPANT IS IN THE SET EVEN THOUGH `landingPathForRole` SENDS THEM TO /welcome,
          where the installer already lives. They can navigate here, and a participant who does
          should not find the download missing from the page that lists their experiences.
        */}
        {canUseDesktop && (
          <div className="mt-10">
            <DesktopAppCard />
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
