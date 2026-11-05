/**
 * INACTIVITY SIGN-OUT, the numbers and the arithmetic, with no DOM in sight.
 *
 * Split from the component (components/IdleTimeout.tsx) on purpose. Everything here
 * is pure and clock-free (the caller passes `now`), so the decisions that actually
 * matter, when we sign out, when we warn, how often we may write, are unit-testable
 * in the node environment this package's vitest runs in, and none of it can touch
 * `window` during a server render.
 *
 * TWO DIFFERENT THINGS END A SESSION IN THIS APP AND THEY MUST NOT BE CONFLATED:
 *
 *   TOKEN EXPIRY (components/providers.tsx → evictExpiredSession), the 30-minute ID
 *   token lapsed while the user was still there, or the backend stopped accepting the
 *   session. The user never asked to leave, so that path clears ONLY this app's cookie
 *   and deliberately leaves Amplify's refresh token alone, which lets /login mint a
 *   fresh app session with no password and no TOTP code. Near-silent renewal.
 *
 *   INACTIVITY (this module), nobody has touched the app for IDLE_TIMEOUT_MS. That IS
 *   a request to leave, made by walking away from an unlocked machine, so it performs
 *   the FULL teardown via lib/sign-out.ts (Amplify tokens + NextAuth cookie + the IdP
 *   session) and re-entry costs a password and a TOTP code.
 *
 * The distinction is the whole point: making expiry behave like idleness would force a
 * TOTP code on someone who read one long page for 31 minutes, and making idleness
 * behave like expiry would leave a walked-away-from browser one click from a full
 * session.
 */

/**
 * How long with no user interaction before a full sign-out.
 *
 * ⚠ TWO HOURS, AND IT NO LONGER MATCHES THE SESSION `maxAge`. The two were equal once, one number in three
 * places, and were separated deliberately: the session went to six hours and then to a DAY, while this one was
 * set at TWO HOURS.
 *
 * The two answer different questions. `maxAge` is how long a session may live WHILE IN USE, the number that
 * signed someone out mid-afternoon while they were working. This is how long it survives with NOBODY THERE,
 * and it is the only control that limits an unlocked, unattended machine.
 *
 * ⚠ SO THIS NUMBER IS THE SECURITY-RELEVANT ONE OF THE PAIR, and at two hours an unattended browser stays
 * signed in for two hours. That is four times the previous window and it is deliberate; it is
 * recorded here rather than argued, because it is a policy choice. What must NOT happen is it drifting
 * upward silently, this is the number to question first if the posture is ever reviewed.
 *
 * ⚠ THE INVARIANT IS NOW `IDLE_TIMEOUT_MS <= maxAge`, not equality: the shorter of the two decides, so an idle
 * window LONGER than the session would be a number that never gets to act. `idle-timeout.test.ts` reads
 * auth.ts and asserts exactly that, rather than the equality it used to.
 *
 * Exported so there is exactly ONE idle timeout in the app rather than a literal per call site.
 */
export const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * How long before the deadline the warning banner appears.
 *
 * 60 seconds: long enough to notice and reach for the keyboard, short enough that the
 * banner is not sitting on the screen as furniture. It is subtracted from the timeout
 * rather than added to it, the sign-out still happens at IDLE_TIMEOUT_MS, so the
 * warning does not quietly extend the window.
 */
export const IDLE_WARNING_MS = 60 * 1000;

/**
 * The floor on how often an activity signal is allowed to be RECORDED.
 *
 * `scroll` fires tens of times per second and `keydown` once per character, and the
 * handler is on the document for the whole session, so it is a hot path by volume even
 * though nothing about it is expensive. The throttle collapses a burst to at most one
 * `Date.now()` + one number write + one localStorage write per 15s, and never a React
 * state update (see the component: the timestamp lives in a ref, not in state, so
 * typing cannot re-render the tree).
 *
 * The cost of the throttle is precision: activity is recorded up to
 * IDLE_ACTIVITY_THROTTLE_MS late, so the effective timeout is 30min + ≤15s. Erring
 * long by 15 seconds on a 30-minute window is not a security difference; re-rendering
 * the app on every keystroke would be a real one.
 */
