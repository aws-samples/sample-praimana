import { readFileSync } from "fs";

/**
 * ── READ A SOURCE FILE WITH ITS COMMENTS STRIPPED, FOR SOURCE-ASSERTION TESTS ──────────────
 *
 * This package's vitest is `environment: "node"` with no jsdom (see vitest.config.ts), so a handful of
 * tests assert component rules against the SOURCE rather than a rendered tree. That is a deliberate
 * convention, shared with the desktop's `phases-view.test.ts`.
 *
 * ── ⚠ WHY STRIPPING COMMENTS IS THE WHOLE POINT ──
 *
 * A source assertion of the form `expect(src).toContain("...")` is satisfied by a COMMENT that merely
 * MENTIONS the thing. That is not a theoretical weakness, it happened twice while writing these tests,
 * and this codebase comments heavily enough that it will happen again:
 *
 *   · `expect(src).toContain('rel="noreferrer noopener"')` passed after the real attribute was DELETED
 *     from the JSX, because the component's doc comment explains why that attribute is required.
 *   · `expect(src).not.toContain("• files")` FAILED on a correct file, because the comment recording
 *     that the label had been removed contained the label's own text.
 *
 * Both were caught by mutation testing rather than by review, which is the argument for a helper: the
 * failure mode is invisible and produces a GREEN test, so it must be removed structurally rather than
 * remembered.
 *
 * ⚠ A REGEX, NOT A PARSER, AND THE LIMITS ARE STATED. It removes line comments (double-slash to end of
 * line) and block comments. It does NOT understand string literals, so a URL inside one, anything
 * containing a double slash, loses its tail. That is acceptable HERE and nowhere else: these tests
 * assert on identifiers, JSX attributes and label text, none of which contain a double slash. A test
 * that needs to assert on a URL literal must read the raw file instead, and say why.
 *
 * (This paragraph originally spelled the block-comment delimiters out, which needed a zero-width space
 * to avoid closing this very comment, and `no-irregular-whitespace` failed the lint. Worth recording:
 * an invisible character in a source file is exactly the kind of thing that is impossible to review.)
 */
export function sourceWithoutComments(path: string): string {
  return readFileSync(path, "utf8")  // nosemgrep: detect-non-literal-fs-filename
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}
