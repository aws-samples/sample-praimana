// ── ⚠ IDLENESS SURVIVES A PAGE LIFECYCLE, OR IT IS NOT A CONTROL ──────────────────────────────
//
// The advertised 2-hour inactivity sign-out was enforced only by a live in-page `setTimeout`, and the
// persisted activity timestamp could only ever EXTEND the window:
//
//   · every mount seeded `let lastActivityAt = Date.now()`, "mounting means the user just arrived";
//   · the only other writer was `latestActivityAt(local, shared)`, which is `Math.max`.
//
// So a stored value hours in the past was discarded by the max, closing the tab removed the only
// enforcement point, and the persistent 24-hour session cookie meant reopening the portal landed
// straight in the application with no password and no TOTP. Past 24 hours, /login's resume effect
// silently minted a brand-new session from the ~30-day Amplify refresh token, also with no idleness
// check. Found in a security review.
//
// The code claimed the opposite for itself, `auth.ts`: "idleness signs out first and does the full
// teardown"; `idle-timeout.ts`: inactivity "IS a request to leave, made by walking away from an
// unlocked machine". Both were true only while a tab stayed open.
//
// This file pins the two properties that make the claim true: the stored instant is OWNED, and it is
// a FLOOR as well as a ceiling.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IDLE_TIMEOUT_MS,
  idleCheck,
  latestActivityAt,
  parseSharedActivity,
  seedActivity,
  serialiseSharedActivity,
} from "./idle-timeout";

const OWNER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const NOW = 1_800_000_000_000;

describe("the shared activity value is owned", () => {
  it("round-trips its own owner", () => {
    const raw = serialiseSharedActivity(OWNER, NOW - 60_000);
    expect(parseSharedActivity(raw, OWNER, NOW)).toBe(NOW - 60_000);
  });

  it("⚠ IGNORES ANOTHER USER'S VALUE, B must not be signed out for A's absence", () => {
    const raw = serialiseSharedActivity(OTHER, NOW - 5 * IDLE_TIMEOUT_MS);
    expect(parseSharedActivity(raw, OWNER, NOW)).toBeNull();
  });

  it("⚠ IGNORES THE BARE-INTEGER FORMAT A PREVIOUS RELEASE WROTE", () => {
    // Degrading to "no shared activity" is what stops a deploy signing out every user who has an old
    // value in storage. Null means "measure from now", which is the previous behaviour, not a
    // sign-out.
    expect(parseSharedActivity(String(NOW - 60_000), OWNER, NOW)).toBeNull();
  });

  it("ignores a missing, empty or malformed value, and an unknown owner", () => {
    for (const raw of [null, undefined, "", "|", "|123", "nonsense", `${OWNER}|`, `${OWNER}|abc`]) {
      expect(parseSharedActivity(raw, OWNER, NOW), String(raw)).toBeNull();
    }
    // No owner to compare against is also "no shared activity" rather than a match.
    expect(parseSharedActivity(serialiseSharedActivity(OWNER, NOW), "", NOW)).toBeNull();
  });

  it("still rejects an implausibly-future instant, which only a bad clock or a tamper produces", () => {
    const raw = serialiseSharedActivity(OWNER, NOW + 60 * 60_000);
    expect(parseSharedActivity(raw, OWNER, NOW)).toBeNull();
  });
});

describe("⚠ the stored instant is a FLOOR, not only a ceiling", () => {
  it("resolves to IDLE when the stored instant is older than the window", () => {
    // This is the finding, expressed as arithmetic: an absence longer than the window, discovered on
    // a fresh mount, must resolve to a sign-out rather than to a fresh window.
    const storedBeforeTabClosed = NOW - (IDLE_TIMEOUT_MS + 60_000);
    expect(idleCheck(storedBeforeTabClosed, NOW).stage).toBe("IDLE");
  });

  it("resolves to ACTIVE when the absence was shorter than the window, and the elapsed time counts", () => {
    const halfAway = NOW - IDLE_TIMEOUT_MS / 2;
    const check = idleCheck(halfAway, NOW);
    expect(check.stage).toBe("ACTIVE");
    // Not a fresh full window: the time spent away has been deducted.
    expect(check.delayMs).toBeLessThan(IDLE_TIMEOUT_MS);
  });

  it("keeps Math.max for the CROSS-TAB case, which is a different question", () => {
    // `latestActivityAt` is still max, and must be: a sibling tab that has just been clicked knows
    // something this tab does not. The floor comes from SEEDING with the stored value, not from
    // changing this comparison, and confusing the two would sign out a user working in another tab.
    expect(latestActivityAt(NOW - 60_000, NOW)).toBe(NOW);
    expect(latestActivityAt(NOW, NOW - 60_000)).toBe(NOW);
    expect(latestActivityAt(NOW - 60_000, null)).toBe(NOW - 60_000);
  });
});

