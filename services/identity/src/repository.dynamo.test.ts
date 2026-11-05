import { describe, it, expect } from "vitest";
import type { DocClient } from "@praimana/service-shared";
import { DynamoUserRepository } from "./repository.dynamo.js";
import type { User } from "./domain.js";

/**
 * Tests for list()'s paging and role filtering against a fake that reproduces the
 * ONE DynamoDB behaviour this code exists to survive: a FilterExpression is applied
 * AFTER Limit, and LastEvaluatedKey is set whenever a Scan stops on Limit — even if
 * it stopped on the last matching row.
 *
 * That combination is why a naive implementation leaks. A FACILITATOR (who must not
 * see ADMIN accounts) asking for 3 rows out of a table holding 1 admin + 3 others
 * gets 2 rows back plus a cursor, and the cursor itself proves a fourth row exists.
 * Confirmed live against the dev table before this was fixed, which is why the fake
 * below models the paging semantics rather than stubbing a tidy answer.
 */

function user(over: Partial<User> = {}): User {
  return {
    id: "u-1",
    email: "u1@example.com",
    name: "User One",
    role: "PARTICIPANT",
    authProvider: "COGNITO",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A fake DocClient that scans an in-memory array with DynamoDB's ordering of
 * operations: take up to Limit rows from the ExclusiveStartKey, THEN drop the ones
 * the filter rejects, and report LastEvaluatedKey whenever the scan stopped because
 * of Limit rather than because the data ran out.
 */
function fakeDb(rows: User[]) {
  const calls: { limit?: number; startKey?: string }[] = [];

  const db = {
    async send(cmd: {
      input: {
        Limit?: number;
        ExclusiveStartKey?: { id: string };
        FilterExpression?: string;
        ExpressionAttributeValues?: Record<string, string>;
      };
    }) {
      const { Limit, ExclusiveStartKey, FilterExpression, ExpressionAttributeValues } =
        cmd.input;
      calls.push({ limit: Limit, startKey: ExclusiveStartKey?.id });

      const from = ExclusiveStartKey
        ? rows.findIndex((r) => r.id === ExclusiveStartKey.id) + 1
        : 0;
      // Rows READ — before any filtering. This is the crux of the behaviour.
      const window = rows.slice(from, from + (Limit ?? rows.length));
      const lastRead = window[window.length - 1];

      let items = window;
      if (FilterExpression) {
        const vals = ExpressionAttributeValues ?? {};
        const roleValues = Object.entries(vals)
          .filter(([k]) => k.startsWith(":r"))
          .map(([, v]) => v);
        const needles = Object.entries(vals)
          .filter(([k]) => k.startsWith(":q"))
          .map(([, v]) => v);

        // Each half evaluated as a PREDICATE, then combined by reading the operator the
        // expression actually uses.
        //
        // THE OPERATOR IS READ FROM THE EXPRESSION, not assumed. Applying the two halves
        // as sequential filters — which is the obvious way to write this fake — makes it
        // behave like AND no matter what the implementation sent, so an implementation
        // that ORed them would still pass. A mutation test caught exactly that: flipping
        // " AND " to " OR " in the repository changed nothing here. A fake that cannot
        // distinguish the safe implementation from the leaky one is worse than no test,
        // because it reports the security property as covered.
        const matchesRole = (r: User) =>
          roleValues.length === 0 || roleValues.includes(r.role);
        const matchesSearch = (r: User) =>
          needles.length === 0 ||
          needles.some((n) => (r.name ?? "").includes(n) || (r.email ?? "").includes(n));

        // The TOP-LEVEL operator, found by scanning at bracket depth 0.
        //
        // A naive `/ OR /.test(expr)` is WRONG here and I had it wrong first: the search
        // half is itself `(contains(name,..) OR contains(email,..) OR ...)`, so a correct
        // AND expression contains " OR " inside its parentheses and the naive check
        // reported every expression as an OR. Only the join between the two halves —
        // outside all brackets — decides whether the restrictions combine safely.
        const bothPresent = roleValues.length > 0 && needles.length > 0;
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
          isOr ? matchesRole(r) || matchesSearch(r) : matchesRole(r) && matchesSearch(r)
        );
      }

      const stoppedOnLimit = from + window.length < rows.length;
      return {
        Items: items,
        // Set whenever there is more table past the window — which DynamoDB reports
        // regardless of how many rows survived the filter.
        LastEvaluatedKey: stoppedOnLimit && lastRead ? { id: lastRead.id } : undefined,
      };
    },
  };

  return { db: db as unknown as DocClient, calls };
}

const FACILITATOR_SEES = ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"];

// One admin followed by three participants — the shape of the live dev table, and
// the arrangement that produced the leak (the hidden row comes FIRST, so it is
// consumed by the first window's Limit).
const population = [
  user({ id: "a-1", email: "admin@example.com", role: "ADMIN" }),
  user({ id: "p-1", email: "p1@example.com" }),
  user({ id: "p-2", email: "p2@example.com" }),
  user({ id: "p-3", email: "p3@example.com" }),
];

describe("DynamoUserRepository.list — role filtering", () => {
  it("returns every row when no visibleRoles is given", async () => {
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({ limit: 10 });
    expect(page.users.map((u) => u.id)).toEqual(["a-1", "p-1", "p-2", "p-3"]);
  });

  it("drops rows whose role is not visible to the caller", async () => {
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({
      limit: 10,
      visibleRoles: FACILITATOR_SEES,
    });
    expect(page.users.map((u) => u.role)).not.toContain("ADMIN");
    expect(page.users.map((u) => u.id)).toEqual(["p-1", "p-2", "p-3"]);
  });

  // The closed case. An empty list means "sees nobody"; reading it as "no filter" —
  // which is what omitting the FilterExpression would do — inverts the entire rule
  // from total exclusion to total exposure.
  it("returns NOTHING for an empty visibleRoles, without querying at all", async () => {
    const { db, calls } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({ visibleRoles: [] });
    expect(page.users).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("fills a full page even when filtered-out rows fall inside it", async () => {
    // limit=3 with the admin first: a single Limit=3 scan reads a-1,p-1,p-2 and
    // yields only 2 visible rows. The fill loop must keep going to reach p-3.
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({
      limit: 3,
      visibleRoles: FACILITATOR_SEES,
    });
    expect(page.users.map((u) => u.id)).toEqual(["p-1", "p-2", "p-3"]);
  });
});

describe("DynamoUserRepository.list — the cursor must not leak hidden rows", () => {
  it("gives NO next cursor when the visible rows are exhausted", async () => {
    // The regression. All 3 visible rows fit in the page, so there is no next page —
    // even though a raw LastEvaluatedKey would have been set by the scan that
    // consumed the admin row.
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({
      limit: 3,
      visibleRoles: FACILITATOR_SEES,
    });

    expect(page.users).toHaveLength(3);
    expect(page.nextCursor).toBeUndefined();
  });

  it("gives no next cursor when an unfiltered page exactly empties the table", async () => {
    // Same bug class without any filter: limit === row count used to return a cursor
    // to an empty page, so the UI showed an enabled "Next" on a complete list.
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({ limit: 4 });
    expect(page.users).toHaveLength(4);
    expect(page.nextCursor).toBeUndefined();
  });

  it("DOES give a cursor when rows genuinely remain, pointing at the last row RETURNED", async () => {
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({
      limit: 2,
      visibleRoles: FACILITATOR_SEES,
    });

    expect(page.users.map((u) => u.id)).toEqual(["p-1", "p-2"]);
    expect(page.nextCursor).toBeDefined();
    // Decoded, it is the last row we HANDED BACK — not the extra row we peeked at.
    // Anchoring on the peeked row is how the next page would skip p-3 entirely.
    const key = JSON.parse(
      Buffer.from(page.nextCursor!, "base64url").toString()
    ) as { id: string };
    expect(key.id).toBe("p-2");
  });

  it("walks a filtered list one row at a time with no overlap and no skips", async () => {
    const repo = new DynamoUserRepository(fakeDb(population).db);
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await repo.list({ limit: 1, cursor, visibleRoles: FACILITATOR_SEES });
      expect(page.users.every((u) => u.role !== "ADMIN")).toBe(true);
      seen.push(...page.users.map((u) => u.id));
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(4); // terminates
    } while (cursor);

    expect(seen).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("walks an unfiltered list the same way", async () => {
    const repo = new DynamoUserRepository(fakeDb(population).db);
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await repo.list({ limit: 2, cursor });
      seen.push(...page.users.map((u) => u.id));
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(4);
    } while (cursor);

    expect(seen).toEqual(["a-1", "p-1", "p-2", "p-3"]);
  });

  it("treats a malformed cursor as page one rather than throwing", async () => {
    // It travels through a URL where a copy-paste can truncate it. Page one is a
    // harmless answer; a 500 on the Administration screen is not.
    const { db } = fakeDb(population);
    const page = await new DynamoUserRepository(db).list({
      limit: 2,
      cursor: "!!!not-base64!!!",
    });
    expect(page.users.map((u) => u.id)).toEqual(["a-1", "p-1"]);
  });

  it("clamps an absurd limit instead of reading the whole table", async () => {
    const { db, calls } = fakeDb(population);
    await new DynamoUserRepository(db).list({ limit: 10_000 });
    // MAX_PAGE_SIZE is 100; the +1 is the look-ahead row.
    expect(calls[0].limit).toBe(101);
  });
});

/**
 * SERVER-SIDE SEARCH — the store must apply it, and it must never widen visibility.
 *
 * Owner: "we need proper backend search as well to search users". The Administration
 * screen previously filtered only the LOADED PAGE in the browser, so searching while on
 * page 1 silently found nobody on page 2 — fine for skimming, wrong when the reason you
 * are searching is to act on a specific person, because the operator concludes the
 * account does not exist.
 */
describe("DynamoUserRepository.list — search", () => {
  const mixed = [
    user({ id: "a-1", email: "admin@example.com", name: "Ada Admin", role: "ADMIN" }),
    user({ id: "p-1", email: "ada.lovelace@example.com", name: "Ada Lovelace" }),
    user({ id: "p-2", email: "grace@example.com", name: "Grace Hopper" }),
  ];

  it("matches on name", async () => {
    const { db } = fakeDb(mixed);
    const page = await new DynamoUserRepository(db).list({ search: "Grace" });
    expect(page.users.map((u) => u.id)).toEqual(["p-2"]);
  });

  it("matches on email", async () => {
    const { db } = fakeDb(mixed);
    const page = await new DynamoUserRepository(db).list({ search: "grace@" });
    expect(page.users.map((u) => u.id)).toEqual(["p-2"]);
  });

  it("is case-insensitive for the common casings", async () => {
    // DynamoDB's `contains` is case-SENSITIVE and a filter expression has no lower(), so
    // the repository sends both a lowercased and a capitalised form. "ada" must find
    // "Ada Lovelace" — otherwise an operator typing lowercase finds nobody.
    for (const needle of ["ada", "Ada", "ADA"]) {
      const { db } = fakeDb(mixed);
      const page = await new DynamoUserRepository(db).list({ search: needle });
      expect(page.users.map((u) => u.id)).toContain("p-1");
    }
  });

  it("AND-COMBINES with visibleRoles — search must never reveal a hidden account", async () => {
    // THE SECURITY PROPERTY. "Ada Admin" matches the needle but is an ADMIN, so a
    // FACILITATOR searching "Ada" must get the participant and NOT be told the admin
    // exists. If search were ORed with the role filter, or applied instead of it, this
    // would leak the row — and a search box is exactly where someone would probe.
    const { db } = fakeDb(mixed);
    const page = await new DynamoUserRepository(db).list({
      search: "Ada",
      visibleRoles: FACILITATOR_SEES,
    });
    expect(page.users.map((u) => u.id)).toEqual(["p-1"]);
    expect(page.users.some((u) => u.role === "ADMIN")).toBe(false);
  });

  it("returns everyone visible when the needle is absent or blank", async () => {
    for (const search of [undefined, "", "   "]) {
      const { db } = fakeDb(mixed);
      const page = await new DynamoUserRepository(db).list({ search });
      expect(page.users).toHaveLength(3);
    }
  });

  it("returns an empty page for a needle nobody matches", async () => {
    // A determined "no matches" — distinct from an error, and the UI says "0 matches".
    const { db } = fakeDb(mixed);
    const page = await new DynamoUserRepository(db).list({ search: "zzz-nobody" });
    expect(page.users).toEqual([]);
  });
});
