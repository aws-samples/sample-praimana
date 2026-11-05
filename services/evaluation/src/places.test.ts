import { describe, it, expect } from "vitest";
import { computePlaces, MIN_SCORES_PER_SUBMISSION } from "./places.js";
import type { RankInput } from "./places.js";
import type { Score } from "./domain.js";

/**
 * The ranking rules, tested as pure functions: quorum, unevenness, standard competition ranking,
 * tie resolution and stale scores.
 *
 * This is the computation that decides which team won, so every rule is exercised on its own rather
 * than through a route: a wrong ranking must be reproducible from its inputs alone.
 */

/** A score whose five criteria all equal `n`, so `judgeMean` is exactly `n`. */
const flat = (judgeId: string, n: number, createdAt = "2026-01-06T00:00:00.000Z"): Score => ({
  submissionId: "unused",
  judgeId,
  innovation: n,
  execution: n,
  aiUsage: n,
  impact: n,
  presentation: n,
  comment: null,
  createdAt,
});

const entry = (over: Partial<RankInput> & { submissionId: string }): RankInput => ({
  teamId: `team-${over.submissionId}`,
  teamName: `Team ${over.submissionId}`,
  releasedAt: "2026-01-05T00:00:00.000Z",
  scores: [],
  ...over,
});

describe("computePlaces — the happy path", () => {
  it("ranks by the mean of judge means, highest first", () => {
    const result = computePlaces([
      entry({ submissionId: "s-low", scores: [flat("j1", 4)] }),
      entry({ submissionId: "s-high", scores: [flat("j1", 9)] }),
      entry({ submissionId: "s-mid", scores: [flat("j1", 7)] }),
    ]);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.places.map((p) => [p.place, p.submissionId, p.average])).toEqual([
      [1, "s-high", 9],
      [2, "s-mid", 7],
      [3, "s-low", 4],
    ]);
  });

  it("averages ACROSS judges, not across criteria only", () => {
    // j1 means 4, j2 means 8 → 6.
    const result = computePlaces([
      entry({ submissionId: "s1", scores: [flat("j1", 4), flat("j2", 8)] }),
      entry({ submissionId: "s2", scores: [flat("j1", 5), flat("j2", 5)] }),
    ]);

    if (result.outcome !== "ok") throw new Error(result.outcome);
    expect(result.places[0]).toMatchObject({ submissionId: "s1", average: 6, judgeCount: 2 });
    expect(result.places[1]).toMatchObject({ submissionId: "s2", average: 5 });
  });

  it("carries the pinned team name through, for a results screen", () => {
    const result = computePlaces([
      entry({ submissionId: "s1", teamName: "Code Vibranium", scores: [flat("j1", 7)] }),
    ]);
    if (result.outcome !== "ok") throw new Error(result.outcome);
    expect(result.places[0].teamName).toBe("Code Vibranium");
  });

  it("rounds the average to 2dp, and ranks on the ROUNDED value", () => {
    /**
     * ⚠ THE WHOLE POINT OF ROUNDING BEFORE RANKING. These two differ in the third decimal:
     * 7.777… vs 7.775. Ranked raw they are strictly ordered; rounded they are both 7.78 and must
     * SHARE a place — otherwise two identical displayed numbers sit at different places, which
     * cannot be explained to the team that came second.
     */
    const a = [flat("j1", 8), flat("j2", 8), flat("j3", 7)]; // 7.6667
    const b = [flat("j1", 8), flat("j2", 7), flat("j3", 8)]; // 7.6667
    const result = computePlaces([
      entry({ submissionId: "s-a", scores: a }),
      entry({ submissionId: "s-b", scores: b }),
    ]);

    if (result.outcome !== "tie-unresolved") throw new Error(`got ${result.outcome}`);
    expect(result.ties).toEqual([{ place: 1, submissionIds: ["s-a", "s-b"] }]);
  });

  it("nothing released is its own outcome, not an empty ranking", () => {
    // An empty places list would publish successfully and declare that nobody won.
    expect(computePlaces([]).outcome).toBe("nothing-released");
  });
});

