// ── ⚠ THE COMPOSER NAMES THE PHASE, AND DEGRADES QUIETLY WHEN IT CANNOT ───────────────────────
//
// The wording now names the workshop phase, and where nothing is known it asks "What are we building?" — chosen
// over both the original and "Waiting for your input" (which reads as a status report rather
// than an invitation to type).
//
// ⚠ THE FALLBACK CHAIN IS THE WHOLE RISK, not the wording. `phases:getPhases` yields no usable phase in
// five situations and TWO OF THEM ARE SUCCESS RESPONSES — `phases: []`, and `currentPhaseOrder: 0`
// which every team has until a facilitator starts phase one. So "no phase" is the common case on a
// fresh workshop, not an error path, and getting it wrong renders "Working on undefined —" to a
// participant on their first screen.

import { describe, it, expect } from "vitest";
import {
  MAX_NAME_CHARS,
  composerPlaceholder,
  currentPhaseName,
  type PhaseLike,
} from "./composer-placeholder";

/** A workshop's phases, deliberately NOT in `order` sequence — see the note in `currentPhaseName`. */
const PHASES: PhaseLike[] = [
  { name: "Build", order: 3 },
  { name: "Inception", order: 1 },
  { name: "Design", order: 2 },
];

describe("currentPhaseName", () => {
  it("finds the phase by ORDER, not by position", () => {
    /**
     * `PhasesView` documents why: the array comes from an API whose ordering is not guaranteed, so
     * `phases[0]` says nothing about sequence. Here `phases[0]` is Build while the current order is 2.
     */
    expect(currentPhaseName(PHASES, 2)).toBe("Design");
    expect(currentPhaseName(PHASES, 1)).toBe("Inception");
    expect(currentPhaseName(PHASES, 3)).toBe("Build");
  });

  it("⚠ returns null for order 0 — 'before the first phase' is a real state", () => {
    // The most common case on a fresh workshop, and a SUCCESS response from the handler.
    expect(currentPhaseName(PHASES, 0)).toBeNull();
  });

  it("⚠ returns null for an empty phase list, which is also a success response", () => {
    expect(currentPhaseName([], 1)).toBeNull();
    expect(currentPhaseName([], 0)).toBeNull();
  });

  it("returns null when nothing matches the current order", () => {
    // A workshop advanced past the phases the read returned — do not guess at the nearest.
    expect(currentPhaseName(PHASES, 9)).toBeNull();
    expect(currentPhaseName(PHASES, -1)).toBeNull();
  });

  it("survives every shape a failed or malformed read can produce", () => {
    /**
     * `{ ok: false }` responses carry `phases: []`, but this must also hold for anything the bridge
     * could hand back after a version skew — the placeholder is not worth a crashed chat view.
     */
    expect(currentPhaseName(null, 1)).toBeNull();
    expect(currentPhaseName(undefined, 1)).toBeNull();
    expect(currentPhaseName(PHASES, null)).toBeNull();
    expect(currentPhaseName(PHASES, undefined)).toBeNull();
    expect(currentPhaseName(PHASES, "2")).toBeNull(); // a string order is not a match
    expect(currentPhaseName(PHASES, NaN)).toBeNull();
    expect(currentPhaseName([{ order: 1 }], 1)).toBeNull(); // present, but nameless
    expect(currentPhaseName([{ name: "  ", order: 1 }], 1)).toBeNull(); // whitespace is not a name
    expect(currentPhaseName([{ name: 42, order: 1 }] as PhaseLike[], 1)).toBeNull();
    expect(currentPhaseName([null as unknown as PhaseLike], 1)).toBeNull();
  });

  it("collapses control characters instead of letting them reflow the box", () => {
    // A newline in a placeholder changes the textarea's rendered height.
    expect(currentPhaseName([{ name: "De\nsign", order: 1 }], 1)).toBe("De sign");
    expect(currentPhaseName([{ name: "Build\tit", order: 1 }], 1)).toBe("Build it");
  });

  it("caps a name that would overflow the composer", () => {
    // Server-supplied, so its length is not ours to assume.
    const long = "A".repeat(120);
    const out = currentPhaseName([{ name: long, order: 1 }], 1)!;
    expect(out.length).toBe(MAX_NAME_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("composerPlaceholder — the fallback chain", () => {
  it("names the phase and the assistant when a phase is known", () => {
    expect(
      composerPlaceholder({ assistant: "kiro-cli", projectName: "acme-api", phaseName: "Design" })
    ).toBe("Working on Design — tell Kiro what to build…");
    expect(
      composerPlaceholder({ assistant: "codex", projectName: "acme-api", phaseName: "Build" })
    ).toBe("Working on Build — tell Codex what to build…");
  });

  it("falls back to the project when there is no phase", () => {
    // The 403 case, the offline case, and the not-started-yet case all land here.
    expect(
      composerPlaceholder({ assistant: "claude", projectName: "acme-api", phaseName: null })
    ).toBe("Describe a change to acme-api…");
  });

  it("asks what we are building when nothing at all is known", () => {
    /**
     * ⚠ THE WORD "anything" IS GONE, deliberately, and this branch names no assistant —
     * it is reached only when there is no phase AND no project, i.e. a fresh install, so there is
     * nothing true to be specific about. Asserted as an exact string because it is the one line a
     * first-run participant reads.
     */
    expect(composerPlaceholder({ assistant: "claude" })).toBe("What are we building?");
    expect(composerPlaceholder({ assistant: "kiro", projectName: "", phaseName: "" })).toBe(
      "What are we building?"
    );
    // Identical whoever the assistant is — the wording deliberately does not vary here.
    expect(composerPlaceholder({ assistant: "codex" })).toBe("What are we building?");
    expect(composerPlaceholder({ assistant: null })).toBe("What are we building?");
  });

  it("⚠ never says \"anything\" in any branch", () => {
    /**
     * The instruction was to remove the word, not to move it. Swept across the whole matrix rather
     * than asserted on the one line it used to live on, so a future edit cannot reintroduce it in the
     * phase or project branch either.
     */
    for (const assistant of ["claude", "kiro-cli", "codex", null]) {
      for (const phaseName of [null, "Design"]) {
        for (const projectName of [null, "repo"]) {
          for (const streaming of [false, true]) {
            expect(
              composerPlaceholder({ assistant, projectName, phaseName, streaming }),
              JSON.stringify({ assistant, phaseName, projectName, streaming })
            ).not.toMatch(/anything/i);
          }
        }
      }
    }
  });

  it("⚠ NEVER renders undefined, null or an empty phase into the sentence", () => {
    /**
     * The failure this file exists to prevent. Every one of these is a real response shape, and any of
     * them reaching the string would show a participant "Working on undefined —" or a dangling dash.
     */
    for (const phaseName of [undefined, null, "", "   ", "\n", "\t"]) {
      const out = composerPlaceholder({ assistant: "kiro", projectName: "repo", phaseName });
      expect(out, JSON.stringify(phaseName)).not.toMatch(/undefined|null|—\s*$/);
      expect(out).toBe("Describe a change to repo…");
    }
  });

  it("⚠ while streaming, explains the BOX rather than repeating the agent's status", () => {
    /**
     * It used to say "<assistant> is working…" six pixels under an element saying exactly that — the
     * "Working…" bar in KiroChatView, `ActivityPhrase` in AssistantChatView. The composer is
     * `readOnly` during a turn, and nothing on screen said so, which is what this space can add: a
     * participant who types and sees nothing appear cannot otherwise tell locked from broken.
     */
    expect(composerPlaceholder({ assistant: "kiro", streaming: true, phaseName: "Design" })).toBe(
      "You can type again when Kiro finishes…"
    );
    expect(composerPlaceholder({ assistant: "claude", streaming: true })).toBe(
      "You can type again when Claude finishes…"
    );
  });

  it("no longer duplicates the status element sitting above it", () => {
    // The specific duplication, asserted as an absence so it cannot come back by paraphrase.
    for (const assistant of ["kiro", "claude", "codex"]) {
      const out = composerPlaceholder({ assistant, streaming: true, phaseName: "Design" });
      expect(out, assistant).not.toMatch(/is working|working…/i);
    }
  });

  it("⚠ streaming BEATS the phase, because the box being locked is the more urgent fact", () => {
    // Ordering, not wording: a phase-named placeholder during a locked turn would be actively wrong.
    const streaming = composerPlaceholder({
      assistant: "kiro",
      projectName: "acme-api",
      phaseName: "Design",
      streaming: true,
    });
    expect(streaming).not.toContain("Working on Design");
    expect(streaming).not.toContain("acme-api");
  });

  it("normalises both assistant vocabularies through the shared helper", () => {
    /**
     * `ai_command` says "kiro-cli" while a session's `ai_provider` says "kiro" — the exact mismatch
     * `lib/assistants.ts` was written for. Both must produce "Kiro" here.
     */
    const withCommand = composerPlaceholder({ assistant: "kiro-cli", phaseName: "Design" });
    const withProvider = composerPlaceholder({ assistant: "kiro", phaseName: "Design" });
    expect(withCommand).toBe(withProvider);
  });

  it("caps a long project name too", () => {
    // Project names come from a folder the user picked, so they can be arbitrarily long.
    const out = composerPlaceholder({ assistant: "claude", projectName: "x".repeat(90) });
    expect(out.length).toBeLessThan(60);
    expect(out).toContain("…");
  });

  it("says something in every case — no empty placeholder is reachable", () => {
    // Property, not examples: an empty placeholder is a blank box with no affordance at all.
    for (const assistant of ["claude", "kiro-cli", "codex", "", null, undefined, "cli"]) {
      for (const phaseName of [null, "Design"]) {
        for (const projectName of [null, "repo"]) {
          for (const streaming of [false, true]) {
            const out = composerPlaceholder({ assistant, projectName, phaseName, streaming });
            expect(out.trim().length, JSON.stringify({ assistant, phaseName })).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
