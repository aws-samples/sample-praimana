// ── ⚠ ONE PHASE READ, SHARED, AND ONLY BECAUSE A CHAT TAB WAS VISITED ─────────────────────────
//
// The placeholder's wording is tested in lib/composer-placeholder.test.ts. This file covers the part
// that could regress an explicit requirement: gate API calls so each tab makes its API call only when
// the user visits that tab.
//
// A phase read per mount would breach that in spirit — the chat views remount on every project switch,
// every session switch, and twice per mount under StrictMode. So the read is cached across mounts and
// shared by both views, and the cached answer includes NULL, because "this team has not started phase
// one" is the common case and re-asking it on every remount is the polling this app avoids.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const ASSISTANT = readFileSync(local("./components/AssistantChatView.tsx"), "utf8");
const KIRO = readFileSync(local("./components/KiroChatView.tsx"), "utf8");
const HOOK = strip(readFileSync(local("./hooks/useCurrentPhase.ts"), "utf8"));

describe("both composers use the shared helper", () => {
  it("neither view builds its placeholder inline any more", () => {
    for (const [name, src] of [["AssistantChatView", ASSISTANT], ["KiroChatView", KIRO]] as const) {
      const code = strip(src);
      expect(code, `${name} must call the helper`).toContain("composerPlaceholder({");
      // The old wording must not survive as a second copy anywhere in the view.
      expect(code, `${name} must not hardcode the old text`).not.toMatch(/Ask \$\{?\w*\}? ?anything/);
      expect(code, `${name} must not hardcode "Ask Kiro anything"`).not.toContain('"Ask Kiro anything…"');
    }
  });

  it("passes the phase and the project to it", () => {
    for (const src of [ASSISTANT, KIRO]) {
      const code = strip(src);
      const call = code.slice(code.indexOf("composerPlaceholder({"));
      const args = call.slice(0, call.indexOf("})"));
      expect(args).toContain("phaseName");
      expect(args).toContain("projectName: project.name");
      expect(args).toContain("streaming");
    }
  });

  it("⚠ KiroChatView no longer keeps its own copy of the assistant's NAME", () => {
    /**
     * It hardcoded "Kiro" in both placeholder branches. Harmless in isolation — this view only renders
     * Kiro sessions — but `lib/assistants.ts` exists because the app has two vocabularies for naming an
     * assistant, and its header lists three reported bugs caused by exactly this kind of local copy.
     */
    expect(strip(KIRO)).toContain('assistant: "kiro"');
  });

  it("calls the hook once per view, at the top of the component", () => {
    // Below an early return it would break the rules of hooks; the placeholder is not worth a crash.
    for (const [name, src] of [["AssistantChatView", ASSISTANT], ["KiroChatView", KIRO]] as const) {
      const code = strip(src);
      expect((code.match(/useCurrentPhase\(\)/g) ?? []).length, name).toBe(1);
      const component = code.indexOf(name === "KiroChatView" ? "export function KiroChatView" : "export function AssistantChatView");
      const hookCall = code.indexOf("useCurrentPhase()", component);
      const firstReturn = code.indexOf("return", component);
      expect(hookCall).toBeGreaterThan(component);
      expect(hookCall, "must precede any return").toBeLessThan(firstReturn);
    }
  });
});

