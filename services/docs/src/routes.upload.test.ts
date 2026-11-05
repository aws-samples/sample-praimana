import { describe, it, expect, beforeAll } from "vitest";
import { createDocsRoutes } from "./routes.js";
import { MAX_UPLOAD_BYTES } from "./upload-policy.js";
import type {
  DocPointer,
  DocPointerRepository,
  DocStore,
  DocVersion,
  PresignedUpload,
  TeamLookup,
} from "./domain.js";
import type { TeamMembership } from "./authz.js";

/**
 * THE TWO-STEP UPLOAD: presign, then confirm.
 *
 * ── WHY IT IS TWO STEPS AND NOT ONE ──
 *
 * A 20MB file cannot pass through the request path at all. API Gateway caps a payload
 * at 10MB, Lambda's synchronous invoke at 6MB, neither adjustable, and JSON-encoding a
 * binary body adds ~33% on top. So the bytes go straight to S3 and the API keeps the
 * decisions: it authorizes membership, and IT — not the client — picks the key, the
 * content type and the byte ceiling, all signed into the URL.
 *
 * What these tests protect, in order of how much damage the absence would do:
 *   1. an EXECUTIVE (read-only) cannot obtain an upload URL at all
 *   2. the key is built from the SERVER's workshop lookup, never from caller input
 *   3. no pointer row is written until S3 confirms the object exists
 *   4. the presigned size and content type are the admitted ones, not the client's
 */

const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(id: string, role = "PARTICIPANT") {
  return {
    "content-type": "application/json",
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": id,
    "x-identity-role": role,
  };
}

/** Records exactly what was presigned, which is the contract under test. */
class FakeStore implements DocStore {
  /** Keys a delete marker was written for, so the test can assert S3 was told. */
  removed: string[] = [];
  async remove(key: string) {
    this.removed.push(key);
  }
  presigned: Array<{ key: string; contentType: string; maxBytes: number; expiresInSeconds: number }> = [];
  objects = new Map<string, { size: number; contentType: string | null; versionId: string | null }>();
  puts: Array<{ key: string; content: string }> = [];

