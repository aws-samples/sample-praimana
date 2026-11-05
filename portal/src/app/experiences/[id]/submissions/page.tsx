"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { formatMessageInstant } from "@/lib/format-message-instant";
import { isSafeHttpUrl } from "@praimana/shared";

/**
 * ── A JUDGING PANEL'S WORKLIST ───────────────────────────────────────────────────────────
 *
 * Released teams only, for judges entitled to THIS experience.
 *
 * ── ⚠ WHY THIS IS AN EXPERIENCE-LEVEL PAGE AND NOT A TEAM TAB ──
 *
 * Judging entitlement is per WORKSHOP, not per team: a judge is invited to an experience and is a
 * member of none of its teams. So the team workspace is the wrong home, its tabs are member-gated,
 * and the Submit tab there was gated in the same change that added this page precisely so a judge is
 * not offered a route that 403s them.
 *
 * ── WHAT A JUDGE CAN AND CANNOT SEE FROM HERE ──
 *
 * Released work only, read from a PINNED SNAPSHOT, so a team that keeps
 * working after release cannot move the target under a judge mid-assessment. Team chat, the board,
 * AI threads and per-member assessments are NOT part of the disclosure, "a release discloses the
 * team's WORK, not its WORKING", and nothing on this page or its detail view reaches for them.
 *
 * ⚠ AN UNRELEASED TEAM IS ABSENT RATHER THAN LOCKED. The service returns released rows only, so
 * there is no "not submitted yet" row to render: a judge has no business knowing which teams exist
 * and have not submitted, which is the team's own state.
 */
export default function WorkshopSubmissionsPage() {
  const params = useParams();
  const workshopId = params.id as string;

  const list = trpc.submission.forWorkshop.useQuery(
    { workshopId },
    { enabled: Boolean(workshopId) }
  );

  if (list.isLoading) {
    return <div className="p-6 text-sm text-ink-subtle">Loading submissions…</div>;
  }

  /**
   * ⚠ THE TWO EMPTY STATES MUST NOT LOOK THE SAME, and one of them is an ERROR while the
   * other is a normal state:
   *
   *   403 WORKSHOP_NOT_ENTITLED → "you are not judging this experience". A real refusal, and telling
   *                               someone "no team has submitted yet" instead would have them wait
   *                               for something that will never arrive.
   *   200 with zero rows        → "no team has released yet". Nothing is wrong; come back later.
   */
  if (list.error) {
    const notEntitled = list.error.data?.code === "FORBIDDEN";
    return (
      <div className="w-full mx-auto max-w-4xl p-6">
        <h1 className="mb-2 text-2xl font-bold">Submissions</h1>
        <div
          role="alert"
          className={`rounded-lg border p-4 text-sm ${
            notEntitled
              ? "border-warn-border bg-warn-bg text-warn-text"
              : "border-danger-border bg-danger-bg text-danger-text"
          }`}
        >
          {notEntitled ? (
            <>
              <p className="font-medium">You&apos;re not judging this experience.</p>
              <p className="mt-1">
                Judging access is granted per experience. If you expected to be on this panel, ask
                the facilitator running it.
              </p>
            </>
          ) : (
            <>Submissions couldn&apos;t be loaded. {list.error.message}</>
          )}
        </div>
      </div>
    );
  }

  const rows = list.data?.submissions ?? [];

  return (
    <div className="w-full mx-auto max-w-4xl space-y-6 p-6">
      <header>
        {/* ⚠ `h2`, NOT `h1`. `ExperienceHeader` in the layout above already owns this route's
              `<h1>` (the experience name), so a second level-one heading here gave the page two
              and broke the document outline. The text itself stays: unlike the settings page, the
              view name plus its one-line description say something the tab bar does not. */}
              <h2 className="text-2xl font-semibold tracking-heading-tight">Submissions</h2>
        <p className="mt-1 text-sm text-ink-subtle">
          Teams that have released their work for judging. You see each team&apos;s notes and files as
          they were when released.
        </p>
      </header>

      {/*
        ⚠ TRUNCATION IS REPORTED, NOT HIDDEN. The service bounds the list and says when it cut it.
        A quietly short list reads as "that team never submitted", the same class of silent-wrong
        answer forbidden elsewhere.
      */}
      {list.data?.truncated && (
        <p className="rounded border border-warn-border bg-warn-bg p-3 text-xs text-warn-text">
          This list was shortened because the experience has a very large number of released teams.
          Ask the facilitator if a team you expect is missing.
        </p>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-ink-subtle">No team has released a submission yet.</p>
          <p className="mt-1 text-xs text-ink-subtle">
            Teams appear here once an executive on the team releases their work.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.submissionId} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    href={`/experiences/${workshopId}/submissions/${row.submissionId}`}
                    className="font-semibold text-brand-text hover:underline"
                  >
                    {/*
                      ⚠ THE PINNED NAME, FALLING BACK TO THE TEAM ID. A judge cannot resolve a team's
                      name themselves, Team's roster route filters to the caller's own teams and a
                      judge has none, so the name is captured at release and stored in the snapshot.
                      When that capture failed it is null, and an id is honest where a blank is not.
                    */}
                    {row.teamName ?? `Team ${row.teamId}`}
                  </Link>
                  {row.title && <p className="mt-0.5 text-sm text-ink-muted">{row.title}</p>}
                  <p className="mt-1 text-xs text-ink-subtle">
                    Released {row.releasedAt ? formatMessageInstant(row.releasedAt) : "-"} ·{" "}
                    {row.artifactCount} file{row.artifactCount === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  {/*
                    ⚠ THIS JUDGE'S OWN SCORE, AND NOBODY ELSE'S. The service returns only the
                    caller's row; another judge's total is never sent here. Mid-judging disclosure of
                    one judge's numbers to another is the P0-4 defect, and a list is exactly where it
                    would creep back in.

                    ⚠ "Not scored" IS NOT ZERO. A zero total is a judgement; the absence of one is
                    not, and rendering `0/50` would be a statement this judge never made.
                  */}
                  {row.scoredByMe ? (
                    <span className="inline-block rounded-full border border-success-border bg-success-bg px-3 py-1 text-xs font-medium text-success-text">
                      You scored {row.myScoreTotal}/{row.maxScore}
                    </span>
                  ) : (
                    <span className="inline-block rounded-full border border-hairline bg-surface-1 px-3 py-1 text-xs font-medium text-ink-subtle">
                      Not scored yet
                    </span>
                  )}
                  {row.demoUrl && (
                    <div className="mt-2">
                      {/*
                        ⚠ `isSafeHttpUrl` IS THE PROTOCOL ALLOWLIST. This URL is participant-supplied;
                        without a scheme check a stored `javascript:` URL would execute in the
                        judge's session on click. Anything not http/https renders as inert text.
                        `rel="noopener noreferrer"` remains as a second line for valid links.
                      */}
                      {isSafeHttpUrl(row.demoUrl) ? (
                        <a
                          href={row.demoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-brand-text hover:underline"
                        >
                          Open demo ↗
                        </a>
                      ) : (
                        <span className="text-xs text-ink-subtle">
                          Demo <span className="text-warn-text">(not a valid web link)</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
