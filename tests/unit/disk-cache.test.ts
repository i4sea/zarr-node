import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, readdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiskCache } from "../../src/cache/disk.js";
import { CachedStore } from "../../src/cache/cached-store.js";
import type { Store } from "../../src/store/store.js";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = join(
    tmpdir(),
    `zarr-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("DiskCache", () => {
  it("get() returns null on cache miss", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    const result = await cache.get("missing/chunk/0.0.0");
    expect(result).toBeNull();
  });

  it("set() + get() round-trips data correctly", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.set("array/0.0", data);

    const result = await cache.get("array/0.0");
    expect(result).not.toBeNull();
    expect(result).toEqual(data);
  });

  it("creates cache directory automatically", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    await cache.set("chunk", new Uint8Array([42]));

    const entries = await readdir(cacheDir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("stores files in storeHash/key structure", async () => {
    const cache = new DiskCache(cacheDir, "s3://bucket/prefix", null);
    await cache.set("wind/0.0.0", new Uint8Array([10]));

    const result = await cache.get("wind/0.0.0");
    expect(result).toEqual(new Uint8Array([10]));
  });

  it("clear() removes all cached entries", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    await cache.set("a/0", new Uint8Array([1]));
    await cache.set("b/0", new Uint8Array([2]));

    await cache.clear();

    expect(await cache.get("a/0")).toBeNull();
    expect(await cache.get("b/0")).toBeNull();
  });

  it("handles concurrent sets to the same key", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    const data1 = new Uint8Array(1000).fill(1);
    const data2 = new Uint8Array(1000).fill(2);

    // Run concurrently — atomic writes should prevent corruption
    await Promise.all([cache.set("chunk", data1), cache.set("chunk", data2)]);

    const result = await cache.get("chunk");
    expect(result).not.toBeNull();
    // Should be one or the other, not corrupt
    const isData1 = result!.every((b) => b === 1);
    const isData2 = result!.every((b) => b === 2);
    expect(isData1 || isData2).toBe(true);
  });

  it("silently handles set() errors (e.g., invalid path chars)", async () => {
    // DiskCache should not throw on set() failures
    const cache = new DiskCache("/dev/null/impossible-path", "store", null);
    // Should not throw
    await cache.set("chunk", new Uint8Array([1]));
  });
});

describe("DiskCache — TTL", () => {
  it("returns data within TTL", async () => {
    const cache = new DiskCache(cacheDir, "test-store", 60000); // 60s TTL
    await cache.set("chunk", new Uint8Array([42]));

    const result = await cache.get("chunk");
    expect(result).toEqual(new Uint8Array([42]));
  });

  it("returns null for expired entries", async () => {
    const cache = new DiskCache(cacheDir, "test-store", 1); // 1ms TTL
    await cache.set("chunk", new Uint8Array([42]));

    // Set file mtime to the past
    const filePath = cache.pathFor("chunk");
    const past = new Date(Date.now() - 5000);
    await utimes(filePath, past, past);

    const result = await cache.get("chunk");
    expect(result).toBeNull();
  });

  it("no TTL means cache forever", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    await cache.set("chunk", new Uint8Array([42]));

    // Set mtime to distant past
    const filePath = cache.pathFor("chunk");
    const past = new Date(Date.now() - 86400000); // 1 day ago
    await utimes(filePath, past, past);

    const result = await cache.get("chunk");
    expect(result).toEqual(new Uint8Array([42]));
  });
});

describe("CachedStore — unbounded cache warning (FR-001)", () => {
  function stubStore(): Store {
    return {
      async get() {
        return null;
      },
      async has() {
        return false;
      },
      async *list() {
        return;
      },
    };
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns exactly once when constructed without maxSizeBytes", () => {
    new CachedStore(stubStore(), { cacheDir });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toMatch(/unbounded/i);
    expect(message).toMatch(/maxSizeBytes/);
  });

  it("warns when maxSizeBytes is null (JS callers bypass the type)", () => {
    new CachedStore(stubStore(), {
      cacheDir,
      maxSizeBytes: null as unknown as number,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn when maxSizeBytes is set", () => {
    new CachedStore(stubStore(), { cacheDir, maxSizeBytes: 1024 });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when skipLocal is true", () => {
    new CachedStore(stubStore(), { cacheDir, skipLocal: true });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ttl: 0 expires entries instead of caching forever", async () => {
    let calls = 0;
    const store: Store = {
      async get() {
        calls++;
        return new Uint8Array([1]);
      },
      async has() {
        return true;
      },
      async *list() {
        return;
      },
    };
    const cached = new CachedStore(store, {
      cacheDir,
      storeId: "ttl0",
      ttl: 0,
      maxSizeBytes: 1024,
    });

    await cached.get("chunk/0");

    // Age the cached file so a zero TTL is unambiguously elapsed
    const probe = new DiskCache(cacheDir, "ttl0", null);
    const past = new Date(Date.now() - 5000);
    await utimes(probe.pathFor("chunk/0"), past, past);

    await cached.get("chunk/0");
    expect(calls).toBe(2);
  });
});

describe("DiskCache — edge cases", () => {
  it("handles corrupt cache file gracefully", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null);
    await cache.set("chunk", new Uint8Array([1, 2, 3]));

    // Corrupt the file by truncating it
    const filePath = cache.pathFor("chunk");
    await writeFile(filePath, "");

    // Should return the empty content (not throw)
    const result = await cache.get("chunk");
    expect(result).not.toBeNull();
  });
});