export const IDLE_ACTIVITY_THROTTLE_MS = 15 * 1000;

/**
 * How long to wait for one full sign-out attempt before giving up on it.
 *
 * signOutEverywhere() awaits two network round-trips (Cognito's global revoke, then
 * NextAuth's own sign-out), and an await with no bound is how the whole feature fails
 * open: a hung request would leave the user parked on a fully populated screen with a
 * live session, which is exactly the defect this feature exists to close. 10 seconds is
 * generous for two calls on a bad connection and short enough that the fallback
 * navigation still feels like a sign-out rather than a hang.
 *
 * Timing out does NOT mean the sign-out failed silently, the caller falls back to
 * navigating away, and Amplify's revoke may well have landed. See fullSignOut.
 */
export const IDLE_SIGN_OUT_TIMEOUT_MS = 10 * 1000;

/**
 * How many times to attempt the full sign-out before falling back to a bare navigation.
 *
 * Two: enough to ride out one transient failure, few enough that a user who has already
 * been told "signing you out" is not watching a spinner for a minute. Bounded
 * deliberately, an unbounded retry here would be an unbounded loop on the one path
 * where the user has walked away and nobody is watching.
 */
export const IDLE_SIGN_OUT_MAX_ATTEMPTS = 2;

/**
 * Never re-arm the timer for less than this.
 *
 * Only reachable when the remaining time rounds to a sub-millisecond value; without a
 * floor that would be a `setTimeout(0)` loop spinning until the deadline passes. 250ms
 * is imperceptible against a 60-second warning.
 */
export const IDLE_MIN_REARM_MS = 250;

/**
 * How far in the FUTURE a stored activity timestamp may sit before we refuse it.
 *
 * localStorage is shared with anything running on this origin and is trivially
 * editable by the user, so a stored timestamp is untrusted input: `Date.now() + 1e12`
 * would postpone the sign-out for thirty years. A minute of tolerance covers a clock
 * that ticked between the write and the read (and the small skew between two tabs);
 * anything beyond it is discarded rather than clamped, so the reader falls back to its
 * own in-memory value and the timeout still fires. Deny by default.
 */
export const IDLE_CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * The activity signals we listen to, a small, deliberate set.
 *
 *   pointerdown, one event per click/tap, and it covers mouse, pen and touch in
 *                      one listener. NOT `mousemove`/`pointermove`: a cat on a desk
 *                      moves a mouse, and polling the pointer position is how an idle
 *                      timer ends up never firing.
 *   keydown, typing, and the only signal a keyboard-only user generates.
 *   scroll, reading a long page IS using the app. Registered with
 *                      `capture: true` because scroll does not bubble, so a scrolling
 *                      inner container would otherwise never reach the document.
 *   visibilitychange, coming back to the tab. Counts as activity ONLY after the
 *                      deadline has been re-checked (see the component): a tab that was
 *                      hidden for two hours must sign out on return, not treat the
 *                      return as proof the user was there all along.
 *
 * `focus` is deliberately absent, it is redundant with pointerdown/keydown and fires
 * on programmatic focus moves, which is not a user.
 */
export const IDLE_ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "scroll",
  "visibilitychange",
] as const;

