import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { User, UserPage, UserRepository } from "./domain.js";

// Page size for list(). Bounded so one Administration page load can never turn into
// an unbounded table read, and capped separately from whatever a caller asks for.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * How many Scan round-trips one list() call may make while trying to fill a page.
 *
 * A FilterExpression is applied by DynamoDB AFTER Limit, so a filtered Scan can
 * return a SHORT page (or an empty one) while still having more matches further on.
 * Left alone that produces a visibly broken screen: "Next" enabled under two rows.
 * The loop below keeps scanning to fill the page, and this caps it so a table that
 * is mostly filtered-out rows costs a bounded number of reads per request rather
 * than a full table walk.
 */
const MAX_SCAN_ROUND_TRIPS = 5;

/** BatchGetItem's hard limit: 100 keys per request. Not a tunable. */
const BATCH_GET_CHUNK = 100;

/**
 * Retries for BatchGetItem's UnprocessedKeys.
 *
 * DynamoDB may return a subset and hand the rest back as UnprocessedKeys (throttling,
 * or a response nearing 16MB). Ignoring that field is the classic silent-truncation
 * bug: rows vanish from the result with no error, and at four users in dev it would
 * never once reproduce.
 */
const MAX_BATCH_GET_RETRIES = 3;

/** DynamoDB implementation of UserRepository — the only file that knows the users
 *  table exists. Swap this to re-home the data; routes never change. */
export class DynamoUserRepository implements UserRepository {
  private readonly table = process.env.TABLE_USERS || "praimana-users";

  constructor(private readonly db: DocClient) {}

