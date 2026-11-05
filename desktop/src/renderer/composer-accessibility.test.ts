// ── ⚠ THE COMPOSERS ARE USABLE WITHOUT SIGHT ──────────────────────────────────────────────────
//
// Two defects this file guards against:
//
//   1. NO ACCESSIBLE NAME. None of the three composer textareas had a `<label>` or an `aria-label`, so
//      a screen reader announced an unnamed multiline text box. Its only description was the
//      placeholder — an unreliable accessible name in general, and worse here since this app's
//      placeholder now changes with the workshop phase.
//   2. THE KEYBOARD CONTRACT WAS SIGHTED-ONLY. `⏎ send · ⇧⏎ newline` existed in all three composers
//      and every copy was `aria-hidden="true"`. Defensible for the glyphs — "return symbol middle dot
//      up-arrowhead return symbol" is worse than silence — and it left the contract unavailable in any
//      other form.
//
// ⚠ AND MID-TURN IT WAS WORSE THAN SILENT. The box goes `readOnly` while a reply streams, with
// `aria-disabled` set and nothing saying why or for how long.
//
// Asserted against source, per this package's convention for view structure: vitest here is node-only,
// so there is no DOM to query. What is checked is the WIRING — that a name exists, that the
// description is referenced, and that the described element is always present.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const HINT = readFileSync(local("./components/ComposerKeyHint.tsx"), "utf8");
const hint = strip(HINT);

/**
 * Every composer in the app, with the exact `aria-label` attribute each must carry.
 *
 * Written out verbatim rather than assembled from parts: an expected string built by string surgery is
 * unreadable, and a test whose expectation cannot be read at a glance is a test nobody trusts when it
 * fails.
 */
const COMPOSERS = [
  {
    file: "AssistantChatView.tsx",
    busy: "streaming",
    // Built from the ACTIVE assistant, so the name matches whom the view says it is talking to.
    label: "aria-label={`Message ${assistantLabel(currentCli)}`}",
  },
  { file: "KiroChatView.tsx", busy: "streaming", label: 'aria-label="Message Kiro"' },
  { file: "TeamChatView.tsx", busy: "sending", label: 'aria-label="Message your team"' },
] as const;

const sourceOf = (file: string) => strip(readFileSync(local(`./components/${file}`), "utf8"));

describe("⚠ every composer's textarea has a name", () => {
  for (const { file, label } of COMPOSERS) {
    it(`${file} names its box`, () => {
      // A placeholder is not a name: it is the first thing to disappear, on the first keystroke.
      expect(sourceOf(file), "an accessible name, not just a placeholder").toContain(label);
    });
  }

  it("all three, counted — so a new composer cannot arrive unnamed", () => {
    /**
     * Counted rather than checked one by one: the failure mode is a FOURTH composer appearing without
     * a name, which per-file assertions would never notice. Three composers exist today.
     */
    const named = COMPOSERS.filter(({ file }) => /aria-label=/.test(sourceOf(file)));
    expect(named).toHaveLength(3);
  });
});

