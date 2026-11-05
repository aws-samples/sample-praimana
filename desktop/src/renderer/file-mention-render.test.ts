// ── ⚠ THE ONE TEST THAT RENDERS THE REAL PIPELINE ────────────────────────────────────────
//
// Everything else about this feature is asserted a level below the truth: `file-mentions.test.ts` builds hast
// trees by hand, and `file-mention-wiring.test.ts` reads the source as text. Neither would notice the failure
// that actually matters — `react-markdown` silently declining to honour the pieces.
//
// The specific things only a real render can prove:
//
//   ⚠ THE CUSTOM SCHEME SURVIVES `urlTransform`. `defaultUrlTransform` blanks any href outside
//     http/https/mailto/tel. If our extension of it were wrong, every mention would arrive at the anchor
//     with an EMPTY href — and would render as ordinary text, feature silently absent.
//
//   ⚠ THE PLUGIN RUNS AT ALL, in the order and on the tree react-markdown actually hands it.
//
//   ⚠ AND A CODE FENCE STILL COPIES. Kiro's `code` component reads its payload from the hast node now; a
//     mistake there is invisible until a participant presses Copy and gets nothing.
//
// `createElement` rather than JSX because this package's vitest only collects `*.test.ts` (see
// vitest.config.ts) — and `renderToStaticMarkup` needs no DOM, which is why the suite can stay in `node`.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "./components/AssistantMarkdown";
import { FileMentionScope, FileMentions } from "./components/FileMentions";
import { ToastProvider } from "./components/Toast";
import { hastText } from "./lib/file-mentions";

const ROOT = "/Users/me/projects/acme";

/** One assistant reply, rendered exactly as the transcript renders it. */
function render(content: string, { root = ROOT, clickable = true } = {}): string {
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(
        FileMentionScope,
        { root, onOpenFile: clickable ? () => {} : undefined, accent: "text-claude-accent" },
        createElement(AssistantMarkdown, { content })
      )
    )
  );
}

describe("⚠ the motivating sentence, rendered", () => {
  const html = render("I created 5 Intent Capture questions at intent-capture-questions.md");

  it("becomes a button that opens the file", () => {
    expect(html).toContain("<button");
    expect(html).toContain(">intent-capture-questions.md</button>");
  });

  /** The tooltip carries the resolved path — the folder is what disambiguates two files of one name. */
  it("names the resolved path for the pointer", () => {
    expect(html).toContain(`title="Open ${ROOT}/intent-capture-questions.md"`);
  });

  it("keeps the words around it intact", () => {
    expect(html).toContain("I created 5 Intent Capture questions at ");
  });

  /** Not an anchor: it opens a tab in this window, and must not be announced or right-clicked as a link. */
  it("is not a link", () => {
    expect(html).not.toContain("<a ");
  });
});

