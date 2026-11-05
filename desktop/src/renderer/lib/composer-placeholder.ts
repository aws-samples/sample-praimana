/**
 * ── ⚠ WHAT THE EMPTY COMPOSER SAYS ────────────────────────────────────────────────────────────
 *
 * The old text was doing nothing, and it was slightly untrue. This is not a Q&A chatbot: the
 * assistant reads and writes files in the participant's project and (since kiro-trust.ts) asks before
 * it runs a command. "Ask anything" primes people to type questions at a tool whose value is being
 * asked for WORK — and it wastes the one moment the wording matters, which is an empty box in front of
 * somebody who does not yet know what this thing does.
 *
 * So the placeholder now names the WORKSHOP PHASE the team is in, because that is the thing a
 * participant is actually trying to make progress on:
 *
 *     Working on Design — tell Kiro what to build…
 *     Describe a change to acme-api…                  (no phase available)
 *     What are we building?                            (nothing known at all)
 *
 * ── ⚠ THE PHASE IS OFTEN ABSENT, AND THAT IS ORDINARY ──
 *
 * `phases:getPhases` reports no usable phase in five different situations, two of which are SUCCESS
 * responses:
 *
 *     no team / no workshop_id     → { ok: false, reason: "no-team" }
 *     403 or 404                   → { ok: false, reason: "access-lost" | "team-gone" }
 *     offline, timeout, busy slot  → { ok: false, reason: "unavailable" | "busy" }
 *     a workshop with no phases    → { ok: true, phases: [] }            ← success
 *     before the first phase       → { ok: true, currentPhaseOrder: 0 }  ← success
 *
 * Hence the fallback chain rather than a conditional string. Treating absence as exceptional is how a
 * composer ends up reading "Working on undefined —", and the two success cases mean this is not a rare
 * path: every team gets `currentPhaseOrder: 0` until a facilitator starts phase one.
 *
 * ── ⚠ NOT COUPLED TO THE FRAMEWORK, DELIBERATELY ──
 *
 * An earlier sketch of this named the experience's framework (AI-DLC, Spec Kit, OpenSpec) too. Dropped
 * for two reasons. `frameworkCheck` is not a cheap read — it hits the workshop endpoint AND inspects
 * the project folder, so painting a placeholder with it would restore exactly the per-mount network
 * call that the tab gating removed. And with no framework configured it returns the fallback name "the
 * project framework" (handlers/framework.ts), which reads grammatically and tells a participant
 * nothing. Phases and frameworks are independent systems; only the phase earns its place here.
 */

import { assistantLabel } from "./assistants";

/** A phase as `phases:getPhases` returns it. Only the two fields this file needs. */
export interface PhaseLike {
  name?: unknown;
  order?: unknown;
}

/**
 * How much server- or filesystem-supplied text may reach the placeholder.
 *
 * ⚠ BOUNDED BECAUSE NEITHER NAME IS OURS. A phase name comes from the workshop record and a project
 * name from a folder the user picked, so either can be far longer than the composer — and an
 * over-long placeholder does not wrap, it truncates mid-word against the send button and looks
 * broken. 32 is comfortably longer than every real phase ("Design", "Build", "Retrospective").
 */
export const MAX_NAME_CHARS = 32;

/**
 * Clean a name for display: collapse whitespace and control characters, trim, and cap.
 *
 * ⚠ CONTROL CHARACTERS COLLAPSE RATHER THAN VANISH, the same rule `frameworkName` follows in main. A
 * name containing a newline would otherwise reflow the textarea's placeholder onto two lines and
 * change the composer's height.
 */
function displayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NAME_CHARS ? `${cleaned.slice(0, MAX_NAME_CHARS - 1)}…` : cleaned;
}

/**
 * The name of the phase the team is currently on, or null when there is no usable one.
 *
 * ⚠ MATCHED ON `order`, NEVER `phases[0]`. `PhasesView` documents why: the array comes from an API
 * whose ordering is not guaranteed, so position says nothing about sequence. `currentPhaseOrder` is
 * the workshop's own pointer and 0 means "before the first phase" — a real state, not a missing value.
 */
