// ── ⚠ THE BOUNDARY OF THE EXECUTIVE WRITE GRANT ──────────────────────────────────────────
//
// Executives may take part in the team's chat, scoped to chat AND the task board. This file exists to pin what was NOT granted, because that is the part a
// future change is most likely to erode.
//
// ⚠ THE SCOPE WAS MEASURED BEFORE IT WAS WIDENED — and the measurement is why the grant is a
// dedicated guard rather than an edit to `READ_ONLY_ROLES`. That constant gates ~34 write routes
// across SEVEN services. Removing EXECUTIVE from it would also have granted:
//
//     POST /submissions/:submissionId/scores   ← JUDGING SCORES
//     POST /teams/:teamId/submissions          ← the team's submitted work
//     POST /teams/:teamId/ratings              ← member ratings
//     POST /teams/:teamId/docs (+ upload URLs)  ← the team's documents
//     POST /teams/:teamId/commits              ← source history
//
// An executive writing judging scores is a competition-integrity problem, not a permissions
// convenience. `apps/services/ai/src/authz.ts` recorded the same reasoning when it hit this wall for
// AI insights and chose a narrow guard; this follows that precedent.

import { describe, it, expect } from "vitest";
import { isReadOnlyRole } from "./authz";

describe("⚠ READ_ONLY_ROLES is UNTOUCHED — the grant did not leak", () => {
  /**
   * THE MOST IMPORTANT ASSERTION IN THIS FILE.
   *
   * `isReadOnlyRole` is what the other six services import to refuse writes. If a future change
   * "simplifies" the executive grant by dropping EXECUTIVE from that set, this fails — and the
   * failure is the warning that judging scores, submissions, ratings, docs and commits just opened
   * up as a side effect.
   */
  it("still classifies EXECUTIVE as a read-only role", () => {
    expect(
      isReadOnlyRole("EXECUTIVE"),
      "EXECUTIVE must stay read-only GLOBALLY — the chat/board grant is a local exception, " +
        "not a change to the role"
    ).toBe(true);
  });

  it("does not classify a writing role as read-only", () => {
    for (const role of ["PARTICIPANT", "ADMIN", "FACILITATOR", "JUDGE"]) {
      expect(isReadOnlyRole(role), `${role} should not be read-only`).toBe(false);
    }
  });

  /**
   * ⚠ FAIL CLOSED ON AN UNKNOWN ROLE — but note which direction "closed" is here. `isReadOnlyRole`
   * answering false for an unrecognised role means such a role is NOT treated as read-only, so the
   * membership predicate is the thing that must refuse it. That is the existing contract and this
   * test records it rather than changing it: the guard's own membership check is what holds.
   */
  it("returns false for an unknown role, leaving membership to decide", () => {
    expect(isReadOnlyRole("SUPERUSER")).toBe(false);
    expect(isReadOnlyRole("")).toBe(false);
  });
});

describe("the grant is scoped to this service's three routes", () => {
  /**
   * A structural assertion rather than a behavioural one, because the risk is someone reaching for
   * the permissive guard on a route it was not meant for. There are exactly three write routes in
   * this service — tasks POST, tasks PATCH, messages POST — and all three are conversation or
   * planning. If a fourth write route appears, it must make this choice deliberately rather than
   * inheriting it.
   */
  it("uses the collaboration guard on exactly the three write routes", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./routes.ts", import.meta.url), "utf8")
    );

    const permissive = [...src.matchAll(/requireTeamCollaborationWrite\(/g)];
    const strict = [...src.matchAll(/requireTeamContentWrite\(/g)];

    expect(permissive.length, "tasks POST, tasks PATCH, messages POST").toBe(3);
    // If a future route needs the STRICT guard it is welcome to it — this only pins that the
    // permissive one has not spread beyond the three it was granted for.
    expect(strict.length).toBe(0);

    const writeRoutes = [...src.matchAll(/\.(post|patch|put|delete)\("/g)];
    expect(
      writeRoutes.length,
      "a new write route appeared — it must choose a guard deliberately, not inherit this one"
    ).toBe(3);
  });
});
