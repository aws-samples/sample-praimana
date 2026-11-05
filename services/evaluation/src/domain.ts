/**
 * EVALUATION bounded context — domain types + repository interfaces.
 *
 * The Evaluation service owns exactly three tables: submissions, scores, and
 * memberRatings. It owns NO other context's data (Single Responsibility). In
 * particular it must NOT read users, teams, teamMembers, tasks, messages, or
 * gitCommits — the monolith's rating aggregator did (it scanned ~8 tables). Here
 * those cross-context reads are replaced by:
 *
 *   - an activity READ-MODEL (MemberActivity) fed by domain events, and
 *   - a users READ-MODEL (UserView) fed by `user.*` events for name/email display.
 *
 * Routes and domain logic depend on the interfaces below (DIP), never on DynamoDB.
 */
import type { ReadModel } from "@praimana/service-shared";
// The caller's request context, forwarded so a hop authorizes as the SAME user rather than as this
// service. Defined in authz.ts beside the ports that already take it.
import type { AuthContext } from "./authz.js";

/**
 * ── ⚠ THE RESERVED SORT-KEY NAMESPACE, AND WHY IT IS A NAMESPACE RATHER THAN ONE VALUE ────
 *
 * The team's uniqueness POINTER lives in the same partition as its submission, keyed
 * `teamId` = the team and `id` = this sentinel.
 *
 * ⚠ NO SUBMISSION MAY EVER CARRY AN ID IN THIS NAMESPACE. `byId` is a HASH-on-`id` GSI
 * queried with `Limit: 1` (`repository.dynamo.ts:69`), so if two teams' rows shared an `id`,
 * `getById` would return AN ARBITRARY TEAM'S SUBMISSION — and every authorization decision in this
 * service reads that record. It is a cross-tenant leak, not an untidiness.
 *
 * The whole `#` PREFIX is reserved rather than the single literal, because the create route accepts
 * a caller-supplied `id`: reserving one string invites the next internal row to pick `#pointer2` and
 * discover the guard only covered its predecessor. A ULID can never begin with `#`
 * (Crockford base32), so nothing legitimate is excluded.
 */
export const RESERVED_ID_PREFIX = "#";
export const POINTER_ID = "#pointer";

/** True for any id reserved for this service's internal rows. Used by the WRITER, not just readers. */
export function isReservedId(id: string): boolean {
  return id.startsWith(RESERVED_ID_PREFIX);
}

/**
 * The team's one submission id, held in its own partition under `POINTER_ID`.
 *
 * Written inside the same `TransactWriteItems` as the submission, so two concurrent creates cannot
 * both win, using the standard conditional-transaction idiom. It carries nothing but the pointer — a duplicate of
 * any submission field here would be a second, disagreeing copy.
 */
export interface SubmissionPointer {
  teamId: string;
  id: typeof POINTER_ID;
  submissionId: string;
}

/**
 * What a judge reads: the team's work PINNED at the moment of release.
 *
 * ⚠ PHASES ARE COPIED, ARTIFACTS ARE POINTED AT. Phase notes are small text, so they are stored
 * inline and a later edit cannot change what a judge sees. Artifact BODIES stay in S3 and are
 * fetched at the pinned `versionId` — copying them would duplicate every team's files into this
 * table, and S3 versioning already gives an immutable read.
 */
