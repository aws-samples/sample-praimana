import { describe, it, expect } from "vitest";
import {
  admitUpload,
  ALLOWED_EXTENSIONS,
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
} from "./upload-policy.js";

/**
 * THE UPLOAD ADMISSION POLICY — an allowlist, a size ceiling, and a path check.
 *
 * Every one of these is load-bearing on a route that writes into a bucket other team
 * members read. The path arm matters most and is the least obvious: the caller supplies
 * `path`, the service concatenates it into `workshop/<w>/team/<t>/<path>`, and a `..`
 * segment would therefore write into ANOTHER TEAM's prefix — an authorization bypass
 * through string concatenation, sitting behind a membership guard that correctly checked
 * the wrong team.
 */

const OK_SIZE = 1024;

describe("file types — allowlist of exactly four", () => {
  it.each(["md", "txt", "pdf", "html"])("admits .%s", (ext) => {
    const got = admitUpload(`notes.${ext}`, OK_SIZE);
    expect(got.ok, `expected .${ext} to be admitted`).toBe(true);
    if (got.ok) expect(got.contentType).toBe(ALLOWED_UPLOAD_TYPES[ext]);
  });

  it("the allowlist has not quietly grown", () => {
    // A fifth type is a product decision, not a refactor. If this fails, someone
    // widened the upload surface — check it was deliberate.
    expect(ALLOWED_EXTENSIONS.sort()).toEqual(["html", "md", "pdf", "txt"]);
  });

  it.each([
    "payload.exe",
    "run.sh",
    "app.js",
    "index.php",
    "archive.zip",
    "image.png",
    "config.yaml",
    "data.json",
    "doc.docx",
    "sheet.xlsx",
    "lib.so",
    "installer.dmg",
  ])("refuses %s", (path) => {
    const got = admitUpload(path, OK_SIZE);
    expect(got.ok, `expected ${path} to be refused`).toBe(false);
  });

  it("refuses a file with NO extension", () => {
    expect(admitUpload("README", OK_SIZE).ok).toBe(false);
  });

  it("matches the extension case-insensitively", () => {
    // A participant on Windows may well produce NOTES.MD or Report.PDF.
    for (const p of ["NOTES.MD", "Report.PDF", "a.TxT", "page.HtMl"]) {
      expect(admitUpload(p, OK_SIZE).ok, `${p} should be admitted`).toBe(true);
    }
  });

  it("judges only the LAST extension, so a double extension cannot smuggle a type", () => {
    // `evil.md.exe` is an executable; `report.exe.md` is a markdown file with an odd
    // name. Taking the last segment is what makes the first case a refusal.
    expect(admitUpload("evil.md.exe", OK_SIZE).ok).toBe(false);
    expect(admitUpload("report.exe.md", OK_SIZE).ok).toBe(true);
  });

  it("the content type is SERVER-chosen, never taken from the caller", () => {
    // admitUpload takes no content-type argument at all, which is the point: the
    // signature covers the type, so a client cannot store a .pdf key as text/html.
    expect(admitUpload.length).toBe(2);
    const got = admitUpload("page.html", OK_SIZE);
    if (!got.ok) throw new Error("expected admission");
    expect(got.contentType).toBe("text/html; charset=utf-8");
  });
});

describe("size — 20MB, enforced at the boundary", () => {
  it("the ceiling is 20MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });

  it("admits EXACTLY the ceiling", () => {
    // Off by one here would refuse a legitimate 20MB file forever.
    expect(admitUpload("big.pdf", MAX_UPLOAD_BYTES).ok).toBe(true);
  });

  it("refuses one byte over", () => {
    const got = admitUpload("big.pdf", MAX_UPLOAD_BYTES + 1);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/too large/);
  });

  it.each([0, -1, -20000, 1.5, NaN, Infinity])("refuses a size of %s", (size) => {
    expect(admitUpload("notes.md", size).ok).toBe(false);
  });

  it.each([undefined, null, "1024", {}, []])("refuses a non-number size (%s)", (size) => {
    expect(admitUpload("notes.md", size).ok).toBe(false);
  });
});

describe("path safety — this is the authorization arm", () => {
  it.each([
    "../../team/other-team/steal.md",
    "..%2f..%2fx.md".replace(/%2f/g, "/"),
    "a/../../b.md",
    "..",
    "../secret.md",
  ])("refuses traversal: %s", (path) => {
    const got = admitUpload(path, OK_SIZE);
    expect(got.ok, `expected ${path} to be refused`).toBe(false);
  });

  it("strips leading slashes rather than refusing, matching s3Key()", () => {
    // Both "/README.md" and "README.md" must land on the SAME key, or the same file
    // uploads twice under two paths and the version history splits in half.
    const a = admitUpload("/README.md", OK_SIZE);
    const b = admitUpload("README.md", OK_SIZE);
    if (!a.ok || !b.ok) throw new Error("expected both to be admitted");
    expect(a.path).toBe("README.md");
    expect(a.path).toBe(b.path);
  });

  it("refuses backslashes, which S3 stores literally", () => {
    // `..\..\x.md` defeats a naive forward-slash-only traversal check, and on S3 the
    // backslash is just a character in the key rather than a separator.
    expect(admitUpload("..\\..\\x.md", OK_SIZE).ok).toBe(false);
    expect(admitUpload("docs\\notes.md", OK_SIZE).ok).toBe(false);
  });

  it("refuses control characters and NUL", () => {
    // Written as escapes, NOT as literal bytes: a literal control character does not
    // survive editing and the assertion would silently test a plain string instead.
    expect(admitUpload("notes\u0000.md", OK_SIZE).ok).toBe(false);
    expect(admitUpload("notes\n.md", OK_SIZE).ok).toBe(false);
    expect(admitUpload("notes\u001f.md", OK_SIZE).ok).toBe(false);
    expect(admitUpload("notes\u007f.md", OK_SIZE).ok).toBe(false);
  });

  it("refuses empty and '.' segments", () => {
    expect(admitUpload("docs//notes.md", OK_SIZE).ok).toBe(false);
    expect(admitUpload("docs/./notes.md", OK_SIZE).ok).toBe(false);
  });

  it("refuses an absurdly long path", () => {
    expect(admitUpload("a".repeat(1100) + ".md", OK_SIZE).ok).toBe(false);
  });

  it.each([undefined, null, "", "   ", 42, {}])("refuses a non-path (%s)", (path) => {
    expect(admitUpload(path, OK_SIZE).ok).toBe(false);
  });

  it("ADMITS a legitimate nested path", () => {
    // The traversal checks must not make ordinary subdirectories unusable — AI-DLC
    // writes into nested folders.
    const got = admitUpload("docs/specs/architecture.md", OK_SIZE);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.path).toBe("docs/specs/architecture.md");
  });
});
