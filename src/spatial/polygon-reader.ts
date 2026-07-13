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
  /** Axis index of time. Default: 0. */
  timeAxis?: number;
  /** Half-open [startIdx, endIdx) in time indices. Default: full time extent. */
  timeRange?: [number, number];
  /** Cell budget; exceeding it applies a clamped spatial stride. Default: none. */
  maxCells?: number;
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
    if (
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
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
 * Throws {@link SliceError} on invalid input (< 3 distinct polygon vertices;
 * reversed or out-of-range `timeRange`; `maxCells < 1`). An empty selection is
 * NOT an error and is not detected here.
 *
 * @param nTime Length of the time axis (`arr.shape[timeAxis]`).
 * @internal
 */
export function validatePolygonReadInput(
  opts: PolygonReadOptions,
  nTime: number,
): void {
  if (!Array.isArray(opts.polygon) || distinctVertexCount(opts.polygon) < 3) {
    throw new SliceError(
      "polygon must have at least 3 distinct [lat, lon] vertices",
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
  if (opts.maxCells !== undefined && (!(opts.maxCells >= 1) || !Number.isFinite(opts.maxCells))) {
    throw new SliceError(`maxCells must be >= 1, got ${opts.maxCells}`);
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

/** Bounding box in polygon (lat/lon) space. */
function polygonEnvelope(
  ring: Array<[number, number]>,
): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
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
  nRows: number;
  nCols: number;
  latAt(i: number, j: number): number;
  lonAt(i: number, j: number): number;
  /** Bounding box (half-open, index space) fully containing the polygon. */
  bbox(ring: Array<[number, number]>): PolygonBBox;
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
    nRows: grid.ny,
    nCols: grid.nx,
    latAt: (i, j) => grid.latAt(i, j),
    lonAt: (i, j) => grid.lonAt(i, j),
    bbox(ring) {
      // Envelope-corner nearest cells + 1-cell padding to guard against
      // nearest misses on skewed/curvilinear grids.
      const env = polygonEnvelope(ring);
      const corners: Array<[number, number]> = [
        [env.latMin, env.lonMin],
        [env.latMin, env.lonMax],
        [env.latMax, env.lonMin],
        [env.latMax, env.lonMax],
      ];
      let rMin = Infinity;
      let rMax = -Infinity;
      let cMin = Infinity;
      let cMax = -Infinity;
      for (const [lat, lon] of corners) {
        const { i, j } = grid.nearest(lat, lon);
        if (i < rMin) rMin = i;
        if (i > rMax) rMax = i;
        if (j < cMin) cMin = j;
        if (j > cMax) cMax = j;
      }
      const PAD = 1;
      const [r0, r1] = clampRange(rMin - PAD, rMax + 1 + PAD, grid.ny);
      const [c0, c1] = clampRange(cMin - PAD, cMax + 1 + PAD, grid.nx);
      return { rMin: r0, rMax: r1, cMin: c0, cMax: c1 };
    },
    spatialSelect(timeAxis, t, bbox) {
      // v1: time axis leads; two trailing spatial axes.
      void timeAxis;
      return [t, [bbox.rMin, bbox.rMax], [bbox.cMin, bbox.cMax]];
    },
  };
}

/**
 * Half-open `[start, end)` index range on a monotonic axis whose coordinates
 * fall within `[lo, hi]`. Works for ascending or descending axes (the index
 * span is direction-agnostic). Empty range ⇒ `[0, 0]`.
 */
function axisRange(
  axis: ArrayLike<number>,
  lo: number,
  hi: number,
): [number, number] {
  let start = axis.length;
  let end = 0;
  for (let k = 0; k < axis.length; k++) {
    const v = axis[k];
    if (v >= lo && v <= hi) {
      if (k < start) start = k;
      if (k + 1 > end) end = k + 1;
    }
  }
  return start >= end ? [0, 0] : [start, end];
}

function make1dResolver(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
): LayoutResolver {
  assertNumericCoords(lat, "lat");
  assertNumericCoords(lon, "lon");
  return {
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
    spatialSelect(timeAxis, t, bbox) {
      void timeAxis;
      return [t, [bbox.rMin, bbox.rMax], [bbox.cMin, bbox.cMax]];
    },
  };
}

function makeNpointsResolver(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
): LayoutResolver {
  assertNumericCoords(lat, "lat");
  assertNumericCoords(lon, "lon");
  const n = lat.length;
  return {
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
  let s = 1;
  const fits = (k: number): boolean =>
    Math.ceil(rows / k) * Math.ceil(cols / k) <= maxCells;
  // rows*cols > maxCells >= 1, so some finite stride fits.
  while (!fits(s)) s++;
  return s;
}

interface ResolvedSelection extends PolygonSelection {
  resolver: LayoutResolver;
}

function resolveSelection(
  opts: PolygonReadOptions,
): ResolvedSelection {
  const resolver = resolveLayout(opts.spatialLayout);
  const bbox = resolver.bbox(opts.polygon);
  const rows = bbox.rMax - bbox.rMin;
  const cols = bbox.cMax - bbox.cMin;

  if (rows <= 0 || cols <= 0) {
    return { cells: [], bbox, stride: 1, resolver };
  }

  // Stride-then-mask (D5): decimate the bbox grid, then apply the ray-cast
  // mask; clamp the stride down until at least one in-polygon cell survives.
  let stride = computeStride(rows, cols, opts.maxCells);
  let cells = gatherCells(resolver, bbox, opts.polygon, stride);
  while (cells.length === 0 && stride > 1) {
    stride--;
    cells = gatherCells(resolver, bbox, opts.polygon, stride);
  }
  return { cells, bbox, stride, resolver };
}

/** Row-major mask gather over the (strided) bbox grid. */
function gatherCells(
  resolver: LayoutResolver,
  bbox: PolygonBBox,
  ring: Array<[number, number]>,
  stride: number,
): PolygonCell[] {
  const cells: PolygonCell[] = [];
  for (let i = bbox.rMin; i < bbox.rMax; i += stride) {
    for (let j = bbox.cMin; j < bbox.cMax; j += stride) {
      const lat = resolver.latAt(i, j);
      const lon = resolver.lonAt(i, j);
      if (pointInPolygon(lat, lon, ring)) {
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
 * (clarification Q1). `bbox` is the half-open index-space block that fully
 * contains them (the extent {@link readPolygon} reads per time step). `stride`
 * is the applied uniform sub-sampling factor — `1` unless `opts.maxCells` was
 * exceeded (FR-012/FR-013). The `cells` order here is identical to the
 * `values` alignment of every {@link PolygonTimestep} (FR-004).
 *
 * @param arr Array shaped `[time, ...spatial]`.
 * @param opts Polygon, layout, and read options.
 * @returns The time-invariant selection; `cells: []` for a polygon that selects
 *   nothing (e.g. entirely outside the grid) — not an error (FR-017).
 * @throws {SliceError} on invalid input: < 3 distinct vertices, reversed/out-of
 *   -range `timeRange`, `maxCells < 1`, unsupported layout, or BigInt coords
 *   (FR-018).
 */
export function resolvePolygonCells(
  arr: ZarrArray,
  opts: PolygonReadOptions,
): PolygonSelection {
  const timeAxis = opts.timeAxis ?? 0;
  validatePolygonReadInput(opts, arr.shape[timeAxis]);
  const { cells, bbox, stride } = resolveSelection(opts);
  return { cells, bbox, stride };
}

/**
 * Stream one {@link PolygonTimestep} per time step in `timeRange` (ascending),
 * yielding only the in-polygon cell values for that step (FR-001).
 *
 * The selection is resolved once up front (same as {@link resolvePolygonCells})
 * and each step is read as a single bounding-box block via {@link ZarrArray.get}.
 * A single {@link MemoryCache} is shared across all per-step reads, so a backing
 * chunk that spans the full time axis is fetched/decompressed at most once and
 * reused for every later step (FR-005) — and because only one time slice is
 * materialized at a time, peak working memory tracks ~one slice regardless of
 * the time extent (FR-006). A caller-supplied `readOptions.memoryCache` is
 * honored; otherwise an internal cache is created per call and discarded when
 * the generator completes. All other `readOptions` (concurrency,
 * maxInFlightBytes, observability, ...) are forwarded (FR-016).
 *
 * @param arr Array shaped `[time, ...spatial]`.
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

  const { cells, bbox, resolver } = resolveSelection(opts);
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
    const selection = resolver.spatialSelect(timeAxis, t, bbox);
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
