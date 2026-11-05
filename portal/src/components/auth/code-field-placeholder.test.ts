// ── ⚠ THE CODE FIELD'S PLACEHOLDER, THE SAME IN BOTH APPS ────────────────────────────────
//
// The verification code input uses the placeholder 000000, the same on the desktop and the portal.
//
// The portal's said `123456` and the desktop's field had none at all. Two reasons the value matters more than
// it looks:
//
//   ⚠ 1. A SEQUENTIAL EXAMPLE READS AS A REAL CODE. `123456` is a plausible thing to type into a field that
//        is asking for six digits under a 30-second expiry, and the failure it produces looks like the code
//        being wrong rather than the hint being misleading. Repeated zeros read as a mask: six positions, no
//        suggestion.
//
//   ⚠ 2. THE TWO APPS ARE ONE LOGIN. This field is the same step of the same flow in the desktop and the
//        portal; a different hint in each invites the reader to wonder whether one is asking for something
//        else. So this test asserts BOTH FILES, deliberately reaching across the app boundary, it is the
//        only way a test can hold a cross-app agreement that no shared module enforces.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readSiblingRepoSource,
  siblingRepoPresent,
} from "@/lib/sibling-repo-source";

/**
 * ⚠ COMMENTS STRIPPED BEFORE ANY ASSERTION, and this is not hygiene, it is a bug this file already had.
 * Deleting `placeholder:text-surface-faint` from the desktop's `className` left the suite GREEN, because the
 * very comment I wrote to explain the token ("`placeholder:text-surface-faint` is 5.73:1 on `surface-bg`")
 * satisfied the match. A source-reading test that does not strip prose is asserting its own documentation.
 */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const portal = strip(readFileSync(join(__dirname, "AuthShell.tsx"), "utf8"));

/**
 * ⚠ REACHING INTO THE DESKTOP FROM A PORTAL TEST, which is unusual enough to justify. The agreement being
 * tested is "these two fields say the same thing", and there is no shared component to hang it on, the
 * desktop is Electron and this is Next.
 *
 * ⚠ THAT REACH CROSSES A REPOSITORY, so it is resolved through `sibling-repo-source.ts`:
 * asserted when the desktop repo is checked out beside this one (or `AIAP_DESKTOP_REPO` points at it),
 * reported as a todo when it is not. Read that file's header for why a hard path would be worse.
 *
 * ⚠ A HARD RELATIVE PATH WOULD RESOLVE ONLY BY ACCIDENT OF DIRECTORY DEPTH — correct on a checkout that
 * happens to have the `desktop` repo beside this one, and failing on any clone without that sibling.
 * Naming the dependency is the fix.
 */
const desktopPresent = siblingRepoPresent("desktop");
const desktopSignIn = desktopPresent
  ? strip(readSiblingRepoSource("desktop", "src", "renderer", "components", "SignInView.tsx"))
  : "";
const itWithDesktop = desktopPresent ? it : it.todo;

