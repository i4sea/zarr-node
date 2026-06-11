import { describe, it, expect } from "vitest";
import { loadChunks } from "../../src/chunk/loader.js";
import type { ChunkTask, LoadedChunk } from "../../src/chunk/loader.js";
import { ByteLimiter } from "../../src/chunk/limiter.js";
import { MissingChunkError } from "../../src/errors.js";
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
      { concurrency: 5, limiter, peakPerChunk: 10 },
      (c) => delivered.push(c),
    );

    expect(maxConcurrent()).toBe(5);
    expect(delivered).toHaveLength(20);
  });

  it("skips delivery when getRange misses, without a full-chunk fetch", async () => {
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
      { concurrency: 4, limiter: new ByteLimiter(1024), peakPerChunk: 4096 },
      (c) => delivered.push(c),
    );

    expect(fullGets).toBe(0); // no full-chunk fetch under the small reservation
    expect(delivered).toHaveLength(0); // output pre-fill covers the region
  });

  it("lets a single oversized chunk proceed (no deadlock)", async () => {
    const { store, maxConcurrent } = probingStore();
    const limiter = new ByteLimiter(10);
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      store,
      identityCodec,
      makeTasks(3),
      { concurrency: 50, limiter, peakPerChunk: 1000 }, // each chunk > capacity
      (c) => delivered.push(c),
    );

    // Oversized cost clamps to capacity -> exactly one chunk in flight at a time.
    expect(maxConcurrent()).toBe(1);
    expect(delivered).toHaveLength(3);
  });
});

describe("loadChunks — missing chunks (onMissingChunk / strict)", () => {
  /** Store with no chunks at all: full fetches and byte-range reads both miss. */
  const emptyStore: Store = {
    async get() {
      return null;
    },
    async getRange() {
      return null;
    },
    async has() {
      return false;
    },
    async *list() {},
  };

  it("default mode skips delivery and fires onMissingChunk on the full-fetch path", async () => {
    const missing: { key: string }[] = [];
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      emptyStore,
      identityCodec,
      [{ key: "1.2", chunkCoord: [1, 2] }],
      {
        concurrency: 4,
        limiter: new ByteLimiter(1024),
        peakPerChunk: 8,
        observability: { onMissingChunk: (e) => missing.push(e) },
      },
      (c) => delivered.push(c),
    );

    expect(delivered).toHaveLength(0);
    expect(missing).toEqual([{ key: "1.2" }]);
  });

  it("default mode skips delivery and fires onMissingChunk on the byte-range miss path", async () => {
    const missing: { key: string }[] = [];
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      emptyStore,
      null, // uncompressed -> byte-range path is active
      [{ key: "0", chunkCoord: [0], byteRange: { offset: 0, length: 16 } }],
      {
        concurrency: 4,
        limiter: new ByteLimiter(1024),
        peakPerChunk: 4096,
        observability: { onMissingChunk: (e) => missing.push(e) },
      },
      (c) => delivered.push(c),
    );

    expect(delivered).toHaveLength(0);
    expect(missing).toEqual([{ key: "0" }]);
  });

  it("strict: true throws MissingChunkError with the key on the full-fetch path", async () => {
    await expect(
      loadChunks(
        emptyStore,
        identityCodec,
        [{ key: "3.4", chunkCoord: [3, 4] }],
        {
          concurrency: 4,
          limiter: new ByteLimiter(1024),
          peakPerChunk: 8,
          strict: true,
        },
        () => {},
      ),
    ).rejects.toThrow(MissingChunkError);

    await expect(
      loadChunks(
        emptyStore,
        identityCodec,
        [{ key: "3.4", chunkCoord: [3, 4] }],
        {
          concurrency: 4,
          limiter: new ByteLimiter(1024),
          peakPerChunk: 8,
          strict: true,
        },
        () => {},
      ),
    ).rejects.toThrow("3.4");
  });

  it("strict: true throws MissingChunkError with the key on the byte-range miss path", async () => {
    await expect(
      loadChunks(
        emptyStore,
        null,
        [{ key: "7", chunkCoord: [7], byteRange: { offset: 0, length: 16 } }],
        {
          concurrency: 4,
          limiter: new ByteLimiter(1024),
          peakPerChunk: 4096,
          strict: true,
        },
        () => {},
      ),
    ).rejects.toBeInstanceOf(MissingChunkError);
  });

  it("strict: true still fires onMissingChunk before throwing", async () => {
    const missing: { key: string }[] = [];

    await expect(
      loadChunks(
        emptyStore,
        identityCodec,
        [{ key: "5", chunkCoord: [5] }],
        {
          concurrency: 4,
          limiter: new ByteLimiter(1024),
          peakPerChunk: 8,
          strict: true,
          observability: { onMissingChunk: (e) => missing.push(e) },
        },
        () => {},
      ),
    ).rejects.toBeInstanceOf(MissingChunkError);

    expect(missing).toEqual([{ key: "5" }]);
  });

  it("strict failure stops scheduling new fetches (fail-fast)", async () => {
    let gets = 0;
    const store: Store = {
      async get() {
        gets++;
        return null; // every chunk missing
      },
      async has() {
        return false;
      },
      async *list() {},
    };

    await expect(
      loadChunks(
        store,
        identityCodec,
        makeTasks(10),
        {
          concurrency: 2,
          limiter: new ByteLimiter(1024),
          peakPerChunk: 4,
          strict: true,
        },
        () => {},
      ),
    ).rejects.toBeInstanceOf(MissingChunkError);

    // Only the first wave (concurrency = 2) is ever launched; the failure
    // gates the scheduler before any of the remaining 8 tasks start.
    expect(gets).toBeLessThanOrEqual(2);
  });

  it("strict failure surfaces only after in-flight tasks release the budget", async () => {
    const delivered: LoadedChunk[] = [];
    const store: Store = {
      async get(key: string) {
        if (key === "0") return null; // missing, fails fast
        await delay(20); // slow sibling still in flight at failure time
        return new Uint8Array(4);
      },
      async has() {
        return true;
      },
      async *list() {},
    };

    const limiter = new ByteLimiter(1024);
    await expect(
      loadChunks(
        store,
        identityCodec,
        makeTasks(3),
        { concurrency: 3, limiter, peakPerChunk: 10, strict: true },
        (c) => delivered.push(c),
      ),
    ).rejects.toBeInstanceOf(MissingChunkError);

    // Budget fully restored by the time the rejection is observed, and the
    // aborted siblings did not deliver into the abandoned output.
    expect(limiter.availableBytes).toBe(1024);
    expect(delivered).toHaveLength(0);
  });

  it("strict omitted does not throw on missing chunks", async () => {
    const delivered: LoadedChunk[] = [];

    await loadChunks(
      emptyStore,
      identityCodec,
      [{ key: "0.0", chunkCoord: [0, 0] }],
      { concurrency: 4, limiter: new ByteLimiter(1024), peakPerChunk: 32 },
      (c) => delivered.push(c),
    );

    expect(delivered).toHaveLength(0);
  });
});
