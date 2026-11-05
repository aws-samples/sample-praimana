// ── ⚠ A STATUS PAGE'S ONE UNFORGIVABLE BUG IS READING "FINE" WHEN IT CANNOT TELL ─────────────
//
// A read-only platform health tab in Administration, visible only to admins and facilitators.
//
// The panel itself is a list. What these tests protect is the handful of decisions that make it honest, each
// of which has a comfortable, wrong alternative that a later edit would reach for:
//
//   · no alarms ⇒ UNKNOWN, not healthy. "We found nothing to check" is not "we checked";
//   · the failure branch says the CHECK failed, not that the platform is down;
//   · every state carries a glyph and a word, so it is not colour alone;
//   · it is READ-ONLY, no acknowledge, no silence, no reset;
//   · the audience is the /admin gate, not a second per-tab role check that could disagree with it.
//
// Source assertions, with comments stripped: a source test can otherwise pass on a COMMENT that
// quotes the thing being asserted rather than on the code.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { sourceWithoutComments } from "@/lib/source-under-test";
import { USER_ADMIN_PATHS } from "@/lib/route-gates";
import { canManageUsers } from "@praimana/shared";

const admin = sourceWithoutComments(join(__dirname, "page.tsx"));
const healthRouter = sourceWithoutComments(
  join(__dirname, "..", "..", "lib", "trpc", "routers", "health.ts")
);

describe("who can see the platform health tab", () => {
  it("⚠ inherits the /admin gate rather than adding a second one", () => {
    /**
     * "only visible to admin and facilitators" is ALREADY what /admin means, so the correct implementation is
     * no new gate at all. A per-tab role check would be a second source of truth that could drift from the
     * route gate, and the service refuses the underlying route regardless, so a UI check could only ever
     * hide a tab, never protect anything.
     */
    expect(USER_ADMIN_PATHS).toContain("/admin");
    expect(canManageUsers("ADMIN")).toBe(true);
    expect(canManageUsers("FACILITATOR")).toBe(true);
    for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
      expect(canManageUsers(role), role).toBe(false);
    }
  });

  it("registers the tab and renders it", () => {
    expect(admin).toMatch(/key: "health"/);
    expect(admin).toMatch(/tab === "health" && <HealthTab \/>/);
  });
});

describe("the panel cannot report healthy when it does not know", () => {
  it("⚠ treats an EMPTY alarm set as UNKNOWN", () => {
    // The reassuring wrong version is `data.overall` straight through: with no alarms the service reports OK
    // (nothing is in alarm), and the panel would render "Everything is reporting healthy" having checked
    // nothing at all.
    expect(admin).toMatch(/alarms\.length === 0 \? "UNKNOWN"/);
  });

  it("⚠ defaults a missing verdict to UNKNOWN, never OK", () => {
    expect(admin).toMatch(/\?\? "UNKNOWN"/);
    expect(admin, "no reassuring fallback anywhere in the panel").not.toMatch(/\?\? "OK"/);
    expect(healthRouter).toMatch(/\?\? "UNKNOWN"/);
    expect(healthRouter).not.toMatch(/\?\? "OK"/);
  });

  it("⚠ lets the service's 503 surface instead of catching it into an empty success", () => {
    // A `try/catch` in the BFF returning `{ alarms: [] }` would convert an outage into a reassurance. The
    // router must have no catch at all.
    expect(healthRouter).not.toMatch(/catch/);
  });

  it("⚠ distinguishes 'the check failed' from 'the platform is unhealthy' in the copy", () => {
    expect(admin).toMatch(/could not be read/i);
    expect(admin).toMatch(/says nothing about whether the platform is healthy/i);
  });
});

describe("presentation", () => {
  it("⚠ every state has a NON-COLOUR signal, a glyph and a word", () => {
    /**
     * The platform's a11y rule, and the reason it matters most on this screen: "is anything wrong" has to be
     * answerable at a glance by somebody who cannot distinguish the colours.
     */
    for (const state of ["OK", "ALARM", "UNKNOWN"]) {
      const block = new RegExp(`${state}: \\{[^}]*glyph: "[^"]+"[^}]*word: "[^"]+"`, "s");  // nosemgrep: missing-template-string-indicator
      expect(admin, `${state} needs both a glyph and a word`).toMatch(block);
    }
  });

  it("⚠ keeps the runbook, behind a disclosure rather than deleted", () => {
    // The alarm descriptions are hand-written operator prose WITH runbooks, the most useful text on the
    // screen when something is wrong. Summarised in the row, complete on request, never truncated away.
    expect(admin).toMatch(/<details/);
    expect(admin).toMatch(/alarm\.description/);
  });

  it("is READ-ONLY: no mutation is wired to it", () => {
    // "readly platform health tab" (owner). Acknowledging or silencing an alarm from here would be an
    // operational action on a page whose audience includes facilitators.
    expect(healthRouter).not.toMatch(/\.mutation\(/);
    expect(healthRouter).toMatch(/protectedProcedure\.query/);
  });

  it("polls, so a page left open during an incident does not freeze on a stale verdict", () => {
    expect(admin).toMatch(/refetchInterval: 60_000/);
  });
});

describe("the capitalised labels", () => {
  /**
   * "Desktop" and "Portal", every label in initial caps, plus
   * "Experience: … · Team: …" with the labels in bold.
   */
  it("⚠ labels Experience and Team in bold, with colons", () => {
    expect(admin).toMatch(/font-semibold[^>]*>Experience:</);
    expect(admin).toMatch(/font-semibold[^>]*>Team:</);
  });

  it("⚠ renders the surface through the shared label, not the raw stored value", () => {
    // The stored value stays lowercase, it is an API field the desktop sends and the service validates -
    // so capitalising it at the source would have been a breaking change dressed up as copy.
    expect(admin).toMatch(/surfaceLabel\(report\.surface\)/);
    expect(admin).not.toMatch(/\{report\.surface\}/);
  });

  it("writes the reporter's role as a word rather than shouting the enum", () => {
    expect(admin).toMatch(/platformRoleLabel\(report\.reportedByRole\)/);
  });

  it("capitalises the other labels on the same line", () => {
    for (const label of ["App:", "Version:", "Screen:", "Filed:"]) {
      expect(admin, label).toContain(`>${label}<`);
    }
  });
});
