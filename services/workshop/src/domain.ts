import type { Context } from "hono";
/**
 * Workshop bounded context — domain types + repository interfaces.
 *
 * The Workshop service owns exactly these tables: workshops, phases, teamPhases,
 * and the formats lookup. It owns NO other context's data (Single Responsibility).
 * In particular it does NOT read users, teams, teamMembers, or messages — those
 * belong to the Identity, Team, and Chat contexts. Where the monolith's routes
 * reached into those tables (team counts, editor names, chat-based generation),
 * this service either omits the enrichment with a `// NOTE:` or gets the data via
 * a narrow injected interface (see WorkshopStats / TeamPhaseCount below).
 */

/** The AI coding assistants the platform supports. A workshop's
 *  `enabledAssistants` is validated against this list; empty/absent means all. */
export const VALID_ASSISTANTS = ["claude", "kiro", "codex"] as const;
export type Assistant = (typeof VALID_ASSISTANTS)[number];

/** Workshop lifecycle statuses (mirrors the monolith). */
export const WORKSHOP_STATUSES = [
  "DRAFT",
  "REGISTRATION",
  "ACTIVE",
  "JUDGING",
  "COMPLETED",
  "ARCHIVED",
] as const;
export type WorkshopStatus = (typeof WORKSHOP_STATUSES)[number];

