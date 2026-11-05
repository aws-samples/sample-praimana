import { useState, useEffect, useRef, useCallback, useId } from "react";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { parseChatOptions } from "../lib/option-buttons";
import { OptionButtons } from "./OptionButtons";
import { ActivityPhrase } from "./ActivityPhrase";
import { ToolStep, ToolStepOverflow, TimelineRow } from "./ToolStep";
import { SendIcon } from "./SendIcon";
import { CharCounter } from "./CharCounter";
import { cacheSavings, describeTotals, formatTokens, totalTokens } from "../lib/token-display";
import { MessageTokens } from "./MessageTokens";
import { IconTooltip } from "./IconTooltip";
import { PanePinSlot } from "./PanePinSlot";
import { MAX_AI_PROMPT_CHARS } from "@praimana/shared";
import { SyncBadge, type MessageSyncStatus } from "./SyncBadge";
import { formatMessageInstant } from "../lib/instants";
import { summariseSync, describeSync } from "../lib/sync-summary";
import { CopyButton } from "./CopyButton";
import { assistantIdOf, assistantLabel, canSendInSession } from "../lib/assistants";
import { composerPlaceholder } from "../lib/composer-placeholder";
import { ComposerKeyHint } from "./ComposerKeyHint";
import { useCurrentPhase } from "../hooks/useCurrentPhase";
/**
 * ⚠ THE ACCENTS ARE PER-ASSISTANT NOW. This view renders Claude AND Codex, and every accent in it was
 * hardcoded to Claude's terracotta — reported as "the input model is orange box". See the module for why
 * the mapping is data rather than sixteen inline ternaries.
 */
import { assistantTheme } from "../lib/assistant-theme";
import {
  appendText,
  appendToolUse,
  applyToolResult,
  pruneRetainedTurns,
  type TranscriptBlock,
} from "../lib/transcript";
/* `resolveModel` went with the picker (see ModelPicker.tsx); the option TYPE is still this view's state. */
import { type ModelOption } from "../lib/model-label";
import { ModelPicker } from "./ModelPicker";
import { autoGrow } from "../lib/textarea";
import { useToast } from "./Toast";
import { scrollToLatest } from "../lib/scroll-to-latest";

const api = (window as any).electronAPI;

/**
 * ── THE TRANSCRIPT IS NO LONGER A COLUMN OF BUBBLES ──
 *
 * It was: right-aligned rounded bubbles capped at `max-w-[75%]`, on white, with an avatar per row. It is
 * now the VS Code extension's layout — full-width flowing text on a near-black surface, each step marked
 * by a dot on a continuous timeline spine, tool calls rendered as labelled IN/OUT panels.
 *
 * WHY THE WHOLE LAYOUT AND NOT JUST A REPAINT. The bubble was the reason a turn looked dead. It could
 * only hold ONE STRING, so the only thing it could show was prose — and an agentic turn is mostly not
 * prose. Every command Claude ran was invisible, which is exactly why it could look stuck or
 * idle. A 75%-wide bubble is also the wrong shape for the content: an 80-column
 * command wraps four times inside it.
 *
 * ⚠ EVERY VALUE HERE WAS READ OUT OF THE EXTENSION'S OWN STYLESHEET, at
 * `~/.vscode/extensions/anthropic.claude-code-2.1.226-darwin-arm64/webview/index.css`, rather than
 * matched by eye against a screenshot. That mattered more than expected — four things looked right and
 * were wrong: the spinner is a six-glyph cycle and not a rotating ✳, the word list is the extension's own
 * 84 and not the CLI binary's 145, the "bullets" are a timeline with a connecting rule, and the tool
 * panel's clip is a gradient mask rather than a crop. See ToolStep.tsx and ActivityPhrase.tsx for the
 * rule-by-rule provenance.
 */

/**
 * The assistant's prose, in the dark transcript.
 *
 * `prose-invert` is the whole reason this is short: the typography plugin's dark variant already handles
 * headings, links, blockquotes and table borders, and hand-overriding each of those is how a fork drifts.
 *
 * ── ⚠ CODE SPANS WEAR THE ASSISTANT'S OWN INK, NOT CLAUDE'S ───────────────────────────────
 *
 * This was a constant containing `prose-code:text-claude-accent`, so every inline code span in a CODEX
 * reply was rendered in Claude's terracotta — on a view Claude and Codex share. The colour is now derived
 * from the active assistant's theme, which is where "what colour is this assistant" is already decided.
 *
 * Each accent is legal as prose ink on this surface: claude 5.28:1, kiro 8.14:1, codex 9.96:1 on
 * `surface-panel`. `accent` and not `strong` remains deliberate for Claude — `strong` (#a8432c) measures
 * 2.24:1 here and fails; the pair exists so the choice has to be made explicitly rather than inherited.
 */
function assistantProseClass(proseCode: string): string {
  return (
    "prose prose-sm max-w-none text-surface-text " +
    "prose-pre:bg-surface-panel prose-pre:border-[.5px] prose-pre:border-surface-line " +
    "prose-pre:rounded-[5px] prose-pre:text-[.85em] prose-pre:my-2 " +
    `${proseCode} prose-code:before:content-none prose-code:after:content-none ` +
    "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0"
  );
}

/**
 * A stable empty array, so `blocksBySession[id] ?? EMPTY_BLOCKS` returns the SAME reference every render
 * for a session that has no in-flight turn. A fresh `[]` there would be a new dependency identity on
 * every render and would defeat the scroll effect's change detection.
 */
const EMPTY_BLOCKS: TranscriptBlock[] = [];

/** Messages per page for the read-only shared-chat scroll-up pagination. Mirrors KiroChatView. */
const SHARED_PAGE_SIZE = 5;
/**
 * ⚠ `assistantLabel` MOVED TO `lib/assistants.ts`.
 *
 * It was a local three-line mapping keyed on `ai_command` ("kiro-cli"). The same question is asked of a
 * SESSION's `ai_provider` ("kiro") elsewhere, and having two vocabularies compared by two different pieces of
 * code is what produced the read-only and icon bugs. One normaliser now serves both.
 */

/**
 * A bubble on the DARK surface — Codex's transcript, the in-flight stream beside it, and the
 * teammate's shared-chat viewer.
 *
 * ⚠ THE LIGHT `SHARED_BUBBLE_CLASS` IS GONE, and the comment that justified it was stale.
 *
 * It read "a modal over the app's own light chrome, not the transcript — inverting one panel inside a
 * light dialog would read as a rendering fault". That was true when written. It stopped being true
 * when `usesDarkSurface` became unconditionally `true`: there is no light chrome left to sit over, so
 * the dialog was the only light thing in the app — a white flash over a dark window, its background
 * not matching the desktop theme.
 *
 * ⚠ THE CODE-SPAN INK COMES FROM THE ASSISTANT, for the reason given on `assistantProseClass` above: this
 * bubble renders CODEX's transcript as well as the shared-chat viewer, and a hardcoded terracotta put
 * Claude's colour inside Codex's messages. `accent` and not `strong` stays deliberate for Claude — strong
 * (#a8432c) is 2.24:1 on this background and fails, accent is 5.28:1.
 */
function darkBubbleClass(proseCode: string): string {
  return (
    "bg-surface-panel border border-surface-line text-surface-text prose prose-sm max-w-none " +
    "prose-pre:bg-surface-bg prose-pre:text-surface-text prose-pre:rounded-md prose-pre:text-xs prose-pre:my-2 " +
    `${proseCode} prose-code:before:content-none prose-code:after:content-none ` +
    "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0"
  );
}

import claudeIcon from "../assets/claude.png";
import kiroIcon from "../assets/kiro.png";
import codexIcon from "../assets/codex.png";
import { PANE_HEADER, PANE_TITLE } from "../lib/pane-header";
import { PIN_DEFAULT_W, clampPinnedWidth } from "../lib/pinned-pane";
import { useThreadPagination, type PageFetcher } from "../lib/thread-pagination";

/**
 * The assistant's avatar.
 *
 * Two faults produced that, and this fixes the second one. The first was the CALLER passing
 * `session.ai_provider || currentCli` — so a chat with no stored provider took on whichever assistant was
 * selected, and switching to Kiro relabelled every untagged chat in the list.
 *
 * The second is here: the old resolver ended in `: claudeIcon`, so an unknown provider was silently drawn as
 * Claude. `assistantIdOf` returns null for that case and the neutral mark below is what an unknown chat gets —
 * which is honest, and is what makes the caller's fix visible rather than just moving the wrong answer.
 */
