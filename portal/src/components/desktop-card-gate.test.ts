// ── ⚠ WHO IS OFFERED THE DESKTOP APP, AND WHERE THE CODE FIELD SITS ──────────────────────
//
// Two small requests from the same report, both about the same page-load:
//
//   "only executives and participants should see this desktop not all"
//   "can we move the verification code align center than to left"
//
// The first is the substantive one. `/experiences` is where `landingPathForRole` sends ADMIN,
// FACILITATOR, EXECUTIVE and JUDGE, everyone except PARTICIPANT, who lands on `/welcome` where the
// installer already lives. The card was added here so an EXECUTIVE had any route to the desktop at
// all, and it was rendered unconditionally, so it also offered an installer to the two roles that
// run the event from the portal and have no use for it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canSignInToDesktopApp } from "@praimana/shared";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const page = strip(readFileSync(join(__dirname, "..", "app", "experiences", "page.tsx"), "utf8"));
const shell = strip(readFileSync(join(__dirname, "auth", "AuthShell.tsx"), "utf8"));

describe("⚠ the desktop card is offered by role, not to everyone", () => {
  it("is rendered behind a gate rather than unconditionally", () => {
    expect(page, "the card must be conditional").toMatch(/\{canUseDesktop && \(/);

    /**
     * ⚠ AND THE GATE MUST BE THE THING IMMEDIATELY WRAPPING IT. A first version asserted the
     * ABSENCE of `<div className="mt-10"><DesktopAppCard />`, which the gated markup still
     * contains, the wrapper only adds a line above it, and `\s*` spans that. The check passed on
     * the ungated form too, so it proved nothing. Every usage is now required to have the gate
     * close in front of it.
     */
    const usages = [...page.matchAll(/<DesktopAppCard\s*\/>/g)];
    expect(usages.length, "exactly one place renders it").toBe(1);
    const before = page.slice(0, usages[0].index);
    expect(
      before.lastIndexOf("canUseDesktop"),
      "the nearest preceding condition must be the role gate"
    ).toBeGreaterThan(before.lastIndexOf("</"));
  });

  /**
   * ⚠ AN ALLOWLIST, NOT A DENYLIST, the guarantee is unchanged, its HOME moved.
   *
   * This asserted the inline `role === "EXECUTIVE" || role === "PARTICIPANT"` on the page. That expression
   * is gone: the DESKTOP now enforces the same rule at sign-in (the desktop is for executives and participants only),
   * and two copies of "who is this app for" is how the portal ends up OFFERING an app the app then REFUSES -
   * the shape of the Submit-tab bug. Both ends read `canSignInToDesktopApp`.
   *
   * The denylist objection still stands and still matters: `role !== "ADMIN"` reads the same today and is
   * wrong the moment a role is added, because a new role would silently INHERIT an offer to install
   * software. It is now a property of the shared `DESKTOP_APP_ROLES` list, asserted where it lives, and what
   * is checked HERE is that the page defers to it rather than re-deciding.
   */
  it("defers to the SHARED predicate instead of naming roles inline", () => {
    expect(page).toMatch(/canUseDesktop = canSignInToDesktopApp\(role\)/);
    expect(page, "no inline allowlist").not.toMatch(/role === "EXECUTIVE" \|\| role === "PARTICIPANT"/);
    expect(page, "no denylist").not.toMatch(/role !== "(ADMIN|FACILITATOR|JUDGE)"/);
  });

  it("⚠ and that predicate is still an ALLOWLIST of exactly the two roles", () => {
    // The guarantee itself, exercised rather than pattern-matched: anything new is excluded until somebody
    // decides otherwise, and an EXECUTIVE, who is ALSO portal staff, is still admitted.
    expect(["EXECUTIVE", "PARTICIPANT"].every(canSignInToDesktopApp)).toBe(true);
    expect(["ADMIN", "FACILITATOR", "JUDGE"].some(canSignInToDesktopApp)).toBe(false);
  });

  it("takes the role from the shared hook rather than reading the session directly", () => {
    expect(page).toMatch(/import \{[^}]*useRole[^}]*\} from "@\/lib\/useRole"/);
  });

  /**
   * PARTICIPANT is in the set even though their landing page already has the installer: they can
   * navigate here, and finding the download absent from the page listing their own experiences
   * would read as a fault.
   */
  it("includes PARTICIPANT even though /welcome also offers it", () => {
    // Asserted on the RULE now, not on a string in the page, the role list moved to `shared/`.
    expect(canSignInToDesktopApp("PARTICIPANT")).toBe(true);
  });
});

