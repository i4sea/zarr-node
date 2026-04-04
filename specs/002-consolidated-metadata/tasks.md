# Tasks: Consolidated Metadata (.zmetadata)

**Input**: Design documents from `/specs/002-consolidated-metadata/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Tests**: Included — TDD is a constitution principle (III).

**Organization**: Tasks grouped by user story. This is a focused optimization — fewer tasks than feature 001.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

## Phase 1: Foundational

**Purpose**: Core consolidated metadata parser and test fixture

- [x] T001 Generate consolidated metadata test fixture by adding .zmetadata to tests/fixtures/nested_groups/ (Python script or manual JSON)
- [x] T002 Write unit tests for consolidated metadata parser (valid .zmetadata, malformed JSON, missing "metadata" key, empty metadata) in tests/unit/consolidated.test.ts
- [x] T003 Implement ConsolidatedMetadata class (parse .zmetadata JSON, get/has/listChildren methods) in src/metadata/consolidated.ts

**Checkpoint**: Parser working — can parse .zmetadata and lookup entries by key

---

## Phase 2: User Story 1 — Fast Group Discovery (Priority: P1) MVP

**Goal**: Groups with .zmetadata serve all metadata from cache, eliminating per-file store requests

**Independent Test**: Open a fixture with .zmetadata, list arrays, verify results match and no extra store calls

### Tests for User Story 1

- [x] T004 [P] [US1] Write integration tests for consolidated group discovery (open group with .zmetadata, list arrays, verify all found, verify getArray uses cache) in tests/integration/consolidated.test.ts
- [x] T005 [P] [US1] Write test verifying consolidated metadata reduces store calls (mock store that counts get/has calls) in tests/integration/consolidated.test.ts
- [x] T005b [P] [US1] Write test for FR-005 partial cache miss: .zmetadata present but missing one array entry, verify that array is still accessible via per-file fallback in tests/integration/consolidated.test.ts

### Implementation for User Story 1

- [x] T006 [US1] Modify openGroupFromMeta() in src/index.ts to attempt store.get(".zmetadata"), parse if present, pass ConsolidatedMetadata to ZarrGroup constructor
- [x] T007 [US1] Modify ZarrGroup constructor in src/group.ts to accept optional ConsolidatedMetadata parameter
- [x] T008 [US1] Modify ZarrGroup.getArray() and getGroup() in src/group.ts to check consolidated cache before store.get() for .zarray/.zgroup/.zattrs keys
- [x] T009 [US1] Modify ZarrGroup.arrays() and groups() in src/group.ts to use consolidatedMeta.listChildren() when cache available, falling back to store.list() + discover
- [x] T010 [US1] Modify ZarrGroup.contains() in src/group.ts to check consolidated cache first

**Checkpoint**: US1 complete — groups with .zmetadata list arrays via single cached fetch

---

## Phase 3: User Story 2 — Transparent Fallback (Priority: P1)

**Goal**: Stores without .zmetadata work identically to current behavior

**Independent Test**: Run all existing tests (which have no .zmetadata) and verify they still pass

### Tests for User Story 2

- [x] T011 [US2] Verify all existing tests pass without modification (backward compatibility) by running full test suite

### Implementation for User Story 2

- [x] T012 [US2] Ensure openGroupFromMeta() in src/index.ts handles store.get(".zmetadata") returning null gracefully (pass null cache to ZarrGroup)
- [x] T013 [US2] Ensure open() in src/index.ts also loads .zmetadata when opening a root group (not just openGroup)

**Checkpoint**: US2 complete — no regression, stores without .zmetadata behave identically

---

## Phase 4: User Story 3 — Deep Group Hierarchy (Priority: P2)

**Goal**: Sub-groups share the consolidated cache from root, zero extra metadata requests for hierarchy traversal

**Independent Test**: Open nested_groups fixture with .zmetadata, traverse full tree, verify all metadata from cache

### Tests for User Story 3

- [x] T014 [US3] Write integration test for nested group traversal with consolidated metadata (root → level1 → level2, getArray at each level, verify cache shared) in tests/integration/consolidated.test.ts

### Implementation for User Story 3

- [x] T015 [US3] Modify ZarrGroup.getGroup() in src/group.ts to pass consolidated cache to child ZarrGroup instances
- [x] T016 [US3] Modify ZarrGroup.getArray() in src/group.ts to use consolidated cache for child array metadata (prefix child path when looking up keys)

**Checkpoint**: US3 complete — full hierarchy traversal uses single .zmetadata load

---

## Phase 5: Polish & Validation

**Purpose**: End-to-end validation with real remote data

- [x] T017 Run full test suite and verify all tests pass (existing + new)
- [x] T018 Benchmark: list arrays on S3 WRF dataset with consolidated metadata, verify < 2 seconds (SC-001)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately
- **US1 (Phase 2)**: Depends on Phase 1 (parser must exist) — MVP target
- **US2 (Phase 3)**: Depends on US1 — validates backward compatibility
- **US3 (Phase 4)**: Depends on US1 — extends cache sharing to sub-groups
- **Polish (Phase 5)**: Depends on all user stories complete

### Parallel Opportunities

- T004 + T005 can run in parallel (different test aspects)
- US2 and US3 are independent of each other (both depend on US1)

---

## Implementation Strategy

### MVP First (User Story 1)

1. Complete Phase 1: Parser + fixture
2. Complete Phase 2: Consolidated group discovery
3. **STOP and VALIDATE**: Arrays listed from cache, single request

### Incremental Delivery

1. Parser + fixture → foundation
2. US1 → Fast group listing (MVP!)
3. US2 → Backward compatibility confirmed
4. US3 → Deep hierarchy support
5. Polish → S3 benchmark validation
