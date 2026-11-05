/**
 * ⚠ PINNED TO A FIXED-OFFSET ZONE, BEFORE THE MODULE IS IMPORTED.
 *
 * Without this the timezone cases are VACUOUS on a UTC runner: the broken reading of a zone-less
 * timestamp and the correct one agree at offset 0, so the assertions would pass against the very bug
 * they exist to catch. Asia/Kolkata is +05:30 with no DST, so the two readings can never coincide.
 *
 * Same pin, same reason, as the desktop's message-timestamps.test.ts — which is now testing the CALL
 * SITES while this file tests the RULE.
 */
process.env.TZ = "Asia/Kolkata";

import { describe, it, expect } from "vitest";
import {
  parseStoredInstant,
  formatClock,
  formatMessageInstant,
  messageDayLabel,
} from "./message-time";

/** A fixed "now" so the relative labels are deterministic. Wednesday 19 Aug 2026, 14:00 local. */
const NOW = new Date(2026, 7, 19, 14, 0, 0);

describe("⚠ a stored timestamp is UTC even when it does not say so", () => {
  it("really is running off UTC, or the cases below prove nothing", () => {
    expect(new Date("2026-08-14T12:00:00Z").getTimezoneOffset(), "TZ pin did not take").not.toBe(0);
  });

  /** SQLite's `datetime('now')` shape: space-separated, no `Z`. The exact string the desktop stores. */
  it("reads SQLite's zone-less output as UTC, not as local", () => {
    expect(parseStoredInstant("2026-08-14 20:13:58").getTime()).toBe(
      Date.UTC(2026, 7, 14, 20, 13, 58)
    );
  });

  it("treats a zone-less T form as UTC too", () => {
    expect(parseStoredInstant("2026-08-14T20:13:58").getTime()).toBe(
      Date.UTC(2026, 7, 14, 20, 13, 58)
    );
  });

  /**
   * ⚠ AND THE FIX MUST NOT REACH SERVER TIMESTAMPS. The team and ai services stamp
   * `new Date().toISOString()`, which already carries `Z`; appending another zone would introduce the
   * very error this removes.
   */
  it("leaves a string that already carries a zone completely alone", () => {
    for (const iso of [
      "2026-08-14T20:13:58.123Z",
      "2026-08-14T20:13:58Z",
      "2026-08-14T20:13:58+02:00",
      "2026-08-14T20:13:58-05:00",
    ]) {
      expect(parseStoredInstant(iso).getTime(), iso).toBe(Date.parse(iso));
    }
  });

  it("gives the same answer for both spellings of one moment", () => {
    expect(formatMessageInstant("2026-08-14 20:13:58", NOW)).toBe(
      formatMessageInstant("2026-08-14T20:13:58Z", NOW)
    );
    expect(formatClock("2026-08-14 20:13:58")).toBe(formatClock("2026-08-14T20:13:58Z"));
  });
});

describe("the day label", () => {
  it("says Today and Yesterday relatively — the date would be noise", () => {
    expect(messageDayLabel(new Date(2026, 7, 19, 9, 30).toISOString(), NOW)).toBe("Today");
    expect(messageDayLabel(new Date(2026, 7, 18, 9, 30).toISOString(), NOW)).toBe("Yesterday");
  });

  /** ⚠ THE REPORTED BUG: a Friday message must not read as though it were today's. */
  it("names the day for anything older", () => {
    const friday = new Date(2026, 7, 14, 23, 4).toISOString();
    expect(messageDayLabel(friday, NOW)).toBe("14 Aug");
    expect(messageDayLabel(friday, NOW, { weekday: true })).toBe("Fri 14 Aug");
  });

  /**
   * ⚠ CALENDAR DAYS, NOT 24-HOUR WINDOWS. A message sent at 23:50 is "Yesterday" at 00:10, and a
   * subtraction of 24 hours would call it "Today".
   */
  it("compares calendar days across midnight", () => {
    const justAfterMidnight = new Date(2026, 7, 19, 0, 10, 0);
    expect(messageDayLabel(new Date(2026, 7, 18, 23, 50).toISOString(), justAfterMidnight)).toBe(
      "Yesterday"
    );
    expect(messageDayLabel(new Date(2026, 7, 19, 0, 5).toISOString(), justAfterMidnight)).toBe(
      "Today"
    );
  });

  it("omits the year within the current year and includes it outside", () => {
    expect(messageDayLabel(new Date(2026, 0, 12, 10, 0).toISOString(), NOW)).toBe("12 Jan");
    expect(messageDayLabel(new Date(2025, 0, 12, 10, 0).toISOString(), NOW)).toContain("2025");
    /* A clock-skewed FUTURE row stays legible rather than being quietly mislabelled. */
    expect(messageDayLabel(new Date(2027, 0, 12, 10, 0).toISOString(), NOW)).toContain("2027");
  });
});

describe("the full instant keeps BOTH facts", () => {
  it("carries the day and the clock, not one replacing the other", () => {
    const at = new Date(2026, 7, 14, 23, 4).toISOString();
    const formatted = formatMessageInstant(at, NOW)!;
    expect(formatted).toContain("14 Aug");
    expect(formatted).toContain(formatClock(at)!);
  });

  it("is the day label and the clock joined by a space", () => {
    const at = new Date(2026, 7, 18, 9, 15).toISOString();
    expect(formatMessageInstant(at, NOW)).toBe(`Yesterday ${formatClock(at)}`);
  });
});

describe("a missing or broken value renders NOTHING, not 'Invalid Date'", () => {
  /**
   * Every entry point must agree, because callers guard on one and interpolate another: a `null` from
   * one and an "Invalid Date" from its sibling is how a broken string reaches a bubble.
   */
  for (const bad of [undefined, null, "", "not a date", "2026-13-45 99:99:99"]) {
    it(`returns null from every function for ${JSON.stringify(bad)}`, () => {
      expect(formatMessageInstant(bad, NOW), "formatMessageInstant").toBeNull();
      expect(messageDayLabel(bad, NOW), "messageDayLabel").toBeNull();
      expect(formatClock(bad), "formatClock").toBeNull();
    });
  }
});
