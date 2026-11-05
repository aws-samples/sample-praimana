"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc/client";
import {
  SCORE_CRITERIA,
  SCORE_MIN,
  SCORE_MAX,
  MAX_SCORE_PER_JUDGE,
  MAX_SCORE_COMMENT_CHARS,
  isSafeHttpUrl,
} from "@praimana/shared";
import { formatMessageInstant } from "@/lib/format-message-instant";
import { PhaseNoteBody } from "@/components/PhaseNoteBody";

/**
 * ── WHAT A JUDGE READS, AND WHERE THEY SCORE IT ───────────────────────────────────────────
 *
 * ── ⚠ EVERYTHING HERE COMES FROM THE PINNED SNAPSHOT, NOT FROM THE TEAM'S LIVE SURFACES ──
 *
 * The phase notes are a COPY taken at release, stored inline on the submission, so reading them
 * needs NO call to another service. The file list is the manifest pinned at that instant. Either way a
 * team that keeps working after releasing cannot change what a judge is reading, and "reopen then
 * edit" cannot retroactively alter what an already-cast score was cast against.
 *
 * ⚠ FILE BODIES ARE NOT SERVED, by decision, see the note on `ArtifactList`.
 *
 * That is also why this page does NOT reuse the team's phases page: that page is member-gated and its
 * `PhaseArtifacts` panel calls `trpc.docs.list`, which 403s every judge. Only the notes BODY is
 * shared, via `PhaseNoteBody`, see the note there for why that is the seam.
 */

/** How each criterion is described to a judge. The keys come from the shared scale. */
const CRITERION_LABELS: Record<(typeof SCORE_CRITERIA)[number], { label: string; hint: string }> = {
  innovation: { label: "Innovation", hint: "Originality of the idea and the approach" },
  execution: { label: "Execution", hint: "How well it is actually built and how complete it is" },
  impact: { label: "Impact", hint: "The value it would deliver if adopted" },
  presentation: { label: "Presentation", hint: "How clearly the work is explained and demonstrated" },
};

