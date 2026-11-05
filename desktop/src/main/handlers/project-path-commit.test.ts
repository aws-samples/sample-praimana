// The write side of the filesystem confinement boundary.
//
// `allowedRoots()` (project-paths.ts) builds the roots every file, git and spawn handler is
// confined to from the `project_path` setting. While the renderer could write that setting
// through `db:setSetting`, the confined party chose its own fence: one call naming the home
// directory put `~/.ssh`, `~/.aws` and `~/Library/LaunchAgents` "inside the project".
//
// So the write moved to main, behind picker provenance. These tests drive the REAL handlers
// registered by setupFileHandlers() and assert on `writeSetting` itself — the property is not
// that the call returns an error, it is that an unvouched value never lands in the settings
// table where allowedRoots() would read it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

// What the native dialog will return next, and what it was asked to show.
const showOpenDialog = vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>();
const showErrorBox = vi.fn<(title: string, content: string) => void>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  dialog: {
    showOpenDialog: () => showOpenDialog(),
    showErrorBox: (title: string, content: string) => showErrorBox(title, content),
  },
  app: { getPath: () => "/tmp" },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));

const store = new Map<string, string>();
const writeSetting = vi.fn((key: string, value: string) => {
  store.set(key, value);
});

vi.mock("../database", () => ({
  readSetting: (key: string) => store.get(key) ?? null,
  writeSetting: (key: string, value: string) => writeSetting(key, value),
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
}));

import { setupFileHandlers } from "./files";

setupFileHandlers();

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return handler({}, ...args);
}

/** Simulate the user picking `dir` in the native dialog. */
async function pick(dir: string): Promise<string | null> {
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
  return (await invoke("files:selectDirectory")) as string | null;
}

beforeEach(() => {
  store.clear();
  writeSetting.mockClear();
  showOpenDialog.mockReset();
  showErrorBox.mockClear();
});

describe("files:selectDirectory — the only origin of a project path", () => {
  it("returns the resolved path the user picked", async () => {
    expect(await pick("/Users/dev/picked-a")).toBe("/Users/dev/picked-a");
  });

  it("returns null when the user cancels", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke("files:selectDirectory")).toBeNull();
  });

  it("returns null when the dialog yields no path at all", async () => {
    // Defensive: `canceled: false` with an empty list would otherwise index undefined.
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    expect(await invoke("files:selectDirectory")).toBeNull();
  });

  it("refuses the home directory with a native error box, reported as a cancel", async () => {
    // ⚠ The case provenance alone cannot catch: the dialog WILL return $HOME if the user
    // selects it, and then every downstream check is satisfied for ~/.ssh with real consent.
    // Reported as null because both call sites already treat null as "changed their mind",
    // so the refusal needs no renderer change.
    expect(await pick(os.homedir())).toBeNull();
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(showErrorBox.mock.calls[0][1]).toMatch(/cannot be used as a project/);
  });

  it("refuses the filesystem root", async () => {
    expect(await pick("/")).toBeNull();
    expect(showErrorBox).toHaveBeenCalledTimes(1);
  });
});

describe("files:commitProjectPath — only a picked path becomes the boundary", () => {
  it("writes project_path for a path the picker just returned", async () => {
    const dir = "/Users/dev/picked-b";
    await pick(dir);

    await expect(invoke("files:commitProjectPath", dir)).resolves.toEqual({ success: true });
    expect(writeSetting).toHaveBeenCalledWith("project_path", dir);
    expect(store.get("project_path")).toBe(dir);
  });

  it("refuses a path the renderer invented, and writes nothing", async () => {
    // The original attack, verbatim: point the boundary at the home directory.
    await expect(invoke("files:commitProjectPath", os.homedir())).rejects.toThrow(/Access denied/);

    expect(writeSetting).not.toHaveBeenCalled();
    expect(store.get("project_path")).toBeUndefined();
  });

  it("refuses a sibling of a picked path (no prefix inheritance)", async () => {
    await pick("/Users/dev/picked-c");

    await expect(
      invoke("files:commitProjectPath", "/Users/dev/picked-c-evil")
    ).rejects.toThrow(/Access denied/);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("refuses a child of a picked path (the grant is the root itself)", async () => {
    await pick("/Users/dev/picked-d");

    await expect(
      invoke("files:commitProjectPath", "/Users/dev/picked-d/nested")
    ).rejects.toThrow(/Access denied/);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("accepts a traversal spelling of a picked path, because it resolves to the same folder", async () => {
    await pick("/Users/dev/picked-e");

    await expect(
      invoke("files:commitProjectPath", "/Users/dev/sub/../picked-e")
    ).resolves.toEqual({ success: true });
    // Stored resolved, never as the caller spelled it.
    expect(writeSetting).toHaveBeenCalledWith("project_path", "/Users/dev/picked-e");
  });

  it("refuses a path the dialog offered but the forbidden-root check rejected", async () => {
    // The refusal at the picker must not leave provenance behind for a second attempt.
    await pick(path.join(os.homedir(), "Library"));

    await expect(
      invoke("files:commitProjectPath", path.join(os.homedir(), "Library"))
    ).rejects.toThrow(/Access denied/);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("refuses empty and non-string input", async () => {
    await expect(invoke("files:commitProjectPath", "")).rejects.toThrow(/Access denied/);
    await expect(invoke("files:commitProjectPath", undefined)).rejects.toThrow(/Access denied/);
    expect(writeSetting).not.toHaveBeenCalled();
  });
});
