"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc/client";
import { canManageWorkshopSettings } from "@praimana/shared";
import { canOpenExperienceTab, type NavigatingTab } from "@/lib/experience-tabs";

/**
 * ── ONE EXPERIENCE'S CONTEXT BAR: WHICH EXPERIENCE, AND WHICH VIEW ─────────────────────────
 *
 * Activity, Submissions and Results keep the same style and the experience header, because they are part
 * of the same experience.
 *
 * The back link, the experience NAME and the tab bar lived inside `experiences/[id]/page.tsx`. So
 * Activity, Submissions and Results, which are *tabs in that very bar*, rendered as bare pages: no
 * name, no tabs, no way back except the browser button, and no indication which experience you were
 * looking at. Clicking Results took you out of the experience it belonged to.
 *
 * Moving it here and mounting it from the LAYOUT is the same fix, and the same reasoning, as the
 * AppHeader one directly above it: the shell belongs to the AREA, not to whichever page remembered it.
 *
 * ── ⚠ THE PANEL TABS CHANGE SHAPE DEPENDING ON WHERE YOU ARE, AND THAT IS THE SUBTLE PART ──
 *
 * Overview / Teams / People / Phases are not routes, they are `?tab=` panels of the base page. On the
 * base page they must stay BUTTONS that rewrite the query (that is how the panel switches without a
 * navigation). From a sub-route like `/results` the same click has to NAVIGATE back to the base page
 * carrying the tab, because there is no panel here to switch to. Rendering buttons everywhere would
 * make Overview silently do nothing on three pages out of seven.
 *
 * ── ⚠ IT FETCHES THE WORKSHOP ITSELF, AND THAT IS NOT A SECOND REQUEST ──
 *
 * `trpc.workshop.getById` is already queried by every page in this area, and React Query serves both
 * callers from one cache entry under the same key. Threading the workshop down through a layout would
 * mean either a server fetch that cannot share that cache or prop-drilling through `children`, which a
 * layout cannot do.
 */

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "teams", label: "Teams" },
  { key: "people", label: "People" },
  { key: "phases", label: "Phases" },
  { key: "activity", label: "Activity", navigates: true },
  /**
   * Workshop-wide material the facilitator uploads, briefs, decks, datasets.
   *
   * ⚠ SHOWN TO EVERY ROLE, not just the owner, because reading is the common case: a participant opens
   * this tab to GET the brief. The page itself hides the upload and delete controls from anyone who is
   * not the owning facilitator, and the Workshop service refuses them regardless, so a visible tab
   * leads somewhere useful for everyone rather than to a 403.
   */
  { key: "resources", label: "Resources", navigates: true },
  { key: "submissions", label: "Submissions", navigates: true },
  { key: "results", label: "Results", navigates: true },
  { key: "settings", label: "Settings", navigates: true },
] as const;

/** The leftmost tab that navigates away, the only one that needs `ml-auto` to push the group right. */
const FIRST_NAVIGATING_TAB = TABS.find((t) => "navigates" in t)?.key;

const PANEL_KEYS = TABS.filter((t) => !("navigates" in t)).map((t) => t.key) as string[];

