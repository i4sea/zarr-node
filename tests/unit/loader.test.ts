import { describe, it, expect } from "vitest";
import { loadChunks } from "../../src/chunk/loader.js";
import type { ChunkTask, LoadedChunk } from "../../src/chunk/loader.js";
import { ByteLimiter } from "../../src/chunk/limiter.js";
import type { Store } from "../../src/store/store.js";
import type { Codec } from "../../src/codec/codec.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Store that tracks how many `get()` calls are simultaneously in flight, so a
 * test can assert the in-flight ceiling. Each get is held open briefly so the
 * pool fills up to whatever bound binds first.
 */
function probingStore(holdMs = 10): {
  store: Store;
  maxConcurrent: () => number;
} {
  let active = 0;
  let max = 0;
  const store: Store = {
    async get(): Promise<Uint8Array> {
      active++;
      if (active > max) max = active;
      await delay(holdMs);
      active--;
      return new Uint8Array(4);
    },
    async has() {
      return true;
    },
    async *list() {},
  };
  return { store, maxConcurrent: () => max };
}

// Identity codec so the loader treats chunks as "compressed" (decode path).
const identityCodec: Codec = {
  id: "identity",
  async decode(data) {
    return data;
  },
};

function makeTasks(n: number): ChunkTask[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${i}`,
    chunkCoord: [i],
  }));
}

describe("loadChunks — bounded in-flight memory", () => {
  it("caps in-flight chunks by the byte budget, below the concurrency count", async () => {
    const { store, maxConcurrent } = probingStore();
    // budget=25, cost/chunk=10 -> floor(25/10) = 2 chunks live at once,
    // even though the concurrency count cap is 50.
    const limiter = new ByteLimiter(25);
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      store,
      identityCodec,
      makeTasks(20),
      null,
      4,
      { concurrency: 50, limiter, peakPerChunk: 10 },
      (c) => delivered.push(c),
    );

    expect(maxConcurrent()).toBe(2);
    expect(delivered).toHaveLength(20);
    // All distinct chunks delivered.
    expect(new Set(delivered.map((d) => d.chunkCoord[0])).size).toBe(20);
    // Budget fully restored after the run.
    expect(limiter.availableBytes).toBe(25);
  });

  it("falls back to the concurrency count cap when the budget is ample", async () => {
    const { store, maxConcurrent } = probingStore();
    const limiter = new ByteLimiter(1024 * 1024 * 1024); // effectively unbounded
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      store,
      identityCodec,
      makeTasks(20),
      null,
      4,
      { concurrency: 5, limiter, peakPerChunk: 10 },
      (c) => delivered.push(c),
    );

    expect(maxConcurrent()).toBe(5);
    expect(delivered).toHaveLength(20);
  });

  it("fills only the requested slice when getRange misses (stays in budget)", async () => {
    let fullGets = 0;
    const store: Store = {
      async get() {
        fullGets++;
        return new Uint8Array(4096); // a full chunk — must NOT be fetched
      },
      async getRange() {
        return null; // missing chunk
      },
      async has() {
        return true;
      },
      async *list() {},
    };

    const delivered: LoadedChunk[] = [];
    await loadChunks(
      store,
      null, // uncompressed -> byte-range path is active
      [{ key: "0", chunkCoord: [0], byteRange: { offset: 0, length: 16 } }],
      null,
      4096,
      { concurrency: 4, limiter: new ByteLimiter(1024), peakPerChunk: 4096 },
      (c) => delivered.push(c),
    );

    expect(fullGets).toBe(0); // no full-chunk fetch under the small reservation
    expect(delivered).toHaveLength(1);
    expect(delivered[0].partial).toBe(true);
    expect(delivered[0].data.byteLength).toBe(16);
  });

  it("lets a single oversized chunk proceed (no deadlock)", async () => {
    const { store, maxConcurrent } = probingStore();
    const limiter = new ByteLimiter(10);
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      store,
      identityCodec,
      makeTasks(3),
      null,
      4,
      { concurrency: 50, limiter, peakPerChunk: 1000 }, // each chunk > capacity
      (c) => delivered.push(c),
    );

    // Oversized cost clamps to capacity -> exactly one chunk in flight at a time.
    expect(maxConcurrent()).toBe(1);
    expect(delivered).toHaveLength(3);
  });
});
