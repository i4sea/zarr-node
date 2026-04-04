export interface MemoryCacheOptions {
  /** Maximum total cache size in bytes. Must be > 0. */
  maxBytes: number;
}

/**
 * In-memory LRU cache for decoded chunk data.
 * Caches post-decompression Uint8Array — avoids both
 * disk I/O and decompression on repeated access.
 */
export class MemoryCache {
  private readonly maxBytes: number;
  private readonly entries = new Map<string, Uint8Array>();
  private _totalBytes = 0;

  constructor(options: MemoryCacheOptions) {
    if (options.maxBytes <= 0) {
      throw new Error("MemoryCache maxBytes must be > 0");
    }
    this.maxBytes = options.maxBytes;
  }

  /** Get cached chunk data. Returns null on miss. Updates LRU order on hit. */
  get(key: string): Uint8Array | null {
    const data = this.entries.get(key);
    if (data === undefined) return null;
    // Move to end (most recently used) by re-inserting
    this.entries.delete(key);
    this.entries.set(key, data);
    return data;
  }

  /** Store decoded chunk data. Evicts LRU entries if over maxBytes. */
  set(key: string, data: Uint8Array): void {
    // If key already exists, remove it first
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this._totalBytes -= existing.byteLength;
      this.entries.delete(key);
    }

    // Add new entry
    this.entries.set(key, data);
    this._totalBytes += data.byteLength;

    // Evict oldest entries until under limit
    while (this._totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const oldData = this.entries.get(oldest.value);
      if (!oldData) break;
      this._totalBytes -= oldData.byteLength;
      this.entries.delete(oldest.value);
    }
  }

  /** Remove all cached entries. */
  clear(): void {
    this.entries.clear();
    this._totalBytes = 0;
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Current total bytes cached. */
  get totalBytes(): number {
    return this._totalBytes;
  }
}
