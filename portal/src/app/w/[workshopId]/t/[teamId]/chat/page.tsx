"use client";

import { useRef, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { teamContentGate } from "@/lib/team-content-gate";
import { teamTabHref } from "@/lib/team-routes";
import {
  ContentLoadError,
  MemberOnlyNotice,
  SessionExpiredNotice,
} from "@/components/TeamContentNotice";
import { scrollToLatest } from "@/lib/scroll-to-latest";
import { MAX_TEAM_MESSAGE_CHARS, SHOW_REMAINING_WITHIN } from "@/lib/chat-limits";
// Aliased to the names this page's markup already used, so consolidating the rule did not touch a
// single call site. See the note where the two local copies used to be defined.
import {
  formatMessageDay as formatDate,
  formatMessageClock as formatTime,
} from "@/lib/format-message-instant";

function getAvatarColor(name: string) {
  const colors = [
    "bg-notice-text", "bg-success-text", "bg-series-1", "bg-series-4",
    "bg-brand", "bg-series-2", "bg-series-6", "bg-series-7",
  ];
  const index = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

/*
  ⚠ TWO LOCAL DATE HELPERS WERE DELETED FROM HERE, and their absence is the point.

  This page carried its own `formatTime` and `formatDate`, copies 2 of 4 of a rule that also lived in
  `lib/format-message-instant.ts` and twice in the desktop app. They had already diverged: this
  `formatDate` said "Fri, Aug 8" while the desktop's inline label said "8 Aug", and neither of the two
  copies here handled the zone-less timestamp form that the desktop's did.

  Both now come from `@praimana/shared` via the portal's adapter (imported at the top of this
  file as `formatDate` / `formatTime`, so the call sites below are unchanged), giving the day rule
  (Today / Yesterday / weekday+date / year-when-it-differs) exactly one definition across both
  front-ends. See constants/message-time.ts.
*/

/**
 * ── ⚠ ONE MEASURE FOR THE TRANSCRIPT AND THE COMPOSER ────────────────────────────────────────
 *
 * A single constant rather than the same classes typed twice, because the whole point is that the
 * composer's edges line up with the messages above it. Two literals would drift the first time
 * either was adjusted, and the misalignment would be a few pixels, visible but hard to name.
 *
 * `max-w-3xl` is ~48rem, which puts a message line at roughly 80–90 characters: past the 65ch
 * ideal for running prose, but chat lines are short and a narrower column would waste the screen
 * a team is sharing. `w-full` alongside `mx-auto` because a centred container that is also a flex
 * item collapses to its content width without it, a trap this codebase has hit three times.
 */
const CHAT_MEASURE = "mx-auto w-full max-w-3xl";

export default function ChatPage() {
  const params = useParams();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;

  const messagesQuery = trpc.message.list.useQuery(
    { teamId, limit: 100 },
    {
      /**
       * POLLING STOPS ONCE THE ANSWER IS A RULE.
       *
       * This is the only page here that polls, and a flat `refetchInterval: 3000` against a
       * member-only endpoint means one refused request every three seconds for as long as
       * the tab is open, 1,200 an hour, all of them answered identically, none of them
       * capable of changing. Both halves of that are wrong: it is load nothing asked for,
       * and it is a rule being treated as a transient fault.
       *
       * Stops on ANY error rather than on 403 only. A chat service that is down does not
       * come back because a browser asked 1,200 times, and the page now offers an explicit
       * Try again, an operator retrying deliberately is better than a poll that hides the
       * failure by continuously re-entering it.
       */
      refetchInterval: (query) => (query.state.error ? false : 3000),
    }
  );
  const messagesData = messagesQuery.data;

  /**
   * ── ⚠ THE COMPOSER, WHICH THIS PAGE HAS NEVER HAD ────────────────────────────────────
   *
   * REPORTED as "on portal executives cant send team chat messages". They could not, and neither
   * could anyone else: this page rendered the transcript and nothing else, and `message.send` existed
   * in the tRPC router with ZERO callers. The executive write grant in the collaboration service was
   * complete and deployed the whole time; there was simply no UI to exercise it.
   *
   * Built now because "all executives might not use desktop", the desktop was the only place a team
   * message could be written, which made team chat unavailable to anyone who reads the portal instead.
   */
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const sendMessage = trpc.message.send.useMutation({
    onSuccess: () => {
      setDraft("");
      setSendError(null);
      /**
       * Refetched rather than optimistically appended. The row the server stores carries its own id,
       * `createdAt` and resolved sender, an optimistic copy would have to invent all three and then
       * be reconciled, and a wrong `createdAt` is exactly the defect the per-message timestamps were
       * just added to fix.
       */
      void messagesQuery.refetch();
    },
    onError: (err) => {
      /**
       * ⚠ SHOWN, AND THE DRAFT IS KEPT. A failed send that cleared the box would lose what somebody
       * typed, the same class of loss as the desktop's stopped-turn message, and less excusable
       * because the text is still on screen at the moment it is thrown away.
       *
       * A 403 is named specifically: it means the person is not a member of this team, not
       * that the platform is broken, and the remedy is different.
       */
      setSendError(
        err.data?.httpStatus === 403
          ? "Only members of this team can post here."
          : "Your message was not sent. It is still in the box, so try again."
      );
    },
  });

  const trimmed = draft.trim();
  const remaining = MAX_TEAM_MESSAGE_CHARS - draft.length;
  const canSend = trimmed.length > 0 && draft.length <= MAX_TEAM_MESSAGE_CHARS && !sendMessage.isPending;

  function submit() {
    if (!canSend) return;
    sendMessage.mutate({ teamId, content: trimmed });
  }

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollToLatest(messagesEndRef.current);
  }, [messagesData?.messages]);

  const messages = messagesData?.messages ?? [];

  // Group messages by date
  const groupedMessages: { date: string; messages: typeof messages }[] = [];
  let currentDate = "";
  for (const msg of messages) {
    const date = new Date(msg.createdAt).toDateString();
    if (date !== currentDate) {
      currentDate = date;
      groupedMessages.push({ date: msg.createdAt, messages: [] });
    }
    groupedMessages[groupedMessages.length - 1].messages.push(msg);
  }

  /**
   * NOTHING TO SHOW, AND WHY. The chat is member-only, so `message.list` answers
   * 403 to a facilitator, judge or admin who is not on this team.
   *
   * THIS PAGE IS THE STRONGEST CASE FOR THE SEPARATION. Its existing empty state is "No team
   * messages yet.", an affirmative claim about the team, rendered from `messages.length ===
   * 0`, which is exactly what a refused or failed query leaves behind. A facilitator reading
   * that during an incident concludes the team has gone quiet. Both branches must be taken
   * before that line can be reached.
   */
  // Held until the query has answered. Without this, `messages.length === 0` is true on the
  // first paint and the page states "No team messages yet." before the 403 arrives, an
  // affirmative claim about the team, made from no data, on the page where that sentence is
  // most likely to be believed.
  if (messagesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-ink-tertiary">Loading messages...</div>
      </div>
    );
  }

  const gate = teamContentGate([messagesQuery]);
  // SESSION EXPIRED outranks both branches below: a 401 means the server could not
  // evaluate any rule, so "member-only" would be a lie and "failed" blames the data.
  // Providers() is already signing out; this is what renders during that round trip.
  if (gate.state === "expired") {
    return <SessionExpiredNotice what="this team's chat" />;
  }
  if (gate.state === "member-only") {
    return (
      <MemberOnlyNotice
        what="This team's chat is visible to its members."
        teamHref={teamTabHref(workshopId, teamId)}
      />
    );
  }
  if (gate.state === "failed") {
    return (
      <ContentLoadError
        what="this team's chat"
        detail={gate.detail}
        onRetry={gate.retry}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-3">
      {/* ── ⚠ ONE MEASURE, SHARED BY THE TRANSCRIPT AND THE COMPOSER ────────────────────────────
          REPORTED: the input box was as wide as the page. So was the transcript, on a 1512px
          screen a message line ran to roughly 200 characters, two to three times the measure at
          which the eye reliably finds the start of the next line.

          `CHAT_MEASURE` is applied to both, so the composer's left and right edges line up exactly
          with the messages above it rather than being a separately-chosen width. The SCROLL
          CONTAINER stays full-width on purpose, the scrollbar belongs at the window edge, not
          floating in the middle of the page, and only the content inside it is capped. */}
      <div className="flex-1 overflow-y-auto">
        <div className={CHAT_MEASURE}>
        {messages.length === 0 && (
          <div className="mt-20 text-center text-ink-tertiary">
            {/* Was a 💬 at `text-4xl`. Same reasoning as the nav icons: an emoji is OS-owned font
                data that ignores `currentColor`, so it could not be toned down to sit with the
                line beneath it. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="mx-auto mb-3 h-8 w-8 text-ink-tertiary"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 6.5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-4 3v-9a2 2 0 0 1 2-2Z" />
              <path d="M19 9.5h1a1.5 1.5 0 0 1 1.5 1.5v6l-2.5-2h-4" />
            </svg>
            <p className="text-sm">No team messages yet.</p>
          </div>
        )}

        {groupedMessages.map((group, gi) => (
          <div key={gi}>
            {/* Date separator */}
            <div className="flex items-center gap-3 px-6 py-3">
              <div className="flex-1 h-px bg-surface-2" />
              <span className="text-xs font-medium text-ink-tertiary">
                {formatDate(group.date)}
              </span>
              <div className="flex-1 h-px bg-surface-2" />
            </div>

            {/* Messages for this date */}
            <div className="space-y-1 px-4">
              {group.messages.map((msg, mi) => {
                const prevMsg = mi > 0 ? group.messages[mi - 1] : null;
                const sameSender = prevMsg?.sender?.name === msg.sender?.name;
                const isSystem = !msg.sender;

                if (isSystem) {
                  return (
                    <div key={msg.id} className="flex justify-center py-2">
                      <span className="text-xs text-ink-tertiary italic bg-surface-1 px-3 py-1 rounded-full">
                        {msg.content}
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={msg.id}
                    className={`group flex items-start gap-3 px-2 py-1 rounded-lg hover:bg-surface-1 transition-colors ${
                      !sameSender ? "mt-3" : ""
                    }`}
                  >
                    {/* Avatar */}
                    <div className="w-9 flex-shrink-0">
                      {!sameSender && (
                        <div className={`w-9 h-9 rounded-full ${getAvatarColor(msg.sender!.name)} flex items-center justify-center text-brand-ink text-sm font-medium shadow-sm`}>
                          {msg.sender!.name[0]}
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/*
                        The NAME only. The time used to sit here too, which would now print it twice on the
                        first message of a run, every row carries its own on the right (see below).
                      */}
                      {!sameSender && (
                        <div className="mb-0.5">
                          <span className="text-sm font-semibold text-ink">
                            {msg.sender!.name}
                          </span>
                        </div>
                      )}
                      <p className="text-sm text-ink-muted leading-relaxed whitespace-pre-wrap">
                        {msg.content}
                      </p>
                    </div>

                    {/*
                      ── ⚠ EVERY MESSAGE CARRIES ITS OWN TIME ────────────────────────────────────
                      REPORTED: "the same user sent multiple messages but on portal its only showing the
                      first time stamp".

                      Consecutive messages from one sender hide the name+time header (that grouping is
                      right, repeating the name on every line is noise), and the time was then shown ONLY
                      on hover. So a run of five messages displayed one timestamp, and the other four had
                      no readable time at all: not discoverable with a keyboard, not discoverable on a
                      touch screen, and invisible in a screenshot of an incident.

                      Now it is always rendered, right-aligned at the end of the row. `whitespace-nowrap`
                      and `flex-shrink-0` because a narrow column would otherwise wrap "10:42" onto two
                      lines or squeeze it away entirely.
                    */}
                    <span className="pt-0.5 text-xs tabular-nums text-ink-tertiary whitespace-nowrap flex-shrink-0">
                      {formatTime(msg.createdAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* ── THE COMPOSER ────────────────────────────────────────────────────────────────────
          Outside the scrolling transcript and after it, so it stays put while messages move.

          ⚠ NO ROLE CHECK HERE, AND THAT IS DELIBERATE RATHER THAN AN OMISSION. Reaching this line
          already proves membership: the transcript is member-only, so a facilitator, judge
          or admin who is not on this team never gets past the `member-only` gate above. And every
          member may post, `requireTeamCollaborationWrite` refuses read-only roles EXCEPT executive,
          which is the grant this composer exists to make usable. A second copy of that rule here
          could only drift from the service's, which is the one that cannot be bypassed. */}
      <div className="border-t border-hairline bg-surface-3 p-3">
        <div className={CHAT_MEASURE}>
          <div className="rounded-lg border border-field-border transition-colors focus-within:border-brand">
            <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              /*
                Enter sends, Shift+Enter makes a newline, the convention every chat in this product
                uses, including both desktop composers. A textarea (not an input) because a message
                that cannot contain a line break is a worse control that merely looks the same.
              */
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            /*
              A courtesy, not the boundary: the tRPC schema and the collaboration service are what
              enforce this. Shared constant so the two cannot disagree, see lib/chat-limits.ts.
            */
            maxLength={MAX_TEAM_MESSAGE_CHARS}
            placeholder="Message your team…"
            aria-label="Message your team"
            className="w-full resize-none bg-transparent px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary outline-none"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-2">
            <span className="text-xs text-ink-tertiary">
              {/*
                ⚠ THE COUNT APPEARS ONLY NEAR THE LIMIT. A permanent counter tells every one-line
                message that it is being measured; this is information only when it is nearly spent.
              */}
              {remaining <= SHOW_REMAINING_WITHIN
                ? `${remaining} character${remaining === 1 ? "" : "s"} left`
                : "Enter to send · Shift+Enter for a new line"}
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sendMessage.isPending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
          {/* Inside the measure, so an error lines up with the field it is about rather than
              running the full width of the window. */}
          {sendError && (
            <p role="alert" className="mt-2 text-xs text-danger-text">
              {sendError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
