"use client";

import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { formatMessageInstant } from "@/lib/format-message-instant";
import {
  needsAttention,
  experienceTotals,
  QUIET_AFTER_HOURS,
  type Attention,
} from "@/lib/experience-activity";

/**
 * ── HOW IS MY EXPERIENCE GOING?, for whoever is RUNNING it ────────────────────────────────
 *
 * This screen is for an ADMIN, or the FACILITATOR who owns this
 * experience, and the evaluation service enforces that against the stored `ownerId`, not this page.
 *
 * ── ⚠ WHAT THIS SCREEN IS AND IS NOT ──
 *
 * It answers the question a facilitator standing in a live room cannot answer by looking: WHICH TEAM
 * HAS GONE QUIET. Everyone looks busy.
 *
 * It shows COUNTS AND TIMESTAMPS, never CONTENT (team content is member-only and a
 * facilitator is not a member), and nothing PER PERSON (this platform measures
 * capability, not people). The service aggregates the person away before answering, so this page could
 * not show it even if it tried.
 *
 * ⚠ AND IT DOES NOT CLAIM A TREND. The underlying read-model is cumulative with one `updatedAt`, so
 * every time figure here is "when did anything last happen", never "activity is falling". Presenting a
 * trend would be inventing a series that does not exist: a real one would need per-interval activity
 * counts, which the read-model does not store.
 */
