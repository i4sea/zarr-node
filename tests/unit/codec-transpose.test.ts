import { describe, it, expect } from "vitest";
import { TransposeCodec } from "../../src/codec/transpose.js";
import type { ChunkDecodeContext } from "../../src/codec/pipeline.js";
import { CodecError, MetadataError } from "../../src/errors.js";
import { resolveV3Dtype } from "../../src/dtype.js";

function ctx(chunkShape: number[], dtypeName = "int32"): ChunkDecodeContext {
  return { chunkShape, dtype: resolveV3Dtype(dtypeName) };
}

function i32(...values: number[]): Uint8Array {
  return new Uint8Array(new Int32Array(values).buffer);
}

describe("transpose codec (FR-008)", () => {
  it("inverts a 2D axis permutation with known input/output", async () => {
    // Original chunk A (shape [2, 3], C-order): [[1,2,3],[4,5,6]]
    // Encoded (numpy transpose order (1,0), shape [3, 2], C-order):
    //   [[1,4],[2,5],[3,6]] → flat [1,4,2,5,3,6]
    const codec = new TransposeCodec({ id: "transpose", order: [1, 0] });
    const stored = i32(1, 4, 2, 5, 3, 6);

    const decoded = await codec.decode(stored, ctx([2, 3]));
    expect(Array.from(new Int32Array(decoded.buffer, decoded.byteOffset, 6)))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("inverts a 3D permutation", async () => {
    // A shape [2, 2, 2], values 0..7 in C-order. order = [2, 0, 1]:
    // B = A.transpose(2, 0, 1); B[k, i, j] = A[i, j, k].
    // B flat (C-order over [2,2,2]): B[0,0,0]=A[0,0,0]=0, B[0,0,1]=A[0,1,0]=2,
    // B[0,1,0]=A[1,0,0]=4, B[0,1,1]=A[1,1,0]=6, B[1,0,0]=A[0,0,1]=1,
    // B[1,0,1]=A[0,1,1]=3, B[1,1,0]=A[1,0,1]=5, B[1,1,1]=A[1,1,1]=7
    const codec = new TransposeCodec({ id: "transpose", order: [2, 0, 1] });
    const stored = i32(0, 2, 4, 6, 1, 3, 5, 7);

    const decoded = await codec.decode(stored, ctx([2, 2, 2]));
    expect(Array.from(new Int32Array(decoded.buffer, decoded.byteOffset, 8)))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("identity permutation round-trips", async () => {
    const codec = new TransposeCodec({ id: "transpose", order: [0, 1] });
    const stored = i32(1, 2, 3, 4, 5, 6);
    const decoded = await codec.decode(stored, ctx([2, 3]));
    expect(Array.from(new Int32Array(decoded.buffer, decoded.byteOffset, 6)))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("handles 8-byte elements bit-exactly", async () => {
    const codec = new TransposeCodec({ id: "transpose", order: [1, 0] });
    const values = new BigUint64Array([1n, 3n, 2n, 4n]); // [[1,3],[2,4]] = A.T
    const stored = new Uint8Array(values.buffer);
    const decoded = await codec.decode(stored, ctx([2, 2], "uint64"));
    expect(
      Array.from(new BigUint64Array(decoded.buffer, decoded.byteOffset, 4)),
    ).toEqual([1n, 2n, 3n, 4n]);
  });

  it("rejects an invalid order configuration", () => {
    expect(
      () => new TransposeCodec({ id: "transpose", order: [0, 0] }),
    ).toThrow(MetadataError);
    expect(() => new TransposeCodec({ id: "transpose", order: 3 })).toThrow(
      MetadataError,
    );
    expect(
      () => new TransposeCodec({ id: "transpose" }),
    ).toThrow(MetadataError);
  });

  it("throws when decoded without a chunk context", async () => {
    const codec = new TransposeCodec({ id: "transpose", order: [1, 0] });
    await expect(codec.decode(i32(1, 2, 3, 4))).rejects.toThrow(CodecError);
  });

  it("rejects a rank mismatch between order and chunk shape", async () => {
    const codec = new TransposeCodec({ id: "transpose", order: [1, 0] });
    await expect(codec.decode(i32(0), ctx([1, 1, 1]))).rejects.toThrow(
      CodecError,
    );
  });

  it("decodes 4-byte data from a misaligned input buffer", async () => {
    // Simulate an upstream stage handing us a view at a non-4-aligned
    // byteOffset (e.g. a pooled Buffer or an odd-offset subarray): a naked
    // `new Uint32Array(buf, offset)` would throw RangeError.
    const codec = new TransposeCodec({ id: "transpose", order: [1, 0] });
    const payload = i32(1, 4, 2, 5, 3, 6); // 24 bytes
    const padded = new Uint8Array(payload.byteLength + 1);
    padded.set(payload, 1);
    const misaligned = padded.subarray(1); // byteOffset === 1
    expect(misaligned.byteOffset % 4).not.toBe(0);

    const decoded = await codec.decode(misaligned, ctx([2, 3]));
    // Read defensively (decoded may itself be at any offset).
    const view = new DataView(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
    expect(
      Array.from({ length: 6 }, (_, i) => view.getInt32(i * 4, true)),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("decodes 8-byte data from a misaligned input buffer", async () => {
    const codec = new TransposeCodec({ id: "transpose", order: [1, 0] });
    const values = new BigUint64Array([1n, 3n, 2n, 4n]);
    const payload = new Uint8Array(values.buffer);
    const padded = new Uint8Array(payload.byteLength + 3);
    padded.set(payload, 3);
    const misaligned = padded.subarray(3); // byteOffset === 3
    expect(misaligned.byteOffset % 8).not.toBe(0);

    const decoded = await codec.decode(misaligned, ctx([2, 2], "uint64"));
    const view = new DataView(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
    expect(
      Array.from({ length: 4 }, (_, i) => view.getBigUint64(i * 8, true)),
    ).toEqual([1n, 2n, 3n, 4n]);
  });
});
