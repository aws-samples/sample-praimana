// ── ⚠ THE ASSISTANT TAB SAYS WHEN IT IS BLOCKED, NOT ONLY WHEN IT REPLIED ───────────────────────
//
// A prompt blocks the turn — `session/prompt` does not resolve until it is answered — so a participant who
// switched to Board or Team Chat had no way to know the assistant was waiting on them. The unread mechanism
// already solved the adjacent problem for replies; this is the same delivery with three deliberate
// differences, and the differences are what these cases pin.
//
// ⚠ ASSERTED AGAINST THE SOURCE. The signal crosses three files by a window event — two chat views, the hook,
// the rail — and "the badge appears when a prompt is outstanding" is a property of that wiring rather than of
// any one render. Same technique the sibling suites use for rules that live in more than one file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(local(rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");

const HOOK = read("./hooks/useTeamUnread.ts");
const SIDEBAR = read("./components/Sidebar.tsx");
const APP = strip(read("./App.tsx"));
const KIRO = strip(read("./components/KiroChatView.tsx"));
const ASSISTANT = strip(read("./components/AssistantChatView.tsx"));

describe("⚠ both chat views announce a blocked turn", () => {
  /**
   * ⚠ DERIVED FROM STATE, NOT DISPATCHED AT EACH CALL SITE. A prompt appears or clears in several places —
   * the request arrives, the turn ends, the agent exits, it errors, and three buttons — and an event beside
   * each is the shape that has produced a differential bug in this codebase every time one sibling was
   * updated and the other was not. Watching `permissionBySession` covers a new call site by construction.
   */
  for (const [name, src] of [
    ["KiroChatView", KIRO],
    ["AssistantChatView", ASSISTANT],
  ] as const) {
    it(`${name} derives the signal from permissionBySession`, () => {
      expect(src, "one effect, not per-call-site dispatches").toMatch(
        /Object\.keys\(permissionBySession\)\.length > 0/
      );
      expect(src).toContain('"ai:permission-pending"');
      expect(src).toContain('"ai:permission-resolved"');
    });
  }

  /** Both paths, because either can be the mounted one — App picks on `useAcpMode`. */
  it("covers both assistant paths", () => {
    expect(APP).toMatch(/useAcpMode \?/);
    for (const src of [KIRO, ASSISTANT]) {
      expect(src).toContain("ai:permission-pending");
    }
  });
});