/**
 * Where tabs of this app share their last-activity instant.
 *
 * WHY SHARED AT ALL: two tabs are one user. Without this, a tab left in the background
 * while the user works in another would hit its own deadline and sign the whole browser
 * out mid-sentence. Each tab writes its own (throttled) activity here and every tab
 * measures idleness against the LATEST of its own value and this one, so "active
 * somewhere" means "active everywhere".
 *
 * One key holding one `<owner>|<epochMs>` pair, bounded by construction, nothing accumulates.
 *
 * ⚠ THE OWNER IS THERE BECAUSE THE VALUE NOW ENFORCES THE DEADLINE, NOT JUST POSTPONES IT.
 * It used to hold a bare integer and carry no identity, which was fine while the only thing it could
 * do was EXTEND a window (see `latestActivityAt`). Now that a stored value older than the idle window
 * signs the user out on mount, an unowned timestamp is a hazard in two directions:
 *
 *   · A value left behind by a PREVIOUS session would sign the user out immediately after they
 *     signed in, and since /login mounts no timer, they would land back on the app and be signed
 *     out again. A loop, produced by the fix rather than the bug.
 *   · On a shared machine, user B would inherit user A's idleness and be signed out for someone
 *     else's absence.
 *
 * The owner is the session's user id, already in the browser via `useSession()`, and no more
 * identifying than the session cookie sitting beside it. A value whose owner does not match is
 * treated as absent, which degrades to exactly the old behaviour (seed the window now) rather than
 * to a sign-out.
 *
 * Read only when a decision is being made (timer fire, tab becomes visible), never on an activity
 * event, so a scroll burst does no I/O at all.
 */
export const IDLE_ACTIVITY_STORAGE_KEY = "aiap.idle.lastActivityAt";

/** The separator between owner and instant. Absent from a Cognito `sub`, which is a UUID. */
const SHARED_ACTIVITY_SEPARATOR = "|";

/** Serialise this tab's activity for its siblings. */
export function serialiseSharedActivity(owner: string, at: number): string {
  return `${owner}${SHARED_ACTIVITY_SEPARATOR}${at}`;
}

/**
 * The shared instant, but only if it belongs to `owner`.
 *
 * Returns null, "no shared activity", for a missing value, a foreign owner, an unparseable
 * instant, or the bare-integer format written by a previous release. Null leaves the tab measuring
 * from now, which is the SAFE direction: it can only delay a sign-out, never cause a spurious one,
 * and the alternative during a deploy would be signing out every user with an old value in storage.
 */
export function parseSharedActivity(
  raw: string | null | undefined,
  owner: string,
  now: number,
  skewToleranceMs: number = IDLE_CLOCK_SKEW_TOLERANCE_MS
): number | null {
  if (!raw || !owner) return null;

  const separator = raw.lastIndexOf(SHARED_ACTIVITY_SEPARATOR);
  if (separator <= 0) return null;

  if (raw.slice(0, separator) !== owner) return null;
  return parseLastActivityAt(raw.slice(separator + 1), now, skewToleranceMs);
}

/**
 * Read the shared last-activity instant for `owner`, or null.
 *
 * ⚠ THE STORAGE ACCESS LIVES HERE, IN ONE PLACE, because there are now two readers: the idle timer
 * (which seeds its window from it) and `/login`'s resume effect (which refuses to resume past it).
 * `IdleTimeout.tsx` had its own inline `try`/`catch` wrapper, and a second copy in `AuthFlow.tsx`
 * would be exactly the "two copies of one rule" this codebase keeps getting bitten by.
 *
 * localStorage THROWS rather than returning null in Safari private mode and when a quota or policy
 * blocks it, so the failure is absorbed and reported as "no shared activity", which leaves every
 * caller measuring from now. That is the conservative direction: it can delay a sign-out, never cause
 * a spurious one.
 */
export function readSharedActivity(owner: string, now: number): number | null {
  if (typeof window === "undefined") return null;
  try {
    return parseSharedActivity(window.localStorage.getItem(IDLE_ACTIVITY_STORAGE_KEY), owner, now);
  } catch {
    return null;
  }
}

/** Publish this tab's activity to its siblings. Same swallow, same reasoning. */
export function writeSharedActivity(owner: string, now: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IDLE_ACTIVITY_STORAGE_KEY, serialiseSharedActivity(owner, now));
  } catch {
    // Storage unavailable: sibling tabs each keep their own window. The timeout still works
    // per-tab, which is why this is not worth failing over.
  }
}

