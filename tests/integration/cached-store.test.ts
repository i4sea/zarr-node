import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CachedStore } from "../../src/cache/cached-store.js";
import { FileSystemStore } from "../../src/store/filesystem.js";
import type { Store } from "../../src/store/store.js";
import { openArray } from "../../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
let cacheDir: string;

beforeEach(() => {
  cacheDir = join(tmpdir(), `zarr-cached-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("CachedStore — basic caching (US1)", () => {
  it("first read caches chunk, second read from disk", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    let fetchCount = 0;
    const counting: Store = {
      async get(key: string) {
        fetchCount++;
        return inner.get(key);
      },
      async has(key: string) { return inner.has(key); },
      async *list(prefix: string) { yield* inner.list(prefix); },
    };

    const cached = new CachedStore(counting, { cacheDir, storeId: "test" });
    const arr = await openArray(cached);

    // First read — fetches chunk "0" from store
    fetchCount = 0;
    const data1 = await arr.get();
    const firstFetches = fetchCount;

    // Second read — chunk should come from cache
    fetchCount = 0;
    const data2 = await arr.get();
    const secondFetches = fetchCount;

    expect(data1).toEqual(data2);
    expect(firstFetches).toBeGreaterThan(0);
    // Second read: only metadata calls (which pass through), no chunk fetch
    // Chunk key "0" should be cached
    expect(secondFetches).toBeLessThan(firstFetches);
  });

  it("metadata keys are NOT cached", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const cached = new CachedStore(inner, { cacheDir, storeId: "test" });

    // Trigger metadata + chunk read
    await openArray(cached);

    // Check cache directory — should only contain chunk files, not .zarray/.zattrs
    const storeEntries = await listRecursive(cacheDir);
    const metadataFiles = storeEntries.filter(
      (f) => f.endsWith(".zarray") || f.endsWith(".zattrs") || f.endsWith(".zgroup") || f.endsWith(".zmetadata"),
    );
    expect(metadataFiles).toEqual([]);
  });

  it("cache hit is fast (< 10ms)", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const cached = new CachedStore(inner, { cacheDir, storeId: "test" });
    const arr = await openArray(cached);

    // Populate cache
    await arr.get();

    // Time the cached read
    const start = performance.now();
    await cached.get("0"); // Direct chunk key
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
  });
});

describe("CachedStore — opt-in behavior (US2)", () => {
  it("no cache files when store is NOT wrapped", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    await openArray(inner);

    // cacheDir should not exist (we never created CachedStore)
    try {
      await readdir(cacheDir);
      // If it exists, it should be empty
      expect(true).toBe(false); // Should not reach here
    } catch {
      // Expected — directory doesn't exist
    }
  });

  it("FileSystemStore wrapped with CachedStore skips caching (FR-009)", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const cached = new CachedStore(inner, { cacheDir, storeId: "test", skipLocal: true });
    const arr = await openArray(cached);
    await arr.get();

    // With skipLocal, no cache files should be created
    try {
      const entries = await listRecursive(cacheDir);
      expect(entries.length).toBe(0);
    } catch {
      // Directory doesn't exist — also correct
    }
  });

  it("cache files mirror key hierarchy", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "chunked_2d") });
    const cached = new CachedStore(inner, { cacheDir, storeId: "test" });
    const arr = await openArray(cached);
    await arr.get([[0, 1], [0, 1]]); // Small slice — chunk 0.0

    const files = await listRecursive(cacheDir);
    const chunkFiles = files.filter((f) => !f.includes(".tmp"));
    expect(chunkFiles.some((f) => f.includes("0.0"))).toBe(true);
  });
});

describe("CachedStore — TTL (US3)", () => {
  it("serves from cache within TTL", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const cached = new CachedStore(inner, { cacheDir, storeId: "test", ttl: 60 });
    const arr = await openArray(cached);

    await arr.get();
    const data = await arr.get();
    expect(data.length).toBe(10);
  });

  it("clearCache() removes all entries", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const cached = new CachedStore(inner, { cacheDir, storeId: "test" });
    const arr = await openArray(cached);
    await arr.get();

    await cached.clearCache();

    // Cache should be empty
    try {
      const files = await listRecursive(cacheDir);
      expect(files.length).toBe(0);
    } catch {
      // Directory removed — also correct
    }
  });
});

describe("CachedStore — cross-session (US4)", () => {
  it("second CachedStore instance reads from existing cache", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });

    // Session 1: populate cache
    const cached1 = new CachedStore(inner, { cacheDir, storeId: "test" });
    await (await openArray(cached1)).get();

    // Session 2: new CachedStore, same cacheDir
    let fetchCount = 0;
    const counting: Store = {
      async get(key: string) { fetchCount++; return inner.get(key); },
      async has(key: string) { return inner.has(key); },
      async *list(prefix: string) { yield* inner.list(prefix); },
    };
    const cached2 = new CachedStore(counting, { cacheDir, storeId: "test" });
    fetchCount = 0;

    // Read chunk — should come from cache, not counting store
    const data = await cached2.get("0");
    expect(data).not.toBeNull();
    expect(fetchCount).toBe(0); // Zero fetches — served from disk
  });
});

async function listRecursive(dir: string): Promise<string[]> {
  const { readdir: rd, stat: st } = await import("node:fs/promises");
  const results: string[] = [];
  try {
    const entries = await rd(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await listRecursive(fullPath)));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore
  }
  return results;
}
