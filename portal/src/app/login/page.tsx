"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { SiteFooter } from "@/components/SiteFooter";
import { LandingSplit } from "@/components/landing/LandingSplit";
import { LandingHero, LandingPillars } from "@/components/landing/landing-content";

/**
 * Sign-in, rendered by our OWN screens against the Amplify Auth SDK rather than by
 * redirecting to the Cognito Hosted UI.
 *
 * The journey <AuthFlow> drives is the full one Cognito can demand, password, TOTP
 * enrolment (this pool is MfaConfiguration: ON, so every first sign-in enrols), the
 * per-sign-in TOTP challenge, email confirmation, forced password change, and
 * forgot/reset. See components/auth/AuthFlow.tsx.
 *
 * Everyone invited signs in here, participants included: they land on /welcome with
 * their team join code and the desktop download, while staff land on the workshop
 * list. Role is resolved server-side in lib/auth.ts from the Cognito
 * `cognito:groups` claim and the destination is chosen by landingPathForRole, so we
 * send everyone to "/" and let that single decision point route.
 *
 * ?error=... can still arrive here from NextAuth (e.g. a stale Hosted-UI callback,
 * or the credentials provider refusing a token that carried no recognised role), so
 * it's surfaced as the initial banner rather than dropped.
 *
 * ── ⚠ THIS ROUTE IS THE LANDING PAGE WITH THE PANEL ALREADY OPEN ────────────────────────────
 *
 * It used to render a standalone centred card on a grey field, which meant sign-in had two
 * different designs depending on how you arrived: the landing page's split layout if you pressed
 * "Get started", the old card if you opened /login directly.
 *
 * That was not merely inconsistent, it was reachable mid-task. The reveal on `/` pushes /login
 * into history, so refreshing the page, or following the link in an invitation email, or being
 * bounced here by middleware, swapped the design out from under a reader who had already started
 * typing. Both routes now render `LandingSplit` over the same `landing-content`; the only
 * difference is `mode`.
 *
 * ⚠ AND IT IS STILL A REAL, SEPARATELY-ADDRESSABLE ROUTE. `callbackUrl`, the middleware redirect
 * and NextAuth's `?error=` all target /login, and every one of them still works, this is a
 * change of appearance, not of routing.
 */
function LoginPageInner() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  // AccessDenied is the signIn-callback rejection of a token with no recognised
  // role, almost always a post-confirmation trigger that hasn't assigned a group
  // yet. Worth its own copy: "sign-in failed" would send the user to retype a
  // correct password forever.
  const initialError =
    error === "AccessDenied"
      ? "Your account doesn't have a role assigned yet. If you just registered, wait a moment and try again, or ask your facilitator to check your invitation."
      : error
        ? "Sign-in failed. Please try again."
        : null;

  return (
    /* The same shell as `app/page.tsx`, deliberately duplicated rather than factored out: it is
       four elements, and the two routes are free to diverge in their chrome (this one has no
       reason to carry a nav later; the landing page might). Extracting a wrapper to save three
       lines would couple them for no benefit. */
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas px-6 py-4 flex items-center">
        {/* `as="h1"` because on this route the product name IS the page heading: the sign-in
            card's own title is `sr-only` inside the panel, and the hero beside it is an `h2`. */}
        <BrandMark as="h1" tagline priority href="/" />
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-8 sm:py-10">
        <LandingSplit
          mode="page"
          initialError={initialError}
          hero={<LandingHero />}
          pillars={<LandingPillars />}
        />
      </main>

      <SiteFooter />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
