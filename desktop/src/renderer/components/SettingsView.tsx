import { useState, useEffect } from "react";
import claudeIcon from "../assets/claude.png";
import kiroIcon from "../assets/kiro.png";
import codexIcon from "../assets/codex.png";
import { THEME_LABELS, THEME_HINTS, type ThemeMode } from "../lib/theme";

/**
 * The order the three modes are OFFERED, which is not the order they are defined in.
 *
 * Light, Dark, Auto reads as "least to most automatic" and puts the deferral last, where its extra line of
 * explanation does not sit between the two plain choices.
 */
const THEME_ORDER: readonly ThemeMode[] = ["light", "dark", "system"];

const api = (window as any).electronAPI;

/**
 * ⚠ THIS ARRAY'S ORDER IS BOTH THE DISPLAYED ORDER AND THE FALLBACK PRIORITY. Kiro leads to match
 * SelectAssistantView, so a participant meets the AWS assistant first in both places.
 *
 * ⚠ IT IS NOT ONLY COSMETIC, WHICH IS THE PART WORTH KNOWING BEFORE REORDERING AGAIN. The
 * disabled-assistant recovery below does `ASSISTANTS.find((a) => enabled.includes(a.id))`, and
 * `.find` returns the FIRST match in this array — so whichever entry sits at the top is the
 * assistant a participant is auto-switched to when a facilitator disables the one they were using.
 * Moving Kiro up therefore also changed that fallback from Claude Code to Kiro CLI.
 *
 * That is deliberate and consistent: the code's own comment describes the behaviour as "switch to
 * the first enabled one", so display order and fallback order being the same thing is the intent
 * rather than a coincidence. If they ever need to diverge, give the fallback its own explicit
 * priority list instead of relying on this one, because a future reorder done purely for layout
 * would otherwise silently change which assistant participants are moved onto.
 */
const ASSISTANTS = [
  { id: "kiro", name: "Kiro CLI", command: "kiro-cli", img: kiroIcon },
  { id: "claude", name: "Claude Code", command: "claude", img: claudeIcon },
  { id: "codex", name: "Codex", command: "codex", img: codexIcon },
];

// Sign-out clears the session in the MAIN process (`auth:signOut`), not here.
// The list of keys lives in src/main/setting-access.ts: three of them are
// credential keys the renderer is no longer allowed to write, and main also has
// to drop its own in-memory cached bearer, which this component cannot reach.
// The saved `accounts` row is kept either way.

/**
 * ⚠ NO `onSignOut` PROP ANY MORE. Sign-out moved to Account, so this
 * component no longer ends sessions and does not need to tell App.tsx that one ended.
 */
