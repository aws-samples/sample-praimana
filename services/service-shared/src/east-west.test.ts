import { describe, it, expect, afterEach, vi } from "vitest";
import {
  EAST_WEST_TIMEOUT_MS,
  EAST_WEST_TIMEOUT_DEFAULT_MS,
} from "./east-west.js";

/**
 * The east-west call deadline, and the validation around its env-var override.
 *
 * WHY THIS FILE EXISTS. Set too low, this number causes a real failure: at 800ms it was BELOW the
 * measured 1802ms first-call cost of a cold Lambda reaching the execute-api PrivateLink
 * endpoint, so a facilitator who owned a workshop was told "only the workshop owner can
 * create teams". The probe aborted and the fail-closed catch rendered an authorization
 * FAILURE as an authorization ANSWER.
 *
 * It is now overridable via `EAST_WEST_TIMEOUT_MS` so it can be retuned with a stack
 * update instead of rebuilding six Lambda bundles. That makes it OPERATOR INPUT, and an
 * unvalidated timeout can fail in two directions that both matter:
 *
 *   too low  → reintroduces the original bug (denying legitimate users on cold starts)
 *   too high → restores the unbounded-wait failure the timeout exists to prevent, while
 *              LOOKING like a configured timeout, which is worse than having none
 *
 * So every branch of that parsing is asserted here. The constant is resolved ONCE at
 * module load (Lambda fixes the env for a container's lifetime), which is why these
 * tests re-import the module rather than mutating a live value.
 */

/** Re-imports east-west.js with `EAST_WEST_TIMEOUT_MS` set to `value` (or unset). */
async function loadWith(value: string | undefined) {
  const previous = process.env.EAST_WEST_TIMEOUT_MS;
  if (value === undefined) delete process.env.EAST_WEST_TIMEOUT_MS;
  else process.env.EAST_WEST_TIMEOUT_MS = value;

  // The module caches its resolved constant, so the cache must be dropped for the new
  // env to be read. Without this every case below would silently assert the same value.
  vi.resetModules();
  try {
    return (await import("./east-west.js")) as {
      EAST_WEST_TIMEOUT_MS: number;
      EAST_WEST_TIMEOUT_DEFAULT_MS: number;
    };
  } finally {
    if (previous === undefined) delete process.env.EAST_WEST_TIMEOUT_MS;
    else process.env.EAST_WEST_TIMEOUT_MS = previous;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the shipped default", () => {
  it("is 2500ms — above the measured first-call cost, far below the gateway timeout", () => {
    // Pinned so changing what SHIPS stays a reviewed decision. The two bounds either
    // side are the lesson, and they outlive any future revision of the number itself.
    expect(EAST_WEST_TIMEOUT_DEFAULT_MS).toBe(2500);
    expect(EAST_WEST_TIMEOUT_DEFAULT_MS).toBeGreaterThan(1802);
    expect(EAST_WEST_TIMEOUT_DEFAULT_MS).toBeLessThan(29_000);
  });

  it("is what the effective value resolves to when nothing overrides it", async () => {
    // i.e. adding the env plumbing did not change behaviour by merely existing.
    expect(EAST_WEST_TIMEOUT_MS).toBe(EAST_WEST_TIMEOUT_DEFAULT_MS);
    const m = await loadWith(undefined);
    expect(m.EAST_WEST_TIMEOUT_MS).toBe(2500);
  });

  it("ignores an empty or whitespace-only override", async () => {
    // CloudFormation passes an unset parameter through as "", and a blank string must
    // mean "not configured" rather than parsing to 0 and disabling every timeout.
    for (const blank of ["", "   ", "\n"]) {
      const m = await loadWith(blank);
      expect(m.EAST_WEST_TIMEOUT_MS).toBe(2500);
    }
  });
});

describe("a valid override", () => {
  it("is used as given", async () => {
    const m = await loadWith("4000");
    expect(m.EAST_WEST_TIMEOUT_MS).toBe(4000);
  });

  it("tolerates surrounding whitespace", async () => {
    const m = await loadWith("  3200  ");
    expect(m.EAST_WEST_TIMEOUT_MS).toBe(3200);
  });

  it("accepts the exact boundary values", async () => {
    expect((await loadWith("200")).EAST_WEST_TIMEOUT_MS).toBe(200);
    expect((await loadWith("10000")).EAST_WEST_TIMEOUT_MS).toBe(10_000);
  });
});

describe("a malformed override falls back to the tested default", () => {
  it("rejects non-numeric values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await loadWith("soon");
    expect(m.EAST_WEST_TIMEOUT_MS).toBe(2500);
    expect(warn).toHaveBeenCalled();
  });

  it("rejects a number with trailing junk rather than silently truncating it", async () => {
    // The parseInt trap: parseInt("2500abc") is 2500, so a typo would be accepted as a
    // plausible-looking value. Number() gives NaN, which is the honest answer.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadWith("2500abc")).EAST_WEST_TIMEOUT_MS).toBe(2500);
    expect((await loadWith("2.5s")).EAST_WEST_TIMEOUT_MS).toBe(2500);
  });

  it("rejects fractional values", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadWith("2500.5")).EAST_WEST_TIMEOUT_MS).toBe(2500);
  });

  it("rejects Infinity and NaN spellings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["Infinity", "-Infinity", "NaN"]) {
      expect((await loadWith(bad)).EAST_WEST_TIMEOUT_MS).toBe(2500);
    }
  });

  it("warns rather than failing silently", async () => {
    // A misconfigured timeout that falls back QUIETLY is how an environment ends up
    // running a different bound than its stack parameter says.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadWith("nonsense");
    expect(warn.mock.calls[0]?.[0]).toContain("EAST_WEST_TIMEOUT_MS");
  });
});

describe("an out-of-range override falls back to the tested default", () => {
  it("rejects zero and negatives, which would abort every call instantly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // AbortSignal.timeout(0) fires immediately: every east-west call fails, and since
    // the callers are fail-closed, EVERY authorization decision becomes "denied". That
    // is a total outage dressed as a config value.
    for (const bad of ["0", "-1", "-2500"]) {
      expect((await loadWith(bad)).EAST_WEST_TIMEOUT_MS).toBe(2500);
    }
  });

  it("rejects a value at or beyond the function and gateway timeouts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 15000 is the function timeout and 29000 the gateway's, so either would mean the
    // caller is bounded by something else entirely — the exact failure this module was
    // written to prevent, but harder to see because a timeout appears to be set.
    for (const bad of ["10001", "15000", "29000", "300000"]) {
      expect((await loadWith(bad)).EAST_WEST_TIMEOUT_MS).toBe(2500);
    }
  });
});

describe("an override at or below the measured first-call cost", () => {
  it("is ALLOWED but warned about", async () => {
    // Deliberately not refused: once the services run OUTSIDE the VPC the PrivateLink
    // first-call cost disappears and a much tighter bound is correct. Hard-coding a
    // ~1800ms floor would bake today's topology into the code. But it is the exact
    // configuration that caused the incident, so it must not pass in silence.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await loadWith("800");

    expect(m.EAST_WEST_TIMEOUT_MS).toBe(800);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("first-call");
  });

  it("does not warn for a value safely above it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await loadWith("2500");
    expect(m.EAST_WEST_TIMEOUT_MS).toBe(2500);
    expect(warn).not.toHaveBeenCalled();
  });
});
