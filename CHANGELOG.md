# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-06-15

Integrated dataset-session API: a single place that owns ALL caching so consumers stop hand-wiring `CachedStore` + `openGroup` + `MemoryCache` + coordinate caches. Aimed at cross-region S3 serving, where every byte is expensive and low-traffic pods keep caches cold.

### Added

- **`ZarrDatasetRegistry`** (root export). Build one per process; `open(id, storeFactory)` returns a cached `ManagedDataset`. Owns: handle reuse (LRU `maxDatasets`, default 32, with thundering-herd dedup), metadata cache (passed through to `openGroup`, scoped by `id`), an optional on-disk chunk cache (`disk: { cacheDir, maxSizeBytes, ttl? }` → `CachedStore`), a per-dataset decoded-chunk `MemoryCache` (`chunkMemoryCacheBytes`), and a shared decoded-array cache (`coordinateCache`). `storeFactory` keeps the registry store-agnostic — the caller builds the backend `Store` (e.g. a fresh `S3Store`).
- **`ManagedDataset`**. `read(name, selection, opts)` applies the per-dataset decoded-chunk memory cache + observability automatically (callers can't pass `memoryCache` — it stays dataset-scoped so chunk keys can't collide across datasets). `decodedArray(name, { cacheKey, ttlMs })` returns a small array's DECODED `Float64Array` from L1 (per handle) → L2 (shared `coordinateCache`) before the store; with a run_time-invariant `cacheKey` (a domain key), coordinate arrays are read **once per domain** and reused across every run_time and pod — eliminating the multi-second cold-open coordinate re-read on cross-region stores.
- The `open`/`openGroup`/`openArray` functions moved to `src/open.ts` (re-exported unchanged from the root — no API change).

## [0.6.0] — 2026-06-12

S3 latency reduction. All additions are opt-in or strictly improve defaults.

### Added

- **S3 connection pooling.** `S3StoreOptions` gains `maxSockets` (default **128**, keep-alive on), `keepAlive`, `connectionTimeoutMs`, and a `requestHandler` escape hatch. The store now builds a `NodeHttpHandler` with a keep-alive `https.Agent` so many-chunk reads aren't capped at the SDK's ~50-socket default — raise the read `concurrency` and keep `maxSockets >= concurrency` to collapse a read into fewer waves. Degrades gracefully to the SDK default handler if `@smithy/node-http-handler` (new optional dependency) is unavailable.
- **S3 connection prewarming.** `S3Store.prewarm()` opens a pooled TLS connection ahead of the first read (best-effort, swallows errors). `S3StoreOptions.warmOnCreate` triggers it fire-and-forget on construction.
- **`GridIndex` spatial helper** (`@i4sea/zarr-node/spatial`). Resolves nearest `(i, j)` for a (lat, lon) on a 2D curvilinear grid. `fromCoordinates`/`fromGroup` build it once (queries are pure CPU); `loadCached(group, { cache })` adds an L1 (process) + L2 (shared `Cache`/Redis) layer so only the first pod pays the coordinate fetch — keyed per *domain* (`source_model`/`experiment`/`grid_id` + shape) so every run of the same grid shares one entry, with `gridKey` override and optional `verifyGrid` content fingerprint. `toBytes`/`fromBytes` give a compact binary snapshot for the cache.
- README: S3 connection-pooling/prewarming guidance and a "Spatial lookups (GridIndex)" section.

## [0.5.0] — 2026-06-10

Production hardening release. All new capabilities are opt-in; omitting the new options preserves current behavior.

### Added

- **Shared, pluggable metadata cache.** `open()` / `openGroup()` / `openArray()` accept `OpenOptions { metadataCache?, storeId?, observability? }`. Metadata reads (`.zmetadata`, `.zarray`, `.zgroup`, `.zattrs` — including child metadata via `ZarrGroup`) go through a read-through async `Cache` interface, cached without TTL. Ships `InMemoryCache` (root export) and `RedisCache` (`@i4sea/zarr-node/redis` subpath export, backed by the new optional `ioredis` peer dependency — accepts a pre-configured client or a connection URL). Keys are scoped `${storeId}:${key}`; the id derives automatically for `S3Store`/`HTTPStore`, and supplying `metadataCache` for a store with no derivable identity and no explicit `storeId` throws fast. Cache errors/unavailability fall back to the store.
- **Observability hooks** (`ObservabilityHooks`, per-instance via option bags on stores, `CachedStore`, `open*`, and reads): `onCacheHit`/`onCacheMiss` (tiers `memory`/`disk`/`shared`), `onStoreFetch` (key/bytes/latencyMs), `onRetry`, `onChunkDecoded` (bytes/codec/decodeMs), `onInFlightBytes`, `onMissingChunk`. Throwing or rejecting handlers are swallowed; with no hooks registered there is zero dispatch/allocation overhead.
- **Network resilience config.** Retryable conditions broadened to HTTP `429/500/502/503/504`, network codes `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`, and S3 SDK throttling errors, with full-jitter exponential backoff. `maxRetries` (default 3) is configurable on `HTTPStore` and `S3Store`; `S3Store` gains an explicit per-operation `timeout` (default 30000 ms) that aborts the in-flight request.
- **Missing-chunk observability and strict mode.** A chunk absent from the store fires `onMissingChunk({ key })` and still zero-fills by default; `array.get(selection, { strict: true })` throws the new `MissingChunkError` instead of fabricating zeros.
- **Unbounded disk-cache warning.** Constructing a `CachedStore` without `maxSizeBytes` now logs a one-time `console.warn` naming the unbounded-growth risk and how to bound it. This is a **new warning, not a behavior break** — caching behavior with or without a limit is unchanged.
- README: peak-memory formula (`peakPerChunk = chunkBytes × (decodeFactor + byteSwapFactor)`) and guidance for deriving `maxInFlightBytes` from a pod RAM limit; usage docs for the Redis metadata cache and observability hooks; disk-cache eviction and sizing guidance.

