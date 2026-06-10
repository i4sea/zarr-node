import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { safeInvoke } from "../../src/observability.js";
import type { ObservabilityHooks } from "../../src/observability.js";
import { HTTPStore } from "../../src/store/http.js";
import { CachedStore } from "../../src/cache/cached-store.js";
import { MemoryCache } from "../../src/cache/memory.js";
import { ByteLimiter } from "../../src/chunk/limiter.js";
import { loadChunks } from "../../src/chunk/loader.js";
import type { LoadedChunk } from "../../src/chunk/loader.js";
import { GzipCodec } from "../../src/codec/gzip.js";
import type { Store } from "../../src/store/store.js";

describe("safeInvoke", () => {
  // T002: throw-isolation — a throwing handler is swallowed and never propagates
  it("swallows a throwing handler and never propagates", () => {
    const throwing = () => {
      throw new Error("handler exploded");
    };

    expect(() =>
      safeInvoke(throwing, { tier: "memory", key: "0.0" }),
    ).not.toThrow();
  });

  it("invokes the handler with the given argument", () => {
    const handler = vi.fn();
    const payload = { tier: "disk", key: "1.2" };

    safeInvoke(handler, payload);

    expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("swallows a rejecting async handler (no unhandled rejection)", async () => {
    // `(e) => void` accepts async handlers via void-return assignability; a
    // rejection must not escape as an unhandled rejection (process crash).
    const rejecting = (async () => {
      throw new Error("async handler exploded");
    }) as unknown as (e: { tier: string; key: string }) => void;

    expect(() =>
      safeInvoke(rejecting, { tier: "memory", key: "0.0" }),
    ).not.toThrow();
    // Give the rejection a tick to surface — vitest fails the test run on
    // unhandled rejections, so reaching the end cleanly is the assertion.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

/** Minimal in-memory Store for driving the loader and CachedStore. */
function mapStore(entries: Record<string, Uint8Array>): Store {
  const map = new Map(Object.entries(entries));
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async has(key) {
      return map.has(key);
    },
    async *list() {},
  };
}

// T019: onStoreFetch fires on successful store fetches with key/bytes/latencyMs
describe("onStoreFetch (HTTPStore)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires with key, byte length, and non-negative latencyMs on a successful GET", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body.slice(), { status: 200 })),
    );

    const onStoreFetch = vi.fn();
    const store = new HTTPStore({
      url: "http://example.test/data",
      observability: { onStoreFetch },
    });

    const result = await store.get("a/0.0");

    expect(result).toEqual(body);
    expect(onStoreFetch).toHaveBeenCalledTimes(1);
    const event = onStoreFetch.mock.calls[0][0];
    expect(event.key).toBe("a/0.0");
    expect(event.bytes).toBe(5);
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not fire on a 404 miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const onStoreFetch = vi.fn();
    const store = new HTTPStore({
      url: "http://example.test/data",
      observability: { onStoreFetch },
    });

    expect(await store.get("missing")).toBeNull();
    expect(onStoreFetch).not.toHaveBeenCalled();
  });

  it("fires on a successful range fetch with the slice byte length", async () => {
    const slice = new Uint8Array([9, 8, 7]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(slice.slice(), { status: 206 })),
    );

    const onStoreFetch = vi.fn();
    const store = new HTTPStore({
      url: "http://example.test/data",
      observability: { onStoreFetch },
    });

    const result = await store.getRange("a/0.0", 4, 3);

    expect(result).toEqual(slice);
    expect(onStoreFetch).toHaveBeenCalledTimes(1);
    const event = onStoreFetch.mock.calls[0][0];
    expect(event.key).toBe("a/0.0");
    expect(event.bytes).toBe(3);
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("slices locally when a Range-ignoring server replies 200 with the full body", async () => {
    const fullBody = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fullBody.slice(), { status: 200 })),
    );

    const onStoreFetch = vi.fn();
    const store = new HTTPStore({
      url: "http://example.test/data",
      observability: { onStoreFetch },
    });

    const result = await store.getRange("a/0.0", 4, 3);

    expect(result).toEqual(new Uint8Array([4, 5, 6]));
    expect(onStoreFetch.mock.calls[0][0].bytes).toBe(3);
  });

  it("a throwing onStoreFetch handler does not break the read", async () => {
    const body = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body.slice(), { status: 200 })),
    );

    const store = new HTTPStore({
      url: "http://example.test/data",
      observability: {
        onStoreFetch: () => {
          throw new Error("handler exploded");
        },
      },
    });

    await expect(store.get("a/0.0")).resolves.toEqual(body);
  });
});

