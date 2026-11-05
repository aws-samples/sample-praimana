"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { signOutEverywhere } from "@/lib/sign-out";
import { POST_LOGOUT_PATH } from "@/lib/cognito-logout";
import {
  IDLE_SIGN_OUT_MAX_ATTEMPTS,
  IDLE_SIGN_OUT_TIMEOUT_MS,
  /* `IDLE_TIMEOUT_MS` is no longer imported: the only place this component used it was the banner's copy,
     which now goes through `describeIdleWindow` so it reads "2 hours" rather than "120 minutes". The
     scheduling arithmetic reads the constant inside the pure module, not here. */
  describeIdleWindow,
  idleCheck,
  latestActivityAt,
  readSharedActivity,
  seedActivity,
  shouldRecordActivity,
  writeSharedActivity,
  type IdleStage,
} from "@/lib/idle-timeout";

/**
 * THE inactivity timer. Mounted once, inside Providers, for the whole app.
 *
 * WHAT IT IS FOR. Leaving the portal alone used to not end
 * the Cognito session. It did not end anything, because there was no idle timer at all:
 * the only thing that happened after 30 minutes was the ID token expiring, and that
 * path is deliberately a LOCAL sign-out (see providers.tsx) whose whole purpose is to
 * let /login resume silently. So an unattended browser stayed one click from a live
 * session.
 *
 * THE TWO PATHS ARE STILL SEPARATE, AND THAT IS THE DESIGN:
 *
 *   TOKEN EXPIRED, USER PRESENT → providers.tsx's evictExpiredSession(). NextAuth
 *   cookie only; Amplify's refresh token survives; /login mints a fresh session with no
 *   password and no TOTP. Unchanged by this component.
 *
 *   USER ABSENT → this component. signOutEverywhere(), Amplify tokens, NextAuth
 *   cookie, and the IdP session, so getting back in costs a password AND a TOTP code.
 *
 * Whichever happens first wins, and they cannot fight: the expiry path is triggered by
 * a failed request (so the user was there), and this one is triggered by the absence of
 * interaction. Conflating them would mean a user who spent 31 minutes reading one page
 * has to redo TOTP, which is precisely what the comment in providers.tsx argues
 * against.
 *
 * SSR SAFETY. Renders nothing at all until an effect has run: `stage` starts "ACTIVE",
 * and every clock read, listener and storage access lives inside useEffect. Same class
 * of hazard as SiteFooter's BRAND_YEAR and admin/page.tsx's useClientNow, a
 * `Date.now()` in render would differ between the prerender and hydration and take the
 * banner's visibility with it.
 *
 * ONLY RUNS FOR A SIGNED-IN USER. Keyed on the session status, so /login, /join/<token>
 * and the error pages never arm a timer that would sign out an anonymous visitor, and
 * so the listeners are attached exactly while there is a session to protect.
 */
