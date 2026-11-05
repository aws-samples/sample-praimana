/**
 * ── THE TEAM WORKSPACE'S tRPC SURFACE, WITH THE REAL PROCEDURE NAMES ────────────────────────
 *
 * Nine routes live under `/w/<workshop>/t/<team>/…` and they share a layout that queries
 * `team.getById` on every one of them. Each tab then adds its own procedures.
 *
 * ⚠ NAMES TAKEN FROM `src/lib/trpc/routers/`, NOT FROM MEMORY. Guessing them cost the /admin work
 * four wrong fixtures and three false conclusions about the product; `expectAllProceduresStubbed()`
 * in trpc.ts is what turns a wrong name into a failing test that names the missing path.
 *
 * ⚠ EVERY DEFAULT IS EMPTY. A spec overrides the one key it is about, so it cannot lean on data it
 * never read — and the empty responses exercise the empty states, which is where the layout bugs in
 * this redesign have actually been.
 */

import type { ProcedureHandler } from "./trpc";
import { meFixture, teamFixture, type TeamMemberFixture } from "./data";
import type { SpecIdentity } from "./session";

/**
 * Every procedure the nine workspace routes touch.
 *
 * ⚠ `team.getById` IS THE ONE THE LAYOUT NEEDS, so a spec that stubs nothing else still renders
 * the nav. It reads `team.name`, `team.workshop`, `team.members`, `team.phases`, `team.teamPhases`
 * and `team.inviteCode` — `teamFixture` supplies all six, including the `phases`/`teamPhases`
 * duplication its own note explains.
 */
export function teamWorkspace(
  identity: SpecIdentity,
  members: TeamMemberFixture[] = []
): Record<string, ProcedureHandler> {
  return {
    // Chrome, on every authenticated screen.
    "auth.me": () => meFixture(identity),

    // The layout, and therefore all nine routes.
    "team.getById": () => teamFixture(members),

    // Team tab
    "team.listFormerMembers": () => [],
    "team.listInvitations": () => [],

    // Phases + submit
    "phase.listForTeam": () => [],
    "workshop.getById": () => ({
      id: "wksp-e2e-0001",
      name: "E2E Accelerator",
      description: "Six teams, three phases.",
      format: "IN_PERSON",
      status: "ACTIVE",
      phases: [],
      setupConfig: null,
      enabledAssistants: ["claude"],
    }),

    // Board
    "task.list": () => [],

    // Chat
    "message.list": () => ({ messages: [], nextCursor: null }),

    // AI transcripts
    "ai.getThreads": () => [],
    "ai.tokenUsage": () => null,

    /* Submit.
       ⚠ `submission.ensure` IS A MUTATION THE PAGE FIRES ON MOUNT, not a query — it creates the
       team's draft submission if none exists. It is easy to miss when reading the page for
       `useQuery` calls, and `expectAllProceduresStubbed()` is what surfaced it. */
    "docs.list": () => [],
    "submission.list": () => [],
    "submission.ensure": () => ({
      submissionId: "sub-e2e-0001",
      teamId: "team-e2e-0001",
      title: "",
      problemStatement: "",
      solution: "",
      demoUrl: "",
      repoUrl: "",
      slidesUrl: "",
      videoUrl: "",
      releasedAt: null,
      artifactCount: 0,
      phases: [],
    }),

    /* Insights.
       ⚠ `rating.summary` AND `rating.analysis` ARE DIFFERENT PROCEDURES — team-level and
       per-member. Stubbing one and not the other leaves half the page in a loading state, which
       reads as a broken page rather than a missing stub. */
    "rating.summary": () => null,
    "rating.analysis": () => null,
    "rating.prompts": () => null,
  };
}
