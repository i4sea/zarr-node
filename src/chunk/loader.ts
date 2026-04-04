import type { Store } from "../store/store.js";
import type { Codec } from "../codec/codec.js";

export interface ChunkTask {
  key: string;
  chunkCoord: number[];
}

export interface LoadedChunk {
  chunkCoord: number[];
  data: Uint8Array;
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
): Promise<LoadedChunk[]> {
  const results: LoadedChunk[] = [];
  let index = 0;

  async function processTask(task: ChunkTask): Promise<LoadedChunk> {
    const raw = await store.get(task.key);

    if (raw === null) {
      // Missing chunk -> fill with fill_value (default 0)
      const filled = new Uint8Array(chunkByteSize);
      return { chunkCoord: task.chunkCoord, data: filled };
    }

    const decoded = codec ? await codec.decode(raw) : raw;
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
