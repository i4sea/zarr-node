# Tasks: Efficient Polygon-Based Spatial Reading (Streaming bbox + mask)

**Input**: Design documents from `/specs/007-polygon-reader/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/polygon-reader.api.md, quickstart.md

**Tests**: INCLUDED — mandated by Constitution III (TDD, non-negotiable) and the spec's acceptance-scenario/test focus. Tests are written first (red) before their implementation.

**Organization**: Grouped by user story (US1–US4, priority order). All four stories are delivered inside one new module (`src/spatial/polygon-reader.ts`) plus its test file — so within-module edits across stories are **sequential** (same files), while distinct test additions and doc/setup work are marked `[P]` where they touch different files.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1 / US2 / US3 / US4
- Exact file paths included per task

## Path Conventions

Single-project library. Source in `src/spatial/`, tests in `tests/unit/`. Public export via the `@i4sea/zarr-node/spatial` subpath (`src/spatial/index.ts`) — NOT root `src/index.ts` (research D1).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new module skeleton and wire the public export so everything else compiles.

- [X] T001 Create `src/spatial/polygon-reader.ts` with the public type surface (no logic yet): `SpatialLayout` union, `PolygonReadOptions`, `PolygonCell`, `PolygonBBox`, `PolygonSelection`, `PolygonTimestep`, and stub signatures `resolvePolygonCells(arr, opts): PolygonSelection` (throws "not implemented") and `async function* readPolygon(arr, opts): AsyncGenerator<PolygonTimestep>` (empty). Types must match `specs/007-polygon-reader/contracts/polygon-reader.api.md` exactly, no `any`.
- [X] T002 Re-export the new public API from `src/spatial/index.ts`: `readPolygon`, `resolvePolygonCells`, and `export type { SpatialLayout, PolygonReadOptions, PolygonCell, PolygonBBox, PolygonSelection, PolygonTimestep }`.
- [X] T003 Create `tests/unit/polygon-reader.test.ts` with the Vitest scaffold (imports from `../../src/spatial/index.js`) and a shared fixtures/helpers block mirroring `tests/unit/grid-index.test.ts` style: a `makeArray(shape, chunks, dtype, filler)` helper backed by an in-memory `Store`, and a `CountingStore`/observability counter helper for chunk-decode assertions.

**Checkpoint**: Module compiles, exports resolve, test file runs (all pending/failing) — `npm run build` type-checks.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The geometry + validation primitives every user story depends on. MUST complete before US1–US4.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Write failing unit tests for the ray-casting point-in-polygon primitive in `tests/unit/polygon-reader.test.ts`: convex inside/outside, concave notch (bbox-inside but polygon-outside excluded), on-edge and on-vertex points, and closed-ring == unclosed-ring equivalence (FR-002, FR-014, SC-003, SC-006).
- [X] T005 Implement the internal `pointInPolygon(lat, lon, ring)` even-odd ray-casting helper in `src/spatial/polygon-reader.ts` (implicit ring closure; `(yi>y)!==(yj>y)` edge rule) to pass T004 (research D3).
- [X] T006 [P] Write failing unit tests for input validation in `tests/unit/polygon-reader.test.ts`: polygon with < 3 distinct vertices → `SliceError`; reversed/out-of-range `timeRange` → `SliceError`; `maxCells < 1` → `SliceError`; BigInt coordinate dtype rejected (FR-018, research D8).
- [X] T007 Implement internal validation helpers in `src/spatial/polygon-reader.ts` (reusing `SliceError` from `../errors.js`): ring-vertex-count, `timeRange` bounds against `arr.shape[timeAxis]`, `maxCells`, and coordinate-dtype guard (mirror `GridIndex.numericCoords`) to pass T006.

**Checkpoint**: Geometry + validation verified in isolation — user-story phases can begin.

---

## Phase 3: User Story 1 — Stream cells inside a polygon per time step (Priority: P1) 🎯 MVP

**Goal**: `readPolygon` streams, per time step, only the in-polygon cell values in row-major order, with the time-invariant selection exposed; sub-range and ring-closure honored.

**Independent Test**: Small `[time, rows, cols]` array + concave polygon; iterate; assert each timestep holds exactly the in-polygon values in stable row-major order, positions returned once, `timeRange` respected, closed==unclosed (spec US1 acceptance scenarios).

- [X] T008 [P] [US1] Write failing tests in `tests/unit/polygon-reader.test.ts` for `resolvePolygonCells` on a **2-D array with a directly-supplied grid** (defer full layout matrix to US3): correct in-polygon `cells`, row-major ordering, `bbox` half-open bounds, per-cell `lat/lon`, and empty `cells` for an out-of-grid polygon (FR-003, FR-008, FR-009, FR-017, clarification Q1).
- [X] T009 [US1] Implement the bbox computation + row-major mask gather in `src/spatial/polygon-reader.ts` producing `PolygonSelection` (cells row-major over bbox, `stride: 1`), used by `resolvePolygonCells`, to pass T008.
- [X] T010 [P] [US1] Write failing tests in `tests/unit/polygon-reader.test.ts` for `readPolygon` streaming: one `PolygonTimestep` per index ascending; `values` (`Float64Array`) aligned to `resolvePolygonCells().cells`; `timeRange` sub-range yields exactly those steps in order; empty selection completes with zero yields; reversed range throws (FR-001, FR-004, FR-007, FR-017, research D6).
- [X] T011 [US1] Implement `readPolygon` streaming loop in `src/spatial/polygon-reader.ts`: resolve selection once, then for each `t` in `timeRange` call `arr.get([t, [rMin,rMax], [cMin,cMax]], readOptions)`, gather masked cells into a `Float64Array` in cell order, `yield { t, values }` (FR-001–FR-004, research D2/D6/D7) to pass T010.
- [X] T012 [US1] Wire `readOptions` pass-through (memoryCache/concurrency/maxInFlightBytes/observability) into the per-timestep `arr.get` calls in `src/spatial/polygon-reader.ts`; create an internal per-call `MemoryCache` when none supplied (FR-016, research D2).

**Checkpoint**: MVP complete — an area can be read efficiently per time step. US1 tests green; `npm test && npm run lint` pass.

---

## Phase 4: User Story 2 — Efficient, memory-bounded reads (Priority: P1)

**Goal**: Each bbox-overlapping chunk is downloaded/decompressed at most once; peak working memory tracks one time slice regardless of time extent.

**Independent Test**: Instrument chunk decode on a multi-chunk-bbox, many-timestep array; assert each covered chunk decoded exactly once and memory bounded to one slice (spec US2 acceptance scenarios, SC-001/SC-002).

- [X] T013 [P] [US2] Write failing tests in `tests/unit/polygon-reader.test.ts` using the `CountingStore`/`observability.onChunkDecoded` helper: over a full `readPolygon` on a `[fullTime, tile, tile]`-chunked array whose bbox spans multiple chunks, assert distinct-chunk-decode count == number of bbox-overlapping chunks and 0 re-decodes across all timesteps (FR-005, SC-001).
- [X] T014 [P] [US2] Write failing test in `tests/unit/polygon-reader.test.ts` asserting memory-bound behavior: reading 10× more timesteps does not grow per-timestep allocation beyond a one-slice constant (assert `values.length == cells.length` each step and no accumulation of prior slices; peak in-flight bytes tracked via `observability.onInFlightBytes`) (FR-006, SC-002).
- [X] T015 [US2] Verify/adjust the streaming implementation in `src/spatial/polygon-reader.ts` so the shared `MemoryCache` (from T012) is passed to every per-`t` `arr.get`, guaranteeing chunk reuse across timesteps; ensure no full-time-range materialization and no retention of prior slices (FR-005, FR-006, research D2) to pass T013–T014.

**Checkpoint**: Performance + memory guarantees verified. US1 and US2 tests green.

---

## Phase 5: User Story 3 — Resolve polygon cells for three coordinate layouts (Priority: P2)

**Goal**: `resolvePolygonCells` (and thus `readPolygon`) supports 1d-rectilinear, 2d-curvilinear (via `GridIndex`), and npoints layouts.

**Independent Test**: For each layout, given coordinates + polygon, assert resolved cell set, bbox, and per-cell lat/lon are correct (spec US3 acceptance scenarios, SC-004).

- [X] T016 [P] [US3] Write failing tests in `tests/unit/polygon-reader.test.ts` for the **1d-rectilinear** layout: bbox via binary search on monotonic lat/lon axes, in-polygon cells, positions `(lat[i], lon[j])` (FR-010, SC-004).
- [X] T017 [US3] Implement the `{ kind: "1d" }` branch in `src/spatial/polygon-reader.ts`: binary-search bbox on the monotonic axes, mask, position lookup, to pass T016 (research D4).
- [X] T018 [P] [US3] Write failing tests in `tests/unit/polygon-reader.test.ts` for the **2d-curvilinear** layout backed by a real `GridIndex` (built via `GridIndex.fromCoordinates`): envelope-corner bbox + padding, mask resolves exact membership, positions from grid (FR-011, SC-004).
- [X] T019 [US3] Implement the `{ kind: "2d" }` branch in `src/spatial/polygon-reader.ts`: derive bbox from `grid.nearest()` on polygon-envelope corners with 1–2 cell padding, mask via per-cell grid lat/lon, to pass T018 (research D4, FR-011).
- [X] T020 [P] [US3] Write failing tests in `tests/unit/polygon-reader.test.ts` for the **npoints** layout: flat point-in-polygon filter, `i`=point index / `j`=0, degenerate bbox `[0,nPoints)`×`[0,1)`, positions per point (FR-010, SC-004).
- [X] T021 [US3] Implement the `{ kind: "npoints" }` branch in `src/spatial/polygon-reader.ts` (flat filter + single-spatial-axis `arr.get` selection in the streaming loop) to pass T020 (research D4/D7).

**Checkpoint**: All three layouts verified. US1–US3 tests green.

---

## Phase 6: User Story 4 — Adaptive cap on very large selections (Priority: P3)

**Goal**: When bbox cell count exceeds `maxCells`, apply a clamped uniform stride (stride-then-mask), report the factor; no default cap.

**Independent Test**: Set `maxCells` below in-box count; assert returned cell count ≤ budget, cells spread across the area, `stride` reported; single-cell polygon never sub-samples to zero (spec US4 acceptance scenarios, SC-005).

- [X] T022 [P] [US4] Write failing tests in `tests/unit/polygon-reader.test.ts`: bbox exceeds `maxCells` → `cells.length ≤ maxCells`, cells distributed (not corner-clustered), `stride > 1` reported; within budget or unset → `stride == 1`, all in-polygon cells; single-cell polygon with tiny `maxCells` → still 1 cell (clamp) (FR-012, FR-013, SC-005, clarification Q3).
- [X] T023 [US4] Implement stride computation + application in `src/spatial/polygon-reader.ts`: smallest integer `s` with `ceil(rows/s)*ceil(cols/s) ≤ maxCells`, decimate bbox grid first, then mask; clamp `s` down until ≥1 in-polygon cell survives; set `PolygonSelection.stride`; npoints uses single-axis stride, to pass T022 (research D5).

**Checkpoint**: Adaptive cap verified. All user stories complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finalize public surface, docs, versioning, and full-suite validation.

- [X] T024 [P] Add TSDoc comments to all exported symbols in `src/spatial/polygon-reader.ts` (function summaries, param/return docs, and the FR/behavior notes from the contract), matching `grid-index.ts` documentation density.
- [X] T025 [P] Add a runnable usage example to the package docs/README (or `examples/`) based on `specs/007-polygon-reader/quickstart.md` (2-D curvilinear stream + `resolvePolygonCells`), importing from `@i4sea/zarr-node/spatial`.
- [X] T026 [P] Add a changeset entry under `.changeset/` describing the new `readPolygon`/`resolvePolygonCells` spatial API as a **minor** bump (0.8.0 → 0.9.0); update CHANGELOG per project workflow (Constitution VI).
- [X] T027 Bump `version` in `package.json` to `0.9.0`.
- [X] T028 Run full quality gate: `npm test && npm run lint` (and `npm run build` for type-check). Confirm existing point-read / `grid-index` suites remain green — no regression (FR-020, SC-008). Fix any failures.

**Checkpoint**: Feature done — publishable minor, all guarantees (SC-001…SC-008) verified, no regressions.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → blocks everything.
- **Foundational (P2)** → blocks all user stories (geometry + validation are shared).
- **US1 (P3)** → depends on P2. The MVP. Delivers `resolvePolygonCells` + `readPolygon` for a supplied grid.
- **US2 (P4)** → depends on US1 (verifies/hardens the same streaming loop). Co-equal P1 priority but sequenced after US1 because it tests US1's mechanism.
- **US3 (P5)** → depends on US1 (extends layout resolution). Independent of US2/US4.
- **US4 (P6)** → depends on US1 (extends the resolution/selection step). Independent of US2/US3.
- **Polish (P7)** → depends on all user stories.

### Story independence

US2, US3, US4 each build on the US1 core but are independent of each other — once US1 lands, they can proceed in any order. Because all implementation edits target the single file `src/spatial/polygon-reader.ts`, cross-story *implementation* tasks are effectively sequential; their *test* tasks (different `describe` blocks, and could be split into files) are marked `[P]`.

### Within-story parallelism

- Test-authoring tasks marked `[P]` (T004/T006, T008/T010, T013/T014, T016/T018/T020, T022) can be written concurrently — distinct test blocks.
- Implementation tasks on `polygon-reader.ts` (T005, T007, T009, T011, T012, T015, T017, T019, T021, T023) are sequential (same file).
- Polish tasks T024/T025/T026 are `[P]` (different files); T027 then T028 run last.

### Parallel execution example (Foundational phase)

```text
# Author both failing test groups together (different describe blocks):
T004  [P]  ray-casting point-in-polygon tests
T006  [P]  input-validation tests
# Then implement sequentially in polygon-reader.ts:
T005 → T007
```

---

## Implementation Strategy

- **MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: an efficient per-timestep area read for a supplied 2-D grid. Independently shippable and testable.
- **Incremental delivery**: US2 hardens/verifies performance → US3 broadens to all three layouts → US4 adds the safety cap. Each phase leaves the suite green and the API additive.
- **TDD throughout** (Constitution III): every implementation task is preceded by a failing-test task in the same phase.
- **Ship**: after Phase 7, publish minor 0.9.0 to GitHub Packages; downstream (nautilus) bumps its pin (spec acceptance criterion — out of this repo's tasks).

## Task summary

- **Total**: 28 tasks
- **Setup**: 3 (T001–T003) · **Foundational**: 4 (T004–T007)
- **US1**: 5 (T008–T012) · **US2**: 3 (T013–T015) · **US3**: 6 (T016–T021) · **US4**: 2 (T022–T023)
- **Polish**: 5 (T024–T028)
- **Test tasks**: T004, T006, T008, T010, T013, T014, T016, T018, T020, T022 (10 — TDD, each precedes its implementation)
- **Parallel opportunities**: all `[P]`-marked test-authoring and the polish doc/changeset tasks
