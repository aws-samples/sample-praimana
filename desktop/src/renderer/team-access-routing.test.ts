import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const APP = readFileSync(local("./App.tsx"), "utf8");
const SIGNIN = readFileSync(local("./components/SignInView.tsx"), "utf8");
const JOIN = readFileSync(local("./components/JoinTeamView.tsx"), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * WHERE A 401 OR A 403 SENDS THE USER.
 *
 * THE RULE: on a 401 or 403, do not sign the user in automatically. Show the sign-in page if the login
 * config is available; if it is missing, ask the user to sign in in the browser and open the desktop
 * from there.
 *
 * ⚠ AN EARLIER VERSION OF THIS FILE ASSERTED THE OPPOSITE — that a 403 routes to the JOIN screen and
 * never to sign-in — on the reasoning that a 403 means the token was accepted, so re-authenticating
 * cannot fix it. That reasoning is still true, and it is no longer the rule: a
 * 401 or a 403 shows the login page. The tests follow the decision, and the reasoning survives as the
 * thing `reauthTried` exists to handle.
 *
 * Asserted against source rather than by mounting App, which would need the whole Electron bridge and
 * ~40 IPC channels to observe one branch. The routing RULE is what matters and it is legible here.
 */
describe("a 401 or 403 routes to sign-in, with one pass only", () => {
  const code = strip(APP);

  it("sends a conclusive verdict to SignInView", () => {
    expect(code).toMatch(/if \(!connected \|\| needsSignIn\)/);
    expect(code).toMatch(/needsSignIn[\s\S]{0,200}return \(\s*<SignInView/);
  });

  it("treats 403, 404 and a surviving 401 as the conclusive set", () => {
    expect(code).toContain('teamAccessReason === "access-lost"');
    expect(code).toContain('teamAccessReason === "team-gone"');
    expect(code).toContain('teamAccessReason === "signed-out"');
  });

  it("never routes on an INCONCLUSIVE reason — a blip must not eject a room", () => {
    /**
     * `unavailable` and `busy` are not verdicts from the service. Treating a venue-wifi drop as "you
     * were removed from your team" would sign a whole workshop out mid-session.
     */
    for (const inconclusive of ["unavailable", "busy"]) {
      expect(
        new RegExp(`reason === "${inconclusive}"`).test(code),
        `${inconclusive} must not route the user anywhere`
      ).toBe(false);
    }
  });

  it("a probe that cannot run leaves the user where they are", () => {
    // "We could not ask" is not "you were removed".
    /**
     * ⚠ ENDED AT THE ASSISTANT-LABEL READ, NOT AT `setup_complete`. The old bound assumed the gates were
     * read one at a time with `setup_complete` last — which is exactly what made the assistant-selection
     * screen flash on every launch, since the render chain committed a half-loaded state at each `await`.
     * The four gates are batched ahead of this probe now, so `setup_complete` appears BEFORE it and the
     * old slice inverted to empty. The `length` guard is what caught that rather than the assertion
     * silently passing over nothing.
     */
    const probe = code.slice(
      code.indexOf("checkTeamAccess"),
      code.indexOf('api.getSetting("ai_assistant")')
    );
    expect(probe.length, "the slice must contain the probe").toBeGreaterThan(50);
    expect(probe).toMatch(/catch\s*\{[\s\S]*?setTeamAccessReason\(null\)/);
  });

  /**
   * ── ⚠ THE PROBE RUNS AFTER THE GATES ARE COMMITTED, AND THAT ORDER IS LOAD-BEARING ────────────
   *
   * The gates used to be read one at a time, so each `await` committed a partial state and the render
   * chain answered with whatever it had — landing on SelectAssistantView for the duration of this
   * network probe, which is the "few seconds". Batching them ahead of the probe is the fix, and this
   * pins the ordering so it cannot drift back.
   */
  it("⚠ reads every gate BEFORE the network probe, so no screen decision waits on the server", () => {
    const gates = code.indexOf('api.getSetting("setup_complete")');
    const probeAt = code.indexOf("checkTeamAccess");
    expect(gates, "the gate reads must exist").toBeGreaterThan(-1);
    expect(probeAt, "and so must the probe").toBeGreaterThan(-1);
    expect(gates, "a gate read after the probe is the reported bug").toBeLessThan(probeAt);
  });

  it("commits all four gates together, so the chain never sees a half-loaded state", () => {
    /**
     * One `Promise.all`, then four setters in one synchronous block — React batches those into a single
     * commit, so the blank guard opens straight onto the correct screen instead of three wrong ones.
     */
    const reads = code.slice(code.indexOf("Promise.all"), code.indexOf("setPlatformConfigured("));
    for (const key of ["connected", "team_joined", "setup_complete"]) {
      expect(reads, `${key} must be read in the batch`).toContain(key);
    }
    /**
     * ⚠ THE REGION IS THE FOUR SETTERS, NOT "up to the probe". A first version ran to `checkTeamAccess`
     * and caught that probe's OWN `await`, failing on correct code — the bound has to be the thing the
     * claim is about, which is that nothing splits the commit.
     */
    const commit = code.slice(
      code.indexOf("setPlatformConfigured("),
      code.indexOf("setSetupComplete(")
    );
    for (const setter of ["setConnected(", "setTeamJoined("]) {
      expect(commit, `${setter} must be set with the others`).toContain(setter);
    }
    expect(commit, "an await between the setters would split React's batch").not.toContain("await");
  });

  it("clears the verdict when the app is not on a team at all", () => {
    expect(code).toMatch(/else \{\s*setTeamAccessReason\(null\);\s*\}/);
  });
});

describe("the loop escape, which is what makes the instruction safe", () => {
  const code = strip(APP);

  it("gives a team problem exactly ONE pass at signing in", () => {
    /**
     * ⚠ THE CONSEQUENCE THAT HAD TO BE ENGINEERED AROUND. A 403 means the gateway ACCEPTED the token,
     * so a fresh sign-in SUCCEEDS and the team is refused again. Without this, "403 → sign-in" is a
     * closed loop: sign in, succeed, land back on sign-in, for ever.
     */
    expect(code).toMatch(/teamProblem && !reauthTried/);
    expect(code).toMatch(/if \(teamProblem\) setReauthTried\(true\)/);
  });

  it("marks the attempt BEFORE re-checking, or the escape never fires", () => {
    // Ordering is the whole mechanism: checkState() runs the probe again, and if the flag were set
    // after it, the still-refused team would route back to sign-in.
    const onComplete = code.slice(code.indexOf("onComplete={() => {"), code.indexOf("if (!teamJoined"));
    expect(onComplete).toMatch(/setReauthTried\(true\);[\s\S]*checkState\(\)/);
  });

  it("hands a still-refused team to the join screen afterwards", () => {
    expect(code).toMatch(/if \(!teamJoined \|\| teamProblem\)/);
    expect(code).toMatch(/teamProblem[\s\S]{0,300}<JoinTeamView/);
  });

  it("gives a 401 NO escape hatch, because signing in is genuinely the fix for it", () => {
    // `signed-out` must not be in the teamProblem set — bouncing back to sign-in is correct there.
    expect(code).toMatch(
      /teamProblem =\s*teamAccessReason === "access-lost" \|\| teamAccessReason === "team-gone"/
    );
  });
});

describe("the missing-config case is handled by the gate ABOVE this one", () => {
  const code = strip(APP);

  it("PlatformSetupView still precedes SignInView", () => {
    /**
     * Asking the user to sign in in the browser and open the desktop when the login config is missing —
     * that screen is
     * `PlatformSetupView`, and it already sits ahead of the sign-in gate, so a missing config is
     * answered before any 401/403 verdict is consulted. Nothing new was needed; the order is the
     * feature, so it is pinned.
     */
    const setup = code.indexOf("<PlatformSetupView");
    const signin = code.indexOf("<SignInView");
    expect(setup).toBeGreaterThan(-1);
    expect(signin).toBeGreaterThan(-1);
    expect(setup, "PlatformSetupView must be reached first").toBeLessThan(signin);
  });
});

describe("the user is told why they are there", () => {
  it("SignInView takes an optional notice and renders it", () => {
    expect(strip(SIGNIN)).toMatch(/notice\?: string/);
    expect(strip(SIGNIN)).toMatch(/\{notice &&/);
  });

  it("JoinTeamView still takes one, for the post-reauth case", () => {
    expect(strip(JOIN)).toMatch(/notice\?: string/);
    expect(strip(JOIN)).toContain("{noticeBlock}");
  });

  it("the 403 notice warns that a re-join may follow", () => {
    // Signing in successfully and THEN being sent somewhere else is baffling without the warning.
    expect(APP).toMatch(/if the same thing happens afterwards/i);
  });

  it("the post-reauth notice says the sign-in worked", () => {
    // So the user does not conclude their credentials are the problem.
    expect(APP).toMatch(/signed in successfully/i);
  });

  it("no notice is shown on a first, chosen sign-in", () => {
    // `connected` is false on a genuine first run, so the notice is suppressed there.
    expect(strip(APP)).toMatch(/needsSignIn && connected/);
  });
});
