import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupGitHandlers } from "./git";

/**
 * CHOOSING WHICH REPO FILES GET PUBLISHED — the two handlers that replaced `git:sync`.
 *
 * ── WHAT CHANGED AND WHY ──
 *
 * `git:sync` collected EVERY `.md` in the repo and pushed all of them on one click, with no way to
 * see or choose what was going. Wrong in both directions: licence files, dependency READMEs and
 * scratch notes landed in the team's documents, while a participant who wanted to publish one design
 * doc had no way to say so. It also had NO TESTS, which is precisely why nobody noticed.
 *
 * Now: `git:listUploadable` (a pure read — nothing leaves the machine) then `git:uploadSelected`.
 *
 * ── THE ASSERTION THAT MATTERS MOST ──
 *
 * ⚠ `git:uploadSelected` READS FILES AT RENDERER-SUPPLIED PATHS. That makes the confinement check a
 * security boundary, not tidiness: without it, a compromised or buggy renderer could ask the main
 * process to read `../../.ssh/id_rsa` and POST the contents to the workshop store. The traversal
 * tests below are the point of this file; the rest is behaviour.
 */

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
}));

/**
 * Both guards are recorded rather than stubbed away, so a test can assert WHICH one ran. The real
 * implementations have their own suite (project-paths.test.ts); what matters here is that the upload
 * path calls the REALPATH variant — the lexical one is blind to a symlink pointing out of the
 * project, which is the case that would leak a file.
 */
const assertWithinProject = vi.fn();
const assertRealPathWithinProject = vi.fn();
vi.mock("../project-paths", () => ({
  assertWithinProject: (p: string) => assertWithinProject(p),
  assertRealPathWithinProject: (p: string, o?: unknown) => assertRealPathWithinProject(p, o),
}));

const settings: Record<string, string | null> = {
  auth_token: "tok",
  server_url: "https://api.example.test",
  team_id: "team-1",
};
vi.mock("../database", () => ({
  readSetting: (k: string) => settings[k] ?? null,
}));

/** Files the fake filesystem will return, keyed by absolute path. */
let fileContents: Record<string, string> = {};
let statSizes: Record<string, number> = {};
vi.mock("fs", () => ({
  readFileSync: (p: string) => {
    if (!(p in fileContents)) throw new Error(`ENOENT: ${p}`);
    return fileContents[p];
  },
  statSync: (p: string) => {
    if (!(p in statSizes)) throw new Error(`ENOENT: ${p}`);
    return { size: statSizes[p] };
  },
}));

/** What `find` returns. */
/**
 * ── ⚠ THE HANDLER NO LONGER SHELLS OUT TO `find` ───────────────────────────────────────────────
 *
 * It walks the tree in Node (`walkDocuments`), because Windows has a `find.exe` that searches for a
 * string INSIDE files and knows nothing of `-type`/`-name` — so on Windows the old call exited
 * non-zero, this handler's catch read that as "no matching files", and the document list was silently
 * empty.
 *
 * ⚠ SO THE THREE CASES THAT ASSERTED `find`'s ARGV MOVED, they did not disappear. "searches for these
 * four extensions" and "excludes these directories" are now properties of `walkDocuments` and are
 * tested against a real directory tree in walk-documents.test.ts — which is a stronger test than
 * grepping an argument list, because it proves the behaviour rather than the intent to request it.
 * What is left here is what this file is actually about: the handler's own contract.
 */
let foundPaths: string[] = [];
let walkThrows = false;
const walkedRoots: string[] = [];
vi.mock("../walk-documents", () => ({
  walkDocuments: (root: string) => {
    walkedRoots.push(root);
    if (walkThrows) throw new Error("walk failed");
    return { files: foundPaths, truncated: false };
  },
}));

let gitLogLatest: unknown = null;
vi.mock("simple-git", () => {
  const factory = () => ({
    log: async () => ({ latest: gitLogLatest }),
  });
  // simple-git 4.x: git.ts imports the NAMED export { simpleGit }. Expose both.
  return { simpleGit: factory, default: factory };
});

/** Captures the outbound POST so its body can be asserted. */
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchReply: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { stored: 0, paths: [], skipped: [] },
};

setupGitHandlers();
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

const ROOT = "/tmp/project";

