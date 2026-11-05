// ── WHAT AN UPLOAD'S STATE IS ALLOWED TO CLAIM ───────────────────────────────────────────
//
// ⚠ EVERY TEST HERE IS ABOUT ONE FAILURE: the product said "Accepted" and never said anything else.
//
// The first real bulk upload had all three teams refused by a broken east-west hop, and the requester's
// email arrived empty so no report could be sent. The panel said "being set up". Nothing in the product
// disagreed, and the only evidence anywhere was one line in a Lambda log group.
//
// So these assertions are all forms of the same rule: the panel says what is KNOWN, never what would be
// convenient.

import { describe, it, expect } from "vitest";
import {
  STALLED_AFTER_MS,
  formatDuration,
  hasDetail,
  isStalled,
  isTerminal,
  orderedFailures,
  reportMissing,
  statusView,
  type BulkBatchView,
} from "./batch";

const T0 = Date.parse("2026-08-12T21:08:10.000Z");
const at = (msAfter: number) => T0 + msAfter;

const batch = (over: Partial<BulkBatchView> = {}): BulkBatchView => ({
  batchId: "01KZVWVPC5SAKCZ0A02QD5B5RF",
  workshopId: "01KZVC9WVW4MBZS362BE6EPR0E",
  status: "queued",
  requestedBy: { id: "u-fac", email: "fac@example.com" },
  requested: { teams: 3, members: 18 },
  createdAt: new Date(T0).toISOString(),
  ...over,
});

// ─── THE STALL RULE ──────────────────────────────────────────────────────────────────

describe("⚠ a batch that stopped answering must not still say 'processing'", () => {
  /**
   * Nothing fires when a Lambda is OOM-killed or hits its 300s ceiling, so the row is left saying
   * `processing` with nobody working on it. Showing that forever is the same lie as before, prettier.
   */
  it("reports a long-silent processing batch as unresponsive, not in progress", () => {
    const b = batch({ status: "processing", startedAt: new Date(T0).toISOString() });

    expect(isStalled(b, at(STALLED_AFTER_MS + 1))).toBe(true);
    const view = statusView(b, at(STALLED_AFTER_MS + 60_000));
    expect(view.label).toBe("No response");
    expect(view.tone).toBe("warn");
    expect(view.detail).toMatch(/may have stopped/i);
  });

  /**
   * ⚠ THE THRESHOLD EXISTS TO MAKE A FALSE STALL IMPOSSIBLE, not to detect death quickly. The worker's
   * ceiling is 300s and EventBridge may retry twice, so a legitimately slow batch, retries included -
   * cannot still be running at 20 minutes. A batch still inside that window is NOT stalled.
   */
  it("does not accuse a batch that is merely slow", () => {
    const b = batch({ status: "processing", startedAt: new Date(T0).toISOString() });

    expect(isStalled(b, at(STALLED_AFTER_MS - 1))).toBe(false);
    expect(statusView(b, at(5 * 60_000)).label).toBe("Processing");
  });

  it("leaves 20 minutes of room, which is longer than three full attempts", () => {
    // 300s ceiling × 3 attempts = 15 minutes. The threshold must exceed that or a real run gets libelled.
    expect(STALLED_AFTER_MS).toBeGreaterThan(3 * 300 * 1000);
  });

  /**
   * ⚠ A `queued` ROW THAT NEVER MOVES IS A DIFFERENT FAILURE, AND THE ONLY WAY IT IS EVER VISIBLE.
   * `EventBridgePublisher.publish` swallows its errors so a bus hiccup cannot fail the originating
   * write, so a batch can be accepted, recorded, and never reach a worker with nothing reporting a
   * problem anywhere.
   */
  it("reports a batch no worker ever picked up, and says not to just re-upload", () => {
    const view = statusView(batch({ status: "queued" }), at(STALLED_AFTER_MS + 1));

    expect(view.label).toBe("Not started");
    expect(view.tone).toBe("warn");
    expect(view.detail).toMatch(/may not have been queued/i);
  });

  it("never reports a finished batch as stalled, however old it is", () => {
    // A terminal row is a fact and does not decay. Ageing it into a warning would be nonsense.
    for (const status of ["completed", "completed_with_errors", "failed"] as const) {
      expect(isStalled(batch({ status }), at(30 * 24 * 3600 * 1000))).toBe(false);
    }
  });

  it("does not invent a stall from an unparseable timestamp", () => {
    // A bad date is not evidence of anything, and `NaN` comparisons would silently say "not stalled"
    // anyway, asserted so a future refactor cannot make it say the opposite.
    expect(isStalled(batch({ status: "processing", startedAt: "not a date" }), at(1e12))).toBe(false);
  });

  it("measures from createdAt when the batch was never picked up", () => {
    // A `queued` row has no startedAt, falling back to `createdAt` is what makes the case above work.
    expect(isStalled(batch({ status: "queued", startedAt: undefined }), at(STALLED_AFTER_MS + 1))).toBe(
      true
    );
  });
});

