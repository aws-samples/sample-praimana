import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import type { DocClient } from "@praimana/service-shared";
import { AmbiguousInviteCodeError } from "./invite-code.js";
import type {
  Team,
  TeamMember,
  TeamPage,
  Invitation,
  AdmitOutcome,
  TeamRepository,
  TeamMemberRepository,
  InvitationRepository,
  AuditRepository,
  AuditEntryWrite,
  AuditEntryRead,
} from "./domain.js";
// A VALUE import, unlike everything above it: the membership status predicate is what makes
// `get`/`listByTeam` refuse a deactivated row, so it has to be the SAME function the routes
// and the domain use. A second local copy of "what does INACTIVE mean" is exactly how the two
// halves drift into disagreeing about whether a removed person is a member.
import { isInactiveMembership } from "./domain.js";
// The service's SINGLE local copy of the platform team-size ceiling. Used here
// only as the fallback cap for a legacy row that carries none — see LEGACY_TEAM_SEAT_CAP.
import { MAX_TEAM_MEMBERS } from "./team-size.js";

/**
 * DynamoDB implementations of the Team repositories. This is the ONLY file in the
 * service that knows about DynamoDB commands or table names. Everything else
 * depends on the interfaces in domain.ts. To extract/re-home later, you write a
 * new implementation of the same interfaces — routes stay untouched.
 */

// Tables THIS service owns. It references no other context's tables (notably NOT
// the users table — that belongs to Identity; see users-readmodel.dynamo.ts).
const TABLES = {
  teams: process.env.TABLE_TEAMS || "praimana-teams",
  teamMembers: process.env.TABLE_TEAM_MEMBERS || "praimana-team-members",
  invitations: process.env.TABLE_INVITATIONS || "praimana-invitations",
  audit: process.env.TABLE_AUDIT || "praimana-audit",
} as const;

/**
 * True when DynamoDB refused a write because its ConditionExpression did not hold.
 *
 * Matched on `name`, the stable contract on an AWS SDK error, rather than on message
 * text or an `instanceof` against the modelled exception class — the doc client can
 * surface either the modelled type or a plain error with this name depending on the
 * SDK's middleware path, and this distinction decides whether a failure is benign.
 */
function isConditionalCheckFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "ConditionalCheckFailedException"
  );
}

/**
 * The per-item cancellation `Code` DynamoDB reports when one item's ConditionExpression did
 * not hold. Every other value ("None", "ThrottlingError", "ValidationError",
 * "TransactionConflict", …) means something OTHER than a business-rule refusal.
 *
 * ⚠ NOT the same string as the standalone `ConditionalCheckFailedException` above — inside a
 * transaction the suffix is dropped. Using the exception's name here would match nothing, and
 * every seat refusal would surface as a 500.
 */
const TRANSACTION_CONDITION_FAILED = "ConditionalCheckFailed";

/**
 * The cancellation code DynamoDB returns when ANOTHER transaction was operating on the same
 * item — optimistic contention, not a business-rule refusal.
 *
 * ⚠ THIS IS NOT RETRYABLE BY THE SDK. `$retryable` is undefined and `attempts` is 1, so nothing
 * below us retries it. Left unmodelled, it fell through `tryAdmit`'s final `throw` and became a
 * 500 for a join that should plainly have succeeded — MEASURED against live DynamoDB at 25% of
 * requests with 2 concurrent admits into an EMPTY 10-seat team, 55% at 4, and 73.5% at 10.
 * Nobody was over the cap; the transaction simply lost a coin toss on the team item, which every
 * admit for a given team necessarily contends on because it is the serialization point.
 */
const TRANSACTION_CONFLICT = "TransactionConflict";

/**
 * Attempts for a CONTENDED transaction, and the backoff between them.
 *
 * ⚠ BOTH NUMBERS ARE MEASURED, NOT CHOSEN. Every admit for a team contends on the same `teams`
 * item — that is what makes the cap safe — so contention rises with how many people join at
 * once, and the retry budget has to cover a whole team arriving together rather than a pair.
 *
 * Against live DynamoDB, 6 concurrent admits into empty 10-seat teams, 90 calls:
 *
 *     no retry     ~55% of calls threw TransactionConflict (measured at 4 concurrent)
 *     3 attempts   4 of 90 still threw  — better, and still a 500 for a valid join
 *     6 attempts   0 of 90 threw        — every admit succeeded
 *
 * Bounded because an unbounded retry on a hot item is a queue that spends the caller's whole
 * request budget and fails anyway. Worst case here is ~15+30+60+120+240 ≈ 465ms of backoff
 * before giving up, which sits inside the join route's budget and well inside the 60s function
 * timeout — and a caller who exhausts it gets a real error rather than a wrong answer.
 *
 * Jitter is load-bearing, not decoration: a fixed delay makes every loser retry in lockstep and
 * collide again, which is how a retry storm forms out of a retry fix.
 *
 * MAX_TEAM_MEMBERS is 10, so a whole team joining simultaneously is the realistic ceiling on
 * contention. Re-measure if that cap rises.
 */
const TRANSACTION_CONFLICT_ATTEMPTS = 6;
const TRANSACTION_CONFLICT_BASE_DELAY_MS = 15;

/**
 * WHICH ITEMS OF A CANCELLED TRANSACTION FAILED THEIR CONDITION — positionally.
 *
 * `TransactionCanceledException.CancellationReasons` is ORDERED BY REQUESTED ITEM and every
 * item gets an entry (`Code: "None"` when it was fine), which is the documented contract this
 * reads. That ordering is the ONLY way to tell "already a member" from "team full": both
 * arrive as ONE exception with the same name, and the distinction is mandatory
 * because conflating them tells somebody already on the team that it is full.
 *
 * Returns `null` — NOT an empty array — when this is not a cancelled transaction, or when the
 * reasons are missing or not an array. The distinction is load-bearing at the call site:
 * `null` means "this is not a condition failure, rethrow it", while an array of `false`s means
 * "cancelled, but for a reason we do not model" which is also a rethrow. An empty array for
 * both would make an unclassifiable failure look like a clean answer.
 *
 * Matched on `name` rather than `instanceof`, the same stable contract and the same reason
 * `isConditionalCheckFailure` gives: the doc client may surface either the modelled type or a
 * plain error carrying this name depending on the middleware path.
 */
/**
 * True when the write lost to another writer on the same item — contention, not a refusal.
 *
 * ⚠ DYNAMODB REPORTS THIS IN TWO DIFFERENT SHAPES, and matching only one leaves the other
 * falling through to a 500. Both were observed live within the same probe run:
 *
 *   1. `TransactionCanceledException` with `CancellationReasons[i].Code === "TransactionConflict"`
 *      — the per-item form, which is what the docs lead with.
 *   2. `TransactionConflictException` — a STANDALONE error with no CancellationReasons at all,
 *      message "Transaction is ongoing for the item".
 *
 * The second is easy to miss precisely because the first is the documented one. Handling only
 * the cancellation form is how a retry fix ships still throwing.
 */
function isTransactionConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  // Shape 2: the standalone exception carries the conflict in its NAME and nothing else.
  if (name === "TransactionConflictException") return true;
  if (name !== "TransactionCanceledException") return false;
  // Shape 1: one item's cancellation reason.
  const reasons = (err as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  return reasons.some(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      (r as { Code?: unknown }).Code === TRANSACTION_CONFLICT
  );
}

/**
 * Run a transaction, retrying ONLY on contention.
 *
 * A `ConditionalCheckFailed` is an ANSWER — already a member, or no seat left — and retrying it
 * would just get the same answer more slowly. A `TransactionConflict` is not an answer at all,
 * so it is the one cancellation reason worth another attempt.
 */
async function withConflictRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= TRANSACTION_CONFLICT_ATTEMPTS || !isTransactionConflict(err)) throw err;
      // Exponential with full jitter. `Math.random` is fine here — this is backoff timing, not
      // anything a caller can observe or that needs to be reproducible.
      const ceiling = TRANSACTION_CONFLICT_BASE_DELAY_MS * 2 ** (i - 1);
      await new Promise((r) => setTimeout(r, Math.random() * ceiling));
    }
  }
}

