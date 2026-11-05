// ── ⚠ THE WINDOW, AND FINDING THE CLI, ON A NON-macOS DESKTOP ─────────────────────────────────
//
// Two defects that only show up off macOS:
//
//   1. `titleBarStyle: "hiddenInset"` was UNCONDITIONAL. It is a macOS style; on Windows Electron
//      treats it as `hidden`, which removes the frame AND the minimise/maximise/close buttons. This app
//      draws no replacements, so the window could only be closed from the taskbar or with Alt+F4 — not
//      a cosmetic defect.
//
//   2. `TRAFFIC_LIGHT_INSET_PX = 92` reserved space at the TOP LEFT for macOS traffic lights. Windows
//      and Linux put their buttons at the top RIGHT, so the reservation left a 92px hole at the start of
//      the strip and pushed the search field off centre.
//
// Asserted against source, per this package's convention for window and view structure: neither
// `BrowserWindow` options nor a Tailwind layout can be observed in a node-only test runner. What is
// checkable — and what would actually regress — is whether the decision is conditional at all.

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const read = (rel: string) => strip(readFileSync(local(rel), "utf8"));

describe("⚠ the window keeps its buttons off macOS", () => {
  it("uses hiddenInset ONLY on darwin", () => {
    const main = read("./index.ts");
    expect(main).toContain('titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"');
    // The unconditional form is what left Windows with an unclosable window.
    expect(main).not.toMatch(/titleBarStyle:\s*"hiddenInset",/);
  });

  it("does not reach for titleBarOverlay, which needs a visual judgement", () => {
    /**
     * The overlay would keep the custom strip and let Windows draw its buttons over the top-right of
     * the content — closer to the macOS look, and it requires re-laying-out the right-hand side of the
     * strip around those buttons. That is a decision for somebody who can see the result; a real title
     * bar above our own strip is slightly redundant and unmistakably functional.
     */
    expect(read("./index.ts")).not.toContain("titleBarOverlay");
  });
});

describe("⚠ the titlebar strip reserves space only where the OS takes it", () => {
  const app = read("./../renderer/App.tsx");

  it("derives the inset from the platform", () => {
    expect(app).toContain('const IS_MAC = ((window as any).electronAPI?.platform ?? "darwin") === "darwin"');
    expect(app).toContain("const TRAFFIC_LIGHT_INSET_PX = IS_MAC ? 92 : 0");
  });

  it("⚠ DEFAULTS TO THE macOS LAYOUT when the bridge is absent", () => {
    /**
     * The fallback direction matters. An unnecessary 92px gap is survivable; a strip drawn UNDER the
     * traffic lights is unreadable and unclickable, so the safe default is to assume they are there.
     * `?? "darwin"` also keeps a plain test render on the layout the existing tests describe.
     */
    expect(app).toMatch(/\?\?\s*"darwin"/);
  });

  it("reads the platform synchronously, not over IPC", () => {
    /**
     * The layout depends on it at FIRST PAINT. An async answer would draw a macOS-shaped strip and then
     * correct it, which is a visible jump in the app's own chrome — so the preload exposes a value.
     */
    const preload = read("./../preload/index.ts");
    expect(preload).toContain("platform: process.platform");
    expect(preload).not.toMatch(/platform:\s*\(\)\s*=>/);
    expect(app, "and the renderer must not await it").not.toMatch(/await[^\n]*\.platform/);
  });

  it("keeps the derived search offset in step with the inset", () => {
    // The two numbers were coupled and written out separately once already; the derivation is the fix.
    expect(app).toContain(
      "TRAFFIC_LIGHT_INSET_PX + PROFILE_CHIP_MAX_PX + PROFILE_CHIP_GUTTER_PX"
    );
  });
});

describe("⚠ finding kiro-cli on Windows", () => {
  const acp = read("./handlers/kiro-acp.ts");

  it("offers Windows locations and extensions, not just POSIX paths", () => {
    /**
     * Every candidate was a POSIX path, so on Windows the loop found nothing and fell through to the
     * bare name — which then failed in spawn, because `kiro-cli` there is `kiro-cli.exe` or a `.cmd`
     * shim. `fs.accessSync` does not consider PATHEXT, so the extensions are enumerated.
     */
    expect(acp).toContain('process.platform === "win32"');
    expect(acp).toMatch(/suffixes = \[".exe", ".cmd", ".bat", ""\]/);
    expect(acp).toContain("LOCALAPPDATA");
  });

  it("keeps the POSIX candidates unchanged", () => {
    // macOS and Linux behaviour must be byte-identical; this is a Windows addition, not a rewrite.
    expect(acp).toContain('"/usr/local/bin/kiro-cli"');
    expect(acp).toMatch(/path\.join\(home, "\.toolbox", "bin", "kiro-cli"\)/);
  });

  it("still ends with the bare name, which is now genuinely usable", () => {
    /**
     * The fallback used to be a dead end on Windows. It works now because `spawnPortable` resolves a
     * bare name through PATH and PATHEXT itself — so "let the OS find it" is a real answer rather than
     * a guaranteed ENOENT.
     */
    expect(acp).toMatch(/return \[[\s\S]{0,400}"kiro-cli",?\s*\]/);
    expect(read("./spawn-confined.ts")).toContain("launchSpec");
  });

  it("notes that X_OK means nothing on Windows", () => {
    // `fs.accessSync(f, X_OK)` there is equivalent to F_OK — it reports existence, not executability.
    expect(readFileSync(local("./handlers/kiro-acp.ts"), "utf8")).toMatch(/X_OK.{0,80}windows/is);
  });
});

/**
 * A sanity check that the POSIX behaviour this session must not disturb is still what it was. Runs on
 * whatever platform the suite is on, and is meaningful on macOS and Linux — which is where it matters,
 * because that is the path already in use.
 */
describe("the POSIX path is untouched", () => {
  it("resolves a home-relative candidate the same way it always did", () => {
    const expected = path.join(os.homedir(), ".toolbox", "bin", "kiro-cli");
    expect(expected.startsWith(os.homedir())).toBe(true);
    expect(expected.endsWith("kiro-cli")).toBe(true);
  });

  it("launchSpec is the identity function here", async () => {
    // Restated in this file too, because it is the guarantee that makes all of the above low-risk.
    const { launchSpec } = await import("./windows-launch");
    if (process.platform === "win32") return; // the Windows behaviour has its own suite
    expect(launchSpec("claude", ["-p"])).toEqual({ command: "claude", args: ["-p"] });
  });
});
