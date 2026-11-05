import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PRECEDENCE, canManageWorkshopSettings } from "@praimana/shared";
import { canOpenExperienceTab, type ExperienceViewer } from "./experience-tabs";

/**
 * WHICH EXPERIENCE TAB EACH ROLE IS OFFERED.
 *
 * Not the security boundary, every page re-checks with the evaluation service, but it IS what
 * decides whether a judge is offered a route to the work they are here to judge, and whether a
 * participant is offered a tab that would refuse them.
 */

const ALL_ROLES = [...ROLE_PRECEDENCE];

/** A viewer with the role's real settings capability, so the cases cannot drift from `authz`. */
function viewer(role: string, canManage: boolean): ExperienceViewer {
  return { role, canManage, canManageSettings: canManageWorkshopSettings(role) };
}

describe("settings", () => {
  it("needs BOTH the capability and ownership", () => {
    expect(canOpenExperienceTab("settings", viewer("FACILITATOR", true))).toBe(true);
    // A facilitator who does not own THIS experience is not configuring it.
    expect(canOpenExperienceTab("settings", viewer("FACILITATOR", false))).toBe(false);
    expect(canOpenExperienceTab("settings", viewer("ADMIN", true))).toBe(true);
  });

  it("is refused to every role that cannot manage settings, even if canManage were true", () => {
    for (const role of ALL_ROLES.filter((r) => !canManageWorkshopSettings(r))) {
      expect(canOpenExperienceTab("settings", viewer(role, true)), role).toBe(false);
    }
  });
});

describe("submissions, the judging worklist", () => {
  /**
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR. The page previously hid EVERY navigating tab unless the
   * viewer could open Settings, so adding this tab under that gate would have hidden the judging
   * worklist from every judge, the single thing a judge is on the platform to do.
   */
  it("is offered to a JUDGE, who does not own anything", () => {
    expect(canOpenExperienceTab("submissions", viewer("JUDGE", false))).toBe(true);
  });

  it("is offered to ADMIN and to the owner, who supervise the panel", () => {
    // They need it because coverage is what gates publishing.
    expect(canOpenExperienceTab("submissions", viewer("ADMIN", true))).toBe(true);
    expect(canOpenExperienceTab("submissions", viewer("FACILITATOR", true))).toBe(true);
  });

  it("is NOT offered to a PARTICIPANT", () => {
    // A team member has no claim on other teams' released work, and the tab would refuse them.
    expect(canOpenExperienceTab("submissions", viewer("PARTICIPANT", false))).toBe(false);
  });

  it("is NOT offered to an EXECUTIVE, their route is their own team's Submit tab", () => {
    expect(canOpenExperienceTab("submissions", viewer("EXECUTIVE", false))).toBe(false);
  });

  it("is not offered to a FACILITATOR who does not own the experience", () => {
    expect(canOpenExperienceTab("submissions", viewer("FACILITATOR", false))).toBe(false);
  });
});

describe("results, the outcome", () => {
  it("is offered to every role, because both outcomes LOAD", () => {
    // An entitled reader sees the places; everyone else sees "not published yet". Neither is a
    // refusal, which is the bar for showing a tab at all.
    for (const role of ALL_ROLES) {
      expect(canOpenExperienceTab("results", viewer(role, false)), role).toBe(true);
    }
  });

  it("is offered even with no role resolved yet", () => {
    // The session resolves a round trip after first paint; a tab that vanishes is worse than one
    // that leads to "not published yet".
    expect(
      canOpenExperienceTab("results", { role: undefined, canManage: false, canManageSettings: false })
    ).toBe(true);
  });
});