export function currentPhaseName(
  phases: readonly PhaseLike[] | null | undefined,
  currentPhaseOrder: unknown
): string | null {
  if (!Array.isArray(phases) || phases.length === 0) return null;
  if (typeof currentPhaseOrder !== "number" || !Number.isFinite(currentPhaseOrder)) return null;
  // 0 is "not started yet". There is no phase to name, which is different from failing to find one.
  if (currentPhaseOrder <= 0) return null;

  const match = phases.find((p) => p?.order === currentPhaseOrder);
  return match ? displayName(match.name) : null;
}

export interface PlaceholderInput {
  /** Raw `ai_command` or `ai_provider` value — normalised through `assistantLabel`. */
  assistant: string | null | undefined;
  /** The open project's folder name, if there is one. */
  projectName?: string | null;
  /** From `currentPhaseName`. Null whenever no phase is known, which is common. */
  phaseName?: string | null;
  /** True while a turn is in flight. */
  streaming?: boolean;
}

/**
 * The composer's placeholder.
 *
 * Pure, and the whole decision lives here rather than in JSX, so both chat views get identical
 * wording and the fallback chain can be tested without mounting Electron.
 */
export function composerPlaceholder(input: PlaceholderInput): string {
  const label = assistantLabel(input.assistant);

  /**
   * ── ⚠ WHILE A TURN IS IN FLIGHT, SAY WHAT THE SCREEN DOES NOT ALREADY SAY ──────────────────
   *
   * This read `${label} is working…`, six pixels below an element saying exactly that: the "Working…"
   * bar in `KiroChatView` (with its own spinner and Cancel) and `ActivityPhrase` in
   * `AssistantChatView`. Two copies of one fact, and the more prominent copy was the one nobody
   * needed to read twice.
   *
   * ⚠ THE UNANSWERED QUESTION AT THAT MOMENT IS ABOUT THE BOX, NOT THE AGENT. The composer is
   * `readOnly` while streaming — deliberately, so it keeps focus and the caret instead of dropping
   * them (see the note at `readOnly` in both views) — so a participant who starts typing sees nothing
   * appear and has no way to tell a locked composer from a broken one. Nothing on screen explains
   * that, and it is the one thing this space can usefully add.
   *
   * ⚠ IT IS NOT A KEYBOARD HINT, and that is not an oversight. `⏎ send · ⇧⏎ newline` already sits in
   * every composer's action row — all three of them — and it is correctly hidden while streaming,
   * because a keybinding you cannot currently use is advice, not help.
   */
  if (input.streaming) return `You can type again when ${label} finishes…`;

  const phase = displayName(input.phaseName);
  if (phase) {
    /**
     * The em dash and the lower-case second clause are one sentence, not two labels: "Working on
     * Design — tell Kiro what to build…". Naming the assistant as well as the phase keeps the two
     * chat views distinguishable, which is what the old text did do usefully.
     */
    return `Working on ${phase} — tell ${label} what to build…`;
  }

  const project = displayName(input.projectName);
  if (project) return `Describe a change to ${project}…`;

  /**
   * ── ⚠ LAST RESORT: NO PHASE, NO PROJECT ───────────────────────────────────────────────────
   *
   * CHOSEN over "Ask <assistant> anything…" and over "Waiting for your input", and the
   * two rejections are the useful part of the record:
   *
   *   "anything"            — the original. Primes a question at a tool whose value is being asked
   *                           for WORK, and describes a Q&A box rather than an agent that edits files.
   *   "waiting for your…"   — reads as a STATUS, not an invitation. A placeholder that sounds like a
   *                           progress report gets misread as "the app is busy, do not type" — the
   *                           same confusion that made the streaming line worth separating from the
   *                           "Working…" bar.
   *
   * ⚠ NAMES NO ASSISTANT, unlike the two branches above, and that is deliberate rather than an
   * oversight: this branch is reached only when NOTHING is known — no phase, no project — which in
   * practice means a fresh install. "We" carries the collaboration without asserting a fact we do not
   * have, and it is the one line here that never goes stale.
   */
  return "What are we building?";
}
