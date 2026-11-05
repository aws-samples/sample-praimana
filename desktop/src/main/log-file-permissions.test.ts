// ── ⚠ BOTH LOCAL LOGS ARE OWNER-ONLY ──────────────────────────────────────────────────────────
//
// `appendFileSync(file, data)` creates with 0666 masked by the umask, commonly 0644: group- and
// world-readable. Both files describe this user's session — crash stacks and request URLs in one, who signed
// in and what the agent was allowed to run in the other — and on a shared or managed machine that made them
// readable by every other local account.
//
// ⚠ ASSERTED AGAINST A REAL FILE ON DISK, because a `mode:` option that is silently ignored looks
// exactly like one that works. The two facts that matter — the bits on a NEW file, and the bits on
// one an earlier build already created at 0644 — are only observable from the filesystem.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let userData = "";
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "1.0.0-test", on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

/** Telemetry only writes when the user has opted in, so the setting has to say yes. */
vi.mock("./database", () => ({
  readSetting: (key: string) => (key === "telemetry_enabled" ? "true" : null),
}));

import { recordTelemetry } from "./telemetry";

const TELEMETRY = () => path.join(userData, "telemetry.jsonl");
const groupOrWorldBits = (file: string) => fs.statSync(file).mode & 0o077;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "logperm-test-"));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("telemetry.jsonl", () => {
  it("is created 0600", () => {
    recordTelemetry({ source: "test", message: "boom" });
    expect(fs.existsSync(TELEMETRY())).toBe(true);
    expect(groupOrWorldBits(TELEMETRY()), "no group or world access").toBe(0);
    expect(fs.statSync(TELEMETRY()).mode & 0o777).toBe(0o600);
  });

  it("NARROWS a log an earlier build left world-readable", () => {
    // The upgrade path, which a `mode:` option alone does not cover: mode applies on CREATE only.
    fs.writeFileSync(TELEMETRY(), "", { mode: 0o644 });
    fs.chmodSync(TELEMETRY(), 0o644);
    expect(groupOrWorldBits(TELEMETRY())).not.toBe(0); // precondition

    recordTelemetry({ source: "test", message: "boom" });
    expect(groupOrWorldBits(TELEMETRY())).toBe(0);
  });

  it("stays 0600 across the rotation rewrite", () => {
    // Rotation replaces the whole file — a second chance to widen the permissions.
    for (let i = 0; i < 520; i++) recordTelemetry({ source: "test", message: `e${i}` });
    expect(groupOrWorldBits(TELEMETRY())).toBe(0);
  });

  it("still records what it is for", () => {
    // A permissions change that broke telemetry would be a poor trade.
    recordTelemetry({ source: "main:uncaughtException", message: "kaboom" });
    const rows = fs.readFileSync(TELEMETRY(), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "main:uncaughtException", message: "kaboom" });
  });
});