export interface Snapshot {
  takenAt: string;
  /**
   * ⚠ THE TEAM'S NAME, PINNED — AND THE ONLY WAY A JUDGE CAN LEARN IT WITHOUT WIDENING ANOTHER
   * SERVICE'S AUTHZ (the pinning design forbids that explicitly).
   *
   * Team's `GET /workshops/:workshopId/teams` FILTERS BY MEMBERSHIP for anyone who is not an ADMIN or
   * the workshop owner, and a judge is on no team — so that route returns an EMPTY list to them. The
   * name therefore has to be captured by someone who can see it, and release already runs as an
   * executive who is a member of the team.
   *
   * ⚠ NULL IS ACCEPTABLE HERE, UNLIKE EVERY OTHER SNAPSHOT FIELD. A display name is not part of the
   * submission and not a release precondition: if that read fails, the release proceeds and a reader
   * falls back to the team id. Artifacts and phases are the submission itself, so THEY block. The
   * asymmetry is deliberate — blocking a deadline release because a name lookup was slow would be a
   * worse failure than showing a ULID.
   */
  teamName: string | null;
  phases: Array<{
    phaseId: string;
    order: number;
    name: string;
    content: string;
    aiGenerated: boolean;
    editedByName: string | null;
    editedAt: string | null;
  }>;
  artifacts: Array<{
    path: string;
    versionId: string | null;
    lastAuthorName: string | null;
    updatedAt: string;
  }>;
}

/** A team's hackathon submission. Mirrors the monolith's submissions rows but is
 *  team-scoped (teamId + id) instead of workshop-scoped, matching the AI service's
 *  teamId+id convention. workshopId is retained as an attribute for reference. */
export interface Submission {
  teamId: string;
  id: string;
  workshopId: string | null;
  status: "DRAFT" | "SUBMITTED";
  title: string | null;
  summary: string | null;
  problemStatement: string | null;
  solution: string | null;
  demoUrl: string | null;
  videoUrl: string | null;
  repoUrl: string | null;
  slidesUrl: string | null;
  aiUsageSummary: string | null;
  submittedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  /**
   * ── RELEASE AND REOPEN AUDIT ──
   *
   * `releasedAt` is the real field; `submittedAt` above is kept at the SAME VALUE for API
   * compatibility with anything already reading it. Two names for one instant is not ideal and is
   * deliberate — the alternative is breaking a field that predates this work.
   */
  releasedById: string | null;
  releasedAt: string | null;
  reopenedById: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  /** Written at release, REPLACED on each release, and RETAINED through a reopen. */
  snapshot: Snapshot | null;
}

/** The fields a team may edit on its own draft — everything else is server-owned. */
export type SubmissionPatch = Partial<
  Pick<
    Submission,
    | "title"
    | "summary"
    | "problemStatement"
    | "solution"
    | "demoUrl"
    | "videoUrl"
    | "repoUrl"
    | "slidesUrl"
    | "aiUsageSummary"
  >
>;

/**
 * A single judge's score for a submission. Keyed by submissionId + judgeId so a judge scores a given
 * submission once — and a second attempt is REFUSED (409 `ALREADY_SCORED`) rather
 * than overwriting.
 *
 * ── ⚠ `aiUsage` IS OPTIONAL BECAUSE IT IS HISTORICAL, NOT BECAUSE IT IS UNIMPORTANT ───────────
 *
 * It was a scored criterion until it was dropped: the narrative it judged had already come off
 * the submission form, so a fifth of every score was being awarded against
 * something the team could no longer write. `SCORE_CRITERIA` now has four entries and
 * `MAX_SCORE_PER_JUDGE` is 40.
 *
 * ⚠ THE FIELD STAYS ON THE TYPE, MARKED OPTIONAL, RATHER THAN BEING DELETED. Rows written before
 * it was dropped still carry a number, and a type that denied it would make every one of them
 * unrepresentable — so reading an old row would either lie or throw. Optional is the honest shape:
 * present on historical rows, absent on new ones, and read by nothing. Totals and means are derived
 * over `SCORE_CRITERIA`, so an old row now reads as four criteria out of 40 — lower than the judge
 * saw when they submitted it, which is the only internally consistent answer short of a migration.
 */
export interface Score {
  submissionId: string;
  judgeId: string;
  innovation: number;
  execution: number;
  /** @deprecated Dropped from `SCORE_CRITERIA`. Present on rows written before it was dropped. */
  aiUsage?: number;
  impact: number;
  presentation: number;
  comment: string | null;
  createdAt: string;
}

