// ── ⚠ THE CHOOSER MUST REPLACE THE APP, NOT RENDER INSIDE IT ───────────────────────────────
//
// In chooser mode the main process has opened NO DATABASE and registered only the `profile:*` channels (see
// the early return in `index.ts`). So `<App />` must not mount: it calls `getSetting`, `getProjects` and the
// rest immediately, against handlers that do not exist in that mode.
//
// ⚠ AND THE PRELOAD BRIDGE IS TYPED `any`, so none of that would fail at compile time. It would fail as an
// empty window with an error in a log nobody is watching — which is why the gate is asserted here rather than
// left to the type-checker.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const main = strip(readFileSync(join(__dirname, "main.tsx"), "utf8"));
const chooser = strip(readFileSync(join(__dirname, "components", "ProfileChooser.tsx"), "utf8"));
const app = strip(readFileSync(join(__dirname, "App.tsx"), "utf8"));

describe("⚠ the chooser is gated at the ROOT, swapping App out entirely", () => {
  it("reads the mode from the URL the main process set", () => {
    expect(main).toContain('params.get("chooser") === "1"');
    expect(main).toContain('params.get("mustCreate") === "1"');
  });

  /**
   * ⚠ A TERNARY, NOT A SIBLING. Rendering both would mount `App` alongside the picker and defeat the whole
   * point — `App`'s effects would fire against absent handlers.
   */
  it("renders the chooser INSTEAD of App, never beside it", () => {
    expect(main).toMatch(/showChooser \? <ProfileChooser[^>]*\/> : <App \/>/);
  });
});