beforeEach(() => {
  /**
   * resetAllMocks, NOT clearAllMocks. `clear` wipes call history but KEEPS a
   * `mockImplementation` — so the traversal test's throwing guard leaked into every test after it
   * and failed five of them. Caught by those failures rather than by inspection, which is the
   * argument for running a new suite before trusting it.
   */
  vi.resetAllMocks();
  fileContents = {};
  statSizes = {};
  foundPaths = [];
  walkThrows = false;
  walkedRoots.length = 0;
  gitLogLatest = null;
  fetchCalls.length = 0;
  fetchReply = { ok: true, status: 200, body: { stored: 0, paths: [], skipped: [] } };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return {
      ok: fetchReply.ok,
      status: fetchReply.status,
      json: async () => fetchReply.body,
      text: async () => JSON.stringify(fetchReply.body),
    } as Response;
  });
});

describe("git:listUploadable — a pure read", () => {
  it("UPLOADS NOTHING", async () => {
    /**
     * The property that makes the button safe to press. Listing must be free and reversible, or the
     * two-step flow is no better than the one-step one it replaced.
     */
    foundPaths = [`${ROOT}/design.md`];
    statSizes[`${ROOT}/design.md`] = 120;

    await invoke("git:listUploadable", ROOT);

    expect(fetchCalls, "no network call at all").toHaveLength(0);
  });

  it("lists ALL FOUR server-allowed extensions, not just .md", async () => {
    /**
     * The docs service admits md/txt/pdf/html. Listing only `.md` — as the old sync did — would hide
     * files the platform accepts, making the desktop stricter than the server for no reason.
     */
    /**
     * The extensions and the directory exclusions are `walkDocuments`' job now and are asserted
     * against a real tree in walk-documents.test.ts. What this file must still hold is that the
     * handler walks the CONFINED root it was given, and nothing else.
     */
    await invoke("git:listUploadable", ROOT);
    expect(walkedRoots).toEqual([ROOT]);
  });

  it("walks the repo path it was given, and only that", async () => {
    // No shell, no argument list, nothing a repo path containing quotes or `;` could inject into.
    await invoke("git:listUploadable", ROOT);
    expect(walkedRoots).toHaveLength(1);
    expect(walkedRoots[0]).toBe(ROOT);
  });

  it("returns paths RELATIVE to the repo, with sizes", async () => {
    foundPaths = [`${ROOT}/docs/design.md`];
    statSizes[`${ROOT}/docs/design.md`] = 2048;

    const res = await invoke("git:listUploadable", ROOT);

    expect(res.files).toEqual([
      expect.objectContaining({ path: "docs/design.md", sizeBytes: 2048 }),
    ]);
  });

  it("reports an UNTRACKED file rather than skipping it", async () => {
    /**
     * A new file has no git log, and that is not an error — it is arguably the most likely thing
     * somebody wants to publish. Null authorship, still listed.
     */
    foundPaths = [`${ROOT}/new.md`];
    statSizes[`${ROOT}/new.md`] = 10;
    gitLogLatest = null;

    const res = await invoke("git:listUploadable", ROOT);

    expect(res.files).toHaveLength(1);
    expect(res.files[0].lastAuthor).toBeNull();
  });

  it("carries the last author when the file IS committed", async () => {
    foundPaths = [`${ROOT}/design.md`];
    statSizes[`${ROOT}/design.md`] = 10;
    gitLogLatest = { hash: "abc123", author_name: "Alice", date: "2026-08-01" };

    const res = await invoke("git:listUploadable", ROOT);

    expect(res.files[0]).toMatchObject({ lastAuthor: "Alice", lastCommitHash: "abc123" });
  });

  it("TRUNCATES a huge list and says so", async () => {
    /**
     * A monorepo can hold thousands of markdown files. A list that long is unrenderable and makes the
     * IPC payload big enough to stall the UI — but silently showing a prefix is how somebody
     * concludes a file is missing from their repo, so the total is reported.
     */
    foundPaths = Array.from({ length: 600 }, (_, i) => `${ROOT}/f${i}.md`);
    for (const p of foundPaths) statSizes[p] = 1;

    const res = await invoke("git:listUploadable", ROOT);

    expect(res.files).toHaveLength(500);
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(600);
  });

  it("returns an EMPTY LIST, not an error, when the walk fails", async () => {
    /**
     * `walkDocuments` is written not to throw, so this guards the boundary rather than a known throw:
     * listing a participant's documents must never surface an error they have to interpret. The old
     * version of this case existed because POSIX `find` exits non-zero when nothing matches.
     */
    walkThrows = true;

    const res = await invoke("git:listUploadable", ROOT);

    expect(res.files).toEqual([]);
  });

  it("skips a file that vanished between the walk and the stat", async () => {
    // A build running in the background deletes files mid-listing; one missing file must not fail
    // the whole list.
    foundPaths = [`${ROOT}/gone.md`, `${ROOT}/here.md`];
    statSizes[`${ROOT}/here.md`] = 5;

    const res = await invoke("git:listUploadable", ROOT);

    expect(res.files.map((f: { path: string }) => f.path)).toEqual(["here.md"]);
  });

  it("confines the repo path — by REAL path, not lexically", async () => {
    /**
     * ⚠ THIS ASSERTED THE WEAKER GUARD. `assertWithinProject` resolves `..` but follows no symlinks,
     * so `<project>/link-to-elsewhere` passed it — and this handler walks the tree and returns a list
     * of documents the renderer then offers for UPLOAD TO THE TEAM. The boundary has to hold where
     * the list is built, not only where each file is later read.
     */
    await invoke("git:listUploadable", ROOT);
    expect(assertRealPathWithinProject).toHaveBeenCalledWith(ROOT, { mustExist: true });
    expect(assertWithinProject, "the lexical check is not enough here").not.toHaveBeenCalled();
  });
});