function transactionConditionFailures(err: unknown): boolean[] | null {
  if (
    typeof err !== "object" ||
    err === null ||
    !("name" in err) ||
    (err as { name: unknown }).name !== "TransactionCanceledException"
  ) {
    return null;
  }
  const reasons = (err as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return null;
  return reasons.map(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      (r as { Code?: unknown }).Code === TRANSACTION_CONDITION_FAILED
  );
}

/**
 * POSITION OF EACH ITEM IN THE MEMBERSHIP TRANSACTIONS. Named rather than written as `0`/`1`
 * at four call sites, because the disambiguation in §C is entirely positional — swap the two
 * items in the array without changing these and every "team full" becomes "already a member".
 *
 * The order is MEMBER FIRST, TEAM SECOND for all three transitions, so one pair of constants
 * describes `admit`, `deactivate` and `reactivate` alike.
 */
const TX_MEMBER_ITEM = 0;
const TX_TEAM_ITEM = 1;

/**
 * The `seatCap` a LEGACY team row inherits when it carries none at all — see
 * `initialiseLedger`, the only user of it in this file.
 *
 * The platform ceiling, imported from this service's single local copy (team-size.ts). It is
 * NOT the cap enforced on a normal admission: that is the team's OWN `seatCap`, seeded from the
 * workshop template at creation, and the whole point of the template rule is that Team never consults
 * the workshop on a membership path.
 */
const LEGACY_TEAM_SEAT_CAP = MAX_TEAM_MEMBERS;

/**
 * ── WHY THERE IS NO `ClientRequestToken` ON THESE TRANSACTIONS ──
 *
 * The design specifies one (`"admit#<teamId>#<userId>"`), and it was implemented. It has been
 * REMOVED, because it protected nothing and actively broke retries.
 *
 * WHAT IT WAS FOR: suppressing a double increment when the same logical call is retried inside
 * DynamoDB's 10-minute idempotency window.
 *
 * WHY IT IS UNNECESSARY, verified live rather than reasoned about — the same admit replayed
 * three times with NO token at all:
 *
 *     attempt 1  committed
 *     attempt 2  refused [ConditionalCheckFailed, None]
 *     attempt 3  refused [ConditionalCheckFailed, None]
 *     final memberCount = 1
 *
 * `attribute_not_exists(userId)` already makes a repeat admit a no-op, and the same holds for
 * the status flips: `#status <> :inactive` refuses a second deactivate, `#status = :inactive`
 * refuses a second reactivate. Every one of these transactions is idempotent BY ITS
 * CONDITIONS. The token was a second mechanism for a property the first one already had.
 *
 * WHY IT WAS HARMFUL: a token is only valid for an IDENTICAL request, and these requests are
 * not identical between attempts — `reactivatedAt`/`removedAt` are `new Date().toISOString()`
 * minted inside the call, and `joinedAt` is minted per request by the route. So a retry sent
 * the same token with different parameters and DynamoDB answered
 * `IdempotentParameterMismatchException` — a 500. Reproduced live: removing a member and
 * restoring them inside ten minutes failed outright, which is exactly the sequence an operator
 * runs after a mistaken removal, and it also made a freed seat unreachable for ten minutes.
 *
 * ⚠ DO NOT REINSTATE IT WITHOUT MAKING THE PAYLOAD BYTE-IDENTICAL ACROSS ATTEMPTS. A stable
 * token over a varying payload is strictly worse than no token: it converts a safe, idempotent
 * retry into a hard failure.
 */

/**
 * Page size for the TEAMS DIRECTORY (`listDirectory`).
 *
 * The same two numbers the identity service's user directory uses
 * (identity/src/repository.dynamo.ts:13-14), deliberately: the two screens are the same
 * screen with a different noun, they are paged by the same BFF shape, and an operator who
 * learns one page size from Users and gets another from Teams has to discover the difference
 * at runtime. Bounded so one directory page load can never turn into an unbounded table read,
 * and clamped server-side so a caller asking for 10,000 gets MAX_DIRECTORY_PAGE_SIZE.
 */
const DEFAULT_DIRECTORY_PAGE_SIZE = 50;
const MAX_DIRECTORY_PAGE_SIZE = 100;

/**
 * How many Scan round-trips ONE `listDirectory` call may make while trying to fill a page.
 *
 * THIS IS THE BOUND ON THE SCAN, and it is the honest answer to "what stops this growing
 * unbounded?": a request reads at most MAX_DIRECTORY_SCAN_ROUND_TRIPS × (limit + 1) rows,
 * never the whole table, whatever the table's size becomes. It is REPORTED rather than
 * hidden — hitting it hands back a cursor, so the page is short and "Next" is live, which is
 * true; it is not silently truncated into looking complete.
 *
 * It exists because a FilterExpression is applied by DynamoDB AFTER Limit, so a filtered Scan
 * can return a SHORT or EMPTY page while more matches lie further on. Without the loop a
 * search for a team on page 3 renders an empty directory. Five, matching
 * MAX_SCAN_ROUND_TRIPS in the identity service, for the same reason the page sizes match.
 */
const MAX_DIRECTORY_SCAN_ROUND_TRIPS = 5;

/**
 * The decoded form of a directory cursor — EXACTLY the `teams` table's key schema
 * (workshopId HASH, id RANGE) and nothing else.
 *
 * A named type rather than `Record<string, unknown>` because this value becomes an
 * `ExclusiveStartKey`, and DynamoDB answers a start key that is not precisely the key schema
 * with a ValidationException — i.e. a 500 on the directory. See decodeDirectoryCursor.
 */
type DirectoryCursor = { workshopId: string; id: string };

/**
 * Decode a caller-supplied cursor, or `undefined` to start at page one.
 *
 * ── THE SHAPE IS VALIDATED, NOT JUST THE DECODABILITY ──
 *
 * The try/catch alone was not enough, and the gap was a caller-triggerable 500:
 * `JSON.parse` SUCCEEDS on `{"foo":1}`, on `null`, on `"abc"` and on `5`, so a
 * well-formed-JSON wrong-shape cursor sailed past the catch and was spread straight into
 * `ExclusiveStartKey`. DynamoDB then rejects the start key with a ValidationException. It
 * fails closed (no rows leak), but `?cursor=eyJmb28iOjF9` was a 500 on an authenticated
 * route, which is the exact outcome the restart-at-page-one rule exists to avoid.
 *
 * NO EXTRA KEYS, deliberately: an attacker choosing the ATTRIBUTES of a start key the SDK
 * sends is a store-facing input we have no reason to accept, and a legitimate cursor never
 * carries one (this method mints every cursor itself, from the key schema).
 *
 * ANYTHING UNREADABLE RESTARTS AT PAGE ONE — never a 400. The cursor travels
 * through a URL where a copy-paste truncates it, and a 400 strands a user holding a stale
 * bookmark on a screen whose cursor is opaque to them. Logged ONCE per request so a bad
 * cursor is diagnosable without being a per-row log line; ids only, and the cursor itself is
 * NOT logged (it is caller-controlled free text of bounded-but-arbitrary content).
 */
function decodeDirectoryCursor(cursor: string): DirectoryCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    console.warn("[team] teams directory: undecodable cursor — restarting at page one");
    return undefined;
  }

  // Rejects null (typeof null === "object"), arrays, and every primitive.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[team] teams directory: cursor is not an object — restarting at page one");
    return undefined;
  }

  const keys = Object.keys(parsed);
  const { workshopId, id } = parsed as Record<string, unknown>;
  if (
    keys.length !== 2 ||
    typeof workshopId !== "string" ||
    workshopId === "" ||
    typeof id !== "string" ||
    id === ""
  ) {
    console.warn("[team] teams directory: cursor has the wrong shape — restarting at page one", {
      // The KEY NAMES only, never their values: a name set is enough to tell a truncated
      // cursor from a crafted one, and the values are caller-controlled content.
      keys: keys.slice(0, 8),
    });
    return undefined;
  }

  return { workshopId, id };
}

export class DynamoTeamRepository implements TeamRepository {
  constructor(private readonly db: DocClient) {}