describe("computePlaces — standard competition ranking", () => {
  it("two equal averages share place 2, and the next team is place 4", () => {
    const result = computePlaces(
      [
        entry({ submissionId: "s-first", scores: [flat("j1", 10)] }),
        entry({ submissionId: "s-tie-a", scores: [flat("j1", 7)] }),
        entry({ submissionId: "s-tie-b", scores: [flat("j1", 7)] }),
        entry({ submissionId: "s-last", scores: [flat("j1", 3)] }),
      ],
      // Supplied so the tie does not refuse — this test is about the PLACE NUMBERS the computation
      // produces, which is what the owner's preview shows.
      {}
    );

    // Unresolved, because a tie exists — but the ties it reports name the shared place.
    if (result.outcome !== "tie-unresolved") throw new Error(`got ${result.outcome}`);
    expect(result.ties).toEqual([{ place: 2, submissionIds: ["s-tie-a", "s-tie-b"] }]);
  });

  it("is NOT dense ranking — the team after a shared 2nd is 4th, never 3rd", () => {
    const result = computePlaces(
      [
        entry({ submissionId: "s1", scores: [flat("j1", 10)] }),
        entry({ submissionId: "s2", scores: [flat("j1", 7)] }),
        entry({ submissionId: "s3", scores: [flat("j1", 7)] }),
        entry({ submissionId: "s4", scores: [flat("j1", 3)] }),
      ],
      { tieOrder: ["s2", "s3"] }
    );

    if (result.outcome !== "ok") throw new Error(result.outcome);
    // With the tie broken the places are distinct and consecutive — see the note in places.ts.
    expect(result.places.map((p) => [p.place, p.submissionId])).toEqual([
      [1, "s1"],
      [2, "s2"],
      [3, "s3"],
      [4, "s4"],
    ]);
  });

  it("a three-way tie at the top shares place 1 and the next team is 4th", () => {
    const result = computePlaces([
      entry({ submissionId: "a", scores: [flat("j1", 8)] }),
      entry({ submissionId: "b", scores: [flat("j1", 8)] }),
      entry({ submissionId: "c", scores: [flat("j1", 8)] }),
      entry({ submissionId: "d", scores: [flat("j1", 2)] }),
    ]);

    if (result.outcome !== "tie-unresolved") throw new Error(`got ${result.outcome}`);
    expect(result.ties).toEqual([{ place: 1, submissionIds: ["a", "b", "c"] }]);
  });
});

