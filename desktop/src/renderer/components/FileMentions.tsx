// ── ⚠ A FILE NAME SOMEBODY WROTE, AS A CONTROL THAT OPENS IT ─────────────────────────────
//
// ── ⚠ WHY THIS SPLIT OUT OF `AssistantMarkdown.tsx` ──
//
// The two surfaces do not share a rendering path, only a MEANING:
//
//   AI chat is markdown. A rehype pass finds mentions in the tree and parks them on an anchor, because a
//     regex over the markdown source cannot tell prose from a fenced code block.
//
//   Team chat is a plain string — `{msg.content}` straight into a div, no markdown, deliberately (a teammate
//     typing an asterisk means an asterisk). There is no tree to walk, so the text is split directly.
//
// Both then need the identical control: the same resolution rules, the same existence check, the same
// refusals, the same styling. Keeping that control here — rather than in the file named for assistant
// markdown — is what stops team chat from growing a second, drifting copy of it. That drift is a real habit in
// this codebase, not a hypothetical: see `chat-view-parity.test.ts`'s header, and `kiro-acp.ts`'s private copy
// of `syncToServer` that missed two fixes.

import { createContext, useContext, type ReactNode } from "react";
import { findFileMentions, mentionTargetPath } from "../lib/file-mentions";
import { basenameOf } from "../lib/file-tree-ops";
import { useToast } from "./Toast";

/**
 * ⚠ LOOKED UP ON THE CLICK, NOT AT MODULE LOAD — the one deviation from the `const api = (window as any)
 * .electronAPI` line every other component opens with.
 *
 * That line runs when the module is IMPORTED, which makes importing this file outside a browser a crash. It
 * is imported outside a browser on purpose: `file-mention-render.test.ts` renders the real markdown pipeline
 * through `renderToStaticMarkup` to prove the custom scheme survives react-markdown's own URL sanitiser,
 * which is the one thing neither the unit tests nor the source-text tests can see. A function defers the
 * lookup to the moment there is something to look up.
 */
function desktopApi(): any {
  return (globalThis as { window?: { electronAPI?: any } }).window?.electronAPI;
}

export interface FileMentionScopeValue {
  /** The open project's root. Every mention resolves against this or not at all. */
  root: string;
  /** Where a click goes. Absent (or absent provider) means mentions render as ordinary text. */
  onOpenFile?: (path: string) => void;
  /**
   * Ink for the control, when the surface has a colour to lend it.
   *
   * ⚠ TEAM CHAT PASSES NOTHING, ON PURPOSE. A mention can land in the participant's OWN bubble, which is a
   * saturated `brand-strong` fill carrying WHITE text — an accent that is legal on the dark panel is not
   * legal there, and the same message can appear in either. Inheriting (`text-current`) keeps the words at
   * whatever contrast the bubble already guarantees, and leaves the dotted underline to say "clickable".
   */
  accent?: string;
}

const FileMentionContext = createContext<FileMentionScopeValue | null>(null);

/**
 * Makes file mentions clickable for everything rendered inside.
 *
 * ⚠ A CONTEXT AND NOT A PROP, for the reason `PanePinProvider` is one: the markdown renderer is reached
 * through `renderBlocks` (a module function), through Kiro's turn component, and through two shared-chat
 * dialogs. Threading `onOpenFile` to all of them would touch every signature in between, and the one that
 * got missed would silently lose the feature — which is exactly the failure `chat-view-parity.test.ts`
 * exists to stop.
 *
 * ⚠ NO PROVIDER IS A LEGAL STATE, and it renders plain text. `PhasesView` and the file preview render
 * markdown too; a mention there is not a promise anybody made.
 */
export function FileMentionScope({
  root,
  onOpenFile,
  accent,
  children,
}: FileMentionScopeValue & { children?: ReactNode }) {
  return (
    <FileMentionContext.Provider value={{ root, onOpenFile, accent }}>{children}</FileMentionContext.Provider>
  );
}

