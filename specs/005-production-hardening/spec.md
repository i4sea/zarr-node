# Feature Specification: Production Hardening

**Feature Branch**: `005-production-hardening`  
**Created**: 2026-06-09  
**Status**: Draft  
**Input**: User description: "Spec based on issue #3 — production hardening of zarr-node for the nautilus-api (NestJS) workload: bounded-memory disk cache defaults, pluggable Cache interface with Redis adapter, observability hooks, network resilience, missing-chunk handling, and docs. Evaluate excluding P3 (worker-threads offload)."

## Context

`zarr-node` is consumed in production by `nautilus-api` (NestJS) running across 5 EKS pod replicas (`requests 400m/512Mi`, `limits 800m/1Gi`, CPU-based HPA). Each pod serves many models/datasets per day, on demand per HTTP request, reading from `s3://bucket/<path>.zarr` datasets that are **immutable per path** (each model run is a new path). Worst-case per-request fan-out is `models(4) × vars(4) × chunks(8)` ≈ **128 concurrent chunk reads**.

This specification covers **library hardening only**. Consumer-side changes live in a separate issue (`i4sea/i4sea-aurora-ui#794`).

**Scope decision on P3 (decompression on the event loop / worker-threads offload)**: P3 is **excluded** from this specification. The source issue gates P3 on a profiling step that has not yet been performed (*"confirm if production datasets use blosc/zstd with large chunks"*) and frames the offload as conditional (*"if it justifies, evaluate offloading"*), and the issue's own suggested ordering defers it (*"P3 — workers, if profiling demands"*). A `worker_threads` pool is also an architectural change of a different class than the targeted hardening below, and its requirements cannot be made concrete or testable until profiling defines them. P3 should become its own specification once profiling data exists.

## Clarifications

### Session 2026-06-09

- Q: Observability delivery mechanism — plain callbacks object, EventEmitter, or both? → A: Plain handlers object — optional typed callbacks (e.g. `{ onCacheHit?, onStoreFetch?, ... }`) passed via options; each fired directly only if present. No EventEmitter.
- Q: Where are observability handlers registered — per instance, per read call, global, or hybrid? → A: Per instance — handlers passed in options at store/group construction and propagated internally to caches/loader. No global registry, no per-read parameter.
- Q: Which client library backs the Redis shared-cache adapter — ioredis, node-redis, or client-agnostic? → A: `ioredis`, declared as an optional peer dependency of the adapter (subpath export).
- Q: How to handle store identity for the shared cache when it can't be derived deterministically (current `store-${Date.now()}` fallback is non-deterministic across pods)? → A: Require an explicit `storeId` when a shared cache is used and the store has no deterministic identity; fail fast at construction instead of using the non-deterministic fallback.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Disk cache cannot silently grow unbounded (Priority: P1)

A library consumer enables the on-disk chunk cache but forgets to set a maximum size. Today the cache grows without limit in `/tmp`, eventually causing disk-pressure on the pod. As a library consumer, I want the library to make the bounded-vs-unbounded behavior impossible to overlook, so an operational mistake does not take down a pod.

**Why this priority**: This is the highest-severity production risk in the issue (P0): it can degrade or crash a running pod. It is also self-contained and delivers value on its own.

**Independent Test**: Construct a cached store without a size limit and confirm the library surfaces a discoverable signal (warning/notification) about unbounded growth; construct one with a size limit and confirm eviction keeps total cache size at or below the limit. No other story needs to be implemented for this to be testable and valuable.

**Acceptance Scenarios**:

1. **Given** a cached store is constructed without a maximum cache size, **When** the store is created, **Then** the library emits a discoverable warning that the cache is unbounded and at risk of unbounded disk growth.
2. **Given** a cached store is constructed with a maximum cache size, **When** cached data exceeds that size, **Then** the oldest cached entries are evicted so total cache size stays at or below the configured maximum.
3. **Given** a consumer reads the project documentation, **When** they look for cache behavior, **Then** eviction behavior, the unbounded-growth risk, and how to size the cache are documented.

---

### User Story 2 - Shared, pluggable metadata cache avoids repeated metadata fetches (Priority: P1)

Metadata (`.zmetadata`/`.zarray`/`.zattrs`/`.zgroup`) is deliberately excluded from the disk chunk cache, so every pod re-fetches it from S3 — including reading whole `time`/`lat`/`lon` axes — on each request. Because datasets are immutable per path, this metadata can be cached indefinitely in a shared store (e.g. Redis). As a library consumer, I want to plug in a shared cache for metadata so that repeated `openGroup`/axis reads across pods avoid redundant S3 round-trips.

**Why this priority**: Directly reduces per-request latency and S3 load across all pods. Depends on a stable, documented cache abstraction, which is itself reusable for in-memory caching.

