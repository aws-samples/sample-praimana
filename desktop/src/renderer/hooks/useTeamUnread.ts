import { useState, useEffect, useRef } from "react";

const api = (window as any).electronAPI;

// Short two-tone notification chime via WebAudio — no asset needed, works under
// the app's strict CSP. Fails silently if audio is unavailable/blocked.
let audioCtx: AudioContext | null = null;
function playChime() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    const ctx = audioCtx!;
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    const tones = [
      { freq: 880, start: 0, dur: 0.12 },
      { freq: 1320, start: 0.1, dur: 0.16 },
    ];
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = t.freq;
      gain.gain.setValueAtTime(0.0001, now + t.start);
      gain.gain.exponentialRampToValueAtTime(0.15, now + t.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + t.start);
      osc.stop(now + t.start + t.dur + 0.02);
    }
  } catch {
    /* audio unavailable — ignore */
  }
}

export type UnreadCounts = { ai: number; chat: number; board: number; phases: number };

/**
 * ── ⚠ A BLOCKED TURN IS NOT AN UNREAD COUNT ───────────────────────────────────────────────────
 *
 * ⚠ A BOOLEAN, NOT A NUMBER. `session/prompt` does not resolve until the prompt is answered, so an agent
 * can never have two questions outstanding — a count would imply a queue that cannot exist.
 *
 * ⚠ AND IT IS SEPARATE FROM `UnreadCounts` RATHER THAN A FIFTH FIELD, because the two clear on different
 * events and merging them would force one rule on both. See `awaitingPermission` below.
 */
export interface AssistantAttention {
  counts: UnreadCounts;
  /** True while the assistant is blocked on a permission prompt the user has not answered. */
  awaitingPermission: boolean;
}

// Which backend event kind badges which surface, and which app view "reads"
// (clears) each surface. `ai` (assistant chat, view "chat") is driven locally by
// the chat views via the "ai:response-complete" window event, not the SSE stream.
const KIND_TO_VIEW: Record<string, keyof UnreadCounts> = {
  message: "chat",
  task: "board",
  phase: "phases",
};
const VIEW_FOR_APP: Record<string, keyof UnreadCounts | undefined> = {
  chat: "ai",
  "team-chat": "chat",
  board: "board",
  phases: "phases",
};

/**
 * Real-time unread badges + notification sound for team activity (chat, board,
 * phases), driven by events PUSHED from the main process over IPC (backend SSE
 * stream) — no polling. Events caused by the current user never count or chime.
 * Opening the corresponding tab clears that surface's count.
 *
 * @param view the currently-active app view (clears its matching count).
 */
