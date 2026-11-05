import { Hono } from "hono";
import { ulid } from "ulid";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  type EventPublisher,
} from "@praimana/service-shared";
import {
  sanitizeEnabledAssistants,
  WORKSHOP_STATUSES,
  type Workshop,
  type WorkshopRepository,
  type PhaseRepository,
  type TeamPhaseRepository,
  type FormatRepository,
  type WorkshopStats,
} from "./domain.js";
import {
  requireTeamContentRead,
  requireTeamPhaseWrite,
  requireWorkshopRead,
  type TeamAccess,
  type TeamWorkshop,
  type WorkshopMembership,
  type WorkshopEntitlements,
  type UserRoles,
} from "./authz.js";
import { registerResourceRoutes } from "./resource-routes.js";
import type { ResourceStore } from "./resource-store.js";
// This service's local copy of the platform team-size ceiling. `maxTeamSize` is
// the TEMPLATE a new team's seatCap is seeded from, so an out-of-range value here becomes a team
// permitted to exceed the platform limit — see team-size.ts.
import { MAX_TEAM_MEMBERS, MIN_TEAM_SIZE, isValidMaxTeamSize } from "./team-size.js";

/**
 * How many experiences the ADMIN catalogue returns before reporting itself truncated.
 *
 * ⚠ A BOUND ON A SCAN, so it exists whether or not anyone believes the platform will ever hold
 * this many: an unbounded Scan is a read whose cost is set by the table rather than by the
 * request, and this one is reachable from a page render. 200 is far above hackathon scale (tens)
 * and far below anything that troubles a single Scan page's 1MB limit for two projected
 * attributes, so the cap should never bite in practice — and `truncated` is what stops it lying
 * if it ever does.
 */
const MAX_CATALOGUE_WORKSHOPS = 200;

/**
 * Workshop service routes. Note the constructor-style dependency injection: the
 * routes depend on INTERFACES (WorkshopRepository, PhaseRepository,
 * TeamPhaseRepository, FormatRepository, WorkshopStats, EventPublisher) passed in,
 * never on concrete DynamoDB/HTTP classes. This is the Dependency Inversion seam —
 * wiring lives in app.ts, and tests pass in-memory fakes.
 *
 * Mounted under basePath /v1 so it is a drop-in for the monolith's /v1/workshops/*,
 * /v1/lookup/* (and the phase routes that hang off workshops) — the gateway can
 * route those here while everything else still hits the monolith (strangler-fig).
 */
/**
 * Cap on a phase id taken from the path.
 *
 * 128, comfortably admitting a ULID (26) or a slug while refusing prose. Previously the
 * route validated nothing, so any string became a stored row's sort key.
 */
const MAX_PHASE_ID_LENGTH = 128;

/**
 * Cap on one phase's stored content.
 *
 * 40,000 — ten times `MAX_SCORE_COMMENT_CHARS`, because this is a team's working notes for a whole
 * phase rather than a one-box comment, and deliberately far below DynamoDB's 400 KB item limit.
 * That headroom is the point: this content is copied INLINE into the release snapshot, so the bound
 * has to leave room for every other field on that item plus the team's other phases.
 */
const MAX_PHASE_CONTENT_CHARS = 40_000;

export interface WorkshopDeps {
  workshops: WorkshopRepository;
  /**
   * S3 storage for workshop resources — the facilitator's material for one experience.
   *
   * ⚠ OPTIONAL, AND ABSENT MEANS REFUSE. Exactly the polarity `userRoles` below uses and for the same
   * reason: a deployment that has not been given a bucket answers 501 on every resource route rather
   * than appearing to accept uploads it is quietly dropping. See resource-routes.ts.
   */
  resources?: ResourceStore;
  phases: PhaseRepository;
  teamPhases: TeamPhaseRepository;
  formats: FormatRepository;
  stats: WorkshopStats;
  events: EventPublisher;
  /** Team-membership authz for the per-team phase routes. Owned by the TEAM
   *  service, so it is asked, never read from teamMembers (see authz.ts). */
  teamAccess: TeamAccess;
  /**
   * WHICH EXPERIENCE A TEAM BELONGS TO — Team-owned, asked rather than read. Used by ONE route, the
   * per-team phase WRITE, to check the `phaseId` in the path against that experience's phase
   * template (this service's own data).
   *
   * OPTIONAL so a deployment that has not wired it still composes — and the route then REFUSES the
   * save (503) rather than accepting an unvalidated phase id. That polarity is the point: a default
   * of "no port, so skip the check" would silently restore the defect on every un-updated
   * deployment, which is how a fix gets un-fixed. Same reasoning as `userRoles` below, which cannot
   * transfer rather than transferring unchecked.
   */
  teamWorkshop?: TeamWorkshop;
  /** "Is the caller on any team in this workshop?" — the membership branch of the
   *  workshop READ gate. Also Team-owned, also asked rather than read. Reached only
   *  when the ADMIN and owner branches both miss (see requireWorkshopRead). */
  membership: WorkshopMembership;
  /** The caller's entitled workshop ids — `E(self)` — for the LIST route. Team-owned
   *  like the two above, and asked rather than read. Reached ONLY for roles that own
   *  no workshop; ADMIN and FACILITATOR never touch it (see GET /workshops
   **/
  entitlements: WorkshopEntitlements;
  /**
   * "What role does this user hold?" — Identity-owned, asked rather than read. Used by ONE route,
   * `PATCH /workshops/:id/owner`, to stop an experience being transferred to somebody who may not
   * own one. Optional so a deployment that has not wired it simply cannot transfer, rather than
   * transferring UNCHECKED — see the route for why that polarity matters.
   */
  userRoles?: UserRoles;
}

/**
 * Owner check the Workshop service CAN decide on its own: it owns the workshop (so it knows `ownerId`)
 * and it knows the caller's role from the edge identity.
 *
 * ⚠ OWNERSHIP ALONE NOW. This was `ownerId === id || role === "ADMIN"`, so any admin could rename
 * another owner's experience, move it through its lifecycle, rewrite its phases or change which
 * assistants it offers. THE RULE: an admin sees no other experiences, scores or anything else they do
 * not own — and a role that cannot READ another owner's experience must not be able to WRITE it.
 *
 * ⚠ THE NAME IS KEPT DESPITE NO LONGER MENTIONING ADMIN, because an ADMIN who CREATED an experience is
 * its owner and still passes — which is the whole of the clarification ("if admin creates experience
 * yes"). Renaming this to `isOwner` would suggest admins were excluded as a class, which is not the
 * rule.
 */
function isOwnerOrAdmin(
  workshop: Workshop,
  identity: { id: string; role: string }
): boolean {
  return workshop.ownerId === identity.id;
}

