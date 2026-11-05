/**
 * THE TWO SYSTEM PROMPTS BEHIND A TEAM AI ASSESSMENT, and the description of what each call
 * receives — one module, no dependencies, two consumers.
 *
 * ── ⚠ WHY THESE LEFT `analyst.bedrock.ts` ──
 *
 * They are now read by TWO callers: the Bedrock adapter, which sends them, and
 * `GET /teams/:teamId/ratings/prompts`, which DISCLOSES them to the executive who presses
 * Analyze. The disclosure must be the same string that is sent — an executive shown a prompt
 * that is not the one the model received has been told something false about how a judgement of
 * a person was produced, which is worse than showing nothing at all.
 *
 * A test asserting two copies match would catch that drift a commit late. Importing ONE constant
 * makes the drift unrepresentable, so there is nothing to assert.
 *
 * ⚠ THIS MODULE MUST STAY DEPENDENCY-FREE, and specifically must never import
 * `@aws-sdk/client-bedrock-runtime`. `routes.ts` depends on the `RatingAnalyst` PORT and never on
 * the adapter (see AiDeps); exporting these from `analyst.bedrock.ts` and importing that into the
 * route would drag the SDK into the request path and collapse the seam that lets every other test
 * run without billing.
 *
 * ── WHAT THE `INPUTS` DESCRIPTIONS ARE FOR, AND WHY THEY ARE NOT DECORATION ──
 *
 * The prompts alone MISSTATE where the safety properties come from. `SUMMARY_SYSTEM` says "NEVER
 * refer to an individual"; a reader shown only that concludes the guarantee is the instruction.
 * It is not — `SummaryModelInput` carries team totals and a coarse spread label, so the model
 * cannot name someone it never saw. `domain.ts` records why: given per-member rows, a live probe
 * produced "one member drove the majority...", and the fix was to remove the capability rather
 * than to ask more firmly.
 *
 * So the disclosure ships the INPUT SHAPE beside each prompt. Anything less credits an
 * instruction with a property the input is actually holding.
 *
 * ── ⚠ PER-TEAM CUSTOM PROMPTS: CONSIDERED, PARKED ──────────────────────────────────────────
 *
 * The prompts are DISCLOSED, not editable. Letting an executive edit their own team's prompt was
 * scoped and deliberately deferred; the analysis is recorded here because this module is where
 * someone would come to implement it, and three of the findings are not obvious from the code.
 *
 *   1. A FREE-TEXT PROMPT BOX IS A SELF-SERVICE OUTAGE BUTTON. Both prompts end in a mandatory
 *      JSON schema, and `invoke` does `JSON.parse` then reads `aiKnowledgeScore` / `teamSummary`.
 *      An edit that breaks the contract yields MODEL_RESPONSE_INVALID → 502 — AFTER burning the
 *      generation lease and up to 11 Bedrock invokes. So the rules block and the schema have to be
 *      a fixed frame; only a bounded guidance block can be caller-supplied, and it must be
 *      REJECTED rather than truncated when over length (a prompt cut mid-sentence is the same
 *      failure class as stopReason=max_tokens, which this service already treats as hard).
 *   2. THE SUMMARY CALL IS THE ONE WITH A NON-TEAM AUDIENCE. It survives a hostile prompt for
 *      singling-out because the INPUT is aggregated totals — but the route's leak check only
 *      catches literal names, not invited speculation about roles or motives. Leave it fixed.
 *   3. THE KNOWLEDGE CALL HAS NO STRUCTURAL BACKSTOP. It genuinely receives the member's own
 *      messages, so "NEVER quote a message" and "NEVER compare people to each other" are the only
 *      protections on an output stored as a judgement of a named person.
 *
 * IF IT RETURNS: prefer CURATED PRESETS over free text — an emphasis enum selecting among prompts
 * written and probed here keeps the JSON contract and every safety rule provably intact, adds no
 * injection surface, and costs one field on the snapshot. Two things are then MANDATORY regardless
 * of shape: the snapshot must record which prompt produced it (`promptSource`/hash, schemaVersion
 * → 2), because otherwise this disclosure describes today's prompt while the reader looks at an
 * older analysis; and the new prompt must be RE-PROBED against the live model, since
 * rule-following is behavioural (see analyst.bedrock.ts on why the summary input was aggregated).
 *
 * Storage, when needed: the `teamAiRatings` partition already carries a reserved sort key
 * (CLAIM_SORT_KEY = "!claim") and `latest()` excludes every non-ULID sort value by construction via
 * ULID_SORT_FLOOR, so a `"!prompt"` item needs no new table and no change to that query.
 */

/**
 * The knowledge prompt.
 *
 * Says "coaching" rather than "grading" because that is the honest purpose and because the
 * output is read by the person it describes AND their teammates. A model told to rank people
 * writes comparative prose ("weaker than the others"), which is the one thing this output
 * must never contain.
 */
