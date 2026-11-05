import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { canSignInToDesktopApp } from "@praimana/shared";

/**
 * ── ⚠ ONLY EXECUTIVES AND PARTICIPANTS MAY SIGN IN TO THIS APP ─────────────────────────────
 *
 * THE RULE: the desktop is used only by execs and participants; no other role may sign in.
 *
 * ── WHY SOURCE ASSERTIONS ──
 *
 * The sign-in handler needs Electron's `ipcMain`, a configured platform, a real JWT and a keychain. This
 * package's convention for exactly that situation is to exercise the pure rule directly and assert the
 * ORDERING facts against the source — the same shape as `phases-view.test.ts` and `view-theme.test.ts`.
 *
 * The ordering is the part that would break silently: refusing AFTER `adoptSession` would leave the app
 * signed in to a state its own UI cannot serve, and no status code would reveal it.
 */

const SRC = readFileSync(join(__dirname, "handlers", "ai.ts"), "utf8");
/** Comments stripped: this file's own prose names both the function and `adoptSession`. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

describe("the desktop refuses roles it is not for", () => {
  it("uses the SHARED predicate rather than a local role list", () => {
    // A second list is how the desktop and the portal end up disagreeing about who this app is for.
    expect(code).toContain("canSignInToDesktopApp(role)");
    expect(code).toContain("collapseCognitoGroups(claims[");
  });

  it("⚠ REFUSES BEFORE adoptSession — a rejected role must leave NO session behind", () => {
    /**
     * The ordering fact. `adoptSession` writes the token, the refresh token and the profile; refusing
     * after it would leave a signed-in app with a role its own screens cannot serve, and the user would
     * have to find Sign out to escape.
     */
    const guard = code.indexOf("canSignInToDesktopApp(role)");
    const adopt = code.indexOf("adoptSession({");
    expect(guard).toBeGreaterThan(-1);
    expect(adopt).toBeGreaterThan(-1);
    expect(guard, "the role guard must come first").toBeLessThan(adopt);
  });

  it("⚠ derives the role AFTER the issuer/audience/expiry checks", () => {
    // Reading groups from an unverified token would let a token from another pool decide who may sign in.
    const issuer = code.indexOf("platform.cognito.issuer");
    const role = code.indexOf("collapseCognitoGroups(claims[");
    expect(issuer).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(issuer);
  });

  it("tells the refused user where to go instead", () => {
    // "Refused" with no destination is a dead end; an admin needs to know the browser is their surface.
    expect(code).toMatch(/executives and participants/i);
    expect(code).toMatch(/browser/i);
  });
});

/**
 * ── ⚠ BOTH DOORS, NOT ONE ──────────────────────────────────────────────────────────────────────
 *
 * `ai:login` — the Hosted UI flow behind this app's own "Sign in" button — adopted a session without ever
 * consulting it, so an ADMIN or FACILITATOR was admitted by whichever door they happened to use.
 *
 * ⚠ I HAD DECLINED TO FIX THIS, on the reasoning that the role gates nothing downstream so a
 * facilitator gains no privilege. True, and beside the point: it is a product rule about which
 * accounts this app serves, and a rule enforced at one of two entrances is not enforced. These tests
 * exist because "which sign-in paths exist" is exactly the fact that drifts as paths are added.
 */