// T019: memory-tier onCacheHit/onCacheMiss and onChunkDecoded fire in the loader
describe("loader memory-tier hooks", () => {
  async function runLoad(
    store: Store,
    codec: GzipCodec | null,
    memoryCache: MemoryCache | null,
    hooks: ObservabilityHooks,
  ): Promise<LoadedChunk[]> {
    const chunks: LoadedChunk[] = [];
    await loadChunks(
      store,
      codec,
      [{ key: "0.0", chunkCoord: [0, 0] }],
      0,
      4,
      {
        concurrency: 2,
        memoryCache,
        limiter: new ByteLimiter(1024),
        peakPerChunk: 8,
        observability: hooks,
      },
      (c) => chunks.push(c),
    );
    return chunks;
  }

  it("fires onCacheMiss (tier memory) then onCacheHit on a repeat read", async () => {
    const store = mapStore({ "0.0": new Uint8Array([1, 2, 3, 4]) });
    const cache = new MemoryCache({ maxBytes: 1024 });
    const onCacheHit = vi.fn();
    const onCacheMiss = vi.fn();
    const hooks = { onCacheHit, onCacheMiss };

    await runLoad(store, null, cache, hooks);

    expect(onCacheMiss).toHaveBeenCalledExactlyOnceWith({
      tier: "memory",
      key: "0.0",
    });
    expect(onCacheHit).not.toHaveBeenCalled();

    await runLoad(store, null, cache, hooks);

    expect(onCacheHit).toHaveBeenCalledExactlyOnceWith({
      tier: "memory",
      key: "0.0",
    });
    expect(onCacheMiss).toHaveBeenCalledTimes(1);
  });

  it("fires onChunkDecoded with bytes, codec id, and non-negative decodeMs", async () => {
    const decoded = new Uint8Array([1, 2, 3, 4]);
    const store = mapStore({ "0.0": new Uint8Array(gzipSync(decoded)) });
    const onChunkDecoded = vi.fn();

    const chunks = await runLoad(store, new GzipCodec("gzip"), null, {
      onChunkDecoded,
    });

    expect(chunks[0].data).toEqual(decoded);
    expect(onChunkDecoded).toHaveBeenCalledTimes(1);
    const event = onChunkDecoded.mock.calls[0][0];
    expect(event.bytes).toBe(4);
    expect(event.codec).toBe("gzip");
    expect(event.decodeMs).toBeGreaterThanOrEqual(0);
  });

  it("fires onChunkDecoded with codec null for uncompressed chunks", async () => {
    const store = mapStore({ "0.0": new Uint8Array([1, 2, 3, 4]) });
    const onChunkDecoded = vi.fn();

    await runLoad(store, null, null, { onChunkDecoded });

    expect(onChunkDecoded).toHaveBeenCalledTimes(1);
    const event = onChunkDecoded.mock.calls[0][0];
    expect(event.bytes).toBe(4);
    expect(event.codec).toBeNull();
    expect(event.decodeMs).toBeGreaterThanOrEqual(0);
  });

  it("throwing handlers do not break the read", async () => {
    const store = mapStore({ "0.0": new Uint8Array([1, 2, 3, 4]) });
    const cache = new MemoryCache({ maxBytes: 1024 });
    const boom = () => {
      throw new Error("handler exploded");
    };
    const hooks = {
      onCacheHit: boom,
      onCacheMiss: boom,
      onChunkDecoded: boom,
    };

    const first = await runLoad(store, null, cache, hooks);
    const second = await runLoad(store, null, cache, hooks);

    expect(first[0].data).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(second[0].data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

// T019: disk-tier onCacheHit/onCacheMiss fire in CachedStore
describe("CachedStore disk-tier hooks", () => {
  it("fires onCacheMiss (tier disk) on first read and onCacheHit on repeat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zarr-obs-"));
    try {
      const inner = mapStore({ "a/0.0": new Uint8Array([5, 6, 7]) });
      const onCacheHit = vi.fn();
      const onCacheMiss = vi.fn();
      const store = new CachedStore(inner, {
        cacheDir: dir,
        storeId: "obs-test",
        maxSizeBytes: 1024 * 1024,
        observability: { onCacheHit, onCacheMiss },
      });

      const first = await store.get("a/0.0");
      expect(first).toEqual(new Uint8Array([5, 6, 7]));
      expect(onCacheMiss).toHaveBeenCalledExactlyOnceWith({
        tier: "disk",
        key: "a/0.0",
      });
      expect(onCacheHit).not.toHaveBeenCalled();

      const second = await store.get("a/0.0");
      expect(second).toEqual(new Uint8Array([5, 6, 7]));
      expect(onCacheHit).toHaveBeenCalledExactlyOnceWith({
        tier: "disk",
        key: "a/0.0",
      });
      expect(onCacheMiss).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not fire disk-tier events for metadata keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zarr-obs-"));
    try {
      const inner = mapStore({ ".zarray": new Uint8Array([123]) });
      const onCacheHit = vi.fn();
      const onCacheMiss = vi.fn();
      const store = new CachedStore(inner, {
        cacheDir: dir,
        storeId: "obs-test",
        maxSizeBytes: 1024 * 1024,
        observability: { onCacheHit, onCacheMiss },
      });

      await store.get(".zarray");

      expect(onCacheHit).not.toHaveBeenCalled();
      expect(onCacheMiss).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// T019: onInFlightBytes fires on every budget change in ByteLimiter
describe("ByteLimiter onInFlightBytes", () => {
  it("reports current in-flight bytes on acquire and release", async () => {
    const seen: number[] = [];
    const limiter = new ByteLimiter(100, (current) => seen.push(current));

    await limiter.acquire(30);
    expect(seen).toEqual([30]);

    await limiter.acquire(50);
    expect(seen).toEqual([30, 80]);

    limiter.release(30);
    expect(seen).toEqual([30, 80, 50]);

    limiter.release(50);
    expect(seen).toEqual([30, 80, 50, 0]);
  });

  it("reports the post-wake budget when a queued waiter resumes", async () => {
    const seen: number[] = [];
    const limiter = new ByteLimiter(100, (current) => seen.push(current));

    await limiter.acquire(100);
    const pending = limiter.acquire(40);
    limiter.release(100);
    await pending;

    // Release returns 100 bytes then pump reserves 40 for the waiter → 40 in flight.
    expect(seen[seen.length - 1]).toBe(40);
  });

  it("a throwing callback does not break acquire/release", async () => {
    const limiter = new ByteLimiter(100, () => {
      throw new Error("handler exploded");
    });

    await expect(limiter.acquire(10)).resolves.toBeUndefined();
    expect(() => limiter.release(10)).not.toThrow();
    expect(limiter.availableBytes).toBe(100);
  });

  it("does not dispatch when no callback is registered", async () => {
    const limiter = new ByteLimiter(100);
    await limiter.acquire(10);
    limiter.release(10);
    expect(limiter.availableBytes).toBe(100);
  });
});
