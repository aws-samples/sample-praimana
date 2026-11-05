// ── ⚠ AN ID IS A SEGMENT, NEVER A PATH ──────────────────────────────────────────────────────────
//
// The exploit needs no encoding trick — `fetch` hands the string to the WHATWG URL parser, which collapses
// `..` and honours `?` and `#`:
//
//     new URL("https://api.example/v1/ai/threads/x/../../../v1/auth/me?z=/messages").pathname
//       →  "/v1/auth/me"
//
// So the tests below are not about "weird characters". They are about the exact five characters that
// let one segment become a different endpoint: `/ \ ? # %` — plus the fact that a legitimate id has
// never contained any of them.

import { describe, it, expect } from "vitest";
import { isSafeRowId, assertSafeRowId, MAX_ROW_ID_LENGTH } from "./row-id";

describe("isSafeRowId", () => {
  it("accepts the id the app actually generates", () => {
    // Every call site in src/renderer uses crypto.randomUUID().
    expect(isSafeRowId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
  });

  it("accepts the wider set a future server id scheme might use", () => {
    for (const id of ["thread_42", "team.alpha", "urn:thread:9", "A-b_C.9"]) {
      expect(isSafeRowId(id), id).toBe(true);
    }
  });

  /** The characters that rewrite a URL rather than name a resource. */
  it.each([
    ["a forward slash", "x/../../../v1/auth/me"],
    ["a backslash", "x\\..\\y"],
    ["a query", "s1?token=leak"],
    ["a fragment", "s1#frag"],
    ["a percent escape", "s1%2f..%2f"],
    ["a space", "s 1"],
    ["a newline", "s1\nHost: evil"],
  ])("refuses %s", (_label, id) => {
    expect(isSafeRowId(id)).toBe(false);
  });

  /**
   * ⚠ ALL-DOTS IS REFUSED even though `.` is on the allowlist. A single segment cannot traverse on
   * its own, so this is not the traversal fix — it is that an id of only dots is never a real id,
   * and the same rule already exists in `sanitiseProfileName`.
   */
  it("refuses an all-dots id", () => {
    expect(isSafeRowId(".")).toBe(false);
    expect(isSafeRowId("..")).toBe(false);
    expect(isSafeRowId("....")).toBe(false);
    expect(isSafeRowId("..a")).toBe(true);
  });

  it("refuses empty and non-string values", () => {
    expect(isSafeRowId("")).toBe(false);
    expect(isSafeRowId(undefined)).toBe(false);
    expect(isSafeRowId(null)).toBe(false);
    expect(isSafeRowId(42)).toBe(false);
    expect(isSafeRowId({ toString: () => "ok" })).toBe(false);
  });

  it("bounds the length", () => {
    expect(isSafeRowId("a".repeat(MAX_ROW_ID_LENGTH))).toBe(true);
    expect(isSafeRowId("a".repeat(MAX_ROW_ID_LENGTH + 1))).toBe(false);
  });
});

describe("assertSafeRowId", () => {
  it("returns the id when it is safe", () => {
    expect(assertSafeRowId("s1", "chat")).toBe("s1");
  });

  it("names what was rejected", () => {
    expect(() => assertSafeRowId("a/b", "chat")).toThrow(/chat id/);
  });

  /**
   * ⚠ THE REJECTED VALUE IS NOT IN THE MESSAGE. It came from the renderer and this message reaches a
   * log file and, on some paths, a UI string — echoing an attacker-chosen path fragment into either
   * turns a refusal into an injection of its own.
   */
  it("does not echo the rejected value", () => {
    let message = "";
    try {
      assertSafeRowId("x/../../../v1/auth/me", "chat");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("auth/me");
    expect(message).not.toContain("..");
  });
});
