// ── VALIDATE-ALL-THEN-REJECT ─────────────────────────────────────────────────────────────
//
// All-or-nothing: nothing is created until EVERY row passes. One bad row rejects
// the whole file.
//
// ⚠ WHY THAT IS THE RIGHT POLARITY HERE, when "process the good rows and report the bad" is the
// friendlier-sounding default. This path's side effects are not reversible: it creates Cognito
// accounts and (today, on the single-invite path) emails a temporary password that exists nowhere
// else. A half-applied file leaves the facilitator reconciling which of eighty addresses got how
// far, and re-uploading a corrected file risks a second account and a second email for everyone who
// already succeeded. Refusing early costs one edit; a torn apply costs an investigation.
//
// ── WHAT THIS MODULE IS *NOT* ──
//
// ⚠ IT IS NOT THE AUTHORITY. Everything here is SYNTACTIC — it consults no platform state. Whether
// the caller owns the workshop, whether a team name matches an existing team, whether a seat is
// free, and whether the caller may grant a role are all re-decided in the Team service, which owns
// those tables. These checks exist to give a fast, specific error instead of a
// round-trip, exactly as `/api/invite`'s own duplicated gate does.

import {
  BULK_PLATFORM_ROLES,
  BULK_TEAM_ROLES,
  KNOWN_COLUMNS,
  MAX_BULK_ROWS,
  MAX_ERRORS_REPORTED,
  MAX_NEW_TEAMS_PER_FILE,
  MAX_TEAM_NAME_CHARS,
  REQUIRED_COLUMNS,
  emailRejectionReason,
  normalizeEmail,
  normalizeTeamName,
  type BulkPlatformRole,
  type BulkTeamRole,
} from "./contract";
import { parseCsv } from "./csv";

export interface BulkRowError {
  /** 1-based line in the uploaded file, counting the header. */
  line: number;
  column?: string;
  code: BulkErrorCode;
  message: string;
}

export type BulkErrorCode =
  | "SCHEMA"
  | "BOUNDS"
  | "MALFORMED"
  | "MISSING"
  | "EMAIL"
  | "ROLE"
  | "TEAM_NAME"
  | "DUPLICATE";

/** One validated member row, normalised and ready to become part of the Team-service plan. */
export interface BulkPlannedMember {
  line: number;
  /** The raw spelling, which is what gets stored and displayed. */
  teamName: string;
  /** The comparison key — never displayed. */
  teamKey: string;
  email: string;
  platformRole: BulkPlatformRole;
  teamRole?: BulkTeamRole;
}

export interface BulkPlan {
  members: BulkPlannedMember[];
  /** Distinct teams in file order, by comparison key → first raw spelling seen. */
  teams: Array<{ teamKey: string; teamName: string; memberCount: number }>;
}

export type BulkValidationResult =
  | { valid: true; plan: BulkPlan; rowCount: number }
  | { valid: false; errors: BulkRowError[]; rowCount: number; truncated: boolean };

/** Sort by line, then by column, so the report reads in file order rather than check order. */
function ordered(errors: BulkRowError[]): BulkRowError[] {
  return [...errors].sort((a, b) => a.line - b.line || (a.column ?? "").localeCompare(b.column ?? ""));
}

function reject(errors: BulkRowError[], rowCount: number): BulkValidationResult {
  const all = ordered(errors);
  return {
    valid: false,
    errors: all.slice(0, MAX_ERRORS_REPORTED),
    rowCount,
    truncated: all.length > MAX_ERRORS_REPORTED,
  };
}

/**
 * Validate an already-decoded CSV body.
 *
 * ⚠ THE BYTE CAP IS *NOT* HERE. `MAX_FILE_BYTES` must be applied to the raw request body BEFORE
 * decoding, which only the route handler can do — by the time a string reaches this function the
 * memory has already been spent. This function takes text so it can be tested directly; the caller
 * owns the cap.
 */
