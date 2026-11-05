// ── ⚠ WHICH PROFILE THIS SESSION IS FOR, ASKED BEFORE ANYTHING IS OPEN ────────────────────
//
// ⚠ THIS SCREEN RUNS WITH NO DATABASE. It is drawn before `initDatabase()` is ever called (see the early
// return in `index.ts`), so the ONLY channels available are `profile:*`, which read the filesystem. Nothing
// here can look at a team, a sign-in or a chat — those live inside the profile that has not been picked yet.
// Adding a call to any other API here would fail at runtime rather than at compile time, because the preload
// bridge is typed `any`.
//
// ⚠ AND IT IS NOT SHOWN ON EVERY LAUNCH. The remembered profile is entered directly — a facilitator opening
// the app mid-workshop should not have to click past a picker. This appears on a fresh install, when the
// remembered profile has been deleted, and on demand from the File menu. The four rules are in
// `decideLaunch`.
//
// ── ⚠ WHY IT SAYS PROFILES ARE NOT PRIVATE ──
//
// This is the exact screen where somebody forms the belief "this one is mine". It is not true: profiles share
// one OS user and one keychain, so `safeStorage` will decrypt any profile's tokens for any other, and the
// files are mutually readable. On a shared workshop laptop two participants would each reasonably assume
// otherwise. Saying so here costs one line and is the difference between a convenience feature and a
// misleading one.

