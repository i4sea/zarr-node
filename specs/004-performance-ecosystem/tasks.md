# Tasks: Performance & Ecosystem Improvements

**Input**: Design documents from `/specs/004-performance-ecosystem/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — TDD is a constitution principle (III).

**Organization**: Tasks grouped by user story across 3 tiers.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)

---

## Tier 1: Quick Wins

---

## Phase 1: User Story 1 — Built-in Blosc Codec (Priority: P1)

**Goal**: Blosc-compressed arrays read without any manual codec registration

**Independent Test**: Open a Blosc-compressed fixture, read data — no codecRegistry.register() call

### Tests for US1

- [X] T001 [US1] Write test verifying Blosc-compressed array reads without manual registration (import library, open fixture, read data) in tests/unit/blosc-builtin.test.ts
- [X] T002 [US1] Write test verifying all Blosc sub-codecs (lz4, zstd, zlib, snappy) are handled via CompressorConfig passthrough in tests/unit/blosc-builtin.test.ts
- [X] T003 [US1] Write test verifying user-registered custom "blosc" codec takes precedence over built-in in tests/unit/blosc-builtin.test.ts

### Implementation for US1

- [X] T004 [US1] Add Blosc auto-registration in src/codec/codec.ts: register "blosc" factory that passes full CompressorConfig to numcodecs Blosc.fromConfig(), with has() guard to allow user override
- [X] T005 [US1] Remove manual Blosc registration from all example files in examples/

**Checkpoint**: Blosc arrays work out of the box — zero setup code

---

## Phase 2: User Story 2 — In-Memory LRU Chunk Cache (Priority: P1)

**Goal**: Decoded chunks cached in RAM — repeated reads skip disk I/O and decompression

**Independent Test**: Read same chunk twice with MemoryCache, verify second read < 0.1ms

### Tests for US2

- [X] T006 [P] [US2] Write unit tests for MemoryCache (get/set, LRU eviction, maxBytes limit, clear, size tracking) in tests/unit/memory-cache.test.ts
- [X] T007 [P] [US2] Write integration test: read chunk with MemoryCache, verify second read < 0.1ms in tests/integration/memory-cache.test.ts

### Implementation for US2

- [X] T008 [US2] Implement MemoryCache class (LRU Map, maxBytes, eviction, get/set/clear) in src/cache/memory.ts
- [X] T009 [US2] Add optional memoryCache parameter to ReadOptions in src/array.ts
- [X] T010 [US2] Integrate MemoryCache into loadChunks pipeline in src/chunk/loader.ts: check memory cache before store, cache decoded bytes after decompression
- [X] T011 [US2] Export MemoryCache and MemoryCacheOptions from src/index.ts

**Checkpoint**: Repeated chunk reads return in < 0.1ms from RAM

---

## Phase 3: User Story 3 — Disk Cache Size Limit (Priority: P1)

**Goal**: Disk cache stays within configured max size via LRU eviction

**Independent Test**: Fill cache beyond limit, verify oldest entries evicted

### Tests for US3

- [X] T012 [US3] Write unit tests for DiskCache LRU eviction (fill beyond maxSizeBytes, verify oldest files removed, verify total under limit) in tests/unit/disk-cache-lru.test.ts

### Implementation for US3

- [X] T013 [US3] Add maxSizeBytes option to CacheOptions in src/cache/cached-store.ts
- [X] T014 [US3] Implement evictLRU() in DiskCache: scan directory for file sizes+mtime, delete oldest until under limit in src/cache/disk.ts
- [X] T015 [US3] Call evictLRU() after each set() when maxSizeBytes is configured in src/cache/disk.ts

**Checkpoint**: Disk cache auto-evicts when over size limit

---

## Tier 2: Major Features

---

## Phase 4: User Story 4 — Multi-Array Reads (Priority: P2)

**Goal**: Read multiple arrays at the same selection through a shared concurrency pool

**Independent Test**: Read 4 arrays via readMultiple(), verify shared pool limits total concurrent fetches

### Tests for US4

- [X] T016 [P] [US4] Write integration test for readMultiple() (4 arrays, same selection, verify all returned correctly) in tests/integration/multi-array.test.ts
- [X] T017 [P] [US4] Write test verifying shared concurrency pool: mock store counting concurrent fetches, verify max concurrent <= configured limit in tests/integration/multi-array.test.ts
- [X] T017b [P] [US4] Write test for FR-013 partial failure: readMultiple with one invalid array name, verify error identifies failed array and other results are still returned in tests/integration/multi-array.test.ts

### Implementation for US4

- [X] T018 [US4] Implement readMultiple(names, selection?, options?) on ZarrGroup: collect chunk tasks from all arrays, run through shared loadChunks, split results back in src/group.ts
- [X] T019 [US4] Export readMultiple types from src/index.ts

**Checkpoint**: 4 arrays read with shared pool, no connection explosion

---

## Phase 5: User Story 5 — Byte-Range Requests (Priority: P2)

**Goal**: Partial chunk fetches for uncompressed data via HTTP Range / S3 Range headers

**Independent Test**: Read small slice from large uncompressed chunk, verify transfer < 10% of full chunk

### Tests for US5

- [X] T020 [P] [US5] Write unit tests for getRange() on FileSystemStore (read partial file by offset+length) in tests/integration/byte-range.test.ts
- [X] T021 [P] [US5] Write integration test: read small slice from uncompressed fixture, verify only needed bytes fetched (mock store tracking requested byte ranges) in tests/integration/byte-range.test.ts
- [X] T021b [P] [US5] Write test for FR-017 fallback: mock store WITHOUT getRange(), verify library falls back to full chunk fetch silently in tests/integration/byte-range.test.ts

### Implementation for US5

- [X] T022 [US5] Add optional getRange(key, offset, length) method to Store interface in src/store/store.ts
- [X] T023 [P] [US5] Implement getRange() in FileSystemStore using fs.read() with position in src/store/filesystem.ts
- [X] T024 [P] [US5] Implement getRange() in HTTPStore using Range HTTP header in src/store/http.ts
- [X] T025 [P] [US5] Implement getRange() in S3Store using Range parameter in GetObjectCommand in src/store/s3.ts
- [X] T026 [US5] Update chunk loader in src/chunk/loader.ts: for uncompressed arrays with stores supporting getRange, compute byte offset and fetch partial chunk

**Checkpoint**: Uncompressed slice reads transfer only needed bytes

---

## Tier 3: Ecosystem Features

---

## Phase 6: User Story 6 — Reference Filesystem (Priority: P3)

**Goal**: Read HDF5/NetCDF data via kerchunk JSON manifest without file conversion

**Independent Test**: Create reference manifest for local fixture, open as store, read correct data

### Tests for US6

- [X] T027 [P] [US6] Write test for ReferenceStore with inline string values (metadata entries) in tests/integration/reference.test.ts
- [X] T028 [P] [US6] Write test for ReferenceStore with byte-range references [url, offset, length] pointing to local files in tests/integration/reference.test.ts
- [X] T029 [P] [US6] Write test for ReferenceStore list() and has() operations in tests/integration/reference.test.ts

### Implementation for US6

- [X] T030 [US6] Define ReferenceSpec type and parseReferenceSpec() parser in src/metadata/reference-spec.ts
- [X] T031 [US6] Implement ReferenceStore: resolve keys from refs map, handle inline strings, handle [url, offset, length] via inner store getRange(), handle [url] via inner store get() in src/store/reference.ts
- [X] T032 [US6] Implement inner store pool: create/cache S3Store, HTTPStore, or FileSystemStore based on URL scheme (s3://, http://, file:// or relative path) in src/store/reference.ts
- [X] T033 [US6] Export ReferenceStore, ReferenceStoreOptions, ReferenceSpec from src/index.ts

**Checkpoint**: Kerchunk manifests can open non-Zarr files as virtual Zarr stores

---

## Phase 7: User Story 7 — Dataset Concept (Priority: P3)

**Goal**: Label-based selection by dimension name and coordinate value (xarray-style)

**Independent Test**: Open WRF fixture as Dataset, sel({lat: -25.5}), verify correct data at nearest coordinate

### Tests for US7

- [X] T034 [P] [US7] Write unit tests for coordinate nearest-neighbor lookup (sorted 1D binary search, unsorted linear scan) in tests/unit/coordinates.test.ts
- [X] T035 [P] [US7] Write integration test: open nested_groups fixture as Dataset, verify dimension discovery from _ARRAY_DIMENSIONS attrs in tests/integration/dataset.test.ts
- [X] T036 [P] [US7] Write integration test for ds.sel() with coordinate values, verify correct data returned in tests/integration/dataset.test.ts

### Implementation for US7

- [X] T037 [US7] Implement coordinate lookup functions (nearestIndex for sorted 1D, linearNearestIndex for unsorted/2D) in src/coordinates.ts
- [X] T038 [US7] Implement Dataset class: auto-discover dims from _ARRAY_DIMENSIONS, load coordinate arrays, sel() method using readMultiple + coordinate lookup in src/dataset.ts
- [X] T039 [US7] Implement openDataset(store) convenience function in src/index.ts
- [X] T040 [US7] Export Dataset, DatasetSelection, openDataset from src/index.ts

**Checkpoint**: Label-based selection works with auto-discovered coordinates

---

## Phase 8: Polish & Validation

**Purpose**: Full validation and backward compatibility

- [X] T041 Run full test suite (existing + all new) and verify 100% pass
- [X] T042 Verify all existing tests pass without modification (backward compatibility SC-008)
- [X] T043 Benchmark: WRF e2e with all optimizations (Blosc built-in + memory cache + disk cache LRU + multi-array reads)

---

## Dependencies & Execution Order

### Phase Dependencies

- **US1 (Phase 1)**: No dependencies — start immediately
- **US2 (Phase 2)**: No dependencies — can run parallel with US1
- **US3 (Phase 3)**: Depends on existing DiskCache from feature 003
- **US4 (Phase 4)**: Depends on existing ZarrGroup
- **US5 (Phase 5)**: No dependencies on other US in this feature
- **US6 (Phase 6)**: Depends on US5 (byte-range requests)
- **US7 (Phase 7)**: Depends on US4 (multi-array reads)
- **Polish (Phase 8)**: Depends on all user stories

### Parallel Opportunities

- US1 + US2 + US3 can all run in parallel (Tier 1 — independent modules)
- US4 + US5 can run in parallel (Tier 2 — independent)
- T006 + T007 can run in parallel (US2 tests)
- T020 + T021 can run in parallel (US5 tests)
- T023 + T024 + T025 can run in parallel (getRange per store)
- T027 + T028 + T029 can run in parallel (US6 tests)
- T034 + T035 + T036 can run in parallel (US7 tests)

---

## Implementation Strategy

### Tier 1 MVP (US1 + US2 + US3)

1. US1: Blosc built-in (quickest win, 0.5 day)
2. US3: Disk cache LRU (1.5 days)
3. US2: Memory LRU cache (2 days)
4. **STOP and VALIDATE**: Blosc zero-config, memory cache < 0.1ms, disk cache within limit

### Tier 2 (US4 + US5)

5. US5: Byte-range requests (3 days)
6. US4: Multi-array reads (2 days)
7. **VALIDATE**: Shared pool, partial fetches working

### Tier 3 (US6 + US7)

8. US6: Reference filesystem (5-7 days)
9. US7: Dataset concept (5-7 days)
10. **VALIDATE**: Kerchunk opens HDF5, ds.sel() works
