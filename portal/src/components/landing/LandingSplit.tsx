"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AuthFlow } from "@/components/auth/AuthFlow";
import { EmbeddedAuthShell } from "@/components/auth/AuthShell";

/**
 * ── THE LANDING PAGE'S SIGN-IN REVEAL ────────────────────────────────────────────────────────
 *
 * "Get started" slides the hero left and brings the sign-in card in from the right, instead of
 * navigating to /login and repainting the whole page.
 *
 * ── ⚠ IT IS STILL A REAL LINK TO /login, AND THAT IS THE MOST IMPORTANT LINE IN THIS FILE ──
 *
 * The reveal is an ENHANCEMENT layered on a working navigation, not a replacement for it. The
 * element stays an `<a href="/login">` and the click handler bails out, letting the browser
 * navigate normally, in every case where intercepting would take something away from the user:
 *
 *   - JavaScript has not loaded or has failed (no handler runs at all, the href just works);
 *   - a modified click (⌘/ctrl/shift/alt, or middle button), which means "open somewhere else";
 *   - a viewport below `lg`, where there is no room for two columns side by side.
 *
 * Building this as a `<button>` with `router.push` would have broken open-in-new-tab, copy-link,
 * and the no-JS path, in exchange for nothing.
 *
 * ── ⚠ THE URL IS UPDATED WITHOUT NAVIGATING, so the address bar does not lie ──
 * `history.pushState` to /login on reveal, and a `popstate` listener to collapse again. Without
 * it, Back would leave the site entirely from what looks to the user like a second page, and a
 * refresh would silently discard the form they had started filling in. With it, Back closes the
 * panel and refresh lands on the real /login route rendering the same flow.
 *
 * ⚠ `pushState` RATHER THAN `router.push`: Next's router would mount the /login route and
 * unmount this page, which is precisely the full-page transition being avoided.
 *
 * ── MOTION ──
 * Transform and opacity only, so the animation stays on the compositor. `prefers-reduced-motion`
 * is handled globally in globals.css (durations collapse to 0.01ms), so the panel appears
 * instantly for those users rather than not at all, the end state is identical either way.
 */
