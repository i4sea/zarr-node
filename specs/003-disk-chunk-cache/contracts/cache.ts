import type { Store } from "../../src/store/store.js";

/**
 * Configuration for disk chunk caching.
 */
export interface CacheOptions {
  /** Local directory for cached chunk files. Created if it doesn't exist. */
  cacheDir: string;

  /** Time-to-live in seconds. Cached chunks older than TTL are re-fetched.
   *  Omit for no expiry (cache forever until manually cleared). */
  ttl?: number;

  /** Override auto-derived store identity string.
   *  Useful when the same remote data is accessed via different store configs. */
  storeId?: string;
}

/**
 * CachedStore wraps a remote Store and caches chunk data on disk.
 *
 * Only `get()` is cached. Metadata keys (.zarray, .zgroup, .zattrs, .zmetadata)
 * are never cached — they are served by consolidated metadata or fetched fresh.
 *
 * `has()` and `list()` delegate to the inner store without caching.
 */
export interface CachedStore extends Store {
  /** Remove all cached entries for this store from disk. */
  clearCache(): Promise<void>;
}