### Changed

- **Disk-cache identity for unrecognized stores (operational cache-bust).** `deriveStoreId` moved to `src/store/identity.ts` and now returns a deterministic id or `null` instead of fabricating `store-${Date.now()}`. `CachedStore` keeps a per-process fallback id for stores without a derivable identity, but its format changed, so existing on-disk cache entries under old fallback ids are orphaned on deploy (they were already non-reusable across restarts, since the old fallback was also per-construction). S3/HTTP-backed disk caches are unaffected (same deterministic ids). Pass an explicit `storeId` to `CachedStore` for a stable, restart-surviving cache identity.

## [0.4.0] — 2026-06-02

### Added

- **`maxInFlightBytes` read option** (default 256 MiB). Reads now bound the *decoded bytes held in flight* rather than only the chunk count, so peak memory stays predictable regardless of `concurrency` or chunk size. On arrays with large (e.g. compressed WRF) chunks the effective decode parallelism drops automatically. Exposed as `DEFAULT_MAX_IN_FLIGHT_BYTES`.
- **`largeReadWarningBytes` read option** (default 512 MiB). A `get()` whose materialized output would exceed this threshold logs a one-line `console.warn`. Set to `Infinity` to silence. Exposed as `DEFAULT_LARGE_READ_WARNING_BYTES`.

### Changed

- **Chunks are now streamed into the output as they decode instead of being accumulated.** Previously every selected chunk was decoded and retained until the whole selection finished, so a point-slice over a full axis of a compressed array held *all* covered chunks at once — the root of an observed OOM. Decoded buffers are now copied into the output on arrival and released immediately, bounding the live footprint to roughly `maxInFlightBytes` plus the output. Read results are unchanged.
- **`ZarrGroup.readMultiple` now bounds the *combined* in-flight memory of all arrays through one shared `maxInFlightBytes` budget**, instead of each array read allocating an independent ceiling. This caps the `arrays × concurrency × chunkSize` blow-up when reading many compressed arrays at once. (The previous "shared concurrency pool" was not in fact shared — each array ran its own pool.)

### Notes

- Compressed point-slices still pay full-chunk cost: selecting one `(lat, lon)` from a `blosc`/`gzip`/`zlib` array decodes the entire chunk covering that point (partial decode is not possible for these codecs). `maxInFlightBytes` bounds how many such decodes run concurrently; a `MemoryCache` avoids re-decoding across repeated reads.
- `DEFAULT_CONCURRENCY` remains 50 — the byte budget, not a lower count, is what makes the large-chunk case safe by default.

## [0.2.0] — 2026-05-16

### Added

- Dual ESM/CJS package. `require('@i4sea/zarr-node')` now works in CommonJS consumers (e.g. NestJS services compiled to CJS), in addition to `import`. The package now ships a second build under `dist/cjs/` with a per-folder `package.json` declaring `type: commonjs`, and the root `exports` map gains `require`/`default` conditions.
- Interop smoke tests (`npm run test:cjs`, `npm run test:esm`) gating release via `prepublishOnly`. Both exercise the Blosc lazy-load path end-to-end so the `ERR_REQUIRE_ESM` regression cannot ship undetected.

### Changed

- **Breaking**: `codecRegistry.get(config)` is now async and returns `Promise<Codec>`. Codec factories may return either `Codec` or `Promise<Codec>`. Built-in `zlib`/`gzip` codecs are unchanged in behavior; Blosc is now lazy-loaded on first use via dynamic `import()`. This avoids `ERR_REQUIRE_ESM` against the ESM-only `numcodecs` package when zarr-node is loaded from a CommonJS consumer.
- **Breaking**: `ZarrArray` constructor takes an additional `codec: Codec | null` parameter. The `open()` / `openArray()` / `openGroup()` / `ZarrGroup.getArray()` helpers resolve the codec for you, so the change is transparent to typical consumers — only code that constructs `ZarrArray` directly is affected.

## [0.1.0]

### Added

- Zarr v2 array reader with `FileSystemStore`, `HTTPStore`, and `S3Store` backends
- Consolidated metadata (`.zmetadata`) support for fast group discovery
- Disk chunk cache with thundering herd protection and LRU eviction
- Built-in Blosc codec (lz4, zstd, zlib, snappy) with zero-config auto-registration
- In-memory LRU chunk cache for sub-millisecond repeated reads
- Multi-array reads with shared concurrency pool (`readMultiple`)
- Byte-range requests for partial chunk fetches on all store backends
- Reference filesystem (kerchunk) support via `ReferenceStore`
- `Dataset` class with xarray-style label-based coordinate selection (`sel()`)
