# Implementation Plan: Production Hardening

**Branch**: `005-production-hardening` | **Date**: 2026-06-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-production-hardening/spec.md`

## Summary

Harden `@i4sea/zarr-node` for the `nautilus-api` EKS workload along five tracks, all additive and backward-compatible: (1) make the disk cache warn loudly when constructed unbounded; (2) introduce a pluggable async `Cache` interface, wire it into the metadata read path, and publish an optional `ioredis`-backed Redis adapter as a subpath export; (3) add a zero-overhead, per-instance observability hooks object threaded through stores, caches, and the chunk loader; (4) strengthen network resilience (broader retryable set, full-jitter backoff, explicit S3 timeout, configurable retries/timeout); and (5) surface missing chunks via a hook plus an optional strict mode. Plus README docs for cache sizing and the peak-memory formula.

Technical approach: extract the store-identity and retry/backoff logic into shared helpers, add a thin `Cache` abstraction reusing the existing `MemoryCache` LRU via an adapter, thread three optional option bags (`ObservabilityHooks`, metadata `Cache` + `storeId`, retry/timeout config) through existing construction and open paths without changing default behavior when omitted. The package stays ESM-first with a CJS build; the Redis client is an optional peer dependency loaded only when the adapter is used (same pattern as `@aws-sdk/client-s3`).

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`), targeting ES2022, ESM-only
**Primary Dependencies**: `numcodecs` (Blosc, runtime), `@aws-sdk/client-s3` (optional peer), `ioredis` (NEW optional peer for the Redis adapter); Node built-ins `node:fs/promises`, `node:crypto`, `node:path`, `node:zlib`, native `fetch`
**Storage**: Local filesystem (disk chunk cache), remote stores (S3, HTTP), optional Redis (shared metadata cache)
**Testing**: Vitest (`vitest run`), shared store contract suite (`tests/contract/store.contract.ts`), Python-generated Zarr fixtures, CJS/ESM interop smoke tests
**Target Platform**: Node.js >= 22 (LTS) server workloads; 5-replica EKS pods, `limits 800m/1Gi`
**Project Type**: Single library (read-only Zarr v2 reader)
**Performance Goals**: Observability adds zero allocation/dispatch when hooks unset; full-jitter backoff prevents retry storms under ~128 concurrent chunk reads; shared metadata cache eliminates redundant per-pod metadata fetches
**Constraints**: Memory-conscious (existing `ByteLimiter` byte budget, `DEFAULT_MAX_IN_FLIGHT_BYTES` 256 MiB); no new required runtime dependency for the base package; backward-compatible (pre-1.0, minor bump 0.5.0)
**Scale/Scope**: ~8 new/changed source modules, ~6 public API additions, all five user stories in one feature branch

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Read-Only by Design | ✅ PASS | No write paths added. `Cache` is read-through for metadata; `Store` interface unchanged (get/has/list/getRange?). |
| II. TypeScript-First | ✅ PASS | New `Cache`, `ObservabilityHooks`, option types are fully typed; no `any` in public API (existing internal S3 `any` untouched). |
| III. TDD (NON-NEGOTIABLE) | ✅ PASS | Tests first per track: `Cache` contract suite, retry/jitter unit tests, observability hook-firing tests, missing-chunk/strict tests, disk-cache warning test. Existing store contract suite must keep passing. |
| IV. Extensible Plugin Architecture | ✅ PASS | `Cache` is a new stable plugin interface alongside `Store`/`Codec`; Redis adapter is one implementation, not assumed. |
| V. Server-First Performance | ✅ PASS | Hooks zero-overhead when unset; jitter caps retry amplification; uses native primitives. Benchmark test (`tests/integration/benchmark.test.ts`) guards regressions. |
| VI. Semantic Versioning & API Stability | ✅ PASS | Additive public API. Behavior changes (retry now covers 5xx/network by default; unbounded disk cache now warns) are acceptable in a pre-1.0 minor (0.4.0 → 0.5.0); changeset + CHANGELOG entry required. |
| VII. Simplicity (YAGNI) | ✅ PASS | Each addition maps to a user story. Plain handlers object over EventEmitter; adapter reuses existing LRU; shared helpers instead of duplicated retry logic. |

