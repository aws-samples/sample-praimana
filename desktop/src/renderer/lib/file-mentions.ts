// ── ⚠ THE FILENAME IN A REPLY WAS A DEAD WORD ────────────────────────────────────────────
//
// The assistant names the file it just wrote in almost every turn. Until now that name was inert text: the
// participant read `intent-capture-questions.md` on screen and then went looking for it in the tree or the
// quick-open box. Everything needed to open it already existed — `lib/file-tabs.ts` holds the tab rules and
// `App.handleOpenFile` opens one — so what was missing was only the recognition.
//
// ── WHY A PURE MODULE, AND NOT A REGEX INSIDE THE VIEW ──
//
// Because every interesting decision here is a REFUSAL, and a refusal that cannot be tested is a refusal
// nobody will notice going wrong:
//
//   ⚠ NOT EVERY DOTTED WORD IS A FILE., "v1.2.3", "e.g." and "Node.js" are all shaped like
//     one. An extension ALLOWLIST is what separates them, and it is checked here rather than trusted.
//
//   ⚠ NOT EVERY FILE IS OPENABLE. The editor is a TEXT editor: handing it a .png would paint a screenful of
//     mojibake and call it a document. Image and archive extensions are deliberately absent from the list.
//
//   ⚠ NOT EVERY PATH IS OURS. An assistant writes absolute paths, and a shared conversation carries paths
//     from a TEAMMATE's machine. Anything that does not resolve inside the open project resolves to `null`
//     and renders as plain text — the renderer never asks main to open it, so a message cannot turn the
//     editor into a viewer for `~/.ssh/id_rsa`. Main confines every read as well (`files:readFile` →
//     `assertRealPathWithinProject`); this is the check that stops us OFFERING the click at all.
//
//   ⚠ AND THE HOST SEPARATOR IS NOT ALWAYS "/". Paths reach the renderer built by `path.join`, so on Windows
//     they are `\`-separated — the ninth Windows defect (see path-labels.windows.test.ts) was exactly this
//     assumption. Both separators are accepted on the way in, and the ROOT's separator is what comes out.

import { isSelfOrDescendant } from "./file-tree-ops";

/**
 * The href a recognised mention is parked under by `rehypeFileMentions`, so that ONE `a` component in the
 * markdown renderer decides what every link does.
 *
 * ⚠ A CUSTOM SCHEME MEANS `urlTransform` HAS TO BE TOLD ABOUT IT. `react-markdown` runs
 * `defaultUrlTransform` over every href and blanks anything outside http/https/mailto/tel — which is a
 * sanitiser worth keeping, so `AssistantMarkdown` extends it rather than switching it off.
 */
export const MENTION_SCHEME = "file-mention:";

/**
 * What makes a dotted word a file mention.
 *
 * ⚠ AN ALLOWLIST, BECAUSE THE ALTERNATIVE MIS-FIRES ON PROSE. "sees" and "in v1.2.3" match any
 * `word.word` pattern, and an assistant's reply is full of both. The cost of the allowlist is a missed
 * mention for an exotic extension, which reads as ordinary text — the cost of the general pattern is
 * underlining half the sentence.
 *
 * ⚠ TEXT FORMATS ONLY. `png`, `jpg`, `pdf`, `zip`, `woff` and friends are absent ON PURPOSE: clicking one
 * would open a binary in a text editor. A mention we cannot honour should not be offered.
 */
const TEXT_FILE_EXTENSIONS = [
  // Documents — the workshop's own output is mostly this line
  "md", "markdown", "mdx", "txt", "rst", "adoc",
  // Config and data
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "csv", "tsv", "xml", "lock",
  // Code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "kts", "go", "rs", "rb", "php", "cs",
  "swift", "c", "h", "cpp", "hpp", "scala", "sh", "bash", "zsh", "ps1", "sql", "graphql", "proto", "gradle",
  // Web
  "css", "scss", "less", "html", "htm", "svelte", "vue",
  // Infrastructure
  "tf", "tfvars",
];

/**
 * ⚠ LONGEST FIRST, OR `.markdown` LOSES ITS TAIL. A regex alternation takes the first branch that matches,
 * so `md|markdown` matches "md" inside "markdown" and the trailing "own" then fails the word-boundary check
 * below — which discards the whole mention rather than shortening it.
 */
const EXTENSION_ALTERNATION = [...TEXT_FILE_EXTENSIONS].sort((a, b) => b.length - a.length).join("|");

/** Characters legal inside one path segment. Deliberately no spaces — see `findFileMentions`. */
const SEGMENT = String.raw`[\w.@+~-]`;

