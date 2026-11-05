// ── ⚠ HOW FULL THIS KIRO CONVERSATION IS ─────────────────────────────────────────────────
//
// Kiro chats were missing their context-usage percentage on the portal, which is why this now
// lives in MAIN rather than in the renderer. See the boundary note below.
//
// ── ⚠ KIRO REPORTS NO TOKENS. MEASURED, NOT ASSUMED. ──
//
// `kiro-cli acp --trust-all-tools` was probed directly (kiro-cli 2.18.1, ACP protocolVersion 1): full
// handshake, one real turn, every frame captured. The turn-end frame is the whole of it:
//
//     { "result": { "stopReason": "end_turn" } }
//
// No `session/update` variant carries usage — the only one Kiro emits for a reply is `agent_message_chunk`.
// So `chat_messages.input_tokens` and its siblings STAY NULL for Kiro, and the portal's coverage line
// ("measured over N of M replies") remains the honest report. Nothing here writes a token count.
//
// ── ⚠ WHAT IT DOES REPORT, AND WHY ONLY ONE FIELD IS USED ──
//
// A vendor extension, `_kiro.dev/metadata`, fires during and at the end of a turn:
//
//     { sessionId, contextUsagePercentage: 10.6659,
//       meteringUsage: [{ value: 0.17961, unit: "credit", unitPlural: "credits" }],
//       turnDurationMs: 2091 }
//
// Three real quantities; only `contextUsagePercentage` is taken, deliberately:
//
//   • `meteringUsage` is CREDITS — a billing unit, not a count. `computeTokenInsights` sums its column across
//     every thread regardless of provider, so 0.18 credits would land beside a 13.2M-token Codex turn. That is
//     the same incomparable-units problem that put the per-person table behind a flag (BACKLOG 9a). Parked.
//   • `turnDurationMs` is already measured by the app itself (`latencyMs`), so storing Kiro's copy would add a
//     second source of truth for a number we have.
//   • `contextUsagePercentage` needs NO cross-provider comparison to mean something. It answers a question a
//     participant can act on — is this chat close to needing a compact? — which is why it is the one worth
//     showing.
//
// ⚠ AND IT IS A `_kiro.dev/` VENDOR EXTENSION, not standard ACP: it can change without a protocol version
// bump. Hence every field is treated as optional and unrecognised shapes yield null rather than throwing.
//
// ── ⚠ WHY THIS MODULE IS IN `main/` AND NOT `renderer/lib/` ──
//
// Because the frame ARRIVES here. `kiro-acp.ts` owns the ACP socket; the renderer only ever sees what main
// chooses to forward. While the parser lived in the renderer, main had no reading to attach to the turn it
// was syncing — the number existed exclusively inside a React `useState` and reached the portal never. That
// was the reported bug, and it was a boundary mistake before it was a missing feature.
//
// `renderer/lib/kiro-metadata.ts` re-exports this module so every existing renderer import keeps working.
// This file imports NOTHING — no electron, no node — precisely so the renderer can bundle it unchanged.

/** The one field worth reading, already clamped and rounded for display. */
export interface KiroContextUsage {
  /** 0..100, rounded. */
  percent: number;
}

const METHOD = "_kiro.dev/metadata";

/**
 * Pull the context-fullness figure out of one ACP notification.
 *
 * @returns the reading, or `null` for any other notification and for any payload that does not carry a
 *          usable number — a missing figure must leave the previous one standing rather than zeroing it.
 */
export function readKiroContextUsage(method: string, params: unknown): KiroContextUsage | null {
  if (method !== METHOD || !params || typeof params !== "object") return null;
  const raw = (params as Record<string, unknown>).contextUsagePercentage;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  /**
   * ⚠ CLAMPED AT 100 AND ROUNDED. The probe returned 10.665900230407715 — sixteen significant figures for a
   * progress reading, and a percentage above 100 would be a Kiro bug rather than a conversation that is 140%
   * full. Presenting either verbatim would make the app look wrong for the agent's reasons.
   */
  return { percent: Math.min(100, Math.round(raw)) };
}

/**
 * Whether a reading is worth drawing at all.
 *
 * ⚠ QUIET UNTIL IT MATTERS. Every turn reports this, and a permanent "11% context" in the header is the same
 * noise the sync badge was just stripped of — an indicator that is always lit carries no information. It
 * appears once the conversation is full enough that compacting is a real consideration.
 *
 * ⚠ THIS GOVERNS THE DESKTOP HEADER ONLY, NOT WHAT IS STORED. Every reading is synced regardless: the portal
 * is read after the fact by someone reconstructing what happened, and "the conversation was 30% full" is a
 * fact they may want even though it needed no action at the time. Suppressing storage at the same threshold
 * as display would silently make the portal's history depend on a UI preference.
 */
export const CONTEXT_NOTICE_THRESHOLD = 60;

export function shouldShowContextUsage(usage: KiroContextUsage | null): boolean {
  return usage !== null && usage.percent >= CONTEXT_NOTICE_THRESHOLD;
}
