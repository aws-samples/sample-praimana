import { useEffect, useState } from "react";
import { ProfileBadge } from "./ProfileBadge";
import { BrandName } from "./BrandName";
import logo from "../assets/logo.png";

const api = (window as any).electronAPI;

/**
 * ── CONNECT THIS APP TO A PLATFORM ──
 *
 * The first screen on a fresh install. This app is ONE BINARY shipped to MANY CUSTOMERS, each
 * with their own portal and Cognito pool, so nothing about a customer is compiled in and
 * something has to tell it which platform this is.
 *
 * ⚠ THE USER TYPES NOTHING. They click "Open desktop app" on the portal's welcome page, which
 * delivers the platform's configuration — its URLs, Cognito pool and app client — via an
 * `praimana://` link. This screen CONFIRMS it. Sign-in is the NEXT screen, in the app's own form.
 *
 * Three earlier revisions are worth knowing about, because each was withdrawn for a reason that
 * still constrains this one: a typed portal URL (needed a public config endpoint on every
 * customer domain), a pasted encrypted Access Key (made a participant carry a credential-shaped
 * string), and a one-time code redeemed for a session (impossible — the portal cannot mint a
 * token for another client).
 *
 * ── ⚠ WHY THERE IS A CONFIRMATION AT ALL ──
 *
 * ANY web page can trigger a custom-scheme navigation. So a hostile page can send a link naming
 * the REAL portal alongside ITS OWN API origin — and this app would then send every request,
 * bearing the user's token, to that attacker. Config-only does not fix this: the API origin IS
 * the dangerous field.
 *
 * Showing the API origin and requiring a click is what closes it. **DO NOT ADD AN AUTO-CONNECT
 * PATH HERE**, however convenient: the confirmation is the security boundary, not a courtesy.
 */

const PRODUCT_NAME = "Praimana";
const BRAND_YEAR = "2026";

interface PendingLink {
  /**
   * ⚠ HANDED BACK ON CONFIRM, so the click commits the proposal that was on screen.
   *
   * Main holds one pending proposal and any web page can replace it. Without this the commit took
   * whatever occupied that slot at the instant of the click, so a page firing a second link between
   * render and click had its own platform persisted under the participant's confirmation of a
   * different one. Opaque and unguessable — it names a proposal, it cannot describe one.
   */
  linkId: string;
  portalUrl: string;
  apiBaseUrl: string;
  /**
   * ⚠ THE COGNITO POOL AND APP CLIENT, which are what the click actually authorises.
   *
   * These are handed to Amplify and become the target of THIS APP'S OWN sign-in form — the one
   * that collects the participant's email, password and TOTP. A panel that showed only the two
   * origins was asking for confirmation of the fields that do not decide that.
   */
  poolId: string;
  clientId: string;
  region: string;
  wouldSignOut: boolean;
  /** The platform configured today, or `null` on a fresh install. The basis for the diff below. */
  current: { poolId: string; apiBaseUrl: string; region: string } | null;
  /**
   * Whether this profile is ALREADY somebody's workspace — see the note on the block that renders it.
   * Distinct from `wouldSignOut`, which is about the PLATFORM and was false in the case that prompted
   * this: two workshops of one deployment share a fingerprint exactly.
   */
  profileInUse?: boolean;
  profileAccountCount?: number;
  profileTeamName?: string | null;
  /** The profile holds projects or chats — the signal a Disconnect cannot erase. */
  profileHasWork?: boolean;
  configured?: boolean;
}

