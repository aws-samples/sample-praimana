// ── DID THIS MESSAGE REACH THE TEAM? ─────────────────────────────────────────────────────
//
// A one-line footer inside a message, and a retry when the answer is no.
//
// ⚠ IT EXISTS BECAUSE THE ANSWER USED TO BE UNKNOWABLE FROM THE APP. Two sync failures both looked like
// nothing at all: the sync sent an ID token that expires after 30 minutes, so every push half an hour
// into a session 401'd; and a stopped turn pushed neither half, so the participant's own question was
// missing from the portal while sitting in their local database. The only evidence either time was a
// line in a console log.
//
// ── ⚠ WHAT IT MAY AND MAY NOT CLAIM ──
//
// `synced` is the ONLY affirmative state, and it is written from the server's own acknowledgement. There
// is deliberately no "probably fine": an unknown row (`sync_status IS NULL`, i.e. written before the
// column existed) renders NOTHING rather than a reassuring tick, because a tick on an unverified row is
// the exact lie this component was built to stop telling.

import { useState } from "react";
import { IconTooltip } from "./IconTooltip";

/** The same accessor every other renderer component uses — the preload bridge is untyped by design. */
const api = (window as unknown as {
  electronAPI: {
    retryMessageSync: (id: string) => Promise<{ retried: boolean; status?: "pending" | "synced" | "failed" }>;
  };
}).electronAPI;

/** Mirrors the `sync_status` CHECK constraint in migration 11. `null` means unknown — see above. */
export type MessageSyncStatus = "pending" | "synced" | "failed" | null | undefined;