  async getById(id: string): Promise<Team | null> {
    // teams is keyed by (workshopId, id); the id-index GSI resolves by id alone.
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teams,
        IndexName: "id-index",
        KeyConditionExpression: "id = :id",
        ExpressionAttributeValues: { ":id": id },
        Limit: 1,
      })
    );
    return (res.Items?.[0] as Team) ?? null;
  }

  /**
   * The team holding this join code, or null.
   *
   * ⚠ `Limit: 2`, NOT `Limit: 1`, AND AN AMBIGUOUS ANSWER IS AN ERROR. A GSI
   * cannot enforce uniqueness, so this index can hold duplicates — and it certainly does for
   * teams created before `generateInviteCode` replaced the old ULID-timestamp prefix, which gave
   * every team created in the same 256 ms window an IDENTICAL code (see invite-code.ts).
   *
   * With `Limit: 1` this returned whichever item DynamoDB surfaced first, so a legitimate joiner
   * could be resolved to a team they were never invited to and then refused for having no
   * invitation on it. The second item is fetched for exactly one purpose: to know that the
   * answer is ambiguous. Two is enough — the count beyond two changes nothing about the
   * decision, and paging the whole duplicate set would turn a join into an unbounded read.
   */
  async getByInviteCode(inviteCode: string): Promise<Team | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teams,
        IndexName: "inviteCode-index",
        KeyConditionExpression: "inviteCode = :code",
        ExpressionAttributeValues: { ":code": inviteCode },
        Limit: 2,
      })
    );
    const items = res.Items ?? [];
    if (items.length > 1) {
      throw new AmbiguousInviteCodeError(inviteCode, items.length);
    }
    return (items[0] as Team) ?? null;
  }

  async listByWorkshop(workshopId: string): Promise<Team[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teams,
        KeyConditionExpression: "workshopId = :workshopId",
        ExpressionAttributeValues: { ":workshopId": workshopId },
      })
    );
    return (res.Items as Team[]) ?? [];
  }

  async put(team: Team): Promise<Team> {
    await this.db.send(new PutCommand({ TableName: TABLES.teams, Item: team }));
    return team;
  }

  /**
   * SET `seatCap`, REFUSING TO DROP IT BELOW THE LIVE MEMBER COUNT.
   *
   * `memberCount <= :cap` AT THE STORE rather than a read-then-write, and that is the whole
   * correctness of it: a route that read the count and then wrote the cap can be interleaved
   * with an `admit()` filling the seat it just judged spare, leaving `memberCount > seatCap`
   * with neither writer at fault. The condition makes the two serialize on the `teams` item,
   * exactly as the admission does.
   *
   * `attribute_not_exists(memberCount)` is the OTHER accepted branch, and it is required for
   * a legacy row: a team that has never been admitted through the counter has no
   * `memberCount`, and `memberCount <= :cap` evaluates FALSE for an absent attribute — so
   * without this disjunct a facilitator could not set a cap on any pre-existing team, which
   * is precisely the population §G exists to bring under the invariant. Accepting it is safe
   * because `admit()` lazily initialises the count from a strongly consistent roster read and
   * re-checks the cap at that moment; the seat limit is enforced on ADMISSION, not by this
   * write.
   *
   * `attribute_exists(id)` stops an UpdateCommand from UPSERTING a team row that does not
   * exist — the same trap `deactivate`/`reactivate` guard, and here it would fabricate a team
   * carrying nothing but a key and a cap, which every reader would render as a nameless team.
   */
  async setSeatCap(
    workshopId: string,
    id: string,
    seatCap: number
  ): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.teams,
          Key: { workshopId, id },
          UpdateExpression: "SET seatCap = :cap, updatedAt = :now",
          ExpressionAttributeValues: {
            ":cap": seatCap,
            ":now": new Date().toISOString(),
          },
          ConditionExpression:
            "attribute_exists(id) AND (memberCount <= :cap OR attribute_not_exists(memberCount))",
        })
      );
      return true;
    } catch (err) {
      // The expected refusal: the new cap is below the live roster, or the row vanished.
      // The route disambiguates by re-reading and reports the COUNT in its 409.
      if (isConditionalCheckFailure(err)) return false;
      // A real store failure. Rethrown: this write IS what the caller asked for, so
      // reporting success would misinform them about the only thing they requested.
      throw err;
    }
  }

  /**
   * EVERY team, one page at a time — A SCAN, DELIBERATELY, AND BOUNDED.
   *
   * ── WHY A SCAN AND NOT A GSI, STATED PLAINLY ──
   *
   * `teams` is (workshopId HASH, id RANGE) with two GSIs — `id-index` and
   * `inviteCode-index` — both keyed for POINT LOOKUPS. None of the three can enumerate
   * across workshops, so "all teams" has no index-backed form today.
   *
   * The alternative is a GSI keyed on a constant partition (`entity = "TEAM"`), which is
   * what an earlier design review already covered for the identical ADMIN workshops list and REJECTED:
   * it funnels every team CREATE through one index partition and duplicates the whole table,
   * for an ordering nothing needs. That reasoning applies verbatim here.
   *
   * ⚠ AN EARLIER DESIGN NOTE WAS AGAINST THIS SCAN, so it is noted here rather than omitted:
   * *"a global teams Scan would be a second enumeration surface for no new capability"*. That
   * clause is **SUPERSEDED** — the platform now needs a capability the
   * drill-down cannot provide (cross-workshop search, and "which team is X on?" without
   * knowing the workshop), so that premise no longer holds. Quoting the
   * supporting clause and omitting the contradicting one is worse than no
   * note, which is why both are named.
   *
   * So a Scan is honest at this scale — and it is bounded by
   * MAX_DIRECTORY_SCAN_ROUND_TRIPS × (limit + 1) rows per request, never the table, whatever
   * the table grows to. What DOES degrade with size is COMPLETENESS PER PAGE, not cost: a
   * needle matching one team in ten thousand needs more pages to reach. **Revisit at 5,000
   * teams** — the volume trip-wire, which binds SOONER here than on `workshops`
   * because one workshop holds many teams, so `teams` is the strictly LARGER table — or when
   * `ScannedCount / Count` exceeds 10:1 sustained (this replaces the inherited p99
   * trip-wire, which would never fire on this route: its p99.9 is dominated by a 2500ms
   * east-west timeout, not by the Scan). At that point the constant-partition GSI (or a
   * `lowerName` attribute, see below) becomes the better trade.
   *
   * ── THE RESTRICTION AND THE SEARCH ARE ONE FilterExpression, ANDed ──
   *
   * `workshopIds` is the authorization scope (a FACILITATOR sees only teams in workshops
   * they own) and it is pushed into the filter rather than applied to the returned array.
   * Not stylistic: DynamoDB bills and returns rows BEFORE the filter, so a post-filter would
   * have already shipped out-of-scope rows into this process — and, more importantly, doing
   * it here means the ONE method that can enumerate teams cannot return a team the caller may
   * not see, whatever route grows on top of it later. ANDing it with `search` is the security
   * property: search must never widen what the scope allows.
   *
   * ── CASE-INSENSITIVE NAME MATCH, THE WAY THIS TABLE FORCES ──
   *
   * DynamoDB's `contains` is case-SENSITIVE and a FilterExpression has no `lower()`, so
   * "phoenix" would not match "Team Phoenix". The identity service already hit this and
   * worked around it the same way (identity/src/repository.dynamo.ts:199-228): compare the
   * needle against BOTH a lowercased and a capitalised-first form, which covers how names are
   * actually stored (team names are typed by a facilitator, so Title Case dominates).
   *
   * Its stated limitation transfers verbatim: a fully general match needs a stored lowercased
   * copy of the name, which is a migration plus an attribute to keep in step on every write.
   * Worth doing if search is ever reported as missing a team; not worth doing pre-emptively.
   *
   * NOT post-filtered in memory, for the reason identity records: `hasMore` is derived from
   * how many rows the Scan RETURNED, so discarding rows afterwards would hand out a cursor
   * that skips them — a cursor that lies.
   *
   * WORKSHOP NAME IS NOT SEARCHABLE HERE, and that is a boundary, not an omission: the
   * workshop's name is the WORKSHOP context's data and this table stores only `workshopId`.
   * Matching on it would mean either denormalising a name this service does not own (a second
   * copy to drift on every rename) or resolving names before filtering, which cannot be a
   * store filter at all and so would break pagination. The route resolves workshop names for
   * the rows it RETURNS, which is display, not search.
   *
   * A malformed cursor is treated as "start from the beginning" rather than throwing — it
   * comes back through a URL where a copy-paste can truncate it, and page one is a harmless
   * answer to an unreadable cursor whereas a 500 on the directory is not. MALFORMED INCLUDES
   * WELL-FORMED-JSON OF THE WRONG SHAPE; see decodeDirectoryCursor for why that distinction
   * was a 500 until it was checked.
   */
  async listDirectory(
    opts: {
      limit?: number;
      cursor?: string;
      search?: string;
      workshopIds?: readonly string[];
    } = {}
  ): Promise<TeamPage> {
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE)),
      MAX_DIRECTORY_PAGE_SIZE
    );

    // An EMPTY scope means "may see nothing" and MUST return nothing. Building `IN ()` is a
    // syntax error, and omitting the filter for an empty list would turn "sees no workshops"
    // into "sees every team on the platform" — the worst possible direction for this bug.
    if (opts.workshopIds && opts.workshopIds.length === 0) {
      return { teams: [] };
    }

    // SHAPE-VALIDATED, not merely decoded — an unreadable cursor restarts at page one and is
    // logged once. See decodeDirectoryCursor.
    const startKey: DirectoryCursor | undefined = opts.cursor
      ? decodeDirectoryCursor(opts.cursor)
      : undefined;

    const conditions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (opts.workshopIds) {
      conditions.push(
        `workshopId IN (${opts.workshopIds.map((_, i) => `:w${i}`).join(", ")})`
      );
      opts.workshopIds.forEach((w, i) => {
        values[`:w${i}`] = w;
      });
    }

    const needle = opts.search?.trim();
    if (needle) {
      const lower = needle.toLowerCase();
      const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
      // `name` is a DynamoDB reserved word, hence the placeholder.
      conditions.push("(contains(#name, :qLower) OR contains(#name, :qTitled))");
      names["#name"] = "name";
      values[":qLower"] = lower;
      values[":qTitled"] = titled;
    }

    const filter = conditions.length
      ? {
          FilterExpression: conditions.join(" AND "),
          // Omitted entirely when empty: DynamoDB rejects an empty
          // ExpressionAttributeNames map rather than ignoring it.
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: values,
        }
      : {};

    const found: Team[] = [];
    // Widened to the SDK's own shape because it is re-assigned from LastEvaluatedKey below.
    // Narrowed back to the key schema before it can ever be minted into a cursor — see
    // fallbackKey at the bottom of this method.
    let lastKey: Record<string, unknown> | undefined = startKey;
    let exhausted = false;

    // Fetch ONE MORE than the page needs. That extra row is the only reliable way to know a
    // next page exists: DynamoDB sets LastEvaluatedKey whenever a Scan stops on Limit,
    // INCLUDING when it stopped on the last matching row — so trusting it hands out a cursor
    // to an empty page.
    const wanted = limit + 1;

    for (let trip = 0; trip < MAX_DIRECTORY_SCAN_ROUND_TRIPS; trip++) {
      const res = await this.db.send(
        new ScanCommand({
          TableName: TABLES.teams,
          // Only what is still missing, so a nearly-full page does not over-read.
          Limit: wanted - found.length,
          ExclusiveStartKey: lastKey,
          ...filter,
        })
      );

      found.push(...((res.Items as Team[]) ?? []));
      lastKey = res.LastEvaluatedKey;

      if (!lastKey) {
        // The authoritative "no more rows" signal.
        exhausted = true;
        break;
      }
      if (found.length >= wanted) break;
    }

    const teams = found.slice(0, limit);

    // ── `hasMore`, AND THE TWO DIFFERENT REASONS THERE IS A NEXT PAGE ──────────────────
    //
    // A next page exists if we actually SAW a row beyond this page (`> limit`), OR the
    // round-trip cap stopped us early with the table still unexhausted (`!exhausted`) — which
    // is how the bound is REPORTED rather than silently truncating.
    //
    // ⚠ `!exhausted` ALONE, with no `found.length >= limit` conjunct, AND THAT MATTERS.
    // The old `… || (!exhausted && found.length >= limit)` returned FALSE for a page the trip
    // cap truncated to FEWER than `limit` rows — which is precisely the case the round-trip
    // loop exists for. A FACILITATOR owning one workshop with three teams in a 10,000-row
    // table evaluated 5 × 51 rows, matched 1, exited on the trip cap with LastEvaluatedKey
    // still set, and got `hasMore: false`: one of their three teams, "Next" dead, no error.
    // `!exhausted` already means "the table had more rows and we stopped early", so the extra
    // conjunct added nothing and broke every partial page.
    const hasMore = found.length > limit || !exhausted;

    // ── WHICH KEY THE CURSOR IS BUILT FROM ────────────────────────────────────────────
    //
    // PREFERRED: the last row we RETURN. That property is load-bearing and must not be
    // "simplified" to LastEvaluatedKey — the latter points PAST the discarded over-fetch row,
    // so the next page would skip it. Deriving from the last returned row makes the discarded
    // extra the FIRST row of the next page instead.
    //
    // FALLBACK: `lastKey`, for the ONE state a last-returned-row cursor cannot express —
    // five trips, ZERO matches, table unexhausted. There is no returned row to build a key
    // from, so without this fallback `hasMore` would be true and the cursor absent, and the
    // caller would be told "no more results" while the needle sat further down the table.
    // Skipping the evaluated-and-rejected rows the fallback jumps over is correct: they did
    // not match the filter, so no row the caller may see is lost.
    //
    // Building the key by hand couples this to the table's key schema — (workshopId HASH,
    // id RANGE). That is already this class's job: it is the only file that knows the teams
    // table exists, and the alternative is a cursor that lies. The fallback is SHAPE-CHECKED
    // for the same reason a caller's cursor is: a key we cannot mint honestly must be no
    // cursor at all rather than one that 500s the next request.
    const last = teams[teams.length - 1];
    const fallbackKey =
      typeof lastKey?.workshopId === "string" && typeof lastKey?.id === "string"
        ? { workshopId: lastKey.workshopId, id: lastKey.id }
        : undefined;
    const nextKey = hasMore
      ? last
        ? { workshopId: last.workshopId, id: last.id }
        : fallbackKey
      : undefined;

    return {
      teams,
      // base64url, because this value travels in a query string.
      nextCursor: nextKey
        ? Buffer.from(JSON.stringify(nextKey)).toString("base64url")
        : undefined,
    };
  }
}

