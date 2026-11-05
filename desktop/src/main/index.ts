import { app, BrowserWindow, Menu, shell, session, nativeImage, ipcMain } from "electron";
import path from "path";
import { setupFileHandlers } from "./handlers/files";
import { setupFileOpsHandlers } from "./handlers/file-ops";
import { setupGitHandlers } from "./handlers/git";
import { setupAIHandlers, tearDownSession } from "./handlers/ai";
import { setupPlatformHandlers, checkPlatformDrift } from "./handlers/platform";
import { setupDbHandlers } from "./handlers/db";
import { setupTeamDataHandlers } from "./handlers/team-data";
import { setupCliAssistantHandlers } from "./handlers/cli-assistant";
import { loadAssistantCommandOverrides } from "./assistant-command-config";
import { setupClaudeCodeHandlers } from "./handlers/claude-code";
import { setupFrameworkHandlers } from "./handlers/framework";
import { setupChooserThemeHandlers, setupThemeHandlers } from "./handlers/theme";
import { setupKiroAcpHandlers } from "./handlers/kiro-acp";
import { installIpcSenderGuard } from "./ipc-guard";
import { DEV_ORIGIN, isOwnRendererUrl } from "./renderer-document";
import { isDevRuntime } from "./runtime-mode";
import { cspFor } from "../csp-policy";
import { initDeepLinks } from "./deep-link";
import { debugLog } from "./debug-log";
import { readPlatformConfig, writePlatformSeed, consumePlatformSeed } from "./platform-config";
import {
  applyProfile,
  rootDir,
  resolveLaunch,
  listProfiles,
  createProfile,
  relaunchInto,
  openProfileWindow,
  writeLastProfile,
  writeProfileMeta,
  profileDir,
  profileExists,
  sanitiseProfileName,
  DEFAULT_PROFILE_ID,
} from "./profile";
import { initDatabase } from "./database";
import { scheduleSweep } from "./sync-sweep";
import { setupTelemetry } from "./telemetry";

let mainWindow: BrowserWindow | null = null;

/**
 * ── ⚠ THE PROFILE COMES FIRST, BEFORE ANYTHING TOUCHES `userData` ─────────────────────────
 *
 * `--profile=<name>` (or `PRAIMANA_PROFILE`) redirects `userData`, which gives this process its own
 * SQLite file, its own settings — and therefore its own signed-in user, team and workshop — and its own
 * single-instance lock.
 *
 * ⚠ THIS LINE'S POSITION IS ITS CORRECTNESS. It must precede `initDeepLinks()` below, because that takes the
 * lock and Chromium keys the lock on the user-data directory; and it must precede `initDatabase()` inside
 * `whenReady`, which opens `praimana.db` from that same directory. Moved after either one, the lock and
 * the database would disagree about which profile this process is — one instance holding the lock while
 * writing another's data, which is worse than the single-instance behaviour it replaces.
 *
 * ⚠ THE LOCK IS NOT REMOVED, only re-scoped. Two instances sharing one database was the real hazard, and it
 * is prevented at the root here: separate profiles have no shared file to race on, and two copies of the SAME
 * profile still cannot start. See profile.ts, which also records what a profile deliberately is NOT — it is
 * not a security boundary between two people on one machine.
 */
/**
 * ── ⚠ WHICH PROFILE, OR WHETHER TO ASK ────────────────────────────────────────────────────
 *
 * `resolveLaunch()` reads the pointer file and the profiles directory and returns one of three outcomes:
 * launch a named profile, launch the root install, or show the chooser. Its four ordered rules — and in
 * particular why an UPGRADED install must never see the chooser — are documented on `decideLaunch`.
 *
 * ⚠ IT RUNS BEFORE `applyProfile`, WHICH IS WHAT MAKES IT POSSIBLE AT ALL. It has to read the ROOT userData
 * (the pointer file and `profiles/` both live there), and `applyProfile` is what redirects that path away.
 */
const launch = resolveLaunch();
const activeProfile = applyProfile(launch.profile);
if (activeProfile) {
  // Before `debugLog` is usable (it writes into userData, which we have only just decided).
  console.log(`[profile] running as "${activeProfile}" — data dir: ${app.getPath("userData")}`);
}