/**
 * The same, minus `@`, for the FILENAME.
 *
 * ⚠ THIS IS WHAT KEEPS E-MAIL ADDRESSES OUT. `me@example.md` is a legal filename shape and an illegal thing
 * to underline. Dropping `@` from the last segment makes the scan start at "example.md" instead, whose left
 * neighbour is then the `@` that `REJECT_BEFORE` refuses. Directory segments keep it, because
 * `node_modules/@types/node/index.d.ts` is a real path people are shown every day.
 */
const FILENAME_SEGMENT = String.raw`[\w.+~-]`;

function mentionPattern(): RegExp {
  return new RegExp(
    // "C:\" or "C:/" — a Windows absolute path
    String.raw`(?:[A-Za-z]:[\\/])?` +
      // a leading separator (POSIX absolute, or a UNC share) or an explicit "./"
      String.raw`(?:[\\/]|\.[\\/])?` +
      // the directories
      String.raw`(?:${SEGMENT}+[\\/])*` +
      // the filename and its extension
      String.raw`${FILENAME_SEGMENT}+\.(?:${EXTENSION_ALTERNATION})` +
      // ":12" or ":12:4" — how every agent cites a line, and part of the mention's TEXT
      String.raw`(?::\d+(?::\d+)?)?`,
    "g"
  );
}

/** One recognised mention, located in the string it was found in. */
export interface FileMention {
  start: number;
  /** Exclusive, so `text.slice(start, end) === raw`. */
  end: number;
  /** Exactly as written, line suffix included — this is what stays on screen. */
  raw: string;
}

/**
 * Where the char before a candidate rules it out.
 *
 * ⚠ THIS IS WHAT KEEPS URLS OUT. `https://example.com/docs/spec.md` contains a perfectly good-looking
 * `/example.com/docs/spec.md`, and the only thing distinguishing it from a real path is the `/` in front of
 * it (from `//`). Rejecting a match whose left neighbour is a separator, a colon or an `@` throws out URLs
 * and e-mail addresses without needing to parse either.
 */
const REJECT_BEFORE = /[A-Za-z0-9_@:/\\.]/;

/** No trailing letters, digits or separators: `spec.mdx` must not be read as `spec.md` plus "x". */
const REJECT_AFTER = /^[A-Za-z0-9_/\\]|^\.[A-Za-z0-9]/;

/**
 * Every file mention in a run of plain text, left to right and non-overlapping.
 *
 * ⚠ A REJECTED CANDIDATE IS SKIPPED WHOLE, not re-scanned from the inside. That is what makes the URL rule
 * above hold: having decided `/example.com/docs/spec.md` is not a path, we must not then go on to find
 * `docs/spec.md` inside it and link the middle of somebody's URL.
 *
 * ⚠ NO SPACES IN A PATH, and that is a knowing trade. "the file my notes.md" gives no way to tell where the
 * filename starts, so a path with a space in it is not recognised. Under-recognising leaves ordinary text;
 * guessing would swallow the words in front of it.
 */
export function findFileMentions(text: string): FileMention[] {
  const found: FileMention[] = [];
  const pattern = mentionPattern();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const before = match.index === 0 ? "" : text[match.index - 1];
    const after = text.slice(match.index + raw.length);

    if (before && REJECT_BEFORE.test(before)) continue;
    if (REJECT_AFTER.test(after)) continue;

    found.push({ start: match.index, end: match.index + raw.length, raw });
  }

  return found;
}