describe("⚠ the verification code field is centred", () => {
  it("centres the text", () => {
    const cls = /className="([^"]*tracking-\[0\.3em\][^"]*)"/.exec(shell);
    expect(cls, "the code input's class list").not.toBeNull();
    expect(cls![1]).toContain("text-center");
  });

  /**
   * ⚠ `text-center` ALONE IS NOT CENTRED HERE, which is the non-obvious part. `tracking-[0.3em]`
   * appends letter-spacing AFTER the final character too, so the visible digits sit left of true
   * centre by one space's width. The trailing gap is compensated with an equal left indent, the
   * standard fix, and the thing a later "simplification" would strip as redundant.
   */
  it("compensates for the trailing letter-space that tracking adds", () => {
    const cls = /className="([^"]*tracking-\[0\.3em\][^"]*)"/.exec(shell);
    expect(cls![1], "indent must offset the trailing tracking").toMatch(/indent-\[0\.3em\]/);
  });
});

/**
 * ── ⚠ CONNECT MUST NOT DEPEND ON AN INSTALLER EXISTING ────────────────────────────────────
 *
 * REPORTED: "why executives are not seeing open in desktop by default … show this to executives as well".
 *
 * The connect link was nested inside `platforms.length > 0`, so on a deployment with no published installer
 * the card fell through to the amber empty state and the link was never rendered. That is this deployment
 * today, which is exactly why it was reported: an executive holding the app already had no way to connect it.
 *
 * The two were already independent QUERIES, the markup is what coupled them. `/welcome` never had this bug
 * because its download and connect are separate sections.
 */
const card = strip(readFileSync(join(__dirname, "DesktopAppCard.tsx"), "utf8"));

describe("⚠ the connect link is independent of the installer", () => {
  it("renders connect BEFORE the download branch, not inside it", () => {
    const connect = card.indexOf("desktopLink?.link");
    const downloadBranch = card.indexOf("platforms.length > 0");

    expect(connect, "the connect link must exist").toBeGreaterThan(-1);
    expect(
      connect,
      "it must not sit inside the branch that requires a published installer"
    ).toBeLessThan(downloadBranch);
  });

  /**
   * ⚠ THE EMPTY STATE MUST NOT SWALLOW IT. This is the specific shape of the bug: the amber "no installer"
   * paragraph was the else-branch, and everything the if-branch held, including connect, disappeared with it.
   */
  it("still offers connect when no installer is published", () => {
    const amber = card.indexOf("No installer has been published");
    expect(card.indexOf("desktopLink?.link")).toBeLessThan(amber);
  });

  /** A dead praimana:// anchor fails silently when clicked, so a misconfigured deployment shows nothing. */
  it("hides connect when the link could not be built", () => {
    expect(card).toMatch(/!linkError && desktopLink\?\.link/);
  });
});

/**
 * ── ⚠ THE S3 LOOKUP IS OPT-IN ─────────────────────────────────────────────────────────────
 *
 * Collapsed by default, to avoid an unnecessary API call for the S3 download.
 *
 * `desktop.releases` calls `/v1/desktop/releases`, which lists the shared account's installer bucket. It was
 * firing on every `/experiences` load for every executive and participant, to render a card most of them will
 * never act on.
 */
describe("⚠ the releases query does not run until asked for", () => {
  /**
   * ⚠ THE SAVING IS THE DISABLED QUERY, NOT THE HIDDEN MARKUP. Collapsing the UI while leaving the query
   * enabled would look identical on screen and cost exactly the same S3 round trip, which is the mistake
   * this assertion exists to catch.
   */
  it("gates the query on the disclosure, not just the markup", () => {
    expect(card).toMatch(/trpc\.desktop\.releases\.useQuery\(undefined, \{\s*enabled: showDownloads/);
  });

  it("starts collapsed", () => {
    expect(card).toMatch(/useState\(false\)/);
  });

  /**
   * ⚠ A BUTTON, NOT `<details>`. A native disclosure toggles visibility without React re-rendering, so the
   * state would never change and the query would never fire, the downloads would stay permanently "loading".
   */
  it("uses a state-changing control so the query can be triggered", () => {
    expect(card).toMatch(/onClick=\{\(\) => setShowDownloads\(true\)\}/);
    expect(card, "a native <details> would not trigger the query").not.toMatch(/<details/);
  });
});
