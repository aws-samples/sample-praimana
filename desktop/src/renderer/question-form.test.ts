// ── ⚠ THE ANSWER MODE, AND WHAT IT REFUSES TO DO SILENTLY ───────────────────────────────────────
//
// These cases are about the WIRING of the question form: that the form is offered only where it
// applies, that answering goes through the same buffer as typing, and that the confirm before
// destroying an annotated answer cannot be dropped.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");

const APP = strip(read("./App.tsx"));
const FORM = strip(read("./components/QuestionForm.tsx"));

describe("⚠ answering writes through the buffer, never to disk", () => {
  /**
   * ⚠ THIS IS WHAT MAKES IT SAFE. Going through `setContent` means the file is dirty-tracked, saved, watched
   * and stale-checked by machinery that already exists — and the participant still has to save, so a mis-click
   * is undone by closing without saving. A form that wrote directly would bypass all of it.
   */
  it("⚠ routes a selection through setContent, not files:writeFile", () => {
    const handler = APP.slice(APP.indexOf("const answerQuestion"), APP.indexOf("const answerQuestion") + 400);
    expect(handler).toContain("setContent((prev) => setAnswer(prev, question, letters, freeText))");
    expect(handler, "no direct write").not.toContain("api.writeFile");
  });

  it("re-parses the live buffer, so the next click sees the last one", () => {
    expect(APP).toContain("parseQuestions(content)");
    expect(APP, "not the text read off disk").not.toContain("parseQuestions(original)");
  });
});

describe("⚠ the mode is offered, not forced", () => {
  it("only appears for a file that parses as questions", () => {
    expect(APP).toContain("isQuestionFile && (");
    expect(APP).toContain('setMode("answer")');
  });

  /** A file may have been opened to READ, and anything parsed imperfectly needs an escape. */
  it("⚠ still opens markdown in preview, not in the form", () => {
    expect(APP).toContain('setMode(isMarkdown ? "preview" : "edit")');
  });

  /** Editing the questions away must not leave the reader stranded in an empty form. */
  it("⚠ leaves answer mode when the document stops parsing", () => {
    expect(APP).toMatch(/if \(mode === "answer" && !isQuestionFile\) setMode/);
  });

  it("keeps Preview and Edit reachable", () => {
    expect(APP).toContain('setMode("preview")');
    expect(APP).toContain('setMode("edit")');
  });
});

describe("⚠ it confirms before deleting an annotated answer", () => {
  /**
   * ⚠ THE CASE THE WHOLE COMPONENT IS SHAPED AROUND. In the real document Q2's answer appends a revision note
   * and Q9's is entirely prose — "Superseded by [Q12] … the guard is therefore a regulated compliance
   * boundary, not a product feature" — and the file is the only copy. A one-click rewrite would delete that
   * with no diff and no undo.
   */
  it("⚠ routes through a pending state when the answer has notes", () => {
    const choose = FORM.slice(FORM.indexOf("function choose("), FORM.indexOf("function toggle("));
    expect(choose).toContain("if (question.answerHasNotes)");
    expect(choose).toContain("setPending({ letters, freeText: text })");
    expect(choose, "and only then does it write").toContain("onSelect(question, letters, text)");
  });

  it("offers both answers and names the consequence", () => {
    expect(FORM).toContain("Replace anyway");
    expect(FORM).toContain("Keep the existing answer");
    expect(FORM, "the cost is stated, not implied").toMatch(/delete everything after the option/i);
  });

  /** `tool-warning`: nothing has failed, a choice is being asked for — and it sits behind text. */
  it("uses the token that is legal behind text", () => {
    expect(FORM).toContain("text-tool-warning");
    expect(FORM).not.toContain("text-tool-error");
  });

  /** The form must never hide what the file actually says. */
  it("shows the existing answer verbatim", () => {
    expect(FORM).toContain("{question.answerText}");
  });
});

describe("⚠ multi-select and free text are not one-click cases", () => {
  it("adds to the selection rather than replacing it when multi-select", () => {
    /**
     * ⚠ ANCHORED ON THE FUNCTION'S OWN END, not on `return (` — which appears in `QuestionForm` ABOVE this
     * function and so produced an EMPTY slice that passed nothing while looking like it asserted something.
     * The third time this session a character-window anchor has done that; the fix is always a unique anchor.
     */
    const start = FORM.indexOf("function toggle(");
    const toggle = FORM.slice(start, FORM.indexOf("choose(next,", start) + 80);
    expect(toggle).toContain("question.multiSelect");
    expect(toggle, "removes when already chosen").toContain('filter((l) => l !== letter)');
    expect(toggle, "and replaces outright when single-select").toContain("[letter]");
  });

  /**
   * ⚠ "Other (please specify)" EXISTS FOR THE TEXT. Selecting it with none would write an answer that says
   * nothing — the one case where a picker is worse than typing.
   */
  it("⚠ gives the free-text option a field, not just a button", () => {
    expect(FORM).toContain("option.isFreeText && isChosen");
    expect(FORM).toContain('placeholder="Your answer…"');
    expect(FORM, "and it can be committed from the keyboard").toContain('e.key === "Enter"');
  });

  it("states that a question takes several answers, since only the heading says so", () => {
    expect(FORM).toContain("question.multiSelect &&");
    expect(FORM).toContain("Select all that apply.");
  });
});

describe("the options are reachable without a mouse or colour", () => {
  it("marks the chosen option for assistive tech", () => {
    expect(FORM).toContain("aria-pressed={isChosen}");
  });

  it("labels each question block by its heading", () => {
    expect(FORM).toContain("aria-labelledby={`q-${question.id}`}");
  });

  /** The letter is decoration beside the text, so it must not be read out twice. */
  it("hides the duplicated letter badge from the reader", () => {
    /** `lastIndexOf`: the first `{option.letter}` is the React `key`, four hundred lines above the badge. */
    const at = FORM.lastIndexOf("{option.letter}");
    const badge = FORM.slice(at - 600, at);
    expect(badge).toContain('aria-hidden="true"');
  });
});
