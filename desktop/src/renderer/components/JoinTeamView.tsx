import { useState, useEffect } from "react";
import { ProfileBadge } from "./ProfileBadge";

const api = (window as any).electronAPI;

interface MyTeam {
  id: string;
  name: string;
  description?: string | null;
  workshopId?: string | null;
  inviteCode?: string | null;
  role?: string | null;
  joinedAt?: string | null;
}

export function JoinTeamView({
  onComplete,
  notice,
  profileLabel,
  onSwitchProfile,
}: {
  onComplete: () => void;
  /**
   * Why the user is on this screen, when they did not choose to be.
   *
   * ⚠ OPTIONAL, AND ABSENT ON THE NORMAL PATH. A first-run participant is here because the app has
   * no team yet, and explaining that would be noise. It is set only when App routed them here after
   * losing access to a team they already had — without a sentence, "join a team" reads as the app
   * having forgotten them, which is the wrong thing to believe about a valid session.
   */
  notice?: string;
  /** Current profile name, shown so the user knows WHICH profile they are acting in. */
  profileLabel?: string | null;
  /** Open the profiles page. */
  onSwitchProfile?: () => void;
}) {
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Teams this user has already joined (fetched from the server). While loading
  // we show a spinner; the result decides whether to show the team list or the
  // invite-code form.
  const [teams, setTeams] = useState<MyTeam[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  // When the user has teams, the invite form is hidden behind a "Join" button.
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);

  useEffect(() => {
    loadMyTeams();
  }, []);

  async function loadMyTeams() {
    setTeamsLoading(true);
    try {
      const res = await api.getMyTeams?.();
      setTeams(Array.isArray(res?.teams) ? res.teams : []);
    } catch {
      setTeams([]);
    } finally {
      setTeamsLoading(false);
    }
  }

  // Clear the "connected" gate so App re-renders the login screen. Credentials
  // stay stored, so returning here just re-shows the (pre-filled) login form.
  async function handleBack() {
    await api.setSetting("connected", "false");
    onComplete();
  }

  /**
   * Enter a team the user already belongs to — no invite code needed.
   *
   * ── ⚠ MAIN WRITES THE TENANT, NOT THIS SCREEN ──
   *
   * This used to `setSetting("team_id", …)` directly, which is why those keys were on the renderer's write
   * allowlist — and that made the tenant key client-controlled for every team-scoped request in the app,
   * including `share:shareSession`, which publishes a private local transcript. Any code in the renderer
   * bundle could re-point it.
   *
   * `selectTeam` re-checks the membership against `/v1/teams/mine` in main and writes the four rows
   * there. `team_joined` stays a renderer write: it is screen gating, not a tenant key.
   */
  async function handleSelectTeam(team: MyTeam) {
    if (selecting) return;
    setSelecting(team.id);
    setError("");
    try {
      const result = await api.selectTeam(team.id);
      if (!result?.ok) throw new Error(result?.error || "Failed to open team");
      await api.setSetting("team_joined", "true");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open team");
      setSelecting(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteCode.trim()) {
      setError("Invite code is required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Store the invite code and join via server
      const serverUrl = await api.getSetting("server_url");
      const teamData = await api.joinTeam(inviteCode.trim(), serverUrl);

      if (teamData?.error) {
        throw new Error(teamData.error);
      }

      /**
       * ⚠ THE TENANT ROWS ARE ALREADY WRITTEN — by `ai:joinTeam`, in main, from the team the SERVER
       * returned for this invite code. They used to be written again from here, which is what put
       * them on the renderer's write allowlist in the first place; see `handleSelectTeam` above.
       */
      await api.setSetting("team_joined", "true");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join team");
    } finally {
      setLoading(false);
    }
  }

  // Whether to show the invite-code form: either the user has no teams yet, or
  // they explicitly tapped "Join" to add another.
  const showForm = !teamsLoading && (teams.length === 0 || showJoinForm);

  if (teamsLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-bg">
        <div className="flex items-center gap-3 text-surface-muted">
          <svg className="animate-spin h-5 w-5 text-blue-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm text-surface-muted">Loading your teams…</span>
        </div>
      </div>
    );
  }

  /**
   * The explanation, when there is one. Styled like the app's other alerts: `tool-error` is legal as a
   * BORDER (3.87:1, a graphical indicator) while the words use `tool-error-text` (7.22:1) — the ratios
   * recorded in tailwind.config.ts, which is why the two reds are not interchangeable.
   */
  const profileBadge = (
    <ProfileBadge label={profileLabel ?? null} onSwitch={onSwitchProfile} />
  );

  const noticeBlock = notice ? (
    <div
      role="alert"
      className="mb-5 rounded-lg border border-tool-error bg-surface-raised p-3 text-xs text-tool-error-text"
    >
      {notice}
    </div>
  ) : null;

  // ── Invite-code form (no teams yet, or "join another") ─────────────────────
  if (showForm) {
    const canGoBackToList = teams.length > 0;
    return (
      <div className="h-screen flex items-center justify-center bg-surface-bg">
        <div className="max-w-md w-full p-8">
          {profileBadge}
          {profileBadge}
        {noticeBlock}
          <button
            type="button"
            onClick={() => {
              if (canGoBackToList) {
                setShowJoinForm(false);
                setError("");
              } else {
                handleBack();
              }
            }}
            disabled={loading}
            className="mb-4 text-sm text-surface-muted hover:text-surface-text disabled:opacity-50 flex items-center gap-1"
          >
            ← {canGoBackToList ? "Back to my teams" : "Back to sign in"}
          </button>
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-surface-text">Join Your Team</h1>
            <p className="text-surface-muted mt-2">
              Enter the invite code from your workshop facilitator
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-surface-text mb-1">
                Team Invite Code
              </label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste your invite code here"
                // ⚠ COLOUR AND FILL STATED. This is the invite-code field: text a participant has
                // just typed and must be able to check against what a facilitator gave them.
                // Inheriting a colour here was the worst instance of the reported defect.
                className="w-full rounded-md border border-surface-line bg-surface-bg px-4 py-3 text-sm font-mono text-surface-text placeholder:text-surface-faint focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none text-center tracking-wider"
                required
              />
              <p className="text-xs text-surface-faint mt-2">
                Ask your facilitator or team lead for the code.
              </p>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Joining..." : "Join Team"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── My Teams list (user already belongs to one or more teams) ──────────────
  return (
    <div className="h-screen flex flex-col items-center bg-surface-bg overflow-y-auto">
      <div className="max-w-lg w-full p-8">
        {noticeBlock}
        <div className="flex items-center justify-between mb-6">
          <button
            type="button"
            onClick={handleBack}
            className="text-sm text-surface-muted hover:text-surface-text flex items-center gap-1"
          >
            ← Back to sign in
          </button>
          <button
            type="button"
            onClick={() => {
              setShowJoinForm(true);
              setInviteCode("");
              setError("");
            }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            + Join a team
          </button>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold text-surface-text">Your Teams</h1>
          <p className="text-surface-muted mt-1">
            Select a team to continue, or join another with an invite code.
          </p>
        </div>

        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

        <div className="space-y-2">
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              onClick={() => handleSelectTeam(team)}
              disabled={selecting !== null}
              className="w-full text-left rounded-lg border border-surface-line bg-surface-panel px-4 py-3 hover:border-blue-400 hover:bg-surface-raised transition-colors disabled:opacity-50 flex items-center gap-3"
            >
              <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center text-sm font-semibold bg-blue-100 text-blue-700 uppercase">
                {team.name?.[0] || "T"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-surface-text truncate">{team.name}</div>
                {team.description ? (
                  <div className="text-xs text-surface-muted truncate">{team.description}</div>
                ) : team.role ? (
                  <div className="text-xs text-surface-faint capitalize">{team.role.toLowerCase()}</div>
                ) : null}
              </div>
              <span className="text-xs text-blue-600 flex-shrink-0">
                {selecting === team.id ? "Opening…" : "Open →"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
