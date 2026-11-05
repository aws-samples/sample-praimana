// Does the guard rail actually fire?
//
// setting-access.ts runs two checks AT MODULE LOAD, so a misconfigured allowlist stops the
// app instead of quietly widening the renderer's reach. A guard that is never exercised is a
// comment, so these tests re-import the module with a deliberately broken configuration and
// assert it refuses to load.
//
// The second check is the one this file exists for: `project_path` feeds `allowedRoots()`, and
// it was renderer-writable for the app's whole history. Being removed from the allowlist is
// not enough on its own — nothing stopped a future edit from adding it back, which is exactly
// how this class of hole reopens.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("better-sqlite3", () => ({ default: class {} }));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("./project-paths");
  vi.doUnmock("./assistant-command");
});

describe("setting-access boot invariants", () => {
  it("loads cleanly as currently configured", async () => {
    const mod = await import("./setting-access");
    // Sanity: the module really did evaluate, and the fixed state is the safe one.
    expect(mod.canRendererRead("project_path")).toBe(true);
    expect(mod.canRendererWrite("project_path")).toBe(false);
  });

  it("refuses to load if a boundary-input key is renderer-writable", async () => {
    // `notify_sound` IS on the writable allowlist, so naming it a boundary input is the
    // same mistake `project_path` used to be — stated in the one direction the check reads.
    vi.doMock("./project-paths", () => ({
      ALLOWLIST_SOURCE_SETTINGS: new Set(["notify_sound"]),
    }));

    await expect(import("./setting-access")).rejects.toThrow(
      /allowedRoots\(\) derives the filesystem boundary from/
    );
  });

  it("names the offending key and the correct writer in the failure message", async () => {
    vi.doMock("./project-paths", () => ({
      ALLOWLIST_SOURCE_SETTINGS: new Set(["notify_sound"]),
    }));

    // A boot failure a maintainer cannot act on gets worked around rather than fixed, so the
    // message has to carry both halves: which key, and where the write belongs instead.
    await expect(import("./setting-access")).rejects.toThrow(/notify_sound/);
    vi.resetModules();
    vi.doMock("./project-paths", () => ({
      ALLOWLIST_SOURCE_SETTINGS: new Set(["notify_sound"]),
    }));
    await expect(import("./setting-access")).rejects.toThrow(/files:commitProjectPath/);
  });

  /**
   * ── ⚠ THE THIRD CHECK: KEYS THAT NAME SOMETHING THE APP EXECUTES ──
   *
   * `ai_command` was renderer-writable for the app's whole history and it is passed to `spawn`. It sits
   * among `notify_sound` and `chat_history_visible` on that list and reads exactly like a preference,
   * which is why the boot check exists: the next person to edit the list has to be STOPPED, not
   * trusted to remember.
   */
  it("refuses to load if an executable-source key is renderer-writable", async () => {
    vi.doMock("./assistant-command", () => ({
      EXECUTABLE_SOURCE_SETTINGS: new Set(["notify_sound"]), // on the write list — same mistake
    }));

    await expect(import("./setting-access")).rejects.toThrow(
      /names the executable the app spawns/
    );
  });

  it("names the key and the correct writer in that failure too", async () => {
    vi.doMock("./assistant-command", () => ({
      EXECUTABLE_SOURCE_SETTINGS: new Set(["notify_sound"]),
    }));
    await expect(import("./setting-access")).rejects.toThrow(/notify_sound/);

    vi.resetModules();
    vi.doMock("./assistant-command", () => ({
      EXECUTABLE_SOURCE_SETTINGS: new Set(["notify_sound"]),
    }));
    await expect(import("./setting-access")).rejects.toThrow(/cli:setAssistant/);
  });

  it("tolerates an executable-source key that is merely readable", async () => {
    // Which is the real configuration: `ai_command` stays readable, and must, because the chat
    // header and the assistant theme branch on it.
    vi.doMock("./assistant-command", () => ({
      EXECUTABLE_SOURCE_SETTINGS: new Set(["user_email"]),
    }));
    await expect(import("./setting-access")).resolves.toBeDefined();
  });

  it("tolerates a boundary key that is merely readable", async () => {
    // Read access is not the hazard and is genuinely needed — SettingsView and TeamDocs both
    // display the folder. Only the write side may not be granted.
    vi.doMock("./project-paths", () => ({
      ALLOWLIST_SOURCE_SETTINGS: new Set(["user_email"]), // readable, not writable
    }));

    await expect(import("./setting-access")).resolves.toBeDefined();
  });

  /**
   * ── ⚠ THE FOURTH CHECK: KEYS THAT NAME THE TENANT ────────────────────────────────────────────
   *
   * `team_id` and `workshop_id` were renderer-writable, so the tenant every team-scoped request is made
   * against was client-controlled — including `share:shareSession`, which publishes a private local
   * transcript.
   *
   * ⚠ THIS ONE CANNOT BE BROKEN BY A MOCK, and that is a property of where the set lives rather than a
   * gap in the test. `ALLOWLIST_SOURCE_SETTINGS` and `EXECUTABLE_SOURCE_SETTINGS` are imported from the
   * modules that own those concerns, so a test can substitute them; `TENANT_SETTINGS` is declared in
   * setting-access.ts beside the list it guards, because the tenant concern has no single owning module
   * that setting-access can import without pulling in `ipcMain`. So the check is asserted two ways: the
   * sets really are disjoint, and the guard that keeps them disjoint is really in the file.
   */
  it("keeps the tenant keys off the write allowlist, and carries the guard that enforces it", async () => {
    const mod = await import("./setting-access");
    for (const key of mod.TENANT_SETTINGS) {
      expect(mod.canRendererWrite(key), key).toBe(false);
      // Readable, and needed: the sidebar, Settings and the Account panel all display the team.
      expect(mod.canRendererRead(key), key).toBe(true);
    }

    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./setting-access.ts", import.meta.url), "utf8");
    expect(src).toMatch(/for \(const key of TENANT_SETTINGS\)/);
    expect(src, "and the failure has to name where the write belongs instead").toMatch(
      /ai:joinTeam \/ ai:selectTeam/
    );
  });
});

