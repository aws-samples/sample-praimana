import { describe, it, expect } from "vitest";
import { newestCreatedAt, mergeTail, prependOlder } from "./thread-pagination";

const m = (id: string, createdAt?: string) => ({ id, createdAt });

describe("newestCreatedAt — the `since` cursor for an incremental refresh", () => {
  it("returns the max createdAt", () => {
    expect(newestCreatedAt([m("a", "2026-01-01T00:00:01Z"), m("b", "2026-01-01T00:00:03Z"), m("c", "2026-01-01T00:00:02Z")]))
      .toBe("2026-01-01T00:00:03Z");
  });
  it("is undefined for an empty list or rows with no createdAt", () => {
    expect(newestCreatedAt([])).toBeUndefined();
    expect(newestCreatedAt([m("a"), m("b")])).toBeUndefined();
  });
});

describe("mergeTail — append only genuinely new rows", () => {
  it("appends ids not already held, in order", () => {
    const held = [m("a"), m("b")];
    expect(mergeTail(held, [m("c"), m("d")]).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("drops a boundary row already held (at-least-once / clock-tie dedup)", () => {
    const held = [m("a"), m("b")];
    expect(mergeTail(held, [m("b"), m("c")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("returns the SAME reference when nothing is new, so the caller can skip a re-render", () => {
    const held = [m("a"), m("b")];
    expect(mergeTail(held, [])).toBe(held);
    expect(mergeTail(held, [m("a")])).toBe(held);
  });
});

describe("prependOlder — put an older page above, without duplicating", () => {
  it("prepends older rows, preserving ascending order", () => {
    const held = [m("c"), m("d")];
    expect(prependOlder(held, [m("a"), m("b")]).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("drops an overlapping boundary row", () => {
    const held = [m("c"), m("d")];
    expect(prependOlder(held, [m("b"), m("c")]).map((x) => x.id)).toEqual(["b", "c", "d"]);
  });
  it("returns the SAME reference when the page adds nothing", () => {
    const held = [m("c")];
    expect(prependOlder(held, [])).toBe(held);
    expect(prependOlder(held, [m("c")])).toBe(held);
  });
});
