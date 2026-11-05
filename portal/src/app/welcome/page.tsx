"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import {
  INVITABLE_PLATFORM_ROLES,
  TEAM_ROLES,
  greetingName,
} from "@praimana/shared";
import { trpc } from "@/lib/trpc/client";
import { WelcomeResources } from "@/components/WelcomeResources";
import { Disclosure } from "@/components/Disclosure";
import { ProfileMenu } from "@/components/ProfileMenu";
import { BrandMark } from "@/components/BrandMark";
import { SiteFooter } from "@/components/SiteFooter";

/**
 * Post-registration onboarding, the page a newly-registered PARTICIPANT lands on
 * after the Cognito Hosted UI round-trip. It hands them the two things they need:
 *
 *   1. Their team's JOIN CODE (entered once in the desktop app to join).
 *   2. The desktop app download.
 *
 * The code comes from the caller's own INVITATIONS, not from membership:
 * registration deliberately does not auto-join a team, so a fresh participant has
 * no membership yet and team.listMine would be empty. The backend keys the lookup
 * on the verified token's email, so nothing here is tamperable, this page passes
 * no team id or code.
 *
 * Staff can reach this page too (it's a harmless summary of their own invites);
 * middleware only confines participants TO it.
 */

// Human labels + the API route that presigns and 302s to the installer. The
// download is a plain browser navigation (not a fetch): the backend redirects to
// a short-lived presigned S3 URL, and a link is the simplest way to let the
// browser follow that. Per-platform, keyed by the same codes the backend uses.
const PLATFORM_LABELS: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
};
function downloadHref(platform: string): string {
  return `/api/desktop/download?platform=${platform}`;
}

// "Participant · Builder" (or just "Judge") from the stored role codes. Same
// mapping the team page uses.
function roleLabel(platformRole?: string, teamRole?: string | null): string {
  const platform =
    INVITABLE_PLATFORM_ROLES.find((r) => r.role === platformRole)?.label ??
    platformRole ??
    "Participant";
  const team = teamRole
    ? TEAM_ROLES.find((r) => r.role === teamRole)?.label ?? teamRole
    : undefined;
  return team ? `${platform} · ${team}` : platform;
}

