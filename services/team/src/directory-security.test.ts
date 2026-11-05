import { describe, it, expect } from "vitest";
import type { DocClient } from "@praimana/service-shared";
import { DynamoTeamRepository } from "./repository.dynamo.js";
import type { Team } from "./domain.js";

/**
 * ADVERSARIAL STORE-LEVEL TESTS for the TEAMS DIRECTORY's `listDirectory` — from a pre-deploy
 * security review.
 *
 * A SEPARATE FILE from repository.dynamo.test.ts, deliberately: that suite pins the CONTRACT
 * (the conditional flips, the filtered reads, the paging arithmetic). This one attacks the
 * boundary — injection into the FilterExpression, a forged cursor, and every hostile `limit` —
 * so a reader can tell "what this is supposed to do" from "what an attacker cannot make it do".
 *
 * Each test asserts a property the implementation's own comments CLAIM. Where a claim does not
 * hold, the test is named for the DEFECT rather than the wish, and says so in its body.
 *
 * FOUR OF THOSE DEFECTS HAVE BEEN FIXED, and every test here is now named for what it actually
 * asserts. Each carries a comment naming what it used to assert, so the history stays legible and a
 * regression names the decision it broke:
 *
 *   - the wrong-shape cursor (condition 2) — RE-POINTED at the correct behaviour
 *   - the unreachable match past the trip cap (condition 1) — RE-POINTED
 *   - the unbounded workshop scope (condition 3) — FIXED AT THE ROUTE (`MAX_DIRECTORY_SCOPE_IDS`
 *     = 50 with `scopeTruncated` reported); the test now MEASURES the 4KB threshold that cap is
 *     chosen against, and asserts 50 has headroom
 *   - the NaN limit — never reachable through the route (`Number.isFinite` drops it); the test now
 *     DOCUMENTS that the guard lives at the route rather than in this method's own clamp
 *
 * ⚠ NO TEST IN THIS FILE IS NAMED `DEFECT` ANY MORE, and that is deliberate. A test named for a
 * bug that has been fixed is worse than an unnamed one: the next reader either spends time chasing
 * a hole that is not there, or learns to ignore the labels — and then misses the real one. The two
 * remaining known-open items on this feature live elsewhere and are named there: the `audited:
 * false` alarm gap (authz-attack.test.ts, accepted by the owner) and the ZWJ emoji split (accepted
 * trade-off, pinned in two suites).
 */

