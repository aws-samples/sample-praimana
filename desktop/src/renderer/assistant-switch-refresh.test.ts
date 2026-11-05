// ── ⚠ SWITCHING ASSISTANT WRITES INTO THE OPEN FOLDER, AND NOTHING RE-READ IT ─────────────────
//
// The framework ships different files per assistant, so Settings re-runs `framework:install` — which
// copies a tree into the project the file panel is already displaying. The existing `onAssistantChanged`
// callback looks like it should cover this and cannot: it leads to `checkState()`, which re-reads the
// settings and reloads the projects row, but the project's PATH is unchanged. Everything keyed on
// `rootPath` therefore has no reason to re-read, and the tree keeps showing the folder as it was.
//
// ⚠ THE FOLDER-SWITCH PATH WAS FIXED FIRST AND THIS ONE WAS MISSED, which is why the assertions below
// are about the SECOND caller rather than the mechanism: `folderRefresh` already existed and worked. A
// third framework-install site would have the same gap, so the test names the property — every install
// site tells the folder-reading views to re-read.
//
// Asserted against source: this package's vitest is node-only, so there is no DOM to render into.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const SETTINGS = readFileSync(local("./components/SettingsView.tsx"), "utf8");
const settings = strip(SETTINGS);
const app = strip(readFileSync(local("./App.tsx"), "utf8"));

/**
 * The assistant-switch handler alone.
 *
 * ⚠ THE END MARKER IS SEARCHED *FROM THE START INDEX*. `return (` also appears in a helper above this
 * function, so a bare `indexOf` gave an earlier offset, a negative-length slice, and an empty string —
 * against which every assertion below passed as vacuously as it failed. Bounded explicitly instead.
 */
const handler = (() => {
  const start = settings.indexOf("async function handleSwitchAssistant");
  expect(start, "handleSwitchAssistant still exists").toBeGreaterThan(-1);
  const end = settings.indexOf("return (", start);
  expect(end, "the render still follows it").toBeGreaterThan(start);
  return settings.slice(start, end);
})();

describe("⚠ every framework install tells the folder views to re-read", () => {
  it("the assistant switch reports its writes", () => {
    expect(handler, "the install is here").toMatch(/api\.frameworkInstall\(/);
    expect(handler, "and so is the notification").toMatch(/onProjectFilesChanged\?\.\(\)/);
  });

  /**
   * ⚠ IN `finally`, WHICH IS THE WHOLE POINT. The distribution is copied in BEFORE the step that can
   * fail (the agent), so a failed install leaves real files on disk — `.codex` among them. Notifying
   * only on success would hide exactly the half-finished state somebody needs to see, and the early
   * `return` that used to sit in the error branch would have skipped it entirely.
   */
  it("reports them even when the install fails", () => {
    const install = handler.slice(handler.indexOf("api.frameworkInstall("));
    const finallyBlock = install.slice(install.indexOf("} finally {"));
    expect(finallyBlock, "the notification is inside the finally").toMatch(
      /onProjectFilesChanged\?\.\(\)/
    );
  });

  /**
   * ⚠ AND THE SWITCH ITSELF IS NO LONGER ABANDONED ON A FAILED INSTALL. `cliSetAssistant` has already
   * written `ai_assistant` and `ai_command` by this point, so returning early left main running the new
   * assistant while this screen still named the old one as current — the same defect, and the same fix,
   * as the folder-switch path.
   */
  it("does not abandon a switch that already happened", () => {
    const install = handler.slice(handler.indexOf("api.frameworkInstall("));
    const errorBranch = install.slice(
      install.indexOf("if (result.error)"),
      install.indexOf("} finally {")
    );
    expect(errorBranch, "the failure is reported").toMatch(/setSwitchStatus\(/);
    expect(errorBranch, "and the handler continues").not.toMatch(/\breturn\b/);
  });

  it("is wired to the same counter the folder switch uses", () => {
    // One mechanism, two callers. A second counter would be a second thing to forget to bump.
    expect(app).toMatch(/onProjectFilesChanged=\{\(\) => setFolderRefresh\(\(n\) => n \+ 1\)\}/);
  });
});

/**
 * ── ⚠ THE SAME BLOCKER, AND A HANDOVER TO THE ASSISTANT ───────────────────────────────────────
 *
 * The hazard is identical to the folder switch's: this install runs an assistant turn in the folder the
 * participant is looking at. What is NOT identical is where they end up — a folder switch leaves them
 * where they were, while an assistant switch is done from a settings form whose work is finished.
 */
describe("⚠ the assistant switch blocks, then hands over", () => {
  it("raises the shell's overlay rather than one of its own", () => {
    /**
     * A local overlay could not cover the app: rendered inside the settings view it would be clipped by
     * that view's own scroll container and would leave the sidebar and the composer reachable.
     */
    expect(handler).toMatch(/onFrameworkSetupChange\?\.\(check\.name\)/);
    expect(settings, "and no second overlay component").not.toMatch(/FrameworkSetupBlocker/);
  });

  it("lowers it in the finally, so a rejected invoke cannot strand the app", () => {
    const install = handler.slice(handler.indexOf("api.frameworkInstall("));
    const finallyBlock = install.slice(install.indexOf("} finally {"));
    expect(finallyBlock).toMatch(/onFrameworkSetupChange\?\.\(null\)/);
  });

  it("routes to the assistant when the switch completes", () => {
    expect(app).toMatch(/onAssistantChanged=\{\(result\) => \{[\s\S]*?setView\("chat"\)/);
  });

  /**
   * ⚠ THE FAILURE HAS TO SURVIVE THE NAVIGATION. It used to live only in this screen's inline status
   * line, and the screen is now left behind the moment the switch finishes — so a setup failure reported
   * only there would be reported nowhere.
   */
  it("carries a setup failure out to the shell, which is what still has a surface", () => {
    expect(handler, "composed where the framework's name is known").toMatch(
      /setupFailure = `\$\{check\.name\} setup failed/
    );
    expect(handler, "and handed over").toMatch(/onAssistantChanged\?\.\(\{ setupFailure \}\)/);
    expect(app, "the shell reports it").toMatch(/if \(result\?\.setupFailure\) toast\.error/);
  });

  /**
   * ⚠ ONE PROGRESS LISTENER FOR THE WINDOW. Both install paths used to register their own on a channel
   * with no remover in the preload, so the callbacks accumulated for the life of the window and every
   * event fanned out to all of them.
   */
  it("no longer registers a progress listener per switch", () => {
    expect(handler).not.toMatch(/onFrameworkProgress/);
    const shellEffect = app.slice(
      app.indexOf("const [frameworkStep"),
      app.indexOf("const [folderRefresh")
    );
    expect(shellEffect, "the shell owns it").toMatch(
      /api\.onFrameworkProgress\?\.\([\s\S]{0,120}setFrameworkStep\(data\.step\)/
    );
    expect(shellEffect, "registered once, on mount").toMatch(/\}, \[\]\)/);
    /**
     * ⚠ AND IT DETACHES. The preload had no remover at all — that absence is what let the per-switch
     * registrations accumulate — so one was added alongside this. Without the cleanup, React 18's
     * StrictMode double-mount leaves two live handlers in development, which is the same bug in
     * miniature.
     */
    expect(shellEffect, "and detaches on unmount").toMatch(
      /return \(\) => api\.removeFrameworkProgressListeners\?\.\(\)/
    );
  });
});
