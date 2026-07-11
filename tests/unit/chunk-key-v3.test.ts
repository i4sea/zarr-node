import { describe, it, expect } from "vitest";
import { encodeChunkKey } from "../../src/chunk/indexing.js";
import type { ChunkKeyStrategy } from "../../src/metadata/types.js";

function strategy(over: Partial<ChunkKeyStrategy> = {}): ChunkKeyStrategy {
  return {
    kind: "v3-default",
    separator: "/",
    prefix: "c",
    basePath: null,
    ...over,
  };
}

describe("v3 chunk key encoding (FR-010)", () => {
  it("v3-default: c prefix with / separator", () => {
    expect(encodeChunkKey([0, 1], strategy())).toBe("c/0/1");
    expect(encodeChunkKey([12, 3, 4], strategy())).toBe("c/12/3/4");
  });

  it("v3-default with . separator", () => {
    expect(encodeChunkKey([0, 1], strategy({ separator: "." }))).toBe("c.0.1");
  });

  it("v3-default zero-dimensional array uses just the prefix", () => {
    expect(encodeChunkKey([], strategy())).toBe("c");
  });

  it("v3-default folds in basePath", () => {
    expect(encodeChunkKey([2, 5], strategy({ basePath: "grp/arr" }))).toBe(
      "grp/arr/c/2/5",
    );
  });

  it("v2 encoding: separator-joined indices, no prefix", () => {
    expect(
      encodeChunkKey(
        [0, 1],
        strategy({ kind: "v2", separator: ".", prefix: null }),
      ),
    ).toBe("0.1");
    expect(
      encodeChunkKey(
        [3, 4],
        strategy({ kind: "v2", separator: "/", prefix: null }),
      ),
    ).toBe("3/4");
  });

  it("v2 encoding folds in basePath", () => {
    expect(
      encodeChunkKey(
        [7],
        strategy({
          kind: "v2",
          separator: ".",
          prefix: null,
          basePath: "a/b",
        }),
      ),
    ).toBe("a/b/7");
  });
});