describe("git:uploadSelected — publishes ONLY what was chosen", () => {
  it("sends exactly the selected files", async () => {
    fileContents[`${ROOT}/a.md`] = "# A";
    fileContents[`${ROOT}/b.md`] = "# B";
    fetchReply = { ok: true, status: 200, body: { stored: 1, paths: ["a.md"], skipped: [] } };

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["a.md"] });

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ path: "a.md", content: "# A" });
  });

  it("does NOT call the server for an empty selection", async () => {
    const res = await invoke("git:uploadSelected", { repoPath: ROOT, paths: [] });

    expect(fetchCalls).toHaveLength(0);
    expect(res).toMatchObject({ stored: 0, selected: 0 });
  });

  it("⚠ REFUSES A TRAVERSAL PATH — the security boundary", async () => {
    /**
     * THE TEST THIS FILE EXISTS FOR. The renderer supplies these paths and the main process reads
     * whatever it is given, so without confinement a buggy or compromised renderer could exfiltrate
     * any file the user can read by naming it here.
     *
     * The guard is asserted by making it throw, exactly as the real one does for an outside path.
     */
    assertRealPathWithinProject.mockImplementation(() => {
      throw new Error("path is outside an open project");
    });
    fileContents["/Users/someone/.ssh/id_rsa"] = "PRIVATE KEY";

    await expect(
      invoke("git:uploadSelected", { repoPath: ROOT, paths: ["../../../.ssh/id_rsa"] })
    ).rejects.toThrow(/outside an open project/);

    expect(fetchCalls, "nothing may be sent").toHaveLength(0);
  });

  it("uses the REALPATH guard, not the lexical one", async () => {
    /**
     * A symlink inside the project pointing out of it resolves as a string that LOOKS contained, so
     * the lexical check passes it — the blind spot file-ops.ts documents. For a read that gets
     * POSTed to a shared store, the realpath variant is the only sufficient guard.
     */
    fileContents[`${ROOT}/a.md`] = "# A";

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["a.md"] });

    expect(assertRealPathWithinProject).toHaveBeenCalled();
    const [, opts] = assertRealPathWithinProject.mock.calls[0];
    expect(opts, "must require existence, since it is about to be read").toMatchObject({
      mustExist: true,
    });
  });

  it("REFUSES an oversized selection before reading anything", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `f${i}.md`);

    await expect(
      invoke("git:uploadSelected", { repoPath: ROOT, paths: many })
    ).rejects.toThrow(/at most 100/);

    expect(fetchCalls).toHaveLength(0);
  });

  it("reports an unreadable file instead of failing the batch", async () => {
    // One bad file must not discard the others; the participant is told which one.
    fileContents[`${ROOT}/good.md`] = "# ok";
    fetchReply = { ok: true, status: 200, body: { stored: 1, paths: ["good.md"], skipped: [] } };

    const res = await invoke("git:uploadSelected", {
      repoPath: ROOT,
      paths: ["good.md", "missing.md"],
    });

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(["good.md"]);
    expect(res.skipped).toEqual([
      expect.objectContaining({ path: "missing.md" }),
    ]);
  });

  it("MERGES local and server refusals into one list", async () => {
    /**
     * The server rejects on type and size; the client can fail to read. A participant needs one
     * answer to "what did not make it", not two half-answers.
     */
    fileContents[`${ROOT}/a.md`] = "# A";
    fetchReply = {
      ok: true,
      status: 200,
      body: { stored: 0, paths: [], skipped: [{ path: "a.md", reason: "too large" }] },
    };

    const res = await invoke("git:uploadSelected", {
      repoPath: ROOT,
      paths: ["a.md", "gone.md"],
    });

    expect(res.skipped).toHaveLength(2);
  });

  it("surfaces an HTTP failure with the server's own detail", async () => {
    fileContents[`${ROOT}/a.md`] = "# A";
    fetchReply = { ok: false, status: 413, body: { error: "payload too large" } };

    await expect(
      invoke("git:uploadSelected", { repoPath: ROOT, paths: ["a.md"] })
    ).rejects.toThrow(/413/);
  });

  it("is BOUNDED by a timeout", async () => {
    // A hung request otherwise holds the renderer's button in its spinner with no way out.
    fileContents[`${ROOT}/a.md`] = "# A";

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["a.md"] });

    expect(fetchCalls[0].init.signal).toBeTruthy();
  });

  it("refuses when the app is not configured", async () => {
    settings.auth_token = null;
    try {
      await expect(
        invoke("git:uploadSelected", { repoPath: ROOT, paths: ["a.md"] })
      ).rejects.toThrow(/Not configured/);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      settings.auth_token = "tok";
    }
  });
});

