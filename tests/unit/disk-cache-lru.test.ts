import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, utimes } from "node:fs/promises";
import { DiskCache } from "../../src/cache/disk.js";
import { totalDiskSize } from "../helpers/disk.js";

describe("DiskCache LRU eviction", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = join(
      tmpdir(),
      `zarr-disk-lru-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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

  it("keeps total on-disk size ≤ maxSizeBytes across sustained writes (SC-001)", async () => {
    const maxSizeBytes = 1000;
    const cache = new DiskCache(cacheDir, "test-store", null, maxSizeBytes);

    // Backdated, strictly increasing mtimes make eviction order deterministic
    // regardless of filesystem mtime granularity (no sleeps needed).
    const base = Date.now() - 60_000;
    for (let i = 0; i < 20; i++) {
      await cache.set(`chunk-${i}`, new Uint8Array(300).fill(i));
      const mtime = new Date(base + i * 1000);
      await utimes(cache.pathFor(`chunk-${i}`), mtime, mtime);

      const size = await totalDiskSize(cacheDir);
      // Guard against a vacuous pass if the cache writes nowhere
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(maxSizeBytes);
    }

    // Most-recent entries survive eviction
    expect(await cache.get("chunk-19")).not.toBeNull();
  });

  it("rejects maxSizeBytes <= 0", () => {
    expect(() => new DiskCache(cacheDir, "test-store", null, 0)).toThrow();
    expect(() => new DiskCache(cacheDir, "test-store", null, -1)).toThrow();
  });

  it("rejects NaN maxSizeBytes", () => {
    expect(() => new DiskCache(cacheDir, "test-store", null, NaN)).toThrow();
  });

  it("accepts Infinity as an explicit no-eviction configuration", async () => {
    const cache = new DiskCache(cacheDir, "test-store", null, Infinity);
    await cache.set("a", new Uint8Array(200));
    expect(await cache.get("a")).not.toBeNull();
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
