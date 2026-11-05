import { Hono } from "hono";
import type { Context } from "hono";
import { ulid } from "ulid";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  type DomainEvent,
  type EventPublisher,
} from "@praimana/service-shared";
import { isReservedId, memberRatingId, RESERVED_ID_PREFIX } from "./domain.js";
import type { MemberRating } from "./domain.js";

/**
 * Cap on the `ratedUserId` a peer rating may name.
 *
 * Previously the route checked only that the field was TRUTHY, so any value became key
 * material for a stored row. 128 comfortably admits a Cognito sub (36) and a ULID (26) while
 * refusing prose — the same "bound what one request can write into a row" reasoning as
 * MAX_SCORE_COMMENT_CHARS.
 */
const MAX_RATED_USER_ID_LENGTH = 128;
import { computePlaces, MIN_SCORES_PER_SUBMISSION } from "./places.js";
import type { PlacesOutcome } from "./places.js";
import type {
  Score,
  Submission,
  SubmissionPatch,
  DocsCatalog,
  PhaseNotes,
  TeamDirectory,
  TeamRoster,
  WorkshopDirectory,
  WorkshopResultsRepository,
  SubmissionRepository,
  ScoreRepository,
  MemberRatingRepository,
  ActivityReadModel,
  UsersReadModel,
  MemberActivity,
} from "./domain.js";

/**
 * P4: a demo URL good enough to release.
 *
 * ⚠ `https:` ONLY, AND PARSED RATHER THAN PATTERN-MATCHED. `startsWith("https://")` would be close,
 * and `URL` is exact — it settles `HTTPS://`, whitespace, and the cases that matter:
 *
 *   - `http://…` is refused. This link is handed to judges; sending a panel to a plaintext URL is a
 *     downgrade the platform should not perform on their behalf.
 *   - `javascript:…` is refused. A judge's browser is the thing this protects, and the
 *     protocol allowlist is the only reliable place to do it — an escape in a UI is a second chance,
 *     not the first one.
 */
function isReleasableDemoUrl(demoUrl: string | null): boolean {
  if (!demoUrl) return false;
  return isHttpsUrl(demoUrl);
}

/**
 * `https:` and nothing else, PARSED rather than pattern-matched.
 *
 * ⚠ EXTRACTED FROM `isReleasableDemoUrl` SO THE PATCH ROUTE AND THE RELEASE GATE CANNOT DISAGREE.
 * The parse was inline in that one predicate, which is how three of the four URL fields ended up with
 * no check at all: there was nothing to reuse. `startsWith("https://")` would be close and this is
 * exact — it settles `HTTPS://`, leading whitespace, and the two cases that matter:
 *
 *   - `http://…` is refused. These links are handed to judges; sending a panel to a plaintext URL is a
 *     downgrade this platform should not perform on their behalf.
 *   - `javascript:…` is refused. A reader's browser is what this protects, and a protocol allowlist is
 *     the only reliable place to do it — escaping in a UI is a second chance, not the first one.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    // Not a URL at all. A team typing "coming soon" must not be releasable.
    return false;
  }
}

/**
 * Cap on any single editable submission text field, in characters.
 *
 * Mirrors the intent of `MAX_SCORE_COMMENT_CHARS`: bound what one request can write into a row that
 * every judge and the results page reads, and REFUSE rather than truncate so nobody loses the end of
 * an answer without being told. 20k is far above a considered `problemStatement` and far below a
 * payload that makes a row expensive to read.
 */
const MAX_SUBMISSION_FIELD_CHARS = 20_000;

/**
 * The fields a team may edit on its own draft.
 *
 * ⚠ AN ALLOWLIST, AND IT IS THE ONLY THING THE PATCH ROUTE WILL WRITE. `status`, `snapshot`,
 * `workshopId`, `createdById`/`createdAt` and the release/reopen audit fields are absent, so no
 * request shape can reach them — the protection is the shape of this array, not a check someone has
 * to remember to add. Kept in step with `SubmissionPatch` in domain.ts, which `tsc` enforces.
 */
const EDITABLE_SUBMISSION_FIELDS = [
  "title",
  "summary",
  "problemStatement",
  "solution",
  "demoUrl",
  "videoUrl",
  "repoUrl",
  "slidesUrl",
  "aiUsageSummary",
] as const satisfies ReadonlyArray<keyof SubmissionPatch>;

/**
 * The editable fields that are LINKS, and must therefore be `https:` or absent.
 *
 * Derived from `EDITABLE_SUBMISSION_FIELDS` by name rather than listed independently, so a URL field
 * added to that array cannot silently arrive here unvalidated — which is exactly how `videoUrl`,
 * `repoUrl` and `slidesUrl` came to be unchecked while `demoUrl` was not.
 */
const URL_FIELDS: ReadonlySet<string> = new Set(
  EDITABLE_SUBMISSION_FIELDS.filter((f) => f.endsWith("Url"))
);

/** The 400 body a failed field check produces, ready to hand to `c.json(…, 400)`. */
type SubmissionFieldRejection = {
  error: string;
  code: "FIELD_INVALID" | "URL_INVALID" | "FIELD_TOO_LONG";
  field: string;
  max?: number;
};

/**
 * ── ⚠ THE THREE FIELD CHECKS, SHARED BY *BOTH* WRITERS ─────────────────────────────────────────────
 *
 * These lived inline in the PATCH loop, and CREATE had NONE of them: `POST /teams/:teamId/submissions`
 * copied nine client-controlled body fields into the stored row with only a `|| null` default. Both
 * routes share the same guard (`requireSubmissionDraftWrite`), so no extra privilege was needed to
 * take the unvalidated door — a team could simply create rather than patch. The release gate re-checked
 * `demoUrl` alone, so `videoUrl`/`repoUrl`/`slidesUrl` written at create time were never validated on
 * any path.
 *
 * ⚠ EXTRACTED RATHER THAN COPIED, deliberately. Two writers with two copies of a rule is the shape
 * that produced this defect in the first place (and, one layer down, the shape `isHttpsUrl` was
 * extracted to fix). One function, two call sites, identical 400 bodies.
 *
 * WHAT EACH CHECK IS FOR:
 *
 *  1. STRING-OR-NULL. A non-string stored here is type confusion for every reader — the judge's view,
 *     the release snapshot, the results page — and `|| null` silently accepted objects and numbers.
 *
 *  2. `https:` ON EVERY URL FIELD, not just `demoUrl` at release. `repoUrl:
 *     "javascript:alert(document.cookie)"` has already been stored and served on this platform. The
 *     writer is an EXECUTIVE on the team; the readers are the JUDGE scoring the submission and the
 *     experience owner — a role boundary crossed in the direction that matters most, the judged
 *     influencing the judge. Validated in the SERVICE even though the renderer is the portal, because
 *     "the services enforce; the UI explains" (ROLES.md): whether the portal sanitises an href is not
 *     a property this repo can assert or keep true, and a stored `javascript:` URI is a defect in the
 *     stored data regardless of who renders it.
 *
 *     CLEARING IS ALWAYS ALLOWED, AND WHITESPACE COUNTS AS CLEARING. `null`, `""` and `"   "` all skip
 *     the check — `trim()`, not `!== ""`, because the demo-link ordering rule on the PATCH route
 *     already treats a whitespace-only value as a clear, and two adjacent rules on the same field
 *     disagreeing about what "empty" means is how one of them ends up wrong. A team must be able to
 *     delete a value typed by mistake; gating the clear would trap them with a bad link.
 *
 *  3. A LENGTH BOUND. Mirrors `MAX_SCORE_COMMENT_CHARS`: bound what one request can write into a row
 *     every judge and the results page read, and REFUSE rather than truncate so nobody loses the end
 *     of an answer without being told.
 *
 * Returns the refusal body, or null when the value is acceptable.
 */
function rejectSubmissionField(field: string, value: unknown): SubmissionFieldRejection | null {
  if (value !== null && typeof value !== "string") {
    return { error: `${field} must be text or null.`, code: "FIELD_INVALID", field };
  }

  if (URL_FIELDS.has(field) && typeof value === "string" && value.trim() !== "") {
    if (!isHttpsUrl(value)) {
      return { error: `${field} must be a full https:// link.`, code: "URL_INVALID", field };
    }
  }

  if (typeof value === "string" && value.length > MAX_SUBMISSION_FIELD_CHARS) {
    return {
      error: `${field} must be ${MAX_SUBMISSION_FIELD_CHARS} characters or fewer.`,
      code: "FIELD_TOO_LONG",
      field,
      max: MAX_SUBMISSION_FIELD_CHARS,
    };
  }

  return null;
}

/**
 * ⚠ THIS SERVICE NOW DEPENDS ON `@praimana/shared`, WHICH BREAKS A LOCAL CONVENTION ON
 * PURPOSE. `authz.ts:21` and `team/src/authz.ts:35` mirror role tables locally because "bundled
 * Lambdas take no dep on @praimana/shared" (`service-shared/src/east-west.ts:21`).
 *
 * Three reasons that convention does not apply to the scoring rule:
 *
 *   1. The convention's own justification is BACKLOG P2-1 — five drifting copies of
 *      `ROLE_PRECEDENCE`, only one drift-tested. It is a known defect, not a design.
 *   2. `identity` already imports this package at the root and bundles with the IDENTICAL esbuild
 *      command, so the claim that a bundled Lambda cannot is disproven in this repo.
 *   3. The whole argument for the shared scoring rule is that the FORM and this ROUTE must refuse
 *      the same inputs. A local mirror here would recreate exactly the divergence
 *      `constants/scoring.ts` exists to prevent.
 *
 * ⚠ `packages/shared` declares `zod` but imports it NOWHERE in `src/`, so this adds no runtime
 * weight to the bundle beyond the constants themselves.
 */
import {
  SCORE_MIN,
  SCORE_MAX,
  SCORE_CRITERIA,
  MAX_SCORE_PER_JUDGE,
  MAX_SCORE_COMMENT_CHARS,
  scoreFieldErrors,
} from "@praimana/service-shared";
import {
  requireSubmissionRelease,
  requireSubmissionDraftWrite,
  requireTeamRead,
  requireTeamContentRead,
  requireTeamContentWrite,
  requireScoringRole,
  requireScoringScope,
  requireSubmissionRead,
  isStaffRole,
  type TeamAccess,
  type WorkshopEntitlements,
} from "./authz.js";

/**
 * Evaluation service routes. Note the constructor-style dependency injection: the
 * routes depend on INTERFACES (SubmissionRepository, ScoreRepository,
 * MemberRatingRepository, ActivityReadModel, UsersReadModel, TeamAccess,
 * EventPublisher) passed in, never on concrete DynamoDB/HTTP classes. This is the
 * Dependency Inversion seam — wiring lives in app.ts, and tests pass in-memory fakes.
 *
 * Mounted under basePath /v1 so it is a drop-in for the monolith's submission +
 * rating routes (strangler-fig: the gateway can route these paths here while
 * everything else still hits the monolith).
 */
export interface EvaluationDeps {
  submissions: SubmissionRepository;
  /**
   * The two content sources a RELEASE pins. Separate ports because they belong to
   * different contexts and fail independently — see the note on them in domain.ts.
   */
  docs: DocsCatalog;
  phases: PhaseNotes;
  /** The team's display name, pinned at release. See `Snapshot.teamName`. */
  teams: TeamDirectory;
  /**
   * WHO IS ON A TEAM — for the one write that names a person other than the caller.
   *
   * OPTIONAL, and the polarity is chosen so an unwired deployment FAILS CLOSED: the rating route
   * answers 503 rather than accepting an unvalidated `ratedUserId`. The alternative default —
   * "no roster port, so skip the check" — would silently restore the reported defect on any
   * deployment that had not been updated, which is exactly how a fix gets un-fixed.
   */
  roster?: TeamRoster;
  /** The experience's owner and state — the judging list's "or owner" branch, and publishing. */
  workshops: WorkshopDirectory;
  /** The published ranking, one row per experience. */
  results: WorkshopResultsRepository;
  scores: ScoreRepository;
  ratings: MemberRatingRepository;
  activity: ActivityReadModel;
  users: UsersReadModel;
  teamAccess: TeamAccess;
  /**
   * The caller's ENTITLED WORKSHOP IDS — `E(self)` — used by the judge-scoping guard
   * (BACKLOG P0-3). A SEPARATE port from `teamAccess` above because it
   * answers a different question about a different subject: "which workshops is this
   * caller judging?" rather than "may this caller touch this team?". Interface
   * Segregation, and the two have different failure semantics — see authz.ts.
   */
  entitlements: WorkshopEntitlements;
  events: EventPublisher;
}

/** Aggregated per-member contribution derived from the activity read-model. */
interface MemberContribution {
  userId: string;
  name: string | null;
  tasksCreated: number;
  tasksCompleted: number;
  messagesSent: number;
  commitsPushed: number;
  aiThreadsShared: number;
  /**
   * ASSISTANT TURNS — the honest AI-usage signal, unlike `aiThreadsShared` which counts button
   * presses.
   *
   * NULLABLE, and null is NOT zero: rows predating the `aiTurns` counter have no value, and the
   * event that feeds it was consumed by nothing until v0.3.2. Reporting those as 0 would say
   * "this member used no assistant" about a period nobody was measuring. A reader must render
   * null as "not measured" and exclude it from an average rather than pulling it down.
   */
  aiTurns: number | null;
  contributionScore: number;
}

