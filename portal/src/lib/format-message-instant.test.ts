import { describe, it, expect } from "vitest";
import { formatMessageInstant } from "./format-message-instant";

/**
 * AI CHAT TIMESTAMPS, reported as misleading because the DATE was missing.
 *
 * Every message and thread rendered as a bare "09:42". A conversation from last week was
 * indistinguishable from one this morning, and a thread spanning several days read as a single
 * sitting, which misstates the pace of work on a page whose figures inform an assessment of
 * people.
 *
 * `now` is injected throughout, so these assertions are about the RULE and not about the day the
 * suite happens to run. The one thing deliberately not asserted is the exact glyphs: the helper
 * uses the reader's locale (justified in its own comment, every call site renders only after a
 * client-side query resolves, so there is no server render to mismatch), and pinning ICU output
 * would make this suite fail on a Node upgrade rather than on a real regression.
 */

/** Fixed reference clock: Wednesday 12 Aug 2026, 14:00 local. */
const NOW = new Date(2026, 7, 12, 14, 0, 0);

/** A local-time instant, built the same way the reference clock is. */
const at = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m, d, h, min, 0).toISOString();

describe("the date is present whenever it is not today or yesterday", () => {
  it("labels TODAY relatively, the date would be noise", () => {
    const out = formatMessageInstant(at(2026, 7, 12, 9, 42), NOW);
    expect(out).toMatch(/^Today /);
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it("labels YESTERDAY relatively", () => {
    expect(formatMessageInstant(at(2026, 7, 11, 18, 40), NOW)).toMatch(/^Yesterday /);
  });

  it("⚠ CARRIES A DATE for anything older, the reported bug", () => {
    /**
     * THE ASSERTION THAT WOULD HAVE CAUGHT IT. The old helper returned "09:42" here, with nothing
     * to distinguish it from a message sent an hour ago.
     */
    const out = formatMessageInstant(at(2026, 7, 4, 9, 42), NOW);
    expect(out).toMatch(/Aug/);
    expect(out).toMatch(/\b4\b/);
    expect(out).toMatch(/\d{2}:\d{2}/);
    expect(out, "must not be a bare clock time").not.toMatch(/^\d{2}:\d{2}$/);
  });

  it("keeps the TIME as well as the date, both facts, not one replacing the other", () => {
    // Losing the time would break the other half of reading a transcript: the order and rhythm of
    // an exchange within a day.
    const out = formatMessageInstant(at(2026, 7, 4, 23, 15), NOW);
    expect(out).toMatch(/23:15|11:15/); // 24h or 12h, depending on the runtime's locale
  });
});

describe("the year appears exactly when its absence would mislead", () => {
  it("is OMITTED within the current year", () => {
    const out = formatMessageInstant(at(2026, 0, 12, 9, 0), NOW);
    expect(out).not.toMatch(/2026/);
  });

  it("is INCLUDED for a previous year", () => {
    /**
     * "12 Jan" for a message from the previous January reads as three weeks ago rather than
     * fifteen months, the single most misleading version of this label, and the reason the extra
     * width is worth spending here and nowhere else.
     */
    const out = formatMessageInstant(at(2025, 0, 12, 9, 0), NOW);
    expect(out).toMatch(/2025/);
  });

  it("is included for a FUTURE year too, a clock-skewed row is still legible", () => {
    // Not a hypothetical: a device with a wrong clock writes one, and reporting it as "12 Jan"
    // would hide the anomaly rather than show it.
    expect(formatMessageInstant(at(2027, 0, 12, 9, 0), NOW)).toMatch(/2027/);
  });
});

describe("relative labels are calendar-day comparisons, not 24-hour windows", () => {
  it("a message 30 minutes ago that crossed midnight is YESTERDAY, not Today", () => {
    /**
     * The distinction a subtraction-based implementation gets wrong. At 00:15, a message from
     * 23:45 is fifteen minutes old but belongs to yesterday, and "Today 23:45" on a message sent
     * before the reader's day began is a contradiction on its face.
     */
    const justAfterMidnight = new Date(2026, 7, 12, 0, 15, 0);
    expect(
      formatMessageInstant(at(2026, 7, 11, 23, 45), justAfterMidnight)
    ).toMatch(/^Yesterday /);
  });

  it("a message 23 hours ago on the same calendar day is TODAY", () => {
    const lateEvening = new Date(2026, 7, 12, 23, 30, 0);
    expect(formatMessageInstant(at(2026, 7, 12, 0, 30), lateEvening)).toMatch(/^Today /);
  });

  it("handles the month boundary", () => {
    const firstOfMonth = new Date(2026, 8, 1, 10, 0, 0);
    expect(formatMessageInstant(at(2026, 7, 31, 22, 0), firstOfMonth)).toMatch(
      /^Yesterday /
    );
  });
});

describe("a missing or broken value renders NOTHING, not 'Invalid Date'", () => {
  for (const bad of ["", "not-a-date", "undefined"]) {
    it(`returns "" for ${JSON.stringify(bad)}`, () => {
      /**
       * "Invalid Date NaN:NaN" beside a real message makes a data gap look like a fault in the
       * conversation. Same discipline as formatInstantUtc, which degrades to "" for the same
       * reason.
       */
      expect(formatMessageInstant(bad, NOW)).toBe("");
    });
  }
});
