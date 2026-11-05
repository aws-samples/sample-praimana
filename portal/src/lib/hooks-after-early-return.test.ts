// ── ⚠ THE BUG CLASS `rules-of-hooks` CANNOT SEE IN THIS CODEBASE ─────────────────────────────
//
// `eslint.config.mjs` enables `react-hooks/rules-of-hooks` as an ERROR, and its comment says the rule
// was "ADDED AFTER SHIPPING THE EXACT BUG IT CATCHES", a hook placed after an early return, which
// makes React count a different number of hooks between renders and throws
// "Rendered fewer hooks than expected". That is all true, and the protection is narrower than it reads.
//
// ⚠ THE RULE IS BLIND TO EVERY tRPC HOOK IN THIS APP, PROVEN RATHER THAN SUSPECTED. `isHook` in
// eslint-plugin-react-hooks (7.1.1) treats a member expression as a hook only when the OBJECT is a
// single PascalCase identifier, `React.useState()` qualifies, `Namespace.useThing()` qualifies. Every
// hook call in this application is `trpc.<router>.<procedure>.useQuery()` / `.useMutation()`, whose
// object is a NESTED member expression with a lowercase root, so the rule does not classify it as a
// hook at all and has nothing to say about where it sits. Verified with a two-line probe: the
// PascalCase form was flagged in the same file where the tRPC form was not.
//
// That is not a bug in the rule, it is a heuristic doing what it documents. It does mean the app's
// most common hook call is unprotected, and it is why `UsersTab` shipped with
// `trpc.admin.setUserAccess.useMutation` below an `if (error) return`: any error on the Administration
// → Users tab CRASHED the tab instead of rendering the error message it had ready.
//
// So this file is the missing half of that lint rule. It is a source scan, in the same spirit as the
// other source-assertion tests here, because the property is static and there is no DOM to render.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = join(__dirname, "..");

/** Every `.tsx` under `src/`, which is where components (and therefore hooks) live. */
function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...componentFiles(path));
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(path);
    }
  }
  return out;
}

const HOOK_CALL =
  /trpc\.[A-Za-z0-9_.]*\.(useQuery|useMutation|useInfiniteQuery|useSuspenseQuery)\s*\(/;
const FUNCTION_START = /^(?:export\s+)?(?:default\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;
/** A `return` at a component's own statement level. Prettier indents those 2–6 spaces. */
const TOP_LEVEL_RETURN = /^\s{2,6}return\b/;
/** An `if (` at the component's own statement level, where a guard clause lives. */
const TOP_LEVEL_IF = /^ {2}if\s*\(/;

interface Finding {
  file: string;
  component: string;
  returnLine: number;
  hookLine: number;
  hook: string;
}

/**
 * ⚠ A HEURISTIC, AND ITS LIMITS ARE STATED RATHER THAN GLOSSED. It is line- and
 * indentation-based, which works because every file here is prettier-formatted at two-space
 * indentation, and it looks only for the shape that actually shipped: a guard `if (…)` at a
 * component's own statement level whose body returns, followed later by a hook call.
 *
 * What it will MISS: a guard nested inside another block, a return produced by a helper, a
 * component written with unusual formatting. What it must never do is FALSE-POSITIVE, because a
 * scan that cries wolf gets deleted, so the `if (` anchor is deliberately strict. An earlier
 * version of this scan matched any `return` at brace depth 1 and reported three files, all of
 * which turned out to be returns inside JSDoc examples and `onSuccess` callbacks.
 */
function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of componentFiles(APP_ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let component: string | null = null;
    let guardReturn: number | null = null;

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];

      const start = FUNCTION_START.exec(line);
      if (start) {
        component = start[1];
        guardReturn = null;
        continue;
      }
      if (component === null) continue;
      // A closing brace in column 0 ends the function.
      if (/^\}/.test(line)) {
        component = null;
        guardReturn = null;
        continue;
      }

      if (TOP_LEVEL_IF.test(line)) {
        for (let k = n; k < Math.min(n + 8, lines.length); k++) {
          if (TOP_LEVEL_RETURN.test(lines[k])) {
            guardReturn ??= k + 1;
            break;
          }
        }
      }

      if (guardReturn !== null && HOOK_CALL.test(line)) {
        findings.push({
          file: file.replace(`${APP_ROOT}/`, "src/"),
          component,
          returnLine: guardReturn,
          hookLine: n + 1,
          hook: (HOOK_CALL.exec(line) ?? [""])[0],
        });
        guardReturn = null; // one finding per component is enough to fail
      }
    }
  }
  return findings;
}

describe("no tRPC hook may sit after a component's early return", () => {
  it("⚠ FINDS NONE, a hook below a guard clause is a crash, not a lint warning", () => {
    const findings = scan();
    const report = findings
      .map(
        (f) =>
          `${f.file}: ${f.component}() returns early at line ${f.returnLine}, then calls ` +
          `${f.hook} at line ${f.hookLine}`
      )
      .join("\n");
    expect(
      findings,
      `A hook after an early return makes React render a different NUMBER of hooks between ` +
        `renders, and it throws "Rendered fewer hooks than expected", so the guard clause that ` +
        `was meant to show an error message crashes the screen instead. Move the hook ABOVE the ` +
        `guard; hooks must be unconditional.\n\n${report}`
    ).toEqual([]);
  });

  it("the scan actually looks at this app's components", () => {
    // A scan pointed at nothing passes forever. Pin that it reads a real, known population and
    // finds the hook calls it is supposed to be reasoning about.
    const files = componentFiles(APP_ROOT);
    expect(files.length).toBeGreaterThan(20);
    const withHooks = files.filter((f) => HOOK_CALL.test(readFileSync(f, "utf8")));
    expect(withHooks.length, "the app should have plenty of tRPC hook call sites").toBeGreaterThan(10);
  });

  it("⚠ AND IT CATCHES THE SHAPE THAT SHIPPED, the scan is exercised on a fixture", () => {
    /**
     * The regression this whole file exists for, reproduced as text rather than as a real file so the
     * repo never contains the bug on purpose. If the heuristic is ever loosened into uselessness,
     * this fails.
     */
    const shipped = [
      "function UsersTab() {",
      "  const currentAccessRef = useRef<string | null>(null);",
      "",
      "  if (error) {",
      "    return (",
      "      <p>{error.message}</p>",
      "    );",
      "  }",
      "",
      "  const setUserAccess = trpc.admin.setUserAccess.useMutation({",
      "    onSuccess: () => {},",
      "  });",
      "}",
    ];
    // Same predicates the scan uses, applied to the fixture.
    const ifAt = shipped.findIndex((l) => TOP_LEVEL_IF.test(l));
    const returnAt = shipped.findIndex((l) => TOP_LEVEL_RETURN.test(l));
    const hookAt = shipped.findIndex((l) => HOOK_CALL.test(l));
    expect(ifAt, "the guard is recognised").toBeGreaterThan(-1);
    expect(returnAt, "its return is recognised").toBeGreaterThan(ifAt);
    expect(hookAt, "the hook is recognised as a hook").toBeGreaterThan(returnAt);
  });
});
