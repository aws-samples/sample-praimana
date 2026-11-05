/**
 * AI bounded context — domain types + repository interfaces.
 *
 * The AI service owns exactly two tables: aiThreads and aiMessages. It owns NO
 * other context's data (Single Responsibility). Where it needs a user's display
 * name, it reads a local users READ-MODEL populated from `user.updated` events —
 * never the Identity service's table (see UsersReadModel below).
 */
import type { ReadModel } from "@praimana/service-shared";

export interface AiThread {
  teamId: string;
  id: string;
  title: string | null;
  phaseContext: string | null;
  aiProvider: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  shared?: boolean;
  sharedAt?: string;
  sharedById?: string;
  sharedByName?: string | null;
}

export interface AiMessage {
  threadId: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;

  /**
   * MEASURED wall-clock duration of the model call that produced this message,
   * in milliseconds. Assistant messages only.
   *
   * DEFINITION (unambiguous on purpose — see model.bedrock.ts): this is
   * time-to-COMPLETION — the invoke until the model's last token — because that
   * is the interval the user actually waited before the answer was whole. For
   * streamed responses `firstTokenMs` carries the time-to-first-token separately;
   * the two are very different numbers and collapsing them would make either
   * one meaningless.
   *
   * OPTIONAL, and absence is MEANINGFUL: `undefined` means "not measured", which
   * is NOT the same as `0`. Every message written before this field existed, and
   * every message that arrives via a desktop transcript sync (where the model
   * call happened on someone's laptop and was never timed here), has no value.
   * Rollups must count those separately rather than folding in a zero — see
   * timing.ts.
   */
  latencyMs?: number;

  /**
   * MEASURED ms from invoke to the model's FIRST content token. Set only for
   * responses this service streamed; absent for non-streamed invokes, where
   * first-token and completion are the same instant and recording it would
   * silently flatter any responsiveness average.
   */
  firstTokenMs?: number;

  /** Token counts reported by Bedrock's invocation metrics, or by the CLI for a synced turn. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * ── THE OPTIMISATION BREAKDOWN, CLI-REPORTED ────────────────────────────────────────────
   *
   * Captured so the platform can show token-optimisation savings from a MEASURED
   * figure rather than a comparison against a hypothetical.
   *
   *   cachedInputTokens     — the part of the prompt served from cache instead of re-sent. `cached / input` IS
   *                           the saving.
   *   reasoningOutputTokens — the share of the reply spent thinking rather than answering.
   *
   * Absent when nobody reported them, which is not zero: every turn before this, and every assistant that
   * reports nothing.
   */
  cachedInputTokens?: number;
  /**
   * Prompt tokens WRITTEN to the cache. Paired with `cachedInputTokens` it separates a normal first turn
   * (writes, never reads — unavoidable) from a conversation discarding its cache (keeps writing, never reads).
   * With only the read figure the two are indistinguishable, and only the second is fixable.
   */
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;

  /**
   * ── ⚠ HOW FULL THE CONTEXT WINDOW WAS, WHICH IS A STATE AND NOT A COUNT ─────────────────
   *
   * THE SYMPTOM: the portal showed no context-usage percentage for Kiro chats. It was missing because
   * nothing in this service had a field for it — the desktop held the number in a React state and no
   * payload carried it.
   *
   * 0..100, as the assistant reported it at the end of the turn. Kiro publishes it
   * (`_kiro.dev/metadata.contextUsagePercentage`); Claude and Codex do not, so the field is absent for
   * them — and absent means NOT REPORTED, not an empty window.
   *
   * ⚠ THE ONE FIGURE ON THIS TYPE THAT MUST NEVER BE SUMMED OR AVERAGED. Every count above is additive;
   * this is a reading at an instant. Two turns at 40% are not 80% full, and the mean of a conversation's
   * readings describes nothing a participant can act on. `timing.ts` takes the LAST reading in the thread,
   * which is the only aggregate that means anything: how full the conversation is NOW.
   *
   * ⚠ CLIENT-REPORTED, so it is bounded on the way in exactly as `latencyMs` and the token counts are —
   * see the sync route. A value outside 0..100 is dropped rather than clamped, because a clamped 100%
   * would read as "this conversation is full" on evidence that is known to be wrong.
   */
  contextUsagePercent?: number;

  /**
   * True for messages seeded in bulk by a transcript sync/share rather than
   * captured live. The monolith stamped these with `base + i` milliseconds, so
   * their `createdAt` ordering is real but the GAPS between them are fabricated.
   * timing.ts must therefore never infer a user's compose time across them.
   */
  synced?: boolean;

