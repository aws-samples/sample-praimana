import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠ `app.isPackaged` IS NOW AN INPUT, so it has to be drivable.
 *
 * Outside Electron the real `electron` package exports an `app` of `undefined`, which the module reads
 * as "not packaged" — correct, and what every OTHER test in this file relies on. This mock exists only
 * so one case can assert the packaged branch.
 */
let packaged = false;
vi.mock("electron", () => ({ app: { get isPackaged() { return packaged; } } }));

/**
 * PER-AREA DEBUG LOGGING.
 *
 * ── ⚠ THOSE LINES WERE ALREADY GATED ──
 *
 * `debugLog` has always been a no-op unless debugging is on. They print because `vite-plugin-electron` sets
 * `NODE_ENV=development`, so the gate is open by design during `pnpm dev` — the only way this app is currently
 * run. The fix is a FINER gate, not a new one, and the diagnosis mattered: without it the obvious move is to
 * delete the calls.
 *
 * ── WHY NOT DELETE THEM ──
 *
 * The `[claude-code]` block is the whole diagnosis for "Not logged in · Please run /login" and for the
 * `AWS_REGION: us-west-2` mismatch. Both took several rounds to find; both were found BY those lines. Deleting
 * them makes the next occurrence as expensive as the first.
 *
 * ── WHAT THIS FILE GUARDS ──
 *
 * Two things a comment cannot: that the scope list matches the prefixes the code ACTUALLY emits, and that the
 * two named areas are genuinely silent while everything else still speaks.
 */

const MAIN_DIR = join(__dirname);