describe("activity, the operational view of running the experience", () => {
  it("is offered to ADMIN and to the owner", () => {
    expect(canOpenExperienceTab("activity", viewer("ADMIN", true))).toBe(true);
    expect(canOpenExperienceTab("activity", viewer("FACILITATOR", true))).toBe(true);
  });

  it("is NOT offered to a facilitator who does not own this experience", () => {
    expect(canOpenExperienceTab("activity", viewer("FACILITATOR", false))).toBe(false);
  });

  /**
   * ⚠ NOT because the numbers are secret, but because they are somebody's JOB. A participant seeing
   * "your team has been quiet for 6 hours" is being managed by a dashboard, and a judge has no
   * operational role in running the room at all.
   */
  it("is NOT offered to a JUDGE, a PARTICIPANT or an EXECUTIVE", () => {
    for (const role of ["JUDGE", "PARTICIPANT", "EXECUTIVE"]) {
      expect(canOpenExperienceTab("activity", viewer(role, false)), role).toBe(false);
    }
  });
});

describe("resources, the facilitator's material", () => {
  /**
   * THE RULE: only the facilitator can add or delete, and every other role can read them. Reading is the COMMON case, so the tab is offered to everyone, hiding it from
   * participants would hide the feature from the people it exists to serve.
   */
  it("is offered to every role, because reading is the point", () => {
    for (const role of ALL_ROLES) {
      expect(canOpenExperienceTab("resources", viewer(role, false)), role).toBe(true);
    }
  });

  it("is offered to a facilitator who does NOT own the experience", () => {
    // They can still read it if they can open the experience; the page hides the write controls and
    // the service refuses them. An offered tab that loads is correct here.
    expect(canOpenExperienceTab("resources", viewer("FACILITATOR", false))).toBe(true);
  });

  it("is offered before the session has resolved a role", () => {
    expect(
      canOpenExperienceTab("resources", { role: undefined, canManage: false, canManageSettings: false })
    ).toBe(true);
  });
});

// ── ⚠ THE BUG THIS BLOCK EXISTS FOR, AND IT SHIPPED ───────────────────────────────────────────
//
// In 0.6.22 the Resources tab was added to ExperienceHeader's TABS array and NOT to `NavigatingTab`.
// The header calls `canOpenExperienceTab(tab.key as NavigatingTab, …)`, a CAST, so the compiler had
// nothing to object to. The switch matched no case, returned `undefined`, `!undefined` was `true`, and
// the tab rendered `null`. Typecheck passed, 1,944 tests passed, the string was present in the
// deployed bundle, and the tab was invisible. Every signal said shipped.
//
// So this does not test a tab. It ties the two files together: every key the header treats as
// navigating MUST resolve to a real boolean. A key added to one file and not the other fails here.
describe("⚠ every navigating tab in the header is actually handled", () => {
  const header = readFileSync(
    join(__dirname, "..", "components", "ExperienceHeader.tsx"),
    "utf8"
  );

  /** Keys declared with `navigates: true` in the header's TABS array. */
  const navigatingKeys = [...header.matchAll(/\{\s*key:\s*"([a-z-]+)"[^}]*navigates:\s*true/g)].map(
    (m) => m[1]
  );

  it("finds the navigating keys at all, a scan that matches nothing would pass everything", () => {
    // The failure mode of a source-scanning test is silent vacuity. Pinned loosely so it survives a
    // new tab, but strictly enough that a rename of `navigates` fails here with its own name.
    expect(navigatingKeys.length).toBeGreaterThanOrEqual(5);
    expect(navigatingKeys).toContain("resources");
    expect(navigatingKeys).toContain("submissions");
  });

  it("resolves EVERY navigating key to a boolean, for every role", () => {
    for (const key of navigatingKeys) {
      for (const role of [...ALL_ROLES, undefined]) {
        const answer = canOpenExperienceTab(key as never, {
          role,
          canManage: false,
          canManageSettings: false,
        });
        // `undefined` here is the exact failure that hid the tab: a key with no case in the switch.
        expect(
          typeof answer,
          `canOpenExperienceTab("${key}", role=${role}) returned ${String(answer)}, add a case for "${key}" to experience-tabs.ts`
        ).toBe("boolean");
      }
    }
  });

  it("resolves every navigating key to a boolean for an owner too", () => {
    for (const key of navigatingKeys) {
      const answer = canOpenExperienceTab(key as never, viewer("FACILITATOR", true));
      expect(typeof answer, `owner view of "${key}"`).toBe("boolean");
    }
  });
});