**Independent Test**: Supply an in-memory implementation of the cache abstraction on the metadata path, open the same group twice, and confirm the second open is served from the cache without a second metadata fetch from the underlying store. Confirm the library still works with no cache supplied.

**Acceptance Scenarios**:

1. **Given** a shared cache implementing the library's cache abstraction is supplied on the metadata path, **When** the same metadata key is requested twice, **Then** the second request is served from the cache and does not reach the underlying store.
2. **Given** no shared cache is supplied, **When** metadata is requested, **Then** the library behaves exactly as today (fetches from the underlying store) with no errors.
3. **Given** the optional shared-cache adapter's third-party dependency is not installed, **When** the consumer uses the library without that adapter, **Then** the library loads and operates normally and does not require the dependency.
4. **Given** two different datasets (different paths), **When** their metadata is cached, **Then** their cache entries do not collide (each is scoped to its store identity).

---

### User Story 3 - Observability into cache, fetch, retry, and decode behavior (Priority: P2)

The library exposes no metrics today, so operators cannot see cache hit rates, fetch latency, retries, or decode cost in production. As a library consumer, I want optional callbacks for key internal events so I can wire them into my own metrics/logging stack without the library depending on any specific telemetry vendor.

**Why this priority**: High operational value but not a correctness or stability fix; it builds on the cache and store paths touched by the other stories.

**Independent Test**: Register callbacks, perform reads that hit and miss the cache, trigger a retry and a missing chunk, and confirm each corresponding callback fires with the documented payload. Confirm that omitting callbacks changes nothing.

**Acceptance Scenarios**:

1. **Given** observability callbacks are registered, **When** a read hits or misses a cache tier (memory/disk/shared), **Then** the corresponding hit/miss callback fires identifying the tier.
2. **Given** callbacks are registered, **When** the library fetches from the underlying store, **Then** a fetch callback fires with key, byte count, and latency.
3. **Given** callbacks are registered, **When** a request is retried, **Then** a retry callback fires with attempt number and the triggering status/error.
4. **Given** callbacks are registered, **When** a chunk is decoded, **Then** a decode callback fires with byte count, codec, and decode duration.
5. **Given** callbacks are registered, **When** the in-flight byte budget changes, **Then** an in-flight-bytes callback reports the current value.
6. **Given** no callbacks are registered, **When** any of the above events occur, **Then** behavior and performance are unaffected.

---

### User Story 4 - Network resilience under EKS conditions (Priority: P2)

Under EKS (NAT/IRSA/cross-region us-east-2→us-east-1) the workload sees transient network errors and 5xx responses, especially with 128 concurrent reads hitting S3 throttling. Today retries cover only `429/503`, use deterministic exponential backoff, and the S3 path has no explicit per-operation timeout. As a library consumer, I want broader retry coverage, jittered backoff, explicit timeouts, and configurable retry/timeout settings so transient failures recover without amplifying load.

**Why this priority**: Improves reliability of every read under production conditions; important but lower severity than the unbounded-disk risk.

**Independent Test**: Simulate transient `500/502/504` and network errors (`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`) from a store and confirm the operation retries and ultimately succeeds; confirm backoff includes jitter; confirm an S3 operation aborts after its configured timeout; confirm retry count and timeout are configurable via store options.

**Acceptance Scenarios**:

1. **Given** an underlying store returns a retryable response (`429/500/502/503/504`) or a transient network error (`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`), **When** a read is attempted, **Then** the library retries up to the configured maximum before failing.
2. **Given** retries occur, **When** backoff delays are computed, **Then** the delay includes randomized jitter (full jitter) rather than a fixed deterministic value.
3. **Given** an S3 operation exceeds its configured timeout, **When** the timeout elapses, **Then** the operation is aborted (parity with the HTTP path timeout).
4. **Given** a consumer sets maximum retries and timeout via store options, **When** reads run, **Then** those configured values are honored instead of fixed constants.
5. **Given** an error that is not retryable, **When** it occurs, **Then** the library fails fast without consuming retry attempts.

---

### User Story 5 - Missing chunks are observable and optionally fatal (Priority: P2)

A missing chunk is currently filled with zeros silently. In a forecast dataset this produces plausible-but-wrong "0" values with no signal. As a library consumer, I want to be notified when a chunk is missing, and optionally to have the read fail instead of fabricating zeros, so silent data corruption is detectable.

**Why this priority**: Prevents silent wrong data, but it is a targeted addition layered on the observability and read paths.

**Independent Test**: Read an array where a chunk is absent; with default behavior confirm a missing-chunk notification fires while zeros are still returned; with strict mode enabled confirm the read raises an error instead of returning zeros.

**Acceptance Scenarios**:

1. **Given** a chunk is absent and default behavior is in effect, **When** the chunk is read, **Then** the region is filled with the fill value (default 0) **and** a missing-chunk notification fires identifying the key.
2. **Given** strict mode is enabled, **When** an absent chunk is read, **Then** the read raises an error instead of returning fabricated values.
3. **Given** strict mode is disabled (default), **When** an absent chunk is read, **Then** existing behavior is preserved (no breaking change for current consumers).

---

### Edge Cases

- Construction with a maximum cache size of zero or negative must be rejected (already enforced for the disk cache; preserve it).
- An unavailable shared cache (connection failure/timeout) must degrade to fetching from the underlying store, not fail the read.
- A shared-cache or callback implementation that throws must not corrupt or abort the primary read path.
- Two stores with the same logical content but different paths must not share cache entries; conversely the same store identity must map consistently across pods.
- Concurrent reads of the same key (thundering herd) must still de-duplicate, and per-event callbacks must remain consistent under that de-duplication.
- Jittered backoff must never produce a negative delay or a zero-then-busy-loop, and total retry time must stay bounded.
- Retry coverage must not turn a genuine 404 (missing object) into a retried failure.

## Requirements *(mandatory)*

### Functional Requirements

#### Bounded disk cache (P0)

- **FR-001**: When a cached store is constructed without a maximum cache size, the library MUST emit a discoverable warning (or notification hook) indicating the cache is unbounded and at risk of unbounded disk growth.
- **FR-002**: When a maximum cache size is configured, the library MUST evict least-recently-used entries so total on-disk cache size stays at or below the configured maximum.
- **FR-003**: The library MUST reject a non-positive maximum cache size at construction.
- **FR-004**: Project documentation MUST describe eviction behavior, the unbounded-growth risk, and guidance for sizing the cache.

#### Pluggable Cache interface + shared adapter (P1)

- **FR-005**: The library MUST define a cache abstraction supporting at least: get a value by key (returning absent on miss), set a value by key with an optional time-to-live, and optionally check existence by key.
- **FR-006**: The existing in-memory cache MUST be (or be adaptable to) an implementation of this cache abstraction.
- **FR-007**: The library MUST accept an optional cache conforming to this abstraction on the metadata path (consolidated-metadata read and group open).
- **FR-008**: Cache keys for metadata MUST be scoped by store identity so entries for different datasets/paths do not collide.
- **FR-008a**: When a shared cache is supplied and the underlying store has no deterministic identity (i.e. identity would fall back to a non-deterministic value such as the current `store-${Date.now()}` path), the library MUST require an explicit `storeId` and fail fast at construction rather than producing per-pod-divergent keys. Stores with deterministic identity (S3 bucket/prefix, HTTP base URL) continue to derive it automatically.
- **FR-009**: The library MUST publish a Redis shared-cache adapter backed by `ioredis`, declared as an **optional** peer dependency that is not imported unless the adapter is used, following the existing optional-peer-dependency pattern used for the S3 client (`@aws-sdk/client-s3`).
- **FR-010**: The library MUST function normally when no shared cache is supplied and when the shared-cache adapter's dependency is not installed.
- **FR-011**: When a supplied cache is unavailable or errors, the library MUST fall back to fetching from the underlying store rather than failing the read.

#### Observability hooks (P1)

- **FR-012**: The library MUST expose observability via an optional plain handlers object of typed callbacks (e.g. `{ onCacheHit?, onCacheMiss?, onStoreFetch?, onRetry?, onChunkDecoded?, onInFlightBytes?, onMissingChunk? }`). No `EventEmitter` is used. Each callback fires directly only when present, coupling the library to no external telemetry system and imposing no measurable overhead (no allocation, no dispatch) when unset.
- **FR-012a**: Observability handlers MUST be registered per store/group instance via construction options and propagated internally to the caches and chunk loader. There is no global registry and no per-read-call handler parameter, so counters stay isolated per dataset/instance.
- **FR-013**: The library MUST emit cache-hit and cache-miss events identifying the cache tier (memory / disk / shared).
- **FR-014**: The library MUST emit a store-fetch event with the key, byte count, and latency.
- **FR-015**: The library MUST emit a retry event with the attempt number and the triggering status or error.
- **FR-016**: The library MUST emit a chunk-decoded event with byte count, codec, and decode duration.
- **FR-017**: The library MUST emit an in-flight-bytes event reporting the current in-flight byte budget value.
- **FR-018**: The library MUST emit a missing-chunk event identifying the key (shared with the missing-chunk requirement below).

#### Network resilience (P2)

