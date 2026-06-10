import { describe, it, expect } from "vitest";
import type { Cache } from "../../src/cache/cache.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared contract test suite for all Cache implementations (T008).
 * Call runCacheContractTests with a factory that creates an empty cache.
 */
export function runCacheContractTests(
  name: string,
  createCache: () => Promise<{ cache: Cache; cleanup?: () => Promise<void> }>,
) {
  describe(`${name} — Cache contract`, () => {
    it("get() on an unset key returns null", async () => {
      const { cache, cleanup } = await createCache();
      try {
        expect(await cache.get("unset-key")).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it("set() then get() round-trips the value", async () => {
      const { cache, cleanup } = await createCache();
      try {
        const value = new Uint8Array([10, 20, 30, 40]);
        await cache.set("round-trip", value);
        const result = await cache.get("round-trip");
        expect(result).not.toBeNull();
        expect(Array.from(result!)).toEqual(Array.from(value));
      } finally {
        await cleanup?.();
      }
    });

    it("round-trip is binary-safe across all byte values", async () => {
      const { cache, cleanup } = await createCache();
      try {
        const value = new Uint8Array(256);
        for (let i = 0; i < 256; i++) value[i] = i;
        await cache.set("binary", value);
        const result = await cache.get("binary");
        expect(result).not.toBeNull();
        expect(result!.byteLength).toBe(256);
        expect(Array.from(result!)).toEqual(Array.from(value));
      } finally {
        await cleanup?.();
      }
    });

    it("round-trips a zero-length value verbatim (negative-cache sentinel)", async () => {
      // The metadata read-through stores absence as a 0-byte value; every
      // Cache implementation must preserve it (not normalize it to a miss).
      const { cache, cleanup } = await createCache();
      try {
        await cache.set("empty", new Uint8Array(0));
        const result = await cache.get("empty");
        expect(result).not.toBeNull();
        expect(result!.byteLength).toBe(0);
      } finally {
        await cleanup?.();
      }
    });

    it("set() with ttlMs expires the entry", async () => {
      const { cache, cleanup } = await createCache();
      try {
        const value = new Uint8Array([1, 2, 3]);
        await cache.set("expiring", value, 30);
        // Visible immediately
        expect(await cache.get("expiring")).not.toBeNull();
        await sleep(80);
        expect(await cache.get("expiring")).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it("set() without ttlMs does not expire", async () => {
      const { cache, cleanup } = await createCache();
      try {
        await cache.set("persistent", new Uint8Array([9]));
        await sleep(80);
        expect(await cache.get("persistent")).not.toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it("has() (if implemented) reflects key presence", async () => {
      const { cache, cleanup } = await createCache();
      try {
        if (!cache.has) return; // optional method
        expect(await cache.has("absent")).toBe(false);
        await cache.set("present", new Uint8Array([7]));
        expect(await cache.has("present")).toBe(true);
      } finally {
        await cleanup?.();
      }
    });
  });
}
