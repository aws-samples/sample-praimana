// ── WHICH READS EACH TAB NEEDS ───────────────────────────────────────────────────────────
//
// Two reported edges, both encoded here rather than in an effect no test in this package can observe
// (vitest runs in `node`, so there is no DOM to render into).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadsForTab } from "./git-tab-loads";

describe("⚠ the tab the panel OPENS on must fetch its own status", () => {
  /**
   * `gitStatus` was loaded only by `loadGit()`, which runs for the LOG tab — so on Actions the status was
   * null, leaving the Changes list empty AND the header's branch and dirty count blank, on the one surface
   * where they matter most.
   */
  it("actions fetches status, and nothing else", () => {
    expect(loadsForTab("actions")).toEqual({ status: true, log: false, diff: false });
  });
});

describe("⚠ the log tab must not fetch status twice", () => {
  /**
   * `loadGit()` already fetches status alongside the log in one `Promise.all`. A separate status call
   * here would be a second request for the same bytes — waste, not safety.
   */
  it("log fetches the log, which carries status with it", () => {
    const loads = loadsForTab("log");
    expect(loads.log).toBe(true);
    expect(loads.status).toBe(false);
  });

  it("diff fetches only the diff", () => {
    expect(loadsForTab("diff")).toEqual({ status: false, log: false, diff: true });
  });

  it("every tab fetches something, so none opens blank", () => {
    for (const tab of ["actions", "log", "diff"] as const) {
      const loads = loadsForTab(tab);
      expect(Object.values(loads).some(Boolean), `${tab} fetches nothing`).toBe(true);
    }
  });
});

/**
 * ── ⚠ WHEN THE PANEL MAY ASK AT ALL ───────────────────────────────────────────────────────────
 *
 * `loadsForTab` answers WHICH reads a tab needs; it cannot know whether there is a repository to
 * read. The effect asked regardless, so a plain folder produced three git invocations whose only
 * possible outcome was three rejections — absorbed by `catch` blocks in the renderer and logged as
 * stack traces from main. `git:status` answers for that case now, but the log and diff handlers
 * still reject, and asking a question already answered is waste either way.
 *
 * Asserted against source: the gate lives in an effect, and this package's vitest runs in `node`
 * with no DOM to render one in.
 */
describe("⚠ no git read is issued before the repository question is answered", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../components/GitPanel.tsx", import.meta.url)),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  const effect = src.slice(src.indexOf("const loads = loadsForTab(tab)") - 1200);

  it("returns early unless the folder is known to be a repository", () => {
    /**
     * `isRepo !== true`, not `!isRepo`: `null` is "the answer has not arrived", and the two must not
     * collapse — one is temporary and one is final.
     */
    expect(effect).toMatch(/if \(isRepo !== true\) return;/);
    expect(
      effect.indexOf("if (isRepo !== true) return;"),
      "the gate precedes the loads it guards"
    ).toBeLessThan(effect.indexOf("const loads = loadsForTab(tab)"));
  });

  it("re-runs once that answer arrives", () => {
    // Without `isRepo` in the dependency array the gate would latch shut: the effect runs while the
    // answer is still null and never again for that folder, so a real repository would never load.
    const deps = src.match(/\}, \[tab, projectPath, isRepo[^\]]*\]\)/);
    expect(deps, "isRepo is a dependency of the load effect").not.toBeNull();
    /**
     * `refreshSignal` joined the SAME effect rather than getting one of its own, so that an outside
     * write (the framework install during a folder switch) re-reads through the rules already encoded
     * here: only the open tab's loads, and only once the repository question is answered.
     */
    expect(deps![0], "and so is the outside-write signal").toContain("refreshSignal");
  });
});

/**
 * ── ⚠ AND THE TREE RE-READS WITHOUT BEING DESTROYED ───────────────────────────────────────────
 *
 * The same signal drives FileTree. Two ways to refresh a component from outside it, and only one keeps
 * the state a participant built up: a remount `key` throws away which folders are expanded and every
 * listing behind them, while a watched counter re-reads what is open.
 */
describe("⚠ the tree refreshes on the signal, not on its own mount", () => {
  const tree = readFileSync(
    fileURLToPath(new URL("../components/FileTree.tsx", import.meta.url)),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("re-reads when the signal changes", () => {
    expect(tree).toMatch(/if \(refreshSignal === seenSignal\.current\) return;/);
    expect(tree).toMatch(/seenSignal\.current = refreshSignal;[\s\S]{0,40}refreshAll\(\)/);
  });

  /**
   * ⚠ THE GUARD IS SEEDED FROM THE PROP, NOT FROM ZERO. This component mounts with whatever the counter
   * has already reached — 3 by the third switch — so `useRef(0)` or a `> 0` test would fire a full
   * re-read on top of the initial load, doubling the disk work of every switch after the first.
   */
  it("seeds its guard from the incoming value, so mounting is not a refresh", () => {
    expect(tree).toMatch(/useRef\(refreshSignal\)/);
    expect(tree, "not a zero seed").not.toMatch(/seenSignal = useRef\(0\)/);
  });

  it("refreshes what is open rather than the whole subtree", () => {
    // `refreshAll` walks the root plus the expanded folders only — a `node_modules` nobody opened is
    // never read. The toolbar's Refresh button follows the same rule.
    expect(tree).toMatch(/void refreshAll\(\)/);
  });
});