describe("⚠ the hook tracks it as a state, not a count", () => {
  it("exposes a boolean beside the counts", () => {
    expect(HOOK).toMatch(/awaitingPermission: boolean/);
    expect(HOOK).toMatch(/return \{ counts, awaitingPermission \}/);
  });

  it("listens for both edges", () => {
    expect(HOOK).toContain('window.addEventListener("ai:permission-pending"');
    expect(HOOK).toContain('window.addEventListener("ai:permission-resolved"');
    expect(HOOK, "and removes them").toMatch(/removeEventListener\("ai:permission-pending"/);
  });

  /**
   * ⚠ THE ONE RULE THAT DIFFERS FROM EVERY COUNT IN THAT FILE. `VIEW_FOR_APP` clears a surface's count when
   * its tab opens, which is right for "you have unread messages" and wrong here: opening the tab shows the
   * question, answering it is what unblocks the turn. Clearing on sight would hide a still-blocked turn the
   * moment the user switched away again — the exact case the badge exists for.
   */
  it("⚠ does NOT clear when the tab is opened", () => {
    const code = strip(HOOK);
    const clearOnView = code.slice(code.indexOf("VIEW_FOR_APP[view]"), code.indexOf("setBadgeCount"));
    expect(clearOnView, "the tab-open reset must not touch it").not.toContain("setAwaitingPermission");
    // It clears on the resolved EVENT instead.
    expect(code).toMatch(/onResolved = \(\) => setAwaitingPermission\(false\)/);
  });

  /**
   * ⚠ IT CHIMES, DELIBERATELY, AND ONLY ON THE EDGE.
   *
   * This case previously asserted SILENCE, on the reasoning that a prompt raised by work the user just asked
   * for is not news and that one sound per shell command in an AI-DLC run is prompt fatigue in another form.
   * That objection had already weakened, because "Allow for this chat" turns a five-prompt run into one.
   *
   * ⚠ THE EDGE IS THE PART WORTH PINNING. The dispatching effect fires on every `permissionBySession`
   * change, so two chats each raising a prompt would re-announce a state that was already true. The sound
   * has to follow the false→true TRANSITION, not the event.
   *
   * ⚠ ANCHORED ON THE EFFECT, NOT ON A CHARACTER WINDOW. A first version of this case sliced backwards from
   * the event name and caught the `ai:response-complete` handler above it, which chimes correctly. An
   * assertion whose subject depends on how far back it happens to reach is not asserting anything.
   */
  it("⚠ chimes on the transition only, and not while the tab is open", () => {
    const code = strip(HOOK);
    const effect = code.slice(code.indexOf("const onPending"), code.indexOf("const onPending") + 900);

    expect(effect, "sanity: the right block").toContain('"ai:permission-pending"');
    expect(effect, "it does chime now").toContain("playChime");
    expect(effect, "on the false->true edge, not on every event").toMatch(/if \(!was &&/);
    expect(effect, "and not when the prompt is already on screen").toContain(
      'viewRef.current !== "chat"'
    );
    expect(effect, "the preference gates it, like every other chime here").toContain(
      'getSetting("notify_sound")'
    );
  });
});

describe("⚠ the rail shows it distinctly from unread", () => {
  it("marks only the assistant tab as blockable", () => {
    expect(SIDEBAR).toMatch(/blocked: awaitingPermission/);
    const items = SIDEBAR.slice(SIDEBAR.indexOf("const navItems"), SIDEBAR.indexOf("⚠ NO \"Explorer\" ITEM"));
    expect((items.match(/blocked:/g) ?? []).length, "the team surfaces have nothing to approve").toBe(1);
  });

  /**
   * ⚠ A GLYPH INSTEAD OF THE COUNT, not beside it. `session/prompt` does not resolve until answered, so
   * there is never a second question — and two badges on one 48px collapsed icon is where the rail stops
   * being readable. "Answer me" outranks "read me".
   */
  it("⚠ renders instead of the unread count, and is not a number", () => {
    expect(SIDEBAR).toMatch(/\(item as any\)\.blocked \?/);
    const badge = SIDEBAR.slice(SIDEBAR.indexOf("(item as any).blocked ?"), SIDEBAR.indexOf("(item as any).badge > 0"));
    expect(badge, "a glyph, not a count").toContain("!");
    expect(badge, "and it is announced").toMatch(/aria-label="Waiting for your permission"/);
  });

  /**
   * ⚠ `tool-warning`, NOT `tool-error`. tailwind.config.ts records that `tool-error` is 3.87:1 — legal as a
   * graphical indicator and ILLEGAL as text — and this badge contains a character.
   */
  it("⚠ uses the token that is legal behind text", () => {
    const badge = SIDEBAR.slice(SIDEBAR.indexOf("(item as any).blocked ?"), SIDEBAR.indexOf("(item as any).badge > 0"));
    expect(badge).toContain("bg-tool-warning");
    expect(badge, "tool-error fails contrast for a glyph").not.toContain("bg-tool-error");
  });

  /** It has to survive collapsing — the rail is where somebody glances. */
  it("positions in the icon corner when collapsed, like the unread count", () => {
    const badge = SIDEBAR.slice(SIDEBAR.indexOf("(item as any).blocked ?"), SIDEBAR.indexOf("(item as any).badge > 0"));
    expect(badge).toContain("absolute right-0.5 top-0.5");
  });
});
