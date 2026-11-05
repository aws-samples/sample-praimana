import { Hono } from "hono";
import { ulid } from "ulid";
import {
  edgeIdentityMiddleware,
  emitMetric,
  requireIdentity,
  type EventPublisher,
} from "@praimana/service-shared";
import type { Context } from "hono";
import type {
  AiThread,
  ThreadRepository,
  MessageRepository,
  UsersReadModel,
  TeamAiRatingRepository,
  RatingAnalyst,
  TeamChatReader,
  MemberAiAssessment,
  TeamCountersReader,
  TeamWorkshopLookup,
  RatingCounters,
  SummaryModelInput,
} from "./domain.js";
// A VALUE, so it cannot ride on the `import type` above. The lease duration is a domain rule the
// route and the store must agree on — see GENERATION_LEASE_MS.
import { GENERATION_LEASE_MS } from "./domain.js";
import {
  requireTeamContentRead,
  requireAiConversationWrite,
  requireAssessmentGenerate,
  requireAssessmentPromptRead,
  requireAssessmentRead,
  type TeamAccess,
  requirePublishedSummaryRead,
  type WorkshopEntitlements,
} from "./authz.js";
// The prompts the assessment actually sends, shared with the Bedrock adapter so the disclosed
// string cannot drift from the sent one. No SDK dependency — see ratings-prompts.ts.
import { ratingsPromptDisclosure } from "./ratings-prompts.js";
import { rollUpThreadTiming } from "./timing.js";
import { CLIENT_ERROR_PLACEHOLDER, isClientErrorContent } from "./cli-error-content.js";

/**
 * AI service routes. Note the constructor-style dependency injection: the routes
 * depend on INTERFACES (ThreadRepository, MessageRepository, TeamAccess,
 * EventPublisher, UsersReadModel) passed in, never on concrete DynamoDB/HTTP
 * classes. This is the Dependency Inversion seam — wiring lives in app.ts, and
 * tests pass in-memory fakes.
 *
 * Mounted under basePath /v1/ai so it is a drop-in for the monolith's /v1/ai/*
 * routes (strangler-fig: the gateway can route /v1/ai/* here while everything
 * else still hits the monolith).
 */
export interface AiDeps {
  threads: ThreadRepository;
  messages: MessageRepository;
  teamAccess: TeamAccess;
  users: UsersReadModel;
  events: EventPublisher;
  /**
   * ── THE CONVERSATIONAL MODEL PORT IS GONE ──
   *
   * There was a `model: ModelClient` here, invoked by `POST /threads/:threadId/messages`. That
   * route no longer calls a model (see its comment for why: no shipped client ever posted to it,
   * and the desktop app records transcripts from the user's OWN local CLI via `/sync`).
   *
   * REMOVED RATHER THAN LEFT UNUSED, deliberately. A wired-but-unreferenced model client is an
   * invitation: the next person to add a route here would find a ready-made billable dependency
   * with no timeout, no history cap and no budget, and use it. Deleting the port means restoring
   * in-app chat has to be a decision rather than an accident.
   *
   * `analyst` below is a SEPARATE port and is untouched — it serves the ratings assessment, which
   * is a deliberate, executive-only, leased and cooled-down action.
   */

  // ── Team AI ratings (optional: a deployment without them simply has no ratings) ──
  //
  // Optional so this service still composes in an environment where ratings are not wired,
  // and so the existing 125 tests need no new fakes. The routes check for presence and
  // return 503 rather than throwing, which is the honest answer for "this deployment cannot
  // do that" as opposed to "you may not".

  /** Snapshot store. */
  ratings?: TeamAiRatingRepository;
  /**
   * The two model calls, and now the ONLY billable port in this service.
   *
   * It was described here as "SEPARATE from `model` above" — that separation was the right
   * instinct and it has outlived the thing it was separated from. The conversational port is gone
   * (see above), so the whole of this service's model spend is reached through exactly one
   * dependency, by exactly one route, which is executive-only, leased and cooled down.
   */
  analyst?: RatingAnalyst;
  /** Team chat, read from the collaboration context over its own API. */
  teamChat?: TeamChatReader;
  /** Activity counters, read from the evaluation context over its own API. */
  counters?: TeamCountersReader;
  /** Server-side workshop resolution for a team. Gates judge access to a published summary. */
  workshops?: TeamWorkshopLookup;
  /**
   * A caller's entitled workshops. Only consulted for a NON-member reading a PUBLISHED
   * summary — members and administration scope are settled before it, so the common path
   * never pays for this hop.
   */
  entitlements?: WorkshopEntitlements;
}

/**
 * Bounds for POST /threads/:threadId/sync. The monolith's version of that route
 * looped over an unbounded array issuing one Put per element, which is both a write
 * amplifier and a slow request nobody could cancel.
 *
 * A turn is a user message plus an assistant reply, so 2 is the normal case; the
 * ceiling exists for a client that batches a backlog after being offline, not to
 * accommodate an unbounded one.
 */
const MAX_SYNC_MESSAGES = 50;

/**
 * Hard ceiling on a single `GET .../messages?limit=` page. The desktop asks for 5 at a time, but a
 * client must not be able to turn the paginated read back into "fetch everything" with one huge
 * limit — which would reintroduce the very cost pagination was added to remove. A generous cap keeps
 * legitimate larger pages working while bounding the worst case.
 */
const MAX_MESSAGE_PAGE = 100;

/**
 * Per-message content ceiling. A CLI turn can legitimately be long — a pasted diff,
 * a stack trace — so this is generous, but it is FINITE: DynamoDB's own item limit
 * is 400KB, and hitting that produces a failed write at the storage layer instead of
 * a clear 400 here. 100k characters keeps the whole batch comfortably inside the
 * 1MB transaction/request envelope even at MAX_SYNC_MESSAGES.
 */
const MAX_SYNC_CONTENT = 100_000;

/**
 * Ceiling on a client-reported turn duration: 6 hours.
 *
 * Generous, because a genuine agentic CLI turn can run for a long time — but finite,
 * because this number is read as "how long the AI worked" and an absurd value would
 * distort every average it appears in. Beyond this the value is dropped rather than
 * clamped: a 40-hour turn is a bug or a bad clock, and silently recording 6 hours would
 * launder it into something that looks plausible.
 */
const MAX_SYNC_LATENCY_MS = 6 * 60 * 60 * 1000;

/**
 * Ceiling on a client-reported token count.
 *
 * ⚠ A BOUND, NOT A GUESS AT THE MODEL'S WINDOW. Frontier context windows are already in the millions and
 * will grow, so this is set well above anything a single turn can legitimately report rather than tracking
 * any particular model — its job is to refuse a corrupted or hostile figure, not to police plausibility.
 * A turn over the bound has its count DROPPED, not clamped: a clamped number is a fabricated one, and the
 * rollup would then report it as measured.
 */
const MAX_SYNC_TOKENS = 100 * 1_000_000;

/**
 * ── BOUNDS ON A CLIENT-SUPPLIED `createdAt` ──────────────────────────────────────────────
 *
 * The desktop now sends each message's REAL local time so `timing.ts` can measure user compose time
 * instead of refusing to (see the parse loop). That is untrusted input on a path that feeds the
 * counters ranking people, so it is bounded rather than believed.
 *
 * ⚠ AHEAD: five minutes. Enough for ordinary clock skew on a laptop; not enough to invent an idle gap.
 * A timestamp an hour in the future would make the NEXT message's gap look like an hour of thinking.
 *
 * ⚠ BEHIND: thirty days, matching the refresh-token lifetime — the longest a session can plausibly
 * span, so a genuine offline backlog still syncs with real times. Older than that and the row would
 * drag a thread's apparent start backwards past anything this platform has seen.
 *
 * A value outside either bound is DROPPED, never clamped: clamping launders a bad clock into a
 * plausible-looking number, which is exactly what `MAX_SYNC_LATENCY_MS` above refuses to do.
 */
const MAX_CLOCK_SKEW_AHEAD_MS = 5 * 60 * 1000;
const MAX_TIMESTAMP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ── Team AI ratings bounds ───────────────────────────────────────────────────
//
// Every one of these caps a cost or a blast radius, not a preference.

/**
 * Members per analysis. REFUSED over this, never truncated: an assessment that silently omits
 * people is a wrong answer that looks right.
 *
 * ── 10, LOWERED FROM 25, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN ──
 *
 * 25 matched the platform's team-size cap, which made it look principled. It was not: probing
 * the real model at that size showed the knowledge call does not work there.
 *
 *     5 members    4.7s   clean
 *    25 members   20-26s  FAILS — "not JSON", and before that silently returned
 *                         25/25 rows with EMPTY rationales at stopReason=max_tokens
 *
 * The 25-member prompt is ~737 KiB / ~188k tokens, and the model stops producing parseable
 * JSON well before the route's 9s budget is reached. So the honest cap is the largest size the
 * call is known to handle, not the largest size the platform allows a team to be — and a bound
 * nobody has measured is a guess with a number on it.
 *
 * 10 refuses nobody in practice: the largest live team is 4. It also leaves the whole path
 * comfortably inside the 9s model timeout rather than relying on it.
 *
 * ⚠ DO NOT RAISE THIS TO MATCH A LARGER TEAM-SIZE CAP WITHOUT RE-PROBING. Raising it is not a
 * config change, it is a claim about model behaviour at a size that has not been tested, and
 * the failure mode it reintroduces is silent empty coaching rather than an error. Chunking the
 * knowledge call into ~5-member batches is what would let this go higher.
 */
const MAX_RATED_MEMBERS = 10;
/** Messages per member fed to call A, newest first. Bounds prompt size and cost. */
const MAX_MEMBER_MESSAGES = 40;
/** Characters per message. A pasted stack trace must not consume the whole context. */
const MAX_MESSAGE_CHARS = 600;
/** Team-chat rows fetched in one hop before per-member bucketing. */
const MAX_TEAM_CHAT_FETCH = 400;
/**
 * PER-CALL model wall-clock. One member's assessment, or the team summary.
 *
 * 9s against a measured ~1.8s per member is ~5x headroom for a single slow invoke.
 */
const RATING_MODEL_TIMEOUT_MS = 9_000;

