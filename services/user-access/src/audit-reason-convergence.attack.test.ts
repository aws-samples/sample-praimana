import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeAuditReason, AUDIT_REASON_MAX } from "./domain.js";

/**
 * ── INDEPENDENT ATTACK PASS ON normalizeAuditReason, USER-ACCESS COPY ──
 *
 * Two jobs, both of which the developer's own tests cannot do from where they sit:
 *
 *   1. THE SHARED CORPUS. The SAME input/expected table is driven through the team service's
 *      copy in the team service's audit-actor-disclosure attack test (through the route
 *      that actually calls it, DELETE /v1/teams/:teamId/members/:userId) and through THIS copy
 *      here. Kept literally in step by the source-identity check below, which fails if either
 *      table is edited alone.
 *
 *      WHY NOT ONE TEST IMPORTING BOTH: the team copy is MODULE-PRIVATE (routes.ts:496 — not
 *      exported, deliberately) and the two live in separate workspaces which take no dependency
 *      on each other. A cross-package behavioural test is therefore not possible, and this is
 *      the honest substitute: the same table pinned on each side, plus a byte-comparison of the
 *      two function bodies.
 *
 *   2. THE ORDERING TRAP, RE-DERIVED. The developer's sanitise-before-truncate test is only
 *      meaningful if its padding is NOT trimmable — a `\n`-padded version passes against the
 *      UNSANITISED original and proves nothing. Rather than take the shipped test's word for it,
 *      the check below re-implements the OLD function and asserts that the padding actually used
 *      discriminates between old and new, and that `\n` padding does NOT.
 *
 * Deterministic: every case is a fixed literal, no clock, no randomness, no sleeps.
 */

/**
 * THE SHARED CORPUS. Must stay byte-identical to `reasonCorpus` in
 * the team service's audit-actor-disclosure attack test — asserted by
 * "the shared corpus is literally identical in both packages" below.
 */
export const reasonCorpus: ReadonlyArray<readonly [input: string, expected: string | undefined]> = [
  ["plain", "plain"],
  ["a\nb", "a b"],
  ["a\r\n\t\tb", "a b"],
  ["a b", "a b"],
  ["left  the   programme", "left  the   programme"],
  ["  ", undefined],
  ["   ", undefined],
  ["", undefined],
  ["\u200B", undefined],
  ["\u202E\n", undefined],
  ["a" + "\n".repeat(200) + "b", "a b"],
  ["\u0000".repeat(400) + "the real reason", "the real reason"],
  ["\u202E".repeat(400) + "the real reason", "the real reason"],
  ["\u0000".repeat(400) + "a".repeat(200), "a".repeat(200)],
  ["\u0000".repeat(400) + "a".repeat(201), "a".repeat(200)],
  ["a".repeat(201), "a".repeat(200)],
  ["disabled\u202E after\u0000 review", "disabled  after  review"],
  ["\u{1F469}\u200D\u{1F4BB}", "\u{1F469} \u{1F4BB}"],
  ["ok \u2764\uFE0F", "ok \u2764\uFE0F"],
  ["ok \u{1F44D}\u{1F3FF}", "ok \u{1F44D}\u{1F3FF}"],
  ["ok \u{1F1EC}\u{1F1E7}", "ok \u{1F1EC}\u{1F1E7}"],
  ["ok e\u0301", "ok e\u0301"],
  ["\uD800 lone high surrogate", "lone high surrogate"],
  ["\uDFFF lone low surrogate", "lone low surrogate"],
  ["\u{10FFFF} unassigned code point", "unassigned code point"],
];

