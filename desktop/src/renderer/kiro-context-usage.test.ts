// ── ⚠ KIRO REPORTS NO TOKENS; IT REPORTS HOW FULL THE CONTEXT IS ─────────────────────────
//
// ⚠ THE FIXTURE IS A REAL PAYLOAD. `kiro-cli acp --trust-all-tools` was probed directly (kiro-cli 2.18.1, ACP
// protocolVersion 1) — full handshake, one real turn, every frame captured. The turn-end frame was the whole
// of what ACP gives: `{ "result": { "stopReason": "end_turn" } }`. No token count anywhere.
//
// The numbers below are verbatim from `_kiro.dev/metadata`, including the sixteen-significant-figure
// percentage, because rounding it is one of the things this module exists to do.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readKiroContextUsage,
  shouldShowContextUsage,
  CONTEXT_NOTICE_THRESHOLD,
} from "./lib/kiro-metadata";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (...p: string[]) => strip(readFileSync(join(__dirname, ...p), "utf8"));

/** Verbatim from the probe — the final metadata frame of a completed turn. */
const REAL_METADATA = {
  sessionId: "2135ae22-90f5-4628-8bc9-f7109fce6051",
  contextUsagePercentage: 10.665900230407715,
  meteringUsage: [{ value: 0.17961439270315094, unit: "credit", unitPlural: "credits" }],
  turnDurationMs: 2091,
};

describe("⚠ reading the one figure that means something alone", () => {
  it("rounds and returns the context percentage", () => {
    expect(readKiroContextUsage("_kiro.dev/metadata", REAL_METADATA)).toEqual({ percent: 11 });
  });

  /**
   * ⚠ CLAMPED. A percentage above 100 would be a Kiro bug, and rendering "140% context" would make the app
   * look wrong for the agent's reasons.
   */
  it("clamps an impossible reading rather than displaying it", () => {
    expect(readKiroContextUsage("_kiro.dev/metadata", { contextUsagePercentage: 140 })).toEqual({
      percent: 100,
    });
  });

  /**
   * ⚠ NULL, NOT ZERO, FOR EVERYTHING ELSE — and the caller relies on it: a null must leave the previous
   * reading standing, because MCP and command notifications arrive constantly and would otherwise blank the
   * figure between turns.
   */
  it("returns null for anything it cannot read", () => {
    for (const [method, params] of [
      ["_kiro.dev/mcp/server_initialized", { sessionId: "x", serverName: "creds-agent" }],
      ["session/update", { update: { sessionUpdate: "agent_message_chunk" } }],
      ["_kiro.dev/metadata", {}],
      ["_kiro.dev/metadata", { contextUsagePercentage: "lots" }],
      ["_kiro.dev/metadata", { contextUsagePercentage: -1 }],
      ["_kiro.dev/metadata", { contextUsagePercentage: Number.NaN }],
      ["_kiro.dev/metadata", null],
    ] as const) {
      expect(readKiroContextUsage(method, params), `${method} ${JSON.stringify(params)}`).toBeNull();
    }
  });

  /**
   * ⚠ AND IT IS SILENT UNTIL IT MATTERS. Every turn reports this; a permanent "11% context" in the header is
   * the same noise the sync badge was just stripped of. The real reading above is 11%, so the default state
   * of a fresh conversation must be to show nothing.
   */
  it("stays hidden at low usage and appears at the threshold", () => {
    expect(shouldShowContextUsage({ percent: 11 }), "the real probe reading").toBe(false);
    expect(shouldShowContextUsage({ percent: CONTEXT_NOTICE_THRESHOLD - 1 })).toBe(false);
    expect(shouldShowContextUsage({ percent: CONTEXT_NOTICE_THRESHOLD })).toBe(true);
    expect(shouldShowContextUsage(null)).toBe(false);
  });
});

describe("⚠ credits and duration are deliberately NOT stored", () => {
  const lib = read("lib", "kiro-metadata.ts");
  const view = read("components", "KiroChatView.tsx");

  /**
   * ⚠ `meteringUsage` IS A BILLING UNIT, NOT A COUNT. `computeTokenInsights` sums `input_tokens` across every
   * thread regardless of provider, so 0.18 credits would land beside a 13.2M-token Codex turn. That is the
   * incomparable-units problem that put the per-person table behind a flag (BACKLOG 9a), and writing credits
   * into a token column would reintroduce it in a place nobody could see.
   */
  it("reads no metering value", () => {
    expect(lib, "credits are parked, not parsed").not.toContain("meteringUsage[");
    expect(lib).not.toMatch(/\.value/);
  });

  /** The app already measures its own latency, so Kiro's copy would be a second source of truth. */
  it("reads no turn duration", () => {
    expect(lib).not.toContain("turnDurationMs");
  });

  /**
   * ⚠ AND NOTHING WRITES A TOKEN COUNT FOR KIRO. The probe settled that Kiro reports none; a fabricated or
   * estimated figure in those columns would break the portal's coverage line, which exists to distinguish
   * "measured zero" from "nobody measured".
   */
  it("writes no token columns from kiro's metadata", () => {
    for (const f of [lib, view]) {
      expect(f).not.toContain("input_tokens");
      expect(f).not.toContain("output_tokens");
    }
  });
});

describe("⚠ the view routes and renders it correctly", () => {
  const view = read("components", "KiroChatView.tsx");

  /**
   * ⚠ THERE ARE TWO `sessionId`s IN THAT NOTIFICATION and only one is right. `data.sessionId` is the APP
   * session, stamped by the main process so concurrent chats route correctly; `params.sessionId` is Kiro's
   * native ACP id, which nothing in the renderer is keyed by. Using the inner one would file every reading
   * under an id no chat has — and would look like the feature simply not working.
   */
  it("keys the reading by the app session, not kiro's native one", () => {
    expect(view).toMatch(/readKiroContextUsage\(data\.method, data\.params\)/);
    expect(view).toMatch(/\[data\.sessionId\]: usage/);
    expect(view, "the inner id must not be used as the key").not.toMatch(/\[params\.sessionId\]/);
  });

  /** A null reading must not overwrite a good one — see the module note. */
  it("ignores a non-reading instead of blanking the figure", () => {
    expect(view).toMatch(/if \(!usage\) return;/);
  });

  it("subscribes to the notification channel", () => {
    expect(view).toMatch(/api\.onKiroAcpNotification\(handleNotification\)/);
  });

  it("renders it only above the threshold", () => {
    expect(view).toMatch(/shouldShowContextUsage\(activeContextUsage\)/);
    expect(view, "and labels it as a percentage, not a token count").toMatch(/% context/);
  });
});
