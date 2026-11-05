/**
 * ── REPORTING A BUG, AND GIVING FEEDBACK — the shared vocabulary ───────────────────────────
 *
 * ── ⚠ THIS FILE USED TO BUILD `mailto:` LINKS. THEY ARE GONE. ──
 *
 * The first implementation composed a prefilled `mailto:` with the reporter's context in the body. The rule
 * now: feedback and bug reports are stored in the database and shown to facilitators and admins; they are
 * not emailed by the reporter. The backend notifies the current experience's facilitators and admins.
 *
 * So a report is now a `POST` that stores a row, and the PLATFORM emails staff. What that changed:
 *
 *   · the reporter never sees a staff address, and cannot lose a report to a misconfigured mail client;
 *   · reports are in ONE place, so nobody has to forward anything and none can sit unread in a personal
 *     inbox;
 *   · no support address needs configuring, so the feature is never invisible for want of an env var —
 *     which is what happened previously, leaving the entry points missing from the portal.
 *
 * ⚠ AND ONE THING IT GAVE UP, worth naming because somebody will hit it. A `mailto:` WORKED WHEN THE
 * PLATFORM DID NOT: a report about "the site is down" could still be sent, because the mail client is not
 * this platform. An in-app form cannot submit during the outage it is describing. That is a real loss for
 * the worst class of bug, and the accepted trade for every other class.
 *
 * What remains here is the vocabulary both front-ends and the service must agree on: the labels, the kinds,
 * the two fields and their bounds. Nothing in this file composes a URL any more.
 */
/**
 * ⚠ EXTENSIONLESS, AND `.js` DOES NOT WORK HERE — this shared code ships as RAW TYPESCRIPT with no build
 * step, so a `./phase-progress.js` specifier resolves for `tsc` and vitest and
 * then fails the portal's webpack build with "Can't resolve", which is how it was found. Every other
 * intra-package import here is extensionless for the same reason.
 *
 * Worth stating because those others are all `import type`, which is erased and never has to resolve at all
 * — this is the first RUNTIME import between two modules inside this package, so it is the first one where
 * the specifier matters.
 *
 * ⚠ WHY IT IS SHARED RATHER THAN A SECOND COUNTER: the phase editor's word gate and a report's word bounds
 * must agree on what a word is, because a participant meets both. Two implementations of "how many words is
 * that" is how somebody ends up looking at "20 / 20" beside a disabled button.
 */
import { countWords } from "./phase-progress";

/** What the two entry points are called. One copy, so the portal and the desktop cannot word them apart. */
export const REPORT_BUG_LABEL = "Report a bug";
export const GIVE_FEEDBACK_LABEL = "Give feedback";

/**
 * What a report IS.
 *
 * ⚠ TWO KINDS, ASKED DIFFERENT QUESTIONS, and that is why it is not one "contact us". A single channel
 * collapses "this is broken" and "this would be better if…" into one inbox where the second is always read
 * as the first.
 */
