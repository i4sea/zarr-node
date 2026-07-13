# Feature Specification: Efficient Polygon-Based Spatial Reading (Streaming bbox + mask)

**Feature Branch**: `007-polygon-reader`  
**Created**: 2026-07-13  
**Status**: Draft  
**Input**: User description: "https://github.com/i4sea/i4sea-aurora-ui/issues/1048"

## Overview

Consumers of the library today read forecast data at **individual points** and rely on a nearest-neighbour grid lookup. A growing class of consumers needs to read **every grid cell that falls inside an arbitrary geographic area (a polygon)** over a range of time steps — for example, to later compute spatial statistics (median/min/max) across an area for each time step.

Reading such an area cell-by-cell is prohibitively slow: the unit of storage I/O is a *chunk* (which typically spans the full time axis and a large spatial tile), so a point read already downloads and decompresses a whole chunk. Reading N cells one at a time re-decompresses the same chunks N times.

This feature provides a generic, domain-neutral helper that, given an array laid out as `[time, ...spatial]` and a lat/lon polygon, **streams data one time step at a time**, delivering **only the cells inside the polygon** (not merely its bounding box), while downloading/decompressing **each chunk at most once** and keeping working memory bounded to roughly one time slice. The intelligence of *spatial I/O* lives here; downstream *aggregation* (statistics over the returned cells) is explicitly out of scope and remains the consumer's responsibility.

## Clarifications

### Session 2026-07-13

- Q: What is the canonical ordering of the selected cells (which per-timestep values align to)? → A: Row-major over the bounding box (iterate rows, then columns), keeping only in-polygon cells.
- Q: What is the default cell-budget behaviour when the consumer does not configure one? → A: No default cap — all in-polygon cells are returned unless the consumer explicitly sets a cell budget. Per-timestep memory stays bounded regardless (FR-006).
- Q: When sub-sampling triggers, how do the stride and the polygon mask interact (ordering + zero-result safety)? → A: Stride decimates the bounding-box grid uniformly first, then the polygon mask is applied to the surviving cells; the stride is clamped so a non-empty polygon never sub-samples to zero in-polygon cells.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stream cells inside a polygon per time step (Priority: P1)

A consumer has a forecast array shaped `[time, ...spatial]` and a polygon describing a geographic area. They want to iterate over time and, for each time step, receive the values of only the grid cells that lie inside the polygon, together with those cells' positions (lat/lon), so they can build any per-area computation themselves.

**Why this priority**: This is the core capability the feature exists to provide. Without it, there is no area read at all. It is the MVP: delivering just this story lets a consumer read an area efficiently.

**Independent Test**: Provide a small array and a concave polygon; iterate the reader; assert that every returned time step contains exactly the values of the cells geometrically inside the polygon (and no cells outside it), that the cell metadata (positions) is returned once and is invariant across time steps, and that the value ordering matches the cell ordering.

**Acceptance Scenarios**:

1. **Given** an array `[time, rows, cols]` and a convex polygon covering a known set of cells, **When** the consumer iterates the reader, **Then** each yielded time step contains exactly the values of the in-polygon cells, in a stable order matching the reported cell list.
2. **Given** a **concave** polygon (or a polygon with an interior hole/notch), **When** the consumer iterates the reader, **Then** cells that fall inside the bounding box but outside the true polygon are excluded from every time step.
3. **Given** a polygon and a time sub-range, **When** the consumer iterates, **Then** exactly the time steps within that range are yielded, in order.
4. **Given** a polygon whose ring is provided unclosed (last point ≠ first point), **When** the consumer iterates, **Then** the result is identical to providing the same ring closed.

---

### User Story 2 - Efficient, memory-bounded reads over large chunked arrays (Priority: P1)

A consumer reads an area from a large, chunked array stored remotely, where each chunk spans the entire time axis and a large spatial tile. They need the read to be fast and to not exhaust memory, regardless of how many time steps the array has.

**Why this priority**: The feature's justification is performance and bounded memory. A correct-but-slow or correct-but-memory-unbounded implementation would defeat the purpose and would not be adopted by consumers. This is co-equal P1 with Story 1.

**Independent Test**: Instrument chunk access on a backing store, run a polygon read whose bounding box spans several chunks over many time steps, and assert (a) each covered chunk is fetched/decompressed at most once for the whole read, and (b) peak working memory scales with one time slice of the bounding box, not with `time × cells`.

**Acceptance Scenarios**:

