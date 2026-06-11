# Phase 0 Research: Production Hardening

All four spec-level unknowns were resolved during `/speckit.clarify` (see spec.md → Clarifications). This document records the remaining design-level decisions, their rationale, and rejected alternatives. No open `NEEDS CLARIFICATION` items remain.

## D1. Cache abstraction shape (FR-005, FR-006)

**Decision**: Define a new **async** interface `Cache { get(key): Promise<Uint8Array|null>; set(key, val, ttlMs?): Promise<void>; has?(key): Promise<boolean> }` in `src/cache/cache.ts`. Provide an in-memory implementation `InMemoryCache implements Cache` that wraps the existing `MemoryCache` byte-LRU. Keep `MemoryCache` itself synchronous and unchanged.

**Rationale**: The shared metadata cache (Redis) is inherently async, so the interface must be async. The existing `MemoryCache.get` is synchronous and sits in the hot decoded-chunk path (`loader.ts` calls it synchronously); changing its signature to async would regress the chunk-read fast path and ripple through `array.ts`/`loader.ts`. FR-006 explicitly allows "be **or be adaptable to**" — an adapter satisfies it without disturbing the hot path. Byte payloads (`Uint8Array`) match what stores already return for `.zmetadata`/`.zattrs`, so no (de)serialization layer is needed in the interface.

**Alternatives considered**:
- *Make `MemoryCache` itself implement `Cache` (async get).* Rejected: regresses the synchronous decoded-chunk hot path and forces `await` into `loadChunks`.
- *Generic `Cache<T>` storing structured metadata objects.* Rejected: violates YAGNI; raw bytes are sufficient and keep the Redis adapter trivial (`SET`/`GET` of buffers).

## D2. Wiring the metadata cache through the open path (FR-007, FR-008)

**Decision**: Introduce an `OpenOptions { metadataCache?: Cache; storeId?: string; observability?: ObservabilityHooks }` accepted by `open`/`openGroup`/`openArray`. Metadata reads have **two seams**, and both must implement read-through:

1. **Root reads inside the open path** (`src/index.ts`): `open`/`openGroup`/`openArray` and their helpers read `.zarray`/`.zgroup`/`.zattrs` — and `.zmetadata` via `loadConsolidatedMetadata` — with **direct `store.get(...)` calls** that do NOT go through `ZarrGroup.getMeta`. A shared read-through helper (e.g. `readMeta(store, key, opts)` in `src/index.ts` or a small module) wraps every one of these call sites.
2. **Child reads in `ZarrGroup`** (`src/group.ts:163` `getMeta`, plus `loadAttrs`): `ZarrGroup` carries `metadataCache`, `storeId`, and `observability` (propagated from `OpenOptions` at construction) so `getArray`/`getGroup`/child metadata reads go through the same helper.

Metadata cache key = `${storeId}:${key}`. Cache read-through order on the metadata path: shared `Cache` → store fetch → populate cache (no TTL, since datasets are immutable per path).

