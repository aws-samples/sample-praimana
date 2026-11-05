"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc/client";
import { SiteFooter } from "@/components/SiteFooter";
import { AppHeader } from "@/components/AppHeader";
import { teamTabHref } from "@/lib/team-routes";

/**
 * The workspace tab icons, at one 1.5px stroke weight so the row reads as a set.
 *
 * Each is drawn to say what the tab IS rather than to be a clever metaphor: three connected nodes
 * for a team, a stepped track for phases, stacked columns for the board, overlapping bubbles for
 * chat, a spark for the assistant, bars for insights, an upward tray for submit.
 */
const ICONS = {
  team: (
    <>
      <circle cx="12" cy="6" r="2.4" />
      <circle cx="5.6" cy="17" r="2.4" />
      <circle cx="18.4" cy="17" r="2.4" />
      <path d="M10.3 8 7.3 14.9M13.7 8l3 6.9M8 17h8" />
    </>
  ),
  phases: (
    <>
      <path d="M3.5 17.5h4v-4h4v-4h4v-4h4" />
      <circle cx="7.5" cy="17.5" r="1.3" />
      <circle cx="15.5" cy="9.5" r="1.3" />
    </>
  ),
  board: (
    <>
      <rect x="3.5" y="4.5" width="4.5" height="15" rx="1" />
      <rect x="10" y="4.5" width="4.5" height="10" rx="1" />
      <rect x="16.5" y="4.5" width="4" height="6.5" rx="1" />
    </>
  ),
  chat: (
    <>
      <path d="M4 6.5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-4 3v-9a2 2 0 0 1 2-2Z" />
      <path d="M19 9.5h1a1.5 1.5 0 0 1 1.5 1.5v6l-2.5-2h-4" />
    </>
  ),
  ai: (
    <>
      <path d="M12 3.5v3M12 17.5v3M4.5 12h3M16.5 12h3" />
      <path d="M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2" />
      <circle cx="12" cy="12" r="2.4" />
    </>
  ),
  insights: (
    <>
      <path d="M4 19.5h16" />
      <rect x="6" y="12" width="3" height="6" rx="0.6" />
      <rect x="11" y="8" width="3" height="10" rx="0.6" />
      <rect x="16" y="4.5" width="3" height="13.5" rx="0.6" />
    </>
  ),
  submit: (
    <>
      <path d="M12 16.5V5.5M8.5 9 12 5.5 15.5 9" />
      <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
} as const;

/** One entry in the section tab bar. */
interface NavItem {
  href: string;
  label: string;
  /**
   * ── ⚠ SVG PATH DATA, NOT AN EMOJI CHARACTER ────────────────────────────────────────────────
   *
   * These were 👥 📋 📌 💬 🤖 📊 🚀. Emoji are the wrong instrument for product iconography for
   * three reasons that have nothing to do with taste, and this bar is the worst place in the app
   * to get it wrong because it renders on all nine workspace routes:
   *
   *   1. THEY ARE FONT DATA THE OS OWNS. The same seven characters are flat pictograms on
   *      Windows, glossy on macOS, outlined on Android and a dotted box in a Linux screenshot. A
   *      product cannot look consistent through glyphs it does not ship.
   *   2. THEY DO NOT INHERIT. `currentColor` passes an emoji by, so the icon stayed full-colour
   *      while the label beside it went from `--ink-subtle` to `--brand-text` on the active tab.
   *      That is visible in any screenshot of the old bar: a coloured pictogram next to grey text.
   *   3. STROKE WEIGHT AND OPTICAL SIZE ARE NOT ADJUSTABLE, so they cannot be tuned to sit with
   *      13px type.
   *
   * Inline `<path>` data rather than an icon package: seven glyphs do not justify a dependency,
   * and the CSP here forbids remote sprite sheets.
   */
  icon: ReactNode;
  /**
   * True when this route's queries answer 403 to a non-member, the ONLY
   * meaning this flag carries. See the note on `navItems` for why it is pinned to the
   * server's behaviour rather than to how private a section feels.
   */
  gated: boolean;
  /** Pinned to the far right, so it holds one position however many tabs precede it. */
  pinRight?: boolean;
}

/**
 * The team workspace shell: app header, workshop/team context bar, phase stepper,
 * and the section tabs.
 *
 * The <AppHeader> is the fix for "keep the header on all pages like the dashboard":
 * one layout covers all nine workspace routes, so it goes here rather than into each
 * page. It sits ABOVE the context bar because the two answer different questions -
 * the header is "which product am I in and who am I", the bar below is "which team
 * and phase am I looking at", and collapsing them would put the sign-out menu next
 * to the team's invite code.
 */
export default function TeamWorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;
  const basePath = `/w/${workshopId}/t/${teamId}`;
  // The one section that is not member-only, and therefore the destination every
  // member-only notice routes to. Built by the shared helper so the tab, the notices on six
  // pages and the focus fallback below cannot disagree about where "the Team tab" is.
  const teamHref = teamTabHref(workshopId, teamId);

  const { data: team } = trpc.team.getById.useQuery({ teamId, workshopId });

  /**
   * IS THE VIEWER ON THIS TEAM, the question that decides which sections exist.
   *
   * Derived from the roster `team.getById` already returns (see the tRPC router's members
   * mapper), so this costs NO extra request. `getById` stays on the administration
   * predicate, which is what keeps this shell, and the Team tab inside it -
   * rendering for a facilitator who is not a member.
   *
   * NOT INFERRED FROM THE ROLE, and that is the whole correctness story. An ADMIN can
   * legitimately be a member (rows predating the rule are exactly that), an EXECUTIVE
   * frequently is, two of the six current members are executives, and read-only is about
   * WRITING, not about belonging, and a PARTICIPANT can be looking at a team they are not
   * on. Membership is a fact about a table; no role is a proxy for it.
   *
   * Compared against `member.userId`, the Cognito sub the membership row is keyed on and
   * the same value NextAuth puts on `session.user.id`, the comparison the team page's own
   * `isSelf` guard already makes.
   */
  const { data: session } = useSession();
  const myUserId = session?.user?.id;
  const isMember =
    !!team &&
    !!myUserId &&
    (team.members ?? []).some((m) => m.userId === myUserId);

  /**
   * WHICH TABS A NON-MEMBER SEES.
   *
   * `gated` means EXACTLY ONE THING: this route's queries answer 403 to a non-member.
   * It is not a judgement about whether a section feels private. Tying the flag to
   * the server's actual behaviour is what makes this bar verifiable, every hidden tab
   * corresponds to a refusal that demonstrably happens, and every visible tab leads to a page
   * that demonstrably loads. Anything looser and the bar becomes a second, drifting copy of
   * the authorization rule, which is how a tab ends up hidden from someone entitled to it -
   * the invisible half of the failure, and the one that has already happened once.
   *
   * So the five are the five: board, chat, AI, insights, and phases (phase NOTES are
   * team-authored, even though the pipeline they hang on is the workshop's).
   *
   * CODE IS GONE, the tab, not the content. It was named for source code while the only real
   * thing it showed was documents, and its other two panels were built on git commit analysis,
   * which this platform dropped. The files and a per-author rollup now live on the BUILD PHASE,
   * where the artefacts are produced (see components/PhaseArtifacts.tsx). One fewer tab, and the
   * remaining one is not making a claim about a feature that no longer exists.
   *
   * TEAM STAYS because `team.getById` stays on the administration predicate: the roster, the
   * invitations, the join code and the Remove control are a facilitator's remaining job here.
   *
   * ⚠ SUBMIT IS NOW GATED, AND THE OPEN QUESTION THIS NOTE LEFT HAS BEEN ANSWERED.
   *
   * It used to be `gated: false`, and the reasoning was explicit and conditional: the tab was a
   * stub, "there is nothing behind it to leak", and whether judges may see it was left open:
   * "if the answer is 'members only' this entry needs the
   * flag AND the route needs a server rule".
   *
   * Both halves have landed. The rule is that A JUDGE NEVER READS A SUBMISSION FROM INSIDE
   * THE TEAM WORKSPACE: judging is per-WORKSHOP entitlement, so a judge's route is the
   * experience-level `/experiences/[id]/submissions`, and it reads a PINNED SNAPSHOT through the
   * evaluation service rather than the team's live surfaces. So gating this tab removes nothing
   * from a judge, it removes a tab that would 403 them.
   *
   * And there IS now something behind it to leak: the team's draft narrative, its deliverable
   * URLs, and the executive Release control. The server rule exists too -
   * `requireSubmissionRelease` (executive + member) and the team-write scope on `PATCH`, so this
   * flag is the tab agreeing with a rule rather than being the rule.
   *
   * `pinRight` stays: the tab keeps its screen position whether the gated set is present or not,
   * which is what the ordering note below depends on.
   *
   * ── GATED ENTRIES COME AFTER UNGATED ONES, AND THAT ORDER IS LOAD-BEARING ──
   * Membership resolves one round trip after this shell first paints, so the tab set
   * necessarily changes once. Ordered this way, the change can only ever APPEND, no tab
   * already on screen moves sideways while a pointer is travelling towards it. Submit is the
   * one exception and it moves by design: it is pinned to the far right by `ml-auto` (see
   * below), so it holds the same screen position whether six tabs sit before it or none.
   */
  const navItems: NavItem[] = [
    { href: teamHref, label: "Team", icon: ICONS.team, gated: false },
    { href: `${basePath}/phases`, label: "Phases", icon: ICONS.phases, gated: true },
    { href: `${basePath}/board`, label: "Board", icon: ICONS.board, gated: true },
    { href: `${basePath}/chat`, label: "Team Chat", icon: ICONS.chat, gated: true },
    { href: `${basePath}/ai`, label: "AI Chats", icon: ICONS.ai, gated: true },
    { href: `${basePath}/insights`, label: "Insights", icon: ICONS.insights, gated: true },
    {
      href: `${basePath}/submit`,
      label: "Submit",
      icon: ICONS.submit,
      gated: true,
      pinRight: true,
    },
  ];

  /**
   * WHETHER THE GATED TABS ARE OFFERED AT ALL, three states, not two, and the third is the
   * one that has to fail in the right direction.
   *
   * While the roster is still in flight (or if `getById` itself failed) membership is
   * UNKNOWN, and this resolves false: a tab that leads to a 403 is the precise defect being
   * fixed, so an unproven membership must not produce one. The cost of being wrong in this
   * direction is that a member sees six tabs appear a moment late, to the right of the one
   * that was already there. The cost of the opposite is a click into a refusal.
   */
  const showGated = isMember;

  /**
   * WHERE FOCUS GOES IF THE TABS DISAPPEAR UNDERNEATH IT.
   *
   * Not hypothetical, and not the first-load case: a facilitator's membership can be
   * removed while their tab is open, and the next `getById` refetch then unmounts six links
   *, one of which may be holding focus. A keyboard operator would be dropped onto <body>,
   * where Tab restarts from the top of the document, in the middle of an access change they
   * did not initiate.
   *
   * The check is "did focus actually end up nowhere", not "was it in the nav": this effect
   * runs after the DOM has already updated, so a focused-then-removed link has ALREADY
   * become <body>. If focus has legitimately settled somewhere else, the operator tabbed
   * on, another component claimed it, taking it back would be worse than the bug. Same
   * instrument and the same guard as the confirmation dialog's focus rescue.
   */
  const teamTabRef = useRef<HTMLAnchorElement>(null);
  const hadGatedTabsRef = useRef(false);
  useEffect(() => {
    const lost = hadGatedTabsRef.current && !showGated;
    hadGatedTabsRef.current = showGated;
    if (!lost) return;
    const active = document.activeElement;
    if (!active || active === document.body) teamTabRef.current?.focus();
  }, [showGated]);

  function renderTab(item: NavItem, extraClassName = "") {
    const isActive =
      item.href === basePath
        ? pathname === basePath
        : pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        // The Team tab is the focus landing place when gated tabs vanish (see the effect
        // above). Keyed on the href rather than on `!item.gated`, so adding a second ungated
        // entry later cannot silently reassign the ref, as Submit would have.
        ref={item.href === teamHref ? teamTabRef : undefined}
        href={item.href}  // nosemgrep: react-href-var
        // aria-current was missing entirely: the active tab was signalled by a blue underline
        // and nothing else, which is colour-alone and inaudible. It matters more now that the
        // bar's contents vary by viewer.
        aria-current={isActive ? "page" : undefined}
        className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
          isActive
            ? "border-brand text-brand-text"
            : "border-transparent text-ink-subtle hover:text-ink-muted"
        } ${extraClassName}`}
      >
        {/* `stroke="currentColor"` is the point: the icon now takes the tab's own colour, so it
            goes brand-lavender with the label on the active tab instead of staying a fixed
            full-colour pictogram beside grey text. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="mr-1.5 inline-block h-4 w-4 align-[-0.15em]"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {item.icon}
        </svg>
        {item.label}
      </Link>
    );
  }

  /**
   * The phase the workshop is CURRENTLY on, at most one, by construction (the status is derived
   * from a single `currentPhaseOrder`, so exactly one phase can equal it).
   *
   * ⚠ THIS BADGE AND THE STEPPER BELOW HAVE NEVER RENDERED UNTIL NOW. They read `team.teamPhases`,
   * which `team.getById` returned as a hardcoded `[]`, so both were permanently behind a
   * `length > 0` guard that could not be satisfied. The procedure now fetches the workshop's phases
   * and derives each status, and the field is renamed `phases` because there was never any per-team
   * phase state to describe.
   */
  const currentPhase = team?.phases?.find((tp) => tp.status === "IN_PROGRESS");

  return (
    /* ── ⚠ AN APP SHELL OF EXACTLY ONE VIEWPORT, NOT A PAGE THAT GROWS ────────────────────────
       REPORTED: in Team Chat the composer had to be scrolled down to, and the whole window
       scrolled rather than the message list.

       ⚠ `min-h-screen` WAS THE BUG, AND `flex-1 min-h-0` ON THE CHILDREN DID NOT FIX IT. A
       minimum height is not a maximum: when the transcript grew, this column grew with it and the
       DOCUMENT scrolled. `flex-1 min-h-0` only bounds a child when its parent has a definite
       height to divide up, and `min-h-screen` gives none. Measured before this change: the window
       was scrollable by 2231px and the composer sat at y=2919 in an 800px viewport.

       `h-dvh` rather than `h-screen`: `100vh` on mobile Safari is the height WITHOUT the browser
       chrome, so the shell would overflow by the toolbar's height and reintroduce the same
       document scroll on a phone. `dvh` is the dynamic viewport.

       `overflow-hidden` here is what makes the shell authoritative, the header, the two bars and
       the footer are then always on screen, and everything that scrolls does so inside `main`. */
    <div className="flex h-dvh flex-col overflow-hidden">
      <AppHeader />

      {/* Workshop/team context bar, which team, which phase, who is on it. */}
      <div className="border-b px-4 py-3 flex items-center justify-between bg-surface-3">
        <div className="flex items-center gap-3">
          <Link
            href={`/experiences/${workshopId}`}
            className="text-sm text-ink-subtle hover:text-ink-muted"
          >
            ← {team?.workshop?.name ?? "Workshop"}
          </Link>
          <div className="h-4 w-px bg-surface-2" />
          <h1 className="font-semibold text-sm">{team?.name ?? "..."}</h1>
          {currentPhase && (
            <span className="text-xs bg-brand-subtle text-brand-text px-2 py-0.5 rounded-full">
              {currentPhase.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {team?.members?.map((m) => (
            <div
              key={m.id || m.userId}
              className="w-7 h-7 rounded-full bg-brand-subtle flex items-center justify-center text-xs font-medium text-brand-text"
              title={`${m.user?.name || m.userId} (${m.role})`}
            >
              {(m.user?.name || m.userId || "?")[0]}
            </div>
          ))}
          {team && (
            <span className="ml-2 text-xs text-ink-tertiary">
              Code: {team.inviteCode}
            </span>
          )}
        </div>
      </div>

      {/* Phase stepper.

          ⚠ THIS IS THE FIRST TIME IT HAS EVER RENDERED. It reads the phase list `team.getById`
          returned as a hardcoded `[]`, so `length > 0` was never true. The data is real now.

          ⚠ THE PILLS LINK TO THE PHASES TAB, NOT TO `basePath`. They pointed at `basePath`, the
          workspace root, which was harmless while nothing rendered and is a link to the page you
          are already on now that something does. A phase pill means "take me to this phase", and
          the phase notes live on the Phases tab. Gating is unchanged: that tab is member-only like
          every other content tab, so a non-member clicking through gets the same notice the tab
          itself shows rather than anything new. */}
      {team && team.phases.length > 0 && (
        <div className="border-b px-4 py-2 bg-surface-1 flex items-center gap-1 overflow-x-auto">
          {team.phases.map((tp, i) => {
            const isClickable = tp.status !== "NOT_STARTED";
            return (
            <div key={tp.id} className="flex items-center gap-1">
              <Link
                href={isClickable ? `${basePath}/phases` : "#"}
                onClick={(e) => !isClickable && e.preventDefault()}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  tp.status === "COMPLETED"
                    ? "bg-success-bg text-success-text hover:bg-success-bg cursor-pointer"
                    : tp.status === "IN_PROGRESS"
                      ? "bg-brand-subtle text-brand-text hover:bg-brand-subtle cursor-pointer"
                      : "bg-surface-2 text-ink-tertiary cursor-default"
                }`}
              >
                {tp.status === "COMPLETED" && "✓ "}
                {tp.name}
              </Link>
              {i < team.phases.length - 1 && (
                <span className="text-ink-tertiary text-xs">→</span>
              )}
            </div>
            );
          })}
        </div>
      )}

      {/* Nav tabs.

          ── HIDDEN, NOT DISABLED-WITH-A-REASON, and this had a precedent to obey ──
          The reflex is to leave all eight tabs in place, greyed, each with a tooltip saying
          why. The Administration screen tried that shape and it was reported
          AS A BUG: a control that is present, visibly refused, and offers no way forward
          does not read as "this is not yours", it reads as the system taking something
          away from you, and an operator's next move is to file a ticket about a rule that
          is working correctly. So that screen hides the affordance instead (`canEdit` on
          ExperienceRow; the Remove button the roster omits on the caller's own row).

          The other half of that precedent matters just as much: those screens do not leave
          the absence UNEXPLAINED. The roster marks its inactionable row `(you)`, and
          InvitedByNote renders "Not shown" rather than a blank precisely because "a blank
          reads as missing data and invites a support question about a working rule". Six
          tabs vanishing from a bar a facilitator has used all week is exactly that blank.

          So: hide the controls, state the rule ONCE as text rather than as six dead
          buttons. A disabled tab would also be strictly worse on two mechanical counts -
          it stays in the tab order carrying nothing to act on, and the only place a
          tooltip's reason can live is hover, which does not exist on touch and is
          unreachable by keyboard. */}
      <nav
        // A named landmark, because it is now a landmark whose CONTENTS vary by viewer -
        // a screen-reader operator comparing what they hear against a colleague's screen
        // needs the region to identify itself.
        aria-label="Team sections"
        // flex-wrap, added with the explanatory sentence: the bar previously held eight
        // fixed-width tabs and nothing else, and it now holds a sentence too. Without
        // wrapping, a narrow window or 200% zoom would push the right-pinned Submit tab past
        // the edge and clip it, a navigation control lost to a viewport, which is the one
        // failure mode worse than a taller bar. Wrapping puts the sentence on its own line
        // instead and keeps every tab reachable.
        className="border-b px-4 flex flex-wrap items-center gap-1 bg-surface-3"
      >
        {navItems.map((item) => {
          if (item.gated && !showGated) return null;
          if (item.pinRight) return null;
          return renderTab(item);
        })}

        {/* WHY THE BAR IS SHORT, said once, in the space the missing tabs occupied.
            Rendered only once membership is KNOWN and negative (`team` has arrived), so it
            never flickers on during the first paint's unknown state.

            gray-600 on white is 7.46:1, AAA, and deliberately not the gray-400 (2.85:1)
            this codebase reaches for on de-emphasised captions. This sentence is the only
            explanation of a missing navigation control, so it is the wrong place to trade
            contrast for quietness. It is still text-xs and still not red: a rule, not a
            warning. */}
        {team && !showGated && (
          <p className="ml-3 py-2.5 text-xs text-ink-subtle">
            {/* Names all SIX hidden sections, matching the `gated` flags above. A list that
                omits one is worse than no list: an operator who reads five and misses
                "phases" concludes the sixth tab vanished for some other reason. */}
            You are not a member of this team, so its phases, board, chat, AI chats, code and
            insights are visible to members only.
          </p>
        )}

        {/* Pinned right, so the one tab that follows the variable-length group holds the
            same screen position for every viewer. Without this it would sit immediately
            after the last visible tab and land in a different place for a member than for a
            non-member, and would slide sideways under the cursor the moment membership
            resolved. Rendered last so the tab ORDER a keyboard operator walks matches the
            left-to-right order they see. */}
        {navItems
          .filter((item) => item.pinRight && (!item.gated || showGated))
          .map((item) => renderTab(item, "ml-auto"))}
      </nav>

      {/* Content */}
      {/* ── ⚠ `flex flex-col`, AND THE FOOTER BELOW IS WHY THAT MATTERED ─────────────────────
          REPORTED: the footer was missing on every tab in the team workspace. It was, this
          layout never rendered one, while `experiences/[id]/layout.tsx` does. The same omission
          its own note describes for the header, one shell later.

          ⚠ ADDING IT REQUIRED REMOVING A MAGIC NUMBER FIRST. Five pages under here sized
          themselves with `h-[calc(100vh-12rem)]`, where `12rem` was a hand-measured stand-in for
          "the header plus the nav". A footer makes that arithmetic wrong by exactly the footer's
          height, so the chat composer, the board columns and the AI transcript would each have
          been pushed below the fold, silently, because `overflow-hidden` here would clip rather
          than scroll.

          So `main` is now a flex column and those pages use `flex-1 min-h-0` instead. The browser
          measures the space; nothing encodes the chrome's height; and the next bar added to this
          shell cannot break five pages by existing. */}
      {/* ── ⚠ `overflow-y-auto`, NOT `overflow-hidden` ─────────────────────────────────────────
          `main` is the scroll container now, and that single choice serves both kinds of page
          under this shell without either knowing about the other:

            - DOCUMENT-LIKE pages (the team roster, phases, submit, the index) are taller than the
              space and simply scroll inside it. The footer stays put, which is what it could not
              do while the document itself scrolled.
            - PAGES THAT MANAGE THEIR OWN SCROLLING (chat, board, AI chats, insights) are
              `flex-1 min-h-0`, so they fill this box exactly and `main` never needs to scroll.
              Their internal `overflow-y-auto` does the work, which is what pins the chat
              composer and scrolls only the transcript.

          ⚠ IT WAS `overflow-hidden` BEFORE, which would have CLIPPED the four document-like pages
          the moment the shell became a fixed height. Hidden, not scrollable: content simply gone. */}
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
      <SiteFooter />
    </div>
  );
}
