# Tasks: Zarr v2 Reader

**Input**: Design documents from `/specs/001-zarr-v2-reader/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — TDD is a constitution principle (III). Contract tests for stores, unit tests for core logic, integration tests with Python fixtures.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, tooling configuration, and base structure

- [x] T001 Initialize npm package with package.json (name: zarr-node, type: module, engines: node>=22, peerDependencies: @aws-sdk/client-s3)
- [x] T002 Configure TypeScript with tsconfig.json (strict: true, target: ES2022, module: NodeNext, outDir: dist/)
- [x] T003 [P] Configure ESLint and Prettier
- [x] T004 [P] Configure vitest with vitest.config.ts (@vitest/coverage-v8)
- [x] T005 Create source directory structure: src/store/, src/metadata/, src/codec/, src/chunk/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, interfaces, and codecs that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Define custom error classes (ZarrError, MetadataError, StoreError, CodecError, SliceError) in src/errors.ts
- [x] T007 Define Zarr v2 metadata types (ZarrayMeta, ZgroupMeta, CompressorConfig, FilterConfig) in src/metadata/types.ts
- [x] T008 [P] Define Store interface in src/store/store.ts (matching contracts/store.ts)
- [x] T009 [P] Define Codec interface, CompressorConfig, CodecFactory, and CodecRegistry in src/codec/codec.ts (matching contracts/codec.ts)
- [x] T010 Create Python fixture generation script in tests/fixtures/generate.py (simple_1d, chunked_2d, compressed_gzip, nested_groups, big_endian, f_order with expected.json)
- [x] T011 [P] Write unit tests for metadata parsing in tests/unit/metadata.test.ts
- [x] T012 [P] Write unit tests for dtype mapping and byte-swap in tests/unit/dtype.test.ts
- [x] T013 [P] Write unit tests for codec decode (raw, zlib, gzip) in tests/unit/codec.test.ts
- [x] T014 Implement Zarr v2 metadata parser (parse .zarray, .zgroup, .zattrs JSON with validation) in src/metadata/v2.ts
- [x] T015 Implement dtype string to TypedArray mapping with endianness byte-swap (Buffer.swap16/32/64 for big-endian) in src/dtype.ts
- [x] T016 Implement RawCodec (no-op decode) in src/codec/raw.ts
- [x] T017 Implement GzipCodec (node:zlib inflate for "zlib" ID, gunzip for "gzip" ID) in src/codec/gzip.ts
- [x] T018 Implement CodecRegistry singleton pre-populated with raw + zlib + gzip codecs in src/codec/codec.ts

**Checkpoint**: Foundation ready — all core types, interfaces, codecs, and fixtures are in place

---

## Phase 3: User Story 1 — Read Array from Local Filesystem (Priority: P1) MVP

**Goal**: Open a Zarr v2 array on disk, inspect metadata, and read the full typed array (uncompressed and gzip-compressed, C-order and F-order, big-endian byte-swap, missing chunk fill_value, "." and "/" dimension separators)

**Independent Test**: Open local Zarr v2 fixture directories, read arrays, verify typed array values match expected.json

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T019 [P] [US1] Write Store contract test suite (get, has, list) in tests/contract/store.contract.ts
- [x] T020 [P] [US1] Write FileSystemStore contract test using store.contract.ts in tests/integration/filesystem.test.ts
- [x] T021 [P] [US1] Write full-pipeline integration tests (open -> read -> verify for simple_1d, chunked_2d, compressed_gzip, big_endian, f_order fixtures) in tests/integration/array.test.ts

### Implementation for User Story 1

- [x] T022 [US1] Implement FileSystemStore (get, has, list via node:fs/promises) in src/store/filesystem.ts
- [x] T023 [US1] Implement chunk key resolution (array indices to chunk key string with "." or "/" separator) in src/chunk/indexing.ts
- [x] T024 [US1] Implement chunk loader with configurable concurrency (promise pool, default 10, fetch + decode + byte-swap per chunk) in src/chunk/loader.ts
- [x] T025 [US1] Implement ZarrArray class (parse metadata, get() for full read: resolve chunks, load via loader, assemble typed array with C/F order support, fill_value for missing chunks) in src/array.ts
- [x] T026 [US1] Implement open() and openArray() entry functions in src/index.ts (auto-detect array vs group, re-export public API)

**Checkpoint**: User Story 1 complete — can open any local Zarr v2 array and read full data as TypedArray

---

## Phase 4: User Story 2 — Navigate Zarr Groups and Hierarchy (Priority: P1)

**Goal**: Open a Zarr v2 group, list children, navigate to sub-groups and arrays, access attributes

**Independent Test**: Open nested_groups fixture, list children, navigate hierarchy, read specific arrays, verify attributes

### Tests for User Story 2

- [x] T027 [P] [US2] Write integration tests for group hierarchy traversal (open root, list arrays/groups, navigate sub-groups, read .zattrs) in tests/integration/array.test.ts (extend existing)

### Implementation for User Story 2

- [x] T028 [US2] Implement ZarrGroup class (getArray, getGroup, arrays, groups, contains, attrs from .zattrs) in src/group.ts
- [x] T029 [US2] Implement openGroup() and update open() in src/index.ts to return ZarrGroup when path points to a group

**Checkpoint**: User Stories 1 AND 2 complete — can navigate group hierarchies and read arrays within them

---

## Phase 5: User Story 3 — Read Array Slices (Priority: P2)

**Goal**: Read a subset of a Zarr array by specifying per-dimension slices, fetching only necessary chunks

**Independent Test**: Open chunked_2d fixture, request a sub-region, verify only correct subset returned with correct values

### Tests for User Story 3

- [x] T030 [P] [US3] Write unit tests for slice-to-chunk-index mapping (single index, range, null, multi-chunk spans) in tests/unit/indexing.test.ts
- [x] T031 [P] [US3] Write integration tests for slice reads (2D sub-region, single row, 3D single-index reduction) in tests/integration/array.test.ts (extend existing)

### Implementation for User Story 3

- [x] T032 [US3] Implement slice-to-chunk-index mapping (determine which chunks are needed, compute intra-chunk offsets) in src/chunk/indexing.ts (extend T023 logic)
- [x] T033 [US3] Update ZarrArray.get() to support Slice parameter: fetch only required chunks, extract requested elements, assemble result with correct shape in src/array.ts

**Checkpoint**: User Stories 1, 2, AND 3 complete — can read full arrays and slices from local filesystem

---

## Phase 6: User Story 4 — Read Array from HTTP Server (Priority: P2)

**Goal**: Read Zarr v2 data via HTTP GET with timeout, custom headers, and retry on transient failures

**Independent Test**: Serve fixture directory via local HTTP server, open via URL, read array, verify data

### Tests for User Story 4

- [x] T034 [P] [US4] Write HTTPStore contract test using store.contract.ts (with local HTTP test server) in tests/integration/http.test.ts
- [x] T035 [P] [US4] Write integration tests for HTTP reads (timeout, custom headers, retry on 429/503) in tests/integration/http.test.ts

### Implementation for User Story 4

- [x] T036 [US4] Implement HTTPStore (native fetch, AbortSignal.timeout, custom headers, retry 3x with exponential backoff on 429/503/network errors, list() throws UnsupportedOperationError) in src/store/http.ts
- [x] T037 [US4] Export HTTPStore and HTTPStoreOptions from src/index.ts

**Checkpoint**: User Story 4 complete — can read Zarr arrays from HTTP endpoints

---

## Phase 7: User Story 5 — Read Array from Amazon S3 (Priority: P3)

**Goal**: Read Zarr v2 data from S3 buckets using AWS SDK with custom endpoints and default credential chain

**Independent Test**: Read from S3 bucket via MinIO, verify correct data

### Tests for User Story 5

- [x] T038 [P] [US5] Write S3Store contract test using store.contract.ts (with MinIO test container) in tests/integration/s3.test.ts
- [x] T039 [P] [US5] Write integration tests for S3 reads (default credentials, custom endpoint, missing key error) in tests/integration/s3.test.ts

### Implementation for User Story 5

- [x] T040 [US5] Implement S3Store (dynamic import @aws-sdk/client-s3, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command with pagination, custom endpoint, retry 3x with backoff) in src/store/s3.ts
- [x] T041 [US5] Export S3Store and S3StoreOptions from src/index.ts

**Checkpoint**: User Story 5 complete — can read Zarr arrays from S3 and S3-compatible storage

---

## Phase 8: User Story 6 — Extensible Codec and Store Registry (Priority: P3)

**Goal**: Users can register custom codecs and pass custom stores without modifying library source

**Independent Test**: Register a mock codec and mock store, use them to open and read a Zarr array

### Tests for User Story 6

- [x] T042 [P] [US6] Write tests for custom codec registration and usage (register mock codec, read array using it, verify error for unregistered codec) in tests/unit/codec.test.ts (extend existing)
- [x] T043 [P] [US6] Write tests for custom store usage (pass mock store to open(), verify data read) in tests/integration/array.test.ts (extend existing)

### Implementation for User Story 6

- [x] T044 [US6] Ensure CodecRegistry.get() throws descriptive error naming missing codec ID and suggesting registration in src/codec/codec.ts
- [x] T045 [US6] Finalize public API exports in src/index.ts: Store, Codec, CodecFactory, CodecRegistry, CompressorConfig, ZarrArray, ZarrGroup, Slice, ReadOptions, TypedArray, all store classes and options, codecRegistry singleton, open, openArray, openGroup

**Checkpoint**: All user stories complete — full extensible Zarr v2 reader

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Validation, performance, and final quality checks

- [x] T046 Run full test suite against all Python-generated fixtures and verify 100% pass
- [x] T047 Validate quickstart.md code examples compile and run correctly
- [x] T048 [P] Verify error messages include context (file path, chunk coordinates, HTTP status, compressor ID) per SC-007
- [x] T049 [P] Performance validation: 100MB chunked array read from filesystem in < 2 seconds (SC-002)
- [x] T050 [P] Memory profiling: verify slice read of 1GB+ array stays under 100MB library overhead per SC-004

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational phase — MVP target
- **US2 (Phase 4)**: Depends on Foundational phase; benefits from US1 (open/openArray reuse) but independently testable
- **US3 (Phase 5)**: Depends on US1 (extends chunk indexing and ZarrArray.get)
- **US4 (Phase 6)**: Depends on Foundational phase; independent of US1-US3 (new store, same interfaces)
- **US5 (Phase 7)**: Depends on Foundational phase; independent of US1-US4 (new store, same interfaces)
- **US6 (Phase 8)**: Depends on Foundational phase; validates extensibility of existing interfaces
- **Polish (Phase 9)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: After Foundational — no dependencies on other stories
- **US2 (P1)**: After Foundational — may reuse open() from US1 but independently testable
- **US3 (P2)**: After US1 — extends indexing and ZarrArray from US1
- **US4 (P2)**: After Foundational — independent store implementation
- **US5 (P3)**: After Foundational — independent store implementation
- **US6 (P3)**: After Foundational — validates extensibility

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Interfaces/types before implementations
- Core logic before integration
- Story complete before moving to next priority

### Parallel Opportunities

- T003 + T004 can run in parallel (linting vs testing config)
- T008 + T009 can run in parallel (Store interface vs Codec interface)
- T011 + T012 + T013 can run in parallel (unit tests for different modules)
- T019 + T020 + T021 can run in parallel (all US1 test files)
- T030 + T031 can run in parallel (US3 unit + integration tests)
- T034 + T035 can run in parallel (US4 tests)
- T038 + T039 can run in parallel (US5 tests)
- T042 + T043 can run in parallel (US6 tests)
- US4 and US5 can run in parallel with each other (independent store implementations)

---

## Parallel Example: User Story 1

```bash
# Launch all US1 tests together (TDD — write first, expect failures):
Task: T019 "Store contract test suite in tests/contract/store.contract.ts"
Task: T020 "FileSystemStore contract test in tests/integration/filesystem.test.ts"
Task: T021 "Full-pipeline integration tests in tests/integration/array.test.ts"

# Then implement sequentially (dependencies):
Task: T022 "FileSystemStore in src/store/filesystem.ts"
Task: T023 "Chunk key resolution in src/chunk/indexing.ts"
Task: T024 "Chunk loader in src/chunk/loader.ts"
Task: T025 "ZarrArray class in src/array.ts"
Task: T026 "open/openArray/openGroup in src/index.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1 (local filesystem read)
4. **STOP and VALIDATE**: All fixtures read correctly, contract tests pass
5. This delivers: open a local Zarr v2 array and read it as TypedArray

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 → Local filesystem reads (MVP!)
3. US2 → Group navigation
4. US3 → Slice reads (extends US1)
5. US4 → HTTP reads (independent)
6. US5 → S3 reads (independent)
7. US6 → Extensibility validation
8. Polish → Performance + error quality

### Parallel Team Strategy

With multiple developers after Foundational is complete:

- Developer A: US1 → US3 (core pipeline + slicing)
- Developer B: US4 + US5 (remote stores, independent)
- Developer C: US2 + US6 (groups + extensibility)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- TDD: write tests first, verify they fail, then implement
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
