// Renderer setting-access policy (a governing security condition).
//
// `db:getSetting` / `db:setSetting` are reachable from ANY code running in the
// renderer bundle — including a malicious transitive dependency pulled into the
// Vite build — and `readSetting` transparently DECRYPTS the sensitive keys
// (database.ts:17, :39). Without an allowlist,
// `electronAPI.getSetting("cognito_refresh_token")` hands a live 30-day Cognito
// refresh token to the renderer in plaintext: safeStorage protects the value on
// disk and then gives it away over IPC on request.
//
// So the bridge is DENY BY DEFAULT. A key is readable or writable from the
// renderer only because it is named below, and adding one is a deliberate act.
// The sensitive keys are absent from both lists and the module-load invariant at
// the bottom of this file keeps them that way.
//
// A blocked READ returns null rather than throwing, so a compromised or buggy
// caller cannot tell "forbidden" from "absent". A blocked WRITE is a logged
// no-op. Key names are logged (they are not secrets); values never are.

import { isSensitiveSetting } from "./database";
import { ALLOWLIST_SOURCE_SETTINGS } from "./project-paths";
import { EXECUTABLE_SOURCE_SETTINGS } from "./assistant-command";

/**
 * Keys the renderer may read. Every entry corresponds to a real call site in
 * `src/renderer`; none of them is a credential.
 */
export const RENDERER_READABLE_SETTINGS: ReadonlySet<string> = new Set([
  /**
   * Whether the agent may write files without asking (`fs_write` previously had no opt-out).
   *
   * ⚠ READABLE BUT NOT WRITABLE, and the asymmetry is the control. Settings has to show the current
   * state, but writing `true` re-grants a permission the participant explicitly withdrew — so it moves
   * only through `agentTrust:setFileWrites`. Adding it to the write list below would undo the finding's
   * fix; `telemetry_enabled` is the cautionary example of a security-relevant key that IS writable.
   */
  "agent_trust_fs_write",
  // Connection / gating flags that drive which screen App.tsx renders.
  "connected",
  "team_joined",
  "setup_complete",
  "server_url",
  /**
   * The configured platform, for DISPLAY on the setup screen and in Account.
   *
   * ⚠ READABLE BUT NOT WRITABLE — see the write list below. These are public discovery
   * values (the portal serves the Cognito ones unauthenticated), so reading them costs
   * nothing; WRITING one changes which identity provider the app trusts and voids the
   * session, which is `platform:setPortalUrl`'s job, not a settings write's.
   */
  "cognito_pool_id",
  "cognito_issuer",
  "cognito_client_id",
  "cognito_authorization_endpoint",
  "cognito_token_endpoint",
  "cognito_scopes",
  // Team + workshop identity, shown in the UI and used for display only — the
  // main process reads its own copy when it builds a backend request.
  "team_id",
  "team_name",
  "team_invite_code",
  "workshop_id",
  // Display identity (Sidebar, ConnectionStatus, Settings, chat "is this me?").
  "user_id",
  "user_name",
  "user_email",
  // Local preferences.
  "ai_assistant",
  "ai_command",
  "project_path",
  "notify_sound",
  /**
   * How many minutes of TOTAL SILENCE from an assistant before the turn is treated as stalled.
   *
   * ⚠ A NUMBER, NOT A NAME — which is why this belongs here while `ai_command` above is the key this
   * file exists to keep OUT of the writable list. Nothing is executed, resolved or authenticated from
   * it; main clamps it to a bounded range before use, so the worst a renderer can do is choose a
   * different point inside that range.
   *
   * ⚠ AND IT CANNOT TURN THE WATCHDOG OFF. The clamp has a floor as well as a ceiling, so there is no
   * value meaning "wait forever" — see STALL_TIMEOUT floor/ceiling in cli-assistant.ts. A setting that
   * could disable a timeout would be a safety mechanism with a user-facing off switch, which is
   * exactly what the standing rule forbids.
   */
  "cli_stall_timeout_minutes",
  "telemetry_enabled",
  "chat_history_visible",
  /**
   * Layout state, remembered across launches for the same reason `chat_history_visible` is: a panel the
   * user collapsed should stay collapsed, and a view they pinned beside their work should still be there
   * next time. Both are pure presentation — no identity, no platform, nothing a compromised renderer
   * gains anything by writing.
   */
  "sidebar_collapsed",
  "pinned_view",
  "active_session_id",
]);

