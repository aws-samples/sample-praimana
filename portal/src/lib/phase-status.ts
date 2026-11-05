/**
 * ── ⚠ A PHASE'S STATUS IS DERIVED FROM THE WORKSHOP, NOT STORED PER TEAM ────────────────────
 *
 * This is the rule the whole platform already runs on, and writing it down here closes a gap that
 * had a visible symptom.
 *
 * Phase progression is WORKSHOP-WIDE and FACILITATOR-CONTROLLED: `PATCH
 * /workshops/:id/current-phase` sets `currentPhaseOrder` on the workshop row, every team in the
 * workshop sees the same current phase, and a phase's COMPLETED / IN_PROGRESS / NOT_STARTED pill is
 * a COMPARISON against that one number. `shared/constants/phase-progress.ts` states this at length
 * ("There is no per-team advance action to gate"), and it is why the workshop service's own
 * `TeamPhase` carries content, an editor and a timestamp but NO status field: per-team phase status
 * is not a thing that exists.
 *
 * ── WHAT WENT WRONG WITHOUT THIS ──
 *
 * `team.getById` returned a hardcoded `teamPhases: []`, and two screens read it as though it were
 * real data. The workspace layout's phase stepper is behind `length > 0`, so it silently never
 * rendered. The insights page was not so lucky: it reported `phasesCompleted: 0` of `0 total` on a
 * page executives read, which states as fact that a team has completed nothing.
 *
 * ── WHY A MODULE FOR TWO COMPARISONS ──
 *
 * ⚠ THE DESKTOP ALREADY IMPLEMENTS THIS EXACT TERNARY (`renderer/components/PhasesView.tsx`), and
 * its test asserts the operators literally so an inverted one cannot mark finished phases pending.
 * A second hand-rolled copy in the portal is how the two front-ends come to disagree about whether
 * a team has finished a phase, so this is the portal's single copy, with its own test, rather than
 * the comparison inlined at each call site.
 *
 * ⚠ IT IS NOT IN `shared/`, DELIBERATELY. That directory is a vendored, drift-checked copy of the
 * canonical `shared/` repo (README, "Keeping the copies honest"); a portal-authored file there would
 * have no upstream to be checked against. If this rule is ever promoted, `shared/` is the right
 * home for it and the desktop's copy should collapse into the same import, that is a coordinated
 * cross-repo change, not something to fake by adding a file to a mirror.
 */

/** The three states a phase pill can show. Same spellings the desktop and the UI already use. */
export type PhaseStatus = "COMPLETED" | "IN_PROGRESS" | "NOT_STARTED";

/**
 * Where one phase sits relative to the workshop's current phase.
 *
 * ⚠ THE OPERATORS MATCH THE DESKTOP EXACTLY, `<` then `===`, in that order. Inverting either one
 * mislabels every finished phase as pending, or the current phase as done.
 *
 * `currentPhaseOrder` of 0 means the facilitator has not started the workshop, so EVERY phase is
 * NOT_STARTED. That falls out of the comparison rather than being special-cased: phase orders are
 * 1-based, so nothing is ever `< 0` or `=== 0`.
 */
export function derivePhaseStatus(
  order: number,
  currentPhaseOrder: number
): PhaseStatus {
  return order < currentPhaseOrder
    ? "COMPLETED"
    : order === currentPhaseOrder
      ? "IN_PROGRESS"
      : "NOT_STARTED";
}

/** The shape this module needs from a phase definition, narrower than any API type. */
export interface PhaseStatusInput {
  id: string;
  order: number;
  name: string;
}

/** A phase definition with its derived status attached. */
export interface PhaseWithStatus extends PhaseStatusInput {
  status: PhaseStatus;
}

/**
 * Attach a derived status to each phase, ORDERED BY `order`.
 *
 * ⚠ SORTED HERE RATHER THAN TRUSTED. The array arrives from an API whose ordering is not part of any
 * contract, and both consumers render it as a sequence, a stepper reading "Demo → Ideation → Build"
 * is worse than no stepper. `phase-progress.ts` sorts for the same reason and says so.
 *
 * A NEW ARRAY, so a caller's input is never reordered underneath it.
 */
export function phasesWithStatus(
  phases: PhaseStatusInput[],
  currentPhaseOrder: number
): PhaseWithStatus[] {
  return [...phases]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ ...p, status: derivePhaseStatus(p.order, currentPhaseOrder) }));
}
