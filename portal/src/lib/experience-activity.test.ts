import { describe, it, expect } from "vitest";
import {
  needsAttention,
  experienceTotals,
  QUIET_AFTER_HOURS,
  type ActivityRow,
} from "./experience-activity";

/**
 * WHAT GETS FLAGGED TO SOMEBODY RUNNING A LIVE ROOM.
 *
 * A wrong flag either sends a facilitator to the wrong table or leaves a stuck team sitting there, so
 * these rules are tested directly rather than through a component.
 */

const NOW = new Date("2026-08-16T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const team = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  teamId: "t1",
  teamName: "Code Vibranium",
  memberCount: 4,
  membersWithActivity: 3,
  messagesSent: 20,
  commitsPushed: 5,
  tasksCreated: 4,
  tasksCompleted: 2,
  aiTurns: 30,
  lastActivityAt: hoursAgo(0.5),
  released: false,
  ...over,
});

describe("needsAttention", () => {
  it("flags nothing when every team is active", () => {
    expect(needsAttention([team(), team({ teamId: "t2" })], NOW)).toEqual([]);
  });

  it("flags a team that has never done anything as never-started, not quiet", () => {
    // "Never started" and "went quiet" prompt different actions: one is a setup problem, the other is
    // a team that got stuck.
    const found = needsAttention(
      [team({ teamId: "t-new", lastActivityAt: null, membersWithActivity: 0 })],
      NOW
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("never-started");
  });

  it("flags a team with no activity for the threshold as quiet, with the hours", () => {
    const found = needsAttention([team({ lastActivityAt: hoursAgo(6) })], NOW);
    expect(found[0].kind).toBe("quiet");
    if (found[0].kind !== "quiet") return;
    expect(Math.round(found[0].hoursSince)).toBe(6);
  });

  it("does NOT flag a team just under the threshold", () => {
    expect(needsAttention([team({ lastActivityAt: hoursAgo(QUIET_AFTER_HOURS - 0.5) })], NOW)).toEqual(
      []
    );
  });

  it("⚠ NEVER flags a RELEASED team as quiet, silence is the expected state once they finish", () => {
    // Flagging it would train the facilitator to ignore this list.
    expect(
      needsAttention([team({ released: true, lastActivityAt: hoursAgo(48) })], NOW)
    ).toEqual([]);
    expect(
      needsAttention([team({ released: true, lastActivityAt: null, membersWithActivity: 0 })], NOW)
    ).toEqual([]);
  });

  it("flags measured zero AI usage as a coaching signal", () => {
    const found = needsAttention([team({ aiTurns: 0 })], NOW);
    expect(found[0].kind).toBe("no-ai-usage");
  });

  it("⚠ does NOT flag AI usage that was never MEASURED (null), only a measured zero", () => {
    /**
     * `aiTurns: null` means the counter did not exist when those rows were written. Flagging it would
     * send a facilitator to coach a team who may have used their assistant all day, the "null is not
     * zero" rule this codebase applies everywhere.
     */
    expect(needsAttention([team({ aiTurns: null })], NOW)).toEqual([]);
  });

  it("orders never-started first, then the longest-quiet, then coaching", () => {
    const found = needsAttention(
      [
        team({ teamId: "coach", aiTurns: 0 }),
        team({ teamId: "quiet-6h", lastActivityAt: hoursAgo(6) }),
        team({ teamId: "quiet-20h", lastActivityAt: hoursAgo(20) }),
        team({ teamId: "never", lastActivityAt: null, membersWithActivity: 0 }),
      ],
      NOW
    );
    expect(found.map((f) => f.team.teamId)).toEqual(["never", "quiet-20h", "quiet-6h", "coach"]);
  });

  it("honours a custom threshold, since 4h suits one format and not another", () => {
    const rows = [team({ lastActivityAt: hoursAgo(2) })];
    expect(needsAttention(rows, NOW, 4)).toEqual([]);
    expect(needsAttention(rows, NOW, 1)).toHaveLength(1);
  });
});

describe("experienceTotals", () => {
  it("sums across teams", () => {
    const totals = experienceTotals([
      team({ messagesSent: 10, commitsPushed: 2, tasksCompleted: 1, memberCount: 3, membersWithActivity: 2 }),
      team({ teamId: "t2", messagesSent: 5, commitsPushed: 1, tasksCompleted: 4, memberCount: 2, membersWithActivity: 1 }),
    ]);
    expect(totals).toMatchObject({
      teams: 2,
      people: 5,
      peopleWithActivity: 3,
      messagesSent: 15,
      commitsPushed: 3,
      tasksCompleted: 5,
    });
  });

  it("⚠ reports people as NULL when no roster count came back, not 0", () => {
    const totals = experienceTotals([team({ memberCount: null }), team({ teamId: "t2", memberCount: null })]);
    expect(totals.people).toBeNull();
  });

  it("⚠ reports aiTurns as NULL when nothing measured it, with coverage when something did", () => {
    expect(experienceTotals([team({ aiTurns: null })]).aiTurns).toBeNull();

    const partly = experienceTotals([team({ aiTurns: null }), team({ teamId: "t2", aiTurns: 12 })]);
    expect(partly.aiTurns).toBe(12);
    // Coverage travels with the figure: 12 turns, measured for 1 of 2 teams, a floor, not a total.
    expect(partly.aiTurnsMeasuredForTeams).toBe(1);
  });

  it("counts released teams", () => {
    expect(
      experienceTotals([team({ released: true }), team({ teamId: "t2", released: false })]).released
    ).toBe(1);
  });

  it("handles an experience with no teams without dividing by anything", () => {
    expect(experienceTotals([])).toMatchObject({ teams: 0, people: null, aiTurns: null, released: 0 });
  });
});
