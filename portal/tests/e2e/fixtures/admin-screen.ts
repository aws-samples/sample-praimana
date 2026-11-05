/**
 * ── THE /admin SCREEN'S tRPC SURFACE, WITH THE REAL PROCEDURE NAMES ─────────────────────────
 *
 * Every spec that renders /admin needs the same handful of procedures, and the redesign work
 * guessed their names three times and got them wrong three times:
 *
 *   guessed `admin.platformHealth`  → real `health.platform`
 *   guessed `admin.feedback`        → real `feedback.list`
 *   guessed `team.listPlatformInvitations` → real `team.listInvitations`
 *
 * Each wrong guess made the page render an error or an endless loading state, which was then
 * diagnosed as a product problem or as a role-gating limitation of the harness. Neither was true.
 *
 * ⚠ THE NAMES BELOW ARE TAKEN FROM `src/lib/trpc/routers/`, NOT FROM MEMORY. If a router is
 * renamed, `expectAllProceduresStubbed()` in trpc.ts is what turns the resulting silence into a
 * failed test with the missing path named.
 *
 * ⚠ EVERY DEFAULT IS EMPTY, DELIBERATELY. A spec opts into the data it is about by overriding one
 * key, so it cannot accidentally depend on a fixture it did not read. Empty responses also
 * exercise the empty states, which is where two of the layout bugs in this redesign lived.
 */

import type { ProcedureHandler } from "./trpc";
import { meFixture } from "./data";
import type { SpecIdentity } from "./session";

/** A workshop shaped as `workshop.list` returns it. */
export function workshopFixture(over: Partial<AdminWorkshop> = {}): AdminWorkshop {
  return {
    id: "wksp-admin-0001",
    name: "Frontier Agents Accelerator",
    description: "Six teams building agentic workflows against a live retail dataset.",
    format: "IN_PERSON",
    status: "ACTIVE",
    createdAt: "2026-08-01T09:00:00Z",
    ownerId: "sub-admin-0001",
    teams: [],
    _count: { teams: 6 },
    ...over,
  };
}

export interface AdminWorkshop {
  id: string;
  name: string;
  description: string | null;
  format: string;
  status: string;
  createdAt: string;
  ownerId: string;
  teams: unknown[];
  _count: { teams?: number };
}

/** A registered account shaped as `admin.listUsers` returns it. */
export function userFixture(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "sub-user-0001",
    name: "Priya Raman",
    email: "priya@example.test",
    role: "PARTICIPANT",
    organization: "Acme",
    /** ⚠ `status`, NOT `disabledAt`. `isUserDeactivated` reads `status === "DEACTIVATED"`. */
    status: "ACTIVE",
    invitedBy: null,
    isSelf: false,
    hasAccount: true,
    createdAt: "2026-07-01T09:00:00Z",
    ...over,
  };
}

export interface AdminUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
  organization: string | null;
  status: string;
  invitedBy: { name?: string | null; email?: string | null } | null;
  isSelf: boolean;
  hasAccount: boolean;
  createdAt: string;
}

/**
 * Every procedure /admin's seven tabs touch, all answering empty.
 *
 * Spread it and override what the spec is about:
 *
 *   await serveTrpc(page, { ...adminScreen(ADMIN_SELF), "admin.listUsers": () => ({ users, … }) })
 */
export function adminScreen(identity: SpecIdentity): Record<string, ProcedureHandler> {
  return {
    // Chrome — ProfileMenu renders on every authenticated screen.
    "auth.me": () => meFixture(identity),

    // Users tab
    "admin.listUsers": () => ({ users: [], nextCursor: null, scopeTruncated: false }),
    "admin.filterScopes": () => ({ workshops: [], teams: [] }),
    "admin.invitableExperiences": () => ({ experiences: [], truncated: false }),

    // Teams tab
    "team.listDirectory": () => ({ teams: [], nextCursor: null, scopeTruncated: false }),

    // Invitations tab  ⚠ `team.listInvitations`, not `listPlatformInvitations`
    "team.listInvitations": () => [],

    // Experiences tab
    "workshop.list": () => [],

    // Feedback tab  ⚠ `feedback.list`, not `admin.feedback`
    "feedback.list": () => ({ items: [], nextCursor: null, unreadCount: 0 }),

    // Platform health tab  ⚠ `health.platform`, not `admin.platformHealth`
    "health.platform": () => ({
      alarms: [],
      overall: "OK",
      checkedAt: "2026-08-29T10:00:00Z",
    }),

    /* Cost tab (ADMIN only).
       ⚠ `cost.platform`, NOT `health.byService`. `costRouter` is exported from
       `routers/health.ts` but mounted at `cost:` in `root.ts` — so the FILE it lives in is not
       its path. This one was the fourth wrong guess, and it is exactly the case that
       `expectAllProceduresStubbed()` now names instead of leaving to guesswork. */
    "cost.platform": () => ({
      currency: "USD",
      monthToDate: 0,
      yesterday: 0,
      dailyAverage: 0,
      projectedMonth: 0,
      taggedTotal: 0,
      byService: [],
      daily: [],
      asOf: "2026-08-29T10:00:00Z",
      since: "2026-08-01T00:00:00Z",
    }),
  };
}
