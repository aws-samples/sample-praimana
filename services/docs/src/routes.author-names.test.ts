import { describe, it, expect, beforeAll } from "vitest";
import { createDocsRoutes } from "./routes.js";
import {
  IDENTITY_HEADERS,
  INTERNAL_TOKEN_HEADER,
} from "@praimana/service-shared";
import type {
  DocPointer,
  DocPointerRepository,
  DocStore,
  TeamLookup,
  UserView,
  UsersReadModel,
} from "./domain.js";
import type { TeamMembership } from "./authz.js";

/**
 * A DOCUMENT'S AUTHOR, SHOWN AS A NAME RATHER THAN A COGNITO SUB.
 *
 * ── THE REPORTED BUG ──
 *
 * A file uploaded by hand listed its author as `94c89498-90e1-7070-dd34-b71a17076f4c`. `lastAuthor`
 * holds whatever the writer supplied, and the upload route supplies the caller's identity id — so
 * every hand-uploaded file showed a sub. Verified rather than assumed: that id resolves to
 * "Participant Five" in the collaboration read-model, so the name existed on the platform the whole
 * time and this service was simply the only one of six with no users read-model to look it up in.
 *
 * ── THE PROPERTY THAT SHAPES EVERY TEST HERE ──
 *
 * ⚠ `lastAuthor` HOLDS TWO DIFFERENT KINDS OF VALUE. An upload writes a Cognito sub; a git sync
 * writes a git author NAME, because the desktop sends one. So the fix cannot replace the field:
 * looking up "Alice Smith" returns nothing, and blanking it would delete the only attribution a
 * synced file has. Hence an ADDITIVE `lastAuthorName`, set only when the id actually resolves.
 *
 * That is why the "leaves a git author name alone" test matters as much as the resolving one.
 */

const INTERNAL_TOKEN = "test-internal-token";
beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(id: string, role = "PARTICIPANT") {
  return {
    "content-type": "application/json",
    [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
    [IDENTITY_HEADERS.id]: id,
    [IDENTITY_HEADERS.email]: `${id}@example.com`,
    [IDENTITY_HEADERS.role]: role,
  };
}

const SUB = "94c89498-90e1-7070-dd34-b71a17076f4c";

class FakeStore implements DocStore {
  /** Keys a delete marker was written for, so the test can assert S3 was told. */
  removed: string[] = [];
  async remove(key: string) {
    this.removed.push(key);
  }
  async put() {
    return "v1";
  }
  async get() {
    return "# body";
  }
  async listVersions() {
    return [];
  }
  /**
   * These author-name tests never presign or head, but the fake must satisfy the WHOLE port or it is
   * not a DocStore — and `implements` is what makes that a compile error rather than a runtime
   * surprise. Both signatures are the interface's, not invented: `presignPut` (not presignUpload) and
   * a `head` that returns contentType.
   */
  async presignPut(_args: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }) {
    return { url: "https://s3.example/x", headers: {}, expiresAt: "2026-08-07T12:00:00.000Z" };
  }
  async head() {
    return { size: 10, contentType: "text/markdown", versionId: "v1" };
  }
}

class FakePointers implements DocPointerRepository {
  /** Rows forgotten, so the test can assert the file left the list. */
  removedRows: Array<{ teamId: string; path: string }> = [];
  async remove(teamId: string, path: string) {
    this.removedRows.push({ teamId, path });
    this.rows = this.rows.filter((r) => !(r.teamId === teamId && r.path === path));
  }
  constructor(public rows: DocPointer[] = []) {}
  async listByTeam(teamId: string) {
    return this.rows.filter((r) => r.teamId === teamId);
  }
  async get(teamId: string, path: string) {
    return this.rows.find((r) => r.teamId === teamId && r.path === path) ?? null;
  }
  async put(p: DocPointer) {
    this.rows.push(p);
    return p;
  }
}

const teams: TeamLookup = {
  workshopIdForTeam: async (teamId) => (teamId === "team-1" ? "ws-1" : null),
};

class FakeMembership implements TeamMembership {
  async isMember(teamId: string, userId: string) {
    return teamId === "team-1" && userId === "member";
  }
}