/**
 * ⚠ DEEP LINKS ARE REGISTERED AT MODULE LOAD, BEFORE `app.whenReady()`.
 *
 * macOS fires `open-url` early enough that a listener attached inside `whenReady` misses
 * the URL that LAUNCHED the app — which presents as "the portal's Open-in-app button does
 * nothing the first time, and works on the second click". See deep-link.ts.
 *
 * It also takes the single-instance lock. A false return means another copy is already
 * running and has been handed this launch's link, so this process must exit immediately —
 * before it can open a second connection to the same SQLite file.
 */
if (!initDeepLinks()) {
  app.quit();
}

// App icon. In dev the file lives in the repo's build/ dir (two levels up from
// dist/main); in a packaged app it sits next to the bundled resources. macOS
// uses the .icns from the app bundle for the dock, but in dev we set it
// explicitly via app.dock so the running app shows our icon, not Electron's.
function resolveIconPath(): string {
  return path.join(__dirname, "../../build/icon.png");
}

/**
 * The profiles, as menu items that run `open` on the chosen one.
 *
 * ⚠ BUILT FRESH EACH TIME THE MENU IS BUILT, since a profile created in another window would otherwise be
 * missing until a restart. The CURRENT profile is disabled: "open the one I am already in" either does
 * nothing (a spawn that fails the lock and quits) or pointlessly restarts the window, and offering a control
 * that cannot do anything is the defect the model picker was fixed for.
 *
 * ⚠ AND THE LABEL IS THE PROFILE'S OWN, not its directory name — `profile.json` carries "Team Alpha" while
 * the directory is `teamalpha`. A menu of folded, lower-cased ids would be unreadable in exactly the place a
 * participant has to pick correctly.
 */
function profileMenuItems(
  open: (id: string) => void
): Electron.MenuItemConstructorOptions[] {
  const current = activeProfile ?? DEFAULT_PROFILE_ID;
  const items = listProfiles().map((p) => ({
    label: p.team ? `${p.label} — ${p.team}` : p.label,
    enabled: p.id !== current,
    click: () => open(p.id),
  }));
  /* Never an empty submenu: an empty menu reads as a broken one rather than as "you have no other profiles". */
  return items.length > 0
    ? items
    : [{ label: "No other profiles", enabled: false }];
}

/**
 * Ask for a name, create the profile, and open it in a new window.
 *
 * ⚠ A RENDERER PROMPT RATHER THAN A NATIVE ONE, because Electron has no text-input dialog — `dialog` offers
 * message boxes and file pickers only. The window already owns the styled prompt used elsewhere, so the menu
 * asks it to collect the name and calls back through IPC.
 */
function promptForNewProfile(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("profile:promptNew");
}

/**
 * The profile channels. Filesystem only — no database, deliberately, since the chooser runs before one is
 * open. See the note at the call site in `whenReady`.
 */
