// ── ⚠ AI-DLC QUESTION DOCUMENTS, AS PICKABLE OPTIONS ────────────────────────────────────────────
//
// The framework writes question files the participant answers by hand-editing markdown. Read from a real one
// (`.../ideation/intent-capture/intent-capture-questions.md`) rather than assumed, because the shape is not the
// GitHub task-list syntax anyone would guess:
//
//     ## Q1. What business problem is this solving?
//
//     - A. AI inference becomes unusable the moment a device loses connectivity
//     - B. Cloud inference cost and latency are unacceptable at the volume required
//     - E. Not yet defined
//     - X. Other (please specify)
//
//     [Answer]: A. AI inference becomes unusable the moment a device loses connectivity
//
// So: letter-labelled BULLETS, and the answer on a separate `[Answer]:` line — not `- [x]` checkboxes. A picker
// built for checkboxes would have matched nothing in the files it was for.
//
// ── ⚠ THE HAZARD THIS MODULE EXISTS TO HANDLE ──
//
// An `[Answer]:` line is not always just an option. From the same file, Q2:
//
//     [Answer]: B. External commercial customers in regulated industries (finance, healthcare, industrial)
//     — narrowed per [Q11] to healthcare only: healthcare providers and health-tech operators. Finance and
//     industrial are not the customer. (Revised 2026-08-19 at the summary checkpoint; the superseded answer
//     named all three sectors.)
//
// That trailing reasoning is the most valuable text in the document and a one-click picker would silently
// delete it. So `parseQuestions` reports whether an answer carries prose beyond the option it names, and the UI
// is expected to confirm before overwriting one that does. Everything outside the answer line is preserved
// byte-for-byte.

/** One lettered choice within a question. */
export interface QuestionOption {
  /** The letter, uppercased: `A`, `B`, `X`. */
  letter: string;
  /** The text after the letter, e.g. "Not yet defined". */
  text: string;
  /**
   * `X. Other (please specify)` — picking it cannot be a one-click answer, because the point of it is the
   * free text that follows. The UI offers a field rather than a button.
   */
  isFreeText: boolean;
}

export interface ParsedQuestion {
  /** `Q3` — the identifier the document and its downstream artifacts cite. */
  id: string;
  /** The heading text without the `## Q3.` prefix. */
  prompt: string;
  options: QuestionOption[];
  /**
   * `(select all that apply)` in the prompt.
   *
   * ⚠ READ FROM THE PROMPT, because that is the only place the document states it. Guessing single-select for
   * everything would quietly discard two of a three-part answer.
   */
  multiSelect: boolean;
  /** The raw text after `[Answer]:`, or null when the line is absent. */
  answerText: string | null;
  /** Letters the answer names, in document order. Empty when unanswered or free-text-only. */
  answeredLetters: string[];
  /**
   * The answer says more than the options it names.
   *
   * ⚠ THE FLAG THE UI MUST NOT IGNORE. See the module note: this is where a picker would destroy somebody's
   * reasoning, and a confirm is the difference between a convenience and a data-loss bug.
   */
  answerHasNotes: boolean;
  /** 0-based line index of the `[Answer]:` line, or of where one should be inserted. */
  answerLine: number;
  /** True when the `[Answer]:` line exists; false means `answerLine` is an insertion point. */
  answerLineExists: boolean;
}

const HEADING = /^##\s+(Q\d+)\.\s*(.*)$/;
/**
 * ⚠ ANY heading CLOSES THE CURRENT QUESTION, not only the next `## Q<n>.` one.
 *
 * Found by testing against the real document rather than by reading it. The file ends its questions with
 * `## Consolidated Summary Confirmation`, which has its OWN `- Looks correct` bullets and its own `[Answer]:`
 * line — so a parser that only closed on the next question heading kept absorbing them into Q9, and Q9's
 * compliance-relevant revision note was reported as the word "Narrower" from a section four headings below.
 *
 * That section is deliberately NOT a pickable question either: its options are unlettered, so the option regex
 * ignores them and `close()` discards a question with none.
 */
const ANY_HEADING = /^#{1,6}\s+/;
/**
 * `- A. text`, `- A) text`, `* (A) text`.
 *
 * ⚠ A SINGLE LETTER ONLY. `- Approve — does the thing` is a different convention this app already parses
 * elsewhere (lib/option-buttons.ts), and treating its first word as a letter would turn every dash-list in
 * every markdown file into a question.
 */
const OPTION = /^\s*[-*]\s+\(?([A-Z])\)?[.)]\s+(.+)$/;
const ANSWER = /^\s*\[Answer\]:\s*(.*)$/;
const MULTI = /\(select all that apply\)/i;

/** `X` is the document's own convention for "Other (please specify)". */
function looksFreeText(letter: string, text: string): boolean {
  return letter === "X" || /^other\b/i.test(text);
}

/**
 * Letters an answer names.
 *
 * ⚠ ANCHORED AT THE START, AND ONLY THERE. An answer's prose can mention "[Q11]" or "option C" in passing —
 * Q2's does — and scanning the whole line for letters would read those as selections. Multi-select answers are
 * written as a leading run (`A. …, B. …` or `A, B`), so the run is what is read.
 */
