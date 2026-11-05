import { describe, it, expect } from "vitest";
import { isAccessLost } from "./TeamAccessNotice";

/**
 * WHICH FAILURES DESERVE A BANNER.
 *
 * The reported bug was an empty screen with no explanation, on a 403. The fix is a sentence — but a
 * sentence that also appears on every venue-wifi blip is one people learn to scroll past, and then the
 * 403 is invisible again for a different reason. So the predicate is the interesting part of this
 * component, and it is tested directly rather than through the DOM.
 *
 * `isAccessLost` is deliberately narrow: exactly the two permanent, actionable reasons.
 */
describe("isAccessLost", () => {
  it("is true for the two permanent, actionable failures", () => {
    // 403: authenticated, and the service refuses this team. The reported case.
    expect(isAccessLost("access-lost")).toBe(true);
    // 404: the team no longer exists — different question, same remedy.
    expect(isAccessLost("team-gone")).toBe(true);
  });

  it("is false for transient failures, so a blip raises no banner", () => {
    // These self-correct on the next poll and the views keep their last data, which is the better
    // behaviour mid-workshop than a banner that flickers.
    expect(isAccessLost("unavailable")).toBe(false);
    expect(isAccessLost("busy")).toBe(false);
  });

  it("is false when there is simply no team yet", () => {
    // Not a failure at all. A fresh install has not joined anything.
    expect(isAccessLost("no-team")).toBe(false);
  });

  it("is false for signed-out, which the app already handles elsewhere", () => {
    // `auth:expired` is broadcast and the app has its own re-login path; a second, competing message
    // here would be worse than none.
    expect(isAccessLost("signed-out")).toBe(false);
  });

  it("is false for a successful read, where reason is absent", () => {
    // `reason` is only present when a read came back empty — the shape is a discriminated union on
    // `ok`, so success carries no reason at all.
    expect(isAccessLost(undefined)).toBe(false);
    expect(isAccessLost(null)).toBe(false);
  });

  it("is false for anything unrecognised, rather than defaulting to alarm", () => {
    // A reason string from a future build must not raise a banner this build cannot explain.
    expect(isAccessLost("something-new")).toBe(false);
    expect(isAccessLost(403)).toBe(false);
    expect(isAccessLost({})).toBe(false);
    expect(isAccessLost("")).toBe(false);
  });
});
