// Single source of truth for the AI coding assistants a workshop can enable.
// Both the zod validation (admin tRPC workshop router) and the UI toggle lists
// (new-workshop + settings pages) derive from this so the set can never drift.

export interface AssistantDefinition {
  /** Stable identifier persisted on the workshop + validated server-side. */
  id: string;
  /** Display name shown in the admin UI and desktop app. */
  name: string;
  /** Icon path served from the admin app's /public. */
  img: string;
}

export const ASSISTANTS = [
  { id: "claude", name: "Claude Code", img: "/icons/claude.png" },
  { id: "kiro", name: "Kiro CLI", img: "/icons/kiro.png" },
  { id: "codex", name: "Codex", img: "/icons/codex.png" },
] as const satisfies readonly AssistantDefinition[];

/** Union of valid assistant ids, e.g. "claude" | "kiro" | "codex". */
export type AssistantId = (typeof ASSISTANTS)[number]["id"];

/** The valid ids as a tuple, for building a zod enum. */
export const ASSISTANT_IDS = ASSISTANTS.map((a) => a.id) as [AssistantId, ...AssistantId[]];

/** True if the given string is a known assistant id. */
export function isAssistantId(value: string): value is AssistantId {
  return ASSISTANTS.some((a) => a.id === value);
}