  /** Author of a user message (absent on assistant messages). */
  userId?: string;
}

/**
 * Repository interfaces — domain code depends on THESE, not on DynamoDB (DIP).
 * Narrow by aggregate (Interface Segregation). Swapping the DynamoDB impl for an
 * HTTP/event-backed one later does not touch the routes.
 */
export interface ThreadRepository {
  get(teamId: string, id: string): Promise<AiThread | null>;
  /**
   * Resolve a thread by its id ALONE (via the aiThreads `id-index` GSI).
   *
   * Exists for authorization, not convenience: the thread-keyed routes
   * (/threads/:threadId/*) receive no teamId, and a thread's team is what decides
   * who may read or write it. Without this the routes had no way to find the owning
   * team and simply skipped the check — a known thread id was an IDOR, and on the
   * POST it also billed a model call. Returns null when no thread matches, which
   * those routes turn into a 404.
   */
  getById(id: string): Promise<AiThread | null>;
  listByTeam(teamId: string, sharedOnly: boolean): Promise<AiThread[]>;
  put(thread: AiThread): Promise<AiThread>;
  /**
   * Move a thread's `updatedAt` forward. Nothing else on the row is touched.
   *
   * ⚠ WHY THIS EXISTS AT ALL, AND WHY IT IS NOT `put`. `updatedAt` was only ever written by CREATE and
   * SHARE, so a thread that was messaged for a week still reported its creation time — the portal's
   * conversation list showed "16 Aug" for a chat used today, and `ai.tokenUsage`'s `at` had the same
   * blind spot. Message writes have to move it.
   *
   * ⚠ AND A FULL-ITEM `put` IS THE WRONG TOOL FOR THAT, WITH PRECEDENT IN THIS FILE'S OWN HISTORY. The
   * create route records what an unconditional `put` cost: it DESTROYED A REAL SHARE, wiping `shared`,
   * `sharedAt`, `sharedById` and `sharedByName` off thread 4392b109 and making it invisible in Team
   * Chats. Even a read-modify-put here would lose a share that landed between the read and the write —
   * a sync is a long request and the desktop shares from the same screen. So this is an UPDATE of one
   * attribute, and it cannot clobber a field it does not name.
   *
   * ⚠ A MISSING THREAD IS NOT AN ERROR TO THE CALLER. The implementation is conditional on the row
   * existing and swallows the miss: a thread deleted mid-sync must not fail a sync whose messages were
   * already stored, and this is a display timestamp, not a fact anybody's authorization depends on.
   */
  touch(teamId: string, id: string, at: string): Promise<void>;
}

export interface MessageRepository {
  /**
   * The WHOLE thread, ascending. Kept for the rollup/ratings/timing callers that genuinely need
   * every turn (and for the no-param compatibility path on `GET .../messages`). The two bounded
   * reads below exist because a multi-day workshop thread grows without limit, and the desktop no
   * longer wants the whole transcript on every open or every live refresh.
   */
  listByThread(threadId: string): Promise<AiMessage[]>;

  /**
   * Only the messages NEWER than `since` (an ISO `createdAt`), ascending. Backs the live refresh:
   * the client sends the `createdAt` of the newest row it already has, and gets back just what was
   * appended, which it concatenates rather than re-rendering the whole thread. `createdAt` is the
   * table's RANGE key, so this is a bounded Query, not a scan-and-filter.
   */
  listByThreadSince(threadId: string, since: string): Promise<AiMessage[]>;

  /**
   * One NEWEST-FIRST page for scroll-up pagination. Returns at most `limit` messages older than
   * `before` (omit `before` for the first/newest page) and a `nextBefore` cursor for the next older
   * page — null when the start of the thread has been reached. The page itself is returned ASCENDING
   * (oldest-of-page first) so the client can prepend it directly; `nextBefore` is the oldest
   * `createdAt` in the page.
   */
  listByThreadPage(
    threadId: string,
    opts: { limit: number; before?: string }
  ): Promise<{ messages: AiMessage[]; nextBefore: string | null }>;

  put(message: AiMessage): Promise<AiMessage>;
}