export function IdleTimeout() {
  const { status, data: session } = useSession();

  /**
   * Who the stored last-activity instant belongs to.
   *
   * Read here rather than inside the effect so the effect re-runs if the identity changes, a
   * sign-out followed by a different user signing in must not inherit the first user's idleness.
   * See `IDLE_ACTIVITY_STORAGE_KEY`.
   */
  const owner = session?.user?.id ?? "";

  // The only rendered state, and it changes at most twice per idle window (ACTIVE →
  // WARN → IDLE), never on an activity event. Activity lives in the effect's local
  // `lastActivityAt`, deliberately NOT in state: a keystroke must not re-render the app.
  const [stage, setStage] = useState<IdleStage>("ACTIVE");

  /**
   * "Stay signed in", published by the effect that owns the timer.
   *
   * A ref rather than a state callback because the button must reach into the LIVE
   * timer, and the timer's state is effect-local by design. Reset to a no-op on
   * cleanup, so a click that lands after unmount does nothing instead of resurrecting
   * a dead closure.
   */
  const staySignedInRef = useRef<() => void>(() => {});

  useEffect(() => {
    // No session, or still loading: no timer, and make sure no stale banner survives a
    // sign-out that happened while the warning was up.
    //
    // `owner` is required too: without an identity there is no way to tell whether a stored
    // timestamp is this user's, and the seeding below now depends on that answer. An authenticated
    // session always has one (`cognito-verify.ts` requires `sub`), so this is a type guard rather
    // than a reachable state.
    if (status !== "authenticated" || !owner) {
      setStage("ACTIVE");
      return;
    }

    // ── Effect-local state. Single writer: every mutation below happens on the main
    // thread from a listener or a timer callback, so no synchronisation is needed and
    // no partially-updated value is ever observable. ────────────────────────────────
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set to false by cleanup so a timer callback that was already queued when the
    // component unmounted cannot sign anyone out.
    let armed = true;
    // Guards the teardown against a double fire (timer + visibilitychange racing on the
    // same tick). signOutEverywhere revokes a refresh token; doing it twice is a
    // pointless network call and a confusing log line.
    let signingOut = false;
    /**
     * The instant we last saw the user, in epoch ms. Seeded HERE rather than in render, because a
     * `Date.now()` above would be a hydration mismatch.
     *
     * ── ⚠ SEEDED FROM STORAGE FIRST, AND THAT IS THE FIX ──────────────────────────────────────
     *
     * This read `let lastActivityAt = Date.now()`, "mounting means the user just arrived", and the
     * only other writer was `latestActivityAt(lastActivityAt, shared)`, which is `Math.max`. So the
     * stored value could only ever POSTPONE the deadline: a timestamp hours in the past was
     * discarded by the max, and the elapsed absence was unrecoverable. Closing the tab therefore
     * removed the ONLY enforcement point, and the persistent 24-hour session cookie meant reopening
     * the portal any time that day landed straight in the application with no password and no TOTP -
     * while `auth.ts` claimed "idleness signs out first and does the full teardown". Found in a
     * security review.
     *
     * Seeding from the stored value makes it a FLOOR as well as a ceiling. `check()` runs immediately
     * below and signs out when the seeded instant is already outside the window, so no separate
     * expiry path is needed, the existing decision point does it.
     *
     * `?? Date.now()` keeps the old behaviour whenever there is nothing trustworthy to read (first
     * sign-in, cleared storage, Safari private mode, a foreign or stale owner). That direction is the
     * safe one: it can delay a sign-out, never cause a spurious one.
     *
     * ── ⚠ AND THE SEED IS NOW PERSISTED WHEN STORAGE HAD NOTHING, WHICH IS THE SECOND HALF ──────
     *
     * Seeding from storage only enforces an absence that storage RECORDED, and nothing wrote the
     * seed: the only writer is the throttled activity handler, which drops any signal within
     * `IDLE_ACTIVITY_THROTTLE_MS` of the last recorded instant, and right after a page load that
     * instant is this seed. So "sign in, click something, navigate, close the browser" wrote
     * nothing at all, and reopening hours later seeded `now` and started a clean window. See
     * `seedActivity`, which owns the rule and the reasoning.
     *
     * ⚠ WRITE-ONCE. A trustworthy stored instant is never overwritten here, doing so would move
     * the deadline on every page load and delete the timeout for anyone who navigates.
     */
    const seed = seedActivity(readSharedActivity(owner, Date.now()), Date.now());
    let lastActivityAt = seed.lastActivityAt;
    if (seed.persist) writeSharedActivity(owner, lastActivityAt);
    // Mirrors `stage` inside the effect so the listeners can branch on it without a
    // stale-closure read of React state.
    let currentStage: IdleStage = "ACTIVE";

    /*
     * The shared last-activity instant is read and written through `lib/idle-timeout.ts` rather than
     * through a local wrapper: `/login`'s resume effect reads the same value for the same decision,
     * and the storage access needs the same failure handling in both places. See `readSharedActivity`
     * there for why a throwing localStorage resolves to "no shared activity".
     */
    function applyStage(next: IdleStage): void {
      if (next === currentStage) return;
      currentStage = next;
      setStage(next);
    }

    /**
     * The FULL teardown, Amplify tokens, NextAuth cookie, IdP session, reusing
     * lib/sign-out.ts rather than repeating its three steps and its ordering rule.
     *
     * Awaited (never fire-and-forget) with a TIMEOUT on each attempt and a bounded retry
     * count. The timeout is the part that matters: signOutEverywhere() awaits two network
     * round-trips, and an unbounded await here would fail OPEN, a hung request would
     * leave the user parked on a populated screen holding a live session, which is the
     * defect this whole feature closes. signOutEverywhere already swallows an Amplify
     * failure, so a rejection means NextAuth's own sign-out failed and this app's cookie
     * may still be alive.
     *
     * When every attempt is exhausted we navigate to /login anyway. That is not a
     * pretence of success, the cookie may genuinely outlive it, down to its 30-minute
     * maxAge, but it removes the populated screen, and the log line is there so the
     * residual exposure is something an operator can actually see.
     */
    async function fullSignOut(): Promise<void> {
      if (signingOut) return;
      signingOut = true;
      applyStage("IDLE");

      for (
        let attempt = 1;
        attempt <= IDLE_SIGN_OUT_MAX_ATTEMPTS;
        attempt++
      ) {
        // The loser of this race is abandoned, not cancelled: signOutEverywhere has no
        // AbortSignal to hand a fetch it does not own. Abandoning is safe here because
        // the operation is IDEMPOTENT, revoking an already-revoked refresh token and
        // clearing an already-cleared cookie are both no-ops, so a late-landing first
        // attempt cannot undo a successful second one.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            signOutEverywhere(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("sign-out timed out")),
                IDLE_SIGN_OUT_TIMEOUT_MS
              );
            }),
          ]);
          return;
        } catch (err) {
          if (attempt === IDLE_SIGN_OUT_MAX_ATTEMPTS) {
            // Not a hot path (once per idle sign-out, and only on failure), so an
            // unsampled log is fine. No token, no email, no payload, just the reason.
            console.error(
              `[idle] inactivity sign-out failed after ${IDLE_SIGN_OUT_MAX_ATTEMPTS} attempts; the local session may outlive its cookie maxAge`,  // nosemgrep: unsafe-formatstring
              err
            );
            // Guarded on `armed`: an unmounted component must not yank the browser to
            // /login underneath whatever replaced it.
            if (armed) window.location.assign(POST_LOGOUT_PATH);
          }
        } finally {
          // Always cleared, including on the success path, otherwise a pending 10s
          // timer keeps this closure alive and rejects into nothing.
          clearTimeout(timer);
        }
      }
    }

    /**
     * The one decision point. Re-measures against the clock every time rather than
     * trusting that the previous timeout fired when it was asked to, a background tab's
     * timers are throttled and a suspended laptop's are frozen, so a wake-up that is ten
     * minutes late must resolve to IDLE, not to "still 30 minutes to go".
     *
     * Exactly ONE timeout is outstanding at any moment; every path that changes the
     * deadline goes through here.
     */
    function check(): void {
      if (!armed || signingOut) return;

      const now = Date.now();
      // Another tab's activity counts as this user's activity, so a background tab can
      // never sign out a user who is working in the foreground one.
      const shared = readSharedActivity(owner, now);
      lastActivityAt = latestActivityAt(lastActivityAt, shared);

      const { stage: next, delayMs } = idleCheck(lastActivityAt, now);

      if (next === "IDLE") {
        void fullSignOut();
        return;
      }

      applyStage(next);
      clearTimeout(timer);
      timer = setTimeout(check, delayMs);
    }

    /**
     * Record a user interaction. THROTTLED, see IDLE_ACTIVITY_THROTTLE_MS: `scroll`
     * fires tens of times a second and `keydown` once per character, and this listener
     * is attached for the entire session.
     *
     * The cheap path does one clock read, one comparison and nothing else. It
     * deliberately does NOT reschedule the timer: the pending check will wake up, find
     * the deadline has moved, and re-arm itself. The only case that cannot wait is a
     * banner on screen, which must disappear the moment the user touches something.
     */
    function recordActivity(force = false): void {
      if (!armed || signingOut) return;

      const now = Date.now();
      if (!force && !shouldRecordActivity(lastActivityAt, now)) return;

      lastActivityAt = now;
      writeSharedActivity(owner, now);

      if (currentStage !== "ACTIVE") check();
    }

    function onActivity(): void {
      recordActivity();
    }

    /**
     * Returning to the tab counts as activity, but only AFTER the deadline is
     * re-checked. A tab hidden for two hours must sign out on return; treating the
     * return itself as proof of presence would make "leave the tab in the background"
     * an unlimited session extension.
     *
     * Going hidden is not activity and deliberately does nothing: the timer keeps
     * running against the last real interaction.
     */
    function onVisibilityChange(): void {
      if (document.visibilityState !== "visible") return;
      check();
      // check() returns having started the sign-out when the deadline has passed;
      // signingOut short-circuits recordActivity, so a late return can never rescue an
      // expired window.
      recordActivity(true);
    }

    staySignedInRef.current = () => recordActivity(true);

    // scroll uses capture because it does NOT bubble, a scrolling inner container
    // would otherwise never reach the document. passive on all of them: we only
    // observe, never preventDefault, so the browser can keep scrolling off the main
    // thread.
    document.addEventListener("pointerdown", onActivity, { passive: true });
    document.addEventListener("keydown", onActivity, { passive: true });
    document.addEventListener("scroll", onActivity, {
      passive: true,
      capture: true,
    });
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Arm it. The first wake-up is IDLE_TIMEOUT_MS - IDLE_WARNING_MS away.
    check();

    return () => {
      // EVERY registration undone on EVERY path: the listeners, the pending timeout and
      // the published callback. Without the removals this leaks three document
      // listeners holding this closure per mount, and StrictMode mounts twice.
      armed = false;
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onActivity);
      document.removeEventListener("keydown", onActivity);
      document.removeEventListener("scroll", onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisibilityChange);
      staySignedInRef.current = () => {};
    };
    // `owner` in the deps: a change of identity must rebuild the timer against the new user's stored
    // activity rather than keep measuring with the previous one.
  }, [status, owner]);

  if (stage === "ACTIVE") return null;

  /**
   * WHY THERE IS A WARNING AT ALL. The portal has real forms an operator can be
   * part-way through, an invite list of twenty addresses, an experience's settings -
   * and a full sign-out discards them AND costs a TOTP code to undo. A silent
   * disappearance would read as the app having crashed and lost the work. One minute
   * (IDLE_WARNING_MS) and one button is the smallest thing that turns that into a
   * choice.
   *
   * It does NOT extend the window: the sign-out still happens at IDLE_TIMEOUT_MS unless
   * the user actually interacts, and if they do, any interaction at all dismisses this,
   * not just the button.
   *
   * role="alert" + aria-live="assertive" because a warning nobody is looking at is not a
   * warning; a screen-reader user gets it announced rather than discovering it by
   * tabbing past.
   */
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-4 left-1/2 z-[100] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-warn-border bg-warn-bg px-4 py-3 shadow-lg"
    >
      {stage === "IDLE" ? (
        <p className="text-sm font-medium text-warn-text">
          Signing you out for inactivity…
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-warn-text">
              You&apos;ll be signed out shortly
            </p>
            <p className="text-xs text-warn-text">
              {/* Still spelled from the constant so the copy cannot drift from the behaviour, but through
                  `describeIdleWindow`, because the raw arithmetic read "After 120 minutes without activity"
                  once the window became two hours. */}
              After {describeIdleWindow()} without activity you&apos;ll need your password and
              authentication code again.
            </p>
          </div>
          <button
            type="button"
            onClick={() => staySignedInRef.current()}
            className="shrink-0 rounded-md bg-warn-text px-3 py-1.5 text-xs font-medium text-brand-ink hover:bg-warn-text transition-colors"
          >
            {/* Restating the grace period would go stale; the button says what it
                does. */}
            Stay signed in
          </button>
        </div>
      )}
    </div>
  );
}