/**
 * TOTAL wall-clock for the whole generation — every per-member call plus the summary.
 *
 * ── WHY A SECOND, SEPARATE BUDGET ──
 *
 * Assessments are now one call per member, so a single 9s deadline shared across the loop
 * aborts partway through: at the measured ~1.8s per member it would cut a 10-person team off
 * around member 5, and the abort is indistinguishable from a model fault. A 10-member team
 * measured 18.4s end to end, which is CORRECT behaviour and must not be treated as a timeout.
 *
 * 45s sits under the AI function's 60s Lambda timeout (set in the infrastructure template), so a
 * generation that overruns is aborted BY US — with the previous snapshot intact and a
 * MODEL_TIMEOUT the caller can act on — rather than by the platform, which would return an
 * opaque 502 and lose the partial work.
 *
 * ⚠ RAISING MAX_RATED_MEMBERS MEANS RE-CHECKING THIS. At ~1.8s per member, 10 members is 18s
 * and 25 would be ~45s — i.e. this budget, not the model, is what makes a larger cap need an
 * asynchronous design rather than a bigger number here.
 */
const RATING_TOTAL_TIMEOUT_MS = 45_000;
/** Regeneration cooldown. The counters are event-fed and move slowly, so a re-run inside
 *  this window costs a full invoke to produce near-identical text. */
const RATING_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Why a generation was refused, or NONE when it was admitted — so overload is OBSERVABLE rather
 * than merely handled.
 *
 * `Reason` IS A CLOSED THREE-VALUE SET, which is what makes it a legal CloudWatch dimension. A
 * dimension whose values are unbounded (a teamId, an actor) multiplies into a separate metric per
 * value and costs money per unique combination — so those go in `properties`, which is searchable
 * in Logs Insights and free.
 *
 * IN_PROGRESS is the interesting signal. COOLDOWN firing is routine and expected — somebody pressed
 * Generate twice in ten minutes. IN_PROGRESS means two people are competing for one generation,
 * which is the case worth alarming on because it is invisible to both of them.
 */
function emitRefusalMetric(
  reason: "COOLDOWN" | "IN_PROGRESS" | "NONE",
  teamId: string,
  actorId: string
): void {
  emitMetric({
    namespace: "Praimana/Ratings",
    name: "RatingsGenerationRefused",
    value: reason === "NONE" ? 0 : 1,
    dimensions: { Reason: reason },
    properties: { teamId, actorId },
    source: "ai-service",
  });
}


/**
 * Cap on sharer-name lookups per list request.
 *
 * A team's shared-chat list is small, but this is a per-request fan-out against another table and
 * must not scale with a list an attacker could grow. Beyond the cap the remaining rows simply show
 * "Shared", which is the pre-existing behaviour rather than a failure.
 */
const MAX_SHARER_LOOKUPS = 25;

/**
 * Wall-clock budget for the WHOLE sharer-name resolution step.
 *
 * ⚠ THE SHARED `DocClient` SETS NO REQUEST TIMEOUT (the services' shared dynamo module), so on its
 * own each lookup is an unbounded external call — a throttled or hung read-model would hold this
 * list open for the SDK's default retry ladder while the reader stares at an empty panel. The names
 * are decoration; the list is the answer. So the step gets a deadline, and past it the remaining
 * rows show "Shared".
 *
 * Fixing the client's defaults would be the better fix, but it is shared by 11 services and is not
 * this change's business — noted for that work instead.
 */
const SHARER_LOOKUP_BUDGET_MS = 1_000;

/**
 * Resolves display names for thread sharers whose rows carry no `sharedByName`, in place.
 *
 * Bounded on three axes: DISTINCT ids only, at most MAX_SHARER_LOOKUPS of them, and the whole step
 * abandoned after SHARER_LOOKUP_BUDGET_MS. Never throws and never rejects — every failure mode
 * leaves the name absent, which the UI already renders as "Shared".
 */
