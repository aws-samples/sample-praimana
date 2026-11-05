// ── ⚠ THE STORE THAT HOLDS THE TRANSCRIPTS IS OWNER-ONLY TOO ──────────────────────────────────
//
// `new Database(path)` applies no mode, so `praimana.db` was created 0666 masked by the umask —
// commonly 0644, readable by every other local account. The identical exposure had already been
// recognised and fixed for the two logs (telemetry.ts, security-audit.ts), each with the 0644 rationale
// written out in a comment; this file carries strictly more than either of them — `chat_messages.content`
// is the participant's full prompts and the assistant's replies, plus chat titles, absolute project
// paths, account email/name/user id and the team invite code, all cleartext TEXT.
//
// ⚠ ASSERTED AGAINST REAL FILES ON DISK, for the reason log-file-permissions.test.ts gives: a mode that
// is silently ignored looks exactly like one that works, and the two facts that matter — the bits on a
// NEW file, and the bits on one an earlier build already created at 0644 — are only observable from the
// filesystem.
//
// ⚠ POSIX ONLY. Windows has no POSIX mode and the production code deliberately swallows the failure, so
// these cases would assert nothing there.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isPosix = process.platform !== "win32";

let userData = "";
vi.mock("electron", () => ({
  app: { getPath: () => userData, setPath: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
}));

const { initDatabase } = await import("./database");
const { writeProfileMeta, profileDir } = await import("./profile");

const DB = () => path.join(userData, "praimana.db");
const groupOrWorldBits = (file: string) => fs.statSync(file).mode & 0o077;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "storeperm-test-"));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe.skipIf(!isPosix)("praimana.db", () => {
  it("is created 0600", async () => {
    await initDatabase();

    expect(fs.existsSync(DB())).toBe(true);
    expect(groupOrWorldBits(DB()), "no group or world access").toBe(0);
    expect(fs.statSync(DB()).mode & 0o777).toBe(0o600);
  });

  /**
   * ⚠ THE WAL SIDECARS ARE THE EASY ONES TO FORGET, and the `-wal` holds the most RECENTLY written
   * pages — i.e. the newest transcript content. Narrowing only the main file would leave the freshest
   * data at 0644, which is the worst possible half-fix.
   */
  it("narrows the WAL sidecars, not just the main file", async () => {
    await initDatabase();

    // `journal_mode = WAL` creates these; assert on the ones that actually exist.
    const sidecars = [`${DB()}-wal`, `${DB()}-shm`].filter((f) => fs.existsSync(f));
    expect(sidecars.length, "WAL mode must have produced at least one sidecar").toBeGreaterThan(0);
    for (const file of sidecars) {
      expect(groupOrWorldBits(file), `${path.basename(file)} must be owner-only`).toBe(0);
    }
  });

  /**
   * ⚠ THE UPGRADE PATH, which a `mode:` option alone would not cover: a mode applies when a file is
   * CREATED, so a database an earlier build wrote at 0644 keeps those bits for ever without a chmod on
   * every open. This is the case that matters in practice — every existing install is this case.
   */
  it("⚠ NARROWS a database an earlier build left world-readable", async () => {
    fs.writeFileSync(DB(), "");
    fs.chmodSync(DB(), 0o644);
    expect(groupOrWorldBits(DB()), "precondition: starts group/world-readable").not.toBe(0);

    await initDatabase();

    expect(groupOrWorldBits(DB())).toBe(0);
  });

  it("still opens and migrates the database", async () => {
    // A permissions change that broke the store would be a poor trade.
    await initDatabase();

    const { getDb } = await import("./database");
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("settings");
    expect(names).toContain("chat_messages");
    expect(names).toContain("accounts");
  });
});

/**
 * ── ⚠ AND THE PROFILE SIDECAR, WHICH HAD THE SAME OMISSION ────────────────────────────────────
 *
 * `writeProfileMeta` wrote `profile.json` with no mode, so the umask decided. It is not a cosmetic file:
 * `ProfileMeta` carries `label` and `team`, and the label is set from the signed-in person's name or
 * email — so at 0644 it answers "who uses this machine, and which team are they on" to any other local
 * account.
 *
 * ⚠ THE DIRECTORY MODE IS THE ONE THAT ACTUALLY BOUNDS THE PROBLEM, and it is why this belongs beside
 * the database cases rather than in profile.test.ts. The profile directory is what that profile's SQLite
 * store sits in, so 0700 stops a reader who is not this OS user from traversing to it whatever the modes
 * inside say. The finding could not verify the containing directory because it depends on the install;
 * setting it here means it no longer depends on the install.
 *
 * ⚠ `profileDir` MEMOISES THE ROOT on first call, so these cases derive every path from it rather than
 * rebuilding one from `userData` — which changes per test and would silently assert against a directory
 * nothing was written to.
 */
describe.skipIf(!isPosix)("profile.json", () => {
  const PROFILE_ID = "team-b";

  it("is created 0600, in a 0700 directory", () => {
    writeProfileMeta(PROFILE_ID, { label: "Jane Doe", team: "Team B" });

    const dir = profileDir(PROFILE_ID);
    const file = path.join(dir, "profile.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777, "the sidecar is owner-only").toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777, "and so is the directory holding the store").toBe(0o700);
  });

  /** The upgrade path again: a mode applies on create, so an existing install needs the chmod. */
  it("⚠ NARROWS a sidecar and directory an earlier build left readable", () => {
    const dir = profileDir(PROFILE_ID);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, "profile.json");
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o644);
    expect(groupOrWorldBits(file), "precondition").not.toBe(0);
    expect(groupOrWorldBits(dir), "precondition").not.toBe(0);

    writeProfileMeta(PROFILE_ID, { label: "Jane Doe" });

    expect(groupOrWorldBits(file)).toBe(0);
    expect(groupOrWorldBits(dir)).toBe(0);
  });

  it("still records the label it exists to record", () => {
    // A permissions change that broke the profile chooser would be a poor trade.
    writeProfileMeta(PROFILE_ID, { label: "Jane Doe", team: "Team B" });

    const parsed = JSON.parse(
      fs.readFileSync(path.join(profileDir(PROFILE_ID), "profile.json"), "utf8")
    );
    expect(parsed).toMatchObject({ label: "Jane Doe", team: "Team B" });
  });

  it("merges into an existing sidecar rather than replacing it", () => {
    // The pre-existing behaviour, re-asserted because the write now passes options as well as content.
    writeProfileMeta(PROFILE_ID, { label: "Jane Doe", team: "Team B" });
    writeProfileMeta(PROFILE_ID, { lastUsedAt: "2026-08-23T10:00:00Z" });

    const parsed = JSON.parse(
      fs.readFileSync(path.join(profileDir(PROFILE_ID), "profile.json"), "utf8")
    );
    expect(parsed).toMatchObject({
      label: "Jane Doe",
      team: "Team B",
      lastUsedAt: "2026-08-23T10:00:00Z",
    });
  });
});
