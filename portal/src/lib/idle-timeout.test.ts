import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  IDLE_ACTIVITY_EVENTS,
  IDLE_ACTIVITY_STORAGE_KEY,
  IDLE_ACTIVITY_THROTTLE_MS,
  IDLE_CLOCK_SKEW_TOLERANCE_MS,
  IDLE_MIN_REARM_MS,
  IDLE_SIGN_OUT_MAX_ATTEMPTS,
  IDLE_SIGN_OUT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_MS,
  idleCheck,
  latestActivityAt,
  msUntilIdle,
  parseLastActivityAt,
  shouldRecordActivity,  describeIdleWindow,
} from "./idle-timeout";
import { siblingRepoPath } from "./sibling-repo-source";

/**
 * The inactivity sign-out's arithmetic and its numbers.
 *
 * Everything asserted here is what a manual test cannot check: nobody sits in front of a
 * browser for 30 minutes to find out whether the deadline moved, and the interesting
 * cases (a clock that jumped, a tab that was frozen, a hand-edited localStorage value)
 * are not reachable by clicking at all.
 */

describe("IDLE_TIMEOUT_MS", () => {
  /**
   * ⚠ THE VALUE IS PINNED ON PURPOSE, and the number has now changed twice on request, 30 minutes, then two
   * hours ("can we set portal session 1day and portal idle timeout to 2 hours"). Pinning it means a change is
   * always a deliberate edit to this line rather than a drift nobody notices, which matters because this is
   * the only control limiting an unlocked, unattended machine.
   */
  it("is 2 hours", () => {
    expect(IDLE_TIMEOUT_MS).toBe(7_200_000);
  });

  /**
   * The constraint that makes the two timeouts one decision instead of two.
   *
   * If the idle window were LONGER than the session maxAge, the session would expire
   * first and the idle sign-out would never run, the full teardown would be dead code
   * and Cognito's tokens would survive, the very failure this timer exists for. If it were
   * SHORTER, the idle path would always pre-empt the silent-renewal path that
   * providers.tsx deliberately keeps.
   *
   * Read out of auth.ts rather than restated, because a restated number is a number that
   * drifts. Matching on the arithmetic the file actually contains: it is a server-only
   * module (it imports next-auth and constructs the handlers at import time), so importing
   * it into this node test suite is not an option.
   *
   * ⚠ THE ASSERTION IS NOW `idle <= maxAge`, NOT EQUALITY. They were equal until the session was raised to
   * six hours on request; the idle window stayed at 30 minutes because the two control different things -
   * how long a session lives while IN USE, versus how long it survives with nobody there. Equality would now
   * fail on correct code, and inverting the check (idle LONGER than the session) is the case that actually
   * matters: the shorter of the two decides, so an idle window beyond the session never gets to act and the
   * walked-away-from browser would be signed out by expiry instead, silently losing the full teardown that
   * idleness triggers.
   */
  it("never exceeds the NextAuth session maxAge in lib/auth.ts", () => {
    const authSource = readFileSync(
      fileURLToPath(new URL("./auth.ts", import.meta.url)),
      "utf8"
    );

    /* Two or three factors, so the pattern survives `30 * 60`, `6 * 60 * 60` and `24 * 60 * 60` alike. */
    const match = authSource.match(/maxAge:\s*(\d+)(?:\s*\*\s*(\d+))?(?:\s*\*\s*(\d+))?\s*,/);
    expect(match, "could not find `maxAge: …` in lib/auth.ts").not.toBeNull();

    const maxAgeSeconds = [match![1], match![2], match![3]]
      .filter((n): n is string => n !== undefined)
      .reduce((acc, n) => acc * Number(n), 1);

    expect(maxAgeSeconds, "sanity: the parse must find real arithmetic").toBeGreaterThan(0);
    expect(
      IDLE_TIMEOUT_MS,
      "an idle window longer than the session would never get to act"
    ).toBeLessThanOrEqual(maxAgeSeconds * 1000);
  });

  /**
   * ⚠ AND THE SESSION MUST ACTUALLY BE THE INTENDED DAY. Without this, quietly reverting `maxAge`
   * to a shorter value would still satisfy the inequality above, the policy would be undone and every test
   * would stay green.
   */
  it("gives the session its intended one day", () => {
    const authSource = readFileSync(
      fileURLToPath(new URL("./auth.ts", import.meta.url)),
      "utf8"
    );

    expect(authSource).toMatch(/maxAge:\s*24\s*\*\s*60\s*\*\s*60\s*,/);
  });

  /**
   * ⚠ AND THE BEARER TOKENS MUST STAY SHORT. The session is served by refreshed 30-minute tokens; raising
   * `IdTokenValidity` to match would multiply the replay window for a stolen credential by twelve, for no
   * gain. This reads the CloudFormation template, because that is where the mistake would be made.
   *
   * The template is `infra/aws/app/platform-identity.yaml`, reached through `siblingRepoPath` (which maps
   * `infrastructure` to `../infra`, or `AIAP_INFRASTRUCTURE_REPO` when set). It is asserted when present
   * and reported as a todo when not; `lib/sibling-repo-source.ts` carries the reasoning.
   */
  const templatePath = siblingRepoPath("infrastructure", "aws", "app", "platform-identity.yaml");
  const withTemplate = existsSync(templatePath) ? it : it.todo;

  withTemplate("does not lengthen the Cognito token lifetime to match", () => {
    const template = readFileSync(templatePath, "utf8");

    expect(template, "access tokens stay short-lived").toMatch(/AccessTokenValidity:\s*30\b/);
    expect(template, "and so do ID tokens").toMatch(/IdTokenValidity:\s*30\b/);
    expect(template).toMatch(/TokenValidityUnits:\s*\{[^}]*AccessToken:\s*minutes/);
  });

  it("leaves room for the warning to be seen before the deadline", () => {
    // A warning window at or beyond the timeout would mean the banner is on screen from
    // the moment the app loads.
    expect(IDLE_WARNING_MS).toBeGreaterThan(0);
    expect(IDLE_WARNING_MS).toBeLessThan(IDLE_TIMEOUT_MS);
  });

  it("throttles activity by far less than the warning window", () => {
    // The throttle delays RECORDING activity, so it effectively extends the timeout by up
    // to its own length. It must stay small relative to the warning, or a user who taps a
    // key during the warning could see the banner linger.
    expect(IDLE_ACTIVITY_THROTTLE_MS).toBeGreaterThan(0);
    expect(IDLE_ACTIVITY_THROTTLE_MS).toBeLessThan(IDLE_WARNING_MS);
  });

  it("re-arms with a floor, so a sub-millisecond remainder cannot spin", () => {
    expect(IDLE_MIN_REARM_MS).toBeGreaterThan(0);
  });
});