export const FEEDBACK_KINDS = ["BUG", "FEEDBACK"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Which app a report came from — the first thing a triager needs. */
export type SupportSurface = "portal" | "desktop";

/**
 * How a surface is WRITTEN for a person: labels are in initial caps ("Desktop", "Portal").
 *
 * ⚠ DISPLAY ONLY. The stored and transmitted value stays lowercase: `surface` is an API field the desktop
 * sends and the service validates against a closed set, and capitalising the wire value to fix a label would
 * be a breaking change dressed up as copy — an older client would post "desktop" and be normalised to
 * "portal", quietly mislabelling every desktop report.
 */
export const SURFACE_LABELS: Record<SupportSurface, string> = {
  portal: "Portal",
  desktop: "Desktop",
};

/**
 * The label for a surface, tolerating a value outside the closed set.
 *
 * The fallback is not defensive noise: rows written before the field was constrained, or by a future client,
 * would otherwise render as `undefined` in the one place somebody is trying to work out where a bug happened.
 */
export function surfaceLabel(surface: string | null | undefined): string {
  if (!surface) return "Unknown";
  return (
    SURFACE_LABELS[surface as SupportSurface] ??
    surface.charAt(0).toUpperCase() + surface.slice(1).toLowerCase()
  );
}

/**
 * Cap on a report's message.
 *
 * ⚠ SHARED SO THE FORM AND THE ROUTE REFUSE THE SAME INPUT, the same reason `constants/scoring.ts` is
 * shared: a textarea that accepts more than the service stores produces a refusal after the writing, which
 * is the worst possible moment to be told.
 *
 * A bound on STORAGE, not a judgement about detail — a long bug report is a good bug report, so this is
 * generous. But it is finite: without a ceiling one paste turns a DynamoDB item into a 400KB failure at the
 * storage layer instead of a clear refusal at the edge.
 */
export const MAX_FEEDBACK_MESSAGE = 8_000;

/** Cap on a subject line's characters — the same storage argument as above, at a subject's scale. */
export const MAX_FEEDBACK_SUBJECT = 300;

/**
 * ── ⚠ HOW LONG A REPORT MAY BE, AND HOW SHORT ──────────────────────────────────────────────
 *
 * The bounds are ONE rule for both kinds — subject 5–15 words, description 20–200 words — rather than a
 * ceiling that changes with the kind, so the form shows two counters and two numbers and a reporter never
 * has to learn which channel has which limit.
 *
 * ⚠ WORDS, NOT CHARACTERS, AND THE CHARACTER CAPS STILL STAND. They measure different things and both are
 * needed: the word bounds are the RULE a reporter is held to and are what the counters show, while
 * `maxChars` is a STORAGE bound that stops one paste turning a DynamoDB item into a 400KB failure at the
 * storage layer. A 200-word limit alone would happily accept a single 8MB "word".
 *
 * ── ⚠ THE MINIMUMS ARE FRICTION, DELIBERATELY ACCEPTED, AND THEY HAVE A COST WORTH NAMING ──
 *
 * "The submit button returns a 500" is seven words and a perfectly good bug report; under a 20-word floor it
 * is refused. The intent is clearly to stop one-line reports that cost a triager a round trip to understand
 * — a real problem — but the mechanism cannot tell a terse GOOD report from a useless one, so some of the
 * former will be padded to fit. That trade-off is accepted deliberately.
 *
 * What the implementation owes the reporter in exchange, and delivers: the floor is stated BEFORE they
 * write, the counter shows progress towards it rather than only complaining afterwards, and nothing is ever
 * silently truncated.
 */
export interface FeedbackFieldBounds {
  readonly minWords: number;
  readonly maxWords: number;
  readonly maxChars: number;
}

export const FEEDBACK_SUBJECT_BOUNDS: FeedbackFieldBounds = {
  minWords: 5,
  maxWords: 15,
  maxChars: MAX_FEEDBACK_SUBJECT,
};

export const FEEDBACK_MESSAGE_BOUNDS: FeedbackFieldBounds = {
  minWords: 20,
  maxWords: 200,
  maxChars: MAX_FEEDBACK_MESSAGE,
};

/** The two fields a report has. Used to key both the bounds and the error codes. */
export type FeedbackField = "subject" | "message";

export const FEEDBACK_BOUNDS: Record<FeedbackField, FeedbackFieldBounds> = {
  subject: FEEDBACK_SUBJECT_BOUNDS,
  message: FEEDBACK_MESSAGE_BOUNDS,
};

/** What each field is called where a reporter can see it. */
export const FEEDBACK_FIELD_LABELS: Record<FeedbackField, string> = {
  subject: "Subject",
  message: "Description",
};

/**
 * A refusal: the code the service returns, and the sentence a person reads.
 *
 * ⚠ ONE SENTENCE, WRITTEN ONCE. The service's 400 body and the form's inline error are the SAME string
 * because they come from here — otherwise the two drift and a reporter is told "at least 20 words" by the
 * form and something subtly different by the API that actually refused them.
 */
export interface FeedbackFieldProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * Is this field acceptable? `null` when it is.
 *
 * ⚠ THE SINGLE VALIDATOR FOR ALL FOUR CALLERS — the portal form, the portal BFF, the desktop form and the
 * identity route. Not so the client can be trusted (the service's refusal is the real one) but so the client
 * cannot MISLEAD: a form that accepts what the route refuses produces a rejection after the writing, which
 * is the worst possible moment to be told.
 *
 * ⚠ AND THE ORDER OF THE CHECKS IS PART OF THE BEHAVIOUR. Empty first, because "please write something" is a
 * different message from "please write more". Then the character cap, before the word bounds, so a
 * megabyte-long single token is refused as too long rather than reported as one word and too short.
 */
export function checkFeedbackField(
  field: FeedbackField,
  value: string | null | undefined
): FeedbackFieldProblem | null {
  const bounds = FEEDBACK_BOUNDS[field];
  const label = FEEDBACK_FIELD_LABELS[field];
  const upper = field.toUpperCase();
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return {
      code: `${upper}_REQUIRED`,
      message: field === "subject" ? "Please add a subject." : "Please describe the problem.",
    };
  }
  if (trimmed.length > bounds.maxChars) {
    return {
      code: `${upper}_TOO_LONG`,
      message: `${label} must be under ${bounds.maxChars} characters.`,
    };
  }

  const words = countWords(trimmed);
  if (words < bounds.minWords) {
    return {
      code: `${upper}_TOO_SHORT`,
      // The count is included because "at least 20 words" without "you have 7" leaves a reporter guessing
      // at how much more is wanted.
      message: `${label} needs at least ${bounds.minWords} words — you have ${words}.`,
    };
  }
  if (words > bounds.maxWords) {
    return {
      code: `${upper}_TOO_LONG`,
      message: `${label} must be at most ${bounds.maxWords} words — you have ${words}.`,
    };
  }
  return null;
}

/**
 * The first problem with a whole report, or `null` if there is none.
 *
 * ⚠ SUBJECT FIRST, deliberately: it is the field above, and reporting the lower field's problem while the
 * one above it is also wrong makes a form feel like it is refusing at random.
 */
export function checkFeedbackReport(input: {
  subject?: string | null;
  message?: string | null;
}): FeedbackFieldProblem | null {
  return (
    checkFeedbackField("subject", input.subject) ?? checkFeedbackField("message", input.message)
  );
}

/** Live counter text — "7 / 20 words" while short, "24 words" once inside the bounds. */
export function feedbackWordHint(field: FeedbackField, value: string): string {
  const { minWords, maxWords } = FEEDBACK_BOUNDS[field];
  const words = countWords(value);
  if (words < minWords) return `${words} / ${minWords} words`;
  if (words > maxWords) return `${words} words — ${maxWords} maximum`;
  return `${words} words`;
}

/**
 * The prompt each kind shows above the box.
 *
 * ⚠ THE THREE BUG PROMPTS ARE THE THREE THINGS THAT MAKE A REPORT ACTIONABLE, in the order a reporter can
 * answer them. "What did you expect" earns its place: the gap between expected and actual is often the
 * entire bug, and plenty of reports describe behaviour that turns out to be intended.
 *
 * Shared rather than written into each form, so the two apps ask for the same thing and a triager reads a
 * consistent shape.
 */
export const FEEDBACK_PROMPTS: Record<FeedbackKind, string> = {
  BUG: "What happened, what you expected instead, and what you were doing just before it.",
  FEEDBACK: "What is working well, and what would make this more useful for you.",
};

/**
 * What goes in the subject box, per kind.
 *
 * ⚠ THE PLACEHOLDER IS THE SPEC FOR A GOOD SUBJECT, which matters more here than it usually would: a
 * subject line with a FIVE-WORD FLOOR is not the two-word subject people are used to writing, so the field
 * has to say what it wants. "Submit fails" is refused; "The Submit button fails silently" is not.
 */
export const FEEDBACK_SUBJECT_PLACEHOLDERS: Record<FeedbackKind, string> = {
  BUG: "In one line: what went wrong, and where",
  FEEDBACK: "In one line: what you would change",
};

/** The heading each kind shows, so a reporter knows which channel they are in. */
export const FEEDBACK_TITLES: Record<FeedbackKind, string> = {
  BUG: REPORT_BUG_LABEL,
  FEEDBACK: GIVE_FEEDBACK_LABEL,
};