1. **Given** an array whose bounding box for a polygon spans multiple chunks, **When** the consumer completes a full read, **Then** each covered chunk is downloaded and decompressed at most once.
2. **Given** an array with a large time axis, **When** the consumer streams all time steps, **Then** working memory stays bounded to roughly one time slice of the bounding-box block and does not grow proportionally to the number of time steps.
3. **Given** the reader consumes the same chunk data across many time steps, **When** reading, **Then** it reuses already-decompressed chunk data rather than re-reading the store.

---

### User Story 3 - Resolve polygon cells for three coordinate layouts (Priority: P2)

A consumer needs to know *which* cells a polygon selects and where they are, independently of reading values — for example to inspect coverage, or to reuse the selection metadata. The array's coordinates may be described in one of three layouts: a 1-D rectilinear axis pair, a 2-D curvilinear grid, or an unstructured list of points.

**Why this priority**: Exposing the resolution step separately makes the selection inspectable and testable on its own and supports consumers that want positions without values. It builds directly on the coordinate handling required by Story 1 but is a distinct, independently valuable capability.

**Independent Test**: For each of the three layouts, provide coordinates and a polygon and assert the resolved cell set, bounding box, and per-cell lat/lon positions are correct.

**Acceptance Scenarios**:

1. **Given** a 1-D rectilinear layout (separate monotonic lat and lon axes), **When** the consumer resolves cells for a polygon, **Then** the returned cells, bounding box, and positions correspond to the axis cells inside the polygon.
2. **Given** a 2-D curvilinear layout, **When** the consumer resolves cells, **Then** the bounding box is derived from the grid and the returned cells are exactly those inside the polygon.
3. **Given** an unstructured points layout, **When** the consumer resolves cells, **Then** the returned cells are exactly the flat points inside the polygon, each with its position.
4. **Given** any layout, **When** cells are resolved, **Then** each returned cell reports both its spatial index (or indices) and its lat/lon position.

---

### User Story 4 - Adaptive cap on very large selections (Priority: P3)

A consumer selects a very large area whose bounding box would contain more cells than they want to process. They want the reader to automatically sub-sample the selection to stay within a cell budget while still covering the whole area.

**Why this priority**: A safety valve for pathological selections. Valuable for robustness but not required for the primary flow; most real selections stay under any reasonable budget.

**Independent Test**: Set a cell budget below the polygon's in-box cell count; resolve/read; assert the returned cell count does not exceed the budget and that the retained cells remain spread across the area (regular sub-sampling), with the applied sub-sampling factor reported.

**Acceptance Scenarios**:

1. **Given** a polygon whose bounding box cell count exceeds the configured cell budget, **When** the consumer resolves or reads, **Then** a spatial sub-sampling factor is applied so the returned cell count stays within the budget.
2. **Given** a polygon whose in-box cell count is within the budget, **When** the consumer resolves or reads, **Then** no sub-sampling is applied and all in-polygon cells are returned.
3. **Given** sub-sampling is applied, **When** the consumer inspects the result, **Then** the applied sub-sampling factor is reported alongside the cells.

---

### Edge Cases

