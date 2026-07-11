// v3 `transpose` codec (array→array): the encoded chunk is the numpy-style
// transpose of the original by the declared axis `order`; decode applies the
// inverse permutation to restore C-order over the chunk shape (FR-008).
import { CodecError, MetadataError } from "../errors.js";
import type { ChunkDecodeContext, PipelineCodec } from "./pipeline.js";

export interface TransposeCodecConfig {
  id: string;
  order?: unknown;
}

/**
 * Element-size views that copy bit-exactly (no float canonicalization).
 *
 * A multi-byte typed-array view requires `byteOffset` to be a multiple of the
 * element size; upstream decode stages (or a store returning a pooled Buffer)
 * make no such guarantee, so we realign into a fresh 0-offset buffer when the
 * incoming offset is unaligned. The 1-byte view is always safe.
 */
function elementView(
  data: Uint8Array,
  byteSize: number,
  elements: number,
): Uint8Array | Uint16Array | Uint32Array | BigUint64Array {
  if (byteSize > 1 && data.byteOffset % byteSize !== 0) {
    // `.slice()` copies into a new ArrayBuffer at offset 0 — always aligned.
    data = data.slice();
  }
  switch (byteSize) {
    case 1:
      return new Uint8Array(data.buffer, data.byteOffset, elements);
    case 2:
      return new Uint16Array(data.buffer, data.byteOffset, elements);
    case 4:
      return new Uint32Array(data.buffer, data.byteOffset, elements);
    case 8:
      return new BigUint64Array(data.buffer, data.byteOffset, elements);
    default:
      throw new CodecError(
        `transpose: unsupported element size ${byteSize} bytes`,
      );
  }
}

export class TransposeCodec implements PipelineCodec {
  readonly id = "transpose";
  readonly usesContext = true;
  /** Declared (encode) axis permutation. */
  readonly order: number[];

  constructor(config: TransposeCodecConfig) {
    const order = config.order;
    if (
      !Array.isArray(order) ||
      order.length === 0 ||
      order.some((v) => typeof v !== "number" || !Number.isInteger(v)) ||
      new Set(order).size !== order.length ||
      order.some((v: number) => v < 0 || v >= order.length)
    ) {
      throw new MetadataError(
        `Invalid "transpose" codec order: ${JSON.stringify(order)}. ` +
          `Must be a permutation of [0..rank-1].`,
      );
    }
    this.order = order as number[];
  }

  async decode(
    data: Uint8Array,
    ctx?: ChunkDecodeContext,
  ): Promise<Uint8Array> {
    if (!ctx) {
      throw new CodecError(
        "transpose codec requires a chunk decode context (chunk shape + dtype)",
      );
    }
    const shape = ctx.chunkShape; // original chunk shape (decode target)
    const ndim = shape.length;
    if (this.order.length !== ndim) {
      throw new CodecError(
        `transpose order rank ${this.order.length} does not match chunk ` +
          `rank ${ndim}`,
      );
    }

    const byteSize = ctx.dtype.byteSize;
    const elements = shape.reduce((a, b) => a * b, 1);
    if (data.byteLength !== elements * byteSize) {
      throw new CodecError(
        `transpose: chunk has ${data.byteLength} bytes, expected ` +
          `${elements * byteSize} (${elements} × ${byteSize}-byte elements)`,
      );
    }

    // Encoded array B = transpose(A, order): B.shape[i] = shape[order[i]],
    // and A[idx] = B[j] with j[i] = idx[order[i]]. Walk A in C-order and
    // gather each element from its position in B.
    const encodedShape = this.order.map((axis) => shape[axis]);
    const encodedStrides = new Array<number>(ndim);
    encodedStrides[ndim - 1] = 1;
    for (let d = ndim - 2; d >= 0; d--) {
      encodedStrides[d] = encodedStrides[d + 1] * encodedShape[d + 1];
    }
    // Stride to advance in B when A's dimension k increments: B's dimension i
    // reads A's dimension order[i], so dimension k of A maps to B dimension
    // order.indexOf(k).
    const sourceStrides = new Array<number>(ndim);
    for (let k = 0; k < ndim; k++) {
      sourceStrides[k] = encodedStrides[this.order.indexOf(k)];
    }

    const out = new Uint8Array(data.byteLength);
    const src = elementView(data, byteSize, elements);
    const dst = elementView(out, byteSize, elements);

    const idx = new Array<number>(ndim).fill(0);
    let srcOffset = 0;
    for (let i = 0; i < elements; i++) {
      dst[i] = src[srcOffset] as never;
      // Increment the C-order index over A, tracking B's linear offset.
      for (let d = ndim - 1; d >= 0; d--) {
        idx[d]++;
        srcOffset += sourceStrides[d];
        if (idx[d] < shape[d]) break;
        srcOffset -= idx[d] * sourceStrides[d];
        idx[d] = 0;
      }
    }
    return out;
  }
}
