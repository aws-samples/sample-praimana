/**
 * ── WHICH TEAMS NEED THE FACILITATOR'S ATTENTION ──────────────────────────────────────────
 *
 * Answers "which teams have gone quiet?", the one
 * thing a facilitator standing in a live room cannot answer by looking, because everyone looks busy.
 *
 * Pure functions, in `lib/` so they can be tested without rendering: this decides what gets flagged to
 * somebody running a room, and a wrong flag either sends them to the wrong table or lets a stuck team
 * sit there.
 *
 * ── ⚠ WHAT THIS CANNOT DO, AND WHY THE THRESHOLD IS COARSE ──
 *
 * The activity read-model is CUMULATIVE, totals plus one `updatedAt`, so "quiet" can only mean
 * "nothing has happened since <time>". It cannot mean "activity dropped off", because there is no
 * series to compare against. That is a real limit, not a simplification: a genuine trend would
 * need range Queries against the timestamped source tables.
 *
 * So the language is "no activity for N hours", never "activity is down".
 */

/** A team as the activity route reports it, the subset these rules read. */
export interface ActivityRow {
  teamId: string;
  teamName: string | null;
  memberCount: number | null;
  membersWithActivity: number;
  messagesSent: number;
  commitsPushed: number;
  tasksCreated: number;
  tasksCompleted: number;
  aiTurns: number | null;
  lastActivityAt: string | null;
  released: boolean;
}

/**
 * How long without any recorded activity before a team is worth walking over to.
 *
 * ⚠ FOUR HOURS IS A GUESS THAT SUITS ONE FORMAT AND NOT ANOTHER, and it is named here so it can be
 * argued with rather than buried in a comparison. In a one-day hackathon four hours is most of the
 * event; in an always-on track it is nothing. This remains an open decision, probably a
 * per-format default rather than one number.
 */
export const QUIET_AFTER_HOURS = 4;

export type Attention =
  /** Nothing recorded, ever. Different from "went quiet", they may never have started. */
  | { kind: "never-started"; team: ActivityRow }
  | { kind: "quiet"; team: ActivityRow; hoursSince: number }
  /** Activity but no assistant use, the coaching signal (Q4), not a fault. */
  | { kind: "no-ai-usage"; team: ActivityRow };

/**
 * Teams worth a facilitator's attention, most urgent first.
 *
 * `now` is a parameter rather than an ambient clock so the rule is testable and a long-open tab cannot
 * be reasoned about incorrectly, the same discipline `messageDayLabel` uses.
 *
 * ⚠ A RELEASED TEAM IS NEVER FLAGGED AS QUIET. They have finished; silence is the expected state, and
 * flagging it would train the facilitator to ignore this list.
 */
export function needsAttention(
  teams: ActivityRow[],
  now: Date = new Date(),
  quietAfterHours: number = QUIET_AFTER_HOURS
): Attention[] {
  const out: Attention[] = [];

  for (const team of teams) {
    if (team.released) continue;

    if (team.lastActivityAt === null || team.membersWithActivity === 0) {
      out.push({ kind: "never-started", team });
      continue;
    }

    const hoursSince = (now.getTime() - new Date(team.lastActivityAt).getTime()) / 3_600_000;
    if (hoursSince >= quietAfterHours) {
      out.push({ kind: "quiet", team, hoursSince });
      continue;
    }

    /**
     * ⚠ ONLY WHEN AI USAGE WAS ACTUALLY MEASURED. `aiTurns === null` means nobody measured it (rows
     * predating the counter), and flagging that would send a facilitator to coach a team who may have
     * been using their assistant all day.
     */
    if (team.aiTurns === 0) {
      out.push({ kind: "no-ai-usage", team });
    }
  }

  /** Never-started first, then longest-quiet, then coaching signals. */
  const rank = { "never-started": 0, quiet: 1, "no-ai-usage": 2 } as const;
  return out.sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if (a.kind === "quiet" && b.kind === "quiet") return b.hoursSince - a.hoursSince;
    return 0;
  });
}

/** Experience-wide totals, with the coverage a reader needs to tell a total from a floor. */
export function experienceTotals(teams: ActivityRow[]) {
  const sum = (pick: (t: ActivityRow) => number) => teams.reduce((n, t) => n + pick(t), 0);
  const measured = teams.filter((t) => typeof t.aiTurns === "number");

  return {
    teams: teams.length,
    /** ⚠ `null` when no team reported a roster count, not 0. */
    people: teams.some((t) => t.memberCount !== null)
      ? sum((t) => t.memberCount ?? 0)
      : null,
    peopleWithActivity: sum((t) => t.membersWithActivity),
    messagesSent: sum((t) => t.messagesSent),
    commitsPushed: sum((t) => t.commitsPushed),
    tasksCompleted: sum((t) => t.tasksCompleted),
    /** ⚠ Null unless at least one team had a measured figure; coverage reported alongside. */
    aiTurns: measured.length > 0 ? measured.reduce((n, t) => n + (t.aiTurns ?? 0), 0) : null,
    aiTurnsMeasuredForTeams: measured.length,
    released: teams.filter((t) => t.released).length,
  };
}
