import { describe, it, expect } from "vitest";

/**
 * The Administration directory's SCOPE FILTER, and its seeding from the URL.
 *
 * The workshop People tab LINKS to the Administration screen rather than growing its own
 * copy of that list. That screen already has full user details, server-side
 * search across every page, cursor pagination, the "invited by" provenance line and the role
 * controls, a second implementation on the workshop page would be two lists to keep in step,
 * and the workshop one would be the one that quietly lagged.
 *
 * For the link to be useful it must arrive PRE-FILTERED, so the users tab now seeds its scope
 * from `?scope=w:<workshopId>`. That makes the query string an input, and an input from a URL
 * is one a person can hand-edit, so what matters is that a malformed value degrades to the
 * unfiltered directory rather than producing a request the backend refuses.
 *
 * `decodeScope` is mirrored here rather than exported: it is a private helper in a "use
 * client" page component, and importing that page into a node-environment test would pull in
 * React, next/navigation and the whole tRPC client for four lines of string handling.
 */

/** Mirrors `decodeScope` in app/admin/page.tsx. */
function decodeScope(scope: string): [string | undefined, string | undefined] {
  if (scope.startsWith("t:")) return [scope.slice(2), undefined];
  if (scope.startsWith("w:")) return [undefined, scope.slice(2)];
  return [undefined, undefined];
}

/** Mirrors the seeding guard: accept the URL value only if it decodes to a real filter. */
function seedScope(raw: string | null): string {
  const value = raw ?? "";
  return decodeScope(value).some(Boolean) ? value : "";
}

describe("decodeScope", () => {
  it("decodes a workshop scope, what the People tab link sends", () => {
    expect(decodeScope("w:01KZ156Z8E")).toEqual([undefined, "01KZ156Z8E"]);
  });

  it("decodes a team scope", () => {
    expect(decodeScope("t:01KZ1C9Z61")).toEqual(["01KZ1C9Z61", undefined]);
  });

  it("NEVER returns both, the encoding makes the invalid request unrepresentable", () => {
    // The reason scope is one string rather than two pieces of state: the team service
    // refuses a request carrying both teamId and workshopId, correctly, since it cannot know
    // which was meant. A shape that cannot hold both cannot send that request.
    for (const raw of ["w:a", "t:b", "", "nonsense", "w:", "t:"]) {
      const [teamId, workshopId] = decodeScope(raw);
      expect(teamId !== undefined && workshopId !== undefined).toBe(false);
    }
  });

  it("returns no filter for an unrecognised prefix", () => {
    expect(decodeScope("x:whatever")).toEqual([undefined, undefined]);
    expect(decodeScope("01KZ156Z8E")).toEqual([undefined, undefined]);
    expect(decodeScope("")).toEqual([undefined, undefined]);
  });
});

describe("seeding the scope from ?scope=", () => {
  it("accepts a well-formed workshop scope", () => {
    expect(seedScope("w:01KZ156Z8E")).toBe("w:01KZ156Z8E");
  });

  it("falls back to UNFILTERED for a malformed value", () => {
    // A hand-edited or stale URL must degrade to the full directory, which the operator can
    // then filter themselves, rather than sending something the backend rejects and
    // rendering an error where a list should be.
    for (const raw of ["x:1", "garbage", "w", "t", ":", null]) {
      expect(seedScope(raw)).toBe("");
    }
  });

  it("falls back when the prefix is present but the id is EMPTY", () => {
    // `w:` decodes to workshopId "", truthy-prefix, falsy-id. That would send an empty
    // filter value and scope the directory to a workshop that cannot exist, showing zero
    // people and reading as "nobody is in this experience".
    expect(seedScope("w:")).toBe("");
    expect(seedScope("t:")).toBe("");
  });

  it("treats an absent parameter as unfiltered", () => {
    // The normal case: someone opens /admin?tab=users directly.
    expect(seedScope(null)).toBe("");
  });
});