describe("CONVERGENCE: the shared corpus through the USER-ACCESS copy", () => {
  it("every corpus case produces the expected reason", () => {
    for (const [input, expected] of reasonCorpus) {
      expect(normalizeAuditReason(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it("no corpus output carries a category-C code point, whatever went in", () => {
    // The INVARIANT, stated independently of the expected table: a reader of the append-only
    // trail may assume every stored `reason` is control-free. Quantified over the corpus rather
    // than asserted case by case, so it also covers cases added later.
    for (const [input] of reasonCorpus) {
      const out = normalizeAuditReason(input);
      if (out !== undefined) {
        expect(out, JSON.stringify(input)).not.toMatch(/\p{C}/u);
      }
    }
  });

  it("no corpus output exceeds the cap, and none contains a lone surrogate", () => {
    for (const [input] of reasonCorpus) {
      const out = normalizeAuditReason(input);
      if (out === undefined) continue;
      expect([...out].length, JSON.stringify(input)).toBeLessThanOrEqual(AUDIT_REASON_MAX);
      // A lone surrogate cannot survive a UTF-8 round trip; if one had been written the
      // re-decoded string would differ.
      expect(Buffer.from(out, "utf8").toString("utf8"), JSON.stringify(input)).toBe(out);
    }
  });
});

// ─── THE TRAP, RE-DERIVED RATHER THAN TRUSTED ───────────────────────────────

describe("the sanitise-before-truncate test must actually discriminate", () => {
  /**
   * THE PRE-FIX FUNCTION, reconstructed from the diff: type check, trim, cap in code points.
   * NO sanitisation. This is the implementation the shipped test has to fail against, and
   * re-implementing it here is what makes "verified against the old function" checkable rather
   * than a claim in a comment.
   */
  function preFixNormalize(reason: unknown): string | undefined {
    if (typeof reason !== "string") return undefined;
    const trimmed = reason.trim();
    if (!trimmed) return undefined;
    const points = [...trimmed];
    return points.length > AUDIT_REASON_MAX
      ? points.slice(0, AUDIT_REASON_MAX).join("")
      : trimmed;
  }

  it("the OLD function is genuinely different — the reconstruction is not a copy of the new one", () => {
    // Guard on the guard: if preFixNormalize accidentally matched the shipped function, every
    // discrimination assertion below would be vacuous.
    expect(preFixNormalize("a\nb")).toBe("a\nb");
    expect(normalizeAuditReason("a\nb")).toBe("a b");
  });

  it("NON-TRIMMABLE padding DISCRIMINATES: the old function fails these, the new one passes", () => {
    // THE POINT OF THE WHOLE FIX ORDER. U+0000 and U+202E are not whitespace, so `trim` leaves
    // them, they consume the entire 200-code-point budget, and the operator's real text is
    // truncated away by padding they did not choose.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["\u0000".repeat(400) + "the real reason", "the real reason"],
      ["\u202E".repeat(400) + "the real reason", "the real reason"],
      ["\u0000".repeat(400) + "a".repeat(AUDIT_REASON_MAX), "a".repeat(AUDIT_REASON_MAX)],
      ["\u0000".repeat(400) + "a".repeat(AUDIT_REASON_MAX + 1), "a".repeat(AUDIT_REASON_MAX)],
      ["\u200B".repeat(400) + "the real reason", "the real reason"],
    ];
    for (const [input, expected] of cases) {
      const label = JSON.stringify(input.slice(0, 12) + "...");
      // The NEW function is correct.
      expect(normalizeAuditReason(input), label).toBe(expected);
      // And the OLD one is NOT — so the assertion above has teeth.
      expect(preFixNormalize(input), label).not.toBe(expected);
      // Concretely: the old output was 200 code points of pure padding.
      expect([...(preFixNormalize(input) as string)], label).toHaveLength(AUDIT_REASON_MAX);
      expect(preFixNormalize(input), label).toMatch(/^\p{C}/u);
    }
  });

  it("TRIMMABLE padding does NOT discriminate — the trap, pinned so nobody re-introduces it", () => {
    // ⚠ THIS IS THE FALSE-CONFIDENCE CASE. `\n`, `\t`, `\r` and ` ` are all stripped by
    // `String#trim`, so a test padded with them PASSES AGAINST THE UNSANITISED FUNCTION and
    // proves nothing about ordering. Asserted as an EQUALITY between old and new so that the
    // trap is documented as a fact about the code rather than as advice in a comment.
    for (const pad of ["\n", "\t", "\r", " ", "\r\n", "\u000B", "\u000C"]) {
      const input = pad.repeat(400) + "the real reason";
      const label = JSON.stringify(pad);
      expect(normalizeAuditReason(input), label).toBe("the real reason");
      // The OLD function ALSO gets this right — hence no discrimination.
      expect(preFixNormalize(input), label).toBe("the real reason");
    }
  });

  it("the SHIPPED test's own padding is one of the discriminating kinds", () => {
    // Reads the sibling test file and asserts the sanitise-before-truncate case is padded with a
    // NON-TRIMMABLE control. This is the fix for that trap, verified as a
    // property of the file rather than taken on trust — and it fails if someone later
    // "simplifies" the padding back to `\n`.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(`${here}domain.test.ts`, "utf8");

    const start = source.indexOf('it("SANITISES BEFORE TRUNCATING');
    expect(start, "the sanitise-before-truncate test must exist").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n  });", start));

    // The padding constant must be a non-trimmable control, spelled as an escape.
    const usesNonTrimmablePad = /\\u0000|\\u202E/.test(body);
    expect(usesNonTrimmablePad, "padding must be U+0000 or U+202E, not a trimmable control").toBe(
      true
    );
    // And it must NOT be padded with a newline run, which is the trap.
    expect(/PAD\s*=\s*"\\n"/.test(body), "PAD must not be a newline run").toBe(false);
  });
});

// ─── SOURCE-LEVEL CONVERGENCE ───────────────────────────────────────────────

describe("CONVERGENCE: the two copies and the two corpora must not drift", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const TEAM_ROUTES = `${here}../../team/src/routes.ts`;
  const TEAM_ATTACK_TEST = `${here}../../team/src/audit-actor-disclosure.attack.test.ts`;
  const THIS_FILE = `${here}audit-reason-convergence.attack.test.ts`;
  const THIS_DOMAIN = `${here}domain.ts`;

  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`function ${name}`);
    if (start === -1) throw new Error(`no function ${name}`);
    const open = source.indexOf("{", source.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced body for ${name}`);
  }

  it("the two normalizeAuditReason BODIES are byte-identical", () => {
    // The convergence claim, asserted from the direction that catches an edit to EITHER copy —
    // including one that changes behaviour in a way no test case happens to cover.
    const team = functionBody(readFileSync(TEAM_ROUTES, "utf8"), "normalizeAuditReason");
    const mine = functionBody(readFileSync(THIS_DOMAIN, "utf8"), "normalizeAuditReason");
    expect(mine).toBe(team);
    // And both actually sanitise, BEFORE trimming — an identically-broken pair would satisfy
    // the equality above.
    expect(mine).toContain("replace(AUDIT_REASON_CONTROL_RUN");
    expect(mine.indexOf("replace(AUDIT_REASON_CONTROL_RUN")).toBeLessThan(mine.indexOf(".trim()"));
  });

  it("both copies use the same pattern and the same cap", () => {
    const team = readFileSync(TEAM_ROUTES, "utf8");
    const mine = readFileSync(THIS_DOMAIN, "utf8");
    const pat = (s: string) => /const AUDIT_REASON_CONTROL_RUN = (.+);/.exec(s)?.[1];
    const max = (s: string) => /AUDIT_REASON_MAX = (\d+)/.exec(s)?.[1];
    expect(pat(mine)).toBe("/\\p{C}+/gu");
    expect(pat(mine)).toBe(pat(team));
    expect(max(mine)).toBe(max(team));
    expect(max(mine)).toBe(String(AUDIT_REASON_MAX));
  });

  it("the shared corpus is literally identical in both packages", () => {
    // The behavioural half of the convergence. Extracts the `reasonCorpus` literal from both
    // test files and compares the text, so a case added on one side and not the other fails
    // here — which is the only way a cross-package corpus can be kept honest without an import.
    const extract = (path: string) => {
      const s = readFileSync(path, "utf8");
      const start = s.indexOf("reasonCorpus: ReadonlyArray");
      expect(start, path).toBeGreaterThan(-1);
      const open = s.indexOf("= [", start) + 2;
      let depth = 0;
      for (let i = open; i < s.length; i += 1) {
        if (s[i] === "[") depth += 1;
        else if (s[i] === "]") {
          depth -= 1;
          if (depth === 0) return s.slice(open, i + 1);
        }
      }
      throw new Error(`unbalanced corpus in ${path}`);
    };
    expect(extract(THIS_FILE)).toBe(extract(TEAM_ATTACK_TEST));
  });
});
