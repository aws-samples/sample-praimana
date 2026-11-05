import { useState, useEffect, useRef, useCallback, useId } from "react";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { hastText } from "../lib/file-mentions";
/**
 * ⚠ WITHOUT THIS, THIS FILE'S OWN `table` / `th` / `td` RENDERERS WERE DEAD CODE.
 *
 * `react-markdown` ships CommonMark only, and CommonMark has no tables. So a pipe table arrived as
 * literal `| Finding | Effort |` text lines, the custom components below were never invoked, and the
 * one thing Kiro output leans on hardest — a summary table — rendered as punctuation. Adding the
 * plugin is what makes the table styling asked for from the reference images reachable at all.
 *
 * It also turns on strikethrough, task lists and autolinks, inert here for the same reason.
 */
import remarkGfm from "remark-gfm";
import kiroIcon from "../assets/kiro.png";
import claudeIcon from "../assets/claude.png";
import codexIcon from "../assets/codex.png";
import { parseChatOptions } from "../lib/option-buttons";
import { OptionButtons } from "./OptionButtons";
import { autoGrow } from "../lib/textarea";
import { SendIcon } from "./SendIcon";
/**
 * ⚠ THE SAME PICKER `AssistantChatView` USES, not a Kiro-flavoured copy of it — the identical reasoning as
 * `SendIcon` above. It was extracted from `AssistantChatView` for this import; see `ModelPicker.tsx`.
 */
import { ModelPicker } from "./ModelPicker";
import { type ModelOption } from "../lib/model-label";
import { CharCounter } from "./CharCounter";
import { ComposerKeyHint } from "./ComposerKeyHint";
import { MAX_AI_PROMPT_CHARS } from "@praimana/shared";
/**
 * ⚠ THESE EXISTED FOR MONTHS IN `AssistantChatView` AND NEVER HERE, which is the actual defect behind three
 * separate reports ("ai chats not showing synced", "copy is missing", "shared ai chat is not showing
 * the shared label"). Every one of those features was built once, wired into the Claude/Codex view,
 * and never into Kiro's — so switching assistant silently lost them. The same one-view-only mistake
 * as `kiro-acp.ts`'s private sync copy.
 */
import { SyncBadge, type MessageSyncStatus } from "./SyncBadge";
import { CopyButton } from "./CopyButton";
import { formatMessageInstant, formatClock, parseStoredInstant } from "../lib/instants";
import { summariseSync, describeSync } from "../lib/sync-summary";
import {
  readKiroContextUsage,
  shouldShowContextUsage,
  type KiroContextUsage,
} from "../lib/kiro-metadata";
import { assistantIdOf, assistantLabel } from "../lib/assistants";
import { composerPlaceholder } from "../lib/composer-placeholder";
import { useCurrentPhase } from "../hooks/useCurrentPhase";
import { useToast } from "./Toast";
import { scrollToLatest } from "../lib/scroll-to-latest";
import { PanePinSlot } from "./PanePinSlot";
import { PANE_HEADER, PANE_TITLE } from "../lib/pane-header";
import { PIN_DEFAULT_W, clampPinnedWidth } from "../lib/pinned-pane";
import { useThreadPagination, type PageFetcher } from "../lib/thread-pagination";
import { basenameOf } from "../lib/file-tree-ops";

const api = (window as any).electronAPI;

/* ─── Types ─────────────────────────────────────────────────────── */

interface ToolCallEntry {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  parameters?: Record<string, unknown>;
  output?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCallEntry[];
  /**
   * Whether this row reached the server. `db:getMessages` is a `SELECT *` and has ALWAYS returned
   * this column — the value was arriving and being thrown away, so the badge could not be rendered
   * for want of one line of type.
   */
  sync_status?: MessageSyncStatus;
  /**
   * When it was written, from the same `SELECT *`.
   *
   * ⚠ AND IT WAS BEING DROPPED IN EXACTLY THE SAME PLACE `sync_status` WAS — see `loadMessages`. Adding
   * the type alone would have compiled and rendered nothing at all, silently, which is what makes this
   * pair of edits one change rather than two.
   */
  created_at?: string;
}

interface KiroChatViewProps {
  project: { id: string; name: string; path: string };
  /**
   * Raised whenever a turn starts or finishes anywhere in this view — the same contract
   * `AssistantChatView` implements, for the same reason: the shell has no other way to know, and it
   * needs to know before it replaces the working folder underneath a running agent.
   */
  onBusyChange?: (busy: boolean) => void;
}

/* ─── Constants ─────────────────────────────────────────────────── */

const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  write: "✏️",
  shell: "⚡",
  grep: "🔍",
  glob: "📂",
  code: "🧠",
  web_search: "🌐",
  web_fetch: "🌐",
  WorkspaceSearch: "🔎",
  InternalCodeSearch: "🔎",
  InternalSearch: "🔎",
};

const STATUS_ICON: Record<string, string> = {
  running: "⏳",
  completed: "✓",
  failed: "✗",
};

/* ─── Component ─────────────────────────────────────────────────── */

/** Messages per page for the read-only shared-chat scroll-up pagination. Small on purpose. */
const SHARED_PAGE_SIZE = 5;

interface SharedThread {
  id: string;
  title: string | null;
  aiProvider?: string;
  sharedByName?: string;
  sharedAt?: string;
  updatedAt?: string;
}

interface SharedMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

