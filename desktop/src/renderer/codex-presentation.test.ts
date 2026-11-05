// ── ⚠ CODEX IS NOT CLAUDE WEARING A BADGE ────────────────────────────────────────────────
//
// Two problems: Codex used Claude's activity messages and style rather than a plain "Thinking" with
// animated dots, and there was no space between the user and AI message boxes, which touched.
//
// Both came from Claude-shaped defaults surviving in a view that renders BOTH assistants.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activityStyleFor } from "./components/ActivityPhrase";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const chatView = strip(readFileSync(join(__dirname, "components", "AssistantChatView.tsx"), "utf8"));
const phrase = strip(readFileSync(join(__dirname, "components", "ActivityPhrase.tsx"), "utf8"));

/**
 * JUST the `thinking` branch.
 *
 * ⚠ BOUNDED TO ITS CLOSING BRACE, and mutation testing is why. A first version sliced from
 * `if (style === "thinking")` to the END OF FILE, so every assertion about the variant was also
 * satisfied by the WORD variant that follows it — deleting the thinking branch's live region entirely
 * left the test passing, because it found the other one. The end marker is the `if`'s own closing brace
 * at two-space indent; everything inside is indented further, so it cannot match early.
 */
const thinkingVariant = (() => {
  const start = phrase.indexOf('if (style === "thinking")');
  expect(start, "the thinking branch must exist").toBeGreaterThan(-1);
  const end = phrase.indexOf("\n  }\n", start);
  expect(end, "and it must be a closed block").toBeGreaterThan(start);
  return phrase.slice(start, end);
})();

describe("⚠ the activity indicator matches the assistant", () => {
  /**
   * An earlier round removed only the BRANDED word ("Clauding") from Codex's pool and kept the other 83 —
   * Percolating, Simmering, Flibbertigibbeting. Generic, but still Anthropic's product VOICE, and Codex's
   * own UI does not narrate at all.
   */
  it("gives Claude the rotating words and everyone else Thinking", () => {
    expect(activityStyleFor("Claude")).toBe("words");
    expect(activityStyleFor("Claude Code")).toBe("words");
    expect(activityStyleFor("Codex")).toBe("thinking");
    expect(activityStyleFor("Kiro")).toBe("thinking");
  });

  it("renders the word Thinking and three dots for that variant", () => {
    expect(phrase).toMatch(/"Thinking"/);
    expect(phrase, "three dots").toMatch(/\[0, 1, 2\]\.map/);
    expect(phrase, "coming and going").toMatch(/motion-safe:animate-pulse/);
    expect(phrase, "staggered so they read as a wave").toMatch(/animationDelay/);
  });

  /**
   * ⚠ THE LIVE REGION AND THE CLOCK ARE SHARED, NOT REIMPLEMENTED. Both took real work: an sr-only
   * sentence that announces on 30-second milestones rather than on every tick, and a wall-clock elapsed
   * time that survives Electron throttling a backgrounded window. A separate component for the Codex
   * variant would have been the place both silently regressed.
   */
  it("keeps the shared live region in the thinking variant", () => {
    const variant = thinkingVariant;
    expect(variant).toMatch(/role="status"/);
    expect(variant).toMatch(/aria-live="polite"/);
    expect(variant, "the same announcement, not a second copy").toMatch(/\{announcement\}/);
  });

  it("still says it is retrying, rather than Thinking, when it is", () => {
    expect(thinkingVariant).toMatch(/retrying \? "Retrying API call" : "Thinking"/);
  });

  /** No hardcoded Claude accent left on the spinner, which every assistant reaches. */
  it("takes the spinner accent from the assistant's theme", () => {
    expect(phrase).not.toMatch(/text-claude-accent/);
    expect(phrase).toMatch(/assistantTheme\(assistant\)\.ink/);
  });
});

