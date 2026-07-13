# Research: Polygon-Based Spatial Reading

**Feature**: 007-polygon-reader | **Date**: 2026-07-13

All spec-level `[NEEDS CLARIFICATION]` markers were resolved in `/speckit.clarify` (cell ordering, default cell budget, stride/mask interaction) and in `/speckit.specify` (antimeridian scope). This document consolidates the remaining **technical** decisions that shape implementation.

---

## D1. Export location — spatial subpath, not root index

- **Decision**: Add `readPolygon` / `resolvePolygonCells` to `src/spatial/polygon-reader.ts` and re-export from `src/spatial/index.ts`. Do **not** touch `src/index.ts`.
- **Rationale**: The library publishes spatial helpers as a dedicated subpath export `@i4sea/zarr-node/spatial` (`package.json` → `exports["./spatial"]`), the same pattern `GridIndex` follows. Consumers import `{ readPolygon } from "@i4sea/zarr-node/spatial"`.
- **Alternatives considered**: Root `src/index.ts` export (as the issue's prose literally says) — rejected: inconsistent with the existing `GridIndex` placement and the established subpath convention. FR-019 ("exposed from the public entry point alongside existing spatial capabilities") is satisfied by the spatial barrel.

## D2. Chunk-read-once + memory bounding mechanism

- **Decision**: Read the selection as **per-time-step bbox blocks** — for each `t` in range, call `arr.get([t, [rMin,rMax], [cMin,cMax]], readOptions)` — passing a **single shared `MemoryCache`** across all those calls (default one created internally if the caller doesn't supply one via `readOptions.memoryCache`).
- **Rationale**: With the typical `[fullTime, tile, tile]` chunking, the chunk covering `(t, rows, cols)` also covers every other `t'` in that spatial tile. The first `t` decodes the chunk into `MemoryCache`; subsequent `t'` reads hit the cache (`onCacheHit`) and never re-fetch/re-decode the store — satisfying FR-005 / SC-001. Because each `get` materializes only one time slice of the bbox block, peak working memory tracks one slice, not `time × cells` — satisfying FR-006 / SC-002.
- **Alternatives considered**:
  - Single `arr.get([[t0,t1], [rMin,rMax], [cMin,cMax]])` for the whole time range — rejected: materializes `time × bboxCells` in RAM, violating FR-006 for large time axes.
  - Manual chunk iteration below `ZarrArray` — rejected: reimplements decode/limiter/observability that `get` already provides (YAGNI, Principle VII).
- **Note on cache scope**: The internal default `MemoryCache` is created per `readPolygon` call and discarded when the generator completes, so it does not retain chunk bytes beyond the read. A caller-supplied cache is honored and lives as long as the caller keeps it.

## D3. Point-in-polygon algorithm

- **Decision**: Even-odd **ray-casting** (crossing-number) test in lat/lon space, computed once over the bbox (or npoints list) to build a boolean mask. Ring treated as implicitly closed; a horizontal ray with the standard `(yi > y) !== (yj > y)` edge rule handles concavity and holes-via-notch.
- **Rationale**: Standard, dependency-free, O(vertices) per cell, correct for concave rings (FR-002, SC-003). Matches spec Assumption ("ray casting; self-intersecting polygons unsupported").
- **Alternatives considered**: Winding number — equivalent result for simple polygons, marginally more work; rejected for simplicity. External geometry lib — rejected (adds a runtime dependency; Constitution IV/VII).

## D4. Coordinate → index resolution per layout

- **Decision**: A discriminated-union `spatialLayout` input with three variants:
  - **1d-rectilinear** `{ kind: "1d", lat: ArrayLike<number>, lon: ArrayLike<number> }`: bbox via binary search on the (monotonic) axes for the polygon's lat/lon extent; per-cell position is `(lat[i], lon[j])`.
  - **2d-curvilinear** `{ kind: "2d", grid: GridIndex }` (or lat/lon 2-D arrays from which one is built): bbox from `grid.nearest()` on the polygon-envelope corners plus 1–2 cell padding; mask resolves exact membership; position is `(lat[i*nx+j], lon[i*nx+j])`.
  - **npoints** `{ kind: "npoints", lat: ArrayLike<number>, lon: ArrayLike<number> }`: no bbox in 2-D index space — filter the flat point list by point-in-polygon; the "bbox" degenerates to `[0, nPoints)` on the single spatial axis.
- **Rationale**: Directly mirrors FR-010/FR-011 and reuses `GridIndex` for the hard (curvilinear) case (FR-011). Binary search assumes monotonic axes (documented). Padding guards against envelope-corner nearest misses on skewed grids.
- **Alternatives considered**: Auto-detecting layout from array/group metadata — deferred (YAGNI); the caller knows its layout and passes it explicitly, keeping the helper domain-neutral. Consolidating with the nautilus point resolver — explicitly out of scope (spec Phase 2).

## D5. Stride (adaptive cap) semantics

- **Decision**: If `maxCells` is set and the bbox cell count exceeds it, compute an integer stride `s` (same for rows and cols in 2-D; single-axis in npoints) as the smallest `s` with `ceil(rows/s) * ceil(cols/s) <= maxCells`. Apply stride to the **bbox grid first** (keep indices `rMin, rMin+s, …` / `cMin, cMin+s, …`), then apply the polygon mask to survivors. Clamp: if the strided+masked set would be empty while ≥1 in-polygon cell exists at stride 1, reduce `s` until ≥1 in-polygon cell survives. Report the applied `s` as `stride` in the resolution output.
- **Rationale**: Implements the clarified FR-012 exactly (stride-then-mask, clamped non-zero, factor reported). Uniform decimation preserves spatial coverage (SC-005). No default — `maxCells` unset ⇒ `stride = 1`, all in-polygon cells (FR-013).
- **Alternatives considered**: Mask-then-decimate (Option B in clarify) — rejected by user; irregular index-space pattern. Per-axis independent stride — unnecessary; uniform `s` keeps aspect coverage even.

## D6. Value dtype normalization

- **Decision**: `PolygonTimestep.values` is a `Float64Array` holding the in-polygon cells' values for that time step, in row-major cell order. The underlying `TypedArray` returned by `get` is copied into `Float64Array` at the mask-gather step.
- **Rationale**: The consumer's use case is spatial statistics (median/min/max), which operate in float space; a single normalized numeric type keeps the streaming contract simple and avoids leaking per-array dtype generics into the aggregation boundary. Fill/missing values pass through as their numeric value (or `NaN`) so the consumer applies its own missing-value policy (spec edge case). 64-bit **integer** dtypes (BigInt arrays) are rejected with a clear error, consistent with `GridIndex.numericCoords`.
- **Alternatives considered**: Generic `TypedArray` values preserving source dtype — rejected: the gather step already copies (masking is not contiguous), and downstream median/percentile math is float anyway; the generic adds friction with no consumer benefit here. This is a deliberate, documented boundary narrowing, not an `any`-style escape (Constitution II).

## D7. Time axis handling

- **Decision**: `timeAxis?: number` (default `0`). The read builds a selection with a scalar index at `timeAxis` and `[min,max]` ranges on the two spatial axes. v1 supports `timeAxis` at position 0 or the leading axis with exactly two trailing spatial axes for 2-D layouts (npoints: one trailing spatial axis). Non-leading time axis with interleaved spatial axes is out of scope.
- **Rationale**: Matches FR-015 and the `[time, ...spatial]` assumption. Keeps selection construction simple.
- **Alternatives considered**: Arbitrary axis permutations — YAGNI; not in the stated use cases.

## D8. Input validation & errors

- **Decision**: Reuse `SliceError` (from `src/errors.ts`) for invalid inputs: polygon with < 3 distinct vertices; reversed/invalid `timeRange` (`end < start`, out of `[0, nTime]`); `maxCells < 1`; unsupported layout shape; BigInt coordinate dtype. Empty selection (polygon outside grid, or empty `timeRange`) is **not** an error — the generator completes yielding nothing and `resolvePolygonCells` returns `cells: []`.
- **Rationale**: FR-017 (empty ⇒ clean completion) and FR-018 (invalid ⇒ clear error). Reusing the existing error class keeps the taxonomy consistent (no new error type needed — YAGNI).
- **Alternatives considered**: A dedicated `PolygonError` — rejected; `SliceError` already models "bad selection input" and is exported.

## D9. Testing strategy (TDD)

- **Decision**: `tests/unit/polygon-reader.test.ts`, tests-first, mirroring `grid-index.test.ts` fixture style. Cases:
  1. Point-in-polygon: convex, concave, notch/hole, on-edge/on-vertex, unclosed==closed ring.
  2. Per-layout bbox + positions: 1d-rectilinear, 2d-curvilinear (via `GridIndex`), npoints.
  3. Stride: exceeds `maxCells` ⇒ within budget & spread; clamp keeps single-cell polygon non-empty; unset ⇒ stride 1.
  4. Streaming order: values row-major, identical order across all timesteps and to `resolvePolygonCells`; `timeRange` sub-range; empty selection completes cleanly.
  5. Chunk-read-once + memory: an instrumented in-memory `Store` (or `observability.onCacheHit`/`onChunkDecoded` counters) asserts each bbox chunk decoded once across a multi-timestep read.
- **Rationale**: Covers every acceptance scenario and SC-001…SC-008. Instrumented store is the concrete mechanism for the "chunk once" and memory-bound assertions.
- **Alternatives considered**: Integration test against a real S3 fixture — deferred to the nautilus consumer (Issue B); unit-level instrumentation is sufficient and hermetic for this library's guarantees.

---

## Summary of decisions

| ID | Decision |
|----|----------|
| D1 | Export via `src/spatial/index.ts` (subpath `@i4sea/zarr-node/spatial`), not root |
| D2 | Per-timestep bbox `get` + shared `MemoryCache` → chunk-once + one-slice memory |
| D3 | Ray-casting even-odd mask, computed once, implicit ring closure |
| D4 | Discriminated `spatialLayout` union: 1d (binary search), 2d (`GridIndex`), npoints (flat filter) |
| D5 | Stride-then-mask, uniform integer stride, clamped non-zero, factor reported |
| D6 | `values` normalized to `Float64Array`; BigInt dtypes rejected |
| D7 | `timeAxis` default 0, `[time, ...spatial]` layout |
| D8 | Reuse `SliceError`; empty selection is not an error |
| D9 | TDD unit suite with instrumented store for perf/memory guarantees |