/** A peer rating submitted by one team member about another. */
export interface MemberRating {
  teamId: string;
  id: string;
  raterId: string;
  ratedUserId: string;
  score: number;
  comment: string | null;
  createdAt: string;
}

/**
 * Per-member activity counters — the local projection that REPLACES the monolith
 * rating aggregator's cross-table reads. Fed by domain events (see applyActivityEvent
 * in routes.ts). The rating endpoint aggregates over THIS, never over foreign tables.
 */
export interface MemberActivity {
  teamId: string;
  userId: string;
  tasksCreated: number;
  tasksCompleted: number;
  messagesSent: number;
  commitsPushed: number;
  /**
   * Threads SHARED — a count of button presses, not of assistant usage. Kept because the
   * ratings summary already reports it, but see `aiTurns`: someone who used an assistant all
   * day and never pressed "share" scores zero here.
   */
  aiThreadsShared: number;
  /**
   * ASSISTANT TURNS — the honest AI-usage signal, fed by `ai.response-generated` from BOTH the
   * in-app Bedrock path (1 per invoke) and the desktop CLI sync (n per batch).
   *
   * OPTIONAL, and absence is MEANINGFUL: rows written before this counter existed have no value,
   * which is NOT the same as zero turns. A reader must treat `undefined` as "not measured" — the
   * event was consumed by nothing until now, so every historical row is in that state and
   * folding them in as zeros would understate every early team.
   */
  aiTurns?: number;
  updatedAt: string;
}

/** Minimal projection of a user this service needs (name/email for display).
 *  Populated from Identity's `user.*` events — NOT by reading the users table. */
export interface UserView {
  id: string;
  name: string;
  email?: string;
}

/**
 * Repository interfaces — domain code depends on THESE, not on DynamoDB (DIP).
 * Narrow by aggregate (Interface Segregation). Swapping the DynamoDB impl for an
 * HTTP/event-backed one later does not touch the routes.
 */
/**
 * What `createUnique` decided. A LOSER IS NOT AN ERROR — it is told which submission won, because
 * the second create to return the existing record rather than a conflict.
 */
export type CreateUniqueOutcome =
  | { outcome: "created"; submission: Submission }
  | { outcome: "exists"; submissionId: string };

/** What `patch` decided. The two refusals are DISTINGUISHABLE, which a bare boolean would lose. */
export type PatchOutcome =
  | { outcome: "patched"; submission: Submission }
  | { outcome: "not-found" }
  | { outcome: "not-draft" };

export interface SubmissionRepository {
  get(teamId: string, id: string): Promise<Submission | null>;
  getById(submissionId: string): Promise<Submission | null>;
  /** ⚠ MUST EXCLUDE THE POINTER ROW — it shares the team's partition but is not a submission. */
  listByTeam(teamId: string): Promise<Submission[]>;
  put(submission: Submission): Promise<Submission>;
  /**
   * Create the team's ONE submission and its pointer in a single transaction.
   *
   * ⚠ NOT `has one already?` THEN `put`. A route-level read cannot hold against a concurrent
   * writer — the same reasoning reused verbatim.
   */
  createUnique(submission: Submission): Promise<CreateUniqueOutcome>;
  /** The team's one submission id, or null when it has none yet. */
  pointer(teamId: string): Promise<string | null>;
  /**
   * Edit a DRAFT's team-owned fields.
   *
   * ⚠ MUST NOT REWRITE `createdById` OR `createdAt`, and must refuse a released submission
   * ATOMICALLY rather than after a read — a check-then-write would let a release land in between.
   */
  patch(teamId: string, id: string, fields: SubmissionPatch): Promise<PatchOutcome>;
  /**
   * The RELEASED submissions of one experience, newest release first.
   *
   * ⚠ RELEASED ONLY, AND THE NAME SAYS SO because a caller who forgot would leak every team's DRAFT
   * to a judging panel. An unreleased team is ABSENT from the list, not a 403 — a judge has no
   * business knowing a team exists and has not submitted.
   *
   * BOUNDED. `truncated` is reported rather than silently dropping the tail, because a list that is
   * quietly short reads as "that team never submitted" — the same reasoning Team's former-members
   * list records.
   */
  listReleasedByWorkshop(
    workshopId: string,
    limit?: number
  ): Promise<{ submissions: Submission[]; truncated: boolean }>;
}