describe("⚠ message boxes do not touch", () => {
  /**
   * ⚠ THE BUG WAS THE CONDITION, NOT THE MISSING CLASS. It read
   * `usesDarkSurface ? "bg-surface-bg px-4 py-3" : "p-4 space-y-3"`, and `usesDarkSurface` became
   * unconditionally `true` when the light theme was retired — so the branch carrying the gap was DEAD
   * code, and Codex (which renders bubbles, not the timeline) lost its spacing entirely.
   */
  it("keys the transcript gap on the LAYOUT, not on the palette", () => {
    expect(chatView, "the dead condition is gone").not.toMatch(
      /usesDarkSurface \? "bg-surface-bg px-4 py-3" : "p-4 space-y-3"/
    );
    expect(chatView, "the gap is decided by the timeline flag").toMatch(
      /usesTimeline \? "" : "space-y-3"/
    );
  });

  /**
   * And the reason the timeline has NO gap is still true: the spine must be continuous, or the connecting
   * rule renders as dashes. Removing that would be the opposite regression.
   */
  it("still leaves the timeline gapless", () => {
    const m = /usesTimeline \? "([^"]*)" : "([^"]*)"/.exec(chatView);
    expect(m).not.toBeNull();
    expect(m![1], "timeline rows must touch").toBe("");
    expect(m![2], "bubbles must not").toContain("space-y-");
  });
});

// ── ⚠ WHICH SIDE EACH TURN SITS ON ───────────────────────────────────────────────────────
//
// ⚠ NOTHING ASSERTED THIS, AND THAT IS WHY IT BROKE. The row was `justify-end` for BOTH roles from the
// start; it was harmless only because the assistant's bubble was never really capped — `DARK_BUBBLE_CLASS`
// carries prose's `max-w-none`, which the generated stylesheet emits AFTER `.max-w-full` and therefore wins,
// so the bubble filled the row and a full-width box reads as left-aligned whatever its container does.
//
// Moving the width cap onto a column wrapper (needed so the timestamp could sit BELOW the bubble) put it
// beyond prose's reach. The assistant clamped to 75% and the latent `justify-end` finally showed.
//
// So these cases pin the ALIGNMENT ITSELF, per role, rather than trusting a width to make it moot.
describe("⚠ the assistant sits left and the participant right", () => {
  /** The container justifies for the user's turn ONLY. */
  it("justifies to the end only for the user", () => {
    expect(chatView).toMatch(/group flex gap-2 \$\{msg\.role === "user" \? "justify-end" : ""\}/);
  });

  /**
   * ⚠ AND THE COLUMN CANNOT BE CAPPED FOR THE ASSISTANT. A 75% cap on that wrapper is exactly the
   * regression: prose's `max-w-none` cannot override a parent, so the reply gets clamped and pushed right.
   */
  it("caps and right-aligns the user's column, leaving the assistant's uncapped and left", () => {
    /**
     * ⚠ BOTH BRANCHES READ WHOLE, because my first version of this case was ORDER-DEPENDENT: it asked for
     * `/items-start[^"]*max-w-\[75%\]/` and so passed happily when the cap was written BEFORE `items-start`
     * — which is exactly the half of the regression it existed to catch. Class order inside a string carries
     * no meaning; an assertion that depends on it is measuring nothing.
     */
    /**
     * ⚠ SELECTED BY CONTENT, NOT BY POSITION. There are TWO role ternaries in this subtree — the row's
     * `justify-end` and the column's classes — and `.match()` returns the FIRST, which is the row. Pinning
     * the column by "whichever pair mentions flex-col" survives either being moved or reordered.
     */
    const pairs = [
      ...chatView.matchAll(/msg\.role === "user"\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g),
    ];
    const col = pairs.find((m) => m[1].includes("flex-col") || m[2].includes("flex-col"));
    expect(col, "the column class must branch on the role").toBeDefined();
    const [, user, assistant] = col!;

    expect(user, "the user's column is capped").toContain("max-w-[75%]");
    expect(user, "and right-aligned").toContain("items-end");

    expect(assistant, "the assistant's column is left-aligned").toContain("items-start");
    expect(assistant, "and must NOT be capped — prose cannot override a parent").not.toContain(
      "max-w-[75%]"
    );
  });

  /**
   * ⚠ THE ONE PLACE A `max-w-[75%]` MAY STILL LIVE IS THE USER'S COLUMN. If it reappears on the bubble
   * itself the cap is back under prose's thumb, which is the state this whole confusion came from.
   */
  it("keeps the cap off the bubble, where prose would override it", () => {
    const at = chatView.indexOf("relative max-w-full rounded-lg");
    expect(at, "the codex bubble must not cap itself").toBeGreaterThan(-1);
  });
});
