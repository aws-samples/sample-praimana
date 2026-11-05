import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel: string) => strip(readFileSync(local(rel), "utf8"));
const APP = read("./App.tsx");
const SIGNIN = read("./components/SignInView.tsx");
const JOIN = read("./components/JoinTeamView.tsx");
const BADGE = read("./components/ProfileBadge.tsx");

/**
 * WHICH PROFILE AM I SIGNING INTO?
 *
 * The profile name lived only in the titlebar of the SIGNED-IN shell, and every pre-auth gate returns
 * before that shell renders. Profiles keep separate sign-ins, so two windows on two profiles showed two
 * identical login forms — and typing a password into the wrong one was a mistake the app gave no way to
 * notice.
 */
describe("the profile is visible before sign-in", () => {
  it("SignInView shows the badge", () => {
    expect(SIGNIN).toContain("<ProfileBadge");
    expect(SIGNIN).toMatch(/profileLabel/);
  });

  it("JoinTeamView shows it too — also a pre-workspace screen", () => {
    expect(JOIN).toContain("<ProfileBadge");
  });

  it("App passes the label it already loads", () => {
    // The label is fetched in an effect on mount, so it is available before any gate resolves.
    expect(APP).toMatch(/<SignInView[\s\S]{0,200}profileLabel=\{profileLabel\}/);
    expect(APP).toMatch(/<JoinTeamView[\s\S]{0,200}profileLabel=\{profileLabel\}/);
  });

  it("renders NOTHING on a default install, rather than inventing a name", () => {
    // "Profile: default" would be noise for a concept the user never opted into.
    expect(BADGE).toMatch(/if \(!label\) return null;/);
  });
});

describe("and the user can act on the answer", () => {
  it("offers a switch, because naming the profile is useless if you are in the wrong one", () => {
    expect(BADGE).toMatch(/onSwitch/);
    expect(SIGNIN).toMatch(/onSwitchProfile/);
  });

  it("the profiles page is reachable BEFORE every gate, including sign-in", () => {
    /**
     * The ordering IS the feature. A chooser reachable only from the signed-in shell would be reachable
     * only after the mistake had already been made.
     */
    const switchGate = APP.indexOf("if (showProfileSwitch)");
    const platformGate = APP.indexOf("if (!platformConfigured)");
    const signInGate = APP.indexOf("if (!connected || needsSignIn)");
    expect(switchGate).toBeGreaterThan(-1);
    expect(switchGate, "must precede the platform gate").toBeLessThan(platformGate);
    expect(switchGate, "must precede the sign-in gate").toBeLessThan(signInGate);
  });

  it("REPLACES this window rather than opening a second one", () => {
    /**
     * `newWindow` is what File → New Profile passes, and it opens a SECOND window. "I am in the wrong
     * profile" means move THIS one, so the switch chooser must not pass it.
     */
    const block = APP.slice(APP.indexOf("if (showProfileSwitch)"), APP.indexOf("if (!platformConfigured)"));
    expect(block).toContain("<ProfileChooser");
    expect(block, "newWindow would open a second window instead of switching").not.toContain("newWindow");
  });

  it("is distinct from the File -> New Profile prompt", () => {
    // Two different intents; sharing one flag would make the menu item replace the window.
    expect(APP).toContain("showProfilePrompt");
    expect(APP).toContain("showProfileSwitch");
    expect(APP).toMatch(/showProfilePrompt[\s\S]{0,400}newWindow/);
  });

  it("cancelling returns to whichever gate was showing", () => {
    expect(APP).toMatch(/onCancel=\{\(\) => setShowProfileSwitch\(false\)\}/);
  });
});

describe("the chooser does not strand the old window", () => {
  const CHOOSER = read("./components/ProfileChooser.tsx");

  it("dismisses itself whenever the process SURVIVED, not just when newWindow was asked for", () => {
    /**
     * `if (newWindow) onCancel?.()` inferred the mechanism from the request; in development `profileOpen`
     * spawns instead of replacing, so the picker was never dismissed.
     */
    expect(CHOOSER).toMatch(/if \(newWindow \|\| result\?\.replaced === false\) onCancel\?\.\(\)/);
  });

  it("both bridges report `replaced`, so nothing has to infer it", () => {
    expect(CHOOSER).toMatch(/profileOpen\(id: string\)[\s\S]{0,120}replaced\?: boolean/);
    expect(CHOOSER).toMatch(/profileOpenWindow\(id: string\)[\s\S]{0,120}replaced\?: boolean/);
  });

  it("still does NOT clear early on the true replace path", () => {
    // Clearing while the process is about to exit would show an app with no database for that instant.
    // `replaced === false` is a strict check, so `true` and `undefined` both leave the picker up.
    expect(CHOOSER).toContain("=== false");
  });
});
