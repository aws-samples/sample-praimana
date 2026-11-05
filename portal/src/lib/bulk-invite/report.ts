// ── THE ANNOTATED ERROR REPORT ───────────────────────────────────────────────────────────
//
// On a validation failure the portal offers the operator their ORIGINAL file back with
// a trailing `error` column, so they fix it in place rather than cross-referencing line numbers
// against a list on screen.
//
// ⚠ THIS IS THE ONE PLACE HOSTILE INPUT IS WRITTEN BACK INTO A FILE THE OPERATOR OPENS.
//
// Everything else about this feature reads the CSV and answers in JSON, which a browser renders as
// text. This function does the opposite: it takes the uploaded rows, arbitrary, possibly
// second-hand content, and produces a spreadsheet. So `csvCell` (which prefixes a formula-leading
// cell with `'`) is not optional decoration here; it is the control that stops
// `=cmd|'/c calc'!A0` in a team name from executing on the facilitator's machine when they
// double-click the report.
//
// Generated CLIENT-SIDE from the JSON error response, so the server never stores an operator's file
// and there is nothing to expire, leak, or clean up.

import { csvCell } from "./contract";
import type { BulkRowError } from "./validate";

/**
 * Rebuild the uploaded file with an `error` column appended.
 *
 * `originalText` is the exact bytes the operator uploaded, so line numbers line up with the errors
 * without re-parsing, which also means a line the parser could not read still appears, with its
 * error beside it. Re-parsing to rebuild would drop exactly the rows most in need of annotation.
 */
export function buildAnnotatedCsv(originalText: string, errors: BulkRowError[]): string {
  // Several errors can land on one line (a bad email AND a bad role), and the operator needs all of
  // them, not the first.
  const byLine = new Map<number, string[]>();
  for (const e of errors) {
    const label = e.column ? `${e.column}: ${e.message}` : e.message;
    byLine.set(e.line, [...(byLine.get(e.line) ?? []), label]);
  }

  const lines = originalText.replace(/^\ufeff/, "").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const lineNo = i + 1;

    // A trailing newline produces one empty element; emitting it would add a stray row.
    if (raw === "" && i === lines.length - 1) continue;

    const problems = byLine.get(lineNo);

    // Comment and blank lines are passed through untouched, they are the template's own banner, and
    // rewriting them would make the round-trip lossy.
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
      out.push(raw);
      continue;
    }

    /**
     * ⚠ THE ORIGINAL LINE IS PASSED THROUGH VERBATIM, NOT RE-ESCAPED.
     *
     * It is already valid CSV as the operator wrote it, and re-quoting it would corrupt their
     * quoting. The formula-injection guard therefore cannot be applied to it here, which is
     * acceptable and worth being explicit about: that content is what they themselves uploaded and
     * already have on disk, so the report adds no exposure it did not already have.
     *
     * ⚠ THE `error` COLUMN IS DIFFERENT AND IS GUARDED. Its text INCLUDES ECHOED CELL VALUES (a
     * rejected role, an unknown column name), so it is a path from their file into a NEW cell, and
     * a cell the report author controls the position of. That one goes through `csvCell`.
     */
    if (problems) {
      out.push(`${raw},${csvCell(problems.join(" | "))}`);
    } else if (lineNo === 1) {
      // The header gains the column name so the file stays well-formed.
      out.push(`${raw},error`);
    } else {
      out.push(`${raw},`);
    }
  }

  return out.join("\n") + "\n";
}