export function ExperienceHeader() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const workshopId = params.id as string;

  const { data: workshop } = trpc.workshop.getById.useQuery(
    { id: workshopId },
    { enabled: Boolean(workshopId) }
  );

  const base = `/experiences/${workshopId}`;
  /**
   * ⚠ EXACT MATCH, NOT `startsWith`. `/experiences/x/results` also starts with `/experiences/x`, so a
   * prefix test would treat every sub-route as the base page and render dead buttons on all of them.
   */
  const onBasePage = pathname === base;

  /** Which panel the base page is showing. Only meaningful there; a stray value falls back. */
  const requested = searchParams.get("tab");
  const activePanel = requested && PANEL_KEYS.includes(requested) ? requested : "overview";

  /**
   * ⚠ RENDER NOTHING UNTIL THE NAME IS KNOWN, rather than a bar with an empty heading.
   *
   * A header whose title is blank for a moment is worse than one that arrives a moment late: it shifts
   * the whole page down when the text lands, and on a slow connection it reads as a broken experience.
   * The pages below have their own loading states, so nothing is hidden by this.
   */
  if (!workshop) return null;

  const userRole = session?.user?.role;
  const canManage = userRole === "ADMIN" || workshop.ownerId === session?.user?.id;

  return (
    <header className="border-b px-6">
      <div className="py-4 flex items-center gap-4">
        {/* "Experiences", not "Workshops": the admin nav item that leads here is labelled Experiences,
            so a back link naming a different thing reads as a different destination. The ROUTE stays
            /experiences, renaming a live URL would break shared links for a wording fix. */}
        <Link href="/experiences" className="text-sm text-ink-subtle hover:text-ink-muted">
          ← Experiences
        </Link>
        <div className="min-w-0">
          {/* NAME ONLY. The description and fact strip belong on the Overview tab: this experience's
              description is a full paragraph, and putting it here grew the header taller than the
              content and pushed the tab bar off the first screen. */}
          <h1 className="text-xl font-bold text-brand-text">{workshop.name}</h1>
        </div>
      </div>

      <nav className="flex items-center gap-1 -mb-px" aria-label="Experience views">
        {TABS.map((tab) => {
          const navigates = "navigates" in tab;

          /**
           * ⚠ PER-TAB GATING, NOT ONE FLAG FOR ALL FOUR. Each navigating tab leads to a page with its
           * own audience, hiding them together would have hidden the judging worklist from every
           * judge. The pages re-check with the service regardless; this is only the offer.
           */
          if (
            navigates &&
            !canOpenExperienceTab(tab.key as NavigatingTab, {
              role: userRole,
              canManage,
              canManageSettings: canManageWorkshopSettings(userRole),
            })
          ) {
            return null;
          }

          // A navigating tab is active when we are ON its route, which is the whole point of moving
          // this bar out of the base page, and was previously unrepresentable.
          const isActive = navigates
            ? pathname.startsWith(`${base}/${tab.key}`)
            : onBasePage && tab.key === activePanel;

          const className = `border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            isActive
              ? "border-brand text-brand-text"
              : "border-transparent text-ink-subtle hover:border-hairline-strong hover:text-ink-muted"
          }`;

          /**
           * ⚠ `?.length`, NOT `.length`, AND THE BLAST RADIUS IS WHY.
           *
           * This read `workshop.teams.length`. `teams` is an array the BFF happens to include
           * today, from a service in a different repository, and this component is in
           * `experiences/[id]/layout.tsx`, so it renders on EVERY route under an experience:
           * overview, activity, submissions, results, settings. One absent array in one response
           * therefore took out five screens with a blank error boundary, not just the tab count
           * it was trying to draw.
           *
           * Found by a test fixture that supplied `_count.teams` but not `teams`, which is
           * exactly the shape a trimmed-down or paginated response would have.
           *
           * The count renders as nothing when it is unknown rather than as a confident `0`: a
           * "0" beside Teams on an experience that has six is worse than no number, the same
           * reasoning `teamCountLabel` uses on the experiences list.
           */
          const teamCount = workshop.teams?.length;
          const count =
            tab.key === "teams" && teamCount !== undefined ? (
              <span className="ml-1.5 text-xs text-ink-tertiary tabular-nums">{teamCount}</span>
            ) : null;

          if (navigates) {
            return (
              <Link
                key={tab.key}
                // Carries a return target so Save/Back lands on the tab the user came from.
                href={`${base}/${tab.key}?from=${activePanel}`}
                aria-current={isActive ? "page" : undefined}
                /* `ml-auto` on the FIRST navigating tab only, it pushes the whole group right.
                   Repeating it would space them apart across the bar. */
                className={`${className} ${tab.key === FIRST_NAVIGATING_TAB ? "ml-auto" : ""}`}
              >
                {tab.label}
              </Link>
            );
          }

          /**
           * ⚠ A LINK OFF THE BASE PAGE, A BUTTON ON IT. See the header note: from a sub-route there is
           * no panel to switch, so the click has to navigate.
           */
          if (!onBasePage) {
            return (
              <Link key={tab.key} href={`${base}?tab=${tab.key}`} className={className}>
                {tab.label}
                {count}
              </Link>
            );
          }

          return (
            <button
              key={tab.key}
              onClick={() => router.replace(`${base}?tab=${tab.key}`, { scroll: false })}
              aria-current={isActive ? "page" : undefined}
              className={className}
            >
              {tab.label}
              {count}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
