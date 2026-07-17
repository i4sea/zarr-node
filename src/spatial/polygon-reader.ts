/**
 * Polygon reader — stream only the cells geometrically inside a lat/lon polygon
 * from a `[time, ...spatial]` Zarr array, one time step at a time.
 *
 * The reader resolves the time-invariant selection once (bounding box + a
 * ray-cast mask over that box), then reads each time step as a bounding-box
 * block via {@link ZarrArray.get}. Because the backing chunks typically span
 * the full time axis, a shared {@link MemoryCache} across the per-step reads
 * makes each bbox-overlapping chunk decode at most once, and peak working
 * memory tracks ~one time slice regardless of the time extent.
 */
import type { ZarrArray, ReadOptions } from "../array.js";
import type { GridIndex } from "./grid-index.js";
import { SliceError } from "../errors.js";
import { MemoryCache } from "../cache/memory.js";

/** Default in-flight byte ceiling for the internal per-call chunk cache. */
const INTERNAL_CACHE_BYTES = 512 * 1024 * 1024;

// ── Coordinate layout (discriminated union) ─────────────────────────────────

/** How lat/lon map to spatial indices (FR-010, FR-011). Discriminated on `kind`. */
export type SpatialLayout =
  | { kind: "1d"; lat: ArrayLike<number>; lon: ArrayLike<number> }
  | { kind: "2d"; grid: GridIndex }
  | { kind: "npoints"; lat: ArrayLike<number>; lon: ArrayLike<number> };

// ── Options ─────────────────────────────────────────────────────────────────

/** Options shared by {@link readPolygon} and {@link resolvePolygonCells}. */
export interface PolygonReadOptions {
  /** Ring of [lat, lon] vertices. Closed or unclosed (implicitly closed). */
  polygon: Array<[number, number]>;
  /** How lat/lon map to spatial indices. */
  spatialLayout: SpatialLayout;
  /**
   * Axis index of time. v1 supports only a leading time axis, so this must be
   * `0`; any other value throws `SliceError`. Default: 0.
   */
  timeAxis?: number;
  /** Half-open [startIdx, endIdx) in time indices. Default: full time extent. */
  timeRange?: [number, number];
  /** Cell budget; exceeding it applies a clamped spatial stride. Default: none. */
  maxCells?: number;
  /**
   * Cell membership rule. `"center"` (default, back-compat) keeps a cell iff
   * its center is inside the ring. `"cover"` additionally keeps any cell whose
   * FOOTPRINT overlaps the polygon (conservative rasterization), so a thin or
   * concave area narrower than the grid step still selects the cells it visibly
   * covers on the map instead of collapsing to a near-empty (or empty) set —
   * the right membership for an area "distribution over the zone" reduction.
   * Implemented for the rectilinear 1d and curvilinear 2d layouts; npoints
   * falls back to `"center"`.
   */
  selection?: "center" | "cover";
  /**
   * Pre-resolved selection to reuse instead of scanning again. When supplied,
   * {@link readPolygon} skips its internal `resolveSelection` (the O(bbox)
   * membership scan) and streams straight from these `cells` + `bbox`. Intended
   * for a caller that reads MANY same-shape variables through one polygon: run
   * {@link resolvePolygonCells} ONCE and thread the result into every read
   * instead of re-scanning per variable.
   *
   * MUST have been produced by {@link resolvePolygonCells} for the SAME `arr`
   * shape/rank and the SAME `polygon` and `spatialLayout` — the reader trusts
   * the `cells` + `bbox` verbatim and does not re-derive them, so a selection
   * from a differently-shaped array yields wrong values. As a guard against the
   * most common misuse, the reader bounds-checks the supplied `bbox`/`cells`
   * against this array's spatial extents and throws {@link SliceError} on a
   * shape mismatch rather than slicing out of range into silent fill/NaN.
   *
   * `spatialLayout` is still required (the per-step block read maps the `bbox`
   * through the layout resolver). `polygon` is also still required, but only to
   * pass {@link validatePolygonReadInput}; it does NOT feed the read once this
   * is set. `timeRange` is applied fresh per read and need not match the one
   * used to resolve. `maxCells` has no effect on the read (the stride is already
   * baked into the supplied selection), but if present it must still be a valid
   * positive integer or validation rejects it.
   */
  resolvedSelection?: PolygonSelection;
  /** Forwarded to ZarrArray.get (memoryCache, concurrency, maxInFlightBytes, observability, ...). */
  readOptions?: ReadOptions;
}

// ── Outputs ─────────────────────────────────────────────────────────────────

/** One grid cell inside the polygon, with its index and geographic position. */
export interface PolygonCell {
  /** Row index (spatial axis 0); flat point index for npoints. */
  i: number;
  /** Column index (spatial axis 1); 0 for npoints. */
  j: number;
  lat: number;
  lon: number;
}

/** Half-open index-space bounding box: the per-step block-read extent. */
export interface PolygonBBox {
  rMin: number;
  rMax: number; // half-open
  cMin: number;
  cMax: number; // half-open
}

/** Time-invariant selection returned by {@link resolvePolygonCells}. */
export interface PolygonSelection {
  /** In-polygon cells, row-major over bbox. Empty if nothing selected. */
  cells: PolygonCell[];
  bbox: PolygonBBox;
  /** Applied sub-sampling factor; 1 when no cap applied. */
  stride: number;
}