function AIIcon({
  provider,
  dark = true,
  placeholder = "disc",
}: {
  provider: string | null | undefined;
  dark?: boolean;
  /**
   * What to render when the provider is UNKNOWN.
   *
   *   "disc"  a neutral "?" — for a LIST, where the icon column keeps rows aligned.
   *   "none"  nothing at all — for a TRANSCRIPT, where a "?" per message is repeated noise.
   */
  placeholder?: "disc" | "none";
}) {
  const id = assistantIdOf(provider);
  if (id === "kiro") return <img src={kiroIcon} alt="Kiro" className="w-6 h-6 rounded-full flex-shrink-0" />;
  if (id === "codex") return <img src={codexIcon} alt="Codex" className="w-6 h-6 rounded-full flex-shrink-0" />;
  if (id === "claude") return <img src={claudeIcon} alt="Claude" className="w-6 h-6 rounded-full flex-shrink-0" />;
  /**
   * UNKNOWN — a legacy row from before `ai_provider` was reliable, or a chat whose provider we cannot name.
   *
   * ⚠ THIS BEHAVIOUR IS CHOSEN: if the right icon cannot be shown, show no icon for chat messages.
   * Naming the right assistant IS possible now (the caller passes the session's own provider), so the icon is
   * shown whenever we know it — but where we genuinely do not, `placeholder="none"` renders NOTHING rather than
   * a "?" beside every message in the transcript, which would be noise repeated per row.
   *
   * The history list still gets the neutral disc, because there the icon column is the only thing distinguishing
   * one row from another and an empty gap would misalign the list.
   */
  if (placeholder === "none") return null;
  /*
    ⚠ THEMED, because this component renders on BOTH paths. The dark tokens are correct on the Claude timeline
    and wrong on Codex's light bubbles — caught by the theme guard in vscode-parity.test.ts rather than by eye,
    which is the second time that check has earned its keep.
  */
  return (
    <span
      aria-hidden="true"
      title="Unknown assistant"
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] ${
        dark ? "bg-surface-raised text-surface-muted" : "bg-surface-panel text-surface-faint"
      }`}
    >
      ?
    </span>
  );
}

interface Message {
  id: string;
  role: string;
  content: string;
  session_id?: string;
  created_at?: string;
  /**
   * Whether this row reached the team's transcript (migration 11). Absent on rows written before the
   * column existed — which `SyncBadge` renders as nothing at all rather than as a reassuring tick.
   */
  sync_status?: MessageSyncStatus;
  /**
   * The CLI's reported token counts for this turn (migration 13). Absent on every row written before it, and
   * on every assistant that does not report them — which is why nothing is rendered rather than a zero.
   */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** The cache and reasoning split (migration 13) — what makes a measured savings figure possible. */
  cached_input_tokens?: number | null;
  reasoning_output_tokens?: number | null;
}

interface Session {
  id: string;
  title: string | null;
  ai_provider: string;
  model: string | null;
  updated_at: string;
  shared_at?: string | null;
}

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

interface Project {
  id: string;
  name: string;
  path: string;
}

/**
 * A copy of `map` without `key`.
 *
 * ⚠ DELETING RATHER THAN SETTING 0/undefined, so "no turn in flight" is the ABSENCE of a timestamp.
 * A leftover 0 would render as a turn that started at the epoch; a leftover `undefined` would make
 * every read need a second guard. Absence is the state that cannot be misread.
 */
function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function AssistantChatView({
  project,
  onBusyChange,
}: {
  project: Project;
  /**
   * Raised whenever a turn starts or finishes anywhere in this view.
   *
   * ⚠ THE SHELL CANNOT WORK THIS OUT FOR ITSELF, which is why it is reported rather than polled. A
   * turn begins because THIS component called `cliSend`; main has a process to report but no event
   * that says "a turn started", and `cli:isRunning` would have to be polled to notice. The state is
   * already here and already correct — passing it up is one line.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  /**
   * The workshop phase, for the composer's placeholder. Null is ordinary — see the hook.
   *
   * ⚠ ONE CACHED READ SHARED WITH `KiroChatView`, not a call per mount: this component remounts on
   * every project and session switch, and under StrictMode twice per mount.
   */
  const phaseName = useCurrentPhase();
  /** Ties the composer to its keyboard description; `useId` because a chat can be pinned beside a pane. */
  const hintId = useId();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Draft input is kept PER SESSION so an unsent message doesn't leak into
  // another chat when you switch. Keyed by session id; the "new chat" (no
  // active session) draft uses the "" key.
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  // Runtime state keyed by session id so multiple chats can stream at once
  // (EA-M1). The UI shows one session at a time; background sessions keep
  // streaming and their results land when you switch back.
  const [streamingSessions, setStreamingSessions] = useState<Record<string, boolean>>({});
  /**
   * ── ⚠ WHEN EACH SESSION'S CURRENT TURN STARTED, KEPT HERE RATHER THAN IN THE CLOCK ──────────
   *
   * `ActivityPhrase` used to start its own clock from `useRef(Date.now())` — i.e. from MOUNT — and it
   * is rendered with `key={activeId}`, which forces a remount whenever the shown session changes.
   * That key is right for what it was added for (it stops chat A's stale elapsed time appearing over
   * chat B's turn) but switching AWAY and BACK is also a remount, so a turn that had been running for
   * four minutes redisplayed as "1s". The turn was fine; only the reported number was wrong — which is
   * worse than it sounds, because that number is exactly what someone consults to decide whether a
   * long turn has hung.
   *
   * Elapsed time is a property of the TURN, not of the component drawing it, so it is recorded here
   * where it survives unmounting, keyed per session for the same reason `streamingSessions` is: turns
   * genuinely continue in the background.
   *
   * Set on the transition into streaming and cleared when the turn ends, so a session with no turn in
   * flight holds no stale timestamp.
   */
  const [turnStartedAt, setTurnStartedAt] = useState<Record<string, number>>({});
  /**
   * ── THE IN-FLIGHT TURN, AS BLOCKS ──
   *
   * Replaces `streamContentBySession`, which was one accumulated STRING per session. A string could only
   * ever render prose, which is why every tool call the assistant made was invisible. The block list keeps
   * the interleaving — prose, tool call, prose, tool call — and that order is the information.
   *
   * Keyed by session id, so several chats can stream at once and a background turn's tool steps land
   * intact when you switch back to it.
   */
  const [blocksBySession, setBlocksBySession] = useState<Record<string, TranscriptBlock[]>>({});
  /**
   * Blocks for turns that have already FINISHED, keyed by session then by the assistant message's id.
   *
   * ⚠ WHY THIS HAS TO EXIST AT ALL. On completion the renderer clears the live buffer and reloads from
   * SQLite — and the messages table stores `content` only, so a finished turn's tool steps have nowhere to
   * come from. Without this the transcript would show a full sequence of steps while streaming and then
   * visibly collapse to a wall of prose the instant it finished.
   *
   * BOUNDED by `pruneRetainedTurns` (20 turns), because this is renderer memory holding up to 2,000
   * characters of tool output per step on a laptop that runs all day. Past the ceiling the oldest turn
   * falls back to its persisted markdown — the pre-existing rendering, not a blank row.
   */
  const [retainedBlocks, setRetainedBlocks] = useState<Record<string, Record<string, TranscriptBlock[]>>>({});
  /**
   * A just-finished turn's blocks, waiting for the id of the assistant message they belong to.
   *
   * WHY A TWO-STEP HANDOFF. On `cli:response-complete` the blocks exist but the message id does not — the
   * main process wrote the row, and the renderer only learns its id when `loadMessages` returns. So they
   * are parked under the session id here and re-keyed by the effect below once the row appears.
   */
  const [pendingHandoff, setPendingHandoff] = useState<Record<string, TranscriptBlock[]>>({});
  /** Running `usage.output_tokens` for the status line's `↓ 38.9k tokens`. */
  const [tokensBySession, setTokensBySession] = useState<Record<string, number>>({});
  const [cliStatusBySession, setCliStatusBySession] = useState<Record<string, string | null>>({});
  const [permissionBySession, setPermissionBySession] = useState<Record<string, { id: string; tool: string; description: string; input: any }>>({});

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
  // Chat history panel lives on the RIGHT and is hidden by default; toggled by
  // the history icon in the header. Preference persists across launches.
  const [showHistory, setShowHistory] = useState(false);
  const [trustRequired, setTrustRequired] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  /**
   * The model the CLI will use when nothing is selected.
   *
   * ⚠ `cli:getModels` HAS RETURNED THIS ALL ALONG and the renderer discarded it — which is why the
   * composer could only say "Uses CLI default" instead of naming it. It now shows the default
   * model's name instead of that text.
   */
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [currentCli, setCurrentCli] = useState("claude");
  // Sharing + Team Chats state.
  const [hasTeam, setHasTeam] = useState(false);
  const [sharing, setSharing] = useState(false);
  // History panel: "mine" = local chats, "team" = chats shared by teammates.
  const [historyTab, setHistoryTab] = useState<"mine" | "team">("mine");
  const [sharedThreads, setSharedThreads] = useState<SharedThread[]>([]);
  // When set, the read-only viewer for a teammate's shared chat is open (full-column takeover).
  const [viewingThread, setViewingThread] = useState<SharedThread | null>(null);
  /**
   * ── THE PINNED SHARED CHAT (session-only) ─────────────────────────────────────────────
   * A teammate's thread docked beside the live chat, polled every 15s, so the participant keeps working
   * while watching it. Never persisted. Messages are owned by `SharedThreadPanel`
   * (useThreadPagination), not here; the parent only names the thread in each role and signals
   * team-event refreshes. Mirrors KiroChatView; the two must stay in parity (chat-view-parity.test.ts).
   */
  const [pinnedThread, setPinnedThread] = useState<SharedThread | null>(null);
  /** Drag-resizable width of the pinned pane, session-only. Mirrors KiroChatView; bounds in lib/pinned-pane. */
  const [pinnedWidth, setPinnedWidth] = useState(PIN_DEFAULT_W);
  /** Bumped on each `ai-share` team event so a pinned panel refreshes its tail at once. */
  const [sharedRefreshSignal, setSharedRefreshSignal] = useState(0);
  const toast = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * This conversation's token totals.
   *
   * ⚠ DERIVED FROM THE LOADED MESSAGES, not accumulated as they stream. An accumulator would double-count on
   * every reload and would reset on restart — the counts are now ON the rows (migration 13), so the rows are
   * the single source. `totalTokens` ignores user rows and reports how many replies it could account for.
   */
  const sessionTokens = totalTokens(messages);

  /**
   * ⚠ THE CONVERSATION'S OUTSTANDING SYNCS, because the per-message badge no longer renders for `synced`.
   * Hiding the common case is only honest if the uncommon one is still reachable somewhere — this is that
   * somewhere. `describeSync` returns null when there is nothing to report, so the header stays clean.
   */
  const syncNotice = describeSync(summariseSync(messages));
  /**
   * The measured share of this conversation's prompts served from cache.
   *
   * ⚠ `null` WHEN NOTHING REPORTED IT, which is not the same as 0% — see `cacheSavings`. Rendering a "0%
   * saved" badge on a conversation nobody measured would teach the participant something false.
   */
  const savings = cacheSavings(sessionTokens);



  useEffect(() => {
    // Load sessions and re-open the last active one so a restart doesn't drop
    // the user back to a blank chat (history is persisted in SQLite).
    (async () => {
      const result = await api.getSessions(project.id);
      setSessions(result);
      const lastId = await api.getSetting("active_session_id");
      const last = lastId && result.find((s: Session) => s.id === lastId);
      if (last) handleSelectSession(last);
      const hist = await api.getSetting("chat_history_visible");
      setShowHistory(hist === "1");
      const teamId = await api.getSetting("team_id");
      setHasTeam(!!teamId);
    })();
    api.cliGetModels().then((result: any) => {
      if (result.models?.length) {
        setAvailableModels(result.models);
      }
      // Stored even when the list is empty: the default is what the composer names, and a failed list
      // does not make the default unknown.
      if (typeof result?.defaultModel === "string") setDefaultModel(result.defaultModel);
    });
    api.getSetting("ai_command").then((cmd: string) => {
      if (cmd) setCurrentCli(cmd);
    });
  }, [project.id]);

  /**
   * ── ⚠ RE-READ THE SELECTED ASSISTANT WHEN IT CHANGES ──
   *
   * THE CAUSE: `ai_command` was read ONCE, in an effect keyed on `[project.id]`. Switching assistant in
   * Settings writes the setting and App.tsx re-reads it — but this component does not remount, because
   * `useAcpMode` only changes for KIRO. So a Claude↔Codex switch left `currentCli` holding the PREVIOUS
   * assistant for the life of the view.
   *
   * Everything downstream reads that one value: the welcome text, every message avatar, and `usesTimeline`
   * (hence the theme). One stale string, three visible symptoms — which is why they were reported together.
   *
   * POLLED rather than pushed, deliberately. The alternative is an IPC event on assistant change, which means
   * a new channel, a new listener and a teardown — and the settings write already happens in a view the user
   * has to navigate away from, so a 1.5s worst-case lag is imperceptible. `getSetting` is a synchronous
   * SQLite read behind IPC, so the cost is negligible; the interval is cleared on unmount.
   */
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const cmd = await api.getSetting("ai_command");
      // Only on CHANGE, so an unchanged poll causes no render — this runs for the life of the session.
      if (!cancelled && cmd) setCurrentCli((prev) => (prev === cmd ? prev : cmd));
    };
    const timer = setInterval(read, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /**
   * ── WHICH ASSISTANT IMPLEMENTATION THIS TURN USES ──
   *
   * CLAUDE ONLY. `claude-code.ts` drives the official @anthropic-ai/claude-agent-sdk, which asks
   * before every tool use via `canUseTool` — the mechanism the VS Code extension uses, and what makes
   * the approve/deny card below actually appear. Without it, Claude's requests for permission to edit
   * files were never shown on the desktop for the user to approve.
   *
   * ⚠ KIRO AND CODEX KEEP THE SPAWN PATH, deliberately. Kiro prompts
   * through its OWN ACP handler and its own card in KiroChatView (`--trust-tools`, see kiro-trust.ts);
   * nothing here changes for it. The predicate
   * is an EQUALITY on "claude" rather than a `!==` on the others, so a newly-added assistant defaults
   * to the working path instead of silently inheriting an SDK that cannot drive it.
   */
  /**
   * The accents for whichever assistant is answering — computed ONCE and threaded, so a per-assistant
   * colour cannot be forgotten at one of the sixteen sites that need it.
   */
  const theme = assistantTheme(currentCli);

  /**
   * The two prose bundles, built once per render from the active assistant's ink.
   *
   * ⚠ THESE WERE MODULE CONSTANTS WITH CLAUDE'S ACCENT BAKED IN, which is how Codex replies came to show
   * terracotta code spans in a view Codex shares with Claude. Derived here so there is exactly one answer
   * to "which assistant is this?" — `currentCli` — and every colour follows from it.
   */
  const proseClass = assistantProseClass(theme.proseCode);
  const bubbleClass = darkBubbleClass(theme.proseCode);

  const usesSdk = currentCli === "claude";

  /**
   * ── WHO GETS THE VS CODE TRANSCRIPT ──
   *
   * CLAUDE ONLY, and it is the SAME predicate as `usesSdk` rather than a second one on purpose: the dark
   * timeline exists to render tool steps and a live token count, and `cli:tool-use` / `cli:tool-result` /
   * `cli:usage` are emitted by claude-code.ts alone. Giving Codex the dark surface would give it a
   * transcript with a permanently empty timeline and a status line stuck at `↓ 0 tokens` — a worse view
   * than the bubbles it has now.
   *
   * ⚠ CODEX'S LAYOUT IS STILL DEFERRED until it can be compared with the VS Code Codex plugin. The right
   * reference for its transcript is the Codex extension's own, not Claude's, so it keeps
   * the bubbles until that comparison is made.
   *
   * ⚠ KIRO CANNOT REACH THIS CODE AT ALL. App.tsx routes on `useAcpMode` and renders KiroChatView, a
   * separate component that imports none of these modules. That structural separation — not a predicate —
   * is what makes "dont mess kiro" hold.
   */
  const usesTimeline = usesSdk;

  /**
   * ── ⚠ THE DARK SURFACE IS SEPARATE FROM THE TIMELINE LAYOUT ──
   *
   * These were ONE flag and should not have been. The deferral was about Codex's
   * TRANSCRIPT LAYOUT — bubbles versus the timeline — and the PALETTE was wired to the same predicate, so
   * deferring the layout also left Codex as a white panel between a dark sidebar and dark everything else.
   *
   * Kiro already proves the two are independent: it kept its own bubbles AND took the dark surface, in a
   * change that touched only `className` values. Codex gets the same treatment.
   *
   * So: `usesDarkSurface` is true for every assistant, and `usesTimeline` stays Claude-only. The name is the
   * documentation — a future reader should not have to work out which of the two a flag means.
   */
  const usesDarkSurface = true;

  /**
   * ── ⚠ ANY SESSION, NOT THE VISIBLE ONE ────────────────────────────────────────────────────────
   *
   * A turn keeps streaming when the participant switches to another conversation, so `streaming`
   * below (which is about the session on screen) would report "idle" while an agent is still
   * writing files. The shell uses this to decide whether replacing the working folder is safe, and
   * that question is about the FOLDER, not about which tab is in front.
   */
  const anyTurnInFlight = Object.values(streamingSessions).some(Boolean);
  useEffect(() => {
    onBusyChange?.(anyTurnInFlight);
  }, [anyTurnInFlight, onBusyChange]);
  /**
   * ⚠ AND IT MUST BE RETRACTED ON UNMOUNT. This view unmounts when the assistant is switched or the
   * pane is unpinned; without this the shell would latch "busy" forever and the folder could never
   * be changed again — a worse failure than the one the flag exists to prevent.
   */
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // Values for the session currently displayed.
  const activeId = activeSession?.id ?? "";
  const streaming = activeId ? !!streamingSessions[activeId] : false;
  const blocks = activeId ? blocksBySession[activeId] ?? EMPTY_BLOCKS : EMPTY_BLOCKS;
  const outputTokens = activeId ? tokensBySession[activeId] ?? 0 : 0;
  const cliStatus = activeId ? cliStatusBySession[activeId] ?? null : null;
  const permissionRequest = activeId ? permissionBySession[activeId] ?? null : null;

  // Draft for the session on screen (keyed by activeId; "" key for a new chat).
  const input = draftBySession[activeId] ?? "";
  const setInput = (value: string) =>
    setDraftBySession((prev) => ({ ...prev, [activeId]: value }));

  // Keep the textarea height in sync with the per-session draft (after a
  // session switch or clearing on send) so it doesn't retain a stale height.
  useEffect(() => {
    if (textareaRef.current) autoGrow(textareaRef.current);
  }, [input]);

  useEffect(() => {
    scrollToLatest(messagesEndRef.current);
  }, [messages, blocks]);

  // Ref to the currently-active session id so completion handlers can decide
  // whether to refresh the visible message list without re-registering.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /**
   * ── SECOND HALF OF THE HANDOFF: re-key a finished turn's blocks by its message id ──
   *
   * Runs when `messages` changes after a completion. The turn's blocks were parked under the session id
   * because the assistant row's id did not exist yet; now it does, so they move to
   * `retainedBlocks[session][messageId]` and the transcript can render the finished turn with its tool
   * steps intact instead of collapsing to prose.
   *
   * THE LAST assistant message, because `loadMessages` returns the whole history in order and the turn
   * that just completed is by definition the newest one.
   */
  useEffect(() => {
    const parked = pendingHandoff[activeId];
    if (!parked || !activeId) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    setRetainedBlocks((prev) => ({
      ...prev,
      // BOUNDED per session: 20 turns of up-to-2KB-per-step output, then the oldest falls back to its
      // persisted markdown. Unbounded, this is a day-long leak on a workshop laptop.
      [activeId]: pruneRetainedTurns({
        ...(prev[activeId] ?? {}),
        [lastAssistant.id]: parked,
      }),
    }));
    setPendingHandoff((prev) => {
      const next = { ...prev };
      delete next[activeId];
      return next;
    });
  }, [messages, activeId, pendingHandoff]);

  useEffect(() => {
    // Clear any stale listeners FIRST — the same guard KiroChatView already uses. Belt
    // and braces with the cleanup below: StrictMode's second mount runs before the first
    // cleanup in some React versions, and a duplicated transcript is a confusing bug to
    // trace back to a listener count.
    api.removeCliListeners?.();

    api.onCliOutput((data: { sessionId: string; text: string }) => {
      // Merged into the trailing text block rather than pushed — see appendText. Tokens arrive a few
      // characters at a time, so pushing would build thousands of one-word siblings per turn.
      setBlocksBySession((prev) => ({
        ...prev,
        [data.sessionId]: appendText(prev[data.sessionId] ?? EMPTY_BLOCKS, data.text),
      }));
    });

    /** A tool call begins: the `Bash  Run doctor check` row and its `IN` line. */
    api.onCliToolUse(
      (data: {
        sessionId: string;
        toolUseId: string | null;
        tool: string;
        description: string | null;
        input: string;
      }) => {
        setBlocksBySession((prev) => ({
          ...prev,
          [data.sessionId]: appendToolUse(prev[data.sessionId] ?? EMPTY_BLOCKS, data),
        }));
      }
    );

    /**
     * Its result: the `OUT` line, matched back to the call BY ID because Claude issues tool calls in
     * parallel and results do not arrive in dispatch order. An unmatchable result is dropped, and
     * `applyToolResult` returns the same array reference so that costs no re-render.
     */
    api.onCliToolResult(
      (data: {
        sessionId: string;
        toolUseId: string | null;
        output: string;
        truncated: boolean;
        isError: boolean;
      }) => {
        setBlocksBySession((prev) => {
          const current = prev[data.sessionId];
          if (!current) return prev;
          const next = applyToolResult(current, data);
          if (next === current) return prev;
          return { ...prev, [data.sessionId]: next };
        });
      }
    );

    /**
     * The status line's token count. MONOTONIC BY CONSTRUCTION — the main process banks each model call's
     * total before the next begins, because `output_tokens` restarts at 1 on every `message_start`. The
     * `Math.max` here is a second guard: a count that visibly went BACKWARDS mid-turn would read as an
     * error, and out-of-order IPC delivery is cheap to defend against.
     */
    api.onCliUsage((data: { sessionId: string; outputTokens: number }) => {
      setTokensBySession((prev) => ({
        ...prev,
        [data.sessionId]: Math.max(prev[data.sessionId] ?? 0, data.outputTokens),
      }));
    });

    api.onCliResponseComplete((data: { sessionId: string; content: string }) => {
      setStreamingSessions((prev) => ({ ...prev, [data.sessionId]: false }));
      setTurnStartedAt((prev) => omitKey(prev, data.sessionId));
      setPermissionBySession((prev) => { const n = { ...prev }; delete n[data.sessionId]; return n; });
      /**
       * ── HAND THE FINISHED TURN'S BLOCKS OVER BEFORE CLEARING THEM ──
       *
       * The live buffer is cleared here and the transcript reloads from SQLite, which stores `content`
       * only. So without this the tool steps that were on screen a moment ago would vanish and the turn
       * would collapse into a wall of prose — a visible regression at the exact moment the reply lands.
       *
       * Keyed by the assistant message's id, which is not known yet: `loadMessages` supplies it below.
       * Parked under the session's own key in the meantime.
       */
      setBlocksBySession((prev) => {
        const finished = prev[data.sessionId];
        if (finished?.length) {
          setPendingHandoff((h) => ({ ...h, [data.sessionId]: finished }));
        }
        const next = { ...prev };
        delete next[data.sessionId];
        return next;
      });
      // The clock and the count belong to ONE turn. Left standing, the next turn's status line would
      // open at the previous turn's total and appear to have done work before it started.
      setTokensBySession((prev) => { const n = { ...prev }; delete n[data.sessionId]; return n; });
      // Only reload the visible message list if this is the session on screen.
      if (data.sessionId === activeIdRef.current) loadMessages(data.sessionId);
      // Notify the unread hook so an off-tab response badges the Chat nav + chimes.
      window.dispatchEvent(new CustomEvent("ai:response-complete"));
    });

    api.onCliExited((data: { sessionId?: string }) => {
      if (!data?.sessionId) return;
      setStreamingSessions((prev) => ({ ...prev, [data.sessionId!]: false }));
      setTurnStartedAt((prev) => omitKey(prev, data.sessionId!));
      setPermissionBySession((prev) => { const n = { ...prev }; delete n[data.sessionId!]; return n; });
      // Not cleared: whatever the turn produced before the process died stays on screen. It is the only
      // record of what happened, and a crash is precisely when a participant needs to see it.
    });

    api.onCliError((data: { sessionId: string; error: string }) => {
      /**
       * APPENDED, NOT SUBSTITUTED. The old code replaced the whole buffer with the error string, throwing
       * away every tool step and every word already streamed — so a failure at minute fourteen erased the
       * fourteen minutes of visible work that led to it. That work is the diagnostic context.
       */
      setBlocksBySession((prev) => ({
        ...prev,
        [data.sessionId]: appendText(
          prev[data.sessionId] ?? EMPTY_BLOCKS,
          `\n\n⚠️ ${data.error}`
        ),
      }));
      setStreamingSessions((prev) => ({ ...prev, [data.sessionId]: false }));
      setTurnStartedAt((prev) => omitKey(prev, data.sessionId));
      setPermissionBySession((prev) => { const n = { ...prev }; delete n[data.sessionId]; return n; });
    });

    api.onCliPermissionRequest((data: { sessionId: string; id: string; tool: string; description: string; input: any }) => {
      setPermissionBySession((prev) => ({ ...prev, [data.sessionId]: data }));
    });

    api.onCliTrustRequired((data: { sessionId: string; path: string }) => {
      setTrustRequired(data.path);
    });

    /**
      * `onCliRaw` IS NO LONGER SUBSCRIBED. It fed the removed Stream Log panel, and accumulating 200
      * frames per session into React state on every line — for a view nobody can open — is work with no
      * reader. The channel and its bridge remain, so a future debug view or support bundle can consume
      * it without re-plumbing anything.
      */

    api.onCliStatus((data: { sessionId: string; status: string }) => {
      setCliStatusBySession((prev) => ({ ...prev, [data.sessionId]: data.status }));
    });

    // Detach on unmount. Every onCli* bridge APPENDS via ipcRenderer.on, and React
    // StrictMode mounts effects twice in development — so without this each frame was
    // delivered to two listeners and every line appeared TWICE in the transcript and the
    // stream log. In production a remount leaks a listener and duplicates from then on.
    //
    // Only the cli:* channels: kiroAcp:* are owned by KiroChatView's own
    // removeKiroAcpListeners, which already works. Tearing those down from here would
    // break a healthy path to fix a broken one.
    return () => api.removeCliListeners?.();
  }, []);

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

  /**
   * ── ⚠ RE-READ WHAT IS ON SCREEN ────────────────────────────────────────────────────────
   *
   * ⚠ WHAT IT REFRESHES AND WHY THAT IS NOT OBVIOUS. Everything on this screen is local — SQLite, in this
   * process — so nothing here is a network call and nothing can hang. What genuinely goes stale is the view:
   * the transcript is patched in place by `sync:status` and reloaded on `cli:response-complete`, and the
   * session list is only re-read when a chat is created or deleted. A turn synced by the BACKGROUND SWEEP,
   * or a row changed by another window, leaves what you are looking at behind.
   *
   * ⚠ IT DOES NOT RE-PUSH ANYTHING. A refresh that also retried a sync would be a different, heavier action
   * wearing a familiar icon — the per-message sync badge is the control for that, and it says so.
   *
   * `spinning` is state rather than a CSS animation on a permanent element: a spinner that never stops is
   * how a control that silently failed still looks busy.
   */
  const [refreshing, setRefreshing] = useState(false);

  async function refreshConversations() {
    if (refreshing) return; // One at a time — a double click must not queue two reads.
    setRefreshing(true);
    try {
      const result = await api.getSessions(project.id);
      setSessions(result);
      if (activeId) await loadMessages(activeId);
      if (showHistory && historyTab === "team") await loadSharedThreads();
    } catch {
      /* Local reads; a failure here means the database is unavailable, which the app surfaces elsewhere. */
    } finally {
      setRefreshing(false);
    }
  }

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
    setViewingThread(thread);
  }

  /** How `SharedThreadPanel` fetches pages/tails for a shared thread — mirrors KiroChatView. */
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
    setViewingThread(null);
    setPinnedThread(thread);
  }

  function unpinSharedThread() {
    setPinnedThread(null);
  }

  /**
   * Drag-resize the pinned pane by dragging the divider between it and the live chat. The pane is
   * anchored right, so its width is `window.innerWidth - clientX`, minus the history drawer (240px)
   * when open. Pointer capture keeps the drag alive past the handle; the clamp keeps it legal. Mirrors
   * KiroChatView.
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

  async function loadMessages(sessionId: string) {
    const result = await api.getMessages(sessionId);
    setMessages(result);
  }

  async function handleNewSession() {
    setActiveSession(null);
    setMessages([]);
    api.setSetting("active_session_id", "");
  }

  async function handleSelectSession(session: Session) {
    setActiveSession(session);
    api.setSetting("active_session_id", session.id);
    await loadMessages(session.id);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || streaming) return;
    await sendMessage(input.trim());
  }

  // Send a message programmatically (also used by quick-reply option buttons).
  async function sendMessage(raw: string) {
    if (!raw.trim() || streaming) return;

    let message = raw.trim();

    // Convert slash commands to natural language for non-claude CLIs
    if (message.startsWith("/") && currentCli !== "claude") {
      const cmd = message.slice(1);
      message = `run ${cmd}`;
    }
    let session = activeSession;

    if (!session) {
      const newSession = {
        id: crypto.randomUUID(),
        projectId: project.id,
        title: message.replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 50) || "Chat",
        aiProvider: currentCli || "claude",
      };
      await api.createSession(newSession);
      session = newSession as any;
      setActiveSession(session);
      api.setSetting("active_session_id", session!.id);
      await loadSessions();
    }

    const userMsg = {
      id: crypto.randomUUID(),
      sessionId: session!.id,
      role: "user",
      content: message,
    };
    await api.addMessage(userMsg);
    /*
      ⚠ THE STAMP GOES ON THE RENDERED COPY, NOT THE ROW. Same gap Kiro had: this object is built here and
      appended straight to state, so without a `created_at` the message you just sent shows no time until the
      list is re-read from SQLite.

      ⚠ AND `userMsg` IS THE DB PAYLOAD, which is why it is spread rather than mutated. `db:addMessage` picks
      four fields by name so an extra one would be ignored today — but the column is `datetime('now')`
      (space-separated, no zone) and EIGHT queries order by it as a string, so an ISO value reaching it would
      sort after every same-day row and reorder the transcript. Keeping the two objects distinct makes that
      impossible rather than merely unlikely.
    */
    /*
      ⚠ `sync_status` IS PART OF THE RENDERED COPY, and its absence was the whole reason the icon kept
      appearing on send. `undefined` is the UNTRACKED state — which draws a push control unconditionally — so
      hiding `synced` and then `pending` both missed it. `db:addMessage` writes this row as `pending`
      (db.ts, and only for user/assistant rows), so this mirrors the row rather than asserting anything new.
    */
    setMessages((prev) => [
      ...prev,
      { ...userMsg, created_at: new Date().toISOString(), sync_status: "pending" } as any,
    ]);
    const sid = session!.id;
    // Clear the draft for both the sent session and the "new chat" ("") key,
    // since a first message promotes the new-chat draft into a real session.
    setDraftBySession((prev) => ({ ...prev, [sid]: "", "": "" }));
    if (textareaRef.current) autoGrow(textareaRef.current);
    setStreamingSessions((prev) => ({ ...prev, [sid]: true }));
    /* The turn's clock starts here, not when ActivityPhrase mounts. See turnStartedAt. */
    setTurnStartedAt((prev) => ({ ...prev, [sid]: Date.now() }));
    // A FRESH block list and a zeroed count for the new turn. Carrying either over would open the status
    // line at the previous turn's total and show its tool steps under this turn's prompt.
    setBlocksBySession((prev) => ({ ...prev, [sid]: EMPTY_BLOCKS }));
    setTokensBySession((prev) => ({ ...prev, [sid]: 0 }));
    setCliStatusBySession((prev) => ({ ...prev, [sid]: null }));

    // Same arguments either way; only the channel differs. The stream events are shared, so every
    // listener above is untouched by this choice.
    const send = usesSdk ? api.claudeSdkSend : api.cliSend;
    const result = await send({
      sessionId: sid,
      message: userMsg.content,
      /**
       * ⚠ THE ROW ID TRAVELS WITH THE SEND, because main cannot otherwise know which row this is. The
       * user's message is inserted HERE, from the renderer, with an id generated here — so without
       * passing it, the sync in main has no way to mark it synced and would have to guess by matching
       * on content. Guessing is how the wrong row gets marked when someone sends the same text twice.
       */
      userMessageId: userMsg.id,
      ...(selectedModel ? { model: selectedModel } : {}),
    });

    if (result.error) {
      setBlocksBySession((prev) => ({
        ...prev,
        [sid]: appendText(prev[sid] ?? EMPTY_BLOCKS, `⚠️ ${result.error}`),
      }));
      setStreamingSessions((prev) => ({ ...prev, [sid]: false }));
      setTurnStartedAt((prev) => omitKey(prev, sid));
    }
  }

  /**
   * THE CAUSE was comparing two different vocabularies directly — `ai_provider` stores `"kiro"` while
   * `ai_command` is `"kiro-cli"` — plus treating the legacy value `"cli"` as a wildcard that matched every
   * assistant. `canSendInSession` normalises both sides and treats an UNRECOGNISED provider as editable, which
   * is the right answer for a legacy row: locking someone out of their own history on a guess is worse than
   * letting them continue with the wrong assistant, which is visible and recoverable.
   */
  const isOtherCli = !canSendInSession(activeSession?.ai_provider, currentCli);

  // Id of the most recent assistant message — only it shows quick-reply buttons.
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="flex-1 flex h-full">
      {/* Chat area */}
      {/* ⚠ `min-w-0` LETS THE LIVE CHAT GIVE UP WIDTH to the pinned shared pane when its divider is
          dragged — without it this flex item keeps its intrinsic min-width and the pinned pane overflows
          instead of trading space. See KiroChatView for the same note. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/*
          ── READ-ONLY SHARED-CHAT VIEWER (in the window, not a popup) ─────────────────────────
          Mirrors KiroChatView. VIEWING (not pinned) takes over this column; PINNED moves it to a second
          column on the right (after this div) so the live composer stays usable. Session-only — no persist.
        */}
        {viewingThread && !pinnedThread ? (
          <SharedThreadPanel
            thread={viewingThread}
            pinned={false}
            fetcher={makeSharedFetcher(viewingThread.id)}
            dark={usesDarkSurface}
            userBubble={theme.userBubble}
            bubbleClass={bubbleClass}
            onClose={() => setViewingThread(null)}
            onTogglePin={() => pinSharedThread(viewingThread)}
          />
        ) : (
        <>
        {/* Header — themed with the transcript below it, for the same contiguity reason as the input.
            ⚠ THE `pr-9` RESERVATION IS GONE because the pin is no longer an overlay. It used to sit
            `absolute` in this pane's top-right, past the controls on the right of this row, and the padding
            existed only to stop it swallowing their clicks. It now renders in the title group below. */}
        <div
          className={`${PANE_HEADER} justify-between ${
            "bg-surface-panel"
          }`}
        >
          <div className="flex items-center gap-2">
            <AIIcon dark={usesDarkSurface} provider={currentCli} />
            <span className={usesDarkSurface ? PANE_TITLE : "truncate text-sm font-semibold text-surface-text"}>
              {assistantLabel(currentCli)}
            </span>
            {/* Next to the NAME — "Codex 📌" — which is what the pin is named after and where it was asked for. */}
            <PanePinSlot />

            {/*
              ── ⚠ "2 MESSAGES NOT SYNCED" ─────────────────────────────────────────────────────

              ⚠ BEFORE THE TOKEN TOTAL, because a problem outranks a statistic. And it renders only when
              something is outstanding — `describeSync` returns null otherwise, so a healthy conversation
              gains no chrome at all, which was the point of hiding the badges.

              ⚠ THE WORDING IS THE TONE. "not synced" is a claim that the server refused the message and is
              drawn as a warning; "syncing" is drawn quietly, because a turn syncs moments after it ends and
              calling that broken would report a fault on every message anyone sends. Untracked rows are in
              neither count — see lib/sync-summary.ts for why that restraint matters here.
            */}
            {syncNotice && (
              <span
                className={`text-[10px] tabular-nums ${
                  /*
                    ⚠ THE SAME RED AS THE BADGES IT REFERS TO. `failed` on a message renders
                    `tool-error-text` (#f48771, 7.22:1 as words — `tool-error` at 3.87:1 is legal only as a
                    shape, which is why the pair exists). A header counting those messages in a different
                    colour would read as a different KIND of problem from the icons it is pointing at.
                  */
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

            {/*
              ── THIS CONVERSATION'S TOKENS ────────────────────────────────────────────────────

              ⚠ IN THE HEADER, NOT THE COMPOSER. The composer already shows a LIVE running count for the turn
              in flight (`ActivityPhrase`'s `↓ …k tokens`), and two numbers a few pixels apart meaning different
              things — this turn versus the whole chat — is how a reader ends up trusting neither.

              ⚠ AND IT IS SILENT WHEN NOTHING WAS COUNTED. Every message before migration 13 has no counts, so
              on an existing chat this renders nothing at all rather than "0".
            */}
            {sessionTokens.counted > 0 && (
              <span
                className={`text-[10px] tabular-nums ${usesDarkSurface ? "text-surface-faint" : "text-surface-muted"}`}
                title={describeTotals(sessionTokens)}
              >
                {formatTokens(sessionTokens.input)} ctx · {formatTokens(sessionTokens.output)} out
                {/* A partial total is a floor, and says so — the same "(min)" honesty the portal strip uses. */}
                {sessionTokens.partial && <span className="text-tool-warning"> (min)</span>}
              </span>
            )}

            {/*
              ── ⚠ WHAT THE CACHE SAVED, MEASURED ──────────────────────────────────────────────

              This is `cached / input` from the CLI's own numbers — the share of the prompt that did not have
              to be re-sent. It is deliberately NOT a comparison against "what a worse prompt would have
              cost", because nothing measured that: a saving against a hypothetical is a number somebody
              chose, and putting it in front of a participant as education would teach them to trust it.

              `tool-ok` because a saving is good news, and it measures 8.88:1 on this surface.
            */}
            {savings && (
              <span
                className="text-[10px] tabular-nums text-tool-ok"
                title={
                  `${savings.percent}% of the prompt tokens in this conversation were served from cache ` +
                  `rather than re-sent, measured over ${savings.covered} repl${savings.covered === 1 ? "y" : "ies"}. ` +
                  `Shorter, more focused prompts and fewer topic changes raise it.`
                }
              >
                {savings.percent}% cached
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Share-with-team control — only meaningful once a chat exists. */}
            {activeSession && (
              activeSession.shared_at ? (
                <div className="flex items-center gap-1">
                  <span
                    className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${
                      usesDarkSurface ? "bg-surface-raised text-tool-ok" : "bg-green-100 text-green-700"
                    }`}
                    title={`Shared with your team${
                      formatMessageInstant(activeSession.shared_at) ? ` on ${formatMessageInstant(activeSession.shared_at)}` : ""
                    }`}
                  >
                    <ShareIcon /> Shared
                  </span>
                  <button
                    onClick={handleUnshare}
                    disabled={sharing}
                    className={`p-1.5 rounded transition-colors disabled:opacity-50 text-surface-muted hover:bg-surface-raised hover:text-surface-text`}
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
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "text-surface-faint hover:bg-surface-raised hover:text-surface-text"}`}
                  title={hasTeam ? "Share this chat with your team" : "Join a team to share chats"}
                  aria-label="Share chat with team"
                >
                  <ShareIcon /> Share
                </button>
              )
            )}
            {/*
              ⚠ ICON ONLY, WITH THE WORD IN THE TOOLTIP — the same rule as the copy and sync controls, and
              for the same reason: this row already carries Share, New and history, and a fourth label would
              push the assistant's name out of a 40px header.
            */}
            <IconTooltip label={refreshing ? "Refreshing…" : "Refresh this conversation"}>
              <button
                onClick={() => void refreshConversations()}
                disabled={refreshing}
                className={`p-1.5 rounded transition-colors disabled:opacity-50 ${usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "text-surface-faint hover:bg-surface-raised hover:text-surface-text"}`}
                title="Refresh"
                aria-label={refreshing ? "Refreshing this conversation" : "Refresh this conversation"}
              >
                <RefreshIcon spinning={refreshing} />
              </button>
            </IconTooltip>
            <button
              onClick={handleNewSession}
              className={`p-1.5 rounded transition-colors ${usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "text-surface-faint hover:bg-surface-raised hover:text-surface-text"}`}
              title="New chat"
              aria-label="New chat"
            >
              <NewChatIcon />
            </button>
            <button
              onClick={toggleHistory}
              className={`p-1.5 rounded transition-colors ${showHistory ? (usesDarkSurface ? `bg-surface-raised ${theme.ink}` : "bg-blue-100 text-blue-600") : usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "text-surface-faint hover:bg-surface-raised hover:text-surface-text"}`}
              title={showHistory ? "Hide chat history" : "Show chat history"}
              aria-label="Toggle chat history"
            >
              <HistoryIcon />
            </button>
          </div>
        </div>
        {/*
          ── ⚠ THE GAP IS KEYED ON THE LAYOUT, NOT ON THE PALETTE ──────────────────────────────

          User and assistant message boxes were touching, with no space between them.

          `space-y-3` is dropped on the TIMELINE deliberately: the spine has to be CONTINUOUS between
          steps, and a gap between rows would break the connecting rule into dashes. That reasoning was
          correct and is unchanged.

          ⚠ THE BUG WAS THE CONDITION. It read `usesDarkSurface ? … : "p-4 space-y-3"`, and
          `usesDarkSurface` became unconditionally `true` when the light theme was retired (line 451) —
          so the branch carrying the gap became DEAD, and Codex, which renders BUBBLES rather than the
          timeline, lost its spacing entirely. Two boxes with no gap read as one box.

          The flag that actually means "rows must touch" is `usesTimeline`, so that is what decides now.
          Nothing changes for Claude.
        */}
        <div
          className={`overflow-y-auto bg-surface-bg px-4 py-3 ${
            usesTimeline ? "" : "space-y-3"
          }`}
          style={{ flex: "1 1 0", minHeight: 0 }}
        >
          {messages.length === 0 && !streaming && (
            <div className={`text-center mt-20 text-surface-muted`}>
              <div className="flex justify-center">
                <AIIcon dark={usesDarkSurface} provider={currentCli} />
              </div>
              <p className={`text-base font-medium mt-3 mb-2 ${usesDarkSurface ? "text-surface-text" : "text-surface-muted"}`}>
                Welcome to {assistantLabel(currentCli)}
              </p>
              <p className={`text-sm mb-3 text-surface-muted`}>
                Ask about your code, request changes, or get help with tasks.
              </p>
              <p className={`text-xs ${usesDarkSurface ? "text-surface-faint" : "text-surface-text"}`}>
                Click "+ New Chat" or type below to start a conversation.
              </p>
              <p
                className={`text-xs mt-3 inline-block px-3 py-1.5 rounded-full ${
                  usesDarkSurface ? "text-surface-faint bg-surface-panel" : "text-surface-text bg-surface-panel"
                }`}
              >
                🔒 Messages are saved locally and synced with your experience for progress insights only.
              </p>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.role === "system") {
              return (
                <div key={msg.id} className={`flex justify-center ${usesTimeline ? "py-1.5" : ""}`}>
                  <span
                    className={`text-xs px-3 py-1 rounded-full ${
                      usesDarkSurface
                        ? "text-surface-muted bg-surface-panel border-[.5px] border-surface-line"
                        : "text-surface-faint bg-surface-panel"
                    }`}
                  >
                    {msg.content}
                  </span>
                </div>
              );
            }

            /* ── THE ORIGINAL BUBBLES, for Codex. Unchanged behaviour. ── */
            if (!usesTimeline) {
              /*
                ── CODEX: BUBBLES, BUT DARK ONES ──

                The LAYOUT stays bubbles — that deferral still stands, pending a look at the
                Codex extension. Only the palette changes, exactly as Kiro's did: `darkBubbleClass` instead of
                the light `SHARED_BUBBLE_CLASS`, and terracotta for the user's own message rather than blue.
              */
              /*
                ── ⚠ THE ASSISTANT SITS LEFT, THE PARTICIPANT RIGHT ──

                  ⚠ I CAUSED THAT, AND THE MECHANISM IS WORTH RECORDING. The row was `justify-end` for BOTH
                  roles and always had been — it was invisible because the assistant's bubble was never
                  actually capped: `darkBubbleClass` carries prose's `max-w-none`, and in the generated
                  stylesheet `.max-w-none` is emitted AFTER `.max-w-full`/`.max-w-[75%]`, so it won. An
                  uncapped bubble fills the row, and a full-width box looks left-aligned no matter how its
                  container justifies.

                  Moving the cap to the column wrapper (so a sibling timestamp could sit below the bubble)
                  put it somewhere prose could not override — the assistant clamped to 75%, and the
                  pre-existing `justify-end` became visible for the first time.

                  ⚠ SO ALIGNMENT IS NOW STATED PER ROLE RATHER THAN EMERGING FROM A WIDTH. Relying on "it is
                full width so justification cannot matter" is what hid this for as long as it did.
              */
              return (
                <div
                  key={msg.id}
                  className={`group flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}
                >
                  {/*
                    ── ⚠ A COLUMN, SO THE TIME CAN SIT BELOW THE BUBBLE RATHER THAN IN IT ──

                    ⚠ `max-w-[75%]` MOVED HERE FROM THE BUBBLE and had to: the percentage must resolve
                    against this flex row, and a stamp that is a SIBLING of the bubble cannot be constrained
                    by the bubble's own width. The bubble keeps `max-w-full`, so it still shrinks to its text.

                    ⚠ AND IT FIXES THE INK RATHER THAN WORKING AROUND IT. Inside the bubble the stamp needed
                    `white/70`, because `faint` measures 3.33:1 on `surface-raised` and is forbidden there.
                    Out here it sits on the transcript background, where `faint` is 5.73:1 and is what every
                    other timestamp in the app already uses.
                  */}
                  <div
                    className={
                      msg.role === "user"
                        ? "flex max-w-[75%] flex-col items-end"
                        : /* Uncapped and left, as it was — `min-w-0` so long code blocks wrap rather than
                             stretching the row. */
                          "flex min-w-0 max-w-full flex-col items-start"
                    }
                  >
                  {/*
                    ⚠ `relative` AND `pr-7` MAKE ROOM FOR THE SYNC ICON INSIDE THE BOX. The sync
                    icon sits on the right, next to the message, rather than below it, where it increased
                    the message box height. In the footer it cost a whole row; in the corner it costs nothing,
                    and the padding is what stops it landing on the last word.

                    ⚠ THE SHARED-CHAT VIEWER FURTHER DOWN USES THE SAME MARKUP AND MUST NOT GAIN THIS. That
                    transcript belongs to a teammate: there is no local row to sync and no badge to show.
                  */}
                  <div
                    /*
                      ⚠ THE RESERVED CORNER IS SIZED FROM WHAT IS ACTUALLY IN IT, and it SHRANK when copy left
                      the user's row: every corner now holds sync alone — one 24×24 target (WCAG 2.2 SC 2.5.8)
                      plus the 6px inset, so 30px — which `pr-9` (36px) covers for both roles. It was `pr-16`
                      on a user row when copy sat there too, and that 28px is now message width instead of
                      reserved emptiness.
                    */
                    className={`relative max-w-full rounded-lg px-4 py-2.5 pr-9 text-sm ${
                      msg.role === "user" ? theme.userBubble : bubbleClass
                    }`}
                  >
                    {/*
                      ⚠ SYNC ALONE. COPY IS GONE FROM THE PARTICIPANT'S OWN MESSAGE, and that is a
                      deliberate choice rather than a simplification.

                      It had been moved INTO this corner to stop it costing a footer row, then asked to move
                      to the bottom-left to match the assistant — at which point the row came back. Deleting
                      it settles both: you wrote the text, so copying it back is the one action here nobody
                      needed. The ASSISTANT keeps its copy, which was always the requested half.
                    */}
                    <span className="absolute right-1.5 top-1.5 flex items-center">
                      <SyncBadge
                        status={msg.sync_status}
                        messageId={msg.id}
                        onLight={msg.role === "user"}
                        onRetried={() => void loadMessages(activeId)}
                      />
                    </span>
                    {msg.role === "user" ? (
                      <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                    ) : (
                      <>
                        <AssistantMarkdown content={msg.content} />
                        {msg.id === lastAssistantId && !streaming && (
                          <OptionButtons
                            options={parseChatOptions(msg.content)}
                            onSelect={(label) => sendMessage(label)}
                          />
                        )}
                      </>
                    )}
                    {/*
                      ⚠ THE SYNC ICON LEFT THIS ROW and sits in the bubble's top-right corner instead — see
                      above. Copy stays: it is a labelled action rather than a status, and it reads badly as a
                      bare glyph in a corner.
                    */}
                    {/*
                      ⚠ THE FOOTER IS ASSISTANT-ONLY NOW. On a user row it held just the copy action, which has
                      moved to the corner — and an empty flex row still costs its top margin, which is the
                      height this change is about. Rendering it conditionally is what actually shrinks the box.
                    */}
                    {/*
                      ── ⚠ WHEN IT WAS SENT. THIS BRANCH HAD NO TIMESTAMP AT ALL ──

Not a data gap — `chat_messages.created_at` is `NOT NULL DEFAULT (datetime('now'))`, so every row of every
provider has always had one. The line to render it was simply never written here: it was added to the
Claude/Kiro user box as a targeted fix and never extended to the bubbles.

                      ⚠ THE INK IS KEYED TO THE ROLE, AND IT HAS TO BE. `surface-faint` measures 3.33:1 on
                      `surface-raised` — the Codex user bubble's own fill — which fails the 4.5 floor and is
                      forbidden outright by the note in tailwind.config.ts. `white/70` over that fill is
                      5.74:1. On the assistant's `surface-panel`, `faint` is 4.74:1 and legal. Same split the
                      shared-chat viewer already uses further down this file.

                      ⚠ ON THE ASSISTANT IT COSTS NO HEIGHT: it joins the footer row that exists anyway for
                      copy and the token counts. Only the user's row gains a line, and at 10px it is the
                      cheapest one available — the height complaint on this bubble was about a 24px icon.
                    */}
                    {msg.role !== "user" && (
                      <div className="mt-1 flex items-center gap-2">
                        <CopyButton text={msg.content} />
                        {/* Only ever present on an assistant row, and only when the CLI counted the turn. */}
                        <MessageTokens input={msg.input_tokens} output={msg.output_tokens} />
                        {formatMessageInstant(msg.created_at) && (
                          <span className="text-[10px] tabular-nums text-surface-faint">
                            {formatMessageInstant(msg.created_at)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Below the box, on the page — the team-chat shape. Only the user's row: the assistant's
                      time rides in the footer it already had, and costs nothing there. */}
                  {msg.role === "user" && formatMessageInstant(msg.created_at) && (
                    <span className="mt-0.5 text-[10px] tabular-nums text-surface-faint">
                      {formatMessageInstant(msg.created_at)}
                    </span>
                  )}
                  </div>
                  {/*
                    ⚠ THE SESSION'S OWN ASSISTANT, NOT THE SELECTED ONE.

                    This read `currentCli`, so every message in a read-only chat was labelled with whatever was
                    selected — a Claude transcript viewed under Codex claimed Codex wrote it. `activeSession`
                    carries the provider the chat was actually created with, which is the only honest answer.

                    ⚠ AND CLAUDE SHOWS NO AVATARS AT ALL, which is preferred: the timeline
                    layout has no per-message icons by design (dots on a spine instead). So this branch is the
                    only place a message avatar renders, and it now names the right assistant.
                  */}
                  {msg.role !== "user" && (
                    <AIIcon
                      provider={activeSession?.ai_provider ?? currentCli}
                      placeholder="none"
                    />
                  )}
                </div>
              );
            }

            /*
              The user's own prompt: a bordered input-style box, NOT a coloured bubble. That is the
              extension's `.userMessage` — `border:1px solid --app-input-border`, medium radius,
              input-background fill, `display:inline-block` so it hugs its text instead of spanning the
              column. It reads as "the thing you typed", which is what it is.
            */
            if (msg.role === "user") {
              const sentAt = formatMessageInstant(msg.created_at);
              return (
                <div key={msg.id} className="group py-2">
                  {/*
                    ⚠ THE ICON SITS TO THE RIGHT OF THE BOX, NOT UNDER IT, because below it the icon
                    increased the message box height — and this box is the one that showed it worst, since a
                    one-character message like
                    "2" had a footer as tall as its content.

                    ⚠ BESIDE rather than inside, unlike the Codex bubble: this box is `inline-block` and hugs
                    its text, so it can be a single character wide. An absolute corner icon would sit on top of
                    the content. `items-start` keeps the icon on the FIRST line of a multi-line message.
                  */}
                  <div className="flex items-start gap-1.5">
                    <div className="inline-block max-w-full whitespace-pre-wrap break-words rounded-md border border-surface-line bg-surface-raised px-1.5 py-1 text-sm text-surface-text">
                      {msg.content}
                    </div>
                    {/* Sync alone, clear of the box. Copy was removed from the user's own message — see the
                        Codex corner above for why. */}
                    <span className="mt-1 flex flex-shrink-0 items-center">
                      <SyncBadge
                        status={msg.sync_status}
                        messageId={msg.id}
                        onRetried={() => void loadMessages(activeId)}
                      />
                    </span>
                  </div>
                  {/*
Rendered only when the row actually carries a timestamp — an absent one prints nothing rather than "Invalid
Date".
                  */}
                  {/*
                    The footer row: when it was sent, and whether it reached the team. Both belong here —
                    this is the "what happened to my message" line, and it already existed for the time.
                  */}
                  {/*
                    ⚠ SYNC AND COPY HAVE BOTH LEFT THIS ROW — they sit beside the box now. All that remains is
                    the timestamp, so the row is rendered ONLY when there is one: an empty flex row still costs
                    its top margin, and that margin is the height this change is about.
                  */}
                  {sentAt && (
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-[10px] text-surface-faint tabular-nums">{sentAt}</span>
                    </div>
                  )}
                </div>
              );
            }

            /*
              The assistant's turn. Its tool steps come from `retainedBlocks` when this turn is one of the
              20 still held in memory; past that the prose alone renders — the pre-existing behaviour, and
              the reason this falls back rather than showing an empty timeline.
            */
            const turnBlocks = retainedBlocks[activeId]?.[msg.id];
            return (
              // `group` so the copy control reveals on hover anywhere over the assistant's turn.
              <div key={msg.id} className="group">
                {turnBlocks
                  ? renderBlocks(turnBlocks, { caret: theme.caret, proseCode: theme.proseCode })
                  : (
                    <TimelineRow state="success">
                      <div className={`py-1 ${proseClass}`}>
                        <AssistantMarkdown content={msg.content} />
                      </div>
                    </TimelineRow>
                  )}
                {/*
                  The assistant's footer: copy the reply, and whether it reached the team. Indented to the
                  timeline's text column (30px) so it lines up with the prose rather than the spine.
                */}
                {/*
                  ⚠ THE ASSISTANT KEEPS ITS FOOTER, and that is a considered exception. Its reply is prose in a
                  full-width timeline row with no box to tuck a corner into, and the row exists for "Copy
                  reply" regardless — so moving the icon out would save no height here at all. It sits at the
                  END of the row, i.e. to the right of the copy action, so the eye finds status in the same
                  place it does on the bubbles.
                */}
                <div className="mt-0.5 flex items-center gap-2 pl-[30px]">
                  <CopyButton text={msg.content} label="Copy reply" />
                  <SyncBadge
                    status={msg.sync_status}
                    messageId={msg.id}
                    onRetried={() => void loadMessages(activeId)}
                  />
                  <MessageTokens input={msg.input_tokens} output={msg.output_tokens} />
                  {/*
                    The reply's own time. Free here — this row exists for "Copy reply" regardless — and it
                    closes the asymmetry where the question was stamped and the answer was not. `faint` is
                    legal at 5.73:1 on the transcript background this row sits on.
                  */}
                  {formatMessageInstant(msg.created_at) && (
                    <span className="text-[10px] tabular-nums text-surface-faint">
                      {formatMessageInstant(msg.created_at)}
                    </span>
                  )}
                </div>
                {/* Quick-reply buttons only on the latest assistant reply, and only when idle. */}
                {msg.id === lastAssistantId && !streaming && (
                  <div className="pl-[30px]">
                    <OptionButtons
                      options={parseChatOptions(msg.content)}
                      onSelect={(label) => sendMessage(label)}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* ── THE TURN IN FLIGHT: its blocks, in order. ── */}
          {usesTimeline && blocks.length > 0 && renderBlocks(blocks, { live: true, caret: theme.caret, proseCode: theme.proseCode })}

          {/*
            Codex's in-flight turn, in a bubble rather than the timeline.

            ⚠ THE OLD NOTE HERE SAID CODEX "produces no tool or usage frames" — that is no longer true. Since
            `codex exec --json` was wired up it emits `turn.completed` with `output_tokens`, so the status line's
            token count works. It still produces no TOOL frames, which is why the timeline would have nothing to
            put on and the bubble stays.
          */}
          {!usesTimeline && blocks.length > 0 && (
            <div className="flex justify-end gap-2">
              <div className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm ${bubbleClass}`}>
                <AssistantMarkdown
                  content={blocks.map((b) => (b.kind === "text" ? b.text : "")).join("")}
                />
                <span className={`inline-block w-1.5 h-4 ${theme.caret} ml-0.5 motion-safe:animate-pulse`} />
              </div>
              {/*
                `currentCli` is correct HERE and nowhere else in the transcript: this bubble is the turn being
                produced right now, so the selected assistant IS its author. `dark` was left at `false` from when
                this path was light — a leftover the surface change should have caught.
              */}
              <AIIcon dark={usesDarkSurface} provider={currentCli} />
            </div>
          )}

          {/**
            * ── THE STATUS LINE ──
            *
            * `✳ Herding… (15m 28s · ↓ 38.9k tokens)`, the extension's format exactly.
            *
            * SHOWN FOR THE WHOLE TURN, not only before the first token — and that is a change from the
            * previous behaviour, which hid it as soon as text arrived. On an agentic turn that was exactly
            * backwards: the long silences happen DURING tool use, minutes after the first tokens, which is
            * when "is this stuck" gets asked. The clock and the token count are the answer, so they stay
            * up until the turn ends.
            *
            * STILL HIDDEN while a permission prompt is up, and that one is a truthfulness rule rather than
            * a tidiness one: the turn is then blocked on the USER clicking, so "Herding…" would claim
            * Claude is busy when it is idle and waiting.
            *
            * Rendering it conditionally is also how its timers are bounded — the component owns three, and
            * unmounting is what clears them, so every exit condition here is also a teardown.
            *
            * `key={activeId}` remounts it per session, so switching chats restarts the clock instead of
            * showing the previous chat's elapsed time against this one's turn.
            */}
          {streaming && !permissionRequest && (
            <div className={usesTimeline ? "py-2 pl-[30px]" : "flex justify-end gap-2"}>
              {usesTimeline ? (
                <ActivityPhrase
                  key={activeId}
                  startedAt={activeId ? turnStartedAt[activeId] : undefined}
                  retrying={cliStatus === "retrying"}
                  outputTokens={outputTokens}
                  assistant={assistantLabel(currentCli)}
                />
              ) : (
                <div className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm ${bubbleClass}`}>
                  <ActivityPhrase
                    key={activeId}
                    startedAt={activeId ? turnStartedAt[activeId] : undefined}
                    retrying={cliStatus === "retrying"}
                    assistant={assistantLabel(currentCli)}
                  />
                </div>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Workspace trust banner */}
        {/*
          ⚠ THE TRUST BANNER WAS STILL FULLY LIGHT, and it renders on every assistant's transcript — so it was a
          blue-and-white card in the middle of a dark chat. Found by auditing which light classes were reachable
          on the dark surface rather than by seeing it, because it only appears when a folder is untrusted.

          It also said "Claude needs permission" regardless of assistant, which is the same hardcoding found
          in the welcome text and the icons.
        */}
        {trustRequired && (
          <div className="border-t border-surface-line bg-surface-panel px-4 py-3">
            <div className="flex items-start gap-3">
              <span className={`flex-shrink-0 text-lg ${theme.ink}`}>🔒</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-surface-text">Workspace Trust Required</p>
                <p className="mt-0.5 text-xs text-surface-muted">
                  {assistantLabel(currentCli)} needs permission to operate in{" "}
                  <span className="font-mono text-surface-text">{trustRequired}</span>
                </p>
              </div>
              <div className="flex flex-shrink-0 gap-2">
                <button
                  onClick={() => setTrustRequired(null)}
                  className="rounded-md border border-surface-line px-3 py-1.5 text-xs text-surface-text hover:bg-surface-raised"
                >
                  Dismiss
                </button>
                <button
                  onClick={async () => {
                    await api.cliTrustWorkspace(trustRequired);
                    setTrustRequired(null);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${theme.primaryButton}`}
                >
                  Trust Folder
                </button>
              </div>
            </div>
          </div>
        )}

        {/*
          ── THE PERMISSION CARD ──

          ⚠ ALSO STILL FULLY LIGHT, and this is the most consequential surface in the app to get wrong: it is
          where a participant approves a file write or a shell command. A light card on a dark transcript is a
          jolt exactly when someone should be reading carefully, and `bg-amber-50` under `text-amber-900` is a
          light-on-light pairing that means nothing on this background.

          `tool-warning` (10.24:1 here) carries the "attention" signal, and the surface tokens do the rest. The
          ⚠️ glyph and the words "Permission Required" mean colour is not the only cue.
        */}
        {permissionRequest && (
          <div className="border-t border-tool-warning/40 bg-surface-panel px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 text-lg">⚠️</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-tool-warning">Permission Required</p>
                <p className="mt-0.5 break-all font-mono text-xs text-surface-text">
                  {permissionRequest.description}
                </p>
                {permissionRequest.input?.command && (
                  <pre className="mt-1.5 overflow-x-auto rounded border border-surface-line bg-surface-bg px-2 py-1 text-xs text-surface-text">
                    {permissionRequest.input.command}
                  </pre>
                )}
                {permissionRequest.input?.file_path && !permissionRequest.input?.command && (
                  <p className="mt-1 font-mono text-xs text-surface-muted">
                    {permissionRequest.input.file_path}
                  </p>
                )}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={() => {
                    // ⚠ Back to whichever implementation ASKED. Answering the wrong one leaves the
                    // SDK's promise parked for ever — and a parked prompt has no deadline.
                    (usesSdk ? api.claudeSdkPermissionRespond : api.cliPermissionRespond)({
                      id: permissionRequest.id,
                      allow: false,
                      sessionId: activeId,
                    });
                    setMessages((prev) => [...prev, {
                      id: crypto.randomUUID(),
                      role: "system",
                      content: `❌ Denied: ${permissionRequest.description}`,
                    }]);
                    setPermissionBySession((prev) => { const n = { ...prev }; delete n[activeId]; return n; });
                  }}
                  className="rounded-md border border-surface-line px-3 py-1.5 text-xs text-surface-text hover:bg-surface-raised"
                >
                  Deny
                </button>
                <button
                  onClick={() => {
                    (usesSdk ? api.claudeSdkPermissionRespond : api.cliPermissionRespond)({
                      id: permissionRequest.id,
                      allow: true,
                      sessionId: activeId,
                    });
                    setMessages((prev) => [...prev, {
                      id: crypto.randomUUID(),
                      role: "system",
                      content: `✅ Approved: ${permissionRequest.description}`,
                    }]);
                    setPermissionBySession((prev) => { const n = { ...prev }; delete n[activeId]; return n; });
                  }}
                  /*
                    ⚠ ALLOW STAYS DISTINCT FROM THE SEND BUTTON'S TERRACOTTA. This is the consequential control on
                    the card, and making it look like the everyday send action would invite the muscle memory of
                    clicking it without reading. `tool-warning` with dark text: 10.24:1, and unmistakably not the
                    brand colour.
                  */
                  className="rounded-md bg-tool-warning px-3 py-1.5 text-xs font-medium text-surface-bg transition-opacity hover:opacity-90"
                >
                  Allow
                </button>
              </div>
            </div>
          </div>
        )}

        {/*
          Input. Themed with the transcript rather than left light: the two are contiguous, and a white
          form directly beneath a near-black panel reads as a rendering fault rather than a design.
        */}
        {isOtherCli && (
          <div
            className={`border-t px-4 py-2 text-center ${
              usesDarkSurface ? "border-surface-line bg-surface-panel" : "bg-surface-panel"
            }`}
          >
            <span className={`text-xs text-surface-muted`}>
              This chat was created with a different assistant. Switch back to continue.
            </span>
          </div>
        )}
        {/*
          ── THE COMPOSER ──

          ONE BORDERED CARD, not three loose controls on a bare strip. The textarea, the send/stop control
          and the model row now share a single surface with one border that lights up on focus — which is
          how the VS Code extension composes it (`.userMessage` and its input share `--app-input-border`),
          and it is also what makes the group read as one thing you type into rather than a form.

          The `focus-within` ring is on the CARD, so focus is visible on the whole composer instead of a
          hairline around an inner box. That matters more here than usual: the textarea has no visible
          border of its own any more.
        */}
        <form
          onSubmit={handleSend}
          className={`p-3 ${isOtherCli ? "hidden" : ""} ${
            usesDarkSurface ? "border-t border-surface-line bg-surface-bg" : "border-t"
          }`}
        >
          <div
            className={
              usesDarkSurface
                ? `rounded-lg border border-surface-line bg-surface-panel transition-colors ${theme.ring}`
                : "rounded-lg border border-surface-line bg-white transition-colors focus-within:border-blue-500"
            }
          >
            <textarea
              ref={textareaRef}
              value={input}
              /*
                ⚠ A COURTESY, NOT A CONTROL: any client may decline to honour it. The NUMBER comes
                from @praimana/shared so the desktop, the portal and the server mean the same
                thing by "too long" — chat-limits.ts records which of them actually enforces it.
              */
              maxLength={MAX_AI_PROMPT_CHARS}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow(e.target);
              }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(e as any);
                }
              }}
              /**
               * Named phase first, then the project, then the old wording — see
               * lib/composer-placeholder.ts for why an empty composer is worth more than
               * "Ask X anything" and why the phase is so often absent.
               */
              placeholder={composerPlaceholder({
                assistant: currentCli,
                projectName: project.name,
                phaseName,
                streaming,
              })}
              /**
               * ⚠ NOT `disabled` ANY MORE, and this is a fix rather than a restyle.
               *
               * A disabled textarea drops focus the moment a turn starts and cannot take it back, so the
               * participant had to click into the box again after every single reply — and `readOnly`
               * keeps focus, the caret and keyboard navigation while still refusing input. The Enter
               * guard below already prevents a send while streaming, so nothing can be submitted.
               *
               * `aria-disabled` states it for assistive tech, which `readOnly` alone does not convey as
               * "temporarily unavailable".
               */
              readOnly={streaming}
              aria-disabled={streaming}
              /**
               * ⚠ AN ACCESSIBLE NAME, which this box did not have — see ComposerKeyHint. The name is
               * built from the ACTIVE assistant rather than hardcoded, so it matches what the rest of
               * the view says it is talking to.
               */
              aria-label={`Message ${assistantLabel(currentCli)}`}
              aria-describedby={hintId}
              rows={1}
              /*
                BORDERLESS AND TRANSPARENT: the card around it draws the border and the fill, so an inner
                border here would render a box inside a box. `outline-none` is safe precisely because the
                card shows focus via `focus-within`.
              */
              className={`w-full resize-none overflow-y-hidden bg-transparent px-3.5 py-3 text-sm outline-none leading-5 ${
                streaming
                  ? "text-surface-muted placeholder:text-surface-muted cursor-default"
                  : "text-surface-text placeholder:text-surface-muted"
              }`}
              style={{ minHeight: "44px", maxHeight: "200px" }}
            />

            {/*
              ── THE ACTION ROW, inside the card ──
              Model on the left (a setting for what you are about to send), send/stop on the right. Grouping
              them in the composer rather than stranding the model picker below it is the "layout" half of
              the request: the two are read together, so they sit together.
            */}
            <div
              className="flex items-center gap-2 px-2.5 pb-2.5 pt-0"
            >
              <ModelPicker
                selectedModel={selectedModel}
                onSelect={setSelectedModel}
                options={availableModels}
                defaultModel={defaultModel}
                disabled={streaming}
                dark={usesDarkSurface}
              />

              {/*
                ⚠ THE REASONING CONTROL WAS HERE AND HAS BEEN REMOVED, because it could not work. Setting an
                effort needs `codex exec -c model_reasoning_effort=…`, and ANY `-c` override breaks this
                config's Bedrock credential provider — measured, including with `-c` set to the value the
                config already had. Every Codex turn failed silently while it was wired up. The evidence and
                the measurements are in `buildCliArgs`; restore this only when Codex offers a flag that does
                not go through `-c`.
              */}

              <div className="ml-auto flex items-center gap-2">
                {/*
                  The keyboard hint, which the placeholder used to carry. Moved out of it for a reason: a
                  placeholder vanishes the moment you start typing, so the one affordance a new user needs
                  disappeared exactly when they were about to use it. Hidden while streaming, when Enter
                  does nothing.
                */}
                <CharCounter value={input} max={MAX_AI_PROMPT_CHARS} hidden={streaming} />
                {/*
                  Glyphs for eyes, the same contract in words for screen readers — see the component.
                  `tone` preserves this view's surface-dependent ink; it is the one composer that varied.
                */}
                <ComposerKeyHint
                  id={hintId}
                  busy={streaming}
                  tone={usesDarkSurface ? "faint" : "muted"}
                  busySubject={assistantLabel(currentCli)}
                />

                {streaming ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (!activeId) return;
                      (usesSdk ? api.claudeSdkStop : api.cliStop)(activeId);
                      setStreamingSessions((prev) => ({ ...prev, [activeId]: false }));
                      setTurnStartedAt((prev) => omitKey(prev, activeId));
                      /**
                       * ⚠ THE BLOCKS ARE NOT CLEARED, and the previous code cleared them. Wiping the
                       * partial reply on Stop destroyed the very thing the participant pressed Stop to keep
                       * looking at — including every tool step the turn had already completed. A stopped
                       * turn is still a record of work done; only the token count is dropped, and only
                       * because it belongs to a clock that is no longer running.
                       */
                      setTokensBySession((prev) => { const n = { ...prev }; delete n[activeId]; return n; });
                    }}
                    aria-label="Stop generating"
                    /*
                      A SQUARE STOP GLYPH, not the word "Stop" in red. Red on this surface was the loudest
                      thing in the window and read as an error rather than a control; the filled square is
                      the universal stop mark and needs no colour to say so. The label stays for screen
                      readers.
                    */
                    className={`flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors ${
                      usesDarkSurface
                        ? "border-surface-line bg-surface-raised text-surface-text hover:border-tool-error hover:text-tool-error-text"
                        : "border-surface-line bg-white text-surface-text hover:border-red-400 hover:text-red-600"
                    }`}
                  >
                    <span aria-hidden="true" className="text-[9px] leading-none">■</span>
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    aria-label="Send message"
                    /*
                      TERRACOTTA, not blue: this is the Claude surface and the send control is the one place
                      a brand colour belongs. `claude-strong` (#a8432c) rather than `accent`, because white
                      text sits on it — accent is the indicator token and fails as a text background.
                      Square-ish and icon-led so it reads as an action rather than a form submit.
                    */
                    className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${theme.primaryButton}`}
                    title="Send message"
                  >
                    <SendIcon />
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>

        {/**
          * ── THE "Stream Log" DEBUG PANEL WAS REMOVED ──
          *
          * A collapsible terminal showing raw `cli:raw` frames — every JSON line the CLI emitted,
          * colour-coded by frame type. It existed because there was nothing else to look at while a turn
          * ran: the SDK path shipped without token streaming, so a participant staring at a spinner had
          * this panel as the only evidence anything was happening.
          *
          * That reason is gone. Replies now stream token by token into the conversation itself
          * (includePartialMessages), so the answer IS the progress indicator — and a raw frame dump next
          * to it is noise in a tool aimed at workshop participants rather than at the people debugging
          * it. Diagnostics live in the debug log, which is where an operator looks anyway.
          *
          * `cli:raw` is STILL EMITTED by cli-assistant.ts and still bridged in the preload. Deliberate:
          * this removes a UI surface, not a diagnostic channel, and a future debug view or a support
          * bundle can consume it without re-plumbing anything.
          */}
        </>
        )}
      </div>

      {/*
        ── PINNED SHARED CHAT, DOCKED AS A SECOND COLUMN ─────────────────────────────────────
        Between the live chat and the history drawer, with the real pinned pane's left divider. The live
        composer on the left stays usable. Session-only; mirrors KiroChatView.
      */}
      {pinnedThread && (
        <div
          className={`relative flex flex-col overflow-hidden border-l ${
            usesDarkSurface ? "border-surface-line" : ""
          }`}
          style={{ width: pinnedWidth, flex: "0 0 auto" }}
        >
          {/*
            Drag-to-resize handle on the LEFT edge — the divider facing the live chat. Dragging it trades
            width between the two panes (the live chat is `flex-1 min-w-0`, so it absorbs the remainder).
            Pointer events for mouse+touch; `role="separator"` + arrow keys for the keyboard.
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
            className="absolute left-0 top-0 z-10 h-full w-1.5 -ml-0.5 cursor-col-resize hover:bg-brand-strong/30 focus:bg-brand-strong/40 focus:outline-none"
          />
          <SharedThreadPanel
            thread={pinnedThread}
            pinned
            fetcher={makeSharedFetcher(pinnedThread.id)}
            refreshSignal={sharedRefreshSignal}
            dark={usesDarkSurface}
            userBubble={theme.userBubble}
            bubbleClass={bubbleClass}
            onClose={() => setPinnedThread(null)}
            onTogglePin={() => unpinSharedThread()}
          />
        </div>
      )}

      {/* Chat history panel (right side, toggled by the header history icon) */}
      {showHistory && (
        <div
          className={`w-60 border-l flex flex-col overflow-hidden ${
            usesDarkSurface ? "border-surface-line bg-surface-panel" : "bg-surface-panel"
          }`}
        >
          <div className={`flex items-center justify-between px-3 py-2 border-b ${usesDarkSurface ? "border-surface-line" : ""}`}>
            <span className={`text-xs font-semibold uppercase tracking-wide ${usesDarkSurface ? "text-surface-muted" : "text-surface-faint"}`}>Chat History</span>
            <div className="flex items-center gap-1">
            <IconTooltip label={refreshing ? "Refreshing…" : "Refresh conversations"}>
              <button
                onClick={() => void refreshConversations()}
                disabled={refreshing}
                className={`p-1 rounded transition-colors disabled:opacity-50 ${usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "text-surface-muted hover:bg-surface-raised hover:text-surface-muted"}`}
                title="Refresh"
                aria-label={refreshing ? "Refreshing conversations" : "Refresh conversations"}
              >
                <RefreshIcon spinning={refreshing} />
              </button>
            </IconTooltip>
            <button
              onClick={toggleHistory}
              className={`p-1 rounded transition-colors ${usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "text-surface-muted hover:bg-surface-raised hover:text-surface-muted"}`}
              title="Hide chat history"
              aria-label="Hide chat history"
            >
              ✕
            </button>
            </div>
          </div>

          {/* Tabs: my local chats vs. chats shared by teammates. */}
          {/*
            Tabs: my local chats vs. chats shared by teammates. Both preserved exactly as they were — only
            the palette is conditional. The selected tab is marked by a BORDER as well as a colour, so the
            selection does not rest on hue alone.
          */}
          <div className={`flex border-b text-xs ${usesDarkSurface ? "border-surface-line" : ""}`}>
            <button
              onClick={() => setHistoryTab("mine")}
              className={`flex-1 px-3 py-2 font-medium transition-colors ${
                historyTab === "mine"
                  ? usesDarkSurface
                    ? `${theme.ink} border-b-2 border-current`
                    : "text-blue-600 border-b-2 border-blue-600"
                  : usesDarkSurface
                    ? "text-surface-muted hover:text-surface-text"
                    : "text-surface-faint hover:text-surface-text"
              }`}
            >
              Chats
            </button>
            <button
              onClick={() => setHistoryTab("team")}
              className={`flex-1 px-3 py-2 font-medium transition-colors ${
                historyTab === "team"
                  ? usesDarkSurface
                    ? `${theme.ink} border-b-2 border-current`
                    : "text-blue-600 border-b-2 border-blue-600"
                  : usesDarkSurface
                    ? "text-surface-muted hover:text-surface-text"
                    : "text-surface-faint hover:text-surface-text"
              }`}
            >
              Team Chats
            </button>
          </div>

          {historyTab === "mine" ? (
            <>
              <div className="p-2">
                <button
                  onClick={handleNewSession}
                  className={`w-full text-left rounded border border-dashed px-3 py-2 text-xs transition-colors ${usesDarkSurface ? "border-surface-line text-surface-muted hover:bg-surface-raised hover:border-current hover:text-surface-text" : "text-surface-faint hover:bg-white hover:border-blue-300"}`}
                >
                  + New Chat
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-0.5">
                {sessions.length === 0 && (
                  <p className={`text-[11px] px-3 py-2 text-surface-muted`}>No previous chats yet.</p>
                )}
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => handleSelectSession(session)}
                    className={`w-full text-left rounded px-3 py-2 text-xs mb-0.5 ${
                      activeSession?.id === session.id
                        ? usesDarkSurface
                          ? "bg-surface-raised text-surface-text"
                          : "bg-blue-100 text-blue-700"
                        : usesDarkSurface
                          ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text"
                          : "hover:bg-surface-panel text-surface-muted"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {/*
                        ⚠ NO `|| currentCli` FALLBACK. That was half of the reported icon bug: an untagged chat
                        adopted whichever assistant happened to be selected, so switching to Kiro appeared to
                        relabel the entire history. An unknown provider now renders as unknown.
                      */}
                      <AIIcon dark={usesDarkSurface} provider={(session as any).ai_provider} />
                      <div className="truncate font-medium flex-1">
                        {session.title || "Untitled"}
                      </div>
                      {/*
                        ── ⚠ A LABEL, NOT A DOT ──────────────────────────────────────────────

                        It WAS marked — by a 1.5px dot in `bg-tool-ok`, which is the same size and the
                        SAME COLOUR as the streaming indicator immediately after it, differing only by
                        `animate-pulse`. So the one piece of state a reader most needs (this
                        conversation is visible to my team) was encoded as a 6px circle that is
                        ambiguous with "currently generating". A word cannot be confused with either.
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
                        <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-tool-ok" title="Streaming" />
                      )}
                    </div>
                    {/*
                      Same Today/Yesterday/date formatter as the transcript, so a chat's age reads the same
                      in the list as it does inside. Previously this printed a bare "8 Aug 14:32" with no
                      year, which is the reported complaint one level up: a conversation from LAST year read
                      as this one.
                    */}
                    {formatMessageInstant(session.updated_at) && (
                      <div className={`text-[10px] mt-0.5 ml-8 tabular-nums ${usesDarkSurface ? "text-surface-faint" : "text-surface-muted"}`}>
                        {formatMessageInstant(session.updated_at)}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {!hasTeam && (
                <p className={`text-[11px] px-3 py-2 text-surface-muted`}>Join a team to see chats shared by your teammates.</p>
              )}
              {hasTeam && sharedThreads.length === 0 && (
                <p className={`text-[11px] px-3 py-2 text-surface-muted`}>No chats have been shared with your team yet.</p>
              )}
              {sharedThreads.map((thread) => (
                <button
                  key={thread.id}
                  onClick={() => openSharedThread(thread)}
                  className={`w-full text-left rounded px-3 py-2 text-xs mb-0.5 ${usesDarkSurface ? "text-surface-muted hover:bg-surface-raised hover:text-surface-text" : "hover:bg-surface-panel text-surface-muted"}`}
                >
                  <div className="flex items-center gap-2">
                    {/*
                      ⚠ NO `|| "claude"`. A teammate's chat with no recorded provider was labelled Claude, which
                      is a guess — and this list is entirely OTHER people's chats, so the guess is wrong more
                      often here than anywhere else. The disc stays because the icon column aligns the rows.

                      ⚠ AND THE DISC IS DARK. This row sits in the dark history panel, so `dark={false}` put a
                      light-grey circle on it — only visible for an unknown provider, which is why it survived.
                    */}
                    <AIIcon provider={thread.aiProvider} />
                    <div className="truncate font-medium flex-1">
                      {thread.title || "Untitled"}
                    </div>
                  </div>
                  <div className={`text-[10px] mt-0.5 ml-8 ${usesDarkSurface ? "text-surface-faint" : "text-surface-muted"}`}>
                    {thread.sharedByName ? `Shared by ${thread.sharedByName}` : "Shared"}
                    {/*
                      Date AND time. This showed the date alone, so two chats shared on the same day were
                      indistinguishable — and "Today" with no clock told a teammate nothing about which of
                      three shares was the latest.
                    */}
                    {formatMessageInstant(thread.sharedAt) && (
                      <span className="tabular-nums">{" · "}{formatMessageInstant(thread.sharedAt)}</span>
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

/**
 * ── PIN GLYPH ── filled when pinned, outline when not. Matches the 14px header glyphs here.
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

/**
 * ── "LIVE · UPDATED Xs AGO" ── a quiet confirmation the pinned pane is polling. Pulsing dot + "live"
 * while a refresh is in flight, then elapsed time since the last one, ticked locally each second.
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

/**
 * ── READ-ONLY SHARED-CHAT PANEL ───────────────────────────────────────────────────────────
 *
 * A teammate's conversation rendered IN THE WINDOW (not a modal), same transcript treatment as the live
 * chat but NO composer. One component, two roles: full-column takeover (`pinned === false`, with a ←
 * back control) or a narrower pinned side-pane (`pinned === true`, with a live indicator).
 *
 * ⚠ TOP-LEVEL, NOT NESTED — it must not close over `theme`/`bubbleClass` (inner-components.test.ts), so
 * those arrive as props. The shared chat's OWN assistant icon throughout; replies through
 * AssistantMarkdown (never bare ReactMarkdown — chat-view-parity.test.ts).
 */
function SharedThreadPanel({
  thread,
  pinned,
  fetcher,
  refreshSignal,
  dark,
  userBubble,
  bubbleClass,
  onClose,
  onTogglePin,
}: {
  thread: SharedThread;
  pinned: boolean;
  fetcher: PageFetcher<SharedMessage>;
  refreshSignal?: number;
  dark: boolean;
  userBubble: string;
  bubbleClass: string;
  onClose: () => void;
  onTogglePin: () => void;
}) {
  const { messages, loading, loadingOlder, hasMore, refreshedAt, openNewest, loadOlder, refreshTail } =
    useThreadPagination<SharedMessage>(fetcher, SHARED_PAGE_SIZE);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void openNewest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useEffect(() => {
    if (!pinned) return;
    const timer = setInterval(() => void refreshTail(true), 15_000);
    return () => clearInterval(timer);
  }, [pinned, refreshTail]);

  useEffect(() => {
    if (!pinned || !refreshSignal) return;
    void refreshTail(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Scroll-up pagination, holding the scroll position across the prepend (see KiroChatView).
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
      <div className={`${PANE_HEADER} justify-between bg-surface-panel`}>
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
          <AIIcon dark={dark} provider={thread.aiProvider} />
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
          {pinned && <LiveIndicator loading={loading} lastRefreshed={refreshedAt} />}
          <button
            onClick={onTogglePin}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              pinned
                ? "text-brand-strong hover:bg-surface-raised"
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

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 space-y-3 overflow-y-auto p-4">
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
                msg.role === "user" ? userBubble : bubbleClass
              }`}
            >
              {msg.role === "user" ? (
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              ) : (
                <AssistantMarkdown content={msg.content} />
              )}
              {formatMessageInstant(msg.createdAt) && (
                <div
                  className={`mt-1 text-[10px] tabular-nums ${
                    msg.role === "user" ? "text-white/70" : "text-surface-faint"
                  }`}
                >
                  {formatMessageInstant(msg.createdAt)}
                </div>
              )}
            </div>
            {msg.role !== "user" && (
              <AIIcon dark={dark} provider={thread.aiProvider} placeholder="none" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * ── ONE TURN'S BLOCKS, AS TIMELINE ROWS ──
 *
 * A module-level function rather than a component, because it renders a FRAGMENT of siblings into the
 * transcript's flow — the timeline spine relies on rows being adjacent siblings, and wrapping each turn in
 * a component would put a `<div>` between them and break the connecting rule.
 *
 * @param live The turn is still in flight, so its LAST prose block gets the typing caret. Only the last:
 *   a caret after an earlier paragraph would mark an insertion point that has already moved on.
 */
/**
 * ⚠ `caret` IS A PARAMETER, NOT A CLOSURE READ. This is a top-level function — deliberately, since a
 * component declared inside another remounts its subtree every render (see inner-components.test.ts) —
 * so it cannot see `theme`. Passing the one class it needs keeps it that way; reaching for a
 * module-level mutable would make the colour depend on render order.
 */
function renderBlocks(
  blocks: TranscriptBlock[],
  { live = false, caret, proseCode }: { live?: boolean; caret: string; proseCode: string }
) {
  return blocks.map((block, i) => {
    // `i` IS the key, and here it is the right one rather than the lazy one: blocks are only ever appended
    // or updated in place, never inserted or reordered, so an index is stable for a given block's lifetime.
    const key = `${i}-${block.kind}`;
    const isLast = i === blocks.length - 1;

    if (block.kind === "note") {
      return <ToolStepOverflow key={key} hidden={block.hidden} />;
    }
    if (block.kind === "tool") {
      return <ToolStep key={key} block={block} />;
    }
    return (
      <TimelineRow key={key} state={live && isLast ? "progress" : "success"} isLast={isLast}>
        <div className={`py-1 ${assistantProseClass(proseCode)}`}>
          <AssistantMarkdown content={block.text} />
          {/*
            Terracotta caret on the live tail. `motion-safe:` on the pulse so a reduced-motion user gets a
            steady block instead of a blinking one — it still marks the insertion point, which is the actual
            information; only the blink is decoration. Opacity-only, so it composites without touching
            layout.
          */}
          {live && isLast && (
            <span className={`ml-0.5 inline-block h-4 w-1.5 ${caret} motion-safe:animate-pulse`} />
          )}
        </div>
      </TimelineRow>
    );
  });
}

/**
 * ── THE MODEL PICKER ──
 *
 * Two things had to change together. The old row was a bare `<select>` labelled "Model:" with the note
 * "Uses CLI default" — which told the reader a default EXISTS while withholding which one, the only part
 * worth printing. And it looked like a form control on a page that had stopped being a form.
 *
 * So: a native `<select>` overlaid on styled content. The select stays REAL and stays on top at zero
 * opacity, which is the part that matters — it keeps the platform's own dropdown, its keyboard behaviour,
 * its type-to-select and its screen-reader semantics, none of which a div-based menu gets for free. What is
 * painted underneath is the branded row: a terracotta spark, the model's NAME, a "1M" badge when the
 * extended-context variant is active, and its capability in a word.
 *
 * ⚠ THE "wow factor" IS NOT A GRADIENT. It is that the row states something true and specific — "Opus 5",
 * "1M", "Most intelligent" — where it used to state something vague. A brand mark on a vague label is
 * still a vague label.
 */
/**
 * ⚠ `ModelPicker` MOVED TO ITS OWN FILE so Kiro's composer can use the same one — see
 * `ModelPicker.tsx`. Same reasoning as `SendIcon` below: two copies of a control that states which model is
 * answering would drift, and each drift is a composer telling a participant something slightly untrue.
 */

/* ─── Icons ────────────────────────────────────────────────────── */

/**
 * ⚠ `SendIcon` MOVED TO ITS OWN FILE so Kiro's composer can use the same one. Copying an 8-line SVG is how two
 * send buttons end up a stroke width apart, which is the inconsistency this removes.
 */

/**
 * The refresh glyph.
 *
 * ⚠ `motion-safe:` ON THE SPIN, because a continuously rotating element is exactly what
 * `prefers-reduced-motion` exists to suppress — and the disabled state already tells a reader the action is
 * in flight, so nothing is lost by holding still.
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