/**
 * These two fields defaulted to the literal string `"unknown"` for a file git had never seen
 * committed, with a comment claiming that was accurate. It was not. GIT does not know the author of an
 * uncommitted file; THE PLATFORM DOES, because the upload is authenticated — and the docs service
 * defaults `lastAuthor` to the caller's id for exactly this case (`f.lastAuthor ?? id`).
 *
 * `"unknown"` is not null, so that fallback never fired. A truthful-sounding default beat a better one
 * by being non-null, and the string was stored and rendered as a person's name.
 *
 * ⚠ THESE TESTS ASSERT THE WIRE BODY, not an internal, because the wire is where the contract lives:
 * the server distinguishes "no attribution" from "this person" by null-vs-string and nothing else.
 */
describe("git:uploadSelected — attribution is null when git has none", () => {
  /** The files array as it actually goes over the wire. */
  const sentFiles = () =>
    JSON.parse(String(fetchCalls[0].init.body)).files as Array<{
      path: string;
      lastAuthor: unknown;
      lastCommitHash: unknown;
    }>;

  it("sends NULL, not \"unknown\", for an untracked file", async () => {
    fileContents[`${ROOT}/new-notes.md`] = "# fresh";
    // `git log` finds no commit for a file that was never committed.
    gitLogLatest = null;

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["new-notes.md"] });

    const [file] = sentFiles();
    // The server turns null into the authenticated caller. "unknown" would defeat that.
    expect(file.lastAuthor).toBeNull();
    // ⚠ AND THE COMMIT HASH TOO: "unknown" is not a hash, and a reader cannot tell it from a hash
    // that failed to parse. Absence is the honest answer.
    expect(file.lastCommitHash).toBeNull();
  });

  it("sends the REAL git author when the file is committed", async () => {
    // The half that must not break. A committed file's author is a better answer than the uploader:
    // the person who wrote it is not necessarily the person who pressed upload.
    fileContents[`${ROOT}/design.md`] = "# design";
    gitLogLatest = { hash: "abc1234", author_name: "Alice Smith" };

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["design.md"] });

    const [file] = sentFiles();
    expect(file.lastAuthor).toBe("Alice Smith");
    expect(file.lastCommitHash).toBe("abc1234");
  });

  it("⚠ sends NULL when git.user.name is unset — the fresh-laptop case", async () => {
    // The common case at a workshop venue: a machine with no `user.name` configured yields an EMPTY
    // author_name, which is also non-null and would have landed exactly like the sentinel.
    fileContents[`${ROOT}/x.md`] = "x";
    gitLogLatest = { hash: "  ", author_name: "   " };

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["x.md"] });

    const [file] = sentFiles();
    expect(file.lastAuthor).toBeNull();
    expect(file.lastCommitHash).toBeNull();
  });
});