/**
 * Turn raw activity counters into a single contribution score. Deliberately a
 * simple, transparent weighting over the LOCAL read-model — the point of the
 * decomposition is that this reads no foreign tables. (The monolith used Bedrock
 * over 8 tables; that heavier analysis can later run as its own consumer.)
 */
function scoreActivity(a: MemberActivity): number {
  /**
   * `aiTurns` IS DELIBERATELY NOT IN THIS WEIGHTING, and leaving it out is the safer error.
   *
   * The counter only started collecting at v0.3.2, so every row written before then has no
   * value. Adding a weighted term now would make a member's score jump the moment the data
   * starts arriving — a change in MEASUREMENT reading as a change in BEHAVIOUR — and would
   * penalise the entire history of the platform for a counter that did not exist.
   *
   * It is reported alongside (see MemberContribution.aiTurns) so a reader can see turns
   * directly. Fold it into the score only once every live row has a value, and say so in the
   * methodology when you do.
   */
  const raw =
    a.tasksCompleted * 10 +
    a.tasksCreated * 3 +
    a.commitsPushed * 5 +
    a.messagesSent * 1 +
    a.aiThreadsShared * 4;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Guard: the caller OWNS this experience (or is an ADMIN).
 *
 * Returns `{ denied }` rather than a bare `Response | null` because two callers need the workshop row
 * afterwards, and re-reading it would double the hop.
 *
 * ⚠ THREE OUTCOMES FROM THE PROBE, ALL DISTINCT. `"unavailable"` is a 503 and must never be reported
 * as "you do not own this" — one is temporary and the other tells a facilitator they are
 * not who they are. `null` is a genuine 404.
 */
/**
 * ⚠ NO `role` PARAMETER, AND ITS ABSENCE IS THE OWNERSHIP RULE IN THE SIGNATURE. This took
 * `role: string` for the `role !== "ADMIN" &&` branch described below; deleting that branch left the
 * argument dead, and all five callers still handing it over implied a role still steered this decision.
 * It does not — ownership is the whole predicate — so the parameter is gone rather than renamed `_role`.
 */
async function requireExperienceOwner(
  c: Context,
  workshops: WorkshopDirectory,
  workshopId: string | null,
  callerId: string
): Promise<{ denied: Response | null; workshop?: { ownerId: string | null; status: string } }> {
  if (!workshopId) {
    return {
      denied: c.json(
        {
          error: "This submission is not linked to an experience.",
          code: "SUBMISSION_SCOPE_UNKNOWN",
        },
        409
      ),
    };
  }

  const workshop = await workshops.get(workshopId, c);
  if (workshop === "unavailable") {
    c.header("Retry-After", "2");
    return {
      denied: c.json(
        {
          error: "We couldn't check this experience just now. Please try again.",
          code: "WORKSHOP_UNAVAILABLE",
        },
        503
      ),
    };
  }
  if (workshop === null) return { denied: c.json({ error: "Not found" }, 404) };

  /**
   * ⚠ OWNERSHIP, FOR EVERY ROLE INCLUDING ADMIN. This read `role !== "ADMIN" && ownerId !== callerId`,
   * so an admin passed every owner gate in this service — publishing another owner's results, reopening
   * their submissions, reading their preview. THE RULE: an ADMIN sees only the experiences they own — no other
   * experiences, scores or data — and an owner GATE that exempts a role is not an owner gate.
   *
   * ⚠ AN ADMIN WHO CREATED THE EXPERIENCE STILL PASSES — they are the `ownerId`. That is the whole of
   * the admin's access, and it needs no role branch to express.
   *
   * A FACILITATOR who owns a DIFFERENT experience is refused exactly like a participant, as before.
   */
  if (workshop.ownerId !== callerId) {
    return { denied: c.json({ error: "Forbidden", code: "NOT_THE_OWNER" }, 403) };
  }

  return { denied: null, workshop };
}

/**
 * Guard: the caller may READ this experience's published places.
 *
 * ⚠ WIDER THAN THE OWNER, DELIBERATELY, AND STILL NOT PUBLIC. The rule admits "any entitled reader of that
 * workshop". Places are the outcome of a competition and the participants, executives and judges of
 * that experience are its audience — but somebody with no connection to it is not.
 *
 * The owner branch is tried only for a staff role, so a judge's read costs one hop rather than two.
 */
async function requireExperienceReader(
  c: Context,
  deps: EvaluationDeps,
  workshopId: string,
  callerId: string,
  role: string
): Promise<Response | null> {
  /**
   * ⚠ THE BLANKET `if (role === "ADMIN") return null` IS GONE. THE RULE: an ADMIN
   * sees only the experiences they own — no other experiences, scores or data. It let an admin read the results, activity and places
   * of an experience they had nothing to do with.
   *
   * ⚠ NO REPLACEMENT BRANCH WAS NEEDED, WHICH IS WHY THIS IS A DELETION. `STAFF_ROLES` is
   * `{FACILITATOR, ADMIN}`, so an admin now falls into the staff branch below and is allowed exactly
   * when `requireExperienceOwner` says they own it — they created it — and otherwise
   * continues to the entitlement check like any other caller, which refuses them.
   *
   * ⚠ IT COSTS AN ADMIN ONE HOP THAT IT DID NOT BEFORE (the ownership lookup). That is the price of the
   * rule and it is bounded: the same lookup a facilitator has always made on this path, and this route
   * is a results read rather than anything on the desktop's hot path.
   */
  if (isStaffRole(role)) {
    const owner = await requireExperienceOwner(c, deps.workshops, workshopId, callerId);
    if (!owner.denied) return null;
    // A facilitator who does not own it may still be entitled to it — fall through rather than
    // returning the ownership refusal.
  }

  const entitled = await deps.entitlements.listEntitledWorkshopIds(role, c);
  if (entitled === "unavailable") {
    c.header("Retry-After", "2");
    return c.json(
      {
        error: "We couldn't confirm your access to this experience. Please try again.",
        code: "ENTITLEMENTS_UNAVAILABLE",
      },
      503
    );
  }
  return entitled.workshopIds.includes(workshopId)
    ? null
    : c.json({ error: "Forbidden", code: "WORKSHOP_NOT_ENTITLED" }, 403);
}

/**
 * Gather one experience's released submissions with their scores, and rank them.
 *
 * ⚠ THE SCORES ARE READ PER SUBMISSION, WHICH IS N READS, AND THAT IS FINE HERE. This runs on an
 * owner's explicit Publish or Preview — never on a participant's page load — and the list is bounded
 * by `listReleasedByWorkshop`. Reads are issued concurrently, so the wall clock is one round trip
 * rather than N.
 */
async function rankExperience(
  deps: EvaluationDeps,
  workshopId: string,
  tieOrder?: string[]
): Promise<PlacesOutcome | "unavailable"> {
  const { submissions } = await deps.submissions.listReleasedByWorkshop(workshopId);

  try {
    const entries = await Promise.all(
      submissions.map(async (s) => ({
        submissionId: s.id,
        teamId: s.teamId,
        teamName: s.snapshot?.teamName ?? null,
        releasedAt: s.releasedAt,
        scores: await deps.scores.listBySubmission(s.id),
      }))
    );
    return computePlaces(entries, { tieOrder });
  } catch (err) {
    /**
     * ⚠ A FAILED SCORE READ IS "unavailable", NOT AN EMPTY SCORE LIST. Empty scores would compute as
     * "quorum not met" — telling an owner the judges have not scored when in fact the table could not
     * be read. Same rule as every other unanswered question here.
     */
    console.error("[results] scores could not be read — refusing to rank", {
      workshopId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
}

export function createEvaluationRoutes(deps: EvaluationDeps) {
  const evaluation = new Hono().basePath("/v1");

  // Every request must carry a gateway-injected identity (authN done at edge).
  evaluation.use("*", edgeIdentityMiddleware());

  // ── THIS SERVICE IS THE ONE THAT USES BOTH PREDICATES ────────────
  //
  // SUBMISSIONS AND SCORES STAY WIDE (requireTeam{Read,Write}). A submission is a
  // DELIVERABLE: the team hands it over to be judged, and the people who judge it are by
  // definition not members. Narrowing these would 403 the workshop owner out of the
  // deliverables of the workshop they are running, which is not what "team content is
  // private" means — and the judging asymmetry documented at the scores route below is
  // already NARROWER than membership, so narrowing further changes nothing for a JUDGE.
  //
  // RATINGS/INSIGHTS MOVE NARROW (requireTeamContent{Read,Write}), because they are not a
  // deliverable — they are DERIVED FROM the four content surfaces. `contributionScore` is
  // computed from messagesSent, aiThreadsShared, tasksCompleted, tasksCreated and
  // commitsPushed, so leaving them wide would publish a numeric shadow of exactly the chat
  // and board that were just made private: how much a team talked, how much they leaned on
  // the model, per named person. `peerRatings` is worse still — teammates' free-text
  // opinions of each other. Both are on the ratings routes, so both move together.

  // ---- Submissions ---------------------------------------------------------

  evaluation.get("/teams/:teamId/submissions", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const submissions = await deps.submissions.listByTeam(teamId);
    return c.json({ submissions });
  });

  /**
   * Create a submission — AND DERIVE ITS WORKSHOP SERVER-SIDE (P0-3).
   *
   * THE DEFECT THIS CLOSES. `workshopId: body.workshopId || null` let the CALLER write the
   * field that the judge-scoping guard on the scores route now rests on. The server-derived-scope
   * rule requires it to be server-derived with `body.workshopId` IGNORED, and for good reason:
   * a scope a participant can name is not a scope. A team could have stamped a foreign
   * workshop onto their own submission and chosen which panel of judges was entitled to it.
   *
   * ONE HOP, NOT TWO. The route already asks Team whether this caller may write this team;
   * `writeScope` is that same probe with `?withWorkshop=1`, so the workshop arrives with the
   * decision. That is the "no new hop" requirement satisfied literally rather than
   * approximately.
   *
   * THE FAILURE LADDER, and every rung is deliberate:
   *
   *   read-only role        → 403 LOCALLY, no hop (an EXECUTIVE cannot create anything)
   *   "unavailable"         → 503. NEVER a null-scoped write — see below.
   *   canWrite false        → 403, exactly as requireTeamWrite answered before
   *   workshopId null       → 404. Team resolved the team and it has none, which in
   *                           practice means no such team: `workshopId` is the teams
   *                           table's PARTITION KEY, so no real row can lack it.
   *
   * **UNDETERMINED IS A 503, NEVER A NULL-SCOPED WRITE.** This is the same rule that
   * applies to the workshop list and the teams directory: "could not determine" must not be
   * returned as an answer. Here it is stronger than a display concern — a row stored with
   * `workshopId: null` is PERMANENTLY unscoreable, because the scoring guard refuses null
   * scopes with SUBMISSION_SCOPE_UNKNOWN and cannot do otherwise. Degrading a Team brownout
   * into a corrupt row would turn a two-second outage into a data-repair task.
   */
  evaluation.post("/teams/:teamId/submissions", async (c) => {
    const teamId = c.req.param("teamId");
    const { id } = requireIdentity(c);

    /**
     * ── ⚠ EXECUTIVE-ONLY ────────────────────────────────────────────────────────────────────────
     *
     * This used to be `isReadOnlyRole` + `writeScope().canWrite`, i.e. any team MEMBER except an
     * executive. That was the "authoring stays with the team" rule — and it deadlocked, because the
     * Submit tab is a staff screen a participant cannot reach, so the one role able to open the form was
     * the one refused by this check. See `requireSubmissionDraftWrite` for the full account.
     *
     * The guard asks EXECUTIVE **and** membership, so it subsumes what `writeScope` was consulted for;
     * a 503 on an unavailable team scope still comes from inside it, via `canReadContent`.
     */
    const scope = await requireSubmissionDraftWrite(c, deps.teamAccess, teamId);
    // A Response means refused (or a 503) — the guard owns every one of those bodies now.
    if (scope instanceof Response) return scope;

    // A determined "this team has no workshop" — see the ladder above.
    if (!scope.workshopId) {
      console.warn("[submissions] team resolved to no workshop — refusing to store a null scope", {
        teamId,
        userId: id,
      });
      return c.json({ error: "Not found" }, 404);
    }

    const body = await c.req.json();
    const now = new Date().toISOString();

    /**
     * ⚠ A CALLER MAY NOT NAME A RESERVED ID. `#pointer` lives in this same partition, and
     * `byId` is a HASH-on-`id` GSI read with `Limit: 1` — so a submission carrying a shared id would
     * make `getById` return AN ARBITRARY TEAM'S RECORD, which every authorization decision here
     * reads. Refused rather than silently replaced, because a caller who sent an id and got a
     * different one back has been lied to.
     */
    if (typeof body.id === "string" && isReservedId(body.id)) {
      return c.json(
        { error: "That id is reserved.", code: "RESERVED_ID", prefix: RESERVED_ID_PREFIX },
        400
      );
    }

    /**
     * ── ⚠ THE SAME FIELD VALIDATION AS PATCH ──────────────────────────────────────────────────
     *
     * This route had NONE. The nine fields below were copied out of the body with only a `|| null`
     * default — no type check, no scheme check on the four URL fields, no length cap — while PATCH
     * applied all three over the same fields. Both routes sit behind the same guard
     * (`requireSubmissionDraftWrite`), so taking the unvalidated door needed no extra privilege: a
     * team could create rather than patch. And the release gate re-checks `demoUrl` only, so a
     * `javascript:` `repoUrl` set at create time was never validated on any path.
     *
     * ⚠ ITERATES `EDITABLE_SUBMISSION_FIELDS`, NOT A HAND-WRITTEN LIST, so a field added to that
     * array is validated on both writers without anyone remembering to come back here — the same
     * argument `URL_FIELDS` makes for deriving itself from the same array.
     *
     * Absent fields are skipped (`in body`), which is what keeps a minimal create — the common case,
     * `{}` or just a title — working exactly as before.
     */
    for (const field of EDITABLE_SUBMISSION_FIELDS) {
      if (!(field in body)) continue;
      const bad = rejectSubmissionField(field, body[field]);
      if (bad) return c.json(bad, 400);
    }

    const candidate: Submission = {
      teamId,
      id: body.id || ulid(),
      // SERVER-DERIVED. `body.workshopId` is read nowhere on this route — deliberately
      // not even validated against this value, because a 400 on a mismatch would tell a
      // caller their input mattered. It does not.
      workshopId: scope.workshopId,
      status: "DRAFT",
      title: body.title || null,
      summary: body.summary || null,
      problemStatement: body.problemStatement || null,
      solution: body.solution || null,
      demoUrl: body.demoUrl || null,
      videoUrl: body.videoUrl || null,
      repoUrl: body.repoUrl || null,
      slidesUrl: body.slidesUrl || null,
      aiUsageSummary: body.aiUsageSummary || null,
      submittedAt: null,
      createdById: id,
      createdAt: now,
      updatedAt: now,
      releasedById: null,
      releasedAt: null,
      reopenedById: null,
      reopenedAt: null,
      reopenReason: null,
      snapshot: null,
    };

    /**
     * ── ⚠ IDEMPOTENT PER TEAM, HELD BY THE STORE ──────────────────────
     *
     * One submission per team is an INVARIANT, not a convention, so it is enforced by a
     * `TransactWriteItems` that writes the submission and the pointer together.
     *
     * A second create is NOT an error: it returns the existing record with **200**. That is
     * deliberate — the desktop and the portal both open a team's deliverables and both would
     * reasonably "ensure a draft exists", and a 409 would make each of them implement the same
     * recovery. The status code carries the difference for anyone who cares (201 created, 200
     * already yours).
     */
    const result = await deps.submissions.createUnique(candidate);

    if (result.outcome === "exists") {
      const existing = await deps.submissions.getById(result.submissionId);
      /**
       * ⚠ NO EVENT ON THIS PATH. `submission.created` must fire once per submission, not once per
       * attempt — a consumer counting them would over-count every time a client re-ensured a draft.
       */
      if (!existing) {
        // The pointer named a row that is not there. A genuine contradiction: report it rather than
        // inventing a record or silently creating a second submission.
        console.error("[submissions] pointer resolves to no submission", {
          teamId,
          submissionId: result.submissionId,
        });
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ submission: existing }, 200);
    }

    const submission = result.submission;

    // Cross-service notification travels as an event, not a direct call.
    await deps.events.publish({
      source: "evaluation-service",
      type: "submission.created",
      detail: { teamId, submissionId: submission.id, createdById: id },
    });

    return c.json({ submission }, 201);
  });

  /**
   * ── EDIT A DRAFT — THE ROUTE `POST` WAS BEING MISUSED AS ─────────────
   *
   * ⚠ WHY THIS HAD TO EXIST BEFORE RELEASE COULD MEAN ANYTHING. The only write path was the `POST`
   * above, whose `put` rewrote `createdById` and `createdAt` FROM THE CURRENT CALLER — so a second
   * teammate saving a draft silently reassigned authorship, and re-posting an existing id reset
   * `status` to `DRAFT`, un-releasing a submission judges may already have read. A demo URL has to be
   * updatable by the team before "the executive releases a draft with a demo URL" is a coherent rule.
   *
   * THE GUARD IS THE SAME `writeScope` PROBE THE CREATE USES, for the same reasons in the same order,
   * so a read-only role is refused locally with no hop and a Team brownout is a 503 rather than a
   * guess. It does NOT re-derive `workshopId`: that is server-owned and already stored, and rewriting
   * it here would hand a participant the scope-selection this route exists to deny them.
   *
   * ⚠ ONLY THE TEAM-OWNED FIELDS ARE WRITABLE, and the list lives in `SubmissionPatch` rather than
   * being spelled out here — `status`, `snapshot`, `releasedBy*`, `createdBy*` and `workshopId` are
   * not in it, so no request shape can reach them. Unknown keys are IGNORED rather than refused: a
   * client sending a field this version does not know is not an error worth failing a save over.
   */
  evaluation.patch("/teams/:teamId/submissions/:id", async (c) => {
    const teamId = c.req.param("teamId");
    const submissionId = c.req.param("id");

    /**
     * Executive + member, same as create — see requireSubmissionDraftWrite. The executive fills in the
     * deliverable URLs, which is what makes release precondition P4 satisfiable at all.
     *
     * The guard returns the team's scope on success; this route has no use for it (the workshop is
     * already on the row being patched), so only the refusal arm is read.
     */
    const denied = await requireSubmissionDraftWrite(c, deps.teamAccess, teamId);
    if (denied instanceof Response) return denied;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Body must be valid JSON.", code: "INVALID_BODY" }, 400);
    }

    /**
     * Only the known editable fields are carried through, and an explicit `null` is kept (it is how a
     * team CLEARS a URL) while `undefined`/absent is skipped (it means "leave this alone").
     */
    const fields: SubmissionPatch = {};
    for (const field of EDITABLE_SUBMISSION_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];

      // The three checks, shared with the CREATE route — see `rejectSubmissionField`.
      const bad = rejectSubmissionField(field, value);
      if (bad) return c.json(bad, 400);

      fields[field] = value as string | null;
    }

    /**
     * ── ⚠ A DEMO LINK CANNOT BE RECORDED BEFORE THE TEAM HAS UPLOADED ANYTHING ──────────────────
     *
     * THE RULE: a demo URL may be recorded only once the team's build files have been uploaded.
     *
     * Release already refuses on both counts — P3 `NO_ARTIFACTS` and P4 `NO_DEMO_URL` — but only at the
     * end, when the executive presses Release. This moves the ORDERING forward: the demo link is the
     * claim "there is something to look at", and a team asserting that before producing a single file has
     * the order of work backwards. Finding out at release is finding out too late.
     *
     * ⚠ ONLY WHEN THE PATCH IS *SETTING* A DEMO URL. Clearing it (`null`, or an empty string) stays
     * allowed unconditionally — a team that uploaded nothing must still be able to remove a value typed
     * by mistake, and gating the clear would trap them with a wrong link they cannot delete.
     *
     * ⚠ AND ONLY THEN IS THE HOP PAID. Editing a title, a summary or the repo link touches no other
     * service; the docs read happens on the one field that needs it.
     */
    const settingDemoUrl = typeof fields.demoUrl === "string" && fields.demoUrl.trim() !== "";
    if (settingDemoUrl) {
      const artifacts = await deps.docs.listByTeam(teamId, c);

      /**
       * ⚠ "COULD NOT DETERMINE" IS NEVER REPORTED AS "YOU HAVE NO FILES". The release ladder
       * states this rule for the identical read — "one is temporary and one tells an executive their team
       * did not upload anything" — and it matters more here, because this refusal is what a person sees
       * while typing. A docs brownout must not accuse them of having done no work.
       *
       * A DISTINCT CODE from the release path's `SNAPSHOT_SOURCE_UNAVAILABLE`: nothing is being
       * snapshotted, and a code that names the wrong mechanism sends a reader to the wrong runbook.
       */
      if (artifacts === "unavailable") {
        console.warn("[submissions] docs unavailable while setting a demo URL — refusing, not guessing", {
          teamId,
          submissionId,
        });
        c.header("Retry-After", "2");
        return c.json(
          {
            error:
              "We couldn't check this team's files just now, so the demo link wasn't saved. This is a temporary problem — try again shortly.",
            code: "ARTIFACTS_UNAVAILABLE",
          },
          503
        );
      }

      /**
       * ⚠ A DISTINCT CODE FROM RELEASE'S `NO_ARTIFACTS`, deliberately. Same underlying fact, different
       * rule and different remedy: release says "this cannot go to judges yet", this says "this FIELD
       * cannot be filled yet". One code per meaning, so a client cannot show the wrong sentence — and
       * `409`, not release's `403`, because it is a conflict with the team's current state rather than a
       * question of who is asking.
       */
      if (artifacts.length === 0) {
        return c.json(
          {
            error:
              "Upload at least one file from the desktop app before adding a demo link — the demo link says there is something to look at.",
            code: "ARTIFACTS_REQUIRED",
          },
          409
        );
      }
    }

    const result = await deps.submissions.patch(teamId, submissionId, fields);

    if (result.outcome === "not-found") return c.json({ error: "Not found" }, 404);
    /**
     * ⚠ 409, AND DISTINGUISHABLE FROM A 404. A released submission is not missing — it is frozen, and
     * the team's route back is an owner reopen. Telling them "not found" would send them to create a
     * second submission, which the store would then refuse.
     */
    if (result.outcome === "not-draft") {
      return c.json(
        {
          error: "This submission has been released and can no longer be edited.",
          code: "ALREADY_RELEASED",
        },
        409
      );
    }

    return c.json({ submission: result.submission });
  });

  /**
   * ── RELEASE: THE EXECUTIVE HANDS THE TEAM'S WORK OVER TO BE JUDGED ─────────────────────
   *
   * The design covers the grant, its preconditions, and what a judge then reads.
   *
   * ⚠ EVERY PRECONDITION IS CHECKED AGAINST THE STORE, NEVER AGAINST THE CLIENT'S ASSERTION. The
   * portal will disable its Release button when it can see a precondition failing; that is a
   * courtesy, and this is the rule. A client can simply not honour a disabled button.
   *
   * THE LADDER, in this order, and the order is the design:
   *
   *   P1  caller is EXECUTIVE            403 EXECUTIVE_ONLY   ← LOCAL, first, NO HOP
   *   P2  caller is a member             403 NOT_A_TEAM_MEMBER
   *   P5  the submission exists + DRAFT  404 / 409 ALREADY_RELEASED
   *   P6  the two content hops answered  503 + Retry-After
   *   P3  at least one artifact          403 NO_ARTIFACTS  
   *   P4  demoUrl present and https:     403 NO_DEMO_URL   
   *
   * ⚠ P1 BEFORE EVERYTHING SO A REFUSED PARTICIPANT COSTS NO EAST-WEST HOP — and so the
   * difference between 403, 404 and 409 cannot be used to probe which teams have submissions.
   *
   * ⚠ P5 BEFORE THE HOPS, so releasing twice is a cheap 409 rather than two calls and then a 409.
   *
   * ⚠ P3/P4 AFTER THE HOPS BUT THE HOP FAILURE WINS. "Could not determine" must never be reported as
   * "you have no artifacts": one is temporary and one tells an executive their team did
   * not upload anything. And the submission STAYS DRAFT on a 503 — it is never released on an
   * unanswered precondition.
   */
  evaluation.post("/teams/:teamId/submissions/:id/release", async (c) => {
    const teamId = c.req.param("teamId");
    const submissionId = c.req.param("id");
    const { id: callerId } = requireIdentity(c);

    // P1 + P2. Local role check inside, before its own membership hop.
    const denied = await requireSubmissionRelease(c, deps.teamAccess, teamId);
    if (denied) return denied;

    // P5 — on the row itself, which is also where `workshopId` for the phases hop comes from.
    const submission = await deps.submissions.get(teamId, submissionId);
    if (!submission) return c.json({ error: "Not found" }, 404);
    if (submission.status !== "DRAFT") {
      return c.json(
        {
          error: "This submission has already been released.",
          code: "ALREADY_RELEASED",
          releasedAt: submission.releasedAt,
        },
        409
      );
    }

    /**
     * ⚠ A NULL `workshopId` CANNOT BE RELEASED. The phases hop needs it, and a released submission
     * with no workshop is unjudgeable anyway — the scoring guard refuses a null scope with
     * `SUBMISSION_SCOPE_UNKNOWN` and cannot do otherwise. Pre-P0-3 rows can carry null here.
     */
    if (!submission.workshopId) {
      console.error("[release] submission has no workshop — cannot pin or judge it", {
        teamId,
        submissionId,
      });
      return c.json(
        {
          error:
            "This submission is not linked to an experience and cannot be released. Please contact an administrator.",
          code: "SUBMISSION_SCOPE_UNKNOWN",
        },
        409
      );
    }

    /**
     * P6 — BOTH HOPS, CONCURRENTLY. They are independent reads of two different contexts, so serial
     * calls would add a round trip to every release for no benefit. `Promise.all` and not
     * `allSettled`: each client already converts its own failure into `"unavailable"`, so there is no
     * rejection to settle.
     */
    const [artifacts, phases] = await Promise.all([
      deps.docs.listByTeam(teamId, c),
      deps.phases.listByTeam(teamId, submission.workshopId, c),
    ]);

    if (artifacts === "unavailable" || phases === "unavailable") {
      console.warn("[release] a content hop went unanswered — refusing to release", {
        teamId,
        submissionId,
        docs: artifacts === "unavailable" ? "unavailable" : "ok",
        phases: phases === "unavailable" ? "unavailable" : "ok",
      });
      c.header("Retry-After", "2");
      return c.json(
        {
          error:
            "We couldn't check this team's work just now, so nothing was released. This is a temporary problem — please try again.",
          code: "SNAPSHOT_SOURCE_UNAVAILABLE",
        },
        503
      );
    }

    // P3 — this is deliberately "at least one FILE", not "build-phase files". Documents
    // carry no phase attribution, so a build-phase check is not expressible today and the copy must
    // not claim one.
    if (artifacts.length === 0) {
      return c.json(
        {
          error:
            "This team hasn't uploaded any files yet. Ask them to sync at least one file from the desktop app before you release.",
          code: "NO_ARTIFACTS",
        },
        403
      );
    }

    // P4 — and the two refusals are DISTINGUISHABLE in body and code.
    if (!isReleasableDemoUrl(submission.demoUrl)) {
      return c.json(
        {
          error:
            "This submission needs a demo link starting with https:// before it can be released.",
          code: "NO_DEMO_URL",
        },
        403
      );
    }

    /**
     * ── ⚠ P4b: THE OTHER THREE LINKS, FOR ROWS WRITTEN BEFORE THE CREATE ROUTE WAS VALIDATED ──────
     *
     * Added alongside the create-route validation. Both WRITERS now reject a non-`https:`
     * link, so no NEW row can carry one — but rows created before that fix can, and this is the gate
     * they must pass to reach a judge. `demoUrl` has been checked here from the start; the other three
     * were checked nowhere at all.
     *
     * ⚠ REFUSED, NOT SANITISED, and the field is NAMED. Silently dropping a bad link would hide a
     * defect in the team's own submission from the team; a 403 that says which box is wrong is
     * actionable, and the PATCH route (which validates) is the way to fix it. Empty/absent is fine —
     * these three are optional, unlike `demoUrl`.
     *
     * A DISTINCT CODE from NO_DEMO_URL: this is a different remedy (fix a link you have, rather than
     * add one you lack), and the two refusals must stay distinguishable in the body — the same rule
     * that keeps NO_ARTIFACTS and NO_DEMO_URL apart.
     */
    for (const field of ["videoUrl", "repoUrl", "slidesUrl"] as const) {
      const value = submission[field];
      if (typeof value === "string" && value.trim() !== "" && !isHttpsUrl(value)) {
        return c.json(
          {
            error: `This submission's ${field} is not a valid https:// link. Please correct or clear it before releasing.`,
            code: "LINK_INVALID",
            field,
          },
          403
        );
      }
    }

    const now = new Date().toISOString();

    /**
     * ⚠ BEST-EFFORT, AND THE ONLY BEST-EFFORT READ IN THIS ROUTE. A judge cannot resolve a team's name
     * themselves — Team's teams route filters to the caller's own teams and a judge has none — so the
     * name has to be captured here, by an executive who IS a member, and pinned.
     *
     * A failure yields `null` and the release PROCEEDS, unlike the two hops above. That asymmetry is
     * deliberate: artifacts and phases ARE the submission, so their absence blocks; a display name is
     * metadata, and refusing a deadline release because a name lookup was slow would be the worse
     * failure. A reader falls back to the team id.
     */
    const teamName = await deps.teams.nameOf(teamId, submission.workshopId, c);
    if (teamName === null) {
      console.warn("[release] team name unavailable — pinning null, judges will see the id", {
        teamId,
        submissionId,
      });
    }

    /**
     * ⚠ THE SNAPSHOT IS WHAT JUDGES READ, SO IT IS WRITTEN FROM THE VALUES JUST FETCHED.
     *
     * Phase notes are COPIED inline — small text, and a later team edit must not change what a judge
     * sees. Artifacts are POINTERS at their CURRENT `versionId`: the bodies stay in S3, which is
     * already versioned, so the pinned version is immutable without duplicating every team's files
     * into this table.
     *
     * `put` rather than `patch`: this write owns `status`, `snapshot` and the audit fields — none of
     * which `patch` will touch, deliberately (they are absent from `SubmissionPatch`). It is safe
     * against a concurrent team edit because P5 already established DRAFT and the team's own writes
     * go through `patch`, which refuses a non-DRAFT row inside the write.
     */
    const released = await deps.submissions.put({
      ...submission,
      status: "SUBMITTED",
      releasedById: callerId,
      releasedAt: now,
      // Kept equal to `releasedAt` for API compatibility — see the note on the field in domain.ts.
      submittedAt: now,
      updatedAt: now,
      snapshot: {
        takenAt: now,
        teamName,
        phases,
        artifacts,
      },
    });

    await deps.events.publish({
      source: "evaluation-service",
      type: "submission.submitted",
      detail: {
        teamId,
        submissionId,
        workshopId: submission.workshopId,
        releasedById: callerId,
        releasedAt: now,
      },
    });

    return c.json({ submission: released });
  });

  /**
   * One submission — `(team read) OR (scoring role AND entitled)`.
   *
   * WIDENED, and this is the half that makes the write scoping usable. `requireTeamRead`
   * refuses a JUDGE on every team (they are never members), so a judge could POST a score
   * to a submission they could not READ. The read-widening rule requires both submission reads to widen to
   * the judging branch, or "scoping the write produces judges who can score but not read".
   *
   * NARROWED AT THE SAME TIME, for judges specifically: the branch requires entitlement to
   * THIS submission's workshop, so a judge reads exactly what they may score and nothing
   * else. Before this change the answer for a foreign judge was 403 (fail-closed but
   * useless); it is now 200 for their own workshop and still 403 for anyone else's.
   *
   * Nothing changes for a caller the Team context already admits — see requireSubmissionRead
   * for why the team predicate is asked first.
   */
  evaluation.get("/submissions/:submissionId", async (c) => {
    const submissionId = c.req.param("submissionId");
    const submission = await deps.submissions.getById(submissionId);
    if (!submission) return c.json({ error: "Not found" }, 404);

    // Authorize against the submission's OWN team and its OWN workshop, both resolved
    // from the stored record — never from the request. A submission id is guessable and
    // shareable, so the record is the only sound basis for either.
    const denied = await requireSubmissionRead(
      c,
      deps.teamAccess,
      deps.entitlements,
      submission
    );
    if (denied) return denied;

    return c.json({ submission });
  });

  /**
   * ── REOPEN: THE OWNER'S, NEVER THE EXECUTIVE'S ─────────────────
   *
   * ⚠ THE ASYMMETRY WITH RELEASE IS THE DESIGN, NOT AN OVERSIGHT. Release is the team's act through
   * its executive. Reopening AFTER judges may have read — and possibly scored — is an
   * experience-integrity decision, so it belongs to whoever is accountable for the experience and not
   * to a party to the submission. An EXECUTIVE is refused here even though they released it.
   *
   * ⚠ THE SNAPSHOT IS RETAINED. It is what already-cast scores were cast against, and deleting
   * it would make those scores unexplainable. The next release REPLACES it; nothing else touches it.
   */
  evaluation.post("/teams/:teamId/submissions/:id/reopen", async (c) => {
    const teamId = c.req.param("teamId");
    const submissionId = c.req.param("id");
    const { id: callerId, role } = requireIdentity(c);

    // LOCAL FIRST: an EXECUTIVE or PARTICIPANT is refused with no store read and no hop.
    if (role !== "ADMIN" && !isStaffRole(role)) {
      return c.json(
        {
          error:
            "Reopening a released submission is the experience owner's decision. Ask an administrator or the facilitator running this experience.",
          code: "OWNER_ONLY",
        },
        403
      );
    }

    const submission = await deps.submissions.get(teamId, submissionId);
    if (!submission) return c.json({ error: "Not found" }, 404);

    // Ownership is checked against the submission's OWN workshop, never a caller-named one.
    const owner = await requireExperienceOwner(c, deps.workshops, submission.workshopId, callerId);
    if (owner.denied) return owner.denied;

    if (submission.status !== "SUBMITTED") {
      return c.json(
        { error: "This submission is already a draft.", code: "NOT_RELEASED" },
        409
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // A reason is required below; an unparseable body simply has none.
    }

    /**
     * ⚠ A REASON IS MANDATORY. This is an audited reversal of somebody else's decision, and "why" is
     * the only part a future reader cannot reconstruct from the other fields.
     */
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason === "") {
      return c.json(
        { error: "A reason is required to reopen a submission.", code: "REASON_REQUIRED" },
        400
      );
    }
    if (reason.length > MAX_SCORE_COMMENT_CHARS) {
      return c.json(
        {
          error: `The reason must be ${MAX_SCORE_COMMENT_CHARS} characters or fewer.`,
          code: "REASON_TOO_LONG",
        },
        400
      );
    }

    const now = new Date().toISOString();
    const reopened = await deps.submissions.put({
      ...submission,
      status: "DRAFT",
      reopenedById: callerId,
      reopenedAt: now,
      reopenReason: reason,
      updatedAt: now,
      /**
       * ⚠ `releasedAt`/`releasedById` AND THE SNAPSHOT ALL SURVIVE. They record what happened and what
       * was judged. `releasedAt` surviving also keeps this row in the `byWorkshop` sparse index — which
       * is precisely why the judging list filters on `status` rather than trusting the index.
       */
    });

    /**
     * ── ⚠ REOPENING WITHDRAWS THE PUBLISHED RANKING ────────────────────────────────────────────
     *
     * Scoring is refused once results are published, so without this a post-publication reopen would be
     * inert: the owner could return a submission to DRAFT and no judge could ever score it again.
     *
     * ⚠ AND THE RANKING WOULD BE WRONG IF IT SURVIVED. The places are STORED, not recomputed — so a
     * ranking left standing after its inputs are reopened states an outcome the scores behind it no
     * longer support. Retracting it is the honest option; the owner publishes again once judging is done.
     *
     * ⚠ THIS RETRACTS A RESULT TEAMS MAY ALREADY HAVE BEEN TOLD. That is a real cost and it is the
     * chosen one — the alternative is a published ranking that quietly disagrees with its own scores.
     *
     * ⚠ THE RELEASED SNAPSHOT IS UNTOUCHED. It is what already-cast scores were cast against.
     * Only the ranking goes.
     *
     * AFTER the submission write and BEFORE the event, so an observer that reacts to
     * `submission.reopened` cannot read a ranking this reopen has already invalidated. Idempotent, so a
     * reopen on an unpublished experience is a no-op.
     */
    if (submission.workshopId) {
      await deps.results.clear(submission.workshopId);
    }

    await deps.events.publish({
      source: "evaluation-service",
      type: "submission.reopened",
      detail: { teamId, submissionId, reopenedById: callerId, reason },
    });

    return c.json({ submission: reopened });
  });

  /**
   * ── ⚠ HOW IS THE EXPERIENCE GOING? COUNTS PER TEAM, FOR THE OWNER AND FOR ADMINS ────────
   *
   * The question a facilitator standing in
   * a live room cannot answer by looking: WHICH TEAM HAS GONE QUIET. Everyone looks busy.
   *
   * ── ⚠ COUNTS AND TIMESTAMPS. NEVER CONTENT. NEVER PER PERSON. ──
   *
   * Team content is member-only, and a facilitator is NOT a member of the teams they run.
   * That is why this route exists at all rather than the portal calling the per-team routes: those are
   * `requireTeamContentRead` and would refuse a facilitator, correctly. So this returns AGGREGATES the
   * owner is entitled to — how much happened, and when it last happened — and nothing that would
   * disclose what was said, written or built.
   *
   * ⚠ AND IT AGGREGATES AWAY THE PERSON, DELIBERATELY. `MemberActivity` is keyed
   * `(teamId, userId)`, so a per-person breakdown is one `map` away — and it is not offered. This
   * platform measures capability, not surveillance; the four
   * no-leaderboard precedents in this codebase say the same thing about ranking people. A facilitator
   * gets "this team has gone quiet", which is actionable, and not "this person contributed least",
   * which is a judgement the executive's assessment surface owns.
   *
   * ⚠ THIS SERVICE READS ONLY ITS OWN TABLE. The activity read-model is evaluation's
   * (`ActivityReadModel`), fed by domain events. The only thing it asks another context for is the
   * team LIST, through Team's own API, as the caller — so no bounded context is reached into.
   *
   * ⚠ `aiTurns` IS NULLABLE AND NULL IS NOT ZERO. Rows written before v0.3.2 have no value, and a
   * team with no rows at all has nothing rather than nothing-happened. Reported as `null` so a reader
   * renders "not measured" — the same rule `MemberContribution.aiTurns` already imposes.
   */
  evaluation.get("/workshops/:workshopId/activity", async (c) => {
    const workshopId = c.req.param("workshopId");
    const { id: callerId } = requireIdentity(c);

    // ⚠ NO ROLE IS READ HERE. This said "ADMIN short-circuits inside; a FACILITATOR must actually own
    // this experience" — the short-circuit is gone, so an ADMIN must own this experience on
    // exactly the same terms as a facilitator, and the guard needs nothing but the caller's id.
    const owner = await requireExperienceOwner(c, deps.workshops, workshopId, callerId);
    if (owner.denied) return owner.denied;

    const teams = await deps.teams.teamsOf(workshopId, c);
    if (teams === "unavailable") {
      c.header("Retry-After", "2");
      return c.json(
        {
          error: "We couldn't read this experience's teams just now. Please try again.",
          code: "TEAMS_UNAVAILABLE",
        },
        503
      );
    }

    const { submissions: released } = await deps.submissions.listReleasedByWorkshop(workshopId);
    const releasedByTeam = new Map(released.map((s) => [s.teamId, s]));

    /**
     * One activity read per team, concurrently — bounded by the team list, which Team caps at 50.
     * This runs on an owner's explicit page load, never on a participant's, so N reads is acceptable
     * where it would not be on a hot path.
     */
    const rows = await Promise.all(
      teams.map(async (team) => {
        const activity = await deps.activity.listByTeam(team.id);

        const sum = (pick: (a: MemberActivity) => number) =>
          activity.reduce((total, a) => total + pick(a), 0);

        /**
         * ⚠ SUMMED ONLY OVER ROWS THAT HAVE A VALUE, and reported as null when none do. Treating an
         * absent `aiTurns` as 0 would state "this team used no assistant" about a period nobody was
         * measuring — see the field's own note.
         */
        const measured = activity.filter((a) => typeof a.aiTurns === "number");
        const aiTurns = measured.length > 0 ? sum((a) => a.aiTurns ?? 0) : null;

        /**
         * The most recent activity anywhere in the team. ⚠ `updatedAt` is the ONLY time signal the
         * read-model has — it is cumulative, not bucketed — so this answers "when did anything last
         * happen" and cannot answer "how much happened this morning". A reader must not present it as
         * a trend. A real series would need per-interval activity counts, which the read-model
         * does not store.
         */
        const lastActivityAt =
          activity.length > 0
            ? activity.map((a) => a.updatedAt).sort().slice(-1)[0]
            : null;

        const submission = releasedByTeam.get(team.id) ?? null;

        return {
          teamId: team.id,
          teamName: team.name,
          memberCount: team.memberCount,
          /** How many members have ANY recorded activity — not who. */
          membersWithActivity: activity.length,
          tasksCreated: sum((a) => a.tasksCreated),
          tasksCompleted: sum((a) => a.tasksCompleted),
          messagesSent: sum((a) => a.messagesSent),
          commitsPushed: sum((a) => a.commitsPushed),
          aiThreadsShared: sum((a) => a.aiThreadsShared),
          aiTurns,
          aiTurnsMeasuredFor: measured.length,
          lastActivityAt,
          released: submission !== null,
          releasedAt: submission?.releasedAt ?? null,
        };
      })
    );

    return c.json({
      workshopId,
      teams: rows,
      /**
       * ⚠ COVERAGE TRAVELS WITH THE FIGURES. `TokenUsagePanel`'s rule: "over 14 of 22 replies is the
       * difference between a total and a floor, and the reader cannot infer it." A reader must be able
       * to see that these totals cover N teams, not that they are the whole experience.
       */
      teamCount: rows.length,
      releasedCount: rows.filter((r) => r.released).length,
    });
  });

  // ---- Places: computed here, PUBLISHED by the owner ------------

  /**
   * The published ranking — readable by anyone entitled to the experience.
   *
   * ⚠ 404 UNTIL PUBLISHED, FOR EVERYONE INCLUDING THE OWNER. "Never render a partial ranking"
   * is the discipline here: with five judges and two having scored, an order is a confident,
   * wrong, public statement about named teams. The owner's preview is a SEPARATE route below, and it
   * is labelled unpublished — so no caller can mistake one for the other.
   */
  evaluation.get("/workshops/:workshopId/results", async (c) => {
    const workshopId = c.req.param("workshopId");
    const { id: callerId, role } = requireIdentity(c);

    const reader = await requireExperienceReader(c, deps, workshopId, callerId, role);
    if (reader) return reader;

    const results = await deps.results.get(workshopId);
    if (!results) {
      return c.json(
        { error: "Results have not been published for this experience.", code: "NOT_PUBLISHED" },
        404
      );
    }

    return c.json({ results });
  });

  /**
   * The OWNER'S PREVIEW — the computed ranking before anybody has declared it.
   *
   * ⚠ A SEPARATE ROUTE FROM THE PUBLISHED READ, AND LABELLED. The results route serves no partial ranking
   * "to anyone, including the owner". This is where the owner sees
   * what publishing WOULD produce, plus the refusal that is currently blocking it — coverage,
   * unevenness, stale scores or an unbroken tie — so the Publish control can explain itself instead of
   * just being disabled.
   *
   * `published: false` is in the payload, not only in the URL, because a response that gets logged,
   * pasted or cached must carry its own status.
   */
  evaluation.get("/workshops/:workshopId/results/preview", async (c) => {
    const workshopId = c.req.param("workshopId");
    const { id: callerId } = requireIdentity(c);

    const owner = await requireExperienceOwner(c, deps.workshops, workshopId, callerId);
    if (owner.denied) return owner.denied;

    const outcome = await rankExperience(deps, workshopId);
    if (outcome === "unavailable") {
      c.header("Retry-After", "2");
      return c.json({ error: "Scores could not be read just now.", code: "SCORES_UNAVAILABLE" }, 503);
    }

    return c.json({ published: false, ...outcome });
  });

  /**
   * PUBLISH — the owner declares the result, and the experience becomes `COMPLETED`.
   *
   * ⚠ `ADMIN`/`FACILITATOR` WHO OWNS THE EXPERIENCE, NEVER A JUDGE. A judge scores; the owner
   * declares. That separation is the whole reason publication is a distinct act rather than a
   * consequence of the last score arriving.
   */
  evaluation.post("/workshops/:workshopId/results/publish", async (c) => {
    const workshopId = c.req.param("workshopId");
    const { id: callerId, role } = requireIdentity(c);

    // LOCAL FIRST — a JUDGE is refused before any read.
    if (role !== "ADMIN" && !isStaffRole(role)) {
      return c.json(
        {
          error: "Publishing results is the experience owner's decision, not a judge's.",
          code: "OWNER_ONLY",
        },
        403
      );
    }

    const owner = await requireExperienceOwner(c, deps.workshops, workshopId, callerId);
    if (owner.denied) return owner.denied;

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // No body is normal — a tie ordering is only needed when there is a tie.
    }
    const tieOrder = Array.isArray(body.tieOrder)
      ? body.tieOrder.filter((v): v is string => typeof v === "string")
      : undefined;

    const outcome = await rankExperience(deps, workshopId, tieOrder);
    if (outcome === "unavailable") {
      c.header("Retry-After", "2");
      return c.json({ error: "Scores could not be read just now.", code: "SCORES_UNAVAILABLE" }, 503);
    }

    /**
     * ⚠ EVERY REFUSAL IS A 409 WITH ITS OWN CODE AND ITS OWN EVIDENCE. The owner is being told why a
     * ranking cannot be declared, and "quorum not met" versus "coverage uneven" versus "a tie needs
     * your decision" send them to three different actions.
     */
    if (outcome.outcome !== "ok") {
      const codes = {
        "nothing-released": "RESULTS_NOTHING_RELEASED",
        "stale-scores": "RESULTS_STALE_SCORES",
        "quorum-not-met": "RESULTS_QUORUM_NOT_MET",
        "coverage-uneven": "RESULTS_COVERAGE_UNEVEN",
        "tie-unresolved": "RESULTS_TIE_UNRESOLVED",
      } as const;
      return c.json({ code: codes[outcome.outcome], ...outcome }, 409);
    }

    const now = new Date().toISOString();
    const created = await deps.results.create({
      workshopId,
      publishedById: callerId,
      publishedAt: now,
      minScoresPerSubmission: MIN_SCORES_PER_SUBMISSION,
      places: outcome.places,
      // Recorded ONLY when a human actually broke a tie — see the ordering note in places.ts.
      tieBrokenById: outcome.tieBroken ? callerId : null,
      tieBrokenAt: outcome.tieBroken ? now : null,
    });

    /**
     * ⚠ A SECOND PUBLISH IS THE STORE'S ANSWER, NOT A PRECEDING READ. Two owners pressing Publish in
     * the same second would both read "not published" and both write, and the stored ranking would be
     * whichever landed second — a declared result changing under the people who declared it.
     */
    if (created === "already-published") {
      const existing = await deps.results.get(workshopId);
      return c.json(
        {
          error: "Results have already been published for this experience.",
          code: "ALREADY_PUBLISHED",
          ...(existing ? { results: existing } : {}),
        },
        409
      );
    }

    await deps.events.publish({
      source: "evaluation-service",
      type: "workshop.results-published",
      detail: { workshopId, publishedById: callerId, publishedAt: now, places: outcome.places.length },
    });

    /**
     * ── ⚠ THE EXPERIENCE TRANSITION IS LAST, AND A FAILURE IS REPORTED RATHER THAN FATAL ──
     *
     * The results row is the authoritative fact and it is already written. If Workshop cannot be
     * reached, throwing here would turn a SUCCEEDED publication into a 500 and invite the owner to
     * publish again — which the store would then refuse with `ALREADY_PUBLISHED`, leaving them
     * convinced nothing happened.
     *
     * So the response says what is true: the results are published, and whether the experience moved.
     * `experienceCompleted: false` is a visible, fixable inconsistency; a 500 over a published result
     * is not.
     */
    const completed = await deps.workshops.setStatus(workshopId, "COMPLETED", c);
    if (!completed) {
      console.error("[results] published, but the experience did not move to COMPLETED", {
        workshopId,
        publishedById: callerId,
      });
    }

    return c.json({ results: await deps.results.get(workshopId), experienceCompleted: completed });
  });

  // ---- What a judge may read ---------------------
  //
  // ⚠ THE READ BOUNDARY IS THE SUBMISSION, AND ONLY THIS SERVICE MOVES. A judge never calls `docs`
  // or `workshop`; both still refuse them, unchanged. The three bounds the pinning design calls
  // load-bearing are enforced in these three routes and nowhere else:
  //
  //   1. RELEASED TEAMS ONLY   — `listReleasedByWorkshop`, and a draft is ABSENT rather than 403
  //   2. ENTITLED JUDGES ONLY  — `requireScoringScope`, never role alone
  //   3. THE PINNED VERSIONS ONLY — the snapshot manifest is the authorization surface for bodies
  //
  // ⚠ AND THE EXCEPTION'S BOUNDARY IS EVERYTHING NOT HERE. Team chat, the board, AI threads and
  // per-member assessments stay member-only and executive-only. A release discloses the team's WORK,
  // not its WORKING — so no route here reads any of them, and routes.test.ts asserts that a judge who can
  // read a released submission still gets nothing from those surfaces.

  /**
   * The released submissions of one experience — a judging panel's worklist.
   *
   * ⚠ ENTITLEMENT, NOT ROLE (bound 2). `requireScoringScope` is the SAME predicate the scoring write
   * uses, so a judge lists exactly what they may score. It short-circuits for ADMIN, refuses a
   * foreign workshop with `WORKSHOP_NOT_ENTITLED` and answers 503 rather than 403 when the
   * entitlement source is unreachable.
   *
   * ⚠ THE OWNER BRANCH IS SEPARATE AND IS CHECKED FIRST-BUT-CHEAPLY. The rule allows "or owner", and
   * the entitlement probe cannot serve it: `GET /entitlements/workshops` is built from INVITATIONS and
   * MEMBERSHIPS, so a facilitator who owns an experience with neither is entitled to nothing by it.
   * The workshop read is attempted only for a STAFF role, so a judge's request costs one hop, not two.
   *
   * ⚠ A DRAFT TEAM IS ABSENT, NOT REFUSED. A judge has no business learning that a team exists
   * and has not submitted — that is the team's own state, and a 403 would disclose it.
   */
  evaluation.get("/workshops/:workshopId/submissions", async (c) => {
    const workshopId = c.req.param("workshopId");
    const { id: callerId, role } = requireIdentity(c);

    /**
     * The owner/staff branch. Attempted BEFORE the entitlement guard so a facilitator who owns the
     * experience is not refused by a probe that structurally cannot know about them — and gated on
     * `isStaffRole` so this costs a judge nothing.
     */
    // ⚠ `role === "ADMIN" ||` REMOVED FROM BOTH LINES BELOW. On this line it was
    // redundant — `isStaffRole` is {FACILITATOR, ADMIN} — but on the `allowed` assignment it was a
    // real grant: every admin got every released submission in every experience. See
    // `decideSubmissionScope`, which had to lose its own ADMIN short-circuit in the same change or
    // this one would have been inert.
    let allowed = false;
    if (isStaffRole(role)) {
      const workshop = await deps.workshops.get(workshopId, c);
      if (workshop === "unavailable") {
        c.header("Retry-After", "2");
        return c.json(
          {
            error: "We couldn't check this experience just now. Please try again.",
            code: "WORKSHOP_UNAVAILABLE",
          },
          503
        );
      }
      if (workshop === null) return c.json({ error: "Not found" }, 404);
      allowed = workshop.ownerId === callerId;
    }

    if (!allowed) {
      /**
       * ── ⚠ THE ROLE HALF OF THE JUDGING GATE ─────────────────────────────────────────────
       *
       * This branch was `requireScoringScope` ALONE, and that was the whole defect. Scope and role
       * are deliberately two functions — `decideSubmissionScope` has no role branch and says so,
       * because "the role half lives in requireScoringRole" — and on THIS route the role half was
       * never called. `requireScoringRole` was imported and used only by the score write.
       *
       * ⚠ ENTITLEMENT IS NOT A JUDGING CREDENTIAL, which is why scope alone cannot stand here.
       * Team's `GET /entitlements/workshops` unions invitation workshopIds with **every workshop
       * reached through team membership**, so any PARTICIPANT or EXECUTIVE on any team in workshop W
       * is entitled to W. Gated on entitlement alone, they received a 200 listing EVERY team's
       * released submission — submissionId, teamId, teamName, title, releasedAt and demoUrl —
       * i.e. competing teams' demo links, before results were published.
       *
       * The sibling id-addressed read had this right all along (`requireSubmissionRead` refuses a
       * non-scoring role BEFORE the entitlement branch, authz.ts), so the list was the permissive
       * one of two paths that must agree.
       *
       * ORDER: role first, because it is LOCAL. A refused participant costs no store read and no
       * east-west hop, and cannot use the difference between refusals to probe which workshops
       * exist — the same argument `requireScoringRole` documents for the score write.
       */
      const wrongRole = requireScoringRole(c);
      if (wrongRole) {
        /**
         * ⚠ STAFF KEEP THE REFUSAL THEY ALREADY HAD, and this is a contract choice rather than a
         * softer rule. A FACILITATOR/ADMIN reaching this line already failed the ownership check
         * above, so they have no judging access either way — but "Judge role required" would be a
         * misleading answer to an admin (they are never going to hold JUDGE) and it would change a
         * response code the portal already distinguishes. Same 403, same body as the scope denial.
         *
         * ⚠ IT ALSO CLOSES A NARROWER CASE THE ENTITLEMENT FALL-THROUGH LEFT OPEN: a staff member
         * who happens to be a MEMBER of a team in someone else's experience is entitled to that
         * workshop by the union above, so falling through to `requireScoringScope` would have
         * admitted them to another owner's worklist. Refusing here does not depend on their
         * entitlements being empty.
         */
        if (isStaffRole(role)) {
          return c.json(
            {
              error: "Forbidden: you are not judging this workshop",
              code: "WORKSHOP_NOT_ENTITLED",
            },
            403
          );
        }
        return wrongRole;
      }

      // The judging branch — identical predicate to the scoring write.
      const outOfScope = await requireScoringScope(c, deps.entitlements, workshopId);
      if (outOfScope) return outOfScope;
    }

    const { submissions, truncated } = await deps.submissions.listReleasedByWorkshop(workshopId);

    /**
     * ⚠ THIS SHAPE IS DELIBERATELY NARROW. A judge gets what they need to pick a team and see their own
     * progress — and NOT the narrative fields, which belong on the detail read where the snapshot
     * banner ("as released on …") appears beside them.
     *
     * `myScore` is THIS judge's own row only. A judge must not see another judge's numbers from a list
     * (the deliberations are gated separately and mid-judging disclosure is the P0-4 defect), so the
     * scores are fetched per submission and reduced to one number for the caller.
     */
    const rows = await Promise.all(
      submissions.map(async (s) => {
        const scores = await deps.scores.listBySubmission(s.id);
        const mine = scores.find((score) => score.judgeId === callerId);
        return {
          submissionId: s.id,
          teamId: s.teamId,
          // The pinned name, falling back to the id — see `Snapshot.teamName`.
          teamName: s.snapshot?.teamName ?? null,
          title: s.title,
          releasedAt: s.releasedAt,
          demoUrl: s.demoUrl,
          artifactCount: s.snapshot?.artifacts.length ?? 0,
          scoredByMe: Boolean(mine),
          myScoreTotal: mine ? SCORE_CRITERIA.reduce((sum, k) => sum + mine[k], 0) : null,
          maxScore: MAX_SCORE_PER_JUDGE,
        };
      })
    );

    return c.json({ submissions: rows, ...(truncated ? { truncated: true } : {}) });
  });

  /**
   * The PINNED snapshot — phase notes and the artifact MANIFEST.
   *
   * Gated by `requireSubmissionRead`, the same predicate as the submission itself: team read OR
   * (scoring role AND entitled to this submission's workshop). So workshop scoping holds here by construction —
   * a judge entitled to workshop A gets 403 on a submission in workshop B.
   *
   * ⚠ NO BODIES HERE, ONLY POINTERS. The manifest is small and the bodies are not; a judge opens the
   * ones they want through the route below, one at a time.
   */
  evaluation.get("/submissions/:submissionId/snapshot", async (c) => {
    const submissionId = c.req.param("submissionId");

    const submission = await deps.submissions.getById(submissionId);
    if (!submission) return c.json({ error: "Not found" }, 404);

    const denied = await requireSubmissionRead(c, deps.teamAccess, deps.entitlements, submission);
    if (denied) return denied;

    /**
     * ⚠ A DRAFT HAS NO SNAPSHOT, AND THAT IS A 409 RATHER THAN AN EMPTY OBJECT. An empty snapshot
     * renders as "this team submitted nothing", which is a statement about the team; "not released
     * yet" is a statement about the submission, and it is the true one.
     */
    if (!submission.snapshot) {
      return c.json(
        { error: "This submission has not been released yet.", code: "NOT_RELEASED" },
        409
      );
    }

    return c.json({
      snapshot: submission.snapshot,
      // Echoed so a reader can render the required banner — "as released on <releasedAt>,
      // later edits are not shown" — without a second request.
      releasedAt: submission.releasedAt,
      teamId: submission.teamId,
    });
  });

  /**
   * ── ⚠ THERE IS NO ARTIFACT-BODY ROUTE, AND ITS ABSENCE IS A DECISION ────────────────────
   *
   * `GET /v1/submissions/:id/artifacts/content` existed here and was REMOVED, with the
   * matching internal route on `docs` and its `requireInternalCaller` gate.
   *
   * ── WHY IT WAS BUILT, AND WHY THAT WAS THE WRONG TRADE ──
   *
   * The requirement wanted a judge to open a file in the portal, and the earlier design said `evaluation` would reach
   * `docs` "east-west, x-internal-token (the established path)". ⚠ THERE WAS NO SUCH PATH:
   * `INTERNAL_SERVICE_TOKEN` IS SET ON NO FUNCTION, deliberately — the template records it being
   * removed because "it bought no security and was strictly worse", and the platform's real
   * internal-trust mechanism is DIRECT LAMBDA INVOCATION where `lambda:InvokeFunction` is the
   * credential (`service-shared/src/service-invoke.ts`).
   *
   * So the shipped route could only ever answer 503, and making it work meant a new
   * service-to-service dependency, a new IAM grant, and a security gate — all so a judge could read
   * source in a portal pane.
   *
   * ⚠ WHAT A JUDGE STILL HAS, AND WHY IT IS ENOUGH: the phase notes (COPIED inline into the snapshot
   * at release, so they need no hop at all), the artifact MANIFEST — path, author, timestamp, count,
   * which is what proves WHAT was submitted and WHEN — the demo link, and the repository link. Code
   * is read where code lives.
   *
   * ⚠ THE MANIFEST IS STILL THE AUTHORIZATION SURFACE if this ever returns. Its rule — a
   * `(path, versionId)` pair not in the released snapshot is refused, and refused with 403 rather
   * than 404 so the manifest cannot be probed — is the part worth keeping. It is written down here
   * rather than in a deleted file.
   */

  // ---- Scoring (JUDGE/ADMIN) ----------------------------------------------

  /**
   * Score a submission — ROLE **AND WORKSHOP SCOPE** (BACKLOG P0-3).
   *
   * ── THE LAST P0 ON THIS PLATFORM, AND WHAT IT WAS ──
   *
   * This route was gated on `requireScoringRole` alone, so ANY JUDGE SCORED ANY SUBMISSION
   * IN ANY WORKSHOP. Proven, not inferred: a judge invited to nothing, on no team, whom the
   * Team context refused everything, got **201 CREATED** against a submission in workshop
   * `w-foreign`; the Score row landed; `submission.scored` was published so downstream
   * consumers acted on it; and the injected `teamAccess` port recorded **zero** predicate
   * calls — the scoping decision consulted nothing at all.
   *
   * TWO GUARDS, IN THIS ORDER, AND THE ORDER IS THE DESIGN:
   *
   *   1. `requireScoringRole` — LOCAL, from the token. A non-judge is refused with no store
   *      read and no hop, so the 404/403/201 differences cannot be used to probe which
   *      submission ids exist or which workshop one belongs to.
   *   2. the submission is LOADED — the integrity check (below), which also produces the
   *      record the scope decision reads.
   *   3. `requireScoringScope` — ADMIN short-circuits locally; otherwise the SUBMISSION's
   *      stored `workshopId` must be present and in the caller's entitlement set.
   *
   * The scope is decided on the STORED record, never on the request: `body.workshopId` is
   * read nowhere here, and the stored value is server-derived from the team, so
   * there is no caller-supplied input anywhere in this decision.
   *
   * THREE DISTINGUISHABLE REFUSALS: `WORKSHOP_NOT_ENTITLED` (403,
   * an authorization answer), `SUBMISSION_SCOPE_UNKNOWN` (403, a DATA problem on a
   * null-scoped legacy row), `ENTITLEMENTS_UNAVAILABLE` (503, we could not find out). The
   * last is never a pass and never a 403 — see requireScoringScope.
   */
  evaluation.post("/submissions/:submissionId/scores", async (c) => {
    const denied = requireScoringRole(c);
    if (denied) return denied;

    const submissionId = c.req.param("submissionId");
    const { id } = requireIdentity(c);

    // The submission must EXIST before a score is written against it. Without this the
    // route happily persisted a Score row keyed to a submission id that was never
    // created — an orphan that no read path can ever surface (every score read starts
    // from a submission) and that quietly inflates any future aggregate. A typo in a
    // judge's URL used to "succeed" with a 201.
    //
    // It is ALSO what makes the scope check possible: the record it returns carries the
    // server-derived `workshopId` the guard below decides on. Integrity first, then scope —
    // a scope check on a submission that does not exist has nothing to decide about.
    const submission = await deps.submissions.getById(submissionId);
    if (!submission) return c.json({ error: "Not found" }, 404);

    // THE SCOPE. Resource-aware: it reads the submission's own workshop, not the caller's
    // claim about it. See requireScoringScope for the ordering and the three refusals.
    const outOfScope = await requireScoringScope(c, deps.entitlements, submission.workshopId);
    if (outOfScope) return outOfScope;

    /**
     * ── ⚠ ONLY A RELEASED SUBMISSION CAN BE SCORED ──
     *
     * Checked BEFORE the body is looked at, and the order is deliberate: an unreleased submission
     * is refused without its scores ever being inspected, so a judge cannot learn whether their
     * numbers were well-formed by probing a draft. It also reads better as a refusal — "this is not
     * released yet" is the actionable fact, and a 400 about a field would bury it.
     *
     * The state comes from the STORED record, which is already loaded above for the scope decision.
     */
    if (submission.status !== "SUBMITTED") {
      return c.json(
        {
          error: "This submission has not been released for judging yet.",
          code: "NOT_RELEASED",
        },
        409
      );
    }

    /**
     * ── ⚠ ONCE THE RANKING IS PUBLISHED, SCORING IS CLOSED ────────────────────────────────────
     *
     * The places are STORED, not recomputed on read — `WorkshopResults`' own header says why: "a ranking
     * that recomputed itself would change when a late score arrived — after the owner had declared the
     * result and teams had been told". The corollary was missing: nothing stopped the late score. A
     * judge could score after publication, the stored ranking would keep saying what it said, and the
     * scores behind it would no longer add up to it.
     *
     * ⚠ AND THIS IS WHY REOPEN CLEARS THE RANKING. Refusing here would otherwise make a post-publication
     * reopen pointless — the owner could reopen a submission and nobody could re-judge it. `reopen` now
     * calls `results.clear`, so the sequence is: publish → scoring closed → reopen → ranking withdrawn,
     * scoring open again → publish again. A published result IS retracted by a reopen; that is the
     * deliberate cost of keeping the ranking and the scores in agreement.
     *
     * Read AFTER the release check so the more specific refusal wins: "not released" is about this
     * submission, "results published" is about the whole experience.
     */
    /**
     * ⚠ THE `? :` IS THE COMPILER'S, NOT A REACHABLE BRANCH. `submission.workshopId` is
     * `string | null` on the row, but `requireScoringScope` above has already refused every null:
     * `decideSubmissionScope`'s STEP 1 returns "scope-unknown" for a non-string or empty id, before
     * the entitlement hop and for EVERY role — so the 403 `SUBMISSION_SCOPE_UNKNOWN` fires and
     * `if (outOfScope) return outOfScope` returns, well before this line.
     *
     * Written as a guard rather than a cast because a cast asserts the invariant while this one
     * HOLDS it: if that ordering ever changes, the null takes the `null` arm and the publication gate
     * simply does not find a ranking — it does not throw a 500 at a judge. Same shape as `reopen`'s
     * `if (submission.workshopId) await deps.results.clear(...)`, which is this file's convention for
     * reaching the results repository off a nullable scope.
     */
    const published = submission.workshopId
      ? await deps.results.get(submission.workshopId)
      : null;
    if (published) {
      return c.json(
        {
          error:
            "Results have been published for this experience, so scores are final. An owner must reopen the submission to judge it again.",
          code: "RESULTS_PUBLISHED",
        },
        409
      );
    }

    /**
     * ⚠ A MALFORMED BODY IS A 400, NOT A 500. `c.req.json()` THROWS on invalid JSON, and an
     * unhandled throw here is a 500 — which says "this service is broken" about a caller's typo.
     */
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Body must be valid JSON.", code: "INVALID_BODY" }, 400);
    }

    /**
     * ── ⚠ THE FIVE CRITERIA ARE VALIDATED, NOT COERCED ──
     *
     * WHAT THIS REPLACES: `innovation: Number(body.innovation) || 0`, five times over. That line
     * did three wrong things at once and each has its own acceptance criterion:
     *
     *   - `Number("abc") || 0` stored a typo as **0** — a real, meaningful score
     *   - `|| 0` meant a submitted `0` also became 0, hiding that the scale starts at 1
     *   - nothing bounded the TOP, so `innovation: 999` was stored verbatim
     *
     * A stored 0 is indistinguishable from "a judge thought this was worthless", and these numbers
     * feed the ranking that decides places — so a coerced value is not a cosmetic problem, it is a
     * wrong result nobody can see is wrong.
     *
     * ⚠ REJECTED, NOT CLAMPED. Clamping 999 to 10 would invent a judgement the judge did not make.
     * The refusal NAMES the offending fields so a form can mark them.
     *
     * The predicate is `@praimana/shared`'s, so the scoring FORM refuses exactly what this
     * refuses — see the header of `constants/scoring.ts`.
     */
    const invalid = scoreFieldErrors(body);
    if (invalid.length > 0) {
      return c.json(
        {
          error: `Each score must be a whole number from ${SCORE_MIN} to ${SCORE_MAX}.`,
          code: "SCORE_OUT_OF_RANGE",
          fields: invalid,
        },
        400
      );
    }

    /**
     * The comment is optional, but when present it must be a STRING and within the cap.
     *
     * ⚠ REFUSED RATHER THAN TRUNCATED, per the convention `constants/chat-limits.ts` states: the
     * server-side bound is the real one. Silently cutting a judge's feedback at 4,000 characters
     * loses the part they may have cared most about, and they would never know.
     */
    const comment = body.comment ?? null;
    if (comment !== null && typeof comment !== "string") {
      return c.json({ error: "Comment must be text.", code: "COMMENT_INVALID" }, 400);
    }
    if (typeof comment === "string" && comment.length > MAX_SCORE_COMMENT_CHARS) {
      return c.json(
        {
          error: `Comment must be ${MAX_SCORE_COMMENT_CHARS} characters or fewer.`,
          code: "COMMENT_TOO_LONG",
          limit: MAX_SCORE_COMMENT_CHARS,
        },
        400
      );
    }

    /**
     * ⚠ WRITTEN FROM THE VALIDATED BODY, FIELD BY FIELD FROM `SCORE_CRITERIA`, so a criterion added
     * to the shared list cannot be validated-but-not-stored (or stored unvalidated). `scoreFieldErrors`
     * has already proven every one of these is an integer in range.
     *
     * Keyed `submissionId` + `judgeId`, so re-scoring OVERWRITES this judge's row rather than adding
     * a second — unchanged behaviour, now asserted.
     */
    const criteria = Object.fromEntries(
      SCORE_CRITERIA.map((criterion) => [criterion, body[criterion] as number])
    ) as Record<(typeof SCORE_CRITERIA)[number], number>;

    /**
     * ── ⚠ A JUDGE SCORES ONCE ─────────────────────────────────────────────────────────────────
     *
     * This was `scores.put`, an unconditional write over a row keyed `(submissionId, judgeId)` — so a
     * second POST from the same judge silently REPLACED the first, and nothing recorded that a cast
     * score had changed. The portal stopped offering the form again, but a UI is not a boundary: a
     * stale tab, a double-click or a direct call still rewrote it.
     *
     * The refusal is a returned VALUE rather than a thrown error, so this reads as a 409 about state
     * instead of a fault — same contract as `results.create`.
     */
    const score: Score = {
      submissionId,
      judgeId: id,
      ...criteria,
      comment,
      createdAt: new Date().toISOString(),
    };
    const outcome = await deps.scores.create(score);
    if (outcome === "already-scored") {
      return c.json(
        {
          error:
            "You have already scored this submission, and a score is final once submitted.",
          code: "ALREADY_SCORED",
        },
        409
      );
    }

    await deps.events.publish({
      source: "evaluation-service",
      type: "submission.scored",
      detail: { submissionId, judgeId: id },
    });

    return c.json({ score }, 201);
  });

  /**
   * Every judge's scores for a submission — GATED (P0-4).
   *
   * This route had NO AUTHORIZATION AT ALL. Any signed-in user could read every judge's
   * numeric scores and free-text comments for any submission id, including mid-judging
   * — the deliberations, not just the outcome. Its sibling GET /submissions/:id above
   * IS gated on requireTeamRead; this one was simply missed.
   *
   * Gated the SAME way as that sibling, for the same reason: the submission is resolved
   * first so the team comes from the stored record rather than from the request, and
   * `requireTeamRead` then decides. A submission id is guessable and shareable, so the
   * record's own team is the only sound basis.
   *
   * ── THE JUDGE ASYMMETRY IS NOW CLOSED (BACKLOG P0-3) ──
   *
   * This comment used to record a KNOWN CONSEQUENCE: a JUDGE is not a member of the teams
   * they score, so `requireTeamRead` refused them here and a judge could POST a score
   * without being able to read the resulting list. That was the safe reading at the time —
   * widening on ROLE ALONE would have let any JUDGE read any workshop's deliberations,
   * which is the neighbouring P0-3 — and it is no longer necessary, because the entitlement
   * mechanism that was missing now exists (the live `GET /v1/entitlements/workshops`, not
   * the withdrawn Workshop-local store).
   *
   * The gate is now `(team read) OR (scoring role AND entitled to this submission's
   * workshop)`, evaluated by the SAME predicate as the write, so a judge reads exactly the
   * deliberations they are a party to. A judge from another workshop is still 403 — the
   * widening is bounded by entitlement, not by role.
   */
  evaluation.get("/submissions/:submissionId/scores", async (c) => {
    const submissionId = c.req.param("submissionId");

    const submission = await deps.submissions.getById(submissionId);
    if (!submission) return c.json({ error: "Not found" }, 404);

    // Authorize against the submission's OWN team and OWN workshop, both from the record.
    const denied = await requireSubmissionRead(
      c,
      deps.teamAccess,
      deps.entitlements,
      submission
    );
    if (denied) return denied;

    /**
     * ── ⚠ WHO MAY SEE WHOSE NUMBERS — THIS ROUTE USED TO HAND EVERY JUDGE'S SCORES TO EVERYONE ──
     *
     * `requireSubmissionRead` above admits `teamAccess.canRead(submission.teamId)` OR a scoring role
     * entitled to the workshop. It then returned `listBySubmission` — ALL judges' numbers AND comments —
     * to every one of them. Two disclosures fell out of that:
     *
     *   · A JUDGE could read every other judge's scores and deliberations for a submission they were
     *     scoring. The judging LIST route deliberately refuses exactly this, reducing to the caller's own
     *     row because "a judge must not see another judge's numbers from a list (the deliberations are
     *     gated separately and mid-judging disclosure is the P0-4 defect)". The detail read handed over
     *     what the list withheld — the same disclosure through a different door.
     *   · THE TEAM BEING JUDGED could read them too, via `canRead`. That is the subject of the
     *     assessment reading the assessors' private comments, potentially mid-judging.
     *
     * ── THE RULE ──
     *
     *   the experience's OWNER → every judge's scores, attributed. They run the experience and moderate
     *                            judging. (Originally written as "ADMIN / FACILITATOR"; narrowed to
     *                            ownership — see the branch below.)
     *   JUDGE                  → their OWN row and nothing else. Enough to see what they submitted, which
     *                            is what the portal's scoring panel reads it for.
     *   the team's EXECUTIVE   → their own team's scores and comments, with `judgeId` STRIPPED.
     *                            The feedback, not the attribution.
     *   anyone else           → refused. A PARTICIPANT included.
     *
     * ⚠ DECIDED BY ROLE, EXPLICITLY, AND NOT BY WHICH GATE THEY PASSED. `canRead` admits an ADMIN and a
     * FACILITATOR as well as the team, so "came in through the team door" cannot distinguish a
     * facilitator from a participant. Reading the role is the only sound basis.
     *
     * ⚠ A 403 RATHER THAN AN EMPTY LIST for the refused case. An empty array reads as "nobody has scored
     * this yet" — a statement about the judging, and a false one. "You may not see these" is the true
     * answer and the honest shape of it, and it is the same choice the release routes make.
     */
    const { id: readerId, role: readerRole } = requireIdentity(c);
    const all = await deps.scores.listBySubmission(submissionId);

    /**
     * ⚠ A JUDGE FIRST, SO THEIR READ COSTS NO WORKSHOP LOOKUP. Their own row is decidable from the
     * scores alone, and this is the read the portal's scoring panel makes on every submission a judge
     * opens — the hot path of the three.
     */
    if (readerRole === "JUDGE") {
      return c.json({ scores: all.filter((s) => s.judgeId === readerId) });
    }

    /**
     * ── ⚠ THE TEAM'S EXECUTIVE SEES THEIR OWN TEAM'S FEEDBACK ────────────────────────────────────
     *
     * THE RULE: of the team, only its EXECUTIVE reads the judges' scoring. This closes a gap the
     * previous change created and that nobody had decided: when the team-read branch was removed from
     * this route, **a team was left with no route to judge feedback at all**. The scores existed, the
     * comments existed, and the people they were written about could not read a word of them.
     *
     * ⚠ THE EXECUTIVE AND NOT THE TEAM. An EXECUTIVE is the team's read-only observer and the role that
     * RELEASES the submission — the accountable reader. A PARTICIPANT still gets nothing, which is what
     * "only executive" means and is the same shape as every other executive-only grant here
     * (`requireSubmissionRelease`, `requireSubmissionDraftWrite`).
     *
     * ⚠ MEMBERSHIP IS ALREADY PROVEN, AND THIS DEPENDS ON THAT — SO IT IS STATED. `requireSubmissionRead`
     * ran before this handler and its FIRST branch is `teamAccess.canRead(submission.teamId, …)`. For an
     * EXECUTIVE that predicate is membership ALONE: `canRead`'s other branch is `isStaffRole && owns…`,
     * and EXECUTIVE is not a staff role. So an executive who reaches this line is a member of this
     * submission's team, by invariant rather than by assumption. Re-probing would spend a second
     * east-west hop on a question already answered. ⚠ If that gate ever admits an executive on some
     * other basis, this branch silently widens with it — which is why `routes.test.ts` pins the
     * NON-MEMBER executive being refused at the gate, not just the member being served here.
     *
     * ⚠ `judgeId` IS STRIPPED, AND THAT IS A DELIBERATE CHOICE RATHER THAN AN OMISSION. The feedback is
     * the numbers and the comments; WHICH JUDGE WROTE WHICH is not feedback, it is attribution. Handing a
     * team the mapping turns the judged into judges of the judges — and on an experience with a handful of
     * judges an executive could deanonymise every comment against the invitation list they can already
     * see. The rows keep every scoring field and the comment, so nothing useful is lost. Reversing this
     * is one line if attributed feedback is ever wanted; the reverse direction is not recoverable.
     *
     * ⚠ NOT GATED ON PUBLICATION, AS CHOSEN. So an executive can read scores MID-JUDGING, before every
     * judge has finished — which is the disclosure the original team-read removal was partly about
     * ("the subject of the assessment reading the assessors' private comments, potentially mid-judging").
     * The trade was made knowingly; if it bites, gating this branch on `results.publishedAt` is the fix
     * and it needs no other change.
     */
    if (readerRole === "EXECUTIVE") {
      return c.json({
        scores: all.map(({ judgeId: _judgeId, ...rest }) => rest),
      });
    }

    /**
     * ── ⚠ EVERY JUDGE'S SCORES GO TO THE EXPERIENCE'S OWNER — BY OWNERSHIP, NOT BY ROLE ─────────
     *
     * THE RULE: only the experience's owner sees all judges' scores. An ADMIN who created the
     * experience is its owner; an ADMIN sees no other experiences, scores or data.
     *
     * So the question is not "what role is this?" but "did this person create this experience?".
     * ⚠ THIS REPLACED `role === "ADMIN" || role === "FACILITATOR"`, which was wrong in both
     * directions: it showed an ADMIN who had nothing to do with an experience every judge's private
     * comments on it, and it showed the same to any FACILITATOR on the platform rather than the one
     * running it.
     *
     * ⚠ CONSISTENT WITH WHAT THE WORKSHOP SERVICE ALREADY DOES. `GET /v1/workshops` sends both ADMIN
     * and FACILITATOR down `listByOwner(id)` — neither has ever LISTED an experience they did not own.
     * This route was simply more generous than the list that leads to it.
     *
     * ⚠ RESOLVED FROM THE STORED SUBMISSION'S `workshopId`, never from anything the caller supplied —
     * a submission id is guessable and shareable, so the record is the only sound basis.
     *
     * ⚠ UNDETERMINED IS A 503, NEVER A 403. Same three-valued handling the publish route applies to
     * this port: a directory that cannot answer must not be reported as "you may not". Reporting a
     * failed lookup as an authorization answer is the unavailable-not-an-answer defect.
     */
    if (submission.workshopId) {
      const workshop = await deps.workshops.get(submission.workshopId, c);
      if (workshop === "unavailable") {
        c.header("Retry-After", "2");
        return c.json(
          {
            error: "We couldn't check this experience just now. Please try again.",
            code: "WORKSHOP_UNAVAILABLE",
          },
          503
        );
      }
      if (workshop && workshop.ownerId && workshop.ownerId === readerId) {
        return c.json({ scores: all });
      }
    }
    return c.json(
      {
        error:
          "Judges' scores are visible to the people running this experience and to a team's executive for their own team. Published results are on the results page.",
        code: "SCORES_NOT_VISIBLE",
      },
      403
    );
  });

  // ---- Ratings -------------------------------------------------------------

  /**
   * Per-member contribution, aggregated from the LOCAL activity read-model.
   *
   * NOTE: the monolith's rating aggregator read ~8 foreign tables (teamMembers,
   * users, tasks, messages, aiThreads, aiMessages, gitCommits, gitFiles) to
   * compute this. Here we read ONLY the event-fed activity projection and enrich
   * names from the local users read-model — no cross-context table reads.
   */
  evaluation.get("/teams/:teamId/ratings", async (c) => {
    const teamId = c.req.param("teamId");
    // MEMBER-ONLY — see the note at the top of this file. This is the numeric
    // shadow of the chat, the board, the AI threads and the commits, so it must not be
    // readable by anyone who cannot read those.
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const activity = await deps.activity.listByTeam(teamId);
    const contributions: MemberContribution[] = await Promise.all(
      activity.map(async (a) => ({
        userId: a.userId,
        name: (await deps.users.get(a.userId))?.name ?? null,
        tasksCreated: a.tasksCreated,
        tasksCompleted: a.tasksCompleted,
        messagesSent: a.messagesSent,
        commitsPushed: a.commitsPushed,
        aiThreadsShared: a.aiThreadsShared,
        // `?? null` NOT `?? 0` — absent means "not measured", which is a different fact from
        // zero turns and must survive the trip to the client. See MemberContribution.aiTurns.
        aiTurns: a.aiTurns ?? null,
        contributionScore: scoreActivity(a),
      }))
    );
    contributions.sort((x, y) => y.contributionScore - x.contributionScore);

    // Peer ratings submitted by members (distinct from the activity-derived score).
    const peerRatings = await deps.ratings.listByTeam(teamId);

    return c.json({ contributions, peerRatings });
  });

  evaluation.post("/teams/:teamId/ratings", async (c) => {
    const teamId = c.req.param("teamId");
    // MEMBER-ONLY. A peer rating is a teammate's opinion of a teammate, so the
    // writer has to be a teammate — an outsider rating a team's members was never a
    // product case, and it would land free text in a store the team can read.
    const denied = await requireTeamContentWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const body = await c.req.json();

    // ── ⚠ THE SUBJECT'S ID IS VALIDATED, NOT MERELY PRESENT ────────────────────────────────
    //
    // Previously `if (!body.ratedUserId)` was the only check, so any truthy value became
    // a stored row's key material. A non-string, or a megabyte of text, reached the store.
    const ratedUserId =
      typeof body.ratedUserId === "string" ? body.ratedUserId.trim() : "";
    if (!ratedUserId || ratedUserId.length > MAX_RATED_USER_ID_LENGTH) {
      return c.json({ error: "ratedUserId is required" }, 400);
    }
    // `#` is the separator in the row's derived key (see memberRatingId), so a value containing one
    // could make two different pairs collide. Refused rather than escaped: every real id here is a
    // Cognito sub or a ULID, neither of which contains one.
    if (ratedUserId.includes("#")) {
      return c.json({ error: "ratedUserId contains an unsupported character" }, 400);
    }

    // ── ⚠ NO SELF-RATING ────────────────────────────────────────────────────────────────────
    //
    // A peer rating is a teammate's opinion OF A TEAMMATE. Rating yourself is not an opinion, it
    // is a score you awarded yourself sitting in the same list an executive reads. Checked before
    // any store call because it needs none.
    if (ratedUserId === id) {
      return c.json(
        { error: "You cannot rate yourself", code: "SELF_RATING_REFUSED" },
        409
      );
    }

    // ── ⚠ AND THE SUBJECT MUST ACTUALLY BE ON THE TEAM ─────────────────────────────────────
    //
    // The local rules above bound the SHAPE of `ratedUserId`; this is the one that bounds its
    // MEANING. Without it a member could file a rating for any id at all, and the one-row-per-pair
    // rule did not cap the row count either — the pair's second half was unbounded, so a rater could
    // mint a fresh row per invented id. It also let a rating name somebody on a DIFFERENT team,
    // stored in this team's partition where their own team can never see or answer it.
    //
    // ⚠ ASKED OF THE TEAM CONTEXT, NEVER READ FROM ITS TABLE, and re-presenting the CALLER's own
    // token — so this service gains no authority it could not exercise as that user. See TeamRoster.
    //
    // ⚠ AN UNWIRED PORT IS A 503, NOT A SKIP. `roster` is optional so the service still composes
    // where it has not been wired, and the refusal is what makes that safe: a deployment missing the
    // port cannot silently fall back to the defect this check exists to close.
    if (!deps.roster) {
      console.error(
        "[evaluation] rating refused — no roster port is wired, so ratedUserId cannot be validated"
      );
      return c.json(
        {
          error: "Ratings are unavailable in this environment.",
          code: "ROSTER_UNAVAILABLE",
        },
        503
      );
    }

    const onTeam = await deps.roster.isActiveMember(teamId, ratedUserId, c);
    if (onTeam === "unavailable") {
      // NOT a 403 and NOT an empty roster. An unanswered "who is on this team?" is an
      // outage, and reporting it as "that person is not on your team" would send a member arguing
      // with a validation error that will fix itself.
      c.header("Retry-After", "2");
      return c.json(
        {
          error: "Could not check your team's roster — try again shortly.",
          code: "ROSTER_UNAVAILABLE",
        },
        503
      );
    }

    if (!onTeam) {
      // 404 rather than 403: the caller is fully authorized here, and the subject is simply not
      // someone this team can rate. Naming the distinction would also confirm whether an arbitrary
      // id exists somewhere on the platform, which is not this route's business to answer.
      return c.json(
        {
          error: "That person is not an active member of this team",
          code: "NOT_A_TEAM_MEMBER",
        },
        404
      );
    }

    // ── ⚠ THE COMMENT IS CAPPED ─────────────────────────────────────────────────────────────
    //
    // It was `body.comment || null` with no length check, and this row is COPIED INLINE into the
    // release snapshot — so an oversized comment also risked pushing the submission item past
    // DynamoDB's 400 KB limit and making release itself fail.
    //
    // Reuses MAX_SCORE_COMMENT_CHARS rather than choosing a number: a judge's comment and a peer's
    // comment are both a person writing prose into a box, and that constant's own note explains why
    // two different four-thousand-ish limits in one product cannot be justified.
    const comment = typeof body.comment === "string" ? body.comment : null;
    // `.length`, matching the judge-comment check in this same file rather than the code-point
    // measure used for audit reasons — one constant must not mean two different limits in one file.
    if (comment !== null && comment.length > MAX_SCORE_COMMENT_CHARS) {
      return c.json(
        {
          error: `comment is too long — at most ${MAX_SCORE_COMMENT_CHARS} characters`,
          code: "COMMENT_TOO_LONG",
        },
        400
      );
    }

    const rating: MemberRating = {
      teamId,
      // ⚠ DERIVED FROM THE PAIR, not a fresh ulid(). A fresh id per call is what made the rows
      // unbounded: one rater could rate the same teammate without limit and every row was stored
      // and returned. See MemberRatingRepository.create.
      id: memberRatingId(id, ratedUserId),
      raterId: id,
      ratedUserId,
      score: Math.max(0, Math.min(100, Number(body.score) || 0)),
      comment: comment || null,
      createdAt: new Date().toISOString(),
    };

    const outcome = await deps.ratings.create(rating);
    if (outcome === "already-rated") {
      // 409 and the same shape as a judge's second score: the first opinion stands, and silently
      // replacing it would let a rater revise a record their teammates have already been read on.
      return c.json(
        {
          error: "You have already rated this teammate",
          code: "ALREADY_RATED",
        },
        409
      );
    }

    await deps.events.publish({
      source: "evaluation-service",
      type: "member.rated",
      detail: { teamId, raterId: id, ratedUserId: rating.ratedUserId },
    });

    return c.json({ rating }, 201);
  });

  return evaluation;
}