/**
 * Keys the renderer may write with an arbitrary value. Deliberately narrower
 * than the readable set: the renderer displays identity, it does not own it.
 */
/**
 * The keys that name the tenant this client acts as.
 *
 * ⚠ NAMED AS A SET RATHER THAN LEFT IMPLICIT, so the boot invariant at the bottom of this file can
 * refuse to start if a future edit makes one of them writable again — the same treatment
 * `project_path` and `ai_command` get, and for a reason of the same kind.
 */
export const TENANT_SETTINGS: ReadonlySet<string> = new Set([
  "team_id",
  "team_name",
  "team_invite_code",
  "workshop_id",
]);

export const RENDERER_WRITABLE_SETTINGS: ReadonlySet<string> = new Set([
  /**
   * ⚠ NO PLATFORM KEYS HERE. `cognito_pool_id`, `server_url`, the other `cognito_*` keys
   * and `platform_config_fingerprint` are all deliberately absent.
   *
   * Writing any of them changes which Cognito pool the app authenticates against, and
   * changing it VOIDS THE SESSION. If the renderer could set `cognito_pool_id` or
   * `cognito_authorization_endpoint` directly it would move the login destination
   * without AWS discovery having vouched for it, without the teardown, and without the
   * fingerprint that describes it — leaving a pool and a fingerprint naming different
   * platforms, which is the exact state the drift check reads to decide whether to sign
   * someone out.
   *
   * `platform:connect` does all four together. That is why it is a handler and not a
   * setting.
   */
  // Screen gating, written by SetupView / JoinTeamView / SelectAssistantView.
  "connected",
  "team_joined",
  "setup_complete",
  /**
   * ⚠ THE TENANT KEYS ARE DELIBERATELY ABSENT — `team_id`, `team_name`, `team_invite_code` and
   * `workshop_id` — and must stay absent. Third instance of the same shape as `project_path` and
   * `ai_command` above, one class of consequence out.
   *
   * The tenants in this system are workshops/teams sharing one platform API, and the desktop's whole notion
   * of "which tenant am I acting as" was these two rows. `teamContext()` (handlers/team-data.ts) reads
   * `team_id` and every team-scoped handler interpolates it into the request path; the same value drives
   * `share:shareSession`, `share:unshareSession`, `share:getSharedThreads` and the WebSocket event
   * subscription, and `workshop_id` drives the phase and framework-config requests.
   *
   * While these were writable, `electronAPI.setSetting("team_id", "<other team>")` from any code in
   * the renderer bundle silently re-pointed every tenant-scoped request — INCLUDING WRITES — and
   * overwrote the value `ai:joinTeam` had established only after a server-verified join. The concrete
   * local consequence: `share:shareSession` publishes a private local transcript under whatever
   * `team_id` was last written, and the event stream subscribes to that team's events.
   *
   * ⚠ THE SERVER STILL AUTHORISES EVERY REQUEST against the bearer, so a forged id only yields
   * cross-tenant data where the server fails to check membership — and that code is not in this
   * repository. That is the honest bound, and it is not a reason to leave it: what is verifiable here
   * is that the client contributed no isolation control of its own for the key that names the tenant.
   *
   * `ai:joinTeam` and `ai:selectTeam` write them instead, both AFTER the server has confirmed the
   * membership. The invariant at the bottom of this file makes re-adding them a boot failure.
   */
  /**
   * ⚠ `project_path` IS DELIBERATELY ABSENT, and must stay absent.
   *
   * It is not a preference — `allowedRoots()` (project-paths.ts) builds the filesystem
   * confinement boundary from it. While it was writable here, the renderer chose the fence
   * that was supposed to contain it: one `setSetting("project_path", "/Users/<you>")` made
   * `~/.ssh/id_rsa`, `~/.aws/credentials` and `~/Library/LaunchAgents` "inside the project"
   * for every file, git and spawn handler in the app.
   *
   * `files:commitProjectPath` writes it instead, and only for a path a native dialog just
   * returned. The invariant at the bottom of this file makes re-adding it here a boot
   * failure rather than a silent regression.
   */
  /**
   * ⚠ `ai_command` IS DELIBERATELY ABSENT, and must stay absent — for the same shape of reason as
   * `project_path` above, one step worse in consequence.
   *
   * It is the name the app SPAWNS. `buildCliArgs`'s default case returns `{ cmd: command }`
   * verbatim, so while this was writable, `setSetting("ai_command", "/tmp/payload")` followed by any
   * chat message was arbitrary local code execution through two ordinary IPC calls.
   *
   * `cli:setAssistant` writes it instead, from an assistant ID mapped through
   * `COMMAND_FOR_ASSISTANT` in main — the renderer names an assistant and never supplies an
   * executable. `ai_assistant` comes off the list with it: that handler writes both together, and
   * leaving one writable would let the renderer desync the badge from the process behind it.
   *
   * The invariant at the bottom of this file makes re-adding it a boot failure.
   */
  // Local preferences and UI state.
  "notify_sound",
  /* Minutes of assistant silence before a turn is stalled. Clamped in main; see the readable list. */
  "cli_stall_timeout_minutes",
  "telemetry_enabled",
  "chat_history_visible",
  /**
   * Layout state, remembered across launches for the same reason `chat_history_visible` is: a panel the
   * user collapsed should stay collapsed, and a view they pinned beside their work should still be there
   * next time. Both are pure presentation — no identity, no platform, nothing a compromised renderer
   * gains anything by writing.
   */
  "sidebar_collapsed",
  "pinned_view",
  "active_session_id",
]);

