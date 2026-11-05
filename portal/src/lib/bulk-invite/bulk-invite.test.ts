// ── BULK TEAM UPLOAD: THE CONTRACT, THE PARSER, AND THE REFUSALS ─────────────────────────
//
// This is the surface that turns an operator's spreadsheet into up to eighty Cognito accounts, so
// the tests that matter most here are the ones that pin a REFUSAL. A parser bug reads a fragment of
// an email address; a validator bug grants a role nobody chose.
//
// Grouped by the property being pinned rather than by module, because several properties span two
// modules (the template's limits must match the validator's; the parser's BOM handling only matters
// because of the validator's header allowlist).

import { describe, it, expect } from "vitest";
import { parseCsv } from "./csv";
import { validateBulkCsv } from "./validate";
import { buildBulkInviteTemplate } from "./template";
import { TEAM_ROLES } from "@praimana/shared";
import {
  BULK_TEAM_ROLES,
  MAX_BULK_ROWS,
  MAX_CELL_CHARS,
  MAX_NEW_TEAMS_PER_FILE,
  TRANSACT_ITEM_CEILING,
  normalizeTeamName,
} from "./contract";

const HEADER = "team_name,email,platform_role,team_role";

/**
 * `n` valid rows spread across at most `MAX_NEW_TEAMS_PER_FILE` teams, i.e. the shape of a REAL
 * full file (80 people in 20 teams of four), not 80 teams of one.
 *
 * ⚠ MY FIRST VERSION GAVE EVERY ROW ITS OWN TEAM, so the 80-row boundary case tripped the 20-team
 * cap and looked like an off-by-one in the row cap. The helper was wrong, not the validator, worth
 * recording because a fixture that quietly violates a *different* bound is a confusing way to fail.
 */