function directoryRow(over: Partial<Team> = {}): Team {
  return {
    workshopId: "w1",
    id: "t1",
    name: "Team Phoenix",
    description: null,
    inviteCode: "CODE1234",
    repoUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A fake DocClient that Scans an in-memory array with DynamoDB's ORDER OF OPERATIONS: read up to
 * Limit rows from the ExclusiveStartKey, THEN drop the ones the filter rejects, and report
 * LastEvaluatedKey whenever the scan stopped on Limit rather than on running out of data.
 *
 * A DELIBERATE DUPLICATE of the fake in repository.dynamo.test.ts, and the duplication is the
 * point: this copy also reads the TOP-LEVEL boolean operator out of the FilterExpression at
 * bracket depth 0, so an implementation that ORed the authorization scope with the search — which
 * is what a successful injection would achieve — fails here instead of passing on a tidy stub. A
 * fake that applied the two halves as sequential filters would behave like AND whatever the
 * implementation sent, and would report the security property as covered when it is not.
 */
function fakeScanDb(rows: Team[]) {
  const calls: Array<{
    limit?: number;
    startKey?: string;
    filter?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  }> = [];

  const db = {
    async send(cmd: {
      input: {
        Limit?: number;
        ExclusiveStartKey?: { workshopId: string; id: string };
        FilterExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }) {
      const {
        Limit,
        ExclusiveStartKey,
        FilterExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
      } = cmd.input;
      calls.push({
        limit: Limit,
        startKey: ExclusiveStartKey?.id,
        filter: FilterExpression,
        names: ExpressionAttributeNames,
        values: ExpressionAttributeValues,
      });

      const from = ExclusiveStartKey
        ? rows.findIndex(
            (r) =>
              r.workshopId === ExclusiveStartKey.workshopId &&
              r.id === ExclusiveStartKey.id
          ) + 1
        : 0;
      // Rows READ — before any filtering. This is the crux of the behaviour.
      const window = rows.slice(from, from + (Limit ?? rows.length));
      const lastRead = window[window.length - 1];

      let items = window;
      if (FilterExpression) {
        const vals = ExpressionAttributeValues ?? {};
        const scopeValues = Object.entries(vals)
          .filter(([k]) => k.startsWith(":w"))
          .map(([, v]) => v as string);
        const needles = Object.entries(vals)
          .filter(([k]) => k.startsWith(":q"))
          .map(([, v]) => v as string);

        const matchesScope = (r: Team) =>
          scopeValues.length === 0 || scopeValues.includes(r.workshopId);
        // CASE-SENSITIVE, exactly like DynamoDB's own `contains`.
        const matchesSearch = (r: Team) =>
          needles.length === 0 || needles.some((n) => r.name.includes(n));

        // The TOP-LEVEL operator, found at bracket depth 0. A naive /OR/ test is wrong: the
        // search half is itself `(contains(...) OR contains(...))`, so a correct AND expression
        // legitimately contains " OR " inside its parentheses.
        const bothPresent = scopeValues.length > 0 && needles.length > 0;
        let isOr = false;
        if (bothPresent) {
          let depth = 0;
          for (let i = 0; i < FilterExpression.length; i++) {
            const ch = FilterExpression[i];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            else if (depth === 0 && FilterExpression.startsWith(" OR ", i)) {
              isOr = true;
              break;
            }
          }
        }

        items = items.filter((r) =>
          isOr
            ? matchesScope(r) || matchesSearch(r)
            : matchesScope(r) && matchesSearch(r)
        );
      }

      const stoppedOnLimit = from + window.length < rows.length;
      return {
        Items: items,
        LastEvaluatedKey:
          stoppedOnLimit && lastRead
            ? { workshopId: lastRead.workshopId, id: lastRead.id }
            : undefined,
      };
    },
  };

  return { db: db as unknown as DocClient, calls };
}

/** Records exactly what reached the SDK, without modelling a scan. */
function recordingDb() {
  const sent: Array<{
    Limit?: number;
    ExclusiveStartKey?: Record<string, unknown>;
    FilterExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }> = [];
  const db = {
    async send(cmd: { input: (typeof sent)[number] }) {
      sent.push(cmd.input);
      return { Items: [], LastEvaluatedKey: undefined };
    },
  } as unknown as DocClient;
  return { db, sent };
}

// ─── 1. THE WORKSHOP SCOPE CANNOT BE WIDENED ────────────────────────────────────────

describe("SECURITY: listDirectory — the workshop scope cannot be widened", () => {
  it("an EMPTY scope returns nothing WITHOUT a store call — the inversion stays closed", async () => {
    // The claim: "omitting the filter for an empty list would turn 'sees no workshops' into
    // 'sees every team on the platform' — the worst possible direction for this bug". Asserted at
    // the store-call COUNT, not just the returned rows: a route that read the table and filtered
    // afterwards would still have shipped out-of-scope rows into this process.
    const { db, calls } = fakeScanDb([
      directoryRow({ workshopId: "w1", id: "t1" }),
      directoryRow({ workshopId: "w2", id: "t2" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({ workshopIds: [] });

    expect(page.teams).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('a scope of [""] is a REAL restriction matching nothing, not an absent filter', async () => {
    // `[""]` is what the route would pass if HttpWorkshopDirectory's `.filter(w => w.id !== "")`
    // were ever dropped and a Workshop response carried a row with no id. It must reach the store
    // as an IN clause over one impossible partition — never as "no restriction".
    const { db, calls } = fakeScanDb([
      directoryRow({ workshopId: "w1", id: "t1" }),
      directoryRow({ workshopId: "w2", id: "t2" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({ workshopIds: [""] });

    expect(calls[0].filter).toContain("workshopId IN (:w0)");
    expect(calls[0].values![":w0"]).toBe("");
    expect(page.teams).toEqual([]);
  });

  it("a scope of [null] as an untyped value still restricts rather than widening", async () => {
    // `workshopIds` is typed `readonly string[]`, but its value crosses a service boundary as
    // JSON — so the polarity has to hold for a value TypeScript did not actually check. A null in
    // the list must produce an IN operand, never a dropped condition.
    const { db, calls } = fakeScanDb([
      directoryRow({ workshopId: "w1", id: "t1" }),
      directoryRow({ workshopId: "w2", id: "t2" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({
      workshopIds: [null as unknown as string],
    });

    expect(calls[0].filter).toContain("workshopId IN (:w0)");
    expect(page.teams).toEqual([]);
  });

  it("a scoped SEARCH cannot return a team OUTSIDE the scope — the AND, at the store", async () => {
    // The security property the design rests on: search is ANDed with the scope, so a needle
    // matching a team in ANOTHER facilitator's workshop must not appear. Proven against the
    // operator-reading fake, so an implementation that ORed them fails here.
    const { db } = fakeScanDb([
      directoryRow({ workshopId: "w1", id: "t1", name: "phoenix mine" }),
      directoryRow({ workshopId: "w2", id: "t2", name: "phoenix theirs" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({
      workshopIds: ["w1"],
      search: "phoenix",
      limit: 50,
    });

    expect(page.teams.map((t) => t.id)).toEqual(["t1"]);
    expect(page.teams.map((t) => t.workshopId)).not.toContain("w2");
  });

  it("A FORGED CURSOR naming another owner's partition does NOT escape the scope", async () => {
    // THE FORGED-CURSOR ATTACK, which the cursor's shape invites: it is
    // base64url(JSON({workshopId,id})) built client-visibly, so an attacker can hand-craft one
    // pointing into a partition they do not own. The defence must be that the FilterExpression is
    // rebuilt from the CALLER's scope on every request, so a forged start key changes only WHERE
    // the scan begins and never WHAT it may return. Asserted on the rows AND on the filter.
    const { db, calls } = fakeScanDb([
      directoryRow({ workshopId: "w2", id: "a1", name: "Theirs One" }),
      directoryRow({ workshopId: "w2", id: "a2", name: "Theirs Two" }),
      directoryRow({ workshopId: "w1", id: "b1", name: "Mine One" }),
    ]);

    const forged = Buffer.from(
      JSON.stringify({ workshopId: "w2", id: "a1" })
    ).toString("base64url");

    const page = await new DynamoTeamRepository(db).listDirectory({
      workshopIds: ["w1"],
      cursor: forged,
      limit: 50,
    });

    // It started mid-table at the attacker's chosen key and still returned only w1.
    expect(page.teams.map((t) => t.workshopId)).toEqual(["w1"]);
    expect(calls[0].filter).toContain("workshopId IN (:w0)");
    expect(calls[0].startKey).toBe("a1");
  });

  it("a cursor REPLAYED after the scope shrank is re-filtered against the CURRENT scope", async () => {
    // The revoked-ownership case: a facilitator pages page 1 while owning w1 and w2, loses w2,
    // then submits the cursor from page 1. The filter is rebuilt per request, so the second page
    // must carry only what they own NOW. This is what makes the cursor safe to be opaque-but-
    // forgeable — it is a position, never a capability.
    const { db } = fakeScanDb([
      directoryRow({ workshopId: "w1", id: "a1" }),
      directoryRow({ workshopId: "w2", id: "a2" }),
      directoryRow({ workshopId: "w2", id: "a3" }),
      directoryRow({ workshopId: "w1", id: "a4" }),
    ]);
    const repo = new DynamoTeamRepository(db);

    const stale = Buffer.from(
      JSON.stringify({ workshopId: "w1", id: "a1" })
    ).toString("base64url");

    const page = await repo.listDirectory({
      workshopIds: ["w1"],
      cursor: stale,
      limit: 50,
    });

    expect(page.teams.map((t) => t.id)).toEqual(["a4"]);
  });

  it("a WRONG-SHAPE cursor restarts at page ONE and sends NO ExclusiveStartKey to the SDK", async () => {
    const cases: Array<[string, string]> = [
      ['{"foo":1}', "eyJmb28iOjF9 — an unrelated object, the condition 2 example"],
      // ⚠ THE SHARP ONE: `typeof null === "object"`, so a bare object test lets it through.
      ["null", "bnVsbA — parses to null"],
      ['"abc"', "ImFiYyI — parses to a string"],
      ["5", "a number"],
      ["true", "a boolean"],
      ["[]", "an array — an object by typeof, never a key"],
      // The ORIGINAL FINDING's exact payload: extra keys ALONGSIDE two valid ones, which is the
      // case a "do the required keys exist?" check would wave through.
      [
        '{"workshopId":"w1","id":"t1","injected":{"S":"x"}}',
        "EXTRA attribute beside two VALID keys — attacker-chosen",
      ],
      ['{"id":"t1","workshopId":"w1","limit":10000}', "an extra key that looks like an option"],
      ['{"workshopId":"w1"}', "the range key missing"],
      ['{"id":"t1"}', "the hash key missing"],
      ['{"workshopId":"","id":"t1"}', "an EMPTY hash key — not a key DynamoDB accepts"],
      ['{"workshopId":"w1","id":""}', "an EMPTY range key"],
      ['{"workshopId":1,"id":2}', "the right key NAMES, the wrong types"],
    ];

    for (const [raw, why] of cases) {
      const { db, sent } = recordingDb();

      await new DynamoTeamRepository(db).listDirectory({
        cursor: Buffer.from(raw).toString("base64url"),
      });

      // The store WAS asked — a wrong-shape cursor is page one, not an empty result.
      expect(sent, why).toHaveLength(1);
      expect(sent[0].ExclusiveStartKey, why).toBeUndefined();
    }
  });

  it("a TRUNCATED base64 cursor is page one too — the copy-paste case the rule exists for", async () => {
    // The reason the rule is "page one" and not "400": this value travels through a URL where a
    // copy-paste truncates it, and a 400 strands a user holding a stale bookmark on a screen whose
    // cursor is opaque to them. These fail at DECODE (or at JSON.parse) rather than at the shape
    // check, so both arms of decodeDirectoryCursor are covered.
    const valid = Buffer.from(JSON.stringify({ workshopId: "w1", id: "t1" })).toString(
      "base64url"
    );
    const truncations = [
      valid.slice(0, valid.length - 1),
      valid.slice(0, valid.length - 4),
      valid.slice(0, 8),
      valid.slice(1),
      "",
      "not-base64-at-all!!",
      "%%%",
    ];

    for (const cursor of truncations) {
      const { db, sent } = recordingDb();

      // Never throws OUT of the repository — a mangled cursor is not a crash.
      await expect(
        new DynamoTeamRepository(db).listDirectory({ cursor }),
        cursor
      ).resolves.toBeDefined();

      // An EMPTY cursor is falsy, so the repository never decodes it — it is page one by the same
      // observable outcome, which is what this asserts rather than which branch produced it.
      expect(sent[0].ExclusiveStartKey, JSON.stringify(cursor)).toBeUndefined();
    }
  });

  it("a wrong-shape cursor still returns PAGE ONE'S ROWS, not an empty page", async () => {
    // The half a "no start key reached the SDK" assertion cannot see: restarting means the caller
    // GETS page one. An implementation that refused the cursor and also returned nothing would
    // satisfy every assertion above and still be a broken directory.
    const { db } = fakeScanDb([
      directoryRow({ workshopId: "w1", id: "t1" }),
      directoryRow({ workshopId: "w1", id: "t2" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({
      cursor: "eyJmb28iOjF9",
      limit: 50,
    });

    expect(page.teams.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("a VALID cursor is still honoured verbatim — the shape check did not break pagination", async () => {
    // The negative control for the whole block. "Reject every cursor" passes every assertion above
    // and turns the directory into a single unpageable page — which, given §C's trip cap, silently
    // loses rows rather than erroring.
    const { db, sent } = recordingDb();

    await new DynamoTeamRepository(db).listDirectory({
      cursor: Buffer.from(JSON.stringify({ workshopId: "w1", id: "t1" })).toString("base64url"),
    });

    expect(sent[0].ExclusiveStartKey).toEqual({ workshopId: "w1", id: "t1" });
  });

  it("a cursor that parses to a NON-OBJECT does not throw out of the repository", async () => {
    // `JSON.parse("5")` succeeds and yields a number, which the try/catch does not catch. Bounds
    // the damage of a mangled cursor to a start key the store rejects, never an unhandled crash
    // inside this method.
    const { db } = fakeScanDb([directoryRow({ id: "t1" })]);
    const repo = new DynamoTeamRepository(db);

    for (const raw of ["5", "null", '"str"', "[]", "true"]) {
      const cursor = Buffer.from(raw).toString("base64url");
      await expect(repo.listDirectory({ cursor, limit: 1 })).resolves.toBeDefined();
    }
  });
});

// ─── 2. EXPRESSION INJECTION ────────────────────────────────────────────────────────

/** Every needle a caller could send that looks like DynamoDB expression syntax. */
const HOSTILE_NEEDLES = [
  ") OR workshopId <> :w0 OR contains(#name, ",
  ":w0",
  "#name",
  ") OR attribute_exists(id) OR (",
  "' OR '1'='1",
  '" OR "1"="1',
  "\\",
  ":qLower",
  "AND NOT contains(#name, :qLower)",
  "size(#name) > :w0",
  "*",
];

describe("SECURITY: listDirectory — `search` cannot break out of contains()", () => {
  it("PARAMETERISES the needle — it is a VALUE, never spliced into the expression text", async () => {
    // THE INJECTION BOUNDARY, and the reason there is nothing to escape: the needle only ever
    // reaches ExpressionAttributeValues[":qLower"/":qTitled"], and the FilterExpression is a
    // constant string. Asserted by proving the expression is BYTE-IDENTICAL for a benign needle
    // and for every hostile one — an implementation that concatenated would differ.
    const benign = recordingDb();
    await new DynamoTeamRepository(benign.db).listDirectory({ search: "phoenix" });
    const benignExpr = benign.sent[0].FilterExpression;

    for (const needle of HOSTILE_NEEDLES) {
      const { db, sent } = recordingDb();

      await new DynamoTeamRepository(db).listDirectory({ search: needle });

      // The expression NEVER varies with the needle — that is the whole property.
      expect(sent[0].FilterExpression, needle).toBe(benignExpr);
      // And the needle appears only as a bound VALUE. Trimmed, because the repository trims
      // before binding — so the comparison is against the trimmed form, not the raw one.
      expect(sent[0].ExpressionAttributeValues![":qLower"], needle).toBe(
        needle.trim().toLowerCase()
      );
      // No hostile needle leaks into the NAME map either, which is the other half of an
      // expression: an injected `#name` alias would be a way to filter on a different attribute.
      expect(sent[0].ExpressionAttributeNames, needle).toEqual({ "#name": "name" });
    }
  });

  it("a hostile needle cannot widen a SCOPED read — the scope survives verbatim", async () => {
    // The attack that would matter if the needle WERE spliced: an injected `OR workshopId <>`
    // turns a facilitator's scoped page into the whole table. Asserted end to end against the
    // operator-reading fake, so a concatenating implementation returns t2 and fails.
    for (const needle of HOSTILE_NEEDLES) {
      const { db } = fakeScanDb([
        directoryRow({ workshopId: "w1", id: "t1", name: "mine" }),
        directoryRow({ workshopId: "w2", id: "t2", name: "theirs" }),
      ]);

      const page = await new DynamoTeamRepository(db).listDirectory({
        workshopIds: ["w1"],
        search: needle,
        limit: 50,
      });

      expect(page.teams.map((t) => t.workshopId), needle).not.toContain("w2");
    }
  });

  it("the workshopId IN (...) list is built from PLACEHOLDERS, so an id cannot inject either", async () => {
    // The scope ids come from ANOTHER SERVICE's response body, which is a second untrusted
    // source — HttpWorkshopDirectory copies `w.id` through with only a typeof check. They are
    // bound as :w0..:wN exactly like the needle, so an id containing expression syntax is an
    // operand rather than syntax.
    const { db, sent } = recordingDb();

    await new DynamoTeamRepository(db).listDirectory({
      workshopIds: [") OR attribute_exists(id) OR (", ":w1"],
    });

    expect(sent[0].FilterExpression).toBe("workshopId IN (:w0, :w1)");
    expect(sent[0].ExpressionAttributeValues![":w0"]).toBe(
      ") OR attribute_exists(id) OR ("
    );
    expect(sent[0].ExpressionAttributeValues![":w1"]).toBe(":w1");
  });

  it("binds #name and sends NO name map when there is no search", async () => {
    // `name` is a DynamoDB reserved word, and an EMPTY ExpressionAttributeNames map is a 400
    // rather than an ignored field — so the presence of the map has to track the presence of the
    // search. Both polarities asserted together so neither can regress alone.
    const withSearch = recordingDb();
    await new DynamoTeamRepository(withSearch.db).listDirectory({ search: "x" });
    expect(withSearch.sent[0].ExpressionAttributeNames).toEqual({ "#name": "name" });

    const without = recordingDb();
    await new DynamoTeamRepository(without.db).listDirectory({ workshopIds: ["w1"] });
    expect(without.sent[0].ExpressionAttributeNames).toBeUndefined();
  });

  it("a needle of ONLY whitespace produces NO search filter at all", async () => {
    // `?search=%20%20` must not become `contains(#name, "")`, which matches every row and costs
    // an expression to say nothing.
    const { db, calls } = fakeScanDb([directoryRow()]);

    await new DynamoTeamRepository(db).listDirectory({ search: "   " });

    expect(calls[0].filter).toBeUndefined();
  });

  it("the NEEDLE half of the expression is bounded — placeholders, so its size is constant", async () => {
    // The needle is caller-controlled in SIZE, which is the one thing about it worth bounding.
    // Because it is bound as a VALUE, the expression TEXT does not grow with it at all: a
    // 100-code-point needle and a one-character needle produce the same expression string.
    const long = recordingDb();
    await new DynamoTeamRepository(long.db).listDirectory({ search: "x".repeat(100) });
    const short = recordingDb();
    await new DynamoTeamRepository(short.db).listDirectory({ search: "x" });

    expect(long.sent[0].FilterExpression).toBe(short.sent[0].FilterExpression);
    // And the whole expression, values included, is nowhere near the 4KB cap.
    const total =
      Buffer.byteLength(long.sent[0].FilterExpression!, "utf8") +
      Buffer.byteLength(
        JSON.stringify(long.sent[0].ExpressionAttributeValues),  // nosemgrep: no-stringify-keys
        "utf8"
      );
    expect(total).toBeLessThan(1024);
  });

  it("MEASURES the 4KB threshold the route's 50-id scope cap protects (repository has no cap of its own)", async () => {
    // WHAT THIS MEASURES, AND WHY IT IS NOT A LIVE DEFECT ANY MORE.
    //
    // This began as a finding: the route did `workshopIds = owned.map(w => w.id)` with no slice,
    // `listOwnedWorkshops` returned whatever the Workshop service sent, and that service's
    // `listByOwner` is an unbounded Query — so a FACILITATOR owning ~91+ workshops produced a
    // `workshopId IN (:w0 … :wN)` expression over DynamoDB's 4KB cap and got a permanent 500 on
    // their own teams directory.
    //
    // ⚠ FIXED AT THE ROUTE, not here. `MAX_DIRECTORY_SCOPE_IDS = 50` (routes.ts) slices the scope
    // and reports `scopeTruncated: true` in the body, and that path is asserted by
    // adr0004-deploy-conditions.test.ts ("a 120-workshop FACILITATOR gets 200 with
    // scopeTruncated: true, not a 500"). So the reachable hole is closed and this test was
    // renamed off `DEFECT:` — a test name that says "DEFECT" for a fixed bug is worse than no
    // name, because the next reader either chases a hole that is not there or stops trusting the
    // labels.
    //
    // WHAT IT STILL EARNS ITS PLACE FOR: the repository declares no cap of its own, so it is the
    // ROUTE that makes the 50 true. This test states the THRESHOLD the route's number is chosen
    // against — measured, not guessed — so if anyone raises MAX_DIRECTORY_SCOPE_IDS they can see
    // immediately how much headroom is left, and if the id format ever changes (26-char ULIDs are
    // what make the threshold what it is) the arithmetic is re-derived rather than assumed. Note
    // the search makes it worse: 91 with a full needle, 98 without.
    //
    // It calls `listDirectory` DIRECTLY, which is the only way to observe the unclamped
    // arithmetic — going through the route would exercise the 50-cap and measure nothing.
    const sizeFor = async (n: number, needle?: string) => {
      const { db, sent } = recordingDb();
      await new DynamoTeamRepository(db).listDirectory({
        // A real ULID's 26-character length is what makes the threshold what it is.
        workshopIds: Array.from(
          { length: n },
          (_, i) => `01J${String(i).padStart(23, "0")}`
        ),
        ...(needle ? { search: needle } : {}),
      });
      return (
        Buffer.byteLength(sent[0].FilterExpression!, "utf8") +
        Buffer.byteLength(
          JSON.stringify(sent[0].ExpressionAttributeValues),  // nosemgrep: no-stringify-keys
          "utf8"
        )
      );
    };

    const NEEDLE = "x".repeat(100);

    // The route's cap (50) is comfortably inside the budget, WITH a full-length needle. This is
    // the assertion that says the chosen number is safe rather than merely smaller.
    expect(await sizeFor(50, NEEDLE)).toBeLessThan(4096);
    // Realistic scopes have plenty of room.
    expect(await sizeFor(25, NEEDLE)).toBeLessThan(4096);
    // And the budget IS exceeded above the cap — which is why the cap exists. Before the route
    // capped it, this was the finding; now it is the reason the finding stays fixed.
    expect(await sizeFor(100, NEEDLE)).toBeGreaterThan(4096);

    const thresholdFor = async (needle?: string) => {
      for (let n = 60; n <= 140; n++) {
        if ((await sizeFor(n, needle)) > 4096) return n;
      }
      return 0;
    };

    // With a full-length search needle, and without one — the search costs 7 workshops of scope.
    expect(await thresholdFor(NEEDLE)).toBe(91);
    expect(await thresholdFor()).toBe(98);
  });

  it("a 100-CODE-POINT needle of 4-byte emoji does not blow the BYTE budget either", async () => {
    // The route slices in CODE POINTS while the budget is in BYTES — the one place those two
    // units diverge, so 100 "characters" can be 400 bytes.
    const { db, sent } = recordingDb();

    await new DynamoTeamRepository(db).listDirectory({
      search: "\u{1F600}".repeat(100),
    });

    const bytes = Buffer.byteLength(
      JSON.stringify(sent[0].ExpressionAttributeValues),  // nosemgrep: no-stringify-keys
      "utf8"
    );
    expect(bytes).toBeLessThan(4096);
  });
});

// ─── 3. THE READ IS BOUNDED WHATEVER THE CALLER ASKS ────────────────────────────────

describe("SECURITY: listDirectory — bounded whatever the caller asks", () => {
  it("CLAMPS every hostile limit into [1, 100] — the ONLY place the route relies on", async () => {
    // The route deliberately forwards any FINITE Number and relies on this clamp, so every
    // boundary value has to be proven HERE, because here is the only place it is enforced.
    const cases: Array<[number, number]> = [
      [10000, 100],
      [1e9, 100],
      [-5, 1],
      [0, 1],
      [2.7, 2],
      [0.4, 1],
      [Number.MAX_SAFE_INTEGER, 100],
      [-Number.MAX_SAFE_INTEGER, 1],
    ];

    for (const [asked, clamped] of cases) {
      const { db, calls } = fakeScanDb(
        Array.from({ length: 300 }, (_, i) => directoryRow({ id: `t${i}` }))
      );

      const page = await new DynamoTeamRepository(db).listDirectory({ limit: asked });

      // The Limit sent is clamped + 1 (the has-more probe row).
      expect(calls[0].limit, `asked ${asked}`).toBe(clamped + 1);
      expect(page.teams.length, `asked ${asked}`).toBeLessThanOrEqual(100);
    }
  });

  it("clamps INFINITY, in both directions", async () => {
    // ±Infinity survives `Math.floor` and is clamped by `Math.min`/`Math.max`, so these are safe
    // in the repository itself and not only behind the route's guard.
    for (const [bad, expected] of [
      [Infinity, 101],
      [-Infinity, 2],
    ] as const) {
      const { db, calls } = fakeScanDb([directoryRow({ id: "t1" })]);

      await new DynamoTeamRepository(db).listDirectory({ limit: bad });

      expect(calls[0].limit, String(bad)).toBe(expected);
    }
  });

  it("DOCUMENTS that the repository's own clamp does not hold for NaN — the ROUTE is what makes it safe", async () => {
    // NOT A REACHABLE DEFECT, and the name says so rather than crying DEFECT at a hole that is
    // closed: the route drops a non-finite value with `Number.isFinite(parsedLimit)`, so
    // `?limit=NaN` arrives here as `undefined` and defaults to 50. Verified through the HTTP
    // surface, not assumed. Renamed off `DEFECT:` for the same reason as the scope test above —
    // a name that claims a live hole for something guarded elsewhere teaches the next reader to
    // distrust the labels.
    //
    // But the clamp is the ONLY bound this method declares, and it does not hold for NaN:
    // `Math.min(Math.max(1, Math.floor(NaN)), 100)` is NaN, because every Math comparison with
    // NaN is false. A `Limit: NaN` is a DynamoDB ValidationException, i.e. a 500. The repository
    // is a PUBLIC method on an exported class whose own comment says it is "clamped server-side so
    // a caller asking for 10,000 gets MAX_DIRECTORY_PAGE_SIZE" — that claim is not true of every
    // input, and the route's guard is what makes it true today. A second caller that forgets the
    // guard reintroduces it silently.
    const { db, calls } = fakeScanDb([directoryRow({ id: "t1" })]);

    await new DynamoTeamRepository(db).listDirectory({ limit: NaN });

    // This assertion IS the finding: NaN was neither clamped nor rejected.
    expect(Number.isNaN(calls[0].limit)).toBe(true);
  });

  it("NEVER exceeds 5 round trips, even when the filter rejects every row it reads", async () => {
    // THE BOUND ON THE SCAN, and the honest answer to "what stops this reading the table?". A
    // needle matching nothing in a large table is the worst case: DynamoDB keeps returning
    // LastEvaluatedKey and the loop keeps asking. Asserted at the round-trip COUNT, which is the
    // resource being bounded, and at the rows READ.
    const { db, calls } = fakeScanDb(
      Array.from({ length: 5000 }, (_, i) =>
        directoryRow({ id: `t${i}`, name: "Team" })
      )
    );

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 100,
      search: "nothing-matches-this-needle",
    });

    expect(calls).toHaveLength(5);
    expect(page.teams).toEqual([]);
    const rowsRead = calls.reduce((n, c) => n + (c.limit ?? 0), 0);
    expect(rowsRead).toBeLessThanOrEqual(5 * 101);
  });

  it("a match past the 5-trip window is REACHABLE by paging — the trip cap hands back a FALLBACK cursor", async () => {
    // ── RE-POINTED. THE GAP IS CLOSED. This was "KNOWN GAP: a match past the 5-trip window is
    // reported as 'not found' with NO cursor" and asserted `nextCursor` undefined on an empty
    // capped page — a completeness gap that failed closed (a team missed, never an extra team
    // shown) but made the route's own "hitting the cap hands back a CURSOR" claim false.
    //
    // WHAT THE FIX IS. Two parts, both in listDirectory (repository.dynamo.ts):
    //   `hasMore = found.length > limit || !exhausted` — condition 1. The old
    //     `… || (!exhausted && found.length >= limit)` evaluated `0 >= 10` false on exactly this
    //     page, so a truncated page reported "no more".
    //   `fallbackKey` — the scan's own LastEvaluatedKey, carried for the ONE state a
    //     last-returned-row cursor cannot express: five trips, ZERO matches, table unexhausted.
    //     There is no returned row to derive a key from.
    //
    // THE ASSERTION IS REACHABILITY, NOT THE PRESENCE OF A CURSOR. "A cursor exists" is satisfied
    // by a cursor that loops, restarts, or skips the needle — so this pages to completion over a
    // 10,000-row table with THREE needles and asserts ALL THREE are found, NONE is duplicated, and
    // the paging TERMINATES. Skipping the evaluated-and-rejected rows the fallback jumps over is
    // correct: they did not match the filter, so no row the caller may see is lost.
    const NEEDLE_AT = [4321, 7777, 9999];
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      directoryRow({
        id: `t${String(i).padStart(5, "0")}`,
        // CASE-SENSITIVE match, like DynamoDB's own `contains` and like the fake: "needle" is
        // lowercase so it matches the repository's lowercased form of the search term.
        name: NEEDLE_AT.includes(i) ? `needle team ${i}` : "Team",
      })
    );
    const repo = new DynamoTeamRepository(fakeScanDb(rows).db);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    // A hard iteration ceiling so a `hasMore` that is ALWAYS true fails as a bounded assertion
    // below rather than hanging the suite — an infinite "Next" is not a fix.
    do {
      const page = await repo.listDirectory({ limit: 10, search: "needle", cursor });
      seen.push(...page.teams.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 500);

    // COMPLETE: every needle reached, in table order.
    expect(seen).toEqual(NEEDLE_AT.map((i) => `t${String(i).padStart(5, "0")}`));
    // NO DUPLICATES — a fallback cursor that re-covered ground would double-count a match.
    expect(new Set(seen).size).toBe(seen.length);
    // TERMINATES: the cursor eventually clears rather than paging forever.
    expect(cursor).toBeUndefined();
    expect(pages).toBeLessThan(500);
  });

  it("the FIRST page of that search is SHORT with a LIVE cursor, rather than empty and dead", async () => {
    // The single-request shape of the same fix, asserted separately from the paging loop so a
    // failure names which property broke. The first request evaluates 5 × 11 rows and matches
    // nothing — the exact state that used to report `hasMore: false` with no cursor.
    const { db } = fakeScanDb(
      Array.from({ length: 10_000 }, (_, i) =>
        directoryRow({
          id: `t${String(i).padStart(5, "0")}`,
          name: i === 9999 ? "needle team" : "Team",
        })
      )
    );

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 10,
      search: "needle",
    });

    expect(page.teams).toEqual([]);
    // THE INVERTED ASSERTION: a live cursor on an empty capped page, so the client can page on.
    expect(page.nextCursor).toBeDefined();
    // And it is a cursor the repository would ACCEPT back — a fallback key that failed its own
    // shape check would be a "Next" that 500s or silently restarts at page one forever.
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, "base64url").toString()
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(["id", "workshopId"]);
    expect(typeof decoded.workshopId).toBe("string");
    expect(typeof decoded.id).toBe("string");
  });

  it("still hands back NO cursor when the table IS exhausted — the fix is not 'always more'", async () => {
    // The polarity that must not regress with the fallback, and the reason `!exhausted` is safe:
    // DynamoDB sets LastEvaluatedKey whenever a Scan stops on Limit, INCLUDING on the last matching
    // row. A cursor here would be a live "Next" onto an empty page — the mirror-image defect.
    const { db } = fakeScanDb([
      directoryRow({ id: "t1", name: "needle one" }),
      directoryRow({ id: "t2", name: "needle two" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 10,
      search: "needle",
    });

    expect(page.teams.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(page.nextCursor).toBeUndefined();
  });
});
