import { describe, it, expect, vi } from "vitest";

// Mock Electron's safeStorage with a reversible base64 "cipher" so we can test
// the enc:v1: framing, sensitivity gating, and legacy passthrough without the
// OS keychain. better-sqlite3 is also imported by database.ts at module load;
// stub it so the module can be imported in a plain Node test.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`CIPHER:${s}`, "utf-8"),
    decryptString: (buf: Buffer) => buf.toString("utf-8").replace(/^CIPHER:/, ""),
  },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));

import {
  isSensitiveSetting,
  encryptSettingValue,
  decryptSettingValue,
} from "./database";

describe("settings encryption (EA-H1: credentials at rest)", () => {
  it("marks only sensitive keys as sensitive", () => {
    expect(isSensitiveSetting("user_password")).toBe(true);
    expect(isSensitiveSetting("auth_token")).toBe(true);
    expect(isSensitiveSetting("server_url")).toBe(false);
    expect(isSensitiveSetting("team_id")).toBe(false);
  });

  it("encrypts sensitive values with the enc:v1: prefix", () => {
    const enc = encryptSettingValue("auth_token", "secret-token");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("secret-token"); // not stored in cleartext
  });

  it("round-trips sensitive values", () => {
    const enc = encryptSettingValue("user_password", "hunter2");
    expect(decryptSettingValue(enc)).toBe("hunter2");
  });

  it("does not encrypt non-sensitive values", () => {
    const v = encryptSettingValue("server_url", "http://localhost:4000");
    expect(v).toBe("http://localhost:4000");
  });

  it("does not encrypt empty strings (used to clear a setting)", () => {
    expect(encryptSettingValue("auth_token", "")).toBe("");
  });

  it("passes through legacy plaintext on read (backward compatible)", () => {
    // Values written before encryption existed have no enc:v1: prefix.
    expect(decryptSettingValue("legacy-plaintext-token")).toBe("legacy-plaintext-token");
  });

  it("returns null unchanged", () => {
    expect(decryptSettingValue(null)).toBe(null);
  });
});
