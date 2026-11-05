import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { landingPathForRole } from "@praimana/shared";
import { BrandMark } from "@/components/BrandMark";
import { SiteFooter } from "@/components/SiteFooter";
import { LandingSplit } from "@/components/landing/LandingSplit";
import { LandingHero, LandingPillars } from "@/components/landing/landing-content";

export default async function HomePage() {
  const session = await auth();

  // Role decides the destination: participants get the onboarding page (join code
  // + desktop download), staff get the workshop list.
  if (session?.user) {
    redirect(landingPathForRole(session.user.role));
  }

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      {/* NO sign-in button up here, deliberately. It pointed at the same /login as
          the hero's "Get Started" two hundred pixels below, so the page offered one
          action under two different names, which reads as two different things and
          makes a visitor choose between them. The hero keeps the call to action;
          this row is just the brand. */}
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas px-6 py-4 flex items-center">
        {/* as="h1" keeps this page's heading order intact: the hero below is the
            <h2>, so the product name has to stay the <h1>. */}
        <BrandMark as="h1" tagline priority />
      </header>

      {/* ⚠ THIS PAGE STAYS A SERVER COMPONENT. It calls `auth()` and redirects signed-in
          visitors before rendering anything, which must happen on the server, doing it in
          the client would ship the landing page to someone who is already signed in and
          then bounce them, with a visible flash of the wrong page.

          So only the INTERACTIVE part is a client component: `LandingSplit` owns the reveal
          state and the animation, and receives the hero and the pillars as children. The
          copy and the inline SVG stay server-rendered, so none of it costs client JS. */}
      <main className="flex-1 flex items-center justify-center px-6 py-8 sm:py-10">
        <LandingSplit hero={<LandingHero />} pillars={<LandingPillars />} />
      </main>

      <SiteFooter />
    </div>
  );
}