/**
 * ── THE CONVERSATIONAL MODEL PORT IS GONE ──
 *
 * `ModelClient`, `ModelTurn` and `ModelCompletion` lived here, along with the Bedrock
 * implementation in `model.bedrock.ts`. All of it is deleted: no route in this service invokes a
 * chat model, because no client ever asked it to. The desktop app drives the participant's OWN
 * local CLI and records the finished transcript via `POST /threads/:threadId/sync`, which stores
 * turns and publishes activity WITHOUT a model call.
 *
 * THE TYPES WENT WITH THE IMPLEMENTATION, deliberately. Leaving a port with no adapter is an
 * invitation — the next route added here would find a ready-made billable interface with no
 * timeout, no history cap and no spend budget, and wire something to it. Restoring in-app chat now
 * has to be a decision.
 *
 * WHAT SURVIVES, because it is still fed by CLI turns: `AiMessage.latencyMs` / `firstTokenMs` /
 * `inputTokens` / `outputTokens`. Those are now CLIENT-MEASURED — the platform never saw the
 * invoke — which is why the sync route validates them rather than trusting them, and why an
 * implausible duration is dropped instead of clamped (see MAX_SYNC_LATENCY_MS).
 *
 * `RatingAnalyst` below is a different port and is untouched. It is the ONLY billable dependency
 * left in this service, reached by exactly one executive-only route behind a lease and a cooldown.
 */

/** Minimal projection of a user this service needs (name for display). Populated
 *  from Identity's `user.updated` events — this is how we avoid reading the users
 *  table across a service boundary. */
export interface UserView {
  id: string;
  name: string;
}
export type UsersReadModel = ReadModel<UserView, string>;

// ─── Team AI ratings ─────────────────────────────────────────────────────────
//
// TWO MODEL CALLS, TWO AUDIENCES, AND THEY MUST NEVER MERGE.
//
// Call A reads members' actual AI conversations and team chat to assess how well each
// person works with an assistant. That is the only honest way to score AI skill — the
// counters cannot do it, because `aiThreadsShared` counts button presses, so someone who
// used Claude Code brilliantly and never pressed "share" scores zero. The cost is that A's
// output is derived from private message text, so it stays MEMBER-ONLY with no publish
// path in the code at all.
//
// Call B reads five integers per member and nothing else. Its team summary is publishable
// to judges and non-member executives precisely BECAUSE no message text entered the
// prompt — it cannot leak what it never saw. That is a structural property, not a
// prompt instruction, and prompt instructions are not authorization boundaries.
//
// The audiences:
//   members (incl. an EXECUTIVE who is on the team) → A and B
//   executive NOT on the team, judge, facilitator, admin → B only
//
// A needs NO new authorization: `canReadTeamContent` is pure membership and deliberately
// ignores `role` (team/src/authz.ts:292-303), so an executive member already passes it and
// a judge already fails it.

/** One member's activity counters — the ENTIRE input to call B. */
export interface RatingCounters {
  tasksCreated: number;
  tasksCompleted: number;
  messagesSent: number;
  commitsPushed: number;
  /** Threads SHARED — button presses, not usage. Kept because the summary already reports it. */
  aiThreadsShared: number;
  /**
   * ASSISTANT TURNS — the honest AI-usage signal.
   *
   * NUMBER, not `number | null`, and the coercion happens at the READER (see
   * ratings-readers.http.ts): by the time counters reach the prompt they are integers a model
   * can add up, and a null in a payload a model reads becomes the string "null" in prose.
   *
   * ⚠ SO THE "not measured" DISTINCTION IS LOST HERE ON PURPOSE, and the reader records it in
   * `coverage[]` instead — the caveat travels to the screen rather than into the model's input.
   */
  aiTurns: number;
}

/**
 * What call B sends the model: TEAM TOTALS. No per-member rows, not even under a handle.
 *
 * ── WHY THIS IS AGGREGATED, AND WHY IT WAS NOT AT FIRST ──
 *
 * This originally carried one row per member keyed by an opaque `M1..Mn` handle, on the
 * reasoning that a model which never sees a name cannot name anyone. That reasoning was
 * incomplete, and a live probe against Bedrock proved it: given two rows, the model wrote
 * "one member drove the majority of messaging, commits, and AI-assisted work, while the
 * other contributed a smaller share". It named nobody and broke the rule anyway — in a team
 * of two or three, "one member did most of it" identifies a person as surely as a name does,
 * and the summary is the ONE output a judge or an off-team executive can read.
 *
 * A stronger prompt is not the fix. Instruction-following is probabilistic and this is an
 * authorization-adjacent property, so it has to be structural: with no per-member rows in the
 * input, singling someone out is not something the model is asked to refrain from — it is
 * something it has no data to do. Same move as keeping message text out of this call.
 *
 * `distribution` is the one fact lost by aggregating that is worth keeping, so it is computed
 * SERVER-SIDE into a coarse label. "unevenly" is useful in a retrospective; which specific
 * person sat at which end of it is precisely what must not travel.
 */