/** Records lookups so "one per DISTINCT author" is assertable, not assumed. */
class FakeUsers implements UsersReadModel {
  getCalls = 0;
  constructor(private readonly rows: UserView[] = []) {}
  async get(id: string) {
    this.getCalls += 1;
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async upsert() {}
  async delete() {}
}

/** A users read-model whose lookups always fail — a read-model blip, not a missing row. */
class BrokenUsers implements UsersReadModel {
  async get(): Promise<UserView | null> {
    throw new Error("read-model unavailable");
  }
  async upsert() {}
  async delete() {}
}

const pointer = (over: Partial<DocPointer> = {}): DocPointer => ({
  teamId: "team-1",
  path: "design.md",
  workshopId: "ws-1",
  s3Key: "workshop/ws-1/team/team-1/design.md",
  versionId: "v1",
  lastCommitHash: null,
  lastAuthor: SUB,
  updatedAt: "2026-08-10T10:00:00.000Z",
  ...over,
});

function build(opts: { rows?: DocPointer[]; users?: UsersReadModel } = {}) {
  const pointers = new FakePointers(opts.rows ?? []);
  const app = createDocsRoutes({
    store: new FakeStore(),
    pointers,
    teams,
    membership: new FakeMembership(),
    ...(opts.users ? { users: opts.users } : {}),
  });
  return { app, pointers };
}

const list = (app: ReturnType<typeof build>["app"]) =>
  app.request("/v1/teams/team-1/docs", { headers: asUser("member") });
const content = (app: ReturnType<typeof build>["app"], path = "design.md") =>
  app.request(`/v1/teams/team-1/docs/content?path=${encodeURIComponent(path)}`, {
    headers: asUser("member"),
  });

describe("GET /docs — the reported sub becomes a name", () => {
  it("resolves a Cognito sub to a display name", async () => {
    const users = new FakeUsers([{ id: SUB, name: "Participant Five" }]);
    const { app } = build({ rows: [pointer()], users });

    const body = await (await list(app)).json();

    expect(body.files[0].lastAuthorName).toBe("Participant Five");
  });

  it("KEEPS the raw lastAuthor alongside it", async () => {
    /**
     * Additive, not a replacement. The id is what the store holds and what a later write compares
     * against; a reader prefers the name and falls back to the id, so nothing needs the field to
     * change meaning.
     */
    const users = new FakeUsers([{ id: SUB, name: "Participant Five" }]);
    const { app } = build({ rows: [pointer()], users });

    const body = await (await list(app)).json();

    expect(body.files[0].lastAuthor).toBe(SUB);
  });

  it("⚠ LEAVES A GIT AUTHOR NAME ALONE", async () => {
    /**
     * THE TEST THAT STOPS THE FIX BREAKING THE OTHER CASE. A git-synced file's `lastAuthor` is
     * already a name, so the lookup misses — and a version of this that overwrote the field, or set
     * `lastAuthorName: null`, would delete the only attribution such a file has.
     */
    const users = new FakeUsers([{ id: SUB, name: "Participant Five" }]);
    const { app } = build({
      rows: [pointer({ path: "readme.md", lastAuthor: "Alice Smith" })],
      users,
    });

    const body = await (await list(app)).json();

    expect(body.files[0].lastAuthor).toBe("Alice Smith");
    expect(body.files[0]).not.toHaveProperty("lastAuthorName");
  });

  it("OMITS the field rather than sending null when the id does not resolve", async () => {
    // A brand-new user can upload before the projection's row arrives. Omitted means "no name
    // available", which a reader's `?? lastAuthor` handles; `null` would need a second branch.
    const { app } = build({ rows: [pointer()], users: new FakeUsers([]) });

    const body = await (await list(app)).json();

    expect(body.files[0]).not.toHaveProperty("lastAuthorName");
    expect(body.files[0].lastAuthor).toBe(SUB);
  });

  it("looks each author up ONCE, not once per file", async () => {
    // A team whose twelve documents were all uploaded by one person must cost one Get.
    const users = new FakeUsers([{ id: SUB, name: "Participant Five" }]);
    const rows = Array.from({ length: 12 }, (_, i) => pointer({ path: `f${i}.md` }));
    const { app } = build({ rows, users });

    const body = await (await list(app)).json();

    expect(body.files).toHaveLength(12);
    expect(body.files.every((f: { lastAuthorName?: string }) => f.lastAuthorName === "Participant Five")).toBe(true);
    expect(users.getCalls, "one lookup per DISTINCT author").toBe(1);
  });

  it("resolves several distinct authors", async () => {
    const users = new FakeUsers([
      { id: SUB, name: "Participant Five" },
      { id: "other-sub", name: "Participant Six" },
    ]);
    const { app } = build({
      rows: [pointer(), pointer({ path: "b.md", lastAuthor: "other-sub" })],
      users,
    });

    const body = await (await list(app)).json();

    expect(body.files.map((f: { lastAuthorName?: string }) => f.lastAuthorName)).toEqual([
      "Participant Five",
      "Participant Six",
    ]);
    expect(users.getCalls).toBe(2);
  });
});

describe("the document list survives a broken read-model", () => {
  it("⚠ STILL RETURNS THE FILES when every lookup throws", async () => {
    /**
     * THE FAILURE DIRECTION THAT MATTERS. The list is the valuable thing on this response; a name is
     * a nicety. Letting a read-model blip propagate would render "this team has no documents" — a
     * far more alarming and less true statement than showing an id.
     */
    const { app } = build({ rows: [pointer()], users: new BrokenUsers() });

    const res = await list(app);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].lastAuthor).toBe(SUB);
    expect(body.files[0]).not.toHaveProperty("lastAuthorName");
  });
});

