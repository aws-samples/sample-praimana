// ── ⚠ THE UPLOAD PATH IS THE ONE PLACE A FACILITATOR HANDS US A STRING THAT BECOMES A KEY ─────
//
// Every assertion here defends one of two properties:
//
//   1. A name supplied by a caller CANNOT reach outside its own experience's prefix. The docs service
//      names the failure this prevents — "an authorization bypass through string concatenation, past a
//      membership guard that checked the right thing about the wrong team" — and resources are
//      readable by every role in the experience, so a crossed prefix is a disclosure, not a mess.
//
//   2. The ceiling and the type allowlist actually REFUSE things. This repo has shipped four controls
//      that were present in review and inert in fact; a size limit that only ever sees a number the
//      client chose is exactly that shape, which is why `exceedsCeiling` exists and is tested apart.
import { describe, it, expect } from "vitest";
import {
  admitResource,
  exceedsCeiling,
  extensionOf,
  safeFilename,
  resourceKey,
  resourcePrefix,
  parseResourceKey,
  MAX_RESOURCE_BYTES,
  MAX_FILENAME_LENGTH,
  PART_SIZE_BYTES,
  MAX_PARTS,
  ALLOWED_RESOURCE_EXTENSIONS,
  ALLOWED_RESOURCE_TYPES,
} from "./resource-policy.js";

describe("⚠ safeFilename — traversal and injection", () => {
  it("reduces a path to its final segment so no separator survives", () => {
    expect(safeFilename("folder/sub/brief.pdf")).toEqual({ ok: true, filename: "brief.pdf" });
  });

  it("treats a Windows path as a path, because a dragged file arrives as one", () => {
    expect(safeFilename("C:\\Users\\me\\Desktop\\deck.pptx")).toEqual({
      ok: true,
      filename: "deck.pptx",
    });
  });

  /**
   * ⚠ THE CASE THAT WOULD CROSS EXPERIENCES. Were the name used as given, this key would resolve into
   * another workshop's prefix — past an ownership check that correctly verified the workshop the caller
   * named, while the bytes landed somewhere else entirely.
   */
  it("cannot escape the prefix with traversal, however it is spelled", () => {
    for (const attack of [
      "../../workshops/other/resources/x/steal.pdf",
      "..\\..\\workshops\\other\\resources\\x\\steal.pdf",
      "./../brief.pdf",
      "a/../../../../../../etc/passwd.txt",
    ]) {
      const r = safeFilename(attack);
      expect(r.ok, `${attack} was admitted`).toBe(true);
      if (r.ok) {
        expect(r.filename).not.toContain("/");
        expect(r.filename).not.toContain("\\");
        expect(r.filename).not.toContain("..");
      }
    }
  });

  it("refuses the names that are not names", () => {
    for (const bad of ["", "   ", ".", "..", "foo/", "foo\\"]) {
      expect(safeFilename(bad).ok, `${JSON.stringify(bad)} was admitted`).toBe(false);
    }
  });

  /** A newline would break the S3 metadata header the name is stored in — header injection. */
  it("refuses control characters and newlines", () => {
    for (const bad of ["bri\nef.pdf", "brief\u0000.pdf", "a\u007fb.pdf", "tab\there.pdf"]) {
      expect(safeFilename(bad).ok, `${JSON.stringify(bad)} was admitted`).toBe(false);
    }
  });

  it("refuses a name longer than the cap, and admits one exactly at it", () => {
    const at = "a".repeat(MAX_FILENAME_LENGTH - 4) + ".pdf";
    expect(safeFilename(at).ok).toBe(true);
    expect(safeFilename("a".repeat(MAX_FILENAME_LENGTH + 1) + ".pdf").ok).toBe(false);
  });

  it("refuses a non-string without throwing", () => {
    for (const junk of [null, undefined, 42, {}, []] as unknown[]) {
      expect(() => safeFilename(junk)).not.toThrow();
      expect(safeFilename(junk).ok).toBe(false);
    }
  });
});

