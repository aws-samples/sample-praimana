// ── ⚠ THE CLICK, WHICH IS THE HALF NO UNIT TEST CAN REACH ────────────────────────────────
//
// `lib/file-mentions.test.ts` proves what counts as a mention and where it resolves to. What is asserted
// here is everything AROUND that, which has no return value: the provider App must supply, the sanitiser the
// custom scheme depends on, the existence check before a tab opens, and the `a` that no caller may shadow.
//
// This package's vitest runs in `node` with no jsdom (see vitest.config.ts), so the wiring is read out of the
// source — the same technique as `file-tabs-wiring.test.ts`, and for the same reason: the alternative is
// asserting nothing at all about it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (...parts: string[]) => strip(readFileSync(join(__dirname, ...parts), "utf8"));

const APP = read("App.tsx");
const MARKDOWN = read("components", "AssistantMarkdown.tsx");
const MENTIONS = read("components", "FileMentions.tsx");
const TEAM = read("components", "TeamChatView.tsx");
const KIRO = read("components", "KiroChatView.tsx");

describe("⚠ the shell supplies the scope, once, around both chat views", () => {
  /**
   * The provider wraps the pane that swaps between `KiroChatView` and `AssistantChatView`, so neither can be
   * the one that got forgotten — and neither needs a prop threaded through `renderBlocks` and two dialogs.
   */
  it("wraps the chat pane rather than passing a prop per view", () => {
    /* The AI one specifically: team chat has a scope of its own further up the file. */
    const start = APP.lastIndexOf("<FileMentionScope", APP.indexOf("<KiroChatView"));
    const scope = APP.slice(start, APP.indexOf("</FileMentionScope>", start));
    expect(scope, "the whole pane is inside it").toContain("<KiroChatView");
    expect(scope, "and so is the other view").toContain("<AssistantChatView");
  });

  /** Resolution needs a root; without it every mention is plain text (see `mentionTargetPath`). */
  it("gives it the open project's root", () => {
    expect(APP).toMatch(/<FileMentionScope[\s\S]{0,200}?root=\{activeProject\.path\}/);
  });

  /**
   * ⚠ THE SAME DOOR AS THE TREE AND QUICK-OPEN, and that is the point of reusing it: `handleOpenFile` is
   * where the tab cap lives, and where an unsaved edit is protected from eviction (`lib/file-tabs.ts`). A
   * private `setTabs` here would have been a second set of rules for the same act.
   */
  it("sends a click through handleOpenFile, not a private open", () => {
    expect(APP).toMatch(/<FileMentionScope[\s\S]{0,300}?onOpenFile=\{handleOpenFile\}/);
  });

  /** The answering assistant's own ink, so a mention is not wearing Claude's terracotta inside Codex. */
  it("takes the accent from the active assistant", () => {
    expect(APP).toMatch(/accent=\{assistantTheme\(aiCommand\)\.ink\}/);
  });
});

