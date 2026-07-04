import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ZarrDatasetRegistry } from "../../src/dataset/registry.js";
import type { Store } from "../../src/store/store.js";
import type { Cache } from "../../src/cache/cache.js";

/** The hashed directory name DiskCache derives for a given store id. */
function diskDirFor(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

// ── minimal in-memory store with one uncompressed float64 array `lat` ────────
function makeStoreData(values: number[]): Map<string, Uint8Array> {
  const enc = new TextEncoder();
  const f64 = new Float64Array(values);
  const m = new Map<string, Uint8Array>();
  m.set(".zgroup", enc.encode(JSON.stringify({ zarr_format: 2 })));
  m.set(".zattrs", enc.encode(JSON.stringify({})));
  m.set(
    "lat/.zarray",
    enc.encode(
      JSON.stringify({
        zarr_format: 2,
        shape: [values.length],
        chunks: [values.length],
        dtype: "<f8",
        compressor: null,
        fill_value: 0,
        order: "C",
        filters: null,
        dimension_separator: ".",
      }),
    ),
  );
  m.set("lat/0", new Uint8Array(f64.buffer.slice(0)));
  return m;
}

class MemStore implements Store {
  gets = 0;
  chunkGets = 0;
  constructor(private readonly data: Map<string, Uint8Array>) {}
  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    if (key === "lat/0") this.chunkGets++;
    return this.data.get(key) ?? null;
  }
  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }
  async *list(prefix: string): AsyncIterable<string> {
    for (const k of this.data.keys()) if (k.startsWith(prefix)) yield k;
  }
}

function fakeCache(): Cache & {
  store: Map<string, Uint8Array>;
  gets: number;
  /** TTL (ms) passed to each `set`, in call order — `undefined` = no TTL. */
  ttls: Array<number | undefined>;
} {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    gets: 0,
    ttls: [],
    async get(key) {
      this.gets++;
      return store.get(key) ?? null;
    },
    async set(key, value, ttlMs) {
      this.ttls.push(ttlMs);
      store.set(key, value);
    },
  };
}

describe("ZarrDatasetRegistry — handle reuse", () => {
  it("reuses the opened dataset and calls the store factory only once", async () => {
    const reg = new ZarrDatasetRegistry();
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return new MemStore(makeStoreData([10, 20, 30]));
    };

    const a = await reg.open("s3://x/ds.zarr", factory);
    const b = await reg.open("s3://x/ds.zarr", factory);

    expect(a).toBe(b);
    expect(factoryCalls).toBe(1);
    expect(reg.size).toBe(1);
  });

  it("dedups concurrent opens of the same id (thundering herd)", async () => {
    const reg = new ZarrDatasetRegistry();
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return new MemStore(makeStoreData([1, 2, 3]));
    };

    const [a, b] = await Promise.all([
      reg.open("id", factory),
      reg.open("id", factory),
    ]);

    expect(a).toBe(b);
    expect(factoryCalls).toBe(1);
  });

  it("evicts the least-recently-used handle past maxDatasets", async () => {
    const reg = new ZarrDatasetRegistry({ maxDatasets: 1 });
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return new MemStore(makeStoreData([1]));
    };

    await reg.open("A", factory);
    await reg.open("B", factory); // evicts A
    await reg.open("A", factory); // A re-opened (factory again)

    expect(factoryCalls).toBe(3);
    expect(reg.size).toBe(1);
  });
});

describe("ManagedDataset — managed memory cache on read()", () => {
  it("serves repeated reads from the per-dataset memoryCache (no extra chunk GET)", async () => {
    const reg = new ZarrDatasetRegistry({ chunkMemoryCacheBytes: 1024 * 1024 });
    const store = new MemStore(makeStoreData([10, 20, 30]));
    const ds = await reg.open("id", () => store);

    const r1 = await ds.read("lat");
    const before = store.chunkGets;
    const r2 = await ds.read("lat");

    expect(Array.from(r1 as Float64Array)).toEqual([10, 20, 30]);
    expect(Array.from(r2 as Float64Array)).toEqual([10, 20, 30]);
    // Second read hit the decoded-chunk memory cache → no new chunk fetch.
    expect(store.chunkGets).toBe(before);
  });

  it("re-fetches when no memory cache is configured", async () => {
    const reg = new ZarrDatasetRegistry(); // chunkMemoryCacheBytes unset → disabled
    const store = new MemStore(makeStoreData([10, 20, 30]));
    const ds = await reg.open("id", () => store);

    await ds.read("lat");
    const before = store.chunkGets;
    await ds.read("lat");

    expect(store.chunkGets).toBe(before + 1);
  });
});