export default function WelcomePage() {
  const { data: session, status: sessionStatus } = useSession();
  const { data: invitations = [], isLoading: invitationsLoading } =
    trpc.team.listMyInvitations.useQuery(undefined, { enabled: !!session });

  /**
   * WAITING FOR THE SESSION COUNTS AS LOADING, the same defect fixed on /experiences, and it
   * matters more here.
   *
   * `enabled: !!session` leaves this query DISABLED until NextAuth resolves, and a disabled
   * query reports `isLoading === false` because nothing is in flight. So the first paint fell
   * through to `invitations.length === 0` and told a participant who had JUST registered from
   * an invitation "No team invitation found yet", on the one screen whose entire purpose is
   * handing them that code, at the one moment they are most likely to believe something went
   * wrong with their sign-up.
   */
  const isLoading = invitationsLoading || sessionStatus === "loading";

  // Which installers are published (per platform). Drives the download buttons;
  // when nothing is published the page explains the link is coming.
  const { data: releases, isLoading: releasesFetching } =
    trpc.desktop.releases.useQuery(undefined, { enabled: !!session });
  // Same reasoning as `isLoading` above: this one decides between offering a download and
  // saying the installer is not published yet, so a pre-session paint would tell a new user
  // the app does not exist.
  const releasesLoading = releasesFetching || sessionStatus === "loading";

  const availablePlatforms = releases
    ? (["macos", "windows"] as const).filter((p) => releases[p])
    : [];

  // The stored profile, for the greeting. Previously this was
  // `session.user.name.split(" ")[0]`, a guess that is wrong for anyone whose given
  // name contains a space or whose display name is family-name-first. The first name
  // is now stored as its own field, collected as mandatory at registration.
  const { data: me } = trpc.auth.me.useQuery(undefined, { enabled: !!session });

  /**
   * The experiences this participant belongs to, for the resources section below.
   *
   * ⚠ FROM THEIR TEAMS, NOT FROM THEIR INVITATIONS. `listMyInvitations` carries a teamId but no
   * workshopId, and an invitation that has not been accepted is not membership, the service's read
   * gate admits a participant through MEMBERSHIP, so an invitation alone would produce a section that
   * 403s. `team.listMine` returns the teams they are on, each with its workshopId.
   *
   * De-duplicated because two teams on one experience would otherwise render the list twice.
   */
  /**
   * ── ⚠ EVERY SECTION STARTS CLOSED, WHICH INVERTS `Disclosure`'s USUAL DEFAULT ────────────────
   *
   * Deliberate. That component's header says a collapsible section of PRIMARY
   * content "opens by default and collapsing is a scanning aid, not a way to defer work", true of a
   * roster, and the opposite of what this page is. /welcome is a CHECKLIST: once a participant has
   * their code, has installed the app and has connected it, all three steps are finished work they
   * scroll past. Closed by default turns a long page into a short one they can re-open on demand.
   *
   * ⚠ THE COST, STATED PLAINLY: a FIRST-TIME participant now lands on closed panels and must click to
   * find their team code. The counts in the headings are what keeps that bearable, "Your team code (1)"
   * still answers "is there anything here for me?" while shut, which is exactly the reason that
   * component puts the count inside the heading.
   *
   * ⚠ ONE SECTION IS NOT IN HERE AND THAT IS DELIBERATE: the AI-usage disclosure stays open, always.
   * See its own comment, it must be read BEFORE someone starts working, and this page is "the only
   * place every participant reliably sees". A disclosure behind a click is not a disclosure.
   */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const { data: myTeams } = trpc.team.listMine.useQuery(undefined, { enabled: !!session });
  const myExperiences = Array.from(
    new Map((myTeams ?? []).map((t) => [t.workshopId, t])).values()
  ).filter((t) => Boolean(t.workshopId));

  /**
   * The link that configures the desktop app for this platform.
   *
   * ⚠ A QUERY FETCHED ON LOAD, which the earlier version could not be: it minted a single-use
   * 60-second code, so fetching it on render would have burned it while the user read the page.
   * The link now carries only configuration, nothing expires and nothing is consumed, so it
   * can be a plain `<a href>` the user clicks whenever they are ready.
   *
   * `retry: false`, the failure mode is a MISSING ENV VAR, not a flake, so retrying only
   * delays the message that tells a facilitator to fix the deployment.
   */
  const { data: desktopLink, isError: linkError } = trpc.desktop.connectLink.useQuery(undefined, {
    enabled: !!session,
    retry: false,
  });
  const firstName = me
    ? greetingName(me)
    : session?.user?.name
      ? greetingName({ name: session.user.name })
      : undefined;

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas px-6 py-4 flex items-center justify-between">
        {/* No href: middleware confines a fresh participant to this page, so a link
            home would bounce them straight back here. Was a bare <h1>, stays the
            <h1>, "You're registered" below is the <h2>. */}
        <BrandMark as="h1" tagline priority />
        <ProfileMenu />
      </header>

      {/* flex-1 so the footer sits at the bottom rather than under the content. */}
      <main className="w-full flex-1 max-w-2xl mx-auto px-6 py-10">
        {/* ⚠ THE 🎉 IS GONE, and the reason is the screen reader rather than taste. It sat
            immediately after the reader's own name, so the heading was announced as
            "You're registered, Priya, party popper", the emoji name read out as if it were
            part of their greeting. It also renders as a different object on every OS, and
            the sentence carries the good news perfectly well without it.

            Same call as the three pillar emoji on the landing page, and `text-2xl font-bold`
            becomes the Linear heading step for the same reason as elsewhere: tracking, not
            weight, is what makes a heading feel deliberate. */}
        <h2 className="text-2xl font-semibold tracking-heading-tight">
          You&apos;re registered{firstName ? `, ${firstName}` : ""}
        </h2>
        <p className="mt-2 text-sm text-ink-subtle">
          Three steps left: download the desktop app, connect it to this platform, then
          join your team with the code below.
        </p>

        {/* Step 1, the join code(s), from the caller's own invitations. */}
        <Disclosure
          id="welcome-team-code"
          title="1. Your team code"
          count={invitations.length}
          open={!!openSections["welcome-team-code"]}
          onToggle={() => toggle("welcome-team-code")}
          className="mt-8"
        >
          <p className="text-sm text-ink-subtle mb-4">
            Enter this in the desktop app to join your team.
          </p>

          {isLoading ? (
            <div className="animate-pulse text-ink-tertiary">Loading your invitation…</div>
          ) : invitations.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-ink-subtle">No team invitation found yet.</p>
              <p className="text-sm text-ink-tertiary mt-1">
                Ask your facilitator to invite {session?.user?.email || "your email"}{" "}
                to a team, then reload this page.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {invitations.map((inv) => (
                <InvitationCard key={inv.teamId} invitation={inv} />
              ))}
            </div>
          )}
        </Disclosure>

        {/* Step 2, the desktop download. */}
        <Disclosure
          id="welcome-get-app"
          title="2. Get the desktop app"
          open={!!openSections["welcome-get-app"]}
          onToggle={() => toggle("welcome-get-app")}
          className="mt-10"
        >
          <p className="text-sm text-ink-subtle mb-4">
            The desktop app is where you build. It connects your AI assistant, your
            repo, and your team&apos;s workspace.
          </p>

          {releasesLoading ? (
            <div className="animate-pulse text-ink-tertiary">Checking for the latest build…</div>
          ) : availablePlatforms.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {availablePlatforms.map((platform) => (
                <a
                  key={platform}
                  href={downloadHref(platform)}
                  className="inline-block rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-brand-ink hover:bg-brand-hover transition-colors"
                >
                  Download for {PLATFORM_LABELS[platform] ?? platform}
                </a>
              ))}
            </div>
          ) : (
            <div className="rounded-md bg-warn-bg border border-warn-border px-4 py-3 text-sm text-warn-text">
              The download isn&apos;t published yet. Your facilitator will share
              the installer. Your team code above stays valid.
            </div>
          )}
        </Disclosure>

        {/* Step 3, connecting the desktop app to THIS platform.
            The desktop is one binary shipped to many customers, so it has no idea which
            deployment it belongs to until someone tells it. This is where that happens. */}
        <Disclosure
          id="welcome-connect-app"
          title="3. Connect the desktop app"
          open={!!openSections["welcome-connect-app"]}
          onToggle={() => toggle("welcome-connect-app")}
          className="mt-10"
        >
          <p className="text-sm text-ink-subtle mb-4">
            After you extract the desktop app, download your <code>connect.json</code> below and place
            it in the extracted folder, next to <code>start.sh</code> / <code>start.bat</code>, then
            run the start script. The app opens on a Connect screen pre-filled for this platform; you
            sign in there with the same email and password you used here.
          </p>
          {linkError ? (
            <div className="rounded-md bg-warn-bg border border-warn-border px-4 py-3 text-sm text-warn-text">
              Desktop sign-in isn&apos;t configured on this platform yet. Ask your facilitator.
              Your team code above stays valid.
            </div>
          ) : desktopLink ? (
            <DesktopConnectCard />
          ) : (
            <div className="animate-pulse text-ink-tertiary">Preparing your config…</div>
          )}
        </Disclosure>

        {/*
          ⚠ WHY RESOURCES APPEAR HERE AND NOT ON THE EXPERIENCE PAGE. `route-gates.ts` gate 1 confines a
          PARTICIPANT to /welcome, /profile, /how-it-works and /desktop, `canAccessStaffScreens` covers
          ADMIN, FACILITATOR, EXECUTIVE and JUDGE, and PARTICIPANT is the one role excluded. So the
          Resources TAB in the experience console is unreachable for them and the feature reached
          everyone except the audience most likely to want the brief. This is the same list on the
          surface they already have; nothing was added to the allowlist.

          ONE SECTION PER EXPERIENCE, each its own component so each can run its own query, a hook
          cannot be called in a loop. Bounded by the participant's own memberships, which is one in
          nearly every case. Each renders NOTHING when that experience has no resources.
        */}
        {myExperiences.map((t) => (
          <WelcomeResources
            key={t.workshopId}
            workshopId={t.workshopId}
            experienceName={myExperiences.length > 1 ? t.name : undefined}
            /* Collapsed like the rest. The component keeps its own id so two experiences toggle
               independently, and still renders NOTHING when that experience has no resources, a
               collapsed section the participant can open to find it empty would be worse than absent. */
            open={!!openSections[`welcome-resources-${t.workshopId}`]}
            onToggle={() => toggle(`welcome-resources-${t.workshopId}`)}
          />
        ))}

        {/* ── HOW WE USE YOUR WORK, said up front ────────────────────────────────
            A model reads this participant's AI conversations and team chat to produce
            an AI-usage assessment for them. That has to be disclosed BEFORE they start
            working, not discovered later on a page that scores them, and the first
            screen after sign-in is the only place every participant reliably sees.

            The tone is deliberate and it is not decoration. The honest purpose of this
            feature is coaching: showing someone how they are working with an assistant
            and what would make them better at it. Framing it as surveillance would be
            both inaccurate and self-defeating, people who feel measured optimise for
            the measure. So it says what is read, what it is for, and what it is NOT.

            NOT dismissible, and no acknowledgement flag: this is not a consent gate we
            are recording, it is information that should stay visible every time a
            participant lands here. A "don't show again" would hide it from exactly the
            person it concerns. */}
        <section className="mt-10 rounded-lg border border-brand-border bg-brand-wash p-5">
          <h3 className="font-semibold">Your AI coaching insights</h3>
          {/* ⚠ REWRITTEN WHEN PER-MEMBER READS BECAME EXECUTIVE-ONLY, and the previous text is
              why this comment exists. It said "Your team sees your insights, the same page shows
              everyone's" and "The point is to help you improve, not to grade you". Both became
              FALSE for a participant the moment the rule became that per-member insights are read
              by executives only: a participant cannot see the coaching written about them, so
              there is nothing for them to improve FROM here.

              The honest version says who reads it and stops claiming a benefit the reader does
              not receive. Overstating access is the worse error of the two, somebody who
              believes their assistant conversations are only summarised at team level, when an
              executive reads a per-person assessment of them, has been misled about something
              they might have chosen differently about. */}
          <p className="mt-1.5 text-sm text-ink-muted leading-relaxed">
            As you work, the platform looks at how you use your AI assistant, meaning your
            conversations with it and your team chat, and turns that into an assessment of
            how effectively you work with it.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-ink-subtle">
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>
                <span className="font-medium">
                  An executive on your team reads the per-person assessments
                </span>, including yours. Your teammates do not, and neither do facilitators,
                judges or admins.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>
                <span className="font-medium">
                  Executives and judges see a team-level summary
                </span>{" "}
                : how the team worked overall, built only from activity counts, never from
                your individual messages.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>
                <span className="font-medium">
                  Your executive will share your review with you
                </span>, including anything worth changing or improving. It is written as coaching:
                what is working, and concrete things to try next.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>
                <span className="font-medium">It measures how you work, not what you know.</span>{" "}
                It looks at whether prompts carry context and whether answers get challenged,
                not at the subject matter and not at how much you produced.
              </span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-ink-subtle leading-relaxed">
            Every insight page explains exactly how its numbers are calculated. Look
            for the &ldquo;i&rdquo; next to the heading.
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