export function validateBulkCsv(text: string): BulkValidationResult {
  const errors: BulkRowError[] = [];
  const { rows, errors: parseErrors } = parseCsv(text);

  for (const e of parseErrors) {
    errors.push({ line: e.line, code: "MALFORMED", message: e.message });
  }

  if (rows.length === 0) {
    return reject(
      [
        ...errors,
        {
          line: 1,
          code: "SCHEMA",
          message: "the file has no header row — download the template and fill it in",
        },
      ],
      0
    );
  }

  // ── THE HEADER IS THE VERSION ──
  const header = rows[0];
  const headerNames = header.cells.map((c) => c.trim().toLowerCase());

  const unknown = headerNames.filter((h) => h !== "" && !KNOWN_COLUMNS.includes(h));
  const missing = REQUIRED_COLUMNS.filter((c) => !headerNames.includes(c));

  for (const name of unknown) {
    errors.push({
      line: header.line,
      column: name,
      code: "SCHEMA",
      // ⚠ REFUSED, NEVER IGNORED. A dropped column is a facilitator believing they configured
      // something. Naming the accepted set makes a typo self-correcting.
      message: `unknown column "${name}" — this file accepts only ${KNOWN_COLUMNS.join(", ")}`,
    });
  }
  for (const name of missing) {
    errors.push({
      line: header.line,
      column: name,
      code: "SCHEMA",
      message: `required column "${name}" is missing`,
    });
  }

  // A duplicated column would make cell lookup ambiguous, so it is refused before any row is read.
  const seenHeader = new Set<string>();
  for (const name of headerNames) {
    if (name === "") continue;
    if (seenHeader.has(name)) {
      errors.push({
        line: header.line,
        column: name,
        code: "SCHEMA",
        message: `column "${name}" appears more than once`,
      });
    }
    seenHeader.add(name);
  }

  const dataRows = rows.slice(1);

  // ⚠ A BROKEN HEADER STOPS HERE. Validating rows against a header we could not understand would
  // bury the one error that matters under eighty spurious ones.
  if (errors.length > 0) return reject(errors, dataRows.length);

  if (dataRows.length === 0) {
    return reject(
      [{ line: header.line, code: "SCHEMA", message: "the file has a header but no rows" }],
      0
    );
  }

  if (dataRows.length > MAX_BULK_ROWS) {
    // Reported against the first row over the line, so the operator can see where to cut.
    return reject(
      [
        {
          line: dataRows[MAX_BULK_ROWS].line,
          code: "BOUNDS",
          message: `this file has ${dataRows.length} rows; the maximum is ${MAX_BULK_ROWS}. Split it into smaller files.`,
        },
      ],
      dataRows.length
    );
  }

  const at = (row: string[], column: string): string => {
    const i = headerNames.indexOf(column);
    return i === -1 || i >= row.length ? "" : row[i];
  };

  const members: BulkPlannedMember[] = [];
  const teamOrder: string[] = [];
  const teamDisplay = new Map<string, string>();
  const teamCounts = new Map<string, number>();
  /** (teamKey, email) already seen → the line it was on, so the message can name it. */
  const seenPair = new Map<string, number>();

  for (const row of dataRows) {
    const line = row.line;

    // A row with more cells than the header means a stray comma — almost always an unquoted comma
    // inside a name. Refused, because reading it would put a fragment into a field.
    if (row.cells.length > headerNames.length) {
      errors.push({
        line,
        code: "MALFORMED",
        message: `this row has ${row.cells.length} values but the header has ${headerNames.length} columns — an unquoted comma?`,
      });
      continue;
    }

    const rawTeam = at(row.cells, "team_name").trim();
    const rawEmail = at(row.cells, "email");
    const rawPlatform = at(row.cells, "platform_role").trim().toUpperCase();
    const rawTeamRole = at(row.cells, "team_role").trim().toUpperCase();

    let rowOk = true;

    // ── team_name ──
    const teamKey = normalizeTeamName(rawTeam);
    if (teamKey === "") {
      errors.push({ line, column: "team_name", code: "MISSING", message: "team_name is required" });
      rowOk = false;
    } else if (rawTeam.length > MAX_TEAM_NAME_CHARS) {
      errors.push({
        line,
        column: "team_name",
        code: "TEAM_NAME",
        message: `team_name is longer than ${MAX_TEAM_NAME_CHARS} characters`,
      });
      rowOk = false;
    }

    // ── email ──
    const email = normalizeEmail(rawEmail);
    const emailProblem = emailRejectionReason(email);
    if (emailProblem) {
      errors.push({ line, column: "email", code: "EMAIL", message: emailProblem });
      rowOk = false;
    }

    // ── platform_role ──
    if (rawPlatform === "") {
      errors.push({
        line,
        column: "platform_role",
        code: "MISSING",
        // ⚠ NO DEFAULT, DELIBERATELY. Granting a role must be an explicit act, and
        // nobody reviews column 3 of row 47.
        message: `platform_role is required — one of ${BULK_PLATFORM_ROLES.join(", ")}`,
      });
      rowOk = false;
    } else if (!(BULK_PLATFORM_ROLES as readonly string[]).includes(rawPlatform)) {
      errors.push({
        line,
        column: "platform_role",
        code: "ROLE",
        // The message explains WHY rather than just refusing: a facilitator who can grant JUDGE in
        // the interactive form will otherwise read this as a bug.
        message:
          `platform_role "${rawPlatform}" cannot be set from a bulk file. ` +
          `Only ${BULK_PLATFORM_ROLES.join(" and ")} are allowed here; ` +
          `invite admins, facilitators and judges individually.`,
      });
      rowOk = false;
    }

    // ── team_role (optional) ──
    if (rawTeamRole !== "" && !(BULK_TEAM_ROLES as readonly string[]).includes(rawTeamRole)) {
      errors.push({
        line,
        column: "team_role",
        code: "ROLE",
        message: `team_role "${rawTeamRole}" is not one of ${BULK_TEAM_ROLES.join(", ")}`,
      });
      rowOk = false;
    }

    if (!rowOk) continue;

    // ── within-file duplicates ──
    //
    // ⚠ REFUSED RATHER THAN DEDUPED. The same person listed twice for one team is a copy-paste
    // mistake, and silently collapsing it hides the fact that the file is not what its author
    // thinks it is. Naming the earlier line makes it a one-second fix.
    const pairKey = `${teamKey}\u0000${email}`;
    const earlier = seenPair.get(pairKey);
    if (earlier !== undefined) {
      errors.push({
        line,
        column: "email",
        code: "DUPLICATE",
        message: `${email} is already listed for this team on line ${earlier}`,
      });
      continue;
    }
    seenPair.set(pairKey, line);

    if (!teamDisplay.has(teamKey)) {
      // FIRST raw spelling wins.
      teamDisplay.set(teamKey, rawTeam);
      teamOrder.push(teamKey);
    }
    teamCounts.set(teamKey, (teamCounts.get(teamKey) ?? 0) + 1);

    members.push({
      line,
      teamName: teamDisplay.get(teamKey)!,
      teamKey,
      email,
      platformRole: rawPlatform as BulkPlatformRole,
      ...(rawTeamRole ? { teamRole: rawTeamRole as BulkTeamRole } : {}),
    });
  }

  if (errors.length > 0) return reject(errors, dataRows.length);

  /**
   * ⚠ THE TEAM CAP IS CHECKED AGAINST DISTINCT NAMES IN THE FILE, WHICH IS THE PESSIMISTIC READ.
   *
   * Some of these names may match existing teams and so create nothing — only the Team service can
   * tell, because it owns `teams`. Checking the distinct count here means the transaction ceiling
   * (§C) can never be exceeded no matter how the resolution lands, at the cost of occasionally
   * refusing a file that would have fit. Refusing early is the safe direction: the alternative is
   * discovering it when the transaction is rejected, after the ownership and seat hops.
   */
  if (teamOrder.length > MAX_NEW_TEAMS_PER_FILE) {
    return reject(
      [
        {
          line: header.line,
          code: "BOUNDS",
          message: `this file names ${teamOrder.length} different teams; the maximum is ${MAX_NEW_TEAMS_PER_FILE}.`,
        },
      ],
      dataRows.length
    );
  }

  return {
    valid: true,
    rowCount: dataRows.length,
    plan: {
      members,
      teams: teamOrder.map((teamKey) => ({
        teamKey,
        teamName: teamDisplay.get(teamKey)!,
        memberCount: teamCounts.get(teamKey) ?? 0,
      })),
    },
  };
}
