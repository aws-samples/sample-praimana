"use client";

import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsReadOnly } from "@/lib/useRole";
import { teamContentGate } from "@/lib/team-content-gate";
import { isForbidden, isUnauthorized } from "@/lib/trpc/errors";
import { teamTabHref } from "@/lib/team-routes";
import { formatInstantUtc } from "@/lib/format-datetime";
import { InsightsMethodology } from "@/components/InsightsMethodology";
import {
  RatingsPromptDisclosure,
  type DisclosedPrompt,
} from "@/components/RatingsPromptDisclosure";
import { TokenUsagePanel } from "@/components/TokenUsagePanel";
import { RatingCoverage } from "@/components/RatingCoverage";
import { PublishedTeamSummary } from "@/components/PublishedTeamSummary";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import {
  ActionOutcome,
  type ActionOutcomeState,
} from "@/components/ActionOutcome";
import { ContentLoadError,
  SessionExpiredNotice, } from "@/components/TeamContentNotice";

// --- Types ---

interface MemberMetrics {
  id: string;
  name: string;
  role: string;
  aiSessions: number;
  aiMessagesSent: number;
  avgMessagesPerSession: number;
  tasksCompleted: number;
  tasksTotal: number;
  teamMessages: number;
  aiUsageScore: number;
  engagementLevel: "Low" | "Medium" | "High" | "Power User";
  topTopics: string[];
}

/**
 * One member's AI-assistant coaching assessment, as `rating.analysis` returns it.
 *
 * ⚠ THERE IS NO NAME ON THIS SHAPE, and that is the service's design rather than an omission:
 * the model is only ever given opaque `M1..Mn` handles, so it cannot name anyone in the
 * publishable summary (see SummaryModelInput in the ai service's `domain.ts`). Names are
 * resolved HERE, from the roster this page already holds, which also means a member removed
 * since the analysis ran has no name to resolve, and the card has to say so rather than render
 * a blank card for a person nobody can identify.
 */
interface MemberAssessment {
  userId: string;
  aiKnowledgeScore: number;
  rationale: string;
  strengths: string[];
  improvements: string[];
}

/**
 * Display bound on the assessment list. The service REFUSES an analysis above 25 members
 * (MAX_RATED_MEMBERS in its routes.ts) so this cannot bite today; it exists so a future
 * service that raises its own cap cannot turn this card into an unbounded render, and it
 * DISCLOSES the truncation rather than dropping people silently.
 */
const MAX_ASSESSMENTS_SHOWN = 25;

// --- Helpers ---

function computeEngagementLevel(score: number): MemberMetrics["engagementLevel"] {
  if (score >= 80) return "Power User";
  if (score >= 55) return "High";
  if (score >= 30) return "Medium";
  return "Low";
}

/**
 * The engagement band's styling. Neutral for every band, see ScoreBadge for the full note.
 *
 * A red "Low" pill beside a colleague's name was the strongest comparative signal on the page:
 * red is the colour of an error everywhere else in this UI, and the band is an activity bucket,
 * not a fault. The bands still READ differently ("Low" vs "Power User") because the word is the
 * information; they no longer look like a pass and a failure.
 *
 * Kept as a function returning one constant rather than inlined, so the call sites and the
 * `engagementLevel` union stay untouched and a future band cannot silently miss styling.
 */
function engagementColor(level: MemberMetrics["engagementLevel"]) {
  void level;
  return "bg-surface-2 text-ink-subtle border-hairline";
}

function extractTopic(content: string): string {
  const cleaned = content.replace(/```[\s\S]*?```/g, "").trim();
  const firstLine = cleaned.split("\n")[0] ?? "";
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57) + "...";
}

/**
 * Suggestions for the TEAM, phrased without naming or grading an individual.
 *
 * ── WHAT THIS USED TO EMIT, AND WHY IT HAD TO CHANGE ──
 *
 * One bullet per person, by name, carrying their score and a verdict:
 *
 *   "Dana has low AI engagement (score: 22) - consider pairing them with a more
 *    experienced AI user for their next task."
 *
 * That is a written performance judgement about a named colleague, rendered on a page their
 * whole team reads, derived from an activity heuristic that the methodology panel itself says
 * "is not a measure of contribution". It is the same objection that applies to the
 * model-generated ratings, "positive vibe", no ranking, and it applies with more force here,
 * because a heuristic cannot see the work at all: someone who solved the hard problem in three
 * messages scores below someone who took thirty.
 *
 * So the suggestions are now COUNTS, not names. "Two people have not started a conversation
 * yet" tells a facilitator exactly as much about what to do next, and tells the other five
 * nothing about who those two are. The people concerned already know.
 *
 * Nobody is described as low, weak, or behind, only as not having started something yet, which
 * is a fact about a counter rather than a claim about a person.
 */
function generateRecommendations(members: MemberMetrics[]): string[] {
  const recommendations: string[] = [];

  const powerUsers = members.filter((m) => m.engagementLevel === "Power User");
  const lowUsers = members.filter((m) => m.engagementLevel === "Low");
  const mediumUsers = members.filter((m) => m.engagementLevel === "Medium");

  /** "1 person has" / "3 people have", a count reads as a team signal, a name as a verdict. */
  const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
  const have = (n: number) => (n === 1 ? "has" : "have");

  if (powerUsers.length > 0) {
    recommendations.push(
      `${people(powerUsers.length)} on this team ${have(powerUsers.length)} the deepest AI usage so far - a good moment for them to share what is working in a stand-up or retro.`
    );
  }

  const notStarted = lowUsers.filter((m) => m.aiSessions === 0).length;
  if (notStarted > 0) {
    recommendations.push(
      `${people(notStarted)} ${have(notStarted)} not started an AI conversation yet - a guided walkthrough or a pairing session is usually enough to get going.`
    );
  }

  const startedButQuiet = lowUsers.length - notStarted;
  if (startedButQuiet > 0) {
    recommendations.push(
      `${people(startedButQuiet)} ${have(startedButQuiet)} used the assistant only briefly - pairing on the next task is an easy way to pick up techniques.`
    );
  }

  const shortSessions = mediumUsers.filter((m) => m.avgMessagesPerSession < 3).length;
  if (shortSessions > 0) {
    recommendations.push(
      `${people(shortSessions)} tend${shortSessions === 1 ? "s" : ""} to have short AI conversations - following up on an answer, rather than re-asking, usually gets more out of it.`
    );
  }

  if (powerUsers.length === 0 && members.length > 0) {
    recommendations.push(
      "No power users yet on this team. Consider running a mini-workshop on effective AI prompting techniques."
    );
  }

  if (members.length > 0) {
    const avgScore =
      members.reduce((sum, m) => sum + m.aiUsageScore, 0) / members.length;
    if (avgScore < 40) {
      recommendations.push(
        `Team average AI score is ${avgScore.toFixed(0)}/100 - the team could benefit from sharing prompt templates and best practices.`
      );
    } else if (avgScore >= 70) {
      recommendations.push(
        `Strong team AI adoption (avg score: ${avgScore.toFixed(0)}/100) - this team is well-positioned to tackle more complex AI-assisted tasks.`
      );
    }
  }

  return recommendations;
}

// --- Component ---

