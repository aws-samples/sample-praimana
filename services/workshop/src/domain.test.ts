import { describe, it, expect } from "vitest";
import {
  sanitizeEnabledAssistants,
  VALID_ASSISTANTS,
  WORKSHOP_STATUSES,
  ZeroWorkshopStats,
} from "./domain.js";

/**
 * sanitizeEnabledAssistants has one non-obvious invariant: it must NEVER return an
 * empty list. An empty enabledAssistants would lock every participant out of every
 * AI assistant for that workshop — a silent, total loss of the product's function
 * with no error anywhere. Absent, empty, and wholly-invalid input therefore all
 * mean "all assistants", not "none". These tests pin that fail-OPEN default, which
 * is the opposite of the fail-closed stance the authz code takes, and deliberately
 * so: this is a feature toggle, not a permission.
 */
describe("sanitizeEnabledAssistants", () => {
  it("keeps a valid subset, preserving only recognised assistants", () => {
    expect(sanitizeEnabledAssistants(["claude", "kiro"])).toEqual(["claude", "kiro"]);
  });

  it("drops unrecognised assistants", () => {
    expect(sanitizeEnabledAssistants(["claude", "not-a-real-assistant"])).toEqual([
      "claude",
    ]);
  });

  it("de-duplicates", () => {
    expect(sanitizeEnabledAssistants(["claude", "claude", "kiro"])).toEqual([
      "claude",
      "kiro",
    ]);
  });

  it("defaults to ALL assistants for absent input", () => {
    expect(sanitizeEnabledAssistants(undefined)).toEqual([...VALID_ASSISTANTS]);
    expect(sanitizeEnabledAssistants(null)).toEqual([...VALID_ASSISTANTS]);
  });

  it("defaults to ALL assistants for an empty array", () => {
    expect(sanitizeEnabledAssistants([])).toEqual([...VALID_ASSISTANTS]);
  });

  it("defaults to ALL assistants when every entry is invalid", () => {
    // The dangerous case: a caller sends a list that filters down to nothing. That
    // must not become "no assistants enabled".
    expect(sanitizeEnabledAssistants(["bogus", "also-bogus"])).toEqual([
      ...VALID_ASSISTANTS,
    ]);
  });

  it("defaults to ALL assistants for a non-array of any shape", () => {
    for (const bad of ["claude", 42, {}, true, { claude: true }]) {
      expect(sanitizeEnabledAssistants(bad)).toEqual([...VALID_ASSISTANTS]);
    }
  });

  it("ignores non-string entries mixed into an otherwise valid array", () => {
    expect(sanitizeEnabledAssistants(["claude", 1, null, undefined, {}])).toEqual([
      "claude",
    ]);
  });

  it("returns a fresh array, never a reference to VALID_ASSISTANTS", () => {
    // A caller mutating the result must not corrupt the module-level constant for
    // every subsequent workshop in the same warm Lambda container.
    const result = sanitizeEnabledAssistants(undefined);
    result.push("mutated");
    expect(VALID_ASSISTANTS).not.toContain("mutated");
    expect(sanitizeEnabledAssistants(undefined)).toEqual([...VALID_ASSISTANTS]);
  });
});

describe("WORKSHOP_STATUSES", () => {
  it("lists the lifecycle statuses the status route validates against", () => {
    // PATCH /workshops/:id/status rejects anything not in this list, so the list IS
    // the API contract for that route.
    expect([...WORKSHOP_STATUSES]).toEqual([
      "DRAFT",
      "REGISTRATION",
      "ACTIVE",
      "JUDGING",
      "COMPLETED",
      "ARCHIVED",
    ]);
  });
});

describe("ZeroWorkshopStats", () => {
  /**
   * THIS TEST'S EXPECTATION WAS INVERTED, and the bug proved it.
   *
   * It used to assert `{ w1: 0, w2: 0 }`, reasoning that "a MISSING key would render as
   * undefined; an explicit 0 renders as '0 teams'". That is exactly what went wrong: the
   * experiences list showed "0 teams" beside workshops that plainly had teams, because a
   * placeholder's stand-in value was rendered as fact.
   *
   * An unknown count must be ABSENT so the UI can say "—". A stated zero is a claim, and
   * this class is not in a position to make it — it exists precisely because the count
   * lives in another service.
   */
  it("returns NO keys — unknown is absent, never a stated zero", async () => {
    expect(await new ZeroWorkshopStats().teamCounts(["w1", "w2"])).toEqual({});
  });

  it("handles an empty id list", async () => {
    expect(await new ZeroWorkshopStats().teamCounts([])).toEqual({});
  });
});
