/**
 * ── ⚠ A BARE BLOCK COMMENT IN JSX CHILDREN POSITION IS NOT A COMMENT, IT IS TEXT ─────────────
 *
 * This shipped. The platform-health tab rendered a full paragraph of explanatory prose on screen,
 * above the alarm list, because a note was written as a bare block comment between two elements
 * instead of inside braces. It was visible in the browser.
 *
 * ── WHY A STATIC TEST AND NOT A BROWSER ONE ──
 *
 * The obvious guard is to render each screen and assert the prose is absent, and that was the
 * first attempt. It was VACUOUS: /admin's tabs gate their queries on a role the e2e harness
 * cannot establish (`signInAs` mints a placeholder bearer with no refresh token, so the `jwt`
 * callback's refresh path clears `role`), so the health tab never got past "Checking the
 * platform…" and the region containing the leak was never rendered at all. The test passed with
 * the bug deliberately reintroduced, twice, before that was noticed.
 *
 * A source scan has none of that dependency. It needs no session, no fixtures and no server, it
 * covers every component including the ones no test can currently render, and it is the check
 * that actually found the original leak.
 *
 * ── WHY THIS IS NOT A LINT RULE ──
 * ESLint's `react/jsx-no-comment-textnodes` exists and would be the better home, but the plugin
 * is not in this project's flat config (`eslint.config.mjs` carries `@eslint/js`,
 * `typescript-eslint` and `eslint-plugin-react-hooks`, not `eslint-plugin-react`). Adding a
 * dependency for one rule is a bigger change than this file; if the plugin arrives later, delete
 * this and enable the rule.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * A block comment is in JSX children position when the previous meaningful line closed an
 * element or an expression container, and the next one opens an element.
 *
 * ⚠ THE `=>` AND `({` EXCLUSIONS ARE LOAD-BEARING. `things.map((x) => {` and `({` both end in a
 * brace but open a FUNCTION BODY, where a bare block comment is a perfectly ordinary comment.
 * Without those two exclusions this reports every documented callback in the codebase and is
 * useless. The first version of the detector lacked them and produced 46KB of false positives.
 */
function leaks(source: string): { line: number; text: string }[] {
  const lines = source.split("\n");
  const found: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\*/.test(lines[i])) continue;

    let p = i - 1;
    while (p >= 0 && lines[p].trim() === "") p--;
    const prev = p >= 0 ? lines[p].trim() : "";

    let end = i;
    while (end < lines.length && !lines[end].includes("*/")) end++;
    let n = end + 1;
    while (n < lines.length && lines[n].trim() === "") n++;
    const next = n < lines.length ? lines[n].trim() : "";

    const afterElementOrExpression = /[>}]$/.test(prev);
    const opensFunctionBody = prev.endsWith("=>") || prev.endsWith("({") || prev.endsWith("=> {");
    const beforeElement = next.startsWith("<");

    if (afterElementOrExpression && !opensFunctionBody && beforeElement) {
      found.push({ line: i + 1, text: lines[i].trim().slice(0, 80) });
    }
  }
  return found;
}

describe("⚠ no block comment renders as text in JSX", () => {
  const files = tsxFiles(SRC);

  it("scans a realistic number of components", () => {
    // A guard on the guard: if the walk silently stops finding files (a moved directory, a
    // changed extension) every assertion below passes for the wrong reason.
    expect(files.length).toBeGreaterThan(40);
  });

  it("finds none in any component", () => {
    const offenders = files.flatMap((f) =>
      leaks(readFileSync(f, "utf8")).map((l) => `${f.replace(SRC, "src")}:${l.line} → ${l.text}`)
    );
    expect(offenders, "wrap these in braces: {/* … */}").toEqual([]);
  });

  /**
   * ⚠ THE DETECTOR IS ITSELF TESTED, because a detector that reports nothing is
   * indistinguishable from a codebase with nothing to report, which is precisely how the
   * browser version of this guard passed twice against a known bug.
   */
  it("catches a bare comment between two elements", () => {
    const bad = ["      </div>", "", "      /* a note */", '      <ul className="x">'].join("\n");
    expect(leaks(bad)).toHaveLength(1);
  });

  it("allows a comment in an expression slot, where it is a real comment", () => {
    const ternary = ["      ) : (", "        /* a note */", '        <ul className="x">'].join("\n");
    expect(leaks(ternary)).toEqual([]);

    const arrow = ["        {rows.map((r) => {", "          /* a note */", "          <li />"].join("\n");
    expect(leaks(arrow)).toEqual([]);
  });

  it("allows the braced form", () => {
    const braced = ["      </div>", "      {/* a note */}", '      <ul className="x">'].join("\n");
    expect(leaks(braced)).toEqual([]);
  });
});