/** One streamed time step: the in-polygon values for a single time index. */
export interface PolygonTimestep {
  /** Absolute time index (ascending, within timeRange). */
  t: number;
  /** In-polygon values for time t, aligned to PolygonSelection.cells order. */
  values: Float64Array;
}

// ── Geometry & validation primitives (internal; exported for unit tests) ─────

/**
 * Even-odd (crossing-number) ray-casting point-in-polygon test in lat/lon
 * space. The ring is treated as implicitly closed, so a closed and an unclosed
 * ring give identical results. Correct for concave rings and notches.
 *
 * `ring` is a list of `[lat, lon]` vertices; `lat` is the y-axis, `lon` the
 * x-axis. Edge/vertex points are handled by the standard
 * `(yi > y) !== (yj > y)` half-open crossing rule — membership on the boundary
 * is not guaranteed either way, only that it is deterministic.
 *
 * @internal
 */
export function pointInPolygon(
  lat: number,
  lon: number,
  ring: ReadonlyArray<readonly [number, number]>,
): boolean {
  const y = lat;
  const x = lon;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Orientation-based segment intersection in (lat, lon) space (lat=y, lon=x).
 * Returns true when segment `a1a2` and segment `b1b2` cross or touch. Colinear
 * overlap is treated as intersecting. Used by {@link polygonOverlapsRect} for
 * the "cover" membership test.
 *
 * @internal
 */
export function segmentsIntersect(
  a1: readonly [number, number],
  a2: readonly [number, number],
  b1: readonly [number, number],
  b2: readonly [number, number],
): boolean {
  const cross = (
    o: readonly [number, number],
    p: readonly [number, number],
    q: readonly [number, number],
  ): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const onSeg = (
    o: readonly [number, number],
    p: readonly [number, number],
    q: readonly [number, number],
  ): boolean =>
    Math.min(o[0], q[0]) <= p[0] &&
    p[0] <= Math.max(o[0], q[0]) &&
    Math.min(o[1], q[1]) <= p[1] &&
    p[1] <= Math.max(o[1], q[1]);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) return true;
  // Colinear / touching cases.
  if (d1 === 0 && onSeg(b1, a1, b2)) return true;
  if (d2 === 0 && onSeg(b1, a2, b2)) return true;
  if (d3 === 0 && onSeg(a1, b1, a2)) return true;
  if (d4 === 0 && onSeg(a1, b2, a2)) return true;
  return false;
}

/**
 * Does the (filled) polygon `ring` overlap the axis-aligned lat/lon rectangle
 * `[latLo,latHi] x [lonLo,lonHi]`? True when any rect corner is inside the ring
 * (rect inside, or straddling), any ring vertex is inside the rect (ring inside,
 * or straddling), or any ring edge crosses a rect edge (a thin ribbon slicing
 * through the cell without landing a vertex or corner). This is the conservative
 * rasterization predicate behind `selection: "cover"`.
 *
 * @internal
 */
