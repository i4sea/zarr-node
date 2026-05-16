import type { Store } from "../store/store.js";
import type { Codec } from "../codec/codec.js";
import type { MemoryCache } from "../cache/memory.js";

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

/**
 * Fetch and decode chunks with configurable concurrency.
 * Uses a simple promise pool pattern.
 */
export async function loadChunks(
  store: Store,
  codec: Codec | null,
  tasks: ChunkTask[],
  fillValue: number | null,
  chunkByteSize: number,
  concurrency: number,
  memoryCache?: MemoryCache | null,
): Promise<LoadedChunk[]> {
  const results: LoadedChunk[] = [];
  let index = 0;

  // Can we use byte-range requests? Only when uncompressed and store supports it.
  const getRange = codec === null ? store.getRange?.bind(store) : undefined;

  async function processTask(task: ChunkTask): Promise<LoadedChunk> {
    // Check memory cache first
    if (memoryCache) {
      const cached = memoryCache.get(task.key);
      if (cached !== null) {
        return { chunkCoord: task.chunkCoord, data: cached };
      }
    }

    // Use byte-range fetch for uncompressed partial reads
    if (getRange && task.byteRange) {
      const partial = await getRange(
        task.key,
        task.byteRange.offset,
        task.byteRange.length,
      );
      if (partial !== null) {
        // Don't cache partial reads — cache expects full decoded chunks
        return { chunkCoord: task.chunkCoord, data: partial, partial: true };
      }
      // Fall through to full fetch if range failed
    }

    const raw = await store.get(task.key);

    if (raw === null) {
      // Missing chunk -> fill with fill_value (default 0)
      const filled = new Uint8Array(chunkByteSize);
      return { chunkCoord: task.chunkCoord, data: filled };
    }

    const decoded = codec ? await codec.decode(raw) : raw;

    // Store decoded result in memory cache
    if (memoryCache) {
      memoryCache.set(task.key, decoded);
    }

    return { chunkCoord: task.chunkCoord, data: decoded };
  }

  const inFlight = new Set<Promise<void>>();

  while (index < tasks.length) {
    while (inFlight.size < concurrency && index < tasks.length) {
      const task = tasks[index++];
      const p = processTask(task).then((result) => {
        results.push(result);
        inFlight.delete(p);
      });
      inFlight.add(p);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);
  return results;
}
