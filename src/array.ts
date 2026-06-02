import type { Store } from "./store/store.js";
import type { ZarrayMeta, Zattrs } from "./metadata/types.js";
import type { Codec } from "./codec/codec.js";
import type { TypedArray } from "./dtype.js";
import type { MemoryCache } from "./cache/memory.js";
import {
  dtypeToTypedArrayCtor,
  dtypeByteSize,
  isBigEndian,
  byteSwap,
} from "./dtype.js";
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
import type { ChunkTask, LoadedChunk } from "./chunk/loader.js";
import { ByteLimiter } from "./chunk/limiter.js";

/** Default concurrency (network-request cap) for chunk loading. */
export const DEFAULT_CONCURRENCY = 50;

/**
 * Default ceiling on decoded chunk bytes held in flight during a single read.
 * Acts as an adaptive throttle: with large (e.g. compressed WRF) chunks the
 * effective parallelism drops automatically so a read can't balloon to
 * `concurrency × chunkSize`. 256 MiB.
 */
export const DEFAULT_MAX_IN_FLIGHT_BYTES = 256 * 1024 * 1024;

/**
 * Default output-size threshold above which `get()` logs a one-line warning.
 * 512 MiB. Set `largeReadWarningBytes: Infinity` to silence.
 */
export const DEFAULT_LARGE_READ_WARNING_BYTES = 512 * 1024 * 1024;

/** Compressed chunks transiently hold input + output during decode (~2×). */
const DECODE_PEAK_FACTOR = 2;

