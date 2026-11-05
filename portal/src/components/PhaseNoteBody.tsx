"use client";

import ReactMarkdown from "react-markdown";
import { formatMessageInstant } from "@/lib/format-message-instant";
import {
  decodeLinks,
  hasAnyLink,
  isSafeHttpUrl,
  linkFieldsFor,
  type PhaseLinkField,
} from "@praimana/shared";

/**
 * ── ONE PHASE'S NOTES, AND WHO WROTE THEM ────────────────────────────────────────────────
 *
 * Extracted so the team's live phases page and a JUDGE's snapshot view render notes identically:
 * the presentational part is a component fed by props, rather than the snapshot view reusing the
 * page.
 *
 * ── ⚠ WHY THIS SEAM AND NOT THE WHOLE ACCORDION ──
 *
 * The obvious extraction is the entire phase list. It is the wrong one: the team's page shows phase
 * STATUS, current, completed, upcoming, the workshop's descriptions, and the build phase's file
 * panel, none of which exists in a snapshot, because a snapshot is a record of what was written and
 * not of where the experience had got to. Parameterising all of that would produce a component whose
 * props are mostly "off", which is how a shared component becomes harder to read than two.
 *
 * What ACTUALLY duplicates is this: the markdown body, the AI-generated badge, and the
 * "Edited by X · when" provenance line. Those three must look the same to a participant and to a
 * judge, because they are the same claim about the same text, and drifting them would mean a judge
 * seeing work attributed differently from how its authors see it.
 *
 * ⚠ THE PAGE MUST NOT BE REUSED, and this is why: the team's phases page is
 * hard-gated by `teamContentGate` (member-only) and renders `PhaseArtifacts`, which calls
 * `trpc.docs.list`, a route that 403s every judge. A judge reaching for that page gets a refusal,
 * not a view.
 */
export interface PhaseNote {
  /**
   * ⚠ REQUIRED, AND IT IS WHAT SELECTS THE LINK RENDERING. The Demo phase stores two labelled URLs in
   * `content`, and `linkFieldsFor` is keyed by phase NAME, ids are per-workshop ULIDs, so an id check
   * would work in dev and nowhere else. Both call sites already had the name to hand.
   */
  name: string;
  content: string;
  aiGenerated: boolean;
  editedByName: string | null;
  editedAt: string | null;
}

/**
 * ── ⚠ THE DEMO PHASE'S LINKS, RENDERED AS LINKS ────────────────────────────────────────────
 *
 * REPORTED: the portal showed `app: https://test.com video: https://test-watch.com`, one line of
 * prose, nothing clickable.
 *
 * TWO causes, both from sending this through `ReactMarkdown` unexamined. The stored format is one
 * `key: value` PER LINE, and markdown joins single newlines into a paragraph, so the two fields ran
 * together. And a bare URL is not a link in plain markdown; it needs GFM autolinking, which this
 * renderer did not have.
 *
 * Rather than fix the markdown, this renders the SAME THING THE DESKTOP DOES: each field on its own
 * row, its label above it, the URL as an anchor. A participant fills these in on the desktop and a
 * facilitator or judge clicks them here, so the two views showing the same stored value differently was
 * the actual defect.
 *
 * ⚠ `isSafeHttpUrl` IS A SECURITY CONTROL, NOT VALIDATION POLISH. This is participant-supplied content
 * going into an `href`. A stored `javascript:` or `data:` URL would execute on click, and the desktop
 * had exactly that hole once. Anything that is not http/https is shown as TEXT, so the reader still
 * sees what was stored and it cannot run.
 *
 * ⚠ `rel="noreferrer noopener"` WITH `target="_blank"`. Without `noopener` the opened page gets a
 * handle back to this window; without `noreferrer` it learns the workshop URL the reader came from.
 */
function PhaseLinks({ fields, content }: { fields: PhaseLinkField[]; content: string }) {
  // Decoded ONCE for the row, not once per field: `decodeLinks` scans the whole stored string.
  const values = decodeLinks(fields, content);
  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const value = (values[field.key] ?? "").trim();
        // A blank field renders nothing at all, an empty labelled row would read as a broken link.
        if (!value) return null;
        return (
          <div key={field.key}>
            <div className="text-xs text-ink-subtle">{field.label}</div>
            {isSafeHttpUrl(value) ? (
              <a
                href={value}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-sm text-brand-text hover:underline"
              >
                {value}
              </a>
            ) : (
              <div className="break-all text-sm text-ink-muted">
                {value}{" "}
                <span className="text-xs text-warn-text">(not a valid web link)</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PhaseNoteBody({
  note,
  /**
   * What to say when there are no notes.
   *
   * ⚠ IT DIFFERS BY AUDIENCE AND MUST. A participant is told how to add them ("the team can add or
   * generate them in the desktop app"); a judge is told the FACT, because they cannot act on an
   * instruction addressed to somebody else.
   *
   * ⚠ AND IT DESCRIBES THE NOTES, NEVER THE PHASE. The judge copy used to read "The team left this
   * phase empty", which is a claim about the TEAM and was wrong whenever files had been uploaded, the
   * normal case for BUILD, whose deliverable is documents rather than notes
   * (`shared/constants/phase-links.ts`). What is empty is this box. A caller passing new copy here
   * should keep that distinction: this component knows only whether `content` is blank, so any wording
   * that implies more than that is the call site overreaching.
   */
  emptyNote,
}: {
  note: PhaseNote;
  emptyNote: string;
}) {
  const linkFields = linkFieldsFor(note);
  const storedLinks = linkFields ? decodeLinks(linkFields, note.content) : {};
  /**
   * ⚠ `hasAnyLink`, NOT `!!note.content`, FOR A LINK PHASE, and the difference is a real row in the
   * live database. A Demo phase whose content is PROSE from before the link fields existed decodes to
   * no values at all, so keying off "content is non-empty" would render an empty link list where the
   * team can see they wrote something. Falling through to the markdown body shows what is actually
   * there.
   */
  const hasLinks = linkFields ? hasAnyLink(storedLinks) : false;

  if (!note.content) {
    return <p className="text-sm italic text-ink-tertiary">{emptyNote}</p>;
  }

  return (
    <>
      {hasLinks && linkFields ? (
        <PhaseLinks fields={linkFields} content={note.content} />
      ) : (
        <div className="prose prose-sm max-w-none text-ink-muted">
          <ReactMarkdown>{note.content}</ReactMarkdown>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
        {/*
          ⚠ THE AI BADGE IS SHOWN TO JUDGES TOO, and that is a deliberate disclosure rather than an
          oversight. This platform exists to evaluate how people work WITH an assistant,
          so "the team generated this" is relevant information about the work, hiding it from the
          people assessing the work would be the strange choice.
        */}
        {note.aiGenerated && (
          <span className="inline-flex items-center gap-1 rounded-full border border-brand-border bg-brand-subtle px-2 py-0.5 text-brand-text">
            ✨ AI-generated
          </span>
        )}
        {note.editedByName && (
          <span>
            {note.aiGenerated ? "Generated" : "Edited"} by {note.editedByName}
            {/*
              ⚠ `formatMessageInstant`, NOT `new Date(...).toLocaleString()`. The page this was
              extracted from used the latter, which renders a zone-less SQLite timestamp an hour out
              in summer, the exact bug `constants/message-time.ts` exists to prevent, and one of the
              four copies that consolidation was about. Extraction is how it gets fixed in both
              places at once.
            */}
            {note.editedAt && ` · ${formatMessageInstant(note.editedAt)}`}
          </span>
        )}
      </div>
    </>
  );
}