async function resolveSharerNames(
  threads: AiThread[],
  users: AiDeps["users"]
): Promise<void> {
  const needsName = (t: AiThread) => Boolean(t.sharedById) && !t.sharedByName;

  const missing = [
    ...new Set(threads.filter(needsName).map((t) => t.sharedById as string)),
  ].slice(0, MAX_SHARER_LOOKUPS);
  if (!missing.length) return;

  const names = new Map<string, string>();

  // Names found before the deadline are still applied — a partial answer beats none.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHARER_LOOKUP_BUDGET_MS);
    // Do not hold a Lambda invocation open on a timer nobody is waiting for.
    timer.unref?.();
  });

  try {
    await Promise.race([
      Promise.all(
        missing.map(async (id) => {
          try {
            const name = (await users.get(id))?.name;
            if (name) names.set(id, name);
          } catch {
            /* Best-effort — see above. */
          }
        })
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  for (const t of threads) {
    if (!needsName(t)) continue;
    const resolved = names.get(t.sharedById as string);
    if (resolved) t.sharedByName = resolved;
  }
}

export function createAiRoutes(deps: AiDeps) {
  const ai = new Hono().basePath("/v1/ai");

  // Every request must carry a gateway-injected identity (authN done at edge).
  ai.use("*", edgeIdentityMiddleware());

  // ── EVERY ROUTE BELOW IS MEMBER-ONLY ────────────────────────────
  //
  // A team's AI conversations are the most revealing content the platform holds about how
  // they think and work, so they are gated on requireTeamContent{Read,Write} — membership
  // of THIS team — and not on the wider requireTeam{Read,Write}, which an ADMIN and a
  // workshop-owning FACILITATOR also pass. All of these now 403 an admin, facilitator or
  // judge, with NO exception — an audited admin break-glass route was built and then removed
  // (removed via an audited change), so an EXECUTIVE who is a member of the team is the only investigation path.
  //
  // The thread-keyed routes are covered too, via resolveThreadForAccess below: they
  // authorize against the team that OWNS the thread with the same content guards, so
  // knowing a thread id is not a way around this.

  ai.get("/teams/:teamId/threads", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const sharedOnly = c.req.query("shared") === "true";
    const threads = await deps.threads.listByTeam(teamId, sharedOnly);

    /**
     * ── RESOLVE THE SHARER'S NAME FOR ROWS THAT PREDATE `sharedByName` ──
     *
     * REPORTED: shared chats showed "Shared" with no name — the reader could not tell who had
     * shared "Quick question" or "Fix the build".
     *
     * ⚠ THE CAUSE WAS HISTORICAL, NOT A BROKEN LOOKUP. `sharedByName` is stamped at share time
     * (see PUT /share below) and every one of those users IS in the read-model with a name.
     * But threads shared BEFORE that field was written have `sharedById` and no name, while
     * threads shared afterwards display correctly. Stamping at write time is right; it just cannot retrofit rows already stored.
     *
     * So the name is resolved on READ when the stored one is missing. Deliberately NOT a
     * backfill migration: a read-time lookup also self-heals a row whose sharer was renamed, and
     * this list is small and already behind an authorization check.
     *
     * ⚠ BOUNDED AND BEST-EFFORT on every axis — see resolveSharerNames. A missing name is a
     * cosmetic gap; an errored or hung list is an empty panel.
     */
    await resolveSharerNames(threads, deps.users);

    return c.json({ threads });
  });

  ai.post("/teams/:teamId/threads", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireAiConversationWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const body = await c.req.json();
    const now = new Date().toISOString();
    const threadId = body.id || ulid();

    /**
     * ── ⚠ CREATE MUST NOT CLOBBER AN EXISTING THREAD ─────────────────────────────────────
     *
     * `threads.put` is a full-item write, and this route used to call it unconditionally. So a second
     * "create" for an id that already existed did not fail and did not merge — it REPLACED the row,
     * dropping every field this handler does not set.
     *
     * ⚠ THAT DESTROYED A REAL SHARE, and the data proved it. Thread
     * `4392b109-3772-4b11-bfbe-fbb80c55f825`: the desktop recorded `shared_at = 11:47:01` locally
     * (which it only does after a 2xx from the share route), and the server row later read
     * `createdAt = updatedAt = 12:48:42` — an hour LATER — with `shared`, `sharedAt`, `sharedById` and
     * `sharedByName` all gone and the title replaced by the participant's most recent prompt. The
     * chat showed as shared on their machine and was invisible in Team Chats to everyone, including
     * them.
     *
     * ⚠ THE CALLER WAS NOT MISBEHAVING EITHER. `syncToServer` creates the thread when its probe finds
     * 404 **or a 200 with zero messages** — and while message syncs were failing (an expired bearer),
     * the thread permanently had zero messages, so every subsequent turn re-created it. One bug made
     * the other repeat.
     *
     * The desktop's condition is being narrowed to 404 as well, but that is the caller's half. This is
     * the half that cannot be bypassed: an existing thread is LEFT ALONE and reported as-is, so no
     * client — retrying, replaying, or simply confused — can erase a share by asking to create.
     */
    const existing = await deps.threads.get(teamId, threadId);
    if (existing) {
      /**
       * 200, not 201: nothing was created. And deliberately not a 409 — the caller's intent ("there
       * should be a thread here") is satisfied, and turning that into an error would make the desktop
       * report a failure for a state that is entirely correct.
       */
      return c.json({ thread: existing }, 200);
    }

    const thread = await deps.threads.put({
      teamId,
      id: threadId,
      title: body.title || null,
      phaseContext: body.phaseContext || null,
      aiProvider: body.aiProvider || null,
      createdById: id,
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ thread }, 201);
  });

  ai.post("/teams/:teamId/threads/:threadId/share", async (c) => {
    const teamId = c.req.param("teamId");
    const threadId = c.req.param("threadId");
    const denied = await requireAiConversationWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const body = await c.req.json().catch(() => ({}));
    const now = new Date().toISOString();

    const prior = await deps.threads.get(teamId, threadId);
    // Display name comes from the LOCAL users read-model, not the users table.
    const sharedByName = (await deps.users.get(id))?.name ?? null;

    const thread = await deps.threads.put({
      teamId,
      id: threadId,
      title: body.title || prior?.title || null,
      phaseContext: prior?.phaseContext ?? null,
      aiProvider: body.aiProvider || prior?.aiProvider || null,
      createdById: prior?.createdById || id,
      createdAt: prior?.createdAt || now,
      updatedAt: now,
      shared: true,
      sharedAt: now,
      sharedById: id,
      sharedByName,
    });

    // Cross-service notification travels as an event, not a direct call.
    await deps.events.publish({
      source: "ai-service",
      type: "ai.thread-shared",
      // `userId` mirrors `sharedById` — evaluation's activity projection reads `userId` and
      // skipped every share, so `aiThreadsShared` never moved. Additive.
      detail: { teamId, threadId, sharedById: id, userId: id },
    });

    return c.json({ thread });
  });

  /**
   * Resolve a thread-keyed route's owning team, then authorize the caller against
   * it. Returns the Response to short-circuit with, or the thread to proceed with.
   *
   * The thread-keyed routes below receive no teamId, so this is the only way they
   * can apply the SAME team rules as their /teams/:teamId/* siblings. A missing
   * thread 404s before any authz call, which is also the cheaper order.
   *
   * A 404 for a thread that exists but belongs to another team would confirm the id
   * is real; the 403 from the guard is deliberate — the caller learns they may not
   * have it, which they already knew, and nothing about whose it is.
   *
   * THE CONTENT GUARDS, matching the /teams/:teamId/* siblings exactly. These
   * MUST move with them: a thread id resolves to a team, so leaving these on the wider
   * administration predicate would let an ADMIN read any team's whole conversation by
   * naming a thread instead of a team — the same disclosure through a different door.
   */
  async function resolveThreadForAccess(
    c: Context,
    threadId: string,
    mode: "read" | "write"
  ): Promise<Response | AiThread> {
    const thread = await deps.threads.getById(threadId);
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    const denied =
      mode === "write"
        ? await requireAiConversationWrite(c, deps.teamAccess, thread.teamId)
        : await requireTeamContentRead(c, deps.teamAccess, thread.teamId);
    return denied ?? thread;
  }

  ai.get("/threads/:threadId/messages", async (c) => {
    const threadId = c.req.param("threadId");

    // Conversations are the most sensitive content this service holds. Read access
    // is decided by the thread's TEAM, resolved from the id (see above) — without
    // it, a known thread id dumped another team's entire chat history.
    const resolved = await resolveThreadForAccess(c, threadId, "read");
    if (resolved instanceof Response) return resolved;

    /**
     * ── THREE READ SHAPES ON ONE ROUTE, CHOSEN BY QUERY PARAMS ──────────────────────────────
     *
     * A multi-day workshop thread grows without bound, so returning the whole transcript on every
     * open and every live poll is the cost the desktop asked to stop paying. All three are bounded
     * reads on the `createdAt` RANGE key — no scan, no GSI.
     *
     *   ?since=<ISO>            incremental: only messages newer than `since`, ascending. The live
     *                           refresh sends the newest row it has and appends what comes back.
     *   ?limit=<n>[&before=ISO] paginated: one newest-first page of ≤ n messages older than `before`
     *                           (omit `before` for the newest page), plus `{ nextBefore }` to fetch
     *                           the page above as the user scrolls up. Page is returned ascending.
     *   (no params)             the whole thread, ascending — unchanged, so any caller or older
     *                           desktop build keeps working.
     *
     * `since` and `limit` are mutually exclusive in practice; if both arrive, `since` wins because
     * an incremental tail is never paginated.
     */
    const since = c.req.query("since");
    if (since) {
      const messages = await deps.messages.listByThreadSince(threadId, since);
      return c.json({ messages });
    }

    const limitRaw = c.req.query("limit");
    if (limitRaw) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_MESSAGE_PAGE) {
        return c.json({ error: `limit must be an integer in 1..${MAX_MESSAGE_PAGE}` }, 400);
      }
      const before = c.req.query("before") || undefined;
      const page = await deps.messages.listByThreadPage(threadId, { limit: n, before });
      return c.json(page);
    }

    const messages = await deps.messages.listByThread(threadId);
    return c.json({ messages });
  });

  /**
   * ── RECORD A TURN THAT ALREADY HAPPENED ELSEWHERE ──────────────────────────
   *
   * REGRESSION RESTORED. This route existed in the monolith
   * (`apps/backend/src/ai/routes.ts:218` at 2e7d2fa~1) and was LOST in the
   * microservices split, when apps/backend was deleted. Nothing replaced it, and
   * the desktop kept calling it — so every Claude Code / Kiro / Codex transcript
   * was POSTed into a 404. The symptom: a thread row existed while
   * praimana-ai-messages held ZERO rows, which is why the portal showed empty conversations and looked like
   * an executive permissions problem.
   *
   * WHY IT CANNOT BE `POST /messages`. That route takes `{content}`, invokes the
   * model to GENERATE a reply, and publishes `ai.response-generated` with measured
   * Bedrock metrics. Here the turn already completed off-platform in a CLI on the
   * participant's machine: there are TWO messages to store, no generation must
   * occur, and no trustworthy latency or token counts exist.
   *
   * The request contract is deliberately UNCHANGED from the monolith's, so the two
   * desktop callers (cli-assistant.ts, kiro-acp.ts) work without a client release:
   *   POST /v1/ai/threads/:threadId/sync  { messages: [{role, content}, ...] }
   *
   * WHAT THIS ADDS over the monolith's version, all of which it lacked:
   *
   *  1. BOUNDS. The monolith looped over an unbounded array with one PutCommand
   *     each — an unauthenticated-shaped write amplifier, and a slow one. Capped at
   *     MAX_SYNC_MESSAGES and MAX_SYNC_CONTENT, rejected rather than truncated
   *     because silently storing half a transcript is a wrong answer that looks
   *     right.
   *  2. IDEMPOTENCY. At-least-once is the house rule and the desktop retries. The
   *     monolith minted a fresh `ulid()` per message per call, so every retry
   *     DUPLICATED the whole turn in the reader's view. Ids are now derived
   *     deterministically from (threadId, clientTurnId, index) when the caller
   *     supplies `clientTurnId`, so a replay overwrites rather than appends.
   *     Without one the old append behaviour stands, which keeps the current
   *     desktop working while it is unaware of the field.
   *  3. ROLE VALIDATION. `msg.role` was written through unchecked, so a typo
   *     produced messages that render as neither user nor assistant.
   *
   * TIMESTAMPS are server-stamped, not client-supplied. `GET /threads/:threadId/
   * timing` computes user-time vs AI-time from these values, so an untrusted clock
   * corrupts a metric that already ships. The `+i` offset preserves within-batch
   * order under the table's (threadId, createdAt) key — the monolith's one good
   * idea here, kept. The cost is honest and documented in timing.ts's
   * measured-vs-inferred caveat: a synced turn's stamps are when we RECORDED it,
   * not when the participant lived it.
   *
   * AN EVENT IS NOW PUBLISHED, BUT COUNT ONLY. This note previously read "NO EVENT IS
   * PUBLISHED", reasoning that `ai.response-generated` carries latency and token counts a CLI
   * turn cannot honestly supply. That half is still true and still honoured — no timing or
   * token field is sent. What was too broad was omitting the event entirely: it made CLI work
   * invisible to every activity figure, so a team using Claude Code as the platform recommends
   * counted zero AI usage. See the publish site at the end of this handler.
   *
   * AUTHZ is the same member-only gate as every other route here, via
   * resolveThreadForAccess(..., "write").
   *
   * ⚠ IT NO LONGER REFUSES AN EXECUTIVE, and the comment used to say it did. That refusal was silent
   * data loss: an executive's conversation was answered locally and every push returned
   * `403 {"error":"Read-only role"}` at thread create, so a 6,522-character transcript existed on one
   * laptop and nowhere else. `requireAiConversationWrite` permits a MEMBER of any role here; the team's
   * work product (submissions, scores, docs, commits) is still closed to read-only roles.
   *
   * `userId` comes from the verified identity and is NEVER accepted from the body.
   */
  ai.post("/threads/:threadId/sync", async (c) => {
    const threadId = c.req.param("threadId");

    const resolved = await resolveThreadForAccess(c, threadId, "write");
    if (resolved instanceof Response) return resolved;

    const { id: actorId } = requireIdentity(c);
    const body = await c.req.json().catch(() => ({}));

    const messages: unknown = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages array is required" }, 400);
    }
    if (messages.length > MAX_SYNC_MESSAGES) {
      return c.json(
        { error: `too many messages: ${messages.length} > ${MAX_SYNC_MESSAGES}` },
        400
      );
    }

    // Validate the WHOLE batch before writing any of it, so a bad element cannot
    // leave a half-stored turn behind.
    const clientTurnId =
      typeof body.clientTurnId === "string" && body.clientTurnId.trim()
        ? body.clientTurnId.trim().slice(0, 128)
        : "";

    const parsed: Array<{
      role: "user" | "assistant";
      content: string;
      latencyMs?: number;
      /** CLI-reported token counts, on the same footing as `latencyMs` — see the parse loop. */
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
      reasoningOutputTokens?: number;
      /** 0..100 context fullness, Kiro only. A state, not a count — see the parse loop. */
      contextUsagePercent?: number;
      /**
       * Set when this "assistant reply" was the client's own failure output and its content has been
       * replaced. Carried through the loop so the activity count below can exclude it: a failed turn
       * is stored (the exchange happened) but must never be CREDITED as AI usage.
       *
       * Not persisted — it is a decision about this batch, not a fact about the message. The stored
       * row is simply a short assistant message with no latency.
       */
      clientError?: boolean;
      /** The real local time, when the client supplied a usable one — see the parse loop. */
      createdAt?: string;
    }> = [];
    for (const raw of messages) {
      const msg = (raw ?? {}) as {
        role?: unknown;
        content?: unknown;
        latencyMs?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
        cachedInputTokens?: unknown;
        cacheWriteInputTokens?: unknown;
        reasoningOutputTokens?: unknown;
        contextUsagePercent?: unknown;
        createdAt?: unknown;
      };
      if (msg.role !== "user" && msg.role !== "assistant") {
        return c.json({ error: "each message needs role 'user' or 'assistant'" }, 400);
      }
      const content = typeof msg.content === "string" ? msg.content : "";
      if (!content.trim()) {
        return c.json({ error: "each message needs non-empty content" }, 400);
      }
      if (content.length > MAX_SYNC_CONTENT) {
        return c.json(
          { error: `message too long: ${content.length} > ${MAX_SYNC_CONTENT}` },
          400
        );
      }
      /**
       * `latencyMs` — MEASURED assistant time for a CLI turn, optional.
       *
       * The desktop spawns the CLI itself, so it genuinely knows when the turn started
       * and when the process closed. That is a real measurement, not an estimate, and it
       * is the only way GET /threads/:threadId/timing can report AI time for a turn that
       * happened off-platform (timing.ts sums `latencyMs`, which until now only the
       * Bedrock path produced — so CLI threads reported ZERO AI time while showing large
       * inferred user gaps, i.e. exactly backwards).
       *
       * Accepted ONLY on an assistant message and only when it is a sane positive
       * number. A client-supplied duration is weaker evidence than a server-side
       * measurement, so it is bounded rather than trusted: a wrong or hostile value here
       * would corrupt a figure people read as productivity. Absent or invalid → omitted,
       * and the rollup treats the turn as having no measured AI time, which is the honest
       * answer rather than a zero that looks like an instant reply.
       */
      let latencyMs: number | undefined;
      if (msg.role === "assistant" && msg.latencyMs !== undefined) {
        const n = msg.latencyMs;
        if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_SYNC_LATENCY_MS) {
          latencyMs = Math.round(n);
        }
      }

      /**
       * `inputTokens` / `outputTokens` — MEASURED by the CLI, optional, and admitted on exactly the terms
       * `latencyMs` is.
       *
       * ⚠ THESE ARE REPORTED, NOT ESTIMATED, and that distinction is the whole reason they are allowed. The
       * note further down this file says no token counts are sent for a CLI turn because "a CLI turn has no
       * trustworthy latency or token counts" — written when nothing measured them. Codex's own
       * `turn.completed` does: `{"usage":{"input_tokens":13027,…,"output_tokens":61}}`. So the objection
       * stands where it was aimed (do not invent numbers) and does not apply to a number the tool states.
       *
       * ⚠ AND THEY STILL DO NOT GO NEAR THE ACTIVITY EVENT. That payload feeds a rating a human is judged
       * by; these are message metadata, read back only by the descriptive timing rollup. The event below is
       * deliberately unchanged.
       *
       * Bounded like the latency, and for the same reason: a client-supplied figure is weaker evidence than
       * a server measurement, and a wrong or hostile value would corrupt a number people read as cost.
       * Absent or invalid → omitted, so the rollup can report coverage instead of implying a zero.
       */
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cachedInputTokens: number | undefined;
      let cacheWriteInputTokens: number | undefined;
      let reasoningOutputTokens: number | undefined;
      if (msg.role === "assistant") {
        const sane = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_SYNC_TOKENS
            ? Math.round(v)
            : undefined;
        inputTokens = sane(msg.inputTokens);
        outputTokens = sane(msg.outputTokens);
        cachedInputTokens = sane(msg.cachedInputTokens);
        cacheWriteInputTokens = sane(msg.cacheWriteInputTokens);
        reasoningOutputTokens = sane(msg.reasoningOutputTokens);

        /**
         * ⚠ A CACHE FIGURE LARGER THAN THE PROMPT IS DROPPED, NOT CLAMPED. `cached / input` is shown to
         * participants as a savings percentage, so a cache count exceeding the prompt would render as over
         * 100% saved — or, clamped, as a fabricated 100%. Neither is a measurement, and this is untrusted
         * client input feeding a figure meant to teach people something true.
         */
        if (
          cachedInputTokens !== undefined &&
          (inputTokens === undefined || cachedInputTokens > inputTokens)
        ) {
          cachedInputTokens = undefined;
        }
      }

      /**
       * ── ⚠ CONTEXT FULLNESS, ADMITTED ON THE SAME TERMS AND BOUNDED DIFFERENTLY ────────────
       *
       * THE SYMPTOM: the portal showed no context-usage percentage for Kiro chats.
       *
       * Kiro's `_kiro.dev/metadata` frame states how full the conversation's window is. It is REPORTED by
       * the agent, not estimated by us, which is what admits it here at all — the same basis as the token
       * counts above.
       *
       * ⚠ ITS BOUND IS 0..100, NOT `MAX_SYNC_TOKENS`, because it is a PERCENTAGE and not a quantity. Reusing
       * the token ceiling would accept `4,000,000` as a context percentage and the portal would render it.
       *
       * ⚠ AND AN OUT-OF-RANGE VALUE IS DROPPED, NOT CLAMPED — the same rule as the cache figure two blocks
       * up, for the same reason. Clamping 140 to 100 would state "this conversation is full" on evidence
       * already known to be wrong, and a participant would compact a chat that did not need it. Absent is
       * honest; a fabricated maximum is not.
       *
       * ⚠ ASSISTANT-ONLY. The reading describes the state after the agent replied; on a user message there
       * is nothing it could be a measurement of.
       */
      let contextUsagePercent: number | undefined;
      if (msg.role === "assistant" && msg.contextUsagePercent !== undefined) {
        const n = msg.contextUsagePercent;
        if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100) {
          contextUsagePercent = Math.round(n);
        }
      }

      /**
       * ── A CLIENT'S OWN FAILURE OUTPUT IS NOT AN ASSISTANT REPLY ──
       *
       * Reported: a participant's CLI failed to reach Bedrock and printed a raw IAM refusal — an
       * account id, a role ARN, an action name — which was synced as the turn's "reply" and rendered
       * to an executive in the portal.
       *
       * Replaced HERE, at the boundary, rather than hidden in the UI, for three reasons. The portal
       * is not the only reader. The disclosure would otherwise stay in the table for the next reader
       * to find. And — the deciding one — a stored failure counts as an assistant turn, so it
       * increments `aiTurns` and inflates the counters that RANK PEOPLE. Only filtering here fixes
       * the numbers as well as the display.
       *
       * ⚠ THREE THINGS DELIBERATELY NOT DONE:
       *   · the batch is NOT refused — the user's own message in it is legitimate content;
       *   · the turn is NOT dropped — a user message with no reply reads as an unanswered question
       *     rather than a broken tool, which is a worse lie than a placeholder;
       *   · USER messages are never filtered. If a participant pastes an IAM error to ask about it,
       *     that is exactly the conversation this platform hosts.
       *
       * `latencyMs` goes with it: time spent failing is not AI time, and leaving it would put the
       * duration of a crash into a figure people read as productivity.
       *
       * ⚠ AND SO DO THE TOKEN COUNTS, for exactly the same reason — the tokens a crash consumed are not
       * the tokens of a reply. `parsed.push` below omits all three by constructing the entry without them,
       * so a new metric cannot be forgotten here: it has to be added deliberately.
       */
      /**
       * ⚠ NOT A METRIC, AND THAT IS A SCOPE DECISION RATHER THAN AN OVERSIGHT.
       *
       * A metric was briefly added here, counting these as "assistant failures". It was WRONG and was
       * removed: THE PLATFORM DOES NOT CONTROL WHICH ASSISTANT A PARTICIPANT USES. Claude Code on
       * subscription auth, Codex and Kiro do not go anywhere near Bedrock, so a failure caught by
       * `isClientErrorContent` is not a Bedrock refusal, is not attributable to this account, and is
       * not something an operator here could act on. Paging somebody about a stranger's expired
       * credentials is the fastest way to teach a room to ignore an alarm.
       *
       * The Bedrock signal that IS ours covers the one Bedrock caller this platform owns — insights
       * generation. See `emitBedrockRefusal` and `analyst.bedrock.ts`.
       *
       * The SCRUBBING below stays exactly as it was, for the three reasons in the block above: it is
       * not observability, it is a disclosure fix and a correctness fix for `aiTurns`.
       */
      const isClientError = msg.role === "assistant" && isClientErrorContent(content);
      if (isClientError) {
        parsed.push({ role: msg.role, content: CLIENT_ERROR_PLACEHOLDER, clientError: true });
        continue;
      }

      /**
       * ── ⚠ A CLIENT-SUPPLIED TIMESTAMP, VALIDATED BECAUSE IT FEEDS A MEASUREMENT ──────────
       *
       * THE SYMPTOM: team time showed 0s and gaps went uncounted. Because this route
       * fabricated `now + i` and flagged the rows `synced`, `timing.ts` refused to infer ANY user
       * compose time — honestly, since 1ms gaps describe a for-loop rather than a person.
       *
       * The desktop has the real times (`chat_messages.created_at`) and now sends them, so a CLI
       * thread can report real thinking time instead of a refusal.
       *
       * ⚠ BUT IT IS UNTRUSTED INPUT ON A PATH THAT FEEDS THE COUNTERS RANKING PEOPLE, so it is bounded
       * rather than believed. A far-future stamp would invent an enormous idle gap for whoever comes
       * next; a far-past one would make the thread look like it began last year. Anything that fails
       * these checks is DROPPED, not rejected — the message itself is legitimate and refusing the whole
       * batch over a bad clock would lose real content to a cosmetic problem. Dropping it falls back to
       * the fabricated stamp, which is where we already were.
       */
      let createdAt: string | undefined;
      if (typeof msg.createdAt === "string") {
        const at = Date.parse(msg.createdAt);
        const skewAhead = at - Date.now();
        if (
          Number.isFinite(at) &&
          skewAhead < MAX_CLOCK_SKEW_AHEAD_MS &&
          Date.now() - at < MAX_TIMESTAMP_AGE_MS
        ) {
          createdAt = new Date(at).toISOString();
        }
      }

      parsed.push({
        role: msg.role,
        content,
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
        ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
        ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
        ...(createdAt ? { createdAt } : {}),
      });
    }

    const now = Date.now();
    const stored = [];
    for (let i = 0; i < parsed.length; i++) {
      const msg = parsed[i];
      stored.push(
        await deps.messages.put({
          threadId,
          // Deterministic when the caller identifies the turn — that is what makes
          // a retry converge instead of duplicating. See note 2 above.
          id: clientTurnId ? `sync-${clientTurnId}-${i}` : ulid(),
          role: msg.role,
          content: msg.content,
          /**
           * The client's real time when it gave us one; otherwise the fabricated `now + i` this route
           * has always used. Which of the two it is decides `synced` below.
           */
          createdAt: msg.createdAt ?? new Date(now + i).toISOString(),
          ...(msg.role === "user" ? { userId: actorId } : {}),
          ...(msg.latencyMs !== undefined ? { latencyMs: msg.latencyMs } : {}),
          /**
           * The CLI's own token counts. `AiMessage` has carried these fields since the monolith
           * (`domain.ts`) and nothing had ever populated them for a CLI turn — the desktop is the only
           * thing that sees them, and it now sends them.
           */
          ...(msg.inputTokens !== undefined ? { inputTokens: msg.inputTokens } : {}),
          ...(msg.outputTokens !== undefined ? { outputTokens: msg.outputTokens } : {}),
          ...(msg.cachedInputTokens !== undefined
            ? { cachedInputTokens: msg.cachedInputTokens }
            : {}),
          ...(msg.cacheWriteInputTokens !== undefined
            ? { cacheWriteInputTokens: msg.cacheWriteInputTokens }
            : {}),
          ...(msg.reasoningOutputTokens !== undefined
            ? { reasoningOutputTokens: msg.reasoningOutputTokens }
            : {}),
          /**
           * How full the window was when the agent finished. Kiro only, and stored per-turn rather than
           * rolled up here — the thread-level answer is the LAST reading, which `timing.ts` computes.
           */
          ...(msg.contextUsagePercent !== undefined
            ? { contextUsagePercent: msg.contextUsagePercent }
            : {}),
          /**
           * `synced: true` — these timestamps are FABRICATED (`now + i`), so the gaps
           * between them describe a for-loop, not a person.
           *
           * timing.ts keys on this flag to refuse inferring user compose time across
           * either endpoint of such a gap (timing.ts:222). Omitting it — which the
           * restored route did until now — would have made a two-message turn synced 1ms
           * apart look like a user who read and replied in one millisecond, dragging every
           * average toward zero. The monolith set it for exactly this reason and the flag
           * has been on AiMessage all along; the restore dropped it.
           *
           * `latencyMs` is unaffected: AI time is MEASURED by the desktop that ran the
           * turn, so it stays trustworthy even though these createdAt values are not.
           */
          /**
           * ⚠ ONLY WHEN THE STAMP IS OURS. `synced: true` is what makes `timing.ts` refuse to infer a
           * user gap across this row, and that refusal is right for a fabricated `now + i` stamp —
           * "read and replied in one millisecond" would drag every average to zero.
           *
           * It is WRONG for a real client timestamp. Keeping the flag on a row whose time is genuine
           * was the whole reason "team time" read 0s with "5 gaps not counted": the data to measure had
           * arrived and the flag still said do not trust it.
           */
          ...(msg.createdAt ? {} : { synced: true }),
        })
      );
    }

    /**
     * ── THE THREAD'S `updatedAt` MOVES WITH ITS MESSAGES ────────────────────────────────────
     *
     * ⚠ IT DID NOT, AND THAT WAS A VISIBLE BUG. `updatedAt` was written by CREATE and SHARE and by
     * nothing else, so a thread messaged every day still reported the moment it was made. The portal's
     * conversation list SORTS by `updatedAt || createdAt` and so put a week-old chat at the top
     * labelled with its creation date, even though it had been updated since. `ai.tokenUsage`'s `at` field reads the same attribute and was wrong the
     * same way.
     *
     * ⚠ `touch`, NOT `put` — see the note on the interface. A full-item write here can wipe a share
     * that landed since this route read the thread, which has happened to a real row in this table.
     *
     * ⚠ AFTER the messages, and AWAITED. After, because a sync that failed to store must not advertise
     * activity it did not record; awaited, because the desktop refetches the thread list immediately
     * after a sync and a fire-and-forget update loses that race often enough to look like the bug this
     * fixes. `touch` swallows a missing row, so this cannot fail a sync whose messages are already in.
     *
     * ⚠ THE STAMP IS THIS SERVER'S CLOCK, NOT THE CLIENT'S — deliberately, and unlike the messages
     * above, which honour `msg.createdAt`. "When did the server last hear about this thread" is what a
     * list orders by, and a device with a skewed clock must not be able to pin its thread to the top
     * of a facilitator's list, nor bury it.
     */
    if (stored.length > 0) {
      await deps.threads.touch(resolved.teamId, threadId, new Date().toISOString());
    }

    /**
     * PUBLISH THE TURNS — count only, no fabricated metrics.
     *
     * ── WHY THIS REVERSES "NO EVENT IS PUBLISHED" ──
     *
     * The note above this route argued that publishing `ai.response-generated` would mean
     * "inventing numbers that feed a rating a human is judged by", because a CLI turn has no
     * trustworthy latency or token counts. That objection is CORRECT and is still honoured:
     * neither `latencyMs`, `firstTokenMs`, `inputTokens` nor `outputTokens` is sent here.
     *
     * But the CONCLUSION was too broad. "This turn happened" is a real observation, not an
     * estimate — the desktop ran the CLI and we are storing the messages it produced. Omitting
     * the event entirely made CLI work invisible to every activity figure, so a team using
     * Claude Code exactly as the platform recommends counted ZERO on AI usage while an in-app
     * team counted every turn. For a rough retrospective signal that was a documented gap
     * (BACKLOG 6c); for a judged cross-team comparison it selects the wrong winner, which is
     * what makes it worth fixing now.
     *
     * ── ASSISTANT TURNS, NOT MESSAGES ──
     *
     * One assistant reply is one turn, matching what the Bedrock path publishes per invoke. A
     * two-message sync (user + assistant) is therefore ONE turn, not two — counting messages
     * would make the CLI path score double per exchange against the in-app path.
     *
     * Zero assistant messages ⇒ no event. A sync carrying only user text has no turn to count,
     * and publishing `aiTurns: 0` would burn a Lambda invoke to increment nothing.
     *
     * ── FIRE AND FORGET, AND NOT AWAITED INTO THE RESPONSE PATH ──
     *
     * The messages are already stored; that write is the source of truth. A publish failure
     * must not fail a sync the desktop cannot easily retry, so this follows the same
     * fire-and-forget contract every other publisher here uses.
     *
     * ⚠ AT-LEAST-ONCE MEANS THIS CAN DOUBLE-COUNT WITHOUT `clientTurnId`. The message writes
     * are idempotent when the caller supplies one (deterministic ids above), but the EVENT is
     * not — EventBridge assigns its own id per publish, so a client retrying a sync without a
     * `clientTurnId` converges the messages and adds the turns twice. The desktop sends one;
     * this is recorded rather than silently accepted because a caller that omits it inflates
     * its own team's count.
     */
    /**
     * ⚠ FILTERED TURNS ARE EXCLUDED FROM THE COUNT, and this is the half of the client-error fix
     * that is not about disclosure at all.
     *
     * A CLI failure stored as an assistant message would otherwise increment `aiTurns` — so a
     * participant whose credentials expired would be CREDITED with AI usage for every failed
     * attempt, on the counters that feed a model-written assessment of how well they work with an
     * assistant. The more their tooling was broken, the better they would score.
     *
     * Counted from `parsed` rather than `stored` because the flag is a decision about the batch and
     * is deliberately not persisted on the row (see the type above).
     */
    const assistantTurns = parsed.filter(
      (m) => m.role === "assistant" && !m.clientError
    ).length;
    if (assistantTurns > 0) {
      await deps.events.publish({
        source: "ai-service",
        type: "ai.response-generated",
        detail: {
          teamId: resolved.teamId,
          threadId,
          userId: actorId,
          aiTurns: assistantTurns,
          /**
           * ── ⚠ THE FIX FOR THE DOUBLE-COUNT THE NOTE ABOVE PREDICTED ──────────────────────
           *
           * That note says a client retrying a sync "adds the turns twice", and it was right about the
           * mechanism while understating the reach: the MESSAGE writes converge on `clientTurnId`, but
           * this event does not, because EventBridge assigns a fresh id per publish and the projection
           * dedups on that id. So a re-sync left the transcript correct and incremented `aiTurns` again.
           *
           * It stopped being theoretical when the desktop grew a per-message "retry sync" button: every
           * press on an already-delivered turn inflated the counters that feed a model-written
           * assessment of a named person.
           *
           * A key derived from `clientTurnId` is stable across every retry of THIS turn and unique
           * across turns — the same property that makes the message ids converge — so the projection can
           * claim it once. `evaluation/handler.ts` prefers this over EventBridge's id.
           *
           * ⚠ OMITTED WITHOUT A `clientTurnId`, deliberately. There is then nothing stable to key on,
           * and inventing one from the content or the clock would either collapse two distinct turns
           * into one claim or fail to match the retry it exists for. Those callers keep the old
           * at-least-once behaviour, which the note above already documents as their cost.
           */
          ...(clientTurnId ? { dedupeKey: `ai-turn-${threadId}-${clientTurnId}` } : {}),
          /**
           * ── ⚠ NO TOKEN COUNTS ON THE EVENT, EVEN NOW THAT WE HAVE REAL ONES ──────────────
           *
           * The counts ARE stored, on the message rows above, and the portal and the desktop both report them.
           * They are kept off this payload on purpose, and the reason has changed: it is no longer "we have no
           * trustworthy numbers" — Codex states them — it is that THIS event feeds a rating a human is judged
           * by, and token counts are not a measure of anyone's skill.
           *
           * Three specific ways they would mislead if wired in as they stand:
           *
           *   1. ⚠ ONLY ONE ASSISTANT REPORTS THEM. Codex does; Claude's spawn path and Kiro do not. A
           *      participant using the assistant this platform recommends would score ZERO tokens and be rated
           *      on their TOOL CHOICE. That is the same defect as the one recorded above this route, where CLI
           *      work counted zero on AI usage and "selects the wrong winner".
           *   2. ⚠ `inputTokens` GROWS WITH THE CONVERSATION, since every turn re-sends the context. It rewards
           *      short sessions and penalises thorough ones, which is the opposite of the behaviour a workshop
           *      wants to encourage.
           *   3. ⚠ IT IS TRIVIALLY GAMEABLE by anyone who understands it, and a counter that can be gamed
           *      stops measuring the thing and starts measuring who knows how it works.
           *
           * `token-in-rating.test.ts` asserts they stay out. Wiring them in needs coverage across all three
           * assistants FIRST, and a defensible per-turn normalisation — not a raw sum.
           *
           * `latencyMs` / `firstTokenMs` remain absent for the original reason: no server-measured value.
           */
        },
      });
    }

    return c.json({ synced: stored.length });
  });

  /**
   * ── THIS ROUTE NO LONGER INVOKES A MODEL, AND THAT IS THE POINT ──
   *
   * It used to accept a user message, call Bedrock with the FULL thread history, and persist the
   * reply. It was removed because team-member chats do not call Bedrock, and never did.
   *
   * WHAT ACTUALLY HAPPENS IN THIS PRODUCT: the desktop app drives the participant's OWN local CLI
   * (Claude Code, Kiro, Codex — see `cliSend` / `kiroAcpSend`) and POSTs the finished transcript to
   * `/threads/:threadId/sync` above. No model call, and the participant's own subscription pays for
   * their assistant. This route was a leftover from the monolith's in-app chat.
   *
   * EVERY POST CALLER WAS DEAD, verified rather than assumed:
   *   · the portal only ever GETs this path (reading a transcript)
   *   · `ai:stream` in desktop/main/handlers/ai.ts posted here and is bridged as `api.aiStream` —
   *     with ZERO renderer callers
   *   · `/api/desktop/sync-message` looped POSTing transcript messages here, with no caller of its
   *     own — and it was the worst-shaped hazard on the platform: syncing a 20-message transcript
   *     would have fired 20 Bedrock invocations to "record" a conversation that had already happened
   *
   * So this was an authenticated, unbounded, billable route with no legitimate traffic — the shape
   * of thing whose abuse nobody would notice, because there is no normal usage to compare against.
   *
   * ── WHY 410 AND NOT DELETION ──
   *
   * The path stays mapped and answers 410 Gone. Deleting the handler would let the greedy
   * `ANY /v1/ai/{proxy+}` mapping deliver POSTs here anyway and produce Hono's bare 404 — which is
   * exactly how the board's dead "Analyze Chat" button hid for months, indistinguishable from a
   * typo. 410 says "this existed and was withdrawn", which is the truth and is actionable.
   *
   * AUTHZ STILL RUNS FIRST. A caller who is not a member of the thread's team gets their 403 rather
   * than learning the route is gone — the refusal a non-member gets must not depend on whether the
   * feature exists.
   *
   * IF IN-APP CHAT IS EVER WANTED, this is not the thing to restore. It needs, at minimum: a
   * timeout on the Bedrock call (this one had NONE, in violation of the standing rule — the ratings
   * analyst has connect/socket/abort and this never got them), a cap on the history it replays (it
   * sent EVERY message every turn, so cost grew quadratically with conversation length), and a
   * per-team spend budget.
   */
  ai.post("/threads/:threadId/messages", async (c) => {
    const threadId = c.req.param("threadId");

    // Authorization BEFORE the withdrawal notice, deliberately: "you may not touch this team's
    // threads" is a different answer from "this feature is gone", and a non-member is entitled to
    // the first one regardless of what happened to the second.
    const resolved = await resolveThreadForAccess(c, threadId, "write");
    if (resolved instanceof Response) return resolved;

    return c.json(
      {
        error:
          "In-app AI chat was withdrawn. Assistant transcripts are recorded by the desktop app via POST /v1/ai/threads/:threadId/sync, which stores turns without invoking a model.",
        code: "AI_CHAT_WITHDRAWN",
      },
      410
    );
  });

  /**
   * Per-thread timing rollup — user time vs. AI time for the whole session.
   *
   * Computed ON READ from the messages this one Query already returns; nothing is
   * stored on AiThread. The reasoning (and the measured-vs-inferred caveat the
   * response shape carries) is documented in timing.ts.
   */
  // ═══ TEAM AI RATINGS ═══════════════════════════════════════════════════════
  //
  // Four routes, two audiences, and the split is the security boundary. See the domain
  // types and `requirePublishedSummaryRead` for the full reasoning; in short:
  //
  //   per-member assessments come from members' MESSAGE TEXT      → members only, never
  //                                                                 published
  //   the team summary comes from FIVE INTEGERS per member        → publishable to judges
  //                                                                 and off-team executives
  //
  // An EXECUTIVE who is on the team reads everything a teammate reads, with no special case:
  // `canReadContent` is pure membership. A JUDGE fails that and reaches only a PUBLISHED
  // summary, on the snapshot's own server-derived workshopId.

  /**
   * Generate an analysis. The ONLY route that invokes a model for ratings.
   *
   * TWO CALLS, and the separation is the whole security design:
   *
   *   A. members' own AI + team-chat text  → per-member aiKnowledgeScore, strengths,
   *                                          improvements. Member-only. Never published.
   *   B. five integers per member          → the team summary. Publishable, precisely
   *                                          because no text entered its prompt.
   *
   * They are separate invocations against separate inputs, so B's output cannot contain
   * anything from A's. That is a property of the wiring, not of a prompt instruction — and a
   * prompt is not an authorization boundary, because instruction-following is probabilistic
   * and authorization cannot be.
   *
   * MEMBER WRITE, so a read-only EXECUTIVE cannot generate even on their own team, and a
   * judge cannot generate at all.
   */
  ai.post("/teams/:teamId/ratings/analyze", async (c) => {
    const teamId = c.req.param("teamId");
    if (!deps.ratings || !deps.analyst || !deps.teamChat || !deps.counters) {
      return ratingsUnavailable(c);
    }

    // EXECUTIVE-ONLY, and a MEMBER of this team. NOT
    // requireTeamContentWrite: that refuses every read-only role, and EXECUTIVE *is* the
    // read-only role — the inverse of what this route needs. Reading is still member-wide;
    // only TRIGGERING moved. See requireAssessmentGenerate.
    const denied = await requireAssessmentGenerate(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id: actorId } = requireIdentity(c);

    // COOLDOWN before any work. The counters are event-fed and move slowly, so a re-run
    // inside the window costs a full invoke to produce near-identical text. The existing
    // snapshot rides along so the UI still has something to render.
    const existing = await deps.ratings.latest(teamId);
    if (existing) {
      const age = Date.now() - Date.parse(existing.generatedAt);
      if (Number.isFinite(age) && age >= 0 && age < RATING_COOLDOWN_MS) {
        const retryAfterMs = RATING_COOLDOWN_MS - age;
        /**
         * Retry-After, IN SECONDS, alongside the millisecond value in the body.
         *
         * It was missing, and this is the one route on the platform that already sheds load — so
         * it was shedding it unobservably to everything except our own UI. Every generic HTTP
         * client, proxy and library reads this header; `retryAfterMs` is ours alone. Both, because
         * the header is the standard and the body value is finer-grained (the portal renders a real
         * countdown from it). Ceiling, not floor: rounding 1.4s down to 1 invites a retry that is
         * still too early.
         */
        c.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        emitRefusalMetric("COOLDOWN", teamId, actorId);
        return c.json(
          {
            error: "An analysis was generated recently.",
            code: "ANALYSIS_COOLDOWN",
            retryAfterMs,
            analysis: existing,
          },
          429
        );
      }
    }

    /**
     * ── THE GENERATION LEASE ──
     *
     * The cooldown above compares the STORED snapshot's age, and the store is written at the END of
     * a generation — up to RATING_TOTAL_TIMEOUT_MS (45s) after that check. Two requests entering
     * the window together both read the same snapshot, both pass, and both generate: one Bedrock
     * call per member plus a summary, twice. At MAX_RATED_MEMBERS = 10 that is 22 model
     * invocations for one intended analysis, and the loser's snapshot is silently superseded so
     * `generatedById` records whoever finished last rather than whoever asked.
     *
     * Two clicks in two tabs is enough; the button's `disabled` state does not span tabs, and the
     * desktop app and curl bypass the UI entirely.
     *
     * AFTER THE AUTHZ GUARD AND AFTER THE COOLDOWN, BEFORE THE FIRST MODEL CALL. Claiming earlier
     * would let an unauthorized caller deny a team its generation by holding the lease — the same
     * reasoning that puts requireAssessmentGenerate ahead of everything else.
     */
    const claimed = await deps.ratings.claimGeneration(teamId, actorId, Date.now());
    if (!claimed) {
      /**
       * A DISTINCT CODE FROM THE COOLDOWN, because the two need different sentences. "Someone on
       * your team is generating this right now — about 30 seconds" is not "one was generated four
       * minutes ago, wait six more". Collapsing them would tell an operator to wait ten minutes for
       * something finishing imminently.
       */
      c.header("Retry-After", String(Math.ceil(GENERATION_LEASE_MS / 1000)));
      emitRefusalMetric("IN_PROGRESS", teamId, actorId);
      return c.json(
        {
          error: "An analysis for this team is already being generated.",
          code: "ANALYSIS_IN_PROGRESS",
          retryAfterMs: GENERATION_LEASE_MS,
        },
        429
      );
    }
    // ZERO ON THE ADMITTED PATH, so the metric exists in a healthy account and "no data" stays
    // distinguishable from "no refusals" — the same reasoning emitAccessAuditMetric documents.
    emitRefusalMetric("NONE", teamId, actorId);

    try {

    // ── Inputs. BOTH must be readable, or we refuse. ────────────────────────────
    //
    // "unavailable" is not "empty". Scoring someone on counters or chat we failed to read
    // would invent a story about a person who was merely unreachable — and that story then
    // gets published. Refuse instead.
    const [counters, chat] = await Promise.all([
      deps.counters.byTeam(teamId, c),
      deps.teamChat.recentByTeam(teamId, MAX_TEAM_CHAT_FETCH, c),
    ]);
    if (counters === "unavailable" || chat === "unavailable") {
      c.header("Retry-After", "2");
      return c.json(
        {
          error: "Could not read this team's activity — try again shortly.",
          code: "TEAM_ACTIVITY_UNAVAILABLE",
        },
        503
      );
    }

    if (counters.length === 0) {
      return c.json(
        {
          error: "No activity to analyse yet — build something first.",
          code: "NO_ACTIVITY",
        },
        409
      );
    }
    if (counters.length > MAX_RATED_MEMBERS) {
      // REFUSED, not truncated: an assessment that silently omits members is a wrong answer
      // that looks right.
      return c.json(
        {
          error: `This team has ${counters.length} members; analysis supports up to ${MAX_RATED_MEMBERS}.`,
          code: "TEAM_TOO_LARGE",
        },
        409
      );
    }

    // ── Handles. The model never sees a name. ───────────────────────────────────
    //
    // Opaque `M1..Mn`, mapped back server-side after validation. So the model CANNOT name an
    // individual in the published team summary — it has never seen a name. That turns "no
    // per-person attribution in B" from an instruction into a property of the input.
    const handleFor = new Map<string, string>();
    const userFor = new Map<string, string>();
    counters.forEach((m, i) => {
      const handle = `M${i + 1}`;
      handleFor.set(m.userId, handle);
      userFor.set(handle, m.userId);
    });

    // Per-member AI messages, from this service's own store.
    const threads = await deps.threads.listByTeam(teamId, false);
    const aiByUser = new Map<string, string[]>();
    for (const t of threads) {
      const msgs = await deps.messages.listByThread(t.id);
      for (const m of msgs) {
        if (m.role !== "user" || !m.userId) continue;
        const list = aiByUser.get(m.userId) ?? [];
        if (list.length < MAX_MEMBER_MESSAGES) {
          list.push(m.content.slice(0, MAX_MESSAGE_CHARS));
          aiByUser.set(m.userId, list);
        }
      }
    }

    const chatByUser = new Map<string, string[]>();
    for (const m of chat) {
      const list = chatByUser.get(m.userId) ?? [];
      if (list.length < MAX_MEMBER_MESSAGES) {
        list.push(m.content.slice(0, MAX_MESSAGE_CHARS));
        chatByUser.set(m.userId, list);
      }
    }

    // Two deadlines: one bounding the WHOLE generation, one bounding each individual call.
    // Neither alone is sufficient — see the constants.
    const overall = AbortSignal.timeout(RATING_TOTAL_TIMEOUT_MS);
    let assessments: MemberAiAssessment[];
    let teamSummary: string;
    try {
      /**
       * ONE CALL PER MEMBER, SEQUENTIALLY — the fix for a measured failure, not a refactor.
       *
       * A single prompt carrying the whole team did not work. Against the live model:
       * 5 members was clean in 4.7s; 10 members returned 1-2 of 10 rows with every score 0;
       * 25 members failed outright after 20-26s, and before the truncation guard existed it
       * returned 25 rows with EVERY rationale empty. None of those were clean errors — the
       * model silently dropped people or produced hollow coaching that would then be stored
       * and displayed as considered assessment.
       *
       * Per-member calls make the unit of work CONSTANT, so quality stops degrading with team
       * size and one member's failure costs one assessment instead of the whole generation.
       *
       * SEQUENTIAL, not parallel: concurrent invokes multiply peak spend and throttle risk on
       * a route already bounded by one function timeout.
       *
       * EACH CALL GETS ITS OWN per-call deadline, combined with the generation-wide one. A
       * single shared 9s deadline would abort a 10-member team around member 5 — measured at
       * ~1.8s each, 10 members legitimately takes ~18s.
       */
      const rawAssessments: Array<
        Awaited<ReturnType<typeof deps.analyst.assessKnowledge>>
      > = [];
      let failed = 0;
      let lastError: unknown;
      for (const m of counters) {
        try {
          rawAssessments.push(
            await deps.analyst.assessKnowledge(
              {
                handle: handleFor.get(m.userId)!,
                aiMessages: aiByUser.get(m.userId) ?? [],
                teamMessages: chatByUser.get(m.userId) ?? [],
              },
              // Whichever fires first: this member taking too long, or the generation as a
              // whole having run out of time.
              { signal: AbortSignal.any([overall, AbortSignal.timeout(RATING_MODEL_TIMEOUT_MS)]) }
            )
          );
        } catch (err) {
          // ONE MEMBER'S FAILURE IS NOT THE TEAM'S. A malformed answer for one person leaves
          // the others' coaching intact — the alternative is discarding 9 good assessments
          // because the 10th came back unparseable.
          //
          // An ABORT is different: the shared deadline has expired, so every remaining call
          // would fail too. Rethrow and let the outer catch keep the previous snapshot.
          // The GENERATION-wide deadline expiring means every remaining call would fail too,
          // so stop. A single call's own timeout is just one member's failure — skip and go on.
          if (overall.aborted) throw err;
          failed++;
          lastError = err;
          console.warn("[ratings] assessment failed for one member; continuing", {
            teamId,
            handle: handleFor.get(m.userId),
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          });
        }
      }

      // Map handles back, dropping anything the model invented. An unknown handle is a
      // hallucinated member and must not become a row.
      assessments = rawAssessments
        .filter((a) => userFor.has(a.handle))
        .map((a) => ({
          userId: userFor.get(a.handle)!,
          aiKnowledgeScore: clampScore(a.aiKnowledgeScore),
          rationale: String(a.rationale ?? "").slice(0, 400),
          strengths: cappedList(a.strengths),
          improvements: cappedList(a.improvements),
        }));

      /**
       * NOTHING STORABLE IS A FAILED GENERATION, not a partial one.
       *
       * Checked AFTER the handle filter, deliberately: an earlier check on the raw count
       * passes when every answer came back under a hallucinated handle, and the route then
       * stored a snapshot with zero assessments — which renders as "analysis complete, nobody
       * assessed" and, worse, starts the 10-minute cooldown, so the member cannot retry.
       *
       * `failed` counts calls that threw; the difference between that and the filter is what
       * distinguishes "the model errored" from "the model answered about the wrong person".
       */
      if (assessments.length === 0) {
        /**
         * TWO DIFFERENT FAILURES, AND THEY MUST NOT COLLAPSE INTO ONE ANSWER.
         *
         * EVERY call threw ⇒ the model or the network is down. That is transient, so the
         * original error propagates and the outer catch answers 503 with Retry-After — a
         * retry genuinely might work.
         *
         * Calls SUCCEEDED but nothing was storable ⇒ the model answered about people nobody
         * asked about. Retrying the same input reproduces it, so 502 is the honest answer.
         *
         * Conflating them either tells an operator to retry a deterministic failure forever,
         * or reports a Bedrock outage as malformed output and sends them reading prompts.
         */
        if (failed === counters.length && lastError !== undefined) throw lastError;
        throw new Error(
          `MODEL_RESPONSE_INVALID: no member could be assessed ` +
            `(${counters.length} requested, ${failed} errored, ` +
            `${rawAssessments.length - assessments.length} unrecognised)`
        );
      }

      // AGGREGATED, not per-member — see SummaryModelInput. A live probe showed that
      // per-member rows let the model write "one member drove the majority", which
      // identifies a person in a small team without naming one. Totals remove the
      // capability rather than asking it not to use it.
      teamSummary = await deps.analyst.summariseTeam(
        summaryInputFor(counters),
        { signal: AbortSignal.any([overall, AbortSignal.timeout(RATING_MODEL_TIMEOUT_MS)]) }
      );
    } catch (err) {
      // The previous snapshot is left INTACT on every failure path. A failed regeneration
      // must not destroy a good analysis someone may be reading.
      const aborted = err instanceof Error && err.name === "TimeoutError";

      /**
       * A BAD ANSWER IS NOT AN OUTAGE — 502, not 503.
       *
       * `MODEL_RESPONSE_INVALID` means the model replied and the reply was unusable (nothing
       * storable, a truncated generation, a summary naming somebody). That is not a transient
       * service problem, so it must not be dressed as one: a 503 with Retry-After tells the
       * caller "come back shortly and it will work", and a retry against the same input will
       * fail the same way. Same code the summary-leak check already returns, for the same
       * reason, so one class of failure has one answer.
       */
      const invalid =
        err instanceof Error && err.message.startsWith("MODEL_RESPONSE_INVALID");
      if (invalid) {
        return c.json(
          {
            error: "The analysis could not be generated from the model's response.",
            code: "MODEL_RESPONSE_INVALID",
            analysis: existing ?? null,
          },
          502
        );
      }

      c.header("Retry-After", "5");
      return c.json(
        {
          error: aborted
            ? "The analysis timed out — try again."
            : "The analysis could not be generated.",
          code: aborted ? "MODEL_TIMEOUT" : "MODEL_FAILED",
          analysis: existing ?? null,
        },
        503
      );
    }

    // The published summary must not name anyone. Belt and braces over the handle scheme:
    // the model never saw a name, and this rejects the generation if one appears anyway.
    const names = await Promise.all(
      counters.map(async (m) => (await deps.users.get(m.userId))?.name ?? "")
    );
    const leaked = names.find((n) => n && teamSummary.toLowerCase().includes(n.toLowerCase()));
    if (leaked) {
      return c.json(
        {
          error: "The generated summary referenced an individual and was discarded.",
          code: "MODEL_RESPONSE_INVALID",
          analysis: existing ?? null,
        },
        502
      );
    }

    // Server-derived, never from the request. `null` when unresolvable: the snapshot is
    // still written and the judge path simply refuses it, which beats losing an analysis
    // because a lookup blinked.
    const workshopId = deps.workshops
      ? await deps.workshops.workshopIdForTeam(teamId, c).catch(() => null)
      : null;

    const snapshot = await deps.ratings.put({
      teamId,
      generationId: ulid(),
      // SERVER-DERIVED. Never from the request — it is what gates judge access later.
      workshopId: workshopId ?? null,
      generatedAt: new Date().toISOString(),
      generatedById: actorId,
      /**
       * ⚠ THIS READ THE WRONG VARIABLE, and every stored assessment recorded "unknown".
       *
       * It was `BEDROCK_MODEL_ID` — a name nothing sets. The chat model's variable was `AI_MODEL_ID`
       * and the assessment model's is `BEDROCK_RATINGS_MODEL_ID`; neither matched, so the `??`
       * fallback fired on every generation, so every stored
       * snapshot carried `modelId: "unknown"`.
       *
       * That matters more here than a wrong string usually would. This field is the PROVENANCE of a
       * judgement about a person — which model produced the scores an executive reads and a judge
       * eventually sees. Losing it means a future "why did this member score 40?" cannot be answered,
       * and a model swap cannot be correlated with a change in scores.
       *
       * Now reads the variable the analyst itself requires (see requiredModelId), so the recorded id
       * and the invoked model cannot disagree. Still `?? "unknown"` rather than a throw: an
       * assessment that generated successfully must not be discarded because its label is missing.
       */
      modelId: process.env.BEDROCK_RATINGS_MODEL_ID ?? "unknown",
      members: assessments,
      teamSummary: teamSummary.slice(0, 1200),
      publishedAt: null,
      publishedById: null,
      // Carried in the PAYLOAD, not left in a comment: people are ranked by these numbers,
      // so what the numbers miss travels with them to the screen.
      coverage: [
        // ⚠ THIS CAVEAT WAS REWRITTEN, not deleted. It used to say CLI work was "not yet
        // reported as platform activity" — true until the sync route began publishing turn
        // counts. Leaving it would have understated the data; deleting it would have overstated
        // it, because everything before that release is still missing.
        "AI assistant turns are counted for both in-app and CLI use (Claude Code, Kiro, Codex), but only from the release that began collecting them — earlier activity is absent, not zero.",
        "Threads shared counts a button press, not assistant use: someone who worked with an assistant all day and never shared a thread contributes nothing to that number.",
        "Counts activity, not quality — a problem solved in three messages scores below one that took thirty.",
      ],
      schemaVersion: 1,
    });

    return c.json({ analysis: snapshot }, 201);
    } finally {
      /**
       * RELEASED ON EVERY EXIT — the success above, every early `return c.json(..., 4xx/5xx)` for an
       * unreadable input or an invalid model response, and any throw.
       *
       * A generation that fails at second three must not hold the lease for the remaining
       * fifty-seven: the executive's legitimate retry would be refused because of OUR fault. The
       * lease's `expiresAt` is the backstop for the one case this cannot cover — the Lambda being
       * killed mid-generation — not the normal path.
       *
       * `releaseGeneration` never throws (see the repository), so this cannot convert a stored,
       * successful analysis into a 500.
       */
      await deps.ratings.releaseGeneration(teamId);
    }
  });

  /** Latest snapshot, in full. Member-only. NEVER invokes the model. */
  ai.get("/teams/:teamId/ratings/analysis", async (c) => {
    const teamId = c.req.param("teamId");
    if (!deps.ratings) return ratingsUnavailable(c);

    // EXECUTIVE-ONLY, and a MEMBER. NOT requireTeamContentRead: that is pure
    // membership, so every teammate read every other member's score. The team SUMMARY is the
    // shared surface; per-member coaching is the executive's. See requireAssessmentRead.
    const denied = await requireAssessmentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const snapshot = await deps.ratings.latest(teamId);
    // `null` is the one legitimate empty: nothing has been generated. Distinguishable from a
    // failure, which is a non-200 — a caller must never have to guess which it got.
    return c.json({ analysis: snapshot ?? null });
  });

  /**
   * THE PROMPTS BEHIND AN ASSESSMENT — what the Analyze button is about to send.
   *
   * ── WHY THIS EXISTS ──
   *
   * The assessment scores a named person's craft and an executive presses the button. A judgement
   * that does not say how it was produced invites the two failures `InsightsMethodology` was
   * written for: distrust that cannot be argued with, and gaming that cannot be seen. The
   * heuristic score on that page already publishes its weights; the model-generated half
   * published nothing, which left the genuinely consequential number as the opaque one.
   *
   * ── ⚠ THIS ROUTE INVOKES NO MODEL, AND THAT IS WHAT MAKES IT SAFE TO CALL ON PAGE LOAD ──
   *
   * It serves two constants. No Bedrock call, no `BEDROCK_RATINGS_MODEL_ID`, no cooldown, no
   * generation lease, no spend — so it is a plain read next to a route where each press costs one
   * invoke per member. `deps.analyst` is deliberately NOT consulted: the prompts come from
   * `ratings-prompts.ts`, which the adapter also imports, so the disclosed string is necessarily
   * the sent string and the port stays out of the request path.
   *
   * ⚠ `deps.ratings` IS NOT REQUIRED EITHER. This reads no table, so gating it on the store would
   * refuse the disclosure during exactly the outage in which an executive is most likely to be
   * asking what the feature does. Only `teamAccess` is needed, for the membership half.
   */
  ai.get("/teams/:teamId/ratings/prompts", async (c) => {
    const teamId = c.req.param("teamId");

    // EXECUTIVE-ONLY, asserted on the role itself rather than through `isReadOnlyRole` — see
    // requireAssessmentPromptRead for why the alias was not reused.
    const denied = await requireAssessmentPromptRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    /**
     * THE CAPS ARE PASSED IN, not restated in the disclosure module.
     *
     * They are this file's constants and the route is the only place that knows them, so the
     * panel's "up to 40 messages, truncated to 600 characters" moves the day somebody tunes
     * either one. A second hardcoded copy in the disclosure text would be a sentence that
     * silently becomes false, in the one panel whose whole purpose is being accurate.
     */
    return c.json({
      prompts: ratingsPromptDisclosure({
        maxMemberMessages: MAX_MEMBER_MESSAGES,
        maxMessageChars: MAX_MESSAGE_CHARS,
      }),
    });
  });

  /**
   * The PUBLISHED team summary. The only route a non-member can reach.
   *
   * Returns the summary and its provenance, and NOTHING per-member: the response shape is
   * the enforcement, not a filter applied to a wider object. A filtered payload is one
   * forgotten branch away from a leak, so the per-member fields are simply not here.
   */
  ai.get("/teams/:teamId/ratings/summary", async (c) => {
    const teamId = c.req.param("teamId");
    if (!deps.ratings) return ratingsUnavailable(c);

    const snapshot = await deps.ratings.latest(teamId);
    const denied = await requirePublishedSummaryRead(
      c,
      deps.teamAccess,
      teamId,
      snapshot,
      deps.entitlements
    );
    if (denied) return denied;

    if (!snapshot) return c.json({ summary: null, generatedAt: null });
    return c.json({
      summary: snapshot.teamSummary,
      generatedAt: snapshot.generatedAt,
      publishedAt: snapshot.publishedAt,
      coverage: snapshot.coverage,
      memberCount: snapshot.members.length,
    });
  });

  /**
   * Publish the current snapshot's summary — a DISCLOSURE, not a save.
   *
   * EXECUTIVE-ONLY and a member, the SAME guard as `analyze` — and they must match, or the
   * feature is incoherent. Generating is executive-only; leaving
   * publish as a member write would have meant the person who can produce an assessment cannot
   * disclose it, while a participant decides what judges get to read. Deciding to publish a
   * team's summary to judges and off-team executives is the reviewer's judgement, so it sits
   * with the same role that generated it.
   *
   * This route previously carried the opposite comment ("an EXECUTIVE cannot publish even on
   * their own team"), which was correct under the old rule and is now wrong. Both guards move
   * together for exactly that reason.
   *
   * The generationId is required and must still be newest: publishing has to apply to the
   * snapshot the publisher was actually looking at, or a regeneration landing mid-review
   * would silently publish text nobody approved.
   */
  ai.post("/teams/:teamId/ratings/publish", async (c) => {
    const teamId = c.req.param("teamId");
    if (!deps.ratings) return ratingsUnavailable(c);

    const denied = await requireAssessmentGenerate(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id: actorId } = requireIdentity(c);
    const body = await c.req.json().catch(() => ({}));
    const generationId =
      typeof body.generationId === "string" ? body.generationId.trim() : "";
    if (!generationId) {
      return c.json({ error: "generationId is required" }, 400);
    }

    const published = await deps.ratings.publish(teamId, generationId, actorId);
    if (!published) {
      return c.json(
        {
          error:
            "That analysis is no longer the current one — review the latest and publish that.",
          code: "GENERATION_SUPERSEDED",
        },
        409
      );
    }
    return c.json({ publishedAt: published.publishedAt, generationId }, 200);
  });

  ai.get("/threads/:threadId/timing", async (c) => {
    const threadId = c.req.param("threadId");

    // Same team-read gate as the messages GET: the rollup is derived FROM those
    // messages, so leaving it open would leak a team's session shape (how long they
    // deliberated, how much they leaned on the model) to any caller.
    const resolved = await resolveThreadForAccess(c, threadId, "read");
    if (resolved instanceof Response) return resolved;

    const messages = await deps.messages.listByThread(threadId);
    return c.json({ timing: rollUpThreadTiming(threadId, messages) });
  });

  return ai;
}

