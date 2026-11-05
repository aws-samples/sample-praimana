import { useState, useEffect } from "react";
import { TeamAccessNotice } from "./TeamAccessNotice";
import ReactMarkdown from "react-markdown";
import { TeamDocs } from "./TeamDocs";
import { PanePinSlot } from "./PanePinSlot";
import { PANE_HEADER, PANE_TITLE } from "../lib/pane-header";
import {
  decodeLinks,
  encodeLinks,
  hasAnyLink,
  isSafeHttpUrl,
  linkFieldsFor,
  MIN_FIRST_PHASE_WORDS,
  countWords,
  firstPhaseWordsRemaining,
  isPhaseNotesUnlocked,
} from "@praimana/shared";

const api = (window as any).electronAPI;

interface Phase {
  id: string;
  name: string;
  description: string;
  order: number;
  status: string;
  content: string;
  aiGenerated: boolean;
  editedByName: string | null;
  editedAt: string | null;
}

/**
 * ⚠ THE LINK-FIELD CONFIG NOW LIVES IN `@praimana/shared` (constants/phase-links.ts).
 *
 * It was local to this package until the PORTAL was found rendering the same stored string as
 * unclickable prose. The desktop WRITES these fields and the portal RENDERS them for a facilitator or
 * judge, so the format and the labels have to be one copy.
 *
 * It was one label/placeholder/hint per phase, inline here, with Build asking for the deployed application URL
 * — a question Build cannot answer, since nothing is deployed for most of a workshop. That field is now on
 * Demo, where a team presents a running thing.
 *
 * Demo therefore carries TWO fields (app URL and video link) and a phase stores ONE content string, so the two
 * are encoded into it and read back out. That encoding has real edge cases — legacy bare URLs already in the
 * database, CRLF, prose in a field that used to be free text — and this package's vitest is node-only, so the
 * logic lives where it can be tested.
 */