**Result**: PASS — no violations. Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/005-production-hardening/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (public TS API contracts)
│   ├── cache.md
│   ├── observability.md
│   └── store-options.md
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── index.ts                  # MODIFY: open/openGroup/openArray accept OpenOptions; ALL root metadata reads (.zarray/.zgroup/.zattrs/.zmetadata — direct store.get today) go through the read-through helper (research.md D2)
├── array.ts                  # MODIFY: ReadOptions gains observability + strict; thread to loader
├── group.ts                  # MODIFY: carry metadataCache/storeId/observability; getMeta reads through Cache
├── errors.ts                 # MODIFY: add MissingChunkError
├── observability.ts          # NEW: ObservabilityHooks interface + safe-invoke helper
├── cache/
│   ├── cache.ts              # NEW: async Cache interface + key scoping helper
│   ├── memory.ts             # MODIFY: add Cache adapter (InMemoryCache) reusing MemoryCache LRU
│   ├── disk.ts               # (unchanged logic; eviction already correct)
│   └── cached-store.ts       # MODIFY: warn when unbounded; emit disk hit/miss hooks; use shared identity helper
├── chunk/
│   ├── loader.ts             # MODIFY: missing-chunk hook + strict; memory hit/miss + decode + in-flight hooks
│   └── limiter.ts            # MODIFY: optional onInFlightBytes callback hook
├── store/
│   ├── identity.ts           # NEW: deriveStoreId(store) -> string | null (refactored from cached-store.ts:107-120; deterministic-or-null)
│   ├── retry.ts              # NEW: shared retry policy (retryable set, full-jitter backoff, config)
│   ├── http.ts               # MODIFY: use shared retry, jitter, expanded codes, configurable maxRetries; fire hooks
│   ├── s3.ts                 # MODIFY: explicit timeout, shared retry, jitter, expanded codes, configurable; fire hooks
│   └── store.ts              # MODIFY: HTTPStoreOptions/S3StoreOptions gain maxRetries/timeout/observability
└── redis/
    └── index.ts              # NEW: RedisCache implements Cache (dynamic-imports ioredis)

tests/
├── contract/
│   ├── store.contract.ts     # (reused; stores must still pass)
│   └── cache.contract.ts     # NEW: shared contract suite for Cache implementations
├── unit/
│   ├── retry.test.ts         # NEW: retryable classification + full-jitter bounds
│   ├── observability.test.ts # NEW: hooks fire with correct payloads; safe-invoke isolates throws
│   ├── cache-interface.test.ts # NEW: InMemoryCache adapter + key scoping
│   ├── disk-cache.test.ts    # MODIFY: unbounded warning assertion
│   └── loader.test.ts        # MODIFY: missing-chunk hook + strict mode
└── integration/
    ├── metadata-cache.test.ts # NEW: shared metadata cache hit/no-refetch; storeId fail-fast
    └── redis-cache.test.ts    # NEW: RedisCache against mock/ioredis (guarded if ioredis absent)

package.json                  # MODIFY: ./redis subpath export; ioredis optional peer + devDep; version 0.5.0
README.md                     # MODIFY: cache eviction/sizing (FR-004); peak-memory formula (FR-028)
```

**Structure Decision**: Single-library layout (existing). New code follows the established module boundaries — `cache/`, `store/`, `chunk/` — plus a new `src/redis/` directory that compiles to a `./redis` subpath export. Shared concerns (store identity, retry policy, observability) are extracted into focused modules so HTTP and S3 stores stop duplicating retry logic and `CachedStore`/metadata-open share one identity derivation.

## Complexity Tracking

> No Constitution violations. Section intentionally empty.