/**
 * ── ⚠ THE AGENT'S FILE-WRITE OPT-OUT IS READABLE, NEVER WRITABLE ──────────────────────────────
 *
 * The setting that closes it has an asymmetry that decides its wiring: writing `false` NARROWS what the agent
 * may do, while writing `true` RE-GRANTS a permission the participant explicitly withdrew — and
 * renderer-resident code is the actor that finding is scoped against.
 *
 * `telemetry_enabled` is the cautionary example on the other side: it IS renderer-writable, and the
 * telemetry finding's own text observes that "the same renderer code can turn the log on before writing
 * to it". This key must not join it.
 */
describe("⚠ agent_trust_fs_write", () => {
  const KEY = "agent_trust_fs_write";

  it("is readable, so Settings can render the current state", async () => {
    const mod = await import("./setting-access");
    expect(mod.canRendererRead(KEY)).toBe(true);
  });

  it("⚠ is NOT writable — that would let the renderer re-grant it", async () => {
    const mod = await import("./setting-access");
    expect(
      mod.canRendererWrite(KEY),
      "it moves only through agentTrust:setFileWrites"
    ).toBe(false);
  });

  /**
   * ⚠ NOT CLEARED ON SIGN-OUT. A preference about how the agent behaves on this machine is not session
   * state, and somebody who declined has not un-declined by signing out — resetting it would silently
   * re-grant on the next sign-in, which is the exact shape of the problem the setting exists to fix.
   */
  it("survives sign-out", async () => {
    const mod = await import("./setting-access");
    expect(mod.SIGN_OUT_SETTINGS).not.toContain(KEY);
  });
});
