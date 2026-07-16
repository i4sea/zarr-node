import { describe, it, expect } from "vitest";
import { resolvePolygonCells, GridIndex } from "../../src/spatial/index.js";
import type { SpatialLayout } from "../../src/spatial/index.js";
import { openArray } from "../../src/index.js";
import type { ZarrArray } from "../../src/array.js";
import type { Store } from "../../src/store/store.js";

/**
 * `selection: "cover"` — conservative rasterization for polygon cell
 * membership. The default `"center"` keeps a cell only when its center lands
 * inside the ring, so a thin or concave polygon narrower than the grid step
 * selects few — or zero — cells (forcing the caller into a degenerate
 * single-cell fallback). `"cover"` also keeps cells whose FOOTPRINT overlaps
 * the polygon, so the selection tracks the cells the shape visibly covers.
 *
 * Shapes here reproduce the hard cases: a thin concave "U" ribbon (low fill
 * ratio, centroid outside the ring) and a sub-cell square that contains no
 * cell center — on both the 1d-rectilinear and 2d-curvilinear layouts.
 */

const encoder = new TextEncoder();

class MapStore implements Store {
  constructor(readonly map: Map<string, Uint8Array>) {}
  async get(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null;
  }
  async has(key: string): Promise<boolean> {
    return this.map.has(key);
  }
  async *list(prefix: string): AsyncIterable<string> {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) yield k;
  }
}

/** Minimal uncompressed [1, ny, nx] f8 array; resolvePolygonCells reads only shape. */
async function makeTimeGrid(ny: number, nx: number): Promise<ZarrArray> {
  const map = new Map<string, Uint8Array>();
  map.set(
    ".zarray",
    encoder.encode(
      JSON.stringify({
        zarr_format: 2,
        shape: [1, ny, nx],
        chunks: [1, ny, nx],
        dtype: "<f8",
        compressor: null,
        fill_value: 0,
        order: "C",
        dimension_separator: ".",
        filters: null,
      }),
    ),
  );
  map.set("0.0.0", new Uint8Array(new Float64Array(ny * nx).buffer));
  return openArray(new MapStore(map));
}

/** Ascending axis of `n` centers starting at `first`, spaced by `step`. */
function axis(first: number, step: number, n: number): Float64Array {
  return Float64Array.from({ length: n }, (_v, k) =>
    Number((first + k * step).toFixed(6)),
  );
}

function keySet(sel: { cells: Array<{ i: number; j: number }> }): Set<string> {
  return new Set(sel.cells.map((c) => `${c.i},${c.j}`));
}

/** A thin, concave "U" ribbon (bars ~0.02 wide) opening toward +lat. Fill ~0.09. */
const U_RIBBON: Array<[number, number]> = [
  [0.0, 0.0],
  [0.0, 1.0],
  [0.4, 1.0],
  [0.4, 0.98],
  [0.02, 0.98],
  [0.02, 0.02],
  [0.4, 0.02],
  [0.4, 0.0],
];

describe("resolvePolygonCells selection: cover vs center", () => {
  it("cover is always a superset of center (thin U ribbon, fine grid)", async () => {
    // ~0.05 deg cells, centers offset off the bar edges to avoid boundary ties.
    const lat = axis(-0.025, 0.05, 12); // -0.025 .. 0.525
    const lon = axis(-0.025, 0.05, 24); // -0.025 .. 1.125
    const arr = await makeTimeGrid(lat.length, lon.length);
    const layout: SpatialLayout = { kind: "1d", lat, lon };
    const base = {
      polygon: U_RIBBON,
      spatialLayout: layout,
      timeRange: [0, 1] as [number, number],
    };

    const center = resolvePolygonCells(arr, { ...base, selection: "center" });
    const cover = resolvePolygonCells(arr, { ...base, selection: "cover" });

    const c = keySet(center);
    const cov = keySet(cover);
    for (const k of c) expect(cov.has(k)).toBe(true); // cover ⊇ center
    expect(cover.cells.length).toBeGreaterThan(center.cells.length); // ribbon adds boundary cells
  });

  it("coarse grid: center collapses to empty, cover stays populated", async () => {
    // ~0.2 deg cells: no center lands inside the 0.02-wide bars -> center empty.
    const lat = axis(0.1, 0.2, 3); // 0.1, 0.3, 0.5
    const lon = axis(0.1, 0.2, 6); // 0.1 .. 1.1
    const arr = await makeTimeGrid(lat.length, lon.length);
    const layout: SpatialLayout = { kind: "1d", lat, lon };
    const base = {
      polygon: U_RIBBON,
      spatialLayout: layout,
      timeRange: [0, 1] as [number, number],
    };

    const center = resolvePolygonCells(arr, { ...base, selection: "center" });
    const cover = resolvePolygonCells(arr, { ...base, selection: "cover" });

    expect(center.cells.length).toBe(0); // <-- would trigger the centroid fallback
    expect(cover.cells.length).toBeGreaterThan(0); // never empty for a covering grid
  });

  it("sub-cell polygon between four centers: center empty, cover keeps the straddled cells", async () => {
    const lat = axis(0, 1, 5); // 0,1,2,3,4
    const lon = axis(0, 1, 5);
    const arr = await makeTimeGrid(lat.length, lon.length);
    const layout: SpatialLayout = { kind: "1d", lat, lon };
    // A small square in the gap between centers (2,2),(2,3),(3,2),(3,3) — contains no center.
    const square: Array<[number, number]> = [
      [2.3, 2.3],
      [2.3, 2.7],
      [2.7, 2.7],
      [2.7, 2.3],
    ];
    const base = {
      polygon: square,
      spatialLayout: layout,
      timeRange: [0, 1] as [number, number],
    };

    const center = resolvePolygonCells(arr, { ...base, selection: "center" });
    const cover = resolvePolygonCells(arr, { ...base, selection: "cover" });

    expect(center.cells.length).toBe(0);
    expect(cover.cells.length).toBeGreaterThan(0);
  });

  it("default and explicit center are unchanged (back-compat)", async () => {
    const lat = axis(-0.025, 0.05, 12);
    const lon = axis(-0.025, 0.05, 24);
    const arr = await makeTimeGrid(lat.length, lon.length);
    const layout: SpatialLayout = { kind: "1d", lat, lon };
    const base = {
      polygon: U_RIBBON,
      spatialLayout: layout,
      timeRange: [0, 1] as [number, number],
    };

    const def = resolvePolygonCells(arr, base);
    const explicit = resolvePolygonCells(arr, { ...base, selection: "center" });
    expect(keySet(def)).toEqual(keySet(explicit));
  });
});

