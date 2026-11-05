"use client";

import Link from "next/link";
import { formatInstantUtc } from "@/lib/format-datetime";
import { SessionExpiredNotice, ContentLoadError } from "@/components/TeamContentNotice";
import { RatingCoverage } from "@/components/RatingCoverage";

/**
 * THE PUBLISHED TEAM SUMMARY, the whole of what a JUDGE, or an EXECUTIVE who is not on this
 * team, may read about how a team worked.
 *
 * ── THE GAP THIS CLOSES ──
 *
 * The insights page returns <MemberOnlyNotice> for any non-member, and that page-level gate is
 * correct and deliberate (see the long note at its `teamContentGate` call). The consequence was
 * that a judge, whose entire reason for being on the platform is to assess submitted work -
 * hit a wall that said "visible to team members" and could never reach the summary the team had
 * deliberately PUBLISHED to them. A rule stated accurately about the wrong thing is still a
 * dead end, and this is the honest destination beyond it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──
 *
 * No score, no name, no rationale, no per-member anything. Not filtered out here, never
 * fetched: this component is fed by `rating.summary`, whose RESPONSE SHAPE is the enforcement
 * (see routes.ts, "the response shape is the enforcement, not a filter applied to a wider
 * object"). A filtered payload is one forgotten branch away from a leak; there is nothing to
 * forget here because the per-member fields never cross the wire.
 *
 * ── THREE STATES, THREE FACES, AND NONE OF THEM IS A RED BOX ──
 *
 *   NOT PUBLISHED  An ORDINARY answer, this team has not published a summary. Dashed gray,
 *                  role="status", the same "there is legitimately nothing here" idiom the
 *                  member-only notice and the empty roster already use. It is emphatically NOT
 *                  a failure: a judge who reads a red panel goes looking for someone to fix
 *                  something that is working exactly as designed, during judging.
 *   PUBLISHED      The summary, its provenance, and the coverage caveats.
 *   FAILED         ContentLoadError, solid red, role="alert", with a retry. The read genuinely
 *                  did not answer.
 *
 * The first two are separated from the third on three axes at once and none of them is colour,
 * for the reasons TeamContentNotice documents at length.
 */

/**
 * How many days after publication the summary stops being described as current.
 *
 * NOT a staleness ALARM, a workshop's summary is a deliverable, and a two-week-old one is
 * perfectly valid evidence of what a team did. The age is stated in every case (see the
 * provenance line); this threshold only decides whether the page volunteers that the analysis
 * predates the work an operator may be looking at. Judged in whole days because the underlying
 * event is a workshop phase, not a tick.
 */
const SUMMARY_AGEING_DAYS = 14;