export function PhasesView() {
  const [phases, setPhases] = useState<Phase[]>([]);
  /**
   * Why this pane is empty, when it is. Main classifies the failure (see team-data.ts); the only
   * ones surfaced are the permanent, actionable ones — a transient blip must not raise a banner.
   */
  const [accessReason, setAccessReason] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * Per-field values while editing a LINK phase, keyed by field key.
   *
   * Separate from `draft` rather than parsed out of it on every keystroke: `draft` is the raw textarea content
   * for prose phases, and a link phase's two inputs are independent values until they are encoded on save.
   */
  const [linkDraft, setLinkDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // phaseId being saved/generated
  const [error, setError] = useState("");

  useEffect(() => {
    loadPhases();
  }, []);

  // All three phase requests run in the MAIN process (phases:*) so the bearer
  // stays there; main returns the same fields this view already rendered.
  async function loadPhases() {
    const res = await api.getPhases();
    // Recorded on EVERY load, so a recovery clears the banner as readily as a failure raises it.
    setAccessReason(res?.reason);

    if (res?.ok) {
      const currentOrder = res.currentPhaseOrder || 0;
      const list: Phase[] = (res.phases || []).map((p: any) => ({
        ...p,
        status:
          p.order < currentOrder ? "COMPLETED" : p.order === currentOrder ? "IN_PROGRESS" : "NOT_STARTED",
      }));
      setPhases(list);
    }
    setLoading(false);
  }

  async function handleSave(phaseId: string) {
    setBusy(phaseId);
    setError("");
    try {
      /**
       * A link phase saves the ENCODED fields; everything else saves the textarea verbatim. The phase is looked
       * up by id rather than passed in, so a save triggered from anywhere cannot disagree with what is on
       * screen about which shape to write.
       */
      const phase = phases.find((p) => p.id === phaseId);
      const fields = phase ? linkFieldsFor(phase) : null;
      const content = fields ? encodeLinks(fields, linkDraft) : draft;
      const res = await api.savePhase({ phaseId, content });
      if (!res?.ok) throw new Error(res?.error || "Save failed");
      setEditing(null);
      await loadPhases();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(phase: Phase) {
    const fields = linkFieldsFor(phase);
    setDraft(phase.content || "");
    // A link phase's stored string is decoded into its fields; `decodeLinks` treats a legacy bare URL as the
    // FIRST field, so an existing value does not disappear from the form the moment this ships.
    setLinkDraft(fields ? decodeLinks(fields, phase.content) : {});
    setEditing(phase.id);
    setExpanded(phase.id);
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-bg text-sm text-surface-muted">
        Loading phases…
      </div>
    );
  }

  /**
   * The gating phase, BY `order` — never `phases[0]`. The array comes from an API whose ordering is not
   * part of any contract, and `constants/phase-progress.ts` refuses to trust array position for exactly
   * that reason; naming it off position here would reintroduce the assumption one layer up.
   */
  const firstPhase = phases.reduce<Phase | null>(
    (lowest, p) => (lowest === null || p.order < lowest.order ? p : lowest),
    null
  );
  const wordsShort = firstPhaseWordsRemaining(phases);

  return (
    /*
      ⚠ THIS PANE HAD NO HEADER BAR AT ALL, which is why it could not line up with anything. Reported as
      "when a tab is pinned other tabs next to it missing borders or title bar height not good", and the
      pinned screenshot shows it exactly: beside the Codex pane's 40px bar, this one opened straight into
      padded content with no rule and no aligned title.

      The heading is now a real `PANE_HEADER`, and the pane's own scrolling content moved into the element
      below it — so this column is a flex COLUMN, with only the content scrolling.
    */
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface-bg">
      <div className={PANE_HEADER}>
        <h2 className={PANE_TITLE}>Experience Phases</h2>
        <PanePinSlot />
      </div>

      <TeamAccessNotice reason={accessReason} />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <p className="mb-4 text-sm text-surface-muted">
        Click a phase to view or edit what your team is working on.
      </p>

      {/* `tool-error-text` (5.98:1 on this panel); the light theme's `red-700` measures 2.5:1 here. */}
      {error && (
        <div className="mb-3 rounded-md border border-surface-line bg-surface-panel px-3 py-2 text-sm text-tool-error-text">
          {error}
        </div>
      )}

      {phases.length === 0 ? (
        <p className="text-sm text-surface-muted">No phases loaded. Check server connection.</p>
      ) : (
        <div className="space-y-3">
          {phases.map((phase, i) => {
            const isOpen = expanded === phase.id;
            const isEditing = editing === phase.id;
            const working = busy === phase.id;
            const linkFields = linkFieldsFor(phase);
            /**
             * The stored links for THIS phase, decoded once. Empty for a prose phase, and cheap either way —
             * but it also feeds `hasAnyLink` below, which is what decides between showing the links and showing
             * the "nothing yet" prompt. Deriving that from `phase.content` being non-empty would have shown an
             * empty link list for a Demo phase whose content is prose from before this change.
             */
            const storedLinks = linkFields ? decodeLinks(linkFields, phase.content) : {};
            // Name-keyed for the same reason as linkConfigFor: phase ids are
            // per-workshop ULIDs, so an id check would work in dev and nowhere else.
            const isBuild = phase.name.trim().toLowerCase() === "build";
            /**
             * ── ⚠ THE LATER PHASES STAY SHUT UNTIL THE FIRST IS WRITTEN UP ────────────────────
             *
             * Users can move on to Build and Demo only once Idea has notes of a minimum length. The
             * threshold is 50 words and lives in `MIN_FIRST_PHASE_WORDS`. See `constants/phase-progress.ts`
             * for what "move" can
             * actually
             * mean here (progression is facilitator-controlled and workshop-wide, so what a team
             * controls per-phase is WRITING ITS NOTES) and for why this is a UI gate rather than a
             * server one.
             *
             * ⚠ IT GATES EDITING, NOT READING. The row still expands and still shows whatever is
             * there — a team can look ahead at what Demo is going to ask them for. Hiding the
             * content would be a different and worse product: it would make the gate feel like a
             * punishment rather than an order of work.
             */
            const notesUnlocked = isPhaseNotesUnlocked(phase, phases);
            return (
              <div
                key={phase.id}
                // Status by BORDER and FILL, with the words in the pill below — so the state survives for
                // anyone who does not distinguish the hues. `tool-ok` / `brand-accent` are the same tokens
                // the chat transcript uses for a completed and an in-flight step.
                className={`rounded-lg border ${
                  phase.status === "IN_PROGRESS"
                    ? "border-brand-accent bg-surface-panel"
                    : phase.status === "COMPLETED"
                      ? "border-tool-ok bg-surface-panel"
                      : "border-surface-line"
                }`}
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : phase.id)}
                  className="w-full flex items-center justify-between p-4 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span
                      // Dark digits on a light fill, which is what makes these legible — the same inversion
                      // the team-chat avatars needed. `surface-bg` on `tool-ok` is 8.24:1, on `accent` 5.68:1.
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                        phase.status === "COMPLETED"
                          ? "bg-tool-ok text-surface-bg"
                          : phase.status === "IN_PROGRESS"
                            ? "bg-brand-accent text-surface-bg"
                            : "bg-surface-raised text-surface-text"
                      }`}
                    >
                      {phase.status === "COMPLETED" ? "✓" : i + 1}
                    </span>
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-surface-text">
                        {phase.name}
                        {/* The STATUS, said in words.
                            It was previously carried only by the colour of the row and
                            of the step circle, which is invisible to anyone who cannot
                            distinguish those colours and easy to miss for everyone
                            else — "is Ideation actually started?" is precisely the
                            question this screen should answer at a glance. */}
                        {/*
                          ── ⚠ NO "Completed" PILL ("pleae remove completed on phases") ─────────────
                          A completed phase's step marker is a ✓ GLYPH where every other phase shows its
                          NUMBER — a difference in SHAPE, not colour — so the word was saying a second
                          time what the marker already says unambiguously. Same argument that removed
                          "Done" from the portal's experience view.

                          ⚠ THE PILL ITSELF SURVIVES FOR THE OTHER TWO STATES, and that is not
                          inconsistency. "In progress" and "Not started" have NO marker to distinguish
                          them — both show a plain number — so for those two the words are the only
                          non-colour signal there is. Removing them would leave the two states differing
                          by hue alone, which is the accessibility problem this pill was added to fix.
                        */}
                        {phase.status !== "COMPLETED" && (
                          <span
                            className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                              phase.status === "IN_PROGRESS"
                                ? "border-brand-accent/40 bg-surface-raised text-brand-accent"
                                : "border-surface-line bg-surface-raised text-surface-text"
                            }`}
                          >
                            {phase.status === "IN_PROGRESS" ? "In progress" : "Not started"}
                          </span>
                        )}
                        {/*
                          ── ⚠ NO CONTENT BADGE AT ALL, AND THAT TOOK THREE PASSES TO GET RIGHT ────
                          The badge read `phase.content`, the phase's NOTES. A team's FILES are in the
                          docs store and load when the row opens, so uploading a document never touched
                          `content` and Build read "empty" above a panel listing its files.

                          Suppressing it on Build, then removing "empty" everywhere, then removing the
                          positive label too — each step was right and each was too small, because the
                          real problem was the badge itself. `content` answers ONE narrow question
                          ("did somebody type in the notes box") and the row was using it to summarise
                          the phase. The status pill above already says where the experience has got to,
                          and the row expands to show everything else. A second, weaker signal beside
                          it was noise whichever way it was worded.
                        */}
                      </h3>
                      {phase.description && (
                        <p className="mt-0.5 text-xs text-surface-muted">{phase.description}</p>
                      )}
                    </div>
                  </div>
                  <span className="text-sm text-surface-muted">{isOpen ? "▾" : "▸"}</span>
                </button>

                {isOpen && (
                  <div className="border-t border-surface-line px-4 py-3">
                    {/*
                      ── ⚠ WHY THIS PHASE IS READ-ONLY, SAID BEFORE THE TEAM REACHES FOR THE BUTTON ────
                      A disabled Edit button with a tooltip is not an explanation: on a laptop nobody
                      hovers a greyed-out button to find out why it is grey. The requirement, the phase it
                      applies to and the distance still to go are all stated in the open row.

                      ⚠ IT NAMES THE COUNT REMAINING, not just the rule. Stating only the target — "write
                      N words in Ideation" — on a phase that is already most of the way there reads as
                      though nothing has been done. No literal figure in this comment on purpose: the
                      threshold has already moved once, and a worked example with a number in it goes
                      stale silently.
                    */}
                    {!notesUnlocked && (
                      <p className="mb-3 rounded-md border border-surface-line bg-surface-raised px-3 py-2 text-xs text-surface-muted">
                        Read-only for now. Write at least {MIN_FIRST_PHASE_WORDS} words in{" "}
                        <span className="text-surface-text">{firstPhase?.name ?? "the first phase"}</span>{" "}
                        to open this phase — {wordsShort} more{" "}
                        {wordsShort === 1 ? "word" : "words"} to go.
                      </p>
                    )}
                    {isEditing ? (
                      <>
                        {linkFields ? (
                          /*
                            ONE `type="url"` INPUT PER FIELD. Demo has two — the live application URL and the
                            demo recording — and a single-line input rather than a textarea because the answer
                            is one URL: `type="url"` gets the right keyboard and lets the browser reject an
                            obviously malformed value before it is saved as a team's deliverable.
                          */
                          <div className="space-y-3">
                            {linkFields.map((field) => (
                              <div key={field.key}>
                                <label
                                  htmlFor={`phase-link-${phase.id}-${field.key}`}
                                  className="mb-1 block text-xs font-medium text-surface-muted"
                                >
                                  {field.label}
                                </label>
                                <input
                                  id={`phase-link-${phase.id}-${field.key}`}
                                  type="url"
                                  value={linkDraft[field.key] ?? ""}
                                  onChange={(e) =>
                                    setLinkDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
                                  }
                                  placeholder={field.placeholder}
                                  // `text-surface-text` on a raised fill, never `muted` — muted is 4.06:1 there.
                                  className="w-full rounded-md border border-surface-line bg-surface-raised px-3 py-2 text-sm text-surface-text outline-none placeholder:text-surface-muted focus:border-brand-accent"
                                />
                                <p className="mt-1 text-xs text-surface-muted">{field.hint}</p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <>
                            <textarea
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              placeholder="Describe the problem, solution/use-case, and target users..."
                              className="min-h-[160px] w-full rounded-md border border-surface-line bg-surface-raised px-3 py-2 font-mono text-sm text-surface-text outline-none placeholder:text-surface-muted focus:border-brand-accent"
                            />
                            {/*
                              ⚠ THE COUNTER IS LIVE AND ON THE FIRST PHASE ONLY, because that is the only
                              phase whose length unlocks anything. Putting it on every textarea would read
                              as a word requirement on all of them.

                              It counts the DRAFT, not the saved content — a team typing towards the target
                              needs to watch the number move, and counting the stored value would sit at its
                              old figure until Save. `countWords` is the same function the lock uses, so the
                              counter cannot show the target as met while the gate still refuses (the whole
                              reason it is a shared helper).
                            */}
                            {firstPhase?.id === phase.id && (
                              <p className="mt-1 text-xs text-surface-muted">
                                {countWords(draft)} / {MIN_FIRST_PHASE_WORDS} words
                                {countWords(draft) >= MIN_FIRST_PHASE_WORDS
                                  ? " — enough to open the later phases"
                                  : " needed before the later phases open"}
                              </p>
                            )}
                          </>
                        )}
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => handleSave(phase.id)}
                            disabled={working}
                            className="rounded-md bg-brand-strong px-4 py-1.5 text-sm text-white transition-colors hover:bg-brand-accent hover:text-surface-bg disabled:opacity-50"
                          >
                            {working ? "Saving..." : "Save"}
                          </button>
                          <button
                            onClick={() => setEditing(null)}
                            className="rounded-md border border-surface-line px-4 py-1.5 text-sm text-surface-text hover:bg-surface-raised"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (linkFields ? hasAnyLink(storedLinks) : !!phase.content) ? (
                      <>
                        {linkFields ? (
                          /*
                            Each stored link, labelled — two unlabelled URLs would leave a reader guessing which
                            was the app and which the recording.

                            `target=_blank` + `rel="noreferrer noopener"` because this opens
                            participant-supplied content: without `noreferrer` the opened page gets a handle
                            back to this window.
                          */
                          <div className="space-y-2">
                            {/*
                              Decoded ONCE for the row, not once per field — `decodeLinks` splits and scans the
                              whole stored string, and calling it inside the map repeated that work for every
                              field on every render.
                            */}
                            {linkFields.map((field) => {
                              const value = (storedLinks[field.key] ?? "").trim();
                              if (!value) return null;
                              return (
                                <div key={field.key}>
                                  <div className="text-[11px] text-surface-muted">{field.label}</div>
                                  {isSafeHttpUrl(value) ? (
                                    <a
                                      href={value}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      className="break-all text-sm text-brand-accent hover:underline"
                                    >
                                      {value}
                                    </a>
                                  ) : (
                                    /*
                                      ⚠ NOT CLICKABLE, AND THIS IS A REAL HOLE THIS CHANGE CLOSES. The previous
                                      code put `phase.content` straight into `href`, so a participant who stored
                                      a `javascript:` URL had it EXECUTE in the renderer's context on click.
                                      Anything that is not http/https is shown as text instead — the reader still
                                      sees what was stored, and it cannot run.
                                    */
                                    <div className="break-all text-sm text-surface-text">
                                      {value}{" "}
                                      <span className="text-[11px] text-tool-warning">
                                        (not a valid web link)
                                      </span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="prose prose-sm max-w-none text-surface-text">
                            <ReactMarkdown>{phase.content}</ReactMarkdown>
                          </div>
                        )}
                        <div className="mt-3 flex items-center justify-between">
                          <div className="flex items-center gap-2 text-xs text-surface-muted">
                            {phase.aiGenerated && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-brand-accent/40 bg-surface-raised px-2 py-0.5 text-brand-accent">
                                ✨ AI-generated
                              </span>
                            )}
                            {phase.editedByName && (
                              <span>
                                {phase.aiGenerated ? "Generated" : "Edited"} by {phase.editedByName}
                                {phase.editedAt && ` · ${new Date(phase.editedAt).toLocaleString()}`}
                              </span>
                            )}
                          </div>
                          <button
                            disabled={!notesUnlocked}
                            title={
                              notesUnlocked
                                ? undefined
                                : `Write at least ${MIN_FIRST_PHASE_WORDS} words in ${firstPhase?.name ?? "the first phase"} first — ${wordsShort} to go`
                            }
                            onClick={() => startEdit(phase)}
                            className="text-xs text-brand-accent hover:underline"
                          >
                            Edit
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-4">
                        <p className="mb-3 text-sm text-surface-muted">
                          {linkFields
                            ? `No ${linkFields.map((f) => f.label.toLowerCase()).join(" or ")} yet.`
                            : "No notes yet for this phase."}
                        </p>
                        <div className="flex items-center justify-center gap-2">
                          {/* NO "Generate from chat" button, on ANY phase.
                              Two separate reasons, and both had to be true to remove
                              it rather than fix it:

                              1. For Build and Demo the deliverable is a URL, and no
                                 amount of chat history produces one.
                              2. For every other phase the button was BROKEN: it POSTs
                                 to /v1/workshops/teams/:teamId/phases/:phaseId/generate,
                                 which does not exist in the workshop service and never
                                 has (git log -S finds no commit adding it). Every click
                                 was a 404 surfaced as "Generate failed".

                              Implementing it is not a small fix: the workshop service
                              has no model client and would need both a Bedrock
                              dependency and a cross-context read of the ai service's
                              threads. That is a design decision, not something
                              to leave a dead button standing in for. */}
                          <button
                            disabled={!notesUnlocked}
                            title={
                              notesUnlocked
                                ? undefined
                                : `Write at least ${MIN_FIRST_PHASE_WORDS} words in ${firstPhase?.name ?? "the first phase"} first — ${wordsShort} to go`
                            }
                            onClick={() => startEdit(phase)}
                            className="rounded-md bg-brand-strong px-4 py-1.5 text-sm text-white transition-colors hover:bg-brand-accent hover:text-surface-bg"
                          >
                            {linkFields ? "Add links" : "Write notes"}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* THE TEAM'S SYNCED DOCUMENTS, on the Build phase only.
                        Build is where the spec-driven artefacts are actually produced,
                        so it is where a participant looks for them. The store itself is
                        team-wide rather than phase-scoped — a doc synced during Ideation
                        shows here too, which is right: the list answers "what has our
                        team produced", not "what did we produce in this phase". */}
                    {isBuild && <TeamDocs />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}
