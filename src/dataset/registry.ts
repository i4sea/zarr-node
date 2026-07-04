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
   * otherwise accumulate in the shared cache forever. The TTL is (re)stamped on
   * each cache miss, so a version's keys expire `ttlMs` after the last time it
   * was read from the store (not after the last read served from cache). Size it
   * above your re-ingestion cadence.
   * Eviction from the handle LRU tears down heap and disk immediately, but the
   * shared metadata cache is process-external, so a TTL is the only mechanism
   * that bounds its growth — omit it and content-versioned metadata leaks even
   * though heap and disk are reclaimed.
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
    /**
     * The disk-backed store wrapping the backend (when a disk tier is
     * configured), so this handle owns the full lifecycle of its caches and
     * {@link dispose} can tear the disk directory down. `undefined` ⇒ no disk tier.
     */
    private readonly store: CachedStore | undefined,
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
   * Tear down ALL of this dataset's caches — the single place that owns the
   * handle's cleanup. Heap (decoded-chunk `MemoryCache` + decoded-array maps)
   * is freed synchronously so it's reclaimed immediately rather than at GC's
   * discretion; the returned promise settles once the disk directory has been
   * removed. Best-effort on disk: a failed `rm` is swallowed (the dir stays
   * bounded by its own `maxSizeBytes`) so teardown can't break an eviction.
   * Safe to call more than once. Does NOT touch the shared metadata cache —
   * that is process-external and bounded by `metadataCacheTtlMs`.
   *
   * A caller still holding this handle after it was evicted keeps a working
   * dataset (`getArray`/`read` continue to function), but its caches are now
   * cold — subsequent reads re-decode / re-hit the store. Freeing eagerly is
   * intentional: it bounds heap to the live handles rather than every handle
   * any request still references. Hold the handle only for the duration of a
   * request if you rely on its cache warmth.
   */
  dispose(): Promise<void> {
    this.memoryCache?.clear();
    this.decoded.clear();
    // In-flight decodes clean themselves up in their own `finally`; clearing
    // here just drops our reference so a pending map doesn't pin the handle.
    this.decodedInflight.clear();
    if (!this.store) return Promise.resolve();
    return this.store.clearCache().catch(() => {
      // Disk teardown is best-effort; a failed rm just leaves the directory,
      // which is still bounded by the disk cache's own maxSizeBytes.
    });
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
   * In-flight disk teardowns keyed by id. A dataset's directory is derived
   * deterministically from its id (`sha256(id)`), so a re-open of a just-
   * evicted id targets the SAME directory. {@link open} awaits any pending
   * teardown for the id before building, so the old teardown's `rm` can never
   * race the new store's writes. Entries are removed once teardown settles.
   */
  private readonly teardowns = new Map<string, Promise<void>>();

  constructor(private readonly options: ZarrDatasetRegistryOptions = {}) {
    this.maxDatasets = options.maxDatasets ?? 32;
    if (this.maxDatasets <= 0) {
      throw new Error(
        `ZarrDatasetRegistry maxDatasets must be > 0, got ${this.maxDatasets}`,
      );
    }
  }

  /**
   * Resolve once every disk teardown triggered by eviction so far has settled.
   * Eviction runs teardown in the background (an `open()` isn't blocked on the
   * evicted id's `rm`), so this is the hook for code that must know the disk is
   * reclaimed — a graceful shutdown that unmounts the cache volume, or a test
   * asserting on directory contents. Re-opening an evicted id already waits for
   * its own teardown internally; this awaits all of them.
   */
  async whenTornDown(): Promise<void> {
    await Promise.allSettled([...this.teardowns.values()]);
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

    // A prior eviction/clear may still be tearing down this id's disk
    // directory. Since the dir is keyed by id, rebuilding now would race the
    // in-flight `rm`. Wait for it to settle first (best-effort teardown never
    // rejects), then build against a clean directory.
    const pending = this.teardowns.get(id);
    const promise = (
      pending
        ? pending.then(() => this.build(id, storeFactory))
        : this.build(id, storeFactory)
    )
      .then((dataset) => {
        this.entries.set(id, dataset);
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
   * disk directory. The returned promise resolves once every handle — including
   * any that were still being built when `clear()` was called — has been torn
   * down and its disk directory removed. Heap is freed regardless of whether
   * you await.
   */
  async clear(): Promise<void> {
    // Settle in-flight builds first: a build resolving after we clear would
    // otherwise re-populate `entries` and leave a disk dir this call promised
    // to remove. `open`'s `.then` runs on settle, so awaiting here guarantees
    // those handles are in `entries` before we enumerate them.
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
    const teardowns: Array<Promise<void>> = [];
    for (const [id, ds] of this.entries) {
      const t = ds.dispose();
      // Track each so a re-open of the id during teardown serializes against
      // its disk `rm` (same as the eviction path).
      this.track(id, t);
      teardowns.push(t);
    }
    this.entries.clear();
    await Promise.all(teardowns);
    // Also drain any teardowns already in flight from prior evictions.
    await Promise.allSettled([...this.teardowns.values()]);
  }

  private async build(
    id: string,
    storeFactory: StoreFactory,
  ): Promise<ManagedDataset> {
    const backend = await storeFactory();
    const {
      metadataCache,
      metadataCacheTtlMs,
      coordinateCache,
      observability,
      disk,
    } = this.options;

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

    return new ManagedDataset(
      id,
      group,
      memoryCache,
      coordinateCache,
      observability,
      cachedStore,
    );
  }

  private evictIfOverCap(): void {
    while (this.entries.size > this.maxDatasets) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      const [id, dataset] = oldest.value;
      this.entries.delete(id);
      // Record the teardown so a re-open of the same id waits for its disk
      // `rm` before rebuilding (the dir is keyed by id). The shared metadata
      // cache is bounded separately via `metadataCacheTtlMs`.
      this.track(id, dataset.dispose());
    }
  }

  /**
   * Register an in-flight teardown for `id` and drop it from {@link teardowns}
   * once it settles. {@link open} awaits the entry to serialize re-opens
   * against the disk `rm` for the same directory.
   */
  private track(id: string, teardown: Promise<void>): void {
    this.teardowns.set(id, teardown);
    void teardown.finally(() => {
      // Only clear if this is still the tracked teardown — a later eviction of
      // the same id would have replaced it.
      if (this.teardowns.get(id) === teardown) this.teardowns.delete(id);
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