describe("⚠ both apps hint the code field the same way", () => {
  it("uses 000000 in the portal", () => {
    expect(portal).toContain('placeholder="000000"');
    expect(portal, "the sequential example is gone").not.toContain('placeholder="123456"');
  });

  itWithDesktop("uses 000000 in the desktop", () => {
    expect(desktopSignIn).toContain('placeholder="000000"');
  });

  /**
   * ⚠ SCOPED TO THE CODE FIELD'S OWN `className`, NOT THE FILE.
   *
   * My first version asserted `placeholder:text-surface-faint` anywhere in `SignInView.tsx`, and that file
   * has ANOTHER input (the email field, line ~315) carrying the same token. So deleting the code field's
   * placeholder ink left the test green: the assertion was satisfied by an unrelated control. Both fields are
   * identified here by `tracking-[0.3em]`, which only the six-digit inputs use.
   */
  const codeFieldClass = (src: string, name: string) => {
    const classes = [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    const found = classes.filter((c) => c.includes("tracking-[0.3em]"));
    expect(found.length, `${name}: exactly one letter-spaced code field expected`).toBe(1);
    return found[0];
  };

  /**
   * ⚠ AND IT MUST NOT LOOK PRE-FILLED. Both fields are centred monospace at a larger size, where a
   * placeholder at normal ink weight reads as a value already typed, on a form whose submit is disabled
   * until six characters exist, that is actively misleading.
   *
   * ⚠ THE PORTAL'S VALUE CHANGED, AND THE DESKTOP IS WHY IT HAD TO. This asserted
   * `placeholder:text-gray-300`, #d1d5db, which is 1.47:1 against the white card. That is not "faint",
   * it is invisible, on the one field in the product operating under a 30-second expiry. The desktop's
   * half of this very agreement was already compliant (`surface-faint`, documented at 5.73:1 in the
   * assertion below), so the two apps were NOT in fact hinting the field the same way, the portal was
   * the outlier and this test was pinning it there.
   *
   * Now `--field-placeholder` (4.77:1 on --canvas, 4.92:1 on --surface-1 in the dark variant), which is
   * still far lighter than the entered digits at --ink (16.8:1). Faint, and legible.
   */
  it("draws the hint faintly, on the code field itself", () => {
    expect(codeFieldClass(portal, "portal"), "portal ink").toContain(
      "placeholder:text-field-placeholder"
    );
  });

  /**
   * ⚠ AND THE FAINT TOKEN MUST NOT DRIFT BACK TO A RAW GREY. The whole reason the value above is a token
   * is that a literal `gray-300`/`gray-400` cannot be contrast-checked once and trusted, it means a
   * different ratio on every surface it lands on. Naming the failed values explicitly so a revert has to
   * delete this line rather than quietly pass.
   */
  it("does not reach back for a hardcoded grey placeholder", () => {
    /* ⚠ THESE TWO STRINGS ARE DELIBERATELY LITERAL AND MUST STAY THAT WAY. They name the values
       that FAILED, so they cannot be tokens, and a codebase-wide grey-to-token migration did in
       fact rewrite them once, which collapsed both assertions onto the same token and quietly
       turned this test into a tautology. Split across two lines so each names its own ratio. */
    const cls = codeFieldClass(portal, "portal");
    expect(cls, "gray-300 is 1.47:1 on the card").not.toContain("placeholder:text-" + "gray-300");
    expect(cls, "gray-400 is 2.54:1 on the card").not.toContain("placeholder:text-" + "gray-400");
  });

  // ⚠ SPLIT FROM THE ASSERTION ABOVE BY THE REPO BOUNDARY, NOT BY CHOICE. One `it` covering both apps would
  // have to be gated as a whole, which would stop checking the PORTAL on any clone without a desktop
  // checkout, the half that is always here would be lost to the half that sometimes is not.
  itWithDesktop("draws the desktop's hint faintly too", () => {
    expect(codeFieldClass(desktopSignIn, "desktop"), "desktop ink").toContain(
      "placeholder:text-surface-faint"
    );
  });

  /**
   * ⚠ LETTER-SPACING DOES NOT REACH A PLACEHOLDER ON ITS OWN. Both inputs space their value; without the
   * `placeholder:` variant the hint renders tight, so the field visibly changes shape as soon as you type.
   */
  it("spaces the hint like the value it stands in for", () => {
    expect(codeFieldClass(portal, "portal"), "portal must space the placeholder too").toContain(
      "placeholder:tracking-[0.3em]"
    );
  });

  itWithDesktop("spaces the desktop's hint the same way", () => {
    expect(codeFieldClass(desktopSignIn, "desktop"), "desktop must space the placeholder too").toContain(
      "placeholder:tracking-[0.3em]"
    );
  });

  /**
   * The attributes that make the field usable were already right and must survive an edit to its hint: a
   * numeric keypad on a phone, OS autofill from Messages/an authenticator, and `type="text"` rather than
   * `number`, a number input strips a leading zero, and a code beginning 0 is perfectly ordinary.
   */
  const keepsFieldAttributes = (src: string, name: string) => {
    expect(src, `${name} numeric keypad`).toMatch(/inputMode="numeric"/);
    expect(src, `${name} OS autofill`).toMatch(/autoComplete="one-time-code"/);
    expect(src, `${name} six-digit cap`).toMatch(/maxLength=\{6\}/);
  };

  it("keeps the attributes that make the field work", () => {
    keepsFieldAttributes(portal, "portal");
  });

  itWithDesktop("keeps them in the desktop as well", () => {
    keepsFieldAttributes(desktopSignIn, "desktop");
  });
});
