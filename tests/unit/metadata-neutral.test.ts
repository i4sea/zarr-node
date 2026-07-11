import { describe, it, expect } from "vitest";
import { parseZarrayMeta, toResolvedArrayMeta } from "../../src/metadata/v2.js";
import { CodecPipeline } from "../../src/codec/pipeline.js";

function sampleZarray(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    zarr_format: 2,
    shape: [100, 200],
    chunks: [10, 20],
    dtype: "<f4",
    compressor: null,
    fill_value: 0,
    order: "C",
    dimension_separator: ".",
    filters: null,
    ...overrides,
  });
}

describe("v2 → neutral metadata adapter", () => {
  it("maps a parsed .zarray to ResolvedArrayMeta", () => {
    const meta = parseZarrayMeta(sampleZarray());
    const resolved = toResolvedArrayMeta(
      meta,
      { units: "m" },
      "path/to/arr",
      CodecPipeline.passthrough(),
    );

    expect(resolved.zarrFormat).toBe(2);
    expect(resolved.shape).toEqual([100, 200]);
    expect(resolved.chunkShape).toEqual([10, 20]);
    expect(resolved.dtypeName).toBe("<f4");
    expect(resolved.dtype.ctor).toBe(Float32Array);
    expect(resolved.dtype.byteSize).toBe(4);
    expect(resolved.dtype.byteOrder).toBe("little");
    expect(resolved.dtype.widenHalfToFloat).toBe(false);
    expect(resolved.order).toBe("C");
    expect(resolved.attrs).toEqual({ units: "m" });
  });

  it("builds a v2 ChunkKeyStrategy from dimension_separator and basePath", () => {
    const meta = parseZarrayMeta(sampleZarray({ dimension_separator: "/" }));
    const resolved = toResolvedArrayMeta(
      meta,
      {},
      "grp/arr",
      CodecPipeline.passthrough(),
    );

    expect(resolved.chunkKey.kind).toBe("v2");
    expect(resolved.chunkKey.separator).toBe("/");
    expect(resolved.chunkKey.prefix).toBeNull();
    expect(resolved.chunkKey.basePath).toBe("grp/arr");
  });

  it("uses a null basePath at the store root", () => {
    const meta = parseZarrayMeta(sampleZarray());
    const resolved = toResolvedArrayMeta(
      meta,
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(resolved.chunkKey.basePath).toBeNull();
    expect(resolved.chunkKey.separator).toBe(".");
  });

  it("resolves big-endian and single-byte dtypes to the right byte order", () => {
    const big = toResolvedArrayMeta(
      parseZarrayMeta(sampleZarray({ dtype: ">i2" })),
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(big.dtype.ctor).toBe(Int16Array);
    expect(big.dtype.byteOrder).toBe("big");

    const one = toResolvedArrayMeta(
      parseZarrayMeta(sampleZarray({ dtype: "|u1" })),
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(one.dtype.byteOrder).toBe("none");
  });

  it("resolves special v2 fill values", () => {
    const nan = toResolvedArrayMeta(
      parseZarrayMeta(sampleZarray({ fill_value: "NaN" })),
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(Number.isNaN(nan.fillValue as number)).toBe(true);

    const inf = toResolvedArrayMeta(
      parseZarrayMeta(sampleZarray({ fill_value: "Infinity" })),
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(inf.fillValue).toBe(Infinity);

    const ninf = toResolvedArrayMeta(
      parseZarrayMeta(sampleZarray({ fill_value: "-Infinity" })),
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(ninf.fillValue).toBe(-Infinity);

    const nil = toResolvedArrayMeta(
      parseZarrayMeta(sampleZarray({ fill_value: null })),
      {},
      "",
      CodecPipeline.passthrough(),
    );
    expect(nil.fillValue).toBeNull();
  });
});