/**
 * A file somebody named, as a control that opens it here.
 *
 * ⚠ A `<button>`, NOT AN `<a>`. It does not navigate: it opens a tab in this window. An anchor would offer a
 * context menu full of lies ("Open in New Tab", "Copy Link Address") and would be announced as a link to a
 * screen reader — a button is what "does something in this app" means to both.
 */
export function FileMentionLink({ raw, children }: { raw: string; children: ReactNode }) {
  const scope = useContext(FileMentionContext);
  const toast = useToast();
  const target = scope?.root ? mentionTargetPath(scope.root, raw) : null;

  /*
    Not ours to open, or nowhere to open it: the words stay, the affordance does not. See
    `mentionTargetPath` for what gets refused — chiefly absolute paths from another checkout, which is how a
    TEAMMATE's message arrives. Their `/Users/them/proj/spec.md` is not a file on this machine, and guessing
    which of ours they meant (by matching the folder name, say) would open the wrong file silently.
  */
  const onOpenFile = scope?.onOpenFile;
  if (!target || !onOpenFile) return <>{children}</>;

  /*
    Re-bound after the guard rather than used through the optional chain: `open` is a hoisted declaration, so
    TypeScript will not carry the narrowing above into it, and `target!` would be a claim rather than a check.
  */
  const path = target;
  const openFile = onOpenFile;

  async function open() {
    /*
      ⚠ `statFile` IS THE EXISTENCE CHECK AND THE CONFINEMENT CHECK AT ONCE. `files:stat` resolves symlinks
      and returns `null` for anything outside the project or not on disk, so a mention that survived the
      lexical check and still points nowhere real is caught here — before an empty editor tab appears.

      ⚠ AND IT EARNS ITS KEEP IN TEAM CHAT. A relative path a teammate wrote resolves cleanly against YOUR
      root whether or not you have that file, so this is the only thing standing between "they mentioned a
      file you have not got" and a blank editor tab.
    */
    const api = desktopApi();
    const stamp = api?.statFile ? await api.statFile(path).catch(() => null) : true;
    if (!stamp) {
      toast.error(`${basenameOf(path)} is not in this project`);
      return;
    }
    openFile(path);
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      /*
        ⚠ A DOTTED UNDERLINE, WHERE AN EXTERNAL LINK GETS A SOLID ONE. The two do genuinely different things
        — one opens a tab beside the transcript, the other leaves the app for a browser — and a participant
        deciding whether to click deserves to be able to tell which. The accent comes from the answering
        assistant (`assistant-theme.ts`), every one of which is documented legal as text on these surfaces;
        `text-current` is the fallback, and the one team chat uses — see `accent` on the scope.
      */
      className={`cursor-pointer underline decoration-dotted decoration-1 underline-offset-2 hover:decoration-solid ${
        scope?.accent ?? "text-current"
      }`}
      /* The full path, for a name that appears twice in a project — the tooltip is where the folder lives. */
      title={`Open ${path}`}
    >
      {children}
    </button>
  );
}

/**
 * One run of PLAIN text, with any file names in it clickable.
 *
 * For surfaces that are not markdown — team chat, whose messages are rendered as the string the teammate
 * typed. The AI chats do not use this: their mentions are found in the hast tree instead, because only the
 * tree can say which text is prose and which is a code fence (see `rehypeFileMentions`).
 *
 * ⚠ RETURNS THE STRING UNTOUCHED WHEN THERE IS NOTHING IN IT, which is nearly every message. No wrapper
 * element, no extra span — the surrounding bubble's own text rendering is unchanged for the common case.
 */
export function FileMentions({ text }: { text: string }) {
  const mentions = findFileMentions(text);
  if (mentions.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const mention of mentions) {
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(
      /* Keyed on the offset: mentions never move within a message, and two can share a name. */
      <FileMentionLink key={mention.start} raw={mention.raw}>
        {mention.raw}
      </FileMentionLink>
    );
    cursor = mention.end;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
