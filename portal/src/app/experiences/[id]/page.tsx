"use client";

import { Suspense, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { BulkTeamUpload } from "@/components/BulkTeamUpload";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { formatLabel, statusLabel, workshopDate } from "@/lib/workshop-display";
import { useSession } from "next-auth/react";
import { useCanManageUsers } from "@/lib/useRole";

/**
 * The workshop this page renders, and its two nested lists, DERIVED from the procedure that
 * loads them, so the panels below cannot disagree with the BFF about the shape.
 *
 * Every panel here took `workshop: any` until the backend responses were typed, which is why the
 * `.map()` callbacks had to be annotated too. `RouterOutputs` (lib/trpc/client.ts) explains why
 * this is derived rather than declared.
 */
type Workshop = RouterOutputs["workshop"]["getById"];
type WorkshopTeam = Workshop["teams"][number];
type WorkshopPhase = Workshop["phases"][number];
type TeamMember = NonNullable<WorkshopTeam["members"]>[number];
/** `| undefined` because a react-query result is undefined until the query has answered, the
 *  procedure itself resolves to the team or `null`. */
type MyTeam = RouterOutputs["team"]["getMyTeam"] | undefined;

/**
 * The views of a workshop, as TABS rather than one long scroll.
 *
 * The tab lives in the URL (`?tab=`), NOT in component state, and that is the whole
 * reason this is a `useSearchParams` page: a facilitator running a live session
 * shares links ("look at the Teams view"), reloads after a deploy, and hits Back
 * expecting to land where they were. Local state loses all three silently. It also
 * means a deep link from elsewhere in the app, the workshops list, an email, can
 * point at one specific view.
 *
 * SETTINGS is a tab in this bar but NOT a tab panel: it navigates to its own route
 * (/experiences/[id]/settings), because it is a form with unsaved state and rendering
 * it inline would put a half-edited form one stray click away from being discarded.
 * It is a tab entry because it used to be an unlabelled gear in the top-right corner,
 * which is where users do not look for it, the tab bar is where this page's other
 * views already are. `navigates` marks that difference so the render loop treats it
 * as a link rather than as a `?tab=` value it would then fail to match.
 *
 * WHO SEES EACH NAVIGATING TAB is decided at render by `canOpenExperienceTab` (lib/experience-tabs.ts,
 * with tests), not
 * declared on the entry: it depends on the loaded workshop's ownerId as well as the
 * role, so it cannot be a static property of this table. A JUDGE or EXECUTIVE
 * reaching this page is observing the experience, not running it. Hiding the entry is
 * only the offer, middleware.ts bounces the ROUTE and the Workshop service enforces
 * ownership on every write.
 */
/**
 * ── THE PANELS THIS PAGE RENDERS, AND NOTHING ABOUT THE TAB BAR ────────────────────────────
 *
 * ⚠ THE TAB TABLE MOVED to `components/ExperienceHeader.tsx`, which the area's layout mounts, Activity,
 * Submissions and Results are tabs in that bar and were rendering without it. What is left here is the
 * one thing this page still decides: which `?tab=` values name a panel it can show.
 */
const PANEL_TABS = ["overview", "teams", "people", "phases"] as const;


/** The `?tab=` values that render a panel here, i.e. every tab but Settings. */
type TabKey = (typeof PANEL_TABS)[number];

/** True if `key` is a panel tab, so a stray ?tab=settings falls back to overview
 *  rather than rendering an empty main. */
function isPanelTab(key: string | null): key is TabKey {
  return PANEL_TABS.some((t) => t === key);
}

export default function WorkshopDetailPage() {
  return (
    // useSearchParams needs a Suspense boundary to prerender; same shape as
    // app/login/page.tsx.
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center py-24">
          <div className="animate-pulse text-ink-tertiary">Loading...</div>
        </div>
      }
    >
      <WorkshopDetailPageInner />
    </Suspense>
  );
}

function WorkshopDetailPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const workshopId = params.id as string;

  // An unrecognised ?tab= falls back to overview rather than rendering nothing -
  // a stale bookmark should still show the workshop. ?tab=settings is unrecognised
  // HERE on purpose: Settings is a route, not a panel (see the TABS comment).
  const requested = searchParams.get("tab");
  const activeTab: TabKey = isPanelTab(requested) ? requested : "overview";

  const { data: workshop, isLoading } = trpc.workshop.getById.useQuery({
    id: workshopId,
  });
  const { data: myTeam } = trpc.team.getMyTeam.useQuery(
    { workshopId },
    { enabled: !!session }
  );

  const [showJoin, setShowJoin] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [teamName, setTeamName] = useState("");

  const utils = trpc.useUtils();

  const setCurrentPhase = trpc.workshop.setCurrentPhase.useMutation({
    onSuccess: () => {
      utils.workshop.getById.invalidate({ id: workshopId });
    },
  });

  const createTeam = trpc.team.create.useMutation({
    onSuccess: (team) => {
      router.push(`/w/${workshopId}/t/${team.id}`);
    },
  });

  const joinTeam = trpc.team.join.useMutation({
    onSuccess: (team) => {
      router.push(`/w/${workshopId}/t/${team.id}`);
    },
  });

  if (isLoading || !workshop) {
    return (
      <div className="flex flex-1 items-center justify-center py-24">
        <div className="animate-pulse text-ink-tertiary">Loading...</div>
      </div>
    );
  }

  const userRole = session?.user?.role;
  const isAdmin = userRole === "ADMIN";
  const isOwner = workshop.ownerId === session?.user?.id;
  // Management controls (edit settings, advance phases, change status) are for
  // whoever owns/facilitates the workshop, not just global ADMINs. The backend
  // still enforces ownerId on every write, so this only widens what the UI
  // *shows* to match who can actually save.
  const canManage = isAdmin || isOwner;

  // TWO conditions for the Settings tab, and both are needed:
  //   - the ROLE may configure experiences at all (ADMIN/FACILITATOR). This is the
  //     rule middleware.ts enforces on the route, so the tab and the gate agree.
  //   - and they can actually SAVE, i.e. they own it or are an ADMIN. The Workshop
  //     service refuses a PATCH from anyone else (isOwnerOrAdmin), so offering the
  //     tab to a non-owning facilitator would offer a form that 403s on Save.


  // Replace rather than push: tab switching is navigation WITHIN a page, so it
  // shouldn't stack twenty history entries between the workshop and wherever the
  // user came from. Back still leaves the workshop, which is what Back means here.
  const goToTab = (tab: TabKey) => {
    router.replace(`/experiences/${workshopId}?tab=${tab}`, { scroll: false });
  };

  return (
    // ⚠ NO <AppHeader> / <SiteFooter> / min-h-screen wrapper HERE, they moved to
    // `experiences/[id]/layout.tsx`, which covers every page in this area including the ones added
    // after this one. See the note there for the bug that caused.
    <>
      {/* ⚠ NO HEADER OR TAB BAR HERE. The back link, the experience name and the tab bar moved to
          `components/ExperienceHeader.tsx`, mounted by `experiences/[id]/layout.tsx`, because
          Activity, Submissions and Results are tabs in that bar and were rendering without it. See
          the note on that component for why the panel tabs change shape off this page. */}
      {/* flex-1 so the footer below is pushed to the bottom of the viewport on a
          short tab instead of floating under the content. */}
      <main className="w-full flex-1 max-w-4xl mx-auto px-6 py-8">
        {activeTab === "overview" && (
          <OverviewTab
            workshop={workshop}
            onSeePhases={() => goToTab("phases")}
          />
        )}

        {activeTab === "teams" && (
          <TeamsTab
            workshop={workshop}
            myTeam={myTeam}
            isAdmin={isAdmin}
            isOwner={isOwner}
            canManage={canManage}
            workshopId={workshopId}
            onJoin={() => setShowJoin(true)}
            onCreate={() => setShowCreate(true)}
          />
        )}

        {activeTab === "people" && (
          <PeopleTab
            workshop={workshop}
            workshopId={workshopId}
            onSeeTeams={() => goToTab("teams")}
          />
        )}

        {activeTab === "phases" && (
          <PhasesTab
            workshop={workshop}
            canManage={canManage}
            workshopId={workshopId}
            setCurrentPhase={setCurrentPhase}
          />
        )}

        {/* Join modal */}
        {showJoin && (
          <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50">
            <div className="bg-surface-3 rounded-lg p-6 w-full max-w-sm">
              <h3 className="font-semibold mb-4">Join a Team</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  joinTeam.mutate({ inviteCode });
                }}
              >
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Paste invite code"
                  className="w-full rounded-md border border-field-border px-4 py-2 text-sm mb-3"
                  required
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowJoin(false)}
                    className="flex-1 rounded-md border px-3 py-2 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 rounded-md bg-brand px-3 py-2 text-sm text-brand-ink"
                  >
                    Join
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Create modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50">
            <div className="bg-surface-3 rounded-lg p-6 w-full max-w-sm">
              <h3 className="font-semibold mb-4">Create a Team</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createTeam.mutate({
                    workshopId,
                    name: teamName,
                  });
                }}
              >
                <input
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Team name"
                  className="w-full rounded-md border border-field-border px-4 py-2 text-sm mb-3"
                  required
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowCreate(false)}
                    className="flex-1 rounded-md border px-3 py-2 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 rounded-md bg-brand px-3 py-2 text-sm text-brand-ink"
                  >
                    Create
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