export function useTeamUnread(view: string): AssistantAttention {
  const [counts, setCounts] = useState<UnreadCounts>({ ai: 0, chat: 0, board: 0, phases: 0 });
  const [awaitingPermission, setAwaitingPermission] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;

  const meRef = useRef<string | null>(null);

  // Clear the active surface's count immediately when the user opens that tab.
  useEffect(() => {
    const surface = VIEW_FOR_APP[view];
    if (surface) setCounts((c) => (c[surface] === 0 ? c : { ...c, [surface]: 0 }));
  }, [view]);

  // Mirror the combined unread total onto the dock/taskbar icon badge.
  useEffect(() => {
    const total = counts.ai + counts.chat + counts.board + counts.phases;
    void api.setBadgeCount(total);
  }, [counts]);

  // AI assistant response completion is emitted locally by the chat views (they
  // stay mounted across tabs). Badge it unless the user is already on Chat.
  useEffect(() => {
    async function onAiComplete() {
      if (viewRef.current === "chat") {
        setCounts((c) => (c.ai === 0 ? c : { ...c, ai: 0 }));
        return;
      }
      setCounts((c) => ({ ...c, ai: c.ai + 1 }));
      const soundPref = await api.getSetting("notify_sound");
      if (soundPref !== "false") playChime();
    }
    window.addEventListener("ai:response-complete", onAiComplete);
    return () => window.removeEventListener("ai:response-complete", onAiComplete);
  }, []);

  /**
   * ── ⚠ THE ASSISTANT IS BLOCKED, WHICH IS DIFFERENT FROM HAVING REPLIED ────────────────────────
   *
   * Same delivery as `ai:response-complete` above and for the same reason: the chat views stay MOUNTED
   * across tabs (App.tsx hides the pane rather than unmounting it), so the prompt state is still in the
   * component while the user is elsewhere and a window event is all that is needed to reach the tab. No
   * IPC, no polling, and no second source of truth to drift from the one the buttons act on.
   *
   * ⚠ IT DOES NOT CLEAR WHEN THE TAB IS OPENED, and that is the deliberate difference from every count in
   * this hook. Visiting the tab SHOWS you the question; it does not answer it. Clearing on sight would hide
   * a still-blocked turn the moment you switched away again — the badge exists precisely for the case where
   * you are not looking.
   *
   * ── ⚠ IT CHIMES, DELIBERATELY, AND ONLY ON THE EDGE ──────────────────────────────────────────
   *
   * An earlier version was deliberately silent, reasoning that a prompt raised by work the user just asked
   * for is not news and that one sound per shell command through an AI-DLC run would be the `execute_bash`
   * prompt-fatigue problem in another form.
   *
   * ⚠ AND THE OBJECTION HAD ALREADY WEAKENED, which is why it is not being re-argued. "Allow for this chat"
   * now grants shell for a whole conversation, so the run that produced five consecutive prompts produces
   * ONE — the flood the silence was protecting against is gone, and a blocked turn is exactly the thing
   * worth hearing about from another tab.
   *
   * ⚠ ON THE FALSE→TRUE EDGE, NOT ON EVERY EVENT. The dispatching effect fires on each
   * `permissionBySession` change, so two chats each raising a prompt would re-announce a state that was
   * already true. The ref makes the sound follow the TRANSITION.
   *
   * ⚠ AND NOT WHILE THE USER IS LOOKING AT IT, mirroring `onAiComplete` above: if the assistant tab is
   * already open the prompt is on screen and a sound adds nothing. The `notify_sound` preference gates it,
   * like every other chime here.
   */
  useEffect(() => {
    const onPending = () => {
      setAwaitingPermission((was) => {
        if (!was && viewRef.current !== "chat") {
          void (async () => {
            const soundPref = await api.getSetting("notify_sound");
            if (soundPref !== "false") playChime();
          })();
        }
        return true;
      });
    };
    const onResolved = () => setAwaitingPermission(false);
    window.addEventListener("ai:permission-pending", onPending);
    window.addEventListener("ai:permission-resolved", onResolved);
    return () => {
      window.removeEventListener("ai:permission-pending", onPending);
      window.removeEventListener("ai:permission-resolved", onResolved);
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    (async () => {
      meRef.current = await api.getSetting("user_id");
      if (disposed) return;
      await api.subscribeTeamEvents();
    })();

    api.onTeamEvent(async (evt: any) => {
      const surface = KIND_TO_VIEW[evt.kind];
      if (!surface) return;

      // Ignore events the current user caused themselves.
      if (meRef.current && evt.actorId === meRef.current) return;
      // Chat: only real text messages chime/badge (skip system/code).
      if (evt.kind === "message" && evt.type && evt.type !== "TEXT") return;

      // If the user is already looking at that surface, don't badge it.
      if (VIEW_FOR_APP[viewRef.current] === surface) {
        setCounts((c) => (c[surface] === 0 ? c : { ...c, [surface]: 0 }));
        return;
      }

      setCounts((c) => ({ ...c, [surface]: c[surface] + 1 }));

      const soundPref = await api.getSetting("notify_sound");
      if (soundPref !== "false") playChime();
    });

    return () => {
      disposed = true;
      api.removeTeamEventListeners();
    };
  }, []);

  return { counts, awaitingPermission };
}