export interface ScoreRepository {
  listBySubmission(submissionId: string): Promise<Score[]>;
  /**
   * ⚠ A JUDGE SCORES ONCE, AND THE STORE ENFORCES IT — `put` USED TO LET THEM OVERWRITE.
   *
   * The row is keyed `(submissionId, judgeId)`, so a second POST silently REPLACED the first. The
   * portal has since stopped offering the form again, but a UI is not a boundary: a stale tab, a
   * double-click, or a direct API call still rewrote a cast score, and nothing recorded that it had
   * changed.
   *
   * ⚠ CONDITIONAL, NOT A READ-THEN-WRITE. Two requests from one judge — a double-click, or a retry
   * after a timeout the first attempt actually completed — would both read "not scored" and both
   * write. Exactly the reasoning `WorkshopResultsRepository.create` already applies to publication,
   * and the same shape of answer: the refusal is a VALUE, not a thrown error, so the route reports a
   * 409 rather than a fault.
   */
  create(score: Score): Promise<"created" | "already-scored">;
}

export interface MemberRatingRepository {
  listByTeam(teamId: string): Promise<MemberRating[]>;
  /**
   * ⚠ ONE RATING PER (RATER, RATED), AND THE STORE ENFORCES IT — `put` LET A RATER WRITE FOREVER.
   *
   * Previously the route minted a fresh `ulid()` for every call, so nothing keyed the row
   * to the pair it describes: one rater could POST the same teammate a thousand times and every row
   * landed and every row came back from `listByTeam`. That is unbounded authenticated storage AND a
   * corrupted read — the team's ratings view is a list, so a rater could drown out their teammates'
   * opinions by repeating their own.
   *
   * The row id is now DERIVED from (raterId, ratedUserId) — see `memberRatingId` — so the pair IS
   * the key and a second attempt collides.
   *
   * ⚠ CONDITIONAL, NOT A READ-THEN-WRITE, and the refusal is a VALUE rather than a thrown error —
   * both exactly as `ScoreRepository.create` above, for the same two reasons: a double-click or a
   * retry after a timeout the first attempt actually completed would otherwise both read
   * "not rated" and both write, and a route reporting a 409 should not have to catch a fault to do
   * it.
   */
  create(rating: MemberRating): Promise<"created" | "already-rated">;
}

/**
 * The row id for a peer rating: the (rater, rated) pair, which is what makes the pair unique.
 *
 * ⚠ THIS DOES NOT REOPEN THE TABLE'S KEY DESIGN, and the distinction matters. The table is keyed
 * (teamId, id) rather than (teamId, ratedUserId) precisely because the latter "would make a person's
 * rating single-valued per team so a second rater silently overwrote the first — wrong for peer
 * rating by construction" (see repository.dynamo.test.ts). Encoding the RATER into the id keeps
 * every rater's opinion of the same teammate on its OWN row — the property that decision protects —
 * while making a single rater's opinion of a single teammate single-valued, which is the property
 * that was missing.
 *
 * `#` as the separator. Both halves are opaque ids from a verified token or a validated body, so
 * neither can contain a `#` that would make two different pairs collide — `ratedUserId` is length-
 * and charset-checked at the route before it reaches here.
 */
export function memberRatingId(raterId: string, ratedUserId: string): string {
  return `${raterId}#${ratedUserId}`;
}

