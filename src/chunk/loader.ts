import type { Store } from "../store/store.js";
import type { Codec } from "../codec/codec.js";
import type { MemoryCache } from "../cache/memory.js";
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
 */
export async function loadChunks(
  store: Store,
  codec: Codec | null,
  tasks: ChunkTask[],
  fillValue: number | null,
  chunkByteSize: number,
  ctx: LoadChunksContext,
  onChunk: (chunk: LoadedChunk) => void,
): Promise<void> {
  const { concurrency, memoryCache, limiter, peakPerChunk } = ctx;

  // Can we use byte-range requests? Only when uncompressed and store supports it.
  const getRange = codec === null ? store.getRange?.bind(store) : undefined;

  async function processTask(task: ChunkTask): Promise<void> {
    // Cache hit: the buffer already lives in the (bounded) cache, so copying it
    // allocates nothing large — skip the byte gate entirely.
    if (memoryCache) {
      const cached = memoryCache.get(task.key);
      if (cached !== null) {
        onChunk({ chunkCoord: task.chunkCoord, data: cached });
        return;
      }
    }

    // Partial byte-range reads only materialize the requested slice.
    const cost = task.byteRange ? task.byteRange.length : peakPerChunk;
    await limiter.acquire(cost);
    try {
      if (getRange && task.byteRange) {
        const partial = await getRange(
          task.key,
          task.byteRange.offset,
          task.byteRange.length,
        );
        if (partial !== null) {
          // Don't cache partial reads — cache expects full decoded chunks.
          onChunk({
            chunkCoord: task.chunkCoord,
            data: partial,
            partial: true,
          });
          return;
        }
        // Fall through to full fetch if range failed.
      }

      const raw = await store.get(task.key);

      if (raw === null) {
        // Missing chunk -> fill with fill_value (default 0)
        const filled = new Uint8Array(chunkByteSize);
        onChunk({ chunkCoord: task.chunkCoord, data: filled });
        return;
      }

      const decoded = codec ? await codec.decode(raw) : raw;

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

  while (index < tasks.length) {
    while (inFlight.size < concurrency && index < tasks.length) {
      const task = tasks[index++];
      const p = processTask(task).then(() => {
        inFlight.delete(p);
      });
      inFlight.add(p);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);
}
