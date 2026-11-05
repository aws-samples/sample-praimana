// ── ⚠ A PARTICIPANT'S ONLY ROUTE TO WORKSHOP RESOURCES ────────────────────────────────────────
//
// The Resources TAB lives in the experience console under `/experiences/<id>`, and a PARTICIPANT can
// never open it: `route-gates.ts` gate 1 confines them to `/welcome`, `/profile`, `/how-it-works`,
// `/desktop` and the API routes, and `canAccessStaffScreens` covers ADMIN, FACILITATOR, EXECUTIVE and
// JUDGE with PARTICIPANT the one role excluded. The feature shipped reaching everyone EXCEPT the
// audience most likely to want the brief, and the symptom was a participant signing in and
// finding no tab.
//
// `route-gates.ts` names this exact failure class in its own comments, "a surface offered to a role the
// route gate then bounces … and it is invisible unless you sign in as that role or think of it here".
// It happened anyway, because I read that file for the tab logic and not for the gate.
//
// So these pin the arrangement that fixes it: the console path stays forbidden (nothing was widened),
// and `/welcome` carries the list instead. Removing that section would silently take participants'
// only route away again, which is precisely the regression no type can catch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isForbiddenPath } from "./route-gates";
import { canAccessStaffScreens } from "@praimana/shared";

const WELCOME = readFileSync(join(__dirname, "..", "app", "welcome", "page.tsx"), "utf8");
const COMPONENT = readFileSync(
  join(__dirname, "..", "components", "WelcomeResources.tsx"),
  "utf8"
);

describe("⚠ why participants cannot use the Resources tab", () => {
  it("confirms PARTICIPANT is the one signed-in role that is not staff", () => {
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE"]) {
      expect(canAccessStaffScreens(role), role).toBe(true);
    }
    expect(canAccessStaffScreens("PARTICIPANT")).toBe(false);
  });

  /**
   * ⚠ ASSERTED AS FORBIDDEN ON PURPOSE. The fix for the missing tab was NOT to widen this: allowlisting
   * the path would drop a participant into the console layout, whose other header tabs lead to pages the
   * gate still bounces, visible links that break. If this ever starts returning false, someone has
   * widened the participant surface and should have to justify it here.
   */
  it("keeps the experience console forbidden to a participant", () => {
    for (const path of [
      "/experiences",
      "/experiences/W1",
      "/experiences/W1/resources",
      "/experiences/W1/results",
    ]) {
      expect(isForbiddenPath(path, "PARTICIPANT"), path).toBe(true);
    }
  });

  it("still admits staff to the resources tab's route", () => {
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE", "JUDGE"]) {
      expect(isForbiddenPath("/experiences/W1/resources", role), role).toBe(false);
    }
  });

  /** The surface they DO have. Gate 1's allowlist, so this is where the list has to live. */
  it("leaves /welcome reachable for a participant", () => {
    expect(isForbiddenPath("/welcome", "PARTICIPANT")).toBe(false);
  });
});

describe("⚠ /welcome is where a participant actually gets resources", () => {
  it("renders the resources section on the participant landing page", () => {
    // Source-scanned rather than rendered: this repo's vitest runs in `node` with no React testing
    // harness, which is why the tab-gating logic lives in `experience-tabs.ts` as extracted logic too.
    expect(WELCOME).toContain("WelcomeResources");
    expect(WELCOME, "the section must be imported, not just mentioned").toContain(
      'from "@/components/WelcomeResources"'
    );
  });

  /**
   * ⚠ FROM TEAMS, NOT FROM INVITATIONS. The service's read gate admits a participant through
   * MEMBERSHIP; an unaccepted invitation is not membership, so driving this off `listMyInvitations`
   * would render a section that 403s. `listMyInvitations` also carries no workshopId at all.
   */
  it("derives the experiences from team membership", () => {
    expect(WELCOME).toContain("team.listMine");
  });

  /**
   * ⚠ READ-ONLY, AND NOT MERELY BY OMISSION. The Workshop service grants writes to the experience
   * OWNER alone and refuses a participant regardless, so an upload or delete control here would be a
   * button the server rejects, the same defect this page's own comments describe as "a surface offered
   * to a role the route gate then bounces".
   */
  it("offers no write controls to participants", () => {
    for (const forbidden of ["beginUpload", "completeUpload", "resources.remove", "Add Resource"]) {
      expect(COMPONENT, `${forbidden} must not appear on the participant surface`).not.toContain(
        forbidden
      );
    }
  });

  it("offers download, which is the whole point of it", () => {
    expect(COMPONENT).toContain("downloadUrl");
    expect(COMPONENT).toContain("resources.list");
  });

  /**
   * The landing page's job is the join code and the desktop download. A facilitator who has shared
   * nothing is the common case early on, and a failed secondary read must not put a red box on the
   * first screen a participant ever sees.
   */
  it("hides itself rather than showing an empty state or an error", () => {
    expect(COMPONENT).toMatch(/if \(list\.isLoading \|\| list\.error \|\| resources\.length === 0\) return null;/);
  });
});