describe("⚠ seedActivity, write-once, and never a refresh", () => {
  it("records the seed when storage held nothing trustworthy", () => {
    // First sign-in, cleared storage, Safari private mode, a foreign or malformed owner. Measuring
    // from now is the safe direction; WRITING it is what makes the absence recoverable after the
    // tab closes, which is the whole point.
    expect(seedActivity(null, NOW)).toEqual({ lastActivityAt: NOW, persist: true });
  });

  it("⚠ NEVER OVERWRITES A STORED INSTANT INSIDE THE WINDOW, that would be an unlimited session", () => {
    /**
     * The failure mode of the obvious fix. Persisting `now` on every mount would push the deadline
     * forward on every page load, so a user who navigates more often than the window is long would
     * never idle out at all, the control deleted while appearing to be repaired.
     */
    const stored = NOW - 30 * 60_000;
    expect(seedActivity(stored, NOW)).toEqual({ lastActivityAt: stored, persist: false });
  });

  it("⚠ RETURNS A STORED INSTANT BEYOND THE WINDOW UNTOUCHED, so the caller's check() signs out", () => {
    // The overnight case. It must survive to `idleCheck` intact, rewriting it to `now` here is
    // exactly the bug this function exists to prevent.
    const stored = NOW - (IDLE_TIMEOUT_MS + 60 * 60_000);
    const seed = seedActivity(stored, NOW);
    expect(seed).toEqual({ lastActivityAt: stored, persist: false });
    expect(idleCheck(seed.lastActivityAt, NOW).stage).toBe("IDLE");
  });

  it("treats a stored instant exactly ON the deadline as idle, not as a fresh window", () => {
    const stored = NOW - IDLE_TIMEOUT_MS;
    const seed = seedActivity(stored, NOW);
    expect(seed.persist).toBe(false);
    expect(idleCheck(seed.lastActivityAt, NOW).stage).toBe("IDLE");
  });

  it("persists a seed of 0 rather than confusing it with 'nothing stored'", () => {
    // `stored === null` is the sentinel, deliberately not falsiness: the epoch is a real instant and
    // `!stored` would treat it as absent, re-seeding `now` and losing an unbounded absence.
    expect(seedActivity(0, NOW)).toEqual({ lastActivityAt: 0, persist: false });
    expect(idleCheck(0, NOW).stage).toBe("IDLE");
  });
});

describe("the enforcement points that survive a page lifecycle", () => {
  const read = (relative: string) => readFileSync(join(__dirname, "..", relative), "utf8");

  it("⚠ THE TIMER SEEDS FROM STORAGE RATHER THAN FROM Date.now()", () => {
    const src = read("components/IdleTimeout.tsx");
    // The seeding line, which was `let lastActivityAt = Date.now();` and is now routed through
    // `seedActivity` so the rule is pure and testable rather than inline in an effect.
    expect(src).toMatch(/seedActivity\(readSharedActivity\(owner, Date\.now\(\)\), Date\.now\(\)\)/);
    expect(src).toMatch(/let lastActivityAt = seed\.lastActivityAt/);
  });

  it("⚠ AND PERSISTS THAT SEED, SO A SESSION WITH NO RECORDED ACTIVITY IS STILL ENFORCED", () => {
    /**
     * The hole the seeding alone left. `writeSharedActivity` is reached only from the THROTTLED
     * activity handler, so every signal within 15s of a page load is discarded, and the seed was
     * never written. "Sign in, click, navigate, close the browser" therefore stored nothing, and the
     * next morning's mount read null and started a clean two-hour window inside a still-valid
     * 24-hour cookie. As observed: signed in around midnight, still signed in the
     * next day.
     */
    const src = read("components/IdleTimeout.tsx");
    expect(src).toMatch(/if \(seed\.persist\) writeSharedActivity\(owner, lastActivityAt\)/);
  });

  it("⚠ /login's RESUME REFUSES PAST THE IDLE WINDOW", () => {
    const src = read("components/auth/AuthFlow.tsx");
    const resume = src.slice(src.indexOf("const [resuming"), src.indexOf("async function handleSignIn"));
    // The check must be present AND must sit before the session is minted, or it decides nothing.
    const checkAt = resume.indexOf("readSharedActivity(subject, now)");
    const mintAt = resume.indexOf('nextAuthSignIn("cognito-token"');
    expect(checkAt, "the resume path should consult the stored activity").toBeGreaterThan(-1);
    expect(mintAt, "the resume path should still mint a session").toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(mintAt);
    expect(resume).toMatch(/idleCheck\(lastActivityAt, now\)\.stage === "IDLE"/);
  });

  it("clears the stored instant on a deliberate sign-out", () => {
    // Otherwise a value outliving its session is litter on a shared machine, and the next
    // successful sign-in would inherit it were it not owner-scoped.
    expect(read("lib/sign-out.ts")).toMatch(/clearSharedActivity\(\)/);
  });
});