/**
 * Event handler that feeds the activity read-model.
 *
 * NOTE: This is the seam that replaces the monolith rating aggregator's direct
 * multi-table reads. It is invoked from handler.ts, which routes EventBridge
 * payloads here (the `EvaluationActivityRule` targets this Lambda directly — no
 * SQS hop). Failures propagate on purpose so EventBridge retries and eventually
 * DLQs; see handler.ts. The following domain events increment per-member counters:
 *
 *   - `task.created`        → tasksCreated
 *   - `task.status-changed` → tasksCompleted (when status becomes DONE)
 *   - `message.sent`        → messagesSent
 *   - `commit.pushed`       → commitsPushed
 *   - `ai.thread-shared`    → aiThreadsShared
 *
 * Each event carries { teamId, userId } in its detail. Unknown event types are
 * ignored (forward-compatible). The rating endpoint then aggregates over this
 * projection instead of reading foreign tables.
 */
/**
 * Ceiling on `aiTurns` from a single event. The AI service caps a sync batch (MAX_SYNC_MESSAGES),
 * so a larger number means a producer bug or a hostile client — and this counter feeds a figure a
 * person is judged by, so it is bounded here as well as there. Independent of the AI service's
 * own cap deliberately: two services, two bounds, neither trusting the other.
 */