const good = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Team ${i % MAX_NEW_TEAMS_PER_FILE},p${i}@example.com,PARTICIPANT,BUILDER`
  );
const file = (...lines: string[]) => [HEADER, ...lines].join("\n");

/** Narrow the union so a test can read `.plan` without a non-null assertion on every line. */
function mustPass(text: string) {
  const result = validateBulkCsv(text);
  if (!result.valid) {
    throw new Error(
      `expected the file to validate, but it was rejected: ${JSON.stringify(result.errors)}`
    );
  }
  return result;
}

function mustFail(text: string) {
  const result = validateBulkCsv(text);
  if (result.valid) throw new Error("expected the file to be REJECTED, but it validated");
  return result;
}

describe("⚠ the bounds are tied to DynamoDB's transaction ceiling", () => {
  /**
   * THE MOST IMPORTANT TEST IN THIS FILE, and the least obvious.
   *
   * The row cap and the team cap guarantee that teams and invitation rows commit in ONE `TransactWriteItems`, so
   * either the whole file applies or none of it does. That guarantee is only available below
   * DynamoDB's 100-item ceiling. The row cap and the team cap are 80 and 20 *because* they sum to
   * exactly 100, not because either number is independently meaningful.
   *
   * Raise either one without the other and the transaction becomes impossible, at which point the
   * atomicity claim silently degrades to a partially-applied file. That is the precise failure mode
   * validate-all-then-reject exists to prevent, so it would be a defect that undoes the design
   * while every other test stayed green. This is the assertion that catches it.
   */
  it("MAX_BULK_ROWS + MAX_NEW_TEAMS_PER_FILE never exceeds 100", () => {
    expect(MAX_BULK_ROWS + MAX_NEW_TEAMS_PER_FILE).toBeLessThanOrEqual(TRANSACT_ITEM_CEILING);
  });
});

describe("the parser accepts what a spreadsheet actually produces", () => {
  /**
   * ⚠ EXCEL WRITES A BOM BY DEFAULT. Left on the first header cell, `team_name` arrives as
   * `<BOM>team_name`, the allowlist rejects it as an unknown column, and a correctly-filled
   * template is refused for a reason the operator cannot see.
   *
   * ⚠ AND THIS TEST ASSERTS AT THE PARSER, NOT THROUGH THE VALIDATOR, because through the
   * validator it proves nothing. `String.prototype.trim()` ALREADY removes U+FEFF (it is in
   * ECMAScript's WhiteSpace production), so `validate.ts`'s `.trim().toLowerCase()` on each header
   * name masks a BOM whether or not the parser strips one. My first version of this test went
   * through `validateBulkCsv` and passed with `stripBom` deleted, it was pinning `trim()`.
   *
   * So there are two independent mechanisms and only one is under test here. `stripBom` stays as
   * the explicit one: relying on a whitespace-trim to fix a byte-order mark is a coincidence, and
   * the next person to write a header comparison without `.trim()` would reintroduce the bug.
   */
  it("strips a UTF-8 BOM from the first cell rather than leaving it for trim() to hide", () => {
    const { rows } = parseCsv("﻿" + file("Team A,a@example.com,PARTICIPANT,LEAD"));
    expect(rows[0].cells[0]).toBe("team_name");
  });

  it("and the file still validates end-to-end with a BOM", () => {
    const withBom = "﻿" + file("Team A,a@example.com,PARTICIPANT,LEAD");
    expect(mustPass(withBom).plan.members[0].email).toBe("a@example.com");
  });

  it("accepts CRLF line endings", () => {
    const crlf = [HEADER, "Team A,a@example.com,PARTICIPANT,"].join("\r\n");
    const plan = mustPass(crlf).plan;
    // A surviving \r would land on the last cell, here team_role, and fail the enum check.
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0].teamRole).toBeUndefined();
  });

  it("reads a quoted field containing a comma as ONE value", () => {
    const plan = mustPass(file('"Team Alpha, Beta",a@example.com,PARTICIPANT,')).plan;
    expect(plan.teams[0].teamName).toBe("Team Alpha, Beta");
  });

  it("reads a doubled quote inside a quoted field as a literal quote", () => {
    const plan = mustPass(file('"Team ""Best""",a@example.com,PARTICIPANT,')).plan;
    expect(plan.teams[0].teamName).toBe('Team "Best"');
  });

  it("skips blank lines and # comments, so the template uploads unedited", () => {
    const withNoise = ["# aiap-bulk-invite v1", "", HEADER, "Team A,a@example.com,PARTICIPANT,", ""].join("\n");
    expect(mustPass(withNoise).rowCount).toBe(1);
  });

  it("reports an unterminated quote instead of guessing where the field ends", () => {
    // Guessing is how a mis-quoted address silently becomes a DIFFERENT address.
    const errors = mustFail(file('"Team A,a@example.com,PARTICIPANT,')).errors;
    expect(errors[0].code).toBe("MALFORMED");
  });

  it("reports a stray quote in the middle of a field", () => {
    expect(mustFail(file('Team "A",a@example.com,PARTICIPANT,')).errors[0].code).toBe("MALFORMED");
  });

  it("⚠ bounds every cell, so one enormous value cannot pass the byte cap and flow downstream", () => {
    const huge = "x".repeat(MAX_CELL_CHARS + 1);
    const errors = mustFail(file(`${huge},a@example.com,PARTICIPANT,`)).errors;
    expect(errors[0].code).toBe("MALFORMED");
    expect(errors[0].message).toContain(`${MAX_CELL_CHARS}`);
  });

  it("counts lines from 1 including the header, matching what the operator sees", () => {
    const { rows } = parseCsv([HEADER, "Team A,a@example.com,PARTICIPANT,"].join("\n"));
    expect(rows[0].line).toBe(1);
    expect(rows[1].line).toBe(2);
  });

  it("keeps the ORIGINAL line number when blank lines are skipped", () => {
    // An error pointing at "row 3" when the editor shows row 5 is worse than no line number.
    const { rows } = parseCsv([HEADER, "", "", "Team A,a@example.com,PARTICIPANT,"].join("\n"));
    expect(rows[1].line).toBe(4);
  });
});

describe("the header IS the version, and unknown columns are refused", () => {
  /**
   * ⚠ REFUSED, NEVER IGNORED. A silently dropped `send_at` column is a facilitator
   * who believes they scheduled something. Tolerating extra columns is the friendlier default and
   * the wrong one, because the cost lands later and on someone else.
   */
  it("rejects an unrecognised column", () => {
    const errors = mustFail(
      ["team_name,email,platform_role,send_at", "Team A,a@example.com,PARTICIPANT,2026-01-01"].join("\n")
    ).errors;
    expect(errors[0].code).toBe("SCHEMA");
    expect(errors[0].message).toContain("send_at");
  });

  it("rejects a missing required column", () => {
    const errors = mustFail(["team_name,email", "Team A,a@example.com"].join("\n")).errors;
    expect(errors.some((e) => e.message.includes("platform_role"))).toBe(true);
  });

  it("accepts the file without the optional team_role column", () => {
    const plan = mustPass(["team_name,email,platform_role", "Team A,a@example.com,PARTICIPANT"].join("\n")).plan;
    expect(plan.members[0].teamRole).toBeUndefined();
  });

  it("accepts columns in any order", () => {
    const plan = mustPass(
      ["platform_role,email,team_name", "PARTICIPANT,a@example.com,Team A"].join("\n")
    ).plan;
    expect(plan.members[0]).toMatchObject({ email: "a@example.com", teamName: "Team A" });
  });

  it("rejects a duplicated column rather than picking one", () => {
    const errors = mustFail(
      ["team_name,email,platform_role,email", "Team A,a@example.com,PARTICIPANT,b@example.com"].join("\n")
    ).errors;
    expect(errors.some((e) => e.message.includes("more than once"))).toBe(true);
  });

  /**
   * A broken header must not bury its own error under eighty spurious row errors, the header is
   * the one thing the operator has to fix, so it must be the only thing reported.
   */
  it("⚠ stops at a broken header instead of validating rows against it", () => {
    const errors = mustFail(["team_name,email,nope", ...good(30).map((r) => r + ",x")].join("\n")).errors;
    expect(errors.every((e) => e.code === "SCHEMA")).toBe(true);
  });

  it("rejects an empty file and a header-only file, with different messages", () => {
    expect(mustFail("").errors[0].message).toContain("no header row");
    expect(mustFail(HEADER).errors[0].message).toContain("no rows");
  });
});

describe("⚠ platform_role is a closed set of TWO, the amplification control", () => {
  /**
   * THE SECURITY-SHAPED TEST. This is narrower than `ROLE_GRANTS` allows: a FACILITATOR *may*
   * grant FACILITATOR and JUDGE interactively, but not from a file.
   *
   * The reason is blast radius. One request creates up to eighty accounts, and
   * `user-access/src/routes.ts:250-253` already records what the unnarrowed version costs, a
   * caller who "could mint an ADMIN account's password". One cell in row 47 must never be able to
   * do that, and a reviewer scanning a spreadsheet will not catch it.
   */
  it.each(["ADMIN", "FACILITATOR", "JUDGE"])("refuses %s in a CSV", (role) => {
    const errors = mustFail(file(`Team A,a@example.com,${role},`)).errors;
    expect(errors[0].code).toBe("ROLE");
    expect(errors[0].column).toBe("platform_role");
  });

  it("explains WHY, because a facilitator can grant JUDGE in the interactive form", () => {
    // Without the reason this reads as a bug in the upload rather than a deliberate narrowing.
    expect(mustFail(file("Team A,a@example.com,JUDGE,")).errors[0].message).toMatch(
      /individually|cannot be set from a bulk file/i
    );
  });

  it.each(["PARTICIPANT", "EXECUTIVE"])("accepts %s", (role) => {
    expect(mustPass(file(`Team A,a@example.com,${role},`)).plan.members[0].platformRole).toBe(role);
  });

  it("accepts a lowercase role, because a spreadsheet will produce one", () => {
    expect(mustPass(file("Team A,a@example.com,participant,lead")).plan.members[0]).toMatchObject({
      platformRole: "PARTICIPANT",
      teamRole: "LEAD",
    });
  });

  /**
   * ⚠ NO DEFAULT (role is always explicit). The interactive forms deliberately removed their defaulted role so
   * that granting one is always explicit; a CSV is a worse place to inherit a default than a form,
   * because nobody reviews column 3 of row 47.
   */
  it("requires platform_role rather than defaulting it", () => {
    const errors = mustFail(file("Team A,a@example.com,,")).errors;
    expect(errors[0].code).toBe("MISSING");
    expect(errors[0].column).toBe("platform_role");
  });

  it("rejects an unknown team_role", () => {
    expect(mustFail(file("Team A,a@example.com,PARTICIPANT,CAPTAIN")).errors[0].column).toBe("team_role");
  });

  /**
   * ⚠ THE REGRESSION THAT ACTUALLY HAPPENED, ON A REAL UPLOAD.
   *
   * `BULK_TEAM_ROLES` was hardcoded to four values, taken from a stale doc comment in
   * `team/domain.ts` rather than from the `TeamRole` type, which has SIX. So a real file was rejected
   * on six rows for naming PRODUCT and DESIGNER, roles the invite form's dropdown has offered all
   * along, and the error told the operator their file was wrong when the validator was.
   *
   * It is now DERIVED from `TEAM_ROLES`, and these tests pin both halves: every role the platform
   * offers is accepted, and the derivation itself is the mechanism, so adding a seventh role works in
   * a CSV with no edit to the validator.
   */
  it.each(TEAM_ROLES.map((r) => r.role))("accepts the platform team role %s", (role) => {
    const plan = mustPass(file(`Team A,a@example.com,PARTICIPANT,${role}`)).plan;
    expect(plan.members[0].teamRole).toBe(role);
  });

  it("⚠ accepts EVERY role the platform defines, by derivation and not by list", () => {
    // If someone re-hardcodes this, the counts diverge and this fails.
    expect([...BULK_TEAM_ROLES].sort()).toEqual(TEAM_ROLES.map((r) => r.role).sort());
  });
});

describe("team names: one team, however it was typed", () => {
  /**
   * Design decision 3 is "match an existing team by name", which is only meaningful once "same
   * name" is defined. A facilitator's spreadsheet supplies every hard case: a trailing space from a
   * copy-paste, a non-breaking space pasted from a web page, inconsistent capitalisation.
   *
   * ⚠ TREATING THESE AS DIFFERENT TEAMS IS THE REAL BUG: it silently creates a near-duplicate team
   * and splits one real team across two, which nobody notices until the workshop starts.
   */
  it.each([
    ["a trailing and leading space", " Team Alpha "],
    ["a doubled internal space", "Team  Alpha"],
    ["different capitalisation", "team alpha"],
    ["a non-breaking space", "Team Alpha"],
    ["a zero-width joiner", "Team‍Alpha".replace("‍", "​ ")],
  ])("normalises %s to the same key", (_label, variant) => {
    expect(normalizeTeamName(variant)).toBe(normalizeTeamName("Team Alpha"));
  });

  it("groups rows that differ only in spelling into ONE team", () => {
    const plan = mustPass(
      file(
        "Team Alpha,a@example.com,PARTICIPANT,",
        "team  alpha,b@example.com,PARTICIPANT,",
        " TEAM ALPHA ,c@example.com,PARTICIPANT,"
      )
    ).plan;
    expect(plan.teams).toHaveLength(1);
    expect(plan.teams[0].memberCount).toBe(3);
  });

  it("keeps the FIRST raw spelling as the display name", () => {
    // The key is for comparison; what gets stored and shown is what the operator typed first.
    const plan = mustPass(
      file("Team Alpha,a@example.com,PARTICIPANT,", "team alpha,b@example.com,PARTICIPANT,")
    ).plan;
    expect(plan.teams[0].teamName).toBe("Team Alpha");
    expect(plan.teams[0].teamKey).toBe("team alpha");
  });

  it("requires a team name", () => {
    expect(mustFail(file(",a@example.com,PARTICIPANT,")).errors[0].column).toBe("team_name");
  });

  it("treats a whitespace-only team name as missing, not as a name", () => {
    expect(mustFail(file('"   ",a@example.com,PARTICIPANT,')).errors[0].code).toBe("MISSING");
  });
});

describe("⚠ duplicates are refused, not silently deduped", () => {
  /**
   * The same person listed twice for one team is a copy-paste mistake. Collapsing it quietly means
   * the file is not what its author thinks it is, and the next thing they do is trust the count.
   */
  it("refuses the same email twice for one team, naming the earlier line", () => {
    const errors = mustFail(
      file("Team A,dup@example.com,PARTICIPANT,", "Team A,DUP@example.com,PARTICIPANT,")
    ).errors;
    expect(errors[0].code).toBe("DUPLICATE");
    expect(errors[0].message).toContain("line 2");
  });

  it("ALLOWS the same email on two different teams", () => {
    // Not obviously right, but it is not this layer's call: Team owns membership and can refuse it
    // with the full picture. Refusing here would block a legitimate coach across two teams.
    expect(mustPass(file("Team A,x@example.com,PARTICIPANT,", "Team B,x@example.com,PARTICIPANT,")).plan.members)
      .toHaveLength(2);
  });
});

describe("email validation catches what a spreadsheet gets wrong", () => {
  it.each([
    ["no @", "nope"],
    ["two @", "a@@example.com"],
    ["nothing before @", "@example.com"],
    ["a domain with no dot", "a@localhost"],
    ["internal whitespace", "a b@example.com"],
    ["a trailing dot on the domain", "a@example.com."],
  ])("rejects %s", (_label, email) => {
    expect(mustFail(file(`Team A,${email},PARTICIPANT,`)).errors[0].column).toBe("email");
  });

  it("lowercases the address, because the platform stores it lowercased", () => {
    // If this drifted, the duplicate check and the platform's own rows would disagree.
    expect(mustPass(file("Team A,MixedCase@Example.COM,PARTICIPANT,")).plan.members[0].email).toBe(
      "mixedcase@example.com"
    );
  });

  it("⚠ does not hang on a long adversarial local part", () => {
    /**
     * The guard against catastrophic backtracking. A "comprehensive" RFC 5322 regex with nested
     * quantifiers turns this input into a DoS; the validator uses linear structural checks instead.
     * A generous ceiling rather than a tight one, this asserts "not pathological", not a benchmark.
     */
    const started = Date.now();
        validateBulkCsv(file(`Team A,${"a".repeat(300)}@example.com,PARTICIPANT,`));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("bounds are enforced with a message that says what to do", () => {
  it(`accepts exactly ${MAX_BULK_ROWS} rows`, () => {
    // The boundary itself must pass, an off-by-one here refuses a legitimate full file.
    expect(mustPass(file(...good(MAX_BULK_ROWS))).rowCount).toBe(MAX_BULK_ROWS);
  });

  it("refuses one row too many, and says how to fix it", () => {
    const result = mustFail(file(...good(MAX_BULK_ROWS + 1)));
    expect(result.errors[0].code).toBe("BOUNDS");
    expect(result.errors[0].message).toContain("Split it");
    expect(result.rowCount).toBe(MAX_BULK_ROWS + 1);
  });

  it("refuses too many distinct teams", () => {
    // Each row here names its own team, so the team cap bites before the row cap.
    const rows = Array.from(
      { length: MAX_NEW_TEAMS_PER_FILE + 1 },
      (_, i) => `Team ${i},p${i}@example.com,PARTICIPANT,`
    );
    expect(mustFail(file(...rows)).errors[0].message).toContain(`${MAX_NEW_TEAMS_PER_FILE}`);
  });

  it("caps the reported errors and says the list was truncated", () => {
    // An unbounded error array is an unbounded response body built from untrusted input.
    const rows = Array.from({ length: MAX_BULK_ROWS }, () => "Team A,not-an-email,PARTICIPANT,");
    const result = mustFail(file(...rows));
    expect(result.errors.length).toBeLessThanOrEqual(100);
  });

  it("reports errors in file order, not check order", () => {
    const result = mustFail(
      file("Team A,a@example.com,PARTICIPANT,", "Team B,bad,PARTICIPANT,", "Team C,,PARTICIPANT,")
    );
    const lines = result.errors.map((e) => e.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("refuses a row with more values than the header has columns", () => {
    // Almost always an unquoted comma inside a name; reading it would put a fragment in a field.
    expect(mustFail(file("Team A,a@example.com,PARTICIPANT,LEAD,extra")).errors[0].code).toBe("MALFORMED");
  });
});

describe("⚠ NOTHING is returned when ANY row is bad, validate-all-then-reject", () => {
  /**
   * Design decision 2, and the property the whole design rests on. The side effects downstream are
   * irreversible (Cognito accounts, and an emailed credential on the single-invite path), so a
   * half-applied file leaves the operator reconciling eighty addresses.
   *
   * A `valid: true` result with a partial plan would be the dangerous failure, the caller would
   * apply it.
   */
  it("returns no plan at all when one row of many is invalid", () => {
    const result = validateBulkCsv(file(...good(40), "Team X,broken,PARTICIPANT,", ...good(10)));
    expect(result.valid).toBe(false);
    expect(result).not.toHaveProperty("plan");
  });

  it("reports EVERY bad row, not just the first", () => {
    // One error at a time turns a ten-mistake file into ten upload attempts.
    const result = mustFail(
      file("Team A,bad1,PARTICIPANT,", "Team B,bad2,PARTICIPANT,", "Team C,bad3,PARTICIPANT,")
    );
    expect(result.errors).toHaveLength(3);
  });
});

describe("⚠ the template cannot document a limit the validator does not enforce", () => {
  /**
   * The template is generated from the same constants the validator reads, and these assertions are
   * what keep that true. A template promising 80 rows while the code enforces 60 is worse than no
   * template: the operator fills in 80 in good faith and is refused for a reason the documentation
   * denied.
   */
  const template = buildBulkInviteTemplate();

  it("states the real row and team caps", () => {
    expect(template).toContain(`${MAX_BULK_ROWS} rows`);
    expect(template).toContain(`${MAX_NEW_TEAMS_PER_FILE} different teams`);
  });

  it("names exactly the two roles the validator accepts, and no others", () => {
    expect(template).toContain("PARTICIPANT, EXECUTIVE");
    // The refused roles appear only in the explanatory line, never as a legal value.
    expect(template).not.toMatch(/^\s*[^#]*,(ADMIN|FACILITATOR|JUDGE),/m);
  });

  it("warns that one bad row rejects the file", () => {
    // Sets the expectation before the operator meets it, which is the difference between a clear
    // contract and a surprise.
    expect(template).toMatch(/ONE BAD ROW REJECTS THE WHOLE FILE/i);
  });

  /**
   * ⚠ THE TEMPLATE MUST BE VALID INPUT TO ITSELF. A facilitator downloads it, adds their rows under
   * the examples, and uploads it. If its own banner or notes broke the parser they would have to
   * know to delete them first, and the first thing they would see is a schema error on a file the
   * product gave them.
   */
  it("round-trips: the template it hands out is a file it accepts", () => {
    const result = mustPass(template);
    expect(result.plan.teams.map((t) => t.teamName)).toEqual(["Team Aurora", "Team Borealis"]);
    expect(result.plan.members).toHaveLength(3);
    expect(result.plan.members[0].teamRole).toBe("LEAD");
    // The third example leaves team_role empty, proving the optional column round-trips as absent.
    expect(result.plan.members[2].teamRole).toBeUndefined();
    expect(result.plan.members[2].platformRole).toBe("EXECUTIVE");
  });
});