export default function InsightsPage() {
  const params = useParams();
  const teamId = params.teamId as string;

  const workshopId = params.workshopId as string;
  /**
   * THE ANALYSIS IS RUN ON DEMAND, not on arrival.
   *
   * Building these metrics costs three requests, every AI thread, every board task and 100
   * team messages, and then a full recomputation over all of it. That ran on every visit,
   * including the many where someone opened the tab to glance at one number or landed on it
   * by accident. Deferring it makes the cost follow the intent.
   *
   * `hasRun` gates those three together rather than each separately: the metrics are a single
   * derived view over the whole set, so a partial fetch would render a table that is
   * arithmetically wrong rather than merely incomplete.
   */
  const [hasRun, setHasRun] = useState(false);



  /**
   * ⚠ DELIBERATELY NOT GATED ON `hasRun`, unlike the three content queries below, and this is
   * the one query whose gating genuinely changed.
   *
   * It answers "is the viewer a member of this team", which decides WHICH PAGE renders (the
   * member dashboard, or the published summary a judge is entitled to). That decision has to be
   * made before anything is offered, so it cannot wait for a button, and gating it would mean
   * a judge is shown a "Generate insights" button, presses it, produces three refused requests,
   * and only then learns which page they were always going to get.
   *
   * IT COSTS NOTHING TO UN-GATE. The workspace layout already runs this exact query
   * unconditionally on every route in the team workspace (see the `isMember` derivation in
   * ../layout.tsx), so react-query serves this observer from the same cache entry and no
   * additional request is made. The metrics' all-or-nothing invariant is unaffected: the useMemo
   * below returns zeroed metrics unless team AND threads AND tasks AND messages are all present,
   * so the arithmetic is guarded by that condition rather than by this flag.
   */
  const teamQuery = trpc.team.getById.useQuery({ teamId, workshopId });
  const { data: team, isLoading: teamLoading } = teamQuery;
  const threadsQuery = trpc.ai.getThreads.useQuery({ teamId }, { enabled: hasRun });
  /**
   * Token usage across the team's conversations.
   *
   * ⚠ GATED ON `hasRun` LIKE THE OTHERS, so opening this page does not fan out over every thread before the
   * operator has asked for anything. And its failure is deliberately NOT in the page gate: an unreadable usage
   * panel must not blank a page whose assessment loaded fine, so the panel simply does not render.
   */
  const tokenUsageQuery = trpc.ai.tokenUsage.useQuery({ teamId }, { enabled: hasRun });

  const { data: threads, isLoading: threadsLoading } = threadsQuery;
  const tasksQuery = trpc.task.list.useQuery({ teamId }, { enabled: hasRun });
  const { data: tasks, isLoading: tasksLoading } = tasksQuery;
  const messagesQuery = trpc.message.list.useQuery(
    { teamId, limit: 100 },
    { enabled: hasRun }
  );
  const { data: messagesData, isLoading: messagesLoading } = messagesQuery;

  /**
   * Refetch everything this page displays.
   *
   * ⚠ IT USED TO SKIP `analysisQuery`, and that was reported as "clicked Refresh and it did
   * nothing". Four of the five reads were refreshed and the stored assessment was not, so a
   * generation that had completed in another tab, or a colleague's publish, stayed invisible until a
   * full page reload. On a screen whose most valuable content IS that assessment, a Refresh that
   * pointedly does not refresh it is worse than no button.
   *
   * It is a READ, so adding it cannot bill: `analyze` is the billable route and remains an explicit
   * executive action behind a cooldown. `refetch()` on a DISABLED query resolves without firing, so
   * a participant or non-member pressing Refresh sends nothing new, no need to repeat the audience
   * conditions here.
   *
   * `summaryQuery` is included for the same reason and with the same safety: for a judge or an
   * off-team executive it is the ONLY thing on their screen, and it was equally unrefreshable.
   */
  const refreshAnalysis = () => {
    if (!hasRun) {
      setHasRun(true);
      return;
    }
    void Promise.all([
      teamQuery.refetch(),
      threadsQuery.refetch(),
      tasksQuery.refetch(),
      messagesQuery.refetch(),
      analysisQuery.refetch(),
      summaryQuery.refetch(),
    ]);
  };

  const readOnly = useIsReadOnly();
  /**
   * EXECUTIVE is the platform's only read-only role, so this is that same fact named for what
   * it means on THIS page: generating and publishing a team assessment are executive actions.
   * Named rather than inlined so `canAnalyze={isExecutive}` states the rule instead of looking
   * like an inverted flag someone forgot to fix.
   */
  const isExecutive = readOnly;

  /**
   * IS THE VIEWER ON THIS TEAM, three states, and the third one must not guess.
   *
   * The same derivation, from the same query, as the workspace layout's `isMember`: compared
   * against `member.userId`, the Cognito sub the membership row is keyed on and the value
   * NextAuth puts on `session.user.id`.
   *
   * NEVER INFERRED FROM THE ROLE. An EXECUTIVE is frequently a member (read-only is about
   * writing, not about belonging) and must see everything a teammate sees; an ADMIN can
   * legitimately be a member; a PARTICIPANT can be looking at a team they are not on.
   * Membership is a fact about a table and no role is a proxy for it.
   *
   * "unknown" IS ITS OWN STATE because both wrong answers are bad in different ways: guessing
   * "member" renders a dashboard that will 403, and guessing "non-member" shows a member the
   * judge's cut-down page, telling them their own team's coaching does not exist. So an
   * unresolved session or an unloaded roster waits instead of choosing.
   */
  const { data: session } = useSession();
  const myUserId = session?.user?.id;
  const membership: "member" | "non-member" | "unknown" =
    !myUserId || !team
      ? "unknown"
      : (team.members ?? []).some((m) => m.userId === myUserId)
        ? "member"
        : "non-member";

  /**
   * The EXECUTIVE-ONLY per-member analysis. A READ, never a generation, it cannot bill, which
   * is what makes it safe to run without a confirmation.
   *
   * ⚠ THE GATE WAS `membership === "member"`, and that is now too wide. Per-member assessments
   * are read by executives on the team; a participant teammate gets 403 EXECUTIVE_ONLY. Asking
   * anyway would spend a request to be refused and light up the card's error state for somebody
   * who is not entitled to the data in the first place.
   *
   * Three conditions, three different reasons:
   *   `isExecutive`, the audience. EXECUTIVE is the platform's only read-only role, so this
   *                     is that same fact named for what it means here.
   *   `membership`, an executive on ANOTHER team is refused too (NOT_A_TEAM_MEMBER): the
   *                     assessments derive from this team's private conversations.
   *   `hasRun`, the card lives inside the on-demand dashboard, so fetching earlier buys
   *                     a request whose result cannot be displayed.
   *
   * The SERVICE is the boundary in every case; this only avoids a request that is certain to be
   * refused.
   */
  /**
   * ⚠ NO LONGER GATED ON `hasRun`, and removing that gate is the fix for a reported bug.
   *
   * Reported: generate insights, go to the dashboard, come back, and the page asks to generate
   * again. The generation had actually SUCCEEDED and the snapshot was in DynamoDB (verified
   * against the live table: the reported team had a 4-member assessment from that session). The
   * page just never asked, because this query waited for `hasRun`, which is component state and
   * resets on unmount. Circular: it could not discover that an assessment existed until the user
   * clicked the button that exists only because it did not know.
   *
   * Un-gating is cheap and cannot bill. This is a READ; the only billable route is `analyze`,
   * still an explicit executive action behind a ten-minute cooldown. The audience conditions stay
   *, they mirror what the service enforces, so this never fires a request it knows is a 403.
   */
  const analysisQuery = trpc.rating.analysis.useQuery(
    { teamId },
    { enabled: isExecutive && membership === "member" }
  );

  /**
   * THE PROMPTS BEHIND THE ASSESSMENT, for the disclosure beside the Analyze button.
   *
   * Gated identically to `analysisQuery` and for the same reason: the service admits EXECUTIVE and
   * a member of this team, so anyone else would fire a request it already knows is a 403.
   *
   * ⚠ CANNOT BILL. It serves two constants, no Bedrock call, no cooldown, no generation lease -
   * which is what makes it a plain read on this page rather than something behind the button.
   * `staleTime: Infinity` because a prompt only changes when the service is redeployed, so
   * refetching it on every window focus is pure noise.
   */
  const promptsQuery = trpc.rating.prompts.useQuery(
    { teamId },
    { enabled: isExecutive && membership === "member", staleTime: Infinity }
  );

  /**
   * A STORED ASSESSMENT OPENS THE DASHBOARD, so returning to the page shows what was generated
   * rather than an invitation to generate it again.
   *
   * ONE-WAY, deliberately: an existing snapshot sets the flag and nothing clears it. A refetch
   * that momentarily returns nothing must not throw the reader back to the pre-run screen
   * mid-sentence.
   *
   * This only affects the AI ASSESSMENT, which is stored server-side. The usage analytics below
   * are still computed in the browser from four queries and still wait for the button, correct,
   * because nothing about them is persisted, so there is nothing to come back to.
   */
  const hasStoredAssessment = (analysisQuery.data?.members?.length ?? 0) > 0;
  useEffect(() => {
    if (hasStoredAssessment) setHasRun(true);
  }, [hasStoredAssessment]);

  /**
   * "No analysis run yet" FLASHED FOR A SECOND OR TWO before the stored assessment appeared.
   *
   * Un-gating `analysisQuery` fixed the page never DISCOVERING a stored assessment; it did not
   * fix the ORDER in which the discovery is rendered. The flag above is set in an effect, and an
   * effect by definition runs after a paint, so the sequence an executive actually saw on every
   * visit was: pre-run screen with a "Generate insights" button, then the spinner, then their
   * existing assessment. Long enough to click the button and pay for a regeneration of something
   * that already existed.
   *
   * So the pre-run screen now waits for the query to SETTLE rather than for the effect to run.
   * `isPending` is true while in flight and, importantly, ALSO true while the query is disabled -
   * which is the correct answer for a participant or a non-member, who will never fetch it: they
   * would otherwise be held on a spinner for ever. Hence the `enabled` conditions are repeated
   * here; when the query cannot run, the pre-run screen is shown immediately as before.
   *
   * This decides only whether to render an INVITATION TO GENERATE while the answer is unknown.
   * It grants no data and bypasses no gate, every branch below still asks the service.
   */
  const analysisMayExist = isExecutive && membership === "member";
  const stillDiscoveringAssessment = analysisMayExist && analysisQuery.isPending;

  /**
   * WAS A CONTENT READ REFUSED BY RULE, asked directly rather than via `teamContentGate`
   * below, because this decides whether to FETCH and the gate decides which SENTENCE to render.
   *
   * It exists for one disagreement: if the roster says the viewer is a member but the service
   * refuses their content reads (a rolling deploy, a membership removed mid-session), the
   * summary they may still be entitled to has to be fetched or the fallback page below would
   * sit on a loading state forever.
   */
  const contentRefused = [threadsQuery, tasksQuery, messagesQuery].some((q) =>
    isForbidden(q.error)
  );

  /**
   * The PUBLISHED team summary, the only rating route a non-member can reach, and everything
   * a judge or an off-team executive is entitled to.
   */
  const summaryQuery = trpc.rating.summary.useQuery(
    { teamId },
    { enabled: membership === "non-member" || contentRefused }
  );

  /**
   * WHETHER THE BUTTON SHOWS "Refreshing…", and it must watch every query `refreshAnalysis`
   * refetches, otherwise a press that fires six requests while watching four leaves the button
   * reading "Refresh" with work still in flight, which is the other half of "it did nothing": no
   * acknowledgement that the click landed.
   *
   * DECLARED HERE, not beside `refreshAnalysis` above, and the compiler insisted: this expression is
   * evaluated during render, so it cannot reference queries declared further down (TS2448 -
   * block-scoped variable used before its declaration). The refetch function itself is fine up
   * there because its body runs on click, long after every declaration.
   */
  const refreshing =
    hasRun &&
    (teamQuery.isFetching ||
      threadsQuery.isFetching ||
      tasksQuery.isFetching ||
      messagesQuery.isFetching ||
      analysisQuery.isFetching ||
      summaryQuery.isFetching);

  /**
   * NOW, read once after mount rather than during render.
   *
   * This is a client component, so React evaluates it twice, once in the server prerender and
   * once at hydration, and a `Date.now()` in the render body produces two different values,
   * which React reports as a hydration mismatch. Null until mounted, and every consumer treats
   * null as "age not established" rather than as zero. Same discipline, for the same reason, as
   * formatInstantUtc's fixed timezone.
   */
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  // ── Publishing the summary, a DISCLOSURE, not a save ───────────────────────────
  //
  // Held in the PAGE's state and rendered inside the ratings card, which never unmounts for a
  // member, so the outcome notice outlives the button that produced it. Same reasoning as
  // ActionOutcome's placement note.

  const [pendingPublish, setPendingPublish] = useState<{
    generationId: string;
    memberCount: number;
    generatedAt: string | null;
  } | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishOutcome, setPublishOutcome] = useState<ActionOutcomeState | null>(
    null
  );
  /**
   * WHICH generation the open dialog is publishing, read by the callbacks to correlate an
   * answer against the request that is current.
   *
   * A ref rather than state for the same reason the team page's is: the callbacks fire in the
   * same batch that closes the dialog, so no re-render carries a new value down first. Two
   * publishes CAN overlap, dismissing a pending dialog and reopening it is a supported
   * interaction, and an earlier answer must not release the guard on a later request.
   */
  const currentPublishRef = useRef<string | null>(null);
  /**
   * "IS THE TRIGGER ABOUT TO BE DESTROYED?", read by the dialog's unmount cleanup.
   *
   * It is, on success: the Publish button is replaced by the "Published." sentence, so
   * returning focus to it would drop a keyboard operator onto <body> in the middle of a
   * disclosure they just made. A REF, not state, because the cleanup runs in the same batch
   * that closes the dialog and no re-render carries a new prop value down first, exactly the
   * timing the `returnToFallback` prop documents.
   */
  const publishSucceededRef = useRef(false);

  const utils = trpc.useUtils();
  const publishSummary = trpc.rating.publish.useMutation({
    onSuccess: (_result, variables) => {
      if (!variables) return;
      const isCurrent = variables.generationId === currentPublishRef.current;
      // Set BEFORE the dialog closes, so the cleanup that reads it sees the new value.
      if (isCurrent) publishSucceededRef.current = true;
      setPublishOutcome({
        kind: "confirmed",
        message:
          "The team summary is now readable by judges and executives outside this team. Per-member scores, strengths and suggestions were not published.",
      });
      if (isCurrent) setPendingPublish(null);
      // Unconditional: the snapshot really is published regardless of which request answered,
      // so the analysis this card renders is stale either way and must be refetched to show it.
      void utils.rating.analysis.invalidate({ teamId });
    },
    onError: (err, variables) => {
      if (!variables) return;
      const isCurrent = variables.generationId === currentPublishRef.current;
      setPublishOutcome({
        kind: "failed",
        // The service's OWN refusal, which names the rule that fired, GENERATION_SUPERSEDED
        // ("that analysis is no longer the current one") is specific enough to act on and a
        // generic "failed" would send the operator to the wrong remedy.
        message:
          err.message ||
          "The summary was not published and is still visible only to this team. Try again, and reload the page if it keeps failing.",
      });
      if (isCurrent) setPendingPublish(null);
    },
    onSettled: (_data, _err, variables) => {
      if (!variables) return;
      if (variables.generationId === currentPublishRef.current) {
        setPublishing(null);
        currentPublishRef.current = null;
      }
    },
  });

  const analyzeRatings = trpc.rating.analyze.useMutation({
    onSuccess: () => analysisQuery.refetch(),
  });

  const isLoading =
    teamLoading || threadsLoading || tasksLoading || messagesLoading;

  // Compute metrics
  const { memberMetrics, overviewStats, topicBreakdown } = useMemo(() => {
    if (!team || !threads || !tasks || !messagesData) {
      return { memberMetrics: [], overviewStats: null, topicBreakdown: [] };
    }

    const members = team.members;
    const teamMessages = messagesData.messages;

    // Build per-member data
    const metrics: MemberMetrics[] = members.map((member) => {
      const userId = member.user?.id ?? member.userId;

      // AI sessions created by this member
      const memberThreads = threads.filter(
        (t) => (t.createdBy?.id || t.createdById) === userId
      );

      // We only have the last message per thread from getThreads,
      // so count threads as sessions
      const aiSessions = memberThreads.length;

      // Since we don't have full message counts per thread from getThreads,
      // we estimate: each thread the user created means they sent at least 1 message per thread
      // We'll use a heuristic: threads * estimated messages
      const aiMessagesSent = aiSessions; // minimum 1 per session they started

      const avgMessagesPerSession =
        aiSessions > 0 ? aiMessagesSent / aiSessions : 0;

      /**
       * Tasks. ⚠ THE `t.assignee?.id ||` HALF OF THIS TEST WAS DEAD and has been dropped: the
       * tasks route returns the entity plus resolved NAMES (`assigneeName`, `creatorName`), there
       * is no nested `assignee` object anywhere in that response, so the first operand was always
       * undefined and `assigneeId` has always been what matched. Typing `task.list` is what made
       * that visible.
       */
      const memberTasks = tasks.filter((t) => t.assigneeId === userId);
      const tasksCompleted = memberTasks.filter(
        (t) => t.status === "DONE"
      ).length;
      const tasksTotal = memberTasks.length;

      // Team messages sent
      const memberTeamMessages = teamMessages.filter(
        (m) => (m.sender?.id || m.userId) === userId
      ).length;

      // Compute AI Usage Score (0-100)
      // Weights: AI sessions (30%), task completion (25%), team engagement (20%), session depth (25%)
      const maxSessions = Math.max(
        ...members.map(
          (m) =>
            threads.filter((t) => (t.createdBy?.id || t.createdById) === (m.user?.id ?? m.userId))
              .length
        ),
        1
      );
      const maxTeamMsgs = Math.max(
        ...members.map(
          (m) =>
            teamMessages.filter(
              (msg) => (msg.sender?.id || msg.userId) === (m.user?.id ?? m.userId)
            ).length
        ),
        1
      );

      const sessionScore = Math.min((aiSessions / maxSessions) * 100, 100);
      const taskScore =
        tasksTotal > 0 ? (tasksCompleted / tasksTotal) * 100 : 0;
      const teamEngagementScore = Math.min(
        (memberTeamMessages / maxTeamMsgs) * 100,
        100
      );
      const depthScore = Math.min(avgMessagesPerSession * 20, 100);

      const aiUsageScore = Math.round(
        sessionScore * 0.3 +
          taskScore * 0.25 +
          teamEngagementScore * 0.2 +
          depthScore * 0.25
      );

      // Extract topics from threads this member started
      const topics = memberThreads
        .map((t) => t.title || "General conversation")
        .slice(0, 3);

      return {
        id: userId,
        name: member.user?.name ?? "Unknown",
        role: member.role,
        aiSessions,
        aiMessagesSent,
        avgMessagesPerSession,
        tasksCompleted,
        tasksTotal,
        teamMessages: memberTeamMessages,
        aiUsageScore,
        engagementLevel: computeEngagementLevel(aiUsageScore),
        topTopics: topics,
      };
    });

    // Overview stats
    const totalAIConversations = threads.length;
    const totalAIMessages = threads.length; // approximation from available data
    const avgMessagesPerMember =
      members.length > 0 ? totalAIConversations / members.length : 0;
    const completedTasks = tasks.filter((t) => t.status === "DONE").length;
    const completionRate =
      tasks.length > 0
        ? Math.round((completedTasks / tasks.length) * 100)
        : 0;

    const overviewStats = {
      totalAIConversations,
      totalAIMessages,
      avgMessagesPerMember,
      completionRate,
      completedTasks,
      totalTasks: tasks.length,
      /**
       * ⚠ THIS TILE REPORTED "0 of 0" TO EVERY READER, ALWAYS. It read `team.teamPhases`, which
       * `team.getById` returned as a hardcoded `[]`, so the one figure on this page that describes
       * the workshop's own structure asserted that the team had completed nothing, on a screen
       * executives read. The procedure now returns the workshop's phases with a status derived from
       * `currentPhaseOrder` (see `lib/phase-status.ts`), and the field is named `phases` because
       * per-team phase status was never a thing that existed.
       *
       * COMPLETED means "the facilitator has moved the workshop past this phase", it is a fact
       * about the workshop's progress, shared by every team in it, not a measure of this team's
       * output. The tile's label must not imply otherwise.
       */
      phasesCompleted: team.phases.filter((tp) => tp.status === "COMPLETED").length,
      totalPhases: team.phases.length,
    };

    // Topic breakdown
    const topicCounts: Record<string, number> = {};
    threads.forEach((t) => {
      const topic = t.title || "Untitled session";
      const key = extractTopic(topic);
      topicCounts[key] = (topicCounts[key] || 0) + 1;
    });
    const topicBreakdown = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    return { memberMetrics: metrics, overviewStats, topicBreakdown };
  }, [team, threads, tasks, messagesData]);

  const recommendations = useMemo(
    () => generateRecommendations(memberMetrics),
    [memberMetrics]
  );

  /**
   * WHO EACH ASSESSMENT IS ABOUT. `rating.analysis` carries userIds only, the model is never
   * given a name, so the roster is the only place a name can come from.
   *
   * Built from `team.members` rather than from `memberMetrics`, which is empty until an
   * analysis has been run: the coaching cards must be readable without running the heuristic
   * dashboard at all.
   */
  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of team?.members ?? []) {
      const id = m.user?.id ?? m.userId;
      if (id) map.set(id, m.user?.name || m.userId);
    }
    return map;
  }, [team]);

  /**
   * A NON-MEMBER'S WHOLE PAGE, the published team summary, and nothing per-member.
   *
   * ── WHY THIS IS FIRST, AHEAD OF THE PRE-RUN SCREEN AND EVERY GATE BELOW ──
   * A judge, or an executive who is not on this team, is entitled to the summary the team
   * PUBLISHED and to nothing else. Everything below this line is either member-only content or
   * an offer to compute it, so reaching any of it would produce refused requests and then a
   * wall. Previously that wall was where they stopped: <MemberOnlyNotice> told them accurately
   * that per-member insights belong to the team, and left them with no route to the deliverable
   * they are on the platform to assess.
   *
   * The audience rule this implements: members (INCLUDING an
   * executive who is a member) see per-member coaching and the summary; judges and off-team
   * executives see the published summary only, never a score, never a name, never a rationale.
   * It is enforced by the SERVICE, twice over: `rating.analysis` 403s a non-member, and
   * `rating.summary`'s response shape simply has no per-member fields in it.
   */
  if (membership === "non-member") {
    return (
      <PublishedTeamSummary
        data={summaryQuery.data}
        loading={summaryQuery.isLoading}
        // A failed READ, kept distinct from `notPublished`, which is an ordinary answer and
        // must never render as a fault. See the component's three-state note.
        loadError={summaryQuery.error?.message ?? null}
        sessionExpired={isUnauthorized(summaryQuery.error)}
        onRetryLoad={() => summaryQuery.refetch()}
        teamHref={teamTabHref(workshopId, teamId)}
        now={nowMs}
      />
    );
  }

  /**
   * MEMBERSHIP NOT YET ESTABLISHED, wait, rather than pick a page and be wrong.
   *
   * Reached while the session or the roster is still in flight. It resolves in one round trip
   * (the layout has already asked), and both alternatives are worse than a moment's wait: the
   * member dashboard would 403 for a judge, and the judge's page would tell a member their own
   * team's coaching does not exist.
   *
   * A FAILED roster read deliberately falls THROUGH rather than waiting here. Membership is
   * then unknowable, and the honest behaviour is the one this page had before, offer the
   * analysis, and let the gate below report whatever the content queries actually answer.
   * Blocking instead would replace a legible failure with a spinner that never stops.
   */
  if (membership === "unknown" && !teamQuery.error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-ink-subtle">Checking your access to this team…</p>
      </div>
    );
  }

  /**
   * BEFORE THE FIRST RUN. Rendered ahead of every gate below, because those gates all
   * interrogate queries that have deliberately not run yet: `gate.state` would read as
   * "failed" or "member-only" from three idle queries, and `!overviewStats` would report "No
   * data available yet", a sentence that sounds like a fact about the team when it is only
   * a fact about a button nobody has pressed.
   *
   * The methodology icon is available HERE too, on purpose: someone deciding whether to run
   * an analysis should be able to read what it computes first.
   */
  if (!hasRun && stillDiscoveringAssessment) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-brand border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-sm text-ink-subtle">Looking for an existing analysis…</p>
        </div>
      </div>
    );
  }

  if (!hasRun) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-6xl mx-auto px-6 py-6">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-ink">Praimana Insights</h2>
            <InsightsMethodology />
          </div>
          <p className="text-sm text-ink-subtle mt-0.5">
            Usage analytics and engagement metrics for this team
          </p>

          <div className="mt-8 rounded-xl border border-dashed bg-surface-1/50 p-8 text-center">
            <p className="text-2xl" aria-hidden="true">
              📊
            </p>
            <h3 className="mt-2 font-semibold text-ink-muted">No analysis run yet</h3>
            <p className="w-full mx-auto mt-1 max-w-md text-sm text-ink-subtle leading-relaxed">
              Building these metrics reads this team&apos;s AI conversations, board tasks and
              chat history, so it runs when you ask rather than on every visit.
            </p>
            <button
              type="button"
              onClick={() => setHasRun(true)}
              className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover transition-colors"
            >
              Generate insights
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-brand border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-sm text-ink-subtle">Analyzing team data...</p>
        </div>
      </div>
    );
  }

  /**
   * NOTHING TO SHOW, AND WHY. Four of this page's five queries become member-only,
   * threads, tasks, messages and the ratings analysis, so a facilitator, judge or
   * admin who is not on this team gets 403 from each.
   *
   * ── WHICH QUERIES GATE THE PAGE, AND WHICH DELIBERATELY DO NOT ──
   * The three the metrics are computed FROM: threads, tasks and messages. Those three are one
   * rule with one answer, they are the team's authored content, they become member-only
   * together, and nothing on this page survives losing them.
   *
   * NOT `team.getById`, which stays on the administration predicate and keeps answering. Gating
   * on it would render the whole dashboard for a non-member with every metric derived from
   * nothing.
   *
   * NOT `rating.analysis` either, and that exclusion is the load-bearing one. A page-level gate
   * states "you are not a member of this team" as a fact, so any query that can 403 for a
   * reason OTHER than membership must stay out of it, one divergent service (a rolling deploy
   * where the ratings Lambda has a rule the others do not, an expired Bedrock permission) would
   * otherwise tell an actual member they are not on their own team and hide four working
   * sections behind it. Being wrong in that direction is invisible to us and infuriating to
   * them. So a ratings failure degrades its own card instead, see the `loadError` prop.
   *
   * ── AND WHY THIS MUST PRECEDE THE `!overviewStats` BRANCH BELOW ──
   * This page is the worst offender of the six. Every number on it is COMPUTED from those
   * queries, and the useMemo above returns zeroed metrics when any of them is missing, so a
   * 403 previously rendered "No data available yet.", or worse, a full dashboard of 0s, 0%
   * completion and "Low" engagement badges against real member names. That is not an empty
   * state; it is a fabricated performance review of six people, and someone could act on it.
   * Both branches below run before any of it can render.
   */
  const gate = teamContentGate([threadsQuery, tasksQuery, messagesQuery]);
  // SESSION EXPIRED outranks both branches below: a 401 means the server could not
  // evaluate any rule, so "member-only" would be a lie and "failed" blames the data.
  // Providers() is already signing out; this is what renders during that round trip.
  if (gate.state === "expired") {
    return <SessionExpiredNotice what="this team's insights" />;
  }
  if (gate.state === "member-only") {
    /**
     * THE SERVICE SAYS NON-MEMBER AND THE ROSTER DID NOT, a disagreement, not a contradiction
     * to hide.
     *
     * Reachable two ways: the roster read failed (so membership fell through as unknown), or
     * membership was withdrawn between that read and these three. Either way the SERVICE is the
     * authority on what may be read, and it has answered. So the viewer gets exactly what a
     * non-member gets, the published summary, or a calm "not published yet", rather than a
     * wall. The audience rule is the same one; only the route to discovering it differed.
     */
    return (
      <PublishedTeamSummary
        data={summaryQuery.data}
        loading={summaryQuery.isLoading}
        loadError={summaryQuery.error?.message ?? null}
        sessionExpired={isUnauthorized(summaryQuery.error)}
        onRetryLoad={() => summaryQuery.refetch()}
        teamHref={teamTabHref(workshopId, teamId)}
        now={nowMs}
      />
    );
  }
  if (gate.state === "failed") {
    return (
      <ContentLoadError
        what="this team's insights"
        detail={gate.detail}
        onRetry={gate.retry}
      />
    );
  }

  if (!overviewStats) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-ink-subtle">No data available yet.</p>
      </div>
    );
  }

  const analysis = analysisQuery.data;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Header: title + methodology, with the run/refresh control on the right. */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-ink">
                Praimana Insights
              </h2>
              {/* The scores below RANK PEOPLE, so how they are produced is published next to
                  them rather than buried in a doc. See InsightsMethodology. */}
              <InsightsMethodology />
            </div>
            {/**
             * NO TIMESTAMP ON THIS LINE, and the history is worth recording because I got it wrong
             * three times before arriving here.
             *
             *   1. `dataUpdatedAt` labelled "· updated", read as "the analysis re-ran on load".
             *   2. The same value labelled "· figures read", still a clock beside the word
             *      Insights, so still read as "something was produced just now". Both were doomed:
             *      `staleTime` is 0 and `refetchOnMount` refetches anything stale, so that value is
             *      ALWAYS a few milliseconds old and can only ever say "now".
             *   3. The ASSESSMENT's `generatedAt`, which was reported twice over, it never moved
             *      when Refresh was pressed, and it duplicated the timestamp on the assessment card
             *      below. Both complaints were the same mistake: I put a fact about the MODEL RUN
             *      in the header of the USAGE METRICS section, beside a button that refetches
             *      metrics. It could not move, because Refresh does not re-run the model, and the
             *      one place it belongs already showed it.
             *
             * THE HEADING IS FOR THE METRICS, so the only timestamp it could honestly carry is the
             * fetch time, which is the useless value from (1) and (2). It therefore carries none,
             * and the two sections each date themselves:
             *
             *   · these metrics are recomputed from live queries on every visit and on Refresh, so
             *     "how old are they" is answered by the Refreshing… state, not by a clock;
             *   · the model assessment carries its own `generatedAt`, on its own card, next to the
             *     Generate button that is the only thing which moves it.
             *
             * One timestamp on the page, beside the coaching it dates and the control that changes
             * it.
             */}
            <p className="text-sm text-ink-subtle mt-0.5">
              Usage analytics and engagement metrics for this team
            </p>
          </div>
          <button
            type="button"
            onClick={refreshAnalysis}
            disabled={refreshing}
            className="shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-surface-1 disabled:opacity-50 transition-colors"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {/* Overview Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="AI Conversations"
            value={overviewStats.totalAIConversations}
            icon="🤖"
            sub={`${overviewStats.avgMessagesPerMember.toFixed(1)} avg/member`}
          />
          <StatCard
            label="Tasks Completed"
            value={overviewStats.completedTasks}
            icon="✅"
            sub={`${overviewStats.completionRate}% completion rate`}
          />
          <StatCard
            label="Team Messages"
            value={messagesData?.messages.length ?? 0}
            icon="💬"
            sub="collaboration signals"
          />
          {/* ⚠ "PASSED", NOT "COMPLETED", AND `workshop-wide` IS LOAD-BEARING. This tile read
              "Phases Completed · of 0 total" and was always 0 because the data behind it was a
              hardcoded empty array. Now that it shows a real number, the old label would actively
              mislead: a phase counts as passed when the FACILITATOR moves the workshop beyond it,
              which is the same for every team in the workshop and says nothing about what THIS team
              produced. Sitting unqualified among per-team metrics, "Phases Completed" reads as this
              team's achievement, so the label states whose progress it is. */}
          <StatCard
            label="Phases Passed"
            value={overviewStats.phasesCompleted}
            icon="🎯"
            sub={`of ${overviewStats.totalPhases} · workshop-wide`}
          />
        </div>

        {/*
          ── ⚠ TOKEN USAGE, DELIBERATELY ABOVE THE ASSESSMENT AND VISUALLY APART ────────────────
          Efficiency data, not a judgement, it renders nothing at all when nothing
          reported counts, which on this page is the difference between "we measured nothing" and a confident
          "0 tokens" in front of an executive.

          ⚠ ITS OWN SECTION, NOT A CARD INSIDE THE COACHING BLOCK. Sitting inside a model-written assessment of
          named people, a token figure reads AS part of that assessment, which is the misreading Decision 1
          exists to prevent.
        */}
        <div className="mb-6">
          <TokenUsagePanel
            threads={tokenUsageQuery.data?.threads ?? []}
            truncated={tokenUsageQuery.data?.truncated}
            totalThreads={tokenUsageQuery.data?.totalThreads}
            nameByUserId={nameByUserId}
          />
        </div>

        {/* Model-generated per-member coaching + the publishable team summary. */}
        <MemberCoachingSection
          data={analysis}
          nameByUserId={nameByUserId}
          /**
           * WHETHER THE ROSTER IS KNOWN AT ALL, which is a different fact from "this userId is
           * not on it" and must not be collapsed into one.
           *
           * Names come from the roster, so a FAILED roster read leaves every lookup empty, and
           * without this flag every card would read "No longer on this team", telling a member
           * their whole team had left. Reachable: `team.getById` failing while the three content
           * queries succeed is exactly the case the membership fall-through above allows.
           */
          rosterKnown={!!team}
          loading={analysisQuery.isLoading}
          analyzing={analyzeRatings.isPending}
          onAnalyze={() => analyzeRatings.mutate({ teamId })}
          error={analyzeRatings.error?.message ?? null}
          // Deliberately kept OUT of the page-level gate (see the note above), so its failure
          // has to be reported here or it is reported nowhere: an empty coaching list is what
          // the section would otherwise show when the READ fails, which invites an operator to
          // spend a Bedrock analysis re-generating an assessment that already exists and
          // simply did not arrive.
          loadError={analysisQuery.error?.message ?? null}
          sessionExpired={isUnauthorized(analysisQuery.error)}
          onRetryLoad={() => analysisQuery.refetch()}
          /**
           * ⚠ INVERTED FROM `!readOnly`, and that is the whole change.
           *
           * Generating and publishing an assessment are EXECUTIVE actions by
           * rule, so the two controls are shown to exactly the role that every other write
           * control is hidden from. `readOnly` is true for EXECUTIVE and only EXECUTIVE, so it
           * doubles as "is an executive" here, but it is read through a named value rather
           * than used raw, because `canAnalyze={readOnly}` reads like a bug at a glance.
           *
           * Membership is NOT checked here: the roster is loaded on this page, but the service
           * is the boundary and it refuses a non-member executive with NOT_A_TEAM_MEMBER.
           * Duplicating that decision in the UI would be a second place for it to drift.
           */
          canAnalyze={isExecutive}
          canPublish={isExecutive}
          /**
           * The prompt disclosure travels with `canAnalyze`, it describes what that button is
           * about to send, so it appears for exactly the role that can press it. The service
           * refuses everyone else regardless; this keeps the UI from offering a control whose
           * request it knows would 403.
           */
          prompts={promptsQuery.data?.prompts ?? []}
          promptsLoading={promptsQuery.isLoading}
          promptsError={promptsQuery.error?.message ?? null}
          publishOutcome={publishOutcome}
          onDismissPublishOutcome={() => setPublishOutcome(null)}
          onRequestPublish={() => {
            if (!analysis?.generationId) return;
            // Reset ON OPEN, not on close: open is the only moment unambiguously before the
            // next request, where a reset on close would race the cleanup that reads it.
            publishSucceededRef.current = false;
            setPendingPublish({
              generationId: analysis.generationId,
              memberCount: analysis.members.length,
              generatedAt: analysis.generatedAt,
            });
          }}
          publishPending={publishing !== null}
        />

        {/* Per-Member Analysis Table */}
        <div className="bg-surface-3 rounded-xl border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b bg-surface-1/50">
            <h3 className="font-semibold text-sm text-ink-muted">
              Member Analysis
            </h3>
            <p className="text-xs text-ink-subtle mt-0.5">
              Heuristic AI usage and engagement breakdown
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-surface-1/30">
                  <th className="text-left px-5 py-3 font-medium text-ink-subtle">
                    Member
                  </th>
                  <th className="text-left px-3 py-3 font-medium text-ink-subtle">
                    Role
                  </th>
                  <th className="text-center px-3 py-3 font-medium text-ink-subtle">
                    AI Sessions
                  </th>
                  <th className="text-center px-3 py-3 font-medium text-ink-subtle">
                    Tasks Done
                  </th>
                  <th className="text-center px-3 py-3 font-medium text-ink-subtle">
                    Team Msgs
                  </th>
                  <th className="text-center px-3 py-3 font-medium text-ink-subtle">
                    AI Score
                  </th>
                  <th className="text-center px-3 py-3 font-medium text-ink-subtle">
                    Engagement
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* ALPHABETICAL, not by score. Ranking by score made this a leaderboard with
                    a named person at the bottom, which is what the coaching cards were already
                    de-ranked to avoid. `[...]` because `.sort()` mutates, and memberMetrics is
                    a memoised array other derivations read. */}
                {[...memberMetrics]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((member) => (
                    <tr
                      key={member.id}
                      className="border-b last:border-b-0 hover:bg-surface-1/50 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-brand-subtle flex items-center justify-center text-xs font-semibold text-brand-text">
                            {member.name[0]}
                          </div>
                          <span className="font-medium text-ink-muted">
                            {member.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-xs bg-surface-2 text-ink-subtle px-2 py-0.5 rounded-full">
                          {member.role}
                        </span>
                      </td>
                      <td className="text-center px-3 py-3 text-ink-muted">
                        {member.aiSessions}
                      </td>
                      <td className="text-center px-3 py-3 text-ink-muted">
                        {member.tasksCompleted}/{member.tasksTotal}
                      </td>
                      <td className="text-center px-3 py-3 text-ink-muted">
                        {member.teamMessages}
                      </td>
                      <td className="text-center px-3 py-3">
                        <ScoreBadge score={member.aiUsageScore} />
                      </td>
                      <td className="text-center px-3 py-3">
                        <span
                          className={`inline-block text-xs font-medium px-2.5 py-1 rounded-full border ${engagementColor(
                            member.engagementLevel
                          )}`}
                        >
                          {member.engagementLevel}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Two-column layout: Topics + Recommendations */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* AI Usage Patterns */}
          <div className="bg-surface-3 rounded-xl border shadow-sm">
            <div className="px-5 py-4 border-b bg-surface-1/50">
              <h3 className="font-semibold text-sm text-ink-muted">
                AI Conversation Topics
              </h3>
              <p className="text-xs text-ink-subtle mt-0.5">
                What the team is asking AI about
              </p>
            </div>
            <div className="p-5 space-y-3">
              {topicBreakdown.length === 0 ? (
                <p className="text-sm text-ink-tertiary text-center py-4">
                  No conversations yet
                </p>
              ) : (
                topicBreakdown.map(([topic, count], i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-ink-muted truncate pr-2">
                          {topic}
                        </span>
                        <span className="text-xs text-ink-tertiary flex-shrink-0">
                          {count}x
                        </span>
                      </div>
                      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-brand rounded-full transition-all"
                          style={{
                            width: `${Math.min(
                              (count / (topicBreakdown[0]?.[1] ?? 1)) * 100,
                              100
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Recommendations */}
          <div className="bg-surface-3 rounded-xl border shadow-sm">
            <div className="px-5 py-4 border-b bg-surface-1/50">
              <h3 className="font-semibold text-sm text-ink-muted">
                Recommendations
              </h3>
              <p className="text-xs text-ink-subtle mt-0.5">
                Auto-generated coaching suggestions
              </p>
            </div>
            <div className="p-5 space-y-3">
              {recommendations.length === 0 ? (
                <p className="text-sm text-ink-tertiary text-center py-4">
                  More data needed for recommendations
                </p>
              ) : (
                recommendations.map((rec, i) => (
                  <div
                    key={i}
                    className="flex gap-3 p-3 rounded-lg bg-warn-bg border border-warn-border/50"
                  >
                    <span className="text-warn-text flex-shrink-0 mt-0.5">
                      💡
                    </span>
                    <p className="text-sm text-ink-muted leading-relaxed">
                      {rec}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Per-member topic details */}
        {memberMetrics.some((m) => m.topTopics.length > 0) && (
          <div className="bg-surface-3 rounded-xl border shadow-sm">
            <div className="px-5 py-4 border-b bg-surface-1/50">
              <h3 className="font-semibold text-sm text-ink-muted">
                Individual AI Focus Areas
              </h3>
              <p className="text-xs text-ink-subtle mt-0.5">
                What each member is using AI for
              </p>
            </div>
            <div className="p-5 grid md:grid-cols-2 gap-4">
              {memberMetrics
                .filter((m) => m.topTopics.length > 0)
                .map((member) => (
                  <div
                    key={member.id}
                    className="p-3 rounded-lg border bg-surface-1/50"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-brand-subtle flex items-center justify-center text-[10px] font-semibold text-brand-text">
                        {member.name[0]}
                      </div>
                      <span className="text-sm font-medium text-ink-muted">
                        {member.name}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {member.topTopics.map((topic, i) => (
                        <div
                          key={i}
                          className="text-xs text-ink-subtle flex items-start gap-1.5"
                        >
                          <span className="text-ink-tertiary mt-px">-</span>
                          <span className="truncate">{topic}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/**
        * THE PUBLISH CONFIRMATION.
        *
        * Rendered at the END of the page and OUTSIDE the scrolling content, away from the
        * high-frequency Refresh and Analyze controls: publishing is the one action here that
        * discloses something outside the team, and it must never sit adjacent to a control an
        * operator presses repeatedly.
        *
        * FRICTION SCALED TO CONSEQUENCE. It is not catastrophic, no data is destroyed and the
        * published text is the aggregate summary, never a per-member score, so it is an
        * explicit confirm naming the exact blast radius with real values, not a typed
        * confirmation. It IS irreversible (the service has no unpublish route), which is why
        * the tone is destructive and the reversibility line says so plainly.
        */}
      {pendingPublish && (
        <ConfirmActionDialog
          title="Publish this team summary outside the team?"
          target={
            <>
              {team?.name ?? "This team"}: the team-level summary generated{" "}
              {formatInstantUtc(pendingPublish.generatedAt) || "at an unknown time"}
            </>
          }
          consequences={[
            "Judges, and executives who are not on this team, will be able to read the team-level summary.",
            <>
              The per-member assessments stay within the team. Scores, rationales, strengths and
              suggestions for all{" "}
              <span className="tabular-nums">{pendingPublish.memberCount}</span>{" "}
              {pendingPublish.memberCount === 1 ? "person" : "people"} are NOT published and are
              not included in what those readers see.
            </>,
            "The summary was written from team-wide totals only, so it contains no per-person figures and names nobody.",
          ]}
          reversibility="Publishing cannot be undone from here; there is no unpublish action. Re-running the analysis creates a new, unpublished snapshot; it does not withdraw this one."
          confirmLabel="Publish summary"
          pendingLabel="Publishing…"
          tone="destructive"
          pending={publishing === pendingPublish.generationId}
          // NO `reasonHint`, so no reason field is rendered. The publish route accepts only a
          // generationId and records no note, and a textarea whose contents are silently
          // discarded is worse than none: an operator who explains a disclosure believes they
          // have left a record and has not. See the prop's own note.
          onConfirm={() => {
            currentPublishRef.current = pendingPublish.generationId;
            setPublishing(pendingPublish.generationId);
            setPublishOutcome(null);
            publishSummary.mutate({
              teamId,
              generationId: pendingPublish.generationId,
            });
          }}
          onDismiss={(wasPending) => {
            if (wasPending) {
              /**
               * THE FOURTH STATE. The request was sent, no answer was seen, and nothing here
               * cancels it, `backendFetch` passes no AbortSignal. "Reload", not "try again":
               * a second publish of a superseded generation answers 409 and would read as a
               * failure to disclose something that may already be disclosed.
               */
              setPublishOutcome({
                kind: "unknown",
                message:
                  "The request to publish this summary was sent but the result was never seen. Reload the page to check whether it is published before trying again.",
              });
            }
            setPendingPublish(null);
          }}
          /**
           * ON SUCCESS THE TRIGGER IS DOOMED: the Publish button is replaced by the
           * "Published." sentence, so `.focus()` on it lands nowhere and a keyboard operator
           * is dropped onto <body> immediately after making a disclosure. Read at cleanup
           * time from a ref the mutation callback has already set, see the prop's note on why
           * a boolean prop cannot work here.
           */
          returnToFallback={() => publishSucceededRef.current}
          /**
           * Where focus goes instead: the heading of the card that now states the published
           * state. It survives the publish (only the button inside it is replaced), so Tab
           * from there walks straight into the sentence that reports the outcome.
           */
          fallbackFocus={() => document.getElementById("ai-coaching-heading")}
        />
      )}
    </div>
  );
}

// --- Sub-components ---

/**
 * MODEL-GENERATED COACHING, one card per member, plus the team-level summary that is the only
 * part of it publishable outside the team.
 *
 * ── WHY THERE IS NO RANKING HERE, AND WHY THAT IS A REQUIREMENT RATHER THAN A PREFERENCE ──
 *
 * These assessments are read by the person described AND by their teammates. The previous
 * version sorted the cards by combined score, a leaderboard by construction, with the lowest
 * scorer at the bottom of a list their colleagues scroll past, and coloured each score red
 * through amber to green, so a person's card carried a traffic light. Both are gone:
 *
 *   · ORDER IS ALPHABETICAL, never by score. A stable, meaningless order is the point; any
 *     score-derived order re-states the ranking that the wording is careful to avoid.
 *   · ONE NEUTRAL TREATMENT for every score. Colour-coding a person red is the comparative
 *     judgement the design explicitly rules out, and it also removes this card's only
 *     colour-alone signal, the figure is stated in text, which is now the whole encoding.
 *
 * The service's prompt is written to the same rule ("Write about the WORK, never the person.
 * NEVER compare people to each other."), so this is the presentation half of a constraint the
 * generation half already honours.
 */
function MemberCoachingSection({
  data,
  nameByUserId,
  rosterKnown,
  loading,
  analyzing,
  onAnalyze,
  error,
  loadError,
  sessionExpired = false,
  onRetryLoad,
  canAnalyze,
  canPublish,
  prompts,
  promptsLoading,
  promptsError,
  publishOutcome,
  onDismissPublishOutcome,
  onRequestPublish,
  publishPending,
}: {
  data:
    | {
        members: MemberAssessment[];
        teamSummary: string;
        generatedAt: string | null;
        generationId: string | null;
        publishedAt: string | null;
        coverage: string[];
      }
    | undefined;
  /** userId → display name, from the roster. See the note on MemberAssessment. */
  nameByUserId: Map<string, string>;
  /** False when the roster itself could not be read, so an empty lookup means nothing. */
  rosterKnown: boolean;
  loading: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  /** A failed ANALYSIS, the operator asked for a new one and did not get it. */
  error: string | null;
  /**
   * A failed READ of the stored analysis, which is a different fact and needs a different
   * sentence: nothing was requested, and what is on screen is missing rather than absent.
   * Kept separate from `error` so a stale analysis failure and a live fetch failure cannot
   * be mistaken for each other.
   */
  loadError: string | null;
  /** True when the failure was a 401, see `PublishedTeamSummary` for why this is a flag and not a string. */
  sessionExpired?: boolean;
  onRetryLoad: () => void;
  canAnalyze: boolean;
  canPublish: boolean;
  /** The system prompts the analysis sends, served by the AI service. See RatingsPromptDisclosure. */
  prompts: DisclosedPrompt[];
  promptsLoading: boolean;
  promptsError: string | null;
  publishOutcome: ActionOutcomeState | null;
  onDismissPublishOutcome: () => void;
  onRequestPublish: () => void;
  publishPending: boolean;
}) {
  const assessments = data?.members ?? [];
  const hasData = assessments.length > 0;

  /**
   * Alphabetical by display name, see the section note above on why this must not be
   * score-ordered. `slice()` first because `sort` mutates, and this array belongs to
   * react-query's cache.
   */
  const shown = assessments
    .slice()
    .sort((a, b) =>
      (nameByUserId.get(a.userId) ?? a.userId).localeCompare(
        nameByUserId.get(b.userId) ?? b.userId
      )
    )
    .slice(0, MAX_ASSESSMENTS_SHOWN);
  const withheld = assessments.length - shown.length;

  return (
    <section
      aria-labelledby="ai-coaching-heading"
      className="bg-surface-3 rounded-xl border shadow-sm overflow-hidden"
    >
      <div className="px-5 py-4 border-b bg-surface-1/50 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The id is the publish dialog's focus fallback, see `fallbackFocus` at the call
              site. `tabIndex={-1}` makes it a legal programmatic focus target without adding it
              to the tab order, so a keyboard operator's sequential Tab walk is unchanged. */}
          <h3
            id="ai-coaching-heading"
            tabIndex={-1}
            className="font-semibold text-sm text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand rounded"
          >
            Working with an AI assistant
          </h3>
          {/* GIT COMMITS ARE NOT MENTIONED, because they are not analysed. The previous copy
              said "Bedrock analysis of AI chats, team chat & git commits"; commit analysis was
              cut, so that sentence named a source that never reaches the model, a false claim
              about the evidence behind a judgement of a person, which is the worst place to
              carry stale copy. The two sources named here are the two the service actually
              reads (see KnowledgeModelInput). */}
          <p className="text-xs text-ink-subtle mt-0.5">
            Model-generated coaching from each member&apos;s own AI conversations and team chat
            {/**
             * THE ONLY TIMESTAMP ON THIS PAGE, and the one that was confirmed correct while three
             * different values in the header were not.
             *
             * "GENERATED", NOT "UPDATED": `generatedAt` comes from the stored snapshot the model
             * produced, so it marks a real event and moves only when an executive presses Generate.
             *
             * I BRIEFLY MIRRORED IT IN THE PAGE HEADER TOO, and that was reported as a bug on sight
             *, two "generated" dates showing the same instant reads as one of them being wrong,
             * even when both are right and read the same field. Two identical timestamps in one view
             * cost a reader more than the second copy saves them. It lives here, beside the coaching
             * it dates and the Generate button that changes it, and nowhere else.
             */}
            {data?.generatedAt && (
              <> · generated {formatInstantUtc(data.generatedAt)}</>
            )}
          </p>
        </div>
        {canAnalyze && (
          /* THE DISCLOSURE SITS BESIDE THE BUTTON, not in the card body, because it describes what
             pressing it will send. Read anywhere else on this page it would look like an
             explanation of the assessments already on screen, which is a different claim, and one
             it cannot make: a stored snapshot may predate the prompt shown here. */
          <div className="flex items-center gap-2 flex-shrink-0">
            <RatingsPromptDisclosure
              prompts={prompts}
              loading={promptsLoading}
              error={promptsError}
            />
            <button
              onClick={onAnalyze}
              disabled={analyzing}
              className="text-sm bg-brand text-brand-ink px-3 py-1.5 rounded-md hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {analyzing && (
                <span className="animate-spin w-3.5 h-3.5 border-2 border-surface-3/40 border-t-brand-ink rounded-full" />
              )}
              {analyzing ? "Analyzing…" : hasData ? "Re-analyze" : "Analyze team"}
            </button>
          </div>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* The publish outcome sits at the TOP of the card body, one fixed place, above
            everything the publish action could have changed, and inside a card that never
            unmounts for a member so the notice outlives the dialog that produced it. */}
        <ActionOutcome
          outcome={publishOutcome}
          onDismiss={onDismissPublishOutcome}
        />

        {error && (
          <div
            role="alert"
            className="text-sm text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2"
          >
            {error}
          </div>
        )}

        {/* THE TEAM SUMMARY, and the disclosure control that belongs to it.
            Rendered together on purpose: publishing discloses THIS text, so the button sits
            beside the words it will publish rather than in the card header, where it would
            read as an action on the per-member cards below. */}
        {data?.teamSummary && (
          <div className="rounded-lg border border-brand-border bg-brand-subtle p-3">
            <div className="flex gap-3">
              <span aria-hidden="true" className="flex-shrink-0">
                🧭
              </span>
              <div className="min-w-0 flex-1">
                <h4 className="text-xs font-semibold text-ink-muted">
                  Team summary
                </h4>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                  {data.teamSummary}
                </p>
                <PublishState
                  publishedAt={data.publishedAt}
                  canPublish={canPublish}
                  hasGeneration={!!data.generationId}
                  onRequestPublish={onRequestPublish}
                  publishPending={publishPending}
                />
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-ink-tertiary text-center py-6">
            Loading this team&apos;s assessment…
          </p>
        ) : sessionExpired ? (
          /* An expired login, not a failed read, the same branch the AI pane was missing when this was
             reported. It goes before the generic error for the reason that one goes before `!hasData`. */
          <SessionExpiredNotice what="this team's stored AI assessment" />
        ) : loadError ? (
          /* BEFORE the !hasData branch, which is the whole point: a failed read leaves
             `assessments` empty, so without this the section claims there is no assessment and
             invites an operator to spend a Bedrock analysis regenerating one that exists and
             simply did not arrive. Scoped to this card, the rest of the page is real. */
          <ContentLoadError
            what="this team's stored AI assessment"
            detail={loadError}
            onRetry={onRetryLoad}
            // Inside a section whose own heading is an <h3>.
            headingLevel={4}
          />
        ) : !hasData ? (
          <p className="text-sm text-ink-subtle text-center py-6">
            No assessment has been generated yet.{" "}
            {canAnalyze ? (
              <>
                <span className="font-medium">Analyze team</span> reads each member&apos;s AI
                conversations and team chat, and suggests what they could try next.
              </>
            ) : (
              // The sentence you get as a PARTICIPANT. Names the role that can act, because
              // "a team member can generate one" was both wrong and unactionable, it implied
              // the reader could do it, and they cannot.
              <>An executive on this team can generate one from this page.</>
            )}
          </p>
        ) : (
          <>
            <div className="grid md:grid-cols-2 gap-4">
              {shown.map((assessment) => (
                <AssessmentCard
                  key={assessment.userId}
                  assessment={assessment}
                  name={nameByUserId.get(assessment.userId)}
                  rosterKnown={rosterKnown}
                />
              ))}
            </div>
            {withheld > 0 && (
              /* The bound DISCLOSED rather than applied silently: a list that quietly ends
                 reads as complete, and "my card is missing" is the one reading that must not
                 be produced by a display cap. */
              <p className="text-xs text-ink-subtle">
                Showing{" "}
                <span className="tabular-nums">{MAX_ASSESSMENTS_SHOWN}</span> of{" "}
                <span className="tabular-nums">{assessments.length}</span> assessments in this
                analysis.
              </p>
            )}
          </>
        )}

        {/* WHAT THE NUMBERS DO NOT CAPTURE, on the screen rather than in a comment. The
            service carries these caveats in the payload precisely because people are ranked by
            the figures above them. */}
        <RatingCoverage coverage={data?.coverage ?? []} />
      </div>
    </section>
  );
}

/**
 * WHETHER THE TEAM SUMMARY HAS BEEN DISCLOSED OUTSIDE THE TEAM, and the control that does it.
 *
 * The published state is stated in WORDS and carries its date, never a colour or an icon
 * alone. "Who can see this" is the question this line exists to answer, and it is the question
 * an operator must never have to infer from a button's presence.
 */
function PublishState({
  publishedAt,
  canPublish,
  hasGeneration,
  onRequestPublish,
  publishPending,
}: {
  publishedAt: string | null;
  canPublish: boolean;
  hasGeneration: boolean;
  onRequestPublish: () => void;
  publishPending: boolean;
}) {
  const published = formatInstantUtc(publishedAt);

  if (publishedAt) {
    return (
      // gray-700 (#374151) on indigo-50 (#eef2ff) is 9.79:1, AAA. The state is carried by the
      // SENTENCE; there is no badge, no dot and no colour doing the work.
      <p className="mt-2 text-xs text-ink-muted">
        <span className="font-medium">Published.</span> Judges and executives outside this team
        can read this summary
        {published && <>, since {published}</>}. Per-member assessments were not published.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="text-xs text-ink-muted">
        <span className="font-medium">Not published.</span> This summary is visible only to
        members of this team.
      </p>
      {canPublish && hasGeneration && (
        <button
          type="button"
          onClick={onRequestPublish}
          // Disabled while a publish is in flight, so the control cannot be re-armed from
          // under a request that has not answered.
          disabled={publishPending}
          className="mt-2 rounded-md border border-field-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-1 disabled:cursor-default disabled:text-ink-subtle focus:outline-none focus:ring-2 focus:ring-brand"
        >
          {/* The ellipsis is the convention for "this opens a confirmation", not for
              "this is happening". */}
          {publishPending ? "Publishing…" : "Publish summary…"}
        </button>
      )}
    </div>
  );
}

/**
 * One member's coaching card.
 *
 * Framed as coaching throughout, by rule: what they already do well, and what
 * to try next. "Improvements" is the service's field name; "To try next" is the operator's
 *, and their teammates', vocabulary for the same list, and it is the wording that keeps a
 * suggestion from reading as a deficiency.
 */
function AssessmentCard({
  assessment,
  name,
  rosterKnown,
}: {
  assessment: MemberAssessment;
  name: string | undefined;
  rosterKnown: boolean;
}) {
  /**
   * WHO THIS CARD IS ABOUT, and the two different reasons the answer can be missing, which
   * must not be reported with the same sentence.
   *
   * A MEMBER WHO HAS LEFT since the analysis ran has no roster row, so their name is genuinely
   * unrecoverable and "No longer on this team" is the truth. THE ROSTER FAILING TO LOAD looks
   * identical from here and is a completely different fact, reported as such, because the
   * alternative is telling a member that every single person on their team has left.
   *
   * Labelled either way rather than blanked: a card with no identity reads as corrupt data.
   * Same reading as the former-members row's "(name unknown)".
   */
  const label =
    name ?? (rosterKnown ? "No longer on this team" : "Name unavailable");

  return (
    <div className="p-4 rounded-lg border bg-surface-1/50">
      <div className="flex items-center gap-2.5 mb-3">
        <div
          aria-hidden="true"
          className="w-8 h-8 rounded-full bg-brand-subtle flex items-center justify-center text-xs font-semibold text-brand-text"
        >
          {(label || "?")[0].toUpperCase()}
        </div>
        {/* The person's name IS this card's heading, an h4 under the section's h3, so the two
            h5 lists below sit at a legal rank and a screen-reader operator can jump between
            cards. `break-words` because a display name has no guaranteed length. */}
        <h4 className="font-medium text-ink-muted min-w-0 break-words">{label}</h4>
      </div>

      <CoachingScore score={assessment.aiKnowledgeScore} />
      {assessment.rationale && (
        // gray-600 (#4b5563), 7.56:1 on white and 7.2:1 against this gray-50-at-50% surface,
        // so AAA either way. Deliberately not the gray-500 (#6b7280, 4.83:1) this card used
        // before: the rationale is the sentence a person reads about themselves and their
        // teammates read about them, which makes it the worst text on the page to de-emphasise.
        <p className="text-xs text-ink-subtle mt-1.5 leading-relaxed">
          {assessment.rationale}
        </p>
      )}

      {assessment.strengths.length > 0 && (
        <div className="mt-3">
          {/* h5, under the card's own h4 heading, which is under the section's h3. Ranked
              rather than styled-to-look-like-a-heading so a screen-reader operator can walk
              the card's structure instead of hearing two undifferentiated lists. */}
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
            Strengths
          </h5>
          <ul className="mt-1 space-y-0.5">
            {assessment.strengths.map((s, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-ink-muted">
                {/* Decorative: the list semantics and the heading already say what this is. */}
                <span aria-hidden="true" className="text-ink-tertiary">
                  ·
                </span>
                <span className="min-w-0">{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {assessment.improvements.length > 0 && (
        <div className="mt-2.5">
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
            To try next
          </h5>
          <ul className="mt-1 space-y-0.5">
            {assessment.improvements.map((s, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-ink-muted">
                <span aria-hidden="true" className="text-ink-tertiary">
                  ·
                </span>
                <span className="min-w-0">{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A member's AI-assistant score, in ONE neutral treatment for every value.
 *
 * ⚠ NO COLOUR RAMP. The card this replaced coloured the bar red below 30, amber below 55 and
 * green above 80, a traffic light on a person, read by their teammates, which is precisely the
 * comparative framing the design rules out. A single accent states the same number without
 * grading the human being described.
 *
 * The bar is decorative and marked so: the figure beside it is the value, stated in text with
 * tabular figures and its scale, so nothing here depends on seeing the bar at all.
 */
function CoachingScore({ score }: { score: number }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-subtle">
          Working with AI
        </span>
        {/* tabular-nums and a fixed "/100" so the figure does not shift horizontally between
            one card and the next as values differ in width. */}
        <span className="text-xs font-semibold tabular-nums text-ink-muted">
          {score}/100
        </span>
      </div>
      <div
        aria-hidden="true"
        className="mt-1 h-1.5 bg-surface-2 rounded-full overflow-hidden"
      >
        <div
          className="h-full rounded-full bg-brand"
          // A width in a style attribute is unavoidable for a value-driven bar; it is the one
          // dynamic dimension on this card and it changes only when a new analysis lands.
          style={{ width: `${Math.min(Math.max(score, 0), 100)}%` }}
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  sub,
}: {
  label: string;
  value: number;
  icon: string;
  sub: string;
}) {
  return (
    <div className="bg-surface-3 rounded-xl border shadow-sm p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-ink-subtle uppercase tracking-wide">
          {label}
        </span>
        <span className="text-lg">{icon}</span>
      </div>
      <div className="text-2xl font-bold text-ink">{value}</div>
      <div className="text-xs text-ink-tertiary mt-1">{sub}</div>
    </div>
  );
}

/**
 * An activity score, stated once and neutrally.
 *
 * ── WHY THERE IS NO COLOUR RAMP HERE ANY MORE ──
 *
 * This badge used to run red → yellow → green → purple by score, with a matching bar. It sits
 * in a table of named teammates that those same teammates read, so the ramp painted a person
 * red for a quiet week, the comparative judgement already ruled out on the model-generated
 * cards. The reasoning does not change because the number upstream is a heuristic rather than
 * a model's: the reader sees a colleague's name next to a red badge either way.
 *
 * The colour was also carrying meaning ALONE, which fails WCAG 1.4.1 and disappears entirely
 * for a red/green-colourblind reader, roughly 1 in 12 men. The figure now states its own
 * scale in text, so nothing depends on seeing the bar, and the bar is `aria-hidden` because it
 * is decoration duplicating an adjacent number.
 *
 * `tabular-nums` keeps the digits from reflowing the column between renders.
 */
function ScoreBadge({ score }: { score: number }) {
  return (
    <div className="inline-flex flex-col items-center gap-1">
      <span className="text-xs font-semibold text-ink-muted tabular-nums">
        {score}
        <span className="font-normal text-ink-tertiary">/100</span>
      </span>
      <div
        className="w-12 h-1 overflow-hidden rounded-full bg-surface-2"
        aria-hidden="true"
      >
        {/* One weight for every score. Width still varies, that is the comparison the table
            is FOR, but no score is coloured as a failing one. */}
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}
