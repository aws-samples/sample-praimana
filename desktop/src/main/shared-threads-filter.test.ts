import { describe, it, expect } from "vitest";
import { excludeOwnThreads } from "./shared-threads-filter";

describe("excludeOwnThreads — the Team Chats list hides your own shared chats", () => {
  const rows = [
    { id: "t1", sharedById: "me" },
    { id: "t2", sharedById: "alice" },
    { id: "t3", sharedById: "bob" },
  ];

  it("drops rows the current account shared", () => {
    const out = excludeOwnThreads(rows, "me");
    expect(out.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("keeps every row when nobody is signed in (me is null)", () => {
    expect(excludeOwnThreads(rows, null)).toEqual(rows);
  });

  it("keeps a row with no sharer id — a legacy share is almost never the caller's", () => {
    const legacy = [{ id: "t1" }, { id: "t2", sharedById: "me" }];
    expect(excludeOwnThreads(legacy, "me").map((t) => t.id)).toEqual(["t1"]);
  });

  it("keeps a row whose sharedById is not a string", () => {
    const odd = [{ id: "t1", sharedById: 123 }, { id: "t2", sharedById: "me" }];
    expect(excludeOwnThreads(odd, "me").map((t) => t.id)).toEqual(["t1"]);
  });

  it("drops ALL rows when the whole list is the caller's own", () => {
    const allMine = [{ id: "t1", sharedById: "me" }, { id: "t2", sharedById: "me" }];
    expect(excludeOwnThreads(allMine, "me")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    excludeOwnThreads(input, "me");
    expect(input).toHaveLength(3);
  });
});