interface Invitation {
  teamId: string;
  teamName: string;
  /** Null once the invitation is spent, see the note in the tRPC router. */
  inviteCode: string | null;
  /** Branch on this rather than on the null: `!!null` is a footgun in JSX. */
  codeAvailable: boolean;
  platformRole: string;
  teamRole: string | null;
  joined: boolean;
}

function InvitationCard({ invitation }: { invitation: Invitation }) {
  const [copied, setCopied] = useState(false);

  function copyCode() {
    // Guarded rather than asserted non-null: a spent invitation has no code, and
    // `writeText(null)` would put the string "null" on the operator's clipboard -
    // which they would then paste into a join box and get a puzzling refusal from.
    if (!invitation.inviteCode) return;
    navigator.clipboard.writeText(invitation.inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border p-5 bg-surface-1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{invitation.teamName}</p>
          <p className="text-xs text-ink-subtle mt-0.5">
            {roleLabel(invitation.platformRole, invitation.teamRole)}
          </p>
        </div>
        {invitation.joined && (
          <span className="text-xs font-medium px-2 py-1 rounded-full bg-success-bg text-success-text border border-success-border whitespace-nowrap">
            Joined
          </span>
        )}
      </div>

      {/* THE CODE BOX ONLY EXISTS WHILE THERE IS A CODE.
          Rendered unconditionally, a spent invitation produced an empty bordered box and a
          Copy button that copied nothing, the shape of a broken screen, on the page a
          participant lands on. The service stopped returning the code for a spent row
          because it is a live credential: a removed member was found reading it from this
          payload and rejoining the team with it.

          A joined member needs no code, they are already on the team, and the "Joined"
          badge above is the whole story. So the absence is explained rather than left as a
          gap, because a card with a name and nothing else reads as data that failed to
          load. */}
      {invitation.codeAvailable && invitation.inviteCode ? (
        <div className="flex items-center gap-3 mt-4">
          <div className="flex-1 rounded-md border bg-surface-3 px-4 py-2.5 font-mono text-lg tracking-widest text-center">
            {invitation.inviteCode}
          </div>
          <button
            onClick={copyCode}
            className="rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-ink hover:bg-brand-hover transition-colors"
          >
            {copied ? "Copied!" : "Copy Code"}
          </button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-subtle">
          {invitation.joined
            ? "You are already on this team, so no code is needed."
            : "This invitation has been used. Ask your facilitator for a new one if you need to rejoin."}
        </p>
      )}
    </div>
  );
}

/**
 * ── STEP 3: CONNECT THE DESKTOP APP ──
 *
 * Step 3's action: download the experience's `connect.json` and run the start script.
 *
 * The run-from-source desktop app reads a `connect.json` placed next to its start script to learn
 * which deployment it belongs to. This replaces the earlier `praimana://` deep-link button, which
 * depended on the OS having registered the scheme to the right app, fragile, and the wrong model for
 * a run-from-source zip. The config is served as a file download by /api/desktop/connect-json.
 */
function DesktopConnectCard() {
  return (
    <div className="rounded-lg border p-4">
      {/* A plain <a download>, not a router link: this is a file download, a top-level navigation the
          middleware gates like a page (see /api/desktop/connect-json in PARTICIPANT_PATHS). */}
      <a
        href="/api/desktop/connect-json"
        download="connect.json"
        className="inline-block rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-brand-ink hover:bg-brand-hover transition-colors"
      >
        Download connect.json
      </a>

      <ol className="mt-4 space-y-1.5 text-sm text-ink-subtle list-decimal pl-5">
        <li>
          Put <code>connect.json</code> in the folder you extracted the desktop app into, the one
          containing <code>start.sh</code> and <code>start.bat</code>.
        </li>
        <li>
          Open a terminal / command prompt in that folder and run{" "}
          <code>./start.sh</code> (macOS/Linux) or <code>start.bat</code> (Windows). The first run
          installs and builds, so it takes a few minutes.
        </li>
        <li>
          The app opens on a <strong>Connect</strong> screen already filled in for this platform,
          review it, click Connect, then sign in with your email and password.
        </li>
      </ol>

      <p className="mt-3 text-xs text-ink-tertiary">
        The <code>START-HERE.md</code> file in that folder has the same steps and troubleshooting.
      </p>
    </div>
  );
}