export function SyncBadge({
  status,
  messageId,
  /** Light-theme container (Codex's own bubble is terracotta) needs lighter ink than the dark surfaces. */
  onLight = false,
  onRetried,
}: {
  status: MessageSyncStatus;
  messageId: string;
  onLight?: boolean;
  onRetried?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MessageSyncStatus>(undefined);

  // The retry's own answer wins over the row we were handed, so the badge changes the moment it works
  // rather than waiting for the parent to re-read the database.
  const shown = result ?? status;

  /**
   * ── ⚠ UNKNOWN OFFERS A PUSH, BUT NEVER A TICK ────────────────────────────────────────
   *
   * A row written before migration 11 carries no status. The first version of this returned `null` for
   * that case, reasoning that a tick would claim delivery nobody verified and a retry would invite
   * pushing a turn that is probably already there.
   *
   * The first half is right and stands — there is still no affirmative state here. The second half was
   * wrong, and the cost was concrete: 12 of 14 messages on one real machine had been lost to the
   * 401, every one of them written before the column existed, so the fix shipped with those exact
   * messages unrecoverable through the UI. "Don't claim what we didn't verify" had quietly become
   * "don't offer to fix what we know is broken".
   *
   * ⚠ AND RE-PUSHING AN ALREADY-DELIVERED TURN IS NOW HARMLESS, which it was not when that decision was
   * made. The messages always converged on `clientTurnId`; the activity EVENT did not, so a redundant
   * push inflated `aiTurns`. That is closed (`dedupeKey`), so the only remaining cost of a needless
   * press is one request.
   *
   * The wording carries the uncertainty instead: "Sync", not "Not synced" — we do not know that it
   * failed, only that nothing here recorded that it worked.
   */
  /**
   * ── ⚠ ONE SYNC GLYPH, THREE COLOURS ────────────────────────────────────────────────────
   *
   * So every state now draws the SAME ↻ and differs only in colour — green delivered, amber in flight, red
   * refused. The first version used a distinct glyph per state (✓ / ↻ / !) precisely so the meaning did not
   * rest on hue; that was overridden deliberately and it is worth being clear about the cost.
   *
   * ⚠ WHAT REPLACES THE SHAPE CUE. The `title` and the `sr-only` sentence both name the state in words, so a
   * screen-reader user is unaffected and a sighted user can hover to read it. What is genuinely lost is the
   * at-a-glance distinction for someone who cannot separate the three hues — for them the icon says "sync"
   * and the tooltip says which. That is a deliberate choice, made twice; do not silently revert it, and do not
   * remove the tooltip or the `sr-only` text, which are the only remaining non-colour cues.
   *
   * ⚠ AND THE COLOURS ARE STILL DROPPED ON THE TERRACOTTA BUBBLE, measured: against `brand-strong`
   * (#a8432c) the palette reads ok 3.00:1, warning 3.46:1, error-text **2.44:1** — the red is below WCAG
   * 1.4.11's 3:1 floor and it is the state that matters most. White is 5.99:1 there. On that one surface the
   * tooltip carries the whole message, because a red nobody can see carries none of it.
   */
  const failed = shown === "failed";
  const pending = shown === "pending";

  /**
   * ── ⚠ A SYNCED MESSAGE SHOWS NOTHING AT ALL ──
   *
   * This used to render a green ↻ — a STATIC SPAN, not a control, the only state with nothing to press. It
   * was on 88% of the rows in one real database (98 of 112), so the badge was almost always saying "fine" and offering
   * nothing. An indicator that is always lit carries no information; it is noise in proportion to how well
   * the system is working.
   *
   * ⚠ THE CORNER RESERVATION STAYS THOUGH — `pr-9` in `AssistantChatView` and `KiroChatView` is deliberately NOT
   * conditional on this. If the padding shrank when the badge vanished, every message would re-flow its text
   * the instant its sync completed (pending → synced), a visible jump on every single turn. 28px of unused
   * width is the cheaper trade.
   *
   * ⚠ AND SILENCE HERE IS NOT AN ASSERTION OF SUCCESS. `unknown` still renders its push control, so "no icon"
   * means synced specifically — not "either fine or unrecorded". The conversation header carries the
   * outstanding count; see lib/sync-summary.ts for what may honestly be counted there.
   */
  if (shown === "synced") return null;

  /**
   * ── ⚠ AND A ROW THAT IS MERELY IN FLIGHT IS SILENT TOO ──
   *
   * Both halves of every turn go `pending` the moment they are written, so the icon appeared on each of them
   * for the duration of the push — which is the noise the previous change set out to remove, just relocated
   * from "always" to "every time you say anything".
   *
   * ⚠ NOTHING IS LOST BY HIDING IT, and that is what makes this safe rather than merely quieter. `pending` is
   * not a resting state in the live path: `syncCliTurn` stamps `synced` or `failed` when the push resolves,
   * under a timeout. A row can only STAY pending if the app died mid-push — and `sync-sweep` re-pushes
   * anything pending or failed and older than two minutes at the next start. Every outcome that matters still
   * surfaces, as `failed`.
   *
   * ⚠ `result === undefined` IS THE WHOLE CONDITION, and without it this would be a worse bug than the one it
   * fixes: pressing retry sets `result` to "pending", so a blanket hide would delete the button from under
   * the pointer at the moment it was clicked. A retry in progress keeps its control and its spinner; only the
   * row's OWN stored pending is silent.
   */
  if (shown === "pending" && result === undefined) return null;

  /**
   * ⚠ EVERY OTHER STATE OFFERS A PUSH, and they do not say the same thing. `pending` may still be in flight
   * — a turn syncs moments after it ends — `failed` means the server refused it, and an absent status means
   * the row predates the column. Pressing is harmless in all three (the turn converges on `clientTurnId`),
   * so the control is offered rather than making someone judge which state they are looking at.
   */
  return (
    <SyncAction
      messageId={messageId}
      onLight={onLight}
      onRetried={onRetried}
      tone={
        onLight
          ? "text-white"
          : failed
            ? "text-tool-error-text"
            : pending
              ? "text-tool-warning"
              : "text-surface-muted"
      }
      /*
        ⚠ SHORT, BECAUSE THE BUBBLE DOES NOT WRAP. The tooltips were very long: these read 61 and 79
        characters, and `IconTooltip` draws `whitespace-nowrap` — so the untracked state produced a bubble
        roughly 420px wide, hanging off a 24px icon. The sentences were accurate and useless.

        ⚠ THE UNTRACKED WORDING STILL AVOIDS "not synced", which is the part not to lose while trimming:
        nothing recorded whether that row arrived, so claiming it did not would be inventing a failure. "Not
        tracked" says exactly what is known. The full explanation lives in the `sr-only` sentence and in this
        file, where length costs nothing.
      */
      title={
        failed ? "Not synced — retry" : pending ? "Syncing…" : "Not tracked — push"
      }
      setResult={setResult}
      busy={busy}
      setBusy={setBusy}
    />
  );
}

/**
 * The push control, shared by the "unknown" and "not synced" states.
 *
 * ⚠ EXTRACTED RATHER THAN COPIED. Both states do the same thing — call the same IPC, spin, report the
 * outcome — and differ only in wording. Two copies would let the busy handling, the error handling or the
 * accessible name drift, and this is the control someone reaches for precisely when the app has already
 * failed them once.
 */
function SyncAction({
  messageId,
  onLight,
  onRetried,
  tone,
  title,
  setResult,
  busy,
  setBusy,
}: {
  messageId: string;
  onLight: boolean;
  onRetried?: () => void;
  /** The ink class, already chosen for the surface this sits on. */
  tone: string;
  title: string;
  setResult: (s: MessageSyncStatus) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  async function push() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.retryMessageSync(messageId);
      /**
       * `retried: false` means the message has no rebuildable turn — an orphan assistant row, or an id
       * the transcript no longer holds. Reported as failed rather than left looking pending, because
       * pressing again will not change it.
       */
      setResult(res.retried ? (res.status ?? "failed") : "failed");
      onRetried?.();
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <IconTooltip label={busy ? "Syncing now" : title}>
    <button
      type="button"
      onClick={push}
      disabled={busy}
      aria-label={title}
      title={title}
      /*
        ⚠ A HIT TARGET, NOT JUST A GLYPH. An 11px character is a ~7px wide click target, so the padding is
        what makes this pressable — and it is the control someone reaches for precisely when the app has
        already failed them once. The focus ring stays for the same reason.
      */
      /* 24×24 target around an 11px glyph, and `-my-1.5` so it overhangs the row rather than growing it.
         See the note in `CopyButton` — this is WCAG 2.2 SC 2.5.8, and it is a real control so it applies. */
      className={`inline-flex h-6 w-6 -my-1.5 items-center justify-center rounded text-[16px] leading-none transition-colors focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:opacity-50 ${tone} ${
        onLight ? "hover:underline" : "hover:bg-surface-raised"
      }`}
    >
      <span aria-hidden="true" className={busy ? "inline-block animate-spin" : "inline-block"}>
        ↻
      </span>
      {/* The tooltip is not reachable by keyboard or screen reader; this sentence is. */}
      <span className="sr-only">{busy ? "Syncing now" : title}</span>
    </button>
    </IconTooltip>
  );
}