export function SettingsView({
  onAssistantChanged,
  onProjectFilesChanged,
  onFrameworkSetupChange,
}: {
  /**
   * The switch is done. `setupFailure` is a ready-to-show sentence when the framework install failed —
   * composed HERE because this is where the framework's name is known, and reported by the shell because
   * the shell navigates away from this screen the moment it is called, taking the inline status with it.
   */
  onAssistantChanged?: (result?: { setupFailure?: string }) => void;
  /**
   * ── ⚠ SWITCHING ASSISTANT WRITES INTO THE OPEN FOLDER ─────────────────────────────────────────
   *
   * The framework ships DIFFERENT FILES PER ASSISTANT, so this screen re-runs the install — and that
   * copies a tree into the project the file panel is already showing. `onAssistantChanged` does not
   * cover it: it leads to `checkState()`, which re-reads settings and reloads the projects row, but the
   * project's PATH is unchanged — so the tree, keyed on `rootPath`, has no reason to re-read and keeps
   * showing the folder as it was before the install.
   */
  onProjectFilesChanged?: () => void;
  /**
   * Raise (name) and clear (null) the shell's blocking overlay around the framework install.
   *
   * ⚠ THE SAME OVERLAY THE FOLDER SWITCH USES, not a second one local to this screen: the hazard is
   * identical — this install runs an assistant turn in the open folder — and the overlay has to cover the
   * WHOLE app, which a component rendered inside one view cannot do.
   */
  onFrameworkSetupChange?: (name: string | null) => void;
}) {
  /** The app's own version, for the About row. Null until the IPC answers; never guessed. */
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getAppVersion?.()
      .then((r: { version?: string }) => {
        if (alive && r?.version) setAppVersion(r.version);
      })
      // Swallowed deliberately: a missing version is a blank row, not an error banner on a
      // settings page the user opened to do something else.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const [currentAssistant, setCurrentAssistant] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchStatus, setSwitchStatus] = useState("");
  const [enabledAssistants, setEnabledAssistants] = useState<string[]>(
    ASSISTANTS.map((a) => a.id)
  );
  const [disabledNotice, setDisabledNotice] = useState("");
  /**
   * The chosen mode, and what it currently resolves to.
   *
   * ⚠ TWO PIECES OF STATE FOR ONE SETTING, and both are needed. `themeMode` is what the participant picked
   * (so the right radio is ticked); `resolvedTheme` is what that means right now, which only main knows
   * because only main can see the OS preference. Deriving the second from the first is impossible for Auto.
   */
  const [themeMode, setThemeMode] = useState<ThemeMode | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark" | null>(null);
  const [notifySound, setNotifySound] = useState(true);
  /**
   * Minutes of assistant SILENCE before a turn is treated as stalled. Held as a string so the field
   * can be mid-edit ("" or "1") without snapping under the user's cursor; clamped on commit.
   */
  const [stallMinutes, setStallMinutes] = useState("6");
  const [stallSaved, setStallSaved] = useState(false);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  /**
   * Whether the open folder is trusted for Claude Code's tool approvals.
   *
   * ⚠ `null` IS "NOT ASKED YET", NOT "NO". The row must not render "Not trusted" while the answer is
   * still in flight — this is the one place a participant comes to check whether a permission is in
   * force, and a momentary wrong answer here is worse than a momentary blank.
   */
  const [workspaceTrusted, setWorkspaceTrusted] = useState<boolean | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustNote, setTrustNote] = useState<string | null>(null);
  /**
   * Whether the agent may write files without asking. `null` until main answers, for the same reason
   * `workspaceTrusted` is: a toggle that renders "off" while the answer is in flight tells the
   * participant their permission is withdrawn when it is not.
   */
  const [agentFileWrites, setAgentFileWrites] = useState<boolean | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const assistant = await api.getSetting("ai_assistant");
    if (assistant) setCurrentAssistant(assistant);
    const path = await api.getSetting("project_path");
    if (path) setProjectPath(path);
    /**
     * Read from Claude Code's OWN file, so the row reports what the CLI will actually honour rather than
     * what this app remembers doing. Tolerant of an older main process: an absent channel leaves the row
     * hidden instead of failing the page.
     */
    if (path) {
      try {
        const t = await api.cliIsWorkspaceTrusted?.(path);
        if (t) setWorkspaceTrusted(t.trusted === true);
      } catch {
        /* Leave it unknown; the section does not render. */
      }
    }
    /* Read through its own channel, not `getSetting`: main owns the write — see agent-trust-setting.ts. */
    try {
      const a = await api.agentTrustGet?.();
      if (a) setAgentFileWrites(a.fileWrites === true);
    } catch {
      /* Older main process: the row does not render. */
    }
    const stall = await api.getSetting("cli_stall_timeout_minutes");
    if (stall != null && String(stall).trim() !== "") setStallMinutes(String(stall));
    const sound = await api.getSetting("notify_sound");
    setNotifySound(sound !== "false"); // default on
    const telemetry = await api.getSetting("telemetry_enabled");
    setTelemetryEnabled(telemetry === "true"); // default off (opt-in)

    /* Read through the dedicated channel, not `getSetting`: it is main that validates the stored value and
       main that knows what Auto resolves to. See the bridge's note in preload/index.ts. */
    try {
      const t = await api.themeGet();
      if (t?.mode) setThemeMode(t.mode);
      if (t?.resolved) setResolvedTheme(t.resolved);
    } catch {
      /* An older main process: the section renders with nothing ticked rather than the page failing. */
    }

    // Enforce the facilitator's enabled-assistant list.
    const res = await api.getEnabledAssistants();
    const enabled: string[] = res?.enabledAssistants?.length
      ? res.enabledAssistants
      : ASSISTANTS.map((a) => a.id);
    setEnabledAssistants(enabled);

    // If the currently-selected assistant was disabled, auto-switch to the
    // first enabled one and let the user know.
    if (assistant && !enabled.includes(assistant)) {
      const fallback = ASSISTANTS.find((a) => enabled.includes(a.id));
      if (fallback) {
        const disabledName = ASSISTANTS.find((a) => a.id === assistant)?.name || assistant;
        setDisabledNotice(
          `${disabledName} was disabled by your facilitator — switched to ${fallback.name}.`
        );
        handleSwitchAssistant(fallback.id);
      }
    }
  }

  const availableAssistants = ASSISTANTS.filter((a) => enabledAssistants.includes(a.id));

  /**
   * Persist the chosen mode.
   *
   * ⚠ THE ATTRIBUTE IS NOT SET HERE. Main broadcasts `theme:changed` and the listener registered in
   * `main.tsx` applies it to `<html>` — so a SECOND window in the same profile re-colours too, and there
   * is exactly one place that touches the document. Painting it here as well would be a second authority
   * that could disagree with the first.
   *
   * The response updates this view's own controls immediately rather than waiting for the broadcast, so
   * the tick does not lag the click.
   */
  async function chooseTheme(mode: ThemeMode) {
    if (mode === themeMode) return;
    const next = await api.themeSet(mode);
    if (next?.mode) setThemeMode(next.mode);
    if (next?.resolved) setResolvedTheme(next.resolved);
  }

  /**
   * Follow the OS while this view is open and the mode is Auto — otherwise the "your machine is currently
   * set to dark" line below would go stale the moment the machine changed, on the one screen showing it.
   */
  useEffect(() => {
    api.onThemeChanged?.((d: { mode: ThemeMode; resolved: "light" | "dark" }) => {
      setThemeMode(d.mode);
      setResolvedTheme(d.resolved);
    });
    /* ⚠ NOT `removeThemeListeners()` on unmount: that channel also feeds the document-level applier in
       main.tsx, and tearing it down here would stop the whole app following the OS. This view attaches an
       ADDITIONAL listener and leaves the shared one alone — the same reasoning that keeps
       `removeCliListeners` away from the `kiroAcp:*` channels. */
  }, []);

  async function toggleNotifySound() {
    const next = !notifySound;
    setNotifySound(next);
    await api.setSetting("notify_sound", next ? "true" : "false");
  }

  /** The bounds main clamps to. Mirrored here so the field can SHOW them, not to enforce them. */
  const STALL_MIN = 2;
  const STALL_MAX = 60;

  /**
   * Commit the stall budget on blur rather than on every keystroke.
   *
   * ⚠ CLAMPED HERE FOR HONESTY, NOT FOR SAFETY. Main clamps the value again before it is used
   * (`stallTimeoutMs`), because `settings` is a plaintext table and this renderer is not the only
   * thing that can write it. Clamping in the field as well means the number the participant is LEFT
   * LOOKING AT is the number that will actually apply — typing 0 and being silently given 2 without
   * the field changing would be a UI that lies about the state of the system.
   */
  async function commitStallMinutes() {
    const parsed = Number.parseFloat(stallMinutes);
    const next = Number.isFinite(parsed)
      ? Math.min(STALL_MAX, Math.max(STALL_MIN, Math.round(parsed)))
      : 6;
    setStallMinutes(String(next));
    await api.setSetting("cli_stall_timeout_minutes", String(next));
    setStallSaved(true);
    setTimeout(() => setStallSaved(false), 2000);
  }

  async function toggleTelemetry() {
    const next = !telemetryEnabled;
    setTelemetryEnabled(next);
    await api.setSetting("telemetry_enabled", next ? "true" : "false");
  }

  async function handleSwitchAssistant(assistantId: string) {
    if (assistantId === currentAssistant || switching) return;

    const assistant = ASSISTANTS.find((a) => a.id === assistantId);
    if (!assistant) return;

    setSwitching(true);
    setSwitchStatus("Switching assistant...");
    let setupFailure: string | undefined;

    try {
      // Main maps the ID to the command and writes both settings — `ai_command` is the executable
      // this app spawns, so it is not renderer-writable. See src/main/assistant-command.ts.
      const chosen = await api.cliSetAssistant(assistantId);
      if (chosen?.error) {
        setSwitchStatus(`Could not switch: ${chosen.error}`);
        setSwitching(false);
        return;
      }

      // The experience's development framework may ship different files per assistant, so a switch
      // re-checks it. `check.name` names whichever framework the facilitator configured.
      if (projectPath) {
        setSwitchStatus("Checking framework setup...");
        const check = await api.frameworkCheck({ projectPath, assistant: assistantId });
        if (!check.installed && !check.skipped) {
          setSwitchStatus(`Installing ${check.name}...`);
          /**
           * ⚠ THE PROGRESS LISTENER IS GONE FROM HERE. It was registered on every switch against a channel
           * the preload gives no way to unsubscribe from, so the callbacks accumulated for the life of the
           * window. The shell keeps one listener for both install paths and shows the live step in the
           * overlay raised below — which is the surface that is actually in front of the participant now.
           */
          onFrameworkSetupChange?.(check.name);
          try {
            const result = await api.frameworkInstall({ projectPath, assistant: assistantId });
            if (result.error) {
              /**
               * This used to `return`, which left the app disagreeing with itself: `cliSetAssistant` had
               * ALREADY written `ai_assistant` and `ai_command`, so main was running the new assistant while
               * this screen still showed the old one as current and `onAssistantChanged` never fired. The
               * same call was made for the folder switch, for the same reason — a failed install is not a
               * reason to hide a switch that happened.
               */
              setSwitchStatus(`Setup failed: ${result.error}`);
              setupFailure = `${check.name} setup failed: ${result.error}`;
            }
          } finally {
            /**
             * ⚠ IN `finally`, SO A FAILED INSTALL REFRESHES TOO. The distribution is copied in BEFORE
             * the step that can fail (the agent), so a failure leaves real files — `.codex` among them —
             * that the tree has never listed.
             *
             * ⚠ AND THE OVERLAY COMES DOWN HERE FOR THE SAME REASON IT DOES IN `performSwitch`: it has no
             * dismiss control of its own, so this is the only thing that removes it. It must survive a
             * rejected invoke, not merely a returned `{ error }`.
             */
            onFrameworkSetupChange?.(null);
            onProjectFilesChanged?.();
          }
        }
      }

      setCurrentAssistant(assistantId);
      setSwitchStatus("Done!");
      setTimeout(() => setSwitchStatus(""), 2000);
      onAssistantChanged?.({ setupFailure });
    } catch (err) {
      setSwitchStatus(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setSwitching(false);
    }
  }

  return (
    // `max-w-2xl mx-auto` moves to an inner wrapper so the dark fill spans the full width while the prose
    // stays at a readable measure. The theme changed; the measure did not.
    <div className="flex-1 overflow-y-auto bg-surface-bg p-8">
      <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-surface-text">Settings</h1>

      {/* AI Assistant Selection */}
      <section className="mb-8">
        <h2 className="mb-2 font-semibold text-surface-text">AI Coding Assistant</h2>
        <p className="mb-3 text-sm text-surface-muted">
          Choose which CLI assistant to use for chat. Changing this will re-check your experience&apos;s
          development framework for the new assistant.
        </p>
        {disabledNotice && (
          <div className="mb-3 rounded-md border border-surface-line bg-surface-panel px-3 py-2 text-xs text-tool-warning">
            {disabledNotice}
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          {availableAssistants.map((a) => (
            <button
              key={a.id}
              onClick={() => handleSwitchAssistant(a.id)}
              disabled={switching}
              // The SELECTED assistant is marked by the brand border AND a lifted fill, not by colour alone —
              // `brand-accent` is 8.14:1 on the panel, far clear of the 3:1 non-text floor, and the fill is
              // the redundant cue for anyone who does not register the hue.
              className={`rounded-lg border-2 p-3 text-center transition-all ${
                currentAssistant === a.id
                  ? "border-brand-accent bg-surface-raised"
                  : "border-surface-line hover:border-surface-muted"
              } ${switching ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <img src={a.img} alt={a.name} className="mx-auto h-8 w-8 rounded-full" />
              <div className="mt-1 text-sm font-medium text-surface-text">{a.name}</div>
            </button>
          ))}
        </div>
        {switchStatus && (
          <div className="mt-3 flex items-center gap-2">
            {switching && (
              <svg className="h-3 w-3 animate-spin text-brand-accent" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            <span className="text-xs text-surface-muted">{switchStatus}</span>
          </div>
        )}
      </section>

      {/* ── ⚠ NO "WORKSHOP" SECTION AND NO TEAM CODE HERE ──
          Both were removed deliberately: the team code is already shown in
          Account, and two copies of one identifier is two places to look and one to forget.
          Account is the right home — it is the page about WHO you are and WHICH experience you
          are in, whereas Settings is about how this app behaves. */}

      {/* ── APPEARANCE ────────────────────────────────────────────────────────────────
          ⚠ A THREE-WAY CHOICE, NOT A TOGGLE. Auto is not "the other one" — it is a deferral to the OS,
          and it has to be selectable alongside the two explicit modes. A switch could only express two
          of the three, which is why this is a radio group.

          ⚠ AND IT IS A REAL RADIO GROUP (`role="radiogroup"` + `role="radio"` + `aria-checked`), not
          three buttons that look like one. The relationship "exactly one of these three" is what a
          screen reader needs, and three independent buttons do not carry it.
      */}
      <section className="mb-8">
        <h2 className="mb-2 font-semibold text-surface-text">Appearance</h2>
        <p className="mb-3 text-sm text-surface-muted">
          Choose how the app looks. Auto follows your computer&apos;s setting and changes with it.
        </p>
        <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-3">
          {THEME_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={themeMode === m}
              onClick={() => void chooseTheme(m)}
              /* Selected by border AND a lifted fill, never hue alone — the same rule the assistant
                 picker above follows, and `brand-accent` is 8.14:1 on this panel in dark and 6.09:1 in
                 light, so the border is perceivable in both modes. */
              className={`rounded-lg border-2 p-3 text-left transition-all ${
                themeMode === m
                  ? "border-brand-accent bg-surface-raised"
                  : "border-surface-line hover:border-surface-muted"
              }`}
            >
              <div className="text-sm font-medium text-surface-text">{THEME_LABELS[m]}</div>
              <div className="mt-0.5 text-[11px] text-surface-muted">{THEME_HINTS[m]}</div>
            </button>
          ))}
        </div>
        {/*
          ⚠ WHAT AUTO CURRENTLY RESOLVES TO, STATED. "Auto" alone does not tell a participant whether they
          are looking at light or dark right now, and on a machine that switches at sunset the answer
          changes without them touching anything. Shown only for Auto, because for the other two the label
          already IS the answer.
        */}
        {themeMode === "system" && resolvedTheme && (
          <p className="mt-2 text-xs text-surface-muted">
            Your machine is currently set to{" "}
            <span className="font-medium text-surface-text">{resolvedTheme}</span>.
          </p>
        )}
      </section>

      {/* Assistant response limit */}
      <section className="mb-8 border-t border-surface-line pt-6">
        <h2 className="mb-2 font-semibold text-surface-text">Assistant responses</h2>
        <div className="flex items-start justify-between gap-4">
          <div className="pr-4">
            <label htmlFor="stall-minutes" className="text-sm text-surface-text">
              Stop a turn after this much silence
            </label>
            {/*
              ⚠ SAYS "SILENCE", NOT "TIME LIMIT", because that is what it measures and the difference
              changes what someone picks. The clock resets on every byte the assistant produces, so an
              agentic turn can run for an hour on a 6-minute setting as long as it keeps working. Anyone
              reading this as a total cap would set it far too high and lose the protection.
            */}
            <p className="mt-1 text-xs text-surface-muted">
              Minutes with <span className="font-medium text-surface-text">no output at all</span> before
              the app stops waiting. The timer restarts whenever the assistant produces anything, so a
              long turn that is still working is never interrupted. Raise this if you use a slow or
              throttled model. {STALL_MIN}–{STALL_MAX} minutes.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <input
              id="stall-minutes"
              type="number"
              inputMode="numeric"
              min={STALL_MIN}
              max={STALL_MAX}
              step={1}
              value={stallMinutes}
              onChange={(e) => setStallMinutes(e.target.value)}
              onBlur={commitStallMinutes}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              // 44px min height: this sits next to destructive controls elsewhere on the page and the
              // small ones there are already below the touch-target floor. Not repeating that here.
              className="h-11 w-20 rounded-md border border-surface-line bg-surface-raised px-3 text-sm text-surface-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
            />
            <span className="text-xs text-surface-muted">min</span>
            {/* aria-live so the confirmation is announced, not only shown. */}
            <span aria-live="polite" className="w-12 text-xs text-surface-muted">
              {stallSaved ? "Saved" : ""}
            </span>
          </div>
        </div>
      </section>

      {/* Notifications */}
      <section className="mb-8 border-t border-surface-line pt-6">
        <h2 className="mb-2 font-semibold text-surface-text">Notifications</h2>
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <p className="text-sm text-surface-text">Sound for team activity</p>
            <p className="text-xs text-surface-muted">
              Play a chime for new team messages, board tasks, and phase updates while you're on another tab.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={notifySound}
            onClick={toggleNotifySound}
            // ⚠ TWO MEASURED CORRECTIONS HERE, both found by computing the ratios rather than by eye.
            //
            // OFF is `surface-muted`, NOT `surface-raised`: raised is 1.72:1 against this background —
            // effectively invisible, so an off toggle would have read as no toggle at all. Muted is 6.99:1.
            //
            // ON carries a `border-brand-accent`: the `brand-strong` fill alone measures 3.43:1 against this
            // background, just under the 3:1 floor for a non-text indicator, and the accent border (5.68:1)
            // is what makes the boundary perceivable without changing the fill the brand wants.
            //
            // The knob's POSITION and `aria-checked` carry the state too, so colour is never the only signal.
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
              notifySound
                ? "border-brand-accent bg-brand-strong"
                : "border-transparent bg-surface-muted"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                notifySound ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </section>

      {/* Diagnostics */}
      <section className="mb-8 border-t border-surface-line pt-6">
        <h2 className="mb-2 font-semibold text-surface-text">Diagnostics</h2>
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <p className="text-sm text-surface-text">Local error logging</p>
            <p className="text-xs text-surface-muted">
              Record crashes and errors to a local file on this machine to help diagnose problems.
              Nothing is sent anywhere — the log stays on your device.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={telemetryEnabled}
            onClick={toggleTelemetry}
            // Same as the toggle above — see its note on the two measured failures (off 1.72:1, on 2.96:1).
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
              telemetryEnabled
                ? "border-brand-accent bg-brand-strong"
                : "border-transparent bg-surface-muted"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                telemetryEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        {telemetryEnabled && (
          <button
            onClick={() => api.telemetryOpenLog?.()}
            className="mt-2 text-xs text-brand-accent hover:underline"
          >
            Show log file
          </button>
        )}
      </section>

      {/* ── ⚠ AGENT WORKSPACE TRUST ────────────────────────────────────────────────────
          Trusting a folder is what makes Claude Code honour that folder's `.claude/settings.json`
          `permissions.allow` instead of prompting — and the app grants it implicitly, on every folder
          switch, into `~/.claude.json`: a file OUTSIDE this app's own storage, global to this computer
          account, shared with every other use of Claude Code. There was no way to withdraw it. Not even
          reinstalling helps, because that file survives.

          ⚠ THE SECTION EXISTS TO MAKE AN INVISIBLE PERMISSION VISIBLE, which is most of the value. The
          button matters less than the sentence above it: a participant could not previously discover
          that this grant had been made at all, let alone that it reached beyond the app.

          ⚠ AND IT IS PHRASED FOR SOMEBODY WHO DOES NOT KNOW WHAT `permissions.allow` IS. "Tool approvals
          in this folder are pre-approved" is the consequence; the file name is a detail, so it is not in
          the primary sentence.

          ⚠ HIDDEN WHEN THE ANSWER IS UNKNOWN OR THERE IS NO FOLDER, rather than rendering a row that
          claims "Not trusted" on an older main process or before the IPC answers. A security state shown
          wrongly is worse than one not shown. */}
      {projectPath && workspaceTrusted !== null && (
        <section className="mb-8 border-t border-surface-line pt-6">
          <h2 className="mb-2 font-semibold text-surface-text">Agent folder permissions</h2>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-surface-text">
                {workspaceTrusted
                  ? "This folder's tool approvals are pre-approved"
                  : "This folder's tool approvals are not pre-approved"}
              </p>
              <p className="mt-0.5 text-xs text-surface-muted">
                {workspaceTrusted ? (
                  <>
                    Claude Code applies the approvals in{" "}
                    <span className="font-mono text-surface-text">
                      {projectPath}
                    </span>{" "}
                    without asking each time. This is stored in your computer account, not in this app,
                    so it also applies when you use Claude Code outside the app.
                  </>
                ) : (
                  <>
                    Claude Code will ask before each tool it uses in{" "}
                    <span className="font-mono text-surface-text">{projectPath}</span>. You can approve
                    the folder from the chat when it asks.
                  </>
                )}
              </p>
            </div>
            {workspaceTrusted && (
              <button
                type="button"
                disabled={trustBusy}
                onClick={async () => {
                  setTrustBusy(true);
                  setTrustNote(null);
                  try {
                    const res = await api.cliUntrustWorkspace(projectPath);
                    if (res?.error) {
                      setTrustNote(res.error);
                    } else {
                      setWorkspaceTrusted(false);
                      /**
                       * ⚠ SAYS WHAT HAPPENS NEXT, because the effect is otherwise invisible until the
                       * next chat turn — and a button that appears to do nothing gets pressed again.
                       */
                      setTrustNote(
                        "Withdrawn. Claude Code will ask before each tool it uses in this folder."
                      );
                    }
                  } catch (err) {
                    setTrustNote(err instanceof Error ? err.message : "Could not withdraw");
                  } finally {
                    setTrustBusy(false);
                  }
                }}
                className="flex-shrink-0 rounded-md border border-surface-line px-3 py-1.5 text-xs text-surface-text transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {trustBusy ? "Withdrawing…" : "Withdraw"}
              </button>
            )}
          </div>
          {trustNote && <p className="mt-2 text-xs text-surface-muted">{trustNote}</p>}
        </section>
      )}

      {/* ── ⚠ FILE-WRITE PRE-APPROVAL ──────────────────────────────────────────────────
          ⚠ THE DEFAULT IS ON, AND STAYS ON. kiro-trust.ts argues from measurements why file writes are
          pre-approved — it is the tool an AI coding session exists to use, and prompting on every write
          teaches people to click Allow without reading. The finding is about the absence of a choice,
          not about the default being wrong, so this is the choice.

          ⚠ IT SAYS WHEN IT TAKES EFFECT. `--trust-tools` is a spawn argument, so a running chat keeps
          the policy it started with. A toggle that appeared to apply instantly and did not would be a
          worse security control than none, because the participant would believe writes were being
          prompted while they were not.

          ⚠ SEPARATE SECTION FROM WORKSPACE TRUST, deliberately. They read as the same topic and are
          not: this one is Kiro's spawn policy for one tool, that one is a persistent grant in another
          app's config file. Merging them under one heading would suggest one switch governs both. */}
      {agentFileWrites !== null && (
        <section className="mb-8 border-t border-surface-line pt-6">
          <h2 className="mb-2 font-semibold text-surface-text">Agent tool permissions</h2>
          <div className="flex items-start justify-between gap-4">
            <div className="pr-4">
              <p className="text-sm text-surface-text">Let the assistant write files without asking</p>
              <p className="mt-0.5 text-xs text-surface-muted">
                On, the assistant edits and creates files in your project without a prompt each time —
                which is what most of a coding session is. Off, it asks first. Shell commands, cloud
                calls and network access always ask, whichever way this is set.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={agentFileWrites}
              disabled={agentFileWrites === null}
              onClick={async () => {
                const next = !agentFileWrites;
                /* Optimistic, then corrected from main's answer — it owns the stored value. */
                setAgentFileWrites(next);
                try {
                  const res = await api.agentTrustSetFileWrites(next);
                  if (res && typeof res.fileWrites === "boolean") setAgentFileWrites(res.fileWrites);
                } catch {
                  setAgentFileWrites(!next);
                }
              }}
              // Same contrast reasoning as the toggles above.
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
                agentFileWrites
                  ? "border-brand-accent bg-brand-strong"
                  : "border-transparent bg-surface-muted"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  agentFileWrites ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <p className="mt-2 text-xs text-surface-muted">
            Applies to chats you start after changing this — a conversation already running keeps the
            setting it began with.
          </p>
        </section>
      )}

      {/* ── ABOUT ─────────────────────────────────────────────────────────────────────
          ⚠ THE VERSION IS READ, NEVER WRITTEN HERE. It comes from `app.getVersion()` — i.e.
          `package.json` — which is also what names the installer the download service serves. A
          literal in this file would be a second copy to forget.

          Rendered as "—" until the IPC answers, and left as "—" if it fails: an app that cannot
          report its own version must not display a guess, because the whole point of the row is
          telling somebody which build they are on when they report a bug. */}
      <section className="mb-8 border-t border-surface-line pt-6">
        <h2 className="mb-2 font-semibold text-surface-text">About</h2>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="text-surface-muted">Desktop version</span>
          <span className="font-medium tabular-nums text-surface-text">
            {appVersion ? `v${appVersion}` : "—"}
          </span>
        </div>
      </section>

      {/* ── ⚠ NO ACCOUNT SECTION HERE ANY MORE ──
          It held the signed-in user's name and email and the Sign Out button. Both moved to the
          Account VIEW, which is where they belong: Account is the page
          about who you are, and Settings is about how this app behaves. Duplicating identity
          across both was two places to look and one to keep in step.

          The account SWITCHER stays gone for the reason it was removed originally: a list of other
          people's accounts on a shared machine disclosed every previous signed-in user's email to
          whoever opened Settings next. The `accounts` table is still written on sign-in and still
          powers switchAccount() in main, so nothing is lost if it returns behind a developer flag. */}
      </div>
    </div>
  );
}