/**
 * `latOf(i, j)` / `lonOf(i, j)` build a curvilinear GridIndex — WRF & other
 * projected weather grids surface as 2d-curvilinear (nautilus `toReaderLayout`),
 * so `"cover"` must work there too, not only on regular lat/lon (1d).
 */
function makeGrid2d(
  ny: number,
  nx: number,
  latOf: (i: number, j: number) => number,
  lonOf: (i: number, j: number) => number,
): GridIndex {
  const lat = new Float64Array(ny * nx);
  const lon = new Float64Array(ny * nx);
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      lat[i * nx + j] = latOf(i, j);
      lon[i * nx + j] = lonOf(i, j);
    }
  }
  return GridIndex.fromCoordinates(lat, lon, ny, nx);
}

describe("resolvePolygonCells selection: cover on 2d-curvilinear grids", () => {
  it("rectilinear-as-2D fine grid: cover is a superset and adds cells", async () => {
    const ny = 12;
    const nx = 24;
    const grid = makeGrid2d(
      ny,
      nx,
      (i) => -0.025 + 0.05 * i,
      (_i, j) => -0.025 + 0.05 * j,
    );
    const arr = await makeTimeGrid(ny, nx);
    const base = {
      polygon: U_RIBBON,
      spatialLayout: { kind: "2d", grid } as SpatialLayout,
      timeRange: [0, 1] as [number, number],
    };
    const center = resolvePolygonCells(arr, { ...base, selection: "center" });
    const cover = resolvePolygonCells(arr, { ...base, selection: "cover" });

    const c = keySet(center);
    const cov = keySet(cover);
    for (const k of c) expect(cov.has(k)).toBe(true);
    expect(cover.cells.length).toBeGreaterThan(center.cells.length);
  });

  it("coarse 2D grid: center collapses to empty, cover stays populated", async () => {
    const ny = 3;
    const nx = 6;
    const grid = makeGrid2d(
      ny,
      nx,
      (i) => 0.1 + 0.2 * i,
      (_i, j) => 0.1 + 0.2 * j,
    );
    const arr = await makeTimeGrid(ny, nx);
    const base = {
      polygon: U_RIBBON,
      spatialLayout: { kind: "2d", grid } as SpatialLayout,
      timeRange: [0, 1] as [number, number],
    };
    const center = resolvePolygonCells(arr, { ...base, selection: "center" });
    const cover = resolvePolygonCells(arr, { ...base, selection: "cover" });

    expect(center.cells.length).toBe(0);
    expect(cover.cells.length).toBeGreaterThan(0);
  });

  it("skewed (genuinely curvilinear) grid: cover superset, non-empty", async () => {
    const ny = 12;
    const nx = 24;
    // lat depends on BOTH i and j (and lon likewise): a small rotation/skew so
    // the grid is not separable into 1-D axes.
    const grid = makeGrid2d(
      ny,
      nx,
      (i, j) => -0.025 + 0.05 * i + 0.002 * (j - nx / 2),
      (i, j) => -0.025 + 0.05 * j + 0.002 * (i - ny / 2),
    );
    const arr = await makeTimeGrid(ny, nx);
    const base = {
      polygon: U_RIBBON,
      spatialLayout: { kind: "2d", grid } as SpatialLayout,
      timeRange: [0, 1] as [number, number],
    };
    const center = resolvePolygonCells(arr, { ...base, selection: "center" });
    const cover = resolvePolygonCells(arr, { ...base, selection: "cover" });

    const c = keySet(center);
    const cov = keySet(cover);
    for (const k of c) expect(cov.has(k)).toBe(true);
    expect(cover.cells.length).toBeGreaterThanOrEqual(center.cells.length);
    expect(cover.cells.length).toBeGreaterThan(0);
  });
});