export function LandingSplit({
  hero,
  pillars,
  mode = "overlay",
  initialError = null,
}: {
  /** The hero block: eyebrow, headline, subtext. The CTA is rendered here, not passed in. */
  hero: ReactNode;
  pillars: ReactNode;
  /**
   * ── ⚠ WHY THERE ARE TWO MODES AND NOT ONE ─────────────────────────────────────────────────
   *
   * `"overlay"` is `/`: the hero stands alone and the panel slides in over the right-hand side
   * when "Get started" is pressed.
   *
   * `"page"` is `/login`: the same layout with the panel ALREADY open, because otherwise the two
   * ways of reaching sign-in look like two different products. That mattered more than it
   * sounds, the reveal pushes `/login` into history, so a reader who refreshed or followed a
   * link from their invitation email landed on the old standalone card mid-journey and saw the
   * design change under them.
   *
   * ⚠ THE MODES DIFFER BELOW `lg` AND THAT IS THE WHOLE REASON IT IS A PROP RATHER THAN JUST AN
   * INITIAL STATE. In overlay mode the panel is `hidden` under `lg` (there is no room for two
   * columns, so the CTA navigates instead). Doing that in page mode would leave someone opening
   * /login on a phone looking at a hero with a "Get started" button and no form at all. So in
   * page mode the panel drops into normal flow below `lg` and the hero steps aside.
   */
  mode?: "overlay" | "page";
  /** NextAuth's `?error=`, surfaced by the /login route. */
  initialError?: string | null;
}) {
  const isPage = mode === "page";
  const [open, setOpen] = useState(isPage);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Set by the CTA click so the focus effect can tell a reveal from a page load. */
  const wantsFocusRef = useRef(false);
  /**
   * ── ⚠ THE URL IS THE STATE, and `open` is derived from it rather than tracked beside it ──
   *
   * The first version of this counted whether *we* had pushed a history entry, so that Escape
   * could call `history.back()` without walking the user off the site. That bookkeeping broke as
   * soon as /login became an entry point in its own right: arriving there directly means the
   * panel is open with nothing of ours on the stack, so "go back" and "close the panel" stopped
   * being the same operation.
   *
   * Both directions now just keep the path in step with the panel, /login open, / closed, and
   * `popstate` reads the panel state back out of `location.pathname`. One rule, and it holds for
   * every entry point: pressed the CTA, refreshed, followed an invitation link, or pressed Back.
   */
  const setPath = useCallback((nextOpen: boolean) => {
    const path = nextOpen ? "/login" : "/";
    if (window.location.pathname !== path) {
      window.history.pushState({ authPanel: nextOpen }, "", path);
    }
  }, []);

  const reveal = useCallback(() => {
    wantsFocusRef.current = true;
    setOpen(true);
    setPath(true);
  }, [setPath]);

  const collapse = useCallback(() => {
    setOpen(false);
    setPath(false);
  }, [setPath]);

  // ⚠ READ BACK OUT OF THE URL, not toggled. `popstate` fires for Back AND Forward, and for
  // history entries this component never created; deriving from the path is correct for all of
  // them, where flipping a boolean would desynchronise on the second press.
  useEffect(() => {
    const onPop = () => setOpen(window.location.pathname === "/login");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /**
   * ⚠ FOCUS MOVES INTO THE PANEL, and it is not optional. A keyboard or screen-reader user who
   * activates "Get started" and is left on the CTA has no idea a form appeared, the reveal is
   * a purely visual event to them. Focus lands on the email field, which is also where a mouse
   * user would click next.
   *
   * ⚠ NOT A FOCUS TRAP, deliberately. This is not a modal: the hero beside it stays visible and
   * legible, and trapping focus in a panel the user can simply Escape out of would make Tab
   * unable to reach the page it is sitting on. `role="dialog"` is likewise wrong for the same
   * reason and is not used.
   */
  /**
   * ⚠ FOCUS FOLLOWS THE ACTION, NOT THE STATE, and the distinction is why this is a ref set by
   * the click rather than a check inside the effect.
   *
   * A keyboard or screen-reader user who presses "Get started" and is left on the CTA has no
   * idea a form appeared, so a reveal MUST move focus. But arriving at /login already open is
   * not a reveal, moving focus because a document finished loading scroll-jumps some browsers
   * and talks over the screen reader's own page-load announcement. (The email field carries its
   * own `autoFocus` for that case, which is the right mechanism for it.)
   *
   * ⚠ AN "IS THIS THE FIRST RUN?" FLAG MUTATED INSIDE THE EFFECT WOULD NOT SURVIVE STRICT MODE.
   * React deliberately runs effects twice in development, so the first pass would consume the
   * flag and the second would focus anyway, the bug would appear only in dev, or only in prod,
   * depending which way round it was written. Setting the intent in the click handler makes the
   * double invocation harmless: the second pass finds the flag already cleared.
   *
   * ⚠ NOT A FOCUS TRAP either. This is not a modal: the hero stays visible and legible beside
   * it, so trapping Tab inside the panel would make the page it sits on unreachable.
   */
  useEffect(() => {
    if (!open || !wantsFocusRef.current) return;
    wantsFocusRef.current = false;
    panelRef.current
      ?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled])')
      ?.focus();
  }, [open]);

  // Escape closes, matching every other dismissible surface in the product.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, collapse]);

  const onCtaClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // A modified click means "open this elsewhere". Honour it.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    // Below `lg` the two columns do not fit, so let the navigation happen. Read from the
    // media query rather than from a resize listener: it is the same breakpoint the classes
    // below use, and there is nothing to keep in sync.
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    e.preventDefault();
    reveal();
  };

  return (
    /* `lg:overflow-x-hidden` so the panel is genuinely off-stage when collapsed rather than
       merely transparent, without it, a translated-but-visible panel would widen the document
       and add a horizontal scrollbar. Scoped to `lg` because below it nothing is translated. */
    <div className="relative w-full lg:overflow-x-hidden">
      <div className="relative mx-auto w-full max-w-3xl lg:max-w-6xl">
        {/* ── THE HERO COLUMN ──
            Slides left by half the panel's width so the two columns end up optically balanced
            in the container, rather than the hero merely being shoved aside.

            ⚠ `lg:` ON EVERY MOTION CLASS. Below the breakpoint the CTA navigates, so this
            subtree must never be translated, a hero shifted 13rem left on a phone would sit
            half off-screen if `open` were ever true there. */}
        <div
          className={`transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
            open ? "lg:-translate-x-[13rem]" : "lg:translate-x-0"
          } ${
            /* ⚠ IN PAGE MODE THE HERO STANDS DOWN BELOW `lg`. /login on a phone must be a
               sign-in form, not a marketing hero with the form somewhere below the fold. Above
               `lg` both are shown, which is the whole point of the shared layout. */
            isPage ? "hidden lg:block" : ""
          }`}
        >
          <div className="mx-auto w-full max-w-3xl">
            {hero}
            {/* ⚠ THE TRIGGER IS REMOVED ONCE THE PANEL IS OPEN, not restyled.
                It was briefly an outline button here, on the reasoning that it carried the
                `aria-expanded`/`aria-controls` relationship. Removing it drops that
                relationship, so the panel is no longer a disclosure, it is a view swap, and
                the announcement job moves to the focus change instead: focus lands on the email
                field, which tells a screen-reader user what appeared far more directly than an
                `aria-expanded` toggle on a button they have left behind.

                ⚠ `invisible`, NOT UNMOUNTED, and the difference is visible. `<main>` centres
                this column vertically, so unmounting a 44px button plus its 24px margin
                re-centres the whole hero and drags the pillars upward, a jump competing with
                the 500ms slide. `invisible` removes it from view, from the tab order and from
                the accessibility tree while its box keeps holding the space, so nothing else
                moves. */}
            <div
              className={`mt-6 flex items-center justify-center transition-opacity duration-300 ${
                open ? "invisible opacity-0" : "opacity-100"
              }`}
              aria-hidden={open}
            >
              <Link
                href="/login"
                onClick={onCtaClick}
                tabIndex={open ? -1 : undefined}
                className="rounded-md bg-brand px-6 py-3 text-sm font-semibold text-brand-ink transition-colors hover:bg-brand-hover active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Get started
              </Link>
            </div>
            {pillars}
          </div>
        </div>

        {/* ── THE SIGN-IN PANEL ──
            ⚠ ABSOLUTELY POSITIONED, WHICH IS WHAT KEEPS THE ANIMATION CHEAP. In flow it would
            change the grid every frame, so the hero's width, and therefore its text wrapping -
            would be recomputed on each tick of a 500ms transition. Out of flow, both sides
            animate with transform and opacity alone and the layout is calculated once.

            ⚠ `hidden lg:block` RATHER THAN JUST TRANSLATED OFF-STAGE. A visually-hidden panel
            that is still in the accessibility tree puts a whole sign-in form into the tab order
            of a page that appears to have one button, and `aria-hidden` alone would leave it
            focusable. Below `lg` it is not rendered at all, because there the CTA navigates. */}
        <aside
          id="signin-panel"
          ref={panelRef}
          aria-label="Sign in"
          aria-hidden={!open}
          /* ⚠ `inset-y-0` + `flex items-center`, NOT `top-0`. The card is ~340px and the column
             beside it (hero, CTA space, three pillars) is ~590px, so anchoring to the top left
             it visibly high, the two sides read as unrelated blocks rather than as one
             composition. Stretching the panel to the column's full height and centring inside
             it lines the card's optical centre up with the hero's.

             ⚠ AND IT IS SELF-LIMITING, which is why this beats `top-1/2 -translate-y-1/2`. That
             would centre a mathematical midpoint, so a tall step (TOTP enrolment is roughly
             twice the sign-in card) would grow symmetrically and push the card up under the
             header. Stretched-and-centred with `max-h-full` on the scroller below, the panel can
             never exceed the height of the content beside it: it centres while it fits and
             scrolls internally once it does not. */
          className={`transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] lg:absolute lg:inset-y-0 lg:right-0 lg:flex lg:items-center lg:w-[22rem] ${
            /* Overlay mode: never rendered below `lg`, because the CTA navigates there instead.
               Page mode: in normal flow below `lg`, centred at the card's own width, so /login
               on a phone is just the form. */
            isPage ? "mx-auto block w-full max-w-sm" : "hidden"
          } ${
            open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-10 opacity-0"
          }`}
        >
          {/* ⚠ A HEIGHT CAP WITH ITS OWN SCROLL. The journey behind this panel has twelve
              screens and they are not the same height: TOTP enrolment renders a QR code and a
              secret to copy, which is roughly twice the sign-in card. Without the cap, reaching
              that step would grow the panel past the viewport and reintroduce the page scroll
              this layout was tuned to avoid. The panel scrolls; the page does not. */}
          {/* `lg:max-h-full` resolves against the stretched panel, i.e. against the height of
              the content on the left. The viewport-based cap stays for the mobile page-mode
              case, where the panel is in normal flow and has no such neighbour to measure. */}
          <div className="w-full max-h-[calc(100vh-14rem)] overflow-y-auto pr-1 lg:max-h-full">
            <EmbeddedAuthShell>
              <AuthFlow callbackUrl="/" initialError={initialError} />
            </EmbeddedAuthShell>
          </div>

          {/* ⚠ NO "BACK" CONTROL UNDER THE CARD. Removed on request. The panel is still
              dismissible by Escape and by the browser's own Back (the URL is a real history
              entry), and the hero it slid out from stays visible beside it, so the reader is
              not stranded on something that looks like a page with no exit. There is, though,
              no on-screen affordance for it any more, worth knowing rather than discovering. */}
        </aside>
      </div>
    </div>
  );
}
