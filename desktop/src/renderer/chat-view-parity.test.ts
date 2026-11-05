// ── ⚠ A FEATURE BUILT FOR ONE AI CHAT VIEW MUST EXIST IN BOTH ────────────────────────────
//
// FOUR SYMPTOMS, ONE CAUSE: AI chats not showing as synced, copy missing, and a shared AI chat not showing
// the shared label in the chat history. None was a regression. Every one of those features had been built,
// wired into `AssistantChatView` (Claude/Codex), and
// never into `KiroChatView` — so switching assistant silently dropped three features at once.
//
// ⚠ AND THE SYNC ONE WAS NOT EVEN A MISSING COMPONENT. `db:getMessages` is a `SELECT *` and has
// always returned `sync_status`; `KiroChatView`'s loader hand-picked `id`, `role` and `content`, so
// the value was discarded one line after arriving. The badge could not render for want of one field.
//
// This is the same shape as `kiro-acp.ts`'s private copy of `syncToServer`, which missed two fixes
// for the same reason (backlog 8a/8b). Two implementations of one idea, and the second is always the
// one that goes stale — so parity is asserted mechanically rather than remembered.
//
// ⚠ WHAT THIS FILE DOES NOT CLAIM. It checks that each capability is PRESENT in both views, not that
// they look identical. The two are deliberately different: Kiro's transcript is full-width with ruled
// separators (its own product's layout), Claude's keeps an avatar gutter. Presence is the invariant;
// presentation is not.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (name: string) =>
  strip(readFileSync(join(__dirname, "components", `${name}.tsx`), "utf8"));

const VIEWS = { AssistantChatView: read("AssistantChatView"), KiroChatView: read("KiroChatView") } as const;
const NAMES = Object.keys(VIEWS) as (keyof typeof VIEWS)[];

describe("⚠ per-message sync state exists in both AI chat views", () => {
  it.each(NAMES)("%s renders a SyncBadge", (name) => {
    expect(VIEWS[name]).toMatch(/import \{[^}]*SyncBadge[^}]*\} from "\.\/SyncBadge"/);
    expect(VIEWS[name]).toMatch(/<SyncBadge/);
  });

  /**
   * ⚠ THE FIELD IS THE FIX, NOT THE COMPONENT. Kiro's loader mapped rows by hand and dropped
   * `sync_status`, so the badge would have rendered "unknown" forever even once imported. A view
   * that maps DB rows must carry the column through.
   */
  it.each(NAMES)("%s carries sync_status from the row it loaded", (name) => {
    expect(VIEWS[name], "the message type declares it").toMatch(/sync_status\?: MessageSyncStatus/);
    expect(VIEWS[name], "and the badge is given it").toMatch(/status=\{(msg|message)\.sync_status\}/);
  });

  /**
   * A retry that succeeds must change what the user sees. Without a refresh the row is re-read only
   * on the next session switch, so a working retry still shows "not synced".
   */
  it.each(NAMES)("%s refreshes after a successful retry", (name) => {
    expect(VIEWS[name]).toMatch(/onRetried=\{/);
  });
});

describe("⚠ copy exists on the assistant reply in both AI chat views", () => {
  it.each(NAMES)("%s renders a CopyButton", (name) => {
    expect(VIEWS[name]).toMatch(/import \{ CopyButton \} from "\.\/CopyButton"/);
    expect(VIEWS[name]).toMatch(/<CopyButton/);
  });

  /**
   * ⚠ "BOTH HALVES ARE COPYABLE" WAS WITHDRAWN: copy is removed from the user's own messages. The count
   * assertion this replaces demanded >=2 per view, which Kiro can no longer satisfy — it has exactly one now,
   * on the reply. The ASSISTANT's copy is the half that was always required, so that is what is pinned.
   */
  it.each(NAMES)("%s offers it on the assistant's reply", (name) => {
    expect(VIEWS[name], "the labelled reply control").toMatch(/label="Copy reply"/);
  });
});

describe("⚠ a shared chat says so IN WORDS, in both history lists", () => {
  /**
   * ⚠ THE DOT WAS THE BUG. `shared_at` was marked with a 1.5px `bg-tool-ok` circle — the same size
   * and colour as the streaming indicator beside it, differing only by `animate-pulse`. The single
   * most consequential fact about a conversation ("my team can see this") was encoded as a 6px shape
   * ambiguous with "currently generating".
   */
  it.each(NAMES)("%s prints the word Shared", (name) => {
    expect(VIEWS[name]).toMatch(/>\s*Shared\s*</);
  });

  it.each(NAMES)("%s does not mark it with a bare dot", (name) => {
    // The dot form, captured exactly: a 1.5-unit circle in the ok colour with no text.
    expect(VIEWS[name]).not.toMatch(
      /w-1\.5 h-1\.5 rounded-full bg-tool-ok flex-shrink-0" title="Shared/
    );
  });

  /**
   * Colour alone must not carry it either — the label keeps a `title`, so the meaning survives for
   * anyone who cannot distinguish the green.
   */
  it.each(NAMES)("%s names it for assistive tech too", (name) => {
    expect(VIEWS[name]).toMatch(/title="Shared with your team"/);
  });
});

describe("⚠ a file name in a reply is clickable in both AI chat views", () => {
  /**
   * Three assistants, two views — and Kiro's is the one that historically got features last (see this
   * file's header). Claude and Codex share `AssistantChatView`, so pinning both views pins all three.
   */
  it.each(NAMES)("%s renders assistant markdown through AssistantMarkdown", (name) => {
    expect(VIEWS[name]).toMatch(/import \{ AssistantMarkdown \} from "\.\/AssistantMarkdown"/);
    expect(VIEWS[name]).toMatch(/<AssistantMarkdown/);
  });

  /**
   * ⚠ THE FAILURE MODE THIS PINS IS AN OS-LEVEL ONE, not a missing feature. A mention becomes an anchor
   * with a custom `file-mention:` scheme, and a bare `<ReactMarkdown>` has neither the plugin that creates
   * it nor the `a` that honours it — so a reply rendered there would offer `file-mention:spec.md` to the
   * browser. Six sites had to be converted; a seventh added later must not go back.
   */
  it.each(NAMES)("%s has no bare ReactMarkdown left to bypass it", (name) => {
    expect(VIEWS[name]).not.toMatch(/<ReactMarkdown/);
    expect(VIEWS[name]).not.toMatch(/^import ReactMarkdown/m);
  });
});