export function polygonOverlapsRect(
  ring: ReadonlyArray<readonly [number, number]>,
  latLo: number,
  latHi: number,
  lonLo: number,
  lonHi: number,
): boolean {
  const corners: Array<[number, number]> = [
    [latLo, lonLo],
    [latLo, lonHi],
    [latHi, lonHi],
    [latHi, lonLo],
  ];
  for (const [la, lo] of corners) {
    if (pointInPolygon(la, lo, ring)) return true;
  }
  for (const [la, lo] of ring) {
    if (la >= latLo && la <= latHi && lo >= lonLo && lo <= lonHi) return true;
  }
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    for (let e = 0; e < 4; e++) {
      if (
        segmentsIntersect(ring[j], ring[i], corners[e], corners[(e + 1) % 4])
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Count of distinct vertices in a ring (order-preserving; closure-tolerant). */
function distinctVertexCount(
  ring: ReadonlyArray<readonly [number, number]>,
): number {
  const seen = new Set<string>();
  for (const [lat, lon] of ring) seen.add(`${lat},${lon}`);
  return seen.size;
}

/**
 * Validate the shared inputs of {@link readPolygon} / {@link resolvePolygonCells}.
 * Throws {@link SliceError} on invalid input (polygon vertex that is not a
 * finite [lat, lon] pair; < 3 distinct polygon vertices; `timeAxis` other than
 * 0; reversed or out-of-range `timeRange`; `maxCells` that is not a positive
 * integer). An empty selection is NOT an error and is not detected here.
 *
 * @param nTime Length of the time axis (`arr.shape[timeAxis]`).
 * @internal
 */
export function validatePolygonReadInput(
  opts: PolygonReadOptions,
  nTime: number,
): void {
  if (!Array.isArray(opts.polygon)) {
    throw new SliceError(
      "polygon must have at least 3 distinct [lat, lon] vertices",
    );
  }
  // Every vertex must be a pair of finite numbers; a malformed entry
  // (wrong arity, NaN/Infinity) would silently poison the ray-cast and
  // envelope math, selecting nothing instead of erroring.
  for (const vertex of opts.polygon) {
    if (
      !Array.isArray(vertex) ||
      vertex.length !== 2 ||
      !Number.isFinite(vertex[0]) ||
      !Number.isFinite(vertex[1])
    ) {
      throw new SliceError(
        "polygon vertices must be [lat, lon] pairs of finite numbers",
      );
    }
  }
  if (distinctVertexCount(opts.polygon) < 3) {
    throw new SliceError(
      "polygon must have at least 3 distinct [lat, lon] vertices",
    );
  }
  // v1 supports only a leading time axis with the spatial axes trailing
  // (research D7). A non-zero `timeAxis` is rejected rather than silently
  // producing a transposed, corrupt selection.
  if (opts.timeAxis !== undefined && opts.timeAxis !== 0) {
    throw new SliceError(
      `timeAxis must be 0 in this version (got ${opts.timeAxis}); ` +
        `only a leading time axis is supported`,
    );
  }
  if (opts.timeRange !== undefined) {
    const [start, end] = opts.timeRange;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > nTime ||
      end < start
    ) {
      throw new SliceError(
        `invalid timeRange [${start}, ${end}) for time axis of length ${nTime}`,
      );
    }
  }
  // maxCells is a cell budget, so it must be a positive integer. This also
  // rejects NaN and Infinity (Number.isInteger is false for both); the no-cap
  // form is `undefined`, not Infinity.
  if (
    opts.maxCells !== undefined &&
    (!Number.isInteger(opts.maxCells) || opts.maxCells < 1)
  ) {
    throw new SliceError(
      `maxCells must be a positive integer, got ${opts.maxCells}`,
    );
  }
}

// ── Layout resolution ────────────────────────────────────────────────────────

/** Reject a BigInt coordinate dtype the same way `GridIndex.numericCoords` does. */
function assertNumericCoords(a: ArrayLike<number>, name: string): void {
  if (a instanceof BigInt64Array || a instanceof BigUint64Array) {
    throw new SliceError(
      `polygon reader: "${name}" has a 64-bit integer dtype; expected float/int coordinates`,
    );
  }
}

/**
 * Validate the array rank against the layout and return the number of
 * "singleton middle dims" to collapse — extra axes sitting between the leading
 * time axis and the trailing spatial dims, each of which must have size 1.
 *
 * A layout addresses `resolver.ndim` axes (`[time, rows, cols]` for 1d/2d;
 * `[time, npoints]` for npoints). Hydrodynamic current fields from
 * hidro/Delft3D datasets carry a degenerate depth dim of size 1 — shape
 * `[time, 1, lat, lon]` — so we accept `rank = ndim + k` when the `k` middle
 * dims are all size 1, and select index 0 for each of them (dropping the dim).
 * A middle dim larger than 1 (a genuine multi-level axis, e.g. a depth
 * profile) still throws: collapsing it would need an explicit level selection,
 * which this reader does not offer.
 *
 * The base rank check remains load-bearing: without it a mismatched array
 * produces chunk keys of the wrong arity, every chunk misses, and the read
 * silently returns all-fill values instead of erroring.
 *
 * @returns The count `k` of leading singleton middle dims (0 for an
 *   exact-rank array). {@link readPolygon} injects `k` index-0 selections
 *   after the time axis so the block read stays C-order over `[rows, cols]`.
 */
function assertArrayRank(arr: ZarrArray, resolver: LayoutResolver): number {
  const rank = arr.shape.length;
  const k = rank - resolver.ndim;
  if (k < 0) {
    throw new SliceError(
      `polygon reader: array rank ${rank} does not match the ` +
        `spatialLayout, which expects a ${resolver.ndim}-D array ` +
        `([time, ...spatial]); got shape ${JSON.stringify(arr.shape)}`,
    );
  }
  if (k > 0) {
    // Middle dims sit between the leading time axis and the trailing spatial
    // dims: shape[1 .. 1+k). Each must be a degenerate size-1 axis we can drop
    // by selecting index 0.
    const middle = arr.shape.slice(1, 1 + k);
    if (middle.some((d) => d !== 1)) {
      throw new SliceError(
        `polygon reader: array rank ${rank} exceeds the ${resolver.ndim}-D ` +
          `spatialLayout ([time, ...spatial]), and the extra middle dims ` +
          `${JSON.stringify(middle)} are not all size 1; only degenerate ` +
          `size-1 dims between the time axis and the trailing spatial dims ` +
          `can be collapsed (a multi-level axis needs an explicit selection). ` +
          `Got shape ${JSON.stringify(arr.shape)}`,
      );
    }
  }
  return k;
}

/**
 * Guard a caller-supplied {@link PolygonReadOptions.resolvedSelection} before
 * the reader trusts it verbatim. `resolvedSelection` bypasses the internal
 * membership scan, so nothing else checks that its `bbox`/`cells` actually fit
 * `arr` — a selection resolved against a different-shaped array would otherwise
 * slice out of range and silently yield fill/NaN values (arr.get pads the
 * out-of-range region) instead of erroring. We validate against the resolver's
 * declared spatial extents (`nRows`/`nCols`) so the failure is a clean
 * {@link SliceError} at the trust boundary.
 */
function assertSelectionInBounds(
  sel: PolygonSelection,
  resolver: LayoutResolver,
): void {
  const { rMin, rMax, cMin, cMax } = sel.bbox;
  if (
    rMin < 0 ||
    cMin < 0 ||
    rMax > resolver.nRows ||
    cMax > resolver.nCols ||
    rMax < rMin ||
    cMax < cMin
  ) {
    throw new SliceError(
      `polygon reader: resolvedSelection.bbox ` +
        `[${rMin}, ${rMax})x[${cMin}, ${cMax}) is out of range for the ` +
        `${resolver.nRows}x${resolver.nCols} spatial grid; the selection must ` +
        `have been produced by resolvePolygonCells for this array's shape`,
    );
  }
  for (const cell of sel.cells) {
    if (cell.i < rMin || cell.i >= rMax || cell.j < cMin || cell.j >= cMax) {
      throw new SliceError(
        `polygon reader: resolvedSelection cell (${cell.i}, ${cell.j}) falls ` +
          `outside its own bbox [${rMin}, ${rMax})x[${cMin}, ${cMax}); the ` +
          `selection must have been produced by resolvePolygonCells`,
      );
    }
  }
}

/** Bounding box in polygon (lat/lon) space. */
function polygonEnvelope(ring: Array<[number, number]>): {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
} {
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  for (const [lat, lon] of ring) {
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
  }
  return { latMin, latMax, lonMin, lonMax };
}

/**
 * The full-grid extent a layout resolves to, plus a per-index position lookup.
 * `nRows`/`nCols` are the spatial index-space dimensions; `latAt`/`lonAt` map an
 * index to its geographic position. `spatialSelect(t, r0, r1, c0, c1)` builds
 * the `arr.get` selection for a single time step over the bbox block.
 */
interface LayoutResolver {
  /**
   * Total array rank this layout addresses: one leading time axis plus the
   * spatial axes (3 for 1d/2d `[time, rows, cols]`; 2 for npoints
   * `[time, npoints]`). Checked against `arr.shape.length`.
   */
  ndim: number;
  nRows: number;
  nCols: number;
  latAt(i: number, j: number): number;
  lonAt(i: number, j: number): number;
  /** Bounding box (half-open, index space) fully containing the polygon. */
  bbox(ring: Array<[number, number]>): PolygonBBox;
  /**
   * Bounding box for `"cover"` membership: every cell whose FOOTPRINT overlaps
   * the polygon's lat/lon envelope (a superset of {@link bbox}, which keys off
   * cell centers). Needed for a sub-cell area that contains no center — its
   * center-bbox is empty, but its footprint-bbox is not. Defined for the
   * rectilinear 1d and curvilinear 2d layouts; `"cover"` degrades to `"center"`
   * when absent (e.g. npoints).
   */
  coverBBox?(ring: Array<[number, number]>): PolygonBBox;
  /**
   * Footprint of cell `(i, j)` in lat/lon space: the axis-aligned rectangle
   * spanning the midpoints to its neighbours (one-sided step at the grid edge).
   * The `"cover"` selection tests this rectangle against the polygon. Defined
   * for the rectilinear 1d and curvilinear 2d layouts; when absent, `"cover"`
   * degrades to `"center"`.
   */
  cellBounds?(
    i: number,
    j: number,
  ): { latLo: number; latHi: number; lonLo: number; lonHi: number };
  /** Build the `arr.get` selection for one time step over the given bbox block. */
  spatialSelect(
    timeAxis: number,
    t: number,
    bbox: PolygonBBox,
  ): (number | [number, number])[];
}

/** Clamp `[lo, hi]` to `[0, n]` and ensure lo <= hi. */
function clampRange(lo: number, hi: number, n: number): [number, number] {
  const a = Math.max(0, Math.min(lo, n));
  const b = Math.max(a, Math.min(hi, n));
  return [a, b];
}

function make2dResolver(grid: GridIndex): LayoutResolver {
  return {
    ndim: 3, // [time, rows, cols]
    nRows: grid.ny,
    nCols: grid.nx,
    latAt: (i, j) => grid.latAt(i, j),
    lonAt: (i, j) => grid.lonAt(i, j),
    bbox(ring) {
      // Exact index-space bbox for a curvilinear grid: scan every cell and
      // keep those whose lat/lon fall inside the polygon's lat/lon envelope.
      // The envelope superset contains every in-polygon cell, so the returned
      // block never drops one — correct for arbitrarily skewed/rotated grids,
      // unlike a corner-nearest + fixed-padding heuristic. This full-grid scan
      // is O(ny·nx); for a small polygon it can dominate the later mask gather,
      // which only iterates the (much smaller) resulting bbox.
      const env = polygonEnvelope(ring);
      let rMin = Infinity;
      let rMax = -Infinity;
      let cMin = Infinity;
      let cMax = -Infinity;
      for (let i = 0; i < grid.ny; i++) {
        for (let j = 0; j < grid.nx; j++) {
          const lat = grid.latAt(i, j);
          const lon = grid.lonAt(i, j);
          if (
            lat >= env.latMin &&
            lat <= env.latMax &&
            lon >= env.lonMin &&
            lon <= env.lonMax
          ) {
            if (i < rMin) rMin = i;
            if (i > rMax) rMax = i;
            if (j < cMin) cMin = j;
            if (j > cMax) cMax = j;
          }
        }
      }
      // No cell fell in the envelope ⇒ empty (degenerate) box.
      if (rMin > rMax || cMin > cMax) {
        return { rMin: 0, rMax: 0, cMin: 0, cMax: 0 };
      }
      const [r0, r1] = clampRange(rMin, rMax + 1, grid.ny);
      const [c0, c1] = clampRange(cMin, cMax + 1, grid.nx);
      return { rMin: r0, rMax: r1, cMin: c0, cMax: c1 };
    },
    coverBBox(ring) {
      // Same full-grid scan as bbox(), but keep cells whose FOOTPRINT overlaps
      // the polygon envelope (a superset of the center-in-envelope box), so a
      // sub-cell / between-centers area still yields a non-empty scan box.
      const env = polygonEnvelope(ring);
      let rMin = Infinity;
      let rMax = -Infinity;
      let cMin = Infinity;
      let cMax = -Infinity;
      for (let i = 0; i < grid.ny; i++) {
        for (let j = 0; j < grid.nx; j++) {
          const b = cellBounds2d(grid, i, j);
          if (
            b.latHi >= env.latMin &&
            b.latLo <= env.latMax &&
            b.lonHi >= env.lonMin &&
            b.lonLo <= env.lonMax
          ) {
            if (i < rMin) rMin = i;
            if (i > rMax) rMax = i;
            if (j < cMin) cMin = j;
            if (j > cMax) cMax = j;
          }
        }
      }
      if (rMin > rMax || cMin > cMax) {
        return { rMin: 0, rMax: 0, cMin: 0, cMax: 0 };
      }
      const [r0, r1] = clampRange(rMin, rMax + 1, grid.ny);
      const [c0, c1] = clampRange(cMin, cMax + 1, grid.nx);
      return { rMin: r0, rMax: r1, cMin: c0, cMax: c1 };
    },
    cellBounds(i, j) {
      return cellBounds2d(grid, i, j);
    },
    spatialSelect(timeAxis, t, bbox) {
      // v1: time axis leads; two trailing spatial axes.
      void timeAxis;
      return [t, [bbox.rMin, bbox.rMax], [bbox.cMin, bbox.cMax]];
    },
  };
}

/**
 * Axis-aligned lat/lon footprint of a curvilinear cell `(i, j)`: the rectangle
 * spanning the midpoints to its four edge-neighbours (center ± half the step to
 * each). At a grid edge the missing side is mirrored from the opposite one, so
 * a boundary cell keeps a full footprint instead of collapsing to its center
 * (matching the 1-D `axisCellSpan` behaviour). The result is a conservative
 * superset for a slightly skewed/rotated grid — enough for `"cover"` membership
 * without an exact quad-cell intersection (area weighting is a later refinement).
 */
function cellBounds2d(
  grid: GridIndex,
  i: number,
  j: number,
): { latLo: number; latHi: number; lonLo: number; lonHi: number } {
  const lat0 = grid.latAt(i, j);
  const lon0 = grid.lonAt(i, j);

  // Half-offset (dlat, dlon) from the center toward a neighbour, or null when
  // that neighbour is off-grid.
  const half = (ii: number, jj: number): [number, number] | null =>
    ii < 0 || ii >= grid.ny || jj < 0 || jj >= grid.nx
      ? null
      : [(grid.latAt(ii, jj) - lat0) / 2, (grid.lonAt(ii, jj) - lon0) / 2];

  // Opposite pairs; mirror one side when the other is off-grid.
  const pair = (
    a: [number, number] | null,
    b: [number, number] | null,
  ): Array<[number, number]> => {
    if (a && b) return [a, b];
    if (a) return [a, [-a[0], -a[1]]];
    if (b) return [[-b[0], -b[1]], b];
    return [];
  };

  const offsets = [
    ...pair(half(i - 1, j), half(i + 1, j)),
    ...pair(half(i, j - 1), half(i, j + 1)),
  ];

  let latLo = lat0;
  let latHi = lat0;
  let lonLo = lon0;
  let lonHi = lon0;
  for (const [dLat, dLon] of offsets) {
    const la = lat0 + dLat;
    const lo = lon0 + dLon;
    if (la < latLo) latLo = la;
    if (la > latHi) latHi = la;
    if (lo < lonLo) lonLo = lo;
    if (lo > lonHi) lonHi = lo;
  }
  return { latLo, latHi, lonLo, lonHi };
}

/**
 * Half-open `[start, end)` index range on a monotonic axis whose coordinates
 * fall within `[lo, hi]`, via binary search (O(log n)). Works for ascending or
 * descending axes (the index span is direction-agnostic). Empty range ⇒
 * `[0, 0]`.
 */
function axisRange(
  axis: ArrayLike<number>,
  lo: number,
  hi: number,
): [number, number] {
  const n = axis.length;
  if (n === 0) return [0, 0];

  // A single-element axis has no direction to infer; test it directly.
  const ascending = n === 1 ? true : axis[n - 1] >= axis[0];

  // `firstAtLeast`/`firstAbove` bracket the in-range span in coordinate order;
  // for a descending axis the same coordinate bounds map to mirrored indices.
  let start: number;
  let end: number;
  if (ascending) {
    start = lowerBoundAsc(axis, lo); // first index with axis[i] >= lo
    end = upperBoundAsc(axis, hi); // first index with axis[i] > hi
  } else {
    start = lowerBoundDesc(axis, hi); // first index with axis[i] <= hi
    end = upperBoundDesc(axis, lo); // first index with axis[i] < lo
  }
  return start >= end ? [0, 0] : [start, end];
}

/** First index `i` in an ascending axis with `axis[i] >= target` (else `n`). */
function lowerBoundAsc(axis: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (axis[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index `i` in an ascending axis with `axis[i] > target` (else `n`). */
function upperBoundAsc(axis: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (axis[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index `i` in a descending axis with `axis[i] <= target` (else `n`). */
function lowerBoundDesc(axis: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (axis[mid] > target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index `i` in a descending axis with `axis[i] < target` (else `n`). */
function upperBoundDesc(axis: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (axis[mid] >= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function make1dResolver(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
): LayoutResolver {
  assertNumericCoords(lat, "lat");
  assertNumericCoords(lon, "lon");
  return {
    ndim: 3, // [time, rows, cols]
    nRows: lat.length,
    nCols: lon.length,
    latAt: (i) => lat[i],
    lonAt: (_i, j) => lon[j],
    bbox(ring) {
      const env = polygonEnvelope(ring);
      const [rMin, rMax] = axisRange(lat, env.latMin, env.latMax);
      const [cMin, cMax] = axisRange(lon, env.lonMin, env.lonMax);
      return { rMin, rMax, cMin, cMax };
    },
    coverBBox(ring) {
      const env = polygonEnvelope(ring);
      const [rMin, rMax] = axisFootprintRange(lat, env.latMin, env.latMax);
      const [cMin, cMax] = axisFootprintRange(lon, env.lonMin, env.lonMax);
      return { rMin, rMax, cMin, cMax };
    },
    cellBounds(i, j) {
      return {
        ...halfOpenBounds(lat, i),
        ...halfOpenBoundsLon(lon, j),
      };
    },
    spatialSelect(timeAxis, t, bbox) {
      void timeAxis;
      return [t, [bbox.rMin, bbox.rMax], [bbox.cMin, bbox.cMax]];
    },
  };
}

/**
 * Half-open cell footprint on a 1-D axis: the interval spanning the midpoints
 * to index `i`'s neighbours, mirroring the one-sided step at either end. Works
 * for ascending or descending axes (the caller orders lo/hi). A single-element
 * axis has no step, so the footprint collapses to the point (lo === hi).
 */
function axisCellSpan(axis: ArrayLike<number>, i: number): [number, number] {
  const v = axis[i];
  const n = axis.length;
  const lo =
    i > 0 ? (v + axis[i - 1]) / 2 : n > 1 ? v - (axis[1] - axis[0]) / 2 : v;
  const hi =
    i < n - 1
      ? (v + axis[i + 1]) / 2
      : n > 1
        ? v + (axis[n - 1] - axis[n - 2]) / 2
        : v;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

function halfOpenBounds(
  lat: ArrayLike<number>,
  i: number,
): { latLo: number; latHi: number } {
  const [latLo, latHi] = axisCellSpan(lat, i);
  return { latLo, latHi };
}

function halfOpenBoundsLon(
  lon: ArrayLike<number>,
  j: number,
): { lonLo: number; lonHi: number } {
  const [lonLo, lonHi] = axisCellSpan(lon, j);
  return { lonLo, lonHi };
}

/**
 * Half-open `[first, last+1)` index range of the cells on a 1-D axis whose
 * FOOTPRINT overlaps `[lo, hi]` — the cover-mode analogue of {@link axisRange}
 * (which keys off centers). The footprints tile the axis contiguously, so the
 * overlapping indices form one run; a single O(n) scan finds it (axes are
 * short). Empty range ⇒ `[0, 0]`.
 */
function axisFootprintRange(
  axis: ArrayLike<number>,
  lo: number,
  hi: number,
): [number, number] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < axis.length; i++) {
    const [flo, fhi] = axisCellSpan(axis, i);
    if (fhi >= lo && flo <= hi) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? [0, 0] : [first, last + 1];
}

function makeNpointsResolver(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
): LayoutResolver {
  assertNumericCoords(lat, "lat");
  assertNumericCoords(lon, "lon");
  const n = lat.length;
  return {
    ndim: 2, // [time, npoints]
    nRows: n,
    nCols: 1,
    latAt: (i) => lat[i],
    lonAt: (i) => lon[i],
    bbox() {
      // No 2-D index space — the point axis spans [0, n); single column.
      return { rMin: 0, rMax: n, cMin: 0, cMax: 1 };
    },
    spatialSelect(timeAxis, t, bbox) {
      void timeAxis;
      // Single trailing spatial axis: [t, [rMin, rMax]].
      return [t, [bbox.rMin, bbox.rMax]];
    },
  };
}

function resolveLayout(layout: SpatialLayout): LayoutResolver {
  switch (layout.kind) {
    case "2d":
      return make2dResolver(layout.grid);
    case "1d":
      return make1dResolver(layout.lat, layout.lon);
    case "npoints":
      return makeNpointsResolver(layout.lat, layout.lon);
    default: {
      const _exhaustive: never = layout;
      throw new SliceError(
        `unsupported spatialLayout kind "${(_exhaustive as { kind: string }).kind}"`,
      );
    }
  }
}

// ── Selection (bbox + stride + row-major mask gather) ────────────────────────

/**
 * Smallest integer stride `s >= 1` with
 * `ceil(rows/s) * ceil(cols/s) <= maxCells`. Returns 1 when `maxCells` is unset
 * or the box already fits.
 */
function computeStride(
  rows: number,
  cols: number,
  maxCells: number | undefined,
): number {
  if (maxCells === undefined || rows * cols <= maxCells) return 1;
  const fits = (k: number): boolean =>
    Math.ceil(rows / k) * Math.ceil(cols / k) <= maxCells;
  // `fits` is monotone in the stride (larger stride ⇒ fewer cells), so binary
  // search the smallest stride that fits. A stride of max(rows, cols) collapses
  // each axis to a single sample (1 cell <= maxCells >= 1), so the range is
  // guaranteed to contain a fitting value.
  let lo = 1;
  let hi = Math.max(rows, cols);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function resolveSelection(
  opts: PolygonReadOptions,
  resolver: LayoutResolver,
): PolygonSelection {
  // "cover" only applies where the resolver can produce cell footprints
  // (rectilinear 1d and curvilinear 2d define them; npoints does not, so it
  // degrades to "center"). `coverBBox` keys off footprints (a superset of the
  // center-bbox), so a sub-cell area that contains no center still has a
  // non-empty scan box.
  const footprint =
    opts.selection === "cover" && typeof resolver.cellBounds === "function"
      ? resolver.cellBounds
      : undefined;
  const coverBBox = footprint ? resolver.coverBBox : undefined;
  const bbox = coverBBox
    ? coverBBox(opts.polygon)
    : resolver.bbox(opts.polygon);

  const rows = bbox.rMax - bbox.rMin;
  const cols = bbox.cMax - bbox.cMin;

  if (rows <= 0 || cols <= 0) {
    return { cells: [], bbox, stride: 1 };
  }

  // Stride-then-mask (D5): decimate the bbox grid, then apply the membership
  // test; clamp the stride down until at least one cell survives.
  let stride = computeStride(rows, cols, opts.maxCells);
  let cells = gatherCells(resolver, bbox, opts.polygon, stride, footprint);
  while (cells.length === 0 && stride > 1) {
    stride--;
    cells = gatherCells(resolver, bbox, opts.polygon, stride, footprint);
  }
  return { cells, bbox, stride };
}

/**
 * Row-major mask gather over the (strided) bbox grid. A cell is kept when its
 * center is inside the ring (`"center"` membership); when `cellBounds` is
 * supplied (`"cover"` membership) it is also kept if its footprint overlaps the
 * polygon (conservative rasterization), so thin/concave areas keep the cells
 * they visibly cover. `cellBounds` is `undefined` for `"center"`.
 */
function gatherCells(
  resolver: LayoutResolver,
  bbox: PolygonBBox,
  ring: Array<[number, number]>,
  stride: number,
  cellBounds: LayoutResolver["cellBounds"],
): PolygonCell[] {
  const cells: PolygonCell[] = [];
  for (let i = bbox.rMin; i < bbox.rMax; i += stride) {
    for (let j = bbox.cMin; j < bbox.cMax; j += stride) {
      const lat = resolver.latAt(i, j);
      const lon = resolver.lonAt(i, j);
      let keep = pointInPolygon(lat, lon, ring);
      if (!keep && cellBounds) {
        const b = cellBounds(i, j);
        keep = polygonOverlapsRect(ring, b.latLo, b.latHi, b.lonLo, b.lonHi);
      }
      if (keep) {
        cells.push({ i, j, lat, lon });
      }
    }
  }
  return cells;
}

// ── Functions ───────────────────────────────────────────────────────────────

/**
 * Resolve the time-invariant selection (cells + positions + bbox + stride) for
 * a polygon over `arr`, without reading any time-varying values (FR-008).
 *
 * The returned `cells` are the grid cells whose lat/lon fall inside the ring
 * (ray-cast, concave-correct — FR-002), ordered row-major over the bounding box
 * (clarification Q1). With `opts.selection === "cover"` (rectilinear 1d and
 * curvilinear 2d layouts) the set also includes cells whose footprint overlaps
 * the ring, so a thin/concave area keeps the cells it visibly covers rather
 * than collapsing to a near-empty selection. `bbox` is the half-open index-space block that fully
 * contains them (the extent {@link readPolygon} reads per time step). `stride`
 * is the applied uniform sub-sampling factor — `1` unless `opts.maxCells` was
 * exceeded (FR-012/FR-013). The `cells` order here is identical to the
 * `values` alignment of every {@link PolygonTimestep} (FR-004).
 *
 * @param arr Array shaped `[time, ...spatial]`. Degenerate size-1 dims between
 *   the time axis and the trailing spatial dims are allowed (e.g. a depth dim
 *   of size 1 in `[time, 1, lat, lon]`) and collapsed by index-0 selection.
 * @param opts Polygon, layout, and read options.
 * @returns The time-invariant selection; `cells: []` for a polygon that selects
 *   nothing (e.g. entirely outside the grid) — not an error (FR-017).
 * @throws {SliceError} on invalid input: non-finite polygon vertex, < 3 distinct
 *   vertices, reversed/out-of-range `timeRange`, non-integer/`< 1` `maxCells`,
 *   array rank below the layout's or exceeding it with a non-singleton middle
 *   dim, unsupported layout, or BigInt coords (FR-018).
 */
export function resolvePolygonCells(
  arr: ZarrArray,
  opts: PolygonReadOptions,
): PolygonSelection {
  const timeAxis = opts.timeAxis ?? 0;
  validatePolygonReadInput(opts, arr.shape[timeAxis]);
  // Reject a rank/layout mismatch before the (potentially expensive) bbox scan
  // and mask gather.
  const resolver = resolveLayout(opts.spatialLayout);
  assertArrayRank(arr, resolver);
  const { cells, bbox, stride } = resolveSelection(opts, resolver);
  return { cells, bbox, stride };
}

/**
 * Inject an index-0 selection for each of the `k` degenerate size-1 middle
 * dims, immediately after the leading time index. Selecting a single index
 * collapses the dim to one element, so the block read stays C-order over
 * `[rows, cols]` and the mask gather (`values[localR * rowStride + localC]`)
 * is unaffected. `k === 0` leaves the selection untouched.
 */
function withSingletonMiddleDims(
  selection: (number | [number, number])[],
  k: number,
): (number | [number, number])[] {
  if (k === 0) return selection;
  selection.splice(1, 0, ...new Array<number>(k).fill(0));
  return selection;
}

/**
 * Stream one {@link PolygonTimestep} per time step in `timeRange` (ascending),
 * yielding only the in-polygon cell values for that step (FR-001).
 *
 * The selection is resolved once up front (same as {@link resolvePolygonCells})
 * -- or, when `opts.resolvedSelection` is supplied, reused verbatim so a caller
 * reading many same-shape variables through one polygon scans the bbox only once
 * -- and each step is read as a single bounding-box block via {@link ZarrArray.get}.
 * A single {@link MemoryCache} is shared across all per-step reads, so a backing
 * chunk that spans the full time axis is fetched/decompressed at most once and
 * reused for every later step (FR-005) — and because only one time slice is
 * materialized at a time, peak working memory tracks ~one slice regardless of
 * the time extent (FR-006). (One exception to the fetch-once reuse: for an
 * *uncompressed* C-order array whose bbox spans the full stored chunk width in
 * every trailing axis, `ZarrArray.get` serves each step with an uncached
 * partial byte-range read, so those steps re-read from the store; the
 * one-slice memory bound still holds.) A caller-supplied `readOptions.memoryCache` is
 * honored; otherwise an internal cache is created per call and discarded when
 * the generator completes. All other `readOptions` (concurrency,
 * maxInFlightBytes, observability, ...) are forwarded (FR-016).
 *
 * @param arr Array shaped `[time, ...spatial]`. Degenerate size-1 dims between
 *   the time axis and the trailing spatial dims (e.g. `[time, 1, lat, lon]`)
 *   are collapsed by index-0 selection, streaming identically to the
 *   equivalent rank-3 array.
 * @param opts Polygon, layout, `timeRange`, `maxCells`, and read options.
 * @throws {SliceError} on invalid input (see {@link resolvePolygonCells}).
 *   Completes with zero yields for an empty selection (FR-017).
 */
export async function* readPolygon(
  arr: ZarrArray,
  opts: PolygonReadOptions,
): AsyncGenerator<PolygonTimestep, void, void> {
  const timeAxis = opts.timeAxis ?? 0;
  const nTime = arr.shape[timeAxis];
  validatePolygonReadInput(opts, nTime);

  // Reject a rank/layout mismatch before the (potentially expensive) bbox scan
  // and mask gather.
  const resolver = resolveLayout(opts.spatialLayout);
  // `singletonMiddleDims` (k) counts degenerate size-1 axes between time and
  // the trailing spatial dims (e.g. depth in `[time, 1, lat, lon]`); each is
  // collapsed by selecting index 0 in the per-step read below.
  const singletonMiddleDims = assertArrayRank(arr, resolver);
  // Reuse a caller-supplied selection (resolved ONCE for many same-shape
  // variables) instead of re-scanning the bbox per read; see
  // `PolygonReadOptions.resolvedSelection`. Absent it, resolve as before. A
  // supplied selection is trusted verbatim but bounds-checked against this
  // array's spatial extents first, so a mismatched shape errors cleanly rather
  // than slicing out of range into silent fill/NaN values.
  if (opts.resolvedSelection) {
    assertSelectionInBounds(opts.resolvedSelection, resolver);
  }
  const { cells, bbox } =
    opts.resolvedSelection ?? resolveSelection(opts, resolver);
  if (cells.length === 0) return;

  const [tStart, tEnd] = opts.timeRange ?? [0, nTime];

  // Share one MemoryCache across all per-step reads so a chunk spanning the
  // full time axis is fetched/decoded once and reused for every later step.
  const baseReadOptions = opts.readOptions ?? {};
  const readOptions: ReadOptions = {
    ...baseReadOptions,
    memoryCache:
      baseReadOptions.memoryCache ??
      new MemoryCache({ maxBytes: INTERNAL_CACHE_BYTES }),
  };

  const rowStride = bbox.cMax - bbox.cMin;
  for (let t = tStart; t < tEnd; t++) {
    const selection = withSingletonMiddleDims(
      resolver.spatialSelect(timeAxis, t, bbox),
      singletonMiddleDims,
    );
    const block = await arr.get(selection, readOptions);
    const values = new Float64Array(cells.length);
    for (let k = 0; k < cells.length; k++) {
      const cell = cells[k];
      // Block is C-order over [rows, cols] of the bbox (time index collapses).
      const localR = cell.i - bbox.rMin;
      const localC = cell.j - bbox.cMin;
      values[k] = Number(
        (block as unknown as ArrayLike<number>)[localR * rowStride + localC],
      );
    }
    yield { t, values };
  }
}