export interface ReadOptions {
  /**
   * Max parallel chunk fetches (network-request cap). Default: 50. The actual
   * decode parallelism may be lower when `maxInFlightBytes` binds first.
   */
  concurrency?: number;
  memoryCache?: MemoryCache;
  /**
   * Ceiling on decoded chunk bytes held in flight, in bytes. Bounds peak memory
   * regardless of `concurrency` or chunk size. Default: 256 MiB.
   */
  maxInFlightBytes?: number;
  /**
   * Warn (once per call, via `console.warn`) when the materialized output would
   * exceed this many bytes. Default: 512 MiB. Use `Infinity` to disable.
   */
  largeReadWarningBytes?: number;
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
    codec: Codec | null,
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
      this.fillValue = meta.fill_value === "NaN" ? NaN : null;
    } else if (meta.fill_value === "Infinity") {
      this.fillValue = Infinity;
    } else if (meta.fill_value === "-Infinity") {
      this.fillValue = -Infinity;
    } else {
      this.fillValue =
        typeof meta.fill_value === "number" ? meta.fill_value : null;
    }

    this.codec = codec;
  }

  async get(selection?: Slice, options?: ReadOptions): Promise<TypedArray> {
    return this.read(selection, options, null);
  }

  /**
   * @internal
   * Read sharing an externally-owned byte budget. Used by
   * `ZarrGroup.readMultiple` so concurrent array reads bound their *combined*
   * in-flight footprint instead of each allocating an independent ceiling.
   */
  async readWithLimiter(
    selection: Slice | undefined,
    options: ReadOptions | undefined,
    limiter: ByteLimiter,
  ): Promise<TypedArray> {
    return this.read(selection, options, limiter);
  }

  private async read(
    selection: Slice | undefined,
    options: ReadOptions | undefined,
    sharedLimiter: ByteLimiter | null,
  ): Promise<TypedArray> {
    const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    const memoryCache = options?.memoryCache ?? null;
    const maxInFlightBytes =
      options?.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
    const warnBytes =
      options?.largeReadWarningBytes ?? DEFAULT_LARGE_READ_WARNING_BYTES;
    const limiter = sharedLimiter ?? new ByteLimiter(maxInFlightBytes);

    if (selection !== undefined) {
      return this.getSlice(selection, concurrency, memoryCache, limiter, warnBytes);
    }

    return this.getFull(concurrency, memoryCache, limiter, warnBytes);
  }

  /** Estimated peak bytes a single in-flight decoded chunk holds. */
  private peakPerChunk(chunkByteSize: number): number {
    return chunkByteSize * (this.codec ? DECODE_PEAK_FACTOR : 1);
  }

  /** Build a Ctor-typed view over chunk bytes, byte-swapping big-endian data. */
  private toTypedChunk(
    data: Uint8Array,
    Ctor: ReturnType<typeof dtypeToTypedArrayCtor>,
    byteSize: number,
    bigEndian: boolean,
  ): TypedArray {
    let chunkBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bigEndian) {
      chunkBuf = Buffer.from(chunkBuf); // copy before in-place swap
      byteSwap(chunkBuf, byteSize);
    }
    return new Ctor(
      chunkBuf.buffer as ArrayBuffer,
      chunkBuf.byteOffset,
      chunkBuf.byteLength / byteSize,
    );
  }

  /** Warn once per call when a read materializes more than `warnBytes`. */
  private maybeWarnLargeRead(
    outputBytes: number,
    warnBytes: number,
    full: boolean,
  ): void {
    if (!Number.isFinite(warnBytes) || outputBytes <= warnBytes) return;
    const mb = (outputBytes / (1024 * 1024)).toFixed(0);
    const what = full
      ? "Full-array read"
      : "Slice read";
    console.warn(
      `[zarr-node] ${what} of "${this.basePath || "/"}" allocates ~${mb} MiB ` +
        `in a single TypedArray. Consider a narrower selection, or set ` +
        `largeReadWarningBytes: Infinity on the read to silence this warning.`,
    );
  }

  private async getFull(
    concurrency: number,
    memoryCache: MemoryCache | null,
    limiter: ByteLimiter,
    warnBytes: number,
  ): Promise<TypedArray> {
    const ndim = this.shape.length;
    const ranges = computeChunkRanges(this.shape, this.chunks);
    const byteSize = dtypeByteSize(this.dtype);
    const chunkElements = this.chunks.reduce((a, b) => a * b, 1);
    const chunkByteSize = chunkElements * byteSize;

    // Allocate output up front so chunks can be copied in on arrival.
    const totalElements = this.shape.reduce((a, b) => a * b, 1);
    this.maybeWarnLargeRead(totalElements * byteSize, warnBytes, true);
    const Ctor = dtypeToTypedArrayCtor(this.dtype);
    const output = new Ctor(totalElements);
    const bigEndian = isBigEndian(this.dtype);
    const outputStrides = cStrides(this.shape);

    // Build chunk tasks
    const tasks: ChunkTask[] = [];
    for (const coord of allChunkCoords(ranges)) {
      const key = this.basePath
        ? `${this.basePath}/${chunkKey(coord, this.meta.dimension_separator)}`
        : chunkKey(coord, this.meta.dimension_separator);
      tasks.push({ key, chunkCoord: coord });
    }

    // Stream chunks into the output as they decode; buffers drop right after.
    await loadChunks(
      this.store,
      this.codec,
      tasks,
      this.fillValue,
      chunkByteSize,
      {
        concurrency,
        memoryCache,
        limiter,
        peakPerChunk: this.peakPerChunk(chunkByteSize),
      },
      (chunk: LoadedChunk) => {
        const chunkTyped = this.toTypedChunk(
          chunk.data,
          Ctor,
          byteSize,
          bigEndian,
        );

        // Compute actual chunk size (edge chunks may be smaller than chunk shape)
        const actualChunkShape = this.chunks.map((c, d) => {
          const start = chunk.chunkCoord[d] * c;
          return Math.min(c, this.shape[d] - start);
        });

        const chunkDataStrides =
          this.order === "F"
            ? fStrides(this.chunks as number[])
            : cStrides(this.chunks as number[]);

        this.copyChunkToOutput(
          chunkTyped,
          output,
          chunk.chunkCoord,
          actualChunkShape,
          chunkDataStrides,
          outputStrides,
          ndim,
        );
      },
    );

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
        (output as unknown as number[])[outputLinear] = (
          chunkData as unknown as number[]
        )[chunkLinear];
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
    memoryCache: MemoryCache | null,
    limiter: ByteLimiter,
    warnBytes: number,
  ): Promise<TypedArray> {
    const ndim = this.shape.length;
    const ranges = normalizeSelection(selection, this.shape);
    const byteSize = dtypeByteSize(this.dtype);
    const chunkElements = this.chunks.reduce((a, b) => a * b, 1);
    const chunkByteSize = chunkElements * byteSize;

    // Determine which chunks are needed
    const chunkRanges = computeSliceChunkRanges(ranges, this.chunks);

    // Build chunk tasks (only needed chunks)
    // For uncompressed C-order arrays, try to compute byte ranges for partial reads
    const canByteRange =
      this.codec === null &&
      this.order === "C" &&
      typeof this.store.getRange === "function";

    const tasks: ChunkTask[] = [];
    for (const coord of allChunkCoords(chunkRanges)) {
      const key = this.basePath
        ? `${this.basePath}/${chunkKey(coord, this.meta.dimension_separator)}`
        : chunkKey(coord, this.meta.dimension_separator);
      const task: ChunkTask = { key, chunkCoord: coord };

      if (canByteRange) {
        const br = this.computeChunkByteRange(coord, ranges, byteSize);
        if (br) {
          task.byteRange = br;
        }
      }

      tasks.push(task);
    }

    // Allocate output up front so chunks can be copied in on arrival.
    const outputShape = ranges.map((r) => r.stop - r.start);
    const totalElements = outputShape.reduce((a, b) => a * b, 1);
    this.maybeWarnLargeRead(totalElements * byteSize, warnBytes, false);
    const Ctor = dtypeToTypedArrayCtor(this.dtype);
    const output = new Ctor(totalElements);
    const bigEndian = isBigEndian(this.dtype);
    const outputStrides = cStrides(outputShape);

    await loadChunks(
      this.store,
      this.codec,
      tasks,
      this.fillValue,
      chunkByteSize,
      {
        concurrency,
        memoryCache,
        limiter,
        peakPerChunk: this.peakPerChunk(chunkByteSize),
      },
      (chunk: LoadedChunk) => {
        const chunkTyped = this.toTypedChunk(
          chunk.data,
          Ctor,
          byteSize,
          bigEndian,
        );

        if (chunk.partial) {
          // Partial byte-range read: data is already the contiguous overlap
          // elements. Copy directly into the correct output position.
          this.copyPartialToOutput(
            chunkTyped,
            output,
            chunk.chunkCoord,
            ranges,
            outputStrides,
            ndim,
          );
        } else {
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
      },
    );

    return output;
  }

  /**
   * Copy contiguous partial (byte-range) data into the output array.
   * The partial data is ordered in C-order and corresponds to the overlap
   * between the chunk and the slice, with full trailing dimensions.
   */
  private copyPartialToOutput(
    partialData: TypedArray,
    output: TypedArray,
    chunkCoord: number[],
    ranges: DimRange[],
    outputStrides: number[],
    ndim: number,
  ): void {
    const chunkStart = chunkCoord.map((c, d) => c * this.chunks[d]);
    const chunkEnd = chunkCoord.map((c, d) =>
      Math.min((c + 1) * this.chunks[d], this.shape[d]),
    );
    const overlapStart = ranges.map((r, d) => Math.max(r.start, chunkStart[d]));
    const overlapEnd = ranges.map((r, d) => Math.min(r.stop, chunkEnd[d]));
    const overlapShape = overlapEnd.map((e, d) => e - overlapStart[d]);

    // Partial data is contiguous in C-order with shape = overlapShape
    const partialStrides = cStrides(overlapShape);

    const copyRecursive = (
      dim: number,
      partialLinear: number,
      outputLinear: number,
    ): void => {
      if (dim === ndim) {
        (output as unknown as number[])[outputLinear] = (
          partialData as unknown as number[]
        )[partialLinear];
        return;
      }
      for (let i = 0; i < overlapShape[dim]; i++) {
        const outputIdx = overlapStart[dim] - ranges[dim].start + i;
        copyRecursive(
          dim + 1,
          partialLinear + i * partialStrides[dim],
          outputLinear + outputIdx * outputStrides[dim],
        );
      }
    };

    copyRecursive(0, 0, 0);
  }

  /**
   * For uncompressed C-order arrays, compute the contiguous byte range within a chunk
   * that covers the slice overlap. Returns null if bytes are not contiguous.
   *
   * Bytes are contiguous when the overlap covers the full chunk width on all
   * trailing dimensions (all dims except the outermost that is partially sliced).
   */
  private computeChunkByteRange(
    chunkCoord: number[],
    ranges: DimRange[],
    byteSize: number,
  ): { offset: number; length: number } | null {
    const ndim = this.shape.length;
    const chunkStart = chunkCoord.map((c, d) => c * this.chunks[d]);
    const chunkEnd = chunkCoord.map((c, d) =>
      Math.min((c + 1) * this.chunks[d], this.shape[d]),
    );

    // Compute overlap per dimension
    const overlapStart = ranges.map((r, d) => Math.max(r.start, chunkStart[d]));
    const overlapEnd = ranges.map((r, d) => Math.min(r.stop, chunkEnd[d]));

    // Check contiguity: trailing dimensions must cover full chunk width
    // Find the first dimension where the overlap is partial
    for (let d = ndim - 1; d >= 1; d--) {
      const chunkDimSize = chunkEnd[d] - chunkStart[d];
      const overlapSize = overlapEnd[d] - overlapStart[d];
      if (overlapSize !== chunkDimSize) {
        // Not contiguous — can't use byte range
        return null;
      }
    }

    // All trailing dims are full chunk width → contiguous
    // Compute C-order strides for the actual chunk shape
    const actualChunkShape = chunkEnd.map((e, d) => e - chunkStart[d]);
    const strides = cStrides(actualChunkShape);

    // First element offset within chunk
    const firstLocal = overlapStart.map((s, d) => s - chunkStart[d]);
    let startElement = 0;
    for (let d = 0; d < ndim; d++) {
      startElement += firstLocal[d] * strides[d];
    }

    // Total contiguous elements
    const overlapShape = overlapEnd.map((e, d) => e - overlapStart[d]);
    const numElements = overlapShape.reduce((a, b) => a * b, 1);

    return {
      offset: startElement * byteSize,
      length: numElements * byteSize,
    };
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
    const overlapStart = ranges.map((r, d) => Math.max(r.start, chunkStart[d]));
    const overlapEnd = ranges.map((r, d) => Math.min(r.stop, chunkEnd[d]));

    const copyRecursive = (
      dim: number,
      chunkLinear: number,
      outputLinear: number,
    ): void => {
      if (dim === ndim) {
        (output as unknown as number[])[outputLinear] = (
          chunkData as unknown as number[]
        )[chunkLinear];
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