/** One label/value row of workshop metadata. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-subtle">{label}</dt>
      <dd className="text-sm mt-0.5">{value}</dd>
    </div>
  );
}


const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-surface-2 text-ink-subtle",
  ACTIVE: "bg-success-bg text-success-text",
  COMPLETED: "bg-notice-bg text-notice-text",
  ARCHIVED: "bg-surface-2 text-ink-tertiary",
};

/** Human date, or an em dash when the field is unset (both dates are optional). */
// `| null` as well as absent: the workshop service stores `startsAt`/`endsAt` as nullable, so a
// workshop created before dates were required carries an explicit null. The `!value` guard below
// already handled it, only the signature was narrower than the data.
function formatDate(value?: string | null): string {
  /* ⚠ DELEGATES TO `workshopDate` RATHER THAN CALLING `toLocaleDateString(undefined, …)`.
     Passing `undefined` as the locale means "use the READER's locale", so this printed
     "Sep 1, 2026" for one operator and "1 Sept 2026" for another, and, more to the point,
     something different from the /experiences list and the admin catalogue, which both render the
     same field through `workshopDate`. Three renderings of one date across three screens.

     The `"-"` fallback for absent/unparseable is preserved: a workshop created before dates were
     required carries an explicit null, and "Invalid Date" is the output this guard exists to
     prevent. */
  return workshopDate(value) ?? "-";
}

/**
 * OVERVIEW, "what is this workshop", the tab a newcomer needs and the one the old
 * single-scroll page never actually had: format, status, dates, team-size rules and
 * AI configuration were only visible on the settings form, i.e. only to staff.
 */