/**
 * ── ⚠ WHAT THE SNAPSHOT IS BUILT FROM, AND WHY IT IS TWO PORTS ──────────────────────────
 *
 * A release pins the team's PHASE NOTES (owned by the Workshop context, table `team-phases`) and its
 * ARTIFACT POINTERS (owned by the Docs context). Neither belongs to this service, so neither is read
 * from its table — each is asked of the owning service through its own API, which is the line
 * between microservices and a distributed monolith (the same argument `TeamAccess` records).
 *
 * TWO PORTS RATHER THAN ONE `SnapshotSource`, because they answer questions about different subjects
 * owned by different contexts and fail independently: Docs can be healthy while Workshop is not. A
 * single port would have to invent a combined failure, and the release preconditions need to say
 * WHICH hop went unanswered.
 *
 * ⚠ `"unavailable"` IS A THIRD OUTCOME, NOT AN EMPTY LIST. An unanswered
 * hop must never be read as an answer. Collapsing it to `[]` would make P3 ("the team has ≥1
 * artifact") refuse a team WITH artifacts during a Docs brownout — and, far worse, would let a
 * release write an EMPTY SNAPSHOT that judges then read as the team's whole submission.
 */
export interface SnapshotArtifact {
  path: string;
  versionId: string | null;
  lastAuthorName: string | null;
  updatedAt: string;
}

export interface SnapshotPhase {
  phaseId: string;
  order: number;
  name: string;
  content: string;
  aiGenerated: boolean;
  editedByName: string | null;
  editedAt: string | null;
}

/** The Docs context's answer: this team's current artifact pointers, at their current versions. */
export interface DocsCatalog {
  listByTeam(
    teamId: string,
    auth?: AuthContext
  ): Promise<SnapshotArtifact[] | "unavailable">;
}

/** The Workshop context's answer: this team's phase notes, joined with the phase definitions. */
export interface PhaseNotes {
  listByTeam(
    teamId: string,
    workshopId: string,
    auth?: AuthContext
  ): Promise<SnapshotPhase[] | "unavailable">;
}

/**
 * The team's display name, best-effort, read at RELEASE time by an executive member.
 *
 * ⚠ RETURNS `null` RATHER THAN `"unavailable"`, WHICH IS THE OPPOSITE OF THE OTHER PORTS. That is the
 * point: this one is display metadata, so a failure degrades to "no name" instead of blocking a
 * release. See the note on `Snapshot.teamName`.
 */
export interface TeamDirectory {
  nameOf(teamId: string, workshopId: string, auth?: AuthContext): Promise<string | null>;
  /**
   * Every team in an experience, with its name and member count — for the OWNER's activity view.
   *
   * ⚠ IT RETURNS WHAT THE CALLER IS ENTITLED TO SEE, AND THAT IS THE WHOLE SECURITY MODEL HERE.
   * Team's `GET /workshops/:id/teams` filters to the caller's own teams unless they are an ADMIN or
   * the workshop OWNER — so calling it as an owner yields every team, and calling it as anyone else
   * yields almost nothing. This service adds no ambient authority; it forwards the caller.
   *
   * ⚠ `"unavailable"` IS DISTINCT FROM AN EMPTY LIST. An experience genuinely has zero teams before
   * anyone provisions them, and reporting a failed hop as "no teams" would tell a facilitator their
   * experience is empty when it is not.
   */
  teamsOf(
    workshopId: string,
    auth?: AuthContext
  ): Promise<Array<{ id: string; name: string | null; memberCount: number | null }> | "unavailable">;
}

