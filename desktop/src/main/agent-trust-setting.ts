/**
 * ── ⚠ MAY THE AGENT WRITE FILES WITHOUT ASKING? ───────────────────────────────────────────────
 *
 * ⚠ THE DEFAULT IS UNCHANGED, AND THAT IS THE POINT. kiro-trust.ts argues at length, with measurements
 * against a real kiro-cli, why `fs_write` is pre-approved: it is the tool an AI coding session exists to
 * use, prompting on every write is a workshop-stopping regression, and the second-order effect is that
 * people learn to click Allow without reading. None of that is weakened by the finding, which is about
 * the absence of a CHOICE rather than about the default being wrong. So this adds the choice and leaves
 * the default alone.
 *
 * ── ⚠ WHY THIS IS NOT A `db:setSetting` KEY ──
 *
 * Because the renderer must not be able to turn it back ON.
 *
 * The asymmetry is what decides it. Writing `false` narrows what the agent may do, so a renderer that
 * could only ever do that would be harmless. Writing `true` RE-GRANTS a permission the participant has
 * explicitly withdrawn — and renderer-resident code is the actor this whole finding is scoped against,
 * so a key it can write is a decision it can undo. `telemetry_enabled` is the cautionary example: it IS
 * renderer-writable, and the telemetry finding's own text observes that "the same renderer code can turn
 * the log on before writing to it".
 *
 * So the key is readable by the renderer (Settings has to render the current state) and absent from
 * `RENDERER_WRITABLE_SETTINGS`. It changes through one dedicated IPC channel, the way the tenant keys
 * and the platform keys do.
 *
 * ⚠ AND IT IS NOT CLEARED ON SIGN-OUT. A preference about how the agent behaves on this machine is not
 * session state, and a participant who declined write pre-approval has not un-declined it by signing
 * out — resetting it would silently re-grant on the next sign-in, which is the exact shape of the
 * problem this setting exists to fix.
 */

import { readSetting, writeSetting } from "./database";

export const AGENT_TRUST_FS_WRITE_KEY = "agent_trust_fs_write";

/**
 * Whether file writes run without asking.
 *
 * ⚠ ABSENT MEANS TRUE, and the asymmetry is deliberate — the same reasoning `isUserDeactivated` states
 * in shared/types/user.ts. Every install predating this setting has no row, and reading those as `false`
 * would silently impose prompt-on-every-write on every existing participant, which is precisely the
 * regression kiro-trust.ts refuses to cause. Only an explicit `"false"` withdraws it.
 */
export function agentMayWriteFilesUnprompted(): boolean {
  return readSetting(AGENT_TRUST_FS_WRITE_KEY) !== "false";
}

/**
 * Record the participant's choice.
 *
 * Stored as the string `"true"`/`"false"` rather than by omission, so "chosen and left on" is
 * distinguishable from "never asked" in the settings table — a distinction anybody reading the row later
 * will want, even though `agentMayWriteFilesUnprompted` treats them alike.
 */
export function setAgentMayWriteFilesUnprompted(allowed: boolean): void {
  writeSetting(AGENT_TRUST_FS_WRITE_KEY, allowed ? "true" : "false");
}
