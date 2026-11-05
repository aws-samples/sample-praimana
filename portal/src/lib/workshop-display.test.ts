/**
 * The presentation rules for a workshop's enums, dates and counts.
 *
 * Three of these assertions pin defects the experiences list actually shipped with, and they are
 * marked as such: JUDGING rendered as an idle/finished state, `toLocaleDateString()` rendering in
 * the reader's locale, and raw SHOUTING_SNAKE_CASE reaching the screen.
 */

import { describe, it, expect } from "vitest";
import {
  WORKSHOP_STATUSES,
  isWorkshopStatus,
  statusLabel,
  statusTone,
  formatLabel,
  teamCountLabel,
  workshopDate,
} from "./workshop-display";

describe("statusLabel", () => {
  it("gives every lifecycle status a sentence-case label", () => {
    // Exhaustive on purpose: a seventh status added to the union without a label would fail
    // to compile, but one added with an ALL_CAPS label would not, this catches that.
    for (const status of WORKSHOP_STATUSES) {
      const label = statusLabel(status);
      expect(label).not.toBe(status);
      expect(label).not.toMatch(/_/);
      expect(label).toBe(label.charAt(0).toUpperCase() + label.slice(1));
      expect(label).not.toBe(label.toUpperCase());
    }
  });

  it("says what REGISTRATION means rather than naming it", () => {
    expect(statusLabel("REGISTRATION")).toBe("Registration open");
  });

  it("renders an unknown status legibly instead of blank", () => {
    // The services ship from a different repository and can introduce a state before the
    // portal knows it. A readable fallback beats an empty cell on the login landing screen.
    expect(statusLabel("AWAITING_SPONSOR")).toBe("Awaiting sponsor");
    expect(statusLabel(null)).toBe("Unknown");
    expect(statusLabel(undefined)).toBe("Unknown");
  });
});

describe("statusTone", () => {
  it("treats JUDGING as a live state, not a finished one", () => {
    // ⚠ THE DEFECT. The list chose its dot colour with `ACTIVE ? … : REGISTRATION ? … : idle`,
    // so JUDGING, the busiest phase of an accelerator, was painted the same dead grey as an
    // event archived last year.
    expect(statusTone("JUDGING")).toBe("active");
    expect(statusTone("ACTIVE")).toBe("active");
  });

  it("separates 'needs an action' from 'finished'", () => {
    expect(statusTone("DRAFT")).toBe("pending");
    expect(statusTone("REGISTRATION")).toBe("pending");
    expect(statusTone("COMPLETED")).toBe("idle");
    expect(statusTone("ARCHIVED")).toBe("idle");
  });

  it("errs towards 'needs attention' for an unknown status", () => {
    // Mislabelling a live workshop as ignorable is the more expensive of the two errors.
    expect(statusTone("AWAITING_SPONSOR")).toBe("pending");
    expect(statusTone(null)).toBe("pending");
  });

  it("assigns a tone to every status in the union", () => {
    for (const status of WORKSHOP_STATUSES) {
      expect(["active", "pending", "idle"]).toContain(statusTone(status));
    }
  });
});

describe("isWorkshopStatus", () => {
  it("narrows only the known lifecycle values", () => {
    expect(isWorkshopStatus("ACTIVE")).toBe(true);
    expect(isWorkshopStatus("COMPLETE")).toBe(false); // near-miss: the real value is COMPLETED
    expect(isWorkshopStatus("active")).toBe(false); // case-sensitive, as the transport is
  });
});

describe("formatLabel", () => {
  it("turns the delivery enums into words", () => {
    expect(formatLabel("IN_PERSON")).toBe("In person");
    expect(formatLabel("VIRTUAL")).toBe("Virtual");
    expect(formatLabel("HYBRID")).toBe("Hybrid");
  });

  it("falls back to an em-dash when absent", () => {
    expect(formatLabel(null)).toBe("-");
    expect(formatLabel(undefined)).toBe("-");
  });
});

describe("teamCountLabel", () => {
  it("agrees with the noun", () => {
    expect(teamCountLabel(1)).toBe("1 team");
    expect(teamCountLabel(6)).toBe("6 teams");
    expect(teamCountLabel(0)).toBe("0 teams");
  });

  it("distinguishes 'none' from 'not loaded'", () => {
    // A stated "0 teams" beside a workshop that has teams reads as fact; "-" reads as unknown.
    expect(teamCountLabel(undefined)).toBe("- teams");
    expect(teamCountLabel(null)).toBe("- teams");
    expect(teamCountLabel(0)).not.toBe(teamCountLabel(undefined));
  });
});

describe("workshopDate", () => {
  it("names the month so day/month order cannot be misread", () => {
    // ⚠ THE DEFECT. Bare `toLocaleDateString()` rendered "8/1/2026" in Seattle and
    // "01/08/2026" in London, the same string meaning two days five months apart.
    expect(workshopDate(new Date("2026-08-01T09:00:00Z"))).toBe("1 Aug 2026");
    expect(workshopDate("2026-05-14T09:00:00Z")).toBe("14 May 2026");
  });

  it("never contains a bare numeric month", () => {
    expect(workshopDate(new Date("2026-08-01T09:00:00Z"))).not.toMatch(/^\d+\/\d+\/\d+$/);
  });

  it("returns null rather than 'Invalid Date' for unusable input", () => {
    expect(workshopDate(null)).toBeNull();
    expect(workshopDate(undefined)).toBeNull();
    expect(workshopDate("not a date")).toBeNull();
    expect(workshopDate("")).toBeNull();
  });
});
