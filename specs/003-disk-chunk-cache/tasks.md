# Tasks: Disk Chunk Cache

**Input**: Design documents from `/specs/003-disk-chunk-cache/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — TDD is a constitution principle (III).

**Organization**: Tasks grouped by user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

## Phase 1: Foundational

**Purpose**: Core DiskCache class and directory structure

- [x] T001 Create src/cache/ directory structure
- [x] T002 Write unit tests for DiskCache (get miss, set+get hit, atomic write, I/O error handling, directory auto-creation) in tests/unit/disk-cache.test.ts
- [x] T003 Implement DiskCache class (get, set, clear, cache path computation, SHA-256 store hash, atomic write via tmp+rename) in src/cache/disk.ts

**Checkpoint**: DiskCache can read/write chunk files to disk with atomic writes

---

## Phase 2: User Story 1 — Cache Chunks on Disk (Priority: P1) MVP

**Goal**: First read fetches from remote and caches; second read serves from disk

**Independent Test**: Read same chunk twice — first hits store, second hits cache with zero network requests

### Tests for User Story 1

- [x] T004 [P] [US1] Write integration tests for CachedStore (first read caches, second read from disk, metadata keys NOT cached) in tests/integration/cached-store.test.ts
- [x] T005 [P] [US1] Write test verifying cache hit is < 10ms for a previously cached chunk in tests/integration/cached-store.test.ts

### Implementation for User Story 1

- [x] T006 [US1] Implement CachedStore class wrapping Store interface (get checks cache, set on miss, skip metadata keys, delegate has/list) in src/cache/cached-store.ts
- [x] T007 [US1] Define CacheOptions interface in src/cache/cached-store.ts (cacheDir, ttl?, storeId?)
- [x] T008 [US1] Add auto-derive store identity for S3Store (s3://bucket/prefix) and HTTPStore (baseUrl) via optional storeIdentity() method or config in src/cache/cached-store.ts
- [x] T009 [US1] Export CachedStore and CacheOptions from src/index.ts

**Checkpoint**: US1 complete — CachedStore caches chunks on disk, second reads are instant

---

## Phase 3: User Story 2 — Opt-in Configuration (Priority: P1)

**Goal**: Cache is disabled by default; enabled only by wrapping store with CachedStore

**Independent Test**: Open store without CachedStore — no cache files created; with CachedStore — cache files appear

### Tests for User Story 2

- [x] T010 [US2] Write test verifying no cache files when store is NOT wrapped with CachedStore in tests/integration/cached-store.test.ts
- [x] T010b [US2] Write test for FR-009: wrapping a FileSystemStore with CachedStore skips caching (local stores don't benefit from disk cache) in tests/integration/cached-store.test.ts
- [x] T011 [US2] Write test verifying cache files appear in correct directory structure (storeHash/chunkKey) in tests/integration/cached-store.test.ts

### Implementation for User Story 2

- [x] T012 [US2] Verify all existing tests pass without modification (no CachedStore = no behavior change)

**Checkpoint**: US2 complete — opt-in confirmed, backward compatibility verified

---

## Phase 4: User Story 3 — TTL Expiration (Priority: P2)

**Goal**: Cached chunks older than TTL are re-fetched from remote store

**Independent Test**: Set TTL, read chunk, wait for expiry, read again — verify re-fetch

### Tests for User Story 3

- [x] T013 [US3] Write test for TTL expiration (cache hit within TTL, cache miss after TTL, verify re-fetch updates mtime) in tests/unit/disk-cache.test.ts

### Implementation for User Story 3

- [x] T014 [US3] Add TTL check to DiskCache.get() — compare file mtime with TTL, return null if expired in src/cache/disk.ts
- [x] T015 [US3] Add clearCache() method to CachedStore that delegates to DiskCache.clear() in src/cache/cached-store.ts

**Checkpoint**: US3 complete — stale cache entries auto-expire, manual clear works

---

## Phase 5: User Story 4 — Cross-Session Persistence (Priority: P2)

**Goal**: Cache persists between process restarts

**Independent Test**: Write cache in one test, read in another without re-fetching

### Tests for User Story 4

- [x] T016 [US4] Write test simulating cross-session: create CachedStore, read chunk (populates cache), create NEW CachedStore with same cacheDir, read same chunk — verify served from cache in tests/integration/cached-store.test.ts

**Checkpoint**: US4 complete — cache survives process restart

---

## Phase 6: Polish & Validation

**Purpose**: Edge cases, error handling, full validation

- [x] T017 Write tests for edge cases (disk full simulation, corrupt cache file, read-only cache dir, concurrent writes) in tests/unit/disk-cache.test.ts
- [x] T018 Run full test suite and verify all tests pass (existing + new)
- [x] T019 Benchmark: read WRF lat/lon from S3 with cache — first read vs second read timing

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately
- **US1 (Phase 2)**: Depends on Phase 1 (DiskCache must exist) — MVP target
- **US2 (Phase 3)**: Depends on US1 — validates opt-in behavior
- **US3 (Phase 4)**: Depends on US1 — extends DiskCache with TTL
- **US4 (Phase 5)**: Depends on US1 — validates persistence
- **Polish (Phase 6)**: Depends on all user stories

### Parallel Opportunities

- T004 + T005 can run in parallel (different test aspects)
- US3 and US4 are independent of each other (both depend on US1)

---

## Implementation Strategy

### MVP First (User Story 1)

1. Complete Phase 1: DiskCache
2. Complete Phase 2: CachedStore wrapping
3. **STOP and VALIDATE**: Second read from cache, < 10ms

### Incremental Delivery

1. DiskCache → foundation
2. US1 → Cached chunk reads (MVP!)
3. US2 → Opt-in verification
4. US3 → TTL expiration
5. US4 → Cross-session persistence
6. Polish → Edge cases + benchmarks