- **Polygon entirely outside the grid**: the reader yields no cells (empty selection); streaming completes with zero cells reported and no time steps carrying values, rather than erroring.
- **Polygon selects a single cell / degenerate area**: the reader returns that one cell; streaming yields one value per time step. Even with an aggressive cell budget, the stride is clamped so this single in-polygon cell is not decimated away (see FR-012).
- **Polygon partially outside the grid**: only the in-grid, in-polygon cells are returned; the out-of-grid region is silently excluded.
- **Polygon straddles the antimeridian (±180° longitude)** or crosses the poles: out of scope for v1 (see FR-021). Coordinates are treated as plain numbers with no wrapping, so such a polygon resolves to its numeric bounding box (it does not wrap around the globe). Documented as unsupported for now.
- **Cells with missing/fill values inside the polygon**: they are still reported as in-polygon cells; the library surfaces the underlying stored/fill value without dropping the cell (any statistical handling of missing values is the consumer's concern).
- **Time sub-range that is empty or reversed**: an empty range yields zero time steps; a reversed/invalid range is rejected with a clear error.
- **Unclosed polygon ring**: treated as implicitly closed.
- **Polygon with fewer than 3 distinct vertices**: rejected with a clear error (not a valid area).
- **Array whose time axis is not the leading axis**: the consumer can indicate which axis is the time axis; the remaining axes are treated as spatial.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The library MUST provide a streaming read that, given an array shaped `[time, ...spatial]` and a lat/lon polygon, yields one result per time step in time order.
- **FR-002**: Each yielded time step MUST contain values for **only** the cells geometrically inside the polygon — not merely inside its bounding box — determined by a point-in-polygon test that correctly handles concave polygons.
- **FR-003**: The set of selected cells and their positions MUST be computed once (time-invariant) and made available to the consumer, so per-time-step results carry only values and the consumer can map values back to positions.
- **FR-004**: The selected cells MUST be reported in **row-major order over the bounding box** — iterating spatial rows, then columns within each row — keeping only the in-polygon cells. The value ordering within each time step MUST match this reported cell ordering and MUST be identical across all time steps and to the resolution capability's output (FR-008). (For the unstructured points layout, "row-major over the bounding box" reduces to the flat point order filtered to in-polygon points.)
- **FR-005**: The library MUST read the selection as bounding-box blocks so that each backing-store chunk overlapping the selection is downloaded and decompressed **at most once** per read.
- **FR-006**: Working memory during a full streamed read MUST remain bounded to approximately one time slice of the bounding-box block, independent of the number of time steps.
- **FR-007**: The consumer MUST be able to restrict the read to a contiguous sub-range of time-step indices; only those time steps are yielded.
- **FR-008**: The library MUST provide a separate resolution capability that returns the selected cells, the selection bounding box, and any applied sub-sampling factor, without reading time-varying values.
- **FR-009**: Each returned cell MUST include its spatial index/indices and its lat/lon position.
- **FR-010**: The library MUST support resolving lat/lon polygons to cells for three coordinate layouts: 1-D rectilinear (separate monotonic axes), 2-D curvilinear grids, and unstructured point lists.
- **FR-011**: For the 2-D curvilinear layout, the library MUST reuse the existing curvilinear grid lookup capability to derive the bounding box and MUST rely on the point-in-polygon mask for final cell membership.
- **FR-012**: When the selection's bounding-box cell count exceeds a configurable cell budget, the library MUST apply a regular spatial sub-sampling (stride) factor that keeps the returned cell count within the budget while preserving coverage across the whole area, and MUST report the applied factor. The stride MUST be applied to the bounding-box grid **first** (uniform decimation of rows and columns), and the point-in-polygon mask (FR-002) MUST then be applied to the surviving strided cells. The library MUST clamp the stride so that a polygon selecting at least one cell never sub-samples to zero in-polygon cells.
- **FR-013**: The cell budget is optional and has **no default**. When it is not configured, the library MUST return all in-polygon cells with no sub-sampling, regardless of selection size (per-timestep memory remains bounded by FR-006). When it is configured but not exceeded, the library MUST likewise return all in-polygon cells with no sub-sampling.
- **FR-014**: The library MUST accept a polygon ring whether or not it is explicitly closed, treating an unclosed ring as implicitly closed, and MUST produce identical results either way.
- **FR-015**: The library MUST allow the consumer to indicate which axis is the time axis (defaulting to the leading axis) and MUST treat the remaining axes as spatial.
- **FR-016**: The library MUST pass through the consumer's existing read tuning/observability controls (e.g., in-flight byte limits, concurrency, chunk reuse across the read, per-read observability) to the underlying reads.
- **FR-017**: When the polygon selects no in-grid cells, the read MUST complete cleanly with an empty selection rather than raising an error.
- **FR-018**: The library MUST reject invalid inputs with clear errors, including: a polygon with fewer than 3 distinct vertices, and a reversed/invalid time sub-range.
- **FR-019**: The new capability MUST be exposed from the library's public entry point alongside the existing spatial capabilities.
- **FR-020**: The existing point-read and nearest-point coordinate resolution paths MUST remain unchanged by this feature (this feature adds the area path only; consolidating the point path is explicitly a future, separate effort).
- **FR-021**: Antimeridian-crossing and polar polygons are out of scope for the first release. The library MUST behave predictably for such inputs: it treats longitudes and latitudes as plain numeric coordinates (no ±180° wrapping, no polar-singularity handling), so a polygon that spans the antimeridian selects the numeric bounding box between its extreme longitudes rather than wrapping around. Global-grid support is a documented future enhancement.

### Key Entities *(include if feature involves data)*

- **Polygon**: An ordered ring of lat/lon vertices defining a geographic area. May be provided closed or unclosed. Concave polygons must be handled correctly.
- **Selected cell**: A single grid cell inside the polygon, identified by its spatial index/indices and its lat/lon position. The full ordered set of selected cells is time-invariant for a given polygon and array.
- **Selection bounding box**: The rectangular index range (in spatial index space) that fully contains the polygon; the unit of block reads.
- **Time-step result**: For one time index, the ordered values of the selected cells (only the in-polygon cells), aligned to the selected-cell ordering.
- **Coordinate layout**: One of three ways the array's positions are described — 1-D rectilinear axis pair, 2-D curvilinear grid, or unstructured point list — determining how a lat/lon polygon maps to spatial indices.
- **Selection metadata**: The resolution output — selected cells, bounding box, and applied sub-sampling factor — describing *what* the polygon selects, independent of *values*.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a polygon over an array whose bounding box spans multiple chunks, the number of chunk downloads/decompressions during a full read equals the number of distinct chunks overlapping the bounding box — each covered chunk is touched exactly once (0 re-reads).
- **SC-002**: Reading the same area over 10× more time steps increases peak working memory by no more than a small constant factor (working memory tracks one time slice, not the total time extent).
- **SC-003**: A concave polygon returns 100% of the cells geometrically inside it and 0 cells that lie inside the bounding box but outside the polygon.
- **SC-004**: All three coordinate layouts (1-D rectilinear, 2-D curvilinear, unstructured points) produce correct cell selections and positions, verified by unit tests for each.
- **SC-005**: When a selection exceeds the configured cell budget, the returned cell count is ≤ the budget and the retained cells remain distributed across the whole area (no clustering to one corner), with the applied sub-sampling factor reported; a polygon that selects at least one cell never returns zero cells due to sub-sampling.
- **SC-006**: Providing a polygon ring closed vs. unclosed yields identical selections and values.
- **SC-007**: An area read replaces N per-point reads with a small number of block reads, eliminating the O(number of cells) chunk re-decompression cost of the point-by-point approach.
- **SC-008**: The existing point-read behaviour and its test suite remain green — no regression introduced by the area path.

## Assumptions

- **Read-only**: Consistent with the library's read-only scope, this feature only reads data; it never writes.
- **Time is a single leading (or consumer-indicated) axis**: Arrays are shaped `[time, ...spatial]` with time as one axis; the remaining axes are spatial. Multiple independent time-like axes are not in scope.
- **Chunking spans the time axis**: The performance argument assumes the typical layout where a chunk covers the full time extent and a spatial tile (e.g., `[fullTime, tile, tile]`). Correctness does not depend on this, but the "each chunk once" efficiency benefit is greatest under it.
- **Aggregation lives downstream**: Statistics (median/min/max/argmax/circular means, missing-value policy, etc.) over the returned cells are the consumer's responsibility and are explicitly out of scope.
- **Point-in-polygon via ray casting**: A standard even-odd (ray-casting) rule is assumed sufficient for area membership; self-intersecting polygons are not a supported input.
- **Regional grids**: The primary use cases are regional forecast grids that do not cross the antimeridian or poles. Global-grid edge handling (longitude wrapping, polar singularity) is explicitly deferred to a future enhancement (FR-021); coordinates are treated as plain numbers in v1.
- **Reuses existing capabilities**: The 2-D curvilinear path reuses the existing curvilinear grid lookup, and reads reuse the existing block-read and chunk-reuse (memory cache) mechanisms; no new storage backend is introduced.
- **Sub-sampling default off**: The cell budget has no default value. Unless a cell budget is explicitly configured, no sub-sampling is ever applied; the budget is an opt-in guard for pathological selections, not a default behaviour.
- **Distribution**: The capability ships in a new minor version of the library and is consumed by pinning that version downstream.

## Out of Scope

- Aggregation / statistics over the returned cells (median, min, max, argmax, circular means) — belongs to the consumer.
- Stitching or reading across multiple datasets/grids in a single call.
- Migrating the existing point-read coordinate resolution onto this shared resolution (a future, separate effort; the current point path stays intact).
- Any write, update, or persistence of selections.
- Antimeridian-crossing / polar (global-grid) polygon handling — deferred to a future enhancement (FR-021).

## Dependencies

- Existing array block-read capability (range selection over an array) and its chunk-reuse (memory cache) mechanism.
- Existing curvilinear (2-D) grid nearest-lookup capability, reused for the 2-D layout's bounding-box derivation.
- The library's public entry point, extended to export the new capability.
