import { SCORE_CRITERIA, judgeMean, roundHalfUp2dp } from "@praimana/service-shared";
import type { Score } from "./domain.js";

/**
 * ── PLACES: COMPUTED HERE, PUBLISHED BY THE OWNER ─────────────────
 *
 * A PURE module. No store, no clock, no request — every input is an argument, so every rule below is
 * testable without a table and a wrong ranking can be reproduced from its inputs alone. That matters
 * more here than anywhere else in this service: this function decides which team won.
 *
 * ── ⚠ WHY THIS RANKS TEAMS WHEN THE CODEBASE REFUSES TO RANK PEOPLE ──
 *
 * Three places in this repo deliberately decline to sort by score — the insights cards ("Ranking by
 * score made this a leaderboard"), `TokenUsagePanel` ("NOT SORTED BY AMOUNT"), and the artifacts
 * rollup ("deliberately not a leaderboard"). Those refusals are about ranking PEOPLE. Ranking TEAMS
 * is the outcome of a competition and is the point of a hackathon.
 *
 * The distinction is kept absolutely, and it constrains this file: places attach to SUBMISSIONS and
 * TEAMS. Nothing per-member reaches this computation — no `MemberActivity`, no `contributionScore`,
 * no per-member assessment. A team's place must never become a person's score.
 *
 * ── ⚠ AND NEVER A PARTIAL RANKING ──
 *
 * With five judges and two having scored, a computed order is a confident, WRONG, public statement
 * about named teams. That is why the refusals below are refusals rather than warnings: quorum,
 * evenness and staleness are checked BEFORE an order exists, and the caller cannot publish past them.
 */

/** One team's coverage, reported with a refusal so the owner can see who is missing. */
export interface Coverage {
  submissionId: string;
  teamId: string;
  teamName: string | null;
  judgeCount: number;
}

export interface Place {
  place: number;
  teamId: string;
  submissionId: string;
  teamName: string | null;
  average: number;
  judgeCount: number;
}

/** What the caller must supply per released team. */
export interface RankInput {
  submissionId: string;
  teamId: string;
  teamName: string | null;
  releasedAt: string | null;
  scores: Score[];
}

export type PlacesOutcome =
  | { outcome: "ok"; places: Place[]; tieBroken: boolean }
  | { outcome: "nothing-released" }
  | { outcome: "stale-scores"; stale: Array<{ submissionId: string; judgeId: string }> }
  | { outcome: "quorum-not-met"; coverage: Coverage[]; required: number }
  | { outcome: "coverage-uneven"; coverage: Coverage[] }
  | { outcome: "tie-unresolved"; ties: Array<{ place: number; submissionIds: string[] }> };

/**
 * The quorum, unless an experience overrides it.
 *
 * ⚠ RECORDED ON THE PUBLISHED ROW rather than only read from here, so a result published under a
 * different quorum stays explainable after this constant changes. The published row's field
 * `minScoresPerSubmission` exists for exactly that reason: "the quorum actually applied, recorded not
 * assumed".
 */
export const MIN_SCORES_PER_SUBMISSION = 1;

/**
 * Compute the ranking, or the reason it cannot be computed.
 *
 * `tieOrder`, when given, is the owner's explicit ordering of submission ids ("A tie for
 * a place is a human decision"). It is applied ONLY to break ties; it cannot reorder teams whose
 * averages differ, which would let an owner overrule the judges.
 */
