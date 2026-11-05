import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * WHAT `DynamoInvitationReader.listByEmail` ACTUALLY SENDS TO DYNAMODB, and what it does when
 * the answer does not fit.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * The method used to be one `QueryCommand` with `return res.Items` — no `Limit`, no
 * `ExclusiveStartKey`, no `LastEvaluatedKey` — so it returned one 1 MB page and silently
 * dropped the rest. The identical defect was fixed in the team service earlier today (backlog
 * P2-2); this is the same bug in a second service, and here it feeds DECISIONS rather than a
 * display: `POST /provision` resolves the role to grant from these rows, and the revoke path
 * counts them to tell an operator how many live credentials it destroyed.
 *
 * ── WHY THE ROUTE TESTS COULD NOT COVER IT ──
 *
 * All 304 existing specs in this service drive the routes against in-memory fakes, so they
 * observe the ARGUMENT passed to the port and never the command the adapter builds. That is
 * exactly how a field gets dropped at the last layer and every test still passes — I hit it in
 * this same file yesterday, where three route tests were green while the adapter omitted
 * `accessChangedBy` entirely. So this file mocks the SDK at module level and asserts the real
 * `QueryCommand` input.
 *
 * `DynamoInvitationReader` closes over a module-level `ddb` built at import time, so there is no
 * client to inject — same technique as adapters.setstatus.test.ts and
 * user-projection/src/handler.test.ts: replace the SDK modules, capture the input, import the
 * subject afterwards.
 */

interface Sent {
  TableName?: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  Limit?: number;
  ExclusiveStartKey?: Record<string, unknown>;
}

/** Queued responses, one per expected round trip. */
const spy: {
  sent: Sent[];
  responses: Array<{ Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> }>;
} = { sent: [], responses: [] };

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: (cmd: { input: Sent }) => {
        spy.sent.push(cmd.input);
        const next = spy.responses.shift() ?? { Items: [] };
        return Promise.resolve(next);
      },
    }),
  },
  QueryCommand: class {
    constructor(public input: Sent) {}
  },
  UpdateCommand: class {
    constructor(public input: unknown) {}
  },
  PutCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send() {
      return Promise.resolve({});
    }
  },
  AdminAddUserToGroupCommand: class {},
  AdminCreateUserCommand: class {},
  AdminDisableUserCommand: class {},
  AdminEnableUserCommand: class {},
  AdminListGroupsForUserCommand: class {},
  ListUsersCommand: class {},
  ListUsersInGroupCommand: class {},
  UsernameExistsException: class extends Error {},
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    send() {
      return Promise.resolve({});
    }
  },
  PutEventsCommand: class {},
}));

const { DynamoInvitationReader, InvitationReadBoundExceeded } = await import(
  "./adapters.js"
);

/** `n` rows, distinguishable so a dropped page is visible in the assertion. */
const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ teamId: `t${from + i}`, email: "a@b.c" }));

beforeEach(() => {
  spy.sent = [];
  spy.responses = [];
});