describe("⚠ what makes the custom scheme safe", () => {
  /**
   * ⚠ `defaultUrlTransform` IS EXTENDED, NOT SWITCHED OFF. It is what blanks a `javascript:` href in
   * model-supplied markdown. Passing `urlTransform={undefined}` — or a bare `(url) => url` to let our
   * scheme through — would take that sanitiser out to add one protocol.
   */
  it("keeps react-markdown's sanitiser for every other protocol", () => {
    expect(MARKDOWN).toMatch(/import ReactMarkdown, \{ defaultUrlTransform/);
    expect(MARKDOWN).toMatch(/url\.startsWith\(MENTION_SCHEME\) \? url : defaultUrlTransform\(url\)/);
  });

  /**
   * ⚠ APPLIED AFTER THE CALLER'S COMPONENTS. Kiro's transcript passes its own `code`, `table` and `td`; if
   * the spread came last it could also pass an `a`, and the mention scheme would fall through to the OS in
   * that view alone — a difference invisible until someone clicked.
   */
  it("does not let a caller shadow the anchor", () => {
    expect(MARKDOWN).toMatch(/components=\{\{ \.\.\.components, a: MarkdownAnchor \}\}/);
  });

  /**
   * ⚠ A RELATIVE HREF MUST NOT REACH `target="_blank"`. `[the questions](intent-capture-questions.md)` was
   * being handed to the OS as a URL — the assistant's own link to its own file, opened in a browser.
   */
  it("routes a relative markdown link to the editor, not the browser", () => {
    expect(MARKDOWN).toMatch(/if \(href && !hasScheme\(href\) && !href\.startsWith\("#"\)\)/);
  });

  /** An external link still leaves with both hardening tokens. */
  it("keeps noreferrer and noopener on the links that do leave", () => {
    expect(MARKDOWN).toMatch(/rel="noreferrer noopener"/);
  });
});

describe("⚠ the click itself", () => {
  /**
   * ⚠ CHECKED BEFORE A TAB APPEARS. `files:stat` resolves symlinks and returns null for anything outside the
   * project or absent from disk, so a mention that survived the lexical check and still points nowhere real
   * is caught here instead of opening an empty editor.
   */
  it("asks whether the file is really there, and says so when it is not", () => {
    const open = MENTIONS.slice(MENTIONS.indexOf("async function open()"), MENTIONS.indexOf("return (\n    <button"));
    expect(open, "stat first").toMatch(/api\.statFile\(path\)/);
    expect(open, "refuse out loud").toMatch(/toast\.error\(/);
    expect(open, "and only then open").toMatch(/openFile\(path\)/);
  });

  /**
   * ⚠ A BUTTON, NOT AN ANCHOR. It opens a tab in this window; an anchor would be announced as a link and
   * would offer a context menu of things it cannot do ("Open in New Tab", "Copy Link Address").
   */
  it("is a button", () => {
    expect(MENTIONS).toMatch(/<button\s+type="button"\s+onClick=\{\(\) => void open\(\)\}/);
  });

  /** Dotted for "opens here", solid for "leaves the app" — the one difference a participant can see. */
  it("does not look like an external link", () => {
    expect(MENTIONS).toMatch(/decoration-dotted/);
  });

  /** Nothing to open, or not ours to open: the words stay, the affordance goes. */
  it("degrades to plain text rather than an inert control", () => {
    expect(MENTIONS).toMatch(/if \(!target \|\| !onOpenFile\) return <>\{children\}<\/>/);
  });
});

describe("⚠ the regression the rehype pass would have caused", () => {
  /**
   * `KiroChatView`'s `code` component derived its copy payload and its inline-vs-block test from
   * `String(children)`. A mention inside an inline span makes one child a React element, and `String()` of
   * that is "[object Object]" — a copy button that copies nothing, silently. `hastText` reads the span's
   * actual text out of the node instead.
   */
  it("no longer stringifies React children to read a code span", () => {
    expect(KIRO).toMatch(/const codeString = hastText\(node\)/);
    expect(KIRO).not.toMatch(/String\(children\)/);
  });
});

describe("⚠ team chat, which is the same meaning through a different renderer", () => {
  /**
   * ⚠ THE THING TO PROTECT HERE IS THAT IT STAYED PLAIN TEXT. A teammate's message is rendered as the string
   * they typed, deliberately — an asterisk means an asterisk. Reaching for `AssistantMarkdown` would have
   * been the quick way to get mentions and would have turned every message into markdown along with it.
   */
  it("splits the plain string rather than rendering it as markdown", () => {
    expect(TEAM).toMatch(/import \{ FileMentions \} from "\.\/FileMentions"/);
    expect(TEAM).toMatch(/<FileMentions text=\{msg\.content\} \/>/);
    expect(TEAM, "no markdown renderer reached this view").not.toMatch(/AssistantMarkdown|ReactMarkdown/);
  });

  /** The same control as the AI chats, from the same module — not a second copy of the rules. */
  it("uses the shared control", () => {
    expect(MENTIONS).toMatch(/export function FileMentions/);
    expect(MENTIONS).toMatch(/<FileMentionLink key=\{mention\.start\}/);
  });

  /**
   * ⚠ TEAM CHAT IS REACHABLE WITH NO FOLDER OPEN — it is the one chat that does not need one. An empty root
   * makes `mentionTargetPath` refuse everything, so the "no project" case needs no branch of its own.
   */
  it("is wrapped in a scope that tolerates having no project open", () => {
    const scope = APP.slice(APP.indexOf('case "team-chat":'), APP.indexOf('case "account":'));
    expect(scope).toMatch(/<FileMentionScope root=\{activeProject\?\.path \?\? ""\} onOpenFile=\{handleOpenFile\}>/);
    expect(scope).toContain("<TeamChatView />");
  });

  /**
   * ⚠ NO ACCENT ON THIS SURFACE, and it is a contrast decision rather than a stylistic one. A mention can
   * land in the participant's OWN bubble — a saturated `brand-strong` fill with white text — and the same
   * component renders both sides of the conversation.
   */
  it("does not tint the control on a surface that has two fills", () => {
    const scope = APP.slice(APP.indexOf('case "team-chat":'), APP.indexOf('case "account":'));
    expect(scope).not.toMatch(/accent=/);
  });
});
