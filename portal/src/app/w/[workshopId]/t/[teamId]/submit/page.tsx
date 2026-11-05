"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { useRole, useIsReadOnly } from "@/lib/useRole";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { formatMessageInstant } from "@/lib/format-message-instant";
import { releaseReadiness } from "@/lib/release-readiness";
import {
  seedForEmptyFields,
  submissionPhaseSeed,
} from "@/lib/submission-phase-seed";
import {
  SUBMISSION_BOUNDS,
  checkSubmissionField,
  submissionWordHint,
} from "@/lib/submission-bounds";

/**
 * ── THE SUBMIT TAB: the team drafts, the EXECUTIVE releases ──────────────────────────────
 *
 * ── ⚠ THIS PAGE CARRIES THE TEAM'S EDITING, NOT THE DESKTOP APP ──
 *
 * The desktop app has no deliverables panel, which would leave
 * `PATCH /v1/teams/:teamId/submissions/:id` WITH NO CLIENT AT ALL -
 * so no team could set a demo URL, and release precondition P4 (an `https:` demo link) could never
 * be satisfied by anybody. The flow would be complete and unusable.
 *
 * So the fields live here, and the two audiences share one page with different controls:
 *
 *   a MEMBER (participant / facilitator / admin)  edits the draft; reads the checklist as STATUS
 *   an EXECUTIVE member                           cannot edit; gets the Release button
 *   the experience OWNER (admin / facilitator)    gets Reopen once it is released
 *
 * ⚠ EVERY ONE OF THOSE IS A COURTESY. `requireSubmissionRelease` (executive AND member of the
 * team), the team-write scope on `PATCH`, and the owner check on reopen are all enforced in the
 * service against the store. Hiding a control saves a request that would be refused; it is not what
 * makes the rule true.
 *
 * ── WHY A JUDGE IS NOT AN AUDIENCE HERE ──
 *
 * A judge never reads a submission from inside the team workspace, entitlement is per
 * WORKSHOP, so their route is `/experiences/[id]/submissions`, and it serves a PINNED SNAPSHOT.
 * This tab is member-gated in the workspace layout, which is why that gating changed alongside this
 * page: an ungated tab here would lead a judge to a 403.
 */

/** The deliverable links, in the order the form presents them. */
const LINK_FIELDS = [
  {
    key: "demoUrl" as const,
    label: "Demo link",
    /** ⚠ THE ONLY REQUIRED ONE, because it is the only link release actually checks (P4). */
    required: true,
    hint: "Must start with https://, and this is the link judges open.",
  },
  { key: "repoUrl" as const, label: "Repository" },
  { key: "videoUrl" as const, label: "Video" },
  { key: "slidesUrl" as const, label: "Slides" },
];

/**
 * The narrative fields, longer text, so they render as textareas.
 *
 * ⚠ ALL FOUR ARE REQUIRED, ENFORCED AT RELEASE RATHER THAN AT SAVE. Bounds, labels and the blocker
 * sentences live in `lib/submission-bounds.ts`; read its header for why the zod patch schema is the
 * wrong place (partial patches, and the Demo-phase auto-seed writes `demoUrl` alone).
 *
 * ── ⚠ `aiUsageSummary` WAS REMOVED FROM THIS FORM, AND THE CRITERION FOLLOWED IT ─────────────
 *
 * "How you used your AI assistant" came off this form. That left
 * `aiUsage` as one of five scored criteria with nothing for a judge to read, a fifth of every score
 * awarded against a narrative the team could no longer write. It was recorded here as a real cost
 * rather than left for a later reader to discover from the scoring maths.
 *
 * ⚠ RESOLVED by dropping the criterion: `SCORE_CRITERIA` is now four entries and
 * `MAX_SCORE_PER_JUDGE` is 40. So the form and the scoring agree again, neither asks about AI use.
 *
 * ⚠ THE COLUMN AND THE BFF SCHEMA ARE STILL INTACT. `submission.patch` accepts `aiUsageSummary` and
 * the record still carries it, so no stored text was destroyed and restoring the field is one line.
 * The judge's detail page renders it when present, so teams who wrote one are not hidden from view -
 * it is simply not scored.
 */
