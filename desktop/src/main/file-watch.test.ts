// ── ⚠ AN OPEN TAB NOTICES SOMEBODY ELSE'S WRITE, AND A SAVE DOES NOT CLOBBER IT ─────────────────
//
// Two defects behind one report. The editor read the file once, keyed on the path, and nothing re-read it —
// that is the visible half. The other half loses work: `dirty` compares against the `original` read on open,
// so saving after the agent rewrote the file wrote the participant's PRE-AGENT copy over the agent's edit,
// silently.
//
// ⚠ AGAINST A REAL FILESYSTEM, because every property here is about bytes and timing: whether `fs.watch`
// coalesces a save into one event or several, whether an mtime comparison sees a write inside the same second,
// whether closing a watcher actually releases it. A mocked `fs` would confirm my assumptions and prove none of
// them — the same reasoning file-ops.test.ts gives for its symlink cases.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/** Broadcasts main would have sent to the renderer. */
const sent: Array<{ channel: string; payload: any }> = [];

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
      },
    ],
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

let ROOT = "";

vi.mock("./database", () => ({
  readSetting: (key: string) => (key === "project_path" ? ROOT : null),
  writeSetting: () => {},
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

const {
  watchOpenFile,
  unwatchOpenFile,
  unwatchAll,
  rememberStamp,
  hasChangedSince,
  readStamp,
  __watchedCount,
} = await import("./file-watch");

const FILE = () => path.join(ROOT, "notes.txt");
/** `fs.watch` is asynchronous and debounced by 120ms; this is comfortably past both. */
const settle = () => new Promise((r) => setTimeout(r, 300));

/**
 * ⚠ THE WATCHER NEEDS A TICK TO ARM, and this is a real property of `fs.watch` rather than a test artefact.
 * Measured here: writing IMMEDIATELY after `watchOpenFile` produced no event at all, while the same write
 * 50ms later produced one — on macOS the FSEvents registration is not complete when the call returns.
 *
 * It is negligible in production (a file the participant just opened, written by the agent inside the same
 * few milliseconds) and it is covered anyway: the stale-write guard compares stamps at SAVE time, so the
 * consequence — overwriting the agent's edit — is caught even when the event is missed.
 */
const armed = () => new Promise((r) => setTimeout(r, 80));
const changes = () => sent.filter((s) => s.channel === "file:changed-on-disk");

beforeEach(() => {
  sent.length = 0;
  // macOS: /var is a symlink to /private/var, so the root must be the REAL path or the confinement
  // check treats legitimate children as escapes.
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filewatch-")));
  fs.writeFileSync(FILE(), "original\n");
});

afterEach(() => {
  unwatchAll();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the stamp is what 'unchanged' means", () => {
  it("reports no change straight after a read", () => {
    rememberStamp(FILE());
    expect(hasChangedSince(FILE())).toBe(false);
  });

  it("⚠ sees another writer's change", async () => {
    rememberStamp(FILE());
    // A different length, which is what the size half of the stamp is for.
    fs.writeFileSync(FILE(), "the assistant rewrote this file\n");
    expect(hasChangedSince(FILE())).toBe(true);
  });

  /**
   * ── ⚠ SIZE IS PART OF THE COMPARISON, AND THIS IS A SOURCE ASSERTION ON PURPOSE ────────────────
   *
   * mtime alone is too coarse: some filesystems carry second granularity, so a write inside the same second
   * as the read is invisible to the timestamp. The size catches those, which is why the stamp is a pair.
   *
   * ⚠ AND THE BEHAVIOURAL VERSION OF THIS CASE CANNOT BE WRITTEN HERE, which is worth recording because the
   * first attempt looked like it could. Isolating the size half means restoring the mtime exactly and
   * `fs.utimesSync` cannot — measured on APFS: 1788036563385.2773 in, 1788036563384.999 out. So the mtime
   * differs anyway and the case passed with the size comparison DELETED, asserting nothing while appearing
   * to assert the opposite. A test that cannot reach a property should say so rather than imply coverage.
   *
   * `readStamp` returning both fields is the observable half, and that IS behavioural.
   */
  it("⚠ stamps both mtime and size, since mtime alone is too coarse", () => {
    const stamp = readStamp(FILE())!;
    expect(stamp.mtimeMs).toBeGreaterThan(0);
    expect(stamp.size, "the length is recorded, not only the time").toBe(
      fs.statSync(FILE()).size
    );

    const src = fs.readFileSync(new URL("./file-watch.ts", import.meta.url), "utf8");
    expect(src, "and both are compared").toContain(
      "now.mtimeMs !== known.mtimeMs || now.size !== known.size"
    );
  });

  it("treats a deleted file as changed", () => {
    rememberStamp(FILE());
    fs.rmSync(FILE());
    expect(hasChangedSince(FILE())).toBe(true);
  });

  /**
   * ⚠ NO STAMP MEANS NOT STALE, and this must stay true: a new file the editor is creating has never been
   * read, so it has nothing to be stale against. If this inverted, a first save would fail.
   */
  it("⚠ reports no change for a path never read", () => {
    expect(hasChangedSince(path.join(ROOT, "never-read.txt"))).toBe(false);
  });
});

describe("watching an open file", () => {
  it("announces an outside write once", async () => {
    watchOpenFile(FILE());
    await armed();
    fs.writeFileSync(FILE(), "the assistant wrote this\n");
    await settle();

    expect(changes().length, "one write, one announcement").toBe(1);
    expect(changes()[0].payload.path).toBe(FILE());
  });

  /**
   * ⚠ OUR OWN SAVE MUST NOT BOUNCE BACK. `files:writeFile` re-stamps after writing, so the write it just did
   * is no longer a difference — without that filter every save would raise "this file changed on disk" at
   * the person who just saved it.
   */
  it("⚠ stays silent for a write we stamped ourselves", async () => {
    watchOpenFile(FILE());
    await armed();
    fs.writeFileSync(FILE(), "the participant saved this\n");
    rememberStamp(FILE()); // what the write handler does
    await settle();

    expect(changes().length, "our own write is not somebody else's change").toBe(0);
  });

  /**
   * ⚠ DEBOUNCED, BECAUSE ONE SAVE IS SEVERAL EVENTS. `fs.watch` reports a truncate and a write separately,
   * so an un-debounced watcher fires mid-write and reads a half-written file.
   */
  it("⚠ coalesces a rapid burst into one announcement", async () => {
    watchOpenFile(FILE());
    await armed();
    for (let i = 0; i < 5; i++) fs.writeFileSync(FILE(), `write ${i}\n`);
    await settle();

    expect(changes().length).toBe(1);
  });

  it("is idempotent — opening the same file twice watches it once", () => {
    watchOpenFile(FILE());
    watchOpenFile(FILE());
    expect(__watchedCount()).toBe(1);
  });

  it("stops announcing once the tab closes", async () => {
    watchOpenFile(FILE());
    unwatchOpenFile(FILE());
    expect(__watchedCount()).toBe(0);

    fs.writeFileSync(FILE(), "nobody is looking\n");
    await settle();
    expect(changes().length).toBe(0);
  });

  it("unwatching a file that was never watched is harmless", () => {
    expect(() => unwatchOpenFile(path.join(ROOT, "absent.txt"))).not.toThrow();
    expect(__watchedCount()).toBe(0);
  });

  it("drops every watcher on unwatchAll, for a project switch", () => {
    fs.writeFileSync(path.join(ROOT, "second.txt"), "x");
    watchOpenFile(FILE());
    watchOpenFile(path.join(ROOT, "second.txt"));
    expect(__watchedCount()).toBe(2);

    unwatchAll();
    expect(__watchedCount()).toBe(0);
  });
});

describe("⚠ it is confined like every other path the renderer names", () => {
  /**
   * A watcher is a read, and a read of a renderer-supplied path is exactly what project-paths.ts bounds. The
   * same guard, so this cannot become the one channel that learns about `~/.ssh`.
   */
  it("refuses a file outside the project", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "filewatch-outside-")));
    const target = path.join(outside, "secret.txt");
    fs.writeFileSync(target, "not yours");
    try {
      expect(() => watchOpenFile(target)).toThrow(/outside an open project/i);
      expect(__watchedCount()).toBe(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file that does not exist", () => {
    expect(() => watchOpenFile(path.join(ROOT, "nope.txt"))).toThrow();
  });
});
