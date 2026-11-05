import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ExperienceHeader } from "@/components/ExperienceHeader";

/**
 * ── THE SHELL FOR EVERY ONE EXPERIENCE'S PAGES ─────────────────────────────────────────────
 *
 * REPORTED: "results tab and submissions is missing the common header we used have".
 *
 * They were. `AppHeader` and `SiteFooter` were imported by `experiences/[id]/page.tsx` and
 * `settings/page.tsx` individually, so the four pages added later, submissions, one submission,
 * results, activity, silently came up with no product header, no navigation home and no way to reach
 * the profile menu. Nothing failed; the pages just started halfway down.
 *
 * ── ⚠ WHY A LAYOUT RATHER THAN FOUR MORE IMPORTS ──
 *
 * Adding the import to each page would fix today's four and lose the next one. This exact reasoning is
 * already written down in `w/[workshopId]/t/[teamId]/layout.tsx`:
 *
 *     "The <AppHeader> is the fix for 'keep the header on all pages like the dashboard': one layout
 *      covers all nine workspace routes, so it goes here rather than into each page."
 *
 * The team workspace has followed that since it was built; the experiences area never got its layout,
 * and the bug is exactly what that omission predicts. So the shell moves UP and the pages below it
 * render only their own content.
 *
 * ── ⚠ IT ALSO FIXES THE LOADING AND ERROR STATES, WHICH NOBODY REPORTED ──
 *
 * `experiences/[id]/page.tsx` and `settings/page.tsx` both `return` early for "loading…" and for
 * "experience not found", and those early returns rendered NO header either. So the header used to
 * disappear and reappear on every navigation into this area, and vanished entirely on an error. A
 * layout wraps every state a page can be in, including the ones it returns before reaching its own
 * markup.
 *
 * ── ⚠ TWO BARS, ANSWERING TWO DIFFERENT QUESTIONS ──
 *
 * `AppHeader` is "which product am I in, and who am I". `ExperienceHeader` is "which EXPERIENCE am I in,
 * and which view of it", the back link, the name, and the tab bar. Both are here for the same reason:
 * Activity, Submissions and Results are TABS IN THAT BAR and used to render without it, so following one
 * of them left the experience it belonged to with no name, no tabs and no way back.
 *
 * ── NOT A CLIENT COMPONENT ──
 *
 * There is no "use client" here on purpose. This adds no hooks and reads no params; the two headers are
 * client components and declare that themselves. Keeping the layout a server component means it does
 * not pull the whole subtree's boundary any earlier than it already is.
 *
 * ⚠ `ExperienceHeader` IS WRAPPED IN Suspense because it calls `useSearchParams` (to know which panel
 * the base page is showing). Without a boundary that opts the whole route out of static rendering -
 * the same requirement the base page already documents around its own Suspense.
 *
 * `flex-1` on the wrapper is what pushes the footer to the bottom of a short page. The pages'
 * own `<main className="flex-1 …">` remains correct inside it.
 */
export default function ExperienceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* ── ⚠ THE TWO BARS ARE PINNED AS ONE UNIT ────────────────────────────────────────────
          Both must stay visible while a long submissions list or results table scrolls: the top
          bar carries identity and the way out, the second carries WHICH experience and which tab.

          ⚠ WRAPPED RATHER THAN EACH MADE STICKY. `AppHeader` is already `sticky top-0`; making
          `ExperienceHeader` sticky too would pin it to `top-0` as well, so the two would overlap,
          and the fix of `top-[76px]` hardcodes the first bar's height, which changes with the
          tagline, the font, and any future control in it. A single sticky wrapper needs no such
          number: the pair scrolls as one object and the browser measures it.

          The wrapper carries no z-index of its own; `AppHeader`'s `Z_CHROME` inside it is the
          layer, and the wrapper is transparent so each bar keeps its own background. */}
      <div className="sticky top-0 z-40">
        <AppHeader />
        <Suspense fallback={null}>
          <ExperienceHeader />
        </Suspense>
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
      <SiteFooter />
    </div>
  );
}