/**
 * ── THE INVERTED DEFAULT IS THE DESIGN. `get()` MUST NOT RETURN THE RAW ROW. ──
 *
 * Read the note on TeamMemberRepository in domain.ts before changing anything in this class.
 * The short version, at the site that would carry the bug:
 *
 * A membership removal keeps the row and marks it INACTIVE, so the history survives and the
 * removal can be reversed. The objection to a soft-delete flag was that it "needs every
 * reader to filter it, and missing one silently restores access" — and that objection is
 * ANSWERED HERE, once, by making the DEFAULT READS refuse to return a deactivated row.
 * `get()` answers null; `listByTeam()` omits it. Every authorization path on the platform
 * already treats null as "not a member", so an inactive membership grants nothing at all of
 * them with NO change to any of them.
 *
 * DO NOT "simplify" `get()` to `return (res.Item as TeamMember) ?? null`. It would type-check,
 * lint, and re-grant a removed person full access to all six content surfaces at once —
 * because the filter that used to be here would then have to exist in fourteen call sites,
 * one of which (apps/services/docs/src/authz.ts) is in a different service that cannot be
 * fixed from this file. repository.dynamo.test.ts asserts the polarity of both reads.
 *
 * FILTERED IN CODE, NOT WITH A DynamoDB FilterExpression, and that is deliberate for the LIST:
 * a FilterExpression is applied AFTER the Limit, so on a paginated read it returns short
 * pages. These queries are unpaginated (a team is tens of people), but writing the filter in
 * code keeps `listByTeam` and `listByTeamIncludingInactive` reading the SAME rows and
 * differing only in what they return — so the two cannot drift into disagreeing about what a
 * roster is.
 */
export class DynamoTeamMemberRepository implements TeamMemberRepository {
  constructor(private readonly db: DocClient) {}

  /**
   * An ACTIVE membership, or null. THE AUTHORIZATION READ — see the class note.
   *
   * An INACTIVE row answers NULL, indistinguishably from no row at all, because for every
   * caller of this method those two ARE the same answer: the person is not a member.
   */
  async get(teamId: string, userId: string): Promise<TeamMember | null> {
    const row = await this.getIncludingInactive(teamId, userId);
    // THE LOAD-BEARING LINE OF THIS FILE. Deactivated means not a member, everywhere.
    if (row && isInactiveMembership(row.status)) return null;
    return row;
  }

  /**
   * A membership row REGARDLESS of status. ⚠ NEVER an authorization source — a row from here
   * may be INACTIVE, so using it as a membership test grants a removed person access. See the
   * interface note for the two legitimate callers.
   */
  async getIncludingInactive(
    teamId: string,
    userId: string
  ): Promise<TeamMember | null> {
    const res = await this.db.send(
      new GetCommand({
        TableName: TABLES.teamMembers,
        Key: { teamId, userId },
      })
    );
    return (res.Item as TeamMember) ?? null;
  }

  /** The team's ACTIVE roster. Inactive rows are omitted — see the class note. */
  async listByTeam(teamId: string): Promise<TeamMember[]> {
    const rows = await this.listByTeamIncludingInactive(teamId);
    return rows.filter((m) => !isInactiveMembership(m.status));
  }

