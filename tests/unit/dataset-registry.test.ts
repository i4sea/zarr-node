import { describe, it, expect } from "vitest";
import { ZarrDatasetRegistry } from "../../src/dataset/registry.js";
import type { Store } from "../../src/store/store.js";
import type { Cache } from "../../src/cache/cache.js";

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

function fakeCache(): Cache & { store: Map<string, Uint8Array>; gets: number } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    gets: 0,
    async get(key) {
      this.gets++;
      return store.get(key) ?? null;
    },
    async set(key, value) {
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
