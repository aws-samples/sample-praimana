import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * WHAT `DynamoProfileStore.setStatus` ACTUALLY SENDS TO DYNAMODB.
 *
 * ── WHY THIS FILE HAD TO EXIST, FOUND BY MUTATION TESTING ──
 *
 * `routes.test.ts` covers the access-change route against a `FakeProfiles`, and those tests
 * are right about what they test: the route resolves the actor from the verified token, passes
 * it down, and does so before the audit write. But they assert on the fake's recorded ARGUMENT,
 * so they cannot see whether the adapter puts it in the UpdateExpression.
 *
 * Proven, not assumed: deleting `#accessChangedBy = :actorId` from the adapter left all 298
 * tests in this service PASSING. The forensic field would have shipped as a value threaded
 * neatly through three layers and then dropped on the floor at the last one — and the whole
 * point of it is to be readable from the row months later, when nothing else remembers.
 *
 * `adapters.ts` had NO test file at all before this. It is the only file in the service that
 * knows an AWS SDK exists, and its writes are the ones that outlive every process.
 *
 * ── WHY THE SDK IS MOCKED AT MODULE LEVEL ──
 *
 * `DynamoProfileStore` closes over a module-level `ddb` built at import time, so there is no
 * client to inject. The same technique as user-projection/src/handler.test.ts: replace the SDK
 * modules, capture the command input, and import the subject afterwards. That captures the
 * REAL UpdateExpression, names and values — which is exactly the layer the fake cannot reach.
 */

interface Sent {
  TableName?: string;
  Key?: Record<string, unknown>;
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

const spy: { sent: Sent[]; reject: null | Error } = { sent: [], reject: null };

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: (cmd: { input: Sent }) => {
        spy.sent.push(cmd.input);
        if (spy.reject) return Promise.reject(spy.reject);
        return Promise.resolve({});
      },
    }),
  },
  UpdateCommand: class {
    constructor(public input: Sent) {}
  },
  // Unused here, but the module's other consumers in adapters.ts import them at load.
  PutCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteCommand: class {
    constructor(public input: unknown) {}
  },
  QueryCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

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

const { DynamoProfileStore } = await import("./adapters.js");

const ACTOR = "99999999-8888-7777-6666-555555555555";
const SUBJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
  spy.sent = [];
  spy.reject = null;
});

describe("DynamoProfileStore.setStatus — the write that outlives the audit trail", () => {
  it("WRITES accessChangedBy INTO THE UPDATE EXPRESSION — the mutation that survived without this", async () => {
    // THE assertion this file exists for. A value threaded correctly through the route and
    // the port, then omitted from the expression, is invisible to every route-level test.
    await new DynamoProfileStore().setStatus({
      userId: SUBJECT,
      status: "DEACTIVATED",
      actorId: ACTOR,
    });

    expect(spy.sent).toHaveLength(1);
    const input = spy.sent[0];

    expect(input.UpdateExpression).toContain("#accessChangedBy = :actorId");
    expect(input.ExpressionAttributeNames).toMatchObject({
      "#accessChangedBy": "accessChangedBy",
    });
    expect(input.ExpressionAttributeValues).toMatchObject({ ":actorId": ACTOR });
  });

  it("writes the actor and the STATUS in ONE command — atomicity is the point", async () => {
    // The breadcrumb is only trustworthy if it cannot land without the change it describes,
    // or the change without it. Two commands could half-succeed and leave a row claiming an
    // actor for a status that was never written, or a status nobody owns. Same reasoning as
    // the team service writing `removedBy` alongside the membership status flip.
    await new DynamoProfileStore().setStatus({
      userId: SUBJECT,
      status: "DEACTIVATED",
      actorId: ACTOR,
    });

    expect(spy.sent).toHaveLength(1);
    const expr = spy.sent[0].UpdateExpression ?? "";
    expect(expr).toContain("#status = :status");
    expect(expr).toContain("#accessChangedBy = :actorId");
    expect(spy.sent[0].ExpressionAttributeValues).toMatchObject({
      ":status": "DEACTIVATED",
      ":actorId": ACTOR,
    });
  });

  it("stamps accessChangedAt with the SAME instant as updatedAt", async () => {
    // One clock for one write. Two `new Date()` calls would differ by a millisecond that
    // never meant anything, and a forensic reader would waste time reconciling it.
    await new DynamoProfileStore().setStatus({
      userId: SUBJECT,
      status: "ACTIVE",
      actorId: ACTOR,
    });

    const values = spy.sent[0].ExpressionAttributeValues ?? {};
    expect(values[":now"]).toBe(values[":updatedAt"]);
    expect(String(values[":now"])).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("still writes ONLY the four attributes — never the user's own profile fields", async () => {
    // The row holds firstName / lastName / organization, and an access change has no business
    // with any of them. `role` in particular is Cognito's to decide. Adding the actor must not
    // have turned a narrow SET into something broader.
    await new DynamoProfileStore().setStatus({
      userId: SUBJECT,
      status: "DEACTIVATED",
      actorId: ACTOR,
    });

    const expr = spy.sent[0].UpdateExpression ?? "";
    for (const forbidden of ["firstName", "lastName", "organization", "#role", "email"]) {
      expect(expr, `must not write ${forbidden}`).not.toContain(forbidden);
    }
    // Exactly four assignments.
    expect(expr.split(",")).toHaveLength(4);
  });

  it("keeps attribute_exists(id), so a disable cannot fabricate a phantom row", async () => {
    // Pre-existing behaviour, re-pinned here because this file now owns the shape of this
    // command: an UpdateCommand CREATES the item when the key is absent, so without the
    // condition a disable against a sub with no profile row would invent one carrying nothing
    // but an id, a status and an actor — a phantom account in the Administration list.
    await new DynamoProfileStore().setStatus({
      userId: SUBJECT,
      status: "DEACTIVATED",
      actorId: ACTOR,
    });

    expect(spy.sent[0].ConditionExpression).toBe("attribute_exists(id)");
    expect(spy.sent[0].Key).toEqual({ id: SUBJECT });
  });

  it("reports FALSE for a missing row and RETHROWS a real store failure", async () => {
    // The distinction the route depends on: no row is a stale-badge problem and must not fail
    // an access change Cognito already applied; a throttle or AccessDenied is a real failure
    // the route reports as an unwritten mirror.
    const store = new DynamoProfileStore();

    const conditional = Object.assign(new Error("nope"), {
      name: "ConditionalCheckFailedException",
    });
    spy.reject = conditional;
    await expect(
      store.setStatus({ userId: SUBJECT, status: "ACTIVE", actorId: ACTOR })
    ).resolves.toBe(false);

    spy.reject = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    await expect(
      store.setStatus({ userId: SUBJECT, status: "ACTIVE", actorId: ACTOR })
    ).rejects.toThrow("throttled");
  });
});