/** Every non-test `.ts` under `src/main`, recursively. */
function mainSources(dir = MAIN_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...mainSources(full));
    } else if (entry.endsWith(".ts") && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/** The `[prefix]` of every `debugLog("[x] …")` in the main process, with counts. */
function emittedPrefixes(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of mainSources()) {
    const src = readFileSync(file, "utf8");
    // Across newlines: several calls wrap their first argument onto the next line, and my first version of this
    // audit missed five of them for exactly that reason.
    for (const m of src.matchAll(/debugLog\(\s*(["`'])\[([a-z-]+)\]/gs)) {
      counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
    }
  }
  return counts;
}

describe("⚠ THE SCOPE LIST MATCHES WHAT THE CODE EMITS", () => {
  const SOURCE = readFileSync(join(MAIN_DIR, "debug-log.ts"), "utf8");
  const listed = new Set(
    [...(SOURCE.match(/const ALL_SCOPES: DebugScope\[\] = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1]
    )
  );

  it("every prefix the code emits is a known scope", () => {
    /**
     * A prefix that is NOT listed always prints, whatever the operator asks for. My first version omitted
     * `claude-settings`, so that line would have kept logging while appearing to be covered.
     */
    const emitted = [...emittedPrefixes().keys()];
    const unlisted = emitted.filter((p) => !listed.has(p));
    expect(unlisted, "these prefixes cannot be silenced").toEqual([]);
  });

  it("⚠ AND NO SCOPE IS DEAD — every listed name is actually emitted", () => {
    /**
     * THE OTHER DIRECTION, AND THE ONE I GOT WRONG. My first list invented `sync` and `settings`; no call site
     * emits either. A dead scope is worse than a missing one: it looks like a control, appears in the
     * documentation, and silences nothing when an operator reaches for it.
     *
     * Found by enumerating the prefixes rather than by reading the handlers.
     */
    const emitted = new Set(emittedPrefixes().keys());
    const dead = [...listed].filter((s) => !emitted.has(s));
    expect(dead, "these scopes control nothing").toEqual([]);
  });

  it("the two noisy startup areas are OFF by default", () => {
    const defaults = SOURCE.match(/const DEFAULT_SCOPES: DebugScope\[\] = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect(defaults, "could not parse DEFAULT_SCOPES").toBeTruthy();
    expect(defaults).not.toContain('"kiro-acp"');
    expect(defaults).not.toContain('"claude-code"');
  });

  it("and they are still the biggest sources of output, which is why", () => {
    // Scale, asserted so the rationale in the source is checkable rather than a claim: these two are the noisy
    // ones because they log on every launch, not in response to an event.
    const counts = emittedPrefixes();
    expect((counts.get("kiro-acp") ?? 0) + (counts.get("claude-code") ?? 0)).toBeGreaterThan(20);
  });
});

describe("what actually prints", () => {
  /**
   * `debug-log.ts` reads its environment ONCE at module load, so each case re-imports it with `resetModules`.
   * Without that, the first test's environment would decide every later one — and the module would look
   * correct while being untested.
   */
  const original = { ...process.env };
  let logged: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    logged = [];
    spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    process.env = { ...original };
  });

  async function load(env: Record<string, string | undefined>) {
    process.env = { ...original, NODE_ENV: "development", ...env };
    return import("./debug-log.js");
  }

  const SAMPLE_LINES = [
    ["[kiro-acp] Spawning:", "/Users/x/.toolbox/bin/kiro-cli acp --trust-all-tools"],
    ["[kiro-acp] Process exited with code:", "255"],
    ["[claude-code] settings sources:", "a.json, b.json"],
    ["[claude-code] AWS_REGION (from settings):", "us-west-2"],
  ] as const;

  it("⚠ SILENCES EVERY ONE OF THESE LINES", async () => {
    // Asserted verbatim rather than by scope name — this is the observable outcome.
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: undefined });
    for (const line of SAMPLE_LINES) debugLog(...line);
    expect(logged).toEqual([]);
  });

  /**
   * ⚠ `telemetry` IS THE DEFAULT-ON STAND-IN THROUGHOUT THIS FILE, and it used to be `pty`. That scope went
   * with the embedded terminal, and the swap is not cosmetic: these tests need a scope that is ON by default
   * to prove the two default-OFF ones (`claude-code`, `kiro-acp`) are being singled out rather than everything
   * being muted. Reaching for `claude-code` here would make several of them pass for the wrong reason.
   */
  it("keeps the areas that only speak when something happens", async () => {
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: undefined });
    debugLog("[cli-assistant] STDERR:", "something went wrong");
    debugLog("[telemetry] write failed:", "disk full");
    expect(logged).toHaveLength(2);
  });

  it("⚠ AN UNPREFIXED LINE ALWAYS PRINTS", async () => {
    /**
     * The safe default, and a deliberate one: an ungated line is noise, but a silently swallowed one is a
     * diagnostic that no longer exists. A future `debugLog("something")` with no prefix is visible rather than
     * invisible.
     */
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: undefined });
    debugLog("no prefix here");
    debugLog("[unknown-area] not a scope we know");
    expect(logged).toHaveLength(2);
  });

  it("⚠ AND PRINTS EVEN WHEN EVERY SCOPE IS OFF, and for a NON-STRING first argument", () => {
    /**
     * Mutation testing found this gap. The previous test passed with the default scopes active, so an
     * implementation that swallowed unprefixed lines could still have printed these two by some other route —
     * and `none` is the case where the distinction actually bites.
     *
     * The non-string case matters too: `debugLog(err)` and `debugLog({ state })` are natural things to write,
     * and a scope check that assumed a string first argument would drop them silently.
     */
    return load({ DESKTOP_DEBUG_SCOPES: "none" }).then(({ debugLog }) => {
      debugLog("no prefix, nothing enabled");
      debugLog(new Error("an object first argument"));
      debugLog({ some: "state" }, "and a trailing string");
      expect(logged).toHaveLength(3);
    });
  });

  it("`all` restores the previous behaviour", async () => {
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: "all" });
    for (const line of SAMPLE_LINES) debugLog(...line);
    expect(logged).toHaveLength(SAMPLE_LINES.length);
  });

  it("one area can be re-enabled on its own", async () => {
    // The point of scoping rather than deleting: when a login problem returns, this is how the diagnosis comes
    // back without the rest of the noise.
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: "claude-code" });
    debugLog("[claude-code] settings sources:", "a.json");
    debugLog("[kiro-acp] Spawning:", "kiro-cli");
    expect(logged).toEqual(["[claude-code] settings sources: a.json"]);
  });

  it("accepts a comma- or space-separated list", async () => {
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: "claude-code, kiro-acp" });
    debugLog("[claude-code] one");
    debugLog("[kiro-acp] two");
    debugLog("[telemetry] three");
    expect(logged).toEqual(["[claude-code] one", "[kiro-acp] two"]);
  });

  it("`none` silences everything that has a scope", async () => {
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: "none" });
    debugLog("[claude-code] one");
    debugLog("[telemetry] two");
    expect(logged).toEqual([]);
  });

  it("⚠ AN UNKNOWN NAME IS NOT SILENTLY ACCEPTED AS A SCOPE", async () => {
    /**
     * The filter against `ALL_SCOPES` is what makes this true, and mutation testing showed that `debugLog`
     * alone CANNOT observe it: an unknown name in the active set mutes exactly the same lines as an empty set,
     * because no message carries that prefix. The difference only shows through `debugEnabledFor`, which a
     * caller uses to decide whether to BUILD a diagnostic.
     *
     * Without the filter, `debugEnabledFor("claude_code" as DebugScope)` would return true and a caller would
     * assemble a dump that `debugLog` then discarded — work with no reader, which is the thing that helper
     * exists to prevent.
     */
    vi.resetModules();
    process.env = { ...original, NODE_ENV: "development", DESKTOP_DEBUG_SCOPES: "claude_code" };
    const { debugEnabledFor } = await import("./debug-log.js");
    expect(debugEnabledFor("claude_code" as never), "a typo is not a scope").toBe(false);
    expect(debugEnabledFor("claude-code"), "and the real one stays off").toBe(false);
  });

  it("⚠ A TYPO ENABLES NOTHING rather than disabling everything", async () => {
    /**
     * The failure direction that matters. `claude_code` (underscore) is not a scope; the result should be that
     * the operator's chosen area stays quiet and they go looking for why — NOT that the four default areas are
     * silently muted as a side effect.
     */
    const { debugLog } = await load({ DESKTOP_DEBUG_SCOPES: "claude_code" });
    debugLog("[claude-code] one");
    debugLog("[telemetry] two");
    expect(logged, "nothing scoped survives an unrecognised name").toEqual([]);
    debugLog("unprefixed still prints");
    expect(logged).toEqual(["unprefixed still prints"]);
  });

  it("⚠ IS STILL COMPLETELY SILENT IN A PACKAGED BUILD", async () => {
    /**
     * The original guarantee, which must survive the new one: outside development and without `DESKTOP_DEBUG`,
     * nothing is logged at all — including areas that are on by default, and including unprefixed lines. These
     * diagnostics disclose file paths and command arguments, so a shipped app must not print them.
     */
    process.env = { ...original };
    delete process.env.DESKTOP_DEBUG;
    delete process.env.DESKTOP_DEBUG_SCOPES;
    process.env.NODE_ENV = "production";
    const { debugLog } = await import("./debug-log.js");
    debugLog("[telemetry] would normally print");
    debugLog("unprefixed would normally print");
    expect(logged).toEqual([]);
  });

  /**
   * ⚠ THE TITLE USED TO SAY "a packaged build" AND THE TEST DID NOT TEST ONE — it set
   * `NODE_ENV=production`, which is not the same fact. That gap is precisely the finding: production
   * is a build-time intention, packaged is a property of the executable, and only the second one an
   * environment variable cannot forge.
   */
  it("DESKTOP_DEBUG opts an UNPACKAGED build in", async () => {
    process.env = { ...original, NODE_ENV: "production", DESKTOP_DEBUG: "1" };
    delete process.env.DESKTOP_DEBUG_SCOPES;
    const { debugLog } = await import("./debug-log.js");
    debugLog("[telemetry] now visible");
    expect(logged).toEqual(["[telemetry] now visible"]);
  });

  /**
   * ── ⚠ THE HARD GATE ──────────────────────────────────────────────────────────────────────
   *
   * Both variables are set as hostilely as a local process can set them, and the shipped app stays silent —
   * including the areas that are on by default, and including an unprefixed line, which the scope filter
   * never blocks.
   */
  it("⚠ A PACKAGED BUILD IGNORES BOTH VARIABLES ENTIRELY", async () => {
    packaged = true;
    try {
      process.env = {
        ...original,
        NODE_ENV: "development",
        DESKTOP_DEBUG: "1",
        DESKTOP_DEBUG_SCOPES: "all",
      };
      const { debugLog, debugEnabledFor } = await import("./debug-log.js");
      debugLog("[kiro-acp] Spawning:", "/Users/x/.toolbox/bin/kiro-cli", "acp");
      debugLog("[telemetry] would normally print");
      debugLog("unprefixed would normally print");
      expect(logged).toEqual([]);
      // And the predicate agrees, so a caller does not assemble a dump it will then discard.
      expect(debugEnabledFor("kiro-acp")).toBe(false);
    } finally {
      packaged = false;
    }
  });
});

describe("debugEnabledFor", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("answers for a scope, so an expensive diagnostic can be skipped", async () => {
    // Assembling a settings dump and then discarding it is work with no reader.
    vi.resetModules();
    process.env = { ...original, NODE_ENV: "development" };
    delete process.env.DESKTOP_DEBUG_SCOPES;
    const { debugEnabledFor } = await import("./debug-log.js");
    expect(debugEnabledFor("claude-code")).toBe(false);
    expect(debugEnabledFor("telemetry")).toBe(true);
  });

  it("is false for everything when debugging is off", async () => {
    vi.resetModules();
    process.env = { ...original, NODE_ENV: "production" };
    delete process.env.DESKTOP_DEBUG;
    delete process.env.DESKTOP_DEBUG_SCOPES;
    const { debugEnabledFor } = await import("./debug-log.js");
    expect(debugEnabledFor("telemetry")).toBe(false);
  });
});