  /**
   * The team's roster INCLUDING deactivated members. ⚠ Rows here may be INACTIVE; the one
   * caller renders `status` per member. Anything counting members wants `listByTeam`.
   */
  async listByTeamIncludingInactive(teamId: string): Promise<TeamMember[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teamMembers,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as TeamMember[]) ?? [];
  }

  /**
   * Every ACTIVE membership for a user.
   *
   * Filtered for the same reason `get` is: this backs /teams/mine, the workshop entitlement
   * union and the roster intersection, all of which mean "teams this person is on". A team
   * they were removed from is not one, and leaving them in would put a team they cannot open
   * on their own home screen.
   */
  async listByUser(userId: string): Promise<TeamMember[]> {
    // teamMembers rows are keyed by teamId; the userId-index GSI lets us find
    // every membership for this user in one query.
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teamMembers,
        IndexName: "userId-index",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      })
    );
    const rows = (res.Items as TeamMember[]) ?? [];
    return rows.filter((m) => !isInactiveMembership(m.status));
  }

  /**
   * ADMIT a member, ENFORCING THE SEAT CAP — ONE transaction.
   *
   * Read the interface note in domain.ts first; it states the contract. This note covers the
   * two things only the implementation can explain: how the outcome is disambiguated, and why
   * a legacy team needs a preliminary write.
   *
   * ── THE TRANSACTION ──
   *
   *   [0] Put    team-members  attribute_not_exists(userId)   ⇒ fails ⇒ "already-member"
   *   [1] Update teams         memberCount < seatCap          ⇒ fails ⇒ "full"
   *
   * Both conditions are evaluated together and the whole thing commits or none of it does, so
   * there is no interleaving in which a row exists without its seat, or a seat is consumed
   * without a row. The `teams` item is the serialization point: two concurrent admits at 9/10
   * contend on it and exactly one commits.
   *
   * `attribute_not_exists(userId)` on the SORT KEY rather than on `teamId`: for a composite
   * key either attribute proves item absence, and naming the sort key makes the intent
   * ("this person specifically") readable at the call site.
   *
   * ── WHY THE OUTCOME IS READ POSITIONALLY ──
   *
   * A cancelled transaction is ONE exception whose name is the same for both refusals. The
   * ONLY thing that distinguishes them is which index of `CancellationReasons` carries
   * `ConditionalCheckFailed` — hence TX_MEMBER_ITEM / TX_TEAM_ITEM and the array order above.
   * Conflating them is the defect §C names: telling somebody already on the team it is full.
   *
   * MEMBER-FIRST WHEN BOTH FAILED, deliberately. A returning member re-joining a team that is
   * at capacity trips both conditions, and "already-member" is the truthful answer: they have
   * the access, nothing is being granted, and "this team is full" would be alarming nonsense
   * to somebody who is already in it.
   *
   * ── THE LEGACY ROW, AND WHY THIS COSTS AN EXTRA WRITE EXACTLY ONCE ──
   *
   * `memberCount < :cap` is FALSE when `memberCount` is ABSENT. Every team row written before
   * the seat cap shipped has no such attribute, so arming the cap without initialising them would refuse
   * every join to every existing team — the failure the Residual risk section calls out.
   * So a cancellation whose ONLY failure is the team item triggers `initialiseLedger`, and the
   * admission is retried ONCE. Bounded at one retry on purpose: the initialiser is itself
   * conditional, so a second failure means the count is now present and the team is genuinely
   * full, and an unbounded retry loop on a write path is a far worse failure than a refusal.
   */
  async admit(member: TeamMember, workshopId: string): Promise<AdmitOutcome> {
    const first = await this.tryAdmit(member, workshopId);
    if (first !== "needs-ledger") return first;

    // The team predates the counter. Initialise from a STRONGLY CONSISTENT roster count,
    // then retry exactly once. `initialiseLedger` reports whether the ledger now exists at
    // all — false means we could not establish one, in which case the honest answer is the
    // refusal the store already gave rather than an admission we cannot account for.
    const initialised = await this.initialiseLedger(workshopId, member.teamId);
    if (!initialised) return "full";

    const second = await this.tryAdmit(member, workshopId);
    // Still refused on the team item AFTER a successful initialisation ⇒ the count is now
    // present and it genuinely reaches the cap. No further retry: see the note above.
    return second === "needs-ledger" ? "full" : second;
  }

  /**
   * One attempt at the admission transaction.
   *
   * `"needs-ledger"` is an INTERNAL fourth outcome, never returned to a caller: it means the
   * TEAM item's condition failed, which is either a genuinely full team or an absent
   * `memberCount`. Those two are indistinguishable from the cancellation alone — DynamoDB
   * reports the same `ConditionalCheckFailed` for "9 < 9" and for "absent < 9" — so the
   * distinction is drawn by the caller attempting the initialisation and seeing whether it
   * changes the answer.
   */
  private async tryAdmit(
    member: TeamMember,
    workshopId: string
  ): Promise<AdmitOutcome | "needs-ledger"> {
    try {
      await withConflictRetry(() =>
        this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLES.teamMembers,
                Item: member,
                ConditionExpression: "attribute_not_exists(userId)",
              },
            },
            {
              Update: {
                TableName: TABLES.teams,
                // BOTH key attributes — `teams` is (workshopId HASH, id RANGE).
                Key: { workshopId, id: member.teamId },
                UpdateExpression: "SET memberCount = memberCount + :one",
                ExpressionAttributeValues: { ":one": 1 },
                ConditionExpression: "memberCount < seatCap",
              },
            },
          ],
        })
      )
      );
      return "admitted";
    } catch (err) {
      const failures = transactionConditionFailures(err);
      // Not a cancelled transaction, or cancelled for a reason we do not model (throttle,
      // conflict, validation). RETHROWN — a join that silently failed would tell somebody
      // they are on a team they cannot open.
      if (!failures) throw err;
      // MEMBER FIRST: a returning member re-joining a full team trips both, and "you are
      // already on this team" is the answer that is true and actionable.
      if (failures[TX_MEMBER_ITEM]) return "already-member";
      if (failures[TX_TEAM_ITEM]) return "needs-ledger";
      // Cancelled, but no condition we recognise failed. Rethrown rather than guessed at:
      // reporting a refusal we cannot explain as "full" would be a fabricated reason.
      throw err;
    }
  }

  /**
   * SEED `memberCount` (and `seatCap` if absent) ON A LEGACY TEAM ROW, from a STRONGLY
   * CONSISTENT roster count.
   *
   * ── EVERY WORD OF THAT SENTENCE IS LOAD-BEARING ──
   *
   * STRONGLY CONSISTENT: an eventually-consistent Query can miss a row written moments ago,
   * and this count becomes the ledger — undercounting here permanently over-admits by exactly
   * the rows that were missed. `ConsistentRead: true` on a table-partition Query is legal and
   * costs 2x the RCU of an eventually-consistent one, which is the correct trade for a number
   * we will treat as authoritative from now on.
   *
   * `attribute_not_exists(memberCount)` GUARDS IT: two concurrent joiners can both observe the
   * absent counter and both try to initialise, and exactly ONE wins at the store. The loser's
   * condition fails, which is BENIGN and reported as success — the ledger it needed now
   * exists, which is all the caller asked. Without the guard the second initialiser would
   * OVERWRITE a count that had already been incremented by the winner's admission, silently
   * freeing a seat.
   *
   * ⚠ IT COUNTS THE *ACTIVE* ROSTER, matching the invariant's left-hand side exactly:
   * `|{m : ¬isInactiveMembership(m.status)}|`. `listByTeam` already applies that predicate via
   * the shared `isInactiveMembership`, so this cannot drift from what the rest of the platform
   * calls a member. Counting inactive rows too would initialise a team above its real roster
   * and refuse joins it should accept.
   *
   * `seatCap` is written ONLY if absent, via `if_not_exists`, and defaults to the platform
   * ceiling. That is the ONE place a cap is inferred rather than read from the workshop, and
   * it is bounded by the ceiling rather than invented: the alternative is that a legacy team
   * with no cap can never be joined at all, and MAX_TEAM_MEMBERS is the widest value the
   * platform permits under any workshop template. A facilitator narrows it with
   * `PATCH /teams/:teamId`; the one-time backfill script sets the real per-workshop value.
   *
   * Returns FALSE only when the ledger could not be established at all. A store failure is
   * SWALLOWED here rather than thrown, because the caller's next move on a false is to report
   * the store's own refusal — surfacing a 500 from a repair step would turn a legitimate
   * "team is full" into an outage.
   */
  /**
   * Set `memberCount` to the team's TRUE active-roster count, whatever it currently says.
   *
   * ── HOW THIS DIFFERS FROM `initialiseLedger`, AND WHY BOTH EXIST ──
   *
   * `initialiseLedger` is guarded on `attribute_not_exists(memberCount)` so it can never
   * overwrite a ledger that live traffic is maintaining — correct for its job, which is
   * establishing a count for a row that has none.
   *
   * That guard makes it useless for REPAIR: a drifted row already has a count, so
   * `initialiseLedger` would decline and leave the drift in place. This one overwrites
   * deliberately, and is therefore called only from the deactivate fallback — a path that has
   * already established the ledger is wrong and has just changed the roster.
   *
   * ⚠ DO NOT CALL THIS ON A HEALTHY PATH. Between the Query and the Update a concurrent admit
   * can commit, and this would then write a count that is stale by one — the very drift it
   * exists to fix. On the fallback that is an acceptable trade against a lost removal; on the
   * hot path it would be a self-inflicted race. The invariant is held by the conditional
   * transaction, never by recounting.
   */
  private async resyncLedger(
    workshopId: string,
    teamId: string
  ): Promise<boolean> {
    try {
      const res = await this.db.send(
        new QueryCommand({
          TableName: TABLES.teamMembers,
          KeyConditionExpression: "teamId = :teamId",
          ExpressionAttributeValues: { ":teamId": teamId },
          // This number BECOMES the ledger, so it cannot come from a stale replica.
          ConsistentRead: true,
        })
      );
      const rows = (res.Items as TeamMember[]) ?? [];
      const active = rows.filter((m) => !isInactiveMembership(m.status)).length;

      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.teams,
          Key: { workshopId, id: teamId },
          UpdateExpression:
            "SET memberCount = :count, seatCap = if_not_exists(seatCap, :defaultCap)",
          ExpressionAttributeValues: {
            ":count": active,
            ":defaultCap": LEGACY_TEAM_SEAT_CAP,
          },
          // The row must EXIST — never upsert a team. NO `attribute_not_exists(memberCount)`
          // here, and that omission is the entire point of this method.
          ConditionExpression: "attribute_exists(id)",
        })
      );
      console.warn("[team] resynced a drifted seat ledger from the roster", {
        teamId,
        memberCount: active,
      });
      return true;
    } catch (err) {
      console.error("[team] could not resync the seat ledger", {
        teamId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return false;
    }
  }

  private async initialiseLedger(
    workshopId: string,
    teamId: string
  ): Promise<boolean> {
    try {
      const res = await this.db.send(
        new QueryCommand({
          TableName: TABLES.teamMembers,
          KeyConditionExpression: "teamId = :teamId",
          ExpressionAttributeValues: { ":teamId": teamId },
          // See the note above: this number becomes the ledger.
          ConsistentRead: true,
        })
      );
      const rows = (res.Items as TeamMember[]) ?? [];
      const active = rows.filter((m) => !isInactiveMembership(m.status)).length;

      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.teams,
          Key: { workshopId, id: teamId },
          UpdateExpression:
            "SET memberCount = :count, seatCap = if_not_exists(seatCap, :defaultCap)",
          ExpressionAttributeValues: {
            ":count": active,
            ":defaultCap": LEGACY_TEAM_SEAT_CAP,
          },
          // The row must EXIST (never upsert a team) and must not already carry a count
          // (never overwrite a live ledger — see the note above).
          ConditionExpression:
            "attribute_exists(id) AND attribute_not_exists(memberCount)",
        })
      );
      console.log("[team] initialised the seat ledger for a legacy team row", {
        teamId,
        memberCount: active,
      });
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        // Benign and EXPECTED under concurrency: another initialiser won, or the count
        // appeared between the read and the write. The ledger exists either way, which is
        // what the caller needs, so the retry proceeds and the cap decides honestly.
        return true;
      }
      // A real store failure, or the team row does not exist. Reported as "could not
      // establish a ledger" so the caller answers the store's refusal rather than a 500.
      console.error("[team] could not initialise the seat ledger", {
        teamId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return false;
    }
  }

  /**
   * DEACTIVATE a membership, KEEPING THE ROW — a CONDITIONAL update, and the condition is the
   * point. Same shape and same reasoning as the two invitation flips above.
   *
   * `attribute_exists(teamId)` is what stops an UpdateCommand from UPSERTING: without it,
   * removing someone who was never on the team would FABRICATE an INACTIVE membership row for
   * them, which the roster would then render as a former member who never was.
   *
   * `#status <> :inactive` makes the SECOND and every later call a no-op AT THE STORE, so
   * `removedAt`/`removedBy` record the FIRST removal and never move. Operators retry removals
   * and that timestamp is evidence of when access was withdrawn — the same property
   * markRevoked provides for the invitation.
   *
   * `role` IS DELIBERATELY NOT TOUCHED. It is the preserved team role, and reactivation
   * restoring a LEAD as a LEAD depends entirely on nothing here clearing it.
   */
  async deactivate(
    teamId: string,
    userId: string,
    removedBy: string,
    removedByRole: string,
    workshopId: string
  ): Promise<boolean> {
    try {
      await withConflictRetry(() =>
        this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLES.teamMembers,
                Key: { teamId, userId },
                // `status` is a DynamoDB reserved word — alias it.
                UpdateExpression:
                  "SET #status = :inactive, removedAt = :now, removedBy = :actor, removedByRole = :actorRole",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":inactive": "INACTIVE",
                  ":now": new Date().toISOString(),
                  ":actor": removedBy,
                  ":actorRole": removedByRole,
                },
                ConditionExpression:
                  "attribute_exists(teamId) AND #status <> :inactive",
              },
            },
            {
              // ── THE SEAT IS FREED IN THE SAME TRANSACTION ──
              //
              // Not a second write: a removal that flipped the row but left the seat taken
              // would leave a team permanently unable to replace the person it just removed,
              // and nothing would ever notice — there is no reconciliation pass.
              Update: {
                TableName: TABLES.teams,
                Key: { workshopId, id: teamId },
                UpdateExpression: "SET memberCount = memberCount - :one",
                ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
                // FLOORED AT ZERO. A ledger that could go negative would then admit MORE
                // than the cap on the next join — a refusal turned into an over-admission by
                // arithmetic. `attribute_exists` is implied by the comparison (an absent
                // attribute fails it), which is the correct behaviour for a legacy row: it
                // has no ledger to decrement, and `admit` will count the roster fresh.
                ConditionExpression: "memberCount > :zero",
              },
            },
          ],
        })
      )
      );
      return true;
    } catch (err) {
      const failures = transactionConditionFailures(err);
      // The expected, benign outcome when there is no membership row or it is already
      // INACTIVE — the MEMBER item's condition. Reported as `false`, exactly as before.
      if (failures?.[TX_MEMBER_ITEM]) return false;
      if (failures?.[TX_TEAM_ITEM]) {
        const flipped = await this.deactivateRowOnly(
          teamId,
          userId,
          removedBy,
          removedByRole
        );
        if (flipped) {
          const resynced = await this.resyncLedger(workshopId, teamId);
          if (!resynced) {
            console.error(
              "[team] removed a member and could NOT resync the seat ledger — the cap for this team is now unreliable in EITHER direction",
              { teamId, userId, workshopId }
            );
          }
        }
        return flipped;
      }
      // Not a cancelled transaction, or cancelled for a reason we do not model. RETHROWN,
      // because a deactivation that silently failed would leave the person with full access
      // while the operator was told they were removed — the one outcome this path exists to
      // prevent. The route reports it as a 5xx.
      throw err;
    }
  }

  /**
   * THE FALLBACK FLIP: deactivate the row WITHOUT touching the seat ledger.
   *
   * Reached only when the ledger item was the sole reason the transaction was cancelled —
   * i.e. the team row carries no `memberCount`, or it is already 0. See the caller for why
   * losing the removal is the worse outcome and why the resulting over-count is acceptable
   * and observable.
   *
   * BYTE-IDENTICAL CONDITIONS to the transactional version's member item, so this cannot
   * become a way to flip a row the real path would refuse: no row, or already INACTIVE, is
   * still a no-op reporting `false`.
   */
  private async deactivateRowOnly(
    teamId: string,
    userId: string,
    removedBy: string,
    removedByRole: string
  ): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.teamMembers,
          Key: { teamId, userId },
          UpdateExpression:
            "SET #status = :inactive, removedAt = :now, removedBy = :actor, removedByRole = :actorRole",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":inactive": "INACTIVE",
            ":now": new Date().toISOString(),
            ":actor": removedBy,
            ":actorRole": removedByRole,
          },
          ConditionExpression:
            "attribute_exists(teamId) AND #status <> :inactive",
        })
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) return false;
      throw err;
    }
  }

  /**
   * REACTIVATE a deactivated membership — a CONDITIONAL update, and BOTH conditions matter for
   * different reasons.
   *
   * `attribute_exists(teamId)` — THERE IS A ROW. Without it this route becomes a way to add an
   *   ARBITRARY user to an ARBITRARY team, bypassing every invitation gate, because an
   *   UpdateCommand CREATES the item when the key does not match. That would be a
   *   privilege-granting upsert reachable by anyone who may write the team. Re-admitting a
   *   never-member is an invitation, not a reactivation.
   * `#status = :inactive` — IT IS ACTUALLY DEACTIVATED. Positive equality here rather than the
   *   `<>` the other flips use, because this is the only one whose precondition is a SPECIFIC
   *   state rather than "not yet in the terminal state". It makes two concurrent reactivations
   *   resolve to exactly one winner AT THE STORE, so they cannot both report success and write
   *   two audit entries for one restoration.
   *
   * `role` IS NOT WRITTEN. The row kept it through the removal, so the restored member returns
   * as whatever they were — a LEAD comes back a LEAD. Reconstructing the role from an
   * invitation would be a guess, and re-defaulting it to BUILDER would silently demote people.
   *
   * `removedAt`/`removedBy`/`removedByRole` are also NOT cleared, deliberately: they are the
   * record of the removal that happened, and a REMOVE of them would erase history to tidy a
   * row. `status` is the only field that says what holds NOW, which is why every reader is
   * keyed on it and not on the presence of `removedAt`.
   */
  async reactivate(
    teamId: string,
    userId: string,
    reactivatedBy: string,
    workshopId: string
  ): Promise<AdmitOutcome> {
    const first = await this.tryReactivate(
      teamId,
      userId,
      reactivatedBy,
      workshopId
    );
    if (first !== "needs-ledger") return first;

    // A legacy team row with no `memberCount`. Same one-shot repair as `admit`, and required
    // for the same reason: `memberCount < seatCap` is FALSE for an absent attribute, so
    // without this every restoration on every pre-existing team would be refused as "full".
    const initialised = await this.initialiseLedger(workshopId, teamId);
    if (!initialised) return "full";

    const second = await this.tryReactivate(
      teamId,
      userId,
      reactivatedBy,
      workshopId
    );
    return second === "needs-ledger" ? "full" : second;
  }

  /**
   * One attempt at the restoration transaction. `"needs-ledger"` is internal — see
   * `tryAdmit`, which carries the same contract for the same reason.
   */
  private async tryReactivate(
    teamId: string,
    userId: string,
    reactivatedBy: string,
    workshopId: string
  ): Promise<AdmitOutcome | "needs-ledger"> {
    try {
      await withConflictRetry(() =>
        this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLES.teamMembers,
                Key: { teamId, userId },
                // `status` is a DynamoDB reserved word — alias it.
                UpdateExpression:
                  "SET #status = :active, reactivatedAt = :now, reactivatedBy = :actor",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":active": "ACTIVE",
                  ":inactive": "INACTIVE",
                  ":now": new Date().toISOString(),
                  ":actor": reactivatedBy,
                },
                ConditionExpression:
                  "attribute_exists(teamId) AND #status = :inactive",
              },
            },
            {
              Update: {
                TableName: TABLES.teams,
                Key: { workshopId, id: teamId },
                UpdateExpression: "SET memberCount = memberCount + :one",
                ExpressionAttributeValues: { ":one": 1 },
                ConditionExpression: "memberCount < seatCap",
              },
            },
          ],
        })
      )
      );
      return "admitted";
    } catch (err) {
      const failures = transactionConditionFailures(err);
      if (!failures) throw err;
      // MEMBER FIRST, as in `admit`: the row is already ACTIVE or absent, which the caller
      // disambiguates with getIncludingInactive (a 200 and a 404). Checked before the seat
      // rule so an already-restored member is never told the team is full.
      if (failures[TX_MEMBER_ITEM]) return "already-member";
      if (failures[TX_TEAM_ITEM]) return "needs-ledger";
      throw err;
    }
  }
}

