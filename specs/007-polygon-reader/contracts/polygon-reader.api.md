# API Contract: Polygon Reader

**Module**: `src/spatial/polygon-reader.ts` → re-exported from `src/spatial/index.ts`
**Public import path**: `@i4sea/zarr-node/spatial`
**Feature**: 007-polygon-reader

This is the public TypeScript contract. All types are exported; no `any` (Constitution II). Signatures are the stable surface for the 0.9.0 minor.

```ts
import type { ZarrArray, ReadOptions } from "@i4sea/zarr-node";
import type { GridIndex } from "@i4sea/zarr-node/spatial";

// ── Coordinate layout (discriminated union) ─────────────────────────────────

export type SpatialLayout =
  | { kind: "1d"; lat: ArrayLike<number>; lon: ArrayLike<number> }
  | { kind: "2d"; grid: GridIndex }
  | { kind: "npoints"; lat: ArrayLike<number>; lon: ArrayLike<number> };

// ── Options ─────────────────────────────────────────────────────────────────

export interface PolygonReadOptions {
  /** Ring of [lat, lon] vertices. Closed or unclosed (implicitly closed). */
  polygon: Array<[number, number]>;
  /** How lat/lon map to spatial indices. */
  spatialLayout: SpatialLayout;
  /** Axis index of time. v1: must be 0 (leading time axis); other values throw SliceError. Default: 0. */
  timeAxis?: number;
  /** Half-open [startIdx, endIdx) in time indices. Default: full time extent. */
  timeRange?: [number, number];
  /** Cell budget; exceeding it applies a clamped spatial stride. Default: none. */
  maxCells?: number;
  /** Forwarded to ZarrArray.get (memoryCache, concurrency, maxInFlightBytes, observability, ...). */
  readOptions?: ReadOptions;
}

// ── Outputs ─────────────────────────────────────────────────────────────────

export interface PolygonCell {
  /** Row index (spatial axis 0); flat point index for npoints. */
  i: number;
  /** Column index (spatial axis 1); 0 for npoints. */
  j: number;
  lat: number;
  lon: number;
}

export interface PolygonBBox {
  rMin: number;
  rMax: number; // half-open
  cMin: number;
  cMax: number; // half-open
}

export interface PolygonSelection {
  /** In-polygon cells, row-major over bbox. Empty if nothing selected. */
  cells: PolygonCell[];
  bbox: PolygonBBox;
  /** Applied sub-sampling factor; 1 when no cap applied. */
  stride: number;
}

export interface PolygonTimestep {
  /** Absolute time index (ascending, within timeRange). */
  t: number;
  /** In-polygon values for time t, aligned to PolygonSelection.cells order. */
  values: Float64Array;
}

// ── Functions ───────────────────────────────────────────────────────────────

/**
 * Resolve the time-invariant selection (cells + positions + bbox + stride)
 * for a polygon over `arr`, without reading time-varying values.
 * Throws SliceError on invalid input; returns empty cells for an out-of-grid polygon.
 */
export function resolvePolygonCells(
  arr: ZarrArray,
  opts: PolygonReadOptions,
): PolygonSelection;

/**
 * Stream one PolygonTimestep per time step in `timeRange` (ascending),
 * yielding only in-polygon cell values. Each bbox-overlapping chunk is read
 * at most once; working memory stays bounded to ~one time slice.
 * Throws SliceError on invalid input; completes with no yields for an empty selection.
 */
export function readPolygon(
  arr: ZarrArray,
  opts: PolygonReadOptions,
): AsyncGenerator<PolygonTimestep, void, void>;
```

## Contract guarantees (mapped to FR / SC)

| Guarantee | Requirement |
|-----------|-------------|
| Yields one timestep per index in `timeRange`, ascending | FR-001, FR-007 |
| `values` contains only in-polygon cells (ray-cast, concave-correct) | FR-002, SC-003 |
| `cells` computed once; order identical across timesteps & to `resolvePolygonCells` | FR-003, FR-004, SC-006 |
| Cells ordered row-major over bbox | Clarification Q1 |
| Each bbox chunk fetched/decompressed ≤ once | FR-005, SC-001 |
| Working memory ~one time slice, independent of time extent | FR-006, SC-002 |
| `resolvePolygonCells` returns cells+bbox+stride, no values | FR-008 |
| Each cell carries i/j + lat/lon | FR-009 |
| Three layouts supported | FR-010, FR-011, SC-004 |
| Stride clamped, non-zero, reported; no default cap | FR-012, FR-013, SC-005 |
| Closed == unclosed ring | FR-014, SC-006 |
| `readOptions` forwarded | FR-016 |
| Empty selection ⇒ clean completion (no throw) | FR-017 |
| Invalid input ⇒ `SliceError` | FR-018 |
| Exported from `@i4sea/zarr-node/spatial` | FR-019 |
| Point-read path untouched | FR-020, SC-008 |

## Non-goals (contract explicitly excludes)

- Aggregation over `values` (median/min/max/argmax/circular).
- Multi-dataset/grid stitching.
- Antimeridian/polar wrapping.
- Any write/mutation path.
