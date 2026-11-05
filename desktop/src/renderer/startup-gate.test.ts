// ── ⚠ NO SCREEN IS CHOSEN BEFORE THE GATES ARE KNOWN ──────────────────────────────────────────
//
// `App` routes through a chain of gates — platform configured, connected, team joined, setup complete —
// and three of them were initialised to `false`. `false` is a MEANINGFUL ANSWER, so as soon as the first
// gate resolved the chain routed on three values nothing had read yet:
//
//     platformConfigured=true, connected=false                → SignInView          (one IPC)
//     …connected=true, teamJoined=false                       → JoinTeamView        (one IPC)
//     …teamJoined=true, setupComplete=false ← INITIAL VALUE    → SelectAssistantView (a NETWORK call)
//
// The first two flashed for a same-machine round-trip and nobody noticed. The third was held across
// `checkTeamAccess()` — a request to the server — which is the "few seconds" in the report and why the
// ASSISTANT screen was the one that showed rather than the two before it.
//
// ⚠ TWO INDEPENDENT PROPERTIES FIX IT AND BOTH ARE PINNED HERE. The gates are `boolean | null` so
// "unknown" is expressible, and the blank guard waits for all four rather than only the platform one.
// Either alone leaves the bug: nullable types with a one-gate guard still route on `null` (falsy), and a
// four-gate guard over booleans has nothing to wait for.
//
// ⚠ ASSERTED AGAINST THE SOURCE. Rendering `App` needs the whole preload bridge, a database and a
// network, and the property is about INITIAL state and the order of a chain — which is what the file
// says rather than what one render happens to show. The same technique profile-chooser-gate.test.ts uses
// for its own early-return ordering.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
/** Comments discuss these gates at length; only code counts. */
const code = APP.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** The four values the render chain routes on. */
const GATES = [
  ["platformConfigured", "setPlatformConfigured"],
  ["connected", "setConnected"],
  ["teamJoined", "setTeamJoined"],
  ["setupComplete", "setSetupComplete"],
] as const;

describe("⚠ every startup gate can express 'not asked yet'", () => {
  for (const [name, setter] of GATES) {
    it(`${name} starts as null, not as a meaningful answer`, () => {
      const decl = new RegExp(
        `const \\[${name}, ${setter}\\] = useState<boolean \\| null>\\(null\\)`
      );
      expect(
        decl.test(code),
        `${name} must be useState<boolean | null>(null) — a boolean cannot say "unknown", ` +  // nosemgrep: html-in-template-string
          `and \`false\` routes the chain`
      ).toBe(true);
    });
  }
});

describe("⚠ the boot gate waits for all four gates AND the first load", () => {
  /**
   * The guard, from its condition to its return.
   *
   * ⚠ ANCHORED ON `booting`, WHICH IS NOW THE FIRST TERM. A first version anchored on
   * `platformConfigured === null` and so sliced from AFTER `booting ||` — the assertion that the gate
   * waits for the first load then failed against a guard that does wait for it.
   */
  const guard = (() => {
    const at = code.indexOf("booting ||");
    expect(at, "the guard must exist").toBeGreaterThan(-1);
    return code.slice(at, code.indexOf(";", code.indexOf("return", at)));
  })();

  for (const [name] of GATES) {
    it(`waits for ${name}`, () => {
      expect(
        guard,
        `${name} missing from the guard means the chain routes before it is read`
      ).toContain(`${name} === null`);
    });
  }

  /**
   * ⚠ AHEAD OF EVERY GATE IN THE CHAIN. A guard placed after the first `if (!platformConfigured)` would
   * let that branch render before the others were known, which is the bug with one fewer screen in it.
   */
  it("comes before the first routing decision", () => {
    const guardAt = code.indexOf("platformConfigured === null");
    const firstRoute = code.indexOf("if (!platformConfigured)");
    expect(firstRoute, "the chain must exist").toBeGreaterThan(-1);
    expect(guardAt, "the guard has to precede the chain it protects").toBeLessThan(firstRoute);
  });

  /**
   * ⚠ ALSO WAITS FOR THE FIRST LOAD, WHICH THE GATES ALONE DID NOT COVER. Making them nullable stopped
   * the chain routing before the four SETTINGS were read — and revealed the next screen behind it —
   * the add-project screen showed for a few seconds: `loadProjects()` runs last in `checkState`,
   * so the shell painted with no active project until it landed.
   */
  it("⚠ waits for the first checkState to finish, not just the settings reads", () => {
    expect(
      guard,
      "the projects read and the team probe are inside checkState, not in any gate"
    ).toContain("booting");
  });

  /**
   * ── ⚠ IT IS A LOADING SCREEN NOW, AND THE OLD ASSERTION SAID THE OPPOSITE ─────────────────────
   *
   * This case used to read "renders nothing rather than a spinner", and that was RIGHT when it was
   * written: the gate then spanned a single local IPC round-trip, and a spinner appearing and vanishing
   * inside a frame is flicker rather than feedback.
   *
   * What changed is the wait, not the taste. The gate now covers the projects read and the team-access
   * probe — a network call, bounded at 4s by the docs service's own READ_TIMEOUT_MS — and seconds of
   * blank window reads as a hung app. So a loading screen masks the background and closes when the
   * desktop is fully loaded.
   *
   * The old reasoning is kept above rather than deleted, because "blank is correct for one IPC" is still
   * true and is the thing to re-read if this gate is ever narrowed again.
   */
  it("⚠ renders the loading screen, which replaced a deliberately blank div", () => {
    expect(guard).toContain("<LoadingView />");
  });
});

/**
 * ── ⚠ THE SPLASH CANNOT OUTLIVE A FAILED LAUNCH ───────────────────────────────────────────────
 *
 * The hazard introduced by gating first paint on a whole async function: if it rejects, the flag never
 * clears and the loading screen is permanent. A hung app is strictly worse than the flash this replaced,
 * so the dismissal lives in a `finally` at the call site rather than at the end of `checkState`.
 */
describe("⚠ the loading screen is always dismissed", () => {
  /**
   * ⚠ SLICED FORWARD FROM THE CALL, NOT TO THE FIRST `}, []);` IN THE FILE. A first version searched for
   * that terminator from position zero and found an EARLIER effect's, producing an empty slice that
   * failed against correct code. `indexOf` without a start offset is the trap here.
   */
  const mount = (() => {
    const at = code.indexOf("checkState()");
    expect(at, "the mount call must exist").toBeGreaterThan(-1);
    return code.slice(at, at + 400);
  })();

  it("clears the flag in a finally, so a rejection cannot strand it", () => {
    expect(mount, "the first load must be awaited somewhere that always settles").toMatch(
      /\.finally\(\(\) => setBooting\(false\)\)/
    );
  });

  it("logs a failed launch rather than swallowing it", () => {
    // A launch that could not read its own state will misroute; the console line is the only clue.
    expect(mount).toMatch(/\.catch\(/);
  });

  /**
   * ⚠ NEVER SET BACK TO TRUE. `checkState` re-runs on sign-out, assistant changes and folder switches;
   * blanking the whole app to a splash on each of those would be a far worse flicker than the one being
   * fixed. The flag describes the FIRST load only.
   */
  it("⚠ is never raised again after the first load", () => {
    const raises = [...code.matchAll(/setBooting\(true\)/g)];
    expect(raises, "a later re-check must not blank the app").toEqual([]);
  });
});
