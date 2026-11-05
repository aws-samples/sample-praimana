// ── ⚠ EVERY DESKTOP COMPOSER HAS A CEILING, FROM THE SHARED CONSTANTS ────────────────────
//
// WHY: the AI-chat and team-chat input boxes need a maximum text length, and none was set. The portal's team
// chat had a `maxLength` and a live counter; all three DESKTOP
// composers had neither, so the desktop was the client that walked around the limit.
//
// ⚠ THE NUMBERS LIVE IN `@praimana/shared`, NOT HERE, and that is the point of the exercise.
// Two copies of a length limit is how a client that truncates at 4,096 ends up talking to a server
// that refuses at 4,000 — the portal's own `chat-limits.ts` says so, and it now re-exports from
// shared for exactly that reason.
//
// ⚠ WHAT `maxLength` IS NOT. It is not enforcement. Any client can decline to honour it, and the
// collaboration service still stores team-chat `content` with no length check at all (backlog 8d).
// These tests pin that the desktop is WELL-BEHAVED; they do not claim the platform is CONSTRAINED.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_AI_PROMPT_CHARS, MAX_TEAM_MESSAGE_CHARS } from "@praimana/shared";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (name: string) =>
  strip(readFileSync(join(__dirname, "components", `${name}.tsx`), "utf8"));

/** Which ceiling each composer must use. The pairing is the substance of these tests. */
const COMPOSERS = [
  ["AssistantChatView", "MAX_AI_PROMPT_CHARS"],
  ["KiroChatView", "MAX_AI_PROMPT_CHARS"],
  ["TeamChatView", "MAX_TEAM_MESSAGE_CHARS"],
] as const;

describe("⚠ all three desktop composers bound their input", () => {
  it.each(COMPOSERS)("%s sets maxLength from %s", (view, constant) => {
    const src = read(view);
    expect(src, "the constant is imported from shared").toMatch(
      new RegExp(`import \\{ ${constant} \\} from "@praimana/shared"`)  // nosemgrep: detect-non-literal-regexp
    );
    expect(src, "and applied to the composer").toContain(`maxLength={${constant}}`);
  });

  /**
   * ⚠ NO LITERAL NUMBERS. A hardcoded `maxLength={4000}` would read identically and be the second
   * copy of a value that must agree with tRPC and with the service — which is the whole reason these
   * constants were moved into the shared package.
   */
  it.each(COMPOSERS)("%s hardcodes no ceiling of its own", (view) => {
    expect(read(view)).not.toMatch(/maxLength=\{\s*\d+\s*\}/);
  });

  /**
   * ⚠ AN AI PROMPT IS NOT A CHAT MESSAGE, and using one number for both was the tempting mistake.
   * Pasting a diff or a stack trace is the normal use of a prompt; 4,000 characters would refuse it.
   * Asserted against the real values so the pairing cannot be quietly swapped.
   */
  it("gives the AI composers the larger ceiling and team chat the smaller one", () => {
    expect(MAX_AI_PROMPT_CHARS).toBeGreaterThan(MAX_TEAM_MESSAGE_CHARS);
    expect(read("TeamChatView")).not.toContain("MAX_AI_PROMPT_CHARS");
    for (const view of ["AssistantChatView", "KiroChatView"]) {
      expect(read(view)).not.toContain("MAX_TEAM_MESSAGE_CHARS");
    }
  });
});

describe("⚠ the remaining count is visible before the limit bites", () => {
  it.each(COMPOSERS)("%s renders a CharCounter", (view, constant) => {
    const src = read(view);
    expect(src).toMatch(/import \{ CharCounter \} from "\.\/CharCounter"/);
    expect(src, "fed the same ceiling as the input").toContain(`max={${constant}}`);
  });

  /**
   * ⚠ ONE COMPONENT, NOT THREE COPIES — a direct response to the night's other bugs. The sync badge,
   * the copy button and the "Shared" label were each written once, wired into AssistantChatView, and never into
   * KiroChatView; three separate reports came from that one habit. A counter pasted into three action
   * rows would have been the fourth.
   */
  it("shares one counter component rather than reimplementing it per view", () => {
    for (const [view] of COMPOSERS) {
      const src = read(view);
      expect(src, `${view} must not compute its own remaining count`).not.toMatch(
        /(MAX_AI_PROMPT_CHARS|MAX_TEAM_MESSAGE_CHARS)\s*-\s*\w+\.length/
      );
    }
  });

  const counter = strip(readFileSync(join(__dirname, "components", "CharCounter.tsx"), "utf8"));

  it("stays silent until the limit is close", () => {
    /**
     * ⚠ THE THRESHOLD MUST BE IN THE GUARD, not merely imported. A first version asserted that
     * `SHOW_REMAINING_WITHIN` appeared anywhere and that a `return null` existed anywhere — both of
     * which stayed true when the mutation reduced the condition to `if (hidden) return null`, making
     * the counter permanently visible. The suite passed on a counter that measures every one-line
     * message in front of the user. The condition itself is the thing to pin.
     */
    expect(counter, "the early return is gated on the threshold").toMatch(
      /if \([^)]*SHOW_REMAINING_WITHIN[^)]*\)\s*return null/
    );
  });

  /**
   * ⚠ A LIVE REGION. This is the one hint that changes as you type; without it a screen-reader user
   * reaches the cap with no warning and no explanation for why the send button stopped responding.
   */
  it("announces the count to assistive tech", () => {
    expect(counter).toMatch(/role="status"/);
    expect(counter).toMatch(/aria-live="polite"/);
  });

  /** At the ceiling it says what is wrong, rather than restating the count as "0 left". */
  it("says what is wrong at the limit instead of showing a zero", () => {
    expect(counter).toMatch(/Message is too long/);
  });
});
