// ── ⚠ WHAT A MIS-RECOGNISED MENTION COSTS ────────────────────────────────────────────────
//
// Two directions, and they are not symmetrical:
//
//   A MISSED mention renders as ordinary text. The participant is exactly where they were before this
//   feature existed — no harm, no confusion.
//
//   A FALSE mention underlines the middle of a URL, or offers a click on a path in somebody else's home
//   directory. That is a link that lies about what it will do, and one of those two lies is a security
//   question rather than a cosmetic one.
//
// So the assertions below lean hard on the refusals: URLs, version numbers, prose, traversal, foreign
// absolute paths, and binaries the text editor could not honestly open.

import { describe, it, expect } from "vitest";
import {
  MENTION_SCHEME,
  findFileMentions,
  hastText,
  mentionTargetPath,
  rehypeFileMentions,
} from "./file-mentions";

const raws = (text: string) => findFileMentions(text).map((m) => m.raw);

describe("⚠ the sentence that started this", () => {
  /** The motivating example, verbatim. */
  it("finds the bare filename in 'I created 5 Intent Capture questions at intent-capture-questions.md'", () => {
    expect(raws("I created 5 Intent Capture questions at intent-capture-questions.md")).toEqual([
      "intent-capture-questions.md",
    ]);
  });

  /** A mention at the end of a sentence keeps the full stop OUT of the filename. */
  it("does not swallow the full stop after it", () => {
    const [mention] = findFileMentions("Written to intent-capture-questions.md.");
    expect(mention.raw).toBe("intent-capture-questions.md");
  });

  it("slices back to exactly what it matched", () => {
    const text = "see docs/spec.md now";
    const [mention] = findFileMentions(text);
    expect(text.slice(mention.start, mention.end)).toBe(mention.raw);
  });
});

describe("⚠ shapes that are files", () => {
  it.each([
    ["a nested path", "updated src/renderer/lib/file-tabs.ts here", "src/renderer/lib/file-tabs.ts"],
    ["an explicit ./", "run ./scripts/start.sh", "./scripts/start.sh"],
    ["a POSIX absolute path", "wrote /Users/me/proj/docs/spec.md", "/Users/me/proj/docs/spec.md"],
    ["a Windows absolute path", "wrote C:\\Users\\me\\proj\\spec.md", "C:\\Users\\me\\proj\\spec.md"],
    ["a Windows relative path", "see src\\main\\index.ts", "src\\main\\index.ts"],
    ["a cited line", "fails at src/app.ts:42", "src/app.ts:42"],
    ["a cited line and column", "fails at src/app.ts:42:7", "src/app.ts:42:7"],
    ["a dotted filename", "check vite.config.ts", "vite.config.ts"],
    // `@` survives in a DIRECTORY segment, which is what keeps scoped packages workable — see the pattern.
    ["a scoped package path", "see node_modules/@types/node/index.d.ts", "node_modules/@types/node/index.d.ts"],
  ])("recognises %s", (_what, text, expected) => {
    expect(raws(text)).toEqual([expected]);
  });

  it("finds several in one run of prose", () => {
    expect(raws("I wrote plan.md and questions.md, then touched src/App.tsx")).toEqual([
      "plan.md",
      "questions.md",
      "src/App.tsx",
    ]);
  });
});

