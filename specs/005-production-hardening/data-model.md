# Phase 1 Data Model: Production Hardening

This library has no persistent domain database; the "entities" are the public types and the internal value objects that carry the new behavior. Types below are the authoritative shapes the implementation must produce.

## Cache (abstraction)

Pluggable async key/value store for byte payloads. New plugin interface alongside `Store`/`Codec`.

| Member | Type | Notes |
|--------|------|-------|
| `get(key)` | `(key: string) => Promise<Uint8Array \| null>` | `null` on miss. Errors must be caught by callers and treated as miss (FR-011). |
| `set(key, value, ttlMs?)` | `(key: string, value: Uint8Array, ttlMs?: number) => Promise<void>` | `ttlMs` omitted ⇒ no expiry. Metadata path passes no TTL (immutable per path). |
| `has?(key)` | `(key: string) => Promise<boolean>` | Optional. |

**Implementations**:
- `InMemoryCache` — wraps existing `MemoryCache` byte-LRU; `ttlMs` honored via stored expiry timestamps.
- `RedisCache` — `./redis` subpath; backed by an `ioredis` client; `set` uses `PX` for `ttlMs`.

**Validation / rules**:
- Key scoping for metadata: effective key = `${storeId}:${logicalKey}` (FR-008).
- A throwing or unavailable implementation ⇒ fall back to underlying store (FR-011); never propagate as a read failure.

## StoreIdentity

Derived identifier used to scope cache keys.

| Rule | Behavior |
|------|----------|
| S3 store | `s3://${bucket}/${prefix}` |
| HTTP store | base URL |
| Unknown store | `null` (deterministic-or-null; replaces `store-${Date.now()}` fabrication) |

**Rules**:
- `deriveStoreId(store): string \| null`.
- When `metadataCache` is set, `storeId` absent, and `deriveStoreId` returns `null` ⇒ throw at open/construction (FR-008a).
- `CachedStore` (disk, per-pod) may still use a per-process fallback id when none derivable.

## ObservabilityHooks

Plain object of optional callbacks, registered per instance (FR-012, FR-012a). All payloads are typed; all invocations are wrapped so a throwing handler cannot break a read.

| Hook | Payload | Fired by |
|------|---------|----------|
| `onCacheHit?` | `{ tier: "memory" \| "disk" \| "shared"; key: string }` | loader (memory), CachedStore (disk), open path (shared) |
| `onCacheMiss?` | `{ tier: "memory" \| "disk" \| "shared"; key: string }` | same as above |
| `onStoreFetch?` | `{ key: string; bytes: number; latencyMs: number }` | HTTPStore, S3Store |
| `onRetry?` | `{ attempt: number; status?: number; error?: string }` | HTTPStore, S3Store (via retry policy) |
| `onChunkDecoded?` | `{ bytes: number; codec: string \| null; decodeMs: number }` | loader |
| `onInFlightBytes?` | `(current: number)` | ByteLimiter |
| `onMissingChunk?` | `{ key: string }` | loader |

**Rules**:
- Absent hook ⇒ no allocation, no dispatch (SC-004).
- Tier discriminates the three cache layers (FR-013).

## RetryConfig / RetryPolicy

Configuration governing store reads (FR-019–FR-024).

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `maxRetries` | `number` | `3` | Configurable via store options. |
| `timeoutMs` | `number` | HTTP `30000`; S3 new explicit timeout (same default) | Per-operation; aborts via `AbortSignal.timeout`. |

**Retryable classification**:
- Status codes: `429, 500, 502, 503, 504`.
- Network error codes: `ECONNRESET, ETIMEDOUT, EAI_AGAIN` (+ S3 SDK names `ThrottlingException`, `SlowDown`, `TimeoutError`).
- Non-retryable (e.g. 404 / `NoSuchKey`) ⇒ fail fast, do not consume attempts (FR-024).

**Backoff**: `fullJitterDelay(attempt, baseMs=100)` = uniform random in `[0, min(cap, baseMs · 2^attempt)]`; never negative, never zero-busy-loop, total bounded by `maxRetries` (edge case).

## MissingChunk handling

| Mode | Behavior |
|------|----------|
| default (`strict: false`) | fill region with fill value (default 0) **and** fire `onMissingChunk` (FR-025) |
| `strict: true` | throw `MissingChunkError` (no fill) (FR-026) |

**New error**: `MissingChunkError extends ZarrError` (exported), with the missing key in its message.

## Option-bag changes (public surface)

| Type | Added fields |
|------|--------------|
| `HTTPStoreOptions` | `maxRetries?: number`, `observability?: ObservabilityHooks` (timeout already exists) |
| `S3StoreOptions` | `maxRetries?: number`, `timeout?: number`, `observability?: ObservabilityHooks` |
| `CacheOptions` (CachedStore) | `observability?: ObservabilityHooks` (existing `maxSizeBytes?` now warns when absent) |
| `OpenOptions` (NEW; `open`/`openGroup`/`openArray`) | `metadataCache?: Cache`, `storeId?: string`, `observability?: ObservabilityHooks` |
| `ReadOptions` (array `get`) | `strict?: boolean`, `observability?: ObservabilityHooks` |

All new fields optional; omission preserves current behavior (FR-010, FR-027).

## State / lifecycle notes

- Metadata cache entries are write-once, no expiry (immutable-per-path datasets); no invalidation lifecycle needed.
- Disk cache eviction lifecycle (LRU by mtime over `maxSizeBytes`) is unchanged; only the unbounded-construction warning is added.
- In-flight byte budget transitions (`acquire`/`release` in `ByteLimiter`) optionally emit `onInFlightBytes` on change.
