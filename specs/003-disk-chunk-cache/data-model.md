# Data Model: Disk Chunk Cache

**Phase**: 1 (Design & Contracts)
**Date**: 2026-04-04

## Entities

### DiskCache

Manages reading and writing chunk data to a local directory.

**Attributes**:
- `cacheDir`: string — Root directory for all cached data
- `storeHash`: string — SHA-256 hex prefix (16 chars) identifying the store
- `ttlMs`: number | null — TTL in milliseconds, or null for no expiry

**Operations**:
- `get(key: string)` → `Promise<Uint8Array | null>` — Read cached chunk. Returns null on miss or expired TTL.
- `set(key: string, data: Uint8Array)` → `Promise<void>` — Write chunk to cache atomically. Silently ignores I/O errors.
- `clear()` → `Promise<void>` — Remove all cached entries for this store.

**State**: Stateless beyond the filesystem. No in-memory index.

### CachedStore

Store wrapper that intercepts `get()` for caching. Implements the Store interface.

**Attributes**:
- `inner`: Store — The wrapped remote store
- `cache`: DiskCache — Disk cache instance
- `metadataKeys`: Set of patterns to skip caching (`.zarray`, `.zgroup`, `.zattrs`, `.zmetadata`)

**Operations**:
- `get(key: string)` → `Promise<Uint8Array | null>` — Check cache first; on miss, fetch from inner store, cache result, return.
- `has(key: string)` → `Promise<boolean>` — Delegate to inner store (no caching).
- `list(prefix: string)` → `AsyncIterable<string>` — Delegate to inner store (no caching).
- `clearCache()` → `Promise<void>` — Clear all cached entries for this store.

### CacheOptions

Configuration for creating a CachedStore.

**Attributes**:
- `cacheDir`: string — Required. Path to local cache directory.
- `ttl`: number | undefined — Optional. TTL in seconds.
- `storeId`: string | undefined — Optional. Override auto-derived store identity.

## Entity Relationships

```
CachedStore (1) ──wraps──> (1) Store (inner)
CachedStore (1) ──uses──> (1) DiskCache
DiskCache (1) ──reads/writes──> (N) Cached chunk files
```

## Validation Rules

- `cacheDir` MUST be a non-empty string.
- `ttl` if provided MUST be > 0.
- Cache directory is created on first write if it doesn't exist.
- Metadata keys are never cached (pattern match on key suffix).