**Rationale**: `ZarrGroup.getMeta` only covers **child** metadata; the first `.zmetadata`/`.zgroup`/`.zarray` read of any open happens in `src/index.ts:62-191` outside it. Without read-through at that seam, the root metadata is fetched from the store on every open and **SC-002 (100% of post-first metadata reads served from cache) fails**. Threading one optional options bag is minimal and backward-compatible (omitted = today's behavior, FR-002/FR-010). Key scoping by store identity prevents cross-dataset collisions (FR-008) and is also correct across pods because two pods opening the same `s3://bucket/path` derive the same id.

**Alternatives considered**:
- *Wrap the `Store` in a metadata-caching decorator (like `CachedStore`).* Rejected: `CachedStore` deliberately excludes metadata keys, and a decorator can't distinguish "open-time metadata read" from arbitrary `get`; the open path is the precise seam.
- *Global cache registry.* Rejected by clarification Q2 (per-instance).

## D3. Store identity: deterministic-or-null (FR-008a)

**Decision**: **Refactor** the existing `deriveStoreId` (today in `src/cache/cached-store.ts:107-120`) into `src/store/identity.ts` as `deriveStoreId(store): string | null` — this is a behavior change, not a pure extraction. Return a stable id for recognized stores (`s3://bucket/prefix`, HTTP base URL) and **`null`** when identity cannot be derived deterministically (replacing today's `store-${Date.now()}` fabrication). When a `metadataCache` is supplied and both `options.storeId` is absent and `deriveStoreId` returns `null`, throw at construction/open time. The existing `CachedStore` keeps a non-shared, per-process fallback (disk cache is per-pod, so a per-process id is acceptable there) but reuses the same deterministic derivation.

**Detection fields (verified against the real stores)**: `S3Store` exposes `bucket`/`prefix`; `HTTPStore` exposes `baseUrl` (`src/store/http.ts:10` — private in TS but present at runtime, which is what the duck-typed check reads). So S3 and HTTP identities derive automatically and never hit the FR-008a fail-fast; only unrecognized stores (filesystem, in-memory, custom) require an explicit `storeId`.

**Operational note (cache-bust)**: changing the `CachedStore` fallback id (from `store-${Date.now()}` to the new per-process fallback) changes the on-disk cache identity for unrecognized stores, invalidating those disk caches on deploy. The current fallback is already per-process non-deterministic (a fresh `Date.now()` per construction), so those caches were never reusable across restarts — but the change MUST still be recorded in the CHANGELOG (see D9). S3/HTTP-backed disk caches are unaffected (same deterministic ids).

**Rationale**: A non-deterministic id silently breaks cross-pod cache sharing (every pod writes different keys → permanent miss) — exactly the silent-failure class this hardening targets. Failing fast forces the consumer to pass an explicit `storeId`. Disk cache is local to a pod, so its non-deterministic fallback is harmless and need not break.

**Alternatives considered**:
- *Warn and continue with the fallback.* Rejected by clarification Q4 (fail fast).
- *Content-hash derivation.* Rejected: requires an extra metadata fetch and adds complexity (YAGNI).

## D4. Observability mechanism and threading (FR-012, FR-012a, FR-013–FR-018)

**Decision**: `ObservabilityHooks` is a plain object of optional typed callbacks in `src/observability.ts`. A `safeInvoke(fn, arg)` helper wraps the call in try/catch so a throwing handler cannot break a read (edge case). **Mandatory call-site pattern** — the existence guard comes FIRST, and the payload object is only constructed inside it:

```ts
if (hooks?.onChunkDecoded) {
  safeInvoke(hooks.onChunkDecoded, { bytes, codec, decodeMs });
}
```

Calling `safeInvoke(hooks?.onChunkDecoded, {...})` unconditionally is forbidden: it allocates the payload before checking whether the hook exists, which violates the SC-004 zero-overhead guarantee in the per-chunk hot loop (~128 concurrent chunks). `safeInvoke` exists only for throw-isolation, not as the dispatch guard. Registration is per-instance: the same hooks object is passed to store options, `CacheOptions`, and `OpenOptions`/`ReadOptions`; each layer fires the events it owns:
- Stores (`http.ts`/`s3.ts`): `onStoreFetch`, `onRetry`.
- `CachedStore`: disk `onCacheHit`/`onCacheMiss` (tier `"disk"`).
- Metadata open path: shared `onCacheHit`/`onCacheMiss` (tier `"shared"`).
- `loader.ts`: memory `onCacheHit`/`onCacheMiss` (tier `"memory"`), `onChunkDecoded`, `onMissingChunk`.
- `limiter.ts`: `onInFlightBytes` (optional callback passed into `ByteLimiter`).

**Rationale**: Plain object = zero allocation/dispatch when unset (guard `if (hooks?.onX) ...`), full per-event typing, and no `EventEmitter` listener-leak/unhandled-`error` footguns in a per-chunk hot loop (clarification Q1). Per-instance registration matches how dependencies are already injected at construction (clarification Q2) and keeps counters isolated per dataset.

**Alternatives considered**: `EventEmitter`, global registry, per-read parameter — all rejected by clarifications Q1/Q2.

## D5. Network resilience: shared retry policy (FR-019–FR-024)

**Decision**: Add `src/store/retry.ts` exposing: a retryable-status set `{429,500,502,503,504}`; retryable network-error codes `{ECONNRESET,ETIMEDOUT,EAI_AGAIN}`; a `fullJitterDelay(attempt, baseMs)` = `random in [0, min(cap, baseMs·2^attempt)]`; and a `RetryConfig { maxRetries; timeoutMs }` with defaults preserving current behavior (`maxRetries: 3`, HTTP `timeoutMs: 30000`). Both `HTTPStore` and `S3Store` consume it. HTTP detects network-error codes via `err.cause?.code` (undici sets this on fetch failures). S3 gets an explicit timeout by passing `abortSignal: AbortSignal.timeout(timeoutMs)` to `client.send(...)`; its `isRetryable` is widened to the new status set and SDK error names (`ThrottlingException`/`SlowDown`/`TimeoutError`), plus network codes. `onRetry({attempt, status})` fires before each backoff.

**Rationale**: One policy module removes the current HTTP/S3 retry duplication and guarantees identical semantics. Full jitter (`[0, k]`, not `k/2 + jitter`) is the AWS-recommended form for de-correlating ~128 concurrent retriers hammering S3 throttling. Using `AbortSignal.timeout` mirrors the existing HTTP timeout for S3 parity. `Math.random()` is fine at runtime (only Workflow scripts forbid it).

**Alternatives considered**:
- *Equal/decorrelated jitter.* Full jitter chosen as spec says "full jitter" explicitly (FR-021) and it minimizes contention.
- *Per-store bespoke retry.* Rejected: duplication and drift risk.

## D6. Missing-chunk handling (FR-025–FR-027)

**Decision**: Add `MissingChunkError extends ZarrError` to `errors.ts` (exported). Thread `strict?: boolean` and `observability?` into `LoadChunksContext` (and surface `strict` via `ReadOptions`). In `loader.ts`, both missing paths (full `store.get` → null, and `getRange` → null) fire `onMissingChunk({key})`; if `strict`, throw `MissingChunkError` instead of filling zeros. Default (`strict` false) preserves zero-fill behavior.

**Rationale**: Centralizes both miss sites in the loader where fill currently happens. New error subclass lets consumers `instanceof`-discriminate. Backward-compatible by default (FR-027).

## D7. Redis adapter packaging (FR-009, FR-010)

**Decision**: `src/redis/index.ts` exports `RedisCache implements Cache`, constructed from a consumer-provided `ioredis` instance (or connection options) and dynamically `import("ioredis")` — mirroring `loadS3SDK()` in `s3.ts`. `package.json`: add `exports["./redis"]` (types/import/require), add `ioredis` to `peerDependencies` + `peerDependenciesMeta.ioredis.optional = true` and to `devDependencies`. The `tsc` build already compiles `src/redis/**`; `postbuild-cjs.mjs` produces the CJS variant. Base package imports nothing Redis unless `./redis` is used (FR-010).

**Rationale**: Identical, proven pattern to the optional `@aws-sdk/client-s3` peer dependency (constitution Technical Constraints: cloud SDKs MUST be peer deps). Subpath export keeps the base bundle dependency-free (SC-003).

**Alternatives considered**:
- *`node-redis` (v4).* Rejected by clarification Q3 (ioredis: better cluster/sentinel for EKS, dominant in NestJS).
- *Bundle a Redis client.* Rejected: violates the peer-dependency constraint and SC-003.

## D8. Disk-cache unbounded warning (FR-001)

**Decision**: In `CachedStore` constructor, when `maxSizeBytes` is undefined and `skipLocal` is false, emit a one-time `console.warn` describing the unbounded-growth risk and how to bound it. Keep `maxSizeBytes` optional (no breaking change); making it mandatory/defaulted is deferred to a future major (spec Assumption). Existing non-positive rejection in `DiskCache` is retained (FR-003).

**Rationale**: "Discoverable warning" (spec) without a breaking API change, consistent with the existing `largeReadWarningBytes` `console.warn` convention in `array.ts`. The defined `ObservabilityHooks` set has no unbounded-cache event, so `console.warn` is the surface; documented in README (FR-004).

## D9. Versioning & changelog

**Decision**: Bump `0.4.0` → `0.5.0` (minor). Add a changeset and CHANGELOG entry covering: new `Cache` interface + `InMemoryCache`, `@i4sea/zarr-node/redis` adapter, observability hooks, expanded retry/jitter/timeout config, missing-chunk hook + strict mode, the unbounded disk-cache warning (noting it is a new warning, not a behavior break), and the **disk-cache identity change for unrecognized stores** (D3 cache-bust note: fallback id is no longer `store-${Date.now()}`; existing disk caches under fallback ids are invalidated on deploy — they were already non-reusable across restarts).

**Rationale**: All changes are additive or pre-1.0-acceptable behavior refinements (constitution VI). Minor bump signals new capabilities.