- **FR-019**: The library MUST treat `429`, `500`, `502`, `503`, and `504` responses as retryable.
- **FR-020**: The library MUST treat transient network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`) as retryable.
- **FR-021**: The library MUST apply randomized (full-jitter) backoff between retries.
- **FR-022**: The library MUST enforce an explicit per-operation timeout on the S3 read path, at parity with the HTTP path.
- **FR-023**: The library MUST allow the maximum retry count and the operation timeout to be configured via store options, with defaults that preserve current behavior where one exists.
- **FR-024**: The library MUST NOT retry non-retryable outcomes (e.g. a genuine not-found / 404), failing fast instead.

#### Missing chunk handling (P2)

- **FR-025**: On a missing chunk, the library MUST emit a missing-chunk notification (see FR-018) while preserving the default fill-value behavior.
- **FR-026**: The library MUST provide an optional strict mode that raises an error on a missing chunk instead of filling with the fill value.
- **FR-027**: With strict mode disabled (default), missing-chunk behavior MUST remain backward-compatible.

#### Documentation (Docs)

- **FR-028**: Documentation MUST explain the peak-memory-per-chunk formula (`peakPerChunk = chunkBytes × (decodeFactor + byteSwapFactor)`) and how to derive a safe in-flight byte budget from a pod's RAM limit.

### Key Entities *(include if feature involves data)*

- **Cache (abstraction)**: A pluggable key/value store for byte payloads, with get, set (optional TTL), and optional existence check. Backed by in-memory or shared (e.g. Redis) implementations.
- **Cached store**: Wraps an underlying store and adds bounded on-disk caching of chunk data, with LRU eviction when a maximum size is configured.
- **Store identity**: A stable identifier derived from a store (bucket/prefix or base URL) used to scope cache keys so different datasets do not collide.
- **Observability event set**: The named events the library emits — cache hit/miss (per tier), store fetch, retry, chunk decoded, in-flight bytes, missing chunk — each with a documented payload.
- **Retry/timeout policy**: Configurable maximum retries, retryable conditions, jittered backoff, and per-operation timeout governing store reads.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A cached store constructed without a maximum size always surfaces a discoverable unbounded-growth signal; with a maximum size configured, total on-disk cache size never exceeds the configured maximum across sustained reads.
- **SC-002**: With a shared metadata cache enabled, repeated opens of the same dataset across pods incur zero redundant metadata fetches from the underlying store after the first (100% of post-first metadata reads served from cache).
- **SC-003**: The library installs, loads, and serves reads with no shared-cache dependency present (zero required new runtime dependencies for the base package).
- **SC-004**: All documented observability events fire with their specified payloads in tests covering hit, miss, fetch, retry, decode, in-flight-bytes, and missing-chunk paths; with no callbacks registered, read throughput is statistically unchanged from baseline.
- **SC-005**: Reads recover from injected transient failures (`429/500/502/503/504` and `ECONNRESET/ETIMEDOUT/EAI_AGAIN`) within the configured retry budget; retry delays are observably jittered; an S3 operation that stalls is aborted at the configured timeout.
- **SC-006**: A missing chunk always produces a missing-chunk notification; with strict mode enabled, a missing chunk causes the read to fail rather than returning fabricated zeros.
- **SC-007**: Documentation lets an operator compute a safe in-flight byte budget from a pod RAM limit using the published peak-per-chunk formula.

## Assumptions

- The library remains read-only Zarr v2; no write paths are added.
- "Discoverable warning" for the unbounded cache means a standard runtime warning and/or a notification via the observability hooks; making the maximum size mandatory or changing its default is deferred to a future major version (the issue lists this as an option to *evaluate*), so this spec requires only a non-breaking warning now.
- The shared-cache adapter targets Redis via `ioredis`, published as a subpath export, mirroring the optional-peer-dependency treatment of the S3 client.
- Default retry/timeout values preserve current observable behavior where a default exists (e.g. ~30s HTTP timeout, 3 retries) unless a consumer overrides them.
- Observability callbacks are isolated such that a throwing callback cannot break a read.
- Store identity derivation continues to use the existing scheme (bucket/prefix or base URL) for recognized stores; the non-deterministic fallback is disallowed when a shared cache is in use (see FR-008a).

## Out of Scope

- **P3 — Decompression offload to worker threads.** Excluded pending profiling that confirms production datasets use heavy codecs (blosc/zstd) with large chunks. The source issue gates this work on that profiling and frames the offload as conditional; its requirements cannot be made concrete or testable until the profiling exists. To be addressed in a separate specification after profiling.
- Consumer-side (`nautilus-api`) changes, tracked in `i4sea/i4sea-aurora-ui#794`.
- Zarr v3 support, write support, or new codec implementations.
- Coupling to a specific metrics/telemetry vendor (Prometheus, Sentry, etc.); the library exposes neutral hooks only.

## Dependencies

- Existing `Store` interface and store implementations (S3, HTTP, filesystem).
- Existing disk cache (`CachedStore`/`DiskCache`), in-memory cache (`MemoryCache`), chunk loader, byte limiter, and consolidated-metadata/`openGroup` paths.
- Optional, consumer-installed Redis client for the shared-cache adapter (not a runtime dependency of the base package).