// ─── WHAT EACH TERMINAL STATE CLAIMS ─────────────────────────────────────────────────

describe("⚠ the label never overstates the outcome", () => {
  const counts = (over: Partial<NonNullable<BulkBatchView["counts"]>> = {}) => ({
    teamsCreated: 3,
    teamsMatched: 0,
    invited: 18,
    skipped: 0,
    failed: 0,
    ...over,
  });

  it("says complete, with the number invited", () => {
    const view = statusView(batch({ status: "completed", counts: counts() }), at(1000));
    expect(view.label).toBe("Complete");
    expect(view.tone).toBe("good");
    expect(view.detail).toMatch(/18 invited/);
  });

  /**
   * ⚠ NOT "COMPLETE" AND NOT "FAILED". Some people were invited and some were not, so both would be
   * false, and the tone has to pull the eye, because the entire reason this state is separate from
   * `completed` is that it needs a human to look at named addresses.
   */
  it("says finished with problems, and gives both numbers", () => {
    const view = statusView(
      batch({ status: "completed_with_errors", counts: counts({ invited: 15, failed: 3 }) }),
      at(1000)
    );

    expect(view.label).toBe("Finished with problems");
    expect(view.tone).toBe("warn");
    expect(view.detail).toMatch(/15 invited/);
    expect(view.detail).toMatch(/3 failed/);
  });

  /**
   * ⚠ `skipped` IS WORDED SO IT CANNOT READ AS A FAILURE. Those people already held a live invitation
   * and were deliberately left alone; re-inviting them would have re-minted their token and invalidated
   * the link already in their inbox. A panel that made that look like a problem would invite exactly the
   * wrong fix.
   */
  it("explains skipped as intentional, and still calls the batch complete", () => {
    const view = statusView(
      batch({ status: "completed", counts: counts({ invited: 15, skipped: 3 }) }),
      at(1000)
    );

    expect(view.label).toBe("Complete");
    expect(view.tone).toBe("good");
    expect(view.detail).toMatch(/already had a live invitation/i);
  });

  /**
   * ⚠ THE STORED REASON, NOT A GENERIC ONE. "Failed" with no reason is what sent somebody to
   * CloudWatch to find out that APP_URL was wrong.
   */
  it("shows the recorded reason for a batch that could not run", () => {
    const view = statusView(
      batch({ status: "failed", error: "APP_URL is unset or local (empty)" }),
      at(1000)
    );

    expect(view.label).toBe("Failed");
    expect(view.tone).toBe("bad");
    expect(view.detail).toMatch(/APP_URL/);
  });

  it("still says something useful for a failure with no recorded reason", () => {
    expect(statusView(batch({ status: "failed" }), at(1000)).detail).toMatch(/nothing was created/i);
  });
});

// ─── THE UNSENT REPORT ───────────────────────────────────────────────────────────────

