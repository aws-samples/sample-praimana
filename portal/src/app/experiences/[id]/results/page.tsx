"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { useRole } from "@/lib/useRole";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { formatMessageInstant } from "@/lib/format-message-instant";
import type { Place, ResultsPreview, WorkshopResults } from "@/lib/trpc/routers/submission";

/**
 * ── PLACES: THE OWNER COMPUTES, THE OWNER PUBLISHES ──────────────────────────────────────
 *
 * ── ⚠ TWO SCREENS IN ONE ROUTE, AND THE DIFFERENCE IS WHO MAY SEE WHAT ──
 *
 * Anyone entitled to the experience reads the PUBLISHED places. Only the OWNER sees the unpublished
 * preview, the coverage table and the Publish control. Both live here because they answer the same
 * question, "who won?", at two different times, and splitting them would put the owner's follow-up
 * click on a different URL from the thing they just published.
 *
 * ── ⚠ NEVER RENDER A PARTIAL RANKING ──
 *
 * This is a deliberate discipline, and the reason the preview is a separate service route rather than a flag
 * on the published read: with five judges and two having scored, an order is a confident, WRONG,
 * public statement about named teams. So `results` is a 404 until publication for everyone including
 * the owner, and everything unpublished on this page is explicitly labelled as such.
 *
 * ⚠ THIS RANKS TEAMS, NOT PEOPLE. Per-member assessments are executive-only, unranked, and are not an
 * input to placement, nothing on this page reads them. "A team's place must never become a person's
 * score."
 */
/**
 * submissionId → the reader's OWN score for it. Empty for anyone who does not score, so the table has
 * one shape and the "You" column simply does not render.
 */
type MyScores = Map<string, { total: number; max: number }>;

export default function WorkshopResultsPage() {
  const params = useParams();
  const workshopId = params.id as string;
  const role = useRole();
  const isOwnerRole = role === "ADMIN" || role === "FACILITATOR";

  const published = trpc.submission.results.useQuery(
    { workshopId },
    { enabled: Boolean(workshopId) }
  );

  /**
   * ⚠ THE PREVIEW IS ONLY FETCHED FOR A ROLE THAT COULD OWN THE EXPERIENCE, and only while nothing is
   * published. A judge or participant asking would be refused, and spending a request to be refused
   * lights up an error for somebody who is not entitled to the data in the first place. Ownership
   * itself is decided by the SERVICE, this is the offer, not the rule.
   */
  const preview = trpc.submission.resultsPreview.useQuery(
    { workshopId },
    { enabled: Boolean(workshopId) && isOwnerRole && published.data === null }
  );

  /**
   * ── A JUDGE'S OWN SCORE, BESIDE EACH PLACE ─────────────────────────────────────────────────
   *
   * A judge could see the ranking but not what THEY gave, so there was no way to relate their own
   * assessment to the outcome without reopening every submission one at a time.
   *
   * ⚠ SOURCED FROM `forWorkshop`, WHICH ALREADY CARRIES IT. That row shape includes `scoredByMe`,
   * `myScoreTotal` and `maxScore`, the caller's OWN figures, reduced server-side precisely because "a
   * judge must not see another judge's numbers from a list". So this needs no new endpoint, no service
   * change, and cannot widen what a judge can read: one query, already scoped to them.
   *
   * ⚠ JUDGES ONLY. An owner already sees the aggregate they published and the per-judge detail through
   * a submission; spending this request for them would fetch a `myScoreTotal` that is meaningless for
   * somebody who does not score.
   */
  const isJudge = role === "JUDGE";
  const mine = trpc.submission.forWorkshop.useQuery(
    { workshopId },
    { enabled: Boolean(workshopId) && isJudge }
  );
  /** submissionId → the caller's own total, for the rows they scored. */
  const myScores: MyScores = new Map(
    (mine.data?.submissions ?? [])
      .filter((row) => row.scoredByMe && row.myScoreTotal !== null)
      .map((row) => [
        row.submissionId,
        { total: row.myScoreTotal as number, max: row.maxScore },
      ])
  );

  if (published.isLoading) {
    return <div className="p-6 text-sm text-ink-subtle">Loading results…</div>;
  }

  return (
    <div className="w-full mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          {/* ⚠ `h2`, NOT `h1`. `ExperienceHeader` in the layout above already owns this route's
              `<h1>` (the experience name), so a second level-one heading here gave the page two
              and broke the document outline. The text itself stays: unlike the settings page, the
              view name plus its one-line description say something the tab bar does not. */}
              <h2 className="text-2xl font-semibold tracking-heading-tight">Results</h2>
          <p className="mt-1 text-sm text-ink-subtle">
            Places are computed from the judges&apos; scores and published by whoever runs this
            experience.
          </p>
        </div>
        {/*
          ⚠ NO "Submissions →" LINK. It existed because these pages had no navigation of their own, they
          rendered with no experience header, so a cross-link to the sibling tab was the only way out. The
          header and its tab bar are now in `experiences/[id]/layout.tsx`, where Submissions is a real tab
          with an active state, so a second route to the same place inside the page is redundant and
          competes with it.
          */}
      </header>

      {published.data ? (
        <PublishedResults results={published.data} myScores={myScores} />
      ) : isOwnerRole ? (
        <OwnerPreview workshopId={workshopId} preview={preview.data} error={preview.error?.message} loading={preview.isLoading} />
      ) : (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-ink-subtle">Results haven&apos;t been published yet.</p>
          <p className="mt-1 text-xs text-ink-subtle">
            They appear here once the facilitator running this experience publishes them.
          </p>
        </div>
      )}
    </div>
  );
}

