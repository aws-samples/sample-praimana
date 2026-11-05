import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * ── ⚠ WHICH OS THIS WINDOW IS ON ──────────────────────────────────────────────────────────
   *
   * A VALUE, not a function, and deliberately not an IPC call: the titlebar layout depends on it on
   * the FIRST render. An async answer would paint a macOS-shaped strip and then correct it, which is
   * a visible jump on the app's own chrome.
   *
   * `process.platform` is one of the few things a SANDBOXED preload still has (Electron polyfills a
   * subset), so this costs nothing and needs no main-process handler.
   */
  platform: process.platform,
  // Files
  selectDirectory: () => ipcRenderer.invoke("files:selectDirectory"),
  /**
   * Record the working folder. Accepts ONLY a path `selectDirectory` just returned —
   * `project_path` feeds the filesystem confinement boundary, so it is deliberately not
   * writable through `setSetting` any more. Rejects with "Access denied" otherwise.
   */
  commitProjectPath: (path: string) => ipcRenderer.invoke("files:commitProjectPath", path),
  /** Native file picker for a document upload; returns { filePath, name } or null. */
  selectUpload: () => ipcRenderer.invoke("files:selectUpload"),
  readDirectory: (path: string) => ipcRenderer.invoke("files:readDirectory", path),
  readFile: (path: string) => ipcRenderer.invoke("files:readFile", path),
  /** Start/stop watching an open editor tab's file. See file-watch.ts. */
  /** `{ mtimeMs, size }` for an open file, or null when it is gone. */
  statFile: (filePath: string) => ipcRenderer.invoke("files:stat", filePath),
  watchFile: (filePath: string) => ipcRenderer.invoke("files:watch", filePath),
  unwatchFile: (filePath: string) => ipcRenderer.invoke("files:unwatch", filePath),
  /** Something other than us wrote a file the editor has open. */
  onFileChangedOnDisk: (callback: (data: { path: string }) => void) =>
    ipcRenderer.on("file:changed-on-disk", (_event, data) => callback(data)),
  removeFileChangedListeners: () => ipcRenderer.removeAllListeners("file:changed-on-disk"),
  writeFile: (path: string, content: string) => ipcRenderer.invoke("files:writeFile", path, content),
  getProjectInfo: (path: string) => ipcRenderer.invoke("files:getProjectInfo", path),

  /**
   * MUTATING file operations. Every one is confined to an open project by the main process, which
   * resolves SYMLINKS before deciding — the renderer cannot widen that by sending a crafted path.
   *
   * `trashFile` is named for what it does: the OS trash, not an unlink, so a mis-click is
   * recoverable in Finder/Explorer.
   */
  createFile: (parentDir: string, name: string) =>
    ipcRenderer.invoke("fileOps:createFile", parentDir, name),
  createFolder: (parentDir: string, name: string) =>
    ipcRenderer.invoke("fileOps:createFolder", parentDir, name),
  renamePath: (target: string, newName: string) =>
    ipcRenderer.invoke("fileOps:rename", target, newName),
  movePath: (target: string, destDir: string) =>
    ipcRenderer.invoke("fileOps:move", target, destDir),
  copyPath: (target: string, destDir: string) =>
    ipcRenderer.invoke("fileOps:copy", target, destDir),
  trashPath: (target: string) => ipcRenderer.invoke("fileOps:trash", target),
  revealInFolder: (target: string) =>
    ipcRenderer.invoke("fileOps:revealInFolder", target),

  // Git
  gitLog: (repoPath: string, count?: number) => ipcRenderer.invoke("git:log", repoPath, count),
  gitStatus: (repoPath: string) => ipcRenderer.invoke("git:status", repoPath),
  gitDiff: (repoPath: string, file?: string) => ipcRenderer.invoke("git:diff", repoPath, file),
  gitBranches: (repoPath: string) => ipcRenderer.invoke("git:branches", repoPath),
  /**
   * ── TWO CALLS WHERE `gitSync` WAS ONE ──
   *
   * `gitSync` collected every `.md` in the repo and pushed all of them with no way to see or choose
   * what was going. Now: list the candidates (a pure read, nothing leaves the machine), then upload
   * the subset the participant selected.
   */
  gitListUploadable: (repoPath: string) =>
    ipcRenderer.invoke("git:listUploadable", repoPath),
  gitUploadSelected: (params: { repoPath: string; paths: string[] }) =>
    ipcRenderer.invoke("git:uploadSelected", params),
  // Is this folder a git repository? Every other git bridge THROWS on a non-repo, so
  // the UI asks this first and hides the git actions entirely when it is false.
  gitIsRepo: (repoPath: string) => ipcRenderer.invoke("git:isRepo", repoPath),
  // Team documents — the versioned store the Build phase lists. `docsUpload` performs
  // ALL THREE hops (presign → PUT → confirm) in main: the renderer must never hold a
  // presigned URL that grants an S3 write, and a renderer-driven sequence could leave an
  // object in the bucket with no pointer row, i.e. a file nobody can list or read.
  docsList: () => ipcRenderer.invoke("docs:list"),
  docsVersions: (params: { path: string }) => ipcRenderer.invoke("docs:versions", params),
  docsContent: (params: { path: string; versionId?: string }) =>
    ipcRenderer.invoke("docs:content", params),
  /**
   * Is this team still readable? Answers `{ ok }` or `{ ok: false, reason }` — see team-data.ts.
   * Reports only; it clears no stored state, so the renderer's routing decision is reversible.
   */
  checkTeamAccess: () => ipcRenderer.invoke("team:checkAccess"),
  docsUpload: (params: { filePath: string; path?: string }) =>
    ipcRenderer.invoke("docs:upload", params),
  /**
   * Remove one of the team's files. ⚠ NOTHING IS DESTROYED: the service drops the pointer row and
   * writes an S3 delete marker, and the bucket is versioned with no expiry, so an operator can restore
   * it. The renderer confirms first because the participant cannot.
   */
  docsDelete: (params: { path: string }) => ipcRenderer.invoke("docs:delete", params),
  /**
   * File a bug report or feedback. Replaces the `mailto:` links: the report is stored by the platform, which
   * emails staff itself. Main assembles the version and the ids — the renderer sends only the two fields the
   * reporter actually wrote (subject and message) plus where they were.
   */
  submitFeedback: (params: {
    kind: "BUG" | "FEEDBACK";
    subject: string;
    message: string;
    location?: string;
  }) => ipcRenderer.invoke("feedback:submit", params),
  // Writes. Each resolves to { ok, error? } rather than rejecting, so the git message
  // ("nothing to commit", "no upstream branch") survives the IPC hop and can be shown.
  gitCommit: (params: { repoPath: string; message: string }) =>
    ipcRenderer.invoke("git:commit", params),
  gitPush: (repoPath: string) => ipcRenderer.invoke("git:push", repoPath),
  gitPull: (repoPath: string) => ipcRenderer.invoke("git:pull", repoPath),
  gitFetch: (repoPath: string) => ipcRenderer.invoke("git:fetch", repoPath),

  /**
   * ── PLATFORM CONFIGURATION ──
   *
   * The user asks for NOTHING. The portal's "Open desktop app" button delivers a one-time code
   * and the two URLs via an `praimana://` link; main exchanges the code for a session and the
   * pool config.
   *
   * ⚠ `connectPlatform` IS THE ONLY WAY TO CHANGE THE PLATFORM. The underlying settings are
   * readable from here but NOT writable (main/setting-access.ts), because changing the platform
   * changes which pool the app trusts and VOIDS THE SESSION. That channel redeems the code,
   * resolves the pool, tears the old session down and stamps the fingerprint as one operation;
   * a settings write could only ever do a fraction of it.
   *
   * ⚠ NEITHER THE CODE NOR ANY TOKEN CROSSES THIS BRIDGE. The renderer sees the two URLs
   * because it must show them for confirmation, and nothing else.
   */
  getPlatformConfig: () => ipcRenderer.invoke("platform:get"),
  /**
   * Describe the pending deep link so the user can confirm it, including the `linkId` that
   * `connectPlatform` must hand back and the pool/client the panel has to display.
   */
  getPendingLink: () => ipcRenderer.invoke("platform:pendingLink"),
  /**
   * Commit the pending link: resolve its pool against AWS discovery and store the platform.
   *
   * ⚠ IT TAKES THE PROPOSAL'S ID, AND ONLY THAT. The platform itself still never crosses this
   * bridge — no pool, no client, no origin — so a renderer cannot supply one of its own choosing.
   * What it passes back is an opaque id it received from `getPendingLink`, naming WHICH of main's
   * proposals the participant confirmed; main refuses anything that is not the one it is holding.
   *
   * An argument the renderer could INVENT would be the vulnerability. An argument it can only ECHO
   * is what stops a page that overwrites the pending link between render and click from having its
   * platform committed under a confirmation the participant gave to a different one.
   */
  connectPlatform: (linkId: string) => ipcRenderer.invoke("platform:connect", linkId),
  /** "Sign in to another experience" — clears the config AND the session. */
  resetPlatform: () => ipcRenderer.invoke("platform:reset"),
  isPlatformConfigured: () => ipcRenderer.invoke("platform:isConfigured"),
  /**
   * An Access Key delivered by the portal's "Open in desktop app" button.
   *
   * Two paths, because the OS uses two: `takeDeepLink` covers a COLD start (the link
   * launched the app, so no window existed to receive an event), and `onDeepLink` covers a
   * warm one. Both only PREFILL the setup field — the user still confirms where they will
   * sign in, which is what stops any web page from pointing this app at a hostile API.
   */
  takeDeepLink: () => ipcRenderer.invoke("platform:takeDeepLink"),
  onDeepLink: (callback: (data: { portalUrl: string; apiBaseUrl: string }) => void) =>
    ipcRenderer.on("platform:deepLink", (_event, data) => callback(data)),
  removeDeepLinkListeners: () => ipcRenderer.removeAllListeners("platform:deepLink"),
  /**
   * The platform changed, so the session was torn down in main.
   *
   * A DISTINCT event from `auth:expired`, deliberately: both land on the sign-in screen,
   * but "your session expired" is false here — the session was fine, the platform moved
   * — and a user told the wrong reason retries the wrong fix.
   */
  onPlatformChanged: (callback: (data: { reason: string }) => void) =>
    ipcRenderer.on("platform:changed", (_event, data) => callback(data)),
  removePlatformChangedListeners: () => ipcRenderer.removeAllListeners("platform:changed"),

  // AI (server-proxied)
  // Sign in via the native Cognito Hosted UI (opens the system browser). No
  // password — Cognito owns credentials + MFA.
  //
  // Takes NO arguments by design. The pool it authenticates against comes from the
  // CONFIGURED platform, read in main — never passed from here. A renderer-supplied
  // origin is a known renderer-supplied-origin vulnerability, and it stays closed:
  // the renderer can ask for the platform to be CHANGED (with validation and a
  // sign-out), but it cannot hand one to a single sign-in call.
  login: () => ipcRenderer.invoke("ai:login"),
  /**
   * Hand main the ID token the native sign-in form obtained from Cognito.
   *
   * ⚠ MAIN VERIFIES IT before adopting it — issuer against the configured pool, audience, token
   * use and expiry. "The renderer says this is valid" is not something main may take on trust:
   * anything in the renderer bundle could otherwise install a session for any identity, from a
   * pool of its choosing. See the handler for what is checked and what deliberately is not.
   */
  completeSignIn: (idToken: string, refreshToken?: string) =>
    ipcRenderer.invoke("auth:completeSignIn", idToken, refreshToken),
  // Registration is invite-only — accounts are created from the emailed invite
  // link, so the desktop app no longer exposes a register bridge/handler.
  joinTeam: (inviteCode: string) => ipcRenderer.invoke("ai:joinTeam", inviteCode),
  getMyTeams: () => ipcRenderer.invoke("ai:getMyTeams"),
  /**
   * Enter a team this user already belongs to.
   *
   * Not `setSetting("team_id", …)`: main owns those writes and re-checks the membership against
   * `/v1/teams/mine` first, because `team_id` is the tenant every team-scoped request — including the
   * one that publishes a private chat — is made against. See setting-access.ts.
   */
  selectTeam: (teamId: string) => ipcRenderer.invoke("ai:selectTeam", teamId),
  getEnabledAssistants: () => ipcRenderer.invoke("ai:getEnabledAssistants"),
  // aiStream / onStreamChunk / onStreamDone REMOVED: they bridged a server-side Bedrock chat that
  // no renderer code ever called, and whose route now answers 410. Assistant turns come from the
  // user's OWN local CLI (cliSend / kiroAcpSend) and are recorded via /sync.
  getProviders: () => ipcRenderer.invoke("ai:getProviders"),
  pingServer: () => ipcRenderer.invoke("ai:ping"),

  // Share AI chats with the team
  shareSession: (sessionId: string) => ipcRenderer.invoke("share:shareSession", sessionId),
  unshareSession: (sessionId: string) => ipcRenderer.invoke("share:unshareSession", sessionId),
  getSharedThreads: () => ipcRenderer.invoke("share:getSharedThreads"),
  /**
   * Read a shared thread's messages. With no `opts`, the whole thread (unchanged). With
   * `{ since }` the incremental tail for a live refresh; with `{ limit, before? }` one newest-first
   * page for scroll-up pagination, which also returns `nextBefore` (null at the thread start).
   */
  getSharedMessages: (
    threadId: string,
    opts?: { since?: string; before?: string; limit?: number }
  ) => ipcRenderer.invoke("share:getSharedMessages", threadId, opts),
  // Renews the session in main. Resolves to { ok } — the token itself never
  // crosses this bridge, and no renderer code needs it (see the board/chat/phases
  // bridges below, which do their fetching in main).
  renewSession: () => ipcRenderer.invoke("ai:renewToken"),

  // Team data (board, team chat, workshop phases). These run in the MAIN process
  // so the Cognito ID token stays there: the renderer used to read `auth_token`
  // over db:getSetting and attach its own Authorization header, which handed a
  // live bearer to anything in the renderer bundle (the governing security condition).
  getBoard: () => ipcRenderer.invoke("board:getBoard"),
  createTask: (params: { title: string; description: string | null; priority: string; assigneeId: string | null }) =>
    ipcRenderer.invoke("board:createTask", params),
  updateTask: (params: { taskId: string; title: string; description: string | null; status: string; priority: string; assigneeId: string | null }) =>
    ipcRenderer.invoke("board:updateTask", params),
  getTeamMessages: () => ipcRenderer.invoke("chat:getTeamMessages"),
  sendTeamMessage: (content: string) => ipcRenderer.invoke("chat:sendTeamMessage", content),
  getPhases: () => ipcRenderer.invoke("phases:getPhases"),
  savePhase: (params: { phaseId: string; content: string }) =>
    ipcRenderer.invoke("phases:savePhase", params),
  /**
   * ⚠ `generatePhase` IS GONE, AND IT NEVER WORKED. It POSTed to
   * `/v1/workshops/teams/:teamId/phases/:phaseId/generate`, a route that does not exist in the workshop
   * service and never has — so every "Generate from chat" click was a 404 surfaced as "Generate failed".
   *
   * The BUTTON was removed first (PhasesView), leaving this bridge and its handler as a dead channel
   * nothing called; both are removed now. Restoring the feature is not a matter of putting the button
   * back: the workshop service has no model client, and would need a Bedrock dependency plus a
   * cross-context read of the ai service's threads. That is a design decision,
   * not something a dead channel should stand in for.
   */
  getSetupInstructions: () => ipcRenderer.invoke("workshop:getSetupInstructions"),

  /**
   * The signed-in account, for the read-only details panel behind the sidebar's user row.
   *
   * READ-ONLY BY DESIGN, for now. There is deliberately no
   * matching setter: every field here is owned elsewhere — the profile by the identity service, the role by
   * the token's group claim, the Cognito config by the deployed stack — so a writer on this channel would be
   * offering to change something it cannot actually change.
   *
   * Returns local settings merged with three best-effort remote reads; `role`, `workshopName` and `cognito`
   * are null when unavailable. No token or secret is included — see the handler for why.
   */
  getAccountDetails: () => ipcRenderer.invoke("account:getDetails"),

  // Multi-user local login (account switching)
  listAccounts: () => ipcRenderer.invoke("auth:listAccounts"),
  /** How many identities this profile belongs to, and the address when there is exactly one. */
  profileIdentity: () => ipcRenderer.invoke("auth:profileIdentity"),
  switchAccount: (accountId: string) => ipcRenderer.invoke("auth:switchAccount", accountId),
  removeAccount: (accountId: string) => ipcRenderer.invoke("auth:removeAccount", accountId),
  // Sign out. Main clears the session settings AND its own cached bearer; the
  // renderer no longer writes credential keys itself (it cannot — see the
  // setting allowlist note below).
  signOut: () => ipcRenderer.invoke("auth:signOut"),
  onAuthExpired: (callback: (data: { reason: string }) => void) =>
    ipcRenderer.on("auth:expired", (_event, data) => callback(data)),
  removeAuthExpiredListeners: () => ipcRenderer.removeAllListeners("auth:expired"),

  // Real-time team events (SSE, pushed from main process — no polling).
  // Events carry a `kind`: "message" | "task" | "phase".
  subscribeTeamEvents: () => ipcRenderer.invoke("events:subscribe"),
  unsubscribeTeamEvents: () => ipcRenderer.invoke("events:unsubscribe"),
  onTeamEvent: (callback: (data: { kind: string; teamId: string; actorId: string; createdAt: string; [k: string]: unknown }) => void) =>
    ipcRenderer.on("team:event", (_event, data) => callback(data)),
  removeTeamEventListeners: () => ipcRenderer.removeAllListeners("team:event"),
  setBadgeCount: (count: number) => ipcRenderer.invoke("badge:setCount", count),
  onSyncFailed: (callback: (data: { context: string; message: string }) => void) =>
    ipcRenderer.on("sync:failed", (_event, data) => callback(data)),
  removeSyncFailedListeners: () => ipcRenderer.removeAllListeners("sync:failed"),

  /**
   * A turn's sync finished — its rows now carry a settled status.
   *
   * ⚠ THIS EXISTS BECAUSE THE BADGE WENT STALE. `cli:response-complete` fires before the fire-and-forget
   * sync writes `sync_status`, so the list the renderer reloads on that event always reads `pending`. The
   * badge then never changed, for a message that WAS on the server — reported as "synced to server but on
   * desktop its showing syncing retry".
   */
  onSyncStatus: (
    callback: (data: { ids: string[]; status: "pending" | "synced" | "failed" }) => void
  ) => ipcRenderer.on("sync:status", (_event, data) => callback(data)),
  removeSyncStatusListeners: () => ipcRenderer.removeAllListeners("sync:status"),

  /**
   * Find files by name/path inside the open project, for the Explorer's search box.
   *
   * Bounded in main (results, entries visited, depth) and returns `truncated` so the UI can say the list is
   * partial rather than implying it is complete.
   */
  searchFiles: (rootPath: string, query: string) =>
    ipcRenderer.invoke("files:searchFiles", rootPath, query),

  /**
   * ── ⚠ NO UPDATE CHANNELS. A NEW VERSION IS A NEW DOWNLOAD ─────────────────────────────────
   *
   * `checkForUpdate` / `installUpdate` / `onUpdateAvailable` / `onUpdateDownloaded` /
   * `removeUpdateListeners` are gone, with `main/updater.ts`, `electron-updater` and the S3 publish
   * targets. Distribution is manual: a later build replaces the installed app.
   *
   * ⚠ NOTHING HERE NEEDS TO SURVIVE FOR THE DATA TO. No user data lives in the app bundle — every
   * profile's database is under `userData` — so replacing the app cannot touch it, and the schema is
   * migrated forward on first open. See the long note at the `setupAutoUpdater` call site in
   * `main/index.ts` for the two identifiers (`productName`, `build.appId`) that WOULD cause loss if
   * they ever changed, and why replacement is forward-only.
   */

  // CLI Assistant
  cliStart: (sessionId: string) => ipcRenderer.invoke("cli:start", sessionId),
  cliUseAcpMode: () => ipcRenderer.invoke("cli:useAcpMode"),
  /**
   * Choose the assistant, by ID.
   *
   * Not `setSetting("ai_command", …)`: main owns that write and maps the ID to a command itself,
   * because `ai_command` is the name the app spawns. See assistant-command.ts.
   */
  cliSetAssistant: (assistantId: string) => ipcRenderer.invoke("cli:setAssistant", assistantId),
  cliSend: (params: {
    sessionId: string;
    message: string;
    model?: string;
    userMessageId?: string;
  }) =>
    ipcRenderer.invoke("cli:send", params),
  cliStop: (sessionId?: string) => ipcRenderer.invoke("cli:stop", sessionId ? { sessionId } : undefined),
  cliIsRunning: (sessionId?: string) => ipcRenderer.invoke("cli:isRunning", sessionId ? { sessionId } : undefined),
  cliGetModels: () => ipcRenderer.invoke("cli:getModels"),
  onCliOutput: (callback: (data: { sessionId: string; text: string }) => void) =>
    ipcRenderer.on("cli:output", (_event, data) => callback(data)),
  onCliResponseComplete: (callback: (data: { sessionId: string; content: string }) => void) =>
    ipcRenderer.on("cli:response-complete", (_event, data) => callback(data)),
  onCliExited: (callback: (data: { sessionId: string; code: number }) => void) =>
    ipcRenderer.on("cli:exited", (_event, data) => callback(data)),
  onCliError: (callback: (data: { sessionId: string; error: string }) => void) =>
    ipcRenderer.on("cli:error", (_event, data) => callback(data)),
  onCliRaw: (callback: (data: { sessionId: string; line: string }) => void) =>
    ipcRenderer.on("cli:raw", (_event, data) => callback(data)),
  onCliStatus: (callback: (data: { sessionId: string; status: string }) => void) =>
    ipcRenderer.on("cli:status", (_event, data) => callback(data)),
  onCliTrustRequired: (callback: (data: { sessionId: string; path: string }) => void) =>
    ipcRenderer.on("cli:trust-required", (_event, data) => callback(data)),
  cliTrustWorkspace: (folderPath: string) => ipcRenderer.invoke("cli:trustWorkspace", folderPath),
  /**
   * ⚠ THE OTHER HALF OF `cliTrustWorkspace`, and the reason it is exposed at all: a grant the
   * participant cannot withdraw is not a decision they made. Both refuse
   * any path that is not an open project root, so neither widens what the renderer can name.
   */
  cliUntrustWorkspace: (folderPath: string) =>
    ipcRenderer.invoke("cli:untrustWorkspace", folderPath),
  cliIsWorkspaceTrusted: (folderPath: string) =>
    ipcRenderer.invoke("cli:isWorkspaceTrusted", folderPath),
  /**
   * ⚠ THE AGENT'S FILE-WRITE PRE-APPROVAL. Its own channel rather than `setSetting`, because writing
   * `true` re-grants a permission the participant withdrew — see agent-trust-setting.ts. Readable
   * through `getSetting` as well, so Settings can render the state; only this can change it.
   */
  agentTrustGet: () => ipcRenderer.invoke("agentTrust:get"),
  agentTrustSetFileWrites: (allowed: boolean) =>
    ipcRenderer.invoke("agentTrust:setFileWrites", allowed),
  onCliPermissionRequest: (callback: (data: { sessionId: string; id: string; tool: string; description: string; input: any }) => void) =>
    ipcRenderer.on("cli:permission-request", (_event, data) => callback(data)),
  cliPermissionRespond: (params: { id: string; allow: boolean; sessionId?: string }) =>
    ipcRenderer.invoke("cli:permission-respond", params),

  /**
   * ── THE SDK-BASED ASSISTANT, ALONGSIDE THE SPAWN ONE ──
   *
   * Separate channels so both implementations can be registered at once. `claudeSdk*` calls the
   * @anthropic-ai/claude-agent-sdk path (claude-code.ts), which asks before every tool use via the
   * SDK's `canUseTool` — the mechanism the VS Code extension uses, and what finally fires the
   * approve/deny card the renderer already had.
   *
   * ⚠ THE STREAM EVENTS ARE SHARED (`cli:output`, `cli:error`, `cli:response-complete`,
   * `cli:permission-request`). That is deliberate: the renderer's existing listeners work unchanged
   * whichever implementation produced the turn, so switching is a matter of which SEND you call.
   * Only the REQUEST channels differ — and a permission answer must go back to the implementation
   * that asked, hence a distinct respond call rather than a shared one.
   */
  claudeSdkSend: (params: { sessionId: string; message: string; model?: string; userMessageId?: string }) =>
    ipcRenderer.invoke("claude-sdk:send", params),
  claudeSdkStop: (sessionId?: string) =>
    ipcRenderer.invoke("claude-sdk:stop", sessionId ? { sessionId } : undefined),
  claudeSdkIsRunning: (sessionId?: string) =>
    ipcRenderer.invoke("claude-sdk:isRunning", sessionId ? { sessionId } : undefined),
  claudeSdkPermissionRespond: (params: { id: string; allow: boolean; sessionId?: string }) =>
    ipcRenderer.invoke("claude-sdk:permission-respond", params),
  /** Parked-prompt count — so a UI or a manual check can prove none leaked. */
  claudeSdkPendingCount: (sessionId?: string) =>
    ipcRenderer.invoke("claude-sdk:pendingCount", sessionId ? { sessionId } : undefined),

  /**
   * ── THE TRANSCRIPT'S TOOL AND PROGRESS CHANNELS ──
   *
   * Emitted by claude-code.ts so the chat can show what the VS Code extension shows: each tool call as
   * a labelled row with its IN/OUT, and a status line carrying elapsed time and a rising token count.
   *
   * Named `cli:*` like their siblings because they are STREAM events, not request channels — the
   * renderer's listeners do not care which implementation produced a turn, and only the spawn path's
   * inability to produce them distinguishes the two.
   */
  onCliToolUse: (
    callback: (data: {
      sessionId: string;
      toolUseId: string | null;
      tool: string;
      description: string | null;
      input: string;
    }) => void
  ) => ipcRenderer.on("cli:tool-use", (_event, data) => callback(data)),
  onCliToolResult: (
    callback: (data: {
      sessionId: string;
      toolUseId: string | null;
      output: string;
      truncated: boolean;
      isError: boolean;
    }) => void
  ) => ipcRenderer.on("cli:tool-result", (_event, data) => callback(data)),
  onCliUsage: (callback: (data: { sessionId: string; outputTokens: number }) => void) =>
    ipcRenderer.on("cli:usage", (_event, data) => callback(data)),

  /**
   * Detach the `cli:*` stream listeners — and ONLY those.
   *
   * WHY THIS HAS TO EXIST. All eight `onCli*` bridges call `ipcRenderer.on`, which
   * APPENDS. AssistantChatView registered them in a `useEffect` with no cleanup, and React
   * StrictMode mounts effects twice in development — so every frame was delivered to two
   * listeners and each line appeared twice in the stream log and the transcript. In
   * production it is once per mount, so any remount still leaks a listener and duplicates
   * from then on.
   *
   * ⚠ DELIBERATELY EXCLUDES every `kiroAcp:*` channel. Those are owned by
   * `removeKiroAcpListeners` below, which KiroChatView already calls correctly on mount
   * and unmount — that is why Kiro's streaming works. Covering them here too would let
   * AssistantChatView tear down listeners KiroChatView still depends on, breaking a working path
   * to fix a broken one. Two components, two channel sets, two removers.
   */
  removeCliListeners: () => {
    for (const channel of [
      "cli:output",
      "cli:error",
      "cli:exited",
      "cli:response-complete",
      "cli:raw",
      "cli:status",
      "cli:trust-required",
      "cli:permission-request",
      "cli:tool-use",
      "cli:tool-result",
      "cli:usage",
    ]) {
      ipcRenderer.removeAllListeners(channel);
    }
  },

  /**
   * ── ⚠ THE EMBEDDED TERMINAL IS GONE, AND IT WAS NEVER REACHABLE ───────────────────────────
   *
   * `ptySpawn` / `ptyWrite` / `ptyResize` / `ptyKill` / `ptyIsActive` / `onPtyData` / `onPtyExit` all
   * lived here, backed by `handlers/pty.ts` and rendered by `TerminalView.tsx`. Every piece worked —
   * and NOTHING MOUNTED THE VIEW. It was shipped-but-unreachable for its whole life, so no participant
   * ever opened it.
   *
   * ⚠ REMOVED RATHER THAN WIRED UP, deliberately. This bridge handed the renderer an interactive shell
   * in the project directory: a channel that can run any command is the widest thing this preload could
   * have exposed, and it was carrying that risk for a feature with no users. The assistant already runs
   * tools (with a permission prompt on the SDK path), which is the reviewed way to execute anything from
   * inside this app.
   *
   * Gone with it: `node-pty` and the three `@xterm/*` packages — including the prebuilt `spawn-helper`
   * chmod dance in `scripts/rebuild-native.sh`, which existed only because the helper shipped mode 644
   * and every spawn failed with `posix_spawnp failed`. That bug was itself only ever found by packaging,
   * never by a user, because there was no way to reach the terminal.
   */

  /**
   * ── THE DEVELOPMENT FRAMEWORK INJECTED INTO THE PROJECT ───────────────────────────────────
   *
   * Whichever one the facilitator configured for the experience — AI-DLC, Spec Kit, OpenSpec, or their
   * own. No framework is named on this bridge or in the renderer.
   *
   * ⚠ EVERY RESULT AND EVERY PROGRESS STEP CARRIES `name`, and the renderer displays what it is given
   * rather than composing a sentence of its own. `handlers/framework.ts` builds the wording; this
   * bridge just carries it. A view that writes its own copy has to know the framework's name, and that
   * is precisely the thing only the experience's config knows.
   */
  frameworkCheck: (params: { projectPath: string; assistant: string }) =>
    ipcRenderer.invoke("framework:check", params) as Promise<{
      installed: boolean;
      skipped?: boolean;
      reason?: string;
      name: string;
    }>,
  frameworkInstall: (params: { projectPath: string; assistant: string }) =>
    ipcRenderer.invoke("framework:install", params) as Promise<{
      success?: boolean;
      message?: string;
      error?: string;
      name: string;
    }>,
  onFrameworkProgress: (callback: (data: { step: string; name?: string }) => void) =>
    ipcRenderer.on("framework:progress", (_event, data) => callback(data)),
  /**
   * ⚠ THE REMOVER THIS CHANNEL NEVER HAD, and its absence was the whole reason the listener
   * accumulated: `performSwitch` and the assistant switch each registered a fresh callback per run with
   * no way to detach, so every progress event fanned out to every handler ever added for the life of
   * the window. The shell now keeps ONE listener, and this is what lets its effect clean up after
   * itself — required for React 18 StrictMode, which mounts effects twice in development.
   */
  removeFrameworkProgressListeners: () => ipcRenderer.removeAllListeners("framework:progress"),

  /**
   * ── PROFILES ──────────────────────────────────────────────────────────────────────────────
   *
   * The only channels available in CHOOSER MODE, where no database is open. They read the filesystem —
   * the profiles directory, each profile's `profile.json` sidecar, and the last-profile pointer.
   *
   * ⚠ `profileOpen` REPLACES this window and `profileOpenWindow` opens a SECOND one. Not interchangeable:
   * the chooser must use the first, because spawning a profile whose lock this process still holds would
   * make the picker appear to do nothing. See profile.ts.
   */
  profileList: () => ipcRenderer.invoke("profile:list"),
  profileCreate: (params: { name: string; newWindow: boolean }) =>
    ipcRenderer.invoke("profile:create", params),
  profileOpen: (id: string) => ipcRenderer.invoke("profile:open", { id }),
  profileOpenWindow: (id: string) => ipcRenderer.invoke("profile:openWindow", { id }),
  /** Label the running profile so the chooser can name it after a person. Display strings only. */
  profileDescribe: (params: { label?: string; team?: string }) =>
    ipcRenderer.invoke("profile:describe", params),
  /** Fired by File → New Profile…, since Electron has no native text-input dialog. */
  onProfilePromptNew: (callback: () => void) =>
    ipcRenderer.on("profile:promptNew", () => callback()),

  // Kiro ACP (structured protocol for rich chat rendering)
  kiroAcpStart: (params: { projectPath: string; sessionId: string }) =>
    ipcRenderer.invoke("kiroAcp:start", params),
  kiroAcpSend: (params: { sessionId: string; message: string; model?: string; projectPath?: string }) =>
    ipcRenderer.invoke("kiroAcp:send", params),
  kiroAcpCancel: (sessionId?: string) => ipcRenderer.invoke("kiroAcp:cancel", sessionId ? { sessionId } : undefined),
  kiroAcpStop: (sessionId?: string) => ipcRenderer.invoke("kiroAcp:stop", sessionId ? { sessionId } : undefined),
  kiroAcpIsRunning: (sessionId?: string) => ipcRenderer.invoke("kiroAcp:isRunning", sessionId ? { sessionId } : undefined),
  kiroAcpNewSession: (params: { sessionId: string; cwd?: string }) => ipcRenderer.invoke("kiroAcp:newSession", params),
  onKiroAcpMessageChunk: (callback: (data: { sessionId: string; content: string }) => void) =>
    ipcRenderer.on("kiroAcp:messageChunk", (_event, data) => callback(data)),
  onKiroAcpToolCall: (callback: (data: { sessionId: string; id: string; name: string; status: string; parameters?: Record<string, unknown>; output?: string }) => void) =>
    ipcRenderer.on("kiroAcp:toolCall", (_event, data) => callback(data)),
  onKiroAcpToolCallUpdate: (callback: (data: { sessionId: string; id: string; name: string; status: string; output?: string }) => void) =>
    ipcRenderer.on("kiroAcp:toolCallUpdate", (_event, data) => callback(data)),
  onKiroAcpTurnEnd: (callback: (data: { sessionId: string }) => void) =>
    ipcRenderer.on("kiroAcp:turnEnd", (_event, data) => callback(data)),
  onKiroAcpExited: (callback: (data: { code: number | null; sessionId?: string }) => void) =>
    ipcRenderer.on("kiroAcp:exited", (_event, data) => callback(data)),
  onKiroAcpError: (callback: (data: { error: string; sessionId?: string }) => void) =>
    ipcRenderer.on("kiroAcp:error", (_event, data) => callback(data)),
  onKiroAcpNotification: (callback: (data: { sessionId: string; method: string; params: unknown }) => void) =>
    ipcRenderer.on("kiroAcp:notification", (_event, data) => callback(data)),
  /**
   * The agent is asking whether it may act — a shell command, an AWS call, an MCP tool.
   *
   * ⚠ THE TURN IS PARKED UNTIL THIS IS ANSWERED. kiro-cli's `session/prompt` does not resolve while
   * a permission request is outstanding (measured, 2.18.1), so a view that listens for this MUST
   * respond, or the chat appears to hang. Main denies after a timeout as a backstop; that is a
   * safety net, not the design.
   */
  onKiroAcpPermissionRequest: (
    callback: (data: { sessionId: string; id: string; toolCallId: string; description: string }) => void
  ) => ipcRenderer.on("kiroAcp:permissionRequest", (_event, data) => callback(data)),
  kiroAcpPermissionRespond: (params: {
    sessionId: string;
    id: string;
    allow: boolean;
    /** Approve every further shell command in THIS chat. Dropped when the session stops. */
    remember?: boolean;
  }) =>
    ipcRenderer.invoke("kiroAcp:permissionRespond", params),
  removeKiroAcpListeners: () => {
    ipcRenderer.removeAllListeners("kiroAcp:messageChunk");
    ipcRenderer.removeAllListeners("kiroAcp:toolCall");
    ipcRenderer.removeAllListeners("kiroAcp:toolCallUpdate");
    ipcRenderer.removeAllListeners("kiroAcp:turnEnd");
    ipcRenderer.removeAllListeners("kiroAcp:exited");
    ipcRenderer.removeAllListeners("kiroAcp:error");
    ipcRenderer.removeAllListeners("kiroAcp:notification");
    // Removed with the rest, or a remount would deliver one prompt to two listeners and the second
    // answer would come back `unknown` — the duplicate-frame bug `removeCliListeners` documents.
    ipcRenderer.removeAllListeners("kiroAcp:permissionRequest");
  },

  // Database
  getProjects: () => ipcRenderer.invoke("db:getProjects"),
  /**
   * ⚠ NO SCOPING FIELDS CROSS THIS BRIDGE. `workshopId`/`teamId` used to be forwarded and were
   * PREFERRED over main's own settings, so a caller could tag a filesystem-boundary grant with an
   * experience it does not belong to — invisible to `getProjects`, and therefore unrevokable from
   * the UI. Main reads both from settings; see the INSERT in handlers/db.ts.
   */
  addProject: (project: { id: string; name: string; path: string }) =>
    ipcRenderer.invoke("db:addProject", project),
  removeProject: (id: string) => ipcRenderer.invoke("db:removeProject", id),
  getSessions: (projectId: string) => ipcRenderer.invoke("db:getSessions", projectId),
  createSession: (session: { id: string; projectId: string; title?: string; aiProvider?: string; model?: string }) =>
    ipcRenderer.invoke("db:createSession", session),
  deleteSession: (id: string) => ipcRenderer.invoke("db:deleteSession", id),
  setSessionShared: (id: string, sharedAt: string | null) =>
    ipcRenderer.invoke("db:setSessionShared", id, sharedAt),
  getMessages: (sessionId: string) => ipcRenderer.invoke("db:getMessages", sessionId),
  /** Re-push one message's turn to the server. Safe to call repeatedly — see retryMessageSync. */
  retryMessageSync: (messageId: string) =>
    ipcRenderer.invoke("sync:retryMessage", messageId) as Promise<{
      retried: boolean;
      status?: "pending" | "synced" | "failed";
    }>,
  addMessage: (message: { id: string; sessionId: string; role: string; content: string }) =>
    ipcRenderer.invoke("db:addMessage", message),
  // Settings are ALLOWLISTED in main (src/main/setting-access.ts). Credentials —
  // auth_token, cognito_refresh_token, user_password — are not readable here at
  // all: a blocked read resolves to null, indistinguishable from "not set". A
  // blocked write is a no-op. Clearing a credential (value "") is permitted, which
  // is what sign-out does. Adding a key to either allowlist is a security change.
  getSetting: (key: string) => ipcRenderer.invoke("db:getSetting", key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke("db:setSetting", key, value),

  // Telemetry (opt-in, local-only error log)
  reportError: (payload: { source: string; message: string; stack?: string; extra?: Record<string, unknown> }) =>
    ipcRenderer.invoke("telemetry:report", payload),
  telemetryIsEnabled: () => ipcRenderer.invoke("telemetry:isEnabled"),
  telemetryOpenLog: () => ipcRenderer.invoke("telemetry:openLog"),

  /**
   * ── LIGHT, DARK, OR FOLLOW THE MACHINE ────────────────────────────────────────────────────
   *
   * ⚠ NOT ROUTED THROUGH `getSetting` / `setSetting`, deliberately. `theme_mode` reaches
   * `nativeTheme.themeSource`, which THROWS on an unrecognised string — so the value is validated in main
   * before it is stored or applied, and the generic settings bridge does no validation. These channels
   * also return the RESOLVED theme, which a settings read could not: only main knows what the OS
   * currently prefers.
   *
   * `themeGet` answers with both — the chosen mode (to tick the control) and what it resolves to right
   * now (to paint the app). `onThemeChanged` fires when the participant switches, and when the OS flips
   * while the mode is Auto.
   */
  themeGet: () =>
    ipcRenderer.invoke("theme:get") as Promise<{ mode: "light" | "dark" | "system"; resolved: "light" | "dark" }>,
  themeSet: (mode: "light" | "dark" | "system") =>
    ipcRenderer.invoke("theme:set", { mode }) as Promise<{
      mode: "light" | "dark" | "system";
      resolved: "light" | "dark";
    }>,
  onThemeChanged: (
    cb: (data: { mode: "light" | "dark" | "system"; resolved: "light" | "dark" }) => void
  ) => ipcRenderer.on("theme:changed", (_e, d) => cb(d)),
  removeThemeListeners: () => ipcRenderer.removeAllListeners("theme:changed"),

  /** The app's own version, from package.json via Electron. Shown in Settings. */
  getAppVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<{ version: string }>,
});
