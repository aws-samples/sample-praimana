// ── THE DESKTOP'S ADAPTER OVER THE SHARED TIME RULE ──────────────────────────────────────
//
// ⚠ THE RULE ITSELF NOW LIVES IN `@praimana/shared` (`constants/message-time.ts`). Read the
// header there for the SQLite/V8 zone bug these functions exist to prevent, and for what four
// divergent copies of this logic actually cost.
//
// This file used to BE the implementation, and its comment argued the portal's equivalent was
// "deliberately not imported from it, since that module is Next-side and this is an Electron
// renderer." That reason was sound when written and is now obsolete: `shared` is source-only
// (`main: ./src/index.ts`) and both front-ends already depend on it, so a pure function can be
// imported by a Next component and an Electron renderer alike.
//
// The file stays rather than being deleted, for two reasons:
//
//   1. ~20 call sites across AssistantChatView, KiroChatView, TeamChatView and GitPanel import from here, so
//      a re-export keeps the consolidation to one file instead of a rename across four.
//   2. It is where a DESKTOP-specific convention belongs if one is ever needed — this renderer's
//      inputs include SQLite's zone-less strings, which the portal's never do.
//
// Re-exported unchanged, so `parseStoredInstant` / `formatMessageInstant` / `formatClock` keep the
// exact signatures and the `null`-on-unusable contract every caller here already relies on.
// `messageDayLabel` is new here and is what TeamChatView's day separators render.

export {
  parseStoredInstant,
  formatClock,
  formatMessageInstant,
  messageDayLabel,
} from "@praimana/shared";
