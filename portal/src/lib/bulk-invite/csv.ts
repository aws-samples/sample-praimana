// ── A DELIBERATELY TINY CSV PARSER ───────────────────────────────────────────────────────
//
// ⚠ WHY NOT papaparse. A general CSV parser's value IS the features this contract
// refuses, streaming, type coercion, dynamic delimiters, embedded newlines, custom escapes. It
// would arrive with a transitive dependency tree on the single surface in the product that eats
// untrusted files uploaded by an operator. The accepted grammar here is small enough to read in
// one sitting, which is the property that matters for a parser on that surface.
//
// THE GRAMMAR, in full:
//   - UTF-8, with a leading BOM stripped
//   - rows separated by \n or \r\n
//   - fields separated by ,
//   - a field may be double-quoted; "" inside a quoted field is a literal "
//   - NO embedded newlines inside quotes, NO backslash escapes
//
// ⚠ NO REGEX TOUCHES A CELL. This is a character loop precisely so there is no possibility of
// catastrophic backtracking on a crafted file.

import { MAX_CELL_CHARS } from "./contract";

/** A parsed line, keeping the file line number so every error can point at the user's editor. */
export interface CsvRow {
  /** 1-based, counting the header, the number the operator sees in Excel or an editor. */
  line: number;
  cells: string[];
}

export interface CsvParseError {
  line: number;
  message: string;
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: CsvParseError[];
}

/**
 * ⚠ A BOM IS STRIPPED, AND THIS IS NOT A NICETY.
 *
 * Excel writes UTF-8 with a BOM by default. Left in place it becomes part of the FIRST header
 * cell, so `team_name` arrives as `U+FEFFteam_name`, the header allowlist rejects it, and the
 * operator is told their correctly-filled template has an unknown column. That is the single most
 * likely way this feature would appear broken to someone doing everything right.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split one line into fields. Returns null when quoting is malformed, because a row whose quoting
 * we cannot resolve must be REPORTED rather than silently reinterpreted, guessing is how a
 * mis-quoted address becomes a different address.
 */
function splitLine(line: string): string[] | null {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'; // an escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        // Anything other than a separator or end-of-line after a closing quote is malformed.
        if (i < line.length && line[i] !== ",") return null;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      // A quote is only legal at the START of a field; `a"b` is a mistake, not a quoted field.
      if (cell.length > 0) return null;
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      cells.push(cell);
      cell = "";
      i++;
      continue;
    }

    cell += ch;
    i++;
  }

  // An unterminated quote at end-of-line: the grammar has no embedded newlines, so this is an error
  // rather than a continuation.
  if (inQuotes) return null;

  cells.push(cell);
  return cells;
}

/**
 * Parse the whole file.
 *
 * BLANK LINES ARE SKIPPED, not reported: a trailing newline is universal, and a spreadsheet export
 * frequently leaves blank rows in the middle. Neither is a mistake worth refusing a file over.
 *
 * A LINE STARTING `#` IS A COMMENT and skipped, that is what carries the template's own banner and
 * its trailing notes, so a facilitator can upload the template they downloaded without deleting
 * anything first.
 */
export function parseCsv(text: string): CsvParseResult {
  const rows: CsvRow[] = [];
  const errors: CsvParseError[] = [];

  const lines = stripBom(text).split("\n");

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].replace(/\r$/, "");
    const lineNumber = idx + 1;

    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("#")) continue;

    const cells = splitLine(line);
    if (cells === null) {
      errors.push({
        line: lineNumber,
        message:
          "could not read this line, check the double quotes (a quote inside a quoted value must be doubled)",
      });
      continue;
    }

    // ⚠ BOUND EVERY CELL. The file byte cap already bounds the total, but a single 60 KiB cell
    // would pass that and then be handed to downstream validation, storage and an email template.
    const tooLong = cells.findIndex((c) => c.length > MAX_CELL_CHARS);
    if (tooLong !== -1) {
      errors.push({
        line: lineNumber,
        message: `column ${tooLong + 1} is longer than ${MAX_CELL_CHARS} characters`,
      });
      continue;
    }

    rows.push({ line: lineNumber, cells });
  }

  return { rows, errors };
}
