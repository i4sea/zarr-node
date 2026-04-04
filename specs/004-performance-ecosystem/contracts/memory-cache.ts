/**
 * In-memory LRU cache for decoded chunk data.
 * Caches post-decompression Uint8Array — avoids both
 * disk I/O and decompression on repeated access.
 */
export interface MemoryCacheOptions {
  /** Maximum total cache size in bytes. */
  maxBytes: number;
}

export interface MemoryCache {
  /** Get cached chunk data. Returns null on miss. Updates LRU order on hit. */
  get(key: string): Uint8Array | null;

  /** Store decoded chunk data. Evicts LRU entries if over maxBytes. */
  set(key: string, data: Uint8Array): void;

  /** Remove all cached entries. */
  clear(): void;

  /** Current number of cached entries. */
  readonly size: number;

  /** Current total bytes cached. */
  readonly totalBytes: number;
}
