import type { Store } from "../store/store.js";
import type { Codec } from "../codec/codec.js";
import type { DecodePool } from "../codec/decode-pool.js";
import type { CompressorConfig } from "../metadata/types.js";
import type { MemoryCache } from "../cache/memory.js";
import type { ObservabilityHooks } from "../observability.js";
import { safeInvoke } from "../observability.js";
import { MissingChunkError } from "../errors.js";
import type { ByteLimiter } from "./limiter.js";

export interface ChunkTask {
  key: string;
  chunkCoord: number[];
  /** Optional byte range hint for partial chunk fetches (uncompressed only). */
  byteRange?: { offset: number; length: number };
}

export interface LoadedChunk {
  chunkCoord: number[];
  data: Uint8Array;
  /** True when data contains only the byte-range slice, not the full chunk. */
  partial?: boolean;
}

export interface LoadChunksContext {
  /** Max parallel chunk fetches (network-request cap). */
  concurrency: number;
  /** Optional decoded-chunk cache. */
  memoryCache?: MemoryCache | null;
  /** Byte budget gate; bounds the live decoded footprint across in-flight chunks. */
  limiter: ByteLimiter;
  /**
   * Estimated peak bytes a single in-flight chunk holds (decoded size, doubled
   * for compressed chunks to cover the transient decode spike). Used as the
   * limiter cost for full-chunk reads.
   */
  peakPerChunk: number;
  /** Per-read observability hooks (memory-tier hit/miss, chunk decode). */
  observability?: ObservabilityHooks;
  /** Throw MissingChunkError on absent chunks instead of zero-filling. */
  strict?: boolean;
  /**
   * Optional worker-thread pool. When present, offloadable chunks above the
   * pool's threshold are decoded off the event loop. Requires `compressorConfig`
   * (the worker reconstructs the codec from it).
   */
  decodePool?: DecodePool | null;
  /** Compressor config from `.zarray`; passed to the worker pool to rebuild the codec. */
  compressorConfig?: CompressorConfig | null;
}

/**
 * Fetch and decode chunks with bounded concurrency, streaming each decoded
 * chunk to `onChunk` as soon as it is ready.
 *
 * Chunks are NOT accumulated: `onChunk` is expected to copy the chunk into the
 * output (or otherwise consume it) synchronously, after which the decoded
 * buffer becomes collectable. This keeps the live footprint near
 * `limiter.capacity` instead of the sum of every selected chunk — the
 * difference between bounded and unbounded memory on wide point-slice reads of
 * compressed arrays.
 *
 * Missing chunks are NOT delivered: the caller pre-fills the output with the
 * array's fill_value, so an absent chunk just leaves its region untouched
 * (after firing `onMissingChunk` and, under `strict`, throwing).
 */
export async function loadChunks(
  store: Store,
  codec: Codec | null,
  tasks: ChunkTask[],
  ctx: LoadChunksContext,
  onChunk: (chunk: LoadedChunk) => void,
): Promise<void> {
  const { concurrency, memoryCache, limiter, peakPerChunk } = ctx;
  const hooks = ctx.observability;
  const strict = ctx.strict === true;
  const decodePool = ctx.decodePool ?? null;
  const compressorConfig = ctx.compressorConfig ?? null;

  // Decode a raw chunk: offload to a worker when the pool accepts this codec
  // and the chunk is large enough; otherwise decode inline on the event loop.
  async function decodeRaw(raw: Uint8Array): Promise<Uint8Array> {
    if (!codec) return raw;
    if (
      decodePool &&
      compressorConfig &&
      decodePool.shouldOffload(codec.id, raw.byteLength)
    ) {
      return decodePool.decode(compressorConfig, raw);
    }
    return codec.decode(raw);
  }

  // Can we use byte-range requests? Only when uncompressed and store supports it.
  const getRange = codec === null ? store.getRange?.bind(store) : undefined;

  // First failure aborts the read: the scheduler stops launching tasks, and
  // in-flight tasks short-circuit after their pending await instead of
  // decoding/delivering into an output the caller has already abandoned.
  let failed = false;
  let firstError: unknown;

  function handleMissing(key: string): void {
    if (hooks?.onMissingChunk) {
      safeInvoke(hooks.onMissingChunk, { key });
    }
    if (strict) {
      throw new MissingChunkError(key);
    }
  }

  async function processTask(task: ChunkTask): Promise<void> {
    // Cache hit: the buffer already lives in the (bounded) cache, so copying it
    // allocates nothing large — skip the byte gate entirely.
    if (memoryCache) {
      const cached = memoryCache.get(task.key);
      if (cached !== null) {
        if (hooks?.onCacheHit) {
          safeInvoke(hooks.onCacheHit, { tier: "memory", key: task.key });
        }
        onChunk({ chunkCoord: task.chunkCoord, data: cached });
        return;
      }
      if (hooks?.onCacheMiss) {
        safeInvoke(hooks.onCacheMiss, { tier: "memory", key: task.key });
      }
    }

    // Partial byte-range reads only materialize the requested slice.
    const cost = task.byteRange ? task.byteRange.length : peakPerChunk;
    await limiter.acquire(cost);
    try {
      if (failed) return;
      if (getRange && task.byteRange) {
        const partial = await getRange(
          task.key,
          task.byteRange.offset,
          task.byteRange.length,
        );
        if (failed) return;
        if (partial !== null) {
          // Don't cache partial reads — cache expects full decoded chunks.
          onChunk({
            chunkCoord: task.chunkCoord,
            data: partial,
            partial: true,
          });
          return;
        }
        // getRange returning null means the chunk is missing: no delivery,
        // the pre-filled output already holds fill_value for this region.
        handleMissing(task.key);
        return;
      }

      const raw = await store.get(task.key);
      if (failed) return;

      if (raw === null) {
        // Missing chunk: no delivery, the pre-filled output already holds
        // fill_value for this region.
        handleMissing(task.key);
        return;
      }

      let decoded: Uint8Array;
      if (hooks?.onChunkDecoded) {
        const start = performance.now();
        decoded = await decodeRaw(raw);
        safeInvoke(hooks.onChunkDecoded, {
          bytes: decoded.byteLength,
          codec: codec ? codec.id : null,
          decodeMs: performance.now() - start,
        });
      } else {
        decoded = await decodeRaw(raw);
      }
      if (failed) return;

      // Store decoded result in memory cache.
      if (memoryCache) {
        memoryCache.set(task.key, decoded);
      }

      onChunk({ chunkCoord: task.chunkCoord, data: decoded });
    } finally {
      // Release only after onChunk has consumed (copied) the buffer, so the
      // budget reflects the chunk's full live lifetime.
      limiter.release(cost);
    }
  }

  const inFlight = new Set<Promise<void>>();
  let index = 0;

  while (index < tasks.length && !failed) {
    while (inFlight.size < concurrency && index < tasks.length && !failed) {
      const task = tasks[index++];
      // `p` never rejects: failures are recorded and rethrown after the drain
      // below, so no member of `inFlight` can become an unhandled rejection.
      const p = processTask(task).then(
        () => {
          inFlight.delete(p);
        },
        (err: unknown) => {
          inFlight.delete(p);
          if (!failed) {
            failed = true;
            firstError = err;
          }
        },
      );
      inFlight.add(p);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  // Drain survivors before surfacing a failure so every limiter reservation
  // is released by the time the caller observes the rejection.
  await Promise.all(inFlight);
  if (failed) {
    throw firstError;
  }
}