describe("⚠ the chooser only uses channels that exist without a database", () => {
  /**
   * The allowlist IS the contract: `profile:*` are the only handlers registered in chooser mode. A call to
   * anything else here is a runtime failure on the first screen a new user ever sees.
   */
  it("touches no API beyond the four profile channels", () => {
    const calls = [...chooser.matchAll(/\bapi\.([A-Za-z]+)\s*\(/g)].map((m) => m[1]);
    expect(calls.length, "sanity: it does call the bridge").toBeGreaterThan(0);
    for (const call of new Set(calls)) {
      expect(
        ["profileList", "profileCreate", "profileOpen", "profileOpenWindow"],
        `api.${call} is not available without a database`
      ).toContain(call);
    }
  });

  /**
   * ── ⚠ WHICH MECHANISM, AND THE `newWindow` FLAG THAT DECIDES ─────────────────────────────
   *
   * ⚠ IT MUST STILL REPLACE ON THE LAUNCH PATH. That process holds the lock for the ROOT userData, so
   * spawning "Default" from the launch screen would make the child fail the lock and quit while the picker
   * merely focused itself — the picker would appear to do nothing. Both branches must therefore exist, and
   * `newWindow` must be what selects between them.
   */
  it("spawns a new window from a running app and REPLACES on the launch path", () => {
    expect(chooser, "both mechanisms are reachable").toContain("profileOpenWindow");
    expect(chooser).toContain("profileOpen(");
    expect(chooser, "and the flag chooses between them").toMatch(
      /newWindow \? await api\.profileOpenWindow\(id\) : await api\.profileOpen\(id\)/
    );
  });

  /**
   * ── ⚠ IT ASKS WHETHER THIS PROCESS SURVIVED; IT DOES NOT INFER IT FROM `newWindow` ──────────────
   *
   * This case used to assert `if (newWindow) onCancel?.()` — the very rule that was wrong, so it would have
   * blocked the fix rather than caught the bug. Recorded because a test can encode a defect as a
   * requirement, and this one did, twice over:
   *
   * `newWindow` describes what was REQUESTED. `replaced` is main reporting what HAPPENED, and they differ in
   * a dev build, where `relaunchInto` spawns rather than exiting so the vite server survives. So the rule is
   * asserted at BOTH call sites now — a rule enforced at one of two doors is not a rule.
   */
  it("⚠ dismisses whenever this process survived, on BOTH the open and create paths", () => {
    const occurrences = chooser.match(/newWindow \|\| result\?\.replaced === false/g) ?? [];
    expect(
      occurrences.length,
      "the launch path and the create path must both ask, not infer"
    ).toBe(2);
    expect(chooser, "inferring from newWindow alone is the defect").not.toMatch(
      /if \(newWindow\) onCancel\?\.\(\)/
    );
  });

  /**
   * ⚠ AND THE LAUNCH SCREEN HAS NOWHERE TO DISMISS TO. `onCancel` is absent in chooser mode (main.tsx renders
   * no cancel — there is no app behind it), so clearing the spinner alone would return the reader to a create
   * form that has already succeeded. It has to say what happened instead.
   */
  it("tells the launch window it is finished when the new profile opened alongside", () => {
    expect(chooser).toContain("setOpenedElsewhere");
    expect(chooser).toContain("is open in a new window");
    expect(chooser, "and names why a dev build behaves this way").toMatch(/dev server/i);
  });

  /**
   * ⚠ AND MAIN CLOSES THE CHOOSER WINDOW ITSELF ON darwin, so the message above is the FALLBACK rather than
   * the normal end state.
   *
   * The platform guard is the whole correctness argument: `window-all-closed` calls `app.quit()` everywhere
   * except darwin, and that exit is precisely what the dev-spawn branch exists to avoid — it would stop vite
   * and leave the child loading `localhost:5173` against nothing. So closing is darwin-only, and it is scoped
   * to the launch chooser, because a running app's window has a session behind it that `activate` would
   * rebuild on the OLD profile.
   */
  it("closes the launch chooser once the profile opened alongside — darwin only", () => {
    const index = strip(readFileSync(join(__dirname, "..", "main", "index.ts"), "utf8"));
    const handler = index.slice(index.indexOf('"profile:create"'), index.indexOf('"profile:open"'));

    expect(handler).toContain('process.platform === "darwin"');
    expect(handler, "only when this process survived").toContain("!replaced");
    expect(handler, "and only with nothing behind the window").toContain("launch.showChooser");
    expect(handler).toContain("win.close()");
  });

  /** Main has to report it, or there is nothing for the renderer to ask. */
  it("main reports whether profile:create replaced this process", () => {
    const index = strip(readFileSync(join(__dirname, "..", "main", "index.ts"), "utf8"));
    const handler = index.slice(index.indexOf('"profile:create"'), index.indexOf('"profile:open"'));
    expect(handler).toContain("replaced = relaunchInto(id)");
    expect(handler).toContain("return { created: id, replaced }");
  });

  /** The profile already on screen is not somewhere to go. */
  it("disables the current profile in the list", () => {
    expect(chooser).toMatch(/disabled=\{launching \|\| p\.id === current\}/);
  });

  /**
   * ⚠ THE HONESTY LINE STAYS. This is the screen where someone concludes a profile is private, and it is not:
   * one OS user, one keychain, mutually readable files. If a later edit removes this, the feature becomes a
   * misleading one rather than merely a convenient one.
   */
  it("says that profiles are not private", () => {
    expect(chooser).toMatch(/not private/i);
    expect(chooser, "and points at what does give separation").toMatch(/separate computer logins/i);
  });

  /** No escape at launch: the app behind this screen has no database, so cancelling would strand the user. */
  it("offers Cancel only when shown over a running app", () => {
    expect(chooser).toMatch(/onCancel && \(/);
  });
});

/**
 * ── ⚠ THE PROFILE BESIDE THE TRAFFIC LIGHTS ───────────────────────────────────────────────
 *
 * ⚠ THIS EXISTS BECAUSE `setTitle` IS INVISIBLE HERE. `titleBarStyle: "hiddenInset"` hides the native title
 * bar and leaves only the traffic lights over the app's own content, so the window title main sets reaches the
 * Window menu, Mission Control and ⌘-Tab and NOTHING on the window. The renderer's own strip is the only part
 * of this window adjacent to those buttons.
 */
describe("⚠ the title strip names this window's profile", () => {
  const app = strip(readFileSync(join(__dirname, "App.tsx"), "utf8"));

  it("renders the label, not the folded directory id", () => {
    /* On disk: `avengerspraimana-starkstack`. In profile.json: "Avengers Praimana-Stark Stack". */
    expect(app).toMatch(/\{profileLabel\}/);
    expect(app, "the label comes from the profile list, matched on `current`").toMatch(
      /p\.id === r\.current/
    );
  });

  /**
   * ⚠ THE OS OWNS THE FIRST 92 PIXELS. close/minimise/zoom are drawn there; anything placed under them is
   * unreadable and unclickable.
   */
  it("clears the macOS traffic-light inset", () => {
    expect(app).toMatch(/left-\[92px\]/);
  });

  /**
   * ⚠ AND THE SEARCH BAND MOVES OUT OF ITS WAY. Both pinned at the same inset would overlap, and the label is
   * the one that cannot be relocated — it has to sit beside the window buttons to mean what it says.
   */
  it("shifts the centred search band when a label is present", () => {
    /**
     * The band must clear the profile chip rather than sit under it. This asserted two literals
     * (`left: profileLabel ? 292 : 92`), which broke when the chip was widened to 300px — and the literal
     * `292` was itself the bug waiting to happen: its own comment described it as "the label's max-w plus
     * its padding and a gap", a derivation kept only in prose.
     *
     * So the assertion now pins the DERIVATION, which is the thing that must stay true.
     */
    expect(app).toMatch(/left: profileLabel \? SEARCH_LEFT_WITH_PROFILE : TRAFFIC_LIGHT_INSET_PX/);
    expect(app).toMatch(/const SEARCH_LEFT_WITH_PROFILE =\s*\n?\s*TRAFFIC_LIGHT_INSET_PX \+ PROFILE_CHIP_MAX_PX \+ PROFILE_CHIP_GUTTER_PX/);
  });

  it("the chip and the offset share ONE width, so they cannot drift apart", () => {
    // Widening the chip while leaving the offset behind would slide the search field under the name.
    expect(app).toMatch(/style=\{\{ maxWidth: PROFILE_CHIP_MAX_PX \}\}/);
    expect(app).toMatch(/const PROFILE_CHIP_MAX_PX = 300;/);
  });

  /**
   * ⚠ NOTHING FOR THE DEFAULT INSTALL. `current` is the reserved `default` sentinel there and has no entry in
   * the list, so the label stays null — a permanent "Default" chip beside the window controls would be
   * furniture carrying no information.
   */
  it("shows nothing when there is no named profile", () => {
    expect(app).toMatch(/\{profileLabel && \(/);
    expect(app, "and it starts null rather than a placeholder").toMatch(
      /useState<string \| null>\(null\)/
    );
  });
});

/**
 * ── ⚠ WHERE THE PROFILE CHOICE SITS IN THE CONNECT FLOW ────────────────────────────────────────
 *
 * So the order is: Disconnect → connect screen → link confirmed → PROFILE CHOICE → sign in.
 *
 * ⚠ THE FIRST ATTEMPT PUT THE CHOOSER ON DISCONNECT AND THAT WAS WRONG, for a reason worth keeping: at
 * Disconnect there is no experience to place yet. The platform has just been cleared and nothing has
 * arrived, so "which profile?" is a question with no information behind it. Asked after the link commits,
 * it has an answer to place — and `profileCreate` seeds the new profile with the platform just saved.
 *
 * Asserted against the source because it is an ORDERING of early returns in one component, which is a fact
 * about the file rather than about any one render.
 */
describe("⚠ the profile choice comes after the platform is confirmed, not at Disconnect", () => {
  it("does NOT open the chooser when the platform is reset", () => {
    const handler = app.slice(app.indexOf("onPlatformChanged"), app.indexOf("removePlatformChangedListeners"));
    expect(handler, "a Disconnect must land on the connect screen").not.toContain("setShowProfileSwitch");
    expect(handler).not.toContain("setChoseProfileAfterConnect");
  });

  it("opens the chooser once the connect screen reports it committed", () => {
    const setup = app.slice(app.indexOf("<PlatformSetupView"), app.indexOf("</PlatformSetupView>") + 1 || undefined);
    expect(setup, "the connect screen's completion is what asks the question").toContain(
      "setChoseProfileAfterConnect(true)"
    );
  });

  /**
   * ⚠ THE CONNECT SCREEN STILL COMES FIRST. The two gates are mutually exclusive on `platformConfigured`,
   * and getting that backwards would show a chooser over an unconfigured app — the state the chooser's own
   * header says must never mount `App`'s data calls.
   */
  it("gates the post-connect chooser on the platform being configured", () => {
    expect(app).toContain("if (choseProfileAfterConnect && platformConfigured)");
    const chooserAt = app.indexOf("choseProfileAfterConnect && platformConfigured");
    const platformAt = app.indexOf("if (!platformConfigured)");
    expect(chooserAt).toBeGreaterThan(-1);
    expect(platformAt).toBeGreaterThan(-1);
  });

  /** The connect screen can reach the chooser directly too — it is a gate ahead of sign-in. */
  it("gives the connect screen a route to the chooser", () => {
    const setup = app.slice(app.indexOf("<PlatformSetupView"));
    expect(setup.slice(0, 600)).toContain("onSwitchProfile");
  });

  /** And the chooser says why it is asking, rather than reading as an interruption. */
  it("tells the participant what the choice is for", () => {
    expect(chooser).toContain("justConnected");
    expect(chooser).toContain("Which profile is this workspace for?");
    // "Cancel" would imply undoing the connect, which this does not do.
    expect(chooser).toContain("Continue in this profile");
  });
});
