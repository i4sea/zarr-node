import { describe, it, expect } from "vitest";
import { coalesceRanges } from "../../src/codec/sharding.js";

interface Item {
  offset: number;
  length: number;
  tag: string;
}

function item(offset: number, length: number, tag: string): Item {
  return { offset, length, tag };
}

describe("byte-range coalescing (FR-015)", () => {
  it("always merges exactly-contiguous ranges", () => {
    const spans = coalesceRanges(
      [item(0, 10, "a"), item(10, 10, "b"), item(20, 5, "c")],
      0,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].offset).toBe(0);
    expect(spans[0].length).toBe(25);
    expect(spans[0].items.map((i) => i.tag)).toEqual(["a", "b", "c"]);
  });

  it("merges ranges whose gap is ≤ the threshold", () => {
    const spans = coalesceRanges([item(0, 10, "a"), item(30, 10, "b")], 20);
    expect(spans).toHaveLength(1);
    expect(spans[0].offset).toBe(0);
    expect(spans[0].length).toBe(40); // covers the 20-byte gap
  });

  it("keeps ranges separate when the gap exceeds the threshold", () => {
    const spans = coalesceRanges([item(0, 10, "a"), item(31, 10, "b")], 20);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ offset: 0, length: 10 });
    expect(spans[1]).toMatchObject({ offset: 31, length: 10 });
  });

  it("sorts unordered input by offset before coalescing", () => {
    const spans = coalesceRanges(
      [item(20, 5, "c"), item(0, 10, "a"), item(10, 10, "b")],
      0,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].items.map((i) => i.tag)).toEqual(["a", "b", "c"]);
  });

  it("a zero threshold does not merge ranges with any gap", () => {
    const spans = coalesceRanges([item(0, 10, "a"), item(11, 4, "b")], 0);
    expect(spans).toHaveLength(2);
  });

  it("handles a single range and empty input", () => {
    expect(coalesceRanges([item(5, 3, "x")], 1024)).toHaveLength(1);
    expect(coalesceRanges([], 1024)).toEqual([]);
  });
});