/**
 * What a mounting timer should measure from, and whether that value has to be WRITTEN.
 *
 * ── ⚠ THE SEED USED TO BE IN-MEMORY ONLY, AND THAT LEFT A HOLE THE SIZE OF THE WHOLE FEATURE ──
 *
 * Seeding from storage (`IdleTimeout.tsx`) made a stale stored instant enforceable across a closed
 * tab, but ONLY when there was something stored. Nothing ever wrote the seed itself, and
 * `writeSharedActivity` is reached exclusively from the THROTTLED activity handler, which discards
 * any signal less than `IDLE_ACTIVITY_THROTTLE_MS` after the last RECORDED instant. Immediately
 * after a page load that recorded instant IS the seed, so:
 *
 *   sign in → click something within 15s → navigate (a full page load, so a fresh seed) → close
 *   the browser
 *
 * wrote NOTHING. Reopening the portal the next morning read null, seeded `now`, started a fresh
 * two-hour window and never saw the overnight absence, while the sliding 24-hour session cookie
 * was still perfectly valid. Straight back into the app, no password and no TOTP: the same outcome
 * the security review flagged, reached by a different route. As observed: signed in
 * around midnight, still signed in the next day.
 *
 * ⚠ IT IS A WRITE-ONCE, NOT A REFRESH, AND THE DIFFERENCE IS THE ENTIRE CONTROL. Persisting `now`
 * on EVERY mount would push the deadline forward on every page load, so anyone who navigates more
 * often than the window is long would never idle out, enforcement deleted, in the guise of
 * fixing it. So a trustworthy stored instant is returned UNTOUCHED (`persist: false`), including
 * one already outside the window: the caller's `check()` reads it and signs out.
 *
 * The 15-second throttle imprecision survives and is still the documented tradeoff, the stored
 * instant can lag the truth by up to `IDLE_ACTIVITY_THROTTLE_MS`, which errs long on a two-hour
 * window and self-corrects on the first signal 15s clear of it.
 *
 * Pure and clock-free: the caller reads storage and supplies `now`, so the decision is testable in
 * this package's node environment (there is no jsdom here, which is why it cannot live in the
 * component).
 */
export interface ActivitySeed {
  /** The instant the timer should measure idleness from. */
  lastActivityAt: number;
  /** True when `lastActivityAt` is not yet in storage and must be written to survive the tab. */
  persist: boolean;
}

export function seedActivity(stored: number | null, now: number): ActivitySeed {
  // Nothing trustworthy to read, first sign-in, cleared storage, Safari private mode, a foreign
  // or malformed owner. Measure from now AND record it, so this session's start outlives the tab.
  if (stored === null) return { lastActivityAt: now, persist: true };
  // A real stored instant is authoritative in BOTH directions. Never overwritten: see above.
  return { lastActivityAt: stored, persist: false };
}

/** Forget the shared instant. Called on a deliberate sign-out. */
export function clearSharedActivity(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(IDLE_ACTIVITY_STORAGE_KEY);
  } catch {
    // Nothing was stored either, so nothing is left behind.
  }
}

/** What to do right now, and when to look again. */
export type IdleStage =
  /** Plenty of time left, nothing on screen. */
  | "ACTIVE"
  /** Inside the warning window, show the banner. */
  | "WARN"
  /** The deadline has passed, sign out fully. */
  | "IDLE";

export interface IdleCheck {
  stage: IdleStage;
  /** How long until the next check. Always ≥ IDLE_MIN_REARM_MS unless stage is IDLE. */
  delayMs: number;
}

/**
 * Milliseconds of inactivity left before the sign-out is due, floored at 0.
 *
 * FAILS CLOSED on a value that is not a real instant (NaN, Infinity, a corrupted ref):
 * "I cannot tell how long they have been away" resolves to "sign out", because the
 * opposite default is a session that never times out and nobody notices.
 *
 * A clock that moved BACKWARDS (NTP correction, a laptop resuming, a hand-edited
 * system clock) yields a negative elapsed time. That is treated as a full fresh
 * window rather than as ≥30 minutes of idleness, so a clock correction cannot eject a
 * user who is sitting right there. It cannot be used to stall the timeout either -
 * the next tick re-measures from the corrected clock.
 */
