import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const APP = strip(readFileSync(local("./App.tsx"), "utf8"));
const SWEEP = strip(readFileSync(local("../main/sync-sweep.ts"), "utf8"));

/**
 * THE LOGIN SCREEN STAYS QUIET.
 *
 * The chain was: `scheduleSweep("startup")` fires 5s after launch with no preconditions -> the sweep
 * pushes team-scoped AI-chat turns -> 403 (or "Not logged in") -> `notifySyncFailed` broadcasts
 * `sync:failed` to every window -> App raises a red toast -> and `ToastProvider` sits above the gates in
 * main.tsx, so it lands over the sign-in form.
 *
 * Fixed in two places, because they fail independently: main will not push without a session, and the
 * renderer will not interrupt someone who is not in the workspace.
 */
describe("main does not push without a signed-in session on a team", () => {
  it("the sweep checks every precondition before attempting anything", () => {
    expect(SWEEP).toMatch(/readSetting\("server_url"\)/);
    expect(SWEEP).toMatch(/readSetting\("auth_token"\)/);
    expect(SWEEP).toMatch(/readSetting\("team_id"\)/);
    /**
     * ⚠ A FOURTH PRECONDITION, AND THE OTHER THREE COULD NOT COVER IT. The login screen was still making
     * API calls: a session whose refresh has FAILED still has `auth_token`,
     * `team_id` and `server_url`, because those are cleared by an explicit sign-out and not by a 401. So
     * `!token` was satisfied, the sweep pushed at a credential already known dead, and every owed turn cost
     * a failed request and an alert. Presence is not usability; see session-liveness.ts.
     */
    expect(SWEEP).toMatch(/if \(!url \|\| !token \|\| !teamId \|\| !isSessionUsable\(\)\)/);
  });

  it("checks them BEFORE the retry loop, not inside it", () => {
    /**
     * Ordering is the fix. A check inside the loop would still attempt the first turn — and one toast is
     * all it takes to land on the login screen.
     */
    const guard = SWEEP.indexOf('readSetting("auth_token")');
    const loop = SWEEP.indexOf("retryMessageSync");
    expect(guard).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(guard, "the precondition must precede the retry import").toBeLessThan(loop);
  });

  it("reports the debt instead of marking rows failed", () => {
    // Burning the retry budget for a condition that resolves at sign-in would be worse than waiting.
    expect(SWEEP).toMatch(/return \{ \.\.\.empty, remaining \}/);
  });
});

describe("the renderer does not interrupt a pre-auth screen", () => {
  it("the sync:failed toast is gated on being in the workspace", () => {
    expect(APP).toMatch(/if \(!inWorkspaceRef\.current\) return;/);
  });

  it("the workspace test requires every gate, not just sign-in", () => {
    /**
     * `connected` alone is not enough: JoinTeamView and SelectAssistantView are also pre-workspace
     * screens, and a toast about chat sync makes no sense on either.
     */
    const test = APP.slice(
      APP.indexOf("inWorkspaceRef.current = Boolean("),
      APP.indexOf("useEffect(() => {\n    api.onSyncFailed")
    );
    for (const gate of ["platformConfigured", "connected", "teamJoined", "setupComplete"]) {
      expect(test, `${gate} must be part of the workspace test`).toContain(gate);
    }
  });

  it("⚠ AND THE ROUTING VERDICTS, which the stored gates alone cannot express", () => {
    /**
     * THE FIRST VERSION OF THIS FIX FAILED HERE, and only an empirical launch showed it. On a 403 every
     * stored gate still reads "signed in, on a team, set up" while the 401/403 routing has sent the user
     * to the SIGN-IN screen — so a test written against the stored gates passed and the red toast landed
     * on the login form anyway.
     *
     * The workspace test therefore has to ask what is RENDERED, not what is stored.
     */
    const test = APP.slice(
      APP.indexOf("inWorkspaceRef.current = Boolean("),
      APP.indexOf("useEffect(() => {\n    api.onSyncFailed")
    );
    expect(test).toContain("!needsSignIn");
    expect(test).toContain("!teamProblem");
  });

  it("derives those verdicts ONCE, so the gate and the router cannot disagree", () => {
    // Two copies of "is the team unreadable" would be two chances to drift.
    expect(APP.match(/const teamProblem =/g) ?? []).toHaveLength(1);
    expect(APP.match(/const needsSignIn =/g) ?? []).toHaveLength(1);
  });

  it("uses a ref, so the IPC listener is not torn down on every state change", () => {
    // Re-registering the listener whenever a gate flips would drop a failure arriving mid-swap.
    expect(APP).toMatch(/const inWorkspaceRef = useRef\(false\)/);
    const effect = APP.slice(APP.indexOf("api.onSyncFailed"), APP.indexOf("removeSyncFailedListeners"));
    expect(effect).not.toContain("teamJoined");
  });

  it("suppression is not silence — main still records every failure", () => {
    const sync = strip(readFileSync(local("../main/handlers/cli-sync.ts"), "utf8"));
    expect(sync).toMatch(/console\.warn\(`\[cli-assistant\] sync failed/);
  });
});