/**
 * WHO MAY CREATE A WORKSHOP.
 *
 * A deliberate LOCAL COPY of WORKSHOP_CREATOR_ROLES in
 * shared/types/user.ts, for the same reason every other service here keeps
 * one: this is a bundled Lambda that takes no dependency on that package. The shared
 * copy drives what the portal OFFERS; this one is the ENFORCEMENT, and routes.test.ts
 * asserts the full role table so the two cannot drift.
 *
 * ── WHY THIS EXISTS AT ALL: EVERY OTHER WORKSHOP WRITE WAS GATED AND CREATE WAS NOT ──
 * The four mutating routes below (PATCH /:id, PATCH /:id/status, PUT /:id/phases,
 * PATCH /:id/current-phase) all run isOwnerOrAdmin. Create had nothing but
 * requireIdentity, and the role rule lived ONLY in the portal's tRPC router — which is
 * a BFF, not a boundary: /v1/workshops is mapped `Method: ANY` behind an authorizer
 * with no AuthorizationScopes, and the browser holds its own ID token, so the route is
 * reachable directly with a participant's own credentials.
 *
 * That made it an escalation rather than merely an unguarded write, because the row it
 * creates names the caller as `ownerId` — which is exactly what isOwnerOrAdmin accepts.
 * A PARTICIPANT could create a workshop and thereby earn write access to all four of
 * those routes plus team creation, since the Team service's `ownsWorkshop` probe also
 * decides on ownerId alone. Its own comment says the case "is never true for
 * EXECUTIVE/JUDGE/PARTICIPANT, since they cannot create workshops at all" — an
 * invariant this route was quietly falsifying.
 *
 * Note EXECUTIVE is refused here for a second, independent reason: it is the platform's
 * designated READ-ONLY role (see isReadOnlyRole in authz.ts), so handing it a write
 * primitive would contradict requireTeamWrite's explicit refusal elsewhere.
 */
const WORKSHOP_CREATOR_ROLES = new Set(["ADMIN", "FACILITATOR"]);

function canCreateWorkshops(role: string | null | undefined): boolean {
  return !!role && WORKSHOP_CREATOR_ROLES.has(role);
}