describe("⚠ shapes that are NOT files, however much they look like one", () => {
  /**
   * ⚠ THE URL CASE IS THE WHOLE REASON THE LEFT NEIGHBOUR IS CHECKED. `//example.com/docs/spec.md` contains
   * a flawless-looking path; the only thing that says otherwise is the separator in front of it.
   */
  it.each([
    ["a URL", "see https://example.com/docs/spec.md for more"],
    ["a URL with no path", "at http://example.com/a.md"],
    ["a domain", "hosted on amazon.com today"],
    ["a version number", "upgraded to v1.2.3 today"],
    ["prose with initials", "e.g. this one"],
    ["an e-mail address", "mail me@example.md today"],
    ["an unknown extension", "opened archive.tar today"],
    ["a bare name with no extension", "opened README today"],
  ])("ignores %s", (_what, text) => {
    expect(raws(text)).toEqual([]);
  });

  /**
   * ⚠ A REJECTED CANDIDATE IS SKIPPED WHOLE. Having decided the URL is not a path, the scan must not then
   * find `docs/spec.md` inside it — that would underline the middle of somebody's link.
   */
  it("does not find a path INSIDE a URL it has already refused", () => {
    expect(raws("see https://example.com/docs/spec.md for more")).toEqual([]);
  });

  /** The extension must end the word: `spec.mdx` is not `spec.md` plus a stray x. */
  it("does not truncate a longer extension into a shorter one", () => {
    expect(raws("see spec.mdx here")).toEqual(["spec.mdx"]);
    expect(raws("see notes.markdown here")).toEqual(["notes.markdown"]);
    expect(raws("see thing.mdz here")).toEqual([]);
  });

  /**
   * ⚠ THE EDITOR IS A TEXT EDITOR. A click that opens a PNG in it paints a screenful of mojibake and calls
   * it a document, so these are not offered at all.
   */
  it.each(["diagram.png", "photo.jpg", "report.pdf", "bundle.zip", "font.woff"])(
    "ignores %s, which the editor could not honestly open",
    (name) => {
      expect(raws(`attached ${name} here`)).toEqual([]);
    }
  );
});

describe("⚠ resolving against the open project", () => {
  const POSIX_ROOT = "/Users/me/projects/acme";
  const WINDOWS_ROOT = "C:\\Users\\me\\projects\\acme";

  it("joins a relative mention onto the root", () => {
    expect(mentionTargetPath(POSIX_ROOT, "docs/spec.md")).toBe("/Users/me/projects/acme/docs/spec.md");
  });

  it("drops a leading ./", () => {
    expect(mentionTargetPath(POSIX_ROOT, "./docs/spec.md")).toBe("/Users/me/projects/acme/docs/spec.md");
  });

  /** `:42` is how an agent cites a line. The editor opens files, so it must not reach the filesystem. */
  it("strips the cited line and column", () => {
    expect(mentionTargetPath(POSIX_ROOT, "src/app.ts:42")).toBe("/Users/me/projects/acme/src/app.ts");
    expect(mentionTargetPath(POSIX_ROOT, "src/app.ts:42:7")).toBe("/Users/me/projects/acme/src/app.ts");
  });

  it("accepts an absolute mention that is inside the project", () => {
    expect(mentionTargetPath(POSIX_ROOT, `${POSIX_ROOT}/docs/spec.md`)).toBe(`${POSIX_ROOT}/docs/spec.md`);
  });

  /**
   * ⚠ THE REFUSALS THAT MATTER. An assistant prints absolute paths from wherever it has been; a SHARED
   * conversation prints a teammate's home directory. Neither is ours to open, and offering the click would
   * be a link that main then declines — indistinguishable from a broken one.
   */
  it.each([
    ["another project", "/Users/me/projects/other/docs/spec.md"],
    ["a sibling whose name merely starts the same", "/Users/me/projects/acme-api/docs/spec.md"],
    ["somebody's private key", "/Users/me/.ssh/id_rsa.txt"],
    ["a traversal out of the project", "../../.ssh/authorized_keys.txt"],
    ["a traversal in the middle", "docs/../../secrets.txt"],
  ])("refuses %s", (_what, mention) => {
    expect(mentionTargetPath(POSIX_ROOT, mention)).toBeNull();
  });

  it("refuses everything when there is no project open", () => {
    expect(mentionTargetPath("", "docs/spec.md")).toBeNull();
  });

  /**
   * ⚠ THE HOST SEPARATOR IS LEARNED FROM THE ROOT, NOT ASSUMED. Paths reach the renderer from `path.join`,
   * so a Windows participant's root is `\`-separated — and an agent on the same machine writes `/` anyway.
   * Both have to land on one path the main process can open.
   */
  it("emits the root's separator, whichever the mention used", () => {
    expect(mentionTargetPath(WINDOWS_ROOT, "docs/spec.md")).toBe("C:\\Users\\me\\projects\\acme\\docs\\spec.md");
    expect(mentionTargetPath(WINDOWS_ROOT, "docs\\spec.md")).toBe("C:\\Users\\me\\projects\\acme\\docs\\spec.md");
    expect(mentionTargetPath(POSIX_ROOT, "docs\\spec.md")).toBe("/Users/me/projects/acme/docs/spec.md");
  });

  it("accepts a Windows absolute mention inside the project, whichever slash it used", () => {
    expect(mentionTargetPath(WINDOWS_ROOT, "C:/Users/me/projects/acme/docs/spec.md")).toBe(
      "C:\\Users\\me\\projects\\acme\\docs\\spec.md"
    );
  });

  it("does not double the separator on a root that has a trailing one", () => {
    expect(mentionTargetPath("/Users/me/projects/acme/", "docs/spec.md")).toBe(
      "/Users/me/projects/acme/docs/spec.md"
    );
  });
});

