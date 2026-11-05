import { useState, useEffect } from "react";
import claudeIcon from "../assets/claude.png";
import kiroIcon from "../assets/kiro.png";
import codexIcon from "../assets/codex.png";
import { basenameOf } from "../lib/file-tree-ops";

const api = (window as any).electronAPI;

interface Assistant {
  id: string;
  name: string;
  command: string;
  description: string;
  img: string;
}

/**
 * ⚠ ORDER IS THE DISPLAYED ORDER, AND KIRO IS FIRST DELIBERATELY. The cards render straight from
 * this array, so moving an entry moves it on screen. Kiro leads because this is an AWS workshop
 * platform and the AWS assistant should be the one a participant reaches first.
 *
 * ⚠ NOTHING PRE-SELECTS THE FIRST ENTRY, and that is worth keeping. `selected` starts as null, so
 * being first is a matter of prominence, not a default choice made on the participant's behalf —
 * the submit button stays disabled until they pick one. If a default is ever wanted, set it by
 * `id` rather than by index, so reordering these cards cannot silently change which assistant
 * a participant ends up running.
 */
const ASSISTANTS: Assistant[] = [
  {
    id: "kiro",
    name: "Kiro CLI",
    command: "kiro-cli",
    description: "AWS AI coding assistant",
    img: kiroIcon,
  },
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    description: "Anthropic's CLI coding assistant",
    img: claudeIcon,
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    description: "OpenAI's CLI coding assistant",
    img: codexIcon,
  },
];

