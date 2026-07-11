import type { Store } from "./store/store.js";
import type { ResolvedArrayMeta } from "./metadata/types.js";
import type { CodecPipeline, ChunkDecodeContext } from "./codec/pipeline.js";
import type { DecodePool } from "./codec/decode-pool.js";
import type { TypedArray, TypedArrayConstructor } from "./dtype.js";
import type { MemoryCache } from "./cache/memory.js";
import type { ObservabilityHooks } from "./observability.js";
import { byteSwap, halfToFloat32 } from "./dtype.js";
import {
  computeChunkRanges,
  encodeChunkKey,
  allChunkCoords,
  cStrides,
  fStrides,
  normalizeSelection,
  computeSliceChunkRanges,
} from "./chunk/indexing.js";
import type { DimRange } from "./chunk/indexing.js";
import { loadChunks } from "./chunk/loader.js";
import type { ChunkTask, LoadedChunk } from "./chunk/loader.js";
import { loadShardedChunks } from "./codec/sharding.js";
import type { ShardReadTask } from "./codec/sharding.js";
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
  /**
   * Per-read observability hooks: memory-tier `onCacheHit`/`onCacheMiss`,
   * `onChunkDecoded`, and `onInFlightBytes` (budget changes in the byte
   * limiter created for this read).
   */
  observability?: ObservabilityHooks;
  /**
   * Throw `MissingChunkError` when a chunk is absent from the store instead of
   * filling its region with the array's `fill_value` (Zarr v2 semantics;
   * zeros when `fill_value` is 0 or null). Default: false.
   */
  strict?: boolean;
  /**
   * Opt-in worker-thread pool for offloading heavy synchronous decompression
   * (Blosc) off the event loop. When omitted, chunks decode inline as before.
   * Create one `DecodePool` per process and reuse it across reads; the caller
   * owns its lifecycle (`terminate()`).
   */
  decodeWorkers?: DecodePool;
  /**
   * Sharded (v3 `sharding_indexed`) reads only: gap threshold in bytes under
   * which adjacent inner-chunk byte-ranges are coalesced into one request.
   * Exactly-contiguous ranges always merge. Default: ~1 MiB.
   */
  shardRangeGapBytes?: number;
}

export type Slice = (number | [number, number] | null)[];

/** Per-read options resolved once in `read()` and shared by both read paths. */
interface ResolvedReadContext {
  concurrency: number;
  memoryCache: MemoryCache | null;
  limiter: ByteLimiter;
  warnBytes: number;
  hooks: ObservabilityHooks | undefined;
  strict: boolean;
  decodePool: DecodePool | null;
  shardGapBytes: number | undefined;
}

export class ZarrArray {
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dtype: string;
  readonly order: "C" | "F";
  readonly fillValue: number | null;
  readonly attrs: Readonly<Record<string, unknown>>;

  private readonly store: Store;
  private readonly meta: ResolvedArrayMeta;
  private readonly basePath: string;
  private readonly pipeline: CodecPipeline;
  private readonly decodeContext: ChunkDecodeContext;
  /**
   * The grid the read path iterates and copies at. Equals `chunks` except for
   * sharded arrays, where reads operate on INNER chunks (`chunks` stays the
   * shard shape, matching the metadata).
   */
  private readonly readGrid: readonly number[];

  constructor(store: Store, meta: ResolvedArrayMeta) {
    this.store = store;
    this.meta = meta;
    this.shape = meta.shape;
    this.chunks = meta.chunkShape;
    this.dtype = meta.dtypeName;
    this.order = meta.order;
    this.attrs = meta.attrs;
    this.basePath = meta.chunkKey.basePath ?? "";
    this.pipeline = meta.codecPipeline;
    this.readGrid = meta.sharding?.innerChunkShape ?? meta.chunkShape;
    this.decodeContext = { chunkShape: this.readGrid, dtype: meta.dtype };

    // Public field keeps its historical `number | null` shape; the resolved
    // fill (which may be bigint/boolean for v3) drives prefill internally.
    const fv = meta.fillValue;
    this.fillValue =
      typeof fv === "number"
        ? fv
        : typeof fv === "bigint"
          ? Number(fv)
          : typeof fv === "boolean"
            ? Number(fv)
            : null;
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
    const maxInFlightBytes =
      options?.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
    const hooks = options?.observability;
    const ctx: ResolvedReadContext = {
      concurrency: options?.concurrency ?? DEFAULT_CONCURRENCY,
      memoryCache: options?.memoryCache ?? null,
      limiter:
        sharedLimiter ??
        new ByteLimiter(maxInFlightBytes, hooks?.onInFlightBytes),
      warnBytes:
        options?.largeReadWarningBytes ?? DEFAULT_LARGE_READ_WARNING_BYTES,
      hooks,
      strict: options?.strict ?? false,
      decodePool: options?.decodeWorkers ?? null,
      shardGapBytes: options?.shardRangeGapBytes,
    };

    if (selection !== undefined) {
      return this.getSlice(selection, ctx);
    }

    return this.getFull(ctx);
  }

