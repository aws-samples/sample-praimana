import { useState, useEffect, useRef } from "react";

const api = (window as any).electronAPI;

/**
 * ⚠ "unconfigured" IS A DISTINCT STATE, not a flavour of offline.
 *
 * An app nobody has pointed at a platform yet is not DOWN — nothing is unreachable, and
 * reporting it red sends the user to debug a network instead of finishing setup. This
 * pill has been wrong-by-default once already: it probed a `/v1/health` route that does
 * not exist on the deployed API, so it read "Offline" permanently while every other
 * request succeeded. A status light that is always red trains people to ignore the one
 * signal that should mean something.
 */
type Status = "checking" | "online" | "offline" | "unconfigured";

/**
 * Header pill showing backend reachability + the current user/team. Surfaces
 * "backend down" and "wrong team/session" issues at a glance. Polls the
 * unauthenticated /v1/health probe on an interval; hover for detail.
 */
export function ConnectionStatus() {
  const [status, setStatus] = useState<Status>("checking");
  const [detail, setDetail] = useState<string>("");
  const [userName, setUserName] = useState<string>("");
  const [teamName, setTeamName] = useState<string>("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadIdentity();
    check();
    pollRef.current = setInterval(check, 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function loadIdentity() {
    const [name, team] = await Promise.all([
      api.getSetting("user_name"),
      api.getSetting("team_name"),
    ]);
    if (name) setUserName(name);
    if (team) setTeamName(team);
  }

  async function check() {
    try {
      const res = await api.pingServer();
      if (res?.configured === false) {
        setStatus("unconfigured");
        setDetail("No platform configured — set the platform URL in Account.");
      } else if (res?.online) {
        setStatus("online");
        setDetail(res.version ? `Backend online (v${res.version})` : "Backend online");
      } else {
        setStatus("offline");
        setDetail(res?.error ? `Backend offline — ${res.error}` : "Backend offline");
      }
    } catch {
      setStatus("offline");
      setDetail("Backend offline");
    }
  }

  // Amber, shared with "checking": both mean "not established yet", which is true and is
  // what distinguishes them from the red that means "we tried and it failed".
  const dot =
    status === "online" ? "bg-emerald-400" : status === "offline" ? "bg-rose-400" : "bg-amber-400";
  const dotPulse = status === "checking" ? "animate-pulse" : "";

  const identity = [userName, teamName].filter(Boolean).join(" · ");
  const title = [detail, identity && `Signed in as ${identity}`].filter(Boolean).join("\n");

  return (
    <button
      onClick={check}
      title={title}
      style={{ WebkitAppRegion: "no-drag" } as any}
      className="flex items-center gap-1.5 rounded-full bg-surface-panel/80 hover:bg-surface-raised px-2.5 py-0.5 text-[11px] text-surface-text transition-colors"
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot} ${dotPulse}`} />
      <span className="truncate max-w-[180px]">
        {status === "offline"
          ? "Offline"
          : status === "unconfigured"
            ? // Names the missing STEP rather than a symptom, because that is the action.
              "No platform"
            : identity || (status === "checking" ? "Connecting…" : "Online")}
      </span>
    </button>
  );
}
