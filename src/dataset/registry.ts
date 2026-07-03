/**
 * High-level dataset session API: a single place that owns ALL caching so
 * consumers don't have to wire `CachedStore` + `openGroup` + `MemoryCache` +
 * coordinate caches by hand.
 *
 * Layers owned here (cross-region S3 is assumed, so caching is aggressive):
 *  1. Handle reuse — an LRU of opened {@link ManagedDataset}s keyed by `id`
 *     (e.g. the dataset's S3 path), with thundering-herd dedup. Reopening the
 *     same dataset is free; the parsed group + per-dataset caches are reused.
 *  2. Metadata cache — the shared `Cache` (e.g. Redis) passed to `openGroup`,
 *     scoped by `id`, so `.zmetadata`/`.zarray` are shared across pods.
 *  3. Disk chunk cache — `CachedStore` wrapping the backend, so raw chunks are
 *     served from local disk instead of the (cross-region) backend.
 *  4. Decoded-chunk memory cache — a per-dataset {@link MemoryCache} applied to
 *     every read, so repeated / nearby point reads skip re-decompression.
 *  5. Decoded-array cache — for small, hot arrays (lat/lon/time): an L1 (per
 *     handle) + optional L2 (shared `Cache`) cache of the DECODED values. With a
 *     run_time-invariant `cacheKey` (domain key), coordinate arrays are read once
 *     per *domain* and reused across every run_time and every pod — this is what
 *     kills the multi-second cold-open coordinate re-read.
 */
import type { Store } from "../store/store.js";
import type { ZarrArray, ReadOptions, Slice } from "../array.js";
import type { TypedArray } from "../dtype.js";
import type { ZarrGroup } from "../group.js";
import type { Cache } from "../cache/cache.js";
import type { ObservabilityHooks } from "../observability.js";
import { CachedStore } from "../cache/cached-store.js";
import { MemoryCache } from "../cache/memory.js";
import { openGroup } from "../open.js";

/** Factory that builds the backend `Store` for a dataset (e.g. a fresh S3Store). */
export type StoreFactory = () => Store | Promise<Store>;

export interface ZarrDatasetRegistryOptions {
  /** Max opened datasets kept in the handle LRU. Default 32. */
  maxDatasets?: number;
  /**
   * Shared cache for Zarr metadata (`.zmetadata`/`.zarray`/…), passed to
   * `openGroup`. Immutable per dataset, so it is shared across pods without TTL.
   */
  metadataCache?: Cache;
  /**
   * Shared L2 cache for DECODED coordinate/time arrays (see
   * {@link ManagedDataset.decodedArray}). Often the same backend as
   * `metadataCache`. Keys are namespaced `coord:`.
   */
  coordinateCache?: Cache;
  /**
   * Per-dataset decoded-chunk memory cache budget (bytes). 0/undefined disables.
   * Worst-case heap ≈ `maxDatasets × this` (only hot datasets fill it).
   */
  chunkMemoryCacheBytes?: number;
  /**
   * TTL in ms for shared metadata (`metadataCache`) writes. Omit ⇒ no expiry.
   *
   * Set this when `id`s are content-versioned (e.g. `s3Path@<etag>`): each
   * re-ingestion produces a new id, so its `.zmetadata`/`.zarray` keys would
   * otherwise accumulate in the shared cache forever. A TTL lets obsolete
   * versions' keys expire once they stop being read. Eviction from the handle
   * LRU tears down heap and disk immediately, but the shared metadata cache is
   * process-external, so a TTL is the mechanism that bounds its growth.
   */
  metadataCacheTtlMs?: number;
  /** Disk chunk cache. Omit to skip the on-disk tier. */
  disk?: {
    cacheDir: string;
    maxSizeBytes: number;
    /** TTL in seconds for cached chunks. Omit for no expiry. */
    ttl?: number;
  };
  /** Observability hooks applied to the store tiers and every managed read. */
  observability?: ObservabilityHooks;
}

/** Read options for {@link ManagedDataset.read} — `memoryCache` is managed for you. */
export type ManagedDatasetReadOptions = Omit<ReadOptions, "memoryCache">;

export interface DecodedArrayOptions {
  /**
   * L2 cache key. Omit ⇒ L1 (per-handle) only. Use a run_time-INVARIANT key
   * (domain key) for coordinates so every run_time/pod shares one entry; use a
   * run_time-specific key (e.g. the dataset id) for the time axis.
   */
  cacheKey?: string;
  /** TTL for the L2 entry, in ms. Omit ⇒ no expiry. */
  ttlMs?: number;
  /** Read options forwarded to the underlying full-array `get()`. */
  readOptions?: ReadOptions;
}

const COORD_PREFIX = "coord:";

/**
 * A dataset opened through {@link ZarrDatasetRegistry}: the parsed group plus the
 * caches that make repeated reads cheap. Construct via `registry.open(...)`.
 */
export class ManagedDataset {
  /** Decoded-array L1 cache (per handle), keyed by `name|cacheKey`. */
  private readonly decoded = new Map<string, Float64Array>();
  /** In-flight dedup for concurrent decodedArray() calls on the same key. */
  private readonly decodedInflight = new Map<string, Promise<Float64Array>>();

