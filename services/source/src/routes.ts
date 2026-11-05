import { Hono } from "hono";
import { ulid } from "ulid";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  type EventPublisher,
} from "@praimana/service-shared";
import { CommitAlreadyExistsError } from "./domain.js";
import type {
  CommitRepository,
  FileRepository,
  UsersReadModel,
} from "./domain.js";
import {
  requireTeamContentRead,
  requireTeamContentWrite,
  type TeamAccess,
} from "./authz.js";

/**
 * Source-control service routes. Note the constructor-style dependency injection:
 * the routes depend on INTERFACES (CommitRepository, FileRepository, TeamAccess,
 * EventPublisher, UsersReadModel) passed in, never on concrete DynamoDB/HTTP
 * classes. This is the Dependency Inversion seam — wiring lives in app.ts, and
 * tests pass in-memory fakes.
 *
 * Mounted under basePath /v1 so it is a drop-in for the monolith's git routes
 * (strangler-fig: the gateway can route these commit/file paths here while
 * everything else still hits the monolith).
 */
/**
 * ── BOUNDS ON THIS SERVICE'S TWO WRITE/READ SURFACES ────────────────────────────────────────
 *
 * Previously this service took a collection size and a pagination limit straight from
 * the request with no bound, in a codebase that caps such inputs deliberately everywhere else —
 * MAX_SYNC_FILES in docs, MAX_SYNC_MESSAGES in ai, MAX_RECIPIENTS in notify,
 * MAX_INVITEES_PER_REQUEST in team.
 */

/** Default page for the commit list. The value the old `parseInt(... || "50")` defaulted to. */
const DEFAULT_COMMIT_PAGE = 50;

/**
 * Ceiling on one commit-list page.
 *
 * 200, matching docs' MAX_SYNC_FILES rather than inventing a number: a team's commit list is a
 * screen, and this is the order of magnitude the platform already treats as "one page of a team's
 * repository activity".
 */
const MAX_COMMIT_PAGE = 200;

/**
 * Ceiling on the per-path rows one commit may carry.
 *
 * 200, the same as docs' MAX_SYNC_FILES and for the same reason: the desktop derives this array
 * from the files a commit touched, so it grows with the repository. A commit legitimately touching
 * more than 200 paths is a bulk refactor, and refusing it with a message beats issuing 50,000
 * writes inside one Lambda invocation and timing out half-done.
 */
const MAX_COMMIT_FILES = 200;

/**
 * How many per-path rows are written at once.
 *
 * Bounded concurrency rather than a full fan-out: `MAX_COMMIT_FILES` in flight simultaneously
 * would trade the timeout this fixes for a burst against the table's write capacity, which is the
 * same failure wearing different clothes. 10 keeps a legal-but-large commit well inside the
 * function's budget while leaving capacity for everything else on the table.
 */
const FILE_WRITE_CONCURRENCY = 10;

/**
 * One per-path entry as it arrives in a commit's `files[]`.
 *
 * Every field is `unknown` because it comes off a parsed JSON body: the route coerces each with
 * `Number(...) || 0` at the point of use, and typing them as `number` here would be a claim about
 * a client this service does not control. Named (rather than inlined) so the filter below has a
 * predicate to narrow to — the same shape `docs` uses for its `IncomingDoc`.
 */
interface IncomingFile {
  path: unknown;
  additions?: unknown;
  deletions?: unknown;
  commits?: unknown;
}

export interface SourceDeps {
  commits: CommitRepository;
  files: FileRepository;
  teamAccess: TeamAccess;
  users: UsersReadModel;
  events: EventPublisher;
}

