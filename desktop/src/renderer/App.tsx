import { useState, useEffect, useRef, type ReactNode, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Sidebar } from "./components/Sidebar";
import { AssistantChatView } from "./components/AssistantChatView";
import { KiroChatView } from "./components/KiroChatView";
/* Makes the file names in a message clickable — see the providers at the chat pane and at team chat. */
import { FileMentionScope } from "./components/FileMentions";
import { assistantTheme } from "./lib/assistant-theme";
import { PhasesView } from "./components/PhasesView";
import { BoardView } from "./components/BoardView";
import { TeamChatView } from "./components/TeamChatView";
import { AccountPanel } from "./components/AccountPanel";
import { GitPanel } from "./components/GitPanel";
import { SettingsView } from "./components/SettingsView";
/**
 * ⚠ `SetupView` IS GONE — it launched the Cognito Hosted UI in the system browser. Replaced by
 * `SignInView`, a native form, because the portal's login leaves no Hosted UI session (measured)
 * and no server-side grant can mint a token
 * either. See SignInView's header.
 */
import { SignInView } from "./components/SignInView";
import { PlatformSetupView } from "./components/PlatformSetupView";
import { JoinTeamView } from "./components/JoinTeamView";
import { SelectAssistantView } from "./components/SelectAssistantView";
/* Covers the whole launch — see the boot gate below. */
import { LoadingView } from "./components/LoadingView";
/* The launch profile chooser, reused for File → New Profile… — see the early return below. */
import { ProfileChooser } from "./components/ProfileChooser";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { useToast } from "./components/Toast";
import { useTeamUnread } from "./hooks/useTeamUnread";
import { paneLayout } from "./lib/pane-layout";
import { PanePin } from "./components/PanePin";
import { PanePinProvider } from "./components/PanePinSlot";
import { FileTabs } from "./components/FileTabs";
import { FileSearch } from "./components/FileSearch";
/* Asked before the picked folder is granted or the current one replaced — see performSwitch. */
import { SwitchFolderConfirm } from "./components/SwitchFolderConfirm";
/* Blocks the app while the setup agent writes into the just-opened folder — see performSwitch. */
import { FrameworkSetupBlocker } from "./components/FrameworkSetupBlocker";
import { EMPTY_TABS, closeTab, closeTabsOutside, openTab, type TabState } from "./lib/file-tabs";
import { PANE_DIVIDER, PANE_HEADER } from "./lib/pane-header";
import { basenameOf, samePath } from "./lib/file-tree-ops";
import { relativeTime } from "./lib/relative-time";
import { QuestionForm } from "./components/QuestionForm";
import {
  parseQuestions,
  setAnswer,
  type ParsedQuestion,
} from "./lib/aidlc-questions";

const api = (window as any).electronAPI;

/**
 * ── ⚠ THE PROFILE CHIP'S WIDTH, AND THE OFFSET THAT MUST CLEAR IT ─────────────────────────────
 *
 * ⚠ THESE TWO NUMBERS WERE COUPLED AND WRITTEN OUT SEPARATELY, which is why they are constants now. The
 * search band's left edge was a literal `292` whose own comment explained it as "the label's max-w plus
 * its padding and a gap" — 92 + 180 + 20. Widening the chip to 300 while leaving 292 behind would slide
 * the search field underneath the profile name, so the value that has to change in step is derived
 * rather than remembered.
 *
 * `TRAFFIC_LIGHT_INSET_PX` is the OS's own reservation: close/minimise/zoom are drawn there, and anything
 * placed under them is both unreadable and unclickable.
 */
const PROFILE_CHIP_MAX_PX = 300;
/**
 * ── ⚠ ONLY macOS RESERVES SPACE ON THE LEFT ───────────────────────────────────────────────────
 *
 * 92px is the width of the macOS traffic lights, which are drawn at the TOP LEFT over our own strip.
 * Windows and Linux put their window buttons at the top RIGHT and, since `titleBarStyle` is now the
 * default frame off macOS, draw them in a real title bar above the content rather than over it — so
 * there is nothing to reserve, and reserving anyway left a 92px hole at the start of the strip and
 * pushed the search field off centre.
 *
 * ⚠ READ FROM THE BRIDGE, SYNCHRONOUSLY, so the first paint is already correct — see `platform` in
 * the preload. `?? "darwin"` keeps the macOS layout when the bridge is absent, which is the case in
 * a plain test render and the safer default: an unnecessary gap is survivable, whereas a strip drawn
 * UNDER the traffic lights is unreadable and unclickable.
 */
const IS_MAC = ((window as any).electronAPI?.platform ?? "darwin") === "darwin";
const TRAFFIC_LIGHT_INSET_PX = IS_MAC ? 92 : 0;
/** `px-2` on each side plus a gap before the search band. */
const PROFILE_CHIP_GUTTER_PX = 20;
const SEARCH_LEFT_WITH_PROFILE =
  TRAFFIC_LIGHT_INSET_PX + PROFILE_CHIP_MAX_PX + PROFILE_CHIP_GUTTER_PX;

/**
 * ⚠ NO "explorer" VIEW, deliberately: the file tree it hosted is the sidebar panel now,
 * permanently visible, so routing the main area to it would show a second copy of what is already beside it.
 *
 * ⚠ "source-control" IS ITS GIT HALF, RESTORED TO A TAB: a Source Control tab showing
 * the current git actions, rather than a section added to the side panel. It spent one revision squeezed
 * into the sidebar under the tree, which was the wrong call — 240px cannot hold a commit field, four action
 * buttons, a scrollable log AND a diff, and the diff was unreadable at that width.
 *
 * These actions have now been unreachable once (shipped unmounted) and cramped once. The tab is the third and
 * correct placement, and `explorer-sidebar.test.ts` pins that they remain reachable either way.
 */
type View =
  | "chat"
  | "phases"
  | "board"
  | "team-chat"
  | "source-control"
  /**
   * ⚠ "account" WAS A MODAL. Clicking the participant now opens a view like Settings rather than a
   * popup, for a consistent layout — so the read-only account details are a routed view now, reached from the
   * user row at the foot of the sidebar and left through the nav, exactly like Settings.
   */
  | "account"
  | "settings";

/**
 * ⚠ NOT EVERY VIEW IS WORTH PINNING, and the exclusions are the point.
 *
 * `settings` and `account` are places you GO, do one thing, and leave — pinning either beside your work
 * would hold a form open indefinitely. `source-control` is excluded for a sharper reason: it has its own
 * three-tab layout and a commit field, and at half width the file list and the message box stop being
 * usable at exactly the moment they matter.
 *
 * What remains is the set someone genuinely watches while doing something else: a conversation, the
 * board, the phases.
 */
const PINNABLE_VIEWS: readonly View[] = ["chat", "team-chat", "board", "phases"];

/**
 * Names for the pane pin's tooltip — "Pin Team Chat", not "Pin team-chat".
 *
 * ⚠ `chat` IS DELIBERATELY ABSENT. Its name is whichever assistant is configured, which is state, not a
 * constant; `pinFor` supplies it. A hardcoded "AI Chat" here would be a second name for the thing the
 * sidebar already calls Claude, Kiro or Codex. `pane-pin.test.ts` asserts the keys match PINNABLE_VIEWS
 * minus chat, so adding a pinnable view without naming it cannot ship as a raw key in the UI.
 */
const PANE_LABELS: Record<string, string> = {
  "team-chat": "Team Chat",
  board: "Board",
  phases: "Phases",
};

const ASSISTANT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  kiro: "Kiro",
  codex: "Codex",
};

interface Project {
  id: string;
  name: string;
  path: string;
}

