// ── THE DOWNLOADABLE TEMPLATE ────────────────────────────────────────────────────────────
//
// ⚠ GENERATED FROM THE VALIDATOR'S OWN CONSTANTS, never written alongside them.
//
// A template that says "80 rows maximum" while the validator enforces 60 is worse than no template
// at all: the operator fills in 80 rows in good faith and the file is refused for a reason the
// documentation explicitly denied. `template.test.ts` pins the property, every limit and every
// role named in this text is interpolated, so the two cannot drift.
//
// The template is also VALID INPUT TO ITSELF: its banner and trailing notes are `#` comment lines,
// which `parseCsv` skips, so a facilitator can download it, add rows, and upload it without
// deleting anything first. The example rows are the only thing they must replace.

import {
  BULK_PLATFORM_ROLES,
  BULK_TEAM_ROLES,
  MAX_BULK_ROWS,
  MAX_NEW_TEAMS_PER_FILE,
  OPTIONAL_COLUMNS,
  REQUIRED_COLUMNS,
} from "./contract";

export const TEMPLATE_VERSION = "v1";
export const TEMPLATE_FILENAME = "bulk-team-invite-template.csv";

/** The header the validator accepts, in the canonical order. */
const HEADER = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(",");

/**
 * Three example rows, chosen to demonstrate the three things people get wrong:
 * two members on ONE team (so the team column repeats rather than being left blank),
 * a second team in the same file, and an EXECUTIVE alongside participants.
 */
const EXAMPLES = [
  "Team Aurora,ada@example.com,PARTICIPANT,LEAD",
  "Team Aurora,grace@example.com,PARTICIPANT,BUILDER",
  "Team Borealis,exec@example.com,EXECUTIVE,",
];

export function buildBulkInviteTemplate(): string {
  return [
    `# aiap-bulk-invite ${TEMPLATE_VERSION}`,
    `#`,
    `# Fill in one row per person. Repeat the team name for each member of that team.`,
    `# A team name that already exists in this experience ADDS those people to it;`,
    `# a new name CREATES the team.`,
    `#`,
    `# Limits: at most ${MAX_BULK_ROWS} rows, naming at most ${MAX_NEW_TEAMS_PER_FILE} different teams.`,
    `# platform_role must be one of: ${BULK_PLATFORM_ROLES.join(", ")}`,
    `#   (admins, facilitators and judges cannot be invited from a file, invite them individually)`,
    `# team_role is optional, one of: ${BULK_TEAM_ROLES.join(", ")} (default BUILDER)`,
    `#`,
    `# ONE BAD ROW REJECTS THE WHOLE FILE and nothing is created, so a mistake here is`,
    `# safe to fix and re-upload.`,
    `#`,
    `# Replace the three example rows below with your own.`,
    HEADER,
    ...EXAMPLES,
    "",
  ].join("\n");
}
