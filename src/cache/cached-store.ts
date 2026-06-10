import type { Store } from "../store/store.js";
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
}

export class CachedStore implements Store {
  private readonly inner: Store;
  private readonly cache: DiskCache;
  private readonly skipLocal: boolean;
  private readonly inflight = new Map<string, Promise<Uint8Array | null>>();

  constructor(inner: Store, options: CacheOptions) {
    this.inner = inner;
    this.skipLocal = options.skipLocal ?? false;

    if (options.maxSizeBytes == null && !this.skipLocal) {
      console.warn(
        `[zarr-node] CachedStore constructed without maxSizeBytes: the disk ` +
          `cache at "${options.cacheDir}" will grow unbounded and may fill the ` +
          `disk. Set maxSizeBytes (e.g. 10 * 1024 ** 3 for 10 GiB) to enable ` +
          `size-based eviction.`,
      );
    }

    const storeId = options.storeId ?? deriveStoreId(inner);
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
      return cached;
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

function deriveStoreId(store: Store): string {
  // Try to extract identity from known store types
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.bucket === "string") {
    // S3Store-like
    const prefix = typeof s.prefix === "string" ? s.prefix : "";
    return `s3://${s.bucket}/${prefix}`;
  }
  if (typeof s.baseUrl === "string") {
    // HTTPStore-like
    return s.baseUrl as string;
  }
  // Fallback: use a generic identifier
  return `store-${Date.now()}`;
}
