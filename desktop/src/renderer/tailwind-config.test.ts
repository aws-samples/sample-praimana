import { describe, it, expect } from "vitest";
import { hex } from "./palette.testkit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE TAILWIND CONFIG MUST ACTUALLY PARSE.
 *
 * ── ⚠ WHY THIS FILE EXISTS: 620 TESTS PASSED WHILE THE APP WOULD NOT START ──
 *
 * A docblock in `tailwind.config.ts` referred to the extension's stylesheet as
 * `…/anthropic.claude-code-<star>/webview/index.css`. A `*` immediately before a `/` CLOSES A BLOCK
 * COMMENT. So the comment ended mid-sentence, the remaining prose became code, the config stopped
 * parsing, PostCSS failed on `index.css`, and the dev server refused to boot:
 *
 *     [postcss] Unexpected token, expected "," (80:65)
 *       at parseObj (sucrase/dist/parser/traverser/expression.js)
 *
 * Note what that error does NOT say: anything about a comment, or about the config at all. It points at
 * `index.css` and at sucrase's object parser, so the two-character cause was well hidden.
 *
 * ── THE TESTING LESSON, WHICH IS THE POINT OF THIS FILE ──
 *
 * The whole suite was green. Every existing assertion about this config — the colour tokens, the contrast
 * figures, the keyframes — reads it with `readFileSync` and matches STRINGS. A file that is textually
 * correct and syntactically broken passes all of them. `pnpm type-check` also passed, because the config
 * is not in the renderer's `tsconfig` include path.
 *
 * So the gap was not "an untested value", it was "an untested KIND of failure": nothing in the repo ever
 * evaluated this file. That is what these tests do, and it is deliberately the cheapest possible version —
 * parse it, then confirm the parsed object actually holds the tokens the string-matching tests assert.
 */

const CONFIG_PATH = fileURLToPath(new URL("../../tailwind.config.ts", import.meta.url));

