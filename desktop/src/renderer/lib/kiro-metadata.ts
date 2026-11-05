// ── ⚠ THE KIRO CONTEXT READING NOW LIVES IN `main/`, AND THIS RE-EXPORTS IT ───────────────
//
// The parser used to live HERE, and that is precisely why the figure never reached the portal. Kiro's
// `_kiro.dev/metadata` frame arrives on the ACP socket in the MAIN process; main forwarded it to the
// renderer, this module parsed it, and `KiroChatView` held the result in React state. So the only copy of
// the number lived in a component's memory: it could be drawn, and it could not be synced, because the
// process doing the syncing had never seen it.
//
// The implementation therefore moved to `main/kiro-metadata.ts`, next to the socket that produces it. The
// full rationale — what Kiro does and does not report, why only `contextUsagePercentage` is taken, and why
// the reading is clamped — is documented there.
//
// ⚠ THIS FILE STAYS as the renderer's import path. Every existing caller and test refers to
// `renderer/lib/kiro-metadata`, and the module is pure with no electron or node imports, so re-exporting it
// keeps one implementation rather than two copies of a validator that must agree.

export {
  readKiroContextUsage,
  shouldShowContextUsage,
  CONTEXT_NOTICE_THRESHOLD,
  type KiroContextUsage,
} from "../../main/kiro-metadata";
