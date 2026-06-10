import type { Store } from "../store/store.js";
import { deriveStoreId } from "../store/identity.js";
import type { ObservabilityHooks } from "../observability.js";
import { safeInvoke } from "../observability.js";
import { DiskCache } from "./disk.js";

const METADATA_SUFFIXES = [".zarray", ".zattrs", ".zgroup", ".zmetadata"];

export interface CacheOptions {
  /** Local directory for cached chunk files. Created if it doesn't exist. */
  cacheDir: string;
  /** Time-to-live in seconds. Omit for no expiry; 0 expires immediately. */
  ttl?: number;
  /** Override auto-derived store identity string. */
  storeId?: string;
  /** Skip caching (e.g., for local filesystem stores). Default: false. */
  skipLocal?: boolean;
  /** Maximum total cache size in bytes. Oldest entries evicted when exceeded. */
  maxSizeBytes?: number;
  /** Per-instance observability hooks (disk-tier `onCacheHit`/`onCacheMiss`). */
  observability?: ObservabilityHooks;
}

export class CachedStore implements Store {
  private readonly inner: Store;
  private readonly cache: DiskCache;
  private readonly skipLocal: boolean;
  private readonly hooks?: ObservabilityHooks;
  private readonly inflight = new Map<string, Promise<Uint8Array | null>>();

  constructor(inner: Store, options: CacheOptions) {
    this.inner = inner;
    this.skipLocal = options.skipLocal ?? false;
    this.hooks = options.observability;

    if (options.maxSizeBytes == null && !this.skipLocal) {
      console.warn(
        `[zarr-node] CachedStore constructed without maxSizeBytes: the disk ` +
          `cache at "${options.cacheDir}" will grow unbounded and may fill the ` +
          `disk. Set maxSizeBytes (e.g. 10 * 1024 ** 3 for 10 GiB) to enable ` +
          `size-based eviction.`,
      );
    }

    const storeId =
      options.storeId ?? deriveStoreId(inner) ?? fallbackStoreId();
    const ttlMs = options.ttl !== undefined ? options.ttl * 1000 : null;
    const maxSizeBytes = options.maxSizeBytes ?? null;
    this.cache = new DiskCache(options.cacheDir, storeId, ttlMs, maxSizeBytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    // Don't cache metadata keys
    if (isMetadataKey(key)) {
      return this.inner.get(key);
    }

    // Skip caching if configured (FR-009)
    if (this.skipLocal) {
      return this.inner.get(key);
    }

    // Check cache first
    const cached = await this.cache.get(key);
    if (cached !== null) {
      if (this.hooks?.onCacheHit) {
        safeInvoke(this.hooks.onCacheHit, { tier: "disk", key });
      }
      return cached;
    }
    if (this.hooks?.onCacheMiss) {
      safeInvoke(this.hooks.onCacheMiss, { tier: "disk", key });
    }

    // Deduplicate in-flight requests (thundering herd protection)
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.fetchAndCache(key);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchAndCache(key: string): Promise<Uint8Array | null> {
    const data = await this.inner.get(key);
    if (data !== null) {
      await this.cache.set(key, data);
    }
    return data;
  }

  async has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }

  async getRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    // Delegate to inner store — no caching for partial reads
    if (this.inner.getRange) {
      return this.inner.getRange(key, offset, length);
    }
    // Fallback: full fetch + slice
    const data = await this.get(key);
    if (data === null) return null;
    return data.slice(offset, offset + length);
  }

  async *list(prefix: string): AsyncIterable<string> {
    yield* this.inner.list(prefix);
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
  }
}

function isMetadataKey(key: string): boolean {
  return METADATA_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

// Per-process fallback for stores with no derivable identity. The disk cache
// is local to the pod, so a non-shared id is acceptable here — unlike the
// shared metadata cache, which fails fast instead (FR-008a). The id must be
// non-deterministic across restarts: DiskCache maps storeId → directory with
// no content validation, so a reproducible id (e.g. a bare counter) could
// hand one dataset another dataset's cached chunks after a restart that
// constructs stores in a different order.
let fallbackCounter = 0;

function fallbackStoreId(): string {
  return `store-local-${process.pid}-${Date.now().toString(36)}-${fallbackCounter++}`;
}