export function KiroChatView({ project, onBusyChange }: KiroChatViewProps) {
  /** The workshop phase for the composer's placeholder — one cached read, shared with the other view. */
  const phaseName = useCurrentPhase();
  /**
   * Ties the composer to its keyboard description. `useId` rather than a constant: a chat can be
   * pinned beside another pane, so two composers may be in one document.
   */
  const hintId = useId();
  const [sessions, setSessions] = useState<{ id: string; title: string | null; ai_provider: string; updated_at: string; shared_at?: string | null }[]>([]);
  const [activeSession, setActiveSession] = useState<{ id: string; title: string | null; ai_provider: string; shared_at?: string | null } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  /**
   * ⚠ THE SAME OUTSTANDING-SYNC LINE AssistantChatView GETS, from the same shared helper. This view is a first-class
   * chat, so hiding the per-message badge for `synced` rows here without a conversation-level count would
   * leave Kiro users with no way to learn that anything failed.
   */
  const syncNotice = describeSync(summariseSync(messages));

  /**
   * ⚠ HOW FULL EACH CONVERSATION'S CONTEXT IS, from Kiro's `_kiro.dev/metadata` notification.
   *
   * Keyed by session because several can stream at once (EA-M1) — the same reason `streamingSessions` is a
   * map rather than a boolean. Kiro reports NO token counts at all (measured; see lib/kiro-metadata.ts), so
   * this is the one usage figure it offers that means anything on its own.
   *
   * In memory only, deliberately: it describes the live conversation's state, not a fact about a stored
   * message, so a column would be a second source of truth that goes stale the moment a turn is compacted.
   */
  const [contextUsage, setContextUsage] = useState<Record<string, KiroContextUsage>>({});
  // Draft input kept PER SESSION so an unsent message doesn't leak into another
  // chat on switch. Keyed by session id; the "new chat" draft uses the "" key.
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  // Runtime state keyed by session id so multiple Kiro chats stream at once
  // (EA-M1). Only the active session is on screen; background sessions keep
  // streaming and their turns persist to the DB, surfacing on switch-back.
  const [streamingSessions, setStreamingSessions] = useState<Record<string, boolean>>({});
  const [runningSessions, setRunningSessions] = useState<Record<string, boolean>>({});
  const [errorBySession, setErrorBySession] = useState<Record<string, string | null>>({});
  const [dbSessionId, setDbSessionId] = useState<string | null>(null);
  /**
   * ── ⚠ THE MODEL, WHICH THIS COMPOSER PREVIOUSLY COULD NOT CHOOSE ─────────────────────────
   *
   * `""` means "use Kiro's own default" and is NOT the same as naming the default explicitly — the main
   * process reads a stated model as grounds to respawn the ACP client, because `--model` only applies at
   * spawn. See the note at the `kiroAcpSend` call.
   *
   * ⚠ NOT PER SESSION, matching `AssistantChatView`. The picker is a setting for what you are about to send, and one
   * shared value is how the other composer behaves — two chats with silently different models would be a
   * more surprising design than a control that reads as global, and diverging from `AssistantChatView` here would
   * make the two views inconsistent in a way a participant switching between them would notice.
   */
  const [selectedModel, setSelectedModel] = useState("");
  /**
   * ── ⚠ "MAY I RUN THIS?", WHICH THIS VIEW COULD NOT ASK ───────────────────────────────────
   *
   * The flag is gone (kiro-trust.ts: file work stays pre-approved, everything that reaches outside the
   * project now asks), and this is where the question lands.
   *
   * ⚠ KEYED BY SESSION, because the prompt belongs to the chat that provoked it. Two Kiro chats can
   * each have a turn parked mid-tool-call, and a single `permissionRequest` value would show one
   * chat's question while the other's went unanswered — which does not merely mislay a dialog, it
   * hangs that turn until main's ten-minute backstop denies it.
   */
  const [permissionBySession, setPermissionBySession] = useState<
    Record<string, { id: string; description: string }>
  >({});
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  // Chat history panel lives on the RIGHT and is hidden by default; the history
  // icon in the header toggles it. Preference persists across launches.
  const [showHistory, setShowHistory] = useState(false);
  // Sharing + Team Chats state.
  const [hasTeam, setHasTeam] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [historyTab, setHistoryTab] = useState<"mine" | "team">("mine");
  const [sharedThreads, setSharedThreads] = useState<SharedThread[]>([]);
  const [viewingThread, setViewingThread] = useState<SharedThread | null>(null);
  /**
   * ── THE PINNED SHARED CHAT ────────────────────────────────────────────────────────────
   * A teammate's shared thread docked beside the live chat so the participant can keep working while
   * watching it update. SESSION-ONLY by request — plain component state, never written to settings, so
   * it clears on unmount and on a project switch (this component remounts per project). Separate from
   * `viewingThread` because the two can be on screen in different roles: you can be reading one thread
   * full-width while another stays pinned at the side.
   *
   * ⚠ THE MESSAGES THEMSELVES NO LONGER LIVE HERE. `SharedThreadPanel` owns its own paginated/
   * incremental message state (useThreadPagination) for both the viewer and the pinned pane; the
   * parent only says WHICH thread is in each role and signals when a team event should refresh.
   */
  const [pinnedThread, setPinnedThread] = useState<SharedThread | null>(null);
  /**
   * Width of the pinned pane in px, so it can be dragged. Session-only like the pin itself (never
   * persisted). Clamped on drag to [PIN_MIN_W, 42% of the window] so it can neither vanish nor crowd out
   * the live chat. `PIN_DEFAULT_W` (384) matches the old `w-96`.
   */
  const [pinnedWidth, setPinnedWidth] = useState(PIN_DEFAULT_W);
  /**
   * Bumped on each `ai-share` team event; the pinned `SharedThreadPanel` watches it and refreshes its
   * tail at once rather than waiting out the 15s poll. A counter, not a boolean, so repeated events
   * each register as a change.
   */
  const [sharedRefreshSignal, setSharedRefreshSignal] = useState(0);
  const toast = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Per-session accumulation of the in-flight turn (content + tool calls),
  // so concurrent sessions never merge into one buffer.
  const pendingRef = useRef<Map<string, { content: string; toolCalls: ToolCallEntry[] }>>(new Map());
  const getPending = (sid: string) => {
    let p = pendingRef.current.get(sid);
    if (!p) { p = { content: "", toolCalls: [] }; pendingRef.current.set(sid, p); }
    return p;
  };

  /**
   * Take a session's permission card off screen.
   *
   * ⚠ CLEARING THE CARD IS NOT ANSWERING IT. Main owns the answer, and every caller here runs when
   * the agent has already stopped waiting (turn ended, process exited, error) or right after the
   * answer was sent. Using this INSTEAD of responding would leave the agent parked until the
   * ten-minute backstop denied it — the hang this whole feature had to design around.
   */
  const dropPermission = useCallback((sessionId: string) => {
    setPermissionBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  /**
   * ── ⚠ THE TAB BADGE, DERIVED FROM STATE RATHER THAN ANNOUNCED AT EACH CALL SITE ───────────────
   *
   * ⚠ ONE EFFECT, NOT AN EVENT BESIDE EVERY `setPermissionBySession`. There are several places a prompt
   * appears or clears — the request arrives, the turn ends, the agent exits, it errors, and three buttons —
   * and dispatching from each is exactly the shape that has produced a differential bug in this codebase
   * every time: one site gets updated, its sibling does not. Watching the state means a new call site is
   * covered by construction.
   *
   * ⚠ A WINDOW EVENT, BECAUSE THE VIEW OUTLIVES THE TAB. App.tsx hides this pane rather than unmounting it,
   * so this component is still here holding the prompt while the user is on Board or Team Chat — the badge
   * needs a route to the rail, not a second source of truth in main to drift from the one the buttons act on.
   */
  useEffect(() => {
    const blocked = Object.keys(permissionBySession).length > 0;
    window.dispatchEvent(
      new CustomEvent(blocked ? "ai:permission-pending" : "ai:permission-resolved")
    );
  }, [permissionBySession]);

  // Values for the session currently displayed.
  const activeId = activeSession?.id ?? "";

  /* Derived AFTER `activeId`, which is declared below the state it reads — see the note on `contextUsage`. */
  const activeContextUsage = activeId ? contextUsage[activeId] ?? null : null;
  const streaming = activeId ? !!streamingSessions[activeId] : false;
  const acpRunning = activeId ? !!runningSessions[activeId] : false;
  /**
   * ── ⚠ STREAMING, NOT `runningSessions` ────────────────────────────────────────────────────────
   *
   * An ACP client that is merely ALIVE is not an agent doing work — it is a warm process waiting for
   * input, and treating that as "busy" would disable the folder switch permanently for anyone who
   * has ever sent a message. Only a turn in flight counts, and any session's turn counts, because
   * one keeps streaming while the participant reads another.
   */
  const anyTurnInFlight = Object.values(streamingSessions).some(Boolean);
  const permissionRequest = activeId ? permissionBySession[activeId] ?? null : null;
  const error = activeId ? errorBySession[activeId] ?? null : null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  useEffect(() => {
    onBusyChange?.(anyTurnInFlight);
  }, [anyTurnInFlight, onBusyChange]);
  /**
   * ⚠ RETRACTED ON UNMOUNT, or the shell latches "busy" forever and the working folder can never be
   * changed again — this view unmounts whenever the assistant is switched.
   */
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // Draft for the session on screen (keyed by activeId; "" key for a new chat).
  const input = draftBySession[activeId] ?? "";
  const setInput = (value: string) =>
    setDraftBySession((prev) => ({ ...prev, [activeId]: value }));

  // Id of the most recent assistant message — only it shows quick-reply buttons.
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  // Most recent user message — shown as a subtitle under the "Kiro" heading so
  // the current request stays visible while the agent works.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content;

  // Load sessions on mount and re-open the last active one so a restart doesn't
  // drop the user back to a blank chat (history is persisted in SQLite).
  useEffect(() => {
    (async () => {
      const result = await api.getSessions(project.id);
      setSessions(result);
      const lastId = await api.getSetting("active_session_id");
      const last = lastId && result.find((s: any) => s.id === lastId);
      if (last) handleSelectSession(last);
      const hist = await api.getSetting("chat_history_visible");
      setShowHistory(hist === "1");
      const teamId = await api.getSetting("team_id");
      setHasTeam(!!teamId);
    })();

    /**
     * ── ⚠ KIRO'S OWN MODEL CATALOGUE ─────────────────────────────────────────────────────────
     *
     * The same `cli:getModels` channel `AssistantChatView` uses. It is assistant-aware in main, so this receives
     * Kiro's catalogue and never Claude's — the rule that `model-list-scope.test.ts` exists to enforce.
     *
     * ⚠ NOT AWAITED INSIDE THE BLOCK ABOVE, deliberately. The Kiro call is MEASURED at 3–5 seconds
     * (`kiro-models.ts` spawns `kiro-cli chat --list-models`), and awaiting it in the same sequence as
     * `getSessions` would delay restoring the last conversation by that long on every mount. Fired
     * alongside instead, so the picker fills in when the answer arrives and nothing else waits on it.
     */
    api.cliGetModels().then((result: { models?: ModelOption[]; defaultModel?: string }) => {
      if (result?.models?.length) setAvailableModels(result.models);
      /* Stored even when the list is empty: a failed list does not make the default unknown. */
      if (typeof result?.defaultModel === "string") setDefaultModel(result.defaultModel);
    });
  }, [project.id]);

  async function loadSharedThreads() {
    const result = await api.getSharedThreads();
    setSharedThreads(result?.threads ?? []);
  }

  // Refresh the Team Chats list when the panel is on the Team tab, and whenever
  // a teammate shares/unshares (pushed over the team SSE stream).
  useEffect(() => {
    if (showHistory && historyTab === "team") loadSharedThreads();
  }, [showHistory, historyTab]);

  useEffect(() => {
    const handler = (data: { kind?: string }) => {
      if (data?.kind === "ai-share") {
        loadSharedThreads();
        // Bump the signal so a pinned SharedThreadPanel refreshes its tail at once (it owns the fetch
        // now). A counter so repeated events each count as a change.
        setSharedRefreshSignal((n) => n + 1);
      }
    };
    api.onTeamEvent(handler);
    return () => api.removeTeamEventListeners?.();
  }, []);

  /**
   * ── ⚠ THE BADGE FOLLOWS THE SYNC, INSTEAD OF GUESSING ─────────────────────────────────────
   *
   * `cli:response-complete` fires BEFORE the fire-and-forget sync writes `sync_status`, so the message list
   * reloaded on that event always read `pending` — and nothing told it to look again. The badge stayed on
   * "not synced, retry" for the rest of the session, for a message already stored on the server.
   *
   * ⚠ PATCHES THE NAMED ROWS RATHER THAN RELOADING. A reload mid-scroll moves the viewport, and this fires
   * on every turn; the event carries exactly the ids whose status changed, so there is nothing to re-read.
   */
  useEffect(() => {
    api.onSyncStatus?.((data: { ids: string[]; status: MessageSyncStatus }) => {
      if (!data?.ids?.length) return;
      const changed = new Set(data.ids);
      setMessages((prev) =>
        prev.some((m) => changed.has(m.id))
          ? prev.map((m) => (changed.has(m.id) ? { ...m, sync_status: data.status } : m))
          : prev
      );
    });
    return () => api.removeSyncStatusListeners?.();
  }, []);

  async function handleShare() {
    if (!activeSession || sharing) return;
    if (!hasTeam) {
      toast.error("Join a team before sharing a chat");
      return;
    }
    const confirmed = window.confirm(
      "Share this chat with your team?\n\nEveryone on your team will be able to read the full conversation."
    );
    if (!confirmed) return;

    setSharing(true);
    const result = await api.shareSession(activeSession.id);
    setSharing(false);
    if (result?.ok) {
      setActiveSession((prev) => (prev ? { ...prev, shared_at: result.sharedAt } : prev));
      setSessions((prev) =>
        prev.map((s) => (s.id === activeSession.id ? { ...s, shared_at: result.sharedAt } : s))
      );
      toast.success("Chat shared with your team");
    } else {
      toast.error(result?.error || "Failed to share chat");
    }
  }

  async function handleUnshare() {
    if (!activeSession || sharing) return;
    setSharing(true);
    const result = await api.unshareSession(activeSession.id);
    setSharing(false);
    if (result?.ok) {
      setActiveSession((prev) => (prev ? { ...prev, shared_at: null } : prev));
      setSessions((prev) =>
        prev.map((s) => (s.id === activeSession.id ? { ...s, shared_at: null } : s))
      );
      toast.success("Chat unshared");
    } else {
      toast.error(result?.error || "Failed to unshare chat");
    }
  }

  function openSharedThread(thread: SharedThread) {
    // The panel loads its own first page once it mounts with this thread.
    setViewingThread(thread);
  }

  /**
   * How `SharedThreadPanel` fetches pages and tails for a given shared thread. Bridges the hook's
   * `{ limit, before? } | { since }` request shape to the IPC method's `{ since?, before?, limit? }`
   * and normalises the response to `{ messages, nextBefore }`. `useCallback` keyed on nothing — the
   * threadId is bound per call by the panel through its `thread` prop, so one stable fetcher closes
   * over `api` only.
   */
  const makeSharedFetcher = useCallback(
    (threadId: string): PageFetcher<SharedMessage> =>
      async (args) => {
        const result = await api.getSharedMessages(threadId, args);
        return {
          messages: (result?.messages ?? []) as SharedMessage[],
          nextBefore: result?.nextBefore ?? null,
        };
      },
    []
  );

  function pinSharedThread(thread: SharedThread) {
    // Moving a thread from the full viewer into the side pane: close the takeover, open the dock.
    setViewingThread(null);
    setPinnedThread(thread);
  }

  function unpinSharedThread() {
    setPinnedThread(null);
  }

  /**
   * Drag-resize the pinned pane. The pane is anchored to the RIGHT (history drawer or window edge is
   * further right), so its width is the distance from the pointer to the right of the chat row — i.e.
   * `window.innerWidth - clientX`, minus the history drawer when it is open (240px / `w-60`). Pointer
   * capture on the handle keeps the drag alive even if the cursor outruns it; a clamp keeps the pane
   * between the min and 42% of the window.
   */
  function startPinnedResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const drawer = showHistory ? 240 : 0;
    const onMove = (ev: PointerEvent) => {
      const next = window.innerWidth - ev.clientX - drawer;
      setPinnedWidth(clampPinnedWidth(next, window.innerWidth));
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function toggleHistory() {
    setShowHistory((v) => {
      const next = !v;
      api.setSetting("chat_history_visible", next ? "1" : "0");
      return next;
    });
  }

  async function loadSessions() {
    const result = await api.getSessions(project.id);
    setSessions(result);
  }

  async function handleNewChat() {
    setActiveSession(null);
    setDbSessionId(null);
    setMessages([]);
    api.setSetting("active_session_id", "");
  }

  async function handleSelectSession(session: { id: string; title: string | null; ai_provider: string; shared_at?: string | null }) {
    setActiveSession(session);
    setDbSessionId(session.id);
    api.setSetting("active_session_id", session.id);
    await loadMessages(session.id);
  }

  /**
   * Read a session's messages from SQLite.
   *
   * ⚠ `sync_status` USED TO BE DROPPED RIGHT HERE. This mapping hand-picked `id`, `role` and
   * `content`, so the column `db:getMessages` returns (it is a `SELECT *`) was discarded one line
   * after arriving — which is the whole reason Kiro chats never showed a sync state. The badge was
   * not missing; its data was being thrown away.
   *
   * Extracted as a function because the retry button needs to re-read after a successful push.
   */
  async function loadMessages(sessionId: string) {
    const msgs = await api.getMessages(sessionId);
    setMessages(
      msgs.map((m: any) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        sync_status: m.sync_status,
        /* ⚠ THE SECOND COLUMN THIS MAPPING LOST. Same `SELECT *`, same silent discard — the timestamps
           were unrenderable here for the identical reason the badge was. */
        created_at: m.created_at,
      }))
    );
  }

  async function handleDeleteSession(id: string) {
    api.kiroAcpStop(id);
    pendingRef.current.delete(id);
    await api.deleteSession(id);
    if (activeSession?.id === id) {
      handleNewChat();
    }
    await loadSessions();
  }

  // Auto-scroll on new content
  useEffect(() => {
    scrollToLatest(messagesEndRef.current);
  }, [messages, streaming]);

  // Register ACP event listeners. Every event carries its own sessionId, so we
  // route accumulation and completion to the right session's buffer.
  useEffect(() => {
    // Clear any stale listeners first (handles React StrictMode double-mount)
    api.removeKiroAcpListeners();

    // Flush a completed/aborted turn: append the assistant message only if that
    // session is the one on screen (background turns are already persisted to
    // the DB by the main process and load on switch-back).
    const flushPending = (sid: string) => {
      const p = pendingRef.current.get(sid);
      if (p && p.content.trim() && sid === activeIdRef.current) {
        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: p.content.trim(),
          toolCalls: p.toolCalls.length > 0 ? [...p.toolCalls] : undefined,
          /*
            ⚠ AND `sync_status` TOO, OR THE BADGE APPEARS ANYWAY.

Hiding `synced` did not stop it, and neither did hiding `pending` — because a message built HERE had no status
at all. `undefined` is the UNTRACKED state, which renders a push control unconditionally, so the icon that
appeared on send was never the pending one. Two fixes aimed at the wrong branch.

            ⚠ THIS IS NOT A GUESS ABOUT THE ROW, it is what the row says. The main process writes this message
            as `pending` (kiro-acp.ts's `saveMessage`, and db.ts's `db:addMessage` for the other view), so the
            renderer's copy is now simply accurate — and accurate happens to be silent.
          */
          sync_status: "pending",
          /*
            ⚠ STAMPED HERE OR THE MESSAGE HAS NO TIME UNTIL YOU LEAVE AND COME BACK.

The markup was fine. This object is built in the RENDERER and appended straight to state, so it never had a
`created_at` at all; the DB row (written separately by the main process) does, and only `loadMessages` on a
session switch ever showed it.

            ⚠ AND IT STAYS OUT OF ANY DB PAYLOAD. `datetime('now')` writes `2026-08-14 20:13:58` — space, no
            zone — while this is ISO with a `Z`. Both parse correctly (see lib/instants.ts), but EIGHT queries
            order by this column AS A STRING, and for the same day `' '` (0x20) sorts before `'T'` (0x54), so a
            mixed format would silently reorder a transcript. The renderer's copy is for display only.
          */
          created_at: new Date().toISOString(),
        };
        setMessages((msgs) => [...msgs, msg]);
      }
      pendingRef.current.delete(sid);
    };

    const handleChunk = (data: { sessionId: string; content: string }) => {
      getPending(data.sessionId).content += data.content;
    };

    const handleToolCall = (data: {
      sessionId: string;
      id: string;
      name: string;
      status: string;
      parameters?: Record<string, unknown>;
      output?: string;
    }) => {
      const p = getPending(data.sessionId);
      const existing = p.toolCalls.find((t) => t.id === data.id);
      if (existing) {
        existing.status = data.status as ToolCallEntry["status"];
        if (data.output) existing.output = data.output;
      } else {
        p.toolCalls.push({
          id: data.id,
          name: data.name,
          status: data.status as ToolCallEntry["status"],
          parameters: data.parameters,
          output: data.output,
        });
      }
    };

    const handleToolUpdate = (data: {
      sessionId: string;
      id: string;
      name: string;
      status: string;
      output?: string;
    }) => {
      const existing = getPending(data.sessionId).toolCalls.find((t) => t.id === data.id);
      if (existing) {
        existing.status = data.status as ToolCallEntry["status"];
        if (data.output) existing.output = data.output;
      }
    };

    const handleTurnEnd = (data: { sessionId: string }) => {
      flushPending(data.sessionId);
      setStreamingSessions((prev) => ({ ...prev, [data.sessionId]: false }));
      // ⚠ A finished turn cannot act on an answer, so the card goes with it. Leaving it up would
      // invite a click that resolves nothing and read as the app ignoring the participant.
      dropPermission(data.sessionId);
      // Notify the unread hook so an off-tab response badges the Chat nav + chimes.
      window.dispatchEvent(new CustomEvent("ai:response-complete"));
    };

    const handleExited = (data: { sessionId?: string }) => {
      if (!data?.sessionId) return;
      flushPending(data.sessionId);
      // Main has already denied it (the agent is gone); this clears the question from the screen.
      dropPermission(data.sessionId);
      setRunningSessions((prev) => ({ ...prev, [data.sessionId!]: false }));
      setStreamingSessions((prev) => ({ ...prev, [data.sessionId!]: false }));
    };

    const handleError = (data: { error: string; sessionId?: string }) => {
      const sid = data.sessionId ?? activeIdRef.current;
      if (sid) {
        flushPending(sid);
        dropPermission(sid);
        setErrorBySession((prev) => ({ ...prev, [sid]: data.error }));
        setStreamingSessions((prev) => ({ ...prev, [sid]: false }));
      }
    };

    /**
     * Kiro's vendor notifications, of which only `_kiro.dev/metadata` is read.
     *
     * ⚠ THE OUTER `sessionId` IS THE RIGHT ONE, AND THERE ARE TWO. `data.sessionId` is the APP session id,
     * stamped by the main process so concurrent chats route correctly; `params.sessionId` is Kiro's own
     * native ACP session id, which nothing here is keyed by. Using the inner one would file every reading
     * under an id no chat has.
     *
     * ⚠ AND A NON-READING LEAVES THE LAST ONE STANDING. `readKiroContextUsage` returns null for other
     * notifications and for malformed payloads; overwriting with null on those would make the figure flicker
     * away on every MCP or command notification that happens to arrive next.
     */
    const handleNotification = (data: { sessionId: string; method: string; params: unknown }) => {
      const usage = readKiroContextUsage(data.method, data.params);
      if (!usage) return;
      setContextUsage((prev) => ({ ...prev, [data.sessionId]: usage }));
    };

    /**
     * The agent is asking. Filed under the app session id main stamped it with — the same routing
     * rule every other handler here follows.
     */
    const handlePermission = (data: {
      sessionId: string;
      id: string;
      toolCallId: string;
      description: string;
    }) => {
      setPermissionBySession((prev) => ({
        ...prev,
        [data.sessionId]: { id: data.id, description: data.description },
      }));
    };

    api.onKiroAcpMessageChunk(handleChunk);
    api.onKiroAcpPermissionRequest(handlePermission);
    api.onKiroAcpNotification(handleNotification);
    api.onKiroAcpToolCall(handleToolCall);
    api.onKiroAcpToolCallUpdate(handleToolUpdate);
    api.onKiroAcpTurnEnd(handleTurnEnd);
    api.onKiroAcpExited(handleExited);
    api.onKiroAcpError(handleError);

    // Cleanup: remove all listeners on unmount
    return () => {
      api.removeKiroAcpListeners();
    };
  }, []);

  // Stop every session's ACP client when the project changes or the view
  // unmounts. Individual sessions start lazily on first send (below).
  useEffect(() => {
    return () => {
      api.kiroAcpStop();
    };
  }, [project.path]);

  // Explicitly (re)start a session's ACP client. Used by the Retry button.
  async function startAcp(sessionId: string) {
    setErrorBySession((prev) => ({ ...prev, [sessionId]: null }));
    const result = await api.kiroAcpStart({ projectPath: project.path, sessionId });
    if (result.error) {
      setErrorBySession((prev) => ({ ...prev, [sessionId]: result.error }));
      setRunningSessions((prev) => ({ ...prev, [sessionId]: false }));
    } else {
      setRunningSessions((prev) => ({ ...prev, [sessionId]: true }));
    }
  }

  const handleSend = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text) return;

    // Create DB session on first message
    let sessionId = dbSessionId;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      const title = text.slice(0, 50);
      await api.createSession({
        id: sessionId,
        projectId: project.id,
        title,
        aiProvider: "kiro",
      });
      setDbSessionId(sessionId);
      setActiveSession({ id: sessionId, title, ai_provider: "kiro" });
      api.setSetting("active_session_id", sessionId);
      loadSessions();
    }

    // Guard against double-send into the same in-flight session.
    if (streamingSessions[sessionId]) return;

    // Add user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      /* Display-only, same as the assistant's above — see the note there. */
      created_at: new Date().toISOString(),
      /* And its real status, for the reason recorded above: absent reads as UNTRACKED, which always draws. */
      sync_status: "pending",
    };
    setMessages((prev) => [...prev, userMsg]);
    // Clear the draft for both the sent session and the "new chat" ("") key,
    // since a first message promotes the new-chat draft into a real session.
    setDraftBySession((prev) => ({ ...prev, [sessionId!]: "", "": "" }));
    setStreamingSessions((prev) => ({ ...prev, [sessionId!]: true }));
    setErrorBySession((prev) => ({ ...prev, [sessionId!]: null }));

    // Resize textarea back
    if (textareaRef.current) autoGrow(textareaRef.current);

    // Pass projectPath so the main process can lazily start this session's
    // client if it isn't already running (e.g. a fresh chat or a revived one).
    const result = await api.kiroAcpSend({
      sessionId,
      message: text,
      projectPath: project.path,
      /**
       * ⚠ OMITTED WHEN NOTHING WAS CHOSEN, not sent as "". The main process treats a stated model as
       * grounds to RESTART the ACP client — `--model` only applies at spawn, since `session/set_model` is
       * not answered by kiro-cli — so sending an empty string on every turn would be indistinguishable
       * from a request for Kiro's default and could respawn a client that was deliberately started with a
       * model. Absent means "no preference"; see `ensureClient`.
       */
      ...(selectedModel ? { model: selectedModel } : {}),
    });

    if (result.error) {
      setErrorBySession((prev) => ({ ...prev, [sessionId!]: result.error }));
      setStreamingSessions((prev) => ({ ...prev, [sessionId!]: false }));
    } else {
      setRunningSessions((prev) => ({ ...prev, [sessionId!]: true }));
    }
  }, [input, streamingSessions, dbSessionId, project, selectedModel]);

  const handleCancel = useCallback(async () => {
    if (!activeId) return;
    await api.kiroAcpCancel(activeId);
    setStreamingSessions((prev) => ({ ...prev, [activeId]: false }));
  }, [activeId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    autoGrow(e.target);
  };

  // Keep the textarea height in sync with the per-session draft (e.g. after
  // switching sessions or clearing on send) so it doesn't keep a stale height.
  useEffect(() => {
    if (textareaRef.current) autoGrow(textareaRef.current);
  }, [input]);

  return (
    <div className="flex-1 flex h-full bg-surface-bg">
      {/* Chat area */}
      {/* ⚠ `min-w-0` IS LOad-BEARING: without it this flex item keeps its intrinsic min-width (the
          composer, long bubbles) and refuses to shrink, so dragging the pinned shared pane wider would
          overflow instead of trading space. With it, the live chat gives up width to the pinned pane. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/*
        ── READ-ONLY VIEWER FOR A TEAMMATE'S SHARED CHAT ─────────────────────────────────────
        ⚠ IN THE WINDOW, NOT A POPUP. This was a `fixed inset-0` modal over a dimmed backdrop; it now
        reads like the chat window itself — same column shell, same transcript, just no
        composer because it is read-only. It renders the shared chat's OWN assistant throughout, never
        Kiro's — this viewer exists to read OTHER people's conversations.

        TWO STATES:
          · VIEWING (not pinned) — it TAKES OVER this column, so the live header/transcript/composer
            below are gated off. The only extra controls are a 📌 pin and the way back to your own chat.
          · PINNED — it leaves this column (the live chat renders normally, composer and all) and docks
            as a SECOND column to the right (see the pinned pane after `</div> close chat area`). That is
            how a participant keeps working while watching a teammate's chat update. Pins do NOT persist
            across restarts — this is "watch what they're doing right now", session-only state.
      */}
      {viewingThread && !pinnedThread ? (
        <SharedThreadPanel
          thread={viewingThread}
          pinned={false}
          fetcher={makeSharedFetcher(viewingThread.id)}
          onClose={() => setViewingThread(null)}
          onTogglePin={() => pinSharedThread(viewingThread)}
        />
      ) : (
      <>
      {/* Header */}
      {/* ⚠ THE `pr-9` RESERVATION IS GONE: the pane pin is no longer an overlay in this pane's corner, so
          there is nothing to keep off the controls at this row's right edge. It renders beside the title. */}
      <div className={`relative justify-between bg-surface-panel ${PANE_HEADER}`}>
        <div className="flex items-center gap-2 min-w-0">
          <img src={kiroIcon} alt="Kiro" className="w-5 h-5 rounded flex-shrink-0" />
          <span className={PANE_TITLE}>Kiro</span>
          {/* Beside the name, for the same reason as in `AssistantChatView`. */}
          <PanePinSlot />
          {acpRunning && (
            <span className="w-2 h-2 rounded-full bg-tool-ok" title="Connected" />
          )}
          {!acpRunning && !error && (
            <span className="w-2 h-2 rounded-full bg-surface-muted" title="Disconnected" />
          )}
        </div>
        {/* Session start message — bold, centered, independent of side widths */}
        {activeSession?.title && (
          <p
            className="absolute left-1/2 -translate-x-1/2 max-w-[45%] truncate text-sm font-semibold text-surface-text text-center pointer-events-none"
            title={activeSession.title}
          >
            {activeSession.title}
          </p>
        )}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/*
            ⚠ "2 MESSAGES NOT SYNCED" — the wording and the tone come from the shared helper, so this view
            cannot drift into making a claim AssistantChatView would not make. Renders nothing when nothing is
            outstanding. The red matches the `failed` badge it refers to (`tool-error-text`, 7.22:1 as words).
          */}
          {/*
            ── ⚠ CONTEXT FULLNESS, ONCE IT IS WORTH KNOWING ──

            Kiro reports no tokens, so this stands where `AssistantChatView` shows `12.4k ctx · 3.1k out`. It is not
            the same quantity and is not labelled as though it were: a percentage of the window, not a count.

            ⚠ HIDDEN BELOW THE THRESHOLD, for the reason the sync badge was just stripped back — every turn
            reports this, and a permanent "11% context" is an indicator that is always lit. It appears when
            compacting becomes a real consideration, and turns amber when it is close.
          */}
          {shouldShowContextUsage(activeContextUsage) && (
            <span
              className={`mr-1 text-[10px] tabular-nums ${
                activeContextUsage!.percent >= 85 ? "text-tool-warning" : "text-surface-faint"
              }`}
              title={
                `This conversation is using ${activeContextUsage!.percent}% of Kiro's context window. ` +
                `Kiro reports no token counts, so this percentage is the whole of what it measures.`
              }
            >
              {activeContextUsage!.percent}% context
            </span>
          )}
          {syncNotice && (
            <span
              className={`mr-1 text-[10px] tabular-nums ${
                syncNotice.tone === "warn" ? "text-tool-error-text" : "text-surface-faint"
              }`}
              title={
                syncNotice.tone === "warn"
                  ? "These messages did not reach your team. Press the ↻ on a message to retry it."
                  : "Still being sent to your team."
              }
            >
              {syncNotice.text}
            </span>
          )}
          {acpRunning && activeId && (
            <button
              onClick={() => { api.kiroAcpStop(activeId); setRunningSessions((prev) => ({ ...prev, [activeId]: false })); }}
              className="text-xs text-surface-muted hover:text-tool-error-text transition-colors mr-1"
              title="Disconnect"
            >
              Disconnect
            </button>
          )}
          {/* Share-with-team control — only meaningful once a chat exists. */}
          {activeSession && (
            activeSession.shared_at ? (
              <div className="flex items-center gap-1">
                <span
                  className="flex items-center gap-1 rounded-full bg-surface-raised px-2 py-1 text-xs font-medium text-tool-ok"
                  title={`Shared with your team${activeSession.shared_at ? ` on ${parseStoredInstant(activeSession.shared_at).toLocaleString()}` : ""}`}
                >
                  <ShareIcon /> Shared
                </span>
                <button
                  onClick={handleUnshare}
                  disabled={sharing}
                  className="p-1.5 rounded text-surface-muted hover:bg-surface-raised hover:text-surface-text transition-colors disabled:opacity-50"
                  title="Stop sharing with your team"
                  aria-label="Unshare chat"
                >
                  <UnshareIcon />
                </button>
              </div>
            ) : (
              <button
                onClick={handleShare}
                disabled={sharing || !hasTeam}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-surface-muted hover:bg-surface-raised hover:text-surface-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={hasTeam ? "Share this chat with your team" : "Join a team to share chats"}
                aria-label="Share chat with team"
              >
                <ShareIcon /> Share
              </button>
            )
          )}
          <button
            onClick={handleNewChat}
            className="p-1.5 rounded text-surface-muted hover:bg-surface-raised hover:text-surface-text transition-colors"
            title="New chat"
            aria-label="New chat"
          >
            <NewChatIcon />
          </button>
          <button
            onClick={toggleHistory}
            className={`p-1.5 rounded transition-colors ${showHistory ? "bg-surface-raised text-kiro-accent" : "text-surface-muted hover:bg-surface-raised hover:text-surface-text"}`}
            title={showHistory ? "Hide chat history" : "Show chat history"}
            aria-label="Toggle chat history"
          >
            <HistoryIcon />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-surface-panel border-b border-surface-line text-sm text-tool-error-text flex items-center justify-between">
          <span>⚠️ {error}</span>
          {activeId && (
            <button onClick={() => startAcp(activeId)} className="text-xs underline hover:no-underline">
              Retry
            </button>
          )}
        </div>
      )}

      {/* Last user input — a standalone bar below the Kiro header and above the
          chat window (detached: own card with margin, not attached to the
          header), mirroring the Claude Code layout. */}
      {lastUserMessage && (
        <div className="mx-4 mt-3 rounded-lg border border-surface-line bg-surface-panel px-4 py-2.5">
          <p className="text-sm text-surface-text truncate" title={lastUserMessage}>
            {lastUserMessage}
          </p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ minHeight: 0 }}>
        {messages.length === 0 && !streaming && !activeSession && (
          <WelcomeState />
        )}

        {messages.length === 0 && !streaming && activeSession && (
          <EmptyState />
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            /*
              ⚠ THE SESSION'S OWN ASSISTANT, not Kiro's icon regardless.

This view can display a chat created by ANY assistant — it is read-only for those, but it still renders them —
and the avatar was hardcoded, so every message claimed Kiro wrote it.
            */
            provider={activeSession?.ai_provider}
            showOptions={msg.id === lastAssistantId && !streaming}
            onSelectOption={(label) => handleSend(label)}
            /* So a successful retry re-reads the row rather than leaving a stale badge. */
            onRetried={() => { if (dbSessionId) void loadMessages(dbSessionId); }}
          />
        ))}

        {/*
          ── THE "Working…" BAR, AS THE REFERENCE IMAGE DRAWS IT ─────────────────────────────
          A bordered strip stating what is happening, with the way out on the same line — replacing
          three bouncing dots and a caption.

          ⚠ THE CANCEL IS HERE BECAUSE THIS IS WHERE SOMEONE LOOKS FOR IT. The composer's Stop
          button is kept (it is where a Claude user's hand already is), so there are deliberately
          TWO ways to stop a turn, wired to the same `handleCancel` — not two behaviours.

          ⚠ `role="status"` + `aria-live="polite"`, which the dots never had: a purely visual
          animation told a screen-reader user nothing about the turn being in flight. Polite, not
          assertive, so it waits for a pause instead of interrupting the reply being read out.
        */}
        {/*
          ── ⚠ THE PERMISSION CARD, WHICH KIRO'S VIEW NEVER HAD ─────────────────────────────
          Kiro ran with `--trust-all-tools`, so it never asked and this had nothing to render. Now
          shell, AWS, network and MCP tools ask (kiro-trust.ts).

          ⚠ IT IS PLACED ABOVE THE "Working…" BAR AND SUPPRESSES IT. The turn genuinely is not
          progressing while this is up — `session/prompt` does not resolve until it is answered — so
          leaving "Working…" on screen beside it would be the app stating something untrue. The same
          truthfulness rule AssistantChatView applies with `streaming && !permissionRequest`.

          ⚠ THE COLOURS ARE THE ESTABLISHED ONES, NOT NEW ONES. `tool-warning` for the heading and
          border, `bg-surface-panel` for the fill, matching AssistantChatView's card — this is the
          same class of decision and must not look like a different kind of event. `tool-warning` on
          this fill is legal for text (see tailwind.config.ts); `tool-error` at 3.87:1 would not be.
        */}
        {permissionRequest && (
          <div
            role="alert"
            className="rounded-lg border border-tool-warning/40 bg-surface-panel px-3 py-3"
          >
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="flex-shrink-0 text-lg">⚠️</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-tool-warning">Permission required</p>
                {/*
                  Kiro's OWN sentence — "Running: rm -rf build", "Creating probe.txt". It names the
                  actual command, which is the only thing that makes an approval an informed one, so
                  it is shown verbatim in a mono face and never summarised to a tool name.
                */}
                <p className="mt-0.5 break-all font-mono text-xs text-surface-text">
                  {permissionRequest.description}
                </p>
                <p className="mt-1 text-xs text-surface-muted">
                  Reading and writing files in this project is already allowed. This step does
                  something else — running a command, calling AWS, or reaching the network.
                </p>
              </div>
              <div className="flex flex-shrink-0 gap-2">
                <button
                  onClick={() => {
                    api.kiroAcpPermissionRespond({
                      sessionId: activeId,
                      id: permissionRequest.id,
                      allow: false,
                    });
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: crypto.randomUUID(),
                        role: "system",
                        content: `❌ Denied: ${permissionRequest.description}`,
                      },
                    ]);
                    dropPermission(activeId);
                  }}
                  className="rounded-md border border-surface-line px-3 py-1.5 text-xs text-surface-text transition-colors hover:bg-surface-raised"
                >
                  Deny
                </button>
                {/**
                  * ── ⚠ APPROVE THE REST OF THIS CHAT'S SHELL COMMANDS ──────────────────────────
                  *
                  * The AI-DLC orchestrator runs each step through `bun`, so each step is a shell call, so
                  * each step asked the same question and got the same answer.
                  *
                  * ⚠ THIS IS NOT "ALWAYS". kiro-cli offers an `allow_always` option and the app still
                  * refuses to select it, because it writes a rule into `~/.kiro` that outlives this app and
                  * applies to the participant's own terminal. This grant is held in main's memory, keyed by
                  * this chat, and dropped when the session stops — so the blast radius is one conversation.
                  *
                  * ⚠ AND `execute_bash` IS STILL NOT TRUSTED. The first shell command of a chat is a real
                  * question with a real refusal; kiro-trust.ts's line is unmoved. What is removed is being
                  * asked again for work already agreed to.
                  */}
                <button
                  onClick={() => {
                    api.kiroAcpPermissionRespond({
                      sessionId: activeId,
                      id: permissionRequest.id,
                      allow: true,
                      remember: true,
                    });
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: crypto.randomUUID(),
                        role: "system",
                        content:
                          `✅ Approved for this chat: ${permissionRequest.description}` +
                          ` — further commands in this conversation will not ask again.`,
                      },
                    ]);
                    dropPermission(activeId);
                  }}
                  className="rounded-md border border-surface-line px-3 py-1.5 text-xs text-surface-text transition-colors hover:bg-surface-raised"
                >
                  Allow for this chat
                </button>
                <button
                  onClick={() => {
                    api.kiroAcpPermissionRespond({
                      sessionId: activeId,
                      id: permissionRequest.id,
                      allow: true,
                    });
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: crypto.randomUUID(),
                        role: "system",
                        content: `✅ Approved: ${permissionRequest.description}`,
                      },
                    ]);
                    dropPermission(activeId);
                  }}
                  /*
                    ⚠ NOT THE SEND BUTTON'S COLOUR, for the reason AssistantChatView states: making the
                    consequential control look like the everyday one invites the muscle memory of
                    clicking it without reading.
                  */
                  className="rounded-md bg-tool-warning px-3 py-1.5 text-xs font-medium text-surface-bg transition-opacity hover:opacity-90"
                >
                  Allow once
                </button>
              </div>
            </div>
          </div>
        )}

        {streaming && !permissionRequest && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-lg border border-surface-line bg-surface-panel px-3 py-2"
          >
            <SessionIcon provider="kiro" size="sm" />
            <span className="text-xs font-medium text-surface-text">Working…</span>
            {/*
              The pulse is the only decorative part, and it is `aria-hidden` — the live region above
              already says it. A single dot rather than three: the sentence carries the meaning now.
            */}
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kiro-accent"
            />
            <button
              onClick={handleCancel}
              className="ml-auto rounded-md border border-surface-line bg-surface-raised px-2.5 py-1 text-xs font-medium text-surface-text transition-colors hover:border-tool-error hover:text-tool-error-text"
            >
              Cancel
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {activeSession && activeSession.ai_provider !== "kiro" && activeSession.ai_provider !== "kiro-cli" ? (
        <div className="border-t border-surface-line bg-surface-panel px-4 py-3 text-center">
          <span className="text-xs text-surface-muted">
            Read-only — this chat was created with <span className="font-medium">{activeSession.ai_provider}</span>. Switch assistant to continue.
          </span>
        </div>
      ) : (
      /*
        ── THE COMPOSER, MATCHED TO CLAUDE'S AND CODEX'S ──

        ⚠ THIS IS THE ONE PART OF THIS FILE CHANGED STRUCTURALLY. An earlier round of this work
        narrowed Kiro to a palette-only pass, deliberately, because the file carries the whole ACP integration.
        The composer is now brought in line deliberately — and nothing else is touched: the same
        `handleInputChange`, `handleKeyDown`, `handleSend` and `handleCancel` are wired to the same controls.

        ONE BORDERED CARD whose border lights on `focus-within`, rather than a bare textarea beside two buttons.
        The card is what makes the group read as one thing you type into, and focus shows on the whole composer
        instead of a hairline around an inner box.
      */
      <div className="border-t border-surface-line bg-surface-bg p-3">
        <div className="rounded-lg border border-surface-line bg-surface-panel transition-colors focus-within:border-kiro-accent">
          <textarea
            ref={textareaRef}
            value={input}
            /*
              ⚠ A COURTESY, NOT A CONTROL: any client may decline to honour it. The NUMBER comes
              from @praimana/shared so the desktop, the portal and the server mean the same
              thing by "too long" — chat-limits.ts records which of them actually enforces it.
            */
            maxLength={MAX_AI_PROMPT_CHARS}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            /**
             * ⚠ THROUGH THE SHARED HELPER, not two hardcoded strings. This view only ever renders Kiro
             * sessions, so the literals were harmless — but `lib/assistants.ts` exists precisely because
             * this app has two vocabularies for naming an assistant, and its header lists three reported
             * bugs caused by a local copy. One fewer copy, and identical wording to the other composer.
             */
            placeholder={composerPlaceholder({
              assistant: "kiro",
              projectName: project.name,
              phaseName,
              streaming,
            })}
            /**
             * ⚠ `readOnly`, NOT `disabled` — and this is a real fix carried across from Claude's composer, not
             * a cosmetic change.
             *
             * A disabled textarea DROPS FOCUS the moment a turn starts and cannot take it back, so the
             * participant had to click into the box again after every single reply. `readOnly` keeps focus, the
             * caret and keyboard navigation while still refusing input, and `handleKeyDown` already guards the
             * send while streaming so nothing can be submitted.
             *
             * `aria-disabled` states it for assistive tech, which `readOnly` alone does not convey as
             * "temporarily unavailable".
             */
            readOnly={streaming}
            aria-disabled={streaming}
            /**
             * ⚠ AN ACCESSIBLE NAME, which this box did not have. With no label and no `aria-label`, a
             * screen reader announced an unnamed multiline text box whose only description was the
             * placeholder — and this app's placeholder now changes with the workshop phase, so it was
             * never a dependable name. `aria-describedby` carries the keyboard contract and, mid-turn,
             * the reason the box is inert.
             */
            aria-label="Message Kiro"
            aria-describedby={hintId}
            rows={1}
            /*
              BORDERLESS AND TRANSPARENT: the card draws the border and the fill, so an inner border here would
              be a box inside a box. `outline-none` is safe because the card shows focus via `focus-within`.
            */
            className={`w-full resize-none overflow-y-hidden bg-transparent px-3.5 py-3 text-sm leading-5 outline-none ${
              streaming
                ? "cursor-default text-surface-muted placeholder:text-surface-muted"
                : "text-surface-text placeholder:text-surface-muted"
            }`}
            style={{ minHeight: "44px", maxHeight: "200px" }}
          />

          {/* The action row, inside the card — as in Claude's composer. */}
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0">
            {/*
              ── ⚠ THE MODEL PICKER, IN THE SAME PLACE CLAUDE'S SITS ────────────────────────────

              Left of the row, before the `ml-auto` group, which is exactly where `AssistantChatView` puts it: the
              model is a setting for what you are about to send, and the send control is the action. A
              participant switching assistants finds the same control in the same position.

              ⚠ `dark` IS UNCONDITIONALLY TRUE HERE, and that is not a shortcut — this composer is only ever
              rendered on the dark Kiro surface (`surface-*` tokens throughout this file), unlike `AssistantChatView`
              which serves both. Passing a computed value would imply a light variant exists to be tested.

              ⚠ AND IT DISAPPEARS ON ITS OWN when the catalogue is empty — a Kiro install that cannot be
              enumerated shows no picker rather than an empty one. That behaviour lives in the shared
              component, which is the point of sharing it.
            */}
            <ModelPicker
              selectedModel={selectedModel}
              onSelect={setSelectedModel}
              options={availableModels}
              defaultModel={defaultModel}
              disabled={streaming}
              dark
            />

            <div className="ml-auto flex items-center gap-2">
              {/*
                The keyboard hint, moved OUT of the placeholder. A placeholder vanishes the moment you start
                typing, so the one affordance a new user needs disappeared exactly when they were about to use
                it. Hidden while streaming, when Enter does nothing.
              */}
              <CharCounter value={input} max={MAX_AI_PROMPT_CHARS} hidden={streaming} />
              {/* Glyphs for eyes, the same contract in words for screen readers — see the component. */}
              <ComposerKeyHint id={hintId} busy={streaming} busySubject="Kiro" />

              {streaming ? (
                <button
                  onClick={handleCancel}
                  aria-label="Stop generating"
                  /*
                    A SQUARE STOP GLYPH rather than the word in red — red on this surface reads as an error
                    rather than a control, and the filled square is the universal stop mark. The label stays for
                    screen readers.
                  */
                  className="flex h-8 items-center gap-1.5 rounded-md border border-surface-line bg-surface-raised px-3 text-xs font-medium text-surface-text transition-colors hover:border-tool-error hover:text-tool-error-text"
                >
                  <span aria-hidden="true" className="text-[9px] leading-none">■</span>
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim()}
                  aria-label="Send message"
                  title="Send message"
                  /*
                    `kiro-strong` (#2563eb) and not `accent`: this fill carries the glyph, so it is held to
                    1.4.11's 3:1 as a SHAPE (3.43:1 against the page) as well as AA for what sits on it
                    (white, 5.17:1). blue-700 carried white better and measured 2.65:1 as a shape — a
                    button whose own outline was under the minimum.
                  */
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-kiro-strong text-white transition-colors hover:bg-kiro-accent hover:text-surface-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      )}
      </>
      )}
      </div> {/* close chat area */}

      {/*
        ── THE PINNED SHARED CHAT, DOCKED AS A SECOND COLUMN ─────────────────────────────────
        Sits between the live chat and the history drawer, with the same left divider the real pinned
        panes use (`border-l border-surface-line`), so it reads as a second pane and not part of the
        chat. The live composer on the left stays usable — this is the whole point of pinning rather
        than taking over. Session-only: `pinnedThread` is component state, so it clears on unmount and
        on a project switch (this component remounts per project).
      */}
      {pinnedThread && (
        <div
          className="relative flex flex-col overflow-hidden border-l border-surface-line"
          style={{ width: pinnedWidth, flex: "0 0 auto" }}
        >
          {/*
            ── DRAG-TO-RESIZE HANDLE ─────────────────────────────────────────────────────────
            A thin strip on the pane's LEFT edge (the side facing the live chat). `col-resize` cursor,
            widened hit area via negative inset so it is grabbable without being a visible bar. Pointer
            events so it works for mouse and touch; `role="separator"` + arrow keys for the keyboard.
          */}
          <div
            onPointerDown={startPinnedResize}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setPinnedWidth((w) => clampPinnedWidth(w + 24, window.innerWidth));
              if (e.key === "ArrowRight") setPinnedWidth((w) => clampPinnedWidth(w - 24, window.innerWidth));
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize shared chat pane"
            tabIndex={0}
            className="absolute left-0 top-0 z-10 h-full w-1.5 -ml-0.5 cursor-col-resize hover:bg-kiro-accent/30 focus:bg-kiro-accent/40 focus:outline-none"
          />
          <SharedThreadPanel
            thread={pinnedThread}
            pinned
            fetcher={makeSharedFetcher(pinnedThread.id)}
            refreshSignal={sharedRefreshSignal}
            onClose={() => setPinnedThread(null)}
            onTogglePin={() => unpinSharedThread()}
          />
        </div>
      )}

      {/* Chat history panel (right side, toggled by the header history icon) */}
      {showHistory && (
        <div className="w-60 border-l border-surface-line bg-surface-panel flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-xs font-semibold text-surface-muted uppercase tracking-wide">Chat History</span>
            <button
              onClick={toggleHistory}
              className="p-1 rounded text-surface-muted hover:bg-surface-raised hover:text-surface-text transition-colors"
              title="Hide chat history"
              aria-label="Hide chat history"
            >
              ✕
            </button>
          </div>
          {/* Tabs: my local chats vs. chats shared by teammates. */}
          <div className="flex border-b text-xs">
            <button
              onClick={() => setHistoryTab("mine")}
              className={`flex-1 px-3 py-2 font-medium transition-colors ${
                historyTab === "mine"
                  ? "text-kiro-accent border-b-2 border-kiro-accent"
                  : "text-surface-muted hover:text-surface-text"
              }`}
            >
              Chats
            </button>
            <button
              onClick={() => setHistoryTab("team")}
              className={`flex-1 px-3 py-2 font-medium transition-colors ${
                historyTab === "team"
                  ? "text-kiro-accent border-b-2 border-kiro-accent"
                  : "text-surface-muted hover:text-surface-text"
              }`}
            >
              Team Chats
            </button>
          </div>

          {historyTab === "mine" ? (
            <>
              <div className="p-2">
                <button
                  onClick={handleNewChat}
                  className="w-full text-left rounded border border-dashed border-surface-line px-3 py-2 text-xs text-surface-muted hover:bg-surface-raised hover:border-kiro-accent transition-colors"
                >
                  + New Chat
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-0.5">
                {sessions.length === 0 && (
                  <p className="text-[11px] text-surface-muted px-3 py-2">No previous chats yet.</p>
                )}
                {sessions.map((session) => {
                  /*
                    ⚠ NORMALISED, not compared literally. `ai_provider` stores "kiro" while `ai_command` is
                    "kiro-cli" — the two vocabularies that caused the reported read-only inversion in the Claude
                    view. This branch happened to enumerate BOTH spellings and so was correct by accident;
                    `assistantIdOf` makes it correct on purpose, and by the same rule everywhere.
                  */
                  const isKiroSession = assistantIdOf(session.ai_provider) === "kiro";
                  return (
                    <div
                      key={session.id}
                      className={`group flex items-center rounded px-3 py-2 text-xs cursor-pointer ${
                        activeSession?.id === session.id
                          ? "bg-surface-raised text-surface-text"
                          : "hover:bg-surface-raised text-surface-muted hover:text-surface-text"
                      }`}
                      onClick={() => handleSelectSession(session)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {/*
This row hardcoded `kiroIcon` for EVERY chat and merely greyed it out for other assistants — so a Codex chat
appeared as a washed-out Kiro logo rather than as Codex. It now draws the icon of whatever actually made the
chat; the dimming stays, because "not usable from here" is separate information from "which assistant".
                          */}
                          <SessionIcon
                            provider={session.ai_provider}
                            dimmed={!isKiroSession}
                          />
                          <span className="truncate font-medium flex-1">{session.title || "Untitled"}</span>
                          {/*
                            ⚠ A WORD, NOT A DOT. The shared label was missing from the chat history.

                            It WAS marked, by a 1.5px dot in `bg-tool-ok` — the same size and the SAME
                            COLOUR as the streaming indicator immediately after it, differing only by
                            `animate-pulse`. So "my team can see this conversation" was encoded as a
                            6px circle ambiguous with "currently generating".

                            AssistantChatView was fixed earlier and this view was not, which is the pattern
                            behind three of tonight's four reports.
                          */}
                          {session.shared_at && (
                            <span
                              className="flex-shrink-0 rounded-sm bg-tool-ok/15 px-1 text-[9px] font-medium uppercase tracking-wide text-tool-ok"
                              title="Shared with your team"
                            >
                              Shared
                            </span>
                          )}
                          {streamingSessions[session.id] && (
                            <span className="w-1.5 h-1.5 rounded-full bg-tool-ok animate-pulse flex-shrink-0" title="Streaming" />
                          )}
                          {!isKiroSession && (
                            <span className="text-[9px] bg-surface-raised text-surface-text px-1 rounded flex-shrink-0">
                              {session.ai_provider}
                            </span>
                          )}
                        </div>
                        {session.updated_at && (
                          <div className="text-[10px] text-surface-muted mt-0.5 ml-5">
                            {/*
                              ⚠ BOTH HALVES WERE `new Date(session.updated_at)` DIRECTLY, and that is where
                              the hour-out bug came from: `updated_at` is SQLite's `datetime('now')` — UTC
                              with no zone marker — which V8 reads as local. See lib/instants.ts.

                              ⚠ THE DATE WAS THE WORSE HALF. An hour's error on the clock is cosmetic; the
                              same error on the DATE names the wrong DAY for anything written within the
                              offset of midnight, which on this list is how you find a conversation.
                            */}
                            {parseStoredInstant(session.updated_at).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                            {formatClock(session.updated_at)}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                        className="opacity-0 group-hover:opacity-100 text-surface-muted hover:text-tool-error-text text-xs ml-1 flex-shrink-0"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {!hasTeam && (
                <p className="text-[11px] text-surface-muted px-3 py-2">Join a team to see chats shared by your teammates.</p>
              )}
              {hasTeam && sharedThreads.length === 0 && (
                <p className="text-[11px] text-surface-muted px-3 py-2">No chats have been shared with your team yet.</p>
              )}
              {sharedThreads.map((thread) => (
                <button
                  key={thread.id}
                  onClick={() => openSharedThread(thread)}
                  className="w-full text-left rounded px-3 py-2 text-xs mb-0.5 hover:bg-surface-raised text-surface-muted hover:text-surface-text"
                >
                  <div className="flex items-center gap-1.5">
                    {/*
                      This list is entirely OTHER PEOPLE's shared chats, so a hardcoded Kiro logo was wrong for
                      almost every row — a teammate's Claude conversation appeared as Kiro's. The disc stays for an
                      unknown provider because the icon column is what aligns the rows here.
                    */}
                    <SessionIcon provider={thread.aiProvider} />
                    <span className="truncate font-medium flex-1">{thread.title || "Untitled"}</span>
                  </div>
                  <div className="text-[10px] text-surface-muted mt-0.5 ml-5">
                    {thread.sharedByName ? `Shared by ${thread.sharedByName}` : "Shared"}
                    {thread.sharedAt && (
                      <>
                        {" · "}
                        {parseStoredInstant(thread.sharedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

/* ─── Icons ────────────────────────────────────────────────────── */

function NewChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

function UnshareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * ── A PIN GLYPH ──────────────────────────────────────────────────────────────────────────
 * Filled when pinned, outline when not, so the toggle's state reads without the label. Matches the
 * weight of the other 14px header glyphs in this file.
 */
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/* ─── Sub-components ───────────────────────────────────────────── */

/**
 * ── READ-ONLY SHARED-CHAT PANEL ───────────────────────────────────────────────────────────
 *
 * A teammate's conversation, rendered IN THE WINDOW (not a modal) with the same transcript treatment
 * as the live chat but NO composer — it is read-only. One component serves both roles:
 *   · full takeover of the chat column (`pinned === false`), with a ← back control, and
 *   · a narrower pinned side-pane (`pinned === true`), with a live "updated Xs ago" indicator.
 *
 * ⚠ IT OWNS ITS OWN PAGINATION (useThreadPagination). A multi-day thread is opened one 5-message
 * page at a time, newest first; older pages load as the reader scrolls to the TOP (prepended, with
 * the scroll position held so the view does not jump). The pinned pane also appends only the tail
 * NEWER than what it holds — on a 15s poll and on each `refreshSignal` bump (a team `ai-share` event)
 * — never refetching the whole transcript.
 *
 * ⚠ NO AUTO-SCROLL ON NEW MESSAGES, by request. This is a teammate's chat; yanking the reader to the
 * bottom when a new turn arrives would fight them while they read older context. New tail rows land
 * below; the reader goes to them if and when they choose.
 *
 * ⚠ THE SHARED CHAT'S OWN ASSISTANT throughout, never Kiro's — this reads OTHER people's chats, so the
 * provider is almost never Kiro's. Assistant replies go through `AssistantMarkdown` (never a bare
 * ReactMarkdown — see chat-view-parity.test.ts), user turns stay plain text.
 */
function SharedThreadPanel({
  thread,
  pinned,
  fetcher,
  refreshSignal,
  onClose,
  onTogglePin,
}: {
  thread: SharedThread;
  pinned: boolean;
  /** How to fetch a page / tail for THIS thread. Must be stable per thread (useCallback in parent). */
  fetcher: PageFetcher<SharedMessage>;
  /** Bumped by the parent on a team `ai-share` event, so the pinned pane refreshes at once. */
  refreshSignal?: number;
  onClose: () => void;
  onTogglePin: () => void;
}) {
  const { messages, loading, loadingOlder, hasMore, refreshedAt, openNewest, loadOlder, refreshTail } =
    useThreadPagination<SharedMessage>(fetcher, SHARED_PAGE_SIZE);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Open the newest page when the thread changes (mount, or re-pin to a different thread).
  useEffect(() => {
    void openNewest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  // Pinned pane: poll the tail every 15s. Interval cleared on unpin/unmount.
  useEffect(() => {
    if (!pinned) return;
    const timer = setInterval(() => void refreshTail(true), 15_000);
    return () => clearInterval(timer);
  }, [pinned, refreshTail]);

  // Pinned pane: a team ai-share event (via refreshSignal) refreshes the tail immediately.
  useEffect(() => {
    if (!pinned || !refreshSignal) return;
    void refreshTail(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  /**
   * Scroll-up pagination. When the reader reaches the top AND there is an older page, load it and
   * HOLD the scroll position: measure scrollHeight before, restore the delta after the prepend, so
   * the rows they were reading stay under the cursor instead of jumping.
   */
  function onScroll() {
    const el = scrollRef.current;
    if (!el || loadingOlder || !hasMore) return;
    if (el.scrollTop <= 0) {
      const before = el.scrollHeight;
      void loadOlder().then(() => {
        const after = scrollRef.current;
        if (after) after.scrollTop = after.scrollHeight - before;
      });
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-bg">
      {/* Header — the same panel row as the live chat's, so the pane reads as a chat window. */}
      <div className={`relative justify-between bg-surface-panel ${PANE_HEADER}`}>
        <div className="flex min-w-0 items-center gap-2">
          {!pinned && (
            <button
              onClick={onClose}
              className="rounded p-1 text-surface-muted transition-colors hover:bg-surface-raised hover:text-surface-text"
              title="Back to your chat"
              aria-label="Back to your chat"
            >
              ←
            </button>
          )}
          <SessionIcon provider={thread.aiProvider} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-surface-text">
              {thread.title || "Untitled"}
            </div>
            <div className="text-[11px] text-surface-muted">
              {thread.sharedByName ? `Shared by ${thread.sharedByName}` : "Shared with your team"}
              {" · read-only"}
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {/* The live indicator only means something for the pinned, polling pane. */}
          {pinned && <LiveIndicator loading={loading} lastRefreshed={refreshedAt} />}
          {/*
            Pin toggles the pane's role: full viewer → side dock, or dock → gone. The verb matches the
            direction so the control is honest in both states.
          */}
          <button
            onClick={onTogglePin}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              pinned
                ? "text-kiro-accent hover:bg-surface-raised"
                : "text-surface-muted hover:bg-surface-raised hover:text-surface-text"
            }`}
            title={pinned ? "Unpin this chat" : "Pin beside your chat and keep it live"}
            aria-label={pinned ? "Unpin shared chat" : "Pin shared chat"}
            aria-pressed={pinned}
          >
            <PinIcon filled={pinned} />
            {pinned ? "Unpin" : "Pin"}
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-surface-muted transition-colors hover:bg-surface-raised hover:text-surface-text"
            title="Close"
            aria-label="Close shared chat"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Transcript — same bubble + markdown treatment as the live chat, no composer below it. */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 space-y-3 overflow-y-auto p-4">
        {/* Top-of-list affordance for older pages. A spinner while fetching, a quiet hint otherwise. */}
        {hasMore && (
          <p className="text-center text-[11px] text-surface-faint">
            {loadingOlder ? "Loading earlier messages…" : "Scroll up for earlier messages"}
          </p>
        )}
        {loading && messages.length === 0 && (
          <p className="mt-8 text-center text-xs text-surface-muted">Loading conversation…</p>
        )}
        {!loading && messages.length === 0 && (
          <p className="mt-8 text-center text-xs text-surface-muted">This chat has no messages.</p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="flex justify-end gap-2">
            <div
              className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm ${
                msg.role === "user"
                  ? "bg-kiro-bubble text-surface-text"
                  : "bg-surface-panel text-surface-text prose prose-sm max-w-none prose-pre:bg-surface-bg prose-pre:text-surface-text prose-pre:rounded-md prose-pre:text-xs prose-pre:my-2 prose-code:text-kiro-accent prose-code:before:content-none prose-code:after:content-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0"
              }`}
            >
              {msg.role === "user" ? (
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              ) : (
                <AssistantMarkdown content={msg.content} />
              )}
            </div>
            {msg.role !== "user" && (
              <SessionIcon provider={thread.aiProvider} size="lg" placeholder="none" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * ── "LIVE · UPDATED Xs AGO" ───────────────────────────────────────────────────────────────
 * A quiet confirmation that the pinned pane is polling, since the content is a teammate's and will not
 * change on anything the reader does. Shows a pulsing dot + "live" while a refresh is in flight, then
 * the elapsed time since the last successful refresh. The clock is driven by a 1s local tick so the
 * number counts up between the 15s fetches rather than freezing.
 */
function LiveIndicator({ loading, lastRefreshed }: { loading: boolean; lastRefreshed: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <span className="mr-1 flex items-center gap-1 text-[10px] text-tool-ok" title="Refreshing…">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-tool-ok" />
        live
      </span>
    );
  }
  if (lastRefreshed == null) return null;
  const secs = Math.max(0, Math.round((Date.now() - lastRefreshed) / 1000));
  const label = secs < 5 ? "just now" : secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  return (
    <span
      className="mr-1 flex items-center gap-1 text-[10px] tabular-nums text-surface-faint"
      title="This pane refreshes every 15 seconds and when a teammate shares an update."
    >
      <span className="h-1.5 w-1.5 rounded-full bg-tool-ok/60" />
      updated {label}
    </span>
  );
}

function WelcomeState() {
  return (
    <div className="flex-1 flex items-center justify-center text-surface-muted py-20">
      <div className="text-center max-w-sm">
        <img src={kiroIcon} alt="Kiro" className="w-14 h-14 mx-auto mb-4 rounded-xl" />
        <p className="text-base font-medium text-surface-text mb-2">Welcome to Kiro</p>
        <p className="text-sm text-surface-muted mb-4">
          Ask about your code, request changes, debug issues, or get help with development tasks.
        </p>
        <p className="text-xs text-surface-faint mb-3">
          Type a message below to start a new chat, or select an existing conversation from the sidebar.
        </p>
        <p className="text-xs text-surface-faint bg-surface-panel inline-block px-3 py-1.5 rounded-full">
          🔒 Messages are saved locally and synced with your experience for progress insights only.
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-surface-muted py-20">
      <div className="text-center">
        <img src={kiroIcon} alt="Kiro" className="w-12 h-12 mx-auto mb-3 opacity-60 rounded-lg" />
        <p className="text-sm font-medium text-surface-text">Kiro Agent</p>
        <p className="text-xs mt-1 text-surface-muted">
          Ask about your code, request changes, or get help with tasks.
        </p>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  provider,
  showOptions,
  onSelectOption,
  onRetried,
}: {
  message: ChatMessage;
  /**
   * Which assistant produced this chat. Absent for a brand-new session, where Kiro is the author by definition —
   * hence the `?? "kiro"` at the render below rather than a neutral gap on a chat the user is actively using.
   */
  provider?: string | null;
  showOptions?: boolean;
  onSelectOption?: (label: string) => void;
  /** Re-read the row after a successful retry, so the badge stops saying "not synced". */
  onRetried?: () => void;
}) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="text-xs text-surface-muted bg-surface-panel px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        {/*
          ⚠ THE SYNC ICON IS IN THE CORNER, NOT UNDER THE TEXT — the same change AssistantChatView's bubble got, and
          for the same reason: on the right, next to the message, rather than below it, where it increased the
          message box height. `pr-7` reserves its column so it cannot land on the
          last word.

          `onLight` stays FALSE: unlike Codex's terracotta, this fill is a dark navy, so the normal ink is
          already legible on it (`surface-muted` measures 3.97:1 there) and the light variant would be the
          LOWER-contrast choice.
        */}
        {/*
          ⚠ A COLUMN, so the time is a SIBLING BELOW the bubble rather than ink inside it — outside
          and below the box, as in team chat messages. `max-w-[80%]` moves here — the cap has to
          resolve against the row, and a sibling stamp cannot live inside the bubble's width.
        */}
        <div className="flex max-w-[80%] flex-col items-end">
        {/* `pr-9` reserves the corner: ONE 24×24 target plus the 6px inset. It was `pr-16` while copy shared
            the corner; that icon is gone from the user's own message — see AssistantChatView for the reasoning. */}
        <div className="relative max-w-full rounded-xl bg-kiro-bubble px-4 py-2.5 pr-9 text-sm text-surface-text">
          <span className="absolute right-1.5 top-1.5 flex items-center">
            <SyncBadge status={message.sync_status} messageId={message.id} onRetried={onRetried} />
          </span>
          <pre className="whitespace-pre-wrap font-sans m-0">{message.content}</pre>
        </div>
        {/*
          ⚠ WHEN IT WAS SENT, BELOW THE BOX. This view never rendered a message time in either role. Out here
          it is on the page rather than on the `kiro-bubble` fill, so `faint` is legal — inside the bubble it
          would have needed `white/70`, which is the ink this replaced.
        */}
        {formatMessageInstant(message.created_at) && (
          <span className="mt-0.5 text-[10px] tabular-nums text-surface-faint">
            {formatMessageInstant(message.created_at)}
          </span>
        )}
        </div>
      </div>
    );
  }

  /**
   * ── THE ASSISTANT'S TURN IS FULL WIDTH, RULED OFF ABOVE ───────────────────────────────────
   *
   * ⚠ THE AVATAR GUTTER IS GONE, and that is the substantive change rather than a tidy-up. A 32px
   * icon column plus its gap took ~44px off EVERY line of every reply, and this view's content is
   * the widest in the app: findings tables, fenced code, file paths. In a pinned half-width pane
   * that gutter was the difference between a five-column table fitting and scrolling. The images
   * show the same thing — Kiro's replies run the full column, and only the participant's own turns
   * are inset, which is what makes the two readable apart.
   *
   * ⚠ SO AUTHORSHIP NEEDED A REPLACEMENT CUE, because the icon WAS the cue. It is now the rule
   * above the turn plus the alignment contrast with the user's inset box — a hairline separator
   * exactly as the images use between sections. Both survive without colour.
   *
   * `border-t` on the turn, not a `<hr>` between turns: a separator element between siblings needs
   * to know whether it is first, and gets it wrong on re-render.
   *
   * `?? "kiro"` is retained below for the timeline dot's provider — a session with no recorded
   * provider, viewed in KIRO's own component, is Kiro's: this view is only reachable when Kiro is
   * selected, and a new chat has no provider until its first turn is saved.
   */
  return (
    <div className="border-t border-surface-line pt-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex items-center gap-2">
        <SessionIcon provider={provider ?? "kiro"} size="sm" />
        <span className="text-xs font-medium text-surface-muted">{assistantLabel(provider ?? "kiro")}</span>
      </div>
      <div className="min-w-0 space-y-2">
        {message.toolCalls?.map((tool) => (
          <ToolCallBlock key={tool.id} tool={tool} />
        ))}
        {message.content && (
          <div className="prose prose-sm max-w-none text-surface-text prose-pre:bg-surface-panel prose-pre:text-surface-text prose-pre:rounded-lg prose-pre:text-xs prose-pre:my-2 prose-code:text-kiro-accent prose-code:before:content-none prose-code:after:content-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1.5">
            <MarkdownRenderer content={message.content} />
          </div>
        )}
        {showOptions && onSelectOption && (
          <OptionButtons options={parseChatOptions(message.content)} onSelect={onSelectOption} />
        )}
        {/*
          The reply's own footer. `label="Copy reply"` rather than "Copy message", so a screen reader
          hears which half of the turn it acts on — the two controls are otherwise identical.
        */}
        <div className="flex items-center gap-2 pt-0.5">
          <SyncBadge status={message.sync_status} messageId={message.id} onRetried={onRetried} />
          <CopyButton text={message.content} label="Copy reply" />
          {/* Free: this row exists for the reply's controls regardless. */}
          {formatMessageInstant(message.created_at) && (
            <span className="text-[10px] tabular-nums text-surface-faint">
              {formatMessageInstant(message.created_at)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolCallBlock({ tool }: { tool: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[tool.name] || "🔧";
  const statusIcon = STATUS_ICON[tool.status] || "⏳";
  const statusColor =
    tool.status === "completed" ? "text-tool-ok" :
    tool.status === "failed" ? "text-tool-error-text" :
    "text-tool-warning";

  // Generate a human-readable summary
  const summary = getToolSummary(tool);

  return (
    <div className={`rounded-lg border text-xs ${
      tool.status === "running" ? "border-tool-warning/40 bg-surface-panel" :
      tool.status === "failed" ? "border-tool-error/40 bg-surface-panel" :
      "border-surface-line bg-surface-panel"
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-black/5 rounded-lg transition-colors"
      >
        <span className={`${statusColor} flex-shrink-0`}>
          {tool.status === "running" ? (
            <span className="inline-block animate-spin">⏳</span>
          ) : (
            statusIcon
          )}
        </span>
        <span className="flex-shrink-0">{icon}</span>
        <span className="font-medium text-surface-text truncate">{summary}</span>
        <span className="ml-auto text-surface-muted flex-shrink-0">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-surface-line pt-2">
          {tool.parameters && Object.keys(tool.parameters).length > 0 && (
            <div>
              <span className="text-surface-muted font-medium">Parameters:</span>
              <pre className="mt-1 p-2 bg-surface-bg border border-surface-line text-surface-text rounded text-[11px] overflow-x-auto max-h-40 overflow-y-auto">
                {JSON.stringify(tool.parameters, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <span className="text-surface-muted font-medium">Output:</span>
              <pre className="mt-1 p-2 bg-surface-bg border border-surface-line text-surface-text rounded text-[11px] overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">
                {tool.output.length > 2000 ? tool.output.slice(0, 2000) + "\n... (truncated)" : tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ⚠ THE MARKDOWN ITSELF IS `AssistantMarkdown` NOW, and this is only Kiro's styling of it.
 *
 * Its `a` — an underlined blue external link — has gone with it. That component decides between "opens a tab
 * in this window" and "leaves for a browser" for all three assistants, and a second `a` here would have
 * quietly taken the decision back for Kiro alone. See AssistantMarkdown.tsx for why it cannot be shadowed.
 */
function MarkdownRenderer({ content }: { content: string }) {
  return (
    <AssistantMarkdown
      content={content}
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, node, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const language = match?.[1] || "";
          /*
            ⚠ THE HAST NODE, NOT `String(children)`. A file mention inside an INLINE span makes one child a
            React element, and `String()` of that is "[object Object]" — which was silently both the copy
            button's payload and the test below for "is this inline". The node is the only place the span's
            actual text still exists.
          */
          const codeString = hastText(node).replace(/\n$/, "");

          // Inline code
          if (!className && !codeString.includes("\n")) {
            return (
              <code className="bg-surface-raised text-kiro-accent px-1.5 py-0.5 rounded text-xs font-mono" {...props}>  // nosemgrep: react-props-spreading
                {children}
              </code>
            );
          }

          // Block code
          return (
            <div className="relative group my-2">
              <div className="flex items-center justify-between bg-surface-panel px-3 py-1 rounded-t-lg">
                <span className="text-xs text-surface-muted font-mono">{language || "text"}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(codeString)}
                  className="text-xs text-surface-muted hover:text-surface-text opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded hover:bg-surface-raised"
                >
                  Copy
                </button>
              </div>
              <pre className="!mt-0 !rounded-t-none">
                <code className={className} {...props}>  // nosemgrep: react-props-spreading
                  {children}
                </code>
              </pre>
            </div>
          );
        },
        /**
         * ── THE TABLE, AS THE REFERENCE IMAGES DRAW IT ────────────────────────────────────
         *
         * A header band, ruled cells and striped body rows. Reachable at all only because
         * `remarkGfm` is now installed — see the import.
         *
         * ⚠ `text-surface-text` IN THE CELLS, NOT `muted`. The body was `surface-muted`
         * (#9ca3af), which is a 2.54:1 dimming applied to the densest text in the view — a
         * findings table is read cell by cell, and it was the one place the palette pushed
         * contrast DOWN. Muted is for labels about content, not the content.
         */
        table({ children }) {
          return (
            /* `block` + overflow so a wide table scrolls itself rather than stretching the turn. */
            <div className="my-3 overflow-x-auto rounded-lg border border-surface-line">
              <table className="min-w-full border-collapse text-xs">{children}</table>
            </div>
          );
        },
        thead({ children }) {
          /* The band. Carried on the row group so it survives a table with no explicit `th`. */
          return <thead className="bg-surface-raised">{children}</thead>;
        },
        th({ children }) {
          return (
            <th className="border-b border-surface-line px-3 py-2 text-left font-semibold text-surface-text">
              {children}
            </th>
          );
        },
        tr({ children }) {
          /*
            Striping via `even:` on the row rather than a wrapper, because ReactMarkdown gives no
            index here. `bg-surface-panel/40` is a lift of about 4% — enough to follow a row
            across five columns, not enough to read as a second surface.
          */
          return <tr className="even:bg-surface-panel/40">{children}</tr>;
        },
        td({ children }) {
          return (
            <td className="border-t border-surface-line px-3 py-2 align-top text-surface-text">
              {children}
            </td>
          );
        },
      }}
    />
  );
}

/* ─── Helpers ──────────────────────────────────────────────────── */

function getToolSummary(tool: ToolCallEntry): string {
  const params = tool.parameters || {};

  switch (tool.name) {
    case "read":
      return `Read ${getFileName(params.path as string) || params.file_path || "file"}`;
    case "write":
      return `Write ${getFileName(params.path as string) || "file"}`;
    case "shell":
      return `Run: ${truncate(params.command as string, 60)}`;
    case "grep":
      return `Search: ${truncate(params.pattern as string, 40)}`;
    case "glob":
      return `Find: ${truncate(params.pattern as string, 40)}`;
    case "code":
      return `Code: ${params.operation || "analyze"}`;
    case "web_search":
      return `Search: ${truncate(params.query as string, 50)}`;
    case "WorkspaceSearch":
      return `Workspace: ${truncate(params.searchQuery as string, 50)}`;
    case "InternalCodeSearch":
    case "InternalSearch":
      return `Search: ${truncate(params.query as string, 50)}`;
    default:
      return tool.name;
  }
}

/**
 * The display name for a path in a tool-call row.
 *
 * ⚠ THIS ONE CANNOT BE FIXED IN THE MAIN PROCESS, which is why the whole class is handled in the
 * renderer. These paths come from the AGENT — they arrive inside `rawInput` on a `session/update`
 * frame, verbatim JSON that main forwards without inspecting — so there is no boundary at which they
 * could be normalised, and on Windows the agent emits `\`.
 */
function getFileName(filePath: string | undefined): string {
  if (!filePath) return "";
  return basenameOf(filePath) || filePath;
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

/**
 * The avatar for one chat in the history list.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN REUSING AssistantChatView's `AIIcon`: that one is sized for a message row (24px) and is
 * local to a component Kiro must not import from — the two views are deliberately separate. Same rule, different
 * size, so the RULE is shared (`assistantIdOf`) and only the markup is local.
 *
 * @param dimmed the chat cannot be continued from this view — a Claude or Codex chat seen in Kiro's history.
 *   Dimming says "not usable here"; the ICON says which assistant. Conflating them is the reported bug.
 */
function SessionIcon({
  provider,
  dimmed,
  size = "sm",
  placeholder = "disc",
}: {
  provider: string | null | undefined;
  dimmed?: boolean;
  /** "sm" for a history row (16px), "lg" for a transcript avatar (24px). */
  size?: "sm" | "lg";
  /**
   * What to render for an UNKNOWN provider.
   *
   *   "disc"  a neutral "?" — for a LIST, where the icon column keeps rows aligned.
   *   "none"  nothing — for a TRANSCRIPT, where a "?" per message is repeated noise. The chosen
   *           behaviour: better no icon at all for chat messages.
   */
  placeholder?: "disc" | "none";
}) {
  const box = size === "lg" ? "w-6 h-6 rounded-full" : "w-4 h-4 rounded";
  const cls = `${box} flex-shrink-0 ${dimmed ? "opacity-40 grayscale" : ""}`;
  const id = assistantIdOf(provider);
  if (id === "kiro") return <img src={kiroIcon} alt="Kiro" className={cls} />;
  if (id === "codex") return <img src={codexIcon} alt="Codex" className={cls} />;
  if (id === "claude") return <img src={claudeIcon} alt="Claude" className={cls} />;
  if (placeholder === "none") return null;
  // Unknown, in a list — a neutral mark rather than a guess at which assistant made it.
  return (
    <span
      aria-hidden="true"
      title="Unknown assistant"
      className={`flex items-center justify-center bg-surface-raised text-[9px] text-surface-muted ${cls}`}
    >
      ?
    </span>
  );
}