function OverviewTab({
  workshop,
  onSeePhases,
}: {
  workshop: Workshop;
  onSeePhases: () => void;
}) {
  const currentPhase =
    workshop.currentPhaseOrder > 0
      ? workshop.phases[workshop.currentPhaseOrder - 1]
      : null;
  const memberCount = (workshop.teams || []).reduce(
    (sum: number, t) => sum + (t._count?.members || 0),
    0
  );

  return (
    <>
      {/* NO "Your Team" box. It duplicated the Teams tab, which already marks the
          caller's own team with a "You" badge and links to the same workspace, so the
          overview opened with a second copy of one row from the list beside it. Removed
          rather than restyled: the shortest path to a team is the Teams tab, and an
          overview should summarise rather than repeat. `myTeam` is still computed and
          still drives that badge. */}

      {/* The description reads as prose, so it gets its own block above the facts rather
          than a cell in a grid, a paragraph in a `<dd>` beside "Format: ACCELERATOR"
          fights the alignment of everything next to it. */}
      {workshop.description && (
        <section className="mb-6">
          <p className="text-sm text-ink-subtle leading-relaxed max-w-3xl">
            {workshop.description}
          </p>
        </section>
      )}

      <section className="mb-8">
        <h2 className="font-semibold mb-3">About this experience</h2>
        <dl className="grid gap-4 sm:grid-cols-3 rounded-lg border p-4">
          <div>
            <dt className="text-xs font-medium text-ink-subtle">Status</dt>
            <dd className="mt-0.5">
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                  STATUS_STYLES[workshop.status] || STATUS_STYLES.DRAFT
                }`}
              >
                {statusLabel(workshop.status)}
              </span>
            </dd>
          </div>
          <Fact label="Format" value={formatLabel(workshop.format)} />
          <Fact
            label="Team size"
            /* ⚠ "undefined–undefined people" WAS WHAT THIS RENDERED. Both bounds are optional on
               the wire, a workshop created before team sizes existed carries neither, and the
               template interpolated them raw, so the card stated a range made of the word
               "undefined" twice. Same defect class as the "undefined teams" the admin row used to
               print. An unknown range is "-", which every other Fact on this card already uses. */
            value={
              workshop.minTeamSize == null || workshop.maxTeamSize == null
                ? "-"
                : `${workshop.minTeamSize}–${workshop.maxTeamSize} people`
            }
          />
          <Fact label="Starts" value={formatDate(workshop.startsAt)} />
          <Fact label="Ends" value={formatDate(workshop.endsAt)} />
          {/* NO AI TILE. This printed `aiModel`, the raw Bedrock id
              "us.anthropic.claude-sonnet-4-20250514-v1:0", under the label "AI
              assistant", which was wrong twice over: the label named the CLI tools
              participants use (enabledAssistants: Claude Code / Kiro CLI / Codex) while
              the value was the model behind the platform's own chat, and a model id is an
              internal implementation detail no operator running an experience needs on an
              overview. Owner: "we dont have to show any ai assistant details".
              Both fields are still stored and still drive behaviour, the desktop app
              reads enabledAssistants, the AI service reads aiModel, this is a display
              change only. Assistant configuration remains on the create and settings
              forms, where it is an editable choice rather than trivia. */}
          <Fact
            label="Teams"
            value={`${(workshop.teams || []).length} team${
              (workshop.teams || []).length === 1 ? "" : "s"
            }`}
          />
          <Fact label="People" value={`${memberCount} on a team`} />
          <Fact label="Created" value={formatDate(workshop.createdAt)} />
        </dl>
      </section>

      <section>
        <h2 className="font-semibold mb-3">Progress</h2>
        <div className="rounded-lg border p-4">
          {workshop.phases.length === 0 ? (
            <p className="text-sm text-ink-subtle">
              No phases defined for this experience yet.
            </p>
          ) : (
            <>
              <p className="text-sm">
                {currentPhase ? (
                  <>
                    Currently in{" "}
                    <span className="font-medium text-brand-text">
                      {currentPhase.name}
                    </span>{" "}
                    <span className="text-ink-subtle">
                      (phase {workshop.currentPhaseOrder} of{" "}
                      {workshop.phases.length})
                    </span>
                  </>
                ) : (
                  <span className="text-ink-subtle">
                    Not started. {workshop.phases.length} phases planned.
                  </span>
                )}
              </p>
              <button
                onClick={onSeePhases}
                className="mt-2 text-sm font-medium text-brand-text hover:text-brand-text-strong"
              >
                See all phases →
              </button>
            </>
          )}
        </div>
      </section>
    </>
  );
}

/** TEAMS, the roster of teams, plus the create/join affordances. */
function TeamsTab({
  workshop,
  myTeam,
  isAdmin,
  isOwner,
  canManage,
  workshopId,
  onJoin,
  onCreate,
}: {
  workshop: Workshop;
  myTeam: MyTeam;
  isAdmin: boolean;
  isOwner: boolean;
  canManage: boolean;
  workshopId: string;
  onJoin: () => void;
  onCreate: () => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Teams ({workshop.teams.length})</h2>
        <div className="flex gap-2">
          {!myTeam && !isOwner && !isAdmin && (
            <button
              onClick={onJoin}
              className="rounded-md border border-field-border px-3 py-1.5 text-sm hover:bg-surface-1 transition-colors"
            >
              Join with Code
            </button>
          )}
          {/* Offered ONLY to whoever facilitates the workshop. It used to also be
              offered to any signed-in user without a team (the "be the first to
              create one" path), but POST /v1/workshops/:id/teams now refuses a caller
              who neither owns the workshop nor is an ADMIN
              (team/src/routes.ts), so showing it to a participant, judge or
              executive would offer a button the server rejects with a 403. The
              join-with-code path above is how a participant gets onto a team. */}
          {/* Beside Create Team, and gated identically: the bulk route enforces the same
              ADMIN-or-owning-FACILITATOR rule, so offering it more widely would be a button the
              server refuses. */}
          {canManage && <BulkTeamUpload workshopId={workshopId} />}
          {canManage && (
            <button
              onClick={onCreate}
              className="rounded-md bg-brand px-3 py-1.5 text-sm text-brand-ink hover:bg-brand-hover transition-colors"
            >
              Create Team
            </button>
          )}
        </div>
      </div>

      {workshop.teams.length === 0 ? (
        <p className="text-sm text-ink-subtle py-4 text-center border border-dashed rounded-lg">
          {canManage
            ? "No teams yet. Create the first one to get started."
            : "No teams yet."}
        </p>
      ) : (
        /* FULL-WIDTH ROWS, not a tile grid.
           Three tiles per row forced every team's description into `line-clamp-2` and put
           the member count under the name, so scanning "which team has room?" meant reading
           in two dimensions. One row per team lines the counts up in a column, matches the
           long-row layout the admin Users and Teams directory already use, and gives the
           description the width it needs. */
        <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
          {workshop.teams.map((team) => {
            const isMyTeam = myTeam?.id === team.id;
            return (
              /* ⚠ AN `<li>` WRAPPER, A ROW WITH NO BORDER OF ITS OWN, AND THE "MY TEAM" MARKER AS
                 AN INSET SHADOW. Three corrections to one row:

                   - A `<Link>` directly inside a `<ul>` is invalid, and it makes
                     `getByRole("listitem")` find nothing.
                   - The row kept `rounded-lg border` after the list became a bordered panel, so
                     every row drew a box inside the panel's box and doubled every edge.
                   - `border-brand-border` for "this is your team" would have been OVERRIDDEN.
                     `divide-hairline` compiles to a selector at specificity (0,3,0) that sets
                     `border-color` on all four sides, beating any single utility, the same
                     collision that gave the admin user rows a stray 4px hairline edge. An inset
                     shadow cannot be overridden by a border-colour rule and costs no layout. */
              <li key={team.id}>
                <Link
                  href={`/w/${workshopId}/t/${team.id}`}
                  className={`flex items-center justify-between gap-4 px-4 py-3 transition-colors ${
                    isMyTeam
                      ? "bg-brand-wash shadow-[inset_3px_0_0_0_rgb(var(--brand))] hover:bg-brand-subtle"
                      : "hover:bg-surface-1"
                  }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium truncate">{team.name}</h3>
                    {isMyTeam && (
                      <span className="shrink-0 text-xs bg-brand-subtle text-brand-text px-1.5 py-0.5 rounded">
                        You
                      </span>
                    )}
                  </div>
                  {team.description && (
                    // One line now: the row is wide enough that a second line would push
                    // the member avatars out of vertical alignment across rows.
                    <p className="text-xs text-ink-subtle mt-0.5 truncate">
                      {team.description}
                    </p>
                  )}
                </div>

                <div className="shrink-0 flex -space-x-2">
                  {/* m.user is joined in from the users read-model and can
                      be absent when that model hasn't caught up, so it is
                      NOT safe to index into. Same fallback chain as the
                      team workspace roster.

                      ⚠ THE KEY WAS `m.id || m.userId` AND THERE IS NO `m.id` HERE. These rows come
                      from the `?withMembers=1` fold, which emits teamId/userId/role/joinedAt/
                      status/user and no id, unlike `team.getById`, which adds `id: m.userId`
                      itself. So the first operand was always undefined and this has always keyed
                      on `userId`. Dropped rather than kept as a harmless fallback: a `||` chain
                      implies the earlier operand sometimes wins, and here it cannot. */}
                  {team.members?.map((m) => (
                    <div
                      key={m.userId}
                      className="w-6 h-6 rounded-full bg-brand-subtle flex items-center justify-center text-xs font-medium text-brand-text border-2 border-surface-3"
                      title={`${m.user?.name || m.userId || "Unknown"} (${m.role})`}
                    >
                      {(m.user?.name || m.userId || "?")[0].toUpperCase()}
                    </div>
                  ))}
                </div>

                {/* tabular-nums so the counts align down the column rather than jittering
                    with digit width, the point of switching to rows. */}
                  {/* ⚠ THE CAP IS OPTIONAL ON THE WIRE, so it cannot be interpolated raw, the
                      Team size fact on this same page printed "undefined–undefined people" for
                      exactly this reason. Absent, the row states the count alone. */}
                  <p className="w-28 shrink-0 text-right text-xs text-ink-tertiary tabular-nums">
                    {workshop.maxTeamSize == null
                      ? `${team._count.members} members`
                      : `${team._count.members} / ${workshop.maxTeamSize} members`}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * PEOPLE, everyone on a team in this workshop, flattened out of the team roster.
 *
 * This is deliberately derived from `workshop.teams[].members`, the data the page
 * ALREADY loads, and nothing else. There is no per-workshop people endpoint and no
 * store of "who is attached to this experience but not yet on a team", so anything
 * more (invited-but-not-registered, judges assigned to this workshop) would be a
 * number this tab made up.
 *
 * Inviting is not workshop-scoped, so this links out rather than pretending it is:
 * staff invitations go to the Administration screen, and participant/executive
 * invitations are sent from inside the team they're joining (which is where the join
 * code lives). The link is gated on the destination's own rule, not this page's
 * canManage, otherwise a workshop owner whom middleware would bounce off /admin
 * would still be offered the link.
 */
