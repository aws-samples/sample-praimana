import { useEffect, useState } from "react";
import claudeIcon from "../assets/claude.png";
import kiroIcon from "../assets/kiro.png";
import codexIcon from "../assets/codex.png";
import { FileTree } from "./FileTree";
import { BrandName } from "./BrandName";

const api = (window as any).electronAPI;

/**
 * ── THE FILE TREE LIVES IN FileTree.tsx NOW ──
 *
 * It was ~700 lines of this file. It moved out UNCHANGED so the full Explorer panel can render the
 * same tree the rail does, rather than a second copy that would drift from it. `MOD` and
 * `REVEAL_LABEL` went with it: they label the context menu, which is the tree's, not the chrome's.
 */

interface Project {
  id: string;
  name: string;
  path: string;
}

interface UnreadCounts {
  ai: number;
  chat: number;
  board: number;
  phases: number;
}

/**
 * ── ⚠ THE BRANCH, BESIDE "SOURCE CONTROL" ────────────────────────────────────────────────
 *
 * The name was already available — `git:status` has always returned `branch` — but only INSIDE the
 * Source Control panel, so seeing which branch you were on required opening the thing you were about to
 * act on. This puts it where the decision is made.
 *
 * ⚠ FETCHED HERE RATHER THAN PASSED DOWN. `App` does not read git status at all, so threading it
 * through would mean teaching the shell about git to decorate one label. `git:status` is a cheap local
 * call and already runs on every GitPanel refresh.
 *
 * ⚠ AND A NON-REPO IS SILENT. A folder with no `.git` is a perfectly ordinary project state, so the label
 * simply does not render — a "not a repository" badge on a nav item would be noise for everyone who never
 * uses git. `git:status` used to THROW for that folder and this effect swallowed the rejection; it now
 * answers `{ isRepo: false, branch: null }` instead, so the ordinary case no longer arrives as an error.
 * See the note on the `.catch` below, and handlers/git.ts.
 */
interface SidebarProps {
  activeProject: Project | null;
  /**
   * Collapsed to an ICON RAIL, VS Code's activity bar — not hidden.
   *
   * The first version collapsed the whole panel to `w-0`, which gave the screen back and took navigation with
   * it: getting to Team Chat meant re-opening the panel, clicking, and collapsing again.
   */
  collapsed?: boolean;
  /**
   * Collapse/expand. Lives HERE rather than in the titlebar because that strip is the window's drag
   * region and, with `titleBarStyle: "hiddenInset"`, also the macOS traffic-light inset — a button at its
   * left edge competes with the OS controls for the same few pixels.
   */
  onToggleCollapse?: () => void;
  /** The view currently pinned beside the active one, if any. */
  pinnedView?: string | null;
  /** Pin or unpin a view. Called with the row's own key. */
  onTogglePin?: (view: string) => void;
  /** Which views may be pinned — see PINNABLE_VIEWS in App. */
  pinnableViews?: readonly string[];
  view: string;
  assistantName: string;
  aiCommand?: string;
  switching?: boolean;
  /** A turn is in flight, so the folder must not be replaced under it — see App.tsx. */
  assistantBusy?: boolean;
  /** Bumped when something outside the tree wrote to the folder — see FileTree's own note. */
  refreshSignal?: number;
  switchStatus?: string;
  unread?: UnreadCounts;
  /**
   * The assistant is blocked on a permission prompt nobody has answered.
   *
   * ⚠ NOT PART OF `unread`, because it clears on a different event — see the note at its badge below.
   */
  awaitingPermission?: boolean;
  /** The file the editor shows, so the tree can reveal and mark it. */
  activeFilePath?: string | null;
  onSelectView: (view: any) => void;
  onSwitchFolder: () => void;
  onOpenFile?: (filePath: string) => void;
}