export function PlatformSetupView({
  onComplete,
  profileLabel: profileLabelProp,
  onSwitchProfile,
}: {
  onComplete: () => void;
  /** Passed by App so the badge names this window without a second lookup. */
  profileLabel?: string | null;
  /** Opens the profile chooser. Absent only in tests and older callers. */
  onSwitchProfile?: () => void;
}) {
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  /** The profile this window is, so the panel can name what it is about to connect. */
  const [profileLabel, setProfileLabel] = useState<string | null>(profileLabelProp ?? null);

  /**
   * Look for a link on mount, and listen for one arriving later.
   *
   * TWO PATHS BECAUSE THE OS USES TWO: a COLD start (the link launched the app, so no window
   * existed to receive an event — main held it for whoever asked first) and a WARM one (the app
   * was already running). Missing either is the classic "the button works the second time" bug
   * — see main/deep-link.ts.
   */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await api.getPendingLink();
        if (cancelled) return;
        if (result?.pending) setPending(result);
        /**
         * The profile's own label, so the panel can NAME what it is about to connect. Derived from
         * `profileList`, which App.tsx already uses for the same purpose — no new channel for a string
         * the renderer can already ask for.
         */
        try {
          const list = await api.profileList?.();
          if (!cancelled && list) {
            const mine = list.profiles?.find((p: { id: string }) => p.id === list.current);
            setProfileLabel(mine?.label ?? null);
          }
        } catch {
          // The panel degrades to "this profile" without a name; the warning still stands.
        }
      } catch {
        // No link, or an older main process. The empty state below explains what to do.
      } finally {
        // Marks the FIRST check complete, so the empty state does not flash before the answer
        // arrives on a cold start.
        if (!cancelled) setChecked(true);
      }
    }

    void load();

    api.onDeepLink?.(() => {
      // The event carries the URLs, but re-reading through `getPendingLink` keeps ONE shape and
      // one source of truth for `wouldSignOut`, which only main can compute.
      setError("");
      void load();
    });

    return () => {
      cancelled = true;
      api.removeDeepLinkListeners?.();
    };
  }, []);

  /**
   * Whether committing would move the app to a DIFFERENT identity provider.
   *
   * ⚠ THE ONE COMPARISON A PARTICIPANT CAN ACTUALLY MAKE. A pool id shown on its own means
   * nothing to someone who has never seen theirs — `us-east-1_AbCdEfGhI` and `us-east-1_XyZwVuTsR`
   * are indistinguishable without a baseline, which is why "show the pool" is only half a fix. A
   * diff against the pool they are already signed in to needs no memory at all.
   */
  const idpChanges = pending?.current != null && pending.current.poolId !== pending.poolId;

  async function handleConnect() {
    if (connecting || !pending) return;
    setConnecting(true);
    setError("");
    try {
      /**
       * ⚠ THE ID OF THE PROPOSAL THIS COMPONENT RENDERED, read from the same `pending` object whose
       * origins and pool the participant just read. Main refuses if it is no longer the proposal it
       * holds — which is exactly the case where committing would persist something the participant
       * never saw.
       */
      const result = await api.connectPlatform(pending.linkId);
      if (!result?.ok) {
        setError(result?.error || "Could not connect to that platform.");
        return;
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect to that platform.");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-surface-bg overflow-y-auto">
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {/**
            * ⚠ WHICH PROFILE THIS WINDOW IS, ON THE GATE THAT DID NOT SAY. Same placement and reasoning
            * as SignInView: this is the screen a Disconnect lands on and the screen an incoming portal
            * link is confirmed on, so it is the last point at which "wrong profile" is cheap to fix.
            * Without it the chooser was reachable from the login form but not from the step BEFORE it.
            */}
          <ProfileBadge label={profileLabel ?? null} onSwitch={onSwitchProfile} />
          {/* Explicit width/height reserve the box — an unsized logo reflows the page the moment
              it decodes, under a pointer already moving toward the button. */}
          <div className="flex items-center justify-center gap-2.5 mb-8">
            <img src={logo} width={32} height={32} className="shrink-0 rounded-lg" alt="" />
            <span className="text-xl font-bold text-surface-text"><BrandName /></span>
          </div>

          <div className="bg-surface-panel rounded-xl border border-surface-line shadow-sm p-6">
            <h1 className="text-xl font-bold tracking-tight text-surface-text">
              Connect to your platform
            </h1>

            {!checked ? (
              // Blank rather than a spinner: this resolves in one IPC round-trip on the same
              // machine, and a spinner that appears and vanishes inside a frame is flicker.
              <div className="h-24" />
            ) : pending ? (
              <>
                <p className="mt-2 text-sm text-surface-muted leading-relaxed">
                  Connect this app to the platform below. You&apos;ll sign in on the next screen.
                </p>

                {/*
                  ── THE CONFIRMATION THAT MATTERS ──

                  The API origin is where this app will send the session token on every request,
                  and a hostile link's entire purpose is to name one of its own. It is rendered
                  prominently and in mono because it is meant to be READ, not skimmed.
                */}
                <div
                  // Announced as well as shown: a sighted user sees the panel, and a
                  // screen-reader user needs the same facts at the same moment.
                  role="status"
                  className="mt-4 rounded-md border border-surface-line bg-surface-bg px-3 py-3"
                >
                  <p className="text-[11px] text-surface-muted">Platform</p>
                  <p className="select-text break-all font-mono text-xs font-semibold text-surface-text">
                    {pending.portalUrl}
                  </p>
                  <p className="mt-2 text-[11px] text-surface-muted">Its API</p>
                  <p className="select-text break-all font-mono text-xs text-surface-text">
                    {pending.apiBaseUrl}
                  </p>
                  {/*
                    ⚠ THE FIELD THE PASSWORD GOES TO. Shown because the next screen's email,
                    password and one-time code are submitted to THIS pool, and a confirmation
                    that omitted it was asking for a signature on an unread line.
                  */}
                  <p className="mt-2 text-[11px] text-surface-muted">Where you&apos;ll sign in</p>
                  <p className="select-text break-all font-mono text-xs text-surface-text">
                    {pending.poolId}{" "}
                    <span className="text-surface-muted">({pending.region})</span>
                  </p>

                  {/*
                    ⚠ THE IdP CHANGE IS THE LOUDEST THING ON THIS SCREEN, because it is the most
                    consequential and the one a hostile link most wants unnoticed: the genuine
                    portal and the genuine API alongside an attacker's own AWS-hosted pool passes
                    every validation this app can perform, and nothing else on the panel differs.
                    Only ever rendered against a real baseline — never on a fresh install, where
                    there is nothing to compare and a warning would be noise.
                  */}
                  {idpChanges ? (
                    <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-2.5 py-2">
                      <p className="text-[11px] font-semibold text-red-400">
                        This changes which sign-in service you trust.
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-red-400/90">
                        Your email, password and one-time code would go to a different sign-in
                        service than the one you use now. You&apos;ll also be signed out.
                      </p>
                      <p className="mt-1.5 select-text break-all font-mono text-[11px] text-red-400/90">
                        now {pending.current!.poolId}
                        <br />
                        new {pending.poolId}
                      </p>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-red-400/90">
                        Only continue if you meant to move to a different platform.
                      </p>
                    </div>
                  ) : (
                    /*
                      ⚠ ONLY WHEN TRUE. Main decides this by comparing FINGERPRINTS — pool, client,
                      issuer and API origin — so connecting to the same platform shows no warning,
                      which is what keeps the warning meaningful on the day it appears.
                    */
                    pending.wouldSignOut && (
                      <p className="mt-2 text-[11px] font-medium text-amber-400">
                        This will sign you out of the platform you&apos;re currently using.
                      </p>
                    )
                  )}
                </div>

                {/**
                  * ── ⚠ THIS PROFILE IS ALREADY SOMEBODY'S WORKSPACE ──────────────────────────────
                  *
                  * ⚠ AND THE WARNING ABOVE COULD NOT HAVE CAUGHT IT. `wouldSignOut` and `idpChanges` are
                  * about the PLATFORM, and on the reporter's machine the two profiles involved carry the
                  * same pool, client, API origin and portal — two workshops of ONE deployment. The
                  * fingerprint matched, so the panel was right to show no platform warning. What it never
                  * said is WHICH PROFILE the link was about to be applied to, or that the profile already
                  * had an account and a team in it.
                  *
                  * ⚠ IT DOES NOT CLAIM TO KNOW THIS IS A DIFFERENT WORKSPACE, because it cannot: the link
                  * carries a code, the portal URL and the API URL — no workshop, no team, no profile. It
                  * states what IS known and offers the remedy that was out of reach — creating the profile
                  * that was missed last time.
                  */}
                {pending.profileInUse && (
                  <div className="mt-4 rounded-md border border-amber-500/40 bg-surface-raised p-3">
                    <p className="text-xs font-medium text-amber-400">
                      You are connecting {profileLabel ? `the "${profileLabel}" profile` : "this profile"}
                      , which is already in use.
                    </p>
                    <p className="mt-1 text-[11px] text-surface-muted leading-relaxed">
                      {pending.profileTeamName
                        ? `It is signed in to the "${pending.profileTeamName}" team.`
                        : pending.profileHasWork
                          ? // After a Disconnect there is no team or account left to name — the work is
                            // what is still here, and it is what would be mixed.
                            "It already holds projects and chats."
                          : "It already has a signed-in account."}{" "}
                      Profiles keep separate sign-ins, teams, chats and projects — so if this link is for a
                      DIFFERENT workspace, create a profile for it rather than connecting here. Mixing two
                      workspaces into one profile cannot be undone by disconnecting.
                    </p>

                    {/**
                      * ⚠ THE INLINE "CREATE A PROFILE" FIELD THAT WAS HERE IS GONE, and its removal is the
                      * fix rather than a tidy-up. It created a profile BEFORE the link was committed, which
                      * relaunched the process and dropped the pending link — a single-use 60-second
                      * credential held in memory — so the new profile came up unconnected and the
                      * participant had to go back to the portal. The profile choice now happens straight
                      * AFTER this screen commits (App.tsx), where `profileCreate` seeds the new profile with
                      * the platform just saved. Same choice, one step later, and nothing is lost.
                      */}
                    <p className="mt-2 text-[11px] text-surface-faint leading-relaxed">
                      You will be asked which profile to use once this is connected.
                    </p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting}
                  aria-busy={connecting || undefined}
                  className="mt-5 w-full rounded-md bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {/* Names the CONSEQUENCE when there is one, rather than a bare "Connect". */}
                  {connecting
                    ? "Connecting…"
                    : idpChanges
                      ? "Connect and trust this sign-in service"
                      : pending.wouldSignOut
                        ? "Connect and sign out of the other platform"
                        : "Connect"}
                </button>

                <p className="mt-3 text-xs text-surface-muted leading-relaxed">
                  Not the platform you expected? Don&apos;t connect — close this and use the
                  button on your own team&apos;s website.
                  {/*
                    Said only on a FRESH install, where the diff above cannot exist. It is the
                    honest limit of this screen: with no configured platform to compare against,
                    the pool id is a value the participant has to check against something outside
                    the app, and pretending otherwise would be worse than saying so.
                  */}
                  {pending.current == null &&
                    " If you were given a sign-in service to expect, check it matches above."}
                </p>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-surface-muted leading-relaxed">
                  Sign in to your team&apos;s <BrandName /> website, then click Open desktop app
                  on the welcome page to point this app at your platform.
                </p>
                <ol className="mt-4 space-y-1.5 text-xs text-surface-muted">
                  <li>1. Open your team&apos;s website in a browser and sign in.</li>
                  <li>
                    2. On the welcome page, click{" "}
                    <span className="font-medium text-surface-text">Open desktop app</span>.
                  </li>
                  <li>3. Come back here — this screen will show the platform to confirm.</li>
                  <li>4. Sign in with the same email and password.</li>
                </ol>
              </>
            )}

            {/* role=alert so the failure is ANNOUNCED, not only seen. This screen has no other
                next step, so a silent error is a dead end. */}
            {error && (
              <div
                role="alert"
                className="mt-4 rounded-md bg-red-500/10 border border-red-500/40 px-3 py-2.5 text-sm text-red-400"
              >
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-surface-line px-6 py-5 text-center text-xs text-surface-muted">
        <p>
          &copy; {BRAND_YEAR} {PRODUCT_NAME}
        </p>
      </footer>
    </div>
  );
}
