// ── ⚠ ONE MARKDOWN RENDERER FOR EVERY AI REPLY, SO A LINK CANNOT MEAN TWO THINGS ─────────
//
// The recognition lives in `lib/file-mentions.ts` and the clickable control in `FileMentions.tsx`, both
// tested there. What lives HERE is how markdown reaches that control — and the one rule that keeps it
// reachable from every site.
//
// ── ⚠ WHY EVERY `<ReactMarkdown>` IN THE CHAT VIEWS NOW GOES THROUGH THIS ──
//
// There were SIX bare `<ReactMarkdown>{content}</ReactMarkdown>` call sites across the two views — the saved
// turn, the streaming turn, Codex's bubble, Kiro's turn, and both shared-chat viewers. A mention becomes an
// anchor with a custom scheme (`file-mention:`), so a site that renders markdown WITHOUT the matching `a`
// component would hand `file-mention:spec.md` to the OS as a URL. That is not a difference anyone would spot
// in review, so the choice is removed: this component owns the plugin, the `a`, and the sanitiser together,
// and `a` is applied AFTER the caller's own components so it cannot be shadowed by accident.
//
// ── ⚠ AND WHY A MENTION IS AN ANCHOR AT ALL, RATHER THAN A COMPONENT IN THE TREE ──
//
// The rehype pass could emit a custom tagName and have this file map it. It emits an `a` under the
// `file-mention:` scheme instead, so react-markdown's own URL sanitiser still sees every link in a reply —
// `defaultUrlTransform` is what blanks a `javascript:` href, and adding one protocol must not cost it. See
// `mentionUrlTransform` below; the check on the CLICK is documented with the button, in FileMentions.tsx.

import { type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { MENTION_SCHEME, rehypeFileMentions } from "../lib/file-mentions";
/**
 * ⚠ THE CONTROL ITSELF LIVES IN `FileMentions.tsx`, and so does the scope. TEAM CHAT needs the identical
 * button — same resolution, same existence check, same refusals — but has no markdown pipeline to reach it
 * through, so the control could not stay behind this file's `a`. See that module's header.
 */
import { FileMentionLink } from "./FileMentions";

/** `mailto:`, `https:`, `tel:` … anything with a scheme is somebody else's to open. */
function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * The one `a` in an AI reply.
 *
 * Three kinds of href reach it, and each has exactly one right answer:
 *   `file-mention:…` — a path the rehype pass found in prose. Opens here.
 *   a relative href — a real markdown link the assistant wrote, `[the questions](intent-capture-questions.md)`.
 *     ⚠ THIS USED TO GO TO THE BROWSER. `target="_blank"` on a relative path asks the OS to open
 *     "intent-capture-questions.md" as a URL, which is a wrong answer nobody had noticed.
 *   anything with a scheme — http(s), mailto. Leaves the app, with both hardening tokens.
 */
function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  if (href?.startsWith(MENTION_SCHEME)) {
    return <FileMentionLink raw={href.slice(MENTION_SCHEME.length)}>{children}</FileMentionLink>;
  }

  if (href && !hasScheme(href) && !href.startsWith("#")) {
    return <FileMentionLink raw={href}>{children}</FileMentionLink>;
  }

  return (
    <a
      href={href}
      /* Participant- and model-supplied content, so both tokens — see PhasesView's links. */
      rel="noreferrer noopener"
      target="_blank"
      /* No colour of its own: the surrounding `prose` already styles links, and this keeps the ONE visual
         difference between the two kinds the underline — solid leaves the app, dotted opens a tab. */
      className="underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/**
 * ⚠ THE SANITISER IS EXTENDED, NOT REPLACED. `react-markdown` runs `defaultUrlTransform` over every href and
 * blanks anything outside http/https/mailto/tel — which is what stops a reply from shipping a
 * `javascript:` link, and is worth keeping. Our own scheme is the one addition, and it is matched exactly.
 */
function mentionUrlTransform(url: string): string {
  return url.startsWith(MENTION_SCHEME) ? url : defaultUrlTransform(url);
}

/**
 * An assistant's markdown, with the file names in it clickable.
 *
 * `components` is merged UNDER the anchor on purpose (see the header): a caller may restyle tables, code and
 * headings — Kiro's transcript does all three — but may not take over `a` and quietly break the scheme.
 */
export function AssistantMarkdown({
  content,
  components,
  remarkPlugins,
}: {
  content: string;
  components?: Components;
  remarkPlugins?: ComponentProps<typeof ReactMarkdown>["remarkPlugins"];
}) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={[rehypeFileMentions]}
      urlTransform={mentionUrlTransform}
      components={{ ...components, a: MarkdownAnchor }}
    >
      {content}
    </ReactMarkdown>
  );
}