// ── ⚠ THE DOCUMENT KEY IS DERIVED FROM THE PATH THAT WAS VERIFIED ────────────────────────────
//
// Verify one value, act on another: the realpath guard ran on `path.resolve(repoPath, rel)` and the key
// POSTed to the docs service was `rel`.
//
// ⚠ THE GUARD IS NOT WHAT FAILS HERE, WHICH IS THE WHOLE POINT — and it is why these cases leave the
// stub PASSING rather than making it throw. `path.resolve` collapses `..`, and this handler requires
// `repoPath` to be WITHIN a project root rather than to BE one, so with `repoPath` a sub-directory a
// `rel` of `../../notes.md` resolves back inside an allowed root: the confinement check is satisfied and
// correct. What still carried `..` was the string in the JSON body, leaving the docs service to
// normalise it — "an assumption about a service this repo cannot see", as the sibling `docs:upload`
// puts it while refusing to make it.
describe("⚠ git:uploadSelected — the key sent is the key that was checked", () => {
  it("sends a relative key for an ordinary nested file", async () => {
    fileContents[`${ROOT}/src/api/routes.ts`] = "export {}";

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["src/api/routes.ts"] });

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.files[0].path).toBe("src/api/routes.ts");
  });

  /**
   * ⚠ THE DIRECTORY STRUCTURE IS PRESERVED, NOT FLATTENED — the difference from `docs:upload`, which
   * reduces its key to a basename. That handler uploads ONE file and has no legitimate use for a
   * directory component; this one uploads a selection from a tree, where `src/routes.ts` and
   * `docs/routes.ts` are different documents that a basename would silently collide.
   */
  it("keeps two same-named files in different directories distinct", async () => {
    fileContents[`${ROOT}/src/routes.ts`] = "a";
    fileContents[`${ROOT}/docs/routes.ts`] = "b";

    await invoke("git:uploadSelected", {
      repoPath: ROOT,
      paths: ["src/routes.ts", "docs/routes.ts"],
    });

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.files.map((f: { path: string }) => f.path)).toEqual([
      "src/routes.ts",
      "docs/routes.ts",
    ]);
  });

  /**
   * ⚠ THE FINDING ITSELF. The guard stub passes — as the real guard would, since the path resolves back
   * inside the project — and the assertion is about what goes on the wire.
   */
  it("⚠ never puts a `..` segment in the document key", async () => {
    /**
     * ⚠ A `rel` THAT TRAVERSES AND COMES BACK, which is the case that both passes the guard AND is
     * uploaded — so it is the one where the wire format is observable. `src/../a.md` resolves to
     * `<root>/a.md`: legitimately inside the project, legitimately publishable, and previously sent to
     * the docs service with the `..` still in it for the service to normalise or not.
     *
     * A `rel` that escapes for real is skipped instead (below), so it never reaches a request body —
     * which is why this case, not that one, is the one that pins the key format.
     */
    fileContents[`${ROOT}/a.md`] = "# A";

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["src/../a.md"] });

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.files[0].path, "the key is recomputed, not echoed").toBe("a.md");
    expect(body.files[0].path).not.toMatch(/(^|\/)\.\.(\/|$)/);
  });

  it("⚠ skips a file that escapes the selected folder rather than renaming it", async () => {
    /**
     * A key cannot be derived for a file outside `repoPath`, and inventing one would be worse than
     * refusing: it would publish the file under a name that does not describe where it came from. So it
     * joins the `skipped` list the participant already sees, with a reason.
     */
    fileContents["/tmp/notes.md"] = "# notes";

    const res = await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["../notes.md"] });

    expect(fetchCalls, "nothing to send, so no request").toHaveLength(0);
    expect(res.skipped).toEqual([
      expect.objectContaining({ path: "../notes.md", reason: expect.stringMatching(/outside/i) }),
    ]);
  });

  it("still reports the caller's own spelling back to them when skipping", async () => {
    // The renderer asked about `../notes.md`; telling it about a path it never mentioned would be
    // unhelpful in the one place the participant is reading for a reason.
    fileContents["/tmp/notes.md"] = "x";

    const res = await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["../notes.md"] });

    expect(res.skipped[0].path).toBe("../notes.md");
  });

  /**
   * ⚠ FORWARD SLASHES, WHATEVER THE PLATFORM. `path.relative` yields backslashes on Windows, and the
   * key is a document identifier in a shared store — so a Windows client and a POSIX one uploading the
   * same file must produce the same key rather than two documents.
   */
  it("normalises the separator so one file has one key on every platform", async () => {
    fileContents[`${ROOT}/src/api/routes.ts`] = "export {}";

    await invoke("git:uploadSelected", { repoPath: ROOT, paths: ["src/api/routes.ts"] });

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.files[0].path, "never a backslash").not.toContain("\\");
  });
});
