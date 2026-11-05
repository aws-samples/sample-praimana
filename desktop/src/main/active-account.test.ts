// ── ⚠ THE TWO-KEY READ EVERY ACCOUNT-SCOPED QUERY DEPENDS ON ────────────────────────────────────
//
// Three findings were the same omission — a query that should have
// been scoped to the active local account and was not. The predicate is only as good as this
// function, and the FALLBACK is the part that would break the app if it were dropped: an install
// that has never used the multi-account switcher has `user_id` and no `active_user_id`, so
// `readSetting("active_user_id")` alone would scope every query to NULL and empty the app.

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();

vi.mock("./database", () => ({
  readSetting: (key: string) => store.get(key) ?? null,
}));

import { activeUserId } from "./active-account";

beforeEach(() => store.clear());

describe("activeUserId", () => {
  it("prefers the switched account over the signed-in one", () => {
    store.set("user_id", "user-1");
    store.set("active_user_id", "user-2");
    expect(activeUserId()).toBe("user-2");
  });

  /** ⚠ THE CASE THAT WOULD EMPTY THE APP IF THE FALLBACK WERE REMOVED. */
  it("falls back to user_id on an install that has never switched accounts", () => {
    store.set("user_id", "user-1");
    expect(activeUserId()).toBe("user-1");
  });

  it("is null when nobody is signed in", () => {
    expect(activeUserId()).toBeNull();
  });

  /**
   * A cleared setting is realistically "" or whitespace rather than absent — `auth:signOut` writes
   * `""` — and `user_id = ''` would match no row while also not being recognised as "nobody".
   */
  it("treats a blank value as nobody, not as an account named blank", () => {
    store.set("user_id", "   ");
    store.set("active_user_id", "");
    expect(activeUserId()).toBeNull();
  });
});
