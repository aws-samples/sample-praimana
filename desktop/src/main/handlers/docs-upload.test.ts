import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * THE UPLOAD ORCHESTRATION — three hops, all in main, in the right order.
 *
 * ── WHY THE SEQUENCE LIVES IN MAIN AND IS TESTED HERE ──
 *
 * `docs:upload` performs presign → PUT → confirm as ONE ipc call. The renderer never
 * sees the presigned URL, for two reasons that are both easy to get wrong later:
 *
 *   1. that URL grants a write to the team's S3 prefix, and the renderer is the
 *      compromisable process (its bundle carries a whole npm dependency tree);
 *   2. a renderer-driven sequence that died between PUT and confirm would leave an
 *      object in the bucket with NO pointer row — a file nobody can list or read, and
 *      nothing would ever reconcile it.
 *
 * So these tests assert the ordering and the failure behaviour, not just the happy path.
 */

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
  app: { getPath: () => "/tmp", setBadgeCount: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("ws", () => ({ default: class {} }));

const settings = new Map<string, string>([
  ["server_url", "https://api.example"],
  ["team_id", "team-1"],
  ["auth_token", "tok"],
]);

vi.mock("../database", () => ({
  getDb: () => ({ prepare: () => ({ run: vi.fn(), get: () => undefined, all: () => [] }) }),
  readSetting: (k: string) => settings.get(k) ?? null,
  writeSetting: vi.fn(),
}));

// fetchAuthed just injects a token in the real thing; here it hands one over so the
// handler's own request-building is what gets exercised.
vi.mock("./ai", () => ({
  fetchAuthed: (build: (token: string) => Promise<Response>) => build("tok"),
}));

const files = new Map<string, { size: number; isFile: boolean; body: Buffer }>();

vi.mock("fs/promises", () => ({
  stat: async (p: string) => {
    const f = files.get(p);
    if (!f) throw new Error("ENOENT");
    return { size: f.size, isFile: () => f.isFile };
  },
  readFile: async (p: string) => files.get(p)!.body,
}));

import { setupTeamDataHandlers } from "./team-data";
import { recordPickedUpload, __resetPickedUploads } from "../picked-uploads";
setupTeamDataHandlers();

const upload = (params: unknown) => handlers.get("docs:upload")!({}, params);

/**
 * `docs:upload` now refuses any path the native upload picker did not return, because it reads
 * the file and PUTs it to the team's shared store. These tests are about the ORCHESTRATION, so
 * they establish the precondition the real flow establishes — `files:selectUpload` recorded the
 * pick — and the refusal itself is asserted in its own block at the bottom.
 */
function pick(...paths: string[]) {
  for (const p of paths) recordPickedUpload(p);
}

/** Every fetch, in order, so the SEQUENCE can be asserted. */
let requests: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
let responder: (url: string, init?: any) => Response;

beforeEach(() => {
  requests = [];
  files.clear();
  files.set("/tmp/notes.md", { size: 100, isFile: true, body: Buffer.from("# hi") });
  __resetPickedUploads();
  // Every path these tests upload, as if the user had picked it. Listed explicitly rather than
  // blanket-allowed so the provenance check stays a real gate in this file too.
  pick(
    "/tmp/notes.md",
    "/Users/someone/deep/dir/report.pdf",
    "/tmp/big.pdf",
    "/tmp/exact.pdf",
    "/tmp/empty.md",
    "/tmp/adir",
    "/tmp/does-not-exist.md"
  );
  responder = (url) => {
    if (url.includes("upload-url")) {
      return new Response(
        JSON.stringify({ upload: { url: "https://praimana.s3.us-east-1.amazonaws.com/workshops/w1/teams/t1/notes.md?X-Amz-Signature=x", headers: { "Content-Type": "text/markdown", "Content-Length": "100" } } }),
        { status: 200 }
      );
    }
    if (url.includes("upload-complete")) {
      return new Response(JSON.stringify({ versionId: "v1" }), { status: 201 });
    }
    return new Response("", { status: 200 });
  };
  vi.stubGlobal("fetch", (url: string, init?: any) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers });
    return Promise.resolve(responder(String(url), init));
  });
});

