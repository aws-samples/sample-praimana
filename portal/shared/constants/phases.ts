import type { PhaseType } from "../types/phase";

export interface PhaseDefinition {
  type: PhaseType;
  name: string;
  description: string;
  templatePrompts: string[];
}

export const PHASE_DEFINITIONS: PhaseDefinition[] = [
  {
    type: "PROBLEM_DEFINITION",
    name: "Problem Definition",
    description: "Define the business problem your team will solve. Be specific about the pain points, affected users, and desired outcomes.",
    templatePrompts: [
      "What is the business problem?",
      "Who is affected and how?",
      "What does success look like?",
      "What constraints exist?",
    ],
  },
  {
    type: "IDEATION",
    name: "Ideation",
    description: "Brainstorm potential solutions. Think broadly, then narrow down to the most promising approach.",
    templatePrompts: [
      "What are 3-5 possible solutions?",
      "What are the pros and cons of each?",
      "Which solution best balances impact and feasibility?",
      "What AI capabilities could accelerate this?",
    ],
  },
  {
    type: "ARCHITECTURE",
    name: "Architecture",
    description: "Design the technical architecture for your chosen solution. Define components, data flows, and integration points.",
    templatePrompts: [
      "What are the major system components?",
      "How do they interact?",
      "What data model is needed?",
      "What AWS services will you use?",
    ],
  },
  {
    type: "BUILD",
    name: "Build",
    description: "Implement your solution. Use AI to generate code, review implementations, and accelerate development.",
    templatePrompts: [
      "What are the key tasks to complete?",
      "What should we build first (MVP)?",
      "What can AI generate for us?",
      "How will we test it?",
    ],
  },
  {
    type: "DEMO",
    name: "Demo",
    description: "Prepare and deliver your demo. Tell a compelling story about the problem, your solution, and its impact.",
    templatePrompts: [
      "What is the demo narrative (problem → solution → impact)?",
      "What is the live demo flow?",
      "How did AI accelerate your work?",
      "What would you build next?",
    ],
  },
];

/**
 * ── ⚠ THE PIPELINE EVERY EXPERIENCE ACTUALLY RUNS: THREE FIXED PHASES ──────────────────────
 *
 * The three phases are fixed: they cannot be edited or removed when creating a new experience.
 *
 * ── WHY A SEPARATE CONSTANT FROM `PHASE_DEFINITIONS` ABOVE ──
 *
 * ⚠ `PHASE_DEFINITIONS` HAS FIVE ENTRIES AND IS REFERENCED BY NOTHING. Verified: no import of it anywhere
 * outside this file. It describes a pipeline the platform does not run — Problem
 * Definition, Ideation, Architecture, Build, Demo — while every live workshop has exactly the three
 * below (checked against the deployed `praimana-phases` table: Ideation/1, Build/2, Demo/3).
 *
 * It is left in place rather than deleted because its `templatePrompts` are the only written record of
 * what each phase is *for*, and deleting them in a change about a form would be losing content in
 * passing. But it is NOT the source of truth and must not be mistaken for one — hence a separate,
 * narrower constant with a name that says what it governs.
 *
 * ── WHY THE PIPELINE IS FIXED AT ALL ──
 *
 * Two reasons, and the second is the one that decides it:
 *
 *   1. The phases are IMMUTABLE once created (`PUT /workshops/:id/phases` refuses
 *      any change with `PHASES_IMMUTABLE`, because phase ids key every team's notes and appear in
 *      released submission snapshots). So a pipeline chosen wrongly on the create form could never be
 *      corrected — an editor that offers a permanent, uncorrectable choice is a trap, not a feature.
 *   2. ⚠ THE PLATFORM ALREADY DEPENDS ON THESE NAMES. `PHASE_LINK_FIELDS` keys the Demo phase's two URL
 *      fields on the name `"demo"`; `buildPhaseIdFor` finds the documents panel by the name `"build"`.
 *      A facilitator renaming Build to "Development" silently lost the file panel and the demo links.
 *      The editor was offering to break the product.
 *
 * `description` is supplied HERE rather than left blank for the facilitator to fill in later. The
 * experience page used to say *"Add a description in Settings to describe what teams do here"* — and no
 * settings screen has ever edited phases, so that was a dead end before the immutability change and an
 * impossibility after it.
 */
export const FIXED_PHASE_PIPELINE: readonly { name: string; description: string }[] = [
  {
    name: "Ideation",
    description:
      "Define the problem and shape the idea. Work with your assistant to explore the space before building anything.",
  },
  {
    name: "Build",
    description:
      "Build the solution. Your team's files land here, so sync them from the desktop app as you go.",
  },
  {
    name: "Demo",
    description:
      "Show it working. Record the live application URL and your demo recording, then an executive releases it to the judges.",
  },
];