describe("⚠ a markdown link the assistant wrote itself", () => {
  /**
   * ⚠ THIS IS THE ONE THAT USED TO REACH THE BROWSER. `target="_blank"` on a relative href asks the OS to
   * open "intent-capture-questions.md" as a URL.
   */
  it("opens in the editor, not a browser window", () => {
    const html = render("see [the questions](intent-capture-questions.md)");
    expect(html).toContain("<button");
    expect(html).toContain(">the questions</button>");
    expect(html).not.toContain('target="_blank"');
  });

  it("still sends a real URL out, hardened", () => {
    const html = render("see [the docs](https://example.com/spec.md)");
    expect(html).toContain('href="https://example.com/spec.md"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  /** A `javascript:` href is still blanked — the sanitiser was extended, not replaced. */
  it("does not let a model-supplied script URL through", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:alert");
  });
});

describe("⚠ where a mention must NOT appear", () => {
  it("leaves a fenced code block as literal text", () => {
    const html = render("```\ncat docs/spec.md\n```");
    expect(html).not.toContain("<button");
    expect(html).toContain("cat docs/spec.md");
  });

  it("leaves the text of an existing link alone", () => {
    const html = render("[docs/spec.md](https://example.com)");
    expect(html).not.toContain("<button");
  });

  /** No project, or nowhere to send the click: the words stay, the affordance does not. */
  it("renders plain text when the shell offered no way to open a file", () => {
    expect(render("wrote docs/spec.md", { clickable: false })).not.toContain("<button");
    expect(render("wrote docs/spec.md", { root: "" })).not.toContain("<button");
  });

  /**
   * ⚠ NOT OURS TO OPEN. An absolute path from another checkout is how a SHARED conversation arrives, and
   * `mentionTargetPath` refuses it before any click can be offered.
   */
  it("renders plain text for an absolute path outside the project", () => {
    const html = render("wrote /Users/someone-else/proj/docs/spec.md");
    expect(html).not.toContain("<button");
    expect(html).toContain("/Users/someone-else/proj/docs/spec.md");
  });
});

describe("⚠ an inline code span, which is how a path is usually written", () => {
  const html = render("see `src/renderer/App.tsx` for the shell");

  it("is clickable inside the span", () => {
    expect(html).toContain("<code");
    expect(html).toContain("<button");
  });

  it("keeps the code span around it", () => {
    expect(html).toMatch(/<code[^>]*>.*<button[\s\S]*?<\/button>.*<\/code>/);
  });
});

describe("⚠ the hast node react-markdown hands a custom code component", () => {
  /**
   * ⚠ THE ASSUMPTION KIRO'S COPY BUTTON NOW RESTS ON. `KiroChatView`'s `code` component reads its payload
   * with `hastText(node)` instead of `String(children)` — see the note there. If react-markdown stopped
   * passing `node`, that expression would quietly become `""`: a Copy button that copies nothing, and an
   * inline-vs-block test that always says "inline". Neither would throw, so it is asserted here.
   *
   * Kiro's own renderer is not exported, so this stands in for it with the same expression.
   */
  it("carries the span's real text, mention and all", () => {
    const seen: string[] = [];
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(
          FileMentionScope,
          { root: ROOT, onOpenFile: () => {} },
          createElement(AssistantMarkdown, {
            content: "see `src/App.tsx` now",
            components: {
              code({ node, children }: any) {
                seen.push(hastText(node));
                return createElement("code", null, children);
              },
            } as any,
          })
        )
      )
    );

    expect(seen, "the node arrived and still knows what it says").toEqual(["src/App.tsx"]);
    expect(html, "and the mention inside it is still clickable").toContain("<button");
  });
});

describe("⚠ team chat: the same meaning, rendered from a plain string", () => {
  /** Team chat has no markdown pipeline; `FileMentions` splits the string the teammate typed. */
  function team(text: string, { root = ROOT } = {}): string {
    return renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(
          FileMentionScope,
          { root, onOpenFile: () => {} },
          createElement(FileMentions, { text })
        )
      )
    );
  }

  it("makes a relative path a button and opens YOUR copy", () => {
    const html = team("pushed my answers to docs/intent-capture-questions.md");
    expect(html).toContain("<button");
    expect(html).toContain(`title="Open ${ROOT}/docs/intent-capture-questions.md"`);
    expect(html).toContain("pushed my answers to ");
  });

  /**
   * ⚠ THE MESSAGE IS NOT MARKDOWN AND MUST NOT BECOME IT. A teammate typing asterisks, backticks or a
   * pipe table means those characters — reaching for the markdown renderer to get mentions would have
   * silently changed every message in the room.
   */
  it("leaves markdown syntax as the characters they typed", () => {
    const html = team("**not bold** and `not code` and # not a heading");
    expect(html).toContain("**not bold**");
    expect(html).toContain("`not code`");
    expect(html).toContain("# not a heading");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<code>");
    expect(html).not.toContain("<h1>");
  });

  /**
   * ⚠ A TEAMMATE'S ABSOLUTE PATH IS NOT A PATH ON THIS MACHINE. Guessing which of ours they meant — by
   * matching the folder name, say — would open the wrong file silently, so it stays text.
   */
  it("refuses an absolute path from somebody else's checkout", () => {
    const html = team("see /Users/priya/projects/acme/docs/spec.md");
    expect(html).not.toContain("<button");
    expect(html).toContain("/Users/priya/projects/acme/docs/spec.md");
  });

  /** Team chat is reachable with no folder open, and then there is nothing to resolve against. */
  it("is inert with no project open", () => {
    expect(team("see docs/spec.md", { root: "" })).not.toContain("<button");
  });

  it("handles several mentions and the words between them", () => {
    const html = team("split it across plan.md and questions.md, then src/App.tsx");
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain(" and ");
    expect(html).toContain(", then ");
  });

  /** The overwhelmingly common message has no mention in it and must cost nothing. */
  it("returns an ordinary message untouched", () => {
    expect(team("morning all, standup in 5")).toBe("morning all, standup in 5");
  });
});