describe("the read-model is OPTIONAL, so the service still composes without it", () => {
  it("returns unenriched rows when no users dep is wired", async () => {
    // Local dev and any deployment that has not provisioned the table: the previous behaviour, which
    // is wrong but strictly better than failing the request.
    const { app } = build({ rows: [pointer()] });

    const body = await (await list(app)).json();

    expect(body.files[0].lastAuthor).toBe(SUB);
    expect(body.files[0]).not.toHaveProperty("lastAuthorName");
  });
});

describe("GET /docs/content — the same name, so the two views cannot disagree", () => {
  it("enriches the single-document response too", async () => {
    /**
     * The viewer's "Last edited by" and the row it was opened from must agree about the same person.
     * Enriching only the list would have left the detail view showing a sub — the same bug, one
     * click deeper.
     */
    const users = new FakeUsers([{ id: SUB, name: "Participant Five" }]);
    const { app } = build({ rows: [pointer()], users });

    const body = await (await content(app)).json();

    expect(body.lastAuthorName).toBe("Participant Five");
    expect(body.lastAuthor).toBe(SUB);
  });

  it("omits the name for an unresolvable author here as well", async () => {
    const { app } = build({ rows: [pointer()], users: new FakeUsers([]) });

    const body = await (await content(app)).json();

    expect(body).not.toHaveProperty("lastAuthorName");
  });
});

describe("authorization is unchanged by the enrichment", () => {
  it("a NON-MEMBER is still refused, and no lookup happens", async () => {
    // The guard runs before the read, so a refused caller costs no read-model traffic either.
    const users = new FakeUsers([{ id: SUB, name: "Participant Five" }]);
    const { app } = build({ rows: [pointer()], users });

    const res = await app.request("/v1/teams/team-1/docs", { headers: asUser("outsider") });

    expect(res.status).toBe(403);
    expect(users.getCalls).toBe(0);
  });
});

/**
 * ── ⚠ THE SECOND REPORTED BUG: "choose from repo" SHOWED "unknown" ─────────────────────────
 *
 * The desktop defaulted `lastAuthor` and `lastCommitHash` to the literal string `"unknown"` for a file
 * git had never seen committed, with a comment claiming that was accurate. It is not: GIT does not know
 * the author of an uncommitted file, but THIS PLATFORM DOES — the request is authenticated.
 *
 * Because `"unknown"` is not null, the route's `?? id` fallback never fired and the sentinel was stored
 * as though it were a person's name. Then the users read-model was asked to resolve a user called
 * "unknown", failed, and the reader's fallback printed it.
 *
 * ⚠ FIXED IN BOTH PLACES, AND THESE TESTS COVER THE SERVER HALF. The desktop now sends null, but an
 * older installer cannot be forced to update mid-workshop and will keep sending the sentinel.
 */