  /** Estimated peak bytes a single in-flight decoded chunk holds. */
  private peakPerChunk(chunkByteSize: number): number {
    // Compressed decode transiently holds compressed input + decoded output
    // (~2×). Big-endian data is copied once more before the in-place byte swap
    // (`toTypedChunk`), adding another full-chunk buffer (+1×). float16
    // widening allocates a Float32Array at 2× the stored halves (+2×).
    const decodeFactor = this.pipeline.isPassthrough ? 1 : DECODE_PEAK_FACTOR;
    const byteSwapFactor = this.meta.dtype.byteOrder === "big" ? 1 : 0;
    const widenFactor = this.meta.dtype.widenHalfToFloat ? 2 : 0;
    return chunkByteSize * (decodeFactor + byteSwapFactor + widenFactor);
  }

  /**
   * Pre-fill a freshly allocated output with the array's fill_value, so
   * regions whose chunks are absent from the store come back as fill_value
   * (missing chunks are never delivered by the loader). TypedArrays are
   * zero-initialized, so 0/null/false fill values need no pass.
   */
  private prefillOutput(output: TypedArray): void {
    const fv = this.meta.fillValue;
    if (fv === null || fv === 0 || fv === false) return;
    if (output instanceof BigInt64Array || output instanceof BigUint64Array) {
      if (typeof fv === "bigint") {
        output.fill(fv);
      } else if (typeof fv === "boolean") {
        output.fill(fv ? 1n : 0n);
      } else if (Number.isFinite(fv)) {
        // JSON fill_value is a number; non-finite values are unrepresentable.
        output.fill(BigInt(Math.trunc(fv)));
      }
      return;
    }
    const numeric =
      typeof fv === "bigint" ? Number(fv) : typeof fv === "boolean" ? 1 : fv;
    output.fill(numeric);
  }