  constructor(
    /** Identity (e.g. the dataset's S3 path); scopes the metadata + disk caches. */
    readonly id: string,
    readonly group: ZarrGroup,
    /** Per-dataset decoded-chunk cache, applied to every {@link read}. */
    readonly memoryCache: MemoryCache | undefined,
    private readonly coordinateCache: Cache | undefined,
    private readonly observability: ObservabilityHooks | undefined,
  ) {}

  /** Open an array by name (delegates to the cached group metadata — no I/O). */
  getArray(name: string): Promise<ZarrArray> {
    return this.group.getArray(name);
  }

  /**
   * Read a selection of a variable, with the per-dataset decoded-chunk
   * `memoryCache` and the registry observability applied automatically. Callers
   * cannot pass `memoryCache` — it is managed so the cache stays dataset-scoped
   * (chunk keys are not store-scoped, so sharing across datasets would collide).
   */
  async read(
    name: string,
    selection?: Slice,
    opts?: ManagedDatasetReadOptions,
  ): Promise<TypedArray> {
    const arr = await this.getArray(name);
    return arr.get(selection, {
      ...opts,
      memoryCache: this.memoryCache,
      observability: opts?.observability ?? this.observability,
    });
  }

  /**
   * Return a small array's DECODED values as a `Float64Array`, served from L1
   * (per handle) then L2 (shared `coordinateCache`) before touching the store.
   * Intended for hot, fully-read coordinate/time arrays. With a run_time-invariant
   * `cacheKey`, coordinates are read once per domain and reused across run_times
   * and pods (eliminates the cold-open coordinate re-read).
   */
  async decodedArray(
    name: string,
    opts: DecodedArrayOptions = {},
  ): Promise<Float64Array> {
    const l1Key = `${name}|${opts.cacheKey ?? ""}`;

    const hit = this.decoded.get(l1Key);
    if (hit) return hit;

    const existing = this.decodedInflight.get(l1Key);
    if (existing) return existing;

    const promise = this.loadDecodedArray(name, l1Key, opts).finally(() => {
      this.decodedInflight.delete(l1Key);
    });
    this.decodedInflight.set(l1Key, promise);
    return promise;
  }

  private async loadDecodedArray(
    name: string,
    l1Key: string,
    opts: DecodedArrayOptions,
  ): Promise<Float64Array> {
    const l2Key =
      opts.cacheKey && this.coordinateCache
        ? COORD_PREFIX + opts.cacheKey + ":" + name
        : null;

    // L2: shared decoded-array cache (e.g. Redis), cross-run_time / cross-pod.
    if (l2Key && this.coordinateCache) {
      try {
        const cached = await this.coordinateCache.get(l2Key);
        if (cached && cached.byteLength >= 8) {
          const arr = bytesToFloat64(cached);
          this.decoded.set(l1Key, arr);
          return arr;
        }
      } catch {
        // Cache read failure ⇒ fall through to the store.
      }
    }

    // L3: the store (decode the full array, with the dataset memory cache).
    const arr = await this.getArray(name);
    const raw = await arr.get(undefined, {
      ...opts.readOptions,
      memoryCache: this.memoryCache,
      observability: opts.readOptions?.observability ?? this.observability,
    });
    const out = toFloat64(raw);
    this.decoded.set(l1Key, out);

    if (l2Key && this.coordinateCache) {
      try {
        await this.coordinateCache.set(l2Key, float64ToBytes(out), opts.ttlMs);
      } catch {
        // Cache write failure must never break a read.
      }
    }
    return out;
  }

  /**
   * Release this dataset's in-process caches deterministically. Called by the
   * registry on eviction so heap is freed immediately instead of waiting for GC
   * to collect the whole handle. Safe to call more than once. Does NOT touch
   * disk or the shared metadata cache — those are torn down by the registry,
   * which owns their handles.
   */
  releaseHeap(): void {
    this.memoryCache?.clear();
    this.decoded.clear();
    // In-flight decodes clean themselves up in their own `finally`; clearing
    // here just drops our reference so a pending map doesn't pin the handle.
    this.decodedInflight.clear();
  }
}

/**
 * Owns opened {@link ManagedDataset}s and all their caching. Build one per
 * process and reuse it across requests.
 */
export class ZarrDatasetRegistry {
  private readonly maxDatasets: number;
  private readonly entries = new Map<string, ManagedDataset>();
  private readonly inflight = new Map<string, Promise<ManagedDataset>>();
  /**
   * The disk-backed `CachedStore` per live dataset id, kept in lockstep with
   * {@link entries} so eviction can call `clearCache()` to remove the id's
   * on-disk directory. Only populated when a disk tier is configured.
   */
  private readonly stores = new Map<string, CachedStore>();

  constructor(private readonly options: ZarrDatasetRegistryOptions = {}) {
    this.maxDatasets = options.maxDatasets ?? 32;
    if (this.maxDatasets <= 0) {
      throw new Error(
        `ZarrDatasetRegistry maxDatasets must be > 0, got ${this.maxDatasets}`,
      );
    }
  }

