import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCache } from "../../src/cache/memory.js";

describe("MemoryCache", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache({ maxBytes: 1000 });
  });

  // T006: get/set, LRU eviction, maxBytes limit, clear, size tracking

  it("returns null on cache miss", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("stores and retrieves data", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    cache.set("key1", data);

    const result = cache.get("key1");
    expect(result).toEqual(data);
  });

  it("tracks size and totalBytes", () => {
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);

    cache.set("a", new Uint8Array(100));
    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(100);

    cache.set("b", new Uint8Array(200));
    expect(cache.size).toBe(2);
    expect(cache.totalBytes).toBe(300);
  });

  it("evicts LRU entries when over maxBytes", () => {
    // maxBytes = 1000
    cache.set("a", new Uint8Array(400)); // total: 400
    cache.set("b", new Uint8Array(400)); // total: 800
    cache.set("c", new Uint8Array(400)); // total: 1200 -> evicts "a" -> total: 800

    expect(cache.get("a")).toBeNull(); // evicted
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
    expect(cache.totalBytes).toBe(800);
  });

  it("updates LRU order on get()", () => {
    cache.set("a", new Uint8Array(400));
    cache.set("b", new Uint8Array(400));
    // Access "a" to make it most recently used
    cache.get("a");
    // Now adding "c" should evict "b" (least recently used)
    cache.set("c", new Uint8Array(400));

    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("b")).toBeNull(); // evicted
    expect(cache.get("c")).not.toBeNull();
  });

  it("clears all entries", () => {
    cache.set("a", new Uint8Array(100));
    cache.set("b", new Uint8Array(200));
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  });

  it("handles overwriting existing key", () => {
    cache.set("key", new Uint8Array(100));
    cache.set("key", new Uint8Array(200));

    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(200);
    expect(cache.get("key")!.length).toBe(200);
  });

  it("rejects maxBytes <= 0", () => {
    expect(() => new MemoryCache({ maxBytes: 0 })).toThrow();
    expect(() => new MemoryCache({ maxBytes: -1 })).toThrow();
  });

  it("handles single entry larger than maxBytes gracefully", () => {
    // Entry bigger than cache — should still store it (evicting everything else)
    cache.set("big", new Uint8Array(2000));
    expect(cache.get("big")).not.toBeNull();
    expect(cache.size).toBe(1);
  });
});