export interface SummaryModelInput {
  memberCount: number;
  /** Team-wide sums. Per-member values are deliberately not derivable from these. */
  totals: RatingCounters;
  /** A coarse, server-computed shape of the spread — never who is where in it. */
  distribution: "single-member" | "even" | "somewhat uneven" | "highly uneven";
}

/**
 * What call A sends the model: ONE MEMBER, their handle, and their own text.
 *
 * ── ONE MEMBER PER CALL, NOT THE WHOLE TEAM ──
 *
 * This was originally `{members: [...]}` — the entire team in a single prompt, returning an
 * array. Measured against the live model, that does not work:
 *
 *     5 members   ~40 KiB   4.7s    complete and clean
 *    10 members  ~295 KiB   1.9-5.8s  returned 1-2 of 10 rows, every score 0
 *    25 members  ~737 KiB   20-26s  "not JSON"; earlier, 25/25 rows with EMPTY rationales
 *
 * The failure was never a clean error: the model silently dropped members or emitted hollow
 * assessments, which would be stored and shown as considered coaching. Raising the output cap
 * did not fix it — the input itself is too large to answer reliably.
 *
 * Per-member calls make the unit of work constant. A 25-member team is 25 small 4.7s-class
 * prompts instead of one 737 KiB prompt, so quality no longer degrades with team size, and one
 * member's failure is one missing assessment rather than a lost generation. The caller decides
 * concurrency and how to treat a partial result.
 */
export interface KnowledgeModelInput {
  handle: string;
  /** Newest-first, capped. The member's own messages to their AI assistant. */
  aiMessages: string[];
  /** Newest-first, capped. The member's own team-chat messages. */
  teamMessages: string[];
}

/** Per-member assessment from call A. MEMBER-ONLY — never in a published response. */
export interface MemberAiAssessment {
  userId: string;
  /** 0-100. Derived from how the member actually works with the assistant. */
  aiKnowledgeScore: number;
  /** Why that score, citing patterns rather than quoting messages. */
  rationale: string;
  /** What they already do well. */
  strengths: string[];
  /**
   * Concrete suggestions. Phrased about the WORK, never the person, and never comparative —
   * teammates read each other's, so "you are worse than X" is not an acceptable output.
   */
  improvements: string[];
}

/**
 * A stored snapshot. One row per generation, keyed (teamId, generationId).
 *
 * `publishedAt` is what admits a non-member to the summary, and it is only ever set by a
 * deliberate member action — the same mechanism that makes a submission judge-readable.
 * Unpublished is invisible outside the team.
 */
export interface TeamAiRatingSnapshot {
  teamId: string;
  /** ULID, so rows sort newest-last without trusting a wall clock. */
  generationId: string;
  /** SERVER-DERIVED at generation time; never read from a request. Gates judge access. */
  workshopId: string | null;
  generatedAt: string;
  generatedById: string;
  modelId: string;
  /** Call A's output. Member-only. */
  members: MemberAiAssessment[];
  /** Call B's output. Publishable. */
  teamSummary: string;
  publishedAt: string | null;
  publishedById: string | null;
  /**
   * What the numbers do NOT capture, carried in the payload rather than left in a code
   * comment, because people are ranked by them. Chiefly: CLI turns are under-counted, since
   * `ai.response-generated` is not consumed (a deliberate earlier decision).
   */
  coverage: string[];
  schemaVersion: number;
}

/** Store for rating snapshots. */
export interface TeamAiRatingRepository {
  /** Newest snapshot for a team, or null when none has been generated. */
  latest(teamId: string): Promise<TeamAiRatingSnapshot | null>;
  put(snapshot: TeamAiRatingSnapshot): Promise<TeamAiRatingSnapshot>;
  /** Set publication on ONE generation. Fails if that generation is no longer newest. */
  publish(
    teamId: string,
    generationId: string,
    publishedById: string
  ): Promise<TeamAiRatingSnapshot | null>;
  /**
   * Take an exclusive lease on generating for this team. `false` when somebody already holds it.
   *
   * ── WHY THE COOLDOWN IS NOT ENOUGH ──
   *
   * The cooldown compares the STORED snapshot's age, and the store is only written at the END of a
   * generation — up to 45 seconds (RATING_TOTAL_TIMEOUT_MS) after the check. Two requests entering
   * that window together both read the same old snapshot, both pass, and both run the full
   * generation: one Bedrock call per member plus a summary, TWICE. At MAX_RATED_MEMBERS = 10 that
   * is 22 model invocations for one intended analysis, and the loser's snapshot is silently
   * superseded so `generatedById` records whoever finished last rather than whoever asked.
   *
   * A read-then-write guard cannot close that; only a conditional write can. Same argument as the
   * team seat ledger's: two callers read the same value and both act on it.
   *
   * The lease EXPIRES on its own, so a Lambda killed mid-generation cannot wedge the route.
   */
  claimGeneration(teamId: string, actorId: string, now: number): Promise<boolean>;
  /**
   * Release the lease. Called on EVERY exit path, success or failure — a generation that failed at
   * second three must not block the legitimate retry for the rest of the lease.
   *
   * Never throws: a failed release is recoverable (the lease expires) and must not convert a
   * successful generation into an error the caller sees.
   */
  releaseGeneration(teamId: string): Promise<void>;
}