function setupProfileHandlers(): void {
  ipcMain.handle("profile:list", async () => ({
    profiles: listProfiles(),
    /** So the renderer can mark the row it is already in rather than offering to re-enter it. */
    current: activeProfile ?? DEFAULT_PROFILE_ID,
  }));

  /**
   * Create a profile and open it.
   *
   * ⚠ THE CALLER DECIDES HOW, and the two cases are not interchangeable. Selecting a new profile opens a
   * new window: from a RUNNING app (`newWindow: true`) this spawns a second instance and leaves the
   * current window untouched.
   *
   * From the LAUNCH CHOOSER it must replace instead: that process holds the lock for the ROOT userData, and
   * spawning from there would make the child fail the lock and quit while the chooser merely focused itself.
   * See the notes on `relaunchInto` and `openProfileWindow`.
   */
  ipcMain.handle(
    "profile:create",
    async (_event, params: { name?: unknown; newWindow?: unknown }) => {
      const name = typeof params?.name === "string" ? params.name : "";
      const id = createProfile(name);
      if (!id) {
        /* A name that sanitises to nothing, collides, or is the reserved `default`. */
        return { error: "That name cannot be used. Try letters, numbers, dots or dashes." };
      }

      /**
       * ── ⚠ THE NEW PROFILE INHERITS THIS ONE'S EXPERIENCE ──────────────────────────────────
       *
       * A new profile is a new `userData`, so its settings are empty, so `isPlatformConfigured()` is false and
       * `App` renders the browser-connect screen. Right for a first-ever install that genuinely does not know
       * which deployment it belongs to; wrong for a profile created BY a window that already knows.
       *
       * ⚠ CONFIGURATION ONLY — pool id, API base URL, issuer, client id, endpoints. NO token. The new profile
       * still requires its own explicit sign-in, which is an accepted cost; this removes only the
       * step where the participant re-answers a question this machine already answered.
       *
       * ⚠ AND ONLY WHEN THIS WINDOW HAS ONE. Seeded from a profile that is itself unconfigured would write an
       * empty config, which `readPlatformConfig` treats as unconfigured anyway — so the guard is for clarity
       * rather than correctness, and the new window correctly falls back to the connect screen.
       */
      /**
       * ⚠ GUARDED ON `!launch.showChooser`, AND THIS IS NOT DEFENSIVE PADDING. `readPlatformConfig` reads
       * SETTINGS, and this handler is deliberately registered before the chooser's early return — where NO
       * DATABASE IS OPEN. Called there, `getDb()` is undefined and this throws, so creating the very first
       * profile would fail. There is nothing to inherit in that mode anyway: no profile is open to inherit
       * FROM. The invariant is "the chooser touches no database", and this is the line that would have broken
       * it.
       */
      if (!launch.showChooser) {
        const inherited = readPlatformConfig();
        if (inherited) writePlatformSeed(profileDir(id), inherited);
      }
      /**
       * ⚠ REPORTS WHETHER THIS PROCESS SURVIVED, exactly as `profile:open` and `profile:openWindow` do.
       *
       * The new window is correct and documented — `relaunchInto` cannot exit in a dev build without taking
       * the vite server down with it, so it SPAWNS and says so by returning false. What was wrong is that
       * this handler threw that answer away, so the chooser had nothing to distinguish "I am about to be
       * replaced" from "I am still here", and left its button on "Opening…" for ever.
       *
       * The sibling channels already return `replaced` for this reason — "so a caller never has to infer the
       * mechanism", as the preload note puts it. This one did not, and the chooser's create path was the last
       * caller still inferring it from `newWindow`.
       */
      let replaced = false;
      if (params?.newWindow === true) openProfileWindow(id);
      else replaced = relaunchInto(id);

      /**
       * ── ⚠ CLOSE THE CHOOSER WINDOW ONCE THE PROFILE HAS OPENED ALONGSIDE IT ─────────────────
       *
       * Only reachable when `relaunchInto` SPAWNED instead of replacing — the dev-build path it documents,
       * where exiting would take `vite-plugin-electron`'s process and the dev server with it. A packaged
       * build has already exited by this line.
       *
       * ⚠ macOS ONLY, AND THAT IS NOT CAUTION FOR ITS OWN SAKE. `window-all-closed` below calls `app.quit()`
       * on every other platform, which is exactly the exit this whole branch exists to avoid: vite dies, and
       * the child that just started loads `localhost:5173` against nothing. On darwin the app stays alive
       * with no window, so closing is free. Elsewhere the window stays and says so instead.
       *
       * ⚠ AND ONLY THE LAUNCH CHOOSER. In a running app this handler is reached with a real session behind
       * the window; closing that would leave macOS with a dock icon whose `activate` rebuilds a window on the
       * OLD profile. The chooser is the only case with nothing behind it to lose.
       */
      if (!replaced && launch.showChooser && process.platform === "darwin") {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.close();
        }
      }
      return { created: id, replaced };
    }
  );

  /**
   * ── ⚠ AN EXISTING PROFILE, VALIDATED THE WAY `profile:create` VALIDATES ITS NAME ──────────────
   *
   * Both channels took the id straight from the renderer after only `typeof id === "string" && id !== ""`,
   * while the sibling `profile:create` above routes through `createProfile` and therefore through the
   * sanitiser, the collision check and the reserved-id check.
   *
   * What that cost is availability and persistence rather than execution — I checked the execution
   * question and it does not hold: the spawned binary is always `process.execPath`, the id is one argv
   * element, and both `requestedProfile` and `readLastProfile` re-sanitise on read. What IS
   * unmitigated is that `relaunchInto` writes the raw string into the machine-level pointer file and
   * then calls `app.exit(0)`, and `decideLaunch` rule 1 accepts an explicit profile that does not
   * exist YET — so one `electronAPI.profileOpen("zzz")` from renderer-bundle code killed the app,
   * created an empty profile, and repointed every subsequent launch at it. The participant sees an
   * empty app — no projects, no chats, signed out — with their data intact but reachable only through
   * the chooser.
   *
   * ⚠ `profileExists` AND NOT ONLY THE SANITISER. A sanitised-but-absent id is precisely the case that
   * caused the repoint, so "is this a real profile" is the check that matters; the sanitiser is what
   * keeps a hand-crafted value out of the pointer file.
   */
  function requireExistingProfile(raw: unknown): string | null {
    const id = sanitiseProfileName(typeof raw === "string" ? raw : null);
    if (id && profileExists(id)) return id;
    // The sentinel is a real, launchable profile that has no directory — see profile.ts.
    if (typeof raw === "string" && raw === DEFAULT_PROFILE_ID && profileExists(DEFAULT_PROFILE_ID)) {
      return DEFAULT_PROFILE_ID;
    }
    return null;
  }

  /** Enter an existing profile, replacing this window. */
  ipcMain.handle("profile:open", async (_event, params: { id?: unknown }) => {
    const id = requireExistingProfile(params?.id);
    // ⚠ ONE MESSAGE FOR BOTH "MALFORMED" AND "ABSENT". A caller must not be able to use this channel
    // to enumerate which profiles exist on the machine.
    if (!id) return { error: "Unknown profile" };
    /**
     * ⚠ `replaced` IS PART OF THE ANSWER, not a detail. In a packaged build this process is about to
     * exit, so the renderer should leave its picker up for the instant that remains. In development it
     * spawns alongside instead (the dev server is a child of this process and dies with it), so the
     * picker MUST dismiss itself or the old window is stranded on a chooser while the new window opens
     * behind it — reported exactly that way.
     */
    const replaced = relaunchInto(id);
    return { opening: id, replaced };
  });

  /** Open one in a SECOND window, leaving this one alone — the File-menu behaviour, exposed to the UI too. */
  ipcMain.handle("profile:openWindow", async (_event, params: { id?: unknown }) => {
    const id = requireExistingProfile(params?.id);
    if (!id) return { error: "Unknown profile" };
    openProfileWindow(id);
    // Uniform shape with `profile:open`: this path never replaces this process, and saying so beats
    // leaving the caller to infer it from which channel it happened to call.
    return { opening: id, replaced: false };
  });

  /**
   * Label this profile once the app knows who is in it, so the chooser and the File menu can name it after a
   * person rather than a directory.
   *
   * ⚠ DISPLAY STRINGS ONLY — this lands in a plaintext sidecar file that a process with no database open has
   * to read. Nothing the keychain protects goes near it.
   */
  ipcMain.handle(
    "profile:describe",
    async (_event, params: { label?: unknown; team?: unknown }) => {
      writeProfileMeta(activeProfile ?? DEFAULT_PROFILE_ID, {
        ...(typeof params?.label === "string" && params.label ? { label: params.label } : {}),
        ...(typeof params?.team === "string" && params.team ? { team: params.team } : {}),
      });
      return { described: true };
    }
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    /**
     * ── ⚠ macOS ONLY GETS THE HIDDEN TITLEBAR ────────────────────────────────────────────────
     *
     * `hiddenInset` is a macOS style. On Windows Electron treats it as `hidden`, which removes the
     * frame AND the minimise/maximise/close buttons — and this app draws no replacements, so the
     * window could only be closed from the taskbar or with Alt+F4. A window a participant cannot close
     * is not a cosmetic defect.
     *
     * ⚠ THE DEFAULT FRAME IS THE CONSERVATIVE CHOICE, not the pretty one. `titleBarOverlay` would keep
     * the custom strip and let Windows draw its buttons over the top-right of the content — closer to
     * the macOS look, and it needs the strip's right-hand side re-laid-out around those buttons, which
     * is a visual judgement nobody can make from a Mac. A real title bar above our own strip is
     * slightly redundant and unmistakably functional; the overlay is worth revisiting by someone who
     * can see it.
     */
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    icon: resolveIconPath(), // used on Windows/Linux; ignored on macOS
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const isDev = isDevRuntime();

  // Block in-app navigation and new windows: the renderer should never leave
  // the app shell or open attacker-controlled pages that hold the IPC bridge.
  const devOrigin = DEV_ORIGIN;
  /**
   * ⚠ ONLY OUR OWN DOCUMENT, not "any file:// URL".
   *
   * This used to return early for anything starting with `file://`, so a click on a link to a local
   * HTML file navigated this window there — and that document then ran with the same preload and
   * passed the IPC sender check for every channel. Markdown in `App.tsx` / `AssistantChatView.tsx`
   * renders plain in-window `<a href>` links, so the route was a click, not an exploit chain.
   *
   * `isOwnRendererUrl` also fixes the dev allowance, which was a string prefix: `startsWith(
   * "http://localhost:5173")` matched `http://localhost:51735` too.
   */
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isOwnRendererUrl(url)) return; // our own document (dev server, or the packaged file)
    event.preventDefault();
  });

  /**
   * ⚠ SUBFRAMES TOO. `will-navigate` fires for the MAIN frame only, so an iframe could navigate
   * unchecked. Low impact today — `nodeIntegrationInSubFrames` is off so a subframe gets no preload,
   * and `isAllowedSender` would reject it anyway — but the guard costs one line and the app renders
   * markdown from the agent, team chat and a shared document store, which is exactly the content that
   * acquires an iframe by accident later.
   */
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (isOwnRendererUrl(event.url)) return;
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External links open in the user's browser; no in-app popups.
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  /**
   * ── ⚠ THE CHOOSER IS THE SAME WINDOW WITH A FLAG, NOT A SECOND HTML ENTRY ────────────────
   *
   * `?chooser=1` tells the renderer to draw the profile picker instead of the app. One entry point keeps the
   * preload bridge, the CSP and the navigation guards identical for both — a second HTML file would be a
   * second place to keep those in step, and the picker is the one screen that runs before anything is
   * signed in.
   */
  const query = launch.showChooser
    ? `?chooser=1${launch.mustCreate ? "&mustCreate=1" : ""}`
    : "";

  if (isDev) {
    mainWindow.loadURL(devOrigin + query);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"), {
      search: query.replace(/^\?/, ""),
    });
  }

  /**
   * ── ⚠ THE TITLE IS FOR THE *SWITCHER*, NOT FOR THE WINDOW ────────────────────────────────
   *
   * ⚠ THIS CLAIMED MORE THAN IT DELIVERED AND IS CORRECTED. The note here said "the profile is in the title,
   * and it is not cosmetic … two windows are otherwise indistinguishable". Half right: `titleBarStyle:
   * "hiddenInset"` (above) hides the native title bar entirely, leaving only the traffic lights over the
   * app's own content — so this string appears in the Window menu, Mission Control and ⌘-Tab, and NOWHERE ON
   * THE WINDOW ITSELF. Anyone looking at two side-by-side windows saw no difference at all.
   *
   * It is still worth setting, because the app switcher and Mission Control are exactly where you pick
   * between two windows of one app. The VISIBLE half — the profile name next to the macOS
   * window buttons — is drawn by the renderer in its own title strip, beside the traffic lights, since that
   * is the only part of this window adjacent to those buttons. See App.tsx.
   */
  if (activeProfile) {
    mainWindow.setTitle(`Praimana — ${activeProfile}`);
    /* Electron would otherwise let the page's <title> win and overwrite it on load. */
    mainWindow.on("page-title-updated", (event) => event.preventDefault());
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  app.setName("Praimana");

  // Show our icon on the macOS dock during development. (Packaged builds use the
  // .icns baked into the app bundle by electron-builder.)
  if (process.platform === "darwin" && app.dock) {
    const img = nativeImage.createFromPath(resolveIconPath());
    if (!img.isEmpty()) app.dock.setIcon(img);
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Praimana",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    /**
     * ── ⚠ THE FILE MENU, WHICH THIS APP DID NOT HAVE ─────────────────────────────────────────
     *
     * ⚠ THE WORDING IS "NEW WINDOW WITH PROFILE" RATHER THAN "SWITCH PROFILE", and that is honest rather
     * than borrowed. `userData` is fixed once the database is open, so a profile can only be entered by a
     * NEW PROCESS — there is no in-place switch to offer. VS Code words it the same way for the same reason.
     *
     * `Switch Profile` below therefore says what it does: it REPLACES this window (via `app.relaunch`),
     * where the submenu above opens a second one concurrently. Two different mechanisms, and mixing them up
     * is a real bug — see the note on `relaunchInto` in profile.ts.
     */
    {
      label: "File",
      submenu: [
        {
          label: "New Window with Profile",
          submenu: profileMenuItems((id) => openProfileWindow(id)),
        },
        /**
         * ⚠ THERE IS NO "SWITCH PROFILE" HERE, DELIBERATELY.
         *
         * It offered `relaunchInto`, which REPLACES the window — and a menu item that closes the app you are
         * working in to reopen it as somebody else is a foot-gun next to "New Window", which does the useful
         * thing without discarding anything. `relaunchInto` is still used, by the chooser, where replacing the
         * window is the whole point.
         */
        { type: "separator" },
        {
          label: "New Profile…",
          click: () => promptForNewProfile(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  /**
   * Content-Security-Policy, as a RESPONSE HEADER.
   *
   * ⚠ THIS REACHES THE DEV SERVER ONLY, WHICH IS WHY THERE IS NOW A META TAG TOO. `onHeadersReceived`
   * needs an HTTP response to attach a header to; production loads the renderer with `loadFile`, over
   * `file://`, which has neither. So the packaged app — the one that ships — was very likely running
   * with no policy at all. The meta tag is injected into `index.html` at build time by the `csp`
   * plugin in vite.config.ts, and both read the same strings from src/csp-policy.ts so they cannot
   * disagree.
   *
   * The header is kept rather than replaced: it is what covers the dev server, and in production it
   * simply never fires.
   */
  const isDev = isDevRuntime();
  const csp = cspFor(isDev);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  /**
   * ── ⚠ PERMISSIONS: DENY BY DEFAULT, BECAUSE ELECTRON'S DEFAULT IS NOT ────────────────────
   *
   * With no handler installed, Chromium/Electron grants most permission requests without asking —
   * camera, microphone, geolocation, notifications. This app needs none of them, so a compromised
   * renderer could have taken any of them silently with no app-layer prompt.
   *
   * An allowlist rather than a denylist, and it is currently EMPTY: nothing in this product uses a
   * privileged web capability. If one is ever needed, adding it here is a deliberate act with a
   * reviewer, which is the property that matters — the previous state granted them by omission.
   *
   * Both hooks are set: `setPermissionRequestHandler` covers an explicit request, and
   * `setPermissionCheckHandler` covers the synchronous query some APIs make instead.
   */
  const ALLOWED_PERMISSIONS: readonly string[] = [];
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.includes(permission);
    if (!allowed) console.warn(`[permissions] denied "${permission}"`);
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.includes(permission)
  );

  // Guard all IPC by sender origin before any handlers are registered (M-4).
  installIpcSenderGuard();

  /**
   * ── ⚠ THE PROFILE HANDLERS EXIST IN BOTH MODES, AND TOUCH NO DATABASE ────────────────────
   *
   * Registered before the early return below, because the chooser needs them and the chooser is the one
   * screen that runs with NO database open. Everything they call reads the filesystem only — the profiles
   * directory, `profile.json`, the pointer file.
   */
  setupProfileHandlers();

  /**
   * ── ⚠ NO PROFILE CHOSEN MEANS NO DATABASE OPENED ─────────────────────────────────────────
   *
   * The chooser returns here and NOTHING below runs: no `initDatabase`, no telemetry, no assistant handlers.
   * That is the invariant worth having rather than an optimisation — the alternative (show the picker inside
   * the default profile) makes the default profile a junk drawer that collects half-signed-in state from
   * everyone who was only passing through the screen, and it would create a database for a profile the user
   * never chose.
   *
   * ⚠ THE WINDOW IS STILL CREATED, obviously — it is what draws the chooser. It just has no data behind it,
   * which is why `profile:*` are the only handlers registered.
   */
  if (launch.showChooser) {
    /**
     * ⚠ BEFORE `createWindow()`, NOT AFTER. `main.tsx` calls `theme:get` before `createRoot`, so the
     * handler has to exist by the time the document loads or the picker paints dark on a light machine
     * — which is exactly the missing-handler error this fixes.
     *
     * The chooser variant is deliberately database-free and is the ONLY `theme:get` registered on this
     * path; `setupThemeHandlers()` below is never reached, so the two cannot collide on the channel.
     */
    setupChooserThemeHandlers();
    createWindow();
    return;
  }

  /**
   * ⚠ REMEMBERED ONLY ONCE THE LAUNCH HAS SUCCEEDED, not when the choice was made. Writing the pointer in
   * the chooser would mean a profile that fails to start becomes the one we return to on every subsequent
   * launch — a broken profile that cannot be escaped without deleting a file by hand.
   */
  writeLastProfile(activeProfile ?? DEFAULT_PROFILE_ID);
  writeProfileMeta(activeProfile ?? DEFAULT_PROFILE_ID, {
    lastUsedAt: new Date().toISOString(),
  });

  await initDatabase();

  /**
   * ── ⚠ ADOPT AN INHERITED EXPERIENCE, IF THIS PROFILE WAS CREATED BY ANOTHER WINDOW ───────
   *
   * Immediately after `initDatabase`, because it WRITES SETTINGS and there is no database before this line —
   * and before `checkPlatformDrift` below, or that would compare a recorded fingerprint against the config we
   * are about to install and void a session that has not been created yet.
   *
   * Consumed rather than merely read: a seed that survived would re-apply on every launch, silently reverting a
   * participant who deliberately pointed this profile somewhere else. See `consumePlatformSeed`.
   */
  if (consumePlatformSeed(app.getPath("userData"))) {
    debugLog("[platform] adopted the experience seeded by the window that created this profile");
  }
  /**
   * Before ANY handler that can spawn an assistant. Reads assistant-commands.json so an install
   * whose Claude is called `claude_bedrock` runs it instead of failing with ENOENT on the
   * participant's first message.
   *
   * ⚠ `rootDir()`, NOT `app.getPath("userData")`. `applyProfile` has already run by this point and
   * has REPLACED what getPath returns, so getPath would resolve to the ACTIVE PROFILE's directory —
   * meaning a participant with three profiles would need three copies of this file, and a new
   * profile would silently lose the override and fail with the ENOENT it exists to prevent.
   *
   * The binary's name is a fact about the MACHINE, not about a workshop, so it belongs in the root
   * alongside the profile list rather than inside any one profile.
   */
  loadAssistantCommandOverrides(rootDir());
  setupTelemetry();
  setupFileHandlers();
  // MUTATING file operations (create/rename/move/copy/trash) — separate module because they
  // change the user's working tree and one of them deletes. See handlers/file-ops.ts.
  setupFileOpsHandlers();
  setupGitHandlers();
  setupAIHandlers();
  // The teardown is PASSED IN rather than imported by the platform module, so the two
  // do not import each other. handlers/ai.ts owns it because it owns the cached bearer
  // and the event stream — see SessionTeardown in handlers/platform.ts.
  setupPlatformHandlers(tearDownSession);
  setupDbHandlers();
  // Must follow setupAIHandlers(): the board/chat/phases fetches borrow that
  // module's token authority (fetchAuthed) rather than holding one of their own.
  setupTeamDataHandlers();
  setupCliAssistantHandlers();
  /**
   * BOTH ASSISTANT IMPLEMENTATIONS ARE REGISTERED, on purpose.
   *
   * `cli-assistant` spawns the CLI and is what ships today. `claude-code` uses the official
   * @anthropic-ai/claude-agent-sdk and adds the real permission prompts the renderer's approve/deny
   * card has always been waiting for. They occupy DIFFERENT channels (`cli:*` vs `claude-sdk:*`), so
   * registering both is safe — Electron throws on a duplicate handler, which is a useful guarantee
   * that they cannot silently collide.
   *
   * Nothing switches automatically. The renderer chooses per turn, so the SDK path can be exercised
   * in a workshop without putting the working path at risk.
   */
  setupClaudeCodeHandlers();
  setupFrameworkHandlers();
  /* Before `createWindow()` below, so the first frame is already the right colour — see handlers/theme.ts. */
  setupThemeHandlers();
  /**
   * ⚠ NO `setupPtyHandlers()`. The embedded terminal is GONE — see the note where the `pty:*` bridges
   * used to be in preload/index.ts. Nothing replaces it: the assistant runs its own tools, and a second
   * way to run commands was never reachable from the UI.
   */
  setupKiroAcpHandlers();

  /**
   * Void the session if the platform changed while the app was closed.
   *
   * BEFORE `createWindow()`, so the first frame the user sees is already correct. Run
   * afterwards it would broadcast `platform:changed` at a window that may not have
   * attached its listener yet — the renderer would show a signed-in app for a session
   * main has already torn down, and only discover it on the next request.
   *
   * Cheap (two settings reads and a hash) and silent when nothing changed.
   */
  checkPlatformDrift(tearDownSession);

  createWindow();

  /**
   * ── ⚠ NO AUTO-UPDATER. A NEW VERSION IS A NEW DOWNLOAD THAT REPLACES THE APP ──────────────
   *
   * `setupAutoUpdater()` and `updater.ts` are gone, with `electron-updater` and the S3 publish targets.
   * Distribution is deliberately manual: a later build is a file someone downloads and drops in place of
   * the installed app.
   *
   * ⚠ THIS IS SAFE BECAUSE NO USER DATA LIVES IN THE APP BUNDLE. Everything is under `userData` —
   * `profiles/<id>/praimana.db` per profile, plus the profile pointer — so replacing the bundle
   * cannot touch a database, and `initDatabase()` above migrates whatever it finds forward on first open
   * (verified against a real pre-migration v0 database: it reaches the current version with every row
   * intact).
   *
   * ⚠ TWO IDENTIFIERS MUST THEREFORE NEVER CHANGE, and they are the only way to lose data here:
   *
   *   `productName`   NAMES the `userData` directory, so renaming the app points it at a directory that
   *                   does not exist yet — Electron creates an empty one and the previous data is
   *                   stranded beside it under the old name. There is no error and no prompt: the app
   *                   opens, works, and appears to have deleted everything. A rename therefore needs a
   *                   step that MOVES the directory, not just a string edit.
   *   `build.appId`   `safeStorage` keys the encryption of stored tokens to the app's identity, so a new
   *                   id leaves the database readable but every credential in it undecryptable — i.e.
   *                   every profile silently signed out. Same reason `patch-electron-name.sh` refuses to
   *                   touch `CFBundleIdentifier`.
   *
   * ⚠ AND REPLACEMENT IS FORWARD-ONLY. Migrations do not run backwards: an OLDER build opening a newer
   * database keeps the newer schema (no error, and the extra columns are harmless), but the unique index
   * added by migration 9 stays and rejects the plain project INSERT older code performed —
   * `UNIQUE constraint failed: index 'idx_projects_path_user'`. Handing someone a previous build is not
   * the reverse of handing them a new one.
   */

  /**
   * ── SETTLE ANYTHING THE LAST SESSION LEFT OWING (backlog 8f) ─────────────────────────────
   *
   * ⚠ STARTUP IS A SEPARATE TRIGGER FROM SIGN-IN, and both are needed. An ordinary restart does not
   * call `adoptSession` — the bearer is read from settings — so a sign-in hook alone would never fire
   * for the commonest case: the app was closed with turns still unsynced and is opened again.
   *
   * AFTER `createWindow()` and delayed inside `scheduleSweep`: the first seconds belong to the window.
   * The sweep is a no-op when nothing is owed (one indexed COUNT), so this costs nothing on the normal
   * path.
   */
  scheduleSweep("startup");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