export function Sidebar({
  activeProject,
  collapsed = false,
  onToggleCollapse,
  pinnedView,
  onTogglePin,
  pinnableViews = [],
  view,
  assistantName,
  aiCommand,
  switching,
  assistantBusy,
  refreshSignal,
  switchStatus,
  unread = { ai: 0, chat: 0, board: 0, phases: 0 },
  awaitingPermission = false,
  activeFilePath = null,
  onSelectView,
  onSwitchFolder,
  onOpenFile,
}: SidebarProps) {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBranch(null);
    const path = activeProject?.path;
    if (!path) return;
    void (window as any).electronAPI
      ?.gitStatus?.(path)
      .then((st: { branch?: string | null }) => {
        if (alive) setBranch(st?.branch ?? null);
      })
      /**
       * ⚠ THIS NO LONGER CATCHES THE ORDINARY CASE, and the distinction is the point. A plain folder
       * used to reject here — on every project change, logging a GitError from main that this line
       * then hid. `git:status` answers `{ isRepo: false, branch: null }` for that now
       * (handlers/git.ts), so it flows through the `.then` above and the label simply does not
       * appear. What reaches this catch is a REAL failure, and it is still swallowed on purpose: a
       * branch label is not a surface on which to report one, and the Source Control tab is.
       */
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeProject?.path]);

  const [userName, setUserName] = useState("");

  useEffect(() => {
    api.getSetting("user_name").then((name: string | null) => {
      if (name) setUserName(name);
    });
  }, []);

  const aiIcon = aiCommand?.includes("kiro") ? kiroIcon : aiCommand?.includes("codex") ? codexIcon : claudeIcon;
  const navItems = [
    {
      key: "chat",
      label: assistantName,
      icon: "",
      img: aiIcon,
      badge: unread.ai,
      /** Only the assistant tab can be blocked; the team surfaces have nothing to approve. */
      blocked: awaitingPermission,
    },
    { key: "phases", label: "Phases", icon: "📋", badge: unread.phases },
    { key: "board", label: "Board", icon: "📌", badge: unread.board },
    { key: "team-chat", label: "Team Chat", icon: "💬", badge: unread.chat },
    /**
     * ⚠ NO "Explorer" ITEM — the tree is the panel above, so a tab would duplicate it on screen.
     *
     * "Source Control" IS here, deliberately, named as VS Code names it: the tool is git, the
     * activity is source control, and a participant looks for the activity. It held these actions in the
     * sidebar for one revision, which was too narrow for a commit field, four buttons, a log and a diff.
     */
    { key: "source-control", label: "Source Control", icon: "⑂" },
    { key: "settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    /*
      ⚠ `border-r` IS NEW, AND IT IS A CONSEQUENCE OF THE RE-THEME.

      The sidebar never had a right border and never needed one: it was `gray-900` against WHITE views, so the
      edge was obvious. Now every view is the same near-black, so there was no seam at all — the chat and the
      rail read as one continuous surface, which is exactly what the report describes. The dark theme removed a
      boundary that had been doing its work implicitly.

      `border-surface-line`, the same hairline every panel edge in the app uses.
    */
    <div
      className={`flex h-full flex-shrink-0 flex-col border-r border-surface-line bg-surface-bg text-surface-text ${
        collapsed ? "w-14" : "w-60"
      }`}
    >
      {/*
        ── THE HEADER: THE PRODUCT NAME AND THE COLLAPSE CONTROL ──────────────────────────
        The collapse arrow sits beside the product name. It was alone in the titlebar, where it also
        had to share the left edge with the macOS traffic lights; this row already existed, so the
        arrow costs no new space here.

        ⚠ THE CONTROL MUST EXIST IN BOTH STATES. The title is dropped on the rail — 48px cannot hold it,
        and "P…" says nothing — so if the arrow lived only in the expanded header, collapsing would hide
        the only way to expand again and leave Cmd/Ctrl+B as the sole escape. The rail therefore keeps a
        centred toggle of its own, in the same row position, which is also what makes the two states read
        as one control rather than two.
      */}
      <div
        className={`flex flex-shrink-0 items-center border-b border-surface-line ${
          collapsed ? "justify-center py-2" : "gap-2 px-4 py-3"
        }`}
      >
        {!collapsed && (
          <h1 className="flex-1 truncate text-sm font-bold text-surface-text"><BrandName /></h1>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand the side panel" : "Collapse the side panel to icons"}
            title={`${collapsed ? "Expand" : "Collapse"} the side panel (${
              navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"
            }B)`}
            className="flex-shrink-0 rounded px-1 py-0.5 text-xs text-surface-muted transition-colors hover:bg-surface-panel hover:text-surface-text focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent"
          >
            <span aria-hidden="true">{collapsed ? "▶" : "◀"}</span>
          </button>
        )}
      </div>

      {/*
        ── THE EXPLORER, IN PLACE OF THE OLD "Working Folder" PANEL ──

        WHAT WENT. A header reading "Working Folder", a "Switch" link, and a row repeating the project's
        name — three rows of chrome above a tree whose own section header ALREADY names the same folder.
        The name was printed twice in two styles, and the panel's only unique function was the Switch link.

        WHERE SWITCH WENT: into the Explorer's own toolbar, beside new-file/new-folder/refresh/collapse. It
        is a folder-level action and that is the folder-level toolbar, so it is more discoverable there than
        under a heading of its own — and it keeps its disabled + progress states.

        SAME SIZE: the tree still occupies `flex-1` between the title and the nav, so removing the three
        rows above it gives that space to the tree rather than changing the column's dimensions.
      */}
      {/*
        ⚠ THE TREE IS HIDDEN, NOT UNMOUNTED, ON THE RAIL. It loads its own data and remembers which folders
        are expanded; unmounting would discard both and refetch on every collapse. A file tree at 48px is
        unusable, so it goes — but it comes back exactly as it was.
      */}
      <div className={`overflow-y-auto border-t border-surface-line px-1 ${collapsed ? "hidden" : "flex-1"}`}>
        {activeProject ? (
          <FileTree
            rootPath={activeProject.path}
            projectName={activeProject.name}
            onOpenFile={onOpenFile}
            onSwitchFolder={onSwitchFolder}
            switching={switching}
            assistantBusy={assistantBusy}
            refreshSignal={refreshSignal}
            activeFilePath={activeFilePath}
          />
        ) : (
          /*
            No project. The switch action has to stay reachable HERE — this is the state in which it is the
            only useful thing on the panel, and it used to live above the tree where it was always visible.
            Losing it in this branch would leave a first-run user with no way to open a folder from the
            sidebar at all.
          */
          <div className="p-4 text-center">
            <p className="text-xs text-surface-faint">No folder open</p>
            <button
              onClick={onSwitchFolder}
              disabled={switching}
              className="mt-2 rounded border border-dashed border-surface-edge px-3 py-1.5 text-xs text-surface-muted hover:border-brand-accent hover:text-surface-text disabled:opacity-50"
            >
              {switching ? "Opening…" : "Open a folder"}
            </button>
          </div>
        )}
        {/*
          The switch PROGRESS line. Kept — it reports a genuinely slow operation (the folder is scanned and
          the assistant is re-pointed at it), and without it a click on Switch looks like nothing happened.
          Moved down here so it sits with the tree it is about to replace rather than under a heading.
        */}
        {switching && switchStatus && (
          <div className="px-3 py-1 text-[11px] text-blue-300 truncate" title={switchStatus}>
            {switchStatus}
          </div>
        )}
      </div>

      {/*
        ── ⚠ THE FILE SEARCH USED TO BE HERE, AND HAS MOVED TO THE TOP OF THE WINDOW ──────────
        First placed low in the project's left panel, then moved to match a reference layout, which puts it in
        a full-width bar above the open-file tabs.

        The reason it is better there is the width. This column is 240px, and the box, its clear button and a
        result list were all competing with the tree for it — while the bar has the whole window and can float
        its results over the panes instead of pushing the tree down the column.

        It is mounted in `App.tsx` beside the tab row. `onOpenFile` still arrives here because the TREE uses
        it; this note exists so the next person looking for the search box in the sidebar knows where it went.
      */}

      {/* Navigation */}
      {/* On the rail this is the ONLY growing section, so the icons sit at the top and the account
          button stays pinned to the bottom exactly as it does when expanded. */}
      <div className={`space-y-0.5 border-t border-surface-line p-2 ${collapsed ? "flex-1" : ""}`}>
        {navItems.map((item) => (
          /*
            ── ⚠ A STRETCHED NAV TARGET, SO THE PIN CAN SIT BESIDE THE TEXT ─────────────────────

            The pin CANNOT be a child of the row: nested interactive controls are invalid HTML and every pin
            click would also fire the navigation. So it has to be a SIBLING — and a sibling of a
            `w-full` button has nowhere to go but the far-right corner, which is exactly where it was.

            Inverted instead: the wrapper is the flex row and carries the row's appearance, the navigation
            button is `absolute inset-0` and INVISIBLE, and the visible content — icon, label, pin, badges —
            sits in normal flow above it. A positioned element paints above static siblings, so a click on
            the icon or the label still lands on the nav button; the pin takes `relative z-10` to sit above
            it and receive its own clicks.

            Two real buttons, no nesting, full-row click target, and the pin immediately after the text.
          */
          <div
            key={item.key}
            className={`group relative flex items-center rounded text-sm ${
              collapsed ? "justify-center px-0 py-2" : "gap-2 py-2 pl-3 pr-2"
            } ${
              view === item.key
                ? "bg-surface-raised text-surface-text"
                : "text-surface-muted hover:bg-surface-panel"
            }`}
          >
          <button
            onClick={() => onSelectView(item.key)}
            /*
              ⚠ THE LABEL BECOMES THE ACCESSIBLE NAME ON THE RAIL. With the text hidden, an icon-only
              button announces nothing — `aria-label` and `title` carry it, so the rail is usable by a
              screen reader and hoverable by everyone else.
            */
            /*
              ⚠ `aria-label` STAYS; `title` DOES NOT. The native tooltip is what this had, and it is the
              wrong tool here: roughly a second of hover before it appears, OS styling that ignores the
              app's theme, and it cannot be positioned — so on a left-edge rail it can render over the
              icon it is describing. A styled sibling below appears instantly, to the right, where there
              is room. The accessible name is unaffected either way.
            */
            /*
              ⚠ THE LABEL IS THE ACCESSIBLE NAME IN BOTH STATES NOW, not just on the rail. The text moved
              OUT of this button when the row inverted, so an unlabelled stretched button would announce
              nothing at all — previously the visible text served as its name when expanded.
            */
            aria-label={item.label}
            /*
              INVISIBLE AND FULL-BLEED: it carries no padding, background or text, because the wrapper draws
              all of that now. `rounded` only so the focus ring follows the row's corners.
            */
            className="absolute inset-0 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent"
          />
          {/* ── The visible row content. Static, so the stretched button above it receives the clicks. ── */}
          <>
            {/*
              Bigger, and bigger again on the rail: expanded, the icon accompanies a label; collapsed it
              IS the control, and a 16px glyph in a 56px column is a small target and a hard read.
            */}
            {(item as any).img ? (
              <img
                src={(item as any).img}
                alt=""
                className={`flex-shrink-0 rounded-full ${collapsed ? "h-6 w-6" : "h-5 w-5"}`}
              />
            ) : (
              <span className={collapsed ? "text-lg leading-none" : "text-base leading-none"}>
                {item.icon}
              </span>
            )}
            {/*
              ⚠ NOT `flex-1` ANY MORE: the pin icon sits next to the tab's text, not in the far right
              corner. A stretching label pushed everything after it to the row's far
              edge, ~150px from a short word like "Board", so the pin read as unrelated chrome rather than
              as an action on that tab. At natural width the text ends where the text ends, and the pin
              lands immediately after it.

              `truncate` and `min-w-0` because the label may now be the thing that has to give: a long
              assistant name plus a pin plus an unread count still has to fit 240px without pushing the
              count out of the rail.
            */}
            {!collapsed && <span className="min-w-0 truncate">{item.label}</span>}
            {/*
              ── ⚠ PIN: A SIBLING OF THE ROW, NOT A CHILD OF IT ────────────────────────────

              Pinning lets two views — team chat and an AI chat, say — sit side by side.

              A pin button INSIDE the row would be invalid HTML — nested interactive controls — and every pin
              click would also fire the navigation. So it is a sibling.
            
              ⚠ IT USED TO BE `absolute right-1`, i.e. the far-right corner, because a sibling of a `w-full`
              button has nowhere else to go. It belongs next to the label rather than in the corner, which
              is why the row inverted: see the note on the wrapper. The pin is now an ordinary flex child
              sitting immediately after the label.

              ⚠ REVEALED ON HOVER *OR FOCUS*, and always visible once pinned. Hover-only would make the
              control unreachable by keyboard (`group-focus-within`), and a pinned view whose pin faded out
              would leave no way to tell WHICH view is pinned or to unpin it without hunting.
            */}
            {/*
              THE RAIL TOOLTIP. Hidden from assistive tech (`aria-hidden`) because `aria-label` already
              names the button — announcing both would read the label twice. `pointer-events-none` so it can
              never intercept the click it is describing, and `whitespace-nowrap` because a two-word label
              wrapping inside a floating box is harder to read than a wide box.
            */}
            {collapsed && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-full top-1/2 z-20 ml-1 -translate-y-1/2 rounded border border-surface-line bg-surface-panel px-2 py-1 text-xs whitespace-nowrap text-surface-text opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                {item.label}
              </span>
            )}

            {/* Pinning is an expanded-panel action: the rail has no room for a second control, and the
                row is entirely the navigation target. The pin state itself is unaffected. */}
            {!collapsed && pinnableViews.includes(item.key) && (
              <button
                type="button"
                onClick={() => onTogglePin?.(item.key)}
                aria-pressed={pinnedView === item.key}
                title={
                  pinnedView === item.key
                    ? `Unpin ${item.label}`
                    : view === item.key
                      ? `${item.label} is the open view — pin a DIFFERENT one to see two at once`
                      : `Pin ${item.label} beside the open view`
                }
                /*
                  ⚠ `relative z-10` IS WHAT MAKES IT CLICKABLE. The nav button is `absolute inset-0` and
                  therefore paints above static siblings — so without lifting the pin into its own layer,
                  every click on it would land on the navigation behind it and simply switch tabs.
                  `flex-shrink-0` so a long label truncates instead of squeezing the pin out of the row.
                */
                className={`relative z-10 flex-shrink-0 rounded px-1 py-0.5 text-[10px] transition-opacity focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent ${
                  pinnedView === item.key
                    ? "text-brand-accent opacity-100"
                    : "text-surface-faint opacity-0 hover:text-surface-text group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <span aria-hidden="true">{pinnedView === item.key ? "📌" : "📍"}</span>
                <span className="sr-only">
                  {pinnedView === item.key ? "Unpin this view" : "Pin this view beside the open one"}
                </span>
              </button>
            )}
            {/*
              ⚠ ON THE SOURCE CONTROL ROW ONLY, and truncated. A long branch name
              ("feature/JARVIS-1234-rework-the-invitation-flow") would otherwise push the label out of
              the rail; `max-w` + `truncate` keeps the row's shape and `title` keeps the full name
              available. `font-mono` because a branch name is an identifier, not prose.
            */}
            {!collapsed && item.key === "source-control" && branch && (
              <span
                className="max-w-[92px] truncate rounded bg-surface-raised/60 px-1.5 py-0.5 font-mono text-[10px] text-surface-text"
                title={branch}
              >
                {branch}
              </span>
            )}
            {/*
              ⚠ POSITIONED, NOT PUSHED, ON THE RAIL. `ml-auto` needs a row to push against; in a centred
              48px button there is none, so the count would sit on top of the icon. Unread is the one thing
              that must survive collapsing — it is why somebody looks at the rail at all — so it moves to
              the icon's corner rather than being dropped.
            */}
            {/**
              * ── ⚠ BLOCKED, WHICH IS NOT THE SAME AS UNREAD ────────────────────────────────────
              *
              * ⚠ A GLYPH, NOT A COUNT. `session/prompt` does not resolve until the prompt is answered, so
              * there is never a second question waiting — a number would imply a queue that cannot exist.
              * It is also why this renders INSTEAD of the unread count rather than beside it: two badges on
              * one 48px icon is where the rail stops being readable, and "answer me" outranks "read me".
              *
              * ⚠ `tool-warning`, NOT `tool-error`. tailwind.config.ts records that `tool-error` is 3.87:1 —
              * legal as a graphical indicator, ILLEGAL as text — and this badge contains a character.
              *
              * ⚠ AND IT DOES NOT CLEAR WHEN THE TAB IS OPENED, unlike every count here. Opening the tab
              * shows the question; answering it is what resolves the turn. See `useTeamUnread`.
              */}
            {(item as any).blocked ? (
              <span
                title="Waiting for your permission"
                aria-label="Waiting for your permission"
                className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-tool-warning px-1.5 text-[10px] font-bold text-surface-bg ${
                  collapsed ? "absolute right-0.5 top-0.5" : "ml-auto"
                }`}
              >
                !
              </span>
            ) : (
              (item as any).badge > 0 && (
                <span
                  className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white ${
                    collapsed ? "absolute right-0.5 top-0.5" : "ml-auto"
                  }`}
                >
                  {(item as any).badge > 99 ? "99+" : (item as any).badge}
                </span>
              )
            )}
          </>
          </div>
        ))}
      </div>

      {/*
        ── THE SIGNED-IN PARTICIPANT — now a BUTTON that opens their account details ──

        It was a static row: an initial, a name, and no affordance. A `<button>` rather than a clickable
        `<div>`, so it gets a tab stop, Enter/Space activation and an accessible name for free — the same
        reasoning the tree's rows carry.

        `aria-haspopup="dialog"` because the target IS a dialog, so a screen reader announces that a panel
        will open rather than leaving the participant to discover it.
      */}
      {userName && (
        <button
          type="button"
          /*
            ⚠ SELECTS A VIEW, no longer opens a dialog. `aria-haspopup` went with it — announcing a popup that no
            longer appears would be worse than announcing nothing, and the row now behaves like every other nav
            item in this column.
          */
          onClick={() => onSelectView("account")}
          aria-label={`Account details for ${userName}`}
          title="View account details"
          /* Marked as selected when it is the active view — the same affordance the nav items above have, which
             is the point of moving it out of a popup. */
          className={`flex w-full items-center border-t border-surface-line py-2.5 transition-colors focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-brand-accent ${
            collapsed ? "justify-center px-0" : "gap-2 px-3 text-left"
          } ${view === "account" ? "bg-surface-raised" : "hover:bg-surface-panel"}`}
        >
          <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[11px] font-semibold bg-surface-raised text-surface-text uppercase">
            {userName[0]}
          </div>
          {/* The name and the chevron are the two things 48px cannot hold. The avatar keeps the initial,
              and `aria-label` above already names the person, so nothing is lost to a screen reader. */}
          {!collapsed && (
            <>
              <span className="flex-1 truncate text-xs text-surface-text" title={userName}>
                {userName}
              </span>
              {/* A chevron, so the row reads as "this opens something" without a hover. */}
              <span aria-hidden="true" className="flex-shrink-0 text-[9px] text-surface-faint">
                ▸
              </span>
            </>
          )}
        </button>
      )}


    </div>
  );
}