export default function JudgeSubmissionPage() {
  const params = useParams();
  const workshopId = params.id as string;
  const submissionId = params.submissionId as string;

  const snapshot = trpc.submission.snapshot.useQuery(
    { submissionId },
    { enabled: Boolean(submissionId) }
  );

  /**
   * ── THE WRITE-UP THE TEAM SUBMITTED, AND ITS ABSENCE WAS THE REPORTED BUG ──────────────────
   *
   * Reported: a judge opening this page saw the team's PHASE NOTES and none of what the executive
   * filled in. The cause was not authorization and not the service, `GET /v1/submissions/:id` has
   * always returned `title`, `summary`, `problemStatement`, `solution` and the four links, behind the
   * SAME `requireSubmissionRead` gate as the snapshot, the portal simply had no procedure calling it.
   * The snapshot is deliberately `phases[]` + `artifacts[]` only.
   *
   * ⚠ ITS FAILURE MUST NOT BLANK THE PAGE, which is why this is a SECOND query rather than a field on
   * the first. A judge whose write-up read fails can still score against the phase notes, the artifact
   * manifest and the demo link; conflating the two would turn a partial degradation into an unopenable
   * submission. The page gates on `snapshot` alone, see the error branch below, and this section
   * renders its own absence.
   */
  const record = trpc.submission.byId.useQuery(
    { submissionId },
    { enabled: Boolean(submissionId) }
  );

  if (snapshot.isLoading) {
    return <div className="p-6 text-sm text-ink-subtle">Loading this team&apos;s submission…</div>;
  }

  if (snapshot.error) {
    return (
      <div className="w-full mx-auto max-w-4xl p-6">
        <BackLink workshopId={workshopId} />
        <div
          role="alert"
          className="mt-4 rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-text"
        >
          This submission couldn&apos;t be opened. {snapshot.error.message}
        </div>
      </div>
    );
  }

  const pinned = snapshot.data!.snapshot;
  const releasedAt = snapshot.data!.releasedAt;
  const teamLabel = pinned.teamName ?? `Team ${snapshot.data!.teamId}`;

  return (
    <div className="w-full mx-auto max-w-4xl space-y-6 p-6">
      <BackLink workshopId={workshopId} />

      <header>
        {/* ⚠ `h2`, NOT `h1`. `ExperienceHeader` in the layout above already owns this route's
              `<h1>` (the experience name), so a second level-one heading here gave the page two
              and broke the document outline. The text itself stays: unlike the settings page, the
              view name plus its one-line description say something the tab bar does not. */}
              <h2 className="text-2xl font-semibold tracking-heading-tight">{teamLabel}</h2>
      </header>

      {/*
        ⚠ THE BANNER IS REQUIRED, and it is the single most important sentence on the
        page. Without it a judge reasonably assumes they are looking at the team's current work, and
        would read any later change as the team having altered something after being judged.
      */}
      <div className="rounded-lg border border-notice-border bg-notice-bg p-4 text-sm text-notice-text">
        You are reading this team&apos;s work <strong>as released
        {releasedAt ? ` ${formatMessageInstant(releasedAt)}` : ""}</strong>. Later edits are not
        shown.
      </div>

      <WriteUp
        submission={record.data ?? null}
        isLoading={record.isLoading}
        error={record.error?.message ?? null}
        onRetry={() => void record.refetch()}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Phase notes</h2>
        {pinned.phases.length === 0 ? (
          <p className="text-sm text-ink-subtle">
            This team had no phase notes when the submission was released.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Sorted by the workshop's own phase order, so a judge reads them in sequence. */}
            {[...pinned.phases]
              .sort((a, b) => a.order - b.order)
              .map((phase) => (
                <div key={phase.phaseId} className="rounded-lg border p-4">
                  <h3 className="mb-2 font-semibold text-ink">{phase.name}</h3>
                  <PhaseNoteBody
                    note={phase}
                    /*
                      ⚠ DIFFERENT COPY FROM THE TEAM'S PAGE, DELIBERATELY. Theirs says "the team can
                      add or generate them", an instruction. A judge cannot act on that, so telling
                      them how to fix it would be noise; they need the FACT.

                      ⚠ AND IT NO LONGER SAYS "THE TEAM LEFT THIS PHASE EMPTY", WHICH WAS A CLAIM ABOUT
                      THE TEAM RATHER THAN ABOUT THE DATA. Only the NOTES are empty. A team that
                      uploaded files and wrote no notes had this page tell a judge they did nothing -
                      and for BUILD that is the normal case, not a deficiency:
                      `shared/constants/phase-links.ts` records that "Build's real artefacts are the
                      DOCUMENTS a team produces", which is why Build has no link fields and why its
                      notes box is routinely left alone. Scoring a team down for it would be scoring
                      them down for doing exactly what the phase asks.

                      ⚠ IT POINTS AT THE FILES WITHOUT CLAIMING THEY BELONG TO THIS PHASE. Documents
                      carry NO phase attribution (the same reason `release-readiness.ts`
                      says "files" and never "build-phase files"), so "the team's files are listed
                      below" is the strongest true statement available. Saying "this phase's files"
                      would be a promise the data cannot keep.
                    */
                    emptyNote={
                      pinned.artifacts.length > 0
                        ? "No notes for this phase. The team's files are listed below."
                        : "No notes for this phase, and no files were submitted."
                    }
                  />
                </div>
              ))}
          </div>
        )}
      </section>

      <ArtifactList artifacts={pinned.artifacts} />

      <ScoringForm
        submissionId={submissionId}
        workshopId={workshopId}
        teamLabel={teamLabel}
      />
    </div>
  );
}

/** The four links a judge may open, in the order the submit form presents them. */
const SUBMISSION_LINKS = [
  { key: "demoUrl" as const, label: "Demo" },
  { key: "repoUrl" as const, label: "Repository" },
  { key: "videoUrl" as const, label: "Video" },
  { key: "slidesUrl" as const, label: "Slides" },
];

/** The narrative fields, in submit-form order so the two screens read the same way. */
const WRITE_UP_FIELDS = [
  { key: "summary" as const, label: "Summary" },
  { key: "problemStatement" as const, label: "Problem" },
  { key: "solution" as const, label: "Solution" },
  /**
   * ⚠ STILL RENDERED, THOUGH NOTHING SCORES IT ANY MORE. `aiUsageSummary` was removed from the team's
   * form, and the `aiUsage` CRITERION was dropped, so this is no longer
   * evidence for a score, it is just something some teams wrote.
   *
   * Kept anyway, and the reason is the same as it was: the column and every stored value survive, and
   * hiding text a team took the trouble to write would be a silent loss. It renders only when
   * present, so every submission created after the removal simply omits the row. When the last of
   * those rows is gone this can go with it.
   */
  { key: "aiUsageSummary" as const, label: "How the team used AI" },
];

