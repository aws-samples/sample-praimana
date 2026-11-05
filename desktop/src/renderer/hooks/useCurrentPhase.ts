import { useEffect, useState } from "react";
import { currentPhaseName, type PhaseLike } from "../lib/composer-placeholder";

const api = (window as any).electronAPI;

/**
 * ── ⚠ WHICH PHASE THE TEAM IS ON, FOR ANYTHING THAT IS NOT THE PHASES TAB ─────────────────────
 *
 * The composer's placeholder names the current phase (see composer-placeholder.ts). `PhasesView`
 * already fetches this, but only when somebody opens that tab — and the participant most helped by
 * the placeholder is the one who has not opened it.
 *
 * ── ⚠ WHY A MODULE-LEVEL CACHE AND NOT A CALL PER MOUNT ──
 *
 * This hook is called from the chat views, so the read happens because a chat tab was visited — which honours
 * that. What would break it is refetching on every mount: the chat views remount on project switch, session
 * switch and React StrictMode's double-mount, and a phase read per remount is the polling this app
 * deliberately does not do. So the answer is cached across mounts and shared by both chat views.
 *
 * ── ⚠ WHY IT DOES NOT SUBSCRIBE TO `team:event` ──
 *
 * Phase changes ARE pushed over that channel, so listening looks like the obvious way to stay
 * current. It is a trap: `useTeamUnread` ends its effect with `api.removeTeamEventListeners()`, which
 * is `removeAllListeners("team:event")` — so whenever that hook remounts it would silently delete this
 * hook's listener too. The same hazard the preload documents between `removeCliListeners` and
 * `removeKiroAcpListeners`, one channel further along.
 *
 * A TTL is the honest alternative. Phases advance when a facilitator moves the workshop on — every
 * half-hour at best — so a placeholder that lags by a few minutes costs nothing, and this is a
 * placeholder: the phase it names is a hint, not a fact anyone acts on.
 */

/** How long a fetched phase name is reused before the next mount refetches. */
export const PHASE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Shared across every caller and every mount.
 *
 * `name: null` is a real, cacheable answer — no team, no phases yet, or `currentPhaseOrder: 0` — and
 * caching it is the point: without that, the common case (a team before phase one) would retry on
 * every single mount.
 */
let cache: { name: string | null; at: number } | null = null;
/** In-flight read, so two chat views mounting together make one call rather than two. */
let inFlight: Promise<string | null> | null = null;

/**
 * Read (or reuse) the current phase name.
 *
 * ⚠ EXPORTED SO THE CACHING IS TESTABLE. This package's vitest is node-only — there is no renderer to
 * mount a hook in — so a `useCurrentPhase` that kept this private would leave "does a remount refetch?"
 * assertable only by reading the source. That is the one question this module exists to answer
 * correctly, and the call count is the only honest evidence for it. The hook below is a thin wrapper.
 */
export async function readCurrentPhaseName(now: number = Date.now()): Promise<string | null> {
  if (cache && now - cache.at < PHASE_CACHE_TTL_MS) return cache.name;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let name: string | null = null;
    try {
      const res = await api.getPhases();
      /**
       * ⚠ ONLY A SUCCESSFUL READ IS BELIEVED. `res.ok === false` covers no-team, 403, 404, offline and
       * a busy slot; all of them mean "we do not know", and the placeholder's fallback chain already
       * says something sensible without this. Note the two SUCCESS cases that also yield null —
       * `phases: []` and `currentPhaseOrder: 0` — which `currentPhaseName` handles.
       */
      if (res?.ok) {
        name = currentPhaseName(res.phases as PhaseLike[] | undefined, res.currentPhaseOrder);
      }
    } catch {
      /**
       * A placeholder must never be able to break a chat. The bridge being absent (a test render, a
       * window torn down mid-call) leaves the fallback wording in place, which is a complete
       * behaviour rather than a degraded one.
       */
      name = null;
    }
    cache = { name, at: now };
    inFlight = null;
    return name;
  })();

  return inFlight;
}

/**
 * The current phase's display name, or null when there is none to show.
 *
 * Null is the ordinary case for a team that has not started phase one, so callers must treat it as
 * "say something else" rather than as an error.
 */
export function useCurrentPhase(): string | null {
  const [name, setName] = useState<string | null>(() => cache?.name ?? null);

  useEffect(() => {
    let alive = true;
    void readCurrentPhaseName(Date.now()).then((value) => {
      // Guarded: the chat views unmount on project and session switches, and setting state on an
      // unmounted component is the warning that trains people to ignore warnings.
      if (alive) setName(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return name;
}

/** Test seam: the module-level cache would otherwise leak between cases. */
export function __resetPhaseCache(): void {
  cache = null;
  inFlight = null;
}