/**
 * ── THE INVITATION READS ARE PAGED, AND THEIR BOUND IS A REFUSAL ──────────────────────
 *
 * `listByEmail` and `listByTeam` each used to issue ONE QueryCommand and return `res.Items`.
 * Neither followed `LastEvaluatedKey` and neither set a `Limit`, so each returned DynamoDB's
 * first 1MB page and SILENTLY DROPPED the rest. That is the failure mode this repo has now
 * fixed twice: `listByEmail` feeds `GET /v1/entitlements/workshops`, an AUTHORIZATION UNION,
 * where a quietly short list UNDER-GRANTS — a judge with many invitations loses a workshop
 * they actually hold, and nothing anywhere says so.
 *
 * ── WHY THE BOUND THROWS INSTEAD OF RETURNING A SHORT LIST ──
 *
 * Both methods return `Promise<Invitation[]>` and KEEP that signature (see the note on
 * `listInvitationsBounded`). An array return has exactly TWO channels: the array, or an
 * exception. A short array is the forbidden one — it is indistinguishable from a complete
 * answer at every call site. So the exception IS the report, and it is one no caller can
 * accidentally ignore the way a `truncated` boolean can be.
 *
 * It is also what the routes already want. Every caller of these two methods, unchanged,
 * fails CLOSED on a throw, and the two that are GATES produce exactly the refusal this
 * service already chose for the identical situation:
 *
 *   /entitlements/workshops   catches → 503 ENTITLEMENTS_UNAVAILABLE ("undetermined, not
 *                             empty" — the route's own stated rule)
 *   POST …/members/…/reactivate  catches → 503 SUBJECT_UNAVAILABLE, the SAME answer
 *                             MAX_SUBJECT_INVITATIONS (routes.ts) already gives on overflow,
 *                             because dropping a row from a refusal gate's evidence can drop
 *                             the row that would have refused
 *   POST /invitations/mine/accept  catches → 200 with `failed: 1`; the flip is idempotent and
 *                             the next sign-in retries it for free
 *   the four remaining readers   do not catch → Hono's default handler, an opaque
 *                             "Internal Server Error" 500 with the detail in the log only
 *
 * ── A `Limit` IS SAFE HERE, UNLIKE EVERYWHERE ELSE IN THIS FILE ──
 *
 * The rest of this file warns repeatedly that DynamoDB applies a FilterExpression AFTER the
 * Limit, so Limit + filter returns short pages (see `listDirectory`, `listByTeamIncludingInactive`,
 * `DynamoAuditRepository.listByTeam`). NEITHER of these two methods sends a FilterExpression, so
 * that hazard does not apply: `Limit` bounds rows and nothing else. Do not add a filter to
 * either one without re-reading this paragraph.
 */

/**
 * The row budget for `listByEmail` — invitations held by ONE EMAIL ADDRESS.
 *
 * A single-partition Query on `email-index`, so this is "how many teams was one person
 * invited to". Real answers are 1–5. 500 is 10× MAX_SUBJECT_INVITATIONS (routes.ts:119, the
 * reactivation gate's own 50-row refusal threshold) DELIBERATELY: the route's gate must stay
 * the thing that decides a refusal for a merely-large subject, and this is the backstop for
 * the STORE's own paging underneath it. 500 invitations for one address is not a busy day,
 * it is a corrupted or abused table.
 */
const MAX_INVITATION_ROWS_PER_EMAIL = 500;

/**
 * The row budget for `listByTeam` — invitations issued against ONE teamId.
 *
 * Sized to be NO TIGHTER THAN WHAT THE CODE ALREADY RETURNED, which is the do-no-harm
 * property: the old single Query returned one 1MB page ≈ 5,000 rows of this shape, so a call
 * that works today cannot start refusing because of this change.
 *
 * It binds on `listByTeam(PLATFORM_INVITATION_TEAM_ID)` and nowhere else. That partition grows
 * with every platform invitation ever issued and is never pruned — the rows ARE the audit
 * record — so it is the one caller that will genuinely reach a bound. Live count is 8, so this
 * is roughly three orders of magnitude of headroom; see the follow-up note below for what has
 * to happen before it is reached.
 */
const MAX_INVITATION_ROWS_PER_TEAM = 5000;

/**
 * How many Query round-trips ONE bounded invitation read may make.
 *
 * Five, matching MAX_DIRECTORY_SCAN_ROUND_TRIPS above, for the reason the page sizes there
 * match identity's: an operator should not have to discover that two reads in one file bound
 * themselves differently. Five 1MB pages is ample to reach either row budget — the budget is
 * the constraint that actually fires, and this caps the WORK when the store hands back pages
 * smaller than asked for.
 *
 * Unlike `listDirectory`'s cap this one is not expected to bind, because there is no
 * FilterExpression to empty a page. It exists so a pathological store response cannot turn one
 * request into an unbounded walk.
 */
const MAX_INVITATION_QUERY_ROUND_TRIPS = 5;

/**
 * Thrown when a bounded invitation read could not return a COMPLETE answer.
 *
 * A distinct type rather than a bare Error so a future caller can tell "the evidence is
 * incomplete" from "the store failed", and answer differently if it ever needs to. Today no
 * caller discriminates — every one of them already fails closed on any throw — and that is
 * fine: the guarantee this class carries is that the incomplete answer is NEVER RETURNED.
 *
 * `name` is assigned explicitly because the bundler mangles class names, and `name` is the
 * stable contract this file already relies on for error identification (see
 * isConditionalCheckFailure).
 */
export class InvitationQueryBoundExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationQueryBoundExceeded";
  }
}

/**
 * Run a bounded, fully-paged invitation Query, or THROW rather than truncate.
 *
 * ONE helper for both readers, for the reason `clampAuditLimit` is shared: two reads that
 * bound themselves differently are two bounds to discover at runtime, and the whole point of
 * this change is that neither read may quietly return a partial answer.
 *
 * ── THE OVER-FETCH BY ONE IS LOAD-BEARING, AND IT IS AN OFF-BY-ONE FIX ──
 *
 * It asks for `budget + 1` rows and refuses only when it actually SEES more than `budget`.
 * Trusting `LastEvaluatedKey` alone would refuse a COMPLETE answer of exactly `budget` rows:
 * DynamoDB sets that key whenever a Query stops on Limit, INCLUDING when it stopped on the
 * last matching row (the same behaviour `listDirectory` documents). So a team with exactly 5,000 invitations would 500 forever. Seeing row
 * `budget + 1` is the only proof that a row is being left behind.
 *
 * @param scopeLabel a NON-PII identifier for the log/error message. `teamId` qualifies; an
 *        EMAIL DOES NOT — it is the subject's PII and the caller passes the index name
 *        instead. This message reaches an operator's log, never the client body.
 */