export function computePlaces(
  entries: RankInput[],
  options: { minScoresPerSubmission?: number; tieOrder?: string[] } = {}
): PlacesOutcome {
  const required = options.minScoresPerSubmission ?? MIN_SCORES_PER_SUBMISSION;

  if (entries.length === 0) return { outcome: "nothing-released" };

  /**
   * ── A SCORE OLDER THAN THE RELEASE IT WAS CAST AGAINST BLOCKS PUBLICATION ──
   *
   * A reopen-then-release cycle produces a NEW snapshot, so a score cast before it was judging
   * different work. An open question — "are those scores void?" — remains unresolved; the refusal is
   * implemented now so nothing is published on an unanswered question, and whichever way it lands
   * (void them, or ask the judge to re-score) this check is where it goes.
   *
   * ⚠ CHECKED FIRST, before quorum, deliberately. A stale score still COUNTS toward `judgeCount`, so
   * checking quorum first would report "quorum met" about coverage that is partly invalid.
   */
  const stale = entries.flatMap((e) =>
    e.releasedAt === null
      ? []
      : e.scores
          .filter((s) => s.createdAt < (e.releasedAt as string))
          .map((s) => ({ submissionId: e.submissionId, judgeId: s.judgeId }))
  );
  if (stale.length > 0) return { outcome: "stale-scores", stale };

  const coverage: Coverage[] = entries.map((e) => ({
    submissionId: e.submissionId,
    teamId: e.teamId,
    teamName: e.teamName,
    judgeCount: e.scores.length,
  }));

  // Scarcity.
  if (coverage.some((c) => c.judgeCount < required)) {
    return { outcome: "quorum-not-met", coverage, required };
  }

  /**
   * UNEVENNESS, called out as "the more dangerous of the two". A team scored by
   * one harsh judge against a team scored by three generous ones is an unfair ranking that looks
   * arithmetically sound, so it is refused separately from scarcity rather than folded into it.
   */
  const counts = new Set(coverage.map((c) => c.judgeCount));
  if (counts.size > 1) return { outcome: "coverage-uneven", coverage };

  /**
   * ⚠ ROUNDED ONCE, AND RANKED ON THE ROUNDED VALUE. Ranking the raw mean while
   * displaying the rounded one puts two IDENTICAL numbers at different places, which cannot be
   * explained to the team that came second. So the number a team sees is the number that ranked it.
   */
  const scored = entries.map((e) => ({
    submissionId: e.submissionId,
    teamId: e.teamId,
    teamName: e.teamName,
    judgeCount: e.scores.length,
    average: roundHalfUp2dp(
      e.scores.reduce(
        (sum, s) => sum + judgeMean(s as unknown as Record<(typeof SCORE_CRITERIA)[number], number>),
        0
      ) / e.scores.length
    ),
  }));

  scored.sort((a, b) => b.average - a.average);

  /**
   * STANDARD COMPETITION RANKING — 1, 2, 2, 4. Not dense ranking (1, 2, 2, 3): with dense
   * ranking the team after a shared second place is told it came third, when three teams did better
   * than nobody and two did better than it.
   */
  const ranked: Place[] = scored.map((row) => {
    // The place is the 1-based position of the FIRST row with this average, which is what makes the
    // next distinct average skip (1, 2, 2, 4) rather than continue (1, 2, 2, 3).
    const firstEqual = scored.findIndex((other) => other.average === row.average);
    return { ...row, place: firstEqual + 1 };
  });

  const ties = groupTies(ranked);
  if (ties.length === 0) return { outcome: "ok", places: ranked, tieBroken: false };

  if (!options.tieOrder || options.tieOrder.length === 0) {
    return { outcome: "tie-unresolved", ties };
  }

  /**
   * ── THE OWNER'S ORDERING, APPLIED ──
   *
   * ⚠ THIS IS AN ASSUMPTION NEITHER DOCUMENT STATES, AND IT IS THE ONLY READING WHERE "ORDERING"
   * MEANS ANYTHING: a broken tie yields DISTINCT consecutive places (2 then 3), not two 2s with an
   * audit field attached. If the places stayed equal, the owner's decision would have changed
   * nothing that anybody could see, and `tieBrokenById` would record a human breaking a tie that is
   * still tied.
   *
   * Standard competition ranking still holds, because it describes the COMPUTATION: the preview an owner sees before
   * deciding shows 1, 2, 2, 4 and flags the tie. This branch is what publication does with the
   * answer.
   *
   * ⚠ THE ORDERING MUST COVER EVERY TIED SUBMISSION AND NOTHING ELSE. A partial list would leave
   * some ties unbroken while recording that a human broke them, and a list naming an untied
   * submission is an attempt to reorder teams whose averages differ — which would overrule the
   * judges. Either is `tie-unresolved`: the owner is asked again rather than obeyed partially.
   */
  const tiedIds = new Set(ties.flatMap((t) => t.submissionIds));
  const supplied = new Set(options.tieOrder);
  const coversExactly =
    supplied.size === options.tieOrder.length &&
    supplied.size === tiedIds.size &&
    [...tiedIds].every((id) => supplied.has(id));
  if (!coversExactly) return { outcome: "tie-unresolved", ties };

  const rank = new Map(options.tieOrder.map((id, i) => [id, i]));
  // Within one average, the owner's order decides; across averages, the judges' scores still do.
  ranked.sort((a, b) => {
    if (a.average !== b.average) return b.average - a.average;
    return (rank.get(a.submissionId) ?? 0) - (rank.get(b.submissionId) ?? 0);
  });

  return {
    outcome: "ok",
    // Distinct, consecutive places now that every tie has a human answer.
    places: ranked.map((row, index) => ({ ...row, place: index + 1 })),
    tieBroken: true,
  };
}

/** Places shared by more than one submission, in place order. */
function groupTies(ranked: Place[]): Array<{ place: number; submissionIds: string[] }> {
  const byPlace = new Map<number, string[]>();
  for (const row of ranked) {
    byPlace.set(row.place, [...(byPlace.get(row.place) ?? []), row.submissionId]);
  }
  return [...byPlace.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([place, submissionIds]) => ({ place, submissionIds }))
    .sort((a, b) => a.place - b.place);
}