function isAbsolutePath(p: string): boolean {
  return /^[\\/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** `\` when the project root uses it, `/` otherwise — the host's separator, learned rather than assumed. */
function separatorOf(root: string): "\\" | "/" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

function stripTrailingSeparators(p: string): string {
  return p.replace(/[\\/]+$/, "") || p;
}

/**
 * The absolute path a mention refers to, or `null` when it refers to nothing we may open.
 *
 * `null` is not an error path — it is the ordinary answer for a mention that names a file in somebody
 * else's checkout, or an absolute path outside the project, or a `../` escape. The caller renders plain
 * text for it, which is what an unopenable name should look like.
 *
 * ⚠ THE LINE SUFFIX IS DROPPED HERE AND NOWHERE ELSE. `src/app.ts:42` is how every agent cites a line; the
 * editor opens files, not lines, so `:42` is display text that must not reach the filesystem.
 */
export function mentionTargetPath(root: string, raw: string): string | null {
  if (!root) return null;

  // Only a trailing ":digits" (optionally ":digits:digits") — a Windows "C:\…" is untouched by this.
  const cited = raw.replace(/:\d+(?::\d+)?$/, "");
  if (!cited) return null;

  const separator = separatorOf(root);
  const normalise = (p: string) => p.split(/[\\/]/).join(separator);

  if (isAbsolutePath(cited)) {
    const absolute = normalise(cited);
    /*
      ⚠ COMPARED, NOT TRUSTED. An assistant working in one project happily prints an absolute path in
      another; a shared conversation prints a teammate's home directory. Neither is ours to open.
      `isSelfOrDescendant` checks the separator after the prefix, so a sibling project whose name merely
      STARTS with ours ("…/acme" vs "…/acme-api") is not mistaken for a child.
    */
    return isSelfOrDescendant(stripTrailingSeparators(root), absolute) ? absolute : null;
  }

  const relative = cited.replace(/^\.[\\/]/, "");
  const segments = relative.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  /*
    ⚠ REFUSED RATHER THAN RESOLVED. `..` could be collapsed here and then handed to main, which would refuse
    anything that escapes anyway — but resolving it would mean offering a click that main then declines,
    which reads as a broken link. A mention that has to climb out of the project is not a mention.
  */
  if (segments.includes("..")) return null;

  return `${stripTrailingSeparators(root)}${separator}${segments.join(separator)}`;
}

/* ─── The rehype pass ───────────────────────────────────────────── */

/**
 * The subset of hast this pass needs. Structural typing rather than `@types/hast`: the shape is four fields
 * and importing a transitive dependency's types to name them would tie the renderer to `react-markdown`'s
 * dependency tree.
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Elements whose text is NOT prose, and must be left exactly as written.
 *
 * `pre` — a code block. Every path in a diff or a listing would become a link, and the block is meant to be
 *   read as literal characters (and copied as them).
 * `a` — already a link. Nesting one inside another is invalid HTML and ambiguous to click.
 *
 * ⚠ `code` IS NOT HERE, ON PURPOSE. An INLINE code span is how an assistant writes a path most of the time
 * ("see `src/main/index.ts`"), so skipping it would miss the common case and leave the feature looking
 * broken. Only `pre` blocks are opaque — a `code` inside a `pre` is protected by its parent.
 */
const OPAQUE_TAGS = new Set(["pre", "a"]);

/**
 * A rehype plugin that turns every file mention in the rendered prose into an anchor under
 * `MENTION_SCHEME`, for the markdown renderer's own `a` component to pick up.
 *
 * ⚠ WHY THE TREE AND NOT THE MARKDOWN SOURCE. A regex over the source string cannot see structure: it would
 * happily rewrite inside fenced code, inside an existing link's target, and inside HTML attributes. By the
 * time rehype runs, "which text is prose" is a fact about the tree rather than a guess about the text.
 *
 * ⚠ AND NOT `unist-util-visit`, though it is present in `node_modules` as somebody else's transitive
 * dependency. Importing it would make our bundle depend on a package our `package.json` never declared —
 * one hoisting change away from a build that cannot resolve it. The walk is nine lines.
 */
export function rehypeFileMentions() {
  return (tree: HastNode): HastNode => {
    linkMentionsIn(tree);
    return tree;
  };
}

function linkMentionsIn(node: HastNode): void {
  const children = node.children;
  if (!children || children.length === 0) return;

  const rebuilt: HastNode[] = [];
  let changed = false;

  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      const split = splitTextNode(child.value);
      if (split) {
        rebuilt.push(...split);
        changed = true;
        continue;
      }
      rebuilt.push(child);
      continue;
    }

    if (child.type === "element" && child.tagName && OPAQUE_TAGS.has(child.tagName)) {
      rebuilt.push(child);
      continue;
    }

    linkMentionsIn(child);
    rebuilt.push(child);
  }

  if (changed) node.children = rebuilt;
}

/** The replacement nodes for one text node, or `null` when it holds no mention (the common case). */
function splitTextNode(value: string): HastNode[] | null {
  const mentions = findFileMentions(value);
  if (mentions.length === 0) return null;

  const out: HastNode[] = [];
  let cursor = 0;

  for (const mention of mentions) {
    if (mention.start > cursor) {
      out.push({ type: "text", value: value.slice(cursor, mention.start) });
    }
    out.push({
      type: "element",
      tagName: "a",
      properties: { href: `${MENTION_SCHEME}${mention.raw}` },
      // The mention's own text, unchanged — the line suffix included, because that is what was written.
      children: [{ type: "text", value: mention.raw }],
    });
    cursor = mention.end;
  }

  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

/**
 * All the text under a hast node, concatenated.
 *
 * ⚠ THIS EXISTS BECAUSE THE PASS ABOVE BREAKS `String(children)`. `KiroChatView`'s `code` component derived
 * its copy-button text and its inline-vs-block test from `String(children)`, which is only a string while
 * the span holds nothing but text. A mention inside an inline span makes one child a React ELEMENT, and
 * `String()` of that is "[object Object]" — a copy button that copies nothing. The hast node is the honest
 * source for "what does this span say".
 */
export function hastText(node: unknown): string {
  const candidate = node as HastNode | null | undefined;
  if (!candidate) return "";
  if (candidate.type === "text") return candidate.value ?? "";
  return (candidate.children ?? []).map(hastText).join("");
}
