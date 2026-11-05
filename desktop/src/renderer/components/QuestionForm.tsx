import { useState } from "react";
import type { ParsedQuestion } from "../lib/aidlc-questions";

/**
 * ── ⚠ AN AI-DLC QUESTION FILE, AS CONTROLS INSTEAD OF MARKDOWN ──────────────────────────────────
 *
 * The framework writes these files and the participant answers them by hand-editing the `[Answer]:` lines. That
 * is fiddly and it is easy to typo an option's text, which downstream stages quote verbatim.
 *
 * ⚠ IT IS A THIRD MODE, NOT A REPLACEMENT. Markdown files already toggle between `preview` and `edit`; this
 * adds `answer`, and the raw editor stays one click away. A form that could not be escaped would be a
 * regression for anything it parses imperfectly — and the answers here carry prose the framework itself writes
 * (see the notes warning below), so the text view is where that gets edited.
 *
 * ⚠ AND IT WRITES THROUGH THE SAME BUFFER AS TYPING. Selecting an option produces new markdown and hands it to
 * `onChange`, exactly as a keystroke in the textarea would, so the file is dirty-tracked, saved, watched and
 * stale-checked by the machinery that already exists. Nothing here writes to disk.
 */
export function QuestionForm({
  questions,
  onSelect,
  disabled,
}: {
  questions: ParsedQuestion[];
  /** Chosen letters, plus free text when the free-text option is among them. */
  onSelect: (question: ParsedQuestion, letters: string[], freeText?: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex-1 overflow-auto bg-surface-bg px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-8">
        {questions.map((question) => (
          <QuestionBlock
            key={question.id}
            question={question}
            onSelect={onSelect}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionBlock({
  question,
  onSelect,
  disabled,
}: {
  question: ParsedQuestion;
  onSelect: (question: ParsedQuestion, letters: string[], freeText?: string) => void;
  disabled?: boolean;
}) {
  /**
   * The pending overwrite of an answer that carries notes.
   *
   * ⚠ THE CONFIRM IS THE POINT OF THIS COMPONENT'S CARE. In the real document Q2's answer appends a revision
   * note and Q9's is entirely prose — "Superseded by [Q12] … the guard is therefore a regulated compliance
   * boundary" — and those are the most valuable sentences in the file. A picker that rewrote the line on one
   * click would delete them with no diff and no undo.
   */
  const [pending, setPending] = useState<{ letters: string[]; freeText?: string } | null>(null);
  const [freeText, setFreeText] = useState("");

  const chosen = new Set(question.answeredLetters);

  function choose(letters: string[], text?: string) {
    if (question.answerHasNotes) {
      setPending({ letters, freeText: text });
      return;
    }
    onSelect(question, letters, text);
  }

  function toggle(letter: string, isFreeText: boolean) {
    const next = question.multiSelect
      ? chosen.has(letter)
        ? question.answeredLetters.filter((l) => l !== letter)
        : [...question.answeredLetters, letter]
      : [letter];
    choose(next, isFreeText ? freeText : undefined);
  }

  return (
    <section aria-labelledby={`q-${question.id}`}>
      <h2 id={`q-${question.id}`} className="text-sm font-semibold text-surface-text">
        <span className="mr-2 font-mono text-xs text-surface-faint">{question.id}</span>
        {question.prompt}
      </h2>

      {/* Stated because it changes what a click does, and the document only says it in the heading. */}
      {question.multiSelect && (
        <p className="mt-1 text-[11px] text-surface-faint">Select all that apply.</p>
      )}

      <div className="mt-3 space-y-1.5">
        {question.options.map((option) => {
          const isChosen = chosen.has(option.letter);
          return (
            <div key={option.letter}>
              <button
                type="button"
                disabled={disabled}
                /**
                 * ⚠ `aria-pressed`, AND `role` LEFT ALONE. These are toggles that write a file, not form
                 * inputs inside a `<form>` — a real radio group would imply submit semantics that do not
                 * exist here, and `aria-pressed` says "on/off" without inventing them.
                 */
                aria-pressed={isChosen}
                onClick={() => toggle(option.letter, option.isFreeText)}
                className={
                  "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-xs transition-colors " +
                  (isChosen
                    ? "border-brand-accent bg-surface-raised text-surface-text"
                    : "border-surface-line text-surface-muted hover:bg-surface-raised hover:text-surface-text") +
                  (disabled ? " cursor-not-allowed opacity-60" : "")
                }
              >
                <span
                  aria-hidden="true"
                  className={
                    "mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold " +
                    (isChosen ? "bg-brand-accent text-surface-bg" : "bg-surface-raised text-surface-faint")
                  }
                >
                  {option.letter}
                </span>
                <span className="min-w-0 flex-1 leading-relaxed">{option.text}</span>
              </button>

              {/**
                * ⚠ THE FREE-TEXT OPTION NEEDS A FIELD, not a button. "Other (please specify)" exists FOR the
                * text, so selecting it without any would write an answer that says nothing — the one case
                * where a one-click picker is actively worse than typing.
                */}
              {option.isFreeText && isChosen && (
                <div className="mt-1.5 flex gap-2 pl-8">
                  <input
                    value={freeText}
                    onChange={(e) => setFreeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && freeText.trim()) {
                        e.preventDefault();
                        choose([option.letter], freeText);
                      }
                    }}
                    placeholder="Your answer…"
                    disabled={disabled}
                    className="min-w-0 flex-1 rounded border border-surface-line bg-surface-bg px-2 py-1 text-xs text-surface-text placeholder:text-surface-faint focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    disabled={disabled || !freeText.trim()}
                    onClick={() => choose([option.letter], freeText)}
                    className="flex-shrink-0 rounded border border-surface-line px-2 py-1 text-xs text-surface-text hover:bg-surface-raised disabled:opacity-50"
                  >
                    Set
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The answer as the file records it, so the form never hides what is actually written. */}
      {question.answerText !== null && question.answerText.length > 0 && (
        <p className="mt-2.5 border-l-2 border-surface-line pl-3 text-[11px] leading-relaxed text-surface-muted">
          <span className="font-mono text-surface-faint">[Answer]: </span>
          {question.answerText}
        </p>
      )}

      {/**
        * ── ⚠ CONFIRM BEFORE OVERWRITING AN ANSWER THAT SAYS MORE ─────────────────────────────
        *
        * Not a nicety. Q9's existing answer in the real document is a compliance decision with its own
        * reasoning and revision date; replacing it with "C. …" on an accidental click would lose text nothing
        * in this app could recover — the file's own history is the only copy.
        */}
      {pending && (
        <div
          role="alert"
          className="mt-2.5 rounded-md border border-tool-warning/40 bg-surface-raised p-3"
        >
          <p className="text-[11px] font-medium text-tool-warning">
            This answer has notes written into it.
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-surface-muted">
            Replacing it will delete everything after the option — including any reasoning or revision history.
            Edit the file as text if you want to keep it.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                onSelect(question, pending.letters, pending.freeText);
                setPending(null);
              }}
              className="rounded border border-tool-warning/50 px-2 py-0.5 text-[11px] text-surface-text hover:bg-surface-bg"
            >
              Replace anyway
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded px-2 py-0.5 text-[11px] text-surface-muted hover:text-surface-text"
            >
              Keep the existing answer
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