export function createWorkshopRoutes(deps: WorkshopDeps) {
  const app = new Hono().basePath("/v1");

  // Every request must carry a gateway-injected identity (authN done at edge).
  app.use("*", edgeIdentityMiddleware());

  // ─── Workshops ─────────────────────────────────────────────────────────────

  /**
   * The caller's workshops. ROLE-BRANCHED.
   *
   * THE BUG THIS FIXES: this route was `listByOwner(id)` for everyone. A JUDGE,
   * EXECUTIVE or PARTICIPANT owns no workshop row, so they got `{"workshops":[]}` —
   * an executive signed in, landed on /workshops (correctly: EXECUTIVE is staff), and
   * saw no experiences at all. They should see
   * `E(self)`; this was the gap.
   *
   * THE ORDER IS THE DESIGN, and it is the same principle as requireWorkshopRead
   * below: every local branch precedes the one hop.
   *
   *   ADMIN / FACILITATOR          → listByOwner. NO HOP, deliberately: a Team
   *                                  brownout must not break the only list that
   *                                  works today. (ADMIN list-all is a separate
   *                                  route, still unbuilt.)
   *   JUDGE / EXECUTIVE / PARTICIPANT → E(self) from Team, then resolve the rows here.
   *   unknown role                 → empty. Fails closed on a role we don't model.
   *
   * "UNAVAILABLE" IS A 503, NEVER AN EMPTY LIST. If the entitlement hop cannot
   * answer, this route must not say "you have no workshops" — that is the same lie as
   * the 403 that said "not the owner" when a probe had timed out, and it would look
   * exactly like the bug being fixed. The failure semantics require this.
   */
  app.get("/workshops", async (c) => {
    const { id, role } = requireIdentity(c);

    // Roles that own their workshops answer locally, with no cross-service call.
    const ownsWorkshops = role === "ADMIN" || role === "FACILITATOR";

    if (!ownsWorkshops) {
      // A role we do not model gets nothing, and gets it without a hop.
      if (role !== "JUDGE" && role !== "EXECUTIVE" && role !== "PARTICIPANT") {
        return c.json({ workshops: [] });
      }

      const entitled = await deps.entitlements.listEntitledWorkshopIds(role, c);
      if (entitled === "unavailable") {
        console.warn("[workshops] entitlements unavailable — 503, not an empty list", {
          userId: id,
          role,
        });
        return c.json(
          {
            error:
              "Your experiences can't be loaded right now. This is a temporary problem, not a change to your access.",
            code: "ENTITLEMENTS_UNAVAILABLE",
          },
          503,
          { "Retry-After": "2" }
        );
      }

      const candidates = await deps.workshops.listByIds(entitled.workshopIds);

      /**
       * ── THE LIST IS NARROWED TO WHAT THE BY-ID GATE WILL ACTUALLY OPEN ──
       *
       * This route used to return every entitled workshop, while `requireWorkshopRead`
       * (authz.ts) admits ADMIN → owner → MEMBER and has no entitlement branch. So an
       * entitled JUDGE got 200 here with a workshop, then 403 from `/workshops/:id`,
       * `/assistants` and `/phases` — a list of doors that would not open. Fail-closed, so
       * never a leak, but a functional dead end and two routes answering different
       * questions for the same role.
       *
       * ⚠ WHY THIS SIDE MOVED, AND NOT THE GATE. The other repair is an entitlement branch
       * in `requireWorkshopRead`, which is what the read matrix actually specifies. It was
       * REJECTED for now: it puts a second east-west hop on a route the desktop calls three
       * times during setup, and there is NO CIRCUIT BREAKER anywhere in this repo — an
       * amplification accepted-but-unmitigated. Narrowing costs one
       * bounded local-ish probe per candidate and cannot make a brownout worse.
       *
       * ⚠ WHAT AN OPERATOR LOSES, stated plainly because it is a real regression in
       * usefulness: an entitled judge who is on no team now sees an EMPTY list rather than a
       * list they cannot act on. That is honest instead of misleading, and it is strictly
       * narrower, so nothing becomes visible that was not. **The read matrix promises
       * the other behaviour and is now wrong** — annotated here rather than silently
       * diverged from. Adding the entitlement branch is the intended endgame ONCE A BREAKER
       * EXISTS; at that point delete this filter, not the gate.
       *
       * THE ENTITLEMENT HOP IS STILL LOAD-BEARING and is not dead code: it produces the
       * CANDIDATE set. Without it this role would have nothing to filter — `listByOwner` is
       * meaningless for a judge, and scanning every workshop to test membership is the
       * enumeration surface the design forbids. Entitlement narrows to "may be
       * relevant"; membership narrows to "may be opened".
       *
       * UNDETERMINED IS STILL 503, NEVER A SHORT LIST. A membership probe that cannot answer
       * must not be read as "not a member" — that would render a plausible, wrong, empty
       * page, which is the exact defect this route exists to prevent and which this route
       * already refuses to commit for the entitlement half above.
       */
      /**
       * ── ⚠ A JUDGE IS ENTITLED, NEVER A MEMBER — SO THE MEMBERSHIP PROBE IS SKIPPED ─────────
       *
       * THE BUG THIS FIXES: a JUDGE with an ACCEPTED invitation naming this experience signed in and saw an
       * EMPTY experiences list. The entitlement half resolved the workshop correctly; the membership
       * filter below then discarded it.
       *
       * ⚠ AND THE FILTER COULD NEVER HAVE BEEN SATISFIED. `team/src/routes.ts` enforces that "an ADMIN,
       * FACILITATOR or JUDGE may NEVER hold a team-membership row" — refused with a 400 on all three
       * write paths — so `isMember` is guaranteed FALSE for a judge by invariant, not merely by
       * convention. A judge's entitlement lives entirely in `invitation.workshopId`
       * (`WORKSHOP_POLICY.JUDGE = "REQUIRED"`).
       *
       * ⚠ SO SKIPPING THE PROBE COSTS LESS THAN RUNNING IT, which is why this needs no circuit breaker
       * to be safe. The fan-out is ONE east-west hop PER CANDIDATE WORKSHOP, every one of which can only
       * return false for a judge. A judge entitled to five experiences was making five useless calls to
       * the Team service and then being shown nothing. This is a strict REDUCTION in load.
       *
       * ⚠ NARROWED TO JUDGE, NOT APPLIED TO THE WHOLE BRANCH. EXECUTIVE and PARTICIPANT are `DERIVED`
       * roles whose entitlement comes THROUGH team membership, so for them the probe is the real
       * question and the filter stays exactly as it was. Only the role for which the answer is a
       * foregone conclusion skips it.
       *
       * ⚠ ENTITLEMENT IS STILL THE CEILING. `candidates` is `listByIds(entitled.workshopIds)` — a judge
       * sees only the experiences their own invitation named, and the entitlement hop above already
       * refuses to answer "none" when it could not determine the answer (503, not an empty list).
       */
      const judgeSeesByEntitlementAlone = role === "JUDGE";

      const memberships = judgeSeesByEntitlementAlone
        ? []
        : await Promise.all(
            candidates.map(async (w) => ({
              workshop: w,
              isMember: await deps.membership.isMember(w.id, id, role, c),
            }))
          );

      if (memberships.some((m) => m.isMember === "unavailable")) {
        console.warn(
          "[workshops] membership probe unavailable — 503, not a short list",
          { userId: id, role }
        );
        return c.json(
          {
            error:
              "Your experiences can't be loaded right now. This is a temporary problem, not a change to your access.",
            code: "MEMBERSHIP_UNAVAILABLE",
          },
          503,
          { "Retry-After": "2" }
        );
      }

      const entitledWorkshops = judgeSeesByEntitlementAlone
        ? candidates
        : memberships.filter((m) => m.isMember === true).map((m) => m.workshop);

      // `truncated` is surfaced so a client can say "showing the first N" rather than
      // presenting a capped list as complete. Reported off the ENTITLEMENT set, not the
      // filtered one: the cap was applied upstream, and a caller that sees fewer rows than
      // it expected deserves to know the set was capped before it was narrowed.
      const body: Record<string, unknown> = { workshops: entitledWorkshops };
      if (entitled.truncated) body.truncated = true;

      if (c.req.query("withCounts") === "1" && entitledWorkshops.length > 0) {
        const counts = await deps.stats.teamCounts(
          entitledWorkshops.map((w) => w.id),
          c
        );
        body.workshops = entitledWorkshops.map((w) => ({
          ...w,
          // OMITTED when unknown rather than defaulted to 0 — see WorkshopStats.
          ...(counts[w.id] !== undefined ? { _count: { teams: counts[w.id] } } : {}),
        }));
      }
      return c.json(body);
    }

    const workshops = await deps.workshops.listByOwner(id);

    // `?withCounts=1` folds a team count into each workshop so the admin BFF makes
    // ONE call instead of an extra /teams request per workshop. NOTE: the team
    // COUNT is owned by the TEAM service (it owns the teams table); this service
    // must NOT query it. We ask the injected WorkshopStats interface, which is
    // backed by a Team-service HTTP client or an event-fed read-model — never a
    // cross-context table read. Default wiring returns 0 (see ZeroWorkshopStats).
    if (c.req.query("withCounts") === "1" && workshops.length > 0) {
      const counts = await deps.stats.teamCounts(workshops.map((w) => w.id), c);
      const withCounts = workshops.map((w) => ({
        ...w,
        // OMITTED when unknown rather than defaulted to 0 — see WorkshopStats.
        ...(counts[w.id] !== undefined ? { _count: { teams: counts[w.id] } } : {}),
      }));
      return c.json({ workshops: withCounts });
    }

    return c.json({ workshops });
  });

  app.post("/workshops", async (c) => {
    const { id, role } = requireIdentity(c);

    // THE ROLE GATE, before the body is read — see canCreateWorkshops above for why this
    // route needs one and the other four workshop writes did not. Refused here and not
    // only in the portal, because the portal is a BFF and this route is independently
    // reachable with the caller's own token.
    if (!canCreateWorkshops(role)) {
      // Worth a log line: every UI path hides the action from these roles, so a request
      // reaching here came from a direct call rather than from the product.
      console.warn("[workshops] refused create for a role that may not create workshops", {
        userId: id,
        role,
      });
      return c.json(
        { error: "Forbidden: only admins and facilitators can create experiences" },
        403
      );
    }

    // Tolerant of a missing or malformed body: an unguarded c.req.json() throws, which
    // surfaces as a 500 on a route the caller merely called wrongly.
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "a JSON object body is required" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "a JSON object body is required" }, 400);
    }

    // A workshop with no name is not a workshop — it renders as an unclickable blank row
    // in every list that shows one. Checked here because the store has no schema to
    // refuse it and the tRPC layer's `min(1)` is, again, not the boundary.
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    const now = new Date().toISOString();

    // `str`/`num` rather than reading body fields straight through: the body is now typed
    // `unknown` per field (it arrives from the network), and the store does no coercion —
    // a numeric `name` or a string `maxTeamSize` would be persisted as-is and break a
    // reader rather than this writer.
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;

    // ── `maxTeamSize` IS VALIDATED, NOT COERCED ────────────────────────
    //
    // This field went through `num(body.maxTeamSize, 6)` and was ENFORCED NOWHERE. Two separate
    // defects, both silent:
    //
    //   1. A NON-NUMERIC value became the DEFAULT. `maxTeamSize: "eight"` stored 6, and the
    //      caller was told the workshop was created exactly as asked.
    //   2. An OUT-OF-RANGE value was stored VERBATIM. `maxTeamSize: 999` was accepted, and
    //      that number is copied onto every team created in the workshop as
    //      its `seatCap` — a team permitted 999 members, above the platform ceiling, which
    //      must be unreachable rather than grandfathered.
    //
    // The portal already validated `z.number().min(2).max(10)`, but a BFF is not the boundary:
    // this route is independently reachable with the caller's own token, which is the same
    // reasoning the role gate above states for itself.
    //
    // ABSENT IS STILL THE DEFAULT (6), deliberately — omitting the field is a legitimate
    // request and every existing caller does it. Only a PRESENT-BUT-WRONG value is a 400.
    if (body.maxTeamSize !== undefined && !isValidMaxTeamSize(body.maxTeamSize)) {
      return c.json(
        {
          error: `maxTeamSize must be a whole number between ${MIN_TEAM_SIZE} and ${MAX_TEAM_MEMBERS}`,
        },
        400
      );
    }

    const workshop = await deps.workshops.put({
      ownerId: id,
      id: ulid(),
      name,
      description: str(body.description) ?? "",
      format: str(body.format) ?? "WORKSHOP",
      status: "DRAFT",
      maxTeamSize: num(body.maxTeamSize, 6),
      minTeamSize: num(body.minTeamSize, 3),
      aiModel: str(body.aiModel) ?? "us.anthropic.claude-sonnet-4-20250514-v1:0",
      aiEnabled: true,
      enabledAssistants: sanitizeEnabledAssistants(body.enabledAssistants),
      setupConfig: body.setupConfig ?? null,
      startsAt: str(body.startsAt) ?? null,
      endsAt: str(body.endsAt) ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await deps.events.publish({
      source: "workshop-service",
      type: "workshop.created",
      detail: {
        workshopId: workshop.id,
        ownerId: id,
        name: workshop.name,
        format: workshop.format,
      },
    });

    return c.json({ workshop }, 201);
  });

  /**
   * A workshop by id — GATED (P0-1).
   *
   * This route had NO authorization: any signed-in caller who could name an id read
   * the workshop's name, description, `setupConfig` (repo and guide URLs), `aiModel`
   * and status. "Unguessable ULID" was never the control — ids leak through
   * /invitations/mine, the admin filter and desktop settings.
   *
   * The gate is ADMIN → owner → member of a team in the workshop, in that order, with
   * the first two decided locally from the row just fetched. See requireWorkshopRead
   * for why that ordering is a correctness requirement (the Team → Workshop → Team
   * cycle) and not a latency preference.
   *
   * 404 BEFORE the access check, deliberately, and this is the one place the two could
   * be argued the other way. A workshop id is not a secret — the routes that hand ids
   * out do their own authorization — and the alternative costs real usability: an
   * unauthorized caller and a deleted workshop would be indistinguishable, so the
   * desktop app could not tell "ask to be invited" from "this workshop is gone", and
   * neither could an operator reading logs. The mutation routes above already resolve
   * the row before authorizing, so this also keeps the whole file consistent.
   */
  /**
   * ── THE ADMIN CATALOGUE: every experience, id and name only ──────────────────────
   *
   * The "separate route": an admin must be able to invite any user to any experience from the
   * Administration tab, as a facilitator does. The Administration tab's invite picker needs to NAME an experience it does not own,
   * and `GET /workshops` deliberately answers an ADMIN from `listByOwner`.
   *
   * ⚠ REGISTERED BEFORE `/workshops/:id`, AND THAT IS LOAD-BEARING RATHER THAN TIDY. Hono matches
   * in registration order and `:id` matches exactly one segment, so a catalogue route declared
   * after it is UNREACHABLE — every request lands in the by-id handler, which looks up a workshop
   * literally named "catalogue", 404s, and looks for all the world like an empty catalogue. Pinned
   * by a test that asserts a 200 with the list rather than a 404, because that failure mode is
   * indistinguishable from "there are no experiences".
   *
   * ⚠ IT IS A DELIBERATE, NARROW WIDENING OF THE ADMIN SCOPING, and it should be read as
   * one. "An admin sees no other experiences, scores or anything" still holds for every OTHER
   * route: this discloses that an experience EXISTS and what it is CALLED, and nothing else — no
   * owner, no status, no dates, no teams, no members, no submissions, no scores. An admin who
   * picks one here can invite into it; they still cannot open it.
   *
   * ⚠ ADMIN ONLY, and NOT `isStaffRole`. A FACILITATOR must not reach this: `GET /workshops`
   * already gives them theirs, and the whole point of the ownership scoping is that one
   * facilitator does not enumerate another's experiences ("facilitors should see
   * the workshops they created not other facilitators created").
   */
  app.get("/workshops/catalogue", async (c) => {
    const { id, role } = requireIdentity(c);

    if (role !== "ADMIN") {
      return c.json(
        {
          error: "Forbidden: only an administrator can list every experience",
          code: "CATALOGUE_ADMIN_ONLY",
        },
        403
      );
    }

    const { workshops, truncated } = await deps.workshops.listAllForCatalogue(
      MAX_CATALOGUE_WORKSHOPS
    );

    if (truncated) {
      // Warned AND reported in the body. A picker quietly missing the experience an operator is
      // hunting for reads as "it does not exist", which is the same class of lie as an empty
      // directory during a brownout.
      console.warn("[workshops] admin catalogue TRUNCATED — the picker is short", {
        userId: id,
        returned: workshops.length,
        cap: MAX_CATALOGUE_WORKSHOPS,
      });
    }

    return c.json({ workshops, truncated });
  });

  app.get("/workshops/:id", async (c) => {
    const workshop = await deps.workshops.getById(c.req.param("id"));
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);

    const denied = await requireWorkshopRead(c, deps.membership, workshop, deps.entitlements);
    if (denied) return denied;

    return c.json({ workshop });
  });

  /**
   * Which AI assistants the facilitator has enabled — GATED (P1-3).
   *
   * Backs the desktop app's assistant picker. Gated on the SAME rule as /:id, and in
   * the same change: gating only /:id would move the hole rather than close it, since
   * this route and /phases below expose the same workshop to the same caller. A
   * participant reaches this legitimately, via the membership branch.
   */
  app.get("/workshops/:id/assistants", async (c) => {
    const workshop = await deps.workshops.getById(c.req.param("id"));
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);

    const denied = await requireWorkshopRead(c, deps.membership, workshop, deps.entitlements);
    if (denied) return denied;

    // Older workshops without the field default to all assistants enabled.
    const enabledAssistants = sanitizeEnabledAssistants(
      workshop.enabledAssistants
    );
    return c.json({ enabledAssistants });
  });

  app.patch("/workshops/:id", async (c) => {
    const identity = requireIdentity(c);
    const workshopId = c.req.param("id");
    const body = await c.req.json();

    const existing = await deps.workshops.getById(workshopId);
    if (!existing) return c.json({ error: "Workshop not found" }, 404);
    if (!isOwnerOrAdmin(existing, identity)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // ── `maxTeamSize` IS VALIDATED HERE TOO, AND THE PATCH IS WHERE IT MATTERS MOST ──
    //
    // The allowlist loop below copies the value STRAIGHT THROUGH — no `num()`, no bound — so
    // this route was the wider of the two holes: `PATCH {maxTeamSize: "999"}` stored the STRING,
    // and `{maxTeamSize: 999}` stored a cap above the platform ceiling. That
    // value is the template every new team's `seatCap` is seeded from.
    //
    // ⚠ THIS PATCH DOES NOT TOUCH EXISTING TEAMS, and that is deliberate: lowering a
    // workshop's template never strands a live team, so grandfathering is unreachable rather
    // than granted and NO MIGRATION REMOVES ANYONE. A facilitator who wants an existing team
    // resized uses `PATCH /v1/teams/:teamId` in the Team service, which refuses to go below that
    // team's live member count.
    //
    // Checked BEFORE the loop so nothing is written when the value is bad — the same
    // all-or-nothing shape the rest of this handler has.
    if (body.maxTeamSize !== undefined && !isValidMaxTeamSize(body.maxTeamSize)) {
      return c.json(
        {
          error: `maxTeamSize must be a whole number between ${MIN_TEAM_SIZE} and ${MAX_TEAM_MEMBERS}`,
        },
        400
      );
    }

    const patch: Partial<Workshop> = {};
    for (const key of [
      "name",
      "description",
      "format",
      "maxTeamSize",
      "minTeamSize",
      "aiModel",
      "aiEnabled",
      "startsAt",
      "endsAt",
      "currentPhaseOrder",
      "setupConfig",
    ] as const) {
      if (body[key] !== undefined) {
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }

    // Enabled assistants are sanitized so a workshop is never left with an
    // empty/invalid list that would lock participants out of every assistant.
    if (body.enabledAssistants !== undefined) {
      patch.enabledAssistants = sanitizeEnabledAssistants(body.enabledAssistants);
    }

    patch.updatedAt = new Date().toISOString();

    // Update against the REAL (ownerId, id) — not the caller's id — so an ADMIN
    // editing someone else's workshop touches the correct item.
    await deps.workshops.update(existing.ownerId, workshopId, patch);

    return c.json({ success: true });
  });

  app.patch("/workshops/:id/status", async (c) => {
    const identity = requireIdentity(c);
    const workshopId = c.req.param("id");
    const { status } = await c.req.json();

    if (!(WORKSHOP_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: "Invalid status" }, 400);
    }

    // Resolve the real workshop so we update the correct (ownerId, id) item.
    // Without this we'd blindly upsert Key: {ownerId: caller.id} and, for a
    // non-owner, silently create a phantom workshop row keyed to the caller.
    const existing = await deps.workshops.getById(workshopId);
    if (!existing) return c.json({ error: "Workshop not found" }, 404);
    if (!isOwnerOrAdmin(existing, identity)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await deps.workshops.update(existing.ownerId, workshopId, {
      status,
      updatedAt: new Date().toISOString(),
    });

    await deps.events.publish({
      source: "workshop-service",
      type: "workshop.status-changed",
      detail: { workshopId, ownerId: existing.ownerId, status },
    });

    return c.json({ success: true });
  });

  // ─── Phase definitions (per workshop) ───────────────────────────────────────

  /**
   * List a workshop's phase definitions (ordered) — GATED (P1-3).
   *
   * Same rule and same change as /:id and /assistants above. This route needs the
   * workshop ROW to authorize (ownerId lives on it), which it did not previously load
   * at all — so the getById below is part of the gate, not an extra read: without it
   * the owner branch has nothing to compare and every facilitator would fall through
   * to the membership hop.
   *
   * That also makes an unknown workshop a 404 here rather than an empty phases list,
   * which is a small behaviour change and the honest one — "no such workshop" and
   * "a workshop with no phases yet" were previously the same response.
   */
  /**
   * ── ⚠ OWNERSHIP TRANSFER: THE ORPHAN RECOVERY PATH ───────────────────────────────────────
   *
   * `PATCH /workshops/:id/owner  { ownerId }`
   *
   * WHY IT EXISTS. Since ADMIN is scoped to the experiences it owns, an experience
   * whose owner is DEACTIVATED is reachable and administrable by NOBODY: every gate on it is
   * `workshop.ownerId === caller`, and no living person satisfies it. The admin role used to be
   * the way back and deliberately is not any more. This is the way back that does not reopen it.
   *
   * ⚠ THE ALTERNATIVE WAS CONSIDERED AND IS WORSE. "Let an admin invite a facilitator into the
   * experience" does nothing today and could not be made to work cheaply: `WORKSHOP_POLICY`
   * FORBIDS a facilitator invitation naming a workshop (400, "a FACILITATOR sees the workshops
   * they create"), and the read gate admits a facilitator only by ownership — the entitlement
   * branch is narrowed to JUDGE. Making it work means inventing a second class of experience
   * staff and re-deciding every "owner only" rule for them: publish results? reopen a submission?
   * see every judge's scores? Transfer changes one field and leaves all of those rules intact.
   *
   * ⚠ ADMIN ONLY, and that is a platform-administration judgement rather than an experience one.
   * An orphan by definition has no owner to ask, so the power has to sit with the role that
   * administers the platform. It is the same ⚙ category as the invitation matrix and the user
   * directory (ROLES.md).
   *
   * ⚠ AND THE NEW OWNER'S ROLE IS VERIFIED, WHICH IS THE PART THAT KEEPS THIS FROM BEING AN
   * ESCALATION PRIMITIVE. `isOwnerOrAdmin` — the gate on every mutating route here — is pure
   * ownership:  `return workshop.ownerId === identity.id`.  So transferring to a PARTICIPANT would
   * hand them the power to rename the experience, set its phases and reopen its submissions.
   * `canCreateWorkshops` gates who may CREATE one and says nothing about who may come to own one.
   * The target must therefore hold a role that can own an experience, checked against Identity.
   *
   * ⚠ AN UNWIRED `userRoles` REFUSES RATHER THAN SKIPPING THE CHECK. A deployment that has not
   * configured the port cannot transfer at all (501). The tempting alternative — transfer without
   * verifying — is the fail-open shape that put an empty COGNITO_CLIENT_ID into this codebase's
   * history; an absent dependency must never mean "skip the gate".
   *
   * ⚠ UNDETERMINED IS 503, NEVER A REFUSAL. If Identity cannot answer, the caller is told to retry,
   * not told the user does not exist, and here the lie would send an operator hunting
   * for a typo in a recovery they are already stressed about.
   *
   * Emits `workshop.owner_transferred` so the move is on the event bus rather than only in a log.
   */
  app.patch("/workshops/:id/owner", async (c) => {
    const { id: callerId, role } = requireIdentity(c);

    if (role !== "ADMIN") {
      return c.json(
        {
          error: "Only an administrator can transfer an experience to a new owner",
          code: "TRANSFER_ADMIN_ONLY",
        },
        403
      );
    }

    const body = await c.req.json().catch(() => null);
    const toOwnerId =
      body && typeof (body as { ownerId?: unknown }).ownerId === "string"
        ? (body as { ownerId: string }).ownerId.trim()
        : "";
    if (!toOwnerId) {
      return c.json({ error: "ownerId is required" }, 400);
    }

    const workshop = await deps.workshops.getById(c.req.param("id"));
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);

    // Idempotent rather than a conflict: re-running a recovery that already succeeded should read
    // as "yes, that is the owner" and not as an error an operator has to interpret.
    if (workshop.ownerId === toOwnerId) {
      return c.json({ workshop, transferred: false });
    }

    if (!deps.userRoles) {
      return c.json(
        {
          error:
            "Ownership transfer is not available in this environment: the user directory is not configured.",
          code: "TRANSFER_UNAVAILABLE",
        },
        501
      );
    }

    const targetRole = await deps.userRoles.roleOf(toOwnerId, c);
    if (targetRole === "unavailable") {
      c.header("Retry-After", "2");
      return c.json(
        {
          error:
            "We couldn't check that user just now. This is a temporary problem, not a change to your access.",
          code: "USER_LOOKUP_UNAVAILABLE",
        },
        503
      );
    }
    if (targetRole === null) {
      return c.json({ error: "No such user", code: "TRANSFER_TARGET_UNKNOWN" }, 400);
    }
    if (!canCreateWorkshops(targetRole)) {
      return c.json(
        {
          error: `An experience can only be owned by ${[...WORKSHOP_CREATOR_ROLES].join(" or ")} — ${toOwnerId} is a ${targetRole}.`,
          code: "TRANSFER_TARGET_INELIGIBLE",
        },
        400
      );
    }

    const outcome = await deps.workshops.transferOwner(workshop, toOwnerId);
    if (outcome === "conflict") {
      return c.json(
        {
          error: "This experience was changed while the transfer was running. Reload and try again.",
          code: "TRANSFER_CONFLICT",
        },
        409
      );
    }

    console.log("[workshops] ownership transferred", {
      workshopId: workshop.id,
      fromOwnerId: workshop.ownerId,
      toOwnerId,
      actorId: callerId,
    });

    await deps.events
      .publish({
        source: "workshop-service",
        type: "workshop.owner_transferred",
        detail: {
          workshopId: workshop.id,
          fromOwnerId: workshop.ownerId,
          toOwnerId,
          actorId: callerId,
        },
      })
      // Best-effort by contract, like every other publish here: the transfer has COMMITTED, and
      // failing the response now would tell an operator it did not happen.
      .catch((err) => {
        console.warn("[workshops] owner_transferred publish failed — the transfer still committed", {
          workshopId: workshop.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return c.json({ workshop: { ...workshop, ownerId: toOwnerId }, transferred: true });
  });

  app.get("/workshops/:workshopId/phases", async (c) => {
    const workshopId = c.req.param("workshopId");

    const workshop = await deps.workshops.getById(workshopId);
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);

    const denied = await requireWorkshopRead(c, deps.membership, workshop, deps.entitlements);
    if (denied) return denied;

    const phases = await deps.phases.listByWorkshop(workshopId);
    return c.json({ phases });
  });

  /**
   * ── SET A WORKSHOP'S PHASES — ⚠ ONCE, AT CREATION, AND NEVER AGAIN ────────────────────────
   *
   * THE RULE: nobody may edit, rename or delete the three phases once they are set.
   *
   * ── ⚠ WHAT THIS ROUTE USED TO DO, AND WHY IT WAS DANGEROUS ──
   *
   * It was an unconditional BULK REPLACE: delete every existing phase, then insert the submitted set
   * with FRESH ULIDs. Owner/ADMIN only, but reachable at any point in a workshop's life.
   *
   * ⚠ PHASE IDS ARE LOAD-BEARING IN TWO OTHER CONTEXTS, so that was silent data loss rather than an
   * edit:
   *   · `praimana-team-phases` keys every team's NOTES by phaseId. New ids orphan all of them —
   *     the rows survive in the table and no longer belong to any phase, so the notes simply vanish
   *     from the page with nothing reporting an error.
   *   · a released submission's SNAPSHOT stores `phases[].phaseId`. A judge's pinned view is supposed
   *     to be immutable; rewriting the phases underneath it breaks the one guarantee
   *     that view makes.
   *
   * Nothing in the product needed the replace. The only caller is the NEW-EXPERIENCE form
   * (`workshop.setPhases` → `experiences/new/page.tsx`); `PhasePipelineEditor` appears on that page and
   * nowhere else, and no settings screen edits phases. So the capability existed solely as a way to
   * destroy data.
   *
   * ── ⚠ IDEMPOTENT, NOT MERELY REFUSING ──
   *
   * A flat "409 once phases exist" would break a legitimate RETRY: the create page calls this straight
   * after creating the workshop, and a network blip after a successful write would leave the operator
   * looking at an error on an experience that is actually fine. So an identical submission returns the
   * EXISTING phases with 200 and writes nothing — the same idiom as the submission create.
   * Only a submission that would CHANGE something is refused.
   *
   * The comparison is over name, description and duration, because "edit" in the request includes
   * rewording a description, not just renaming. Incoming values are normalised the same way a stored
   * one is (`|| ""`, `|| null`) so a retry cannot fail on a shape difference that the store would have
   * flattened anyway.
   */
  app.put("/workshops/:workshopId/phases", async (c) => {
    const identity = requireIdentity(c);
    const workshopId = c.req.param("workshopId");

    // Authorize BEFORE any destructive work — this route deletes and recreates
    // every phase, so an unauthorized caller must be rejected first.
    const workshop = await deps.workshops.getById(workshopId);
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);
    if (!isOwnerOrAdmin(workshop, identity)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { phases } = await c.req.json();
    if (!Array.isArray(phases) || phases.length === 0) {
      return c.json({ error: "phases array is required" }, 400);
    }

    const existing = await deps.phases.listByWorkshop(workshopId);

    if (existing.length > 0) {
      /**
       * ⚠ READ BEFORE ANY DELETE. The original code deleted first and asked questions never; the
       * ordering here is the whole protection, so a future edit must not move the delete loop above
       * this block.
       */
      const byOrder = [...existing].sort((a, b) => a.order - b.order);
      const unchanged =
        byOrder.length === phases.length &&
        byOrder.every((stored, i) => {
          const incoming = phases[i] ?? {};
          return (
            stored.name === incoming.name &&
            stored.description === (incoming.description || "") &&
            stored.durationMinutes === (incoming.durationMinutes || null)
          );
        });

      if (unchanged) {
        // A retry of the creation call. Nothing to do, and saying so beats inventing an error.
        return c.json({ phases: byOrder });
      }

      return c.json(
        {
          error:
            "This experience's phases are already set and cannot be changed. Phase ids are referenced by every team's notes and by released submissions, so replacing them would orphan that work.",
          code: "PHASES_IMMUTABLE",
        },
        409
      );
    }

    const now = new Date().toISOString();
    const created = [];
    for (let i = 0; i < phases.length; i++) {
      const item = await deps.phases.put({
        workshopId,
        order: i + 1,
        id: ulid(),
        name: phases[i].name,
        description: phases[i].description || "",
        durationMinutes: phases[i].durationMinutes || null,
        createdAt: now,
      });
      created.push(item);
    }

    return c.json({ phases: created }, 201);
  });

  // Advance/set current phase on a workshop. Owner/ADMIN only.
  app.patch("/workshops/:workshopId/current-phase", async (c) => {
    const identity = requireIdentity(c);
    const workshopId = c.req.param("workshopId");
    const { currentPhaseOrder } = await c.req.json();

    if (typeof currentPhaseOrder !== "number" || currentPhaseOrder < 0) {
      return c.json(
        { error: "currentPhaseOrder must be a non-negative number" },
        400
      );
    }

    const workshop = await deps.workshops.getById(workshopId);
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);
    if (!isOwnerOrAdmin(workshop, identity)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const advancedAt = new Date().toISOString();
    await deps.workshops.update(workshop.ownerId, workshopId, {
      currentPhaseOrder,
      updatedAt: advancedAt,
    });

    // NOTE: the monolith fanned this out by QUERYING the teams table and emitting
    // a per-team event so each team's Phases view updates in real time. Teams are
    // owned by the TEAM service, so this service must NOT read that table. Instead
    // we publish ONE workshop-level event; the Team service subscribes and fans it
    // out to the teams it owns (it already knows which teams belong to a workshop).
    await deps.events.publish({
      source: "workshop-service",
      type: "workshop.phase-advanced",
      detail: { workshopId, currentPhaseOrder, advancedAt },
    });

    return c.json({ success: true, currentPhaseOrder });
  });

  // ─── Per-team phase content ─────────────────────────────────────────────────
  //
  // Content lives in teamPhases (PK teamId, SK phaseId). Each row tracks whether
  // the content was AI-generated and who last edited it (name + timestamp).

  // List a team's phases: workshop phase definitions joined with the team's saved
  // content. Returns phases ordered, each with content/editedBy/editedAt.
  app.get("/workshops/teams/:teamId/phases", async (c) => {
    const teamId = c.req.param("teamId");

    // Team MEMBERSHIP is owned by the TEAM service (teamMembers), so this service
    // ASKS rather than reads: the guard delegates to the injected TeamAccess (an HTTP
    // call to Team's own /teams/:id/access, or an event-fed read-model). Without this,
    // `teamId` is an unvalidated path param and a guessed id dumps another team's phase
    // content — the notes the whole workshop is written into.
    //
    // MEMBER-ONLY (requireTeamContentRead, narrowed from requireTeamRead),
    // and these routes are in scope. Per-team phase content IS
    // team-authored content: it is what a team wrote in response to each phase, the same
    // material as the board and the chat, and it sits in teamPhases keyed by teamId. So an
    // ADMIN or a workshop-owning FACILITATOR no longer reads it ambiently — which is the
    // deliberate consequence, because the phase DEFINITIONS they own are a different thing
    // from the team's answers to them, and the definitions stay readable through
    // GET /workshops/:workshopId/phases.
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const workshopId = c.req.query("workshopId");
    if (!workshopId) {
      return c.json({ error: "workshopId query param is required" }, 400);
    }

    /**
     * THE SECOND GATE, and the reason it is not redundant with the teamId one above.
     *
     * `teamId` is authorized; `workshopId` arrives from the QUERY STRING and was not.
     * Nothing tied the two together, so a member of ANY team could name a FOREIGN
     * workshop here and read its phase definitions — bypassing
     * GET /workshops/:workshopId/phases, which gates exactly that with
     * requireWorkshopRead. Two sibling routes reaching the same table must not
     * disagree about who may read it.
     *
     * Workshop ids are not a secret and cannot be the control: they leak legitimately
     * through /invitations/mine, the admin filter and desktop settings — a
     * determination this service already records above requireWorkshopRead. So the
     * only defence is checking entitlement to the workshop actually asked for.
     *
     * NO Team → Workshop → Team CYCLE is introduced. requireWorkshopRead resolves
     * locally for ADMIN and for the owner, and its one hop (membership) is reached only
     * on a miss — while the Team service's ownsWorkshop probe targets
     * GET /workshops/:id, never this route. So Team calling here cannot re-enter Team.
     *
     * The ORDER matters: requireTeamRead still runs first, so a caller with no claim to
     * the team learns nothing about whether the workshop exists.
     */
    const workshop = await deps.workshops.getById(workshopId);
    if (!workshop) return c.json({ error: "Workshop not found" }, 404);

    const deniedWorkshop = await requireWorkshopRead(c, deps.membership, workshop, deps.entitlements);
    if (deniedWorkshop) return deniedWorkshop;

    const [phases, teamPhases] = await Promise.all([
      deps.phases.listByWorkshop(workshopId),
      deps.teamPhases.listByTeam(teamId),
    ]);

    const contentByPhase = new Map(teamPhases.map((tp) => [tp.phaseId, tp]));
    const merged = phases.map((p) => {
      const tp = contentByPhase.get(p.id);
      return {
        id: p.id,
        order: p.order,
        name: p.name,
        description: p.description || "",
        content: tp?.content || "",
        aiGenerated: tp?.aiGenerated || false,
        editedByName: tp?.editedByName || null,
        editedAt: tp?.editedAt || null,
      };
    });

    return c.json({ phases: merged });
  });

  // Save (create/replace) a team's content for one phase. Records the editor.
  app.put("/workshops/teams/:teamId/phases/:phaseId", async (c) => {
    const { id } = requireIdentity(c);
    const teamId = c.req.param("teamId");
    const phaseId = c.req.param("phaseId");

    // Write authz BEFORE the body is read or anything is persisted: membership is
    // owned by the TEAM service, so it is asked through the injected TeamAccess.
    //
    // MEMBER-ONLY (narrowed from requireTeamWrite) — see the GET above.
    // Moving the write with the read is not optional: a predicate that let a non-member
    // WRITE a team's phase notes while refusing to let them READ them would be both
    // incoherent and the more damaging half.
    //
    // ⚠ `requireTeamPhaseWrite`, NOT `requireTeamContentWrite`. The comment here
    // used to read "the guard also 403s a read-only EXECUTIVE member, who may watch a team's phases
    // but must never overwrite them" — accurate, and a bug: an executive on a team
    // could not update Ideation. The rule is that every TEAM MEMBER may edit the team's
    // phases. The narrower guard grants exactly that and nothing else; see its own note for why
    // relaxing `requireTeamContentWrite` would also have granted evaluation scores and source writes.
    const denied = await requireTeamPhaseWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    // ── ⚠ THE PHASE ID IS BOUNDED ───────────────────────────────────────────────
    //
    // Previously this took `phaseId` from the path and wrote a row under it with no
    // validation at all, so any string became key material and the merged read above — which
    // iterates the WORKSHOP'S phases and looks each one up — never surfaces the result. Orphan rows,
    // written by an authorized member, invisible to every reader.
    //
    // ⚠ THIS IS THE CHEAP HALF, AND IT RUNS FIRST DELIBERATELY. It bounds the KEY — a phase id
    // cannot be a megabyte of text — with no store read and no east-west hop, so an absurd id is
    // refused before anything is paid for. The check below is the one that establishes the id
    // actually MEANS something, and it costs a hop; ordering them this way keeps the expensive
    // question off the path of the obviously-wrong request.
    if (!phaseId || phaseId.length > MAX_PHASE_ID_LENGTH) {
      return c.json(
        { error: "phaseId is missing or too long", code: "PHASE_ID_INVALID" },
        400
      );
    }

    const { content } = await c.req.json();

    // ── ⚠ AND SO IS THE CONTENT ──────────────────────────────────────────────────────────────
    //
    // It was stored with a type check and NO length bound. Two reasons that is not merely untidy:
    // the row is an authenticated member's free text in a store with no per-row limit of its own,
    // and phase content is COPIED INLINE into the release snapshot (evaluation's release path) — so
    // an oversized note also risked pushing the submission item past DynamoDB's 400 KB item limit
    // and making RELEASE fail, for a team that had done nothing wrong at release time.
    //
    // REFUSED rather than truncated: silently storing the first N characters of somebody's phase
    // notes would let them believe work was saved that was not.
    if (typeof content === "string" && content.length > MAX_PHASE_CONTENT_CHARS) {
      return c.json(
        {
          error: `Phase content must be ${MAX_PHASE_CONTENT_CHARS} characters or fewer.`,
          code: "PHASE_CONTENT_TOO_LONG",
          limit: MAX_PHASE_CONTENT_CHARS,
        },
        400
      );
    }

    // ── ⚠ AND IT MUST NAME A PHASE OF *THIS TEAM'S* EXPERIENCE ──────────────────
    //
    // The bound above stops an absurd key; this stops a MEANINGLESS one. Without it a member could
    // save notes under an id that names no phase, and the merged read — which iterates the
    // experience's phases and looks each one up — never surfaces them. Work somebody believes they
    // saved, that nobody can ever see.
    //
    // TWO STEPS, and only the first leaves this service: teamId → workshopId is Team's data, asked
    // through its own API with the CALLER's token; the phase TEMPLATE is ours, read locally. One
    // east-west hop and one local Query on a user-initiated save — not a hot path, and the cost is
    // the reason this validation was skipped rather than a reason to keep skipping it.
    //
    // ⚠ LAST, AFTER EVERY LOCAL CHECK. It is the only expensive step on this route, so the phase-id
    // bound and the content cap above both run first: a malformed request is refused without paying
    // for a hop. Cheapest-first, same ordering rule the authorization guards in this repo follow.
    if (!deps.teamWorkshop) {
      console.error(
        "[workshop] phase save refused — no teamWorkshop port is wired, so phaseId cannot be validated"
      );
      return c.json(
        {
          error: "Saving phase notes is unavailable in this environment.",
          code: "PHASE_TEMPLATE_UNAVAILABLE",
        },
        503
      );
    }

    const teamWorkshopId = await deps.teamWorkshop.workshopIdOf(teamId, c);
    if (teamWorkshopId === "unavailable") {
      // TRANSIENT — the hop could not be completed, or Team is older than `withWorkshop`. A retry
      // genuinely changes the answer, so Retry-After is truthful. NOT a refusal: telling
      // a member their phase does not exist because another service was slow would send them
      // arguing with a rule that will fix itself.
      c.header("Retry-After", "2");
      return c.json(
        {
          error: "Could not check this experience's phases — try again shortly.",
          code: "PHASE_TEMPLATE_UNAVAILABLE",
        },
        503
      );
    }
    if (teamWorkshopId === null) {
      // DETERMINED absence: the team is unknown to Team, or its `workshopId` has been cleared. There
      // is no phase template, so no phaseId can be valid — this is the ORPHAN-TEAM case `canRead`
      // documents in the team service, and it is answered rather than written into.
      return c.json(
        {
          error: "This team is not part of an experience, so it has no phases to save.",
          code: "PHASE_NOT_IN_EXPERIENCE",
        },
        409
      );
    }

    const template = await deps.phases.listByWorkshop(teamWorkshopId);
    if (!template.some((phase) => phase.id === phaseId)) {
      // 404 rather than 400: the request is well-formed and the caller is authorized; the phase
      // simply is not one of this experience's. The message names the remedy a member can act on.
      return c.json(
        {
          error: "That phase is not part of this team's experience.",
          code: "PHASE_NOT_FOUND",
        },
        404
      );
    }

    // NOTE: the monolith set editedByName by reading the users table
    // (resolveUserName). Users are owned by the IDENTITY service, so we do NOT read
    // that table. editedByName is left null here; in the full impl it comes from a
    // local users read-model synced off Identity's `user.*` events (see the ai
    // service's users-readmodel.dynamo.ts for the pattern).
    const editedAt = new Date().toISOString();
    const teamPhase = await deps.teamPhases.put({
      teamId,
      phaseId,
      content: typeof content === "string" ? content : "",
      aiGenerated: false,
      editedById: id,
      editedByName: null,
      editedAt,
    });

    // NOTE: the monolith also published a per-team activity event (publishTeamEvent)
    // for the team's live activity feed. That feed is a Team/Chat concern; a full
    // impl would publish a domain event the owning service consumes. Kept minimal.

    return c.json({ phase: teamPhase });
  });

  // ─── Lookup ─────────────────────────────────────────────────────────────────

  // The workshop-format dropdown's options. Reference data, not workshop data — it
  // discloses nothing about any workshop, tenant or user, and it is identical for
  // every caller.
  //
  // ⚠ `requireIdentity` IS THE PRIMARY ACCESS CONTROL HERE, NOT DEFENCE IN DEPTH. This
  // comment used to say the route was UNMAPPED in the gateway, so that the only way in
  // was in-process or from inside the VPC. That is no longer true: `platform-api.yaml`
  // maps `GET /v1/lookup/{proxy+}` to this function, so the path is publicly reachable
  // and this check is the only thing standing in front of it. Do not remove it on the
  // strength of the old reasoning.
  //
  // Deliberately NOT role-gated — every role that can reach the workshop create form
  // needs these options, and narrowing it would break the form for no confidentiality
  // gain.
  //
  // The catalogue is READ-ONLY to this service: there is no write path for formats
  // anywhere in it, so an empty table is a seeding gap rather than a bug. See the
  // "Seed data" section of the infrastructure deployment README.
  app.get("/lookup/formats", async (c) => {
    requireIdentity(c);

    const formats = await deps.formats.listByCategory("workshop_format");
    return c.json({ formats });
  });

  /**
   * Workshop resources — the facilitator's material for one experience.
   *
   * Registered here rather than written inline because they are a self-contained concern with their own
   * admission policy and storage; this file is long enough that a seventh area in it would be the one
   * nobody finds. Both authorization gates they use (`requireWorkshopRead` and ownership) are this
   * service's own — see resource-routes.ts.
   */
  registerResourceRoutes(app, deps);

  return app;
}