describe("extensionOf", () => {
  it("lower-cases and drops the dot", () => {
    expect(extensionOf("Brief.PDF")).toBe("pdf");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  /** A dotfile IS its name; it has no extension, so it cannot clear the allowlist. */
  it("gives nothing for a dotfile, a bare name, or a trailing dot", () => {
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf("brief.")).toBe("");
  });
});

describe("⚠ admitResource — the allowlist", () => {
  it("admits each permitted type and pins a server-chosen content type", () => {
    for (const ext of ALLOWED_RESOURCE_EXTENSIONS) {
      const r = admitResource({ filename: `material.${ext}`, declaredBytes: 1024 });
      expect(r.ok, `.${ext} was refused`).toBe(true);
      if (r.ok) expect(r.contentType).toBe(ALLOWED_RESOURCE_TYPES[ext]);
    }
  });

  /**
   * ⚠ THE TWO THAT WERE DELIBERATELY LEFT OUT. Both are script-bearing documents a browser executes in
   * whatever origin serves them. The docs service permits html because its read path returns JSON and
   * never a rendered page — a property of that path, not of the file, and not true of a download.
   */
  it("refuses svg and html, which are script-bearing", () => {
    expect(admitResource({ filename: "logo.svg", declaredBytes: 10 }).ok).toBe(false);
    expect(admitResource({ filename: "page.html", declaredBytes: 10 }).ok).toBe(false);
  });

  it("refuses executables and scripts", () => {
    for (const ext of ["exe", "dll", "sh", "bat", "app", "js", "command", "scpt"]) {
      expect(
        admitResource({ filename: `tool.${ext}`, declaredBytes: 10 }).ok,
        `.${ext} was admitted`
      ).toBe(false);
    }
  });

  /** A double extension must be judged on the LAST one, which is what a system will act on. */
  it("judges a double extension by its final one", () => {
    expect(admitResource({ filename: "invoice.pdf.exe", declaredBytes: 10 }).ok).toBe(false);
    expect(admitResource({ filename: "notes.exe.pdf", declaredBytes: 10 }).ok).toBe(true);
  });

  it("refuses a file with no extension at all", () => {
    expect(admitResource({ filename: "README", declaredBytes: 10 }).ok).toBe(false);
    expect(admitResource({ filename: ".env", declaredBytes: 10 }).ok).toBe(false);
  });

  it("carries the traversal rejection through, not just the type one", () => {
    const r = admitResource({ filename: "../../other/brief.pdf", declaredBytes: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filename).toBe("brief.pdf");
  });
});

describe("⚠ admitResource — size and part arithmetic", () => {
  it("refuses an empty file, which is always a failed export", () => {
    expect(admitResource({ filename: "a.pdf", declaredBytes: 0 }).ok).toBe(false);
  });

  it("admits exactly the ceiling and refuses one byte over", () => {
    expect(admitResource({ filename: "a.mp4", declaredBytes: MAX_RESOURCE_BYTES }).ok).toBe(true);
    expect(admitResource({ filename: "a.mp4", declaredBytes: MAX_RESOURCE_BYTES + 1 }).ok).toBe(false);
  });

  it("refuses a size that is not a whole count of bytes", () => {
    for (const junk of [-1, 1.5, NaN, Infinity, "100", null, undefined, {}] as unknown[]) {
      expect(
        admitResource({ filename: "a.pdf", declaredBytes: junk }).ok,
        `${String(junk)} was admitted`
      ).toBe(false);
    }
  });

  it("never asks for zero parts, and never more than the derived maximum", () => {
    for (const bytes of [1, 5, PART_SIZE_BYTES - 1, PART_SIZE_BYTES, PART_SIZE_BYTES + 1, MAX_RESOURCE_BYTES]) {
      const r = admitResource({ filename: "a.mp4", declaredBytes: bytes });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.partCount).toBeGreaterThanOrEqual(1);
        expect(r.partCount).toBeLessThanOrEqual(MAX_PARTS);
      }
    }
  });

  /**
   * ⚠ EVERY PART BUT THE LAST MUST BE AT LEAST 5MB OR S3 REFUSES THE COMPLETION. This asserts the
   * constant honours that, so a later "let's use smaller parts for nicer progress" cannot quietly
   * produce uploads that fail only at the final step.
   */
  it("uses a part size S3 will accept for a non-final part", () => {
    expect(PART_SIZE_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });
});

describe("⚠ exceedsCeiling — the check that actually enforces the limit", () => {
  // The declared size is advice; a presigned part URL does not constrain the bytes pushed through it.
  // This is the post-upload check against a size S3 reported, and it is the reason the limit is real.
  it("is false at the ceiling and true above it", () => {
    expect(exceedsCeiling(MAX_RESOURCE_BYTES)).toBe(false);
    expect(exceedsCeiling(MAX_RESOURCE_BYTES + 1)).toBe(true);
  });

  it("catches a client that declared a small size and uploaded a large one", () => {
    const admitted = admitResource({ filename: "a.mp4", declaredBytes: 1024 });
    expect(admitted.ok).toBe(true);
    // ...and then pushed 300MB through the part URLs.
    expect(exceedsCeiling(300 * 1024 * 1024)).toBe(true);
  });
});

describe("⚠ key layout", () => {
  it("places the workshop id itself, so a caller cannot choose its own prefix", () => {
    const key = resourceKey({ workshopId: "W1", resourceId: "R1", filename: "brief.pdf" });
    expect(key).toBe("workshops/W1/resources/R1/brief.pdf");
    expect(key.startsWith(resourcePrefix("W1"))).toBe(true);
  });

  it("gives two uploads of one name two distinct keys", () => {
    const a = resourceKey({ workshopId: "W1", resourceId: "R1", filename: "brief.pdf" });
    const b = resourceKey({ workshopId: "W1", resourceId: "R2", filename: "brief.pdf" });
    expect(a).not.toBe(b);
  });

  it("round-trips through parseResourceKey", () => {
    const key = resourceKey({ workshopId: "W1", resourceId: "R1", filename: "my deck.pptx" });
    expect(parseResourceKey(key, "W1")).toEqual({ resourceId: "R1", filename: "my deck.pptx" });
  });

  /** A stray object under the prefix is omitted rather than rendered with a nonsense name. */
  it("returns null for anything not built by resourceKey", () => {
    expect(parseResourceKey("workshops/W1/resources/", "W1")).toBeNull();
    expect(parseResourceKey("workshops/W1/resources/R1/", "W1")).toBeNull();
    expect(parseResourceKey("workshops/W1/resources/R1/a/b.pdf", "W1")).toBeNull();
    expect(parseResourceKey("workshops/W1/other/R1/b.pdf", "W1")).toBeNull();
  });

  /** One experience must never read another's key as its own. */
  it("refuses a key belonging to a different experience", () => {
    const key = resourceKey({ workshopId: "W2", resourceId: "R1", filename: "brief.pdf" });
    expect(parseResourceKey(key, "W1")).toBeNull();
  });
});