  /**
   * Build a typed view over decoded chunk bytes: byte-swap big-endian data,
   * widen float16 halves into a Float32Array.
   */
  private toTypedChunk(data: Uint8Array): TypedArray {
    const { ctor: Ctor, byteSize, byteOrder, widenHalfToFloat } =
      this.meta.dtype;
    let chunkBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (byteOrder === "big") {
      chunkBuf = Buffer.from(chunkBuf); // copy before in-place swap
      byteSwap(chunkBuf, byteSize);
    } else if (byteSize > 1 && chunkBuf.byteOffset % byteSize !== 0) {
      // A multi-byte typed-array view needs a byteOffset that is a multiple of
      // the element size; decoded/pooled buffers make no such guarantee. Copy
      // into a fresh 0-offset buffer when unaligned. (The big-endian branch
      // above already copies, so it never needs this.)
      chunkBuf = Buffer.from(chunkBuf);
    }
    if (widenHalfToFloat) {
      const halves = new Uint16Array(
        chunkBuf.buffer as ArrayBuffer,
        chunkBuf.byteOffset,
        chunkBuf.byteLength / 2,
      );
      return halfToFloat32(halves);
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
    const what = full ? "Full-array read" : "Slice read";
    console.warn(
      `[zarr-node] ${what} of "${this.basePath || "/"}" allocates ~${mb} MiB ` +
        `in a single TypedArray. Consider a narrower selection, or set ` +
        `largeReadWarningBytes: Infinity on the read to silence this warning.`,
    );
  }

  /** Group touched inner-chunk coordinates by shard (C-order inner index). */
  private buildShardTasks(chunkRanges: number[][]): ShardReadTask[] {
    const sharding = this.meta.sharding;
    if (!sharding) throw new Error("buildShardTasks requires a sharded array");
    const byShard = new Map<string, ShardReadTask>();
    for (const coord of allChunkCoords(chunkRanges)) {
      const shardCoord = coord.map((c, d) =>
        Math.floor(c / sharding.chunksPerShardDim[d]),
      );
      const shardKey = encodeChunkKey(shardCoord, this.meta.chunkKey);
      let indexInShard = 0;
      for (let d = 0; d < coord.length; d++) {
        indexInShard =
          indexInShard * sharding.chunksPerShardDim[d] +
          (coord[d] % sharding.chunksPerShardDim[d]);
      }
      let task = byShard.get(shardKey);
      if (!task) {
        task = { shardKey, inner: [] };
        byShard.set(shardKey, task);
      }
      task.inner.push({ coord: [...coord], indexInShard });
    }
    return [...byShard.values()];
  }

  /** Route a sharded read to the store-aware sharding reader (US4). */
  private async loadSharded(
    chunkRanges: number[][],
    ctx: ResolvedReadContext,
    innerChunkByteSize: number,
    onChunk: (chunk: LoadedChunk) => void,
  ): Promise<void> {
    const sharding = this.meta.sharding;
    if (!sharding) throw new Error("loadSharded requires a sharded array");
    await loadShardedChunks(
      this.store,
      sharding,
      this.buildShardTasks(chunkRanges),
      {
        concurrency: ctx.concurrency,
        limiter: ctx.limiter,
        peakPerInnerChunk: this.peakPerChunk(innerChunkByteSize),
        memoryCache: ctx.memoryCache,
        observability: ctx.hooks,
        strict: ctx.strict,
        decodePool: ctx.decodePool,
        decodeContext: this.decodeContext,
        gapBytes: ctx.shardGapBytes,
      },
      onChunk,
    );
  }

  private async getFull(ctx: ResolvedReadContext): Promise<TypedArray> {
    const { concurrency, memoryCache, limiter, warnBytes, hooks, strict } = ctx;
    const decodePool = ctx.decodePool;
    const ndim = this.shape.length;
    const grid = this.readGrid;
    const ranges = computeChunkRanges(this.shape, grid);
    const byteSize = this.meta.dtype.byteSize;
    const chunkElements = grid.reduce((a, b) => a * b, 1);
    const chunkByteSize = chunkElements * byteSize;

    // Allocate output up front so chunks can be copied in on arrival.
    const totalElements = this.shape.reduce((a, b) => a * b, 1);
    const Ctor: TypedArrayConstructor = this.meta.dtype.ctor;
    this.maybeWarnLargeRead(
      totalElements * Ctor.BYTES_PER_ELEMENT,
      warnBytes,
      true,
    );
    const output = new Ctor(totalElements);
    this.prefillOutput(output);
    const outputStrides = cStrides(this.shape);

    // Stream chunks into the output as they decode; buffers drop right after.
    const onChunk = (chunk: LoadedChunk): void => {
      const chunkTyped = this.toTypedChunk(chunk.data);

      // Compute actual chunk size (edge chunks may be smaller than chunk shape)
      const actualChunkShape = grid.map((c, d) => {
        const start = chunk.chunkCoord[d] * c;
        return Math.min(c, this.shape[d] - start);
      });

      const chunkDataStrides =
        this.order === "F"
          ? fStrides(grid as number[])
          : cStrides(grid as number[]);

      this.copyChunkToOutput(
        chunkTyped,
        output,
        chunk.chunkCoord,
        actualChunkShape,
        chunkDataStrides,
        outputStrides,
        ndim,
      );
    };

    if (this.meta.sharding) {
      await this.loadSharded(ranges, ctx, chunkByteSize, onChunk);
      return output;
    }

    // Build chunk tasks
    const tasks: ChunkTask[] = [];
    for (const coord of allChunkCoords(ranges)) {
      tasks.push({
        key: encodeChunkKey(coord, this.meta.chunkKey),
        chunkCoord: coord,
      });
    }

    await loadChunks(
      this.store,
      this.pipeline,
      tasks,
      {
        concurrency,
        memoryCache,
        limiter,
        peakPerChunk: this.peakPerChunk(chunkByteSize),
        observability: hooks,
        strict,
        decodePool,
        decodeContext: this.decodeContext,
      },
      onChunk,
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
    const globalOffset = chunkCoord.map((c, d) => c * this.readGrid[d]);

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
    ctx: ResolvedReadContext,
  ): Promise<TypedArray> {
    const { concurrency, memoryCache, limiter, warnBytes, hooks, strict } = ctx;
    const decodePool = ctx.decodePool;
    const ndim = this.shape.length;
    const grid = this.readGrid;
    const ranges = normalizeSelection(selection, this.shape);
    const byteSize = this.meta.dtype.byteSize;
    const chunkElements = grid.reduce((a, b) => a * b, 1);
    const chunkByteSize = chunkElements * byteSize;

    // Determine which chunks are needed
    const chunkRanges = computeSliceChunkRanges(ranges, grid);

    // Allocate output up front so chunks can be copied in on arrival.
    const outputShape = ranges.map((r) => r.stop - r.start);
    const totalElements = outputShape.reduce((a, b) => a * b, 1);
    const Ctor: TypedArrayConstructor = this.meta.dtype.ctor;
    this.maybeWarnLargeRead(
      totalElements * Ctor.BYTES_PER_ELEMENT,
      warnBytes,
      false,
    );
    const output = new Ctor(totalElements);
    this.prefillOutput(output);
    const outputStrides = cStrides(outputShape);

    const onChunk = (chunk: LoadedChunk): void => {
      const chunkTyped = this.toTypedChunk(chunk.data);

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
            ? fStrides(grid as number[])
            : cStrides(grid as number[]);

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
    };

    if (this.meta.sharding) {
      // Sharded arrays fetch inner chunks by byte-range through the sharding
      // reader (which owns its own range logic — see contracts/sharding.md).
      await this.loadSharded(chunkRanges, ctx, chunkByteSize, onChunk);
      return output;
    }

    // Build chunk tasks (only needed chunks)
    // For uncompressed C-order arrays, try to compute byte ranges for partial reads
    const canByteRange =
      this.pipeline.isPassthrough &&
      this.order === "C" &&
      typeof this.store.getRange === "function";

    const tasks: ChunkTask[] = [];
    for (const coord of allChunkCoords(chunkRanges)) {
      const task: ChunkTask = {
        key: encodeChunkKey(coord, this.meta.chunkKey),
        chunkCoord: coord,
      };

      if (canByteRange) {
        const br = this.computeChunkByteRange(coord, ranges, byteSize);
        if (br) {
          task.byteRange = br;
        }
      }

      tasks.push(task);
    }

    await loadChunks(
      this.store,
      this.pipeline,
      tasks,
      {
        concurrency,
        memoryCache,
        limiter,
        peakPerChunk: this.peakPerChunk(chunkByteSize),
        observability: hooks,
        strict,
        decodePool,
        decodeContext: this.decodeContext,
      },
      onChunk,
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
    const chunkStart = chunkCoord.map((c, d) => c * this.readGrid[d]);
    const chunkEnd = chunkCoord.map((c, d) =>
      Math.min((c + 1) * this.readGrid[d], this.shape[d]),
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
    const chunkStart = chunkCoord.map((c, d) => c * this.readGrid[d]);
    const chunkEnd = chunkCoord.map((c, d) =>
      Math.min((c + 1) * this.readGrid[d], this.shape[d]),
    );

    // Compute overlap per dimension
    const overlapStart = ranges.map((r, d) => Math.max(r.start, chunkStart[d]));
    const overlapEnd = ranges.map((r, d) => Math.min(r.stop, chunkEnd[d]));

    // Check contiguity: trailing dimensions must cover the full STORED chunk
    // width. Zarr v2 stores every chunk padded to the full chunk shape, so an
    // edge chunk clipped by the array bounds in a trailing dimension can never
    // be read contiguously — the overlap (clipped to the array) cannot reach
    // the stored width, and we fall back to a full fetch.
    for (let d = ndim - 1; d >= 1; d--) {
      const overlapSize = overlapEnd[d] - overlapStart[d];
      if (overlapSize !== this.readGrid[d]) {
        // Not contiguous — can't use byte range
        return null;
      }
    }

    // All trailing dims are full stored width → contiguous. Strides over the
    // stored (padded, full-shape) chunk layout.
    const strides = cStrides(this.readGrid as number[]);

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
    const chunkStart = chunkCoord.map((c, d) => c * this.readGrid[d]);
    const chunkEnd = chunkCoord.map((c, d) =>
      Math.min((c + 1) * this.readGrid[d], this.shape[d]),
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