export default function ExperienceActivityPage() {
  const params = useParams();
  const workshopId = params.id as string;

  const activity = trpc.insights.experienceActivity.useQuery(
    { workshopId },
    {
      enabled: Boolean(workshopId),
      /**
       * A facilitator leaves this open on a second screen during a live session, so it refreshes -
       * but slowly. Each poll is one service call that fans out per team, so a tight interval would
       * multiply across every team for a number that changes in minutes, not seconds.
       */
      refetchInterval: 60_000,
    }
  );

  if (activity.isLoading) {
    return <div className="p-6 text-sm text-ink-subtle">Reading this experience&apos;s activity…</div>;
  }

  if (activity.error) {
    /**
     * ⚠ 503 IS "TRY AGAIN", 403 IS "NOT YOURS", AND THEY MUST NOT LOOK ALIKE. The service answers
     * `TEAMS_UNAVAILABLE` rather than reporting an experience as empty, precisely so a facilitator is
     * never told their teams have vanished.
     */
    const notOwner = activity.error.data?.code === "FORBIDDEN";
    return (
      <div className="w-full mx-auto max-w-4xl p-6">
        <Header />
        <div
          role="alert"
          className={`mt-4 rounded-lg border p-4 text-sm ${
            notOwner
              ? "border-warn-border bg-warn-bg text-warn-text"
              : "border-danger-border bg-danger-bg text-danger-text"
          }`}
        >
          {notOwner
            ? "This view is for the administrator or the facilitator running this experience."
            : `Activity couldn't be read just now. Please try again. (${activity.error.message})`}
        </div>
      </div>
    );
  }

  const teams = activity.data?.teams ?? [];
  const totals = experienceTotals(teams);
  const attention = needsAttention(teams);

  return (
    <div className="w-full mx-auto max-w-4xl space-y-6 p-6">
      <Header />

      {/* ── Status strip ──────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Teams" value={String(totals.teams)} />
        {/* ⚠ "-" not "0" when the roster count did not come back. */}
        <Stat label="People" value={totals.people === null ? "-" : String(totals.people)} />
        <Stat
          label="People active"
          value={String(totals.peopleWithActivity)}
          note={
            totals.people !== null && totals.people > 0
              ? `of ${totals.people}`
              : "have any recorded activity"
          }
        />
        <Stat label="Released" value={`${totals.released} of ${totals.teams}`} />
      </section>

      {/* ── Needs attention, the only section that earns the top ──────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Needs attention</h2>
        {attention.length === 0 ? (
          <p className="rounded-lg border border-success-border bg-success-bg p-4 text-sm text-success-text">
            Nothing to chase: every team has been active in the last {QUIET_AFTER_HOURS} hours, or has
            released.
          </p>
        ) : (
          <ul className="space-y-2">
            {attention.map((item) => (
              <li
                key={`${item.kind}:${item.team.teamId}`}
                className="rounded-lg border border-warn-border bg-warn-bg p-3 text-sm text-warn-text"
              >
                <span className="font-medium">
                  {item.team.teamName ?? `Team ${item.team.teamId}`}
                </span>
                {": "}
                {attentionCopy(item)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Per-team table ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Teams</h2>
        {teams.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-ink-subtle">
            This experience has no teams yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-surface-1 text-left text-xs uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">Team</th>
                  <th className="px-3 py-2">People</th>
                  <th className="px-3 py-2">Messages</th>
                  <th className="px-3 py-2">Commits</th>
                  <th className="px-3 py-2">Tasks done</th>
                  <th className="px-3 py-2">AI turns</th>
                  <th className="px-3 py-2">Last activity</th>
                  <th className="px-3 py-2">Submission</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {teams.map((team) => (
                  <tr key={team.teamId}>
                    <td className="px-3 py-2 font-medium text-ink-muted">
                      {team.teamName ?? `Team ${team.teamId}`}
                    </td>
                    <td className="px-3 py-2 text-ink-subtle">
                      {team.membersWithActivity}
                      {team.memberCount !== null && (
                        <span className="text-ink-tertiary"> / {team.memberCount}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-subtle">{team.messagesSent}</td>
                    <td className="px-3 py-2 text-ink-subtle">{team.commitsPushed}</td>
                    <td className="px-3 py-2 text-ink-subtle">{team.tasksCompleted}</td>
                    <td className="px-3 py-2 text-ink-subtle">
                      {/*
                        ⚠ "not measured" IS NOT ZERO. Rows written before the counter existed carry no
                        value, and a 0 here would state "this team used no assistant" about a period
                        nobody was measuring.
                      */}
                      {team.aiTurns === null ? (
                        <span className="text-ink-tertiary" title="No measurement for this team's rows">
                          not measured
                        </span>
                      ) : (
                        team.aiTurns
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-subtle">
                      {team.lastActivityAt ? formatMessageInstant(team.lastActivityAt) : "-"}
                    </td>
                    <td className="px-3 py-2">
                      {team.released ? (
                        <span className="rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-xs text-success-text">
                          Released
                        </span>
                      ) : (
                        <span className="text-xs text-ink-subtle">Draft</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/*
        ⚠ THE LIMITS ARE STATED ON SCREEN. A reader who thinks these are live totals
        with a trend will draw conclusions the data cannot support, and the AI coverage line is the
        difference between a total and a floor (the rule `TokenUsagePanel` states).
      */}
      <section className="space-y-1 border-t pt-4 text-xs text-ink-subtle">
        <p>
          Counts are cumulative since each team started, and &ldquo;last activity&rdquo; is the most
          recent recorded action, not a trend.
        </p>
        {totals.aiTurns !== null && (
          <p>
            AI turns measured for {totals.aiTurnsMeasuredForTeams} of {totals.teams} team
            {totals.teams === 1 ? "" : "s"}. The rest predate the counter, so the total is a floor.
          </p>
        )}
        <p>
          This view shows activity counts only. It does not show messages, documents, or anything about
          individual people.
        </p>
      </section>
    </div>
  );
}

function Header() {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        {/* ⚠ `h2`, NOT `h1`. `ExperienceHeader` in the layout above already owns this route's
              `<h1>` (the experience name), so a second level-one heading here gave the page two
              and broke the document outline. The text itself stays: unlike the settings page, the
              view name plus its one-line description say something the tab bar does not. */}
              <h2 className="text-2xl font-semibold tracking-heading-tight">Activity</h2>
        <p className="mt-1 text-sm text-ink-subtle">
          How each team in this experience is doing, and who needs a nudge.
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
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
      {note && <p className="text-xs text-ink-subtle">{note}</p>}
    </div>
  );
}

/** What to tell the facilitator to DO, the reason each flag exists. */
function attentionCopy(item: Attention): string {
  switch (item.kind) {
    case "never-started":
      return "nothing recorded yet. Check they can sign in and reach their tools.";
    case "quiet":
      return `no activity for about ${Math.round(item.hoursSince)} hours.`;
    case "no-ai-usage":
      // ⚠ A coaching signal, not a fault, the wording matters, since this platform exists to help
      // people work WITH an assistant rather than to police whether they did.
      return "active, but no assistant use recorded. They may need a hand getting started with it.";
  }
}
