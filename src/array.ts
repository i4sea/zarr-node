import type { Store } from "./store/store.js";
import type { ZarrayMeta, Zattrs } from "./metadata/types.js";
import type { Codec } from "./codec/codec.js";
import type { TypedArray } from "./dtype.js";
import {
  dtypeToTypedArrayCtor,
  dtypeByteSize,
  isBigEndian,
  byteSwap,
} from "./dtype.js";
import { codecRegistry } from "./codec/codec.js";
import {
  computeChunkRanges,
  chunkKey,
  allChunkCoords,
  cStrides,
  fStrides,
  normalizeSelection,
  computeSliceChunkRanges,
} from "./chunk/indexing.js";
import type { DimRange } from "./chunk/indexing.js";
import { loadChunks } from "./chunk/loader.js";
import type { ChunkTask } from "./chunk/loader.js";

export interface ReadOptions {
  concurrency?: number;
}

export type Slice = (number | [number, number] | null)[];

export class ZarrArray {
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dtype: string;
  readonly order: "C" | "F";
  readonly fillValue: number | null;
  readonly attrs: Readonly<Record<string, unknown>>;

  private readonly store: Store;
  private readonly meta: ZarrayMeta;
  private readonly basePath: string;
  private readonly codec: Codec | null;

  constructor(
    store: Store,
    meta: ZarrayMeta,
    attrs: Zattrs,
    basePath: string,
  ) {
    this.store = store;
    this.meta = meta;
    this.shape = meta.shape;
    this.chunks = meta.chunks;
    this.dtype = meta.dtype;
    this.order = meta.order;
    this.attrs = attrs;
    this.basePath = basePath;

    // Resolve fill_value
    if (meta.fill_value === null || meta.fill_value === "NaN") {
      this.fillValue =
        meta.fill_value === "NaN" ? NaN : null;
    } else if (meta.fill_value === "Infinity") {
      this.fillValue = Infinity;
    } else if (meta.fill_value === "-Infinity") {
      this.fillValue = -Infinity;
    } else {
      this.fillValue =
        typeof meta.fill_value === "number" ? meta.fill_value : null;
    }

    // Resolve codec
    if (meta.compressor === null) {
      this.codec = null;
    } else {
      this.codec = codecRegistry.get(meta.compressor);
    }
  }

  async get(
    selection?: Slice,
    options?: ReadOptions,
  ): Promise<TypedArray> {
    const concurrency = options?.concurrency ?? 10;

    if (selection !== undefined) {
      return this.getSlice(selection, concurrency);
    }

    return this.getFull(concurrency);
  }

  private async getFull(concurrency: number): Promise<TypedArray> {
    const ndim = this.shape.length;
    const ranges = computeChunkRanges(this.shape, this.chunks);
    const byteSize = dtypeByteSize(this.dtype);
    const chunkElements = this.chunks.reduce((a, b) => a * b, 1);
    const chunkByteSize = chunkElements * byteSize;

    // Build chunk tasks
    const tasks: ChunkTask[] = [];
    for (const coord of allChunkCoords(ranges)) {
      const key = this.basePath
        ? `${this.basePath}/${chunkKey(coord, this.meta.dimension_separator)}`
        : chunkKey(coord, this.meta.dimension_separator);
      tasks.push({ key, chunkCoord: coord });
    }

    // Load all chunks
    const loaded = await loadChunks(
      this.store,
      this.codec,
      tasks,
      this.fillValue,
      chunkByteSize,
      concurrency,
    );

    // Assemble into output
    const totalElements = this.shape.reduce((a, b) => a * b, 1);
    const Ctor = dtypeToTypedArrayCtor(this.dtype);
    const output = new Ctor(totalElements);
    const bigEndian = isBigEndian(this.dtype);

    const outputStrides = cStrides(this.shape);

    for (const chunk of loaded) {
      // Byte-swap if big-endian
      let chunkBuf = Buffer.from(
        chunk.data.buffer,
        chunk.data.byteOffset,
        chunk.data.byteLength,
      );
      if (bigEndian) {
        chunkBuf = Buffer.from(chunkBuf); // copy before in-place swap
        byteSwap(chunkBuf, byteSize);
      }

      const chunkTyped = new Ctor(
        chunkBuf.buffer as ArrayBuffer,
        chunkBuf.byteOffset,
        chunkBuf.byteLength / byteSize,
      );

      // Compute actual chunk size (edge chunks may be smaller than chunk shape)
      const actualChunkShape = this.chunks.map((c, d) => {
        const start = chunk.chunkCoord[d] * c;
        return Math.min(c, this.shape[d] - start);
      });

      // Determine strides for reading from chunk data
      const chunkDataStrides =
        this.order === "F"
          ? fStrides(this.chunks as number[])
          : cStrides(this.chunks as number[]);

      // Copy elements from chunk to output
      this.copyChunkToOutput(
        chunkTyped,
        output,
        chunk.chunkCoord,
        actualChunkShape,
        chunkDataStrides,
        outputStrides,
        ndim,
      );
    }

    return output;
  }