function readAnsweredLetters(answer: string, multiSelect: boolean): string[] {
  const letters: string[] = [];
  let rest = answer.trimStart();

  for (;;) {
    const match = /^\(?([A-Z])\)?[.)]?(?:\s|,|$)/.exec(rest);
    if (!match) break;
    letters.push(match[1]);
    if (!multiSelect) break;
    rest = rest.slice(match[0].length).trimStart();
    // A multi-select run is comma- or "and"-joined; anything else is the start of the answer's prose.
    const joiner = /^(?:and\s+)/i.exec(rest);
    if (joiner) rest = rest.slice(joiner[0].length);
    else if (!/^\(?[A-Z]\)?[.)]/.test(rest)) break;
  }
  return letters;
}

/**
 * Whether the answer carries more than the text of the options it names.
 *
 * ⚠ COMPARED ON A NORMALISED PREFIX rather than exactly. The framework writes `A. <full option text>`, and a
 * participant editing by hand may differ in whitespace or trailing punctuation — reporting "has notes" for a
 * stray double space would make the confirm dialog appear on answers that carry nothing, which is how a
 * warning becomes noise and then gets clicked through.
 */
function hasNotesBeyondOptions(
  answer: string,
  letters: string[],
  options: QuestionOption[]
): boolean {
  if (letters.length === 0) return answer.trim().length > 0;
  const squash = (s: string) => s.replace(/\s+/g, " ").replace(/[.;,]+$/, "").trim().toLowerCase();

  let expected = letters
    .map((l) => {
      const opt = options.find((o) => o.letter === l);
      return opt ? `${l}. ${opt.text}` : l;
    })
    .join(", ");
  expected = squash(expected);
  const actual = squash(answer);

  if (actual === expected) return false;
  // The framework's own single-select form is exactly "A. <text>"; anything appended is a note.
  return actual.length > expected.length + 2;
}

/** Every question in a document. Empty for a file that is not one. */
export function parseQuestions(markdown: string): ParsedQuestion[] {
  const lines = markdown.split("\n");
  const questions: ParsedQuestion[] = [];

  let current: ParsedQuestion | null = null;
  /** Where the answer would go if the question has none: after the last option, before the next heading. */
  let lastContentLine = 0;

  const close = () => {
    if (!current) return;
    if (current.options.length > 0) {
      if (!current.answerLineExists) current.answerLine = lastContentLine + 1;
      questions.push(current);
    }
    current = null;
  };

  lines.forEach((line, index) => {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = {
        id: heading[1],
        prompt: heading[2].trim(),
        options: [],
        multiSelect: MULTI.test(heading[2]),
        answerText: null,
        answeredLetters: [],
        answerHasNotes: false,
        answerLine: index,
        answerLineExists: false,
      };
      lastContentLine = index;
      return;
    }
    if (ANY_HEADING.test(line)) {
      // A different section begins: whatever follows belongs to it, not to the question above.
      close();
      return;
    }
    if (!current) return;

    const option = OPTION.exec(line);
    if (option) {
      const letter = option[1];
      const text = option[2].trim();
      current.options.push({ letter, text, isFreeText: looksFreeText(letter, text) });
      lastContentLine = index;
      return;
    }

    const answer = ANSWER.exec(line);
    if (answer) {
      current.answerText = answer[1].trim();
      current.answerLine = index;
      current.answerLineExists = true;
      current.answeredLetters = readAnsweredLetters(current.answerText, current.multiSelect);
      current.answerHasNotes = hasNotesBeyondOptions(
        current.answerText,
        current.answeredLetters,
        current.options
      );
      lastContentLine = index;
      return;
    }

    if (line.trim().length > 0) lastContentLine = index;
  });
  close();

  return questions;
}

/**
 * The document with one question's answer replaced.
 *
 * ⚠ IT REWRITES ONE LINE AND COPIES THE REST, which is the whole contract. These files carry the reasoning the
 * downstream stages are grounded on — a rewrite that normalised headings or re-wrapped prose would produce a
 * diff nobody can review, in a document whose value is that it is reviewable.
 *
 * ⚠ AND IT WRITES THE FRAMEWORK'S OWN FORM, `A. <full option text>`, not just the letter. Downstream artifacts
 * quote these answers, and a bare "A" is unreadable the moment it is quoted anywhere else.
 */
export function setAnswer(
  markdown: string,
  question: ParsedQuestion,
  letters: string[],
  freeText?: string
): string {
  const lines = markdown.split("\n");

  const parts = letters.map((letter) => {
    const opt = question.options.find((o) => o.letter === letter);
    if (!opt) return letter;
    if (opt.isFreeText && freeText?.trim()) return `${letter}. ${freeText.trim()}`;
    return `${letter}. ${opt.text}`;
  });
  /** Free text with no letter selected is still an answer — the participant typed something else entirely. */
  const body = parts.length > 0 ? parts.join(", ") : (freeText ?? "").trim();
  const rendered = `[Answer]: ${body}`;

  if (question.answerLineExists) {
    lines[question.answerLine] = rendered;
  } else {
    /** Blank line before it, matching the spacing the framework writes between a block and its answer. */
    lines.splice(question.answerLine, 0, "", rendered);
  }
  return lines.join("\n");
}

/**
 * True when a document looks like an AI-DLC question file.
 *
 * ⚠ IT REQUIRES OPTIONS, NOT JUST A HEADING. A design document with a `## Q1.` section and prose under it is
 * not a form, and rendering pickers over it would replace readable text with an empty control.
 */
export function isQuestionDocument(markdown: string): boolean {
  return parseQuestions(markdown).length > 0;
}
