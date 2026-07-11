import { describe, it, expect } from "vitest";
import { resolveV3Dtype, halfToFloat32 } from "../../src/dtype.js";
import { MetadataError } from "../../src/errors.js";

describe("v3 data_type map (FR-004)", () => {
  const cases: Array<
    [string, { ctor: unknown; byteSize: number; widen?: boolean }]
  > = [
    ["bool", { ctor: Uint8Array, byteSize: 1 }],
    ["int8", { ctor: Int8Array, byteSize: 1 }],
    ["int16", { ctor: Int16Array, byteSize: 2 }],
    ["int32", { ctor: Int32Array, byteSize: 4 }],
    ["int64", { ctor: BigInt64Array, byteSize: 8 }],
    ["uint8", { ctor: Uint8Array, byteSize: 1 }],
    ["uint16", { ctor: Uint16Array, byteSize: 2 }],
    ["uint32", { ctor: Uint32Array, byteSize: 4 }],
    ["uint64", { ctor: BigUint64Array, byteSize: 8 }],
    ["float16", { ctor: Float32Array, byteSize: 2, widen: true }],
    ["float32", { ctor: Float32Array, byteSize: 4 }],
    ["float64", { ctor: Float64Array, byteSize: 8 }],
  ];

  for (const [name, want] of cases) {
    it(`resolves ${name}`, () => {
      const resolved = resolveV3Dtype(name);
      expect(resolved.ctor).toBe(want.ctor);
      expect(resolved.byteSize).toBe(want.byteSize);
      expect(resolved.widenHalfToFloat).toBe(want.widen ?? false);
    });
  }

  it("throws MetadataError for an unknown data_type", () => {
    expect(() => resolveV3Dtype("complex64")).toThrow(MetadataError);
    expect(() => resolveV3Dtype("complex64")).toThrow(/complex64/);
    expect(() => resolveV3Dtype("r8")).toThrow(MetadataError);
  });
});

describe("float16 → float32 widening (T022)", () => {
  it("converts known half-precision bit patterns", () => {
    // 0x3C00 = 1.0, 0xC000 = -2.0, 0x3555 ≈ 0.333252, 0x0000 = 0
    const halves = new Uint16Array([0x3c00, 0xc000, 0x3555, 0x0000]);
    const out = halfToFloat32(halves);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out[0]).toBe(1.0);
    expect(out[1]).toBe(-2.0);
    expect(out[2]).toBeCloseTo(0.333252, 5);
    expect(out[3]).toBe(0);
  });

  it("handles specials: NaN, ±Infinity, subnormals, -0", () => {
    // 0x7E00 = NaN, 0x7C00 = +Inf, 0xFC00 = -Inf,
    // 0x0001 = smallest subnormal (2^-24), 0x8000 = -0
    const halves = new Uint16Array([0x7e00, 0x7c00, 0xfc00, 0x0001, 0x8000]);
    const out = halfToFloat32(halves);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(Infinity);
    expect(out[2]).toBe(-Infinity);
    expect(out[3]).toBeCloseTo(2 ** -24, 30);
    expect(Object.is(out[4], -0)).toBe(true);
  });
});
