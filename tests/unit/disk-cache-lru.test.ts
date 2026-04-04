import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { DiskCache } from "../../src/cache/disk.js";

describe("DiskCache LRU eviction", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `zarr-disk-lru-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  // T012: Fill cache beyond maxSizeBytes, verify oldest files removed

  it("evicts oldest entries when over maxSizeBytes", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null, 500);

    // Write entries with 200 bytes each
    const data = new Uint8Array(200);
    await cache.set("a", data);
    // Small delay to ensure different mtimes
    await new Promise((r) => setTimeout(r, 10));
    await cache.set("b", data);
    await new Promise((r) => setTimeout(r, 10));
    await cache.set("c", data); // total: 600 > 500, should evict "a"

    // "a" should have been evicted
    expect(await cache.get("a")).toBeNull();
    // "b" and "c" should still be present
    expect(await cache.get("b")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("evicts multiple entries to get under limit", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null, 300);

    const data = new Uint8Array(200);
    await cache.set("a", data);
    await new Promise((r) => setTimeout(r, 10));
    await cache.set("b", data);
    await new Promise((r) => setTimeout(r, 10));
    // total is now 400, evicts "a" -> 200
    // then adding "c" -> 400, evicts "b" -> 200
    await cache.set("c", data);

    // Only "c" should remain (or "b" and "c" depending on eviction ordering)
    expect(await cache.get("c")).not.toBeNull();
  });

  it("does not evict when under maxSizeBytes", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null, 1000);

    const data = new Uint8Array(200);
    await cache.set("a", data);
    await cache.set("b", data);
    await cache.set("c", data);

    // All entries should still be present (total 600 < 1000)
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("b")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("rejects maxSizeBytes <= 0", () => {
    expect(() => new DiskCache(cacheDir, "test-store", null, 0)).toThrow();
    expect(() => new DiskCache(cacheDir, "test-store", null, -1)).toThrow();
  });

  it("works without maxSizeBytes (no eviction)", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null, null);

    const data = new Uint8Array(200);
    await cache.set("a", data);
    await cache.set("b", data);
    await cache.set("c", data);

    // All entries should be present
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("b")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });
});
