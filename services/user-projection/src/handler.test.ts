import { describe, it, expect, beforeEach, vi } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { Context, DynamoDBRecord } from "aws-lambda";

/**
 * The user-projection consumer's decision logic and its two entry points.
 *
 * WHY THIS SERVICE EXISTS AT ALL, because the tests only make sense against it: five
 * services keep a private `{id, name, email}` read-model so a roster, a chat author, a
 * commit author, a shared-thread byline and a contribution row can render a name without
 * a hop into Identity. Each read-model's own comment said "wire the consumer to call
 * upsert()" — and nothing ever did.
 *
 * TWO DEFECTS ARE PINNED HERE, both of which shipped:
 *
 *   1. THE PROJECTION WAS FED BY EVENTBRIDGE, and `praimana-users` has five
 *      writers of which only two published anything. `user.updated` was subscribed and
 *      published by NOTHING, so a profile completed via PATCH /me never propagated and
 *      names rendered as raw email addresses. It is now fed by a DynamoDB Stream on the
 *      table, so every writer propagates and per-key ordering is guaranteed.
 *      The dispatch and the stream contract are tested because getting them wrong
 *      SILENTLY loses data: a stream event reaching the old single-shape handler was
 *      logged and ACKNOWLEDGED, checkpoint advanced, DLQ empty.
 *   2. TARGET_TABLES HELD THREE ENTRIES WHILE FIVE READ-MODELS EXISTED. The ai and
 *      evaluation tables sat at 0 rows with a reader and no writer, so
 *      `sharedByName: null` and `name: null` were rendered forever — and the reader's
 *      `?? null` makes that indistinguishable from "no name yet".
 *
 * `toUserView` is the part worth testing exhaustively: it decides what gets written,
 * and every branch corresponds to a way a surface can render wrongly.
 */

/** A DynamoDB write the handler attempted, in the order it was attempted. */
interface Attempt {
  table: string;
  item: Record<string, unknown>;
}

/** Decides whether one individual write rejects. Annotated so the hoisted default does
 *  not narrow the field's type to the literal `false`. */
type FailPredicate = (table: string, item: Record<string, unknown>) => boolean;

const spy = vi.hoisted(() => ({
  attempts: [] as Attempt[],
  /**
   * Decides which individual writes reject, simulating a throttle on one bounded
   * context. A PREDICATE rather than a table set because the interesting cases are
   * per-(record, table): "the third table always fails" and "the third table fails for
   * one record only" produce different batchItemFailures, and only the second proves a
   * healthy neighbour is not reported.
   */
  failWrite: (() => false) as FailPredicate,
  /** Tables whose writes hang until the caller's abortSignal fires. */
  hangTables: new Set<string>(),
  /**
   * Writes matching this predicate hang until `release()` is called. This is the only
   * way to observe whether a later record's writes were STARTED before an earlier
   * record's finished — attempt order alone cannot tell sequential from concurrent,
   * because either way each record issues its five sends before yielding.
   */
  gateWrite: (() => false) as FailPredicate,
  gateReleases: [] as Array<() => void>,
  release() {
    const pending = spy.gateReleases;
    spy.gateReleases = [];
    for (const resolve of pending) resolve();
  },
  reset() {
    spy.attempts = [];
    spy.failWrite = () => false;
    spy.hangTables = new Set();
    spy.gateWrite = () => false;
    spy.gateReleases = [];
  },
}));

/**
 * Stands in for the DocumentClient the handler constructs at import time.
 *
 * It honours `abortSignal` rather than ignoring it, because the handler relies on the
 * signal to keep a retried write from outliving the batch's time budget — a spy that
 * silently resolved would make that guarantee untestable and let it rot.
 */
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: (
        cmd: { input: { TableName: string; Item: Record<string, unknown> } },
        options?: { abortSignal?: AbortSignal }
      ) => {
        const { TableName, Item } = cmd.input;
        spy.attempts.push({ table: TableName, item: Item });
        if (spy.failWrite(TableName, Item)) {
          return Promise.reject(new Error(`ProvisionedThroughputExceeded ${TableName}`));
        }
        if (spy.gateWrite(TableName, Item)) {
          return new Promise<object>((resolve) => {
            spy.gateReleases.push(() => resolve({}));
          });
        }
        if (spy.hangTables.has(TableName)) {
          return new Promise((_resolve, reject) => {
            const signal = options?.abortSignal;
            if (!signal) return; // hangs forever — the test times out, which is correct
            if (signal.aborted) return reject(new Error("AbortError"));
            signal.addEventListener("abort", () => reject(new Error("AbortError")), {
              once: true,
            });
          });
        }
        return Promise.resolve({});
      },
    }),
  },
  PutCommand: class {
    constructor(public input: { TableName: string; Item: Record<string, unknown> }) {}
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    constructor(public config: unknown) {}
  },
}));

