import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PRECEDENCE } from "@praimana/shared";
import {
  isForbiddenPath,
  isPublicPath,
  matchesPath,
  PARTICIPANT_PATHS,
  PUBLIC_PATHS,
  USER_ADMIN_PATHS,
  WORKSHOP_ADMIN_PATTERNS,
} from "./route-gates";

/**
 * ROUTE GATES, which role reaches which screen.
 *
 * These are the rules middleware.ts applies. They are not the security boundary (every
 * mutation is gated again server-side), but they ARE the thing that decides whether a
 * judge who types /experiences/<id>/settings sees the configuration form, so a silent
 * widening here is a real defect.
 *
 * The gates live in route-gates.ts rather than middleware.ts precisely so this file can
 * exist: middleware.ts imports next-auth's runtime and cannot be loaded here.
 */

const ALL_ROLES = [...ROLE_PRECEDENCE];

// A representative workshop id. ULIDs are what production uses; the gate must not
// depend on the shape, which the traversal cases below check.
const WORKSHOP_ID = "01JQZX9K2M3N4P5Q6R7S8T9V0W";
const SETTINGS_PATH = `/experiences/${WORKSHOP_ID}/settings`;

describe("isPublicPath", () => {
  it("admits every declared public path and its children", () => {
    for (const path of PUBLIC_PATHS) {
      expect(isPublicPath(path), path).toBe(true);
    }
    // /join carries a token segment, the emailed invite link is the whole reason
    // this list exists, and gating it would strand every invitee at /login.
    expect(isPublicPath("/join/some-invite-token")).toBe(true);
    expect(isPublicPath("/api/auth/callback/cognito")).toBe(true);
  });

  it("does NOT admit a path that merely starts with the same characters", () => {
    // The bug a naive startsWith would introduce: /loginhack must not inherit
    // /login's exemption.
    expect(isPublicPath("/loginhack")).toBe(false);
    expect(isPublicPath("/joinery")).toBe(false);
    expect(isPublicPath("/api/authz")).toBe(false);
  });

  it("does NOT admit the gated screens", () => {
    for (const path of ["/experiences", "/admin", SETTINGS_PATH, "/experiences/new"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("⚠ EXEMPTS THE FOUR BEARER ROUTES BY EXACT PATH, NOT THE /api/desktop PREFIX", () => {
    /**
     * The prefix `"/api/desktop"` used to be the entry, and `matchesPath` prefix-matches, so the
     * whole namespace bypassed the authN redirect and all three role gates, including any route
     * added under it later, which is the part that made it a latent bypass rather than a
     * deliberate exemption.
     *
     * Derived from the routes themselves, so a new bearer route that forgets this list fails here,
     * and a cookie route that lands in the namespace does not silently inherit an exemption.
     */
    const desktopDir = join(__dirname, "..", "app", "api", "desktop");
    const bearerRoutes = readdirSync(desktopDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => {
        try {
          const src = readFileSync(join(desktopDir, e.name, "route.ts"), "utf8");
          // The WRAPPER, not a mention, `download/route.ts` names it in a comment saying it
          // deliberately does not use it.
          return /=\s*withBearer\(|withBearer\(\s*async/.test(src);
        } catch {
          return false;
        }
      })
      .map((e) => `/api/desktop/${e.name}`)
      .sort();

    const declaredDesktop = PUBLIC_PATHS.filter((p) => p.startsWith("/api/desktop")).sort();

    expect(bearerRoutes.length, "there should be bearer routes to reason about").toBeGreaterThan(0);
    expect(declaredDesktop).toEqual(bearerRoutes);
    // The bare prefix must not come back: it is what made every future route public.
    expect(PUBLIC_PATHS).not.toContain("/api/desktop");
  });

  it("⚠ DOES NOT EXEMPT /api/desktop/download, WHICH AUTHENTICATES BY SESSION COOKIE", () => {
    // It reads `await auth()`, so it belongs behind the edge gates like every other
    // cookie-authenticated route. Under the old prefix it skipped them by accident of location.
    expect(isPublicPath("/api/desktop/download")).toBe(false);
  });

  it("does NOT admit doubled-slash paths (regression: '/' prefix degeneration)", () => {
    // The "/" entry in PUBLIC_PATHS must not cause paths starting with "//" to be
    // treated as public. This was the authentication bypass: `"/" + "/"` produced
    // `startsWith("//")`, making every doubled-slash path skip authN and authZ.
    expect(isPublicPath("//admin")).toBe(false);
    expect(isPublicPath("//experiences/new")).toBe(false);
    expect(isPublicPath(`//experiences/${WORKSHOP_ID}/settings`)).toBe(false);
    expect(isPublicPath("//login")).toBe(false);
    expect(isPublicPath("//")).toBe(false);
    expect(isPublicPath("///")).toBe(false);
  });
});

describe("matchesPath", () => {
  it("matches exactly and on a segment boundary, never on a substring", () => {
    expect(matchesPath("/admin", ["/admin"])).toBe(true);
    expect(matchesPath("/admin/users", ["/admin"])).toBe(true);
    expect(matchesPath("/adminx", ["/admin"])).toBe(false);
    expect(matchesPath("/xadmin", ["/admin"])).toBe(false);
  });

  it("treats '/' as exact-match only, no prefix degeneration", () => {
    // The root "/" must match only itself. The prefix form `p + "/"` degenerates
    // to `startsWith("//")` when p is "/", which would incorrectly admit any path
    // with doubled leading slashes.
    expect(matchesPath("/", ["/"])).toBe(true);
    expect(matchesPath("//", ["/"])).toBe(false);
    expect(matchesPath("//admin", ["/"])).toBe(false);
    expect(matchesPath("//anything", ["/"])).toBe(false);
    expect(matchesPath("/foo", ["/"])).toBe(false);
  });
});

// ─── Gate (a): participants are confined to their own surface ────────────────

describe("participant confinement", () => {
  it("lets a PARTICIPANT reach only their own surface", () => {
    for (const path of PARTICIPANT_PATHS) {
      expect(isForbiddenPath(path, "PARTICIPANT"), path).toBe(false);
    }
    // /profile is in the list for a reason: without it a participant has no way to
    // change their own password at all.
    expect(isForbiddenPath("/profile", "PARTICIPANT")).toBe(false);
  });

  it("⚠ LETS A PARTICIPANT REACH THE INSTALLER DOWNLOAD, WHICH IS A NAVIGATION, NOT A FETCH", () => {
    /**
     * `/welcome` and `/desktop` link at this route with a plain `<a href>`, so it passes through
     * the middleware like a page. Forbidden, the redirect went to /welcome, i.e. both download
     * buttons appeared to reload the page they were on, with no error anywhere.
     *
     * Participants are the audience for the installer; staff were never affected, which is exactly
     * why the defect was invisible from a staff account.
     */
    expect(isForbiddenPath("/api/desktop/download", "PARTICIPANT")).toBe(false);
    // Still cookie-authenticated: reachable by role, but never without a session.
    expect(isPublicPath("/api/desktop/download")).toBe(false);
  });

  it("keeps a PARTICIPANT off every staff screen", () => {
    for (const path of ["/experiences", `/experiences/${WORKSHOP_ID}`, "/admin"]) {
      expect(isForbiddenPath(path, "PARTICIPANT"), path).toBe(true);
    }
  });

  it("keeps an absent or unrecognised role off every staff screen (fails closed)", () => {
    for (const role of [undefined, null, "", "SUPERUSER"]) {
      expect(isForbiddenPath("/experiences", role), String(role)).toBe(true);
      expect(isForbiddenPath("/admin", role), String(role)).toBe(true);
      expect(isForbiddenPath(SETTINGS_PATH, role), String(role)).toBe(true);
      expect(isForbiddenPath("/experiences/new", role), String(role)).toBe(true);
    }
  });
});

// ─── Gate (b): /admin is ADMIN + FACILITATOR ─────────────────────────────────

describe("Administration area", () => {
  it("admits ADMIN and FACILITATOR", () => {
    for (const role of ["ADMIN", "FACILITATOR"]) {
      for (const path of USER_ADMIN_PATHS) {
        expect(isForbiddenPath(path, role), `${role} → ${path}`).toBe(false);
      }
      // The tabs are query parameters on /admin, so they inherit this gate rather
      // than needing their own, including the new Experiences tab.
      expect(isForbiddenPath("/admin", role)).toBe(false);
    }
  });

  it("bounces JUDGE and EXECUTIVE, who DO reach the other staff screens", () => {
    for (const role of ["JUDGE", "EXECUTIVE"]) {
      expect(isForbiddenPath("/admin", role), role).toBe(true);
      // The contrast that makes this gate necessary: gate (a) admits them.
      expect(isForbiddenPath("/experiences", role), role).toBe(false);
      expect(isForbiddenPath(`/experiences/${WORKSHOP_ID}`, role), role).toBe(false);
    }
  });
});

// ─── Gate (c): experience configuration is ADMIN + FACILITATOR ───────────────

/**
 * The gate this change added. A JUDGE or EXECUTIVE could previously type
 * /experiences/<id>/settings and be served the configuration form, it would refuse to
 * SAVE (the Workshop service requires ownership-or-ADMIN), but it rendered, which
 * means it disclosed the experience's configuration to a role with no business
 * reading it. Hiding the link was not a gate; this is.
 */
describe("experience configuration routes", () => {
  it("admits ADMIN and FACILITATOR to the settings and create forms", () => {
    for (const role of ["ADMIN", "FACILITATOR"]) {
      expect(isForbiddenPath(SETTINGS_PATH, role), role).toBe(false);
      expect(isForbiddenPath("/experiences/new", role), role).toBe(false);
    }
  });

  it("bounces JUDGE and EXECUTIVE from the settings form", () => {
    for (const role of ["JUDGE", "EXECUTIVE"]) {
      expect(isForbiddenPath(SETTINGS_PATH, role), role).toBe(true);
      expect(isForbiddenPath("/experiences/new", role), role).toBe(true);
    }
  });

  it("bounces a PARTICIPANT, who gate (a) already stops", () => {
    // Belt and braces: if PARTICIPANT_PATHS ever grew a /experiences entry, this gate
    // would still hold the settings form shut.
    expect(isForbiddenPath(SETTINGS_PATH, "PARTICIPANT")).toBe(true);
  });

  it("leaves the READ-ONLY workshop screens open to every staff role", () => {
    // The gate must be the narrow tail, never the /experiences prefix, a judge scores
    // an experience and an executive observes one, so both must still reach the list
    // and the detail page. Getting this wrong would lock two roles out of the app.
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE"]) {
      for (const path of [
        "/experiences",
        `/experiences/${WORKSHOP_ID}`,
        `/experiences/${WORKSHOP_ID}?tab=teams`.split("?")[0],
      ]) {
        expect(isForbiddenPath(path, role), `${role} → ${path}`).toBe(false);
      }
    }
  });

  it("does not let a longer or nested path escape the settings gate", () => {
    // `[^/]+` for the id and anchors at both ends. A greedy `.+` would let a nested
    // path match (or fail to match) as settings depending on the segment count, and
    // "does not match" is the dangerous direction: it means ungated.
    for (const path of [
      SETTINGS_PATH,
      `${SETTINGS_PATH}/`,
      "/experiences/new",
      "/experiences/new/",
    ]) {
      expect(isForbiddenPath(path, "JUDGE"), path).toBe(true);
    }
  });

  it("does not gate paths that only LOOK like the settings form", () => {
    // Documents the boundary rather than asserting a wish: these are ordinary
    // workshop reads and must stay open to a judge.
    for (const path of [
      `/experiences/${WORKSHOP_ID}/settingsx`,
      `/experiences/${WORKSHOP_ID}/teams`,
      "/experiences/newest",
    ]) {
      expect(isForbiddenPath(path, "JUDGE"), path).toBe(false);
    }
  });

  it("has patterns that are all anchored, so no suffix can slip past", () => {
    // A structural assertion, because an unanchored addition to the list would pass
    // every behavioural test above while quietly matching more than intended.
    for (const pattern of WORKSHOP_ADMIN_PATTERNS) {
      expect(pattern.source.startsWith("^"), pattern.source).toBe(true);
      expect(pattern.source.endsWith("$"), pattern.source).toBe(true);
    }
  });
});

// ─── The gates as a whole ────────────────────────────────────────────────────

describe("gate ordering", () => {
  it("never admits a role to a narrow gate while failing the broad one", () => {
    // The invariant that makes the redirect terminate: anything gate (a) forbids must
    // stay forbidden by the composite, whatever the narrower gates say. If this ever
    // failed, a participant would reach a screen by way of a narrower rule.
    const narrowPaths = ["/admin", SETTINGS_PATH, "/experiences/new"];
    for (const role of [...ALL_ROLES, "SUPERUSER", undefined]) {
      for (const path of narrowPaths) {
        if (isForbiddenPath("/experiences", role)) {
          expect(isForbiddenPath(path, role), `${role} → ${path}`).toBe(true);
        }
      }
    }
  });

  it("admits ADMIN everywhere a gated screen exists", () => {
    for (const path of [
      "/experiences",
      `/experiences/${WORKSHOP_ID}`,
      SETTINGS_PATH,
      "/experiences/new",
      "/admin",
      "/profile",
    ]) {
      expect(isForbiddenPath(path, "ADMIN"), path).toBe(false);
    }
  });
});

/**
 * ── ⚠ THE DOCUMENTATION PAGE MUST BE REACHABLE BY THE ROLE IT IS FOR ───────────────────────
 *
 * A "how it works" link, visible to every signed-in role, an explicit
 * choice over staff-only.
 *
 * This is the failure the Submit tab already had once: a surface offered to a role that
 * `isForbiddenPath` then bounces. It is invisible without signing in as that role, and the consequence here
 * would be a page written FOR participants that participants alone cannot open.
 */
describe("/how-it-works is readable by everyone signed in", () => {
  for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE", "FACILITATOR", "ADMIN"]) {
    it(`admits a ${role}`, () => {
      expect(isForbiddenPath("/how-it-works", role)).toBe(false);
    });
  }

  it("⚠ admits a PARTICIPANT specifically, the audience most likely to need it", () => {
    // Spelled out separately from the loop: PARTICIPANT is the one role `isForbiddenPath` confines by
    // default, so it is the only one this can be wrong for, and the loop above would still pass four times.
    expect(isForbiddenPath("/how-it-works", "PARTICIPANT")).toBe(false);
  });

  it("⚠ still requires a SESSION, and that is middleware's job, not this predicate's", () => {
    /**
     * ⚠ THIS ASSERTION WAS WRONG ON ITS FIRST DRAFT and the failure is worth recording, because it reflects
     * a real misunderstanding of what `isForbiddenPath` is for.
     *
     * It originally asserted `isForbiddenPath("/how-it-works", null) === true`, reasoning that an
     * unauthenticated visitor must be refused. That is not this function's job: it answers "may THIS ROLE
     * see this path", and once a path is in `PARTICIPANT_PATHS` it admits every role, including a null
     * one. Authentication is a separate check in middleware, keyed on `PUBLIC_PATHS`.
     *
     * So the real guarantee is that the page is NOT public: it is absent from `PUBLIC_PATHS`, which is what
     * makes middleware demand a session before this predicate is ever consulted.
     */
    expect(PUBLIC_PATHS).not.toContain("/how-it-works");
    // And for completeness: the role gate itself admits everyone, by design.
    expect(isForbiddenPath("/how-it-works", null)).toBe(false);
  });
});