/**
 * WHAT THE TEAM WROTE, the reported gap on this page.
 *
 * A judge saw phase notes and none of the executive's write-up, because nothing in the portal called
 * `GET /v1/submissions/:id`. See the note on `submission.byId`.
 *
 * ⚠ IT DEGRADES INSTEAD OF DISAPPEARING. Three distinct states, none of which is a blank space: still
 * loading, failed (with a retry, because the phase notes below are unaffected and the judge can keep
 * working), and genuinely empty. An empty section rendered as nothing at all would read as "the team
 * wrote nothing", a statement about the team, when the truth might be that this read failed.
 */
function WriteUp({
  submission,
  isLoading,
  error,
  onRetry,
}: {
  submission: {
    title: string | null;
    summary: string | null;
    problemStatement: string | null;
    solution: string | null;
    aiUsageSummary: string | null;
    demoUrl: string | null;
    repoUrl: string | null;
    videoUrl: string | null;
    slidesUrl: string | null;
  } | null;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (isLoading) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What the team submitted</h2>
        <p className="text-sm text-ink-subtle">Loading the team&apos;s write-up…</p>
      </section>
    );
  }

  if (error || !submission) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What the team submitted</h2>
        {/*
          ⚠ NAMED AS A FAILURE TO LOAD, NEVER AS AN EMPTY SUBMISSION. The distinction matters more here
          than almost anywhere: this text is what a judge scores, and "the team wrote nothing" is a
          finding about the team rather than about a request.
        */}
        <div
          role="alert"
          className="rounded-lg border border-warn-border bg-warn-bg p-4 text-sm text-warn-text"
        >
          The team&apos;s write-up couldn&apos;t be loaded. This is a failure to read it, not an empty
          submission. The phase notes and files below are unaffected.
          {error ? <span className="block mt-1 text-warn-text">{error}</span> : null}
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 block rounded border border-warn-border bg-surface-3 px-3 py-1 text-xs font-medium text-warn-text hover:bg-warn-bg"
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const links = SUBMISSION_LINKS.filter(({ key }) => (submission[key] ?? "").trim());
  const written = WRITE_UP_FIELDS.filter(({ key }) => (submission[key] ?? "").trim());

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">What the team submitted</h2>

      {submission.title?.trim() && (
        <p className="text-base font-semibold text-ink">{submission.title}</p>
      )}

      {links.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {links.map(({ key, label }) => (
            <li key={key}>
              {/*
                ⚠ `isSafeHttpUrl` IS THE PROTOCOL ALLOWLIST. These URLs are participant-supplied and
                this page is the one a judge reads. A stored `javascript:` or `data:` URL must
                never become an href, it would execute in the judge's session on click. Anything
                that fails the check renders as inert text so the reader still sees what was stored.
                `rel="noreferrer noopener"` remains as a second line of defence for valid http(s)
                links: without `noopener` the opened page gets a handle back to this window.
              */}
              {isSafeHttpUrl(submission[key] as string) ? (
                <a
                  href={submission[key] as string}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-block rounded border px-3 py-1 text-sm text-brand-text hover:bg-brand-subtle"
                >
                  {label} ↗
                </a>
              ) : (
                <span className="inline-block rounded border px-3 py-1 text-sm text-ink-subtle">
                  {label}{" "}
                  <span className="text-xs text-warn-text">(not a valid web link)</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {written.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          This team released their submission without filling in the write-up.
        </p>
      ) : (
        <dl className="space-y-4">
          {written.map(({ key, label }) => (
            <div key={key}>
              {/* Bold, and a darker grey: these labels separate four blocks of prose a judge reads in
                  sequence, so they have to be findable when scrolling rather than merely present. */}
              <dt className="text-sm font-bold text-ink">{label}</dt>
              {/* `whitespace-pre-wrap`: these are plain-text textareas, and a team's paragraph breaks
                  are part of what they wrote. NOT markdown, nothing renders it as such on the way in. */}
              <dd className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                {submission[key]}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function BackLink({ workshopId }: { workshopId: string }) {
  return (
    <Link
      href={`/experiences/${workshopId}/submissions`}
      className="text-sm text-brand-text hover:underline"
    >
      ← All submissions
    </Link>
  );
}

/**
 * The team's files, as the manifest pinned at release.
 *
 * ⚠ NO IN-PORTAL VIEWER, AND THAT IS A DECISION RATHER THAN A GAP. Serving a file's
 * BODY needs a cross-service read of S3 that `docs` owns, and the route built for it could only ever
 * answer 503, it depended on `INTERNAL_SERVICE_TOKEN`, which is set on no function deliberately.
 * Making it work meant a new service-to-service dependency and a new security boundary so a judge
 * could read source in a pane.
 *
 * ⚠ WHAT THIS LIST IS FOR, AND WHY IT IS ENOUGH ON ITS OWN: it proves WHAT the team submitted and
 * WHEN, path, last author, timestamp, pinned version, which is the evidence a judge needs about
 * scope and authorship. Code itself is read at the repository link above.
 */
function ArtifactList({
  artifacts,
}: {
  artifacts: Array<{
    path: string;
    versionId: string | null;
    lastAuthorName: string | null;
    updatedAt: string;
  }>;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Files at release</h2>
      {artifacts.length === 0 ? (
        // Cannot normally happen, release refuses with NO_ARTIFACTS, but a reopened-and-re-released
        // submission is a moving target and an empty list must not render as a broken page.
        <p className="text-sm text-ink-subtle">No files were part of this release.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {artifacts.map((artifact) => (
            <li
              key={`${artifact.path}@${artifact.versionId}`}
              className="flex items-center justify-between gap-3 p-3"
            >
              <p className="min-w-0 truncate font-mono text-sm text-ink-muted">{artifact.path}</p>
              <p className="shrink-0 text-xs text-ink-subtle">
                {artifact.lastAuthorName ? `${artifact.lastAuthorName} · ` : ""}
                {artifact.updatedAt ? formatMessageInstant(artifact.updatedAt) : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-subtle">
        {artifacts.length} file{artifacts.length === 1 ? "" : "s"} as of release. Open the team&apos;s
        repository link above to read the code.
      </p>
    </section>
  );
}

/**
 * ── THE SCORING FORM ───────────────────────────────────────────────────────
 *
 * Five criteria, 1–10, equal weight. ⚠ THE SCALE COMES FROM `@praimana/shared`, which is where
 * the SERVICE reads it from too, so the inputs cannot offer a value the route will refuse. That
 * shared rule is the reason this form and `scoreFieldErrors` can never disagree.
 */
function ScoringForm({
  submissionId,
  workshopId,
  teamLabel,
}: {
  submissionId: string;
  workshopId: string;
  teamLabel: string;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const existing = trpc.submission.scores.useQuery({ submissionId });
  const { data: session } = useSession();

  const [values, setValues] = useState<Record<string, number | "">>({});
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(false);

  const score = trpc.submission.score.useMutation({
    onSuccess: () => {
      setSaved(true);
      utils.submission.scores.invalidate({ submissionId });
      utils.submission.forWorkshop.invalidate();
      /**
       * ⚠ BACK TO THE QUEUE, because a judge who stays on a page whose form has just locked has
       * nothing left to do on it. The destination is the submissions LIST rather than the results page:
       * `GET /workshops/:id/results` is a 404 until the owner PUBLISHES (deliberately, so no
       * partial ranking is ever rendered), so sending a judge there on their first score would land
       * them on "Results have not been published". The list shows their own score per row
       * (`scoredByMe` / `myScoreTotal`) and is where the next submission to judge is.
       */
      router.push(`/experiences/${workshopId}/submissions`);
    },
  });

  /**
   * ── ⚠ A SCORE IS FINAL ONCE SUBMITTED, AND THIS IS ONLY HALF OF THAT ─────────────────────────
   *
   * The judge's own row, identified by `judgeId` against their session subject. When it exists the
   * form is replaced by a read-only summary: no inputs, no submit.
   *
   * ⚠ THIS IS A UI LOCK AND NOT THE BOUNDARY, WHICH MATTERS MORE HERE THAN USUAL. `POST
   * /v1/submissions/:id/scores` UPSERTS (`deps.scores.put`) and its only refusal is `NOT_RELEASED` -
   * there is no "already scored" check and no check against `publishedAt` either. So a second score
   * still succeeds against the API today, and this component only stops it being offered. Making
   * scores genuinely immutable is a change in the evaluation service; until then, treat what follows
   * as a courtesy exactly like every other gate in this repo.
   *
   * ⚠ AN UNREADABLE SCORES LIST FAILS OPEN, DELIBERATELY. If this query errors we cannot tell whether
   * they have scored, and hiding the form would block a judge who has NOT, refusing the platform's
   * whole purpose for them over a failed read. So the form renders, and the note beside it says the
   * previous score could not be checked.
   */
  const myJudgeId = session?.user?.id;
  const myScore =
    myJudgeId && existing.data
      ? existing.data.find((s) => s.judgeId === myJudgeId)
      : undefined;

  const missing = SCORE_CRITERIA.filter((c) => typeof values[c] !== "number");
  const total = SCORE_CRITERIA.reduce(
    (sum, c) => sum + (typeof values[c] === "number" ? (values[c] as number) : 0),
    0
  );

  function submit() {
    if (missing.length > 0) return;
    setSaved(false);
    score.mutate({
      submissionId,
      ...(Object.fromEntries(SCORE_CRITERIA.map((c) => [c, values[c] as number])) as Record<
        (typeof SCORE_CRITERIA)[number],
        number
      >),
      comment: comment.trim() === "" ? null : comment.trim(),
    });
  }

  /**
   * ⚠ HELD UNTIL WE KNOW WHETHER THEY HAVE ALREADY SCORED. Rendering the form first and locking it a
   * moment later would put a live submit button in front of a judge whose score is final, and on a
   * slow read they could press it. An error is NOT held on (see the note on `myScore`): that resolves
   * to "cannot tell", and the form opens rather than blocking a first score.
   */
  if (existing.isLoading) {
    return (
      <section className="rounded-lg border border-brand-border bg-brand-subtle p-4">
        <h2 className="text-lg font-semibold text-brand-text-strong">Score this submission</h2>
        <p className="mt-1 text-sm text-brand-text-strong">Checking whether you have scored this team…</p>
      </section>
    );
  }

  /**
   * ── ALREADY SCORED: READ-ONLY, NO SUBMIT ────────────────────────────────────────────────────
   *
   * A score is final once submitted, so the form is not offered again. The numbers are shown back
   * because a judge who cannot see what they gave has no way to check the page they are on is the one
   * they think it is, and hiding them would make "final" feel like "lost".
   */
  if (myScore) {
    const myTotal = SCORE_CRITERIA.reduce((sum, c) => sum + myScore[c], 0);
    return (
      <section className="space-y-3 rounded-lg border border-brand-border bg-brand-subtle p-4">
        <div>
          <h2 className="text-lg font-semibold text-brand-text-strong">You have scored this submission</h2>
          <p className="mt-1 text-sm text-brand-text-strong">
            Scores are final once submitted, so this one can no longer be changed.
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SCORE_CRITERIA.map((criterion) => (
            <div key={criterion} className="rounded border border-brand-border bg-surface-3 px-3 py-2">
              <dt className="text-xs capitalize text-brand-text">{criterion}</dt>
              <dd className="text-sm font-semibold text-brand-text-strong">
                {myScore[criterion]}/{SCORE_MAX}
              </dd>
            </div>
          ))}
          <div className="rounded border border-brand-border bg-brand-subtle px-3 py-2">
            <dt className="text-xs text-brand-text-strong">Total</dt>
            <dd className="text-sm font-bold text-brand-text-strong">
              {myTotal}/{MAX_SCORE_PER_JUDGE}
            </dd>
          </div>
        </dl>

        {myScore.comment && (
          <div>
            <h3 className="text-xs font-medium text-brand-text-strong">Your comment</h3>
            {/* `whitespace-pre-wrap`: the judge's own paragraph breaks are part of what they wrote. */}
            <p className="mt-1 whitespace-pre-wrap text-sm text-brand-text-strong">{myScore.comment}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-sm">
          <Link
            href={`/experiences/${workshopId}/submissions`}
            className="text-brand-text hover:underline"
          >
            ← Back to submissions
          </Link>
          {/*
            ⚠ THE RANKING IS A 404 UNTIL THE OWNER PUBLISHES, so this is offered as "once
            published" rather than as a live link that may land on a refusal. Judges see the full
            ranking there; this panel is only their own row.
          */}
          <Link
            href={`/experiences/${workshopId}/results`}
            className="text-brand-text hover:underline"
          >
            View results (once published) →
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-brand-border bg-brand-subtle p-4">
      <div>
        <h2 className="text-lg font-semibold text-brand-text-strong">Score this submission</h2>
        <p className="mt-1 text-sm text-brand-text-strong">
          {SCORE_MIN}–{SCORE_MAX} on each of the five criteria, equally weighted. Maximum{" "}
          {MAX_SCORE_PER_JUDGE}.
        </p>
        {/*
          ⚠ THIS NO LONGER SAYS "submitting again replaces your previous score". A score is now FINAL
          once submitted: the branch above replaces this form with a read-only summary, so the overwrite
          the old copy described is no longer offered. Telling a judge they can revise would be an
          instruction they cannot follow.

          The row is still keyed (submission, judge) in the store, which is the anti-ballot-stuffing
          property, a second POST replaces rather than adds. That is what makes a UI lock safe to add
          without changing the data model, and it is ALSO why the lock is not yet a real one: see the
          note on `myScore`.
        */}
        <p className="mt-1 text-xs text-brand-text">
          Once you submit, your score is final and cannot be changed.
        </p>
        {existing.error && (
          <p className="mt-1 text-xs text-warn-text">
            We couldn&apos;t check whether you have already scored this team, so the form is open. If
            you have, submitting will replace what you gave.
          </p>
        )}
      </div>

      <div className="space-y-3">
        {SCORE_CRITERIA.map((criterion) => (
          <div key={criterion}>
            <label className="block">
              <span className="text-sm font-medium text-brand-text-strong">
                {CRITERION_LABELS[criterion].label}
              </span>
              <span className="ml-2 text-xs text-brand-text">
                {CRITERION_LABELS[criterion].hint}
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {/*
                  ⚠ TEN BUTTONS RATHER THAN A NUMBER INPUT. The scale is a set of ten discrete
                  choices, the service refuses `7.5` and `0`, so a free-text number field would let
                  a judge type a value that is then rejected, and a slider would imply a continuum
                  that does not exist.
                */}
                {Array.from({ length: SCORE_MAX - SCORE_MIN + 1 }, (_, i) => SCORE_MIN + i).map(
                  (n) => {
                    const chosen = values[criterion] === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => {
                          setValues((v) => ({ ...v, [criterion]: n }));
                          setSaved(false);
                        }}
                        className={`h-8 w-8 rounded border text-xs font-medium ${
                          chosen
                            ? "border-brand bg-brand text-brand-ink"
                            : "border-brand-border bg-surface-3 text-brand-text-strong"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  }
                )}
              </div>
            </label>
          </div>
        ))}
      </div>

      <label className="block">
        <span className="text-sm font-medium text-brand-text-strong">Comment (optional)</span>
        <textarea
          rows={3}
          value={comment}
          maxLength={MAX_SCORE_COMMENT_CHARS}
          onChange={(e) => {
            setComment(e.target.value);
            setSaved(false);
          }}
          className="mt-1 w-full rounded border px-3 py-2 text-sm"
          placeholder={`Feedback for ${teamLabel}`}
        />
        {/*
          `maxLength` matches the server's cap exactly, the shared constant. It is a courtesy that
          stops a paste being refused after the fact; the service refuses over-long comments rather
          than truncating them, so the two numbers must be the same number.
        */}
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={missing.length > 0 || score.isPending}
          className="rounded bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:bg-brand-hover disabled:cursor-default"
        >
          {score.isPending ? "Saving…" : "Submit score"}
        </button>
        <span aria-live="polite" className="text-xs">
          {score.error ? (
            <span className="text-danger-text">{score.error.message}</span>
          ) : saved ? (
            /**
             * ⚠ WAS `Score saved{existing.data ? "" : ""}`, A TERNARY RETURNING THE EMPTY STRING IN
             * BOTH BRANCHES. Dead code, and it was dead in a way that mattered: somebody clearly meant
             * to distinguish "saved" from "updated", so a judge who re-scored got the identical message
             * and no signal that they had overwritten anything. The distinction is moot now that a score
             * is final, so the branch is deleted rather than completed.
             *
             * Still rendered even though `onSuccess` redirects: the navigation is not instant, and this
             * sits in an `aria-live="polite"` region, so it is the confirmation a screen reader
             * announces before the route changes.
             */
            <span className="text-success-text">
              Score submitted: {total}/{MAX_SCORE_PER_JUDGE}. Returning to submissions…
            </span>
          ) : missing.length > 0 ? (
            <span className="text-brand-text-strong">
              {missing.length} criteri{missing.length === 1 ? "on" : "a"} still to score
            </span>
          ) : (
            <span className="text-brand-text-strong">
              Total {total}/{MAX_SCORE_PER_JUDGE}
            </span>
          )}
        </span>
      </div>
    </section>
  );
}
