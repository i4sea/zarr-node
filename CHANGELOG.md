# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.2] — 2026-07-14

### Fixed

- **Polygon reader accepts `[time, 1, lat, lon]` singleton-depth arrays (issue #18).** `readPolygon` / `resolvePolygonCells` previously required the array rank to match the layout exactly (`2d`/`1d` ⇒ rank 3, `npoints` ⇒ rank 2), so hydrodynamic current fields (`current_vel`, `current_dir`) from hidro/Delft3D datasets — which carry a degenerate depth dim of size 1, shape `[time, 1, lat, lon]` — could not stream through the polygon reader at all and were dropped from area-aggregated reads. `assertArrayRank` now accepts `rank = expected + k` when the `k` "middle" dims (between the leading time axis and the trailing spatial dims) are **all size 1**, and the per-step read selects index `0` for each of them (collapsing the dim), so the block stays C-order `[rows, cols]` and results are identical to the equivalent rank-3 array. More than one singleton middle dim (`[time, 1, 1, lat, lon]`) works too. A **non**-singleton middle dim (a genuine multi-level axis, e.g. a depth profile) still throws `SliceError`, now with a message stating the size-1 rule — collapsing it would need an explicit level selection, which this reader does not offer. This mirrors the point-read path's existing rank-4 singleton handling; `npoints` (rank 2) and plain rank-3 behavior are unchanged.

## [0.9.1] — 2026-07-13

### Changed

- **Polygon reader 1-D layout uses binary search.** `axisRange` (the `{ kind: "1d" }` bbox resolver) now locates the in-envelope index span with a direction-aware binary search (O(log n)) on the monotonic axis instead of a full linear scan, matching the approach stated in the spec. Result is unchanged for ascending and descending axes.
- **`maxCells` stride computed by binary search.** `computeStride` binary-searches the smallest fitting stride (the fit predicate is monotone in the stride) instead of incrementing one at a time — O(log) rather than O(max(rows, cols)) when a large bounding box overruns a small `maxCells`.
- **Array-rank validation runs before the selection scan.** `readPolygon` / `resolvePolygonCells` now assert the array rank matches the chosen `spatialLayout` immediately after resolving the layout, before the (potentially expensive) bounding-box scan and mask gather — a rank/layout mismatch fails fast instead of doing wasted work on large grids.

### Fixed

- **Docs:** the quickstart's `MemoryCache` example now uses the `{ maxBytes }` options object (was a bare number); corrected a misleading cost comment on the 2-D curvilinear envelope scan.

## [0.9.0] — 2026-07-13

### Added

- **Polygon spatial reader (`@i4sea/zarr-node/spatial`).** `readPolygon(arr, opts)` streams, one time step at a time, only the cells geometrically inside a lat/lon polygon of a `[time, ...spatial]` array — a ray-cast, concave-correct mask over the polygon's bounding box — yielding a `Float64Array` of the in-polygon values per step in row-major order. Each step is read as a bounding-box block sharing one `MemoryCache`, so every bbox-overlapping chunk is fetched/decompressed at most once (chunks typically span the full time axis and are reused across steps) and peak working memory stays bounded to ~one time slice regardless of the time extent. `resolvePolygonCells(arr, opts)` returns the time-invariant selection (`cells` with per-cell `i/j` + `lat/lon`, the half-open `bbox`, and the applied `stride`) without reading values; `cells[k]` aligns with `step.values[k]`. Three coordinate layouts: `{ kind: "1d", lat, lon }` (monotonic axes, binary search), `{ kind: "2d", grid }` (curvilinear `GridIndex`), and `{ kind: "npoints", lat, lon }` (unstructured points). An optional `maxCells` budget triggers a clamped uniform spatial stride (reported as `selection.stride`; no default cap, and a non-empty polygon never sub-samples to zero). Ring closure is implicit (closed == unclosed), invalid input throws `SliceError`, an empty selection completes cleanly, and `readOptions` (concurrency / maxInFlightBytes / observability / memoryCache) are forwarded to the per-step reads. Additive only — the point-read path is untouched.
- **`GridIndex.latAt(i, j)` / `GridIndex.lonAt(i, j)`** — per-cell coordinate accessors on the curvilinear grid (used by the polygon reader's 2-D layout).

## [0.8.0] — 2026-07-04

### Fixed

- **Dataset eviction now tears down its caches (issue #12).** `ZarrDatasetRegistry` evicting a handle past `maxDatasets` previously dropped only the `Map` reference, leaking the disk and shared-metadata tiers (both keyed by dataset `id`). With content-versioned ids (e.g. `s3Path@<etag>`), every re-ingestion left a permanent disk directory and a permanent set of Redis `.zmetadata`/`.zarray` keys — unbounded growth. Eviction (and `clear()`) now release the per-dataset decoded-chunk `MemoryCache` and decoded-array heap caches synchronously (freeing heap deterministically rather than at GC's discretion) and best-effort remove the evicted id's disk-cache directory, via a single `ManagedDataset.dispose()` that owns the handle's full teardown. `ZarrDatasetRegistry.clear()` now returns a `Promise<void>` that settles once disk teardown completes (previously `void`; ignoring it is still safe — heap is freed synchronously) and drains in-flight opens first, so a handle still being built when `clear()` is called can't leak a directory afterward.
- **Eviction no longer races a re-open of the same id.** A dataset's disk directory is derived from its id (`sha256(id)`), so re-opening a just-evicted id targets the same directory. `open()` now waits for that id's in-flight teardown before rebuilding, and `CachedStore.clearCache()` marks the store closed, drains in-flight reads, then removes the directory — so a late `fetchAndCache` write can't resurrect the just-deleted dir and a re-open can't have its freshly-cached chunks deleted by the previous teardown's `rm`.

### Changed

- **`ZarrDatasetRegistry.clear()` now returns `Promise<void>` (was `void`).** Source-compatible if you ignore the result — heap is still freed synchronously. But if you rely on the disk directories being gone after the call (e.g. a shutdown that then unmounts the cache volume), you must now `await reg.clear()`; disk teardown completes asynchronously. Note a synchronous `process.on("exit", () => reg.clear())` handler cannot await it and will not finish disk teardown before exit — use `"beforeExit"` (which allows async work) or await `clear()` in your shutdown sequence instead.

### Added

- **`metadataCacheTtlMs`** on `ZarrDatasetRegistryOptions` (and the underlying `OpenOptions`), applied to shared-metadata (`metadataCache`) writes. Omit ⇒ no expiry (unchanged). Set it alongside content-versioned ids so obsolete versions' metadata keys expire from a shared cache (e.g. Redis) instead of accumulating forever — the shared cache is process-external and can't be enumerated by id on eviction, so a TTL is what bounds its growth. The TTL is (re)stamped on each cache miss (not refreshed on hits), so size it above your re-ingestion cadence; omitting it leaks content-versioned metadata even though heap and disk are reclaimed.
- **`ZarrDatasetRegistry.whenTornDown()`** resolves once every eviction-triggered disk teardown so far has settled — a hook for graceful shutdown (unmounting the cache volume) or tests asserting on directory contents, since eviction runs teardown in the background rather than blocking `open()`.

## [0.7.2] — 2026-06-16

### Added

- **`Store.head(key)`** (optional) + `S3Store.head` implementation, returning `{ etag, lastModified, size } | null` (`null` for an absent key; other failures throw, mirroring `has()`'s retry/404 handling). Intended as a cheap content-version probe: a changed ETag means the object was overwritten in place, so consumers can fold it into a cache key to invalidate cached state on re-ingestion. This closes the gap where a dataset re-written at the same path (same `open()` id) kept serving stale handle/metadata/coordinate state — the registry assumes immutability per id, which an overwrite violates.
- **`DecodePool`** (root export) for off-thread chunk decoding. Blosc decode is synchronous CPU work (runs on WASM), so a large chunk blocks the event loop for the whole decode, degrading the latency of every other request in a shared API pod. Pass a `DecodePool` via the new `decodeWorkers` read option: chunks whose compressor is offloadable (currently Blosc) and whose *compressed* size is at least `minBytes` decode on a worker thread; everything else decodes inline as before. Create one pool per process, reuse it across reads, and call `terminate()` on shutdown. See the README ("Offloading decompression") and `examples/benchmark-decode-workers.ts` for A/B calibration of `minBytes`.

## [0.7.1] — 2026-06-15

### Fixed

- **Coordinate cache (L2) corrupted decoded arrays served from a Node `Buffer`.** `bytesToFloat64` rebuilt the `Float64Array` with `bytes.slice(0, n).buffer` + `new Float64Array(buffer, 0, …)`, which reads from offset 0 of the underlying `ArrayBuffer`. For a Node `Buffer` (e.g. ioredis `getBuffer`, which carves Buffers from a shared pool), `slice` returns a VIEW with a non-zero `byteOffset`, so the decode read the wrong bytes — yielding shifted/garbage values for any coordinate or time array served from the shared `coordinateCache`. A corrupted, non-ascending time axis then collapsed downstream time-window binary searches (every point folded onto one timestamp). Now copies the view's own byte range via `ArrayBuffer.prototype.slice`, honoring `byteOffset`. Regression test added covering a pooled-`Buffer` round-trip.

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