import { useCallback, useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { BrandName } from "./BrandName";

const api = (window as never as { electronAPI: ElectronApi }).electronAPI;

interface ElectronApi {
  profileList(): Promise<{ profiles: ProfileSummary[]; current: string }>;
  profileCreate(params: {
    name: string;
    newWindow: boolean;
  }): Promise<{ created?: string; error?: string; replaced?: boolean }>;
  profileOpen(id: string): Promise<{ opening?: string; error?: string; replaced?: boolean }>;
  /** Both report `replaced`, so a caller never has to infer the mechanism. `openWindow` never replaces. */
  profileOpenWindow(id: string): Promise<{ opening?: string; error?: string; replaced?: boolean }>;
}

interface ProfileSummary {
  id: string;
  /** The account this profile belongs to, when it has signed in once. See profile.ts's sidecar note. */
  identityEmail?: string;
  label: string;
  team?: string;
  lastUsedAt?: string;
}

/**
 * @param mustCreate No profile exists, so creating one is the only way forward — the list and any escape are
 *        hidden.
 * @param onCancel   Present when this is shown as an OVERLAY over a running app (File → New Profile…) rather
 *        than as the launch screen. Absent at launch, where there is nothing to go back to: the app behind
 *        this screen has no database open.
 * @param newWindow  ── ⚠ WHICH MECHANISM OPENS THE PROFILE, AND IT IS NOT COSMETIC ──
 *
 *        `true`  (overlay, from a running app) — open a SECOND instance and leave this window alone. The
 *                running app keeps its chats, its CLI turns and its streams; nothing is discarded to look at
 *                another profile.
 *        `false` (the launch screen) — REPLACE this process. There is no app behind the picker to preserve,
 *                and this process holds the lock for the ROOT userData, so spawning "Default" from here would
 *                make the child fail that lock and quit while this window merely focused itself. The picker
 *                would appear to do nothing.
 *
 *        Both directions are safe in the overlay case, because a running app holds its OWN profile's lock and
 *        every other profile's is free — and the profile it is already in is disabled in the list.
 */
export function ProfileChooser({
  mustCreate,
  onCancel,
  newWindow = false,
  justConnected = false,
}: {
  mustCreate: boolean;
  onCancel?: () => void;
  newWindow?: boolean;
  /**
   * Shown immediately after a connect link was committed, so the copy can say WHY it is asking.
   *
   * ⚠ THE SAME CHOOSER, DIFFERENT SENTENCE. The list, the create form and the navigation are identical;
   * what changes is that the participant arrived here from confirming an experience rather than by
   * deciding they were in the wrong profile, and "Choose a profile" with no context reads as an
   * interruption at that moment.
   */
  justConnected?: boolean;
}) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  /** The profile this window is already in, so it is not offered as somewhere to go. */
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when this process created a profile and then SURVIVED — the dev-build path, where `relaunchInto`
   * spawns rather than replacing. There is nothing further to do in this window, and saying so is better
   * than a button that cannot finish.
   */
  const [openedElsewhere, setOpenedElsewhere] = useState<string | null>(null);
  /**
   * ⚠ ONE-WAY: once a launch is in flight the process is being REPLACED (`app.relaunch`), so there is no
   * "finished" state to return to. Every control is disabled to stop a second click racing the first — two
   * relaunch requests would leave the surviving one ambiguous.
   */
  const [launching, setLaunching] = useState(false);

  const [creating, setCreating] = useState(mustCreate);  // nosemgrep: react-props-in-state

  useEffect(() => {
    api
      .profileList()
      .then((r) => {
        setProfiles(r?.profiles ?? []);
        setCurrent(r?.current ?? null);
      })
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }, []);

  const open = useCallback(
    async (id: string) => {
      setLaunching(true);
      setError(null);
      /* See the `newWindow` note: replace at launch, open a second window from a running app. */
      const result = newWindow ? await api.profileOpenWindow(id) : await api.profileOpen(id);
      if (result?.error) {
        setError(result.error);
        setLaunching(false);
        return;
      }
      /**
       * ⚠ DISMISS WHENEVER THIS PROCESS SURVIVES — which is not the same as `newWindow`.
       *
       * This read `if (newWindow) onCancel?.()`, and the reasoning was sound for the two cases that existed:
       * an overlay spawns and must dismiss; the launch screen is about to be REPLACED, and clearing it would
       * show an app with no database for the instant before it exits.
       *
       * A third case appeared. `profileOpen` replaces the process only in a PACKAGED build — in development
       * it spawns alongside, because the dev server is a child of this process and `app.exit` takes it down
       * with it. So the process survived, nothing cleared the picker, and the old window sat on a chooser
       * while the new window opened behind it. Precisely the stranding this comment set out to avoid.
       *
       * `replaced === false` is main telling us it survived. Trusting `newWindow` alone was inferring the
       * mechanism instead of asking.
       */
      if (newWindow || result?.replaced === false) onCancel?.();
    },
    [newWindow, onCancel]
  );

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the profile a name.");
      return;
    }
    setLaunching(true);
    setError(null);
    const result = await api.profileCreate({ name: trimmed, newWindow });
    if (result?.error) {
      setError(result.error);
      setLaunching(false);
      return;
    }
    /**
     * ⚠ THE SAME `replaced === false` QUESTION THE LAUNCH PATH ABOVE ASKS, and for the same reason its
     * comment gives — this path was the one still inferring the mechanism from `newWindow`, which is only
     * true for an overlay. A dev build spawns instead of replacing, so the process survives a create too.
     */
    if (newWindow || result?.replaced === false) {
      setLaunching(false);
      /**
       * ⚠ AN OVERLAY DISMISSES; THE LAUNCH SCREEN HAS NOWHERE TO GO. `onCancel` is absent in launch-chooser
       * mode (main.tsx renders no cancel — there is no app behind it to return to), so clearing the spinner
       * alone would put the reader back on a create form that has already succeeded. It says what happened
       * instead.
       */
      if (onCancel) onCancel();
      else setOpenedElsewhere(trimmed);
    }
  }, [name, newWindow, onCancel]);

  return (
    <div className="h-screen flex flex-col bg-surface-bg overflow-y-auto">
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center gap-2.5 mb-8">
            <img src={logo} width={32} height={32} className="shrink-0 rounded-lg" alt="" />
            <span className="text-xl font-bold text-surface-text"><BrandName /></span>
          </div>

          {/**
            * ── ⚠ THIS WINDOW IS DONE, AND SAYS SO ────────────────────────────────────────────────
            *
            * The second window is correct and deliberate in a dev build — `relaunchInto` documents why it
            * spawns rather than exiting: `app.exit(0)` would end the process `vite-plugin-electron` owns,
            * stopping the dev server and leaving the new window with nothing to load. The bug was that this
            * window had no way to know it had survived, so it sat on a create form whose button never
            * finished.
            *
            * ⚠ IT DOES NOT PRETEND TO BE THE SWITCHED WINDOW. Nothing here can focus or absorb the instance
            * that just started, so the honest end state is a sentence and a closed door, not a form that
            * looks live. A packaged build never reaches this — it exits before rendering anything.
            */}
          {openedElsewhere ? (
            <div className="bg-surface-panel rounded-xl border border-surface-line shadow-sm p-6">
              <h1 className="text-xl font-bold tracking-tight text-surface-text">
                “{openedElsewhere}” is open in a new window
              </h1>
              <p className="mt-2 text-sm text-surface-muted leading-relaxed">
                Development builds start a profile alongside this window instead of replacing it, because
                replacing it would stop the dev server. You can close this window — the new one is the app.
              </p>
            </div>
          ) : (
          <div className="bg-surface-panel rounded-xl border border-surface-line shadow-sm p-6">
            <h1 className="text-xl font-bold tracking-tight text-surface-text">
              {mustCreate
                ? "Create a profile"
                : justConnected
                  ? "Which profile is this workspace for?"
                  : "Choose a profile"}
            </h1>
            <p className="mt-2 text-sm text-surface-muted leading-relaxed">
              {mustCreate
                ? "A profile keeps one person's sign-in, team and chat history together. Create one to continue."
                : justConnected
                  ? // Says what the choice COSTS if taken wrongly, which is the thing a label cannot.
                    "Create one for this workspace to keep its team, chats and projects separate — a new profile inherits the platform you just connected, so you can sign in straight away. Or continue in the profile you are in."
                  : "Each profile has its own sign-in, team and chat history. This is remembered, so you go straight in next time."}
            </p>

            {loading && <p className="mt-6 text-sm text-surface-muted">Loading…</p>}

            {/* The existing profiles. Absent entirely when there are none, rather than an empty box. */}
            {!loading && !mustCreate && profiles.length > 0 && (
              <ul className="mt-5 space-y-2">
                {profiles.map((p) => (
                  <li key={p.id}>
                    {/*
                      ⚠ THE PROFILE THIS WINDOW IS ALREADY IN IS NOT AN OPTION. Opening it would either fail
                      the single-instance lock and do nothing visible, or pointlessly reopen what is already on
                      screen — the same "control that cannot act" defect the model picker was fixed for.
                    */}
                    <button
                      onClick={() => open(p.id)}
                      disabled={launching || p.id === current}
                      className="w-full rounded-md border border-surface-line px-4 py-3 text-left transition-colors hover:bg-surface-bg disabled:opacity-50"
                    >
                      <span className="block text-sm font-medium text-surface-text">
                        {p.label}
                        {p.id === current && (
                          <span className="ml-2 text-xs font-normal text-surface-faint">
                            (this window)
                          </span>
                        )}
                      </span>
                      {/*
                        The team is shown when known, because it is the thing that distinguishes two profiles
                        belonging to the same person — and picking the wrong one is the mistake this screen
                        exists to prevent.
                      */}
                      {p.team && (
                        <span className="block text-xs text-surface-muted">{p.team}</span>
                      )}
                      {/*
                        ⚠ AND THE ACCOUNT, WHICH IS WHY THE BINDING MOVED OUT OF THE DATABASE. Two profiles of
                        the SAME deployment differ only by team and by which of your addresses works in them —
                        the reporter's `…-codevibranium` and `…-jarvisdeploy` share a pool, client, API origin
                        and portal. A label and a team were not enough to tell them apart; this is.

                        It comes from `profile.json`, which the chooser CAN read: this screen opens no
                        database (see the header), so a per-profile setting was invisible here by design.
                      */}
                      {p.identityEmail && (
                        <span className="block text-xs text-surface-faint">{p.identityEmail}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Create. Always reachable unless a launch is already under way. */}
            {!loading && (creating || mustCreate) ? (
              <div className="mt-5">
                <label htmlFor="profile-name" className="block text-xs font-medium text-surface-muted">
                  Profile name
                </label>
                <input
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !launching) create();
                  }}
                  autoFocus
                  placeholder="e.g. Xavier — Team Alpha"
                  disabled={launching}
                  className="mt-1 w-full rounded-md border border-surface-line bg-surface-bg px-3 py-2 text-sm text-surface-text placeholder:text-surface-muted disabled:opacity-50"
                />
                <button
                  onClick={create}
                  disabled={launching}
                  className="mt-3 w-full rounded-md bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {launching ? "Opening…" : "Create and continue"}
                </button>
              </div>
            ) : (
              !loading && (
                <button
                  onClick={() => setCreating(true)}
                  disabled={launching}
                  className="mt-3 w-full rounded-md border border-surface-line px-6 py-2.5 text-sm font-medium text-surface-text transition-colors hover:bg-surface-bg disabled:opacity-50"
                >
                  New profile…
                </button>
              )
            )}

            {error && (
              <p role="alert" className="mt-4 text-sm text-tool-error-text">
                {error}
              </p>
            )}

            {/*
              Only when shown over a running app. At launch there is deliberately no way out: the app behind
              this screen has no database open, so "cancel" would leave a window with nothing in it.
            */}
            {onCancel && (
              <button
                onClick={onCancel}
                disabled={launching}
                className="mt-3 w-full rounded-md px-6 py-2 text-sm font-medium text-surface-muted transition-colors hover:text-surface-text disabled:opacity-50"
              >
                {/*
                  ⚠ NAMES THE OUTCOME WHEN THERE IS ONE. Arriving here from a connect, "Cancel" implies
                  undoing the connect — which this does not do; the platform is already saved and this
                  falls through to signing in where you are. That is a legitimate choice and the label
                  should say so rather than making it look like a way out.
                */}
                {justConnected ? "Continue in this profile" : "Cancel"}
              </button>
            )}
          </div>
          )}

          {/*
            ⚠ THE HONESTY LINE. See the file header: this screen is where the assumption of privacy is formed,
            and profiles do not provide it — one OS user, one keychain, mutually readable files. Kept short and
            outside the panel so it reads as a standing fact rather than an error.
          */}
          <p className="mt-4 text-center text-xs text-surface-faint leading-relaxed">
            Profiles keep work separate, not private — anyone using this computer account can open any of
            them. For real separation, use separate computer logins.
          </p>
        </div>
      </div>
    </div>
  );
}