export interface Workshop {
  ownerId: string;
  id: string;
  name: string;
  description?: string | null;
  format: string;
  status: WorkshopStatus;
  maxTeamSize: number;
  minTeamSize: number;
  aiModel: string;
  aiEnabled: boolean;
  enabledAssistants: string[];
  setupConfig?: unknown;
  startsAt?: string | null;
  endsAt?: string | null;
  currentPhaseOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Phase {
  workshopId: string;
  order: number;
  id: string;
  name: string;
  description: string;
  durationMinutes: number | null;
  createdAt: string;
}

export interface TeamPhase {
  teamId: string;
  phaseId: string;
  content: string;
  aiGenerated: boolean;
  editedById: string;
  editedByName: string | null;
  editedAt: string;
}

export interface Format {
  name: string;
  value: string;
}

/**
 * Repository interfaces — domain/route code depends on THESE, not on DynamoDB
 * (DIP). Narrow by aggregate (Interface Segregation). Swapping the DynamoDB impl
 * for an HTTP/event-backed one later does not touch the routes.
 */
/**
 * One row of the ADMIN catalogue — ID AND NAME AND NOTHING ELSE.
 *
 * ⚠ THE NARROWNESS IS THE AUTHORIZATION DESIGN, NOT A PROJECTION OPTIMISATION. An ADMIN is
 * scoped to the experiences they OWN (ROLES.md), and this type is the single, deliberate
 * exception: enough to NAME an experience in the Administration tab's invite picker, and not
 * enough to learn anything about it. No status, no owner, no dates, no phases, no counts, no
 * setupConfig — so widening this type is a policy change and should be argued as one.
 */
export interface WorkshopCatalogueEntry {
  id: string;
  name: string;
}

export interface WorkshopRepository {
  /** List a caller's workshops (by ownerId, newest first). */
  listByOwner(ownerId: string): Promise<Workshop[]>;
  /**
   * EVERY workshop on the platform, id and name only — the ADMIN catalogue.
   *
   * The "separate route". `GET /workshops` deliberately
   * answers an ADMIN from `listByOwner`, so before this existed an admin could not NAME another
   * owner's experience in the invite picker — and an admin must be able to invite any user to any
   * experience from the Administration tab, as a facilitator does.
   *
   * ⚠ A SCAN, AND THEREFORE BOUNDED AND TRUNCATION-REPORTING. `workshops` is keyed
   * (ownerId HASH, id RANGE), so "all owners" has no Query that answers it. `truncated` is
   * returned rather than logged because a picker silently missing the experience an operator
   * is looking for reads as "it does not exist" — the same class of lie as an empty directory.
   */
  listAllForCatalogue(
    limit: number
  ): Promise<{ workshops: WorkshopCatalogueEntry[]; truncated: boolean }>;
  /** Resolve a workshop by its id via the id-index GSI (returns owner too). */
  getById(id: string): Promise<Workshop | null>;
  /**
   * Resolve MANY workshops by id — the read half of the entitled list.
   *
   * Separate from getById rather than callers looping it, so the BOUND and the
   * dedupe live in one place: an entitled list is fanned out one Query per id on
   * `id-index`, and an unbounded fan-out over a store result on a page-render path is
   * how a slow workshop takes out the list for everyone. Ids that resolve to nothing
   * (a deleted workshop still named by an invitation) are DROPPED, not returned as
   * nulls — a dangling entitlement is not an error, it is just not a workshop.
   *
   * Newest first, matching listByOwner's ScanIndexForward: false, so the entitled and
   * owned lists are not sorted differently for no reason.
   */
  listByIds(ids: string[]): Promise<Workshop[]>;
  /**
   * Move a workshop to a new owner — the ORPHAN RECOVERY path.
   *
   * ⚠ A MOVE, NOT AN UPDATE, AND THE TABLE'S KEY IS WHY. `workshops` is keyed
   * (ownerId HASH, id RANGE), so `ownerId` IS the partition key — `update()` skips it
   * explicitly for that reason. Changing it means writing a new item and deleting the old.
   *
   * ⚠ AND IT MUST BE ONE TRANSACTION. Done as two calls, a failure between them leaves either
   * TWO rows sharing one `id` or NONE. Two is the worse outcome: `getById` resolves through the
   * `id-index` GSI with `Limit: 1`, so the experience would answer to whichever copy the index
   * returned — nondeterministically, per request, with two owners each seeing themselves as the
   * owner. `TransactWriteItems` makes the move atomic.
   *
   * Returns what happened rather than throwing, so the route can tell a caller the difference
   * between "done" and "somebody else moved it first":
   *   · `"transferred"` — the move committed.
   *   · `"conflict"`    — the source row was gone, or the destination key already existed. Either
   *                       way this transfer did not happen and the caller should re-read.
   */
  transferOwner(
    workshop: Workshop,
    toOwnerId: string
  ): Promise<"transferred" | "conflict">;
  put(workshop: Workshop): Promise<Workshop>;
  /** Partial update keyed by the real (ownerId, id). */
  update(
    ownerId: string,
    id: string,
    patch: Partial<Workshop>
  ): Promise<void>;
}

/**
 * ── ⚠ THERE IS NO `delete`, AND THAT IS THE POINT ──────────────────────────────────────────
 *
 * THE RULE: nobody may edit, rename or delete the three phases once they are set.
 *
 * `delete(workshopId, order)` existed and had exactly ONE caller: the bulk-replace branch of
 * `PUT /workshops/:workshopId/phases`, which wiped every phase and re-inserted the submitted set with
 * FRESH ULIDs. That was silent data loss dressed as an edit — phase ids key every team's NOTES in
 * `praimana-team-phases` and appear in released submission SNAPSHOTS, so new ids orphaned all of
 * it with nothing reporting an error.
 *
 * The route now refuses any change (409 `PHASES_IMMUTABLE`), and the method is REMOVED RATHER THAN
 * LEFT UNUSED — the same reasoning the AI service applies to its withdrawn model port. A guard can be
 * deleted by the next person in a hurry; an absent method has to be deliberately re-added, and doing so
 * is where the "what does this orphan?" question gets asked. Nothing else in this service, and no route
 * anywhere, deletes a phase or a workshop.
 */
export interface PhaseRepository {
  listByWorkshop(workshopId: string): Promise<Phase[]>;
  put(phase: Phase): Promise<Phase>;
}

export interface TeamPhaseRepository {
  listByTeam(teamId: string): Promise<TeamPhase[]>;
  put(teamPhase: TeamPhase): Promise<TeamPhase>;
}

export interface FormatRepository {
  listByCategory(category: string): Promise<Format[]>;
}

/**
 * Team COUNT per workshop is owned by the TEAM service (it owns the teams table),
 * NOT by this service. `?withCounts=1` therefore asks this narrow injected
 * interface instead of querying a foreign table. Inject an HTTP client to the Team
 * service, or an event-fed read-model (from `team.created`/`team.deleted`), and
 * the routes never change (DIP). Returns team count keyed by workshopId.
 */
export interface WorkshopStats {
  /**
   * Team count per workshopId. A workshop MISSING from the result means "unknown" —
   * NOT zero. Callers must omit the field rather than defaulting it, because a
   * confident 0 on a workshop that has teams is the bug this interface's placeholder
   * implementation caused.
   *
   * Takes the request Context so the implementation can forward the caller's identity
   * on the east-west hop; the count route it asks is identity-gated.
   */
  teamCounts(workshopIds: string[], c?: Context): Promise<Record<string, number>>;
}

/** Convenience no-op stats source: returns 0 for every workshop. Use this until a
 *  real Team-service client or read-model is wired. Documents the boundary rather
 *  than silently reading the teams table. */
export class ZeroWorkshopStats implements WorkshopStats {
  async teamCounts(_workshopIds?: string[]): Promise<Record<string, number>> {
    // Empty, not a map of zeros. Returning `{ id: 0 }` is what made the experiences list
    // claim "0 teams" for workshops that had teams — a stated figure that was simply
    // false. An empty map means "unknown", and the routes then omit `_count` so the UI
    // shows "—" instead of a lie. Kept for tests and for a deployment with no Team
    // service reachable.
    return {};
  }
}

/**
 * Sanitize a client-provided enabledAssistants list against VALID_ASSISTANTS.
 * Never returns an empty list — that would lock every participant out of every
 * assistant — so absent/empty/invalid input defaults to all assistants.
 */
export function sanitizeEnabledAssistants(value: unknown): string[] {
  if (!Array.isArray(value)) return [...VALID_ASSISTANTS];
  const filtered = value.filter(
    (a): a is string =>
      typeof a === "string" &&
      (VALID_ASSISTANTS as readonly string[]).includes(a)
  );
  return filtered.length > 0 ? [...new Set(filtered)] : [...VALID_ASSISTANTS];
}
