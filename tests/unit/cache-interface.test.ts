import { describe, it, expect } from "vitest";
import { InMemoryCache } from "../../src/cache/memory.js";
import { scopeKey } from "../../src/cache/cache.js";
import { runCacheContractTests } from "../contract/cache.contract.js";

// T009: InMemoryCache satisfies the shared Cache contract
runCacheContractTests("InMemoryCache", async () => ({
  cache: new InMemoryCache({ maxBytes: 1024 * 1024 }),
}));

describe("InMemoryCache — adapter behavior", () => {
  it("evicts least-recently-used entries when over maxBytes", async () => {
    const cache = new InMemoryCache({ maxBytes: 8 });
    await cache.set("a", new Uint8Array(4));
    await cache.set("b", new Uint8Array(4));
    // Touch "a" so "b" is LRU, then exceed the budget
    await cache.get("a");
    await cache.set("c", new Uint8Array(4));

    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("overwrites an existing key", async () => {
    const cache = new InMemoryCache({ maxBytes: 1024 });
    await cache.set("k", new Uint8Array([1]));
    await cache.set("k", new Uint8Array([2, 3]));
    expect(Array.from((await cache.get("k"))!)).toEqual([2, 3]);
  });

  it("overwriting with no ttlMs clears a previous TTL", async () => {
    const cache = new InMemoryCache({ maxBytes: 1024 });
    await cache.set("k", new Uint8Array([1]), 20);
    await cache.set("k", new Uint8Array([2]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await cache.get("k")).not.toBeNull();
  });

  it("bounds zero-byte negative-cache sentinels (no unbounded entry growth)", async () => {
    // ABSENT sentinels are 0 bytes; they must still be charged against
    // maxBytes (by key size) or an absent-only workload never evicts.
    const cache = new InMemoryCache({ maxBytes: 1024 });
    for (let i = 0; i < 500; i++) {
      await cache.set(`store-id:path/to/missing-${i}/.zarray`, new Uint8Array(0));
    }
    const lru = (
      cache as unknown as { lru: { size: number; totalBytes: number } }
    ).lru;
    expect(lru.size).toBeLessThan(500);
    expect(lru.totalBytes).toBeLessThanOrEqual(1024);
  });

  it("LRU eviction also frees the expiry timestamp (no orphan growth)", async () => {
    // 4-byte budget: every set evicts the previous key
    const cache = new InMemoryCache({ maxBytes: 4 });
    for (let i = 0; i < 50; i++) {
      await cache.set(`key-${i}`, new Uint8Array(4), 60_000);
    }
    const expiries = (cache as unknown as { expiries: Map<string, number> })
      .expiries;
    // Only the live entry may hold an expiry — evicted keys must not linger
    expect(expiries.size).toBeLessThanOrEqual(1);
  });
});

describe("scopeKey — store-identity scoping", () => {
  it("builds `${storeId}:${key}`", () => {
    expect(scopeKey("s3://bucket/prefix", ".zgroup")).toBe(
      "s3://bucket/prefix:.zgroup",
    );
  });

  it("the same metadata key under different store ids never collides", async () => {
    const cache = new InMemoryCache({ maxBytes: 1024 });
    const metaA = new Uint8Array([1, 1, 1]);
    const metaB = new Uint8Array([2, 2, 2]);

    await cache.set(scopeKey("dataset-a", ".zarray"), metaA);
    await cache.set(scopeKey("dataset-b", ".zarray"), metaB);

    expect(Array.from((await cache.get(scopeKey("dataset-a", ".zarray")))!)).toEqual(
      Array.from(metaA),
    );
    expect(Array.from((await cache.get(scopeKey("dataset-b", ".zarray")))!)).toEqual(
      Array.from(metaB),
    );
    expect(await cache.get(scopeKey("dataset-c", ".zarray"))).toBeNull();
  });
});
