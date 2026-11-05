// ── ⚠ A FAILED FRAMEWORK INSTALL MUST NOT STRAND THE PARTICIPANT ─────────────────────────────
//
// SelectAssistantView threw on `result.error`. The throw landed in the catch at the bottom of
// handleSubmit, which sets an error and stops — so `addProject`, `setSetting("setup_complete")`
// and `onComplete()` were all skipped, and the participant sat on the first screen of a timed
// workshop with no way forward. A mistyped `distDir` in the facilitator's setupConfig does it, and
// so does any transient download failure: a private repo, a captive portal, GitHub being slow.
//
// The framework is an ACCELERATOR, not a precondition — the project is a folder and an assistant,
// and both are already chosen by this point.
//
// ⚠ ASSERTED AGAINST SOURCE, WHICH IS THE IDIOM THIS DIRECTORY ALREADY USES (see
// framework-setup-blocker.test.ts). There is no renderer harness here, and the claims worth pinning
// are structural: that the throw is gone, that the flow continues, and that the participant is told
// to set up by hand. A render test would pin the pixels and miss all three.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const src = readFileSync(local("./components/SelectAssistantView.tsx"), "utf8");

describe("a framework install failure is reported, not raised", () => {
  it("⚠ does NOT throw on result.error — the regression this file exists for", () => {
    // The exact line that stranded the participant. `throw new Error(result.error)` anywhere in
    // this file means the catch at the bottom runs and setup stops.
    expect(src).not.toMatch(/throw new Error\(\s*result\.error\s*\)/);
  });

  it("holds the failure in state instead", () => {
    expect(src).toContain("const [frameworkFailed, setFrameworkFailed] = useState(\"\")");
    expect(src).toContain("setFrameworkFailed(result.error)");
  });

  it("clears the busy state so the form is usable again", () => {
    // Without these the button stays disabled on `loading` and the spinner row stays up, which is
    // stranding by a different route.
    const branch = src.slice(src.indexOf("setFrameworkFailed(result.error)"));
    expect(branch).toContain("setLoading(false)");
    expect(branch).toContain('setSetupStep("")');
  });

  it("⚠ tells the participant to set up by hand, and points at the instructions", () => {
    // The whole ask was "an error specifying to setup manually". A message that only says the
    // install failed leaves them stuck for a different reason.
    expect(src).toMatch(/set the project up by hand/i);
    expect(src).toContain("setupInstructions ?");
  });

  it("fetches the setup instructions BEFORE the install, so the message can cite them", () => {
    // Ordering, not presence: the warning's text branches on `setupInstructions`, so instructions
    // fetched after the failure would render the "ask your facilitator" fallback every time.
    expect(src.indexOf("api.getSetupInstructions()")).toBeLessThan(
      src.indexOf("api.frameworkInstall(")
    );
  });

  it("⚠ does not retry the failed install on the next submit", () => {
    // A facilitator's bad distDir fails identically every time. Re-downloading on the second click
    // would make a deliberate "continue" look like a broken button.
    expect(src).toContain("const check = frameworkFailed");
    expect(src).toContain("if (frameworkFailed) {");
  });

  it("changes the button label, so continuing is informed rather than a retry", () => {
    expect(src).toContain("Continue without automatic setup");
  });

  it("⚠ still reaches project creation and completion after a failure", () => {
    // The point of the change. These three are what the old throw skipped; all must sit AFTER the
    // failure branch, on the path a failed install now falls through to.
    const after = src.slice(src.indexOf("setFrameworkFailed(result.error)"));
    for (const call of ["api.addProject(", 'setSetting("setup_complete"', "onComplete()"]) {
      expect(after, `${call} must still run after a failed install`).toContain(call);
    }
  });

  it("keeps the warning distinct from the fatal error banner", () => {
    // `error` stops setup; `frameworkFailed` does not. Rendering them identically would tell a
    // participant the same thing about two opposite outcomes.
    expect(src).toContain('role="status"');
    expect(src).toMatch(/Automatic project setup did not finish/);
  });
});

// ── ⚠ BACK TO TEAM SELECTION, AND THE TENANT KEY IT MUST NOT TOUCH ───────────────────────────
//
// WHY THERE IS A BACK BUTTON on the assistant selection screen: there was none, because nobody had
// added one. JoinTeamView, the gate immediately before, has had "← Back to sign in" all along, so a
// participant who picked the wrong team could only escape this screen by finishing setup.
//
// The security-relevant half is WHICH setting it clears. setting-access.ts puts `team_joined` in
// RENDERER_WRITABLE_SETTINGS as screen gating and names this view as an expected writer, while
// `team_id` is readable-only because it is a tenant key main owns — the allowlist records that a
// renderer-writable `team_id` let any code in the bundle re-point the tenant for every team-scoped
// request, including the one that publishes a private transcript. A back button that cleared it
// would reopen that.
describe("the back button leaves by un-setting its own gate", () => {
  const access = readFileSync(local("../main/setting-access.ts"), "utf8");
  const writable = access.slice(
    access.indexOf("RENDERER_WRITABLE_SETTINGS"),
    access.indexOf("SIGN_OUT_SETTINGS")
  );
  /** Entries only — the writable block's prose mentions "team_id" in a warning about it. */
  const writableEntries = new Set(
    writable
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^"[a-z_]+",$/.test(l))
      .map((l) => l.slice(1, -2))
  );

  it("exists at all", () => {
    expect(src).toContain("async function handleBack()");
    expect(src).toContain("← Back to team selection");
  });

  it("clears team_joined, which is the gate that routes here", () => {
    expect(src).toContain('api.setSetting("team_joined", "false")');
    expect(src).toContain("onComplete()");
  });

  it("⚠ never writes team_id — it is a tenant key and main owns it", () => {
    expect(src).not.toContain('setSetting("team_id"');
  });

  it("⚠ and the allowlist still agrees: team_joined writable, team_id not", () => {
    // Pins the premise rather than the code. If team_id were ever added to the writable set, the
    // reasoning in handleBack's comment would be stale and this fails rather than going unnoticed.
    expect(writableEntries.has("team_joined")).toBe(true);
    expect(writableEntries.has("team_id")).toBe(false);
  });

  it("is disabled mid-setup, so a half-applied write cannot be walked away from", () => {
    const btn = src.slice(src.indexOf("← Back to team selection") - 600);
    expect(btn).toContain("disabled={loading}");
  });

  it("⚠ is still usable after a failed install, because that path clears loading", () => {
    // The one case where this screen holds `loading` and the participant DOES want out. If the
    // failure branch stopped clearing it, back would be dead exactly when it is needed.
    const branch = src.slice(src.indexOf("setFrameworkFailed(result.error)"));
    expect(branch).toContain("setLoading(false)");
  });
});