// ── ⚠ /welcome'S SECTIONS COLLAPSE, AND ONE DELIBERATELY DOES NOT ──────────────────────────────
//
// Sections, all collapsed by default. That INVERTS the default `Disclosure` documents
// for itself, "a roster … opens by default and collapsing is a scanning aid, not a way to defer work"
//, and the inversion is right here because /welcome is a checklist, not a roster: once a participant
// has their code and has connected the app, those steps are finished work they scroll past.
//
// The exception is the one thing on this page that is not a step. The AI-usage disclosure must be read
// BEFORE someone starts working, and this page is "the only place every participant reliably sees" it.
// A disclosure behind a click is not a disclosure, so it stays open, and that is the assertion most
// worth having, because collapsing it later would look like consistency.
describe("⚠ welcome sections collapse by default", () => {
  it("starts with every section closed", () => {
    // An empty initial map IS the "all closed" state: each section reads `!!openSections[id]`.
    expect(WELCOME).toMatch(/useState<Record<string, boolean>>\(\{\}\)/);
  });

  it("derives every section's open state from that map, with none forced open", () => {
    const opens = [...WELCOME.matchAll(/open=\{([^}]+)\}/g)].map((m) => m[1].trim());
    expect(opens.length, "the page should have collapsible sections").toBeGreaterThanOrEqual(3);
    for (const expr of opens) {
      // `open={true}` or `open={someOtherFlag}` would be a section that ignores the collapse state.
      expect(expr, `"${expr}" should read from openSections`).toContain("openSections[");
    }
  });

  it("gives each section a distinct id so they toggle independently", () => {
    const ids = [...WELCOME.matchAll(/id="(welcome-[a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("welcome-team-code");
  });

  /**
   * ⚠ THE EXEMPTION. Asserted by what it is NOT: the AI-usage block must remain a plain `<section>`,
   * never wrapped in a Disclosure. If someone "tidies up" by collapsing it for consistency, this fails.
   */
  it("leaves the AI-usage disclosure permanently visible", () => {
    const i = WELCOME.indexOf("Your AI coaching insights");
    expect(i, "the disclosure heading must still exist").toBeGreaterThan(-1);
    // The 400 characters before the heading are its own wrapper. A Disclosure there would be the bug.
    const wrapper = WELCOME.slice(Math.max(0, i - 400), i);
    expect(wrapper, "the AI-usage disclosure must not be collapsible").not.toContain("<Disclosure");
    expect(wrapper).toContain("<section");
  });

  /** The count must survive being closed, which is why Disclosure puts it in the heading. */
  it("shows a count on the sections where one answers 'anything for me?'", () => {
    expect(WELCOME).toMatch(/count=\{invitations\.length\}/);
    expect(COMPONENT).toMatch(/count=\{resources\.length\}/);
  });

  /**
   * A download failure from a button the participant just pressed must not vanish because they then
   * collapsed the section, the case `Disclosure`'s `notice` prop exists for.
   */
  it("keeps a download error visible when the resources section is collapsed", () => {
    expect(COMPONENT).toMatch(/notice=\{/);
    const panel = COMPONENT.slice(COMPONENT.indexOf("notice={"));
    expect(panel).toContain("role=\"alert\"");
  });
});