export function SelectAssistantView({ onComplete }: { onComplete: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupStep, setSetupStep] = useState("");
  const [setupInstructions, setSetupInstructions] = useState("");
  /**
   * The framework install's failure message, once it has failed. Held rather than thrown so the
   * participant can read it and then continue — see the note at the install call. Non-empty also
   * means "do not retry setup on the next submit": a setup turn that failed once (e.g. the agent
   * could not complete the instructions) will tend to fail the same way, and re-running it would make
   * the second click look broken rather than deliberate.
   */
  const [frameworkFailed, setFrameworkFailed] = useState("");
  const [enabledAssistants, setEnabledAssistants] = useState<string[]>(
    ASSISTANTS.map((a) => a.id)
  );

  useEffect(() => {
    api.getEnabledAssistants().then((res: { enabledAssistants: string[] }) => {
      if (res?.enabledAssistants?.length) setEnabledAssistants(res.enabledAssistants);
    });
  }, []);

  // Only show assistants the facilitator enabled for this workshop.
  const availableAssistants = ASSISTANTS.filter((a) => enabledAssistants.includes(a.id));

  async function handleSelectFolder() {
    const path = await api.selectDirectory();
    if (path) setProjectPath(path);
  }

  /**
   * ── ⚠ BACK TO TEAM SELECTION, BY UN-SETTING THE GATE THAT LED HERE ─────────────────────────────
   *
   * WHY THERE IS A BACK BUTTON: this screen previously had none, simply because nobody had added
   * one. `JoinTeamView`, the gate immediately before this, has had
   * "← Back to sign in" all along; this screen had nothing, so a participant who picked the wrong
   * team could only get out by finishing setup.
   *
   * There is no history to pop. The setup flow is four GATES in App.tsx, each rendering because a
   * persisted condition is false and advancing by making it true. So going back means un-setting the
   * condition this screen arrived through — `team_joined` — and letting the chain re-evaluate, which
   * is exactly what JoinTeamView.handleBack does with `connected`.
   *
   * ⚠ `team_joined` ONLY. NOT `team_id`, AND THAT IS NOT A DETAIL. setting-access.ts puts
   * `team_joined` in RENDERER_WRITABLE_SETTINGS as "screen gating" and names this view as an
   * expected writer; `team_id` is READABLE-ONLY, because it is a tenant key and main owns it — the
   * allowlist's own comment records that a renderer-writable `team_id` let any code in the bundle
   * re-point the tenant for every team-scoped request. Clearing it here would be that same hole.
   * Leaving it set is also correct behaviourally: the join screen offers "Back to my teams" from the
   * stored list, and `selectTeam` in main rewrites the tenant keys when a team is chosen.
   *
   * ⚠ NOTHING IS ROLLED BACK, DELIBERATELY. If the participant already submitted and the framework
   * install failed, `cliSetAssistant` and `commitProjectPath` have run. Both are re-chosen on the
   * way back through this screen, and undoing them would leave `allowedRoots()` pointing at nothing
   * while the folder still held a half-installed framework — the same argument App.tsx makes for not
   * undoing a folder switch on a failed install.
   */
  async function handleBack() {
    await api.setSetting("team_joined", "false");
    onComplete();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !projectPath) {
      setError("Select an assistant and a project folder");
      return;
    }
    setLoading(true);
    setError("");
    setSetupStep("");
    try {
      // One call, and it carries the assistant ID rather than `assistant.command`: main owns both
      // writes because `ai_command` is the binary the app spawns, so the renderer must not be able to
      // name it. See src/main/assistant-command.ts.
      const chosen = await api.cliSetAssistant(selected);
      if (chosen?.error) throw new Error(chosen.error);
      // Not `setSetting("project_path", …)`: main owns this write and accepts only a path its
      // own picker returned, because `allowedRoots()` builds the filesystem boundary from it.
      await api.commitProjectPath(projectPath);

      /**
       * ── ⚠ ASK ABOUT TOOL PERMISSIONS *BEFORE* THE FRAMEWORK INSTALL, NOT AFTER ────────────────
       *
       * This call used to sit at the END of setup, after `frameworkInstall`. That was the wrong order
       * for the same reason App.tsx spells out at its own call site: the install runs an assistant turn
       * in this folder (`runCliAgent`), so a grant made afterwards is too late for the one process that
       * most needs it — the CLI discards `permissions.allow` and cannot get tool approvals mid-setup.
       *
       * ⚠ AND IT BECAME LOAD-BEARING WHEN THE GRANT GAINED A CONFIRMATION.
       * Main now raises a native dialog, so the old position would have put a question in front of the
       * participant AFTER the thing it governs had already run — the answer arriving too late to affect
       * anything, which is worse than not asking.
       *
       * ⚠ SAFE HERE BECAUSE `commitProjectPath` HAS RUN. `cli:trustWorkspace` refuses any path that is
       * not an open project root, and `allowedRoots()` is built from the `project_path` setting that the
       * line above just wrote — so the folder qualifies now, before `addProject` registers it too.
       *
       * ⚠ DECLINING DOES NOT BLOCK SETUP, and that is why this is not a gate. The framework FILES are
       * copied regardless; only the agent's configuration turn degrades. A participant who says no gets
       * a working project and an assistant that asks before each tool.
       *
       * ⚠ AND THE DEGRADATION IS NOW STATED RATHER THAN NOTED. `framework:install` used to swallow that
       * failure into a progress line and still return "installed and verified"; it returns `partial`
       * instead, and the message below says the automated setup did not finish. Declining here is a
       * likely way to reach that path, so the two belong in one another's notes.
       */
      const trust = await api.cliTrustWorkspace(projectPath);
      if (trust?.error) {
        setSetupStep(`Note: could not pre-approve tool permissions (${trust.error}).`);
      } else if (trust?.declined) {
        setSetupStep("Tool permissions were not pre-approved — the assistant will ask each time.");
      }

      // Setup instructions. Fetched in the MAIN process so the bearer stays there;
      // a missing/unreachable workshop just leaves the instructions panel hidden.
      const guide = await api.getSetupInstructions();
      if (guide?.instructions) setSetupInstructions(guide.instructions);

      /**
       * Is the experience's development framework already in this folder?
       *
       * ⚠ `check.name` IS THE FRAMEWORK THE FACILITATOR CHOSE — AI-DLC, Spec Kit, OpenSpec or their own
       * — so every sentence below is built from it. Naming one here would be wrong for every experience
       * that picked another, and this screen is the first thing a participant reads.
       */
      const check = frameworkFailed
        ? { skipped: true, name: "", reason: "", installed: false }
        : await api.frameworkCheck({ projectPath, assistant: selected });
      if (frameworkFailed) {
        // Already reported and read. Fall through to project creation without touching the network.
      } else if (check.skipped) {
        // Nothing was injected — tell the user why instead of silently continuing.
        setSetupStep(`${check.name} not installed: ${check.reason || "setup config unavailable"}`);
      } else if (check.installed) {
        setSetupStep(`${check.name} is already set up in this folder.`);
      } else {
        setSetupStep(`Setting up ${check.name}...`);
        api.onFrameworkProgress((data: { step: string }) => setSetupStep(data.step));
        const result = await api.frameworkInstall({ projectPath, assistant: selected });
        /**
         * ── ⚠ A FAILED FRAMEWORK INSTALL MUST NOT STRAND THE PARTICIPANT ───────────────────────
         *
         * This threw. The throw landed in the catch at the bottom, which sets an error and stops —
         * so `addProject`, `setSetting("setup_complete")` and `onComplete()` were all skipped and the
         * participant sat on this screen with no way forward. An agent that cannot complete the setup
         * instructions is enough to do it, and so is any transient failure — a CLI that is not
         * installed, or an assistant that is not authenticated.
         *
         * ⚠ THE FRAMEWORK IS AN ACCELERATOR, NOT A PRECONDITION. Nothing else on this screen depends
         * on it: the project is a folder and an assistant, and both are already chosen. Blocking on
         * the one optional step — at the first screen of a timed workshop, where the facilitator is
         * in front of the room — trades a participant's whole session for a convenience.
         *
         * So the failure is REPORTED AND CARRIED, not raised. `frameworkFailed` keeps the message on
         * screen next to the Setup Guide link, which is the thing that lets somebody finish the job
         * by hand, and the button below changes to say so. The participant proceeds deliberately,
         * having read it — rather than the message flashing past as the screen unmounts.
         *
         * This mirrors the folder-switch path in App.tsx, which already reports and continues for the
         * same reason, and the `result.partial` case immediately below, which has always continued.
         */
        if (result.error) {
          setFrameworkFailed(result.error);
          setSetupStep("");
          setLoading(false);
          return;
        }
        /**
         * ⚠ "INSTALLED" AND "FILES COPIED" ARE DIFFERENT OUTCOMES, and this line used to claim the
         * stronger one for both. `framework:install` runs an unattended agent turn to complete the
         * framework's own configuration; when that turn cannot run — the participant declined the
         * tool pre-approval above, or the setup needs a shell command the policy does not grant —
         * the files are still in place and the configuration is not.
         *
         * Saying so is what lets somebody finish the job from the setup guide. The previous wording
         * sent them away believing setup had succeeded.
         */
        setSetupStep(
          result.partial
            ? `${check.name} files installed — automated setup did not finish. Open the setup guide to complete it.`
            : `${check.name} installed.`
        );
      }

      const project = {
        id: crypto.randomUUID(),
        // The first thing a participant names their project; on Windows the old form stored the
        // entire path as the name, and it is persisted, so every later screen inherited it.
        name: basenameOf(projectPath) || "Project",
        path: projectPath,
      };
      await api.addProject(project);

      /**
       * ⚠ THE TRUST CALL THAT USED TO BE HERE HAS MOVED UP, above the framework install — see the note
       * at its new position for why the old order could not work once the grant became a question. This
       * comment is left as a signpost because "trust the workspace" is a step somebody will look for at
       * the end of setup, where it lived for the whole of this file's history.
       */
      await api.setSetting("setup_complete", "true");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setLoading(false);
      setSetupStep("");
    }
  }

  return (
    /*
      ⚠ `overflow-y-auto` AND `py-8`, NOT JUST CENTERING. This was the only full-screen view without an
      inner scroll: `items-center` on a fixed `h-screen` centres the card and CLIPS it once the content is
      taller than the window — which this view can be, since it grows a Setup Guide block and a progress
      row. It went unnoticed while the document itself could scroll; now that the shell forbids that
      (index.css), the view has to own its own scroll or its lower half is unreachable on a short window.

      The padding matters with it: a centred flex child with no vertical padding has nothing to scroll
      INTO, so the first and last rows sit flush against the edges.
    */
    <div className="h-screen flex items-center justify-center overflow-y-auto py-8 bg-surface-bg">
      <div className="max-w-lg w-full p-8">
        {/*
          Same markup and same position as JoinTeamView's back link, so the two gates in this flow
          look like one flow. Above the heading rather than beside the submit button: it is a way out
          of the screen, not one of the choices on it.

          ⚠ DISABLED WHILE `loading`. Setup writes real state — the assistant, the project path, a
          workspace-trust grant, a downloaded framework — and leaving mid-write would strand those
          half-applied with the participant on another screen. The one case where this screen holds
          `loading` and DOES want to be left is a failed install, and that path clears `loading`
          before showing its warning, so the button is live exactly when it should be.
        */}
        <button
          type="button"
          onClick={handleBack}
          disabled={loading}
          className="text-sm text-surface-muted hover:text-surface-text flex items-center gap-1 mb-6 disabled:opacity-50"
        >
          ← Back to team selection
        </button>
        <div className="text-center mb-8">
          {/*
            ⚠ `text-surface-text` IS NOT DECORATION HERE — it is the fix for a real defect.
            This heading and the assistant names below carried NO text colour at all, so they
            inherited the browser default and rendered near-invisible grey against the light
            fill. Reported from a screenshot: the title and all three assistant names looked
            disabled while their descriptions did not.
          */}
          <h1 className="text-2xl font-bold text-surface-text">Choose Your AI Assistant</h1>
          <p className="text-surface-muted mt-2">
            Select the coding assistant and project folder
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Assistant selection */}
          <div className="grid gap-3">
            {availableAssistants.map((assistant) => (
              <button
                key={assistant.id}
                type="button"
                onClick={() => setSelected(assistant.id)}
                className={`w-full text-left rounded-lg border-2 p-4 transition-all ${
                  selected === assistant.id
                    ? "border-blue-500 bg-surface-raised"
                    : "border-surface-line hover:border-surface-line"
                }`}
              >
                <div className="flex items-center gap-3">
                  <img src={assistant.img} alt={assistant.name} className="w-8 h-8 rounded-full flex-shrink-0" />
                  <div>
                    {/* Colour stated, not inherited — see the heading above. */}
                    <div className="font-semibold text-surface-text">{assistant.name}</div>
                    <div className="text-xs text-surface-muted">{assistant.description}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Project folder */}
          <div>
            <label className="block text-sm font-medium text-surface-text mb-2">
              Project Folder
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectPath}
                readOnly
                placeholder="Select your project folder..."
                // `text-surface-text` explicitly: this input had no colour either, and a
                // read-only field showing a path the user must verify is the worst place to
                // inherit one.
                className="flex-1 rounded-md border border-surface-line px-4 py-2.5 text-sm bg-surface-bg text-surface-text placeholder:text-surface-faint outline-none"
              />
              <button
                type="button"
                onClick={handleSelectFolder}
                // Colour stated: this is the "Browse" button, and it had no colour either — the
                // new theme test caught it after the first sweep missed it.
                className="rounded-md border border-surface-line px-4 py-2.5 text-sm text-surface-text hover:bg-surface-raised"
              >
                Browse
              </button>
            </div>
          </div>

          {/*
            ── ⚠ THIS PANEL WAS EFFECTIVELY INVISIBLE, AND IT WAS MEASURED ────────────────────
            `text-blue-700` / `text-blue-800` are LIGHT-THEME inks, left behind when these surfaces
            went dark. On `bg-surface-raised` (#374151) they measure:

              body  text-blue-800 (#1e40af) → 1.18:1
              hover text-blue-900 (#1e3a8a) → 1.00:1   ← identical to the background

            AA needs 4.5:1 for text this size. The hover state was literally the same luminance as
            the panel, so pointing at the link made it DISAPPEAR — on the screen a participant sees
            before they have done anything, containing the one link that tells them what to do.

            Now the app's own dark-surface tokens: `surface-text` (#e5e7eb) is 8.33:1 on this fill
            and `kiro-accent` (#93c5fd) is 5.72:1 — both pass, and the link is still distinguishable
            from the prose by colour AND underline, not colour alone. The border moves off
            `blue-200` for the same reason: an almost-white hairline on a mid-grey panel was
            drawing more attention than the text inside it.
          */}
          {setupInstructions && (
            <div className="p-3 bg-surface-raised border border-surface-line rounded-lg">
              <p className="text-xs font-medium text-surface-text mb-1">Setup instructions</p>
              <p className="text-sm text-surface-muted mb-2">
                Your facilitator provided these steps to set up your project. The assistant will try to
                carry them out automatically; you can also follow them yourself.
              </p>
              <pre className="text-sm text-surface-text whitespace-pre-wrap break-words font-sans">
                {setupInstructions}
              </pre>
            </div>
          )}

          {setupStep && (
            <div className="flex items-center gap-3 p-3 bg-surface-raised rounded-lg">
              {/* Same fix: `blue-600` on this panel is 1.99:1 — an indicator below 1.4.11's 3:1. */}
              <svg className="animate-spin h-4 w-4 text-kiro-accent" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {/* "Running AI agent to complete setup…" — 1.54:1 as blue-700, now 8.33:1. */}
              <span className="text-sm text-surface-text">{setupStep}</span>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          {/*
            ⚠ A WARNING, NOT AN ERROR, AND THE DISTINCTION IS THE POINT. `error` above stops setup;
            this does not. The framework is an accelerator and every other part of the project is
            already decided, so a failed install must not cost a participant their session — see the
            note at the install call.

            Amber rather than red, and it sits ABOVE the button whose label it explains, so the
            sequence a participant reads is: what failed, what to do about it, then the control that
            proceeds. `role="status"` rather than `alert`: this is not an interruption, it is the
            outcome of the step they just ran, and it must not steal focus from the button.

            The setup guide is the thing that actually lets somebody finish by hand, so the message
            points at it when there is one and says where to look when there is not.
          */}
          {frameworkFailed && (
            <div
              role="status"
              className="p-3 bg-surface-raised border border-amber-500/40 rounded-lg space-y-1"
            >
              <p className="text-xs font-medium text-amber-400">
                Automatic project setup did not finish
              </p>
              <p className="text-sm text-surface-text">{frameworkFailed}</p>
              <p className="text-sm text-surface-muted">
                You can carry on and set the project up by hand
                {setupInstructions ? " using the setup instructions above." : (
                  <>
                    {" "}using the instructions your facilitator shared. Ask them if you do not have them.
                  </>
                )}
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !selected || !projectPath}
            className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {/* The label changes so the second click is an informed one rather than a retry of the
                thing that just failed — the handler skips the install when `frameworkFailed` is set. */}
            {loading
              ? "Setting up..."
              : frameworkFailed
                ? "Continue without automatic setup"
                : "Start Collaborating"}
          </button>
        </form>
      </div>
    </div>
  );
}
