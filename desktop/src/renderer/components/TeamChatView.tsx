import { useState, useEffect, useRef, Fragment, useId } from "react";
import { TeamAccessNotice } from "./TeamAccessNotice";
import { useToast } from "./Toast";
import { SendIcon } from "./SendIcon";
import { CharCounter } from "./CharCounter";
import { ComposerKeyHint } from "./ComposerKeyHint";
import { MAX_TEAM_MESSAGE_CHARS } from "@praimana/shared";
import { autoGrow } from "../lib/textarea";
import { CopyButton } from "./CopyButton";
/* The same clickable file name the AI chats got, for the one surface that renders plain text. */
import { FileMentions } from "./FileMentions";
import { scrollToLatest } from "../lib/scroll-to-latest";
import { formatClock, messageDayLabel, parseStoredInstant } from "../lib/instants";
import { PanePinSlot } from "./PanePinSlot";
import { PANE_HEADER, PANE_TITLE } from "../lib/pane-header";

const api = (window as any).electronAPI;

interface Message {
  id: string;
  content: string;
  type: string;
  sender?: { name: string; id: string };
  createdAt: string;
}

export function TeamChatView() {
  /** Ties the composer to its keyboard description. */
  const hintId = useId();
  const [messages, setMessages] = useState<Message[]>([]);
  /**
   * Why this pane is empty, when it is. Main classifies the failure (see team-data.ts); the only
   * ones surfaced are the permanent, actionable ones — a transient blip must not raise a banner.
   */
  const [accessReason, setAccessReason] = useState<unknown>(undefined);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  /** The composer, so its height can be reset after a send — see `autoGrow`. */
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const toast = useToast();

  useEffect(() => {
    loadMessages();
    loadUserId();
    pollRef.current = setInterval(loadMessages, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    scrollToLatest(messagesEndRef.current);
  }, [messages]);

  /**
   * ⚠ THE COGNITO `sub`, NOT THE E-MAIL. Ownership of a message is decided against this value, and
   * the fallback to `user_email` made an ADDRESS an identity — see the `isMe` note below. An install
   * with no `user_id` now compares against nothing and every message renders as somebody else's,
   * which is the safe direction: a missing sender label is a cosmetic gap, a message attributed to
   * the wrong person is not.
   */
  async function loadUserId() {
    setUserId((await api.getSetting("user_id")) || "");
  }

  // Polled on a 5s interval. The fetch itself runs in the MAIN process
  // (chat:getTeamMessages) with a 4s timeout, so a poll always resolves before
  // the next tick and the bearer never reaches the renderer.
  async function loadMessages() {
    const res = await api.getTeamMessages();
    // Recorded on EVERY load, so a recovery clears the banner as readily as a failure raises it.
    setAccessReason(res?.reason);

    if (res?.ok) {
      const msgs = (res.messages || []).map((m: any) => ({
        id: m.id || m.createdAt,
        content: m.content,
        type: m.type || "TEXT",
        /**
         * ⚠ THE LAST FALLBACK IS "Unknown", NOT "You". A response carrying neither `sender` nor
         * `userId` says nothing about who sent it, and labelling it "You" asserted the one thing that
         * cannot be inferred — the same conflation of naming and identity as the `isMe` finding
         * below, arriving by a different route.
         */
        sender: m.sender || (m.userId ? { id: m.userId, name: m.userName || "Unknown" } : { id: m.senderId, name: "Unknown" }),
        createdAt: m.createdAt,
      }));
      // Backend returns newest first, reverse for chronological display
      msgs.sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
      setMessages(msgs);
    }
    setLoading(false);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;

    setSending(true);
    const res = await api.sendTeamMessage(input.trim());

    // Same three outcomes as before the send moved to main: sent, server said no
    // (status present), or never reached the server at all (status null).
    if (res?.ok) {
      setInput("");
      // Collapse the box back to one row. Without this a multi-line message leaves the composer tall and empty,
      // which the AI composers already handle the same way.
      if (inputRef.current) {
        inputRef.current.value = "";
        autoGrow(inputRef.current);
      }
      await loadMessages();
    } else if (res?.status != null) {
      toast.error(`Message not sent (server error ${res.status})`);
    } else {
      toast.error("Message not sent — check your connection");
    }
    setSending(false);
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-bg text-sm text-surface-muted">
        Loading team chat…
      </div>
    );
  }

  /**
   * Stable per-sender accent for avatars, so the chat reads clearly at a glance.
   *
   * ⚠ MOVED FROM 500- TO 400-LEVEL, AND THE TEXT ON THEM FROM WHITE TO DARK — because the original was
   * FAILING CONTRAST, on white as much as on this dark surface. Measured:
   *
   *     white on amber-500    2.15:1     dark on amber-400    10.63:1
   *     white on emerald-500  2.54:1     dark on emerald-400   9.23:1
   *     white on cyan-500     2.43:1     dark on cyan-400      9.82:1
   *     white on rose-500     3.67:1     dark on rose-400      6.59:1
   *     white on violet-500   4.23:1     dark on violet-400    6.52:1
   *     white on indigo-500   4.47:1     dark on indigo-400    5.95:1
   *
   * Every one of the six was under the 4.5:1 floor for that initial; three were barely half of it. A
   * pre-existing bug this re-theme surfaced rather than caused — and mirroring the old values faithfully
   * would have carried it across.
   */
  const AVATAR_COLORS = [
    "bg-emerald-400", "bg-violet-400", "bg-amber-400",
    "bg-rose-400", "bg-cyan-400", "bg-indigo-400",
  ];
  function colorFor(key: string) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  return (
    /*
      Dark, matching the AI chat beside it and the sidebar it sits next to. `bg-white` on this root and its
      header were the two most visible mismatches in the app: a white panel inside a gray-900 shell.
    */
    <div className="flex h-full flex-col overflow-hidden bg-surface-bg">
      {/*
        ⚠ THE SUBTITLE MOVED INTO THE ROW rather than below it. It used to be a second line, which is what
        made this header taller than the others and why two pinned panes did not line up. The words are kept
        — they explain what the pane is — but they now sit beside the title, where a 40px bar has room for
        them, and they are hidden on a narrow pane instead of forcing it to grow.
      */}
      <div className={`${PANE_HEADER} bg-surface-panel`}>
        <h2 className={PANE_TITLE}>Team Chat</h2>
        <PanePinSlot />
        <p className="hidden truncate text-xs text-surface-muted lg:block">
          Messages shared with your team
        </p>
      </div>

      <TeamAccessNotice reason={accessReason} />

      <div className="overflow-y-auto bg-surface-bg p-4 space-y-3.5" style={{ flex: "1 1 0", minHeight: 0 }}>
        {messages.length === 0 && (
          <div className="mt-20 text-center text-surface-muted">
            <p className="text-3xl mb-3">👥</p>
            <p className="text-sm">No messages yet. Start the conversation!</p>
          </div>
        )}

        {messages.map((msg, i) => {
          /**
           * ── ⚠ OWNERSHIP IS DECIDED FROM THE ID ONLY ─────────────────────────────────────────
           *
           * This was `msg.sender?.name === userId || msg.sender?.id === userId`, comparing a
           * PARTICIPANT-CONTROLLED DISPLAY NAME against the viewer's identity. `sender.name` is whatever
           * another participant's profile says; `userId` was the Cognito `sub` or, when that was unset, the
           * user's e-mail.
           *
           * So a teammate whose display name equalled the victim's `sub` (or e-mail) had every
           * message they posted render in the victim's client as the victim's OWN — right-aligned in
           * the "mine" bubble, with the name and avatar suppressed entirely, because those are drawn
           * only under `{!isMe && …}`. The victim had no way in the UI to see who actually sent it.
           * And the value is not secret to teammates: `board:getBoard` hands every member's record to
           * every other member.
           *
           * ⚠ `!!userId` GUARDS THE EMPTY CASE. Without it, an install with no `user_id` would match
           * every message whose sender id is also empty.
           */
          const isMe = !!userId && msg.sender?.id === userId;
          /*
            ⚠ THE DAY SEPARATOR, DERIVED IN THE MAP RATHER THAN FROM A PRE-GROUPED ARRAY.

            The portal builds a `groupedMessages` array and renders nested loops. Here a flat map with a
            "did the day change?" test produces the same output without restructuring a list that four
            other things already read (unread tracking, `scrollToLatest`, the auto-scroll effect) — the
            smaller change to a working view.

            Compared on the CALENDAR DAY of the previous message, using the shared parse so a zone-less
            value cannot bucket into the wrong day. `messages` is sorted ascending by the loader, so the
            previous element is the previous message.
          */
          const prev = i > 0 ? messages[i - 1] : null;
          const dayChanged =
            !prev ||
            parseStoredInstant(msg.createdAt).toDateString() !==
              parseStoredInstant(prev.createdAt).toDateString();
          const dayLabel = dayChanged ? messageDayLabel(msg.createdAt, new Date(), { weekday: true }) : null;
          const senderName = msg.sender?.name || "Unknown";
          const initial = senderName[0]?.toUpperCase() || "?";
          return (
            <Fragment key={msg.id}>
              {/*
                Hairline-either-side, same shape as the portal's separator, in this app's dark tokens
                (`surface-line` for the rule, `surface-muted` for the label). `aria-hidden` on the rules
                only — the label itself is real content a screen reader should announce, because it is
                the only place the day is stated.
              */}
              {dayLabel && (
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-px flex-1 bg-surface-line" aria-hidden="true" />
                  <span className="text-[11px] font-medium text-surface-muted">{dayLabel}</span>
                  <div className="h-px flex-1 bg-surface-line" aria-hidden="true" />
                </div>
              )}
              <div
                className={`group flex items-end gap-2 ${isMe ? "justify-end" : "justify-start"}`}
              >
                {!isMe && (
                  <div
                    /*
                      `text-surface-bg` — the near-black — rather than white, which is what makes the 400-level
                      palette above legible. See the ratios in AVATAR_COLORS.
                    */
                    className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-surface-bg ${colorFor(
                      msg.sender?.id || senderName
                    )}`}
                    title={senderName}
                  >
                    {initial}
                  </div>
                )}
                <div className="max-w-[75%]">
                  {!isMe && msg.sender && (
                    <span className="mb-0.5 block text-xs font-medium text-surface-muted">
                      {senderName}
                    </span>
                  )}
                  <div
                    /*
                      ⚠ MY messages in `brand-strong` — THE APP'S OWN BLUE, NEVER AN ASSISTANT'S HUE. Each
                      assistant owns a colour (`lib/assistant-theme.ts`), so borrowing one here would dress
                      human messages as the AI's — and would keep doing so while the participant is working
                      with a different assistant entirely. See the `brand` group in tailwind.config.ts.

                      White on it is 5.17:1; it separates from THEIR bubble (`surface-panel`) at 2.84:1 and
                      from the page at 3.43:1.

                      Theirs stays on `surface-panel` with a hairline, so own-versus-theirs is carried by
                      fill, border AND side, never by hue alone.
                    */
                    className={`rounded-2xl px-4 py-2.5 text-sm ${
                      isMe
                        ? "rounded-br-sm bg-brand-strong text-white"
                        : "rounded-bl-sm border border-surface-line bg-surface-panel text-surface-text"
                    }`}
                  >
                    {/*
                      ⚠ STILL THE STRING THE TEAMMATE TYPED — this is NOT markdown, and must not become it.
                      `FileMentions` only splits the text around file names it recognises and hands those to
                      the same control the AI chats use (see FileMentions.tsx); an asterisk stays an asterisk.

                      ⚠ AND A NAME THAT IS NOT ON THIS MACHINE STAYS PLAIN TEXT OR SAYS SO. A message is
                      written against the SENDER's checkout: their `docs/spec.md` resolves against YOUR root
                      and opens your copy, their `/Users/them/…` is refused outright, and a file you have not
                      got is caught by the existence check on the click rather than opening an empty tab.
                    */}
                    <FileMentions text={msg.content} />
                  </div>
                  {/*
                    The footer line already carried the time; copy joins it rather than floating over the
                    bubble. `justify-end` on my own messages keeps it under the right-aligned bubble.
                  */}
                  <div className={`mt-0.5 flex items-center gap-2 ${isMe ? "justify-end" : ""}`}>
                    {/*
                      THE CLOCK ONLY — the DAY is established by the separator above this group.
  
This footer rendered `toLocaleTimeString` on a FLAT list, so a message from last week read as "11:04 PM" and
sat indistinguishable from one sent minutes ago.
  
                      ⚠ THE FIX IS THE SEPARATOR, NOT A LONGER STAMP. The first pass put the full
                      "Yesterday 11:04 PM" under every bubble, which fixes the ambiguity but repeats the
                      same word down the whole column — and it made this view the one chat surface on the
                      platform NOT using day separators, since the portal's team chat has grouped by day all
                      along. Grouping is the standard chat idiom and the one already built next door; one
                      idiom for one job across both apps.
  
                      `formatClock` shares the parse with everything else, which matters even though
                      `createdAt` here is a SERVER `toISOString()` (already zone-marked): the shared helper
                      is what stops a fourth hand-rolled `new Date(...)` appearing in this file again.
                    */}
                    {formatClock(msg.createdAt) && (
                      <span className="text-[11px] tabular-nums text-surface-faint">
                        {formatClock(msg.createdAt)}
                      </span>
                    )}
                    {/*
                      ⚠ NOT `onLight`. The copy control sits on the page background here, not inside the
                      terracotta bubble — so it uses the normal muted tokens even for my own messages.
                    */}
                    <CopyButton text={msg.content} />
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/*
        ── THE COMPOSER, MATCHED TO THE AI CHATS' ──

        Same single bordered card with a `focus-within` ring, same icon send button, same keyboard hint as a real
        element rather than placeholder text that vanishes as you type.

        ⚠ IT BECOMES A `<textarea>`, NOT AN `<input>` — and that is a behaviour change worth naming rather than a
        styling one. A single-line input cannot hold a newline at all, so a team message was forced to be one
        line; the AI composers have always allowed Shift+Enter. Matching the box without matching that would give
        the same appearance and a worse control.
      */}
      <form onSubmit={handleSend} className="border-t border-surface-line bg-surface-bg p-3">
        {/*
          ⚠ THE CARD IS THE AI COMPOSERS' CARD; ONLY THE HUE IS TEAM CHAT'S. Same rounding, same border,
          same panel fill, same focus-on-the-card behaviour — that is what "same input style" means and
          what `view-theme.test.ts` pins. The RING uses `brand-strong` for the same reason the bubble does:
          an assistant's hue around the box a person types a message into is the same borrowed-brand
          mistake, just smaller.
        */}
        <div className="rounded-lg border border-surface-line bg-surface-panel transition-colors focus-within:border-brand-accent">
          <textarea
            ref={inputRef}
            value={input}
            /*
              ⚠ A COURTESY, NOT A CONTROL: any client may decline to honour it. The NUMBER comes
              from @praimana/shared so the desktop, the portal and the server mean the same
              thing by "too long" — chat-limits.ts records which of them actually enforces it.
            */
            maxLength={MAX_TEAM_MESSAGE_CHARS}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline — the same contract as the AI composers, and the
              // reason this is a textarea now.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(e as unknown as React.FormEvent);
              }
            }}
            placeholder={sending ? "Sending…" : "Message your team…"}
            /**
             * `readOnly` rather than `disabled` while a send is in flight, for the same reason as the AI
             * composers: a disabled field DROPS FOCUS and cannot take it back, so the participant had to click
             * back into the box after every message. The Enter guard and the submit button's own `disabled`
             * already prevent a double send.
             */
            readOnly={sending}
            aria-disabled={sending}
            /**
             * ⚠ AN ACCESSIBLE NAME, which this box did not have either — see ComposerKeyHint. The
             * placeholder said "Message your team…" and a placeholder is not a name: it is the first
             * thing to disappear, on the first keystroke.
             */
            aria-label="Message your team"
            aria-describedby={hintId}
            rows={1}
            /*
              Borderless and transparent — the card draws the border and fill, so an inner border would be a box
              inside a box. `outline-none` is safe because the card shows focus via `focus-within`.
            */
            className={`w-full resize-none overflow-y-hidden bg-transparent px-3.5 py-3 text-sm leading-5 outline-none ${
              sending
                ? "cursor-default text-surface-muted placeholder:text-surface-muted"
                : "text-surface-text placeholder:text-surface-muted"
            }`}
            style={{ minHeight: "44px", maxHeight: "200px" }}
          />

          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0">
            <div className="ml-auto flex items-center gap-2">
              <CharCounter value={input} max={MAX_TEAM_MESSAGE_CHARS} hidden={sending} />
              {/*
                Glyphs for eyes, the same contract in words for screen readers — see the component.
                `busySubject` is omitted: there is no agent here, so the busy sentence says "the current
                message" rather than naming something that does not exist.
              */}
              <ComposerKeyHint id={hintId} busy={sending} />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                aria-label="Send message"
                title="Send message"
                /*
                  ⚠ HOVER DARKENS, IT DOES NOT SWAP THE INK. The assistants' send buttons hover to their
                  light accent and flip the glyph to dark, because their accents are light fills. `brand-dark`
                  is darker than the resting blue, so white stays white (6.70:1) and there is no second ink
                  state to get wrong.
                */
                className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-strong text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