  /** Number of currently cached dataset handles. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Open (or reuse) the dataset identified by `id`. `storeFactory` builds the
   * backend store on a cache miss; it is never called on a hit. Concurrent opens
   * of the same `id` share one in-flight promise (thundering-herd guard).
   */
  async open(id: string, storeFactory: StoreFactory): Promise<ManagedDataset> {
    const cached = this.entries.get(id);
    if (cached) {
      // Touch for LRU.
      this.entries.delete(id);
      this.entries.set(id, cached);
      return cached;
    }

    const existing = this.inflight.get(id);
    if (existing) return existing;

    const promise = this.build(id, storeFactory)
      .then(({ dataset, store }) => {
        this.entries.set(id, dataset);
        if (store) this.stores.set(id, store);
        this.evictIfOverCap();
        return dataset;
      })
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, promise);
    return promise;
  }

  /**
   * Drop all cached handles and tear down their caches (e.g. on shutdown /
   * tests). Releases heap synchronously and best-effort removes every dataset's
   * disk directory. The returned promise resolves once disk teardown settles;
   * you can ignore it (heap is freed regardless) or await it in tests.
   */
  clear(): Promise<void> {
    const teardowns: Array<Promise<void>> = [];
    for (const id of [...this.entries.keys()]) {
      teardowns.push(this.teardown(id));
    }
    this.entries.clear();
    this.stores.clear();
    this.inflight.clear();
    return Promise.all(teardowns).then(() => undefined);
  }

  private async build(
    id: string,
    storeFactory: StoreFactory,
  ): Promise<{ dataset: ManagedDataset; store: CachedStore | undefined }> {
    const backend = await storeFactory();
    const { metadataCache, metadataCacheTtlMs, coordinateCache, observability, disk } =
      this.options;

    const cachedStore: CachedStore | undefined = disk
      ? new CachedStore(backend, {
          cacheDir: disk.cacheDir,
          storeId: id,
          maxSizeBytes: disk.maxSizeBytes,
          ttl: disk.ttl,
          observability,
        })
      : undefined;
    const store: Store = cachedStore ?? backend;

    const group = await openGroup(store, "", {
      ...(metadataCache
        ? { metadataCache, storeId: id, metadataCacheTtlMs }
        : {}),
      ...(observability ? { observability } : {}),
    });

    const memoryCache =
      this.options.chunkMemoryCacheBytes &&
      this.options.chunkMemoryCacheBytes > 0
        ? new MemoryCache({ maxBytes: this.options.chunkMemoryCacheBytes })
        : undefined;

    const dataset = new ManagedDataset(
      id,
      group,
      memoryCache,
      coordinateCache,
      observability,
    );
    return { dataset, store: cachedStore };
  }

  private evictIfOverCap(): void {
    while (this.entries.size > this.maxDatasets) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      // Tear down BEFORE dropping the Map refs: releases heap immediately and
      // removes the id's disk directory. The shared metadata cache is bounded
      // separately via `metadataCacheTtlMs` (it is process-external and cannot
      // be enumerated by id here).
      void this.teardown(oldest.value);
      this.entries.delete(oldest.value);
      this.stores.delete(oldest.value);
    }
  }

  /**
   * Release an evicted dataset's caches: heap synchronously, disk directory
   * best-effort. Never throws — disk teardown failures are swallowed so an
   * eviction can't break an ongoing open. Does not mutate {@link entries} /
   * {@link stores}; the caller drops those refs.
   */
  private teardown(id: string): Promise<void> {
    this.entries.get(id)?.releaseHeap();
    const store = this.stores.get(id);
    if (!store) return Promise.resolve();
    return store.clearCache().catch(() => {
      // Disk teardown is best-effort; a failed rm just leaves the directory,
      // which is still bounded by the disk cache's own maxSizeBytes.
    });
  }
}

function toFloat64(typed: ArrayLike<number | bigint>): Float64Array {
  const out = new Float64Array(typed.length);
  for (let i = 0; i < typed.length; i++) out[i] = Number(typed[i]);
  return out;
}

/** Serialize a Float64Array to bytes for the L2 cache (little-endian, native). */
function float64ToBytes(arr: Float64Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Rebuild a Float64Array from L2 bytes, copying to guarantee 8-byte alignment. */
function bytesToFloat64(bytes: Uint8Array): Float64Array {
  const usable = bytes.byteLength - (bytes.byteLength % 8);
  // Copy THIS view's byte range into a fresh ArrayBuffer. We must NOT use
  // `bytes.slice(0, usable).buffer`: when `bytes` is a Node Buffer (e.g. ioredis
  // `getBuffer`), Buffer overrides `slice` to return a VIEW into a shared/pooled
  // ArrayBuffer with a non-zero `byteOffset`, so `new Float64Array(view.buffer, 0)`
  // would read from offset 0 of the pool — garbage/shifted values. Likewise a
  // plain Uint8Array can be a view with a non-zero offset. `ArrayBuffer.slice`
  // always copies, honoring `byteOffset`, and yields a 0-offset, 8-aligned buffer.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable);
  return new Float64Array(ab);
}