describe("tailwind.config.ts is syntactically valid", () => {
  it("⚠ IMPORTS AS A MODULE, not merely reads as text", () => {
    /**
     * THE ASSERTION THAT WOULD HAVE CAUGHT THE OUTAGE. A dynamic import runs the file through the same
     * transform pipeline Vite uses, so a prematurely-closed comment is a hard failure here rather than a
     * broken dev server later.
     *
     * Vitest resolves `.ts` for us, so this needs no build step and costs a few milliseconds.
     */
    return import(CONFIG_PATH).then((mod) => {
      expect(mod.default, "the config must export a default").toBeTruthy();
    });
  });

  it("no comment ends in the middle of a sentence", () => {
    /**
     * A DIRECTED CHECK for the specific mistake, so the failure names the cause instead of pointing at a
     * syntax-error offset. A glob path such as `claude-code-` followed by a star and a slash, or a CSS
     * selector containing a comment terminator, reintroduces it — both natural things to write in a file
     * documenting CSS.
     *
     * ⚠ THE SAME MISTAKE WAS MADE WRITING THIS COMMENT. The first version quoted the offending path literally,
     * which closed THIS docblock and broke THIS file — esbuild reported "Unterminated regular expression".
     * That is why the sequence is described in words rather than shown: a file that hunts for a footgun is
     * the easiest place to fire it.
     *
     * ⚠ AND MY FIRST ATTEMPT AT THIS ASSERTION COULD NEVER FIRE. It scanned each block comment's BODY for a
     * terminator — but once a comment closes early, the regex simply matches the SHORTER block, whose body
     * is clean by construction. It passed on the real broken file. Verified by reproducing the bug rather
     * than by reading the test, which is the only reason it was caught.
     *
     * What DOES detect it: a comment that ends without the leading star every line in these docblocks
     * carries. A premature close leaves the terminator butted straight against prose, where a deliberate one
     * sits alone on its own line.
     *
     * ⚠ AND THAT IS THE THIRD TIME I FIRED THIS FOOTGUN IN THIS FILE — twice by quoting the offending
     * sequence in a docblock, once in a line comment. Hence a rule for anything written here: describe the
     * character sequence, never reproduce it. Recorded because three identical slips in the file whose
     * purpose is to catch that slip is the most useful thing this file can say.
     */
    const source = readFileSync(CONFIG_PATH, "utf8");
    const blocks = [...source.matchAll(/\/\*[\s\S]*?\*\//g)];
    expect(blocks.length, "sanity: this file is heavily commented").toBeGreaterThan(3);

    const truncated = blocks
      .map((m) => m[0])
      // A well-formed docblock closes on its own line, so the character before the terminator is
      // whitespace or a star. A prematurely closed one has prose butted straight against it.
      .filter((block) => /[^\s*][*][/]$/.test(block))
      .map((block) => block.slice(-60).replace(/\s+/g, " "));

    expect(
      truncated,
      "a comment ended mid-sentence — something inside it closed the block early"
    ).toEqual([]);
  });

  it("the parsed object really holds the tokens the other tests match as strings", () => {
    /**
     * Closing the loop. `vscode-parity.test.ts` asserts `bg: "#111827"` appears in the SOURCE; this asserts
     * it survives into the evaluated config. The two together mean the value is both written and effective
     * — a token could otherwise be defined inside a comment, or under a misspelled key, and every
     * string-matching test would still pass.
     */
    return import(CONFIG_PATH).then((mod) => {
      const colors = (mod.default as any)?.theme?.extend?.colors;
      expect(colors, "theme.extend.colors must exist").toBeTruthy();

      /**
       * ── ⚠ THE CONFIG HOLDS VARIABLE REFERENCES NOW, NOT HEXES ─────────────────────────────
       *
       * These asserted `colors.surface.bg === "#111827"`. The values moved to `index.css` so the app can
       * carry a light AND a dark palette behind one set of class names, and the config maps each token to
       * its custom property instead.
       *
       * ⚠ THE ALPHA PLACEHOLDER IS THE PART WORTH PINNING. `var(--x)` alone would compile and would break
       * every opacity modifier in the app (`brand-accent/40`, `tool-ok/15`) silently — Tailwind can only
       * inject the alpha into an `rgb(... / <alpha-value>)` form. That is the mistake this now guards.
       */
      for (const [group, token] of [
        ["surface", "bg"],
        ["surface", "panel"],
        ["surface", "raised"],
        ["claude", "accent"],
        ["tool", "ok"],
        ["brand", "strong"],
      ] as const) {
        expect(colors[group][token], `${group}.${token} must map to its variable`).toBe(
          `rgb(var(--${group}-${token}) / <alpha-value>)`  // nosemgrep: html-in-template-string
        );
      }

      /** And the values those variables resolve to are asserted against index.css by the palette fixture. */
      expect(hex("surface-bg", "dark")).toBe("#111827");
      expect(hex("surface-bg", "light")).toBe("#ffffff");
    });
  });

  it("the animations the transcript uses are actually registered", () => {
    // `animate-dot-blink` and `animate-row-fade-in` are referenced by class name in ToolStep and
    // ActivityPhrase. A typo in either key produces no error anywhere — just a dot that never blinks.
    return import(CONFIG_PATH).then((mod) => {
      const extend = (mod.default as any)?.theme?.extend;
      expect(Object.keys(extend.animation)).toContain("dot-blink");
      expect(Object.keys(extend.animation)).toContain("row-fade-in");
      expect(Object.keys(extend.keyframes)).toContain("dot-blink");
      expect(Object.keys(extend.keyframes)).toContain("row-fade-in");
    });
  });

  it("the renderer is in the content globs, or every class is purged", () => {
    // The failure mode here is total and silent: a wrong glob ships a stylesheet with none of these classes
    // in it, and the app renders unstyled with no error at all.
    return import(CONFIG_PATH).then((mod) => {
      const content = (mod.default as any)?.content as string[];
      expect(content.some((g) => g.includes("src/renderer"))).toBe(true);
    });
  });
});
