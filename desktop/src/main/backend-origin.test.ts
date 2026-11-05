import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ── WHAT THESE TESTS USED TO ASSERT, AND WHY THEY CHANGED ──
 *
 * This file used to pin that `backendOrigin()` took NO arguments and could not be
 * influenced by a caller or by `process.env` — the build-time pin addressing the
 * caller-chosen-provider risk. That property is deliberately gone: the origin is now DISCOVERED from a portal
 * URL the participant configures.
 *
 * The security properties did not go away, they MOVED. They are enforced in
 * `platform-config.ts` and pinned in `platform-config.test.ts` — above all that the
 * Cognito Hosted UI domain must be an AWS-owned host, which is the control that replaces
 * the pin (it is what stops a hostile portal from collecting a password).
 *
 * What is left to test here is narrower and still worth pinning: this accessor must
 * report "not configured" HONESTLY rather than inventing a fallback, and it must not
 * mangle the origin it returns.
 */

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
}));
vi.mock("better-sqlite3", () => ({ default: class {} }));

const store = new Map<string, string>();
vi.mock("./database", () => ({
  readSetting: (key: string) => store.get(key) ?? null,
  writeSetting: (key: string, value: string) => {
    store.set(key, value);
  },
  getDb: () => ({ transaction: (fn: () => void) => () => fn() }),
}));

import { backendOrigin, backendOriginOrNull } from "./backend-origin";

beforeEach(() => {
  store.clear();
});

describe("backendOrigin", () => {
  /**
   * ⚠ NO INVENTED FALLBACK. A hard-coded default here would be a platform the
   * participant never chose, and every request to it would fail in a way that looks like
   * a network problem rather than a missing setup step. The previous version of this file
   * asserted the opposite (that a default was always returned) because the value was
   * pinned; now that it is configured, silence about being unconfigured is the bug.
   */
  it("returns null when nothing is configured, rather than guessing an origin", () => {
    expect(backendOriginOrNull()).toBeNull();
  });

  it("throws a message naming the FIX when a caller demands an origin it does not have", () => {
    // The error is user-visible via the login handler, so it has to say what to do —
    // "undefined is not a string" three frames deep does not.
    expect(() => backendOrigin()).toThrow(/platform URL/i);
  });

  it("returns the configured origin", () => {
    store.set("server_url", "https://api.example.com");
    expect(backendOriginOrNull()).toBe("https://api.example.com");
    expect(backendOrigin()).toBe("https://api.example.com");
  });

  it("strips trailing slashes, so `${origin}/v1/...` cannot double up", () => {
    // `${url}/v1/auth/config` is built by concatenation in a dozen places; `//v1/...`
    // 404s on some gateways rather than normalising. Cheap invariant, annoying bug.
    store.set("server_url", "https://api.example.com///");
    expect(backendOrigin()).toBe("https://api.example.com");
  });

  it("treats a whitespace-only setting as unconfigured", () => {
    // A cleared row is realistically "" or " " rather than absent, and a blank origin
    // would produce requests to `/v1/...` against nothing.
    store.set("server_url", "   ");
    expect(backendOriginOrNull()).toBeNull();
  });

  it("reads the CURRENT setting on every call — the platform can change at runtime", () => {
    // The old version pinned the opposite (stable across calls) because the value was a
    // build constant. Now a platform change must be visible immediately: a cached origin
    // would keep sending requests to the platform the user just left.
    store.set("server_url", "https://first.example.com");
    expect(backendOrigin()).toBe("https://first.example.com");
    store.set("server_url", "https://second.example.com");
    expect(backendOrigin()).toBe("https://second.example.com");
  });
});