export function msUntilIdle(
  lastActivityAt: number,
  now: number,
  timeoutMs: number = IDLE_TIMEOUT_MS
): number {
  const elapsed = now - lastActivityAt;
  if (!Number.isFinite(elapsed)) return 0;
  if (elapsed < 0) return timeoutMs;
  return Math.max(timeoutMs - elapsed, 0);
}

/**
 * The single decision point: given when the user was last seen, what should the UI show
 * and when should we ask again.
 *
 * Expressed as "check again in N ms" rather than as two independent timers, so there is
 * ONE `setTimeout` outstanding for the whole session and every wake-up re-measures
 * against the clock. That is what makes the timer immune to the things that break
 * naive idle timers: a background tab whose timeouts were throttled or frozen wakes up
 * late and immediately computes IDLE, and another tab's activity arriving through
 * localStorage simply moves the answer on the next check.
 */
export function idleCheck(lastActivityAt: number, now: number): IdleCheck {
  const remaining = msUntilIdle(lastActivityAt, now);

  if (remaining <= 0) return { stage: "IDLE", delayMs: 0 };

  if (remaining <= IDLE_WARNING_MS) {
    return { stage: "WARN", delayMs: Math.max(remaining, IDLE_MIN_REARM_MS) };
  }

  return {
    stage: "ACTIVE",
    delayMs: Math.max(remaining - IDLE_WARNING_MS, IDLE_MIN_REARM_MS),
  };
}

/**
 * True if this activity signal is far enough from the last recorded one to be worth
 * recording. The throttle itself, see IDLE_ACTIVITY_THROTTLE_MS for the tradeoff.
 *
 * A `now` that is not a finite number records nothing: writing junk into the timestamp
 * would make msUntilIdle fail closed and sign out an active user.
 */
export function shouldRecordActivity(
  lastRecordedAt: number,
  now: number,
  throttleMs: number = IDLE_ACTIVITY_THROTTLE_MS
): boolean {
  if (!Number.isFinite(now)) return false;
  // A backwards clock is recorded immediately: `now - lastRecordedAt` is negative, which
  // is not "too soon", and refusing would leave the stored instant in the future.
  return now - lastRecordedAt >= throttleMs || now < lastRecordedAt;
}

/**
 * A stored activity instant, validated, or `null` if it cannot be trusted.
 *
 * This is the trust boundary for IDLE_ACTIVITY_STORAGE_KEY. The value is
 * user-writable, and the ONLY thing it can do is postpone a sign-out, so every
 * unparseable, negative, zero or implausibly-future value is rejected outright rather
 * than coerced into something usable. `null` means "no shared activity", which leaves
 * the tab measuring against its own in-memory timestamp, the safe direction.
 */
export function parseLastActivityAt(
  raw: string | null | undefined,
  now: number,
  skewToleranceMs: number = IDLE_CLOCK_SKEW_TOLERANCE_MS
): number | null {
  if (!raw) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed > now + skewToleranceMs) return null;

  return parsed;
}

/**
 * The most recent of this tab's own activity and whatever another tab shared.
 *
 * MAX, not "prefer the stored one": a tab that has just been clicked knows something
 * localStorage does not yet (the write is throttled), and a stored value from an active
 * sibling tab knows something this one does not. Either can be the newer.
 */
export function latestActivityAt(local: number, shared: number | null): number {
  if (shared === null) return local;
  return Math.max(local, shared);
}

/**
 * The idle window as a person would say it: "30 minutes", "2 hours", "1 hour 30 minutes".
 *
 * ⚠ THIS EXISTS BECAUSE THE WINDOW STOPPED BEING A ROUND NUMBER OF MINUTES. The warning banner spelled the
 * value from this constant so the copy could not drift from the behaviour, good, but as
 * `Math.round(ms / 60_000)` it read "After 120 minutes without activity" the moment the window became two
 * hours. Correct, and not how anyone says it.
 *
 * Pure and exported so the phrasing is tested rather than eyeballed in a browser after a two-hour wait.
 */
export function describeIdleWindow(ms: number = IDLE_TIMEOUT_MS): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

  if (hours === 0) return plural(minutes, "minute");
  if (minutes === 0) return plural(hours, "hour");
  return `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}