describe("every sign-in path is gated, not just the first one", () => {
  /**
   * ── ⚠ ONE GATE, REACHED BY BOTH PATHS ────────────────────────────────────────────────────────
   *
   * This used to assert TWO copies of `canSignInToDesktopApp(role)` — one per handler — because that
   * is how the hole was closed the first time: the gate was added to the second path beside the first.
   * The rest of the same asymmetry surfaced later (`ai:login` also skipped
   * `token_use`, `aud`, `exp` and every invariant `adoptSession` owns), and the answer to "a rule
   * enforced on one of two doors" is one authority rather than a matching pair of copies.
   *
   * So the assertions changed shape deliberately: there is now exactly ONE gate, in
   * `verifyIdTokenForAdoption`, and what has to be pinned is that both handlers go through it and
   * neither does anything consequential first.
   */
  it("has TWO adoption paths and ONE gate they both call", () => {
    const gates = code.match(/canSignInToDesktopApp\(role\)/g) ?? [];
    expect(gates.length, "one authority, not a copy per handler").toBe(1);
    expect((code.match(/ipcMain\.handle\(\s*"auth:completeSignIn"/g) ?? []).length).toBe(1);
    expect((code.match(/ipcMain\.handle\(\s*"ai:login"/g) ?? []).length).toBe(1);

    // And both reach it. A third sign-in path that does not will fail this.
    const calls = code.match(/verifyIdTokenForAdoption\(/g) ?? [];
    expect(calls.length, "the definition plus one call per adoption path").toBe(3);
  });

  it("gates the hosted-UI path BEFORE it stores a bearer", () => {
    /**
     * The ordering fact for this path. It no longer writes the settings inline — that was the other
     * half of the finding — so the bearer is stored by `adoptSession`, and the check has to precede it.
     */
    const body = code.slice(code.indexOf('"ai:login"'));
    const gate = body.indexOf("verifyIdTokenForAdoption(");
    const adopt = body.indexOf("adoptSession({");
    expect(gate, "the hosted-UI path must be verified").toBeGreaterThan(-1);
    expect(adopt, "and it must adopt through the shared function").toBeGreaterThan(-1);
    expect(gate, "verify before anything is persisted").toBeLessThan(adopt);
    expect(body, "it must not hand-roll the credential writes any more").not.toMatch(
      /writeSetting\("auth_token"/
    );
  });

  it("gates it AFTER the signature check, so the groups claim is trustworthy", () => {
    /**
     * `cognito:groups` from an unverified token is attacker-chosen, and the role IS that claim. Both are
     * inside `verifyIdTokenForAdoption` now, so the ordering is asserted where it lives.
     */
    const body = code.slice(code.indexOf("async function verifyIdTokenForAdoption"));
    const verify = body.indexOf("hasValidSignature(");
    const gate = body.indexOf("canSignInToDesktopApp(role)");
    expect(verify).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(verify);
  });

  it("checks the cheap claims before spending a network round trip", () => {
    // A token for the wrong pool, or an expired one, must be refused without touching Cognito's JWKS.
    const body = code.slice(code.indexOf("async function verifyIdTokenForAdoption"));
    const claims = body.indexOf("aud !== platform.cognito.clientId");
    const verify = body.indexOf("hasValidSignature(");
    expect(claims).toBeGreaterThan(-1);
    expect(claims).toBeLessThan(verify);
  });

  it("costs no round trip for a refused account", () => {
    // Cheap, and it is the difference between a refusal and a refusal that also hits the API with a
    // token it is about to throw away.
    const body = code.slice(code.indexOf('"ai:login"'));
    const gate = body.indexOf("verifyIdTokenForAdoption(");
    const profileFetch = body.indexOf("/v1/auth/me");
    expect(profileFetch).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(profileFetch);
  });

  it("gives the refused user one sentence, because it is one rule", () => {
    // Two wordings for one rule reads as two different rules to the person hitting it — and with one
    // authority there is now only one place the sentence can come from.
    const refusals = code.match(/executives and participants/gi) ?? [];
    expect(refusals.length).toBe(1);
  });

  /**
   * ⚠ AND THE CLAIM CHECKS APPLY TO BOTH PATHS, which is the half of this finding that was not about
   * roles at all: `ai:login` never checked `token_use`, `aud` or `exp`, so an ACCESS token, a token for
   * another app client of the same pool, or an expired one would have been adopted.
   */
  it("applies token_use, aud and exp on both paths", () => {
    for (const check of ['tokenUse !== "id"', "aud !== platform.cognito.clientId", "exp * 1000 <= Date.now()"]) {
      expect((code.match(new RegExp(check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, check).toBe(1);
    }
  });
});

/**
 * The rule itself, exercised directly. It lives in the shared package and has its own suite there; these
 * two cases are the ones a DESKTOP reader needs to see without leaving this package.
 */
describe("the rule", () => {
  it("admits the two roles this app is for and refuses the other three", () => {
    expect(["EXECUTIVE", "PARTICIPANT"].every(canSignInToDesktopApp)).toBe(true);
    expect(["ADMIN", "FACILITATOR", "JUDGE"].some(canSignInToDesktopApp)).toBe(false);
  });

  it("⚠ still admits an EXECUTIVE, who is ALSO portal staff", () => {
    // The naive implementation — the complement of `canAccessStaffScreens` — locks out every executive,
    // the one role that needs both surfaces.
    expect(canSignInToDesktopApp("EXECUTIVE")).toBe(true);
  });
});
