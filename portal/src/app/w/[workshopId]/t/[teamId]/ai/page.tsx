"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import { trpc } from "@/lib/trpc/client";
import { ThreadTiming } from "@/components/ThreadTiming";
import { aiProviderDisplay } from "@/lib/ai-provider";
import ReactMarkdown from "react-markdown";
import { teamContentGate } from "@/lib/team-content-gate";
import { teamTabHref } from "@/lib/team-routes";
import { formatMessageInstant } from "@/lib/format-message-instant";
import { isUnauthorized } from "@/lib/trpc/errors";
import {
  ContentLoadError,
  MemberOnlyNotice,
  SessionExpiredNotice,
} from "@/components/TeamContentNotice";

export default function AIChatsPage() {
  const params = useParams();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;

  /**
   * The query cache handle, used to invalidate the timing strip when refresh is pressed.
   *
   * ⚠ `ThreadTiming` OWNS ITS OWN QUERY and has no interval, so refetching the thread alone would leave the
   * token figures stale, the one number someone is most likely to be watching after a new turn.
   */
  const utils = trpc.useUtils();
  const threadsQuery = trpc.ai.getThreads.useQuery({ teamId });
  const threads = threadsQuery.data;
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const activeThreadQuery = trpc.ai.getThread.useQuery(
    // `teamId` is what lets the BFF resolve each turn's author to a name, the messages route is
    // thread-keyed and returns no team. See the note on `ai.getThread`.
    { threadId: activeThreadId!, teamId },
    {
      enabled: !!activeThreadId,
      // Stops polling a request that cannot succeed, for the reason spelt out on the chat
      // page's interval. A thread can only be opened from the list beside it, so in practice
      // this fires only after getThreads succeeded, but a membership removed mid-shift
      // turns this into the refused poller, and it must stop too.
      refetchInterval: (query) => (query.state.error ? false : 5000),
    }
  );
  const activeThread = activeThreadQuery.data;

  /**
   * The active thread's LIST row, title, provider, and the two timestamps.
   *
   * ⚠ ONE `find`, WHICH IS WHAT THE NOTE BELOW ALREADY ASKED FOR AND DID NOT GET. The provider display
   * was hoisted "resolved ONCE... which is how they came to disagree", and then the header went and did
   * its own `threads?.find(...)` for the title anyway. Adding a third for the creation date would have
   * continued the pattern, so the row itself is resolved once and everything reads off it.
   *
   * ⚠ FROM THE LIST, NOT FROM `activeThread`, the transcript payload is messages only. `getThreads` is
   * where the metadata lives, which is also why this survives a `getThread` failure: the header still
   * names the conversation whose messages could not be loaded.
   */
  const activeThreadMeta = threads?.find((t) => t.id === activeThreadId);

  // Resolved ONCE for the active thread. The icon and the author name previously each
  // re-derived this with their own `threads?.find(...)` chain and their own provider
  // branches, which is how they came to disagree.
  const activeProviderDisplay = aiProviderDisplay(activeThreadMeta?.aiProvider);

  /**
   * When the conversation was STARTED, for the header.
   *
   * Deliberately `createdAt` alone with no `updatedAt` fallback: this is the one label on the screen
   * that means creation, and falling back to a modification time would make it quietly lie on exactly
   * the threads the distinction matters for.
   *
   * ⚠ `""` FOR AN ABSENT OR UNPARSEABLE VALUE, NOT `null`, that is the PORTAL'S adapter convention
   * (`lib/format-message-instant.ts`; the shared rule returns null and the desktop guards on it). The
   * guard here is on `createdAt` rather than on the result because that adapter takes a REQUIRED
   * string. Either way the header omits the clause instead of printing "Started" with nothing after it.
   */
  const startedAt = activeThreadMeta?.createdAt
    ? formatMessageInstant(activeThreadMeta.createdAt)
    : "";

  /**
   * NOTHING TO SHOW, AND WHY. The AI threads are member-only, so `ai.getThreads`
   * answers 403 to a facilitator, judge or admin who is not on this team.
   *
   * ONLY `getThreads` GATES THE PAGE, deliberately. It is the query that decides whether
   * there is a page at all; `getThread` is a per-selection read that cannot even be
   * triggered until the list has loaded, so a failure there is about ONE conversation and
   * must not blank the sidebar the operator is working in, its own message is rendered in
   * the reading pane below. Folding it in here would let one unreadable thread hide the
   * other twenty.
   */
  // Held until the list has answered. The sidebar's own empty state ("No AI conversations
  // yet") keys on `threads?.length === 0`, which is false while undefined, so the first paint
  // showed "Conversations (0)" with a blank list, i.e. the same picture as a team that has
  // never used AI.
  if (threadsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-ink-tertiary">Loading AI conversations...</div>
      </div>
    );
  }

  const gate = teamContentGate([threadsQuery]);
  // SESSION EXPIRED outranks both branches below: a 401 means the server could not
  // evaluate any rule, so "member-only" would be a lie and "failed" blames the data.
  // Providers() is already signing out; this is what renders during that round trip.
  if (gate.state === "expired") {
    return <SessionExpiredNotice what="this team's AI conversations" />;
  }
  if (gate.state === "member-only") {
    return (
      <MemberOnlyNotice
        what="This team's AI conversations are visible to its members."
        teamHref={teamTabHref(workshopId, teamId)}
      />
    );
  }
  if (gate.state === "failed") {
    return (
      <ContentLoadError
        what="this team's AI conversations"
        detail={gate.detail}
        onRetry={gate.retry}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Thread sidebar */}
      <div className="w-64 border-r bg-surface-1 flex flex-col">
        {/*
          ── ⚠ REFRESH, IN THE CORNER, ICON ONLY ────────────────────────────────────────────
          A refresh icon beside the AI conversations list, in the right-hand corner, and one in each
          open conversation's right-hand corner: icon only, with a "Refresh" tooltip. Built in the desktop first; this is the portal's own.

          ⚠ WHY IT IS WORTH HAVING HERE AT ALL, given the open thread already polls every 5s: the LIST does
          not. `getThreads` runs once on mount, so a conversation created on someone's desktop, or the
          title of one that was just renamed, does not appear until the page is reloaded. That is the gap
          this closes.
        */}
        <div className="p-3 border-b bg-surface-3 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wide">
            Conversations ({threads?.length ?? 0})
          </h3>
          <button
            type="button"
            onClick={() => void threadsQuery.refetch()}
            disabled={threadsQuery.isFetching}
            className="rounded p-1 text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-ink-subtle disabled:opacity-50"
            title="Refresh"
            aria-label={threadsQuery.isFetching ? "Refreshing conversations" : "Refresh conversations"}
          >
            <RefreshIcon spinning={threadsQuery.isFetching} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {threads?.slice().sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()).map((thread) => {
            const isActive = activeThreadId === thread.id;
            return (
              <button
                key={thread.id}
                onClick={() => setActiveThreadId(thread.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-all ${
                  isActive
                    ? "bg-surface-3 shadow-sm border border-brand-border"
                    : "hover:bg-surface-3 hover:shadow-sm border border-transparent"
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    isActive ? "bg-brand" : "bg-hairline-strong"
                  }`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate text-ink-muted">
                      {thread.title || "Untitled"}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs text-ink-tertiary">
                        {thread.createdBy?.name ?? "unknown"}
                      </span>
                      {thread.aiProvider && (
                        <>
                          <span className="text-ink-tertiary">·</span>
                          {/* One source for the name AND the badge colour, so a Codex
                              thread can never be labelled "Claude" again, which is what
                              the previous two-way ternary did, while the icon beside it
                              got it right. */}
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                              aiProviderDisplay(thread.aiProvider).badgeClass
                            }`}
                          >
                            {aiProviderDisplay(thread.aiProvider).label}
                          </span>
                        </>
                      )}
                      {/*
                        ⚠ LAST ACTIVITY, NOT CREATION, AND THIS LIST WAS CONTRADICTING ITSELF.
                        The sort above is `updatedAt || createdAt`, so a thread started on the 16th and
                        used today sits at the TOP of the list while this label read "16 Aug". The order
                        said "most recent" and the date said something else, which makes the ordering
                        look broken rather than the label.

                        Same expression as the sort, and the same one `ai.tokenUsage` already uses for
                        its `at` field, one idea of "when did this last happen", spelled once per
                        reader. Creation has its own home now: the thread header states it explicitly,
                        where there is room to say which date it is.
                      */}
                      {(thread.updatedAt || thread.createdAt) && (
                        <>
                          <span className="text-ink-tertiary">·</span>
                          <span className="text-xs text-ink-tertiary">
                            {formatMessageInstant(thread.updatedAt || thread.createdAt)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
          {threads?.length === 0 && (
            <div className="text-center py-8">
              <p className="text-3xl mb-2">🤖</p>
              <p className="text-xs text-ink-tertiary">No AI conversations yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Chat view */}
      <div className="flex-1 flex flex-col bg-surface-3">
        {!activeThreadId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-ink-tertiary">
              <p className="text-4xl mb-3">💬</p>
              <p className="text-sm">Select a conversation to view</p>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="border-b px-5 py-3 bg-surface-1/50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm text-ink-muted">
                    {activeThreadMeta?.title || "Untitled"}
                  </h3>
                  {/*
                    ⚠ "Started", AND THE WORD IS LOAD-BEARING. The sidebar now shows each thread's LAST
                    ACTIVITY, because that is what it sorts by; this is the one place the CREATION date
                    is stated, so it has to say which of the two it is. Two bare dates on one screen
                    meaning different things is how the list came to look wrong in the first place.

                    Rendered only when there is a date to render, `formatMessageInstant` returns null
                    for an absent or unparseable value, and a dangling "Started" with nothing after it
                    reads as a truncated page.
                  */}
                  <p className="text-xs text-ink-tertiary mt-0.5">
                    {activeThread?.messages?.length ?? 0} messages
                    {startedAt && <> · Started {startedAt}</>}
                  </p>
                </div>
                {/*
                  ⚠ REFETCHES THE THREAD *AND* ITS TIMING. The transcript polls every 5s, but the timing
                  strip below is its own query with no interval, so without the second call, pressing
                  refresh would update the messages and leave the token figures stale, which is the one
                  number someone is most likely to be watching after a new turn.
                */}
                <button
                  type="button"
                  onClick={() => {
                    void activeThreadQuery.refetch();
                    void utils.ai.timing.invalidate({ threadId: activeThreadId });
                  }}
                  disabled={activeThreadQuery.isFetching}
                  className="flex-shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-ink-subtle disabled:opacity-50"
                  title="Refresh"
                  aria-label={
                    activeThreadQuery.isFetching
                      ? "Refreshing this conversation"
                      : "Refresh this conversation"
                  }
                >
                  <RefreshIcon spinning={activeThreadQuery.isFetching} />
                </button>
              </div>
              {/* Time split for this conversation. Renders nothing while loading or on
                  failure, it is supplementary to the transcript, so a fault here must not
                  put an error in front of someone reading a chat. */}
              <div className="mt-1.5">
                <ThreadTiming threadId={activeThreadId} />
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* ONE THREAD FAILED TO LOAD, scoped to the reading pane, not the page (see
                  the gate above on why). Without this the pane renders as a selected
                  conversation with zero messages, which is indistinguishable from an empty
                  thread and silently loses the fact that a fetch failed. No member-only
                  branch here: reaching this pane means getThreads succeeded, so membership
                  is settled and a 403 on one thread is a genuine fault. */}
              {/*
                ── ⚠ AN EXPIRED LOGIN IS NOT A FAILED LOAD ───────────────────────────────────
                REPORTED: "why do i see this Couldn't load this conversation … Backend error: 401 can add
                redirect hook for this to login page".

                The PAGE-level gate has branched on 401 since the last round of this exact bug, but this
                second, narrower error path did not, so a 401 here produced "Couldn't load this conversation …
                the data is missing … report it and quote the message" for what is only an expired session.
                The message even quoted the status back at the reader, inviting them to file a bug about their
                own login.

                ⚠ THE SAME SHAPE AS THE SYNC BADGE AND THE COPY BUTTON: built once, wired into one path,
                reported again from the other. `isUnauthorized` is the shared decision, string-matching
                "Backend error: 401" here would be a second, disagreeing definition of the same condition.

                The redirect itself is `Providers`' doing (it evicts on any UNAUTHORIZED query and replaces the
                location). This is what the reader sees during that window, and the manual escape if the
                sign-out round trip fails, which is exactly why it renders rather than returning null.
              */}
              {activeThreadQuery.error &&
                (isUnauthorized(activeThreadQuery.error) ? (
                  <SessionExpiredNotice what="this conversation" />
                ) : (
                  <ContentLoadError
                    what="this conversation"
                    detail={activeThreadQuery.error.message}
                    onRetry={() => activeThreadQuery.refetch()}
                    // The thread header above it is an <h3>.
                    headingLevel={4}
                  />
                ))}
              {/**
                * ⚠ THE AUTHOR'S NAME IS REAL NOW, AND FOR A LONG TIME IT WAS NOT.
                *
                * These spots read `msg.user?.name` against a payload that never carried a `user`
                * object, `GET /v1/ai/threads/:id/messages` returns the stored `AiMessage` rows
                * verbatim, with no read-model join, so every user turn rendered the "User" / "U"
                * fallback and the person who wrote it was never named. `ai.getThread` now resolves
                * each turn's `userId` against the team roster, the same way `getThreads` resolves
                * thread owners.
                *
                * THE `?? "User"` FALLBACK STAYS AND IS STILL REACHABLE, an ASSISTANT turn carries no
                * `user` at all (deliberately: a name on the model's reply is a false attribution), and
                * this branch also renders before the query resolves. An author the roster could not
                * name reads "Unknown" rather than falling through to here, because a user turn has an
                * author whatever the roster did, see the note on `ai.getThread`.
                */}
              {activeThread?.messages?.map((msg, i) => {
                const isUser = msg.role === "user";
                const prevMsg = i > 0 ? activeThread.messages[i - 1] : null;
                const showDivider = prevMsg && prevMsg.role !== msg.role;

                return (
                  <div key={msg.id}>
                    {showDivider && (
                      <div className="my-4 border-t border-hairline-soft" />
                    )}
                    <div className="flex gap-3">
                      {/* Avatar */}
                      {isUser ? (
                        <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-medium bg-brand-subtle text-brand-text">
                          {msg.user?.name?.[0]?.toUpperCase() ?? "U"}
                        </div>
                      ) : (
                        <Image
                          src={`/icons/${activeProviderDisplay.icon ?? "claude"}.png`}
                          /**
                           * `alt=""` BY THE SAME RULE `BrandMark` APPLIES, not by omission: the
                           * provider's name renders as text immediately beside this avatar
                           * (`activeProviderDisplay.label`), so real alt text here would make a
                           * screen reader announce the assistant twice per message. It is
                           * decorative and drops out of the accessibility tree.
                           */
                          alt=""
                          /**
                           * Explicit geometry matching the `w-8 h-8` box, 32px, for the reason
                           * `BrandMark` fixes its dimensions too: an image with no reserved box
                           * reflows the transcript as each avatar decodes, and this list is being
                           * scrolled while it loads. No `priority`: these are below the fold by
                           * construction.
                           */
                          width={32}
                          height={32}
                          className="w-8 h-8 rounded-full flex-shrink-0"
                        />
                      )}

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="text-sm font-semibold text-ink-muted">
                            {isUser
                              ? (msg.user?.name ?? "User")
                              : activeProviderDisplay.label}
                          </span>
                          <span className="text-xs text-ink-tertiary">
                            {formatMessageInstant(msg.createdAt)}
                          </span>
                        </div>
                        <div className={`text-sm leading-relaxed rounded-lg px-4 py-3 ${
                          isUser
                            ? "bg-brand-subtle text-ink-muted border border-brand-border whitespace-pre-wrap"
                            : "bg-surface-1 text-ink-muted border border-hairline-soft prose prose-sm max-w-none prose-pre:bg-ink-muted prose-pre:text-surface-2 prose-pre:rounded-md prose-pre:text-xs prose-code:text-series-4 prose-code:before:content-none prose-code:after:content-none"
                        }`}>
                          {isUser ? msg.content : <ReactMarkdown>{msg.content}</ReactMarkdown>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The refresh glyph, icon only, the word lives in the button's `title` and `aria-label`.
 *
 * ⚠ `motion-safe:` ON THE SPIN, because a continuously rotating element is what `prefers-reduced-motion`
 * exists to suppress. The disabled state already conveys "in flight", so nothing is lost by holding still.
 */
function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? "motion-safe:animate-spin" : ""}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