async function listInvitationsBounded(
  db: DocClient,
  query: {
    IndexName?: string;
    KeyConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  },
  budget: number,
  scopeLabel: string
): Promise<Invitation[]> {
  // One more than the budget: seeing it is what distinguishes "exactly budget rows, complete"
  // from "more rows than we will accept". See the note above.
  const ceiling = budget + 1;

  const found: Invitation[] = [];
  let lastKey: Record<string, unknown> | undefined;
  let exhausted = false;

  for (let trip = 0; trip < MAX_INVITATION_QUERY_ROUND_TRIPS; trip++) {
    const res = await db.send(
      new QueryCommand({
        TableName: TABLES.invitations,
        ...query,
        // Only what is still missing, so a nearly-complete read does not over-fetch, and so
        // the STORE never ships more rows than this process has agreed to hold. Safe because
        // there is no FilterExpression on either caller — see the block comment above.
        Limit: ceiling - found.length,
        ExclusiveStartKey: lastKey,
      })
    );

    // Bounded by `ceiling` (≤ 5,001), so the spread is far inside the engine's argument
    // limit. The budget is what keeps that true; do not raise it without re-checking this.
    found.push(...((res.Items as Invitation[]) ?? []));
    lastKey = res.LastEvaluatedKey;

    // The authoritative "no more rows" signal — a COMPLETE answer.
    if (!lastKey) {
      exhausted = true;
      break;
    }
    if (found.length >= ceiling) break;
  }

  // ── THE BOUND IS REPORTED, NEVER RETURNED AS A QUIETLY SHORT LIST ──────────────────
  //
  // Two distinct ways the answer can be incomplete, and both must refuse:
  //   found.length > budget  — we SAW a row past the budget, so rows are being left behind.
  //   !exhausted             — the round-trip cap stopped us with the store still reporting
  //                            more. Same reasoning as `listDirectory`'s `!exhausted`, which
  //                            is the conjunct that was once missing there and broke every
  //                            partial page.
  if (found.length > budget || !exhausted) {
    throw new InvitationQueryBoundExceeded(
      // Operator-informative, attacker-opaque, and NO PII: counts and a non-PII scope label
      // only. The client sees whatever the calling route decides — a 503 at both gates, an
      // opaque 500 elsewhere — never this text.
      `invitation read exceeded its bound (scope=${scopeLabel}, rows=${found.length}, ` +
        `budget=${budget}, trips=${MAX_INVITATION_QUERY_ROUND_TRIPS}, exhausted=${exhausted}) ` +
        `— refusing to return a truncated list`
    );
  }

  return found;
}

export class DynamoInvitationRepository implements InvitationRepository {
  constructor(private readonly db: DocClient) {}

  async get(teamId: string, email: string): Promise<Invitation | null> {
    const res = await this.db.send(
      new GetCommand({
        TableName: TABLES.invitations,
        Key: { teamId, email: email.toLowerCase() },
      })
    );
    return (res.Item as Invitation) ?? null;
  }

  /**
   * Every invitation for one address, ACROSS EVERY PAGE — or a throw. See the block comment
   * above `MAX_INVITATION_ROWS_PER_EMAIL` for why a bound here refuses rather than truncates.
   *
   * This is the read behind `GET /v1/entitlements/workshops`, which is an AUTHORIZATION
   * DECISION, so a short list here is an under-grant nobody is told about. It is also the
   * reactivation gate's only evidence, where a dropped row can be the row that would have
   * refused.
   *
   * The scope label passed to the helper is the INDEX NAME and NOT the address: the address is
   * the subject's PII and this string reaches a log.
   */
  async listByEmail(email: string): Promise<Invitation[]> {
    return listInvitationsBounded(
      this.db,
      {
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": email.toLowerCase() },
      },
      MAX_INVITATION_ROWS_PER_EMAIL,
      "email-index"
    );
  }

  async getByTokenHash(tokenHash: string): Promise<Invitation | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.invitations,
        IndexName: "tokenHash-index",
        KeyConditionExpression: "tokenHash = :hash",
        ExpressionAttributeValues: { ":hash": tokenHash },
        Limit: 1,
      })
    );
    return (res.Items?.[0] as Invitation) ?? null;
  }

  /**
   * Every invitation issued against one teamId, ACROSS EVERY PAGE — or a throw.
   *
   * A Query on the BASE TABLE's partition key, with no IndexName: `teamId` IS the hash key, so
   * there is no index to name and adding one would be wrong.
   *
   * ⚠ THE PARTITION THAT WILL ACTUALLY REACH THE BOUND is the PLATFORM sentinel. It accumulates
   * every platform invitation ever issued and nothing prunes it — the rows are the audit record
   * — so it is the one caller for which MAX_INVITATION_ROWS_PER_TEAM is a real ceiling rather
   * than a theoretical one. Its single caller is `GET /teams/:teamId/invitations`, a
   * human-facing list which already post-filters per row by the invite matrix; when this
   * refuses, that screen 500s rather than rendering a list missing rows an operator needs to
   * find and revoke. That is the correct trade at a bound this far out (live count: 8), and the
   * fix when it is approached is a paged route contract, not a larger constant.
   *
   * `teamId` IS the scope label — it is a system identifier, not PII, and it is the one fact an
   * operator needs to know which partition overflowed.
   */
  async listByTeam(teamId: string): Promise<Invitation[]> {
    return listInvitationsBounded(
      this.db,
      {
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      },
      MAX_INVITATION_ROWS_PER_TEAM,
      teamId
    );
  }

  /**
   * Write an invitation row.
   *
   * ── ⚠ CONDITIONAL, AND THE CONDITION IS THE SECOND HALF OF A FIX ──────────────
   *
   * This was a bare `PutCommand`, so it REPLACED any existing row on key (teamId, email) — new
   * tokenHash, status back to PENDING, `invitedBy` reset to the caller, and acceptedAt/acceptedBy
   * destroyed. The route's gate 6 now refuses that case before we get here; this is the guard that
   * does not depend on a caller remembering to ask.
   *
   * ⚠ WHY BOTH, RATHER THAN JUST THE ROUTE GATE. The gate reads and then writes, so two concurrent
   * invitations for the same address can both pass it and the second would still clobber an accepted
   * row. It is also the only protection a FUTURE caller of this method inherits for free — the
   * defect being fixed is precisely that one write path had no idea what it was overwriting.
   *
   * ⚠ WHAT IT DELIBERATELY STILL ALLOWS: overwriting a PENDING or REVOKED row. Re-sending an
   * invitation is ordinary, and re-inviting a REVOKED address is the documented way to re-admit
   * someone — a condition of `attribute_not_exists` alone would have broken both.
   *
   * On a race, DynamoDB raises `ConditionalCheckFailedException` and this rethrows it as-is: the
   * route's failure semantics are "the first rejection propagates and the request 500s", which is a
   * loud, correct answer for a genuine race and far better than silently swallowing the collision.
   */
  async put(invitation: Invitation): Promise<Invitation> {
    await this.db.send(
      new PutCommand({
        TableName: TABLES.invitations,
        Item: { ...invitation, email: invitation.email.toLowerCase() },
        /**
         * `email` is the RANGE key, so `attribute_not_exists(email)` is the idiomatic "this item does
         * not exist yet" — it cannot be a partial-item check, because a stored item always has its key.
         *
         * ⚠ `attribute_not_exists(#status)` IS THE SECOND CLAUSE AND IT IS NOT PADDING. A comparison
         * against an ABSENT attribute evaluates FALSE in DynamoDB, so without it every row written
         * before `status` existed would become un-overwritable — refusing re-invitation of exactly the
         * legacy rows `isSpentInvitation` goes out of its way to keep admittable ("ABSENT STATUS IS NOT
         * SPENT … a lockout, which is worse than the leak").
         *
         * ⚠ THIS COMPARISON IS CASE-SENSITIVE AND THE ROUTE'S IS NOT. `isAcceptedInvitation`
         * normalises case because the string crosses three bundles; a `ConditionExpression` cannot.
         * So the route gate remains the primary check and this is the backstop for the canonical
         * casing every writer in this repo actually produces — narrower than the gate, deliberately,
         * rather than a second source of truth that could disagree with it.
         */
        ConditionExpression:
          "attribute_not_exists(email) OR attribute_not_exists(#status) OR #status <> :accepted",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":accepted": "ACCEPTED" },
      })
    );
    return invitation;
  }

  /**
   * Flip an invitation to ACCEPTED exactly once — a CONDITIONAL update, and the
   * condition is the whole point.
   *
   * `attribute_exists(teamId)` alone was not enough. This now runs on EVERY sign-in
   * (POST /invitations/mine/accept), so an unconditional SET would move `acceptedAt`
   * forward every time the person logged in — erasing when they first took up the
   * grant, which is the audit fact the field exists for and the reason the revoke gate
   * refuses to delete an ACCEPTED row. Adding `#status <> :accepted` makes the SECOND
   * and every later call a no-op AT THE STORE, so idempotency does not depend on a
   * read-before-write (which would be a race between the read and the update anyway).
   *
   * Returns whether THIS call did the flip, distinguished by the error DynamoDB
   * returns: a ConditionalCheckFailedException means "no row, already accepted, or
   * REVOKED" — all benign — while anything else (throttle, timeout, AccessDenied) is a real
   * failure and is RETHROWN. The previous bare `catch {}` swallowed those identically,
   * which is how a store problem could look exactly like a successful accept.
   *
   * A REVOKED ROW IS NEVER RE-ACCEPTED — see the third condition below. That is the store's
   * half of the removal fix, and it holds for every caller of this method rather than only
   * the ones that remembered to check.
   */
  async accept(
    teamId: string,
    email: string,
    acceptedBy?: string
  ): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.invitations,
          Key: { teamId, email: email.toLowerCase() },
          // `status` is a DynamoDB reserved word — alias it.
          UpdateExpression: acceptedBy
            ? "SET #status = :status, acceptedAt = :now, acceptedBy = :userId"
            : "SET #status = :status, acceptedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "ACCEPTED",
            ":revoked": "REVOKED",
            ":now": new Date().toISOString(),
            ...(acceptedBy ? { ":userId": acceptedBy } : {}),
          },
          // Three conditions, all load-bearing:
          //   attribute_exists(teamId)  — there IS a row (no accidental upsert; an
          //                               UpdateCommand creates the item otherwise,
          //                               which would fabricate an ACCEPTED invitation
          //                               for an address nobody invited).
          //   #status <> :status        — it is not ACCEPTED yet, so acceptedAt and
          //                               acceptedBy are written once and never moved.
          //   #status <> :revoked       — A WITHDRAWN GRANT IS NEVER RE-ACCEPTED. Added
          //                               with the removal-driven revocation: REVOKED is a
          //                               TERMINAL status, and an accept that moved a row
          //                               out of it would destroy the record of the
          //                               withdrawal AND hand back a row the join gate
          //                               reads as live. AT THE STORE rather than only in
          //                               the routes, because `accept` has THREE callers
          //                               (the join path, the sign-in flip, and the staff
          //                               reconciliation PATCH) and a rule enforced in two
          //                               of them is a rule the third one breaks. Only a
          //                               person with grant authority issuing a FRESH
          //                               invitation re-admits someone.
          ConditionExpression:
            "attribute_exists(teamId) AND #status <> :status AND #status <> :revoked",
        })
      );
      return true;
    } catch (err) {
      // The expected, benign outcome on a repeat call or a missing row. Matched on
      // `name`, which is the stable contract on an AWS SDK error — never on message
      // text.
      if (isConditionalCheckFailure(err)) return false;
      // A real store failure. Rethrown so the caller decides — every current caller
      // logs it and carries on rather than failing the user's request, but that is
      // THEIR decision to make, and it cannot be made about an error it never sees.
      throw err;
    }
  }

  /**
   * Flip an invitation to the terminal REVOKED status, KEEPING THE ROW — a CONDITIONAL
   * update, exactly like accept() above and for the same reason.
   *
   * `#status <> :revoked` makes the SECOND and every later call a no-op AT THE STORE, so
   * `revokedAt` records the FIRST revocation and never moves. Removals get retried (a
   * double-click, a client retry, an operator unsure whether the first attempt landed) and
   * the timestamp is evidence of when the grant was withdrawn.
   *
   * `attribute_exists(teamId)` is what stops an UpdateCommand from UPSERTING: without it,
   * revoking a member who was never invited would FABRICATE a REVOKED invitation row for
   * their address — which the former-members view would then read as provenance that does
   * not exist.
   *
   * NOTE the condition does NOT require the row to be ACCEPTED. A member can hold a
   * PENDING row (they joined by invite code before the sign-in flip landed, or the flip
   * failed and was never reconciled), and that row is just as much a way back in — so it
   * is withdrawn too. Both terminal states are refused by isSpentInvitation, so the two
   * cases converge on the same answer at the join gate.
   */
  async markRevoked(
    teamId: string,
    email: string,
    revokedBy: string
  ): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.invitations,
          Key: { teamId, email: email.toLowerCase() },
          // `status` is a DynamoDB reserved word — alias it.
          UpdateExpression:
            "SET #status = :revoked, revokedAt = :now, revokedBy = :actor",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":revoked": "REVOKED",
            ":now": new Date().toISOString(),
            ":actor": revokedBy,
          },
          ConditionExpression:
            "attribute_exists(teamId) AND #status <> :revoked",
        })
      );
      return true;
    } catch (err) {
      // The expected, benign outcome when there is no invitation for this member or it is
      // already REVOKED. Matched on `name`, the stable contract on an AWS SDK error.
      if (isConditionalCheckFailure(err)) return false;
      // A real store failure. Rethrown so the removal route can report that the grant may
      // still be live rather than claiming a clean revocation — see the interface note.
      throw err;
    }
  }

  /**
   * REMOVE the `workshopId` attribute, keeping the row and every other field — a CONDITIONAL
   * update, and the condition is what makes a retried withdrawal a no-op AT THE STORE.
   *
   * `REMOVE workshopId` and NOT `SET workshopId = :empty`. An empty string would still be an
   * attribute, and `Invitation.workshopId`'s own contract says ABSENT means "no workshop
   * grant" — while `GET /v1/entitlements/workshops` tests `typeof … === "string" && …`, so an
   * empty value happens to be excluded there TODAY. Relying on that would put the correctness
   * of a revocation in one reader's truthiness check; removing the attribute is what makes
   * every reader, including a future one, see no grant.
   *
   * `attribute_exists(teamId)` stops an UpdateCommand from UPSERTING, exactly as on the two
   * flips above: without it, clearing the entitlement of an address nobody invited would
   * FABRICATE a row carrying `workshopRevokedBy` and no invitation — provenance for a grant
   * that never existed.
   *
   * `attribute_exists(workshopId)` is the idempotency condition. The SECOND and every later
   * call is a no-op at the store, so `workshopRevokedAt` records the FIRST withdrawal and
   * never moves, and two concurrent calls cannot both report success and write two audit
   * entries. Positive existence rather than the `<>` the status flips use, for the same reason
   * `reactivate` uses `=`: the precondition here is a SPECIFIC state (there is a grant to
   * withdraw), not "not yet terminal".
   *
   * `status`, `acceptedAt`, `acceptedBy`, `invitedBy`, `sentAt` and `platformRole` are
   * DELIBERATELY UNTOUCHED. The row is the audit record of who granted this person access and
   * when they took it up — the same fact that makes the DELETE route refuse a terminal row —
   * and this operation withdraws an entitlement, not a history.
   */
  async clearWorkshop(
    teamId: string,
    email: string,
    revokedBy: string
  ): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.invitations,
          Key: { teamId, email: email.toLowerCase() },
          // ONE UpdateExpression with both clauses, so the breadcrumb cannot land without the
          // removal or vice versa — and so `workshopRevokedBy` is durable BEFORE the route's
          // audit call, which is what keeps the actor recoverable when the trail write fails.
          UpdateExpression:
            "REMOVE workshopId SET workshopRevokedAt = :now, workshopRevokedBy = :actor",
          ExpressionAttributeValues: {
            ":now": new Date().toISOString(),
            ":actor": revokedBy,
          },
          ConditionExpression:
            "attribute_exists(teamId) AND attribute_exists(workshopId)",
        })
      );
      return true;
    } catch (err) {
      // The expected, benign outcome when there is no invitation for this address on this
      // team, or the row carries no workshop grant to withdraw. Matched on `name`, the stable
      // contract on an AWS SDK error.
      if (isConditionalCheckFailure(err)) return false;
      // A real store failure. Rethrown so the route answers a 5xx rather than reporting an
      // entitlement withdrawal that did not happen — a judge would keep reading the workshop
      // while the operator believed the access was gone.
      throw err;
    }
  }

  async revoke(teamId: string, email: string): Promise<boolean> {
    // ReturnValues distinguishes "deleted a row" from "the key matched nothing":
    // a bare DeleteCommand succeeds either way, which would let the route report a
    // revocation that never happened.
    const res = await this.db.send(
      new DeleteCommand({
        TableName: TABLES.invitations,
        Key: { teamId, email: email.toLowerCase() },
        ReturnValues: "ALL_OLD",
      })
    );
    return res.Attributes !== undefined;
  }
}

