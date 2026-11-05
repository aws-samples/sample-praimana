"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { canSignInToDesktopApp } from "@praimana/shared";
import { AppHeader } from "@/components/AppHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { DesktopAppCard } from "@/components/DesktopAppCard";

/**
 * ── THE DESKTOP APP, ON ITS OWN PAGE ───────────────────────────────────────────────────────
 *
 * THE REQUIREMENT: collapse the card on the experiences list, and add a "Desktop app" entry to the
 * profile menu.
 *
 * ⚠ THE MENU ENTRY NEEDED AN HONEST DESTINATION, which is why this page exists rather than the entry
 * pointing at `/experiences` (where the card is now collapsed) or `/welcome` (which happens to carry the
 * installer for participants). A menu item called "Desktop app" that lands you on a list of experiences,
 * beside a collapsed box you then have to find and open, is a worse answer than one screen about the app.
 *
 * ⚠ AND IT REUSES THE SAME CARD rather than a second copy of the download logic. That component owns the
 * platform detection, the release lookup and the connect flow; a page re-implementing any of it would be a
 * second place for "which installer do I offer" to be wrong.
 *
 * ── ⚠ WHO SEES IT, THE SHARED PREDICATE, NOT A LOCAL ROLE TEST ──
 *
 * `canSignInToDesktopApp` is the same function the DESKTOP enforces at sign-in. That matters: offering the
 * app to somebody the app will then refuse is the exact shape of the Submit-tab bug, and a
 * second inline role list is how the two ends drift apart. A refused role gets an explanation rather than a
 * redirect, this URL is shareable, and "the app has nothing for your role" is more use than a bounce.
 */
export default function DesktopAppPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const allowed = canSignInToDesktopApp(role);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-8">
        <h1 className="text-2xl font-bold text-ink">Desktop app</h1>

        {allowed ? (
          <>
            <p className="mt-2 text-sm text-ink-subtle">
              Install it, or connect an installation you already have to this platform.
            </p>
            <div className="mt-6">
              <DesktopAppCard />
            </div>
          </>
        ) : (
          <div className="mt-6 rounded-lg border border-hairline bg-surface-3 p-5">
            {/*
              ⚠ AN EXPLANATION, NOT A REDIRECT. This URL is shareable, and the honest answer is that the app
              has nothing for this role, which is also what the desktop itself says if they try to sign in.
              Bouncing them would leave them wondering whether they had done something wrong.
            */}
            <p className="text-sm text-ink-muted">
              The desktop app is for team members: executives and participants. It runs a participant&apos;s
              AI assistant and syncs their team&apos;s files, so there is nothing in it for your role.
            </p>
            <p className="mt-2 text-sm text-ink-subtle">
              Everything a team produces is visible here in the browser.
            </p>
          </div>
        )}

        <p className="mt-8 text-sm">
          <Link href="/how-it-works" className="text-brand-text hover:underline">
            How this platform works →
          </Link>
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