export function createSourceRoutes(deps: SourceDeps) {
  const source = new Hono().basePath("/v1");

  // Every request must carry a gateway-injected identity (authN done at edge).
  source.use("*", edgeIdentityMiddleware());

  // ── EVERY ROUTE BELOW IS MEMBER-ONLY ────────────────────────────
  //
  // A team's commits, commit messages and per-file contribution counts are their work
  // product, so these are gated on requireTeamContent{Read,Write} — membership of THIS
  // team — and not on the wider requireTeam{Read,Write}, which an ADMIN and a
  // workshop-owning FACILITATOR also pass. All four now 403 an admin, facilitator or judge,
  // with NO exception — an audited admin break-glass route was built and then removed,
  // so an EXECUTIVE who is a member of the team is the only investigation path.

  // List a team's commits, newest first.
  source.get("/teams/:teamId/commits", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    // ── ⚠ THE LIMIT IS VALIDATED, NOT parseInt'd ─────────────────────────────────────────────
    //
    // This was `parseInt(c.req.query("limit") || "50")`, passed STRAIGHT into a QueryCommand's
    // `Limit`. Two ways that broke, both reachable by typing a URL:
    //   ?limit=abc  → parseInt returns NaN
    //   ?limit=-1   → a negative number
    // DynamoDB rejects both with a ValidationException that no handler catches, so a query
    // parameter produced a 500. Clamped into [1, MAX_COMMIT_PAGE] with the Number +
    // Number.isFinite pattern this platform already uses at team/src/routes.ts:1538 and
    // identity's /admin/users.
    //
    // IGNORED rather than 400'd when unparseable, matching those two: it comes from a URL, and a
    // clamped default is a more useful answer than a refusal for a value with an obvious default.
    const requested = Number(c.req.query("limit"));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_COMMIT_PAGE)
        : DEFAULT_COMMIT_PAGE;
    const commits = await deps.commits.listByTeam(teamId, limit);
    return c.json({ commits });
  });

  // Record a commit + its files, then publish `commit.pushed` so the evaluation
  // service's activity read-model can count the contribution.
  source.post("/teams/:teamId/commits", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamContentWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const body = await c.req.json();
    const now = new Date().toISOString();

    // ── ⚠ ATTRIBUTION COMES FROM THE TOKEN, NEVER THE BODY ───────────────────────────────────
    //
    // This was `body.author || (await deps.users.get(id))?.name || id`, so a team member could
    // attribute a commit to a teammate by naming them in the body. Commit history has NO other
    // mutation path on this platform, and the per-file `lastAuthor` below is the team's
    // contribution record that an executive reads as fact — so a spoofable author is not a
    // cosmetic problem.
    //
    // Resolved from the caller's OWN id only, via the LOCAL users read-model (never by reading
    // Identity's table across the boundary). `body.author` is now IGNORED rather than 400'd: it
    // is a field existing clients may still send, and refusing the whole commit over an ignored
    // field would break them for no gain.
    const author = (await deps.users.get(id))?.name || id;

    // ── ⚠ A CREATE THAT FAILS RATHER THAN REPLACES ───────────────────────────────────────────
    //
    // `date` is the item's SORT KEY and it is caller-supplied, and this was a bare PutCommand —
    // so replaying an existing row's `date` REPLACED that commit: its message, its stats and its
    // author, silently, with no update route anywhere in the service to do it legitimately.
    //
    // `commits.create` now carries `attribute_not_exists`, and a conflict is a 409. ⚠ THE HONEST
    // COST: two genuinely distinct commits sharing an identical millisecond timestamp within one
    // team now 409 instead of one silently destroying the other. Losing a commit is worse than
    // refusing one, and the caller can retry — see the note on GitCommit's key in domain.ts for
    // why the key is a date at all.
    let commit;
    try {
      commit = await deps.commits.create({
        teamId,
        date: typeof body.date === "string" && body.date ? body.date : now,
        sha: typeof body.sha === "string" && body.sha ? body.sha : ulid(),
        message: typeof body.message === "string" ? body.message : "",
        author,
        additions: Number(body.additions) || 0,
        deletions: Number(body.deletions) || 0,
        createdAt: now,
      });
    } catch (err) {
      if (err instanceof CommitAlreadyExistsError) {
        return c.json(
          {
            error:
              "A commit is already recorded at that timestamp for this team. Nothing was changed.",
            code: "COMMIT_ALREADY_EXISTS",
          },
          409
        );
      }
      throw err;
    }

    // ── ⚠ BOUNDED FAN-OUT ────────────────────────────────────────────────────────────────────
    //
    // This iterated `body.files` with NO length check, issuing one sequential write per element.
    // A single request carrying tens of thousands of entries became that many writes inside one
    // Lambda invocation — a write amplifier against the table's provisioned capacity and against
    // the function timeout, leaving a half-written result behind. The sibling ingest route in
    // `docs` has enforced exactly this bound since it was written (MAX_SYNC_FILES).
    //
    // REFUSED rather than truncated, for the reason docs states: silently storing the first N of
    // a larger set leaves a team believing their contribution history is complete.
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > MAX_COMMIT_FILES) {
      return c.json(
        {
          error: `too many files: ${files.length} exceeds the ${MAX_COMMIT_FILES} limit`,
          code: "TOO_MANY_FILES",
        },
        400
      );
    }

    // ── ⚠ THE PER-FILE ROWS ACCUMULATE; THEY DO NOT REPLACE ──────────────────────────────────
    //
    // These are keyed (teamId, path) and documented as "rolled-up contribution stats rather than
    // a per-commit snapshot" (domain.ts), and the incoming values are per-commit DELTAS — which
    // `commits: Number(f.commits) || 1` makes plain, since a default of 1 only means "this commit
    // touched this path once". A bare Put therefore threw the rollup away on every commit and
    // left the last commit's deltas standing in for the file's whole history.
    //
    // `accumulate` is an UpdateCommand with ADD, so the counters sum and the row is created on
    // first touch. ⚠ NOT a BatchWriteItem: BatchWriteItem cannot express an update, only a
    // replace, which is the very thing that was wrong here. The bound above is what makes the
    // per-path calls acceptable, and they run with bounded concurrency rather than strictly
    // sequentially so a large-but-legal commit does not serialize into the function timeout.
    const deltas: IncomingFile[] = (files as unknown[]).filter(
      (f): f is IncomingFile =>
        !!f && typeof f === "object" && !!(f as IncomingFile).path
    );
    for (let i = 0; i < deltas.length; i += FILE_WRITE_CONCURRENCY) {
      await Promise.all(
        deltas.slice(i, i + FILE_WRITE_CONCURRENCY).map((f) =>
          deps.files.accumulate({
            teamId,
            path: String(f.path),
            additions: Number(f.additions) || 0,
            deletions: Number(f.deletions) || 0,
            commits: Number(f.commits) || 1,
            lastAuthor: author,
            updatedAt: now,
          })
        )
      );
    }

    // Cross-service notification travels as an event, not a direct call.
    await deps.events.publish({
      source: "source-service",
      type: "commit.pushed",
      detail: {
        teamId,
        sha: commit.sha,
        // `userId` mirrors `authorId` — evaluation's activity projection reads `userId` and
        // silently skipped every commit. `authorId` stays for existing readers.
        authorId: id,
        userId: id,
        additions: commit.additions,
        deletions: commit.deletions,
      },
    });

    return c.json({ commit }, 201);
  });

  // Commit detail with its files (files sharing the commit's paths).
  source.get("/teams/:teamId/commits/:sha", async (c) => {
    const teamId = c.req.param("teamId");
    const sha = c.req.param("sha");
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const commit = await deps.commits.getBySha(teamId, sha);
    if (!commit) return c.json({ error: "Commit not found" }, 404);

    const files = await deps.files.listByTeam(teamId);
    return c.json({ commit, files });
  });

  // Aggregated file/contribution view for a team (mirrors the monolith's
  // GET /teams/:teamId/files).
  source.get("/teams/:teamId/files", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const files = await deps.files.listByTeam(teamId);
    return c.json({ files });
  });

  return source;
}