/**
 * ── WHO IS ON A TEAM — asked of the TEAM context, never read from its table ──────────────────
 *
 * Added to close the half of the peer-rating finding that local bounds could not reach.
 * `POST /teams/:teamId/ratings` validated `ratedUserId` against NOTHING: the length, charset, self-
 * rating and one-row-per-pair rules are all local and all in place, but "is this person actually on
 * the team?" is a question only Team can answer. Without it a member could mint a rating row for any
 * id at all — one per (rater, id) pair, so the per-pair uniqueness bound did not cap the row count
 * either, because the id half was unbounded.
 *
 * ⚠ A SEPARATE PORT FROM `TeamDirectory`, deliberately. That one answers "what is this team CALLED"
 * and "which teams are in this experience" — display metadata, whose failures are correctly reported
 * as `null` because a missing name must never block a deadline release. This answers an
 * INTEGRITY question on a write path, and its failure has to be loud. Two ports, because they
 * answer questions about different subjects and fail differently — the same reasoning recorded on
 * the two snapshot ports above.
 *
 * ⚠ IT ADDS NO AMBIENT AUTHORITY. The implementation re-presents the CALLER's own token against
 * Team's `GET /teams/:teamId/members`, which is gated on `requireTeamRead` — so it answers only for
 * a caller who could have read that roster themselves. The rating route's own guard
 * (`requireTeamContentWrite`) already established the caller is a member, so the hop cannot fail for
 * authorization reasons without the two services disagreeing.
 *
 * ⚠ `"unavailable"` IS NOT `false`, and the polarity is the point. `false` means "that
 * person is not on this team", which is a validation answer a member can act on; an unanswered hop
 * reported that way would make an outage look like a member arguing with a rule. The route answers
 * 503 with Retry-After for one and 404 for the other.
 */
export interface TeamRoster {
  /**
   * Is `userId` an ACTIVE member of this team?
   *
   * ⚠ A QUESTION, NOT THE ROSTER — and the narrowness is deliberate rather than stylistic. The
   * callee's roster response carries members' EMAIL ADDRESSES and, on removed rows, the removing
   * operator's sub. A port that handed back the list would put all of that inside this service for a
   * caller to pick over; a boolean cannot leak what it does not carry. The filtering happens at the
   * HTTP boundary, which is the only place that response should ever exist.
   *
   * ⚠ ACTIVE ONLY. A removed member's row survives and reactivation restores it, but
   * somebody who has been removed is not a person a teammate may still file a NEW opinion about —
   * and admitting inactive ids would make removal a way to keep writing rows about someone after
   * they have lost the access to see or answer them.
   */
  isActiveMember(
    teamId: string,
    userId: string,
    auth?: AuthContext
  ): Promise<boolean | "unavailable">;
}

/**
 * The experience itself — who OWNS it, and what state it is in.
 *
 * Needed by two callers: the judge/owner list (the list allows "or owner", and the entitlements
 * probe does NOT cover an owner — it is built from invitations and memberships, and a facilitator who
 * owns an experience may have neither), and publishing places, which must move the experience to
 * COMPLETED.
 *
 * ⚠ `"unavailable"` IS DISTINCT FROM `null`. `null` means the experience does not exist (a 404);
 * `"unavailable"` means we could not find out, which must never be reported as "you do not own this".
 */
export interface WorkshopDirectory {
  get(
    workshopId: string,
    auth?: AuthContext
  ): Promise<{ id: string; ownerId: string | null; status: string } | null | "unavailable">;
  /**
   * Move the experience to a new lifecycle state — `COMPLETED` on publication.
   *
   * ⚠ A CROSS-CONTEXT WRITE, THROUGH THE OWNING SERVICE'S OWN API, as the caller. Workshop's
   * `PATCH /workshops/:id/status` is already owner-or-ADMIN gated, so this service cannot move an
   * experience the caller could not have moved themselves.
   *
   * Returns whether it landed. ⚠ THE CALLER MUST NOT TREAT FAILURE AS FATAL: by the time this runs the
   * results row is already written, and that is the authoritative fact. See the publish route.
   */
  setStatus(workshopId: string, status: string, auth?: AuthContext): Promise<boolean>;
}