/**
 * Append-only audit store.
 *
 * WHY THE SORT KEY IS `<iso>#<ulid>` AND NOT JUST THE TIMESTAMP. Two administrative actions
 * on the same person within the same millisecond would collide on a bare ISO instant, and
 * DynamoDB's PutItem would SILENTLY OVERWRITE the earlier one — losing an audit entry, which
 * is the one failure this table cannot be permitted to have. The ULID suffix makes every key
 * unique while preserving lexicographic time order, so a Query with ScanIndexForward: false
 * still returns newest-first with no in-memory sort.
 *
 * NEVER THROWS OUT OF `record`. See the interface note: failing the action being recorded
 * would be worse than a missing entry, because the caller's mutation has already happened
 * and a retry would report a confusing "not a member". Returns false so the route can report
 * `audited: false` and an operator can act on it.
 */
export class DynamoAuditRepository implements AuditRepository {
  constructor(private readonly db: DocClient) {}

  async record(entry: AuditEntryWrite): Promise<boolean> {
    const occurredAt = new Date().toISOString();
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.audit,
          Item: {
            ...entry,
            // Denormalised alongside the composite key so a reader never has to parse it.
            occurredAt,
            at: `${occurredAt}#${ulid()}`,
          },
          // Belt and braces on top of the unique sort key: refuse rather than overwrite if
          // a key somehow repeats. On an audit trail, losing a row silently is the failure
          // mode worth two lines of defence.
          ConditionExpression: "attribute_not_exists(subjectId)",
        })
      );
      return true;
    } catch (err) {
      // A ConditionalCheckFailed here means the (astronomically unlikely) same
      // subject+timestamp+ULID already exists. Everything else is a real store failure.
      // Both are logged and swallowed — see the class note on why this must not throw.
      console.error("[team] AUDIT WRITE FAILED — the action succeeded but is unrecorded", {
        action: entry.action,
        subjectId: entry.subjectId,
        actorId: entry.actorId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return false;
    }
  }

  async listBySubject(subjectId: string, limit = 50): Promise<AuditEntryRead[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.audit,
        KeyConditionExpression: "subjectId = :s",
        ExpressionAttributeValues: { ":s": subjectId },
        // Newest first — the order an investigation reads in.
        ScanIndexForward: false,
        Limit: clampAuditLimit(limit),
      })
    );
    return (res.Items as AuditEntryRead[]) ?? [];
  }

  /**
   * Every entry for ONE TEAM, newest first — via the teamId-index GSI.
   *
   * A single-partition Query on `teamId`, sorted by the same `at#ulid` range key as the
   * base table, so "who was removed from this team, most recently first" costs one read
   * with no in-memory sort. Before that index existed the question was answerable only by
   * a Scan of the whole trail, which is why the route did not exist.
   *
   * NO FilterExpression on `action`, deliberately — DynamoDB applies a filter AFTER the
   * Limit, so filtering here would return fewer rows than the caller asked for and a short
   * list would read as "there were no more removals". The route filters what it got.
   */
  async listByTeam(teamId: string, limit = 50): Promise<AuditEntryRead[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.audit,
        IndexName: "teamId-index",
        KeyConditionExpression: "teamId = :t",
        ExpressionAttributeValues: { ":t": teamId },
        ScanIndexForward: false,
        Limit: clampAuditLimit(limit),
      })
    );
    return (res.Items as AuditEntryRead[]) ?? [];
  }
}

/**
 * Clamp a caller-supplied audit page size into [1, 100].
 *
 * 100 because the trail is read by a person on a screen, and an unbounded Limit is a way
 * for one request to pull an arbitrary slab of an append-only table that never shrinks.
 * Shared by both reads so the two cannot drift into different bounds — a caller that
 * learns one limit from the subject view and gets another from the team view has to
 * discover the difference at runtime.
 */
function clampAuditLimit(limit: number): number {
  return Math.min(Math.max(1, limit), 100);
}