/**
 * Session keys wiped on sign-out. This list is the reason the policy above can be
 * absolute rather than carving out a "clearing is allowed" exception: sign-out
 * used to be thirteen `setSetting(key, "")` calls FROM THE RENDERER, three of
 * them on credential keys, so any allowlist had to leave the renderer some write
 * access to `auth_token`. It does not any more — `auth:signOut` in
 * handlers/ai.ts owns the wipe, so the renderer needs no access to these keys in
 * either direction.
 *
 * ⚠ SIGN-OUT KEEPS THE `accounts` ROW AND DESTROYS ITS CREDENTIAL. Those are two different things
 * and the row is the harmless half: it carries the email, the display name and the last team, so the
 * switcher still shows who the account was. The bearer and the 30-day refresh token are cleared, and
 * revoked at Cognito — THE RULE: sign-out logs the user out and clears the login session; signing in
 * again requires the username and password.
 *
 * It used to keep the credential too, so switching back needed no password. That trade is decided
 * now rather than inherited; `signOutAccount` in accounts.ts is the
 * decision, and `auth:removeAccount` is still what forgets the account entirely.
 *
 * ⚠ THE PLATFORM CONFIG IS ALSO ABSENT, and must stay absent. `portal_url`,
 * `server_url`, the `cognito_*` keys and `platform_config_fingerprint` describe WHICH
 * PLATFORM this install belongs to, not who is signed in. Wiping them on sign-out
 * would drop the user back to the "connect to your platform" screen every time they
 * signed out and make them re-paste the connect string to sign back in — and it would erase the
 * fingerprint the drift check compares against, so a genuine platform change after a
 * sign-out would go undetected.
 */
export const SIGN_OUT_SETTINGS: readonly string[] = [
  "connected",
  "team_joined",
  "setup_complete",
  "auth_token",
  "team_id",
  "team_name",
  "team_invite_code",
  /**
   * ⚠ `workshop_id` IS A TENANT KEY, NOT A PLATFORM KEY, and it was the one tenant key this list
   * missed. Its three siblings — `team_id`, `team_name`, `team_invite_code` — are cleared right above
   * it, and RENDERER_WRITABLE_SETTINGS names all four together as "THE TENANT KEYS", so the omission
   * was inconsistency rather than a decision.
   *
   * The `…-jarvisdeploy` profile sat signed out with `team_id`, `user_email`, `connected` and
   * `active_user_id` all correctly empty, and `workshop_id = 01M0XEG0…` still standing — a profile claiming a
   * workshop it had no session for. It survived because sign-out cleared everything around it.
   *
   * ⚠ IT IS NOT THE PLATFORM CONFIG, which the note above is careful to keep. `server_url`, `portal_url`
   * and the `cognito_*` keys say WHICH DEPLOYMENT this install belongs to and must outlive a sign-out or
   * the user re-pastes a connect string every time. A workshop is who you were working WITH, which is
   * exactly what signing out ends.
   *
   * ⚠ AND IT IS RE-ESTABLISHED ON THE WAY BACK IN. `writeTeamContext` (handlers/ai.ts) writes
   * `workshop_id` in the same breath as `team_id` on every team join, so clearing it costs nothing at
   * the next sign-in and stops `activeExperience()` scoping local reads by a workshop the session no
   * longer belongs to.
   */
  "workshop_id",
  "user_email",
  "user_password",
  "cognito_refresh_token",
  "user_id",
  "user_name",
  "active_user_id",
];

