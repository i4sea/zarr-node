import type { Cache } from "./cache.js";

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
  private readonly onEvict?: (key: string) => void;
  private _totalBytes = 0;

  constructor(options: MemoryCacheOptions, onEvict?: (key: string) => void) {
    if (options.maxBytes <= 0) {
      throw new Error("MemoryCache maxBytes must be > 0");
    }
    this.maxBytes = options.maxBytes;
    this.onEvict = onEvict;
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
      this.onEvict?.(oldest.value);
    }
  }

  /** Remove a single entry if present. */
  delete(key: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this._totalBytes -= existing.byteLength;
      this.entries.delete(key);
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

export interface InMemoryCacheOptions {
  /** Maximum total cache size in bytes. Must be > 0. */
  maxBytes: number;
}

/**
 * In-process Cache adapter (FR-006) over the MemoryCache byte-LRU.
 * TTLs are honored via stored expiry timestamps checked on read.
 */
export class InMemoryCache implements Cache {
  private readonly lru: MemoryCache;
  private readonly expiries = new Map<string, number>();

  constructor(options: InMemoryCacheOptions) {
    // Free the expiry timestamp together with the evicted value, so the
    // expiries map can never outgrow the bounded LRU.
    this.lru = new MemoryCache(options, (key) => this.expiries.delete(key));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && Date.now() >= expiry) {
      this.lru.delete(key);
      this.expiries.delete(key);
      return null;
    }
    const data = this.lru.get(key);
    if (data === null) {
      // Entry was evicted by the LRU — drop any stale expiry
      this.expiries.delete(key);
    }
    return data;
  }

  async set(key: string, value: Uint8Array, ttlMs?: number): Promise<void> {
    this.lru.set(key, value);
    if (ttlMs !== undefined) {
      this.expiries.set(key, Date.now() + ttlMs);
    } else {
      this.expiries.delete(key);
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }
}
