# Data Model: Polygon-Based Spatial Reading

**Feature**: 007-polygon-reader | **Date**: 2026-07-13

These are in-memory value types (no persistence — the library is read-only). Field names follow the issue's API sketch, refined by the clarifications.

---

## Polygon (input)

An ordered ring of geographic vertices.

| Field | Type | Notes |
|-------|------|-------|
| ring | `Array<[number, number]>` | `[lat, lon]` pairs. Closed or unclosed (implicitly closed — FR-014). |

**Validation**: MUST have ≥ 3 distinct vertices, else `SliceError` (FR-018). Antimeridian/polar rings treated as plain numbers, no wrapping (FR-021).

---

## SpatialLayout (input — discriminated union)

Describes how lat/lon map to spatial indices (FR-010). Discriminated on `kind`.

**1d-rectilinear**
| Field | Type | Notes |
|-------|------|-------|
| kind | `"1d"` | |
| lat | `ArrayLike<number>` | Monotonic latitude axis (length = spatial rows). |
| lon | `ArrayLike<number>` | Monotonic longitude axis (length = spatial cols). |

**2d-curvilinear**
| Field | Type | Notes |
|-------|------|-------|
| kind | `"2d"` | |
| grid | `GridIndex` | Existing curvilinear index (FR-011). Provides `ny`/`nx`, `nearest()`, per-cell lat/lon. |

**npoints (unstructured)**
| Field | Type | Notes |
|-------|------|-------|
| kind | `"npoints"` | |
| lat | `ArrayLike<number>` | Flat per-point latitude (length = nPoints). |
| lon | `ArrayLike<number>` | Flat per-point longitude (length = nPoints). |

---

## PolygonCell (output — per selected cell)

One grid cell inside the polygon. Time-invariant. Ordered **row-major over the bounding box** (clarification Q1).

| Field | Type | Notes |
|-------|------|-------|
| i | `number` | Row index (spatial axis 0). For npoints: the flat point index. |
| j | `number` | Column index (spatial axis 1). For npoints: `0` (single spatial axis). |
| lat | `number` | Cell latitude (FR-009). |
| lon | `number` | Cell longitude (FR-009). |

**Ordering invariant**: the cell array order is identical between `resolvePolygonCells` and the `values` alignment in every `PolygonTimestep` (FR-004).

---

## PolygonSelection (output of `resolvePolygonCells`)

The time-invariant selection metadata — *what* the polygon selects, no values (FR-008).

| Field | Type | Notes |
|-------|------|-------|
| cells | `PolygonCell[]` | In-polygon cells, row-major. Empty if polygon selects nothing (FR-017). |
| bbox | `{ rMin: number; rMax: number; cMin: number; cMax: number }` | Half-open index bounds fully containing the polygon (the block-read extent). For npoints, `rMin/rMax` span the point axis, `cMin=0, cMax=1`. |
| stride | `number` | Applied spatial sub-sampling factor; `1` when no cap applied (FR-012/FR-013). |

---

## PolygonReadOptions (input to `readPolygon` / `resolvePolygonCells`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| polygon | `Array<[number, number]>` | — (required) | Ring, lat/lon (FR-014). |
| spatialLayout | `SpatialLayout` | — (required) | See union above (FR-010). |
| timeAxis | `number` | `0` | Which axis is time (FR-015). |
| timeRange | `[number, number]` | full extent | Half-open `[startIdx, endIdx)` in time indices (FR-007). Reversed/out-of-range ⇒ `SliceError` (FR-018). |
| maxCells | `number` | `undefined` (no cap) | Cell budget; triggers clamped stride when bbox exceeds it (FR-012/FR-013). |
| readOptions | `ReadOptions` | — | Forwarded to `arr.get`: `memoryCache`, `concurrency`, `maxInFlightBytes`, `observability`, etc. (FR-016). If `memoryCache` omitted, an internal one is created per call for chunk reuse (research D2). |

---

## PolygonTimestep (output — streamed, one per time step)

| Field | Type | Notes |
|-------|------|-------|
| t | `number` | Absolute time index (within `timeRange`), in ascending order (FR-001/FR-007). |
| values | `Float64Array` | Values of the in-polygon cells for time `t`, aligned to `PolygonCell[]` order (FR-003/FR-004, research D6). Length = `cells.length`. Fill/missing pass through as numeric / `NaN`. |

---

## Relationships

```text
readPolygon(arr, opts) ──► AsyncGenerator<PolygonTimestep>
   │                              │ values aligned to ▼
   └─ resolves once ──► PolygonSelection { cells: PolygonCell[], bbox, stride }
                                          ▲
SpatialLayout (1d | 2d GridIndex | npoints) determines cells + positions
Polygon ring + ray-cast mask determines membership within bbox
```

- `readPolygon` internally computes the same `PolygonSelection` as `resolvePolygonCells` (single source of truth), then streams `values` per time step gathered against `cells`.
- `bbox` is the block-read extent; `cells` ⊆ (bbox strided) filtered by the polygon mask.