describe("⚠ the keyboard contract reaches assistive tech", () => {
  it("every composer points aria-describedby at the hint", () => {
    for (const { file } of COMPOSERS) {
      const code = sourceOf(file);
      expect(code, `${file} must describe its box`).toContain("aria-describedby={hintId}");
      expect(code, `${file} must render the hint`).toContain("<ComposerKeyHint");
      expect(code, `${file} must pass the id it referenced`).toMatch(/<ComposerKeyHint[\s\S]{0,120}id=\{hintId\}/);
    }
  });

  it("uses useId rather than a hardcoded id", () => {
    /**
     * A chat can be pinned beside another pane, so two composers can be in one document at once. A
     * constant id would make the document invalid and leave `aria-describedby` ambiguous — pointing at
     * whichever element happened to be first.
     */
    for (const { file } of COMPOSERS) {
      const code = sourceOf(file);
      expect(code, `${file}`).toMatch(/const hintId = useId\(\)/);
    }
  });

  it("renders BOTH halves: aria-hidden glyphs and an sr-only sentence", () => {
    expect(hint, "the glyphs stay hidden from AT").toMatch(/aria-hidden="true"[\s\S]{0,200}⏎ send · ⇧⏎ newline/);
    expect(hint, "and the same contract exists in words").toMatch(/className="sr-only"/);
    expect(hint).toContain("Press Enter to send");
    expect(hint).toContain("Shift plus Enter");
  });

  it("⚠ keeps the described element MOUNTED while a turn is in flight", () => {
    /**
     * The subtle half. `aria-describedby` pointing at an element that has been unmounted leaves some
     * screen readers announcing an empty description and others skipping it silently — neither useful.
     * So `busy` hides the GLYPHS only, and the sr-only element persists with different wording.
     */
    /**
     * ⚠ AN EARLIER VERSION OF THIS ASSERTION DID NOT CATCH THE MUTATION IT EXISTS FOR. It compared the
     * sr-only span's position against the FIRST `)}` after the first `{!busy && (`, so wrapping the
     * sr-only span in its own `{!busy && (…)}` still satisfied it — the exact regression, passing.
     *
     * Counting the conditional is what actually holds: there must be exactly ONE, the glyph branch.
     */
    const conditionals = hint.match(/\{!busy && \(/g) ?? [];
    expect(conditionals.length, "exactly one !busy branch — the glyphs").toBe(1);

    const branchStart = hint.indexOf("{!busy && (");
    const branchEnd = hint.indexOf(")}", branchStart);
    const insideBranch = hint.slice(branchStart, branchEnd);
    expect(insideBranch, "the glyphs are the conditional half").toContain("⏎ send");
    expect(insideBranch, "the sr-only sentence must NOT be conditional").not.toContain("sr-only");

    // And its wording changes rather than vanishing.
    expect(hint).toMatch(/busy\s*\?[\s\S]{0,120}read-only until/);
  });

  it("explains the locked box instead of only marking it unavailable", () => {
    // `aria-disabled` says "unavailable" without saying why or for how long.
    expect(hint).toMatch(/read-only until .*finishes/);
    expect(hint).toContain("You can type again then");
    for (const { file, busy } of COMPOSERS) {
      expect(sourceOf(file), `${file} must pass its busy flag`).toMatch(
        new RegExp(`<ComposerKeyHint[\\s\\S]{0,160}busy=\\{${busy}\\}`)  // nosemgrep: missing-template-string-indicator
      );
    }
  });

  it("names the assistant in the busy sentence where there IS one", () => {
    // Team chat has no agent, so it omits the subject and the component says "the current message".
    expect(sourceOf("KiroChatView.tsx")).toMatch(/busySubject="Kiro"/);
    expect(sourceOf("AssistantChatView.tsx")).toMatch(/busySubject=\{assistantLabel\(currentCli\)\}/);
    expect(sourceOf("TeamChatView.tsx")).not.toContain("busySubject");
    expect(hint).toContain('busySubject ?? "the current message"');
  });

  it("is NOT a live region", () => {
    /**
     * It is a description, read when focus reaches the box. A live region would interrupt the reply
     * being read aloud to announce that the composer is busy — which the user just caused.
     */
    expect(hint).not.toContain("aria-live");
    expect(hint).not.toMatch(/role="status"/);
  });
});

describe("the visible hint is unchanged", () => {
  it("same glyphs, same size, same narrow-width behaviour", () => {
    /**
     * This started as an accessibility fix, not a redesign: three near-identical spans became one
     * component, and anything that altered the sighted appearance would make the change unreviewable.
     */
    expect(hint).toContain("⏎ send · ⇧⏎ newline");
    expect(hint).toContain("text-[10px]");
    expect(hint).toContain("hidden");
    expect(hint).toContain("sm:inline");
  });

  it("keeps the one view that varied its ink", () => {
    // AssistantChatView alone chose its tone by surface; flattening that would have changed its look.
    expect(hint).toMatch(/tone === "muted" \? "text-surface-muted" : "text-surface-faint"/);
    expect(sourceOf("AssistantChatView.tsx")).toMatch(/tone=\{usesDarkSurface \? "faint" : "muted"\}/);
  });

  it("no composer keeps its own inline copy of the glyphs", () => {
    // The whole point of the extraction: one place for a string that existed in three.
    for (const { file } of COMPOSERS) {
      expect(sourceOf(file), `${file} must not duplicate the hint`).not.toContain("⏎ send");
    }
  });
});