describe("docs:upload — the happy path, in order", () => {
  it("presigns, PUTs to S3, then confirms", async () => {
    const res = await upload({ filePath: "/tmp/notes.md" });

    expect(res).toMatchObject({ ok: true, path: "notes.md", sizeBytes: 100, versionId: "v1" });
    expect(requests).toHaveLength(3);
    expect(requests[0].url).toContain("/docs/upload-url");
    expect(requests[1].url).toBe("https://praimana.s3.us-east-1.amazonaws.com/workshops/w1/teams/t1/notes.md?X-Amz-Signature=x");
    expect(requests[1].method).toBe("PUT");
    expect(requests[2].url).toContain("/docs/upload-complete");
  });

  it("stores under the BASENAME, so a local absolute path cannot shape the doc tree", async () => {
    // /Users/someone/secrets/../notes.md must become "notes.md" — the team's document
    // tree is not a mirror of anyone's filesystem.
    files.set("/Users/someone/deep/dir/report.pdf", { size: 10, isFile: true, body: Buffer.from("x") });
    const res = await upload({ filePath: "/Users/someone/deep/dir/report.pdf" });
    expect(res.path).toBe("report.pdf");
  });
});

describe("docs:upload — refusals happen BEFORE any network call", () => {
  it("refuses a file over 20MB without asking the server", async () => {
    files.set("/tmp/big.pdf", { size: 20 * 1024 * 1024 + 1, isFile: true, body: Buffer.alloc(0) });
    const res = await upload({ filePath: "/tmp/big.pdf" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/limit is 20MB/);
    expect(requests).toHaveLength(0);
  });

  it("accepts EXACTLY 20MB", async () => {
    files.set("/tmp/exact.pdf", {
      size: 20 * 1024 * 1024,
      isFile: true,
      body: Buffer.from("x"),
    });
    const res = await upload({ filePath: "/tmp/exact.pdf" });
    expect(res.ok).toBe(true);
  });

  it("refuses an empty file", async () => {
    files.set("/tmp/empty.md", { size: 0, isFile: true, body: Buffer.alloc(0) });
    const res = await upload({ filePath: "/tmp/empty.md" });
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("refuses a directory", async () => {
    files.set("/tmp/adir", { size: 4096, isFile: false, body: Buffer.alloc(0) });
    const res = await upload({ filePath: "/tmp/adir" });
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("refuses an unreadable path", async () => {
    const res = await upload({ filePath: "/tmp/does-not-exist.md" });
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("refuses with no file chosen", async () => {
    expect((await upload({})).ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("docs:upload — a failed hop does not pretend to succeed", () => {
  it("surfaces the SERVER's refusal from the presign step", async () => {
    // The server is the authority on type/size/path; its message is the useful one.
    responder = (url) =>
      url.includes("upload-url")
        ? new Response(JSON.stringify({ error: "unsupported file type '.exe'" }), { status: 400 })
        : new Response("", { status: 200 });

    const res = await upload({ filePath: "/tmp/notes.md" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported file type/);
    // It must NOT go on to PUT or confirm.
    expect(requests).toHaveLength(1);
  });

  it("does NOT confirm when the S3 PUT fails", async () => {
    // Confirming here would index a document whose bytes never landed.
    responder = (url) => {
      if (url.includes("upload-url")) {
        return new Response(
          JSON.stringify({ upload: { url: "https://s3.example/put", headers: { "Content-Type": "text/markdown", "Content-Length": "100" } } }),
          { status: 200 }
        );
      }
      if (url.startsWith("https://s3.example")) return new Response("", { status: 403 });
      return new Response("", { status: 200 });
    };

    const res = await upload({ filePath: "/tmp/notes.md" });

    expect(res.ok).toBe(false);
    expect(requests.some((r) => r.url.includes("upload-complete"))).toBe(false);
  });

  it("reports a failure when the confirm step fails", async () => {
    responder = (url) => {
      if (url.includes("upload-url")) {
        return new Response(
          JSON.stringify({ upload: { url: "https://s3.example/put", headers: { "Content-Type": "text/markdown", "Content-Length": "100" } } }),
          { status: 200 }
        );
      }
      if (url.includes("upload-complete")) return new Response("{}", { status: 404 });
      return new Response("", { status: 200 });
    };

    const res = await upload({ filePath: "/tmp/notes.md" });
    expect(res.ok).toBe(false);
  });

  it("refuses when the server returns no upload URL", async () => {
    responder = (url) =>
      url.includes("upload-url") ? new Response("{}", { status: 200 }) : new Response("", { status: 200 });
    const res = await upload({ filePath: "/tmp/notes.md" });
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(1);
  });
});

describe("the presigned URL never reaches the renderer", () => {
  const src = readFileSync(join(__dirname, "team-data.ts"), "utf8");
  const preload = readFileSync(join(__dirname, "..", "..", "preload", "index.ts"), "utf8");

  it("no ipc channel returns a presigned URL", async () => {
    // The whole point of doing all three hops in main. If a `docs:uploadUrl` channel
    // ever appears, that URL becomes reachable from the renderer's dependency tree.
    //
    // Comments are stripped first: preload DOCUMENTS why the URL stays in main, and a
    // bare string search would fail on that explanation.
    const code = preload
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/uploadUrl|upload-url|presign/i);
    expect(src).not.toMatch(/ipcMain\.handle\("docs:uploadUrl"/);
  });

  it("every docs read is bounded by a timeout", async () => {
    const block = src.slice(src.indexOf('"docs:list"'));
    expect(block).toMatch(/AbortSignal\.timeout/);
  });

  it("the upload PUT is bounded too", async () => {
    expect(src).toMatch(/UPLOAD_TIMEOUT_MS/);
  });
});

describe("docs:upload — only a file the USER picked may be uploaded", () => {
  /**
   * The gap this closes: the handler read `params.filePath` with no confinement, no provenance and
   * no extension check in main, then PUT the bytes to the team's shared, versioned store. So it was
   * a working exfiltration primitive — and the basename reduction `files.ts` points at only
   * sanitises the DESTINATION key, never the source path.
   */
  it("REFUSES a path the picker never returned, and never touches the file or the network", async () => {
    __resetPickedUploads();
    files.set("/Users/victim/.aws/credentials", {
      size: 120,
      isFile: true,
      body: Buffer.from("[default]\naws_secret_access_key=..."),
    });

    const res = await upload({ filePath: "/Users/victim/.aws/credentials", path: "notes.md" });

    expect(res).toMatchObject({ ok: false });
    // The property that matters: no presign, no PUT, no confirm. Nothing left the machine.
    expect(requests).toHaveLength(0);
  });

  it("refuses BEFORE stat, so it is not an existence oracle for arbitrary paths", async () => {
    __resetPickedUploads();
    // A path that does not exist and one that does must be indistinguishable to the caller.
    const absent = await upload({ filePath: "/Users/victim/nope.md" });
    files.set("/Users/victim/real.md", { size: 10, isFile: true, body: Buffer.from("hi") });
    const present = await upload({ filePath: "/Users/victim/real.md" });

    expect(absent).toEqual(present);
    expect(requests).toHaveLength(0);
  });

  it("accepts the file once the picker has vouched for it", async () => {
    __resetPickedUploads();
    files.set("/Users/someone/Downloads/report.pdf", {
      size: 50,
      isFile: true,
      body: Buffer.from("%PDF"),
    });

    // Exactly what files:selectUpload does with the dialog's result.
    recordPickedUpload("/Users/someone/Downloads/report.pdf");

    const res = await upload({ filePath: "/Users/someone/Downloads/report.pdf" });
    expect(res).toMatchObject({ ok: true });
  });

  it("allows a RETRY of the same file — session-scoped, not single-use", async () => {
    // Deliberate: an upload that fails on a flaky connection is exactly when a participant clicks
    // retry, and consuming the entry on first use would break that legitimate flow.
    __resetPickedUploads();
    recordPickedUpload("/tmp/notes.md");

    expect(await upload({ filePath: "/tmp/notes.md" })).toMatchObject({ ok: true });
    expect(await upload({ filePath: "/tmp/notes.md" })).toMatchObject({ ok: true });
  });

  it("matches on the RESOLVED path, so a traversal spelling of a picked file still works", async () => {
    __resetPickedUploads();
    recordPickedUpload("/tmp/notes.md");

    expect(await upload({ filePath: "/tmp/sub/../notes.md" })).toMatchObject({ ok: true });
  });

  it("does not let one picked file vouch for its neighbours", async () => {
    __resetPickedUploads();
    files.set("/tmp/secret.md", { size: 10, isFile: true, body: Buffer.from("s") });
    recordPickedUpload("/tmp/notes.md");

    expect(await upload({ filePath: "/tmp/secret.md" })).toMatchObject({ ok: false });
    expect(requests).toHaveLength(0);
  });
});

/**
 * ── ⚠ THE SECOND HOP IS VALIDATED, NOT TRUSTED ─────────────────────────────────────────────────
 *
 * `upload.url` and `upload.headers` came out of the platform's JSON with only a truthiness test and went
 * straight into `fetch` with the full bytes of a local file — one explicitly allowed to live OUTSIDE the
 * project boundary, which is what the picked-upload registry exists for.
 *
 * ⚠ THESE ARE DEFENCE-IN-DEPTH CASES, and the bound is worth stating: the responder is already the
 * API origin the participant confirmed, over https, so this is not a route for an arbitrary remote
 * party. What is removed is the general-purpose primitive — any host, any port, any scheme, any
 * header on a request main makes from inside the participant's network.
 */
describe("⚠ docs:upload will not PUT a local file just anywhere", () => {
  /** Everything after the presign is skipped, so nothing leaves the machine. */
  const refusesTarget = async (url: unknown) => {
    responder = (u) => {
      if (u.includes("upload-url")) {
        return new Response(JSON.stringify({ upload: { url, headers: {} } }), { status: 200 });
      }
      return new Response(JSON.stringify({ versionId: "v1" }), { status: 201 });
    };
    const res = await upload({ filePath: "/tmp/notes.md" });
    expect(res).toMatchObject({ ok: false });
    // The presign happened; the PUT did not, and neither did the completion.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/docs/upload-url");
  };

  it("⚠ refuses a host that is not AWS S3", async () => {
    await refusesTarget("https://attacker.example/collect");
  });

  it("⚠ refuses a look-alike host", async () => {
    // Anchored at both ends, so neither a prefix nor a suffix trick lands.
    await refusesTarget("https://evil-amazonaws.com/put");
  });

  it("⚠ refuses a suffixed look-alike host", async () => {
    await refusesTarget("https://s3.us-east-1.amazonaws.com.evil.test/put");
  });

  it("⚠ refuses plaintext, even to a real S3 host", async () => {
    await refusesTarget("http://praimana.s3.us-east-1.amazonaws.com/k");
  });

  /** A port turns a host allowlist into a reach-anything-on-that-host primitive. */
  it("⚠ refuses a non-default port", async () => {
    await refusesTarget("https://praimana.s3.us-east-1.amazonaws.com:8443/k");
  });

  it("⚠ refuses a non-HTTP scheme and a malformed URL", async () => {
    await refusesTarget("file:///etc/passwd");
    requests.length = 0;
    await refusesTarget("not a url");
  });

  it("accepts the shapes the SDK actually presigns", async () => {
    for (const url of [
      "https://praimana.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=x",
      "https://praimana.s3.amazonaws.com/k?X-Amz-Signature=x",
      "https://s3.us-east-1.amazonaws.com/bucket/k?X-Amz-Signature=x",
    ]) {
      requests.length = 0;
      responder = (u) =>
        u.includes("upload-url")
          ? new Response(JSON.stringify({ upload: { url, headers: {} } }), { status: 200 })
          : new Response(JSON.stringify({ versionId: "v1" }), { status: 201 });

      expect(await upload({ filePath: "/tmp/notes.md" }), url).toMatchObject({ ok: true });
      expect(requests[1].method).toBe("PUT");
    }
  });

  /**
   * ⚠ THE HEADER ALLOWLIST IS THE HALF THAT REMOVES THE FORGERY PRIMITIVE. Forwarding the map
   * verbatim let the server put ANY header on a request main makes — an `Authorization`, a `Cookie` —
   * on a host it also chose.
   */
  it("⚠ forwards only the headers a presigned PUT needs", async () => {
    responder = (u) =>
      u.includes("upload-url")
        ? new Response(
            JSON.stringify({
              upload: {
                url: "https://praimana.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=x",
                headers: {
                  "Content-Type": "text/markdown",
                  "Content-Length": "100",
                  "x-amz-server-side-encryption": "AES256",
                  Authorization: "Bearer stolen",
                  Cookie: "session=stolen",
                  "X-Custom-Exfil": "whatever",
                },
              },
            }),
            { status: 200 }
          )
        : new Response(JSON.stringify({ versionId: "v1" }), { status: 201 });

    await upload({ filePath: "/tmp/notes.md" });

    const sent = requests[1].headers ?? {};
    expect(Object.keys(sent).sort()).toEqual(
      ["Content-Length", "Content-Type", "x-amz-server-side-encryption"].sort()
    );
    expect(JSON.stringify(sent)).not.toContain("stolen");
  });

  /** Case-insensitively, because HTTP header names are and an allowlist that is not gets bypassed. */
  it("⚠ is not fooled by capitalisation", async () => {
    const { presignedPutHeaders } = await import("./team-data");

    expect(Object.keys(presignedPutHeaders({ AUTHORIZATION: "Bearer x" }))).toEqual([]);
    expect(Object.keys(presignedPutHeaders({ "X-AMZ-ACL": "public-read" }))).toEqual(["X-AMZ-ACL"]);
    // A non-string value is not a header either.
    expect(Object.keys(presignedPutHeaders({ "Content-Type": 42 }))).toEqual([]);
  });
});