export function PublishedTeamSummary({
  data,
  loading,
  loadError,
  sessionExpired = false,
  onRetryLoad,
  teamHref,
  /**
   * Now, in epoch ms, PASSED IN rather than read from the clock, the same discipline
   * `invitationStatusLabel` applies. A `Date.now()` inside a client component renders one
   * answer during the server prerender and a different one at hydration, and React reports the
   * disagreement as a hydration mismatch.
   *
   * NULL until the caller has mounted and established it, and null means "age not yet known",
   * never zero. A zero would date every summary to 1970 and report all of them as ageing.
   */
  now,
}: {
  data:
    | {
        summary: string | null;
        generatedAt: string | null;
        publishedAt: string | null;
        coverage: string[];
        memberCount: number | null;
        notPublished: boolean;
      }
    | undefined;
  loading: boolean;
  /** A failed READ. Distinct from `notPublished`, which is not a failure at all. */
  loadError: string | null;
  /**
   * True when the failure was a 401.
   *
   * ⚠ A SEPARATE FLAG BECAUSE `loadError` IS A STRING, and that flattening is what hid the bug: the caller
   * passes `error?.message`, so by the time it arrives here "Backend error: 401" is indistinguishable from any
   * other message and this component cannot branch on it. String-matching the text would be a second,
   * disagreeing definition of "unauthorised", the same trap as comparing errors with `instanceof` across two
   * copies of tRPC. The decision is made once, at the call site, with `isUnauthorized`.
   */
  sessionExpired?: boolean;
  onRetryLoad: () => void;
  /** The Team tab for THIS team, the one section that is never member-only. */
  teamHref: string;
  now: number | null;
}) {
  return (
    <div className="h-[calc(100vh-12rem)] overflow-y-auto">
      <div className="w-full mx-auto max-w-3xl px-6 py-6">
        <h2 className="text-lg font-bold text-ink">Team AI summary</h2>
        {/*  WHY THE VIEWER IS TOLD THE SHAPE OF THEIR OWN ACCESS, up front and unprompted.
             Without this line the page is indistinguishable from one that is hiding something,
             and the reasonable next move is to ask a facilitator for "the real numbers", a
             support conversation about a rule that is working. gray-600 on white is 7.46:1
             (AAA), deliberately not the gray-400 (2.85:1) this codebase uses for decorative
             captions: this sentence explains an absence, so it is the wrong place to trade
             contrast for quietness. */}
        <p className="mt-0.5 text-sm text-ink-subtle">
          This is the team-level summary its members published. Per-member assessments stay
          within the team.
        </p>

        {loading ? (
          // A sentence, not a spinner: a spinner says "wait" and this says what is being
          // waited for. No animation to suppress under prefers-reduced-motion either.
          <p className="mt-8 text-sm text-ink-subtle">Loading the published summary…</p>
        ) : sessionExpired ? (
          /* BEFORE the generic load error: an expired login is not a failed read, and telling a judge to
             report a bug about their own session is the defect this branch exists to prevent. */
          <SessionExpiredNotice what="this team's published summary" />
        ) : loadError ? (
          /* BEFORE the notPublished branch, and that order is the load-bearing part. A failed
             read leaves `data` undefined, which is shaped exactly like "nothing published" -
             so without this the page would tell a judge the team published nothing when the
             truth is that we could not find out. That is the same class of defect as the
             ratings card's "No AI ratings yet" over a failed read, and it lands on the one
             person whose job depends on the answer. */
          <ContentLoadError
            what="this team's published summary"
            detail={loadError}
            onRetry={onRetryLoad}
          />
        ) : !data || data.notPublished || !data.summary ? (
          /* AN ORDINARY STATE. `notPublished` from the router, and also the belt-and-braces
             `!data.summary`: the service answers `{summary: null}` for a team with no snapshot
             at all, which reaches here with `notPublished: false` and is the same fact to a
             reader. Dashed gray + role="status", never red. */
          <div
            role="status"
            className="mt-8 rounded-xl border border-dashed border-field-border bg-surface-1 p-8 text-center"
          >
            <h3 className="font-semibold text-ink-muted">
              This team hasn&apos;t published a summary yet
            </h3>
            {/* States WHOSE ACTION IS OUTSTANDING and that nothing is broken. Both halves
                matter: without the first, the reader does not know whether to wait or to
                escalate; without the second, a blank page during judging reads as an outage. */}
            <p className="w-full mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
              Publishing is a deliberate step a team member takes, so there is nothing to show
              until they do. Nothing has failed, and there is nothing for you to retry.
            </p>
            {/* A LINK, not a "go back": the operator may have arrived by pasted URL with no
                history. Same destination and same reasoning as MemberOnlyNotice's. */}
            <Link
              href={teamHref}
              className="mt-5 inline-block rounded-md border border-field-border bg-surface-3 px-4 py-2 text-sm font-medium text-brand-text hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-brand"
            >
              Go to the Team tab
            </Link>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <section
              aria-labelledby="published-summary-heading"
              className="rounded-xl border bg-surface-3 shadow-sm"
            >
              <div className="border-b bg-surface-1/50 px-5 py-4">
                <h3
                  id="published-summary-heading"
                  className="text-sm font-semibold text-ink-muted"
                >
                  How this team worked
                </h3>
                {/* PROVENANCE ON ITS OWN LINE, and in a fixed order: published, generated,
                    team size. An operator comparing two teams' summaries reads down the same
                    three facts in the same place both times.

                    Both instants go through formatInstantUtc, so they are fixed-width, carry
                    their zone, and are byte-identical on the server and at hydration. */}
                <SummaryProvenance data={data} now={now} />
              </div>
              <div className="p-5">
                {/* whitespace-pre-line: the model is instructed to write 2-4 sentences with no
                    bullets, but it is a model, if it emits a newline anyway, honouring it
                    beats running two sentences together. max-w-prose keeps the measure
                    readable at 200% zoom. */}
                <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-ink-muted">
                  {data.summary}
                </p>
              </div>
            </section>

            {/* The caveats travel WITH the summary, on the judge's screen as much as on a
                member's. This reader is the one most likely to act on it and the least likely
                to know how it was produced.

                headingLevel 3, not the default 4: here the panel is a SIBLING of the summary
                section rather than nested inside it, so under the page's <h2> the next legal
                rank is 3. An h4 would skip a level and leave a screen-reader operator with a
                broken outline on the panel that states the caveats. */}
            <RatingCoverage coverage={data.coverage} headingLevel={3} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The provenance line: when it was published, when the underlying analysis ran, and how many
 * people it covered.
 *
 * ── WHY BOTH INSTANTS, AND WHY THE ORDER ──
 *
 * They answer different questions and can be days apart. `generatedAt` is when the model looked
 * at the team's activity, the age of the EVIDENCE. `publishedAt` is when a member decided to
 * disclose it. A reader assessing a team needs the first; a reader wondering why they can see
 * this at all needs the second. Collapsing them into one "updated" timestamp, which is what
 * the ratings card does, correctly, for an audience of members who know they just pressed the
 * button, would leave a judge unable to tell a fresh summary from an old one that was
 * published today.
 */
function SummaryProvenance({
  data,
  now,
}: {
  data: {
    generatedAt: string | null;
    publishedAt: string | null;
    memberCount: number | null;
  };
  now: number | null;
}) {
  const published = formatInstantUtc(data.publishedAt);
  const generated = formatInstantUtc(data.generatedAt);

  const generatedMs = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  // An unparseable or absent instant is NOT ageing, it is unknown, and `NaN` comparisons are
  // false in both directions, which is the safe result. A summary reported as old on the
  // strength of a garbled field would discredit a perfectly current analysis. Same for a clock
  // the caller has not established yet: the note appears a beat later rather than wrongly.
  const ageingDays =
    now === null || Number.isNaN(generatedMs)
      ? null
      : Math.floor((now - generatedMs) / 86_400_000);
  const ageing = ageingDays !== null && ageingDays >= SUMMARY_AGEING_DAYS;

  return (
    <>
      {/* gray-600 (7.46:1), not the gray-400 this codebase uses for decoration: these dates
          are how a judge decides how much weight the summary carries. */}
      <p className="mt-1 text-xs text-ink-subtle">
        {published ? (
          <>
            Published{" "}
            <time dateTime={data.publishedAt ?? undefined} title={data.publishedAt ?? undefined}>
              {published}
            </time>
          </>
        ) : (
          // Said out loud rather than left blank. The summary IS published, that is why it is
          // on screen, so a missing date is a gap in the record, not evidence against it.
          <>Published, date unknown</>
        )}
        {generated ? (
          <>
            {" · analysed "}
            <time
              dateTime={data.generatedAt ?? undefined}
              title={data.generatedAt ?? undefined}
            >
              {generated}
            </time>
          </>
        ) : (
          <>{" · analysis date unknown"}</>
        )}
        {/* `memberCount` is null when the service could not report it, which is NOT zero, a
            "0 people" summary is a number a reader would act on. Omitted rather than
            defaulted, the same reading the teams directory applies to its own null count. */}
        {typeof data.memberCount === "number" && (
          <>
            {" · "}
            <span className="tabular-nums">{data.memberCount}</span>
            {data.memberCount === 1 ? " person" : " people"}
          </>
        )}
      </p>

      {ageing && (
        /* NOT an alert and NOT red, a workshop deliverable does not rot on a timer, and this
           is a note about how to read a date the line above already states. It exists because
           the alternative is a judge assuming a summary describes work that in fact continued
           for two more weeks after the analysis ran.

           NOT COLOUR ALONE: the whole fact is in the sentence, and the number of days is
           stated. Remove the amber and nothing is lost but the emphasis. amber-800 (#92400e) on
           white is 7.09:1, AAA, and readable through glare on a wall display. */
        <p className="mt-1 text-xs text-warn-text">
          The analysis behind this summary ran{" "}
          <span className="tabular-nums">{ageingDays}</span> days ago, so it describes the
          team&apos;s activity up to that point and not since.
        </p>
      )}
    </>
  );
}