  async getById(id: string): Promise<User | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { id } })
    );
    return (res.Item as User) ?? null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": email },
        Limit: 1,
      })
    );
    return (res.Items?.[0] as User) ?? null;
  }

  async put(user: User): Promise<User> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: user }));
    return user;
  }

  /**
   * SET the profile fields and nothing else — see UserRepository.updateProfile for the four
   * attributes the previous full-item Put deleted on every profile save.
   *
   * ⚠ NO ConditionExpression, deliberately. The route only calls this when it has already read a
   * row, and an `attribute_exists(id)` here would turn the read-then-write race into a 500 on a
   * path where the correct behaviour is simply to write the fields. The CREATE case is the
   * route's `put`, which is where absence is handled.
   *
   * `#name` is aliased because `name` is a DynamoDB reserved word; the others are not, but they
   * are aliased too so the expression stays uniform and a future rename cannot half-break it.
   */
  async updateProfile(
    id: string,
    fields: {
      firstName: string;
      lastName: string;
      organization: string;
      name: string;
      updatedAt: string;
    }
  ): Promise<User> {
    const res = await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { id },
        UpdateExpression:
          "SET #firstName = :firstName, #lastName = :lastName, " +
          "#organization = :organization, #name = :name, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#firstName": "firstName",
          "#lastName": "lastName",
          "#organization": "organization",
          "#name": "name",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":firstName": fields.firstName,
          ":lastName": fields.lastName,
          ":organization": fields.organization,
          ":name": fields.name,
          ":updatedAt": fields.updatedAt,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes as User;
  }

  /**
   * BatchGetItem over the primary key, chunked at 100 and retrying UnprocessedKeys.
   *
   * Point reads rather than a Scan with a filter, because the ids are already known:
   * a Scan would read the whole table to find them, and — with the visibility filter
   * in mind — a Scan is the shape that can accidentally return a row nobody asked for.
   *
   * Deliberately does NOT apply visibleRoles. Enumeration is the risk this class
   * guards in list(); here the caller has supplied specific ids and must apply
   * visibility to the RESULT, which the admin route does in one place for both its
   * branches. Filtering here as well would silently hide inviter names from the
   * lookup that exists precisely to decide whether to show them.
   *
   * Duplicate ids collapse (BatchGetItem rejects them outright), and unknown ids are
   * absent from the result rather than an error.
   */
  async listByIds(ids: readonly string[]): Promise<User[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return [];

    const found: User[] = [];

    for (let i = 0; i < unique.length; i += BATCH_GET_CHUNK) {
      const chunk = unique.slice(i, i + BATCH_GET_CHUNK);
      let keys = chunk.map((id) => ({ id }));

      for (let attempt = 0; keys.length > 0 && attempt <= MAX_BATCH_GET_RETRIES; attempt++) {
        const res = await this.db.send(
          new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys } } })
        );

        found.push(...((res.Responses?.[this.table] as User[]) ?? []));

        // Whatever DynamoDB declined to serve, ask for again on the next pass.
        const unprocessed = res.UnprocessedKeys?.[this.table]?.Keys ?? [];
        keys = unprocessed as { id: string }[];
      }

      // Exhausting the retries means rows are genuinely missing from the result.
      // Logged rather than thrown: a partially-populated "Invited by" column beats a
      // failed Administration page, but silence would make the gap undiagnosable.
      if (keys.length > 0) {
        console.warn(
          JSON.stringify({
            msg: "listByIds: giving up on unprocessed keys",
            table: this.table,
            abandoned: keys.length,
          })
        );
      }
    }

    return found;
  }

  /**
   * A SCAN, deliberately. The users table is keyed by the Cognito sub (`id` HASH,
   * no range key) and its email-index GSI is a point lookup; neither can enumerate.
   * Listing users therefore has no index-backed form, and adding a GSI purely to list
   * a population that is bounded by "people invited to a workshop" would cost a table
   * rebuild for no real gain.
   *
   * Kept safe by pagination rather than by hope: Limit is clamped server-side, so a
   * caller asking for 10,000 gets MAX_PAGE_SIZE.
   *
   * A malformed cursor is treated as "start from the beginning" rather than
   * throwing. It comes back through a URL where it can be truncated or mangled by a
   * copy-paste, and page one is a harmless answer to an unreadable cursor — whereas
   * a 500 on the Administration screen is not.
   *
   * `visibleRoles` is pushed down into a FilterExpression rather than applied to the
   * returned array. The difference is not stylistic: DynamoDB bills and returns rows
   * BEFORE the filter, so a post-filter in the service would already have shipped the
   * hidden rows over the wire into this process — but more importantly, doing it here
   * means the ONE place that can enumerate users cannot return a row the caller may
   * not see, no matter which route grows on top of it later.
   */
  async list(
    opts: {
      limit?: number;
      cursor?: string;
      visibleRoles?: readonly string[];
      search?: string;
    } = {}
  ): Promise<UserPage> {
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE_SIZE)),
      MAX_PAGE_SIZE
    );

    let startKey: Record<string, unknown> | undefined;
    if (opts.cursor) {
      try {
        startKey = JSON.parse(Buffer.from(opts.cursor, "base64url").toString());
      } catch {
        startKey = undefined;
      }
    }

    // An EMPTY visibleRoles list means "may see nothing" and must return nothing.
    // Building an `IN ()` expression is a syntax error, and — far worse — omitting
    // the filter for an empty list would turn "sees nobody" into "sees everybody".
    if (opts.visibleRoles && opts.visibleRoles.length === 0) {
      return { users: [] };
    }

    // The filter is built from TWO independent restrictions, ANDed. They are assembled
    // together rather than as two separate expressions because DynamoDB takes one
    // FilterExpression, and — more importantly — because ANDing them is the security
    // property: search must never widen what visibleRoles allows, so a caller cannot use
    // it to confirm that an account they may not see exists.
    const conditions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (opts.visibleRoles) {
      // `role` is a DynamoDB reserved word, hence the name placeholder.
      conditions.push(
        `#role IN (${opts.visibleRoles.map((_, i) => `:r${i}`).join(", ")})`
      );
      names["#role"] = "role";
      opts.visibleRoles.forEach((r, i) => {
        values[`:r${i}`] = r;
      });
    }

    // Substring match on name OR email, CASE-INSENSITIVELY.
    //
    // DynamoDB's `contains` is case-SENSITIVE and a filter expression has no lower(), so
    // "ada" would not match "Ada Lovelace". The needle is therefore compared against BOTH
    // a lowercased and a capitalised-first form, which covers the two ways names and
    // addresses are actually stored here (emails are lowercased on write; display names
    // are Title Case). Four conditions ORed, not two.
    //
    // NOT post-filtered in memory, deliberately: this method's pagination derives
    // `hasMore` from how many rows the Scan RETURNED (see the note below on the extra
    // row), so discarding rows after the fact would hand out a cursor that skips them —
    // the exact "cursor that lies" failure the existing comment warns about. The filter
    // has to be in the store for the cursor to stay honest.
    //
    // A fully general case-insensitive match needs a stored lowercased copy of each
    // field. That is a migration plus two attributes to keep in step on every write, on a
    // table three other services project from — worth doing if search is ever reported as
    // missing someone, and not worth doing pre-emptively.
    const needle = opts.search?.trim();
    if (needle) {
      const lower = needle.toLowerCase();
      const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
      conditions.push(
        "(contains(#name, :qLower) OR contains(#name, :qTitled) OR " +
          "contains(email, :qLower) OR contains(email, :qTitled))"
      );
      names["#name"] = "name";
      values[":qLower"] = lower;
      values[":qTitled"] = titled;
    }

    const filter = conditions.length
      ? {
          FilterExpression: conditions.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }
      : {};

    const found: User[] = [];
    let lastKey = startKey;
    let exhausted = false;

    // Fetch ONE MORE than the page needs. That extra row is the only reliable way to
    // know whether a next page exists: DynamoDB sets LastEvaluatedKey whenever a Scan
    // stops on Limit, INCLUDING when it happened to stop on the last matching row, so
    // trusting it would hand out a cursor to an empty page. Harmless-looking, until
    // the filter is a security boundary — a FACILITATOR asking for 3 rows, getting 2,
    // and receiving a cursor has just been told a hidden row exists. Verified against
    // the live dev table, where exactly that happened.
    const wanted = limit + 1;

    for (let trip = 0; trip < MAX_SCAN_ROUND_TRIPS; trip++) {
      const res = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          // Only what is still missing, so a nearly-full page doesn't over-read.
          Limit: wanted - found.length,
          ExclusiveStartKey: lastKey,
          ...filter,
        })
      );

      found.push(...((res.Items as User[]) ?? []));
      lastKey = res.LastEvaluatedKey;

      if (!lastKey) {
        // The table really is exhausted — the authoritative "no more rows" signal.
        exhausted = true;
        break;
      }
      if (found.length >= wanted) break;
    }

    const users = found.slice(0, limit);

    // A next page exists only if we actually SAW a row beyond this page, or if the
    // round-trip cap stopped us early with the table still unexhausted. Deriving the
    // cursor from the last row we RETURN (rather than from LastEvaluatedKey, which
    // points past the discarded extra) is what keeps the next page from skipping it.
    //
    // Building the key by hand couples this to the table's key schema — `id` HASH,
    // no range key. That is already this class's job: it is the only file that knows
    // the users table exists, and the alternative is a cursor that lies.
    const hasMore = found.length > limit || (!exhausted && found.length >= limit);
    const nextKey = hasMore && users.length > 0 ? { id: users[users.length - 1].id } : undefined;

    return {
      users,
      // base64url, because this value travels in a query string.
      nextCursor: nextKey
        ? Buffer.from(JSON.stringify(nextKey)).toString("base64url")
        : undefined,
    };
  }
}
