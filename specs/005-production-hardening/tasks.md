# Tasks: Production Hardening

**Input**: Design documents from `/specs/005-production-hardening/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED and written FIRST — the project constitution mandates Test-Driven Development (Principle III, NON-NEGOTIABLE). Each story's tests must be written and confirmed failing (red) before its implementation (green).

**Organization**: Tasks are grouped by user story. Note this is a refactor over shared library files, so several stories touch the same files (`array.ts`, `loader.ts`, `store.ts`, `http.ts`, `s3.ts`, `cached-store.ts`, `index.ts`). Stories remain independently *testable*, but cross-story parallelism on those files requires coordination — see Dependencies. Within a story, `[P]` marks distinct-file, no-dependency tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 maps to the spec's user stories

## Path Conventions

Single-library layout: `src/`, `tests/` at repository root (per plan.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project configuration enabling the Redis adapter and its tests.

- [ ] T001 Configure `package.json` for the Redis adapter: add `ioredis` to `devDependencies`, add it to `peerDependencies` with `peerDependenciesMeta.ioredis.optional = true`, and add the `./redis` subpath to `exports` (types/import/require pointing at `dist/redis/index.*`). Verify the `tsc` build picks up `src/redis/**` and `postbuild-cjs.mjs` emits the CJS variant.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The observability type is referenced by option bags across US2–US5, so it must exist before those stories thread `observability?` into their options.

**⚠️ CRITICAL**: Complete before US2–US5. (US1 does not depend on this phase.)

- [ ] T002 [P] Write failing unit test for `safeInvoke` (a throwing handler is swallowed and never propagates) in tests/unit/observability.test.ts
- [ ] T003 Create src/observability.ts exporting `CacheTier`, the `ObservabilityHooks` interface (per contracts/observability.md), and a `safeInvoke(fn, arg)` helper; re-export both types from src/index.ts

**Checkpoint**: `ObservabilityHooks` type available; user stories can begin.

---

## Phase 3: User Story 1 - Disk cache cannot silently grow unbounded (Priority: P1) 🎯 MVP

**Goal**: Make the unbounded-vs-bounded disk cache behavior impossible to overlook and document it.

**Independent Test**: Construct `CachedStore` without `maxSizeBytes` → a discoverable warning fires; construct with `maxSizeBytes` → eviction keeps total cache size ≤ the limit; docs explain the risk and sizing.

### Tests for User Story 1 (write first, confirm failing) ⚠️

- [ ] T004 [P] [US1] Failing test: constructing `CachedStore` without `maxSizeBytes` (and `skipLocal` false) calls `console.warn` exactly once with the unbounded-growth risk message; with `maxSizeBytes` set it does NOT warn — in tests/unit/disk-cache.test.ts
- [ ] T005 [P] [US1] Test asserting eviction keeps total on-disk size ≤ `maxSizeBytes` across sustained writes (SC-001 bound) in tests/unit/disk-cache-lru.test.ts (extend existing if not already covered)

### Implementation for User Story 1

- [ ] T006 [US1] Emit a one-time `console.warn` in the `CachedStore` constructor when `options.maxSizeBytes` is undefined and `skipLocal` is false, naming the risk and how to bound it (FR-001) in src/cache/cached-store.ts
- [ ] T007 [US1] Update the README "Caching" section: document LRU eviction behavior, the unbounded-growth risk, and cache-sizing guidance (FR-004) in README.md

**Checkpoint**: US1 fully functional and independently testable — MVP deliverable.

---

## Phase 4: User Story 2 - Shared, pluggable metadata cache (Priority: P1)

**Goal**: Pluggable async `Cache` interface wired into the metadata read path, with an in-memory implementation, store-identity-scoped keys (fail-fast when non-deterministic), and an `ioredis`-backed Redis adapter as a subpath export.

**Independent Test**: Supply an `InMemoryCache` on the metadata path, open the same group twice → second open served from cache with no second store fetch; library still works with no cache and with `ioredis` absent; different paths don't collide.

### Tests for User Story 2 (write first, confirm failing) ⚠️

- [ ] T008 [P] [US2] Shared `Cache` contract suite (get-miss→null, set→get round-trip binary-safe, TTL expiry, optional `has`) in tests/contract/cache.contract.ts
- [ ] T009 [P] [US2] Unit test: `InMemoryCache` adapter behavior + `${storeId}:${key}` scoping (no cross-dataset collision) in tests/unit/cache-interface.test.ts
- [ ] T010 [P] [US2] Integration test: metadata cache hit avoids second store fetch on repeated `open`; no-cache passthrough behaves as today; `metadataCache` + non-deterministic store identity without `storeId` throws at open (FR-008a) in tests/integration/metadata-cache.test.ts
- [ ] T011 [P] [US2] Integration test: `RedisCache` satisfies the cache contract against an `ioredis` instance, and importing `./redis` errors clearly when `ioredis` is absent (guard/skip when not installed) in tests/integration/redis-cache.test.ts

### Implementation for User Story 2

- [ ] T012 [P] [US2] Define the async `Cache` interface and a `scopeKey(storeId, key)` helper in src/cache/cache.ts (per contracts/cache.md)
- [ ] T013 [US2] Implement `InMemoryCache implements Cache` reusing the existing `MemoryCache` byte-LRU, honoring `ttlMs` via stored expiry timestamps, in src/cache/memory.ts
- [ ] T014 [US2] Extract store-identity derivation into src/store/identity.ts as `deriveStoreId(store): string | null` (deterministic-or-null, replacing the `store-${Date.now()}` fabrication); update src/cache/cached-store.ts to consume it (keeping a per-process fallback id for the local disk cache)
- [ ] T015 [US2] Add `OpenOptions { metadataCache?, storeId?, observability? }` and thread it through `open`/`openGroup`/`openArray`: read-through (`cache.get` → `store.get` → `cache.set` no-TTL), shared-tier `onCacheHit`/`onCacheMiss`, error/unavailable cache falls back to store (FR-011), and fail-fast when `metadataCache` is set without a derivable/explicit `storeId` (FR-008a) in src/index.ts
- [ ] T016 [US2] Carry `metadataCache`/`storeId`/`observability` on `ZarrGroup` so `getMeta`/`getArray`/`getGroup` read child metadata through the cache in src/group.ts
- [ ] T017 [P] [US2] Implement `RedisCache implements Cache` (dynamic `import("ioredis")` like `loadS3SDK`, `PX` for TTL, binary-safe buffers, clear error if `ioredis` missing) in src/redis/index.ts
- [ ] T018 [US2] Export `Cache`, `InMemoryCache`, and `OpenOptions` from src/index.ts (RedisCache exported only from the `./redis` entry)

**Checkpoint**: US1 and US2 both independently functional.

---

## Phase 5: User Story 3 - Observability hooks fire across layers (Priority: P2)

**Goal**: Wire the per-instance hooks object so cache hit/miss (memory/disk), store fetch, chunk decode, and in-flight bytes events fire with documented payloads, with zero overhead when unset. (Shared-tier hit/miss is wired in US2; `onRetry` in US4; `onMissingChunk` in US5.)

**Independent Test**: Register callbacks, perform hit/miss reads and a fetch/decode → each fires with the documented payload; a throwing handler does not break the read; with no callbacks, read throughput is unchanged from baseline.

### Tests for User Story 3 (write first, confirm failing) ⚠️

- [ ] T019 [P] [US3] Tests asserting `onStoreFetch` (key/bytes/latencyMs), memory `onCacheHit`/`onCacheMiss` (tier `"memory"`), disk `onCacheHit`/`onCacheMiss` (tier `"disk"`), `onChunkDecoded` (bytes/codec/decodeMs), and `onInFlightBytes` fire with correct payloads in tests/unit/observability.test.ts
- [ ] T020 [P] [US3] Benchmark assertion: a read with no hooks registered is statistically unchanged from baseline (SC-004 zero-overhead) in tests/integration/benchmark.test.ts

### Implementation for User Story 3

- [ ] T021 [US3] Add `observability?: ObservabilityHooks` to `HTTPStoreOptions`/`S3StoreOptions` in src/store/store.ts, and fire `onStoreFetch({key, bytes, latencyMs})` around successful fetches in src/store/http.ts and src/store/s3.ts
- [ ] T022 [US3] Thread `observability` into `LoadChunksContext` and fire memory `onCacheHit`/`onCacheMiss` and `onChunkDecoded` (timing the `codec.decode`) in src/chunk/loader.ts
- [ ] T023 [P] [US3] Add an optional `onInFlightBytes` callback to `ByteLimiter` (invoked on budget change in `acquire`/`release`) in src/chunk/limiter.ts
- [ ] T024 [US3] Add `observability?` to `CacheOptions` and fire disk `onCacheHit`/`onCacheMiss` (tier `"disk"`) in src/cache/cached-store.ts
- [ ] T025 [US3] Add `observability?: ObservabilityHooks` to `ReadOptions` and thread it into the loader context and `ByteLimiter` in src/array.ts

**Checkpoint**: US1–US3 independently functional.

---

## Phase 6: User Story 4 - Network resilience under EKS conditions (Priority: P2)

**Goal**: Broaden retryable conditions, apply full-jitter backoff, add an explicit S3 timeout, and make retries/timeout configurable.

**Independent Test**: Inject transient `500/502/504` + `ECONNRESET/ETIMEDOUT/EAI_AGAIN` → operation retries and succeeds; backoff is jittered; an S3 op exceeding its timeout aborts; `maxRetries`/`timeout` honored from options; a 404 is not retried.

### Tests for User Story 4 (write first, confirm failing) ⚠️

- [ ] T026 [P] [US4] Unit tests for the retry policy: retryable status `{429,500,502,503,504}` and network codes `{ECONNRESET,ETIMEDOUT,EAI_AGAIN}` classify as retryable; 404 does not; `fullJitterDelay(attempt, base)` ∈ `[0, min(cap, base·2^attempt)]`; attempts bounded by `maxRetries` in tests/unit/retry.test.ts
- [ ] T027 [P] [US4] Integration tests: transient failure then success returns data; `maxRetries`/`timeout` overrides honored; S3 operation exceeding `timeout` aborts; `onRetry` fires per attempt in tests/integration/http.test.ts and tests/integration/s3.test.ts

### Implementation for User Story 4

- [ ] T028 [P] [US4] Create src/store/retry.ts: retryable-status set, retryable network-error codes (+ S3 SDK names `ThrottlingException`/`SlowDown`/`TimeoutError`), `fullJitterDelay`, `RetryConfig { maxRetries; timeoutMs }` with defaults (3 retries, 30000ms), and an `isRetryable`/`classify` helper
- [ ] T029 [US4] Add `maxRetries?` to `HTTPStoreOptions` (src/store/store.ts) and refactor `HTTPStore.fetchWithRetry` to use src/store/retry.ts: expanded retryable set, network-error detection via `err.cause?.code`, full-jitter backoff, configurable `maxRetries`, and `onRetry` firing in src/store/http.ts
- [ ] T030 [US4] Add `maxRetries?`/`timeout?` to `S3StoreOptions` (src/store/store.ts) and refactor `S3Store.get`/`getRange` to use src/store/retry.ts: explicit per-op timeout via `abortSignal: AbortSignal.timeout(timeoutMs)` on `client.send`, expanded retryable classification, full-jitter backoff, configurable `maxRetries`, and `onRetry` firing in src/store/s3.ts

**Checkpoint**: US1–US4 independently functional.

---

## Phase 7: User Story 5 - Missing chunks observable and optionally fatal (Priority: P2)

**Goal**: Notify on a missing chunk (preserving default zero-fill) and add an optional strict mode that throws instead.

**Independent Test**: Read an array with an absent chunk → default fires `onMissingChunk` and still returns zeros; `strict: true` throws `MissingChunkError` instead.

### Tests for User Story 5 (write first, confirm failing) ⚠️

- [ ] T031 [P] [US5] Loader tests: absent chunk in default mode → zeros returned AND `onMissingChunk({key})` fired (both full-fetch and byte-range miss paths); `strict: true` → `MissingChunkError` thrown with the key; `strict` omitted → byte-identical to current behavior in tests/unit/loader.test.ts

### Implementation for User Story 5

- [ ] T032 [P] [US5] Add `MissingChunkError extends ZarrError` (with the missing key in its message) in src/errors.ts and export it from src/index.ts
- [ ] T033 [US5] Add `strict?: boolean` to `LoadChunksContext`; on both missing-chunk paths fire `onMissingChunk` and, when `strict`, throw `MissingChunkError` instead of filling zeros, in src/chunk/loader.ts
- [ ] T034 [US5] Add `strict?: boolean` to `ReadOptions` and thread it into the loader context in src/array.ts

**Checkpoint**: All five user stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, release metadata, and full validation across stories.

- [ ] T035 [P] Add the peak-memory formula (`peakPerChunk = chunkBytes × (decodeFactor + byteSwapFactor)`) and how to derive `maxInFlightBytes` from a pod RAM limit (FR-028) to README.md
- [ ] T036 [P] Add README usage for the Redis metadata cache and observability hooks (mirroring quickstart.md) to README.md
- [ ] T037 Add a changeset, bump version `0.4.0` → `0.5.0`, and add a CHANGELOG entry covering all five tracks (note the unbounded disk-cache warning is a new warning, not a behavior break) in package.json + changeset/CHANGELOG
- [ ] T038 Run full validation: `npm test && npm run lint && npm run typecheck && npm run build && npm run test:cjs && npm run test:esm`
- [ ] T039 Execute the quickstart.md validation checklist end-to-end (all six story validations)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; BLOCKS US2–US5 (they thread `observability?` into options). US1 does NOT depend on it.
- **User Stories (Phase 3–7)**: each depends on Foundational (except US1). See shared-file notes below.
- **Polish (Phase 8)**: depends on all targeted stories.

### User story dependencies

- **US1 (P1)**: independent; can start immediately (no Foundational dependency). MVP.
- **US2 (P1)**: after Foundational. Touches `cached-store.ts` (also touched by US1/US3) and `index.ts` (also US5).
- **US3 (P2)**: after Foundational. Independent in intent, but shares files with US1/US2/US4/US5.
- **US4 (P2)**: after Foundational. Shares `store.ts`/`http.ts`/`s3.ts` with US3.
- **US5 (P2)**: after Foundational. Shares `loader.ts`/`array.ts`/`index.ts` with US3/US2.

### Shared-file coordination (sequence, do not parallelize across stories)

- `src/cache/cached-store.ts`: T006 (US1) → T014 (US2) → T024 (US3).
- `src/store/store.ts`: T021 (US3) → T029/T030 (US4).
- `src/store/http.ts`: T021 (US3) → T029 (US4).
- `src/store/s3.ts`: T021 (US3) → T030 (US4).
- `src/chunk/loader.ts`: T022 (US3) → T033 (US5).
- `src/array.ts`: T025 (US3) → T034 (US5).
- `src/index.ts`: T015/T018 (US2) → T032 (US5).

Because of these overlaps, the recommended execution is **sequential by priority** (US1 → US2 → US3 → US4 → US5), even though each story is independently testable once built.

### Within each story

- Tests written and failing BEFORE implementation (constitution Principle III).
- Interface/type files before consumers (e.g. T012 `cache.ts` before T013/T015/T016).
- Story complete and green before moving to the next priority.

---

## Parallel Opportunities

- **Foundational**: T002 (test) is `[P]` relative to other phases' files.
- **US1**: T004, T005 (distinct test files) run in parallel before T006.
- **US2 tests**: T008, T009, T010, T011 all `[P]` (distinct files). Impl: T012 and T017 are `[P]` (distinct files) but T013/T015/T016/T018 depend on T012.
- **US3 tests**: T019, T020 `[P]`. Impl: T023 (`limiter.ts`) `[P]` vs the store/loader/cache edits.
- **US4**: T026, T027 `[P]`; T028 (`retry.ts`) `[P]` and is a prerequisite for T029/T030.
- **US5**: T031 `[P]`; T032 (`errors.ts`) `[P]` and precedes T033/T034.
- **Polish**: T035, T036 `[P]` (both README but can be one editing pass), independent of T037/T038/T039 ordering.

### Parallel example: User Story 2 tests

```bash
Task: "Cache contract suite in tests/contract/cache.contract.ts"
Task: "InMemoryCache + key scoping unit test in tests/unit/cache-interface.test.ts"
Task: "Metadata-cache integration test in tests/integration/metadata-cache.test.ts"
Task: "RedisCache integration test in tests/integration/redis-cache.test.ts"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup (T001).
2. Phase 3 US1 (T004–T007) — note US1 needs neither Setup nor Foundational, but run Setup anyway for the branch.
3. **STOP and VALIDATE**: unbounded warning fires, eviction bounded, docs present.
4. Ship as the P0 disk-safety fix.

### Incremental delivery

1. Foundational (T002–T003) → US2 (metadata cache + Redis) → validate → ship.
2. US3 (observability) → validate → ship.
3. US4 (resilience) → validate → ship.
4. US5 (missing-chunk/strict) → validate → ship.
5. Polish (docs, changeset, full CI + interop) → release 0.5.0.

Each increment is backward-compatible: omitting the new options preserves current behavior.

---

## Notes

- `[P]` = different files, no incomplete dependencies.
- This is a refactor over shared files; honor the shared-file coordination list to avoid merge conflicts.
- Verify each story's tests fail before implementing (TDD red→green→refactor).
- Use conventional-commit prefixes; never add an AI co-author trailer (CLAUDE.md).
- Existing `tests/contract/store.contract.ts` and the full suite must keep passing throughout.