describe("DynamoInvitationReader.listByEmail — paged, bounded, and refuses to truncate", () => {
  it("FOLLOWS LastEvaluatedKey — rows from BOTH pages, not just the first", async () => {
    // THE assertion this file exists for. The old implementation returned page one and dropped
    // the rest, which no route-level fake could observe.
    spy.responses = [
      { Items: rows(2, 0), LastEvaluatedKey: { teamId: "t1", email: "a@b.c" } },
      { Items: rows(2, 2) },
    ];

    const got = await new DynamoInvitationReader().listByEmail("a@b.c");

    expect(spy.sent).toHaveLength(2);
    expect(got.map((r) => r.teamId)).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("passes the RESUME KEY on the second trip, and none on the first", async () => {
    const key = { teamId: "t1", email: "a@b.c" };
    spy.responses = [{ Items: rows(1), LastEvaluatedKey: key }, { Items: rows(1, 1) }];

    await new DynamoInvitationReader().listByEmail("a@b.c");

    expect(spy.sent[0].ExclusiveStartKey).toBeUndefined();
    expect(spy.sent[1].ExclusiveStartKey).toEqual(key);
  });

  it("sends a Limit of budget+1, decremented by what it already has", async () => {
    // Over-fetch by ONE is the off-by-one fix, not decoration: DynamoDB sets LastEvaluatedKey
    // whenever a Query stops on Limit — including on the last matching row — so "a key came
    // back" cannot distinguish complete from truncated. Seeing a row past the budget can.
    spy.responses = [
      { Items: rows(10), LastEvaluatedKey: { teamId: "t9", email: "a@b.c" } },
      { Items: rows(1, 10) },
    ];

    await new DynamoInvitationReader().listByEmail("a@b.c");

    expect(spy.sent[0].Limit).toBe(501);
    // 501 asked, 10 received → 491 still wanted.
    expect(spy.sent[1].Limit).toBe(491);
  });

  it("still queries the email-index by the address, unchanged", async () => {
    spy.responses = [{ Items: rows(1) }];

    await new DynamoInvitationReader().listByEmail("someone@example.com");

    expect(spy.sent[0].IndexName).toBe("email-index");
    expect(spy.sent[0].KeyConditionExpression).toBe("email = :email");
    expect(spy.sent[0].ExpressionAttributeValues).toEqual({
      ":email": "someone@example.com",
    });
  });

  it("returns a complete short answer in ONE trip — no pagination overhead in the normal case", async () => {
    // Real answers are 1-5 rows. The loop must not cost extra calls for them.
    spy.responses = [{ Items: rows(3) }];

    const got = await new DynamoInvitationReader().listByEmail("a@b.c");

    expect(spy.sent).toHaveLength(1);
    expect(got).toHaveLength(3);
  });

  it("REFUSES rather than truncating when a row past the budget is seen", async () => {
    // 502 rows against a budget of 500: the read saw past the ceiling, so rows are being left
    // behind. An array cannot say "incomplete", so the only honest channel is the exception.
    spy.responses = [{ Items: rows(502) }];

    await expect(
      new DynamoInvitationReader().listByEmail("a@b.c")
    ).rejects.toBeInstanceOf(InvitationReadBoundExceeded);
  });

  it("REFUSES when the ROUND-TRIP CAP is hit with the store still reporting more", async () => {
    // The second, independent signal — NOT redundant with the budget check: a read can exhaust
    // its five trips without ever reaching 500 rows. Without this conjunct such a read would
    // return a silently short list, which is the defect in a new disguise.
    spy.responses = Array.from({ length: 5 }, (_, i) => ({
      Items: rows(1, i),
      LastEvaluatedKey: { teamId: `t${i}`, email: "a@b.c" },
    }));

    await expect(
      new DynamoInvitationReader().listByEmail("a@b.c")
    ).rejects.toBeInstanceOf(InvitationReadBoundExceeded);
    expect(spy.sent).toHaveLength(5);
  });

  it("puts NO PII in the refusal — the index name, never the address", async () => {
    // The partition key of this index IS an email, so the scope label must not be the value.
    // The message reaches logs; the callers turn it into a 503 or a `complete: false`.
    spy.responses = [{ Items: rows(502) }];

    // ONE call, then assert on the captured error — a second invocation would drain the
    // response queue and resolve empty, which is a test bug rather than a finding.
    const err = await new DynamoInvitationReader()
      .listByEmail("secret.person@example.com")
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(err, "expected a refusal").not.toBeNull();
    expect(err!.message).toMatch(/scope=email-index/);
    expect(err!.message).not.toMatch(/secret\.person/);
    expect(err!.message).not.toMatch(/@example\.com/);
  });

  it("accepts EXACTLY the budget as a complete answer", async () => {
    // The boundary: 500 rows with the store exhausted is complete, not truncated. Off by one
    // here would refuse a legitimate answer forever.
    spy.responses = [{ Items: rows(500) }];

    const got = await new DynamoInvitationReader().listByEmail("a@b.c");

    expect(got).toHaveLength(500);
  });
});
