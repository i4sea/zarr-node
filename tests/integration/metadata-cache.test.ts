import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { InMemoryCache } from "../../src/cache/memory.js";
import type { Cache } from "../../src/cache/cache.js";
import {
  open,
  openGroup,
  openArray,
  ZarrArray,
  ZarrGroup,
} from "../../src/index.js";
import type { Store } from "../../src/store/store.js";
import type { ObservabilityHooks } from "../../src/observability.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Wrap a store, counting get()/has() calls (the metadata fetch paths). */
function countingStore(inner: Store): {
  store: Store;
  counts: { get: number; has: number };
} {
  const counts = { get: 0, has: 0 };
  const store: Store = {
    async get(key: string) {
      counts.get++;
      return inner.get(key);
    },
    async has(key: string) {
      counts.has++;
      return inner.has(key);
    },
    async *list(prefix: string) {
      yield* inner.list(prefix);
    },
  };
  return { store, counts };
}

function fixtureStore(name: string): Store {
  return new FileSystemStore({ path: join(FIXTURES, name) });
}

describe("Metadata cache — repeated open is served from cache (T010, SC-002)", () => {
  it("second openArray performs ZERO store reads (.zarray/.zattrs)", async () => {
    const { store, counts } = countingStore(fixtureStore("simple_1d"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });

    const arr1 = await openArray(store, undefined, {
      metadataCache: cache,
      storeId: "simple-1d",
    });
    expect(arr1.shape).toEqual([10]);
    expect(counts.get).toBeGreaterThan(0);

    counts.get = 0;
    const arr2 = await openArray(store, undefined, {
      metadataCache: cache,
      storeId: "simple-1d",
    });
    expect(arr2.shape).toEqual([10]);
    expect(counts.get).toBe(0);
  });

  it("second open() of an array performs ZERO store reads", async () => {
    const { store, counts } = countingStore(fixtureStore("simple_1d"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const options = { metadataCache: cache, storeId: "simple-1d" };

    await open(store, undefined, options);
    counts.get = 0;
    const result = await open(store, undefined, options);
    expect(result).toBeInstanceOf(ZarrArray);
    expect(counts.get).toBe(0);
  });

  it("second open() of a consolidated group performs ZERO store reads (.zgroup/.zmetadata)", async () => {
    const { store, counts } = countingStore(fixtureStore("nested_groups"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const options = { metadataCache: cache, storeId: "nested" };

    const g1 = await open(store, undefined, options);
    expect(g1).toBeInstanceOf(ZarrGroup);

    counts.get = 0;
    const g2 = await open(store, undefined, options);
    expect(g2).toBeInstanceOf(ZarrGroup);
    expect((g2 as ZarrGroup).attrs).toEqual({
      description: "Test nested groups",
    });
    expect(counts.get).toBe(0);
  });

  it("child metadata via ZarrGroup is read through the cache (.zgroup/.zattrs/child .zarray)", async () => {
    // Open a sub-path group so the consolidated cache is not involved:
    // child metadata flows through getMeta -> shared cache.
    const { store, counts } = countingStore(fixtureStore("nested_groups"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const options = { metadataCache: cache, storeId: "nested" };

    const g1 = await openGroup(store, "level1", options);
    const a1 = await g1.getArray("array_a");
    expect(a1.shape).toEqual([3]);
    const sub1 = await g1.getGroup("level2");
    expect(sub1).toBeInstanceOf(ZarrGroup);

    counts.get = 0;
    const g2 = await openGroup(store, "level1", options);
    const a2 = await g2.getArray("array_a");
    expect(a2.shape).toEqual([3]);
    const sub2 = await g2.getGroup("level2");
    expect(sub2.attrs).toEqual(sub1.attrs);
    expect(counts.get).toBe(0);
  });

  it("contains() and child existence checks are served from the cache (zero get/has)", async () => {
    const { store, counts } = countingStore(fixtureStore("nested_groups"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const options = { metadataCache: cache, storeId: "nested" };

    // First session populates the cache (including negative entries for
    // the absent .zgroup of array_a / .zarray of level2)
    const g1 = await openGroup(store, "level1", options);
    expect(await g1.contains("array_a")).toBe(true);
    expect(await g1.contains("level2")).toBe(true);
    expect(await g1.contains("missing")).toBe(false);

    counts.get = 0;
    counts.has = 0;
    const g2 = await openGroup(store, "level1", options);
    expect(await g2.contains("array_a")).toBe(true);
    expect(await g2.contains("level2")).toBe(true);
    expect(await g2.contains("missing")).toBe(false);
    expect(counts.get).toBe(0);
    expect(counts.has).toBe(0);
  });

  it("different paths under the same store do not collide", async () => {
    const { store } = countingStore(fixtureStore("nested_groups"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const options = { metadataCache: cache, storeId: "nested" };

    const level1 = await openGroup(store, "level1", options);
    const level2 = await openGroup(store, "level1/level2", options);
    expect(level1.attrs).toEqual({ depth: 1 });
    expect(level2.attrs).toEqual({ depth: 2 });

    // Cached re-open keeps them distinct
    const level1Again = await openGroup(store, "level1", options);
    const level2Again = await openGroup(store, "level1/level2", options);
    expect(level1Again.attrs).toEqual({ depth: 1 });
    expect(level2Again.attrs).toEqual({ depth: 2 });
  });

  it("different datasets sharing one cache do not collide (storeId scoping)", async () => {
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const storeA = fixtureStore("simple_1d");
    const storeB = fixtureStore("chunked_2d");

    await openArray(storeA, undefined, {
      metadataCache: cache,
      storeId: "ds-a",
    });
    await openArray(storeB, undefined, {
      metadataCache: cache,
      storeId: "ds-b",
    });

    // Second opens are cache-served — each must get its own metadata back
    const a = await openArray(storeA, undefined, {
      metadataCache: cache,
      storeId: "ds-a",
    });
    const b = await openArray(storeB, undefined, {
      metadataCache: cache,
      storeId: "ds-b",
    });
    expect(a.shape).toEqual([10]);
    expect(b.shape).toEqual([100, 200]);
  });
});

describe("Metadata cache — no-cache passthrough (FR-010)", () => {
  it("without metadataCache every open hits the store as today", async () => {
    const { store, counts } = countingStore(fixtureStore("simple_1d"));

    const arr1 = await openArray(store);
    const firstCount = counts.get;
    expect(firstCount).toBeGreaterThan(0);

    counts.get = 0;
    const arr2 = await openArray(store);
    expect(counts.get).toBe(firstCount);
    expect(arr2.shape).toEqual(arr1.shape);
  });
});

describe("Metadata cache — store identity (FR-008a)", () => {
  it("metadataCache + non-derivable store identity without storeId throws before any fetch", async () => {
    const { store, counts } = countingStore(fixtureStore("simple_1d"));
    const cache = new InMemoryCache({ maxBytes: 1024 });

    await expect(
      open(store, undefined, { metadataCache: cache }),
    ).rejects.toThrow(/storeId/);
    await expect(
      openArray(store, undefined, { metadataCache: cache }),
    ).rejects.toThrow(/storeId/);
    await expect(
      openGroup(store, undefined, { metadataCache: cache }),
    ).rejects.toThrow(/storeId/);
    expect(counts.get).toBe(0);
  });

  it("derives identity automatically from an HTTP-like store (baseUrl)", async () => {
    const inner = fixtureStore("simple_1d");
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    // Duck-typed HTTP-like store: exposes baseUrl, so no explicit storeId needed
    const httpLike = Object.assign(
      {
        async get(key: string) {
          return inner.get(key);
        },
        async has(key: string) {
          return inner.has(key);
        },
        async *list(prefix: string) {
          yield* inner.list(prefix);
        },
      },
      { baseUrl: "https://example.com/data.zarr" },
    ) as Store;

    const arr = await openArray(httpLike, undefined, { metadataCache: cache });
    expect(arr.shape).toEqual([10]);
  });
});

describe("Metadata cache — failure fallback (FR-011)", () => {
  it("a throwing cache falls back to the store and the read succeeds", async () => {
    const { store, counts } = countingStore(fixtureStore("simple_1d"));
    const brokenCache: Cache = {
      async get() {
        throw new Error("cache unavailable");
      },
      async set() {
        throw new Error("cache unavailable");
      },
    };

    const arr = await openArray(store, undefined, {
      metadataCache: brokenCache,
      storeId: "simple-1d",
    });
    expect(arr.shape).toEqual([10]);
    expect(counts.get).toBeGreaterThan(0);
  });

  it("a cache whose get resolves to undefined is treated as a miss", async () => {
    // Plain-JS adapters commonly return undefined on miss (e.g. Map.get)
    const { store } = countingStore(fixtureStore("simple_1d"));
    const entries = new Map<string, Uint8Array>();
    const mapBackedCache = {
      async get(key: string) {
        return entries.get(key); // undefined on miss — not null
      },
      async set(key: string, value: Uint8Array) {
        entries.set(key, value);
      },
    } as unknown as Cache;

    const arr1 = await openArray(store, undefined, {
      metadataCache: mapBackedCache,
      storeId: "simple-1d",
    });
    expect(arr1.shape).toEqual([10]);

    // Second open is served from the populated cache
    const arr2 = await openArray(store, undefined, {
      metadataCache: mapBackedCache,
      storeId: "simple-1d",
    });
    expect(arr2.shape).toEqual([10]);
  });
});

describe("Metadata cache — shared-tier observability", () => {
  it("fires onCacheMiss on first open and onCacheHit on second", async () => {
    const { store } = countingStore(fixtureStore("simple_1d"));
    const cache = new InMemoryCache({ maxBytes: 1024 * 1024 });
    const hits: string[] = [];
    const misses: string[] = [];
    const observability: ObservabilityHooks = {
      onCacheHit(e) {
        if (e.tier === "shared") hits.push(e.key);
      },
      onCacheMiss(e) {
        if (e.tier === "shared") misses.push(e.key);
      },
    };
    const options = {
      metadataCache: cache,
      storeId: "simple-1d",
      observability,
    };

    await openArray(store, undefined, options);
    expect(misses).toContain(".zarray");
    expect(hits).toHaveLength(0);

    misses.length = 0;
    await openArray(store, undefined, options);
    expect(hits).toContain(".zarray");
    expect(misses).toHaveLength(0);
  });
});