function PeopleTab({
  workshop,
  workshopId,
  onSeeTeams,
}: {
  workshop: Workshop;
  workshopId: string;
  onSeeTeams: () => void;
}) {
  const canManageUsers = useCanManageUsers();

  // Derived from the teams already loaded by this page's one query, no extra request.
  // Deliberately only a COUNT and a short preview: the full directory lives on the
  // Administration screen (see the note below), so duplicating its list here would mean two
  // implementations of the same view drifting apart on details like pagination and search.
  const people = (workshop.teams || []).flatMap((team: WorkshopTeam) =>
    (team.members || []).map((m: TeamMember) => ({
      key: `${team.id}:${m.userId}`,
      name: m.user?.name || m.userId || "Unknown",
      /* Present only where the caller is entitled to it, the roster route OMITS the key
         rather than sending undefined, so this is genuinely absent for a participant. */
      email: m.user?.email,
      teamName: team.name,
      teamRole: m.role,
    }))
  );

  const PREVIEW = 5;
  const preview = people.slice(0, PREVIEW);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">People ({people.length})</h2>
        {canManageUsers && (
          <Link
            href="/admin?tab=invitations"
            className="rounded-md bg-brand px-3 py-1.5 text-sm text-brand-ink hover:bg-brand-hover transition-colors"
          >
            Invite Users
          </Link>
        )}
      </div>

      {/* THE FULL LIST LIVES ON THE ADMINISTRATION SCREEN, and this links there rather than
          re-implementing it. That screen already has everything this tab was asked to grow -
          full user details, server-side search across every page, cursor pagination, the
          "invited by" provenance line, and the role controls, plus a workshop filter. A
          second implementation here would be two lists to keep in step, and the one on a
          workshop page would be the one that quietly lags.

          `?scope=w:<id>` pre-filters it to THIS workshop, so the link lands on the same
          question the operator was already asking. Gated on canManageUsers: the directory is
          ADMIN/FACILITATOR only, and offering a link the middleware would bounce is worse
          than not offering it. */}
      {canManageUsers && (
        <Link
          href={`/admin?tab=users&scope=w:${encodeURIComponent(workshopId)}`}
          className="mb-4 flex items-center justify-between rounded-lg border border-brand-border bg-brand-subtle px-4 py-3 hover:border-brand-border focus:outline-none focus:ring-2 focus:ring-brand"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-brand-text-strong">
              Manage everyone in this experience
            </span>
            <span className="block text-xs text-brand-text">
              Search, page through, see who invited whom, and change roles.
            </span>
          </span>
          <span aria-hidden="true" className="ml-3 shrink-0 text-brand-text">
            →
          </span>
        </Link>
      )}

      {people.length === 0 ? (
        <div className="py-8 text-center border border-dashed rounded-lg">
          <p className="text-sm text-ink-subtle">
            Nobody has joined a team in this experience yet.
          </p>
          <button
            onClick={onSeeTeams}
            className="mt-2 text-sm font-medium text-brand-text hover:text-brand-text-strong"
          >
            Go to Teams →
          </button>
        </div>
      ) : (
        <>
          <ul className="divide-y rounded-lg border">
            {preview.map((p) => (
              <li key={p.key} className="flex items-center gap-3 px-4 py-3">
                <div
                  aria-hidden="true"
                  className="w-8 h-8 rounded-full bg-brand-subtle flex items-center justify-center text-sm font-medium text-brand-text shrink-0"
                >
                  {p.name[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  {p.email && (
                    <p className="text-xs text-ink-subtle truncate">{p.email}</p>
                  )}
                </div>
                <div className="ml-auto text-right shrink-0">
                  <p className="text-xs text-ink-subtle">{p.teamName}</p>
                  <p className="text-xs font-medium text-ink-subtle">{p.teamRole}</p>
                </div>
              </li>
            ))}
          </ul>
          {/* Says how many are hidden rather than implying the list is complete, a
              truncated list presented as whole is how an operator concludes someone is not
              in the workshop when they are. */}
          {people.length > PREVIEW && (
            <p className="mt-2 text-xs text-ink-subtle">
              Showing {PREVIEW} of {people.length}.{" "}
              {canManageUsers ? (
                <Link
                  href={`/admin?tab=users&scope=w:${encodeURIComponent(workshopId)}`}
                  className="font-medium text-brand-text underline hover:no-underline"
                >
                  See all {people.length}
                </Link>
              ) : (
                <span>Ask an administrator to see the full list.</span>
              )}
            </p>
          )}
        </>
      )}

      <p className="mt-3 text-xs text-ink-subtle">
        Counts people who have joined a team. Someone invited but not yet signed up
        appears on their team&apos;s invitations list.
      </p>
    </section>
  );
}

/** PHASES, the phase breadcrumb and, for staff, the controls to advance it. */
function PhasesTab({
  workshop,
  canManage,
  workshopId,
  setCurrentPhase,
}: {
  workshop: Workshop;
  canManage: boolean;
  workshopId: string;
  /**
   * Narrowed to the ONE method this panel calls, rather than taking the whole tRPC mutation
   * object: the input type is the procedure's own, so a change to `setCurrentPhase`'s schema is a
   * compile error here instead of a silently ignored field.
   */
  setCurrentPhase: {
    mutate: (input: { workshopId: string; currentPhaseOrder: number }) => void;
  };
}) {
  if (workshop.phases.length === 0) {
    return (
      <section>
        <h2 className="font-semibold mb-3">Experience Phases</h2>
        <p className="text-sm text-ink-subtle py-4 text-center border border-dashed rounded-lg">
          No phases defined for this experience yet.
        </p>
      </section>
    );
  }

  const total = workshop.phases.length;
  const current = workshop.currentPhaseOrder;
  const notStarted = current === 0;
  const finished = current >= total;
  const currentPhase = workshop.phases[current - 1];

  return (
    <section>
      {/*
        ── ONE STEPPER, NOT TWO LISTS ─────────────────────────────────────────────────────
        This tab used to render the phases TWICE: a pill breadcrumb ("Ideation → Build → Demo")
        and then a numbered list of the same names. The second one existed to show each phase's
        DESCRIPTION and DURATION, but those fields are optional and are empty on every
        experience created so far, so in practice it rendered "1 Ideation" under "Ideation" and
        read as a rendering fault rather than as detail.

        Reported as "can we make the phases look a much better". The fix is structural, not
        cosmetic: one component that carries the name, the status, the description and the
        duration, so it degrades to something deliberate when the optional fields are absent
        instead of looking duplicated.
      */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Experience Phases</h2>
          {/*
            The at-a-glance answer the old breadcrumb was really providing, "where are we?" -
            stated in words rather than inferred from which pill is coloured. Colour was the only
            cue before, which is also why it failed for anyone who cannot distinguish it.
          */}
          <p className="mt-0.5 text-xs text-ink-subtle">
            {notStarted
              ? `${total} ${total === 1 ? "phase" : "phases"} planned · not started`
              : finished
                ? "All phases complete"
                : `Phase ${current} of ${total} · ${currentPhase?.name ?? ""}`}
          </p>
        </div>

        {canManage && current < total && (
          <button
            onClick={() =>
              setCurrentPhase.mutate({ workshopId, currentPhaseOrder: current + 1 })
            }
            className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink transition-colors hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-1"
          >
            {notStarted ? "Start first phase" : `Advance to ${workshop.phases[current]?.name ?? "next phase"}`}
          </button>
        )}
      </div>

      {/* A slim progress bar: the one thing a stepper genuinely cannot show at a glance for a
          long list, and it costs two elements. `aria-hidden` because the sentence above already
          states the same fact to a screen reader, announcing it twice is noise. */}
      <div aria-hidden="true" className="mb-5 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-brand transition-all duration-500"
          style={{ width: `${total ? (Math.min(current, total) / total) * 100 : 0}%` }}
        />
      </div>

      <ol className="relative space-y-1">
        {workshop.phases.map((phase: WorkshopPhase, i: number) => {
          const phaseOrder = i + 1;
          const isCurrent = phaseOrder === current;
          const isCompleted = phaseOrder < current;
          const isLast = i === total - 1;
          // `hasDetail` is gone with the "Add a description in Settings" prompt it gated, see the
          // note further down. The description itself renders on its own truthiness.

          /* The whole row is the control when a facilitator may set the phase, so the target is
             the size of the row rather than a pill. A non-manager gets a plain <div>: a disabled
             button is still focusable in some browsers and announces itself as a control that
             does nothing. */
          const Row = canManage ? "button" : "div";

          return (
            <li key={phase.id || i} className="relative">
              {/* The connector, drawn behind the marker and stopped short on the last row so it
                  does not dangle past the final phase. */}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[15px] top-9 h-[calc(100%-1.25rem)] w-0.5 ${
                    isCompleted ? "bg-success-border" : "bg-surface-2"
                  }`}
                />
              )}

              <Row
                {...(canManage  // nosemgrep: react-props-spreading
                  ? {
                      type: "button" as const,
                      onClick: () =>
                        setCurrentPhase.mutate({ workshopId, currentPhaseOrder: phaseOrder }),
                      "aria-label": `Set current phase to ${phase.name}`,
                    }
                  : {})}
                aria-current={isCurrent ? "step" : undefined}
                className={`relative flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  isCurrent
                    ? "bg-brand-subtle ring-1 ring-inset ring-brand/30"
                    : "bg-transparent"
                } ${
                  canManage
                    ? "cursor-pointer hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
                    : ""
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-4 ring-surface-3 ${
                    isCompleted
                      ? "bg-success-bg text-success-text"
                      : isCurrent
                        ? "bg-brand text-brand-ink"
                        : "bg-surface-2 text-ink-subtle"
                  }`}
                >
                  {isCompleted ? "✓" : phaseOrder}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-sm font-medium ${
                        isCurrent ? "text-brand-text-strong" : "text-ink-muted"
                      }`}
                    >
                      {phase.name}
                    </span>
                    {/*
                      A TEXT status, not only a colour, it names the state rather than relying on hue
                      alone, which is why "upcoming" is spelled out below.

                      ── ⚠ NO "DONE" PILL ("we dont need the word done for phases") ──────────────────
                      It was redundant in a way the other two are not. A completed phase's marker is a
                      ✓ GLYPH where every other phase shows its NUMBER, a difference in SHAPE, not
                      colour, so removing the word does not reintroduce the accessibility problem this
                      comment block was originally written about. "Upcoming" has no such marker (an
                      upcoming phase shows the same number as the current one), so it stays.
                    */}
                    {isCurrent && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-ink">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-surface-3" />
                        In progress
                      </span>
                    )}
                    {!isCurrent && !isCompleted && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
                        Upcoming
                      </span>
                    )}
                    {typeof phase.durationMinutes === "number" && (
                      <span className="text-xs tabular-nums text-ink-tertiary">
                        {phase.durationMinutes} min
                      </span>
                    )}
                  </span>

                  {phase.description && (
                    <span className="mt-1 block text-xs leading-relaxed text-ink-subtle">
                      {phase.description}
                    </span>
                  )}
                  {/*
                    No em-dash placeholder when there is no description: an empty row is quieter than a
                    row announcing its own emptiness.

                    ── ⚠ AND NO "Add a description in Settings" PROMPT ANY MORE ──────────────────────
                    It pointed at a screen that has never edited phases, `setPhases` is called only by
                    the create form, so it was a dead end before phases became immutable, and an
                    impossibility after (`PUT /workshops/:id/phases` now refuses every change with
                    `PHASES_IMMUTABLE`). Telling the person who runs the experience to go and do
                    something the platform will refuse is worse than saying nothing.

                    New experiences no longer reach this state: `FIXED_PHASE_PIPELINE` supplies a
                    description for each of the three phases at creation. Experiences created BEFORE that
                    keep their blank descriptions permanently, which is the honest consequence of
                    immutability rather than something this prompt could fix.
                  */}
                </span>
              </Row>
            </li>
          );
        })}
      </ol>

      {canManage && (
        <p className="mt-4 text-xs text-ink-tertiary">
          Click any phase to jump to it, or use the button above to advance in order.
        </p>
      )}
    </section>
  );
}