const { handler, toUserView, recordToUserView, TARGET_TABLES } = await import(
  "./handler.js"
);

beforeEach(() => {
  spy.reset();
  vi.restoreAllMocks();
  // Silenced, not asserted-on: every failure branch logs, and an 80-line CI transcript
  // of expected errors trains people to ignore the log.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * A stream record as the ESM actually delivers it, NewImage marshalled for real.
 *
 * `marshall` rather than a hand-written AttributeValue map: the handler's `unmarshall`
 * is the code under test on this path, and a hand-built image would let a real encoding
 * mismatch pass. `seq` is explicit because it is the checkpoint identity — the value
 * `batchItemFailures` reports, and therefore what every failure assertion turns on.
 */
function streamRecord(row: Record<string, unknown>, seq = "1"): DynamoDBRecord {
  return {
    eventID: `e-${seq}`,
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    eventSourceARN:
      "arn:aws:dynamodb:us-east-1:123456789012:table/praimana-users/stream/2026-08-04T00:00:00.000",
    dynamodb: {
      // Keys is omitted when the row has no id, because that is the only shape DynamoDB
      // could produce: `id` is the partition key, so a keyless record cannot exist. The
      // handler must still survive it — it reads NewImage, never Keys, and an image
      // whose id is missing or non-string is the malformed case being defended against.
      ...(typeof row.id === "string" ? { Keys: marshall({ id: row.id }) as never } : {}),
      NewImage: marshall(row, { removeUndefinedValues: true }) as never,
      SequenceNumber: seq,
      StreamViewType: "NEW_AND_OLD_IMAGES",
    },
  };
}

/** An EventBridge invocation, the transitional path retained for one deploy. */
function eventBridgeEvent(detail: unknown) {
  return {
    version: "0",
    id: "5f1d2a8e-0000-0000-0000-000000000000",
    "detail-type": "user.updated",
    source: "identity-service",
    account: "123456789012",
    time: "2026-08-04T00:00:00Z",
    region: "us-east-1",
    resources: [],
    detail,
  };
}

/** A Lambda Context with a generous remaining budget. */
function ctx(remainingMs = 15_000): Context {
  return { getRemainingTimeInMillis: () => remainingMs } as Context;
}

describe("toUserView", () => {
  it("projects a well-formed event", () => {
    expect(
      toUserView({
        id: "sub-1",
        name: "Facilitator One",
        email: "f1@example.com",
        role: "FACILITATOR",
      })
    ).toEqual({ id: "sub-1", name: "Facilitator One", email: "f1@example.com" });
  });

  it("drops `role` — the projection is display data, not an authorization source", () => {
    // Copying role into a read-model invites a reader to authorize against a stale
    // copy of it. Identity's token claims are the only role authority.
    const view = toUserView({ id: "sub-1", name: "N", email: "e@example.com", role: "ADMIN" });
    expect(view).not.toHaveProperty("role");
  });

  // ── The name fallbacks. A blank name is worse than "Unknown": it renders as an
  // empty line, which reads as a broken component rather than missing data.
  it("falls back to the email when no name is supplied", () => {
    // THE COMMON CASE, not an edge one: user-access publishes `name: user.email` for
    // admin-provisioned users, and a row could equally arrive with name absent.
    expect(toUserView({ id: "sub-1", email: "p1@example.com" })).toEqual({
      id: "sub-1",
      name: "p1@example.com",
      email: "p1@example.com",
    });
  });

  it("falls back to the id when there is neither name nor email", () => {
    expect(toUserView({ id: "sub-1" })).toEqual({ id: "sub-1", name: "sub-1" });
  });

  it("treats a whitespace-only name as absent", () => {
    expect(toUserView({ id: "sub-1", name: "   ", email: "e@example.com" })?.name).toBe(
      "e@example.com"
    );
  });

  it("never produces an empty name", () => {
    for (const detail of [
      { id: "a" },
      { id: "a", name: "" },
      { id: "a", name: "  " },
      { id: "a", name: "", email: "" },
      { id: "a", name: 42 },
      { id: "a", name: null },
    ]) {
      const view = toUserView(detail);
      expect(view).not.toBeNull();
      expect(view!.name.length).toBeGreaterThan(0);
    }
  });

  // ── The id is the PARTITION KEY: no id, no row.
  it("returns null when the id is missing, empty or not a string", () => {
    // Dropped rather than thrown ON PURPOSE. Throwing would retry a record that can
    // never succeed — on the stream path that stalls the shard behind it.
    for (const detail of [
      {},
      { id: "" },
      { id: "   " },
      { id: 123 },
      { id: null },
      { name: "No id", email: "x@example.com" },
    ]) {
      expect(toUserView(detail)).toBeNull();
    }
  });

  it("returns null for a non-object detail", () => {
    for (const detail of [null, undefined, "a string", 42, true]) {
      expect(toUserView(detail)).toBeNull();
    }
  });

  // ── email is optional and must be OMITTED, not blanked.
  it("omits email entirely when absent, rather than writing an empty string", () => {
    // `removeUndefinedValues` would strip an undefined, but an empty STRING would be
    // stored and render as a blank contact address on the team page.
    const view = toUserView({ id: "sub-1", name: "N", email: "" });
    expect(view).toEqual({ id: "sub-1", name: "N" });
    expect(view).not.toHaveProperty("email");
  });

  it("trims surrounding whitespace on every field", () => {
    expect(toUserView({ id: "  sub-1 ", name: " N ", email: " e@example.com " })).toEqual({
      id: "sub-1",
      name: "N",
      email: "e@example.com",
    });
  });

  it("is IDEMPOTENT — the same detail always yields the same row", () => {
    // Delivery is at-least-once on both paths, so this function runs twice on the same
    // change. The row it produces carries no timestamp and no counter, which is what
    // makes a plain Put safe to replay.
    const detail = { id: "sub-1", name: "N", email: "e@example.com" };
    expect(toUserView(detail)).toEqual(toUserView(detail));
  });
});

describe("TARGET_TABLES", () => {
  it("covers all FIVE services that keep a users read-model", () => {
    // team, collaboration, source, ai and evaluation each have the identical read-model
    // class. This list held THREE for the whole life of the deployment, so the ai and
    // evaluation tables had a READER and no writer: 0 rows, `sharedByName: null` on
    // every shared thread and `name: null` on every contribution row, indistinguishable
    // from "no name yet". Missing one leaves that surface broken while the others are
    // fixed, which is a confusing half-state to debug.
    /**
     * SIX, not five. The docs service gained a users read-model because an uploaded file was showing
     * its author as a raw Cognito sub — and this entry shipped WITH it rather than after, because the
     * failure this count guards is precisely "a reader exists and nothing writes to it".
     */
    expect(TARGET_TABLES).toHaveLength(6);
    expect(TARGET_TABLES.some((t) => t.includes("team"))).toBe(true);
    expect(TARGET_TABLES.some((t) => t.includes("collaboration"))).toBe(true);
    expect(TARGET_TABLES.some((t) => t.includes("source"))).toBe(true);
    expect(TARGET_TABLES.some((t) => t.includes("ai-users-readmodel"))).toBe(true);
    expect(TARGET_TABLES.some((t) => t.includes("evaluation"))).toBe(true);
    expect(TARGET_TABLES.some((t) => t.includes("docs"))).toBe(true);
  });

  it("has no duplicates — a repeated table would double-write and hide a missing one", () => {
    expect(new Set(TARGET_TABLES).size).toBe(TARGET_TABLES.length);
  });
});

describe("recordToUserView", () => {
  it("unmarshalls a NewImage and projects only the three display fields", () => {
    // A stream NewImage carries the WHOLE user row, unlike a hand-built EventBridge
    // detail. An allowlist rather than a spread is what keeps role/status
    // out of five read-models that must not be authorized against.
    const view = recordToUserView(
      streamRecord({
        id: "sub-1",
        email: "f1@example.com",
        name: "Facilitator One",
        role: "FACILITATOR",
        authProvider: "COGNITO",
        status: "ACTIVE",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      })
    );
    expect(view).toEqual({
      id: "sub-1",
      name: "Facilitator One",
      email: "f1@example.com",
    });
  });

  it("returns null for a REMOVE record, which carries OldImage only", () => {
    const record: DynamoDBRecord = {
      eventName: "REMOVE",
      dynamodb: {
        Keys: marshall({ id: "sub-1" }) as never,
        OldImage: marshall({ id: "sub-1", name: "Gone" }) as never,
        SequenceNumber: "1",
      },
    };
    expect(recordToUserView(record)).toBeNull();
  });

  it("returns null rather than throwing when the record has no dynamodb payload", () => {
    expect(recordToUserView({ eventName: "MODIFY" })).toBeNull();
  });
});

describe("handler — dispatch", () => {
  it("routes a `Records` event down the STREAM path and returns batchItemFailures", async () => {
    // THE CUTOVER HAZARD. If the ESM lands before this dual-shape code, a stream event
    // reaches a handler that only understands `detail`: toUserView(undefined) is null,
    // the handler logs and ACKNOWLEDGES, the checkpoint advances and nothing reaches the
    // DLQ. Silent loss of every change made during the gap.
    const res = await handler(
      { Records: [streamRecord({ id: "sub-1", name: "N", email: "e@example.com" })] },
      ctx()
    );
    expect(res).toEqual({ batchItemFailures: [] });
    expect(spy.attempts).toHaveLength(TARGET_TABLES.length);
  });

  it("REFUSES an EventBridge event — that path was cutover cover and is gone", async () => {
    // Was "routes an EventBridge event down the transitional path and returns void".
    // UserProjectionRule has been deleted, so anything arriving without Records is a
    // MISCONFIGURATION rather than a supported shape, and must fail loudly: quietly
    // tolerating it is how a rule wired to this function by mistake would go unnoticed
    // while writing rows from an unordered source.
    await expect(
      handler(
        eventBridgeEvent({ id: "sub-1", name: "N", email: "e@example.com" }) as never,
        ctx()
      )
    ).rejects.toThrow(/no longer accepts EventBridge/);
    // NOTHING was written. The old version of this test asserted five writes, because the
    // transitional path projected the event; inverting the expectation is the whole point
    // of the change — a refused shape must not reach the read-models at all.
    expect(spy.attempts).toHaveLength(0);
  });

  it("writes byte-identical rows to all five read-models, and a REPLAY writes the same", async () => {
    // At-least-once means a retried batch replays every record in it. This is the
    // property that makes that safe.
    const event = { Records: [streamRecord({ id: "sub-1", name: "N", email: "e@example.com" })] };

    await handler(event, ctx());
    const first = [...spy.attempts];

    spy.attempts = [];
    await handler(event, ctx());
    const replay = [...spy.attempts];

    expect(first).toEqual(replay);
    expect(new Set(first.map((a) => a.table))).toEqual(new Set(TARGET_TABLES));
    for (const attempt of first) {
      expect(attempt.item).toEqual({ id: "sub-1", name: "N", email: "e@example.com" });
    }
  });

  it("applies records SEQUENTIALLY so two changes to one id land in shard order", async () => {
    // Per-key ordering is the whole reason a stream replaced EventBridge. Concurrent
    // application would let wall-clock latency pick the winner, and because the
    // projection is last-write-wins the WRONG name would stay in place permanently.
    //
    // A HANGING FIRST RECORD is what makes this a real test. Asserting attempt ORDER
    // alone cannot distinguish sequential from concurrent — either way each record
    // issues its five sends together — so instead the first record's write is held open
    // and the second record must NOT have started. That is the invariant that breaks if
    // the loop is ever changed to Promise.all over records.
    spy.gateWrite = (_table, item) => item.name === "Old Name";

    const pending = handler(
      {
        Records: [
          streamRecord({ id: "sub-1", name: "Old Name" }, "1"),
          streamRecord({ id: "sub-1", name: "New Name" }, "2"),
        ],
      },
      ctx()
    );

    // Let the microtask queue drain as far as it can with record 1 still in flight.
    await new Promise((r) => setImmediate(r));

    expect(spy.attempts.map((a) => a.item.name)).toEqual(
      Array(TARGET_TABLES.length).fill("Old Name")
    );
    expect(spy.attempts.some((a) => a.item.name === "New Name")).toBe(false);

    spy.release();
    const res = await pending;

    expect(res).toEqual({ batchItemFailures: [] });
    // All five writes of "Old Name" complete before any write of "New Name" starts.
    expect(spy.attempts.map((a) => a.item.name)).toEqual([
      ...Array(TARGET_TABLES.length).fill("Old Name"),
      ...Array(TARGET_TABLES.length).fill("New Name"),
    ]);
  });

  it("ignores a REMOVE record without error and without a retry", async () => {
    // No DeleteItem in the role and no delete here: revocation in this system is
    // disable-not-delete, so a vanished user row is a mistake or a hard purge. A stale
    // display name beats a roster row that renders blank.
    const res = await handler(
      {
        Records: [
          {
            eventName: "REMOVE",
            dynamodb: {
              Keys: marshall({ id: "sub-1" }) as never,
              OldImage: marshall({ id: "sub-1", name: "Gone" }) as never,
              SequenceNumber: "7",
            },
          },
        ],
      },
      ctx()
    );
    expect(res).toEqual({ batchItemFailures: [] });
    expect(spy.attempts).toHaveLength(0);
  });

  it("ACKNOWLEDGES a stream record whose image has no id, rather than retrying it", async () => {
    // `id` is the partition key, so this record can never be written. Reporting it as a
    // failure would make the ESM re-deliver it up to MaximumRetryAttempts and then
    // stall the shard behind something no operator can act on — every other user's name
    // stops updating. Scoped to the RECORD: its neighbour still projects.
    const res = await handler(
      {
        Records: [
          streamRecord({ name: "No Id", email: "x@example.com" }),
          streamRecord({ id: "sub-2", name: "Fine" }),
        ],
      },
      ctx()
    );

    expect(res).toEqual({ batchItemFailures: [] });
    expect(spy.attempts.map((a) => a.item.id)).toEqual(
      Array(TARGET_TABLES.length).fill("sub-2")
    );
  });
});

describe("handler — partial failure reporting", () => {
  it("reports ONLY the failed record and does not lose the other four writes", async () => {
    // THE CONDITION THAT MADE THIS A STREAM CONSUMER RATHER THAN AN EVENTBRIDGE ONE.
    // Throwing on any failure — correct for EventBridge, which has its own DLQ — fails
    // the WHOLE batch on a stream, so one poison record stalls the shard until it ages
    // out. Two things are asserted: only the bad record is reported, and the four
    // healthy tables were still written for it (allSettled, not all).
    // Table 3 of 5 fails, and ONLY for the middle record.
    const failing = TARGET_TABLES[2];
    spy.failWrite = (table, item) => table === failing && item.id === "bad";

    const res = await handler(
      {
        Records: [
          streamRecord({ id: "ok-1", name: "One" }, "11"),
          streamRecord({ id: "bad", name: "Two" }, "12"),
          streamRecord({ id: "ok-3", name: "Three" }, "13"),
        ],
      },
      ctx()
    );

    // EXACTLY ONE identifier: the poison record, by its own sequence number. Reporting
    // the whole batch would replay two records that already converged and hide which
    // one is actually bad.
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "12" }] });

    // THE OTHER FOUR WRITES ARE NOT LOST. Even for the failing record, the four healthy
    // tables were still written — that is allSettled rather than all, and it is why one
    // throttled context does not leave four read-models stale.
    for (const table of TARGET_TABLES) {
      const ids = spy.attempts.filter((a) => a.table === table).map((a) => a.item.id);
      expect(ids).toEqual(["ok-1", "bad", "ok-3"]);
    }
    // And the two healthy records are NOT reported, so their checkpoints advance.
    expect(res!.batchItemFailures.map((f) => f.itemIdentifier)).not.toContain("11");
    expect(res!.batchItemFailures.map((f) => f.itemIdentifier)).not.toContain("13");
  });

  it("reports every record when the failing table fails for all of them", async () => {
    // The sustained-failure shape: one read-model table is genuinely down. Each record
    // is reported ONCE, by its own sequence number, and nothing is invented — the ESM
    // then re-delivers from the lowest, which is the correct at-least-once behaviour.
    spy.failWrite = (table) => table === TARGET_TABLES[2];

    const res = await handler(
      {
        Records: [
          streamRecord({ id: "ok-1", name: "One" }, "11"),
          streamRecord({ id: "ok-2", name: "Two" }, "12"),
        ],
      },
      ctx()
    );

    expect(res).toEqual({
      batchItemFailures: [{ itemIdentifier: "11" }, { itemIdentifier: "12" }],
    });
  });

  it("THROWS rather than acknowledging when a failed record has no SequenceNumber", async () => {
    // Fail-closed. Reporting an empty itemIdentifier would ACKNOWLEDGE the record —
    // a silent loss with the checkpoint advanced. DynamoDB Streams always set a
    // sequence number, so this shape means something is deeply wrong and the bounded
    // MaximumRetryAttempts should put the batch in the DLQ where it is visible.
    spy.failWrite = (table) => table === TARGET_TABLES[0];
    const record = streamRecord({ id: "sub-1", name: "N" });
    delete record.dynamodb!.SequenceNumber;

    await expect(handler({ Records: [record] }, ctx())).rejects.toThrow(
      /no SequenceNumber/
    );
  });

  it("defers the whole remainder when the time budget is spent", async () => {
    // Being killed on the Lambda timeout loses the partial-failure report entirely and
    // the ESM retries the batch with no credit for what converged. Reserving wall-clock
    // to RETURN is what keeps that from happening.
    const records = [
      streamRecord({ id: "a", name: "A" }, "31"),
      streamRecord({ id: "b", name: "B" }, "32"),
    ];

    // Remaining budget below the response reserve ⇒ zero working budget.
    const res = await handler({ Records: records }, ctx(1_000));

    expect(res).toEqual({
      batchItemFailures: [{ itemIdentifier: "31" }, { itemIdentifier: "32" }],
    });
    expect(spy.attempts).toHaveLength(0);
  });

  it("aborts a write that would outlive the batch budget and reports that record", async () => {
    // `requestTimeout` bounds ONE attempt; three retried attempts against a throttled
    // table can outlive the budget. The abortSignal is what turns that into a reported
    // record instead of a killed function.
    spy.hangTables.add(TARGET_TABLES[1]);
    const record = streamRecord({ id: "sub-1", name: "N" }, "41");

    // 2001ms remaining ⇒ ~1ms of working budget, so the hanging write is aborted at once.
    const res = await handler({ Records: [record] }, ctx(2_001));

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "41" }] });
  });
});

describe("handler — a non-stream event is a misconfiguration", () => {
  it("THROWS rather than silently accepting an event with no Records", async () => {
    // Replaces the transitional EventBridge partial-write test. The point has changed:
    // there is no second supported path to have its own failure semantics, so the only
    // assertion left worth making is that the shape is refused. An EMPTY Records array is
    // deliberately NOT this case — an event source mapping may legitimately deliver one.
    for (const bad of [undefined, null, {}, { detail: { id: "sub-1" } }, []]) {
      await expect(handler(bad as never, ctx())).rejects.toThrow(
        /expected a DynamoDB stream event with Records/
      );
    }
    expect(spy.attempts).toHaveLength(0);
  });

  it("treats an EMPTY Records array as a no-op, not an error", async () => {
    const res = await handler({ Records: [] }, ctx());
    expect(res).toEqual({ batchItemFailures: [] });
    expect(spy.attempts).toHaveLength(0);
  });
});
