import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE PROFILE CHOOSER'S THEME — the screen that runs with NO DATABASE OPEN.
 *
 * `index.ts` returns early on the chooser path, before `initDatabase()` and before
 * `setupThemeHandlers()`, so only `profile:*` was registered — while `main.tsx` calls `theme:get`
 * before `createRoot` for both roots. The renderer's try/catch swallowed the rejection and the picker
 * fell back to dark, so the visible symptom was a light-mode machine showing a dark picker plus a
 * missing-handler error on every launch.
 *
 * ── ⚠ WHY `../database` IS MOCKED TO THROW ──
 *
 * That is the whole point of this suite. The naive fix — hoisting `setupThemeHandlers()` above the
 * early return — LOOKS right and fails, because `readSetting` calls `db.prepare(...)` on a
 * module-level `db` that is undefined in chooser mode: a TypeError instead of a missing handler. A
 * mock that returned a value would let that regression pass. A mock that throws on ANY database
 * access means these tests fail the moment the chooser path touches the settings table.
 */

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
const osUpdatedListeners: Array<() => void> = [];
const sent: Array<{ channel: string; payload: unknown }> = [];

let osPrefersDark = true;
let windowDestroyed = false;

vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      if (handlers.has(channel)) {
        // Electron itself throws on a second handler for one channel. Mirrored here because the
        // chooser and the full app both register `theme:get` and must stay mutually exclusive.
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, listener);
    },
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return osPrefersDark;
    },
    on: (event: string, cb: () => void) => {
      if (event === "updated") osUpdatedListeners.push(cb);
    },
    set themeSource(_v: string) {
      throw new Error("the chooser path must not pin themeSource — it has no stored preference");
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => windowDestroyed,
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
}));

vi.mock("../database", () => ({
  readSetting: () => {
    throw new Error("no database is open in chooser mode");
  },
  writeSetting: () => {
    throw new Error("no database is open in chooser mode");
  },
  getDb: () => {
    throw new Error("no database is open in chooser mode");
  },
}));

vi.mock("../debug-log", () => ({ debugLog: vi.fn() }));

import { setupChooserThemeHandlers } from "./theme";

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return Promise.resolve(handler({}, ...args));
}

beforeEach(() => {
  handlers.clear();
  osUpdatedListeners.length = 0;
  sent.length = 0;
  osPrefersDark = true;
  windowDestroyed = false;
});

describe("setupChooserThemeHandlers", () => {
  it("registers theme:get, so the picker no longer hits a missing handler", () => {
    setupChooserThemeHandlers();
    expect(handlers.has("theme:get")).toBe(true);
  });

  it("answers without touching the settings table", async () => {
    // The database mock throws on every access; reaching it fails the test rather than passing quietly.
    setupChooserThemeHandlers();
    await expect(invoke("theme:get")).resolves.toEqual({ mode: "system", resolved: "dark" });
  });

  it("follows the OS: light machine gets a light picker", async () => {
    osPrefersDark = false;
    setupChooserThemeHandlers();

    // The actual reported symptom — a light machine showing a dark picker.
    await expect(invoke("theme:get")).resolves.toEqual({ mode: "system", resolved: "light" });
  });

  it("reports mode 'system' rather than inventing a preference", async () => {
    // `theme_mode` is per profile, so before one is chosen there is no stored preference to honour.
    // "system" is the honest answer AND the app's own DEFAULT_THEME_MODE, so the chooser cannot
    // disagree with what the app will do a moment later.
    setupChooserThemeHandlers();
    const { mode } = await invoke("theme:get");
    expect(mode).toBe("system");
  });

  it("re-resolves on every call, so an OS flip is picked up", async () => {
    setupChooserThemeHandlers();
    expect((await invoke("theme:get")).resolved).toBe("dark");
    osPrefersDark = false;
    expect((await invoke("theme:get")).resolved).toBe("light");
  });

  it("does NOT register theme:set — there is nowhere to persist a preference", () => {
    setupChooserThemeHandlers();
    expect(handlers.has("theme:set")).toBe(false);
  });

  it("does NOT register theme:modes — the picker renders no theme control", () => {
    setupChooserThemeHandlers();
    expect(handlers.has("theme:modes")).toBe(false);
  });

  it("does not pin nativeTheme.themeSource", () => {
    // The setter in the electron mock throws. `themeSource` already defaults to "system" every
    // launch, so assigning it here would be a no-op dressed up as a decision.
    expect(() => setupChooserThemeHandlers()).not.toThrow();
  });
});

describe("the chooser follows a live OS flip", () => {
  it("pushes theme:changed when the OS updates", () => {
    setupChooserThemeHandlers();
    expect(osUpdatedListeners).toHaveLength(1);

    osPrefersDark = false;
    osUpdatedListeners[0]();

    // `main.tsx` registers its `theme:changed` listener at module scope for both roots, so the picker
    // follows this without any chooser-specific renderer code.
    expect(sent).toEqual([{ channel: "theme:changed", payload: { mode: "system", resolved: "light" } }]);
  });

  it("skips destroyed windows", () => {
    setupChooserThemeHandlers();
    windowDestroyed = true;

    osUpdatedListeners[0]();

    expect(sent).toEqual([]);
  });

  it("does not read the database on an OS flip either", () => {
    // The push path is where a careless refactor would reach for the shared `state()` helper, which
    // does read settings. The throwing mock is what catches that.
    setupChooserThemeHandlers();
    expect(() => osUpdatedListeners[0]()).not.toThrow();
  });
});

describe("mutual exclusivity with the full app's handlers", () => {
  it("cannot be registered twice — Electron rejects a duplicate channel", () => {
    setupChooserThemeHandlers();

    /**
     * ⚠ THE CONSTRAINT THAT KEEPS THIS FIX SAFE. `setupThemeHandlers` also registers `theme:get`, so
     * the chooser variant is only ever called inside the `launch.showChooser` branch — which returns
     * before the full registration is reached. If a future edit calls both on one path, Electron
     * throws at startup and the app does not boot. This test states that so the ordering in index.ts
     * reads as load-bearing rather than incidental.
     */
    expect(() => setupChooserThemeHandlers()).toThrow(/second handler for 'theme:get'/);
  });
});