describe("ManagedDataset — decodedArray L1/L2", () => {
  it("L1: decodes once per handle, reuses on subsequent calls", async () => {
    const reg = new ZarrDatasetRegistry();
    const store = new MemStore(makeStoreData([10, 20, 30]));
    const ds = await reg.open("id", () => store);

    const a = await ds.decodedArray("lat");
    const before = store.chunkGets;
    const b = await ds.decodedArray("lat");

    expect(Array.from(a)).toEqual([10, 20, 30]);
    expect(b).toBe(a); // same cached instance
    expect(store.chunkGets).toBe(before); // no second fetch
  });

  it("L2: a domain cacheKey lets a NEW handle/store skip the chunk fetch", async () => {
    const coordinateCache = fakeCache();
    const reg = new ZarrDatasetRegistry({ coordinateCache });

    // First dataset (run_time A) populates L2 under the domain key.
    const storeA = new MemStore(makeStoreData([10, 20, 30]));
    const dsA = await reg.open("s3://x/runA.zarr", () => storeA);
    const a = await dsA.decodedArray("lat", { cacheKey: "domain-1" });
    expect(Array.from(a)).toEqual([10, 20, 30]);
    expect(storeA.chunkGets).toBe(1);

    // Second dataset (run_time B, fresh store) hits L2 → no chunk GET on storeB.
    const storeB = new MemStore(makeStoreData([10, 20, 30]));
    const dsB = await reg.open("s3://x/runB.zarr", () => storeB);
    const b = await dsB.decodedArray("lat", { cacheKey: "domain-1" });

    expect(Array.from(b)).toEqual([10, 20, 30]);
    expect(storeB.chunkGets).toBe(0); // served from shared L2
    expect(coordinateCache.store.size).toBe(1);
  });

  it("L2: round-trips correctly when the cache returns a pooled Node Buffer (ioredis getBuffer)", async () => {
    // Regression: ioredis `getBuffer` returns Buffers carved from a shared pool —
    // i.e. views with a NON-ZERO byteOffset into a larger ArrayBuffer. The L2
    // deserializer must honor byteOffset; reading from offset 0 of the pool yields
    // garbage/shifted values, which (for a decoded TIME axis) collapses to a
    // non-ascending array and breaks the downstream time-window binary search.
    const bufferCache: Cache & { store: Map<string, Uint8Array> } = {
      store: new Map<string, Uint8Array>(),
      async get(key) {
        const v = this.store.get(key);
        if (!v) return null;
        // Put the bytes at a non-zero offset in a larger pooled Buffer and return
        // a VIEW over them (what ioredis does). Offset 8 leaves zero-bytes before
        // the data, so the old offset-0 read would return shifted/zeroed values.
        const pool = Buffer.alloc(v.byteLength + 8);
        Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(pool, 8);
        return pool.subarray(8, 8 + v.byteLength);
      },
      async set(key, value) {
        // Copy so the stored bytes are stable regardless of the caller's buffer.
        this.store.set(key, new Uint8Array(value));
      },
    };
    const reg = new ZarrDatasetRegistry({ coordinateCache: bufferCache });

    const storeA = new MemStore(makeStoreData([10, 20, 30]));
    const dsA = await reg.open("s3://x/runA.zarr", () => storeA);
    await dsA.decodedArray("lat", { cacheKey: "domain-1" }); // populate L2

    const storeB = new MemStore(makeStoreData([10, 20, 30]));
    const dsB = await reg.open("s3://x/runB.zarr", () => storeB);
    const b = await dsB.decodedArray("lat", { cacheKey: "domain-1" }); // served from the pooled L2 Buffer

    expect(storeB.chunkGets).toBe(0); // came from L2, not the store
    expect(Array.from(b)).toEqual([10, 20, 30]); // honored byteOffset — not garbage/shifted
  });
});

