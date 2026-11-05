"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { displayName, profileInitials } from "@praimana/shared";
import { trpc } from "@/lib/trpc/client";
import { signOutEverywhere } from "@/lib/sign-out";
import {
  GIVE_FEEDBACK_LABEL,
  REPORT_BUG_LABEL,
  canSignInToDesktopApp,
  type FeedbackKind,
} from "@praimana/shared";
import { FeedbackDialog } from "./FeedbackDialog";

import { useCanManageUsers } from "@/lib/useRole";

/**
 * The signed-in user's name, avatar, and menu, replacing the bare "Sign out" link
 * that every header used to carry.
 *
 * Where the name comes from matters. The SESSION only holds what the Cognito ID
 * token carried, which is why the old headers fell back to
 * `session.user.name.split(" ")[0]`. The identity service's GET /v1/auth/me returns
 * the stored profile, first name, last name, organisation, so the menu reads from
 * there and treats the session as the fallback for the moment before it loads. That
 * also means editing your profile updates this header without re-authenticating,
 * which would not be true of a token claim.
 *
 * Rendered as a real menu (button + `aria-expanded` + Escape + outside-click)
 * rather than a hover dropdown: a hover-only menu is unusable on touch and
 * unreachable by keyboard, and this is the only route to "Sign out".
 */
export function ProfileMenu() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Administration lives in this menu rather than in every page header: it is a
  // rarely-used destination for two roles, and the header already carries the
  // primary action for the page you are on. Hidden for everyone else, the route
  // and the API refuse them independently, so this is only about not offering it.
  const canManageUsers = useCanManageUsers();

  /**
   * Which report form is open, or null.
   *
   * ⚠ THE CONTEXT IS NO LONGER ASSEMBLED HERE. It used to build a `mailto:` body from the pathname and the
   * route params; the dialog captures its own context from the page it opens over, and the SERVICE records
   * the reporter's identity from the verified token. Nothing about who or where is this menu's business any
   * more, which is why a whole block of path-parsing left with the mailto.
   */
  const [reporting, setReporting] = useState<FeedbackKind | null>(null);

  // The stored profile. `enabled` on the session so this doesn't fire before
  // there's an identity to fetch.
  const { data: me } = trpc.auth.me.useQuery(undefined, { enabled: !!session });

  // Prefer the stored profile; fall back to the token's claims while it loads, so
  // the header doesn't flash a "?" avatar on every page load.
  const profile = me ?? {
    name: session?.user?.name ?? undefined,
    email: session?.user?.email ?? undefined,
  };
  const name = displayName(profile);
  const initials = profileInitials(profile);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Escape closes: the menu covers content, and a user who opened it by
      // accident needs a way out that doesn't involve guessing where to click.
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!session) return null;

  async function handleSignOut() {
    // Disabled immediately: signOutEverywhere awaits a network round-trip before
    // navigating, and a second click would fire a second revocation.
    setSigningOut(true);
    await signOutEverywhere();
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 hover:bg-surface-2 transition-colors"
      >
        <span
          aria-hidden="true"
          className="h-8 w-8 shrink-0 rounded-full bg-brand text-brand-ink grid place-items-center text-xs font-semibold"
        >
          {initials}
        </span>
        <span className="text-sm font-medium text-ink-muted max-w-[12rem] truncate">
          {name}
        </span>
        <svg
          aria-hidden="true"
          className={`h-4 w-4 text-ink-tertiary transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          /* `shadow-lg` is Tailwind's pure-black drop shadow, which does nothing on a
             near-black surface, the dropdown lost its separation from the page entirely in
             the dark theme. `--overlay-shadow` is tinted to the surrounding canvas hue and
             defined per theme, so the panel keeps a real edge in both. The ring is what
             actually carries the separation in dark mode, where a shadow cannot. */
          className="absolute right-0 mt-2 w-60 rounded-lg border border-hairline bg-surface-3 shadow-[var(--overlay-shadow)] py-1 z-50"
        >
          {/* Identity restated inside the menu: the trigger truncates long names,
              and the email is what disambiguates two accounts on one machine. */}
          <div className="px-3 py-2.5 border-b border-hairline-soft">
            <p className="text-sm font-medium text-ink truncate">{name}</p>
            {profile.email && (
              <p className="text-xs text-ink-subtle truncate">{profile.email}</p>
            )}
            {me?.organization && (
              <p className="text-xs text-ink-tertiary truncate mt-0.5">
                {me.organization}
              </p>
            )}
          </div>

          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-ink-muted hover:bg-surface-1"
          >
            View profile
          </Link>

          {/*
            ── ⚠ DESKTOP APP AND HOW IT WORKS ────────────────────────────────────────────────────
            THE REQUIREMENT: collapse the desktop card and reach it from here instead, and add a documentation
            link.

            ⚠ "Desktop app" IS ROLE-GATED BY THE *SHARED* PREDICATE, the same function the desktop enforces
            at sign-in. Offering the app to somebody it will then refuse is the shape of the Submit-tab bug,
            so the offer and the enforcement read one function.

            ⚠ "How it works" IS NOT GATED, by explicit choice over staff-only. Participants are
            the people most likely to need it, and `/how-it-works` had to be added to PARTICIPANT_PATHS or
            the route gate would have bounced exactly that audience off a page written for them.
          */}
          {canSignInToDesktopApp(session?.user?.role) && (
            <Link
              href="/desktop"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-ink-muted hover:bg-surface-1"
            >
              Desktop app
            </Link>
          )}

          <Link
            href="/how-it-works"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-ink-muted hover:bg-surface-1"
          >
            How it works
          </Link>

          {canManageUsers && (
            <Link
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-ink-muted hover:bg-surface-1"
            >
              Administration
            </Link>
          )}

          {/*
            ── REPORT A BUG / GIVE FEEDBACK ──────────────────────────────────────────────────────
            "add these links in the profile". They sit ABOVE Sign out and below the destinations,
            separated by a rule: they are not navigation, and putting them next to Sign out without a
            divider invites a misclick on the one irreversible item in this menu.

            ⚠ BUTTONS, NOT LINKS, SINCE THE mailto WENT. They open
            a form over the page rather than navigating, a bug is reported in the middle of hitting it, and
            navigating away loses both the screen being described and anything half-typed elsewhere.

            ⚠ AND THEY NEED NO CONFIGURATION. The mailto version rendered NOTHING without a support address,
            which is how it came to be invisible and prompted "where can i see report bug and feedback on
            portal?". A stored report has no address to configure, so these are always here.
          */}
          <div className="border-t mt-1 pt-1">
            {(
              [
                ["BUG", REPORT_BUG_LABEL],
                ["FEEDBACK", GIVE_FEEDBACK_LABEL],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setReporting(kind);
                }}
                className="block w-full px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-1"
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full text-left px-3 py-2 text-sm text-ink-muted hover:bg-surface-1 disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}

      {/*
        ⚠ MOUNTED OUTSIDE THE MENU PANEL, DELIBERATELY. The panel unmounts when `open` goes false, and the
        menu is closed the moment a report is started, so a dialog rendered inside it would vanish with the
        click that opened it.
      */}
      {reporting && <FeedbackDialog kind={reporting} onClose={() => setReporting(null)} />}
    </div>
  );
}