  async put(key: string, content: string) {
    this.puts.push({ key, content });
    return "v-put";
  }
  async get() {
    return null;
  }
  async listVersions(): Promise<DocVersion[]> {
    return [];
  }
  async presignPut(args: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    this.presigned.push(args);
    return {
      url: `https://s3.example/${args.key}?sig=x`,
      headers: { "Content-Type": args.contentType, "Content-Length": String(args.maxBytes) },
      expiresAt: "2026-08-07T12:00:00.000Z",
    };
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
}

class FakePointers implements DocPointerRepository {
  /** Rows forgotten, so the test can assert the file left the list. */
  removedRows: Array<{ teamId: string; path: string }> = [];
  async remove(teamId: string, path: string) {
    this.removedRows.push({ teamId, path });
    this.rows = this.rows.filter((r) => !(r.teamId === teamId && r.path === path));
  }
  rows: DocPointer[] = [];
  async listByTeam(teamId: string) {
    return this.rows.filter((r) => r.teamId === teamId);
  }
  async get(teamId: string, path: string) {
    return this.rows.find((r) => r.teamId === teamId && r.path === path) ?? null;
  }
  async put(p: DocPointer) {
    this.rows = this.rows.filter((r) => !(r.teamId === p.teamId && r.path === p.path));
    this.rows.push(p);
    return p;
  }
}

const teams: TeamLookup = {
  workshopIdForTeam: async (teamId) => (teamId === "team-1" ? "ws-1" : null),
};

/** Member-only, with no role branch — mirrors the real DynamoTeamMembership. */
class FakeMembership implements TeamMembership {
  constructor(private readonly members = new Set(["team-1:member"])) {}
  async isMember(teamId: string, userId: string) {
    return this.members.has(`${teamId}:${userId}`);
  }
}

function build() {
  const store = new FakeStore();
  const pointers = new FakePointers();
  const app = createDocsRoutes({
    store,
    pointers,
    teams,
    membership: new FakeMembership(),
  });
  return { app, store, pointers };
}

const urlFor = (teamId: string) => `/v1/teams/${teamId}/docs/upload-url`;
const completeFor = (teamId: string) => `/v1/teams/${teamId}/docs/upload-complete`;

function post(app: ReturnType<typeof build>["app"], path: string, body: unknown, who = asUser("member")) {
  return app.request(path, { method: "POST", headers: who, body: JSON.stringify(body) });
}

describe("POST /docs/upload-url — authorization first", () => {
  it("a MEMBER gets a presigned URL", async () => {
    const { app } = build();
    const res = await post(app, urlFor("team-1"), { path: "notes.md", sizeBytes: 1000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upload?: { url?: string } };
    expect(body.upload?.url).toContain("https://s3.example/");
  });

  it("a NON-MEMBER gets 403 and nothing is presigned", async () => {
    const { app, store } = build();
    const res = await post(app, urlFor("team-1"), { path: "notes.md", sizeBytes: 1000 }, asUser("outsider"));
    expect(res.status).toBe(403);
    expect(store.presigned).toHaveLength(0);
  });

  it("an EXECUTIVE is refused — read-only roles may browse, never upload", async () => {
    // The most important authorization case here: executives are members with read
    // access, so only the WRITE predicate distinguishes them.
    const { app, store } = build();
    const res = await post(app, urlFor("team-1"), { path: "notes.md", sizeBytes: 1000 }, asUser("member", "EXECUTIVE"));
    expect(res.status).toBe(403);
    expect(store.presigned).toHaveLength(0);
  });

  it("an unknown team is 404, not a presigned URL into a guessed prefix", async () => {
    const { app, store } = build();
    const res = await post(app, urlFor("team-1"), { path: "x.md", sizeBytes: 1 }, asUser("member"));
    // team-1 resolves; assert the negative case explicitly with a different team.
    expect(res.status).toBe(200);
    const res2 = await post(app, urlFor("team-nope"), { path: "x.md", sizeBytes: 1 }, asUser("member"));
    expect([403, 404]).toContain(res2.status);
    expect(store.presigned).toHaveLength(1);
  });

  it("rejects a request with no internal-service token", async () => {
    const { app } = build();
    const res = await app.request(urlFor("team-1"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-identity-id": "member", "x-identity-role": "PARTICIPANT" },
      body: JSON.stringify({ path: "notes.md", sizeBytes: 1 }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("POST /docs/upload-url — the key and the policy are the SERVER's", () => {
  it("builds the key from the server's workshop lookup and the team path param", async () => {
    // If the key came from anything the caller sent, a crafted value would write into
    // another team's prefix. This asserts the shape end to end.
    const { app, store } = build();
    await post(app, urlFor("team-1"), { path: "docs/spec.md", sizeBytes: 500 });
    expect(store.presigned[0].key).toBe("workshop/ws-1/team/team-1/docs/spec.md");
  });

  it("ignores a caller-supplied key, bucket or contentType", async () => {
    const { app, store } = build();
    await post(app, urlFor("team-1"), {
      path: "notes.md",
      sizeBytes: 500,
      key: "workshop/other/team/other/evil.md",
      bucket: "attacker-bucket",
      contentType: "text/html",
    });
    expect(store.presigned[0].key).toBe("workshop/ws-1/team/team-1/notes.md");
    expect(store.presigned[0].contentType).toBe("text/markdown; charset=utf-8");
  });

  it("signs the ADMITTED content type for each allowed extension", async () => {
    const { app, store } = build();
    for (const [path, expected] of [
      ["a.md", "text/markdown; charset=utf-8"],
      ["b.txt", "text/plain; charset=utf-8"],
      ["c.pdf", "application/pdf"],
      ["d.html", "text/html; charset=utf-8"],
    ] as const) {
      await post(app, urlFor("team-1"), { path, sizeBytes: 10 });
      expect(store.presigned.at(-1)!.contentType).toBe(expected);
    }
  });

  it("signs the exact size, so S3 itself enforces the ceiling", async () => {
    const { app, store } = build();
    await post(app, urlFor("team-1"), { path: "big.pdf", sizeBytes: MAX_UPLOAD_BYTES });
    expect(store.presigned[0].maxBytes).toBe(MAX_UPLOAD_BYTES);
  });

  it("the URL is short-lived", async () => {
    const { app, store } = build();
    await post(app, urlFor("team-1"), { path: "notes.md", sizeBytes: 10 });
    expect(store.presigned[0].expiresInSeconds).toBeGreaterThan(0);
    expect(store.presigned[0].expiresInSeconds).toBeLessThanOrEqual(900);
  });

  it.each([
    ["a disallowed type", { path: "payload.exe", sizeBytes: 10 }],
    ["over the size limit", { path: "big.pdf", sizeBytes: MAX_UPLOAD_BYTES + 1 }],
    ["traversal", { path: "../../team/other/x.md", sizeBytes: 10 }],
    ["no path", { sizeBytes: 10 }],
    ["no size", { path: "notes.md" }],
  ])("400s on %s, and presigns nothing", async (_label, body) => {
    const { app, store } = build();
    const res = await post(app, urlFor("team-1"), body);
    expect(res.status).toBe(400);
    expect(store.presigned).toHaveLength(0);
  });

  it("writes NO pointer row — the file does not exist yet", async () => {
    // A row here would make the list endpoint advertise a document that 404s on read.
    const { app, pointers } = build();
    await post(app, urlFor("team-1"), { path: "notes.md", sizeBytes: 10 });
    expect(pointers.rows).toHaveLength(0);
  });
});

describe("POST /docs/upload-complete — verifies, does not trust", () => {
  const KEY = "workshop/ws-1/team/team-1/notes.md";

  it("records the pointer once S3 holds the object", async () => {
    const { app, store, pointers } = build();
    store.objects.set(KEY, { size: 1234, contentType: "text/markdown", versionId: "v1" });

    const res = await post(app, completeFor("team-1"), { path: "notes.md" });

    expect(res.status).toBe(201);
    expect(pointers.rows).toHaveLength(1);
    expect(pointers.rows[0]).toMatchObject({
      teamId: "team-1",
      path: "notes.md",
      workshopId: "ws-1",
      s3Key: KEY,
      versionId: "v1",
      // An uploaded file has no commit behind it; claiming one would be a lie.
      lastCommitHash: null,
      lastAuthor: "member",
    });
  });

  it("404s when the object is NOT there — no phantom row", async () => {
    const { app, pointers } = build();
    const res = await post(app, completeFor("team-1"), { path: "never-uploaded.md" });
    expect(res.status).toBe(404);
    expect(pointers.rows).toHaveLength(0);
  });

  it("refuses an object whose STORED size exceeds the ceiling", async () => {
    // Defence in depth: the presign bounds it, and this re-checks what actually landed.
    const { app, store, pointers } = build();
    store.objects.set(KEY, { size: MAX_UPLOAD_BYTES + 1, contentType: "text/markdown", versionId: "v1" });
    const res = await post(app, completeFor("team-1"), { path: "notes.md" });
    expect(res.status).toBe(400);
    expect(pointers.rows).toHaveLength(0);
  });

  it("is IDEMPOTENT — a retried confirm leaves one row", async () => {
    // This is the hop most likely to be lost after a slow upload, so it will be retried.
    const { app, store, pointers } = build();
    store.objects.set(KEY, { size: 10, contentType: "text/markdown", versionId: "v1" });
    await post(app, completeFor("team-1"), { path: "notes.md" });
    await post(app, completeFor("team-1"), { path: "notes.md" });
    expect(pointers.rows).toHaveLength(1);
  });

  it("re-applies the path and type policy", async () => {
    const { app, pointers } = build();
    for (const path of ["../../team/other/x.md", "payload.exe"]) {
      const res = await post(app, completeFor("team-1"), { path });
      expect(res.status).toBe(400);
    }
    expect(pointers.rows).toHaveLength(0);
  });

  it("an EXECUTIVE cannot confirm an upload either", async () => {
    const { app, store, pointers } = build();
    store.objects.set(KEY, { size: 10, contentType: "text/markdown", versionId: "v1" });
    const res = await post(app, completeFor("team-1"), { path: "notes.md" }, asUser("member", "EXECUTIVE"));
    expect(res.status).toBe(403);
    expect(pointers.rows).toHaveLength(0);
  });
});

describe("the git-sync ingest is now bounded", () => {
  it("refuses a batch over the file-count limit and stores nothing", async () => {
    const { app, store } = build();
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, content: "x" }));
    const res = await post(app, "/v1/teams/team-1/docs", { files });
    expect(res.status).toBe(400);
    expect(store.puts).toHaveLength(0);
  });

  it("accepts the limit exactly", async () => {
    const { app, store } = build();
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.md`, content: "x" }));
    const res = await post(app, "/v1/teams/team-1/docs", { files });
    expect(res.status).toBe(201);
    expect(store.puts).toHaveLength(200);
  });

  it("SKIPS an oversized file and reports it, rather than failing the whole sync", async () => {
    // One huge generated file must not block the rest of a team's documentation, but
    // the omission has to be visible rather than silent.
    const { app, store } = build();
    const res = await post(app, "/v1/teams/team-1/docs", {
      files: [
        { path: "ok.md", content: "small" },
        { path: "huge.md", content: "x".repeat(1024 * 1024 + 1) },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { stored: number; skipped: Array<{ path: string }> };
    expect(body.stored).toBe(1);
    expect(body.skipped.map((s) => s.path)).toEqual(["huge.md"]);
    expect(store.puts.map((p) => p.key)).toEqual(["workshop/ws-1/team/team-1/ok.md"]);
  });

  /**
   * ── ⚠ THE INGEST ROUTE APPLIES THE PATH POLICY TOO ───────────────────────────────────────────
   *
   * It applied NOTHING. `f.path` went into `s3Key()` — leading slashes stripped, nothing else — then
   * into S3 verbatim, and was persisted as the pointer row's range key. The two presign routes in the
   * same file, behind the same `requireTeamWrite` guard, both called `admitUpload`; this one did not,
   * so an ACTIVE team member could write keys with `..` segments, backslashes, control characters and
   * unbounded length.
   *
   * ⚠ `admitPath`, NOT `admitUpload`: this route legitimately carries repository source files (these
   * pointer rows become the release snapshot's artifact manifest, which contains `src/*.ts`), so the
   * four-extension allowlist must NOT apply here. The extension test below pins that distinction so a
   * future "tidy-up" cannot close the hole by breaking the feature.
   */
  describe("git-sync ingest applies the path admission policy", () => {
    const REFUSED_PATHS: Array<[label: string, path: string]> = [
      ["traversal", "../../team/other/x.md"],
      ["traversal mid-path", "docs/../../../other/x.md"],
      ["a backslash separator", "docs\\notes.md"],
      ["a NUL byte", "docs/no\u0000te.md"],
      ["a control character", "docs/note\u001f.md"],
      ["an over-long path", `${"a".repeat(1025)}.md`],
      ["an empty segment", "docs//notes.md"],
      ["a '.' segment", "docs/./notes.md"],
    ];

    it.each(REFUSED_PATHS)("SKIPS %s and writes nothing for it", async (_label, path) => {
      const { app, store, pointers } = build();

      const res = await post(app, "/v1/teams/team-1/docs", {
        files: [{ path, content: "payload" }],
      });

      // A malformed path is SKIPPED WITH A REASON, not fatal — one bad path must not stop the rest of
      // a team's sync, and the omission is reported rather than silent.
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        stored: number;
        skipped: Array<{ path: string; reason: string }>;
      };
      expect(body.stored).toBe(0);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].reason).toBeTruthy();
      // The half that matters: nothing reached S3 and nothing reached the pointer table.
      expect(store.puts).toEqual([]);
      expect(pointers.rows).toEqual([]);
    });

    it("keeps syncing the GOOD files in a batch that also contains a bad path", async () => {
      const { app, store } = build();

      const res = await post(app, "/v1/teams/team-1/docs", {
        files: [
          { path: "README.md", content: "a" },
          { path: "../../team/other/steal.md", content: "b" },
          { path: "docs/design.md", content: "c" },
        ],
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { stored: number; skipped: Array<{ path: string }> };
      expect(body.stored).toBe(2);
      expect(body.skipped.map((s) => s.path)).toEqual(["../../team/other/steal.md"]);
      expect(store.puts.map((p) => p.key)).toEqual([
        "workshop/ws-1/team/team-1/README.md",
        "workshop/ws-1/team/team-1/docs/design.md",
      ]);
    });

    it("⚠ still syncs NON-MARKDOWN repository files — the extension allowlist must not apply here", async () => {
      /**
       * THE REGRESSION THIS GUARDS, and the reason `admitPath` exists separately from `admitUpload`.
       * These pointer rows are what `evaluation` reads to build the release snapshot's artifact
       * manifest, and a team's manifest legitimately contains source files. Routing this loop through
       * `admitUpload` would have closed the traversal hole by silently dropping every `.ts`, `.json`
       * and extensionless file a team synced.
       */
      const { app, store } = build();

      const res = await post(app, "/v1/teams/team-1/docs", {
        files: [
          { path: "src/app.ts", content: "export const a = 1;" },
          { path: "package.json", content: "{}" },
          { path: "Dockerfile", content: "FROM node" },
          { path: "docs/notes.md", content: "# hi" },
        ],
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { stored: number; skipped: unknown[] };
      expect(body.stored).toBe(4);
      expect(body.skipped).toEqual([]);
      expect(store.puts.map((p) => p.key)).toEqual([
        "workshop/ws-1/team/team-1/src/app.ts",
        "workshop/ws-1/team/team-1/package.json",
        "workshop/ws-1/team/team-1/Dockerfile",
        "workshop/ws-1/team/team-1/docs/notes.md",
      ]);
    });

    it("stores the NORMALISED path in S3, the pointer row and the response", async () => {
      // The check has to apply to the same string that gets stored, or it was decorative. A leading
      // slash is the one normalisation `s3Key` always did, so it is the one worth pinning.
      const { app, store, pointers } = build();

      const res = await post(app, "/v1/teams/team-1/docs", {
        files: [{ path: "/docs/notes.md", content: "x" }],
      });

      const body = (await res.json()) as { paths: string[] };
      expect(body.paths).toEqual(["docs/notes.md"]);
      expect(store.puts.map((p) => p.key)).toEqual(["workshop/ws-1/team/team-1/docs/notes.md"]);
      expect(pointers.rows.map((r) => r.path)).toEqual(["docs/notes.md"]);
    });
  });
});