/**
 * ── ONE PUBLISHED RESULT PER EXPERIENCE ─────────────────────────────────────
 *
 * ⚠ `minScoresPerSubmission` IS RECORDED, NOT ASSUMED. The quorum constant can change; a result
 * published under the old one must stay explainable afterwards. Same reasoning as the released
 * snapshot: what was decided is stored, not re-derived later from whatever the code now says.
 *
 * ⚠ AND THE PLACES ARE STORED, NOT RECOMPUTED ON READ. A ranking that recomputed itself would change
 * when a late score arrived — after the owner had declared the result and teams had been told.
 */
export interface WorkshopResults {
  workshopId: string;
  publishedById: string;
  publishedAt: string;
  minScoresPerSubmission: number;
  places: Array<{
    place: number;
    teamId: string;
    submissionId: string;
    teamName: string | null;
    average: number;
    judgeCount: number;
  }>;
  /** Set only when a human actually broke a tie — see the ordering note in places.ts. */
  tieBrokenById: string | null;
  tieBrokenAt: string | null;
}

export interface WorkshopResultsRepository {
  get(workshopId: string): Promise<WorkshopResults | null>;
  /**
   * Withdraw a published ranking, so the experience can be judged again.
   *
   * ⚠ THE ONLY CALLER IS REOPEN, AND THAT PAIRING IS THE WHOLE DESIGN. Scoring is refused once results
   * are published — otherwise a late score silently staleds a stored ranking that teams have already
   * been told. But an owner REOPENING a submission plainly intends it to be re-judged, and the places
   * are stored rather than recomputed, so the old ranking cannot be allowed to stand as the answer to a
   * question that has changed.
   *
   * ⚠ SO A REOPEN RETRACTS A PUBLISHED RESULT. That is a real consequence and it was chosen: the
   * alternative is a ranking that no longer matches the scores behind it. The owner must publish again.
   *
   * ⚠ THE RELEASED SNAPSHOT IS NOT TOUCHED — it is what already-cast scores were cast against,
   * and deleting it would make those scores unexplainable. Only the RANKING is withdrawn.
   *
   * Idempotent: deleting an absent ranking is a no-op, so a reopen on an unpublished experience is fine.
   */
  clear(workshopId: string): Promise<void>;
  /**
   * ⚠ WRITTEN ONCE PER EXPERIENCE, and a second publish is refused by the CONDITION rather than by a
   * preceding read — two owners pressing Publish at the same moment must not both succeed and race
   * over which ranking is stored.
   */
  create(results: WorkshopResults): Promise<"created" | "already-published">;
}

/** Users read-model (name/email enrichment), fed by Identity's `user.*` events. */
export type UsersReadModel = ReadModel<UserView, string>;

/**
 * Activity read-model. Keyed by (teamId, userId). Exposes get/list plus an
 * event-driven `increment` so the future event consumer can bump counters as
 * domain events arrive — this is the seam the monolith's multi-table reads collapse
 * into. `get`/`upsert`/`delete` follow the shared ReadModel shape (composite key).
 */
export interface ActivityReadModel {
  get(teamId: string, userId: string): Promise<MemberActivity | null>;
  listByTeam(teamId: string): Promise<MemberActivity[]>;
  upsert(activity: MemberActivity): Promise<void>;
  /** Atomically add to a named counter, creating the row if absent. */
  /**
   * Bump one counter. IDEMPOTENT when `eventId` is supplied.
   *
   * EventBridge is at-least-once, so this can be called twice for one real occurrence —
   * either a genuine double delivery, or a retry after a write whose response was lost. A
   * blind `+ 1` therefore over-counts, permanently and undetectably: there is no
   * reconciliation pass, and nothing downstream can tell an inflated counter from a busy
   * member. `eventId` is the bus's own per-delivery id; the implementation records it and
   * refuses a second increment for the same id.
   *
   * Omitting it means "cannot deduplicate" — accepted for the in-process publisher, which
   * has no bus and delivers exactly once by construction.
   */
  increment(
    teamId: string,
    userId: string,
    counter: keyof Omit<MemberActivity, "teamId" | "userId" | "updatedAt">,
    by?: number,
    eventId?: string
  ): Promise<void>;
}