/**
 * How long a generation lease lives.
 *
 * ⚠ DELIBERATELY NOT `RATING_COOLDOWN_MS`, and conflating the two would be a bug in both
 * directions. They bound different things: the lease bounds CONCURRENCY (is one running right
 * now), the cooldown bounds FREQUENCY (how recently did one finish). A ten-minute lease would mean
 * a generation that failed at second three blocks the legitimate retry for ten minutes, punishing
 * an executive for a Bedrock fault.
 *
 * 60s = RATING_TOTAL_TIMEOUT_MS (45s, the longest a generation may legally run) plus margin, so a
 * lease outlives any real generation and lapses shortly after the work must have stopped.
 *
 * HERE, NOT IN THE DYNAMO ADAPTER: it is a rule about the domain that both the route (for its
 * Retry-After) and the store (for its TTL) must agree on, and a route importing from an adapter
 * would invert the dependency.
 */
export const GENERATION_LEASE_MS = 60_000;

/**
 * The two model calls, behind one port so tests never make a billable call.
 *
 * Separate methods rather than one with a mode flag: they take different inputs and their
 * outputs have different audiences, and a flag is one wrong argument away from sending
 * message text into the publishable path.
 */
export interface RatingAnalyst {
  /**
   * Assess ONE member. See KnowledgeModelInput for why this is not batched.
   *
   * Returns the handle it was given so the caller can verify the model answered about the
   * member it was asked about — a mismatch is a hallucination, not a row.
   */
  assessKnowledge(
    input: KnowledgeModelInput,
    opts: { signal: AbortSignal }
  ): Promise<Omit<MemberAiAssessment, "userId"> & { handle: string }>;
  summariseTeam(
    input: SummaryModelInput,
    opts: { signal: AbortSignal }
  ): Promise<string>;
}

/**
 * Reads a team's chat so call A can assess how members work with the assistant.
 *
 * A PORT, because team chat belongs to the COLLABORATION context — this service must ask
 * for it over that context's own member-gated API rather than reading
 * `praimana-messages` directly. Reading a foreign table would bypass the very guard
 * that keeps chat private and couple two services through storage.
 *
 * Returns "unavailable" rather than an empty list when the lookup fails. That distinction is
 * load-bearing: an empty list means "this team has not talked", which would let a brownout
 * silently produce an assessment claiming a member never communicated. The route refuses to
 * generate rather than score someone on data it could not read.
 */
export interface TeamChatReader {
  recentByTeam(
    teamId: string,
    limit: number,
    auth?: unknown
  ): Promise<Array<{ userId: string; content: string }> | "unavailable">;
}

/**
 * Per-member activity counters, read from the EVALUATION context that owns them.
 *
 * A port for the same reason as TeamChatReader: those counters live in evaluation's
 * read-model, and this service asks over its member-gated API rather than reading a foreign
 * table. "unavailable" is distinct from an empty list, because scoring a team on counters we
 * failed to read would invent a story about people who were simply unreachable.
 */
export interface TeamCountersReader {
  byTeam(
    teamId: string,
    auth?: unknown
  ): Promise<Array<{ userId: string } & RatingCounters> | "unavailable">;
}

/**
 * Resolves a team's workshop. A SEPARATE port from TeamAccess, which answers permission
 * questions and should not also be an identity lookup — mixing the two would mean every
 * authorization call carried a dependency it does not need.
 *
 * The value is stored on a snapshot and later gates JUDGE access to a published summary, so
 * it MUST be server-derived. Accepting it from a request would let a caller name a workshop
 * they happen to be entitled to and read a foreign team's summary through it.
 *
 * `null` when unresolvable — the snapshot is still written, and the judge path simply refuses
 * it. Losing an analysis because a lookup blinked would be the worse trade.
 */
export interface TeamWorkshopLookup {
  workshopIdForTeam(teamId: string, auth?: unknown): Promise<string | null>;
}