describe("POST /docs — a placeholder attribution never becomes an author", () => {
  const sync = (app: ReturnType<typeof build>["app"], files: unknown[]) =>
    app.request("/v1/teams/team-1/docs", {
      method: "POST",
      headers: { ...asUser("member"), "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });

  it('stores the CALLER, not the string "unknown" (the legacy desktop sentinel)', async () => {
    const { app, pointers } = build();

    const res = await sync(app, [
      { path: "notes.md", content: "# hi", lastAuthor: "unknown", lastCommitHash: "unknown" },
    ]);

    expect(res.status).toBe(201);
    // The authenticated uploader — the one person we can be certain about.
    expect(pointers.rows[0].lastAuthor).toBe("member");
    // ⚠ AND THE COMMIT HASH BECOMES NULL, NOT THE CALLER. There IS no commit; naming one would be a
    // lie, and "unknown" in a hash field is worse than absence because a reader cannot tell it from a
    // hash it failed to parse.
    expect(pointers.rows[0].lastCommitHash).toBeNull();
  });

  it("treats null and an empty string the same way", async () => {
    // ⚠ EMPTY IS THE COMMON CASE AT A WORKSHOP: a fresh venue laptop with no `user.name` configured
    // yields "" from git, which is also non-null and would land exactly like the sentinel.
    const { app, pointers } = build();

    await sync(app, [
      { path: "a.md", content: "a", lastAuthor: null },
      { path: "b.md", content: "b", lastAuthor: "   " },
      { path: "c.md", content: "c" },
    ]);

    expect(pointers.rows.map((r) => r.lastAuthor)).toEqual(["member", "member", "member"]);
  });

  it("⚠ STILL KEEPS A REAL GIT AUTHOR — the thing this must not break", async () => {
    // A committed file's git author name is the RIGHT answer and is better than the uploader: the
    // person who wrote it is not necessarily the person who pressed upload. Over-normalising here
    // would silently reassign authorship of every synced file to whoever synced it.
    const { app, pointers } = build();

    await sync(app, [
      { path: "readme.md", content: "r", lastAuthor: "Alice Smith", lastCommitHash: "abc1234" },
    ]);

    expect(pointers.rows[0].lastAuthor).toBe("Alice Smith");
    expect(pointers.rows[0].lastCommitHash).toBe("abc1234");
  });

  it("is case-insensitive, because the sentinel's casing is not a contract", async () => {
    const { app, pointers } = build();
    await sync(app, [{ path: "x.md", content: "x", lastAuthor: "Unknown" }]);
    expect(pointers.rows[0].lastAuthor).toBe("member");
  });

  it("does NOT treat other placeholder-ish names as absent", async () => {
    /**
     * ⚠ THE DELIBERATE LIMIT OF THE GUARD. "n/a", "none" and "anonymous" are plausible real values for
     * a git `user.name`, and silently reassigning authorship of a COMMITTED file is a worse bug than
     * the one being fixed. The list is the one sentinel a previous client actually sent, plus empty.
     */
    const { app, pointers } = build();

    await sync(app, [
      { path: "1.md", content: "1", lastAuthor: "n/a" },
      { path: "2.md", content: "2", lastAuthor: "none" },
      { path: "3.md", content: "3", lastAuthor: "anonymous" },
    ]);

    expect(pointers.rows.map((r) => r.lastAuthor)).toEqual(["n/a", "none", "anonymous"]);
  });
});

/**
 * ── ⚠ REMOVING A FILE: WHAT LEAVES, AND WHAT SURVIVES ──────────────────────────────────────
 *
 * THE REQUIREMENT: users can delete files they uploaded in Build.
 *
 * The assertions that matter are not "it returns 200". They are: the pointer row goes (so the file
 * leaves the team's list AND the release check stops counting it), S3 is told (so the object stops
 * serving), and the ORDER of those two — because only one of the two partial failures is fixable by
 * clicking again.
 */
describe("DELETE /docs — the file leaves the list, the content survives", () => {
  const del = (app: ReturnType<typeof build>["app"], path = "design.md", who = "member") =>
    app.request(`/v1/teams/team-1/docs?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: asUser(who),
    });

  it("drops the pointer row AND tells S3", async () => {
    const store = new FakeStore();
    const pointers = new FakePointers([pointer()]);
    const app = createDocsRoutes({
      store,
      pointers,
      teams,
      membership: new FakeMembership(),
    });

    const res = await del(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "design.md", removed: true });
    // Gone from the list — which is also what stops the release check counting it as an artifact.
    expect(pointers.removedRows).toEqual([{ teamId: "team-1", path: "design.md" }]);
    expect(pointers.rows).toHaveLength(0);
    // ⚠ AND THE S3 KEY, NOT THE PATH. The object lives under workshop/<ws>/team/<team>/<path>; deleting
    // the bare path would silently delete nothing and leave the object serving.
    expect(store.removed).toEqual(["workshop/ws-1/team/team-1/design.md"]);
  });

  it("⚠ 404s an unknown path instead of reporting a cheerful success", async () => {
    // A participant who deleted the wrong thing needs to know their click did nothing; "it worked" on a
    // path that was never there hides a client-side bug.
    const store = new FakeStore();
    const pointers = new FakePointers([pointer()]);
    const app = createDocsRoutes({ store, pointers, teams, membership: new FakeMembership() });

    const res = await del(app, "never-existed.md");

    expect(res.status).toBe(404);
    expect(store.removed).toHaveLength(0);
    expect(pointers.removedRows).toHaveLength(0);
  });

  it("requires a path", async () => {
    const app = createDocsRoutes({
      store: new FakeStore(),
      pointers: new FakePointers([pointer()]),
      teams,
      membership: new FakeMembership(),
    });
    const res = await app.request("/v1/teams/team-1/docs", {
      method: "DELETE",
      headers: asUser("member"),
    });
    expect(res.status).toBe(400);
  });

  it("⚠ refuses a NON-MEMBER before reading anything", async () => {
    // Authorization first, so the difference between 403 and 404 cannot be used to probe which paths a
    // team holds.
    const store = new FakeStore();
    const pointers = new FakePointers([pointer()]);
    const app = createDocsRoutes({ store, pointers, teams, membership: new FakeMembership() });

    const res = await del(app, "design.md", "outsider");

    expect(res.status).toBe(403);
    expect(store.removed).toHaveLength(0);
    expect(pointers.removedRows).toHaveLength(0);
    expect(pointers.rows).toHaveLength(1);
  });

  it("normalises a leading slash, like every other path on this service", async () => {
    const store = new FakeStore();
    const pointers = new FakePointers([pointer()]);
    const app = createDocsRoutes({ store, pointers, teams, membership: new FakeMembership() });

    expect((await del(app, "/design.md")).status).toBe(200);
    expect(pointers.rows).toHaveLength(0);
  });

  it("⚠ tells S3 BEFORE forgetting the row — the recoverable failure order", async () => {
    /**
     * If S3 succeeds and the row delete fails, the file still lists and opening it 404s: ugly, and a
     * second click finishes the job. The reverse leaves an object nobody can see, delete or account for.
     * Between two partial failures, take the one the user can fix by pressing the button again.
     */
    const order: string[] = [];
    const store = new FakeStore();
    store.remove = async (key: string) => {
      order.push(`s3:${key}`);
    };
    const pointers = new FakePointers([pointer()]);
    const realRemove = pointers.remove.bind(pointers);
    pointers.remove = async (teamId: string, path: string) => {
      order.push(`row:${path}`);
      await realRemove(teamId, path);
    };
    const app = createDocsRoutes({ store, pointers, teams, membership: new FakeMembership() });

    await del(app);

    expect(order).toEqual(["s3:workshop/ws-1/team/team-1/design.md", "row:design.md"]);
  });
});