const NARRATIVE_FIELDS = [
  { key: "title" as const, label: "Title", rows: 1, required: true },
  { key: "summary" as const, label: "Summary", rows: 3, required: true },
  { key: "problemStatement" as const, label: "Problem", rows: 3, required: true },
  { key: "solution" as const, label: "Solution", rows: 3, required: true },
];

type EditableKey =
  | (typeof LINK_FIELDS)[number]["key"]
  | (typeof NARRATIVE_FIELDS)[number]["key"];

const EDITABLE_KEYS: EditableKey[] = [
  ...LINK_FIELDS.map((f) => f.key),
  ...NARRATIVE_FIELDS.map((f) => f.key),
];

export default function SubmitPage() {
  const params = useParams();
  const teamId = params.teamId as string;
  const workshopId = params.workshopId as string;

  const role = useRole();
  /** EXECUTIVE is the platform's only read-only role, named for what it means on THIS page. */
  const isExecutive = useIsReadOnly();
  const isOwnerRole = role === "ADMIN" || role === "FACILITATOR";

  const utils = trpc.useUtils();
  const list = trpc.submission.list.useQuery({ teamId }, { enabled: Boolean(teamId) });
  const ensure = trpc.submission.ensure.useMutation({
    onSuccess: () => utils.submission.list.invalidate({ teamId }),
  });

  /**
   * ⚠ `ensure` IS A MUTATION RUN ON MOUNT, AND THAT IS SAFE HERE SPECIFICALLY.
   *
   * The service's create is IDEMPOTENT per team, one `TransactWriteItems` over a pointer row, 200
   * with the existing record on a second call, and `submission.created` published only once. So a
   * refresh, a second teammate, and two tabs open at once converge on ONE submission instead of
   * racing. Without that property this would need a read-then-create dance that could still lose.
   *
   * ── ⚠ THE EXECUTIVE RUNS IT, AND THAT IS AN INVERSION ───────────────────────────────────
   *
   * This used to read: "AN EXECUTIVE DOES NOT RUN IT. They are a read-only role and the service refuses
   * them, so calling would spend a request to be refused... They read whatever a teammate has created."
   * True at the time, and it produced a real bug: an executive opening this tab was told *"This
   * team hasn't started a submission yet, a team member needs to open this tab first"*, which was
   * IMPOSSIBLE ADVICE. This is a staff route (`isForbiddenPath` sends every non-staff role to
   * `/welcome`), so no participant can open this tab to create anything.
   *
   * THE RULE: only executives may submit. The service now grants create and patch
   * to EXECUTIVE + member (`requireSubmissionDraftWrite`), so the person who can reach the form is the
   * person who may use it, and nobody has to be asked to open a tab they cannot see.
   */
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (ensuredRef.current) return;
    if (list.isLoading || !list.data || list.data.length > 0) return;
    ensuredRef.current = true;
    ensure.mutate({ teamId });
  }, [list.isLoading, list.data, teamId, ensure]);

  const submission = list.data?.[0] ?? null;
  const released = submission?.status === "SUBMITTED";

  /**
   * The artifact count, for precondition P3.
   *
   * ⚠ FROM `docs.list`, WHICH IS MEMBER-ONLY, and this page is member-gated, so that lines up. It
   * is a COURTESY COUNT: release re-reads the same list server-side through the docs service, so a
   * stale number here cannot cause a wrong release, only a checklist that is briefly behind.
   */
  const docs = trpc.docs.list.useQuery({ teamId }, { enabled: Boolean(teamId) });
  const artifactCount = docs.data?.length ?? 0;

  // ─── The form ──────────────────────────────────────────────────────────────

  const [draft, setDraft] = useState<Record<string, string>>({});
  /**
   * Which fields this page filled from the Demo phase, for the provenance note under each one.
   *
   * ⚠ PRESENTATION ONLY, it must never gate a write. The seeded value is an ordinary draft value the
   * moment it lands, saved by the same `patch` as anything the team typed; if this list drifted from
   * `draft` the worst outcome is a missing or stale caption, never a lost or unsaved URL.
   */
  const [seededFields, setSeededFields] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * ⚠ SEEDED FROM THE SERVER, BUT NEVER OVER UNSAVED EDITS.
   *
   * A background refetch while somebody is typing would otherwise overwrite the characters they
   * just entered, the classic controlled-input-versus-polling bug, and an especially bad one here
   * because the field being eaten is the demo link somebody is pasting.
   *
   * Re-seeded only when the row's identity or state changes AND nothing is unsaved.
   */
  const seedKey = submission
    ? `${submission.id}:${submission.status}:${submission.updatedAt}`
    : null;
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!submission || !seedKey) return;
    if (seededFor.current === seedKey) return;
    if (seededFor.current !== null && dirty) return;
    seededFor.current = seedKey;
    setDraft(
      Object.fromEntries(
        EDITABLE_KEYS.map((key) => [key, (submission[key] as string | null) ?? ""])
      )
    );
    // `dirty` is deliberately not a dependency: this must react to the SERVER changing, and
    // consults `dirty` only as a guard at that moment.
    //
    // ⚠ THE `eslint-disable-next-line react-hooks/exhaustive-deps` THAT WAS HERE IS GONE, AND THE
    // REASONING ABOVE IS NOT. `exhaustive-deps` is switched OFF repo-wide in `eslint.config.mjs`
    // ("advisory, noisy on deliberate mount-only effects... a wrong autofix there introduces bugs"),
    // so the directive suppressed nothing and ESLint reported it as unused. Only the inert line was
    // removed, the note explaining the omitted dependency is the part that has to survive, because
    // it is what stops the next reader from "fixing" the deps array.
  }, [seedKey]);

  /**
   * The Demo phase's links, for seeding the two fields that duplicate them.
   *
   * ⚠ MEMBER-ONLY, WHICH LINES UP WITH THIS PAGE. `phase.listForTeam` goes through
   * `requireTeamContentRead` in the workshop service, and this tab is member-gated in the workspace
   * layout, so a caller who can see this form can already read these phases. No new surface.
   *
   * A COURTESY READ: nothing here can cause a wrong release. If it fails, the fields stay empty and
   * the team types the URL as they do today.
   */
  const phases = trpc.phase.listForTeam.useQuery(
    { teamId, workshopId },
    { enabled: Boolean(teamId && workshopId) }
  );

  /**
   * The two seedable values, decoded once from whichever phase declares link fields.
   *
   * ⚠ FOUND VIA `linkFieldsFor`, NOT BY MATCHING THE NAME "demo" HERE. That predicate is keyed on the
   * phase name in `shared/`, and duplicating the lookup is how the portal and the desktop come to
   * disagree about which phase carries links. A workshop whose format renames the phase simply gets
   * no seed, the fields stay empty, which is today's behaviour rather than a regression.
   */
  const phaseSeed = useMemo(
    () => submissionPhaseSeed(phases.data?.phases),
    [phases.data]
  );

  const patch = trpc.submission.patch.useMutation({
    onSuccess: () => {
      setDirty(false);
      setSaveError(null);
      setSaved(true);
      utils.submission.list.invalidate({ teamId });
    },
    onError: (err) => setSaveError(err.message),
  });

  function set(key: EditableKey, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setSaved(false);
  }

  function save() {
    if (!submission) return;
    /**
     * ⚠ AN EMPTY BOX IS SENT AS `null`, NOT AS `""`. Clearing a link must actually clear it: the
     * service treats null as "clear this", while an empty string would be stored as a value that
     * LOOKS blank but is not absent, and the release precondition would then have to special-case
     * it. Trimmed for the same reason a pasted URL usually arrives with a trailing space.
     */
    const fields = Object.fromEntries(
      EDITABLE_KEYS.map((key) => {
        const value = (draft[key] ?? "").trim();
        return [key, value === "" ? null : value];
      })
    );
    patch.mutate({ teamId, submissionId: submission.id, fields });
  }

  // ─── Release, reopen, and the checklist that explains them ──────────────────

  /**
   * ⚠ THE RULES LIVE IN `lib/release-readiness.ts`, WITH TESTS, rather than inline here. It is a
   * second copy of a server rule, the service's ladder is the one that decides, and the header
   * there explains why that duplication is deliberate and how it is kept from drifting.
   *
   * The demo link is read from the SAVED record once released, and from the form while drafting, so
   * the checklist tracks what the person is actually looking at.
   */
  const { blockers, artifactsOk, demoOk } = releaseReadiness({
    artifactCount,
    demoUrl: released ? submission?.demoUrl : draft.demoUrl,
    hasUnsavedEdits: dirty,
    /**
     * Evaluated against the DRAFT while editing, exactly as `demoUrl` above is, so the checklist
     * responds to what is on screen. `hasUnsavedEdits` is the separate blocker that stops anyone
     * releasing on the strength of text that is not saved yet, release reads the store.
     *
     * A RELEASED submission reads from the record instead: the draft is no longer the subject, and a
     * reopened-then-abandoned edit must not make a released write-up look incomplete.
     */
    writeUp: released
      ? {
          title: submission?.title,
          summary: submission?.summary,
          problemStatement: submission?.problemStatement,
          solution: submission?.solution,
        }
      : {
          title: draft.title,
          summary: draft.summary,
          problemStatement: draft.problemStatement,
          solution: draft.solution,
        },
  });

  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const releaseButtonRef = useRef<HTMLButtonElement>(null);
  const reopenButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * ⚠ THE SERVICE'S MESSAGE IS SHOWN AS IT ARRIVES, AND THE CODES ARE NOT COLLAPSED.
   * `NO_ARTIFACTS` and `NO_DEMO_URL` are different instructions to a human;
   * `SNAPSHOT_SOURCE_UNAVAILABLE` means "try again in a moment" and is NOT a complaint about the
   * team's work; `ALREADY_RELEASED` means somebody else got there first. One friendly catch-all
   * here would erase exactly the distinctions the service went to trouble to make.
   */
  const release = trpc.submission.release.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setActionError(null);
      utils.submission.list.invalidate({ teamId });
    },
    onError: (err) => {
      setConfirming(false);
      setActionError(err.message);
    },
  });

  const reopen = trpc.submission.reopen.useMutation({
    onSuccess: () => {
      setReopening(false);
      setActionError(null);
      utils.submission.list.invalidate({ teamId });
    },
    onError: (err) => {
      setReopening(false);
      setActionError(err.message);
    },
  });

  /**
   * ⚠ THE EXECUTIVE EDITS, since "only executives should be able to submit". This was
   * `!isExecutive && !released`, the exact condition that left the form read-only for the only role
   * able to open it, so `demoUrl` could never be set and release precondition P4 was unsatisfiable.
   *
   * `!released` still gates it: a released submission is pinned for judges and the service refuses a
   * patch with `ALREADY_RELEASED` regardless of who asks.
   */
  const canEdit = isExecutive && !released;

  /**
   * ── SEED FROM THE DEMO PHASE, ONCE, AND ONLY INTO AN EMPTY FIELD ─────────────────────────────
   *
   * ⚠ A SEPARATE EFFECT RATHER THAN A BRANCH INSIDE THE SERVER-SEEDING ONE ABOVE, and the ordering
   * is the reason: `phase.listForTeam` is its own query and usually answers AFTER `submission.list`,
   * so at server-seed time there is nothing to seed from. Folding it in would mean adding the phase
   * data to that effect's deps, where `seededFor.current === seedKey` has already been set and the
   * branch would never run.
   *
   * ⚠ IT CAN ONLY EVER FILL A BLANK. `existing.trim()` non-empty means the team (or a previous save)
   * put something there, and a convenience feature must not overwrite somebody's typing, the same
   * rule the server-seeding effect enforces with `dirty`, for the same reason. Once filled, the
   * submission and the phase note are INDEPENDENT: the submission is the pinned snapshot judges read,
   * so a later phase-note edit must not silently change what was scored.
   *
   * ⚠ IT MARKS THE FORM DIRTY, DELIBERATELY, AND THAT IS NOT A SIDE EFFECT, IT IS THE POINT. The
   * value is not saved yet, and release reads what is SAVED. A seeded field that left `dirty` false
   * would show a demo link on screen while release refused for want of one: exactly the confusion
   * this feature is supposed to remove. Dirty makes the checklist say "Save the changes on screen
   * first", which is both true and actionable.
   *
   * ⚠ NOT FOR A READ-ONLY FORM. `canEdit` is false for a released submission, and seeding a draft
   * nobody can save would be a value that appears editable, is not, and cannot be cleared.
   */
  const phaseSeededRef = useRef(false);
  useEffect(() => {
    if (phaseSeededRef.current) return;
    if (!canEdit) return;
    // Wait for the server seed: filling before it lands would be overwritten by it.
    if (!submission || seededFor.current === null) return;
    if (Object.keys(phaseSeed).length === 0) return;

    const fill = seedForEmptyFields(phaseSeed, draft);
    // Nothing to do, and this is a TERMINAL answer for this mount: every seedable field already
    // holds a value, so re-checking on later renders would only risk clobbering an edit.
    phaseSeededRef.current = true;
    if (Object.keys(fill).length === 0) return;

    setDraft((prev) => ({ ...prev, ...fill }));
    setSeededFields(Object.keys(fill));
    setDirty(true);
    setSaved(false);
  }, [canEdit, submission, phaseSeed, draft]);

  /**
   * Is THIS field the demo link, on a team that has uploaded nothing?
   *
   * ⚠ GATED ON A *CONFIRMED* EMPTY LIST, not on a falsy count. While `docs.list` is loading,
   * `artifactCount` is 0, and disabling the field on that would make it flicker shut on every page
   * load, then open. `docs.isSuccess` is what distinguishes "we know they have none" from "we do not
   * know yet"; if the read FAILS the field stays enabled and the service refuses, which is the right
   * direction (a docs outage must not look like the team having done no work).
   */
  const demoLinkBlocked = (key: string) =>
    key === "demoUrl" && docs.isSuccess && artifactCount === 0;
  /**
   * ⚠ IDENTICAL TO `canEdit` NOW, AND KEPT AS A SEPARATE NAME ON PURPOSE. They answer different
   * questions that happen to have the same answer under the current rule, "may you fill this in" and "may you
   * hand it to the judges". Collapsing them to one flag would make a future divergence (an ADMIN
   * break-glass release) a rename instead of a one-line change.
   */
  const canRelease = isExecutive && !released;

  const releasedWhen = useMemo(
    () => (submission?.releasedAt ? formatMessageInstant(submission.releasedAt) : null),
    [submission?.releasedAt]
  );

  if (list.isLoading) {
    return <div className="p-6 text-sm text-ink-subtle">Loading this team's submission…</div>;
  }

  if (list.error) {
    return (
      <div className="w-full mx-auto max-w-3xl p-6">
        <div className="rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-text">
          This team's submission couldn&apos;t be loaded. {list.error.message}
        </div>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="w-full mx-auto max-w-3xl p-6">
        <h2 className="mb-2 text-xl font-bold">Submit Your Demo</h2>
        {/*
          ⚠ NO LONGER "a team member needs to open this tab first". That advice could not be followed:
          this is a staff route, so the participant it pointed at cannot open the tab. The draft is
          created by THIS page's `ensure` on arrival, for the executive who is looking at it, so the
          honest message is that it is being set up, and the only reason to still be here is an error,
          which is rendered beneath.
        */}
        <p className="text-sm text-ink-subtle">Setting up this team&apos;s submission…</p>
        {ensure.error && <p className="mt-3 text-sm text-danger-text">{ensure.error.message}</p>}
      </div>
    );
  }

  return (
    <div className="w-full mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Submit Your Demo</h2>
          <p className="mt-1 text-sm text-ink-subtle">
            An executive on the team fills this in and releases it to the judges.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
            released
              ? "border-success-border bg-success-bg text-success-text"
              : "border-warn-border bg-warn-bg text-warn-text"
          }`}
        >
          {released ? "Released to judges" : "Draft"}
        </span>
      </header>

      {released && (
        <div className="rounded-lg border border-success-border bg-success-bg p-4 text-sm text-success-text">
          <p className="font-medium">Released{releasedWhen ? ` ${releasedWhen}` : ""}.</p>
          {/*
            ⚠ THE SNAPSHOT IS STATED PLAINLY, because it is the thing a team will otherwise get
            wrong: they will keep editing their phase notes and assume judges see the changes.
          */}
          <p className="mt-1">
            Judges can read this team&apos;s phase notes and files <strong>as they were at that
            moment</strong>. Later edits are not shown to them.
          </p>
          {submission.reopenReason && (
            <p className="mt-2 text-success-text">
              Previously reopened. Reason: {submission.reopenReason}
            </p>
          )}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-text"
        >
          {actionError}
        </div>
      )}

      <section className="space-y-4 rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-ink">Deliverables</h3>

        {LINK_FIELDS.map((field) => (
          <label key={field.key} className="block">
            <span className="mb-1 flex items-center gap-1 text-sm font-medium text-ink-muted">
              {field.label}
              {field.required && (
                <>
                  <span aria-hidden className="text-danger-text-strong">
                    *
                  </span>
                  <span className="sr-only">(required)</span>
                </>
              )}
            </span>
            <input
              type="url"
              inputMode="url"
              value={draft[field.key] ?? ""}
              onChange={(e) => set(field.key, e.target.value)}
              disabled={!canEdit || demoLinkBlocked(field.key)}
              placeholder="https://…"
              className="w-full rounded border px-3 py-2 text-sm disabled:bg-surface-1 disabled:text-ink-subtle"
            />
            {/*
              ── ⚠ THE DEMO LINK IS DISABLED UNTIL A FILE EXISTS ────────────────────────────────
              THE RULE: a demo URL can only be added once build files have been uploaded.

              The SERVICE is the authority, it refuses the patch with `ARTIFACTS_REQUIRED` (409) and
              re-reads the docs list itself, so a stale count here cannot let a bad value through. This
              is the courtesy half: being told BEFORE typing a link beats being refused after.

              ⚠ THE REASON REPLACES THE HINT rather than sitting beside it. Showing "Must start with
              https://" next to a field you cannot use yet answers a question nobody asked.
            */}
            {demoLinkBlocked(field.key) ? (
              <span className="mt-1 block text-xs text-warn-text">
                Upload at least one file from the desktop app first: the demo link says there is
                something to look at.
              </span>
            ) : (
              field.hint && <span className="mt-1 block text-xs text-ink-subtle">{field.hint}</span>
            )}
            {/*
              ⚠ WHERE THE VALUE CAME FROM, because otherwise it did not come from anywhere.

              A field this page filled from the Demo phase would otherwise appear pre-populated with
              no explanation AND the form already dirty, which reads as a bug, or worse, as somebody
              else having edited the submission. Shown only while the seeded value is still the one on
              screen and still unsaved: once it is saved, or edited, it is simply the team's value and
              its provenance stops being interesting.
            */}
            {seededFields.includes(field.key) &&
              draft[field.key] === phaseSeed[field.key as "demoUrl" | "videoUrl"] &&
              dirty && (
                <span className="mt-1 block text-xs text-brand-text">
                  Filled in from your Demo phase. Save to keep it.
                </span>
              )}
          </label>
        ))}

        {NARRATIVE_FIELDS.map((field) => {
          const problem = checkSubmissionField(field.key, draft[field.key]);
          return (
            <label key={field.key} className="block">
              <span className="mb-1 flex items-center gap-1 text-sm font-medium text-ink-muted">
                {field.label}
                {field.required && (
                  <>
                    <span aria-hidden className="text-danger-text-strong">
                      *
                    </span>
                    <span className="sr-only">(required)</span>
                  </>
                )}
              </span>
              <textarea
                rows={field.rows}
                value={draft[field.key] ?? ""}
                onChange={(e) => set(field.key, e.target.value)}
                disabled={!canEdit}
                /**
                 * ⚠ `maxLength` IS THE CHARACTER CEILING, ENFORCED BY THE BROWSER, the field refuses
                 * the next keystroke rather than accepting text that release would later reject. It is
                 * NOT the word ceiling: a hard stop mid-sentence at 150 words would be hostile, so that
                 * one is reported by the counter and the checklist instead.
                 */
                maxLength={SUBMISSION_BOUNDS[field.key].maxChars}
                className="w-full rounded border px-3 py-2 text-sm disabled:bg-surface-1 disabled:text-ink-subtle"
              />
              {/*
                ⚠ THE COUNTER COUNTS *UP TO* THE FLOOR, "7 / 20 words", and that is the point of
                showing it at all. A ceiling is discoverable by typing until it stops you; a FLOOR is
                not, so without this the requirement is experienced only as a refusal at release time.
                Same argument, and the same shape, as the feedback form's word hint.

                Shown only while the form is editable: on a released submission it is a live counter for
                a value nobody can change, which reads as an unmet requirement on finished work.
              */}
              {canEdit && (
                <span
                  className={`mt-1 block text-xs ${
                    problem ? "text-warn-text" : "text-ink-subtle"
                  }`}
                >
                  {submissionWordHint(field.key, draft[field.key])}
                </span>
              )}
            </label>
          );
        })}

        {canEdit && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || patch.isPending}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:bg-brand-hover disabled:cursor-default"
            >
              {patch.isPending ? "Saving…" : "Save"}
            </button>
            {/* One live region, so a screen reader hears the outcome without hunting for it. */}
            <span aria-live="polite" className="text-xs">
              {patch.isPending ? null : saveError ? (
                <span className="text-danger-text">{saveError}</span>
              ) : dirty ? (
                <span className="text-warn-text">Unsaved changes</span>
              ) : saved ? (
                <span className="text-success-text">Saved</span>
              ) : null}
            </span>
          </div>
        )}

        {isExecutive && !released && (
          <p className="text-xs text-ink-subtle">
            You&apos;re viewing this as an executive: the team edits these fields, and you release
            them.
          </p>
        )}
        {released && (
          <p className="text-xs text-ink-subtle">
            A released submission can&apos;t be edited. An administrator, or the facilitator running
            this experience, can reopen it.
          </p>
        )}
      </section>

      {!released && (
        <section className="space-y-2 rounded-lg border p-4">
          <h3 className="text-sm font-semibold text-ink">Before release</h3>
          <ul className="space-y-1 text-sm">
            <Check ok={artifactsOk}>
              {artifactsOk
                ? `${artifactCount} file${artifactCount === 1 ? "" : "s"} uploaded`
                : "At least one file: upload from the desktop app, or sync your repository"}
            </Check>
            <Check ok={demoOk}>
              {demoOk ? "Demo link set" : "A demo link starting with https://"}
            </Check>
            <Check ok={!dirty}>{dirty ? "Unsaved changes on screen" : "All changes saved"}</Check>
          </ul>
          {/*
            ⚠ THE COPY SAYS "FILES", NEVER "BUILD-PHASE FILES". Documents carry no
            phase attribution, so a build-phase check is not expressible today, claiming one would
            be a promise the server does not keep.
          */}
          <p className="pt-1 text-xs text-ink-subtle">
            These are checked again on the server when an executive releases, so a stale screen
            can&apos;t release something incomplete.
          </p>
        </section>
      )}

      {canRelease && (
        <section className="rounded-lg border border-brand-border bg-brand-subtle p-4">
          <h3 className="text-sm font-semibold text-brand-text-strong">Release to judges</h3>
          <p className="mt-1 text-sm text-brand-text-strong">
            Only an executive on this team can do this. It hands the team&apos;s work to the judging
            panel.
          </p>
          <button
            type="button"
            ref={releaseButtonRef}
            onClick={() => setConfirming(true)}
            disabled={blockers.length > 0 || release.isPending}
            aria-describedby={blockers.length > 0 ? "release-blockers" : undefined}
            className="mt-3 rounded bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:bg-brand-hover disabled:cursor-default"
          >
            {release.isPending ? "Releasing…" : "Release submission"}
          </button>
          {/*
            ⚠ A DISABLED BUTTON MUST SAY WHY. A control that is merely grey is indistinguishable
            from a broken one, and the person looking at it (the executive) is usually not the
            person who can fix the reason (the team).
          */}
          {blockers.length > 0 && (
            <ul id="release-blockers" className="mt-2 space-y-1 text-xs text-brand-text-strong">
              {blockers.map((blocker) => (
                <li key={blocker}>• {blocker}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {released && isOwnerRole && (
        <section className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold text-ink">Reopen for editing</h3>
          <p className="mt-1 text-sm text-ink-subtle">
            Returns this to a draft so the team can change it. Judges keep seeing the version they
            already have until it is released again, and scores already given are kept.
          </p>
          <button
            type="button"
            ref={reopenButtonRef}
            onClick={() => setReopening(true)}
            disabled={reopen.isPending}
            className="mt-3 rounded border border-field-border px-4 py-2 text-sm font-medium text-ink-muted disabled:cursor-default disabled:text-ink-subtle"
          >
            {reopen.isPending ? "Reopening…" : "Reopen submission"}
          </button>
        </section>
      )}

      {confirming && (
        /*
          ⚠ TONE IS `neutral`, NOT `destructive`, AND THAT IS THIS FILE HONOURING THE DIALOG'S OWN
          RULE. Its header says red is for actions that destroy something unrecoverable, and that
          "giving a restore the same red button as a removal would teach the operator that red means
          nothing". Releasing destroys nothing, it discloses, and it is reversible by the owner. The
          weight belongs in the consequences list, which is where it is.
        */
        <ConfirmActionDialog
          title="Release this team's submission to the judges?"
          target={submission.title || `Team ${teamId}`}
          consequences={[
            "Judges entitled to this experience will be able to read this team's phase notes and files.",
            "They see them as they are at this moment: a snapshot. Later edits are not shown.",
            "The team can no longer edit the submission.",
          ]}
          reversibility="Only an administrator, or the facilitator running this experience, can reopen it."
          confirmLabel="Release"
          pendingLabel="Releasing…"
          tone="neutral"
          pending={release.isPending}
          onConfirm={() => release.mutate({ teamId, submissionId: submission.id })}
          onDismiss={() => setConfirming(false)}
          fallbackFocus={() => releaseButtonRef.current}
        />
      )}

      {reopening && (
        <ConfirmActionDialog
          title="Reopen this submission for editing?"
          target={submission.title || `Team ${teamId}`}
          consequences={[
            "The team will be able to edit it again.",
            "Judges keep seeing the version already released, until it is released again.",
            "Scores already given are kept, but results can't be published until the latest release has been scored.",
          ]}
          reversibility="An executive on the team can release it again."
          confirmLabel="Reopen"
          pendingLabel="Reopening…"
          tone="neutral"
          pending={reopen.isPending}
          /* The service REQUIRES a reason and stores it, see `reopenReason`. */
          reasonHint="Why is this being reopened? This is recorded on the submission."
          onConfirm={(reason) => reopen.mutate({ teamId, submissionId: submission.id, reason })}
          onDismiss={() => setReopening(false)}
          fallbackFocus={() => reopenButtonRef.current}
        />
      )}
    </div>
  );
}

/**
 * A checklist row.
 *
 * ⚠ A GREY CIRCLE, NEVER A RED CROSS. Nothing here is broken or wrong, these are steps not yet
 * taken, and a red cross on "no files yet" reads as a failure the team caused. The `sr-only` suffix
 * carries the same distinction for a screen reader, which cannot see the glyph.
 */
function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className={ok ? "text-success-text" : "text-ink-tertiary"}>
        {ok ? "✓" : "○"}
      </span>
      <span className={ok ? "text-ink-muted" : "text-ink-subtle"}>
        {children}
        <span className="sr-only">{ok ? ": done" : ": still needed"}</span>
      </span>
    </li>
  );
}