describe("⚠ the hook does not undo the per-tab API gating", () => {
  it("caches across mounts, including a null answer", () => {
    expect(HOOK).toContain("let cache: { name: string | null; at: number } | null = null");
    expect(HOOK).toMatch(/if \(cache && now - cache\.at < PHASE_CACHE_TTL_MS\) return cache\.name/);
  });

  it("de-duplicates concurrent reads, so two views mounting together make ONE call", () => {
    // Both chat views can mount in the same frame when a pinned pane is restored.
    expect(HOOK).toContain("let inFlight");
    expect(HOOK).toMatch(/if \(inFlight\) return inFlight/);
  });

  it("⚠ does NOT subscribe to team:event", () => {
    /**
     * Phase changes are pushed on that channel, so listening is the obvious design — and a trap:
     * `useTeamUnread` ends its effect with `removeTeamEventListeners()`, which is
     * `removeAllListeners("team:event")`, so its next remount would silently delete this hook's
     * listener. Same hazard the preload documents between removeCliListeners and
     * removeKiroAcpListeners.
     */
    expect(HOOK).not.toContain("onTeamEvent");
    expect(HOOK).not.toContain("removeTeamEventListeners");
  });

  it("believes only a successful read", () => {
    // ok:false covers no-team, 403, 404, offline and a busy slot — all "we do not know".
    expect(HOOK).toMatch(/if \(res\?\.ok\)/);
  });

  it("cannot break a chat when the bridge is absent or throws", () => {
    expect(HOOK).toMatch(/catch\s*\{[\s\S]{0,80}name = null/);
  });

  it("does not set state after unmount", () => {
    // The views unmount on project and session switches.
    expect(HOOK).toMatch(/if \(alive\) setName\(value\)/);
  });
});

/**
 * ── THE CACHE AND DE-DUPLICATION, EXERCISED RATHER THAN READ ──────────────────────────────────
 *
 * `api.getPhases` is COUNTED here, because the call count is the only honest evidence for "a remount
 * does not refetch" — the claim this module exists to make. `readCurrentPhaseName` is exported for
 * exactly this: vitest is node-only in this package, so there is no renderer to mount the hook in.
 */
describe("the hook's caching, run for real", () => {
  let calls = 0;
  let response: any = { ok: true, phases: [{ name: "Design", order: 2 }], currentPhaseOrder: 2 };

  beforeEach(() => {
    calls = 0;
    response = { ok: true, phases: [{ name: "Design", order: 2 }], currentPhaseOrder: 2 };
    (globalThis as any).window = {
      electronAPI: {
        getPhases: async () => {
          calls++;
          return response;
        },
      },
    };
    vi.resetModules();
  });

  const load = async () => {
    const mod = await import("./hooks/useCurrentPhase");
    mod.__resetPhaseCache();
    return mod;
  };

  it("reads ONCE and reuses the answer across later mounts", async () => {
    const { readCurrentPhaseName } = await load();
    const now = 1_000_000;

    expect(await readCurrentPhaseName(now)).toBe("Design");
    expect(await readCurrentPhaseName(now + 1)).toBe("Design");
    expect(await readCurrentPhaseName(now + 60_000)).toBe("Design");
    expect(calls, "three mounts, one read").toBe(1);
  });

  it("de-duplicates two reads started in the same frame", async () => {
    /**
     * Both chat views can mount in one frame when a pinned pane is restored, and without the in-flight
     * guard the cache is still empty for the second one — so both would call.
     */
    const { readCurrentPhaseName } = await load();
    const [a, b] = await Promise.all([readCurrentPhaseName(1), readCurrentPhaseName(1)]);
    expect(a).toBe("Design");
    expect(b).toBe("Design");
    expect(calls, "one call for two concurrent mounts").toBe(1);
  });

  it("⚠ CACHES A NULL ANSWER, which is the common case", async () => {
    /**
     * `currentPhaseOrder: 0` — every team before a facilitator starts phase one — is a SUCCESS
     * response yielding no phase. Not caching it would re-read on every single remount, which is the
     * polling the per-tab gating removed.
     */
    response = { ok: true, phases: [{ name: "Design", order: 2 }], currentPhaseOrder: 0 };
    const { readCurrentPhaseName } = await load();

    expect(await readCurrentPhaseName(5_000)).toBeNull();
    expect(await readCurrentPhaseName(5_001)).toBeNull();
    expect(calls, "a null answer is an answer").toBe(1);
  });

  it("refetches once the TTL has passed", async () => {
    const { readCurrentPhaseName, PHASE_CACHE_TTL_MS } = await load();
    const now = 2_000_000;

    expect(await readCurrentPhaseName(now)).toBe("Design");
    response = { ok: true, phases: [{ name: "Build", order: 3 }], currentPhaseOrder: 3 };
    expect(await readCurrentPhaseName(now + PHASE_CACHE_TTL_MS + 1)).toBe("Build");
    expect(calls).toBe(2);
  });

  it("believes no phase from a REFUSED read, and does not retry it on the spot", async () => {
    // A team that 403s takes exactly this path in real use.
    response = { ok: false, reason: "access-lost", phases: [], currentPhaseOrder: 0 };
    const { readCurrentPhaseName } = await load();

    expect(await readCurrentPhaseName(10)).toBeNull();
    expect(await readCurrentPhaseName(11)).toBeNull();
    expect(calls).toBe(1);
  });

  it("survives a bridge that throws, and a bridge that is not there", async () => {
    (globalThis as any).window.electronAPI.getPhases = async () => {
      calls++;
      throw new Error("no window");
    };
    const { readCurrentPhaseName, __resetPhaseCache } = await import("./hooks/useCurrentPhase");
    __resetPhaseCache();
    await expect(readCurrentPhaseName(1)).resolves.toBeNull();

    (globalThis as any).window = {};
    vi.resetModules();
    const again = await import("./hooks/useCurrentPhase");
    again.__resetPhaseCache();
    await expect(again.readCurrentPhaseName(1)).resolves.toBeNull();
  });

  it("does not leave a failed read stuck as in-flight", async () => {
    /**
     * If `inFlight` were not cleared on the error path, every later mount would await a promise that
     * already settled — the placeholder would freeze at its fallback for the rest of the session.
     */
    (globalThis as any).window.electronAPI.getPhases = async () => {
      calls++;
      throw new Error("boom");
    };
    const { readCurrentPhaseName, __resetPhaseCache, PHASE_CACHE_TTL_MS } = await import(
      "./hooks/useCurrentPhase"
    );
    __resetPhaseCache();

    await readCurrentPhaseName(1);
    (globalThis as any).window.electronAPI.getPhases = async () => {
      calls++;
      return { ok: true, phases: [{ name: "Design", order: 1 }], currentPhaseOrder: 1 };
    };
    // Past the TTL, so the cache is stale and a fresh read must actually happen.
    expect(await readCurrentPhaseName(1 + PHASE_CACHE_TTL_MS + 1)).toBe("Design");
    expect(calls).toBe(2);
  });
});
