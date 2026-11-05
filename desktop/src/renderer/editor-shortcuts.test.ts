// ── ⚠ SAVE, CLOSE AND QUICK-OPEN FROM THE KEYBOARD ──────────────────────────────────────────────
//
// ⚠ Cmd+S ALREADY EXISTED AND ONLY HALF-WORKED, which is the part worth pinning. It was bound on the
// `<textarea>`'s `onKeyDown`, so it saved only while the caret was IN the editor — clicking the preview, the
// tab bar or the tree left the same keystroke doing nothing, which reads as a broken shortcut rather than a
// scoped one.
//
// ⚠ ASSERTED AGAINST THE SOURCE. These are `keydown` listeners on `window` whose effects are a save handler, a
// tab-state update and a focus call in another component — jsdom can dispatch the event but has no layout, no
// real focus model and no file to save, so a render test would assert the harness rather than the behaviour.
// Same technique scroll-containment.test.ts argues for.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");

const APP = strip(read("./App.tsx"));
const SEARCH = strip(read("./components/FileSearch.tsx"));

/** The window-level shortcut handler, isolated from the Cmd+B one above it. */
const handler = () => {
  /**
   * Anchored on the early-return guard, which is unique to this handler — the Cmd+B one above it tests the
   * modifier inline. A first version anchored on `const key = ...`, which begins AFTER the guard and so
   * excluded the very line the modifier assertion was looking for.
   */
  const at = APP.indexOf("if (!(e.metaKey || e.ctrlKey)) return");
  expect(at, "the shortcut handler must exist").toBeGreaterThan(-1);
  return APP.slice(at, at + 2200);
};

describe("⚠ the shortcuts are window-level, not field-level", () => {
  it("registers on window keydown rather than as an Electron accelerator", () => {
    /**
     * ⚠ AN ACCELERATOR WOULD FIRE WHILE TYPING — in the assistant composer, a rename field, the search bar.
     * The Cmd+B note in App.tsx already reached this conclusion; these inherit it.
     */
    expect(handler()).not.toMatch(/globalShortcut|accelerator/i);
    expect(APP).toContain('window.addEventListener("keydown", onKey)');
  });

  it("accepts both platforms' modifier", () => {
    expect(handler()).toMatch(/e\.metaKey \|\| e\.ctrlKey/);
  });

  it("reaches the editor by event, so focus does not decide whether saving works", () => {
    expect(handler()).toContain('new CustomEvent("editor:save")');
    expect(APP, "and the editor listens for it").toContain('window.addEventListener("editor:save"');
  });
});

describe("⚠ the text-field guard is per-shortcut, not blanket", () => {
  /**
   * ⚠ Cmd+S MUST STILL WORK WHILE TYPING. There is nothing else it could mean anywhere in this app, and
   * refusing it in the composer would be the same "shortcut is broken" complaint one field along.
   */
  it("⚠ saves even when focus is in a text field", () => {
    const body = handler();
    const save = body.slice(body.indexOf('if (key === "s")'), body.indexOf('if (key === "w"'));
    expect(save, "no typing guard on save").not.toContain("typing");
    expect(save).toContain('new CustomEvent("editor:save")');
  });

  /** Closing and quick-open DO have other meanings mid-typing, so both are guarded. */
  it("does not close a tab or steal focus while typing", () => {
    const body = handler();
    expect(body).toMatch(/if \(key === "w" && !typing\)/);
    expect(body).toMatch(/if \(key === "p" && !typing\)/);
  });

  it("recognises inputs, textareas and contenteditable as typing", () => {
    const body = handler();
    expect(body).toContain('target.tagName === "INPUT"');
    expect(body).toContain('target.tagName === "TEXTAREA"');
    expect(body).toContain("target.isContentEditable");
  });
});

describe("⚠ Cmd+W falls through when there is nothing to close", () => {
  /**
   * On macOS Cmd+W closes the window. Swallowing it with no file open would make this app the one thing that
   * ignores a system-wide shortcut — so the handler returns WITHOUT preventDefault in that case.
   */
  it("⚠ returns before preventDefault when no tab is active", () => {
    const body = handler();
    const close = body.slice(body.indexOf('if (key === "w"'), body.indexOf('if (key === "p"'));
    const bail = close.indexOf("if (!tabs.active) return");
    const prevent = close.indexOf("e.preventDefault()");
    expect(bail, "the bail must exist").toBeGreaterThan(-1);
    expect(bail, "and come before the default is suppressed").toBeLessThan(prevent);
    expect(close).toContain("handleCloseFile(tabs.active)");
  });

  it("re-registers when the active tab changes, so it never closes a stale one", () => {
    expect(APP).toMatch(/\}, \[tabs\.active\]\);/);
  });
});

describe("⚠ the editor ignores a save it cannot honour", () => {
  it("skips a clean, loading or failed buffer", () => {
    const listener = APP.slice(APP.indexOf("const onSaveRequest"), APP.indexOf("const onSaveRequest") + 300);
    expect(listener).toContain("if (loading || error || !dirtyRef.current) return");
  });

  /**
   * ⚠ `dirtyRef`, NOT `dirty`. This listener is registered per render but the guard has to read the CURRENT
   * value — the same trap the changed-on-disk listener documents, where a stale closure read `false` for the
   * life of the tab.
   */
  it("⚠ reads the live dirty flag, not a captured one", () => {
    const listener = APP.slice(APP.indexOf("const onSaveRequest"), APP.indexOf("const onSaveRequest") + 300);
    expect(listener).toContain("dirtyRef.current");
  });
});

describe("⚠ quick-open focuses the search bar in the title bar", () => {
  it("is driven by an event, not a prop threaded through the title bar", () => {
    expect(handler()).toContain('new CustomEvent("editor:quick-open")');
    expect(SEARCH).toContain('window.addEventListener("editor:quick-open"');
  });

  it("selects the existing query so a second press replaces it", () => {
    const listener = SEARCH.slice(SEARCH.indexOf("const onFocusRequest"), SEARCH.indexOf("const onFocusRequest") + 200);
    expect(listener).toContain("focus()");
    expect(listener).toContain("select()");
  });

  it("removes its listener on unmount", () => {
    expect(SEARCH).toContain('removeEventListener("editor:quick-open"');
  });
});
