/**
 * Pluggable async cache abstraction for shared metadata caching
 * (FR-005–FR-011). Implementations: InMemoryCache (root export) and
 * RedisCache (`@i4sea/zarr-node/redis` subpath).
 */
export interface Cache {
  /** Return the cached bytes for `key`, or null on miss. */
  get(key: string): Promise<Uint8Array | null>;
  /** Store bytes under `key`. `ttlMs` omitted ⇒ no expiry. */
  set(key: string, value: Uint8Array, ttlMs?: number): Promise<void>;
  /** Optional existence check. */
  has?(key: string): Promise<boolean>;
}

/**
 * Scope a metadata key by store identity so multiple datasets can share one
 * cache without collisions (FR-008).
 */
export function scopeKey(storeId: string, key: string): string {
  return `${storeId}:${key}`;
}
