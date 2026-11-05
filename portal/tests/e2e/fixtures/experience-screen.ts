/**
 * ── THE EXPERIENCE SUB-PAGES' tRPC SURFACE, PLUS THE REMAINING STANDALONE SCREENS ────────────
 *
 * Six routes sit under `/experiences/<id>/…` behind a layout that renders `AppHeader` and
 * `ExperienceHeader`; the latter queries `workshop.getById` on every one of them. The onboarding
 * and account screens (`/welcome`, `/profile`, `/experiences/new`) are here too because they share
 * nothing with each other and do not justify a file each.
 *
 * ⚠ NAMES TAKEN FROM `src/lib/trpc/routers/`. Guessing them cost the /admin work four wrong
 * fixtures and three false conclusions about the product; `expectAllProceduresStubbed()` is what
 * turns a wrong name into a failing test that names the missing path rather than a page that merely
 * looks broken.
 *
 * ⚠ `ExperienceHeader` READS `workshop.teams` — and it read it UNGUARDED until this redesign, so a
 * response without that array blank-screened all six routes at once. `workshopDetail()` supplies it.
 */

import type { ProcedureHandler } from "./trpc";
import { meFixture } from "./data";
import type { SpecIdentity } from "./session";

export interface WorkshopDetail {
  id: string;
  name: string;
  description: string | null;
  format: string;
  status: string;
  ownerId: string;
  startsAt: string | null;
  endsAt: string | null;
  teams: unknown[];
  phases: Array<{ id: string; name: string; status: string; order: number }>;
  setupConfig: null;
  enabledAssistants: string[];
  _count: { teams?: number };
}

export function workshopDetail(over: Partial<WorkshopDetail> = {}): WorkshopDetail {
  return {
    id: "wksp-e2e-0001",
    name: "E2E Accelerator",
    description: "Six teams, three phases, one week.",
    format: "IN_PERSON",
    status: "ACTIVE",
    ownerId: "sub-admin-0001",
    startsAt: "2026-09-01T09:00:00Z",
    endsAt: "2026-09-05T17:00:00Z",
    /** ⚠ Required by ExperienceHeader's tab count. Absent, the whole area used to crash. */
    teams: [],
    phases: [
      { id: "ph-1", name: "Ideation", status: "COMPLETED", order: 1 },
      { id: "ph-2", name: "Build", status: "CURRENT", order: 2 },
      { id: "ph-3", name: "Demo", status: "UPCOMING", order: 3 },
    ],
    setupConfig: null,
    enabledAssistants: ["claude"],
    _count: { teams: 6 },
    ...over,
  };
}

/** Every procedure the six `/experiences/<id>/…` routes touch, answering empty. */
export function experienceScreen(
  identity: SpecIdentity,
  workshop: WorkshopDetail = workshopDetail()
): Record<string, ProcedureHandler> {
  return {
    "auth.me": () => meFixture(identity),

    // The layout's ExperienceHeader, and therefore all six routes.
    "workshop.getById": () => workshop,

    // Overview
    "team.getMyTeam": () => null,

    // Settings
    "workshop.formats": () => [
      { value: "IN_PERSON", label: "In person" },
      { value: "VIRTUAL", label: "Virtual" },
      { value: "HYBRID", label: "Hybrid" },
    ],

    // Activity
    "insights.experienceActivity": () => ({ teams: [], totals: { people: 0, teams: 0 } }),

    // Submissions + results
    "submission.forWorkshop": () => [],
    "submission.results": () => null,
    "submission.resultsPreview": () => null,

    // One submission
    "submission.byId": () => null,
    "submission.scores": () => [],
    "submission.snapshot": () => null,
    "docs.list": () => [],
  };
}

/** `/welcome` — the participant's first screen after sign-in. */
export function welcomeScreen(identity: SpecIdentity): Record<string, ProcedureHandler> {
  return {
    "auth.me": () => meFixture(identity),
    "team.listMyInvitations": () => [],
    "desktop.releases": () => [],
    "desktop.connectLink": () => null,
  };
}

/** `/profile` — the account screen. */
export function profileScreen(identity: SpecIdentity): Record<string, ProcedureHandler> {
  return { "auth.me": () => meFixture(identity) };
}

/** `/experiences/new` — the create form. */
export function newExperienceScreen(identity: SpecIdentity): Record<string, ProcedureHandler> {
  return {
    "auth.me": () => meFixture(identity),
    "workshop.formats": () => [
      { value: "IN_PERSON", label: "In person" },
      { value: "VIRTUAL", label: "Virtual" },
    ],
  };
}
