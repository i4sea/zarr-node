# Research: Disk Chunk Cache

**Phase**: 0 (Outline & Research)
**Date**: 2026-04-04

## Cache Key Design

### Decision: Hash-based store identity + literal chunk key

**Rationale**: Cache keys must be unique per store + chunk key combination.
The store identity is derived from a hash of the store's configuration
(e.g., bucket+prefix for S3, URL for HTTP) to avoid path-length issues
and special characters in directory names.

**Cache path format**:
```
{cacheDir}/{storeHash}/{chunkKey}
```

Where:
- `cacheDir`: User-provided directory (e.g., `/tmp/zarr-cache`)
- `storeHash`: SHA-256 hex prefix (first 16 chars) of the store identity string
- `chunkKey`: Literal Zarr key (e.g., `wind_speed_at_10m_agl/0.0.0`)

**Store identity string by type**:
- S3Store: `s3://{bucket}/{prefix}`
- HTTPStore: `{baseUrl}`
- Custom stores: `custom://{user-provided-id}` (optional config)

**Alternatives considered**:
- Full URL as directory: Too long, special chars break on Windows. Rejected.
- Store instance ID (random UUID): Doesn't persist across sessions. Rejected.
- User-provided store name: Extra config burden. Rejected — auto-derive is simpler.

## Atomic Write Strategy

### Decision: Write to temp file, then rename

**Rationale**: `fs.rename()` is atomic on POSIX systems within the same
filesystem. Write chunk data to `{path}.tmp.{pid}`, then rename to `{path}`.
This prevents partial reads from concurrent processes or crashes.

**Key details**:
- Temp file includes PID to avoid collisions between concurrent processes
- If rename fails (cross-device), fall back to write-in-place (rare)
- If any I/O error occurs, silently continue without caching (FR-010)

## TTL Implementation

### Decision: File modification time comparison

**Rationale**: Use `fs.stat().mtimeMs` to check chunk file age against
TTL. No separate metadata files needed — the filesystem's mtime is the
TTL clock. Simple, zero-overhead, works across sessions.

**Key details**:
- On cache hit: check `Date.now() - stat.mtimeMs > ttlMs`
- If expired: delete cached file, fetch from remote, write new cache
- If no TTL configured: skip mtime check entirely (serve forever)
- `mtime` is updated on write (including re-fetch after TTL expiry)

**Alternatives considered**:
- Separate `.meta` sidecar files: Doubles file count, more complexity. Rejected.
- SQLite index: Over-engineered for key-value chunk cache. Rejected.
- Custom timestamp in filename: Breaks the mirrored key structure. Rejected.

## CachedStore Design

### Decision: Store wrapper (decorator pattern)

**Rationale**: CachedStore implements the Store interface by wrapping
another Store. Only `get()` is intercepted for caching — `has()` and
`list()` delegate directly to the inner store (metadata operations, not
chunk data).

**Why only cache `get()`**:
- `get()` is the expensive operation (chunk data, megabytes)
- `has()` is cheap (HEAD request) and already optimized by consolidated metadata
- `list()` is rare and already optimized by consolidated metadata
- Caching `has()` or `list()` would risk stale results for metadata operations

**API shape**:
```typescript
interface CacheOptions {
  cacheDir: string;         // Required: local directory for cached chunks
  ttl?: number;             // Optional: TTL in seconds (default: no expiry)
  storeId?: string;         // Optional: override auto-derived store identity
}
```

The user wraps their store:
```typescript
const s3 = new S3Store({ bucket: "data", prefix: "zarr" });
const cached = new CachedStore(s3, { cacheDir: "/tmp/zarr-cache" });
const arr = await openArray(cached);
```

## Thundering Herd Protection

### Decision: In-flight request deduplication via Promise map

**Rationale**: When multiple concurrent reads request the same chunk
(e.g., 4 parallel slice reads all hitting chunk `lat/0.0`), only one
network fetch should be made. Without deduplication, all concurrent
callers miss the cache simultaneously and each triggers its own fetch.

**Observed impact**: Reading 4 corners of a lat array (single chunk)
went from 4 S3 GETs to 1 GET — cutting download time in half.

**Implementation**: CachedStore maintains a `Map<string, Promise>` of
in-flight fetches. On cache miss:
1. Check if a fetch for this key is already in-flight
2. If yes, await the existing promise (no new fetch)
3. If no, start the fetch, store the promise in the map, await it,
   then remove from the map

**Key details**:
- Map is per-CachedStore instance (not global)
- Promise is removed from map after resolution (success or failure)
- Cache write happens inside the deduplicated fetch, so all waiters
  benefit from the cache being populated

**Alternatives considered**:
- No deduplication (original): 4x S3 GETs for same chunk. Rejected —
  wasteful and slow.
- Global deduplication across stores: Unnecessary complexity. Rejected.

## Clear Cache

### Decision: `CachedStore.clearCache()` method

**Rationale**: Simple async method that deletes the store-specific
subdirectory under cacheDir. Called explicitly by the user.

```typescript
await cached.clearCache(); // Removes /tmp/zarr-cache/{storeHash}/
```

## What NOT to cache

### Decision: Only cache chunk data, not metadata

**Rationale**: Metadata (.zarray, .zgroup, .zattrs) is already handled by
consolidated metadata (feature 002). Caching metadata on disk would risk
stale array definitions. Chunk data is immutable in Zarr v2 stores (append-
only), making it safe to cache.

**How to distinguish**: Chunk keys never end in `.zarray`, `.zgroup`,
`.zattrs`, or `.zmetadata`. The CachedStore skips caching for any key
matching these patterns.