/**
 * The bounds on the sign-out itself. Both exist because this path runs when NOBODY IS
 * WATCHING, the user has walked away, so an unbounded await or an unbounded retry has
 * nobody to notice it and would leave a populated screen holding a live session.
 */
describe("the sign-out attempt is bounded", () => {
  it("times out a single attempt rather than awaiting forever", () => {
    // Rule of the house: every await on an external resource has a timeout. Without one
    // this feature fails OPEN, which is the defect it exists to close.
    expect(IDLE_SIGN_OUT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(IDLE_SIGN_OUT_TIMEOUT_MS)).toBe(true);
  });

  it("retries a bounded number of times", () => {
    expect(IDLE_SIGN_OUT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(IDLE_SIGN_OUT_MAX_ATTEMPTS).toBeLessThanOrEqual(3);
  });

  it("cannot spend longer retrying than the idle window itself", () => {
    // Otherwise a second idle window could elapse while the first sign-out is still
    // grinding, which would make the timer's behaviour impossible to reason about.
    expect(IDLE_SIGN_OUT_TIMEOUT_MS * IDLE_SIGN_OUT_MAX_ATTEMPTS).toBeLessThan(
      IDLE_TIMEOUT_MS
    );
  });

  it("finishes trying well inside the warning the user was shown", () => {
    // The banner promises a sign-out at the deadline. If the attempts outlasted the
    // warning window the user would sit watching "Signing you out…" for longer than the
    // notice they were given.
    expect(IDLE_SIGN_OUT_TIMEOUT_MS).toBeLessThanOrEqual(IDLE_WARNING_MS);
  });
});

describe("IDLE_ACTIVITY_EVENTS", () => {
  it("listens to the four real interaction signals", () => {
    expect([...IDLE_ACTIVITY_EVENTS]).toEqual([
      "pointerdown",
      "keydown",
      "scroll",
      "visibilitychange",
    ]);
  });

  it("does NOT poll pointer movement", () => {
    // A mousemove/pointermove listener is how an idle timer ends up never firing: a
    // nudged desk, a sleeping cat or a page animation under the cursor all generate it
    // without a user being present.
    expect([...IDLE_ACTIVITY_EVENTS]).not.toContain("mousemove");
    expect([...IDLE_ACTIVITY_EVENTS]).not.toContain("pointermove");
    expect([...IDLE_ACTIVITY_EVENTS]).not.toContain("mouseover");
  });

  it("counts returning to the tab as a signal", () => {
    expect([...IDLE_ACTIVITY_EVENTS]).toContain("visibilitychange");
  });
});

describe("msUntilIdle", () => {
  const now = 1_700_000_000_000;

  it("is the full window at the instant of activity", () => {
    expect(msUntilIdle(now, now)).toBe(IDLE_TIMEOUT_MS);
  });

  it("counts down as time passes", () => {
    expect(msUntilIdle(now, now + 60_000)).toBe(IDLE_TIMEOUT_MS - 60_000);
  });

  it("is 0 exactly at the deadline, not one tick later", () => {
    // The boundary: `<=` vs `<` here is the difference between signing out at 30:00 and
    // waiting for the next wake-up.
    expect(msUntilIdle(now, now + IDLE_TIMEOUT_MS)).toBe(0);
  });

  it("floors at 0 rather than going negative", () => {
    // A frozen/throttled tab wakes up long after its deadline; a negative remainder
    // would arithmetic its way back into "plenty of time".
    expect(msUntilIdle(now, now + IDLE_TIMEOUT_MS + 3_600_000)).toBe(0);
  });

  it("fails CLOSED on a non-finite input", () => {
    // "I cannot tell how long they've been away" must resolve to signing out. The
    // opposite default is a session that silently never times out.
    expect(msUntilIdle(NaN, now)).toBe(0);
    expect(msUntilIdle(now, NaN)).toBe(0);
    expect(msUntilIdle(Infinity, now)).toBe(0);
    expect(msUntilIdle(now, Infinity)).toBe(0);
  });

  it("gives a full fresh window when the clock moves BACKWARDS", () => {
    // An NTP correction or a resumed laptop can put `now` before the last activity. That
    // is not 30 minutes of idleness, and ejecting a user who is sitting right there
    // because their clock was corrected would be the worse failure.
    expect(msUntilIdle(now, now - 5_000)).toBe(IDLE_TIMEOUT_MS);
  });

  it("honours an explicit timeout, so the window is testable without waiting", () => {
    expect(msUntilIdle(now, now + 400, 1_000)).toBe(600);
  });
});

describe("idleCheck", () => {
  const now = 1_700_000_000_000;

  it("is ACTIVE right after activity, and wakes at the warning boundary", () => {
    const { stage, delayMs } = idleCheck(now, now);
    expect(stage).toBe("ACTIVE");
    expect(delayMs).toBe(IDLE_TIMEOUT_MS - IDLE_WARNING_MS);
  });

  it("is WARN once the remaining time is inside the warning window", () => {
    const atWarning = now + IDLE_TIMEOUT_MS - IDLE_WARNING_MS;
    const { stage, delayMs } = idleCheck(now, atWarning);
    expect(stage).toBe("WARN");
    // The next wake-up is the deadline itself.
    expect(delayMs).toBe(IDLE_WARNING_MS);
  });

  it("is still ACTIVE one millisecond before the warning boundary", () => {
    // Pins the boundary from the other side: an off-by-one here would show the banner a
    // whole warning-window early.
    const justBefore = now + IDLE_TIMEOUT_MS - IDLE_WARNING_MS - 1;
    expect(idleCheck(now, justBefore).stage).toBe("ACTIVE");
  });

  it("is IDLE exactly at the deadline", () => {
    expect(idleCheck(now, now + IDLE_TIMEOUT_MS)).toEqual({
      stage: "IDLE",
      delayMs: 0,
    });
  });

  it("is IDLE for a tab that woke up long after its deadline", () => {
    // The case a background tab actually hits: browsers throttle and then freeze timers,
    // so the callback can arrive hours late. It must sign out, not restart the window.
    expect(idleCheck(now, now + IDLE_TIMEOUT_MS + 7_200_000).stage).toBe("IDLE");
  });

  it("never re-arms below the floor, so it cannot spin", () => {
    // Sub-millisecond remainders inside the warning window would otherwise produce
    // setTimeout(0) in a tight loop until the deadline passed.
    const nearDeadline = now + IDLE_TIMEOUT_MS - 1;
    const { stage, delayMs } = idleCheck(now, nearDeadline);
    expect(stage).toBe("WARN");
    expect(delayMs).toBeGreaterThanOrEqual(IDLE_MIN_REARM_MS);
  });

  it("fails CLOSED to IDLE on a non-finite timestamp", () => {
    expect(idleCheck(NaN, now).stage).toBe("IDLE");
  });
});

describe("shouldRecordActivity", () => {
  const now = 1_700_000_000_000;

  it("records the first signal after the throttle has elapsed", () => {
    expect(shouldRecordActivity(now, now + IDLE_ACTIVITY_THROTTLE_MS)).toBe(true);
  });

  it("drops a burst inside the throttle window", () => {
    // The point of the throttle: scroll fires tens of times a second and keydown once
    // per character, for the whole session.
    expect(shouldRecordActivity(now, now)).toBe(false);
    expect(shouldRecordActivity(now, now + 1)).toBe(false);
    expect(shouldRecordActivity(now, now + IDLE_ACTIVITY_THROTTLE_MS - 1)).toBe(
      false
    );
  });

  it("records immediately when the clock has moved BACKWARDS", () => {
    // Otherwise a corrected clock would leave the stored instant in the future and the
    // throttle would suppress every subsequent signal until real time caught up.
    expect(shouldRecordActivity(now, now - 1)).toBe(true);
  });

  it("records NOTHING for a non-finite clock reading", () => {
    // Writing NaN into the timestamp would make msUntilIdle fail closed and eject an
    // active user.
    expect(shouldRecordActivity(now, NaN)).toBe(false);
    expect(shouldRecordActivity(now, Infinity)).toBe(false);
  });

  it("honours an explicit throttle", () => {
    expect(shouldRecordActivity(now, now + 50, 100)).toBe(false);
    expect(shouldRecordActivity(now, now + 100, 100)).toBe(true);
  });
});

/**
 * The cross-tab timestamp is the ONE untrusted input this feature has: localStorage is
 * writable by anything on the origin and by the user, and the only thing a bad value can
 * do is POSTPONE a sign-out. So every one of these cases must reject rather than coerce.
 */
describe("parseLastActivityAt", () => {
  const now = 1_700_000_000_000;

  it("accepts a plausible recent instant", () => {
    expect(parseLastActivityAt(String(now - 5_000), now)).toBe(now - 5_000);
  });

  it("returns null for an absent or empty value", () => {
    expect(parseLastActivityAt(null, now)).toBeNull();
    expect(parseLastActivityAt(undefined, now)).toBeNull();
    expect(parseLastActivityAt("", now)).toBeNull();
  });

  it("rejects anything that is not a positive number", () => {
    expect(parseLastActivityAt("not-a-number", now)).toBeNull();
    expect(parseLastActivityAt("0", now)).toBeNull();
    expect(parseLastActivityAt("-1", now)).toBeNull();
    expect(parseLastActivityAt("Infinity", now)).toBeNull();
    expect(parseLastActivityAt("{}", now)).toBeNull();
  });

  it("REJECTS a far-future timestamp instead of clamping it", () => {
    // The attack this guard exists for: `Date.now() + 1e12` in localStorage would
    // postpone the inactivity sign-out for thirty years. Rejecting leaves the tab
    // measuring against its own in-memory value, which still times out.
    expect(parseLastActivityAt(String(now + 1e12), now)).toBeNull();
    expect(
      parseLastActivityAt(String(now + IDLE_CLOCK_SKEW_TOLERANCE_MS + 1), now)
    ).toBeNull();
  });

  it("tolerates small skew between two tabs' clock reads", () => {
    // A sibling tab can legitimately be a few milliseconds ahead.
    expect(
      parseLastActivityAt(String(now + IDLE_CLOCK_SKEW_TOLERANCE_MS), now)
    ).toBe(now + IDLE_CLOCK_SKEW_TOLERANCE_MS);
  });

  it("keeps the storage key stable, since two versions would not see each other", () => {
    expect(IDLE_ACTIVITY_STORAGE_KEY).toBe("aiap.idle.lastActivityAt");
  });
});

describe("latestActivityAt", () => {
  const now = 1_700_000_000_000;

  it("falls back to this tab's own value when nothing is shared", () => {
    expect(latestActivityAt(now, null)).toBe(now);
  });

  it("takes another tab's NEWER activity, so a foreground tab keeps a background one alive", () => {
    // The requirement: two tabs are one user. Without this, a tab left in the background
    // would sign the whole browser out while the user works in the other one.
    expect(latestActivityAt(now - 60_000, now)).toBe(now);
  });

  it("keeps its own newer value over a stale shared one", () => {
    // This tab has just been clicked; the localStorage write is throttled, so it knows
    // something the shared value does not yet.
    expect(latestActivityAt(now, now - 60_000)).toBe(now);
  });

  it("does not let a rejected shared value reset the window", () => {
    // parseLastActivityAt returns null for a bad value, which must mean "no shared
    // activity" and never "activity at time 0", the latter would make every tab
    // instantly idle.
    expect(latestActivityAt(now, null)).toBe(now);
  });
});

/**
 * The distinction the original defect turns on, asserted structurally rather than
 * by prose: the IDLE path must reach the FULL teardown, and the EXPIRY path must not.
 *
 * A source-level assertion is a blunt instrument, but the alternative is no coverage at
 * all, these are two client components whose behaviour is a browser navigation, and the
 * failure mode is silent (a sign-out that leaves Cognito's tokens alive looks identical
 * in a click-through). If either file is restructured, this test fails loudly and asks
 * for a decision instead of letting the two paths quietly converge.
 */
describe("the idle path and the expiry path stay distinct", () => {
  /**
   * The file's CODE, with comments removed.
   *
   * Necessary, not fussy: both files now explain the two paths at length, and those
   * comments name `signOutEverywhere` and the IdleTimeout element in prose. Matching raw
   * source would let a comment satisfy, or falsify, an assertion about behaviour, which
   * is worse than no assertion. Block comments are stripped first, which also covers the
   * brace-wrapped JSX comment form; the `(?<!:)` on the line-comment pattern keeps a
   * `https://` inside a string literal from swallowing the rest of its line.
   */
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/.*$/gm, "");

  it("has the idle timer perform the FULL sign-out via the shared helper", () => {
    const source = read("../components/IdleTimeout.tsx");
    // Reused, not reimplemented: a second copy of the three-step teardown is how one of
    // the three steps gets forgotten.
    expect(source).toContain('from "@/lib/sign-out"');
    expect(source).toContain("signOutEverywhere");
  });

  it("does NOT reimplement the teardown in the idle timer", () => {
    const source = read("../components/IdleTimeout.tsx");
    expect(source).not.toContain("aws-amplify/auth");
    expect(source).not.toContain("nextAuthSignOut");
  });

  it("bounds the sign-out await, rather than declaring a timeout it never applies", () => {
    // A constant nobody races against is a comment. This pins that the component actually
    // consumes it.
    const source = read("../components/IdleTimeout.tsx");
    expect(source).toContain("IDLE_SIGN_OUT_TIMEOUT_MS");
    expect(source).toContain("Promise.race");
  });

  it("keeps the expiry path on the LOCAL sign-out, with Amplify untouched", () => {
    // The behaviour providers.tsx's long comment argues for: a merely-expired token must
    // still be silently renewable from Amplify's refresh token, so landing there must NOT
    // cost a password and a TOTP code.
    const source = read("../components/providers.tsx");
    expect(source).toContain("function evictExpiredSession()");
    // NextAuth's own signOut, local, this app's cookie only.
    expect(source).toMatch(/signOut\(\{[^}]*\}\)/);
    expect(source, "the full teardown belongs to the IDLE path, not this one").not.toContain(
      "signOutEverywhere"
    );
    expect(source, "and Amplify's tokens are never touched here").not.toContain("aws-amplify/auth");
  });

  /**
   * ⚠ THE REDIRECT MUST NOT WAIT FOR THE SIGN-OUT ROUND TRIP.
   *
   * REPORTED: a chat page showing "Couldn't load this team's chat … Backend error: 401 … Try again", with
   * the request "can we redirect users immediately to login whenever there is this 401 error".
   *
   * The eviction used to navigate only via `signOut`'s `callbackUrl`, i.e. after a POST to
   * `/api/auth/signout` completed. React renders the failed query's error state on the SAME TICK, so for
   * the whole duration of that request the user sat on a screen blaming the team's data and inviting them
   * to report a bug, for an expired login. The previous assertion pinned that exact call shape, so it
   * would have PASSED on the broken behaviour for ever; what matters is that navigation is immediate.
   */
  it("navigates immediately rather than after the sign-out completes", () => {
    const source = read("../components/providers.tsx");
    expect(source, "a synchronous navigation").toContain('window.location.replace("/login")');
    expect(source, "the sign-out is fired, not awaited").toMatch(/void signOut\(/);
    expect(
      source,
      "and it must not depend on signOut's own redirect, which is the round trip"
    ).not.toContain('callbackUrl: "/login"');
  });

  /**
   * `replace`, not `assign`/`href`: Back must not return to a page whose every query 401s.
   */
  it("leaves no history entry pointing at the dead page", () => {
    const source = read("../components/providers.tsx");
    expect(source).not.toMatch(/window\.location\.href\s*=/);
    expect(source).not.toMatch(/window\.location\.assign\(/);
  });

  it("mounts the idle timer exactly once, in the app-wide provider", () => {
    // One place that wraps the authenticated app, not per-page: a per-page timer would
    // restart on every navigation and would miss whichever page nobody remembered.
    const source = read("../components/providers.tsx");
    expect(source).toContain("<IdleTimeout />");
    expect(source.match(/<IdleTimeout \/>/g)).toHaveLength(1);
  });
});

// ── ⚠ THE COPY MUST READ LIKE SPEECH ─────────────────────────────────────────────────────
//
// The warning banner spells the window from `IDLE_TIMEOUT_MS` so the copy cannot drift from the behaviour.
// That was right, and as `Math.round(ms / 60_000)` it read "After 120 minutes without activity" the moment the
// window became two hours, correct, and not how anyone says it.
describe("describeIdleWindow", () => {
  it("says hours when the window is a whole number of them", () => {
    expect(describeIdleWindow(2 * 60 * 60 * 1000)).toBe("2 hours");
    expect(describeIdleWindow(60 * 60 * 1000), "singular").toBe("1 hour");
  });

  it("still says minutes below an hour", () => {
    expect(describeIdleWindow(30 * 60 * 1000)).toBe("30 minutes");
    expect(describeIdleWindow(60 * 1000), "singular").toBe("1 minute");
  });

  it("says both for a window that is neither", () => {
    expect(describeIdleWindow(90 * 60 * 1000)).toBe("1 hour 30 minutes");
  });

  /** The banner must never read "0 minutes", which would tell the reader nothing. */
  it("never describes the window as zero", () => {
    expect(describeIdleWindow(0)).toBe("1 minute");
    expect(describeIdleWindow(1000)).toBe("1 minute");
  });

  /**
   * ⚠ AND IT DEFAULTS TO THE REAL CONSTANT, so the banner cannot be given a different number from the one
   * that governs the sign-out, the drift the original arithmetic existed to prevent.
   */
  it("defaults to the configured window", () => {
    expect(describeIdleWindow()).toBe(describeIdleWindow(IDLE_TIMEOUT_MS));
    expect(describeIdleWindow()).toBe("2 hours");
  });
});
