import { describe, it, expect } from "vitest";
import {
  normalizeSelection,
  computeSliceChunkRanges,
} from "../../src/chunk/indexing.js";

describe("normalizeSelection", () => {
  it("converts null to full range", () => {
    const result = normalizeSelection([null], [100]);
    expect(result).toEqual([{ start: 0, stop: 100 }]);
  });

  it("converts number to single-element range", () => {
    const result = normalizeSelection([5], [100]);
    expect(result).toEqual([{ start: 5, stop: 6 }]);
  });

  it("passes through [start, stop] tuple", () => {
    const result = normalizeSelection([[10, 20]], [100]);
    expect(result).toEqual([{ start: 10, stop: 20 }]);
  });

  it("handles multi-dimensional selection", () => {
    const result = normalizeSelection([null, [5, 15], 3], [100, 200, 50]);
    expect(result).toEqual([
      { start: 0, stop: 100 },
      { start: 5, stop: 15 },
      { start: 3, stop: 4 },
    ]);
  });
});

describe("computeSliceChunkRanges", () => {
  it("returns correct chunks for a single-chunk slice", () => {
    // shape [100, 200], chunks [10, 20], slice [0:5, 0:10]
    const result = computeSliceChunkRanges(
      [
        { start: 0, stop: 5 },
        { start: 0, stop: 10 },
      ],
      [10, 20],
    );
    expect(result).toEqual([[0], [0]]);
  });

  it("returns multiple chunks when slice spans chunk boundaries", () => {
    // shape [100, 200], chunks [10, 20], slice [0:15, 0:25]
    const result = computeSliceChunkRanges(
      [
        { start: 0, stop: 15 },
        { start: 0, stop: 25 },
      ],
      [10, 20],
    );
    expect(result).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it("handles slice starting mid-chunk", () => {
    // chunks [10], slice [5:15] -> chunks 0 and 1
    const result = computeSliceChunkRanges([{ start: 5, stop: 15 }], [10]);
    expect(result).toEqual([[0, 1]]);
  });

  it("handles single element selection", () => {
    // chunks [10], slice [25:26] -> chunk 2
    const result = computeSliceChunkRanges([{ start: 25, stop: 26 }], [10]);
    expect(result).toEqual([[2]]);
  });
});
