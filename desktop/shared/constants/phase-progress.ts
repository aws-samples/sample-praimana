/**
 * ── DO THE THINKING BEFORE YOU BUILD: THE FIRST PHASE MUST BE WRITTEN UP ───────────────────
 *
 * ── ⚠ WHAT "MOVE TO A PHASE" ACTUALLY MEANS ON THIS PLATFORM, BECAUSE IT IS NOT WHAT IT SOUNDS ──
 *
 * A participant cannot move themselves anywhere. Phase progression is WORKSHOP-WIDE and
 * FACILITATOR-CONTROLLED: `PATCH /workshops/:id/current-phase` sets `currentPhaseOrder` on the workshop
 * row, every team sees the same current phase, and the desktop derives each phase's
 * COMPLETED / IN_PROGRESS / NOT_STARTED pill from that one number. There is no per-team advance action
 * to gate.
 *
 * What a team CAN do per-phase is WRITE ITS NOTES, in any phase, in any order. So the rule this module
 * expresses is the one that is actually available and actually matches the intent: a team cannot open
 * up a LATER phase's notes until the FIRST phase has been written up properly.
 *
 * ── ⚠ AND IT IS A WORKFLOW GATE, NOT A SECURITY BOUNDARY ──
 *
 * Enforced in the desktop, which is the ONLY surface that writes phase notes — the portal's phase
 * router has a read (`listForTeam`) and no write at all, verified. The service does NOT enforce it, and
 * that is deliberate rather than an omission:
 *
 *   · the write route is `PUT /workshops/teams/:teamId/phases/:phaseId` and the workshop service has no
 *     teamId → workshopId resolver, so it cannot look up the phase ORDERS without either reading the
 *     Team context's tables (a cross-context dependency rule forbids it) or a new east-west hop;
 *   · the alternative — trusting a client-supplied `workshopId` — would make the "rule" bypassable by
 *     omitting a query parameter, AND would break every already-installed desktop build, which sends
 *     none. A rule that fails open for old clients and breaks new ones is worse than an honest UI gate.
 *
 * Nothing is protected by this. Skipping it costs a team nothing but the nudge it exists to give, so the
 * proportionate enforcement point is where the participant is standing. If it ever needs to be a real
 * precondition, the place for it is the RELEASE ladder in the evaluation service, which already owns
 * "is this submission allowed to go to judges" and already resolves the workshop.
 */

/**
 * How many words the first phase needs before the rest open up.
 *
 * ⚠ FIFTY IS A CHOSEN NUMBER, not a derived one. It began at 100 and was revised down to 50 the same
 * week. Both
 * figures are deliberate round numbers — enough that a team cannot satisfy the gate with a title and a
 * bullet, small enough to be a few minutes of writing rather than an essay — and 50 sits further towards
 * "a nudge" than "a hurdle".
 *
 * Recorded as a decision, with its history, so a later reader does not go looking for the analysis that
 * produced it: there wasn't one, and pretending otherwise would be worse than saying so. If it moves
 * again, this is the ONLY line to change — the desktop's lock, its live counter and the copy in the
 * locked-row notice all read it, and the tests derive their boundary from it rather than hardcoding a
 * figure.
 */
export const MIN_FIRST_PHASE_WORDS = 50;

/**
 * Count words the way a person would skim them.
 *
 * ⚠ WHITESPACE-SEPARATED RUNS, NOT A LINGUISTIC WORD COUNT. Markdown syntax, URLs and bullet
 * characters all count, which OVER-counts slightly against a team writing dense prose. That direction
 * is chosen on purpose: the failure to avoid is telling a team that has genuinely written a page that
 * they have not written enough. The gate is a floor, not a measurement.
 *
 * Shared so the desktop's live counter and the lock decision cannot disagree — two implementations of
 * "how many words is that" is how a participant ends up looking at "100 / 100" next to a disabled
 * button.
 */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** The shape this module needs from a phase — deliberately narrower than either app's Phase type. */
export interface PhaseProgressInput {
  order: number;
  content?: string | null;
}

/**
 * The first phase in pipeline order, or null when there are none.
 *
 * ⚠ BY `order`, NEVER BY NAME AND NEVER BY ARRAY POSITION. The live pipeline is Ideation / Build / Demo
 * and is now immutable, but a differently-named first phase must still be the one that gates — and the
 * array arrives from an API whose ordering is not part of any contract.
 */
function firstPhase(phases: PhaseProgressInput[]): PhaseProgressInput | null {
  let best: PhaseProgressInput | null = null;
  for (const phase of phases) {
    if (best === null || phase.order < best.order) best = phase;
  }
  return best;
}

/** Words still needed in the first phase before the later ones open. 0 once the floor is met. */
export function firstPhaseWordsRemaining(phases: PhaseProgressInput[]): number {
  const first = firstPhase(phases);
  if (!first) return MIN_FIRST_PHASE_WORDS;
  return Math.max(0, MIN_FIRST_PHASE_WORDS - countWords(first.content));
}

/**
 * May this phase's notes be edited yet?
 *
 * ⚠ THE FIRST PHASE IS ALWAYS OPEN. It is the one a team has to write to satisfy the gate, so locking
 * it would be a deadlock — and that is the single most important line in this file.
 *
 * ⚠ AND AN EMPTY PIPELINE OPENS EVERYTHING. `phases: []` means the caller could not load the pipeline,
 * not that the team has failed a requirement. Locking every phase on a failed read would turn a network
 * blip into "you may not write anything", which is the wrong direction for a nudge: this gate must
 * never be the reason a team cannot record their work.
 */
export function isPhaseNotesUnlocked(
  phase: PhaseProgressInput,
  phases: PhaseProgressInput[]
): boolean {
  const first = firstPhase(phases);
  if (!first) return true;
  if (phase.order <= first.order) return true;
  return countWords(first.content) >= MIN_FIRST_PHASE_WORDS;
}
