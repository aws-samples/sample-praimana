"use client";

import type { ReactNode } from "react";
import { useSession } from "next-auth/react";
import { landingPathForRole } from "@praimana/shared";
import { ProfileMenu } from "@/components/ProfileMenu";
import { BrandMark } from "@/components/BrandMark";

/**
 * The chrome layer: above the page, below every overlay. See `AppHeader`'s note for the full
 * scale. Exported so the layouts that stack a SECOND bar under the header pin the pair at the
 * same layer rather than guessing a number.
 */
export const Z_CHROME = "z-40";

/**
 * The application header, brand on the left, identity on the right.
 *
 * Extracted because the workspace screens did not have one. A facilitator or
 * participant who navigated into /w/<workshop>/t/<team>/… lost the product name, the
 * route back out, and, the part that actually broke things, the ProfileMenu, which
 * is the ONLY route to "Sign out", "View profile" and "Administration". Nine pages
 * behind one layout had no way to sign out at all.
 *
 * A component rather than nine copies of the markup: this is the third place the same
 * header exists (dashboard, admin, welcome, profile all hand-roll it), and the shared
 * BrandMark work has to land in ONE file rather than be chased through the tree. The
 * markup here is deliberately identical to the dashboard's header so those
 * hand-rolled copies can be replaced by this component without a visual diff.
 *
 * The brand itself is <BrandMark>, which owns the logo, the wordmark and the
 * alt-text rule, so the mark is the same artwork at the same size here as on the
 * landing and auth screens, and a re-brand is one edit.
 *
 * WHERE THE BRAND LINKS TO is per-role, not a fixed "/experiences". A PARTICIPANT is
 * confined to /welcome by middleware, so a hardcoded link would make the product name
 * a redirect for the one role most likely to click it out of confusion.
 *
 * ── ⚠ STICKY, AND `Z_CHROME` IS WHY IT IS NOT JUST `z-50` ────────────────────────────────────
 *
 * On a long page (Platform health, How it works, a full user directory) the header scrolled away
 * and took the ProfileMenu with it, so "Sign out" and "Administration" required scrolling back
 * to the top of the document to reach. That is the practical complaint, not a cosmetic one.
 *
 * The z-index has to sit ABOVE page content and BELOW every overlay, and the existing values in
 * this codebase are not arbitrary:
 *
 *   z-[100]  IdleTimeout, the session-expiry dialog outranks everything, correctly
 *   z-50     dialogs, ProfileMenu, confirmations, feedback, the identity dropdown
 *   z-30     RatingsPromptDisclosure
 *   z-20     InsightsMethodology
 *
 * So `z-40`: over the page, under all six z-50 overlays. Anything higher and a confirmation
 * dialog would render *behind* the header it is asking about.
 *
 * ⚠ THE PROFILE DROPDOWN IS STILL z-50 AND STILL WORKS, which is worth stating because it is
 * inside this header. A positioned element with a z-index creates a stacking context, so the
 * dropdown's 50 is resolved WITHIN this header's 40 rather than against the page, it paints
 * above page content because nothing else occupies 41-49, not because 50 > 40 globally.
 *
 * ⚠ AN OPAQUE BACKGROUND IS MANDATORY, not decorative. `bg-surface-3` was already here; without
 * a background a sticky header shows the page scrolling through it.
 */
export function AppHeader({
  /** Optional trailing content, placed BEFORE the profile menu so the menu stays
   *  the right-most element on every screen (a stable target). */
  children,
}: {
  children?: ReactNode;
}) {
  const { data: session } = useSession();
  const home = landingPathForRole(session?.user?.role);

  return (
    <header
      className={`sticky top-0 ${Z_CHROME} border-b border-hairline bg-surface-3 px-6 py-4 flex items-center justify-between`}
    >
      {/* as="span", not "h1": this header sits above pages that each have their own
          <h1> (a workshop name, a team name, "Administration"), and a second <h1>
          per page would leave a screen reader with two competing page titles. */}
      <BrandMark as="span" href={home} tagline priority />
      <div className="flex items-center gap-4">
        {children}
        <ProfileMenu />
      </div>
    </header>
  );
}