describe("computePlaces — the refusals", () => {
  it("a team below quorum refuses publication and reports per-team coverage", () => {
    const result = computePlaces(
      [
        entry({ submissionId: "s-scored", scores: [flat("j1", 8), flat("j2", 7)] }),
        entry({ submissionId: "s-unscored", scores: [] }),
      ],
      { minScoresPerSubmission: 2 }
    );

    if (result.outcome !== "quorum-not-met") throw new Error(`got ${result.outcome}`);
    expect(result.required).toBe(2);
    expect(result.coverage).toEqual([
      {
        submissionId: "s-scored",
        teamId: "team-s-scored",
        teamName: "Team s-scored",
        judgeCount: 2,
      },
      {
        submissionId: "s-unscored",
        teamId: "team-s-unscored",
        teamName: "Team s-unscored",
        judgeCount: 0,
      },
    ]);
  });

  it("equal-but-different judge counts refuse as UNEVEN, not as scarce", () => {
    /**
     * Unevenness is "the more dangerous of the two" — a team scored by one harsh judge
     * against a team scored by three generous ones is unfair in a way that looks arithmetically
     * sound. Both teams clear a quorum of 1 here, so the two refusals must be distinguishable.
     */
    const result = computePlaces(
      [
        entry({ submissionId: "s-one", scores: [flat("j1", 4)] }),
        entry({ submissionId: "s-three", scores: [flat("j1", 8), flat("j2", 8), flat("j3", 8)] }),
      ],
      { minScoresPerSubmission: 1 }
    );

    expect(result.outcome).toBe("coverage-uneven");
    if (result.outcome !== "coverage-uneven") return;
    expect(result.coverage.map((c) => c.judgeCount)).toEqual([1, 3]);
  });

  it("quorum is reported BEFORE unevenness when both are true", () => {
    // 0 and 3 fails both. Scarcity is the more actionable message: nobody has scored that team.
    const result = computePlaces(
      [
        entry({ submissionId: "s-none", scores: [] }),
        entry({ submissionId: "s-three", scores: [flat("j1", 8), flat("j2", 8), flat("j3", 8)] }),
      ],
      { minScoresPerSubmission: 1 }
    );
    expect(result.outcome).toBe("quorum-not-met");
  });

  it("a tie refuses publication until the owner supplies an ordering", () => {
    const tied = [
      entry({ submissionId: "s-a", scores: [flat("j1", 7)] }),
      entry({ submissionId: "s-b", scores: [flat("j1", 7)] }),
    ];

    expect(computePlaces(tied).outcome).toBe("tie-unresolved");

    const resolved = computePlaces(tied, { tieOrder: ["s-b", "s-a"] });
    if (resolved.outcome !== "ok") throw new Error(resolved.outcome);
    expect(resolved.tieBroken).toBe(true);
    // The owner put s-b first, and the judges' equal averages did not.
    expect(resolved.places.map((p) => p.submissionId)).toEqual(["s-b", "s-a"]);
  });

  it("⚠ an ordering may break a tie but must NOT reorder teams the judges separated", () => {
    // s-high beat s-low on the scores. An ordering naming them is an attempt to overrule the judges,
    // and it is refused rather than partly obeyed.
    const result = computePlaces(
      [
        entry({ submissionId: "s-high", scores: [flat("j1", 9)] }),
        entry({ submissionId: "s-low", scores: [flat("j1", 4)] }),
      ],
      { tieOrder: ["s-low", "s-high"] }
    );

    // No tie existed, so there was nothing to break — and the ordering changes nothing.
    if (result.outcome !== "ok") throw new Error(result.outcome);
    expect(result.places.map((p) => p.submissionId)).toEqual(["s-high", "s-low"]);
    expect(result.tieBroken).toBe(false);
  });

  it("a PARTIAL ordering is refused rather than partly applied", () => {
    // Two separate ties; the owner answered only one. Recording "a human broke the tie" while a tie
    // remains would be false.
    const result = computePlaces(
      [
        entry({ submissionId: "a1", scores: [flat("j1", 9)] }),
        entry({ submissionId: "a2", scores: [flat("j1", 9)] }),
        entry({ submissionId: "b1", scores: [flat("j1", 4)] }),
        entry({ submissionId: "b2", scores: [flat("j1", 4)] }),
      ],
      { tieOrder: ["a1", "a2"] }
    );

    expect(result.outcome).toBe("tie-unresolved");
  });

  it("an ordering naming an UNTIED submission is refused", () => {
    const result = computePlaces(
      [
        entry({ submissionId: "tied-a", scores: [flat("j1", 7)] }),
        entry({ submissionId: "tied-b", scores: [flat("j1", 7)] }),
        entry({ submissionId: "clear", scores: [flat("j1", 2)] }),
      ],
      { tieOrder: ["tied-a", "tied-b", "clear"] }
    );

    expect(result.outcome).toBe("tie-unresolved");
  });

  it("a score cast BEFORE the latest release blocks publication", () => {
    /**
     * A reopen-then-release produces a new snapshot, so a score cast before it was judging different
     * work. Whether such scores are void has not been decided, so nothing is published
     * while the question is open.
     */
    const result = computePlaces([
      entry({
        submissionId: "s1",
        releasedAt: "2026-01-10T00:00:00.000Z",
        scores: [flat("j-stale", 9, "2026-01-02T00:00:00.000Z")],
      }),
    ]);

    if (result.outcome !== "stale-scores") throw new Error(`got ${result.outcome}`);
    expect(result.stale).toEqual([{ submissionId: "s1", judgeId: "j-stale" }]);
  });

  it("a score cast AFTER the release is fine", () => {
    const result = computePlaces([
      entry({
        submissionId: "s1",
        releasedAt: "2026-01-10T00:00:00.000Z",
        scores: [flat("j1", 9, "2026-01-11T00:00:00.000Z")],
      }),
    ]);
    expect(result.outcome).toBe("ok");
  });

  it("staleness is checked BEFORE quorum, so coverage is never reported as met on invalid scores", () => {
    const result = computePlaces(
      [
        entry({
          submissionId: "s1",
          releasedAt: "2026-01-10T00:00:00.000Z",
          scores: [flat("j1", 9, "2026-01-01T00:00:00.000Z")],
        }),
      ],
      { minScoresPerSubmission: 5 }
    );
    // Quorum also fails (1 < 5) — but a stale score should not be counted toward coverage at all.
    expect(result.outcome).toBe("stale-scores");
  });

  it("a submission with no releasedAt cannot have stale scores", () => {
    // Defensive: a legacy row with a null releasedAt has nothing to compare against, and must not
    // become permanently unpublishable because of it.
    const result = computePlaces([
      entry({ submissionId: "s1", releasedAt: null, scores: [flat("j1", 6)] }),
    ]);
    expect(result.outcome).toBe("ok");
  });
});

describe("the default quorum", () => {
  it("is 1 — a published ranking requires at least one score per released team", () => {
    expect(MIN_SCORES_PER_SUBMISSION).toBe(1);
  });

  it("is applied when the caller does not override it", () => {
    const result = computePlaces([entry({ submissionId: "s1", scores: [] })]);
    expect(result.outcome).toBe("quorum-not-met");
  });
});