/** The published ranking, what everyone entitled to the experience sees. */
function PublishedResults({
  results,
  myScores,
}: {
  results: WorkshopResults;
  myScores: MyScores;
}) {
  return (
    <>
      <div className="rounded-lg border border-success-border bg-success-bg p-4 text-sm text-success-text">
        Published {formatMessageInstant(results.publishedAt)}.
        {results.tieBrokenById && " A tie was resolved by the experience owner."}
      </div>
      <PlacesTable places={results.places} myScores={myScores} />
      {/*
        ⚠ THE QUORUM ACTUALLY APPLIED IS SHOWN, because it is recorded on the row rather than
        re-derived. If the platform's default changes later, this result stays explainable.
      */}
      <p className="text-xs text-ink-subtle">
        Each team was scored by at least {results.minScoresPerSubmission} judge
        {results.minScoresPerSubmission === 1 ? "" : "s"}.
      </p>
    </>
  );
}

function PlacesTable({
  places,
  myScores,
}: {
  places: Place[];
  myScores: MyScores;
}) {
  return (
    <ol className="space-y-2">
      {places.map((place) => (
        <li
          key={place.submissionId}
          className="flex items-center gap-4 rounded-lg border p-3"
        >
          <span className="w-10 shrink-0 text-center text-lg font-bold text-ink">
            {place.place}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-ink-muted">
            {place.teamName ?? `Team ${place.teamId}`}
          </span>
          <span className="shrink-0 text-sm text-ink-subtle">
            {/*
              ⚠ THE NUMBER SHOWN IS THE NUMBER THAT RANKED. The service rounds once to 2dp and ranks
              on the rounded value, precisely so two identical displayed averages cannot sit at
              different places, which is the thing that cannot be explained to the team that came
              second.
            */}
            {place.average.toFixed(2)}
            <span className="ml-2 text-xs text-ink-tertiary">
              {place.judgeCount} judge{place.judgeCount === 1 ? "" : "s"}
            </span>
          </span>
          {/*
            ⚠ RENDERED ONLY WHEN THE READER HAS A SCORE FOR THIS ROW, and absent is not zero: a judge
            who did not score this team gets nothing here rather than "0", which would read as a
            damning assessment they never made.

            ⚠ AND IT IS LABELLED "You". Beside a column headed by the AGGREGATE average, an unlabelled
            second number invites the reader to mistake one for the other, and these two will usually
            differ, which is the whole reason it is worth showing.
          */}
          {myScores.has(place.submissionId) && (
            <span className="shrink-0 rounded bg-brand-subtle px-2 py-1 text-xs font-medium text-brand-text-strong">
              You: {myScores.get(place.submissionId)!.total}/
              {myScores.get(place.submissionId)!.max}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The owner's view before publication: the ranking that WOULD be published, or the reason it cannot
 * be, and the control, offered only when there is nothing blocking it.
 */
function OwnerPreview({
  workshopId,
  preview,
  error,
  loading,
}: {
  workshopId: string;
  preview: ResultsPreview | undefined;
  error?: string;
  loading: boolean;
}) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [tieOrder, setTieOrder] = useState<string[]>([]);
  const [publishError, setPublishError] = useState<string | null>(null);

  const publish = trpc.submission.publishResults.useMutation({
    onSuccess: (data) => {
      setConfirming(false);
      setPublishError(
        /*
          ⚠ A PUBLISHED-BUT-NOT-COMPLETED RESULT IS REPORTED, NOT HIDDEN. The service writes the
          ranking first and then moves the experience to COMPLETED; if that second step failed, the
          places ARE published and the experience state is stale. Saying nothing would leave the owner
          believing the experience closed when it did not.
        */
        data.experienceCompleted
          ? null
          : "Results are published, but this experience could not be moved to Completed. Please set its status manually."
      );
      utils.submission.results.invalidate({ workshopId });
      utils.submission.resultsPreview.invalidate({ workshopId });
    },
    onError: (err) => {
      setConfirming(false);
      setPublishError(err.message);
    },
  });

  if (loading) return <div className="text-sm text-ink-subtle">Working out the ranking…</div>;

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-text">
        The ranking couldn&apos;t be computed. {error}
      </div>
    );
  }

  if (!preview) return null;

  return (
    <div className="space-y-4">
      <div className="rounded border border-warn-border bg-warn-bg p-3 text-xs text-warn-text">
        <strong>Not published.</strong> Only you can see this. Teams and judges see nothing until you
        publish.
      </div>

      {publishError && (
        <div role="alert" className="rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-text">
          {publishError}
        </div>
      )}

      {/*
        ⚠ EACH REFUSAL IS ITS OWN SCREEN, because they send the owner to three different actions:
        chase the judges, rebalance the panel, or make a decision themselves. A single "cannot publish
        yet" would tell them none of that.
      */}
      {preview.outcome === "nothing-released" && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-ink-subtle">
          No team has released a submission yet, so there is nothing to rank.
        </p>
      )}

      {preview.outcome === "quorum-not-met" && (
        <Refusal
          title="Some teams haven't been scored yet"
          detail={`Every released team needs at least ${preview.required} score before places can be published.`}
        >
          <CoverageTable coverage={preview.coverage} required={preview.required} />
        </Refusal>
      )}

      {preview.outcome === "coverage-uneven" && (
        <Refusal
          title="The judges have scored unevenly"
          /*
            ⚠ THIS IS THE MORE DANGEROUS OF THE TWO REFUSALS and the copy says why. A
            team scored by one harsh judge against a team scored by three generous ones produces a
            ranking that is arithmetically sound and unfair, which is exactly the kind of wrong
            answer nobody spots afterwards.
          */
          detail="Teams have different numbers of scores. Ranking them against each other would be unfair even though the arithmetic works, so publishing is blocked until the coverage matches."
        >
          <CoverageTable coverage={preview.coverage} />
        </Refusal>
      )}

      {preview.outcome === "stale-scores" && (
        <Refusal
          title="Some scores predate the latest release"
          detail="These teams were reopened and released again after being scored, so those scores were given for different work. Ask the judges to score the current version."
        >
          <ul className="mt-2 space-y-1 text-xs text-ink-muted">
            {preview.stale.map((s) => (
              <li key={`${s.submissionId}:${s.judgeId}`}>
                Submission {s.submissionId}, scored before the current release
              </li>
            ))}
          </ul>
        </Refusal>
      )}

      {preview.outcome === "tie-unresolved" && (
        <TieResolver
          ties={preview.ties}
          tieOrder={tieOrder}
          onChange={setTieOrder}
          onPublish={() => setConfirming(true)}
          pending={publish.isPending}
        />
      )}

      {preview.outcome === "ok" && (
        <>
          {/* An owner does not score, so there is no "You" column to show, an empty map rather than
              a second code path, so the table has exactly one shape. */}
          <PlacesTable places={preview.places} myScores={new Map()} />
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={publish.isPending}
            className="rounded bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:bg-brand-hover disabled:cursor-default"
          >
            {publish.isPending ? "Publishing…" : "Publish results"}
          </button>
        </>
      )}

      {confirming && (
        <ConfirmActionDialog
          title="Publish the results for this experience?"
          target={`Experience ${workshopId}`}
          consequences={[
            "Everyone entitled to this experience will be able to see the places.",
            "The experience moves to Completed.",
            tieOrder.length > 0
              ? "Your ordering of the tied teams is recorded against your name."
              : "The ranking shown above is what gets published.",
          ]}
          /*
            ⚠ PUBLISHING IS ONCE. The store refuses a second publish with `attribute_not_exists`, so
            this is not "reversible by repeating it", and the dialog must say so rather than let an
            owner assume they can adjust it afterwards.
          */
          reversibility="Results can be published only once for an experience. This cannot be undone from the app."
          confirmLabel="Publish"
          pendingLabel="Publishing…"
          tone="neutral"
          pending={publish.isPending}
          onConfirm={() =>
            publish.mutate({
              workshopId,
              tieOrder: tieOrder.length > 0 ? tieOrder : undefined,
            })
          }
          onDismiss={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function Refusal({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-warn-border bg-surface-3 p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-ink-subtle">{detail}</p>
      {children}
    </div>
  );
}

/** Who has been scored, and how often, the evidence behind both coverage refusals. */
function CoverageTable({
  coverage,
  required,
}: {
  coverage: Array<{ submissionId: string; teamId: string; teamName: string | null; judgeCount: number }>;
  required?: number;
}) {
  return (
    <ul className="mt-3 divide-y rounded border">
      {coverage.map((row) => {
        const short = required !== undefined && row.judgeCount < required;
        return (
          <li key={row.submissionId} className="flex items-center justify-between gap-3 p-2 text-sm">
            <span className="min-w-0 truncate text-ink-muted">
              {row.teamName ?? `Team ${row.teamId}`}
            </span>
            <span className={short ? "font-medium text-warn-text" : "text-ink-subtle"}>
              {row.judgeCount} score{row.judgeCount === 1 ? "" : "s"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * ── A TIE IS A HUMAN DECISION ───────────────────────────────────────────────
 *
 * The service refuses to publish a tie until the owner supplies an explicit ordering, and records
 * `tieBrokenById` when they do, so the record says a person broke it rather than implying the
 * arithmetic did.
 *
 * ⚠ THE ORDERING MUST COVER EVERY TIED TEAM AND NOTHING ELSE. The service refuses a partial list
 * (which would leave a tie unbroken while recording that a human broke it) and refuses one naming an
 * untied team (which would be an attempt to overrule the judges). So this control offers ONLY the
 * tied ids, and Publish stays disabled until each has a position.
 */
function TieResolver({
  ties,
  tieOrder,
  onChange,
  onPublish,
  pending,
}: {
  ties: Array<{ place: number; submissionIds: string[] }>;
  tieOrder: string[];
  onChange: (order: string[]) => void;
  onPublish: () => void;
  pending: boolean;
}) {
  const allTied = ties.flatMap((t) => t.submissionIds);
  const complete = allTied.every((id) => tieOrder.includes(id)) && tieOrder.length === allTied.length;

  function choose(id: string) {
    onChange(tieOrder.includes(id) ? tieOrder.filter((x) => x !== id) : [...tieOrder, id]);
  }

  return (
    <div className="rounded-lg border border-warn-border bg-surface-3 p-4">
      <h2 className="text-sm font-semibold text-ink">Two or more teams are tied</h2>
      <p className="mt-1 text-sm text-ink-subtle">
        They have identical averages, so the order is yours to decide. Click the teams in the order
        you want them placed: first click is the higher place. This is recorded against your name.
      </p>

      {ties.map((tie) => (
        <div key={tie.place} className="mt-3">
          <p className="text-xs font-medium text-ink-subtle">Tied at place {tie.place}</p>
          <ul className="mt-1 space-y-1">
            {tie.submissionIds.map((id) => {
              const position = tieOrder.indexOf(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => choose(id)}
                    className={`flex w-full items-center gap-3 rounded border p-2 text-left text-sm ${
                      position >= 0 ? "border-brand bg-brand-subtle" : "border-hairline"
                    }`}
                  >
                    <span className="w-6 shrink-0 text-center font-bold text-brand-text">
                      {position >= 0 ? position + 1 : "–"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{id}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <button
        type="button"
        onClick={onPublish}
        disabled={!complete || pending}
        className="mt-4 rounded bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:bg-brand-hover disabled:cursor-default"
      >
        {pending ? "Publishing…" : "Publish with this order"}
      </button>
      {!complete && (
        <p className="mt-2 text-xs text-warn-text">
          Give every tied team a position. A partial order is refused, because the record would
          otherwise say a tie was resolved when it was not.
        </p>
      )}
    </div>
  );
}