  private copyChunkToOutput(
    chunkData: TypedArray,
    output: TypedArray,
    chunkCoord: number[],
    actualChunkShape: number[],
    chunkStrides: number[],
    outputStrides: number[],
    ndim: number,
  ): void {
    // Recursively copy elements
    const globalOffset = chunkCoord.map((c, d) => c * this.chunks[d]);

    const copyRecursive = (
      dim: number,
      chunkLinear: number,
      outputLinear: number,
    ): void => {
      if (dim === ndim) {
        (output as unknown as number[])[outputLinear] =
          (chunkData as unknown as number[])[chunkLinear];
        return;
      }
      for (let i = 0; i < actualChunkShape[dim]; i++) {
        copyRecursive(
          dim + 1,
          chunkLinear + i * chunkStrides[dim],
          outputLinear + (globalOffset[dim] + i) * outputStrides[dim],
        );
      }
    };

    copyRecursive(0, 0, 0);
  }

  private async getSlice(
    selection: Slice,
    concurrency: number,
  ): Promise<TypedArray> {
    const ndim = this.shape.length;
    const ranges = normalizeSelection(selection, this.shape);
    const byteSize = dtypeByteSize(this.dtype);
    const chunkElements = this.chunks.reduce((a, b) => a * b, 1);
    const chunkByteSize = chunkElements * byteSize;

    // Determine which chunks are needed
    const chunkRanges = computeSliceChunkRanges(ranges, this.chunks);

    // Build chunk tasks (only needed chunks)
    const tasks: ChunkTask[] = [];
    for (const coord of allChunkCoords(chunkRanges)) {
      const key = this.basePath
        ? `${this.basePath}/${chunkKey(coord, this.meta.dimension_separator)}`
        : chunkKey(coord, this.meta.dimension_separator);
      tasks.push({ key, chunkCoord: coord });
    }

    const loaded = await loadChunks(
      this.store,
      this.codec,
      tasks,
      this.fillValue,
      chunkByteSize,
      concurrency,
    );

    // Compute output shape
    const outputShape = ranges.map((r) => r.stop - r.start);
    const totalElements = outputShape.reduce((a, b) => a * b, 1);
    const Ctor = dtypeToTypedArrayCtor(this.dtype);
    const output = new Ctor(totalElements);
    const bigEndian = isBigEndian(this.dtype);
    const outputStrides = cStrides(outputShape);

    for (const chunk of loaded) {
      let chunkBuf = Buffer.from(
        chunk.data.buffer,
        chunk.data.byteOffset,
        chunk.data.byteLength,
      );
      if (bigEndian) {
        chunkBuf = Buffer.from(chunkBuf);
        byteSwap(chunkBuf, byteSize);
      }

      const chunkTyped = new Ctor(
        chunkBuf.buffer as ArrayBuffer,
        chunkBuf.byteOffset,
        chunkBuf.byteLength / byteSize,
      );

      const chunkDataStrides =
        this.order === "F"
          ? fStrides(this.chunks as number[])
          : cStrides(this.chunks as number[]);

      // Copy relevant elements from this chunk to output
      this.copySliceChunkToOutput(
        chunkTyped,
        output,
        chunk.chunkCoord,
        ranges,
        chunkDataStrides,
        outputStrides,
        ndim,
      );
    }

    return output;
  }

  private copySliceChunkToOutput(
    chunkData: TypedArray,
    output: TypedArray,
    chunkCoord: number[],
    ranges: DimRange[],
    chunkStrides: number[],
    outputStrides: number[],
    ndim: number,
  ): void {
    // For each dimension, compute the overlap between the slice range
    // and this chunk's coverage
    const chunkStart = chunkCoord.map((c, d) => c * this.chunks[d]);
    const chunkEnd = chunkCoord.map((c, d) =>
      Math.min((c + 1) * this.chunks[d], this.shape[d]),
    );

    // Overlap: max(sliceStart, chunkStart) .. min(sliceStop, chunkEnd)
    const overlapStart = ranges.map((r, d) =>
      Math.max(r.start, chunkStart[d]),
    );
    const overlapEnd = ranges.map((r, d) =>
      Math.min(r.stop, chunkEnd[d]),
    );

    const copyRecursive = (
      dim: number,
      chunkLinear: number,
      outputLinear: number,
    ): void => {
      if (dim === ndim) {
        (output as unknown as number[])[outputLinear] =
          (chunkData as unknown as number[])[chunkLinear];
        return;
      }
      for (let i = overlapStart[dim]; i < overlapEnd[dim]; i++) {
        const chunkIdx = i - chunkStart[dim]; // index within chunk
        const outputIdx = i - ranges[dim].start; // index within output
        copyRecursive(
          dim + 1,
          chunkLinear + chunkIdx * chunkStrides[dim],
          outputLinear + outputIdx * outputStrides[dim],
        );
      }
    };

    copyRecursive(0, 0, 0);
  }
}