/* ─── The rehype pass ───────────────────────────────────────────── */

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: any[], properties: Record<string, unknown> = {}) => ({
  type: "element",
  tagName,
  properties,
  children,
});

const transform = (tree: any) => rehypeFileMentions()(tree);

describe("⚠ the rehype pass rewrites prose and nothing else", () => {
  it("splits a paragraph's text around the mention", () => {
    const tree = { type: "root", children: [element("p", [text("wrote docs/spec.md today")])] };
    transform(tree);

    const paragraph = (tree.children[0] as any).children;
    expect(paragraph.map((n: any) => n.value ?? n.tagName)).toEqual(["wrote ", "a", " today"]);
    expect(paragraph[1].properties.href).toBe(`${MENTION_SCHEME}docs/spec.md`);
    expect(paragraph[1].children[0].value).toBe("docs/spec.md");
  });

  /**
   * ⚠ A CODE BLOCK IS LITERAL CHARACTERS. Every path in a diff or a directory listing would become a link,
   * and the block is meant to be read — and copied — exactly as printed.
   */
  it("leaves a fenced code block alone", () => {
    const block = element("pre", [element("code", [text("cat docs/spec.md")])]);
    const tree = { type: "root", children: [block] };
    transform(tree);

    expect(hastText(block)).toBe("cat docs/spec.md");
    expect((block.children[0] as any).children[0].type).toBe("text");
  });

  /**
   * ⚠ AN INLINE SPAN IS THE COMMON CASE, WHICH IS WHY IT IS NOT OPAQUE. An assistant writes "see
   * `src/app.ts`" far more often than it writes the path bare, so skipping inline code would have shipped a
   * feature that looks broken in most replies.
   */
  it("rewrites inside an INLINE code span", () => {
    const span = element("code", [text("src/app.ts")]);
    transform({ type: "root", children: [element("p", [text("see "), span])] });

    expect(span.children[0]).toMatchObject({ tagName: "a" });
  });

  /** Nesting a link inside a link is invalid HTML and ambiguous to click. */
  it("leaves an existing link's text alone", () => {
    const link = element("a", [text("docs/spec.md")], { href: "https://example.com" });
    transform({ type: "root", children: [element("p", [link])] });

    expect(link.children[0].type).toBe("text");
  });

  it("descends through emphasis, lists and table cells", () => {
    const strong = element("strong", [text("plan.md")]);
    const cell = element("td", [text("src/app.ts")]);
    transform({ type: "root", children: [element("p", [strong]), element("table", [cell])] });

    expect(strong.children[0]).toMatchObject({ tagName: "a" });
    expect(cell.children[0]).toMatchObject({ tagName: "a" });
  });

  it("leaves a paragraph with no mention untouched, node for node", () => {
    const only = text("nothing to see here");
    const tree = { type: "root", children: [element("p", [only])] };
    transform(tree);

    expect((tree.children[0] as any).children[0]).toBe(only);
  });
});

describe("⚠ hastText, because the pass breaks String(children)", () => {
  /**
   * `KiroChatView`'s `code` component derived its copy-button text from `String(children)`. Once a mention
   * inside an inline span makes one child an ELEMENT, that expression yields "[object Object]" — a copy
   * button that copies nothing. This is the honest answer to "what does this span say".
   */
  it("reads the text back out of a span the pass has rewritten", () => {
    const span = element("code", [text("see src/app.ts now")]);
    transform({ type: "root", children: [element("p", [span])] });

    expect(span.children.length).toBeGreaterThan(1);
    expect(hastText(span)).toBe("see src/app.ts now");
  });

  it("survives a missing node", () => {
    expect(hastText(undefined)).toBe("");
    expect(hastText(null)).toBe("");
  });
});