describe("⚠ a finished batch whose report never sent is its own warning", () => {
  /**
   * THE CASE THAT ACTUALLY HAPPENED. The outcome was known and the person who uploaded the file was
   * never told, because `requestedBy.email` was published empty. Somebody reading this panel is then the
   * only remaining path to them finding out, so it cannot be silent about it.
   */
  it("flags a terminal batch that emailed nobody", () => {
    expect(reportMissing(batch({ status: "completed_with_errors", reportSent: false }))).toBe(true);
    expect(reportMissing(batch({ status: "failed", reportSent: false }))).toBe(true);
  });

  it("does not flag a batch that is still running", () => {
    // Nothing is owed yet; the report is sent at the end.
    expect(reportMissing(batch({ status: "processing", reportSent: false }))).toBe(false);
  });

  it("does not flag a batch whose report went out", () => {
    expect(reportMissing(batch({ status: "completed", reportSent: true }))).toBe(false);
  });

  /**
   * ⚠ UNKNOWN IS NOT THE SAME AS FAILED. A row written before this field existed has no `reportSent`,
   * and claiming its report failed would be a fabrication.
   */
  it("does not flag a batch that never recorded either way", () => {
    expect(reportMissing(batch({ status: "completed", reportSent: undefined }))).toBe(false);
  });
});

// ─── THE FAILURE DETAIL ──────────────────────────────────────────────────────────────

describe("⚠ the worst problem is listed first", () => {
  /**
   * A TEAM THAT WAS NEVER CREATED means NOBODY on it was invited, and the fix is a human decision about
   * the name. Leaving it below a list of individual addresses would bury the bigger problem under the
   * smaller ones.
   */
  it("puts whole-team failures above address failures", () => {
    const ordered = orderedFailures(
      batch({
        failures: [
          { teamName: "Jarvis", email: "a@example.com", reason: "rejected" },
          { teamName: "Wakanda", reason: "ambiguous name" },
          { teamName: "Jarvis", email: "b@example.com", reason: "rejected" },
        ],
      })
    );

    expect(ordered[0]).toEqual({ teamName: "Wakanda", reason: "ambiguous name" });
    expect(ordered).toHaveLength(3);
  });

  it("has nothing to expand for a clean batch", () => {
    // The row must not offer a "show problems" control that reveals an empty list.
    expect(hasDetail(batch({ status: "completed", failures: [] }))).toBe(false);
  });

  it("has something to expand when the batch itself failed with no per-row detail", () => {
    // The reason is on the batch, not in a failures array, the control still has to appear.
    expect(hasDetail(batch({ status: "failed", error: "APP_URL is unset" }))).toBe(true);
  });
});

// ─── SMALL TRUTHS ────────────────────────────────────────────────────────────────────

describe("elapsed time is shown only when it is known", () => {
  it("reports the duration once both ends exist", () => {
    expect(
      formatDuration(
        batch({
          startedAt: new Date(T0).toISOString(),
          completedAt: new Date(at(45_000)).toISOString(),
        })
      )
    ).toBe("45s");
  });

  it("uses minutes and seconds for a longer run", () => {
    expect(
      formatDuration(
        batch({
          startedAt: new Date(T0).toISOString(),
          completedAt: new Date(at(95_000)).toISOString(),
        })
      )
    ).toBe("1m 35s");
  });

  it("shows nothing at all for a batch that has not finished", () => {
    // An empty string, not "0s", which would imply it completed instantly.
    expect(formatDuration(batch({ status: "processing", startedAt: new Date(T0).toISOString() }))).toBe(
      ""
    );
  });

  it("shows nothing when the timestamps are inconsistent", () => {
    expect(
      formatDuration(
        batch({
          startedAt: new Date(at(5000)).toISOString(),
          completedAt: new Date(T0).toISOString(),
        })
      )
    ).toBe("");
  });
});

describe("terminality drives the polling, so it has to be exact", () => {
  it("treats all three end states as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("completed_with_errors")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
  });

  it("treats queued and processing as still in flight", () => {
    // The panel polls while either is present; getting this wrong either stops tracking a live batch
    // or polls a finished list forever.
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("processing")).toBe(false);
  });
});