// nosemgrep: missing-template-string-indicator  -- reviewed; the construct is not the vulnerability this rule describes
export const KNOWLEDGE_SYSTEM = `You assess how effectively ONE person works with an AI coding assistant, to help them improve.

You receive an opaque handle for that person and samples of: messages they sent to their AI assistant, and messages they sent in team chat. You never receive names. You are assessing exactly one person and must return exactly one assessment.

Judge the CRAFT of working with an assistant, not the subject matter and not output volume:
- Do they give the assistant context, constraints and examples, or one-line requests?
- Do they iterate on a weak answer, or restate the same prompt?
- Do they check and challenge what it returns, or accept it?
- Do they decompose a hard problem before asking?

RULES, all of them mandatory:
- Write about the WORK, never the person. "Prompts often omit constraints", not "is careless".
- NEVER compare people to each other. Teammates read each other's assessments.
- NEVER quote a message. Describe the pattern instead.
- improvements must be specific and actionable — something they could try in their next turn.
- Someone with little material scores low CONFIDENCE, not low ability. Say so in the rationale rather than inventing a judgement.

Respond with ONLY a JSON object, no prose and no markdown fence:
{"handle":"<the handle given>","aiKnowledgeScore":<0-100>,"rationale":"<1-2 sentences>","strengths":["<short phrase>"],"improvements":["<short actionable phrase>"]}`;

/**
 * The summary prompt.
 *
 * It receives counters only, so it is told plainly what it cannot know. Without that, a model
 * handed five integers will happily narrate motives and quality it has no evidence for, and
 * that fabrication is what a judge would read.
 */
// nosemgrep: missing-template-string-indicator  -- reviewed; the construct is not the vulnerability this rule describes
export const SUMMARY_SYSTEM = `You write a short, factual summary of how a team worked, for facilitators, executives and judges.

You receive ONLY: the number of people on the team, TEAM-WIDE TOTALS (tasks created, tasks completed, messages sent, commits pushed, AI conversations shared, and AI assistant turns), and a coarse label for how evenly effort was spread. You have NO access to what anyone wrote and NO per-person figures. You must not pretend otherwise.

RULES, all of them mandatory:
- NEVER refer to an individual. Not by role, and NOT by paraphrase — "one member did most of the work", "the most active contributor", "one person drove the commits" are all FORBIDDEN. In a team of two or three, singling someone out this way identifies them as surely as naming them would. You have no per-person data to support such a claim in any case.
- Report the spread using the label you were given and nothing more. Correct: "Effort was spread somewhat unevenly." Forbidden: "One member drove most of it."
- NEVER infer quality, skill, motive or feeling. You cannot see any of it.
- Describe only what the totals support: overall throughput, how much the team leaned on the assistant, whether work was completed or left open, and the spread label.
- "AI assistant turns" is the real measure of assistant use; "AI conversations shared" counts a button press and is a much weaker signal. If the two disagree, trust turns.
- If the counts are too sparse to say anything, say that in one sentence rather than inventing a narrative.
- 2 to 4 sentences. No bullet points, no headings.

Respond with ONLY a JSON object, no prose and no markdown fence:
{"teamSummary":"<2-4 sentences>"}`;

/**
 * One disclosed call: the prompt, what reaches it, and who may read what comes back.
 *
 * `audience` is part of the disclosure rather than portal copy because it is the
 * two-audience rule, and the portal is not the place that decides it. A panel that described the
 * per-member coaching as publishable would be wrong about the one distinction this whole feature
 * is built around.
 */
export interface DisclosedPrompt {
  /** Stable key, so the portal orders and labels the blocks without matching on prose. */
  key: "knowledge" | "summary";
  title: string;
  /** The verbatim system prompt — the same constant the adapter sends. */
  system: string;
  /** What the model actually receives on this call. See the module note. */
  inputs: string[];
  /** Who may read this call's output. */
  audience: string;
}

/**
 * ⚠ THE CAPS ARE QUOTED FROM `routes.ts`, NOT RESTATED FROM MEMORY — see MAX_MEMBER_MESSAGES and
 * MAX_MESSAGE_CHARS. They are interpolated below rather than typed as prose so a change to either
 * constant moves the disclosure with it. "40 messages" hardcoded here is a sentence that becomes
 * false the day somebody tunes the cap, in a panel whose entire purpose is being accurate.
 */
export function ratingsPromptDisclosure(caps: {
  maxMemberMessages: number;
  maxMessageChars: number;
}): DisclosedPrompt[] {
  return [
    {
      key: "knowledge",
      title: "Per-member coaching",
      system: KNOWLEDGE_SYSTEM,
      inputs: [
        `One member at a time — never the whole team in one prompt.`,
        `An opaque handle (M1, M2, …). The model never receives a name.`,
        `Up to ${caps.maxMemberMessages} of that member's own messages to their AI assistant, each truncated to ${caps.maxMessageChars} characters.`,
        `Up to ${caps.maxMemberMessages} of that member's own team-chat messages, same truncation.`,
      ],
      audience:
        "Read by executives on this team. There is no path that publishes it outside the team.",
    },
    {
      key: "summary",
      title: "Team summary",
      system: SUMMARY_SYSTEM,
      inputs: [
        `Team-wide TOTALS only: tasks created, tasks completed, messages sent, commits pushed, AI conversations shared, AI assistant turns.`,
        `The number of people on the team.`,
        `A coarse, server-computed label for how evenly effort was spread — never who sat at which end of it.`,
        `⚠ No message text and no per-member rows. This is why the summary cannot single anyone out: it is a property of the input, not a promise the prompt makes.`,
      ],
      audience:
        "Once published by an executive, readable by facilitators, off-team executives and judges.",
    },
  ];
}