/** True if the renderer is allowed to read `key`. */
export function canRendererRead(key: string): boolean {
  return RENDERER_READABLE_SETTINGS.has(key);
}

/**
 * True if the renderer is allowed to write `key`.
 *
 * The policy is key-based with no empty-value exception: with `auth:signOut`
 * owning the credential wipe, "the renderer may never write a credential key"
 * needs no qualifier, and an unqualified rule is the one that survives future
 * edits. It also denies a compromised renderer a free sign-out primitive.
 */
export function canRendererWrite(key: string): boolean {
  return RENDERER_WRITABLE_SETTINGS.has(key);
}

// Fail fast and loudly at startup rather than at the moment of disclosure: if a
// future edit adds a sensitive key to either allowlist, the app refuses to boot
// instead of quietly handing the credential to the renderer. Checked in this
// direction (over the allowlists) so the sensitive set stays private to
// database.ts and there is only one definition of "sensitive".
for (const key of [...RENDERER_READABLE_SETTINGS, ...RENDERER_WRITABLE_SETTINGS]) {
  if (isSensitiveSetting(key)) {
    throw new Error(
      `Setting allowlist misconfigured: "${key}" is a sensitive key (encrypted at rest) ` +
        `and must never be readable or writable from the renderer. Only clearing it is allowed.`
    );
  }
}

// The same fail-fast treatment for the second class of key that must not be writable, for a
// different reason: these ones FEED THE FILESYSTEM CONFINEMENT BOUNDARY. A sensitive key
// leaks a credential; one of these hands over the boundary itself, which is strictly worse —
// it converts every path check in the app into a formality. READ access stays fine and is
// needed (Settings and TeamDocs display the folder), so only the write side is checked.
for (const key of ALLOWLIST_SOURCE_SETTINGS) {
  if (RENDERER_WRITABLE_SETTINGS.has(key)) {
    throw new Error(
      `Setting allowlist misconfigured: "${key}" is what allowedRoots() derives the ` +
        `filesystem boundary from, so a renderer that can write it can point that boundary ` +
        `at ~/.ssh or ~/Library/LaunchAgents. Write it from main after verifying the path ` +
        `came from a native picker (files:commitProjectPath), never from the renderer.`
    );
  }
}

// And the third class: keys naming something the app
// EXECUTES. A sensitive key leaks a credential and a boundary key dissolves the sandbox; this one
// runs attacker-chosen code as the user, so it gets the same boot-time refusal rather than trust in
// whoever edits the list next. READ access is fine and is used (the chat header and the theme both
// branch on which assistant is active), so only the write side is checked.
// And the fourth class: the keys that name WHICH TENANT this client is acting as. A sensitive key
// leaks a credential, a boundary key dissolves the sandbox, an executable key runs code — this one
// re-points every team-scoped request, including the one that PUBLISHES a private transcript. Main
// derives them from a server-verified membership (`ai:joinTeam`, `ai:selectTeam`); READ access stays
// fine and is needed (the sidebar and Settings display the team), so only the write side is checked.
for (const key of TENANT_SETTINGS) {
  if (RENDERER_WRITABLE_SETTINGS.has(key)) {
    throw new Error(
      `Setting allowlist misconfigured: "${key}" names the tenant every team-scoped request is made ` +
        `against, so a renderer that can write it can publish this user's private chats to a team ` +
        `they never selected. Write it from main after the server has confirmed the membership ` +
        `(ai:joinTeam / ai:selectTeam), never from the renderer.`
    );
  }
}

for (const key of EXECUTABLE_SOURCE_SETTINGS) {
  if (RENDERER_WRITABLE_SETTINGS.has(key)) {
    throw new Error(
      `Setting allowlist misconfigured: "${key}" names the executable the app spawns, so a renderer ` +
        `that can write it can run any binary on this machine as the signed-in user. Write it from ` +
        `main via cli:setAssistant, which maps an assistant ID to a fixed command, never from the renderer.`
    );
  }
}
