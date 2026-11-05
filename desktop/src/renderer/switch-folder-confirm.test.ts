// ── ⚠ THE CONSENT DIALOG SAYS THE THREE THINGS, AND TRAPS THE KEYBOARD WHILE IT DOES ─────────
//
// The dialog's whole value is the sentences — a folder picker already asked WHICH folder, so a
// confirmation that only repeats the path adds a click and no information. What must survive an edit
// is therefore the CONTENT (all three consequences) and the KEYBOARD CONTRACT (focus starts on
// Cancel, Escape leaves, Tab cannot escape to the app behind it).
//
// ⚠ AND THAT NO FRAMEWORK IS NAMED. Which one installs is the facilitator's configuration, unknown
// until `framework:check` answers — the rule handlers/framework.ts states and `framework-name.test.ts`
// enforces in main. A renderer that hardcoded "AI-DLC" would be wrong for every experience that chose
// something else, and this is the one screen where the temptation to name it is strongest.
//
// Asserted against source, per this package's convention for view structure: vitest here is node-only,
// so there is no DOM to query.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const src = strip(readFileSync(local("./components/SwitchFolderConfirm.tsx"), "utf8"));
/** Comments stripped, so a consequence "stated" only in a code comment cannot satisfy these. */
const prose = src.replace(/\s+/g, " ");

describe("⚠ it states what the folder picker does not", () => {
  it("says the folder becomes writable, not merely opened", () => {
    expect(prose).toMatch(/readable and writable/);
  });

  it("names who gets that access", () => {
    expect(prose, "the editor").toMatch(/editor/);
    expect(prose, "the Git actions").toMatch(/Git actions/);
    expect(prose, "and the assistant — the one nobody expects").toMatch(/assistant/);
  });

  it("warns that the current folder closes with its open files", () => {
    expect(prose).toMatch(/closes, along with any files you have open from it/);
  });

  /**
   * ⚠ THE LEAST PREDICTABLE CONSEQUENCE. `framework:install` runs an assistant turn in the folder
   * (handlers/framework.ts), which only became reachable on a switch once the grant was reordered —
   * so nobody would infer it from a folder picker.
   */
  it("warns that an agent may run setup in the folder", () => {
    expect(prose).toMatch(/may run setup in this folder/);
    expect(prose, "and that it writes").toMatch(/create and modify files/);
  });

  it("shows the full path, not just the folder name", () => {
    expect(src, "the leaf, for the heading").toMatch(/basenameOf\(folderPath\)/);
    expect(src, "and the whole path, because two checkouts share a leaf").toMatch(
      /\{folderPath\}/
    );
  });

  it("names no framework", () => {
    for (const named of [/AI-?DLC/i, /Spec ?Kit/i, /OpenSpec/i]) {
      expect(prose, `${named} is the facilitator's choice, not ours`).not.toMatch(named);
    }
    expect(prose, "the generic phrasing main uses").toMatch(/the project framework/);
  });
});

describe("⚠ the keyboard contract", () => {
  /** `alertdialog` is what makes a screen reader speak the consequences on open. */
  it("is an alertdialog that claims modality", () => {
    expect(src).toMatch(/role="alertdialog"/);
    expect(src).toMatch(/aria-modal="true"/);
  });

  /** Both the heading and the consequence list are referenced, so neither is announced by luck. */
  it("points at its own title and consequence list", () => {
    expect(src).toMatch(/aria-labelledby=\{titleId\}/);
    expect(src).toMatch(/aria-describedby=\{bodyId\}/);
    expect(src, "the list carries the id it is described by").toMatch(/<ul id=\{bodyId\}/);
  });

  /**
   * ⚠ CANCEL IS THE DEFAULT, AND IN A LAYOUT EFFECT. The affirmative button must never hold focus on
   * open, and `useEffect` would leave a painted frame where focus is still on the trigger behind the
   * overlay — the rule TreeContextMenu's trash confirmation already follows.
   */
  it("focuses Cancel in the commit that mounts it", () => {
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*?cancelRef\.current\?\.focus\(\)/);
  });

  it("restores focus on unmount, so every exit path is covered", () => {
    expect(src).toMatch(/return \(\) => \{[\s\S]*?target\.focus\(\)/);
  });

  it("leaves on Escape", () => {
    expect(src).toMatch(/e\.key === "Escape"[\s\S]*?onCancel\(\)/);
  });

  /**
   * Without the trap, Tab from "Open folder" lands somewhere in the app behind an open dialog and
   * the next Enter activates whatever it found — which is what would make `aria-modal` a lie.
   */
  it("traps Tab between its two buttons", () => {
    expect(src).toMatch(/e\.key !== "Tab"/);
    expect(src).toMatch(/e\.shiftKey && active === first/);
    expect(src).toMatch(/active === last/);
  });

  /** The backdrop is a dismissal, and the panel must not inherit it. */
  it("dismisses on the backdrop without letting panel clicks through", () => {
    expect(src).toMatch(/onClick=\{onCancel\}/);
    expect(src).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });
});