const MAX_AI_TURNS_PER_EVENT = 100;

export async function applyActivityEvent(
  activity: ActivityReadModel,
  event: DomainEvent
): Promise<void> {
  const detail = (event.detail ?? {}) as {
    teamId?: string;
    userId?: string;
    status?: string;
    aiTurns?: unknown;
  };
  const { teamId, userId } = detail;
  if (!teamId || !userId) return; // can't attribute — skip

  switch (event.type) {
    case "task.created":
      await activity.increment(teamId, userId, "tasksCreated", 1, event.id);
      break;
    case "task.status-changed":
      if (detail.status === "DONE") {
        await activity.increment(teamId, userId, "tasksCompleted", 1, event.id);
      }
      break;
    case "message.sent":
      await activity.increment(teamId, userId, "messagesSent", 1, event.id);
      break;
    case "commit.pushed":
      await activity.increment(teamId, userId, "commitsPushed", 1, event.id);
      break;
    case "ai.thread-shared":
      await activity.increment(teamId, userId, "aiThreadsShared", 1, event.id);
      break;
    /**
     * AI TURNS — the only honest measure of assistant usage.
     *
     * `aiThreadsShared` counts BUTTON PRESSES: someone who used an assistant heavily and never
     * pressed "share" scored zero, which is exactly backwards for a figure meant to reflect AI
     * usage. This event was PUBLISHED and consumed by NOTHING, so turns were counted nowhere on
     * the platform.
     *
     * ── WHY THE AMOUNT COMES FROM THE EVENT ──
     *
     * Two producers publish this type: the in-app Bedrock path sends one turn per invoke, and
     * the desktop CLI sync sends the number of assistant replies in a batch. The consumer must
     * not assume 1, or a synced batch of six turns would count as one — under-counting the very
     * path that was previously invisible.
     *
     * VALIDATED, not trusted: a non-integer, zero, negative or absurd value is a producer bug or
     * a hostile client, and this number feeds a figure people are judged by. Out-of-range is
     * clamped to 1 rather than dropped — a turn demonstrably happened, so counting it once is
     * closer to the truth than counting it zero times or a thousand.
     */
    case "ai.response-generated": {
      const raw = detail.aiTurns;
      const turns =
        typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_AI_TURNS_PER_EVENT
          ? raw
          : 1;
      await activity.increment(teamId, userId, "aiTurns", turns, event.id);
      break;
    }
    default:
      // Not an activity-relevant event; ignore.
      break;
  }
}