describe("ZarrDatasetRegistry — eviction teardown (issue #12)", () => {
  it("releases the evicted dataset's decoded-chunk heap cache", async () => {
    const reg = new ZarrDatasetRegistry({
      maxDatasets: 1,
      chunkMemoryCacheBytes: 1024 * 1024,
    });

    const dsA = await reg.open(
      "A",
      () => new MemStore(makeStoreData([1, 2, 3])),
    );
    await dsA.read("lat"); // populate A's memoryCache
    expect(dsA.memoryCache!.size).toBeGreaterThan(0);

    // Opening B evicts A → A's heap caches must be cleared, not left for GC.
    await reg.open("B", () => new MemStore(makeStoreData([4, 5, 6])));

    expect(dsA.memoryCache!.size).toBe(0);
    expect(dsA.memoryCache!.totalBytes).toBe(0);
  });

  it("removes the evicted dataset's disk cache directory", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zarr-evict-"));
    try {
      const reg = new ZarrDatasetRegistry({
        maxDatasets: 1,
        disk: { cacheDir, maxSizeBytes: 10 * 1024 * 1024 },
      });

      const dsA = await reg.open(
        "A",
        () => new MemStore(makeStoreData([1, 2, 3])),
      );
      await dsA.read("lat"); // writes a chunk to A's disk directory
      expect(await readdir(cacheDir)).toEqual([diskDirFor("A")]);

      // Evict A by opening B; A's specific directory must be torn down and
      // B's created — asserting on the exact hashed names, not just the count,
      // so removing the wrong dir can't pass.
      const dsB = await reg.open(
        "B",
        () => new MemStore(makeStoreData([4, 5, 6])),
      );
      await dsB.read("lat");
      await reg.whenTornDown(); // eviction teardown of A runs in the background

      expect(await readdir(cacheDir)).toEqual([diskDirFor("B")]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("serializes a re-open against the evicted id's in-flight disk teardown", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zarr-reopen-"));
    try {
      const reg = new ZarrDatasetRegistry({
        maxDatasets: 1,
        disk: { cacheDir, maxSizeBytes: 10 * 1024 * 1024 },
      });

      // A is opened, cached to disk, then evicted by B (teardown of A's dir
      // starts). Immediately re-open A (same id ⇒ same hashed dir) and cache a
      // chunk. If the re-open didn't wait for A's teardown, the in-flight `rm`
      // could delete the freshly-written chunk.
      const dsA1 = await reg.open(
        "A",
        () => new MemStore(makeStoreData([1, 2, 3])),
      );
      await dsA1.read("lat");
      await reg.open("B", () => new MemStore(makeStoreData([4, 5, 6])));
      const dsA2 = await reg.open(
        "A",
        () => new MemStore(makeStoreData([1, 2, 3])),
      );
      await dsA2.read("lat");

      // A's re-opened dir survives with its chunk intact (teardown finished
      // before the rebuild wrote).
      const dirA = join(cacheDir, diskDirFor("A"));
      expect((await readdir(dirA)).length).toBeGreaterThan(0);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("clear() releases heap and wipes all disk directories", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zarr-clear-"));
    try {
      const reg = new ZarrDatasetRegistry({
        maxDatasets: 4,
        disk: { cacheDir, maxSizeBytes: 10 * 1024 * 1024 },
      });

      const dsA = await reg.open(
        "A",
        () => new MemStore(makeStoreData([1, 2, 3])),
      );
      const dsB = await reg.open(
        "B",
        () => new MemStore(makeStoreData([4, 5, 6])),
      );
      await dsA.read("lat");
      await dsB.read("lat");
      expect((await readdir(cacheDir)).length).toBe(2);

      await reg.clear();

      expect(reg.size).toBe(0);
      expect(await readdir(cacheDir)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("clear() tears down handles whose build was still in flight", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zarr-clear-inflight-"));
    try {
      const reg = new ZarrDatasetRegistry({
        maxDatasets: 4,
        disk: { cacheDir, maxSizeBytes: 10 * 1024 * 1024 },
      });

      // Start an open() but do NOT await it, then clear() concurrently. The
      // build must not resolve into a dataset that survives clear() with a
      // leaked disk directory.
      const opening = reg.open(
        "A",
        () => new MemStore(makeStoreData([1, 2, 3])),
      );
      await reg.clear();
      const dsA = await opening;
      await dsA.read("lat");

      // clear() drained the in-flight build before tearing down, so after it
      // the registry is empty. The subsequent read re-creates A's dir (a fresh
      // open would too) — but nothing leaked from the concurrent clear itself.
      expect(reg.size).toBe(0);

      // A second clear() removes what the post-clear read wrote.
      await reg.clear();
      expect(await readdir(cacheDir)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("writes metadata with the configured TTL when metadataCacheTtlMs is set", async () => {
    const cache = fakeCache();
    const reg = new ZarrDatasetRegistry({
      metadataCache: cache,
      metadataCacheTtlMs: 60_000,
    });
    await reg.open(
      "s3://x/ds.zarr",
      () => new MemStore(makeStoreData([1, 2, 3])),
    );

    // Every metadata write went through with the configured TTL.
    expect(cache.ttls.length).toBeGreaterThan(0);
    expect(cache.ttls.every((t) => t === 60_000)).toBe(true);
  });

  it("writes metadata with no TTL by default (unchanged behavior)", async () => {
    const cache = fakeCache();
    const reg = new ZarrDatasetRegistry({ metadataCache: cache });
    await reg.open(
      "s3://x/ds.zarr",
      () => new MemStore(makeStoreData([1, 2, 3])),
    );

    expect(cache.ttls.length).toBeGreaterThan(0);
    expect(cache.ttls.every((t) => t === undefined)).toBe(true);
  });

  it("does not leak disk dirs under concurrent open/read/clear churn", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zarr-stress-"));
    try {
      // Small cap + a small id pool ⇒ heavy LRU churn: the same id is evicted
      // and re-opened repeatedly, its teardown racing the next open, all while
      // clear() runs concurrently. This is the concurrent shape the race fixes
      // target; the invariant checked at the end is "no directory leaked".
      const reg = new ZarrDatasetRegistry({
        maxDatasets: 2,
        disk: { cacheDir, maxSizeBytes: 10 * 1024 * 1024 },
      });

      const IDS = ["A", "B", "C", "D"];
      // A backend whose read latency varies by id, so builds resolve out of
      // order and teardown/rebuild interleavings actually get exercised.
      const store = (id: string): Store => {
        const delay = (id.charCodeAt(0) % 4) + 1; // 1..4 ticks
        const inner = new MemStore(makeStoreData([1, 2, 3]));
        return {
          async get(key) {
            for (let i = 0; i < delay; i++) await Promise.resolve();
            return inner.get(key);
          },
          has: (k) => inner.has(k),
          list: (p) => inner.list(p),
        };
      };

      const ops: Array<Promise<unknown>> = [];
      for (let i = 0; i < 200; i++) {
        const id = IDS[i % IDS.length];
        // Deterministic mix: mostly open+read, an occasional clear() woven in.
        if (i % 17 === 0) {
          ops.push(reg.clear());
        } else {
          ops.push(reg.open(id, () => store(id)).then((ds) => ds.read("lat")));
        }
      }
      // None of the concurrent ops may reject.
      await Promise.all(ops);

      // Quiesce: drain background teardowns, then a final clear() must leave
      // the cache directory completely empty — proof nothing leaked.
      await reg.whenTornDown();
      await reg.clear();
      await reg.whenTornDown();

      expect(reg.size).toBe(0);
      expect(await readdir(cacheDir)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