export default function App() {
  // Only the setter is used: the list itself is never rendered (the sidebar
  // reads activeProject). Kept as state so loadProjects still has somewhere to
  // put its result rather than silently discarding it.
  const [, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [view, setView] = useState<View>("chat");
  /**
   * ── COLLAPSING THE LEFT PANEL ────────────────────────────────────────────────────────
   *
   * Persisted, like `chat_history_visible`: a panel someone collapsed to get screen back should still be
   * collapsed next launch, or they collapse it again every session.
   *
   * ⚠ COLLAPSED, NOT UNMOUNTED. The sidebar owns the file tree, which loads its own data and holds its
   * expanded folders — unmounting it would throw that away and re-fetch on every toggle. It is hidden
   * with a width of 0 instead, so re-opening is instant and nothing is refetched.
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /**
   * ── A SECOND VIEW, BESIDE THE FIRST ──────────────────────────────────────────────────
   *
   * `null` = one pane, exactly as before. Set = that view is pinned to a second pane beside the active
   * one, so team chat can sit next to an AI conversation.
   */
  const [pinnedView, setPinnedView] = useState<View | null>(null);
  /**
   * ⚠ `null` UNTIL KNOWN, not `false`. Every other gate below can default to "not yet"
   * and be corrected a frame later, because being wrong flashes a screen the user was
   * heading to anyway. This one cannot: defaulting to false renders "Connect to your
   * platform" at every launch of a CONFIGURED app, so the first thing a returning
   * participant sees is a setup screen asking for something they already did.
   */
  /**
   * ── ⚠ ALL FOUR GATES START AS `null` — "NOT ASKED YET", NOT "NO" ──────────────────────────
   *
   * `connected`, `teamJoined` and `setupComplete` were `false` initially, and `false` is a MEANINGFUL ANSWER
   * — so the render chain below happily routed on it before anything had been read. `platformConfigured`
   * already had this treatment and its guard already existed; the other three were simply left out of it.
   *
   * ⚠ THE TYPE IS THE FIX AS MUCH AS THE GUARD. A boolean cannot express "unknown", so any future gate
   * declared as one reintroduces this bug and nothing complains. Declared this way, the guard below is
   * a compile-time-shaped reminder rather than a convention.
   */
  const [platformConfigured, setPlatformConfigured] = useState<boolean | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [teamJoined, setTeamJoined] = useState<boolean | null>(null);
  /**
   * ── ⚠ THE TEAM IS UNREADABLE, WHICH IS NOT THE SAME AS SIGNED OUT ────────────────────────
   *
   * THE QUESTION: why not check the user's session and redirect to sign-in instead of showing the
   * message? The instinct was right, the destination was not.
   *
   * A 403 means the token was ACCEPTED and this identity is simply not a member of this team, so the
   * session is fine. Sending the user to LOGIN would mint a token for the same identity, which the
   * same team refuses again: login → 403 → login. The screen that fixes a team problem is
   * `JoinTeamView`, which the `!teamJoined` gate below already routes to.
   *
   * ⚠ DERIVED STATE, NEVER PERSISTED. `team_joined` and `team_id` are left alone, so if the verdict
   * was wrong — a server blip, a misconfiguration mid-workshop — the next successful probe puts the
   * user straight back with nothing to rebuild. Clearing stored team state would make a transient 403
   * indistinguishable from a real removal.
   */
  const [teamAccessReason, setTeamAccessReason] = useState<string | null>(null);
  /**
   * Has the user already completed a sign-in since the team stopped being readable?
   *
   * ⚠ THIS IS THE LOOP ESCAPE, AND IT IS NOT OPTIONAL. A 403 means the token was ACCEPTED, so signing
   * in again SUCCEEDS and the team is still refused — without this, "403 → sign-in" sends the user
   * round for ever: sign in, land back on sign-in, sign in. One pass at re-authentication is the
   * rule; a second would be a trap, so after it the join screen takes over.
   *
   * Not persisted: it describes this run, and a fresh launch should re-check rather than remember a
   * verdict that may have been fixed on the server in between.
   */
  const [reauthTried, setReauthTried] = useState(false);
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  /**
   * ── ⚠ HAS THE FIRST LOAD FINISHED? ────────────────────────────────────────────────────────
   *
   * ⚠ THE NULLABLE GATES WERE NOT ENOUGH, WHICH IS WHY THIS EXISTS AS WELL. Those stopped the chain
   * routing before the four SETTINGS were read; they said nothing about the rest of `checkState`, and
   * `loadProjects()` runs LAST — after the network probe. So the shell painted with `activeProject`
   * still null, which is the add-project empty state. The previous fix moved the flash rather than
   * removing it.
   *
   * ⚠ ONE FLAG FOR THE WHOLE FUNCTION, rather than a fifth nullable value. "Fully loaded" is a property
   * of `checkState` having run, not of any single row, and every part of it is bounded — local IPC plus
   * one probe capped at 4s by the docs service's own `READ_TIMEOUT_MS`.
   *
   * ⚠ IT IS NEVER SET BACK TO TRUE. `checkState` re-runs on sign-out, assistant changes and folder
   * switches; blanking the whole app to a splash on each of those would be a far worse flicker than the
   * one being fixed. This describes the FIRST load only.
   */
  const [booting, setBooting] = useState(true);
  const [assistantName, setAssistantName] = useState("AI Chat");
  const [aiCommand, setAiCommand] = useState("claude");
  /**
   * The open files and which one is showing.
   *
   * ⚠ WAS A SINGLE `openFilePath`, and that is what "multiple tabs to open multiple files" was asking to
   * change: opening a file replaced the one before it, so following a reference lost your place — and any
   * unsaved edit in it. The rules live in `lib/file-tabs.ts`.
   */
  const [tabs, setTabs] = useState<TabState>(EMPTY_TABS);
  /**
   * Which open files have unsaved changes.
   *
   * ⚠ LIFTED OUT OF THE EDITOR ON PURPOSE, for two reasons that are both about not losing work: the tab row
   * marks a dirty file, and `openTab` refuses to close one to make room at the cap.
   */
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());

  /** Open a file, or focus it if it is already open. */
  function handleOpenFile(filePath: string) {
    const { state, refused } = openTab(tabs, filePath, (p) => dirtyFiles.has(p));
    // Shed the request OBSERVABLY: a cap that silently declines looks like a broken click.
    if (refused) toast.error(refused);
    setTabs(state);
  }

  function handleCloseFile(filePath: string) {
    setTabs((prev) => closeTab(prev, filePath));
    /* The editor unmounts, so its dirty flag must go with it or the tab cap would count a file nobody has open. */
    setDirtyFiles((prev) => {
      if (!prev.has(filePath)) return prev;
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
  }

  function handleDirtyChange(filePath: string, isDirty: boolean) {
    setDirtyFiles((prev) => {
      if (prev.has(filePath) === isDirty) return prev; // No new Set unless it actually changed.
      const next = new Set(prev);
      if (isDirty) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  }
  const [useAcpMode, setUseAcpMode] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchStatus, setSwitchStatus] = useState("");
  /**
   * A folder the user picked and has not yet confirmed opening.
   *
   * ⚠ HELD IN THE RENDERER ON PURPOSE, and it grants nothing. The path is already vouched for in
   * main (the picker recorded it), so parking it here only decides WHEN the grant is asked for —
   * `performSwitch` is the only thing that commits, and it runs from this dialog's confirm.
   */
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  /**
   * ── ⚠ IS AN ASSISTANT MID-TURN? ───────────────────────────────────────────────────────────────
   *
   * ⚠ AND THE REASON THE SWITCH MUST WAIT IS NOT COSMETIC. `performSwitch` opens by killing the CLI
   * and the ACP client, then hands the folder to a framework install that can run an agent of its
   * own — so switching mid-turn discards a reply the participant is waiting for, and does it while
   * the agent may be part-way through writing files into the folder being closed.
   */
  const [assistantBusy, setAssistantBusy] = useState(false);
  /**
   * The framework being installed right now, or null. Drives the blocking overlay — see
   * FrameworkSetupBlocker for why this one modal has no way out, and why that is bounded.
   */
  const [frameworkSetup, setFrameworkSetup] = useState<string | null>(null);
  /**
   * The latest `framework:progress` line, for the blocker's status row.
   *
   * ⚠ ONE LISTENER FOR THE WINDOW, NOT ONE PER INSTALL. `performSwitch` used to register a fresh
   * callback on every switch and `SettingsView` on every assistant change, and the preload exposes no
   * remover — so the handlers accumulated for the life of the window and every progress event fanned out
   * to all of them. Both install paths now share this one, which is also what lets the blocker show live
   * steps no matter which of them raised it.
   */
  const [frameworkStep, setFrameworkStep] = useState("");
  useEffect(() => {
    api.onFrameworkProgress?.((data: { step: string }) => setFrameworkStep(data.step));
    /* Detaches on unmount, and on StrictMode's second mount in development — see the preload note. */
    return () => api.removeFrameworkProgressListeners?.();
  }, []);
  /**
   * ── ⚠ TELL THE FOLDER-READING VIEWS THAT SOMETHING ELSE WROTE ─────────────────────────────────
   *
   * A counter the tree and the git panel watch. It exists because the switch now opens the folder
   * BEFORE the framework installs (that reordering is what made the switch feel instant), so both of
   * them list the folder as it was a moment before an agent copied a framework tree into it.
   *
   * ⚠ NOT A REMOUNT `key`. Re-keying the tree would refresh it by destroying it, discarding which
   * folders are expanded and the listings behind them; a signal re-reads what is open and keeps both.
   */
  const [folderRefresh, setFolderRefresh] = useState(0);
  /**
   * ── ⚠ RE-READ THE FOLDER WHEN THE ASSISTANT STOPS WRITING TO IT ────────────────────────────────
   *
   * ⚠ THE FALLING EDGE, NOT THE STATE. A turn ENDING is the moment every file it was going to write
   * exists; firing on `assistantBusy` being true would refresh repeatedly mid-turn, re-listing a
   * directory tree while an agent is still adding to it — more disk work for a picture that is still
   * changing.
   *
   * ⚠ WHAT THIS IS *NOT*: a watcher. Nothing here notices a file written by a build, a `git pull` in a
   * terminal, or the agent's own writes WHILE the turn runs — those still need the toolbar's Refresh.
   * A real watcher was costed and deliberately deferred: the failure modes are event storms from
   * `node_modules`/`.git`, echoes of the tree's own optimistic renames, and platform-dependent
   * recursive-watch behaviour — all of them "quietly wrong under load", which is the worst kind of
   * change to make casually. This covers the case that actually prompted it for ten lines.
   *
   * ⚠ AND IT DOES NOT DOUBLE UP WITH THE FRAMEWORK INSTALL. That agent runs in main (`runCliAgent`), not
   * through a chat view, so it never appears in `streamingSessions` — the install's own refresh in
   * `performSwitch` remains the only one for that path.
   */
  const wasAssistantBusy = useRef(false);
  useEffect(() => {
    /**
     * A view that unmounts mid-turn retracts to `false` too (see `onBusyChange`), which lands here as a
     * refresh. That is correct rather than merely harmless: the turn wrote files whether or not the pane
     * that started it is still on screen.
     */
    if (wasAssistantBusy.current && !assistantBusy) setFolderRefresh((n) => n + 1);
    wasAssistantBusy.current = assistantBusy;
  }, [assistantBusy]);
  /** Raised by File → New Profile…, which is a menu item in the main process and needs a rendered prompt. */
  const [showProfilePrompt, setShowProfilePrompt] = useState(false);
  /**
   * Show the profiles page so the user can move this window to another profile.
   *
   * ⚠ SEPARATE FROM `showProfilePrompt`, and not a duplicate. That one is File → New Profile and passes
   * `newWindow`, which opens a SECOND window and leaves this one alone. This one is "I am in the wrong
   * profile" — `profileOpen` REPLACES this window — and it must be reachable from the PRE-AUTH screens,
   * which is why it is checked before the gates rather than beside the menu prompt.
   */
  const [showProfileSwitch, setShowProfileSwitch] = useState(false);
  /**
   * Set when a connect link has just been committed, so the profile choice is offered before sign-in.
   * Distinct from `showProfileSwitch` only in WHERE it is asked from — the chooser is the same.
   */
  const [choseProfileAfterConnect, setChoseProfileAfterConnect] = useState(false);
  /**
   * This window's profile, for the strip beside the traffic lights. `null` for the default install, which
   * shows nothing — see the effect that loads it.
   */
  const [profileLabel, setProfileLabel] = useState<string | null>(null);
  const toast = useToast();
  const { counts: unread, awaitingPermission } = useTeamUnread(view);

  useEffect(() => {
    /**
     * ⚠ THE SPLASH IS DISMISSED HERE, IN A `finally`, AND NOT INSIDE `checkState`. Putting it at the end
     * of that function would strand the loading screen for ever on any rejection — a permanent splash is
     * a hung app, which is strictly worse than the flash this replaced. Clearing it where the FIRST load
     * is initiated also matches what the flag means: `checkState` re-runs on sign-out, assistant changes
     * and folder switches, and none of those should blank the app.
     *
     * The rejection is logged rather than swallowed silently — a launch that failed to read its own state
     * will misroute, and the console line is the only clue.
     */
    checkState()
      .catch((err) => {
        console.error("[app] initial state check failed:", err);
      })
      .finally(() => setBooting(false));
  }, []);

  /** File → New Profile… — the menu cannot collect a name, so it asks this window to. */
  useEffect(() => {
    api.onProfilePromptNew?.(() => setShowProfilePrompt(true));
  }, []);

  /**
   * ── ⚠ WHICH PROFILE THIS WINDOW IS, FOR THE TITLE BAR ────────────────────────────────────
   *
   * ⚠ THE *LABEL*, NOT THE ID. On disk a profile is `avengerspraimana-starkstack` — folded and
   * lower-cased because it is a directory name — while `profile.json` holds what the participant actually
   * typed. Showing the id beside the window controls would be unreadable in exactly the place someone has to
   * check they are in the right window.
   *
   * ⚠ AND NOTHING IS SHOWN FOR THE DEFAULT INSTALL. `current` is the reserved `default` sentinel there, which
   * has no entry in the list once the root database is gone — so `find` misses, the label stays null, and an
   * existing single-profile user sees no new furniture.
   */
  useEffect(() => {
    api
      .profileList?.()
      .then((r: { profiles?: { id: string; label: string }[]; current?: string }) => {
        const mine = r?.profiles?.find((p) => p.id === r.current);
        if (mine) setProfileLabel(mine.label);
      })
      /* A missing label is cosmetic; it must never surface as an error on the main window. */
      .catch(() => {});
  }, []);

  /**
   * ── ⚠ RESTORE THE LAYOUT. IT WAS BEING SAVED AND NEVER READ ──────────────────────────
   *
   * `sidebar_collapsed` and `pinned_view` were both WRITTEN on every toggle and never loaded, so the
   * comments on those two pieces of state claimed a persistence that did not exist — the sidebar
   * re-expanded and the pin vanished at every launch. The write half had shipped without its other
   * half.
   *
   * ⚠ MOUNT-ONLY, NOT PART OF `checkState`. That function re-runs on sign-out, on assistant changes and
   * after an expired session, and re-applying stored layout there would yank a panel the participant had
   * just opened back to whatever was last written.
   *
   * The pinned view is VALIDATED against PINNABLE_VIEWS rather than trusted: the stored string outlives the
   * build that wrote it, so a renamed or de-pinnable view would otherwise come back as a pane that has no
   * pin control to remove it — unpinnable in the literal sense.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [collapsed, pinned] = await Promise.all([
        api.getSetting("sidebar_collapsed"),
        api.getSetting("pinned_view"),
      ]);
      if (!alive) return;
      if (collapsed === "true") setSidebarCollapsed(true);
      if (pinned && PINNABLE_VIEWS.includes(pinned as View)) setPinnedView(pinned as View);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Surface background sync failures (chat → server) as a toast so they aren't silent. The data is
   * still saved locally; this just signals degradation.
   *
   * ── ⚠ NOT ON A PRE-AUTH SCREEN ────────────────────────────────────────────────────────────
   *
   * The `ToastProvider` sits ABOVE the gates in main.tsx, so it renders over the sign-in form as
   * readily as over the workspace — and a background reconciliation that fails while someone is typing
   * their password produces a red "Couldn't sync to the server" over a login screen. It describes work
   * the reader did not start, cannot see and cannot act on.
   *
   * The root cause is fixed in main: `sweepUnsyncedTurns` now refuses to push without a signed-in
   * session on a team. This is the second half, and it is not redundant — `sync:failed` is broadcast
   * from every sync path (a live turn, a manual retry, a `session-adopted` sweep), and a token can
   * expire mid-session, so the renderer must still decide whether the reader is somewhere this message
   * makes sense.
   *
   * ⚠ SUPPRESSED, NOT SWALLOWED. `console.warn` in main keeps every failure on the record — the
   * decision here is only about interrupting a person, and a message shown at the wrong moment is not
   * information, it is noise that trains people to dismiss the ones that matter.
   *
   * A ref rather than a dependency: adding the gate values to the array would tear down and
   * re-register the IPC listener on every state change, and a failure arriving mid-swap would be lost.
   */
  /**
   * The routing verdicts, derived ONCE and used by both the toast gate below and the view gates far
   * below. Two copies of this logic would be two chances to disagree about which screen is showing.
   */
  const teamProblem = teamAccessReason === "access-lost" || teamAccessReason === "team-gone";
  const needsSignIn = teamAccessReason === "signed-out" || (teamProblem && !reauthTried);

  /**
   * Is the user actually looking at the workspace?
   *
   * ⚠ THE STORED GATES ARE NOT ENOUGH, AND ASSUMING THEY WERE IS HOW THE FIRST ATTEMPT AT THIS FAILED.
   * On a 403 every stored gate still says "signed in, on a team, set up" — `connected`, `teamJoined`
   * and `setupComplete` are all true — while the 401/403 routing has sent the user to the SIGN-IN
   * screen. A test written against the stored gates passes, and the red toast lands on the login form
   * anyway. Measured on a real launch, not reasoned about.
   *
   * So the question this answers is "what is RENDERED", which means the routing verdicts have to be
   * part of it.
   */
  const inWorkspaceRef = useRef(false);
  inWorkspaceRef.current = Boolean(
    platformConfigured && connected && teamJoined && setupComplete && !needsSignIn && !teamProblem
  );

  useEffect(() => {
    api.onSyncFailed((data: { context: string; message: string }) => {
      if (!inWorkspaceRef.current) return;
      toast.error(`Couldn't sync to the server — your work is saved locally. (${data.context})`);
    });
    return () => api.removeSyncFailedListeners();
  }, [toast]);

  // EA-H6: the session token expired and couldn't be refreshed — send the user
  // back to sign-in rather than leaving the app in a silently-failing state.
  useEffect(() => {
    api.onAuthExpired?.(async () => {
      await api.setSetting("connected", "false");
      toast.error("Your session expired — please sign in again.");
      await checkState();
    });
    return () => api.removeAuthExpiredListeners?.();
  }, [toast]);

  /**
   * The platform changed, so main tore the session down.
   *
   * ⚠ A SEPARATE LISTENER FROM `auth:expired`, and the message is the reason. Both end
   * on the sign-in screen, but telling someone their session expired when they just
   * changed the platform URL describes a failure that did not happen — and they will
   * retry the sign-in rather than notice they are now pointed somewhere else.
   *
   * `connected` is NOT written here: main already wiped it as part of the teardown
   * (SIGN_OUT_SETTINGS), and the renderer cannot write it back to "false" a second time
   * without racing that wipe. `checkState()` just re-reads the truth.
   */
  useEffect(() => {
    api.onPlatformChanged?.(async () => {
      toast.info("The platform changed — please sign in again.");
      await checkState();
      /**
       * ⚠ NO CHOOSER HERE, AND THAT WAS A WRONG TURN WORTH RECORDING. A previous version of this line
       * opened the profile chooser on `reason === "reset"`, reasoning that Disconnect is the moment to
       * ask which profile should receive the next experience. That was corrected: when the user clicks
       * Disconnect, the app should show "connect from the browser".
       *
       * The reason is ordering. At Disconnect there is no experience to place yet —
       * the platform has just been cleared and nothing has arrived. Asking "which profile?" before
       * there is anything to put in one is a question with no information behind it. The choice belongs
       * AFTER the link is confirmed, which is where it now is: see the `onComplete` on
       * `PlatformSetupView` below.
       */
    });
    return () => api.removePlatformChangedListeners?.();
  }, [toast]);

  /**
   * ⚠ NO UPDATE TOAST. It announced a downloaded build and told the reader it would install on quit —
   * a promise only the auto-updater could keep, and that is gone (see the note at the former
   * `setupAutoUpdater` call site in `main/index.ts`). A new version is downloaded and put in place by
   * hand now, so there is nothing for the app to announce and no `update:*` channel left to listen on.
   */

  async function checkState() {
    /**
     * ── ⚠ EVERY GATE IS READ BEFORE ANY OF THEM IS APPLIED ────────────────────────────────────
     *
     * ⚠ THE CAUSE WAS THE `await`s, NOT THE VALUES. This function used to read each gate and set it
     * immediately, so every `await` boundary ended React's batch and COMMITTED a half-loaded state. The
     * render chain then answered with whatever it had:
     *
     *     platformConfigured=true, connected=false                → SignInView          (one IPC)
     *     …connected=true, teamJoined=false                       → JoinTeamView        (one IPC)
     *     …teamJoined=true, setupComplete=false  ← INITIAL VALUE  → SelectAssistantView (a NETWORK call)
     *
     * The first two flashed for a same-machine IPC round-trip and nobody noticed. The third sat there
     * for `checkTeamAccess()` — a request to the server — which is the "few seconds" in the report, and
     * why the ASSISTANT screen was the one that showed rather than the two before it.
     *
     * ⚠ SO THE FOUR READS ARE BATCHED AND THE FOUR WRITES ARE ONE COMMIT. They are all local IPC, so
     * `Promise.all` costs a single round-trip rather than four, and setting them in one synchronous
     * block after the await means React renders the CORRECT screen first rather than three wrong ones.
     *
     * ⚠ AND `setup_complete` MOVED AHEAD OF THE NETWORK PROBE, which is the half that actually fixes
     * the reported symptom. A screen decision must not wait on a server: the blank guard below is blank
     * precisely because it was sized for "one IPC round-trip on the same machine", and holding it across
     * a network call would trade a wrong screen for a long empty one.
     *
     * The team-access probe stays where it is, AFTER the first render. It is a probe rather than a gate
     * — only a conclusive verdict routes, per its own note below — so a participant whose team really is
     * gone now sees the workspace briefly before being routed, instead of every participant seeing the
     * wrong onboarding screen on every launch.
     */
    /**
     * The platform gate is still resolved FIRST among these, and its failure mode is deliberate: if the
     * channel throws, treat the app as UNCONFIGURED. The alternative — assuming configured — sends the
     * user to a sign-in button that cannot work and reports it as a backend problem. Landing on the
     * setup screen with the URL already prefilled costs one click and explains itself.
     */
    const [platform, conn, team, setup] = await Promise.all([
      api.isPlatformConfigured().catch(() => ({ configured: false })),
      api.getSetting("connected"),
      api.getSetting("team_joined"),
      api.getSetting("setup_complete"),
    ]);
    setPlatformConfigured(platform?.configured === true);
    setConnected(conn === "true");
    setTeamJoined(team === "true");
    setSetupComplete(setup === "true");

    /**
     * Ask the server whether this team is still readable, rather than discovering it three views
     * later through an empty board.
     *
     * ⚠ ONLY A CONCLUSIVE ANSWER ROUTES. `access-lost` (403) and `team-gone` (404) are verdicts from
     * the service; `unavailable`, `busy` and `signed-out` are not, and treating a venue-wifi drop as
     * "you were removed from your team" would eject a room full of participants mid-workshop. A dead
     * session is `auth:expired`'s job and lands on sign-in through the `connected` gate.
     */
    if (team === "true") {
      try {
        const access = await api.checkTeamAccess?.();
        const reason = access?.ok === true ? null : (access?.reason ?? null);
        /**
         * ⚠ ONLY A CONCLUSIVE VERDICT IS KEPT. 403 (access-lost), 404 (team-gone) and a surviving 401
         * (signed-out) are answers. `unavailable` and `busy` are not — treating a venue-wifi drop as
         * "you were removed" would eject a room of participants mid-workshop — and `no-team` is simply
         * "not on one yet", which the `teamJoined` gate already covers.
         */
        setTeamAccessReason(
          reason === "access-lost" || reason === "team-gone" || reason === "signed-out"
            ? reason
            : null
        );
      } catch {
        // A probe that cannot run is not a verdict. "We could not ask" is not "you were removed".
        setTeamAccessReason(null);
      }
    } else {
      setTeamAccessReason(null);
    }
    const assistant = await api.getSetting("ai_assistant");
    if (assistant && ASSISTANT_LABELS[assistant]) {
      setAssistantName(ASSISTANT_LABELS[assistant]);
    }
    const cmd = await api.getSetting("ai_command");
    if (cmd) setAiCommand(cmd);

    // Check if kiro ACP mode should be used
    const acpResult = await api.cliUseAcpMode();
    setUseAcpMode(acpResult?.useAcp ?? false);

    if (setup === "true") {
      await loadProjects();
    }
  }

  async function loadProjects() {
    const projects = await api.getProjects();
    setProjects(projects);
    if (projects.length > 0) {
      setActiveProject(projects[0]);
    }
  }

  /**
   * Pick the folder, then ASK before anything is granted or replaced.
   *
   * ⚠ THE PICKER'S RESULT IS PARKED, NOT ACTED ON. `selectDirectory` already recorded the picker
   * provenance in main, which is what makes the folder grantable — but grantable is not the same as
   * granted, and nothing here commits until `performSwitch` runs. See SwitchFolderConfirm for what
   * the dialog exists to say (and for why it is a legibility step, not a security one).
   */
  async function handleSwitchFolder() {
    if (switching) return;
    /**
     * ⚠ REFUSED HERE AS WELL AS DISABLED IN THE UI. The toolbar button is disabled while a turn runs,
     * and that is the affordance — but this function is also reached from the empty state and from
     * whatever calls it next, and a disabled button is a rendering, not a guarantee.
     */
    if (assistantBusy) {
      toast.info(
        `${assistantName} is still working. Wait for it to finish, or stop it, before changing folder.`
      );
      return;
    }

    const dirPath = await api.selectDirectory();
    if (!dirPath) return;

    setPendingFolder(dirPath);
  }

  // Single working directory: switching folders replaces the current project,
  // re-checks the framework setup for the selected assistant, and restarts the CLI so
  // it operates in the new folder.
  async function performSwitch(dirPath: string) {
    if (switching) return;

    setSwitching(true);
    setSwitchStatus("Preparing folder...");

    try {
      const assistant = (await api.getSetting("ai_assistant")) || "claude";

      // Stop any running CLI/ACP session so it restarts in the new cwd.
      try { await api.cliStop(); } catch {}
      try { await api.kiroAcpStop(); } catch {}

      /**
       * ── ⚠ THE GRANT COMES FIRST. EVERY STEP BELOW IT READS THE NEW FOLDER ─────────────────────
       *
       * `allowedRoots()` is built from this setting plus the `projects` rows (project-paths.ts), so
       * until one of them names the chosen folder it is — correctly — outside the boundary. This
       * function used to call `frameworkCheck` and `getProjectInfo` BEFORE registering it, and both
       * are confined:
       *
       *   files:getProjectInfo   assertWithinProject   → THREW, and the switch died in the catch
       *   framework:check        isRealPathWithinProject → returned `{installed: true, skipped: true}`
       *
       * So folder switching was broken outright, and the framework step had been silently doing
       * nothing long before that: `skipped` with `installed: true` is the handler failing safe, and
       * the guard below reads it as "already set up". Nothing was ever installed on a switch.
       *
       * ⚠ THE SETTING, NOT `addProject`, IS WHAT GOES FIRST. Both widen the boundary, but
       * `db:addProject` is not an upsert on name — it returns the existing row untouched when one
       * matches the path (db.ts) — so a placeholder row could never be renamed once `getProjectInfo`
       * answered. Committing the setting needs no placeholder.
       *
       * Not `setSetting("project_path", …)`: main owns this write and accepts only a path its own
       * picker returned, which is the whole reason the boundary can be trusted.
       */
      await api.commitProjectPath(dirPath);

      // Replace the single working directory.
      const info = await api.getProjectInfo(dirPath);
      const proposed = {
        id: crypto.randomUUID(),
        // `basenameOf`: a Windows path has no "/" to split on, so this showed the whole path as the
        // project's name — in the sidebar, the chooser and Settings at once.
        name: info?.name || basenameOf(dirPath) || "Project",
        path: dirPath,
      };
      /**
       * Read BEFORE the insert, so the row this switch is creating is not in the list the cleanup
       * loop below walks.
       */
      const existing = await api.getProjects();
      /**
       * ⚠ THE ROW MAIN RETURNS WINS, NOT THE ONE PROPOSED ABOVE — which is why the two have
       * different names. Re-picking the folder that is already open matches an existing row, and
       * `db:addProject` then answers with THAT row's id rather than inserting the fresh uuid.
       * Keeping the local object would have pointed the whole UI at an id no table contains — chat
       * history keys on it — and, now that the cleanup below deletes "everything except the project
       * row", would have deleted the row for the folder just switched to, revoking its access.
       */
      const added = await api.addProject(proposed);
      const project = added?.id ? { ...proposed, ...added } : proposed;

      /**
       * Now narrow the boundary back to one folder. Everything above needed the folder being LEFT to
       * still be readable; nothing below does, because the tabs pointing into it are closed on the
       * next line.
       */
      for (const p of existing) {
        if (p.id !== project.id) await api.removeProject(p.id);
      }

      // Same reasoning as first-run setup (SelectAssistantView): the user just chose
      // this folder in a native picker, so trust it for Claude Code — otherwise the CLI
      // discards the project's `permissions.allow` and prompts for tools the repo had
      // already approved. Best-effort: a failure costs a permission prompt, not the
      // folder switch, so it must not undo a switch that otherwise worked.
      //
      // ⚠ BEFORE THE FRAMEWORK INSTALL, NOT AFTER IT. That install runs an assistant turn in this
      // very folder (`runCliAgent`), so trusting it afterwards is too late for the one process that
      // most needs it — an untrusted workspace makes the CLI discard `permissions.allow` and prompt
      // for tools mid-setup, with nobody watching the pane it prompts in.
      const trust = await api.cliTrustWorkspace(dirPath);
      if (trust?.error) {
        toast.info(`Switched, but tool permissions were not pre-approved: ${trust.error}`);
      }

      /**
       * ── ⚠ THE UI SWITCHES HERE, BEFORE THE FRAMEWORK STEP, AND THAT IS THE WHOLE FIX ──────────
       *
       * Not an error — a WAIT, misread as a failure, and correctly so. These three lines used to sit
       * AFTER `framework:install`, which downloads a distribution, extracts it, copies it in and then
       * runs an assistant turn in the folder: bounded in main at 120s + 60s + 120s. So for up to five
       * minutes after approving the dialog, every visible surface — sidebar, tree, tabs — still showed
       * the OLD project. The switch had already happened in the database; only the screen disagreed.
       *
       * The row exists and the boundary is granted by this point, so there is nothing left to wait
       * for. Setup continues behind the blocker below.
       */
      setProjects([project]);
      setActiveProject(project);
      /**
       * ⚠ TABS OUTSIDE THE NEW PROJECT ARE CLOSED, and the ones inside it are KEPT. Clearing all of them
       * (what the single-file version did) would be wrong now that switching back and forth is cheap — but
       * leaving a file from the previous folder open is worse than wrong: the editor would still read and
       * WRITE a path outside the project the participant thinks they are in.
       */
      setTabs((prev) => closeTabsOutside(prev, project.path));
      setSwitchStatus("");
      toast.success(`Switched to ${project.name}`);

      /**
       * Ensure the experience's development framework is set up for this assistant in the new folder.
       *
       * ⚠ THE FRAMEWORK'S NAME COMES BACK FROM MAIN — it is whichever one the facilitator configured,
       * so nothing here may name one. The pre-call line is deliberately generic because the name is
       * not known until `frameworkCheck` answers; every line after it uses `check.name`.
       */
      setSwitchStatus("Checking framework setup...");
      const check = await api.frameworkCheck({ projectPath: dirPath, assistant });
      if (check.skipped) {
        /**
         * ⚠ A SKIP IS REPORTED, NOT SWALLOWED — the reason is the only thing that distinguishes
         * "no workshop config on the server", "no config for this assistant" and "not signed in".
         * The first-run screen has always shown it (SelectAssistantView); this path dropped it on
         * the floor, so a participant whose framework never installed had nothing to go on.
         */
        toast.info(`${check.name} was not set up: ${check.reason || "setup config unavailable"}`);
      } else if (!check.installed) {
        setSwitchStatus(`Installing ${check.name}...`);
        setFrameworkStep("");
        /**
         * ── ⚠ THE SCREEN IS BLOCKED WHILE AN AGENT WRITES INTO THE FOLDER ────────────────────
         *
         * The folder is already open by now, which is what makes the block necessary rather than
         * merely reassuring: without it a participant can open a file the setup agent is about to
         * overwrite, send the assistant a message while a second CLI process is mid-turn in the same
         * working tree, or switch folders again while the install is still writing to this one.
         *
         * ⚠ CLEARED IN `finally`. The overlay cannot be dismissed by the user (see the component), so
         * this is the ONLY thing that takes it down — it must survive a rejected invoke, not just a
         * returned `{ error }`.
         */
        setFrameworkSetup(check.name);
        try {
          const result = await api.frameworkInstall({ projectPath: dirPath, assistant });
          /**
           * ⚠ A FAILED INSTALL DOES NOT UNDO THE SWITCH, and that is the honest behaviour rather than
           * the lenient one: `framework:install` copies the distribution into the folder before it can
           * fail (framework.ts), so abandoning the switch would leave the participant pointed at the
           * OLD folder while the new one held a half-installed framework — undoing nothing and hiding
           * it. The failure is reported, exactly as `cliTrustWorkspace` above.
           */
          if (result.error) {
            toast.error(`${check.name} setup failed: ${result.error}`);
          } else {
            toast.success(`${check.name} installed`);
          }
        } finally {
          setFrameworkSetup(null);
          setSwitchStatus("");
          /**
           * ⚠ IN `finally`, SO IT RUNS FOR A FAILED INSTALL TOO — and that is not defensive, it is the
           * case that needs it most. `framework:install` copies the distribution in BEFORE the step
           * that can fail (the agent), so a failure leaves real files on disk that the tree has never
           * listed. Refreshing only on success would hide exactly the half-finished state somebody
           * needs to see.
           */
          setFolderRefresh((n) => n + 1);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown";
      setSwitchStatus(`Error: ${msg}`);
      toast.error(`Could not switch folder: ${msg}`);
    } finally {
      setSwitching(false);
    }
  }

  /**
   * ── GATE ORDER: PLATFORM → SIGN-IN → TEAM → ASSISTANT ──
   *
   * The platform gate is ABOVE sign-in and has to be: `ai:login` reads the configured
   * platform to know which Cognito pool to use, so a sign-in attempt before this is set
   * can only fail. Ordering it second would show a "Get Started" button whose single
   * job is to produce an error.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();

      /** True when the keystroke belongs to whatever the participant is typing into. */
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (key === "s") {
        // Saving is unambiguous wherever focus is — the editor ignores it when there is nothing open.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("editor:save"));
        return;
      }

      if (key === "w" && !typing) {
        /**
         * ⚠ ONLY WHEN A TAB IS OPEN. With nothing to close this must fall through to the platform default —
         * on macOS Cmd+W closes the window, and swallowing it would make the app the one thing that ignores
         * a system-wide shortcut.
         */
        if (!tabs.active) return;
        e.preventDefault();
        handleCloseFile(tabs.active);
        return;
      }

      if (key === "p" && !typing) {
        e.preventDefault();
        // The search bar lives in the title bar and focuses itself on this event.
        window.dispatchEvent(new CustomEvent("editor:quick-open"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs.active]);

  /**
   * ── ⚠ NOTHING RENDERS UNTIL THE FIRST LOAD IS DONE ────────────────────────────────────────────
   *
   * Two symptoms, one gate. The first was the AI assistant selection page flashing for a few seconds: the chain
   * routed on three gates still at their initial `false`, because each `await` in `checkState` committed
   * a partial state. Making them nullable and batching the reads fixed that — and revealed the next
   * screen behind it — the add-project screen showed for a few seconds — because `loadProjects()`
   * runs last and the shell paints with no active project until it lands.
   *
   * ⚠ SO THE CONDITION IS BOTH SHAPES OF "NOT READY". The four nullable gates say "these settings have
   * not been read"; `booting` says "the first `checkState` has not finished", which covers the projects
   * read and the team-access probe that the gates knew nothing about. The gates are kept rather than
   * folded into `booting` because they also guard the LATER re-runs, when `booting` is long since false.
   *
   * ⚠ A LOADING SCREEN, WHERE THIS WAS ONCE DELIBERATELY BLANK — and the old reasoning was right at the
   * time, so it is worth stating why it stopped being. Blank was correct for a single local IPC
   * round-trip: a spinner that appears and vanishes inside a frame is flicker, not feedback. This gate
   * now spans the projects read and a network probe (bounded at 4s by the docs service's own
   * `READ_TIMEOUT_MS`), and seconds of blank window reads as a hung app.
   */
  if (
    booting ||
    platformConfigured === null ||
    connected === null ||
    teamJoined === null ||
    setupComplete === null
  ) {
    return <LoadingView />;
  }

  /**
   * ── ⚠ File → New Profile…, USING THE SAME SCREEN AS THE LAUNCH CHOOSER ───────────────────
   *
   * ⚠ THE LAUNCH CHOOSER IS REUSED RATHER THAN A SECOND DIALOG BEING WRITTEN. Electron has no native
   * text-input dialog, so this needed a rendered prompt either way — and two prompts for one concept would
   * drift on the thing that matters here, which is the honesty line about profiles not being private.
   *
   * ⚠ IT RETURNS EARLY, replacing the app rather than floating over it. Creating a profile RELAUNCHES this
   * process, so anything still mounted behind the overlay is about to be torn down mid-render; leaving the
   * app live underneath would keep timers, SSE streams and an in-flight CLI turn running against a window
   * that is going away.
   */
  if (showProfilePrompt) {
    return (
      <ProfileChooser
        mustCreate={false}
        newWindow
        onCancel={() => setShowProfilePrompt(false)}
      />
    );
  }

  /**
   * ⚠ AHEAD OF EVERY GATE, INCLUDING SIGN-IN. The whole point is that someone on the login form can
   * discover they are in the wrong profile and move — a chooser reachable only from the signed-in shell
   * would be reachable only after the mistake had already been made.
   *
   * `newWindow` is deliberately NOT passed: `profileOpen` replaces this window, which is what "I am in
   * the wrong profile" means. Cancelling returns to whichever gate was showing.
   */
  if (showProfileSwitch) {
    return <ProfileChooser mustCreate={false} onCancel={() => setShowProfileSwitch(false)} />;
  }

  /**
   * ⚠ AFTER THE PLATFORM GATE BELOW HAS BEEN SATISFIED, WHICH IS WHY IT IS A SEPARATE FLAG. This must
   * not render while `!platformConfigured` — the connect screen has to come first — so it is checked
   * here, once the config is in, and before the sign-in gate that follows.
   */
  if (choseProfileAfterConnect && platformConfigured) {
    return (
      <ProfileChooser
        mustCreate={false}
        justConnected
        onCancel={() => setChoseProfileAfterConnect(false)}
      />
    );
  }

  if (!platformConfigured) {
    /**
     * ⚠ `onSwitchProfile` IS PASSED HERE NOW, AND ITS ABSENCE WAS THE WHOLE GAP. `SignInView` has had
     * the ProfileBadge for exactly this reason — the note on `showProfileSwitch` above says the chooser
     * belongs "AHEAD OF EVERY GATE, INCLUDING SIGN-IN", so that "someone on the login form can discover
     * they are in the wrong profile and move". The CONNECT screen is a gate ahead of the login form and
     * it had no such route, which is where both a Disconnect and an incoming portal link land.
     */
    return (
      <PlatformSetupView
        /**
         * ── ⚠ THE PROFILE IS CHOSEN AFTER THE EXPERIENCE IS CONFIRMED, NOT BEFORE ──────────────
         *
         * The ordering is the point and it is better than what was here. By this line the platform is
         * committed, so the question "which profile should hold this experience?" finally has an answer
         * to place — and `profileCreate` SEEDS the new profile with the platform just saved, so a
         * profile created from here comes up already pointed at the right deployment and needs only a
         * sign-in. Asking earlier (at Disconnect) asked before there was anything to put anywhere.
         *
         * ⚠ CANCELLABLE, and cancelling is a real choice rather than an escape: it falls through to the
         * sign-in gate in THIS profile, which is exactly right for somebody who meant to connect the
         * profile they were already in.
         */
        onComplete={() => {
          setChoseProfileAfterConnect(true);
          void checkState();
        }}
        profileLabel={profileLabel}
        onSwitchProfile={() => setShowProfileSwitch(true)}
      />
    );
  }

  /**
   * ── ⚠ A 401 OR A 403 SENDS THE USER TO SIGN IN ────────────────────────────────────────────
   *
   * THE RULE: on a 401 or 403, do not sign the user in automatically. Show the sign-in page if the login
   * config is available; if it is missing, ask the user to sign in in the browser and open the desktop
   * from there.
   *
   * Both destinations already exist and are already in the right order: the `!platformConfigured`
   * gate ABOVE this one is the "open it from the portal in your browser" screen, so a missing login
   * config is handled before this line is ever reached. Below, a present config lands on the native
   * sign-in form. Nothing new had to be invented — the verdict just had to reach the existing chain.
   *
   * ⚠ I ARGUED AGAINST THIS FOR THE 403 CASE AND WAS OVERRULED; RECORDING WHY IT IS SAFE ANYWAY.
   * A 403 means the gateway ACCEPTED the token — the caller is authenticated and simply not a member
   * of that team — so re-authenticating cannot fix it, and on its own this rule would loop: sign in,
   * succeed, get refused again, land back on sign-in. `reauthTried` is what makes the instruction
   * safe to follow: the user gets exactly one pass at signing in, and if the team is STILL unreadable
   * afterwards the join screen takes over, because at that point the team really is the problem.
   *
   * `signed-out` (a 401 that survived the refresh retry) has no escape hatch and needs none: signing
   * in IS the fix for it, so bouncing back here is correct rather than a trap.
   */
  if (!connected || needsSignIn) {
    return (
      <SignInView
        profileLabel={profileLabel}
        onSwitchProfile={() => setShowProfileSwitch(true)}
        notice={
          needsSignIn && connected
            ? teamProblem
              ? "Your team could not be read (the server refused access to it). Please sign in again — if the same thing happens afterwards, you will be asked to re-join the team."
              : "Your session could not be renewed. Please sign in again."
            : undefined
        }
        onComplete={() => {
          // One pass only. Mark it BEFORE re-checking, so a still-refused team escapes to the join
          // screen instead of returning here.
          if (teamProblem) setReauthTried(true);
          void checkState();
        }}
      />
    );
  }

  if (!teamJoined || teamProblem) {
    /**
     * Reached for a team problem only AFTER one sign-in attempt (see above), which is the point at
     * which "the team is the problem" is established rather than assumed.
     */
    return (
      <JoinTeamView
        profileLabel={profileLabel}
        onSwitchProfile={() => setShowProfileSwitch(true)}
        notice={
          teamProblem
            ? "You signed in successfully, but the server still refuses access to your previous team — so its board, phases and chat cannot be loaded. Join again with a current invite code."
            : undefined
        }
        onComplete={() => checkState()}
      />
    );
  }

  if (!setupComplete) {
    return <SelectAssistantView onComplete={() => checkState()} />;
  }

  /**
   * ── WHERE EACH PANE GOES ─────────────────────────────────────────────────────────────
   *
   * Four interacting inputs (active view, pinned view, editor open, project present) and rules that are
   * not obvious from the markup — so the arrangement lives in `lib/pane-layout.ts` as a pure function and
   * is asserted there. This is the delegation.
   */
  const { chat: chatPane, showPinned: showPinnedPane } = paneLayout({
    view,
    pinnedView,
    editorOpen: !!tabs.active,
  });

  /**
   * One view's content, by key. A plain function, NOT a component: declaring a component inside another
   * remounts its whole subtree on every render, which is what cost the commit field its focus in
   * GitPanel. `inner-components.test.ts` now forbids the shape.
   *
   * `chat` returns null — the real chat lives in its own persistent pane so its session survives a tab
   * switch, and rendering a second copy here would be exactly the duplication that pane exists to avoid.
   */
  function renderView(v: View) {
    switch (v) {
      case "chat":
        return null;
      case "phases":
        return <PhasesView />;
      case "board":
        return <BoardView />;
      case "team-chat":
        /*
          ── ⚠ A TEAMMATE'S FILE NAMES OPEN TOO ────────────────────────────────────────────

          ⚠ `activeProject?.path ?? ""` IS THE WHOLE GUARD, and it is not a shortcut. Team chat is reachable
          with NO folder open (it is the one chat that does not need one), and an empty root makes
          `mentionTargetPath` refuse everything — so every mention renders as the plain text it was before,
          with no separate "is a project open" branch to get wrong.

          ⚠ NO `accent`. A mention can land in the participant's OWN bubble, which is a saturated
          `brand-strong` fill carrying white text; an accent legal on the dark panel is not legal there, and
          the same component renders both sides. Inheriting keeps the contrast the bubble already guarantees.
        */
        return (
          <FileMentionScope root={activeProject?.path ?? ""} onOpenFile={handleOpenFile}>
            <TeamChatView />
          </FileMentionScope>
        );
      case "account":
        /* No project needed: this is about the signed-in person, not the folder. `onSignOut` re-reads the
           gates so signing out routes back to the form. */
        return <AccountPanel onSignOut={() => checkState()} />;
      case "source-control":
        /* Needs an open folder: every action here is scoped to one repository. */
        return activeProject ? (
          <GitPanel projectPath={activeProject.path} refreshSignal={folderRefresh} />
        ) : (
          <EmptyState onAdd={handleSwitchFolder} />
        );
      case "settings":
        return (
          <SettingsView
            /**
             * ⚠ THE VIEW MOVES TO THE ASSISTANT: after setup, the tab changes to the AI assistant
             * instead of showing the Settings page. Staying on Settings after a switch leaves
             * the participant on a form whose work is done, one click from the thing they actually
             * changed assistants in order to use.
             *
             * ⚠ AND THE SETUP FAILURE BECOMES A TOAST, because navigating away destroys the inline
             * status line that used to carry it. A failure reported only on a screen the app then
             * leaves is a failure reported nowhere.
             */
            onAssistantChanged={(result) => {
              void checkState();
              if (result?.setupFailure) toast.error(result.setupFailure);
              setView("chat");
            }}
            /*
              The same blocker the folder switch raises: this install also runs an assistant turn in the
              open folder, so the same collisions apply — a file opened while the agent is writing it, or
              a second turn started in the same working tree.
            */
            onFrameworkSetupChange={(name) => {
              if (name) setFrameworkStep("");
              setFrameworkSetup(name);
            }}
            /*
              Switching assistant re-runs the framework install, which writes into the folder the tree is
              already showing — `.codex` for Codex, and the equivalent for the others. `checkState` alone
              cannot cover it: the project's path does not change, so nothing keyed on `rootPath` re-reads.
            */
            onProjectFilesChanged={() => setFolderRefresh((n) => n + 1)}
          />
        );
    }
  }

  /**
   * The pin control for one pane, or null when that view cannot be pinned.
   *
   * ⚠ A LOWERCASE RENDER HELPER, NOT A NESTED COMPONENT — `<PinFor />` declared here would get a new
   * identity every render and remount its subtree, which is the bug that cost the commit field its focus.
   * `inner-components.test.ts` forbids the shape.
   *
   * The chat pane's label is the ASSISTANT's name, because that is what the sidebar row calls it and what
   * the participant chose: "Pin Claude", not "Pin chat". The rest are fixed names.
   */
  function pinFor(v: View) {
    if (!PINNABLE_VIEWS.includes(v)) return null;
    return (
      <PanePin
        paneView={v}
        activeView={view}
        pinnedView={pinnedView}
        label={v === "chat" ? assistantName || "AI Chat" : PANE_LABELS[v] || v}
        onToggle={() => togglePin(v)}
      />
    );
  }

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      void api.setSetting("sidebar_collapsed", next ? "true" : "false");
      return next;
    });
  }

  /**
   * Pin or unpin a view.
   *
   * ⚠ PINNING THE ACTIVE VIEW IS A NO-OP RATHER THAN AN ERROR. The control is offered from the sidebar,
   * where the active row is the one under the cursor most often — refusing loudly would be pedantry, and
   * showing the same view twice is the thing being prevented.
   */
  function togglePin(v: View) {
    setPinnedView((prev) => {
      const next = prev === v ? null : v;
      void api.setSetting("pinned_view", next ?? "");
      return next;
    });
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ WebkitAppRegion: "no-drag" } as any}>
      {/*
        ── ⚠ THE TITLE BAR, WHICH NOW CARRIES THE FILE SEARCH ────────────────────────────────

        The search sits centred in the title strip, beside the window controls.

        `justify-end` for the status pill still; the search is positioned rather than laid out, for the
        reasons below. `h-10` and not `h-8`: a text field in 32px is cramped, and this strip REPLACES the
        40px one that used to sit under it, so the window loses no room overall.
      */}
      <div
        className="relative flex h-10 flex-shrink-0 items-center justify-end bg-surface-bg pr-3"
        style={{ WebkitAppRegion: "drag" } as any}
      >
        {/*
          ⚠ AN ABSOLUTE BAND WITH BOTH ENDS RESERVED, not `justify-center`. Centring in the flex row would
          put the field in the middle of the REMAINING space, which moves as the status pill's text changes —
          and on a narrow window it would slide under the traffic lights. `titleBarStyle: "hiddenInset"`
          means macOS draws close/minimise/zoom at the left inset, and they are the OS's pixels: the band
          starts clear of them and stops clear of the pill, so the field is centred in what is genuinely free.

          ⚠ `pointer-events-none` ON THE BAND, `auto` ON THE FIELD. The band spans most of the title bar, and
          without this it would swallow the drag that the rest of the strip exists to provide — the window
          would only be draggable at its edges.
        */}
        {/*
          ── ⚠ THE PROFILE, BESIDE THE TRAFFIC LIGHTS ─────────────────────────────────────────

          ⚠ IT HAD TO GO HERE, BECAUSE `setTitle` IS NOT VISIBLE IN THIS WINDOW. `titleBarStyle:
          "hiddenInset"` hides the native title bar and leaves only the traffic lights over the app's own
          content — so the window title main sets reaches the Window menu, Mission Control and the app
          switcher, and NOTHING on the window itself. Claiming the profile was "in the title" was therefore
          half true: correct for the switcher, invisible where it matters most. This strip is the only place
          in the window that is genuinely next to those buttons.

          ⚠ `left-[92px]` IS THE OS'S INSET, the same figure the search band uses below. Those pixels belong
          to macOS: close/minimise/zoom are drawn there and anything placed under them is both unreadable and
          unclickable.

          ⚠ ABSENT FOR THE DEFAULT INSTALL, so an existing single-profile user sees no change at all. A label
          reading "Default" beside the window controls would be permanent furniture carrying no information —
          the same rule that keeps the Kiro context reading quiet below 60%.
        */}
        {profileLabel && (
          <div
            className="pointer-events-none absolute inset-y-0 left-[92px] flex items-center"
            /* Not a drag exclusion: it is inert text, so the strip stays draggable across it. */
          >
            <span
              className="truncate rounded bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-surface-text"
              /* Inline rather than a Tailwind literal, so it and the offset below share one constant. */
              style={{ maxWidth: PROFILE_CHIP_MAX_PX }}
              title={`This window is signed in as the "${profileLabel}" profile. Profiles keep separate sign-ins, teams and chat history.`}
            >
              {profileLabel}
            </span>
          </div>
        )}

        {activeProject && (
          <div
            className="pointer-events-none absolute inset-y-0 right-[184px] flex items-center justify-center"
            /*
              ⚠ THE LEFT EDGE MOVES OUT OF THE PROFILE LABEL'S WAY, rather than both being pinned to the same
              inset. `left-[92px]` for both would overlap them, and the label is the one that cannot be
              relocated — it has to sit beside the window buttons to mean what it says. The offset matches the
              label's `max-w` plus its padding and a gap, so the search stays centred in what is genuinely
              free at either width.
            */
            style={{ left: profileLabel ? SEARCH_LEFT_WITH_PROFILE : TRAFFIC_LIGHT_INSET_PX }}
          >
            <div
              className="pointer-events-auto w-full max-w-lg"
              /*
                ⚠ `no-drag` IS WHAT MAKES THE FIELD USABLE AT ALL. Inside a drag region the OS takes the mouse
                to move the window, so without this the box cannot be clicked, focused or selected in — it
                would look like a search box and behave like a handle.
              */
              style={{ WebkitAppRegion: "no-drag" } as any}
            >
              <FileSearch rootPath={activeProject.path} onOpenFile={handleOpenFile} variant="bar" />
            </div>
          </div>
        )}

        <ConnectionStatus />
      </div>
      <div className="flex-1 flex overflow-hidden">
      {/*
        ⚠ COLLAPSED BY WIDTH, STILL MOUNTED. The sidebar owns the file tree, which loads its own data and
        remembers which folders are open; unmounting it on collapse would discard that and refetch on every
        toggle. `w-0 overflow-hidden` hides it and keeps it, so re-opening is instant.
      */}
      {/*
        ⚠ COLLAPSED TO AN ICON RAIL, NOT HIDDEN — and the width is the SIDEBAR's business now, not a
        wrapper's. The first version wrapped it in a `w-0 overflow-hidden` div, which gave the screen back
        and took navigation with it: reaching Team Chat meant expanding, clicking, and collapsing again.
        Owning its own width lets it render a 48px rail of icons instead.
      */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        activeProject={activeProject}
        view={view}
        pinnedView={pinnedView}
        /*
          Narrowed here rather than typing the Sidebar against `View`: the Sidebar is a presentation
          component that should not import the shell's route union, and `pinnableViews` is exactly the
          set it may send back — so the cast is checked by the guard, not assumed.
        */
        onTogglePin={(v) => {
          if (PINNABLE_VIEWS.includes(v as View)) togglePin(v as View);
        }}
        pinnableViews={PINNABLE_VIEWS}
        assistantName={assistantName}
        aiCommand={aiCommand}
        switching={switching}
        switchStatus={switchStatus}
        assistantBusy={assistantBusy}
        refreshSignal={folderRefresh}
        unread={unread}
        awaitingPermission={awaitingPermission}
        activeFilePath={tabs.active}
        onSelectView={setView}
        onSwitchFolder={handleSwitchFolder}
        onOpenFile={handleOpenFile}
      />
      {/*
        ⚠ `flex-col`, AND THAT IS THE FIX FOR THE MISPLACED SEARCH BOX.
        The strip was a SIBLING of `<main>` inside a container whose axis is a ROW, so it became a full-height
        COLUMN between the sidebar and the panes with the field floating in the middle of it. Stacked inside
        `main`, above the pane row, it is the bar the reference layout draws.
      */}
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        {/*
          ⚠ THE SEARCH STRIP THAT WAS HERE HAS MOVED INTO THE TITLE BAR. Nothing replaces it: the
          tab row below is the editor column's own, and a second full-width bar would just be the height this
          change gave back.
        */}
        {/*
          ⚠ `min-h-0` IS LOAD-BEARING ON THIS ROW. A flex child defaults to `min-height: auto`, so with a
          sibling above it this row would refuse to shrink below its content and the panes would spill past the
          bottom of the window — which is what the pinned screenshots showed, the composer clipped at the edge.
        */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Editor panel.
            `border-surface-line` is new: an UNCOLOURED `border-r` inherits the text colour, so on the dark
            theme this seam was drawn in whatever the surrounding text happened to be. */}
        {tabs.active && (
          <div className="flex-1 flex flex-col h-full min-w-0 border-r border-surface-line overflow-hidden">
            <FileTabs
              open={tabs.open}
              active={tabs.active}
              dirty={dirtyFiles}
              onSelect={(path) => setTabs((prev) => ({ ...prev, active: path }))}
              onClose={handleCloseFile}
            />
            {/*
              ── ⚠ EVERY OPEN FILE STAYS MOUNTED, AND THE INACTIVE ONES ARE HIDDEN ──────────────
              Not `<FileEditorView filePath={tabs.active} />`, which is the obvious version and loses work:
              the editor holds its own edited text, so remounting it on every tab switch would silently
              DISCARD unsaved changes and reset the scroll position. The same "hidden, not unmounted" rule the
              chat pane follows, and for the same reason.

              ⚠ THIS IS WHY THE TAB COUNT IS CAPPED (`MAX_OPEN_TABS`): each mounted editor holds the file's
              text twice, current and original, to know whether it is dirty.
            */}
            {tabs.open.map((path) => (
              <div
                key={path}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${path === tabs.active ? "flex" : "hidden"}`}
              >
                <FileEditorView
                  filePath={path}
                  onClose={() => handleCloseFile(path)}
                  onDirtyChange={handleDirtyChange}
                />
              </div>
            ))}
          </div>
        )}

        {/* ── THE RIGHT PANEL: ONE PANE, OR TWO WHEN A VIEW IS PINNED ──────────────────────
            A ROW, not a column, so a pinned view sits BESIDE the active one. It was a column when it only
            ever held one view at a time.

            ⚠ THE PINNED PANE IS SUPPRESSED WHILE A FILE IS OPEN, and the pin is remembered rather than
            cleared. The editor is itself a deliberate split — a third column would leave all three around
            300px on a typical window, which is narrower than the commit field, the board columns and the
            chat composer are usable at. Closing the file brings the pinned pane straight back. */}
        <div
          className={`flex h-full min-w-0 overflow-hidden ${tabs.active ? "w-[450px] flex-shrink-0" : "flex-1"}`}
        >
          {/*
            ── ⚠ THE CHAT CONTAINER NEVER MOVES IN THE DOM, AND THAT IS THE WHOLE DESIGN ──
            It keeps one position and one parent for the life of the app. Its VISIBILITY and its flex
            `order` change; its place in the tree does not.

            React reconciles by position, so re-parenting this subtree to put a pinned chat on the right
            would UNMOUNT it — killing the CLI process, the in-flight stream and every retained tool block.
            That is the same state the pre-existing "hidden, not unmounted" trick was protecting, and
            `order-2` achieves the move without paying for it.
          */}
          {/*
            ⚠ THE PIN IS NO LONGER AN OVERLAY, so `relative` here is no longer holding it in place — it now
            renders inside its pane's own header row, beside the title (see `PanePinSlot`). The class stays
            because these wrappers are the positioning context for OTHER things inside a pane, but it is no
            longer load-bearing for the pin, and a future reader should not restore an `absolute` pin on the
            strength of it.
          */}
          {activeProject && (
            <div
              className={`relative flex h-full min-w-0 flex-col overflow-hidden ${
                chatPane.visible ? "flex-1" : "hidden"
              } ${chatPane.order} ${chatPane.order === "order-2" ? PANE_DIVIDER : ""}`}
            >
              {/* The pin travels DOWN to whichever chat view renders, and lands next to its title. Both
                  views carry a slot, because either can be the one on screen. */}
              <PanePinProvider pin={pinFor("chat")}>
                {/*
                  ── ⚠ THE FILENAMES IN A REPLY OPEN IN THE EDITOR ────────────────────────────────

                  Scoped to the AI chats (Kiro, Claude and Codex) — team chat deliberately does not do this.

                  ⚠ WIRED HERE, ONCE, RATHER THAN AS A PROP ON EACH VIEW. Both views render markdown in
                  several places each — the saved turn, the live stream, and a shared-chat dialog — reached
                  through module functions and nested components. A context is what stops one of those sites
                  from being missed, which is the exact failure `chat-view-parity.test.ts` was written for.

                  `handleOpenFile` is the same door `FileSearch` and the tree use, so the tab cap and the
                  unsaved-work rules in `lib/file-tabs.ts` apply unchanged to a click in the transcript.
                */}
                <FileMentionScope
                  root={activeProject.path}
                  onOpenFile={handleOpenFile}
                  /* The answering assistant's ink, so a mention belongs to the transcript around it. */
                  accent={assistantTheme(aiCommand).ink}
                >
                  {useAcpMode ? (
                    <KiroChatView project={activeProject} onBusyChange={setAssistantBusy} />
                  ) : (
                    <AssistantChatView project={activeProject} onBusyChange={setAssistantBusy} />
                  )}
                </FileMentionScope>
              </PanePinProvider>
            </div>
          )}

          {/* The ACTIVE view, when it is not the chat (which has its own persistent pane above). */}
          {view !== "chat" && (
            <div className="relative order-1 flex h-full min-w-0 flex-1 flex-col overflow-hidden">
              <PanePinProvider pin={pinFor(view)}>{renderView(view)}</PanePinProvider>
            </div>
          )}

          {/* The PINNED view, beside it, with the divider that says they are two panes.
              ⚠ THE CHAT PANE CARRIES THE SAME DIVIDER WHEN IT IS THE ONE ON THE RIGHT — see `chatPane.order`
              above. Reported twice, latterly as "the left border for tabs missing": the divider lived only on
              THIS element, and pinning the CHAT does not render it here. `paneLayout` moves the persistent
              chat pane with flex `order` instead (it must never be re-parented, or its CLI process dies), so a
              pinned chat sat second with no left edge at all. */}
          {showPinnedPane && (
            <div
              className={`relative order-2 flex h-full min-w-0 flex-1 flex-col overflow-hidden ${PANE_DIVIDER}`}
            >
              <PanePinProvider pin={pinFor(pinnedView!)}>{renderView(pinnedView!)}</PanePinProvider>
            </div>
          )}

          {/* Chat is the active view but there is no folder yet. */}
          {view === "chat" && !activeProject && <EmptyState onAdd={handleSwitchFolder} />}
        </div>
        </div>
      </main>
      </div>
      {/*
        ⚠ OUTSIDE `<main>` AND LAST IN THE TREE, like every other overlay in this app: it is
        `position: fixed` over the whole window, and nesting it inside a pane would put it inside
        that pane's `overflow-hidden` and its stacking context.

        ⚠ `pendingFolder` IS CLEARED BEFORE `performSwitch` RUNS, not after it resolves. The switch
        awaits a framework install that can take minutes and may run an agent; leaving the dialog up
        for the duration would read as "nothing happened" and invite a second click, and the sidebar
        already reports progress through `switchStatus`.
      */}
      {/*
        ⚠ ABOVE THE CONFIRM DIALOG IN THE TREE AND IN z-INDEX, though the two can never be visible at
        once: the confirmation is cleared before `performSwitch` starts. The ordering is about which
        one wins if a future edit makes them overlap — a block must never be paintable under a dialog
        that can be dismissed.
      */}
      {frameworkSetup && (
        <FrameworkSetupBlocker frameworkName={frameworkSetup} step={frameworkStep} />
      )}
      {pendingFolder && (
        <SwitchFolderConfirm
          folderPath={pendingFolder}
          currentProjectName={activeProject?.name}
          assistantName={assistantName}
          onCancel={() => setPendingFolder(null)}
          onConfirm={() => {
            const chosen = pendingFolder;
            setPendingFolder(null);
            void performSwitch(chosen);
          }}
        />
      )}
    </div>
  );
}

function FileEditorView({
  filePath,
  onClose,
  onDirtyChange,
}: {
  filePath: string;
  onClose: () => void;
  /**
   * ⚠ THE EDITOR IS THE ONLY PLACE THAT KNOWS, and two things outside it depend on the answer: the tab row
   * marks the file, and `openTab` refuses to close it to make room at the cap. Without this the tab cap would
   * happily evict a file with unsaved edits.
   */
  onDirtyChange?: (filePath: string, dirty: boolean) => void;
}) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Separator-agnostic — see tabLabel. On Windows the old form returned the entire path.
  const fileName = basenameOf(filePath) || filePath;
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const isBinary = ["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot", "pdf", "zip"].includes(ext);
  const isMarkdown = ext === "md" || ext === "markdown";

  // Markdown files default to preview; other files open in the editor.
  const [mode, setMode] = useState<"preview" | "edit" | "answer">(isMarkdown ? "preview" : "edit");

  /** Set when something else wrote this file while the tab had unsaved edits. */
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  /**
   * When the file on disk was last written.
   *
   * ⚠ THE TIME ON DISK, NOT THE TIME WE READ IT. It comes from `files:stat`, which returns the same stamp the
   * stale-write guard compares against — so the header and the guard cannot disagree about when the file
   * changed. Re-read on open, after every save, and on every outside write, which is what makes it answer
   * "is what I am looking at current".
   */
  const [modifiedAt, setModifiedAt] = useState<number | null>(null);

  const refreshStamp = useCallback(() => {
    void api.statFile?.(filePath).then((st: { mtimeMs: number } | null) => {
      setModifiedAt(st?.mtimeMs ?? null);
    });
  }, [filePath]);

  useEffect(() => {
    setLoading(true);
    setError("");
    setSaveError("");
    setChangedOnDisk(false);
    setMode(isMarkdown ? "preview" : "edit");
    api.readFile(filePath)
      .then((text: string) => { setContent(text); setOriginal(text); setLoading(false); refreshStamp(); })
      .catch((err: any) => { setError(err.message || "Failed to read file"); setLoading(false); });
  }, [filePath]);

  const dirty = content !== original;

  /**
   * ── ⚠ AI-DLC QUESTION FILES GET A THIRD MODE ──────────────────────────────────────────────
   *
   * ⚠ PARSED FROM THE LIVE BUFFER, not from what was read off disk. Answering writes new markdown into
   * `content`, so re-parsing it is what makes the next click see the previous one — and it keeps the form and
   * the text view showing the same document rather than two copies that can disagree.
   *
   * ⚠ AND `isQuestionDocument` REQUIRES LETTERED OPTIONS, so a design note that happens to have a `## Q1.`
   * heading is not turned into an empty form. See lib/aidlc-questions.ts for the format, which was read off a
   * real file rather than assumed.
   */
  const questions = useMemo(
    () => (isMarkdown ? parseQuestions(content) : []),
    [isMarkdown, content]
  );
  const isQuestionFile = questions.length > 0;

  /**
   * ⚠ THE ANSWER MODE IS OFFERED, NEVER FORCED. A file that parses as questions still opens in `preview`,
   * because the participant may have opened it to READ it — and a form that could not be escaped would be a
   * regression on anything parsed imperfectly. The raw editor stays one click away, which is also where the
   * prose the framework writes into its own answers gets edited.
   */
  useEffect(() => {
    if (mode === "answer" && !isQuestionFile) setMode(isMarkdown ? "preview" : "edit");
  }, [mode, isQuestionFile, isMarkdown]);

  /**
   * Write one answer back into the buffer.
   *
   * ⚠ IT GOES THROUGH `setContent`, exactly as a keystroke does, so the file is dirty-tracked, saved, watched
   * and stale-checked by the machinery that already exists. Nothing here touches disk, and the participant
   * still has to save — which is what keeps a mis-click undoable by closing without saving.
   */
  const answerQuestion = useCallback(
    (question: ParsedQuestion, letters: string[], freeText?: string) => {
      setContent((prev) => setAnswer(prev, question, letters, freeText));
    },
    []
  );

  /**
   * ── ⚠ WATCH THIS FILE WHILE THE TAB IS OPEN ───────────────────────────────────────────────
   *
   * The read above is keyed on `[filePath]` and nothing ever re-ran it, so a tab held whatever the file said
   * when it opened, for as long as it stayed open.
   *
   * ⚠ THE AGENT DOES NOT WRITE THROUGH US, which is why this is a filesystem watch and not a hook on
   * `files:writeFile`. kiro's `fs_write` and claude's `Write` run in a spawned process and touch the disk
   * directly; the filesystem is the only place both writers meet.
   *
   * ⚠ UNWATCHED ON UNMOUNT AND ON PATH CHANGE, in the same effect. A watcher per tab is an OS handle, and
   * the tab cap means they are bounded, but a leaked one survives the file being closed and reports on a
   * file nobody is looking at.
   */
  useEffect(() => {
    void api.watchFile?.(filePath);
    return () => {
      void api.unwatchFile?.(filePath);
    };
  }, [filePath]);

  /**
   * ── ⚠ RELOAD WHEN CLEAN, ASK WHEN DIRTY ───────────────────────────────────────────────────
   *
   * ⚠ THE DIRTY CASE MUST NOT RELOAD, and that is the whole reason this is not a one-liner. A tab with
   * unsaved edits is the participant's only copy of them; replacing its contents because the agent wrote the
   * file would destroy work they never saved and could not recover. So a clean tab refreshes silently — there
   * is nothing to lose and nothing to decide — and a dirty one raises the banner and lets them choose.
   *
   * ⚠ `dirtyRef`, NOT `dirty`, because this listener is registered once per path and would otherwise close
   * over the `dirty` of the render that registered it — reading `false` for the whole life of the tab, which
   * is exactly the clobber this exists to prevent.
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    api.onFileChangedOnDisk?.((data: { path: string }) => {
      // Main sends the resolved path; compare on the basename-insensitive whole string it gave us.
      if (!data?.path || !samePath(data.path, filePath)) return;
      if (dirtyRef.current) {
        setChangedOnDisk(true);
        // The banner says the file moved; the header should say WHEN, even though the buffer is unchanged.
        refreshStamp();
        return;
      }
      api.readFile(filePath)
        .then((text: string) => { setContent(text); setOriginal(text); setChangedOnDisk(false); refreshStamp(); })
        .catch(() => setChangedOnDisk(true));
    });
    return () => api.removeFileChangedListeners?.();
  }, [filePath]);

  /**
   * ⚠ SAVE ARRIVES BY EVENT, so Cmd+S works wherever focus is — see the shortcut note in App. The textarea
   * keeps its own binding too: that one is what makes the keystroke feel instant while typing, and a second
   * listener costs nothing because both funnel into `handleSave`.
   *
   * ⚠ IT IGNORES THE KEYSTROKE WHEN THERE IS NOTHING TO SAVE. A clean buffer, a still-loading file or one
   * that failed to read are all states where writing would either be a no-op or would write the wrong thing.
   */
  useEffect(() => {
    const onSaveRequest = () => {
      if (loading || error || !dirtyRef.current) return;
      void handleSave();
    };
    window.addEventListener("editor:save", onSaveRequest);
    return () => window.removeEventListener("editor:save", onSaveRequest);
  });

  /** Take the version on disk, discarding the unsaved edits — the participant's explicit choice. */
  function reloadFromDisk() {
    api.readFile(filePath)
      .then((text: string) => { setContent(text); setOriginal(text); setChangedOnDisk(false); setSaveError(""); refreshStamp(); })
      .catch((err: any) => setSaveError(err.message || "Failed to re-read file"));
  }

  useEffect(() => {
    onDirtyChange?.(filePath, dirty);
  }, [filePath, dirty]);

  /**
   * ⚠ REPORT CLEAN ON UNMOUNT, or a closed file leaves a permanent dirty flag behind — and since a dirty
   * path is never evicted to make room, the tab cap would be reached and never recoverable without a restart.
   * Keyed on the path so switching files clears the OLD one rather than the new.
   */
  useEffect(() => () => onDirtyChange?.(filePath, false), [filePath]);

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    try {
      const result = await api.writeFile(filePath, content);
      /**
       * ⚠ A REFUSED SAVE IS NOT A FAILED SAVE. Main declines when the file changed under us — see the guard
       * in `files:writeFile` — and the honest response is the same banner as the watcher raises, because the
       * choice is identical: take theirs, or overwrite with mine. A generic "Failed to save file" would send
       * the reader looking for a permissions problem.
       */
      if (result && result.success === false && result.staleOnDisk) {
        setChangedOnDisk(true);
        return;
      }
      setOriginal(content);
      setChangedOnDisk(false);
      // The save moved the file's mtime, so the header must not keep showing the pre-save time.
      refreshStamp();
    } catch (err: any) {
      setSaveError(err.message || "Failed to save file");
    } finally {
      setSaving(false);
    }
  }

  function header(extra?: ReactNode) {
    return (
      /*
        ⚠ THIS BAR WAS STILL LIGHT — `bg-gray-50`, `text-gray-600`, and a `border-b` with NO colour, so its
        rule inherited whatever the surrounding text colour happened to be. It was the last light panel in the
        app, sitting directly beside the dark chat pane.

        ⚠ AND IT WAS THE SHORTEST OF THE FOUR PANE HEADERS at `py-1.5` (~29px against the board's ~42px),
        which is half of why the tab heading bars had different heights. `PANE_HEADER` fixes the
        height for every pane at once; see `lib/pane-header.ts`.
      */
      <div className={`${PANE_HEADER} justify-between bg-surface-panel`}>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-surface-text">
          {fileName}
          {dirty && (
            <>
              <span aria-hidden="true"> •</span>
              <span className="sr-only"> — unsaved changes</span>
            </>
          )}
          {/**
            * ── ⚠ WHEN THE FILE ON DISK WAS LAST WRITTEN ────────────────────────────────────────
            *
            * ⚠ RELATIVE, WITH THE ABSOLUTE TIME IN THE TOOLTIP. "2m ago" answers the question actually being
            * asked — is what I am looking at current — in a header that has room for four characters, and the
            * exact stamp is one hover away for anybody who needs it.
            *
            * ⚠ NOT `dirty`-DEPENDENT. This is the DISK's time, so it keeps saying when the file changed even
            * while the buffer holds unsaved edits — that pairing is the point: "modified 30s ago" beside an
            * unsaved dot is exactly the state the reload banner is about.
            */}
          {modifiedAt !== null && (
            <span
              className="ml-2 font-sans text-[10px] font-normal text-surface-faint"
              title={`Last modified on disk: ${new Date(modifiedAt).toLocaleString()}`}
            >
              {relativeTime(modifiedAt)}
            </span>
          )}
        </span>
        {extra}
        <button
          onClick={onClose}
          aria-label={`Close ${fileName}`}
          className="flex-shrink-0 text-sm text-surface-muted hover:text-surface-text"
        >
          ✕
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-surface-muted">Loading…</div>
    );
  }

  if (error || isBinary) {
    return (
      <>
        {header()}
        <div className="flex flex-1 items-center justify-center text-surface-muted">
          <div className="text-center">
            <p className="text-3xl mb-3">📄</p>
            <p className="text-sm">{error || "Binary file — cannot display"}</p>
          </div>
        </div>
      </>
    );
  }

  const toolbar = (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {isMarkdown && (
        /*
          The same re-theme the rest of the app had: this strip was `bg-white` + `text-gray-600` on a
          dark titlebar, so the UNSELECTED half read as a disabled control. Selected state keeps a
          filled background as well as a colour, so it does not rest on hue alone.
        */
        <div className="flex overflow-hidden rounded border border-surface-line text-[11px]">
          <button
            onClick={() => setMode("preview")}
            className={`px-2 py-0.5 ${mode === "preview" ? "bg-brand-strong text-white" : "bg-surface-panel text-surface-muted hover:bg-surface-raised hover:text-surface-text"}`}
          >
            Preview
          </button>
          <button
            onClick={() => setMode("edit")}
            className={`border-l border-surface-line px-2 py-0.5 ${mode === "edit" ? "bg-brand-strong text-white" : "bg-surface-panel text-surface-muted hover:bg-surface-raised hover:text-surface-text"}`}
          >
            Edit
          </button>
          {/**
            * ⚠ ONLY FOR A FILE THAT PARSES AS QUESTIONS. A third segment on every markdown file would be a
            * control that does nothing on almost all of them.
            */}
          {isQuestionFile && (
            <button
              onClick={() => setMode("answer")}
              title="Answer the questions with option buttons"
              className={`border-l border-surface-line px-2 py-0.5 ${mode === "answer" ? "bg-brand-strong text-white" : "bg-surface-panel text-surface-muted hover:bg-surface-raised hover:text-surface-text"}`}
            >
              Answer
            </button>
          )}
        </div>
      )}
      <button
        onClick={handleSave}
        disabled={!dirty || saving}
        /*
          ⚠ `hover:text-surface-bg` IS NOT OPTIONAL, and this button shipped without it. `brand-accent` is a
          LIGHT fill, so hovering with white ink measures 1.80:1 — the label all but disappears under the
          pointer. It was already wrong before the palette moved (white on the old accent was 3.12:1, under
          the 4.5:1 floor); the light blue only made an existing defect obvious. Every other filled button in
          the app flips the ink on hover, and `view-theme.test.ts` now asserts the pair so this cannot recur.
        */
        className="rounded bg-brand-strong px-2 py-0.5 text-[11px] text-white transition-colors hover:bg-brand-accent hover:text-surface-bg disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );

  return (
    <>
      {header(toolbar)}
      {saveError && (
        <div className="px-3 py-1 text-[11px] text-red-600 bg-red-50 border-b border-red-100">{saveError}</div>
      )}
      {/**
        * ── ⚠ THE FILE MOVED UNDER AN UNSAVED EDIT ────────────────────────────────────────────
        *
        * A CLEAN tab reloads silently — nothing to lose, nothing to decide. This is the other case, and it
        * only ever appears when there are unsaved edits.
        *
        * ⚠ IT OFFERS BOTH ANSWERS AND PRE-EMPTS NEITHER. "Reload" discards the participant's edits for the
        * agent's version; "Keep mine" dismisses and leaves the buffer alone, and the save that follows now
        * succeeds because main re-stamps on the read that Reload does — or, if they keep theirs, because the
        * next save is a deliberate overwrite they have been told about. Choosing for them in either
        * direction destroys work somebody did.
        *
        * ⚠ `tool-warning`, NOT `tool-error`. Nothing has failed: two versions exist and one person has to
        * say which wins. tailwind.config.ts also records that `tool-error` is illegal behind text.
        */}
      {changedOnDisk && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-tool-warning/40 bg-surface-raised px-3 py-1.5"
        >
          <span className="flex-1 text-[11px] text-surface-text">
            This file changed on disk — most likely the assistant edited it. Your unsaved changes are still
            here.
          </span>
          <button
            onClick={reloadFromDisk}
            className="flex-shrink-0 rounded border border-surface-line px-2 py-0.5 text-[11px] text-surface-text transition-colors hover:bg-surface-bg"
          >
            Reload
          </button>
          <button
            onClick={() => setChangedOnDisk(false)}
            className="flex-shrink-0 rounded px-2 py-0.5 text-[11px] text-surface-muted transition-colors hover:text-surface-text"
          >
            Keep mine
          </button>
        </div>
      )}
      {isMarkdown && mode === "answer" ? (
        <QuestionForm questions={questions} onSelect={answerQuestion} disabled={saving} />
      ) : isMarkdown && mode === "preview" ? (
        <div className="overflow-auto bg-surface-bg p-6" style={{ flex: "1 1 0", minHeight: 0 }}>
          {/*
            ── ⚠ `prose`, THEMED — AND WHY `prose-invert` IS GONE ────────────────────────────
            BROKEN TWICE, in opposite directions, which is the whole story of this block:

              1. Markdown preview text was not visible in the dark app  → the app was dark, and
                 Tailwind Typography sets its OWN colours (gray-700 body, gray-900 headings, plus links, code, quotes and
                 table borders) all chosen for a LIGHT page. `prose-invert`, the plugin's dark
                 palette, fixed it.

              2. In light mode, Markdown preview text was grey and hard to read  → and that is
                 the same mistake with the sign flipped. `prose-invert` was applied
                 UNCONDITIONALLY, so once a light theme existed the preview rendered the plugin's
                 light-grey dark-mode ink on a white surface.

            Patching it a third time per-mode would just queue up a third bug. The plugin's
            palette is driven from the surface tokens in tailwind.config.ts instead, so plain
            `prose` is correct in BOTH themes and there is nothing to remember here. `text-*` on
            this wrapper still would not help: `prose` styles the DESCENDANTS and wins.

            The container keeps `bg-surface-bg` explicitly — it had no background at all, so it
            inherited whatever was behind it, which is how a preview pane ends up the wrong colour
            regardless of the ink.
          */}
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <CodeEditor value={content} onChange={setContent} onSave={handleSave} />
      )}
    </>
  );
}

// Editable code editor: a textarea overlaid on a scroll-synced line-number gutter.
function CodeEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const lineCount = value.split("\n").length;

  return (
    <div className="flex overflow-hidden" style={{ flex: "1 1 0", minHeight: 0 }}>
      <div
        /*
          ⚠ THE GUTTER WAS LIGHT TOO — `bg-gray-50` with `border-gray-200`. Re-themed with the header above it,
          because darkening only the bar would have left a dark title over a white editor: a worse mismatch
          than the uniformly-light panel it replaced.

          `surface-muted` on `surface-panel` measures 5.78:1, clear of AA for this 11px text. It is NOT
          `surface-faint`, which reads 4.74:1 there and would fail at this size.
        */
        className="flex-shrink-0 select-none overflow-hidden border-r border-surface-line bg-surface-panel pl-2 pr-2 text-right font-mono text-[11px] text-surface-muted"
        style={{ transform: `translateY(-${scrollTop}px)` }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="leading-5 h-5">{i + 1}</div>
        ))}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => setScrollTop((e.target as HTMLTextAreaElement).scrollTop)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            onSave();
          }
        }}
        spellCheck={false}
        wrap="off"
        /*
          `surface-text` on `surface-bg` is 14.33:1 — the same pairing the transcript uses for code. The
          caret follows `caret-*` rather than the text colour, which on a dark surface would otherwise be
          the browser's black default and invisible.
        */
        className="min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-surface-bg py-0 pl-3 pr-4 font-mono text-[12px] leading-5 text-surface-text caret-brand-accent outline-none"
      />
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center text-surface-muted">
      <div className="text-center">
        <p className="text-4xl mb-4">{"</>"}</p>
        <p>Open a project to get started</p>
        <button
          onClick={onAdd}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
        >
          Add Project
        </button>
      </div>
    </div>
  );
}