/**
 * A deployment without the ratings ports wired cannot do this — which is a 503 ("not
 * available here"), never a 403 ("you may not") or a 404 ("no such thing"). Conflating a
 * missing capability with a refused one sends an operator hunting for a permissions bug.
 */
function ratingsUnavailable(c: Context): Response {
  return c.json(
    { error: "Team AI ratings are not enabled in this environment", code: "RATINGS_UNAVAILABLE" },
    503
  );
}

/** 0-100, integer. A model returning 7.5 or 300 must not reach a row. */
function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return Math.min(100, Math.max(0, v));
}

/**
 * Per-member counters → the TEAM-LEVEL input for the publishable summary.
 *
 * This function is the boundary that makes the summary safe to show a judge. Everything it
 * drops — every per-member row — is something the model could otherwise have used to single
 * somebody out, which a live probe confirmed it will do unprompted ("one member drove the
 * majority..."). See SummaryModelInput for the full note.
 *
 * `distribution` keeps the one genuinely useful team-level fact: a coefficient of variation
 * over per-member effort, bucketed. Thresholds are coarse on purpose — a finer scale would
 * invite reading a precise number back into "who", which is the thing being prevented.
 */
function summaryInputFor(
  counters: Array<{ userId: string } & RatingCounters>
): SummaryModelInput {
  const totals: RatingCounters = {
    tasksCreated: 0,
    tasksCompleted: 0,
    messagesSent: 0,
    commitsPushed: 0,
    aiThreadsShared: 0,
    aiTurns: 0,
  };
  for (const m of counters) {
    totals.tasksCreated += m.tasksCreated;
    totals.tasksCompleted += m.tasksCompleted;
    totals.messagesSent += m.messagesSent;
    totals.commitsPushed += m.commitsPushed;
    totals.aiThreadsShared += m.aiThreadsShared;
    totals.aiTurns += m.aiTurns;
  }

  // Effort per member as one number, so "uneven" means uneven overall rather than uneven in
  // whichever counter happens to be largest.
  const effort = counters.map(
    (m) =>
      m.tasksCreated +
      m.tasksCompleted +
      m.messagesSent +
      m.commitsPushed +
      m.aiThreadsShared +
      // Turns count toward "who did the work", which is the point of the distribution label:
      // a member whose contribution is mostly assistant-driven should not read as idle.
      m.aiTurns
  );
  return {
    memberCount: counters.length,
    totals,
    distribution: spreadOf(effort),
  };
}

/**
 * Coefficient of variation, bucketed. Guards the two degenerate cases explicitly: one member
 * is not "even" (there is nothing to be even between), and a team whose counters are all zero
 * would divide by zero.
 */
function spreadOf(effort: number[]): SummaryModelInput["distribution"] {
  if (effort.length < 2) return "single-member";
  const mean = effort.reduce((a, b) => a + b, 0) / effort.length;
  if (mean === 0) return "even";
  const variance =
    effort.reduce((a, b) => a + (b - mean) ** 2, 0) / effort.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv < 0.35) return "even";
  return cv < 0.75 ? "somewhat uneven" : "highly uneven";
}

/** At most three short phrases. Bounds what a UI must render and what a model can pad. */
function cappedList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .slice(0, 3)
    .map((x) => x.trim().slice(0, 200));
}
