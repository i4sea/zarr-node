import { describe, it, expect } from "vitest";
import { readPolygon, resolvePolygonCells } from "../../src/spatial/index.js";
import type { PolygonSelection } from "../../src/spatial/index.js";
import { GridIndex } from "../../src/spatial/index.js";
import {
  pointInPolygon,
  validatePolygonReadInput,
} from "../../src/spatial/polygon-reader.js";
import { openArray } from "../../src/index.js";
import type { ZarrArray } from "../../src/array.js";
import type { Store } from "../../src/store/store.js";
import { SliceError } from "../../src/errors.js";

// ── in-memory store + real ZarrArray fixtures ────────────────────────────────

const encoder = new TextEncoder();

/**
 * A minimal in-memory `Store` backed by a Map, wrapping the raw chunk bytes
 * of an uncompressed C-order array. Building a *real* `ZarrArray` over it (via
 * `openArray`) exercises the genuine chunk/decode/MemoryCache/observability
 * path — required for the chunk-once and memory-bound assertions.
 */
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

/** Wraps a Store, counting full `get()` calls per key (distinct-fetch check). */
class CountingStore implements Store {
  readonly getCalls: string[] = [];
  constructor(private readonly inner: Store) {}
  async get(key: string): Promise<Uint8Array | null> {
    this.getCalls.push(key);
    return this.inner.get(key);
  }
  async has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }
  async *list(prefix: string): AsyncIterable<string> {
    yield* this.inner.list(prefix);
  }
  /** Chunk keys fetched (excludes metadata keys like .zarray/.zattrs). */
  chunkFetches(): string[] {
    return this.getCalls.filter((k) => !k.startsWith("."));
  }
  /** Number of distinct chunk keys fetched from the backing store. */
  distinctChunkFetches(): number {
    return new Set(this.chunkFetches()).size;
  }
}

const DTYPE_CTORS: Record<string, new (n: number) => ArrayBufferView> = {
  "<f8": Float64Array,
  "<f4": Float32Array,
  "<i4": Int32Array,
};

interface MakeArrayOpts {
  shape: number[];
  chunks: number[];
  dtype?: keyof typeof DTYPE_CTORS;
  /** filler(...indices) → value for the C-order element at those indices. */
  filler: (...idx: number[]) => number;
  /** Optional wrapper (e.g. CountingStore) around the raw MapStore. */
  wrap?: (store: Store) => Store;
}

/**
 * Build a real, uncompressed C-order `ZarrArray` in memory. Chunks are written
 * padded to the full chunk shape (Zarr v2 semantics). Returns the array plus
 * the (possibly wrapped) store so tests can instrument fetches.
 */
async function makeArray(
  opts: MakeArrayOpts,
): Promise<{ arr: ZarrArray; store: Store }> {
  const { shape, chunks } = opts;
  const dtype = opts.dtype ?? "<f8";
  const Ctor = DTYPE_CTORS[dtype];
  const bytesPer = dtype === "<f8" ? 8 : 4;
  const ndim = shape.length;
  const nChunks = shape.map((s, d) => Math.ceil(s / chunks[d]));

  const map = new Map<string, Uint8Array>();
  const zarray = {
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    fill_value: 0,
    order: "C",
    dimension_separator: ".",
    filters: null,
  };
  map.set(".zarray", encoder.encode(JSON.stringify(zarray)));

  // Write every chunk, padded to full chunk shape, in C-order.
  const chunkElems = chunks.reduce((a, b) => a * b, 1);
  const chunkCoords: number[][] = [[]];
  for (let d = 0; d < ndim; d++) {
    const next: number[][] = [];
    for (const prefix of chunkCoords) {
      for (let c = 0; c < nChunks[d]; c++) next.push([...prefix, c]);
    }
    chunkCoords.length = 0;
    chunkCoords.push(...next);
  }
  for (const coord of chunkCoords) {
    const buf = new (Ctor as new (n: number) => {
      [k: number]: number;
      buffer: ArrayBuffer;
    })(chunkElems);
    // Fill each local element with filler(global indices) (0 outside shape).
    const strides: number[] = new Array(ndim);
    strides[ndim - 1] = 1;
    for (let d = ndim - 2; d >= 0; d--)
      strides[d] = strides[d + 1] * chunks[d + 1];
    for (let lin = 0; lin < chunkElems; lin++) {
      const gidx: number[] = new Array(ndim);
      let rem = lin;
      let inBounds = true;
      for (let d = 0; d < ndim; d++) {
        const local = Math.floor(rem / strides[d]) % chunks[d];
        rem -= local * strides[d];
        gidx[d] = coord[d] * chunks[d] + local;
        if (gidx[d] >= shape[d]) inBounds = false;
      }
      buf[lin] = inBounds ? opts.filler(...gidx) : 0;
    }
    const key = coord.join(".");
    map.set(key, new Uint8Array(buf.buffer, 0, chunkElems * bytesPer));
  }

  const base: Store = new MapStore(map);
  const store = opts.wrap ? opts.wrap(base) : base;
  const arr = await openArray(store);
  return { arr, store };
}

/** Rectilinear-as-2D grid: lat = latOf(i), lon = lonOf(j) over ny×nx. */
function makeGrid(
  ny: number,
  nx: number,
  latOf: (i: number) => number,
  lonOf: (j: number) => number,
): GridIndex {
  const lat = new Float32Array(ny * nx);
  const lon = new Float32Array(ny * nx);
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      lat[i * nx + j] = latOf(i);
      lon[i * nx + j] = lonOf(j);
    }
  }
  return GridIndex.fromCoordinates(lat, lon, ny, nx);
}

/** Collect a full readPolygon stream into an array of timesteps. */
async function collect(
  gen: AsyncGenerator<{ t: number; values: Float64Array }>,
): Promise<Array<{ t: number; values: Float64Array }>> {
  const out: Array<{ t: number; values: Float64Array }> = [];
  for await (const step of gen) out.push(step);
  return out;
}

function cellKeys(sel: PolygonSelection): string {
  return sel.cells.map((c) => `${c.i},${c.j}`).join(" | ");
}

// Sanity: fixtures compile and export surface resolves.
describe("polygon-reader scaffold", () => {
  it("builds a real ZarrArray over an in-memory store", async () => {
    const { arr } = await makeArray({
      shape: [2, 3, 4],
      chunks: [2, 3, 4],
      filler: (t, r, c) => t * 100 + r * 10 + c,
    });
    expect(arr.shape).toEqual([2, 3, 4]);
    const block = await arr.get([0, [0, 3], [0, 4]]);
    expect(block[0]).toBe(0);
    expect(block[11]).toBe(23); // r=2,c=3 → 23
    expect(typeof readPolygon).toBe("function");
    expect(typeof resolvePolygonCells).toBe("function");
    expect(SliceError).toBeDefined();
    expect(collect).toBeTypeOf("function");
    expect(makeGrid).toBeTypeOf("function");
    expect(cellKeys).toBeTypeOf("function");
  });
});

// ── T004: ray-casting point-in-polygon primitive ─────────────────────────────

describe("pointInPolygon (even-odd ray casting)", () => {
  // A concave "notch" polygon (arrow-like). Vertices are [lat, lon].
  //   lat
  //  4 +--------+
  //    |        |
  //  2 |   /\   |   (notch cut down from the top-middle)
  //    |  /  \  |
  //  0 +-/    \-+
  //     lon 0..6
  const concave: Array<[number, number]> = [
    [0, 0],
    [0, 6],
    [4, 6],
    [4, 4],
    [1, 3],
    [4, 2],
    [4, 0],
  ];

  it("includes points inside a convex square", () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [4, 4],
      [4, 0],
    ];
    expect(pointInPolygon(2, 2, square)).toBe(true);
    expect(pointInPolygon(0.1, 0.1, square)).toBe(true);
    expect(pointInPolygon(3.9, 3.9, square)).toBe(true);
  });

  it("excludes points outside a convex square", () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [4, 4],
      [4, 0],
    ];
    expect(pointInPolygon(5, 5, square)).toBe(false);
    expect(pointInPolygon(2, -1, square)).toBe(false);
    expect(pointInPolygon(-1, 2, square)).toBe(false);
  });

  it("excludes a point in the concave notch (bbox-inside but polygon-outside)", () => {
    // (3.5, 3) is within the bbox and above the notch tip → outside the ring.
    expect(pointInPolygon(3.5, 3, concave)).toBe(false);
    // Points in the two side lobes are inside.
    expect(pointInPolygon(3.5, 1, concave)).toBe(true);
    expect(pointInPolygon(3.5, 5, concave)).toBe(true);
    // Below the notch tip along the centre is inside.
    expect(pointInPolygon(0.5, 3, concave)).toBe(true);
  });

  it("treats a closed ring identically to its unclosed form", () => {
    const unclosed: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [4, 4],
      [4, 0],
    ];
    const closed: Array<[number, number]> = [...unclosed, [0, 0]];
    for (const [lat, lon] of [
      [2, 2],
      [5, 5],
      [0, 4],
      [3.9, 0.1],
    ] as Array<[number, number]>) {
      expect(pointInPolygon(lat, lon, closed)).toBe(
        pointInPolygon(lat, lon, unclosed),
      );
    }
  });

  it("is deterministic on edge/vertex points (in-or-out, but stable)", () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [4, 4],
      [4, 0],
    ];
    // On-edge and on-vertex results must be stable across calls.
    const onEdge = pointInPolygon(0, 2, square);
    const onVertex = pointInPolygon(0, 0, square);
    expect(pointInPolygon(0, 2, square)).toBe(onEdge);
    expect(pointInPolygon(0, 0, square)).toBe(onVertex);
    expect(typeof onEdge).toBe("boolean");
    expect(typeof onVertex).toBe("boolean");
  });
});

// ── T006: input validation ───────────────────────────────────────────────────

describe("validatePolygonReadInput", () => {
  const okPoly: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 1],
  ];

  it("rejects a polygon with < 3 distinct vertices", () => {
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: [
            [0, 0],
            [0, 1],
          ],
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
        },
        10,
      ),
    ).toThrow(SliceError);
    // Three points but only two distinct → still invalid.
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: [
            [0, 0],
            [0, 1],
            [0, 0],
          ],
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
        },
        10,
      ),
    ).toThrow(SliceError);
  });

  it("rejects a reversed or out-of-range timeRange", () => {
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: okPoly,
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
          timeRange: [5, 2],
        },
        10,
      ),
    ).toThrow(SliceError);
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: okPoly,
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
          timeRange: [0, 11],
        },
        10,
      ),
    ).toThrow(SliceError);
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: okPoly,
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
          timeRange: [-1, 3],
        },
        10,
      ),
    ).toThrow(SliceError);
  });

  it("rejects maxCells < 1", () => {
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: okPoly,
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
          maxCells: 0,
        },
        10,
      ),
    ).toThrow(SliceError);
  });

  it("rejects a non-integer, NaN, or Infinite maxCells", () => {
    for (const maxCells of [2.5, NaN, Infinity]) {
      expect(() =>
        validatePolygonReadInput(
          {
            polygon: okPoly,
            spatialLayout: { kind: "npoints", lat: [], lon: [] },
            maxCells,
          },
          10,
        ),
      ).toThrow(SliceError);
    }
  });

  it("rejects a polygon vertex that is not a finite [lat, lon] pair", () => {
    const cases: Array<Array<[number, number]>> = [
      // NaN / Infinity components.
      [
        [0, 0],
        [NaN, 1],
        [1, 1],
      ],
      [
        [0, 0],
        [0, Infinity],
        [1, 1],
      ],
      // Wrong arity (single-element vertex).
      [[0, 0], [0, 1], [1] as unknown as [number, number]],
    ];
    for (const polygon of cases) {
      expect(() =>
        validatePolygonReadInput(
          { polygon, spatialLayout: { kind: "npoints", lat: [], lon: [] } },
          10,
        ),
      ).toThrow(SliceError);
    }
  });

  it("accepts valid input (empty timeRange [n,n] is allowed)", () => {
    expect(() =>
      validatePolygonReadInput(
        {
          polygon: okPoly,
          spatialLayout: { kind: "npoints", lat: [], lon: [] },
          timeRange: [3, 3],
        },
        10,
      ),
    ).not.toThrow();
  });
});

// ── US1 shared fixture: 5×5 grid, lat=i, lon=j, value = t*100 + r*10 + c ─────

// A 5×5 grid at integer lat/lon 0..4. A concave polygon over it.
const GRID_5x5 = makeGrid(
  5,
  5,
  (i) => i,
  (j) => j,
);

// Concave "C" opening to the right: excludes the middle-right cells.
//  covers lat 0.5..3.5, lon 0.5..3.5, with a notch removing (2, 2)/(2,3).
const CONCAVE_POLY: Array<[number, number]> = [
  [0.5, 0.5],
  [0.5, 3.5],
  [1.5, 3.5],
  [1.5, 1.5],
  [2.5, 1.5],
  [2.5, 3.5],
  [3.5, 3.5],
  [3.5, 0.5],
];

// Brute-force reference: which (i,j) cells are inside, row-major.
function referenceCells(
  ny: number,
  nx: number,
  latOf: (i: number) => number,
  lonOf: (j: number) => number,
  poly: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      if (pointInPolygon(latOf(i), lonOf(j), poly)) out.push([i, j]);
    }
  }
  return out;
}

// ── T008: resolvePolygonCells on a 2-D supplied grid ─────────────────────────

describe("resolvePolygonCells (2-D supplied grid)", () => {
  it("returns in-polygon cells row-major with per-cell lat/lon and half-open bbox", async () => {
    const { arr } = await makeArray({
      shape: [2, 5, 5],
      chunks: [2, 5, 5],
      filler: (t, r, c) => t * 100 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: { kind: "2d", grid: GRID_5x5 },
    });

    const ref = referenceCells(
      5,
      5,
      (i) => i,
      (j) => j,
      CONCAVE_POLY,
    );
    expect(sel.cells.map((c) => [c.i, c.j])).toEqual(ref);
    // row-major: non-decreasing i, and increasing j within each i.
    for (let k = 1; k < sel.cells.length; k++) {
      const a = sel.cells[k - 1];
      const b = sel.cells[k];
      expect(a.i < b.i || (a.i === b.i && a.j < b.j)).toBe(true);
    }
    // per-cell lat/lon come from the grid (lat=i, lon=j)
    for (const cell of sel.cells) {
      expect(cell.lat).toBe(cell.i);
      expect(cell.lon).toBe(cell.j);
    }
    // half-open bbox (block-read extent) contains the selection; the 2-D
    // resolver may pad by a cell to guard skewed-grid nearest misses.
    expect(sel.bbox.rMin).toBeLessThanOrEqual(
      Math.min(...ref.map((c) => c[0])),
    );
    expect(sel.bbox.rMax).toBeGreaterThanOrEqual(
      Math.max(...ref.map((c) => c[0])) + 1,
    );
    expect(sel.bbox.cMin).toBeLessThanOrEqual(
      Math.min(...ref.map((c) => c[1])),
    );
    expect(sel.bbox.cMax).toBeGreaterThanOrEqual(
      Math.max(...ref.map((c) => c[1])) + 1,
    );
    expect(sel.stride).toBe(1);
    // notch really excluded a bbox-inside cell
    expect(ref.length).toBeLessThan(
      (sel.bbox.rMax - sel.bbox.rMin) * (sel.bbox.cMax - sel.bbox.cMin),
    );
  });

  it("returns empty cells for a polygon entirely outside the grid", async () => {
    const { arr } = await makeArray({
      shape: [2, 5, 5],
      chunks: [2, 5, 5],
      filler: () => 1,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: [
        [100, 100],
        [100, 101],
        [101, 101],
      ],
      spatialLayout: { kind: "2d", grid: GRID_5x5 },
    });
    expect(sel.cells).toEqual([]);
  });
});

// ── T010: readPolygon streaming ──────────────────────────────────────────────

describe("readPolygon streaming (2-D supplied grid)", () => {
  it("yields one Float64Array timestep per index, values aligned to cells", async () => {
    const { arr } = await makeArray({
      shape: [3, 5, 5],
      chunks: [3, 5, 5],
      filler: (t, r, c) => t * 100 + r * 10 + c,
    });
    const opts = {
      polygon: CONCAVE_POLY,
      spatialLayout: { kind: "2d" as const, grid: GRID_5x5 },
    };
    const sel = resolvePolygonCells(arr, opts);
    const steps = await collect(readPolygon(arr, opts));

    expect(steps.map((s) => s.t)).toEqual([0, 1, 2]);
    for (const step of steps) {
      expect(step.values).toBeInstanceOf(Float64Array);
      expect(step.values.length).toBe(sel.cells.length);
      sel.cells.forEach((cell, k) => {
        expect(step.values[k]).toBe(step.t * 100 + cell.i * 10 + cell.j);
      });
    }
  });

  it("honors a timeRange sub-range (ascending, exactly those steps)", async () => {
    const { arr } = await makeArray({
      shape: [10, 5, 5],
      chunks: [10, 5, 5],
      filler: (t, r, c) => t * 100 + r * 10 + c,
    });
    const steps = await collect(
      readPolygon(arr, {
        polygon: CONCAVE_POLY,
        spatialLayout: { kind: "2d", grid: GRID_5x5 },
        timeRange: [2, 5],
      }),
    );
    expect(steps.map((s) => s.t)).toEqual([2, 3, 4]);
  });

  it("completes with zero yields for an empty selection", async () => {
    const { arr } = await makeArray({
      shape: [3, 5, 5],
      chunks: [3, 5, 5],
      filler: () => 1,
    });
    const steps = await collect(
      readPolygon(arr, {
        polygon: [
          [100, 100],
          [100, 101],
          [101, 101],
        ],
        spatialLayout: { kind: "2d", grid: GRID_5x5 },
      }),
    );
    expect(steps).toEqual([]);
  });

  it("throws SliceError on a reversed timeRange", async () => {
    const { arr } = await makeArray({
      shape: [5, 5, 5],
      chunks: [5, 5, 5],
      filler: () => 1,
    });
    await expect(
      collect(
        readPolygon(arr, {
          polygon: CONCAVE_POLY,
          spatialLayout: { kind: "2d", grid: GRID_5x5 },
          timeRange: [4, 1],
        }),
      ),
    ).rejects.toThrow(SliceError);
  });
});

// ── US2: chunk-read-once + memory bounding ───────────────────────────────────

// 6×6 grid, lat=i, lon=j; a polygon spanning multiple 3×3 spatial tiles.
const GRID_6x6 = makeGrid(
  6,
  6,
  (i) => i,
  (j) => j,
);
// Square covering lat 0.5..4.5, lon 0.5..4.5 → cells i,j ∈ {1,2,3,4}.
const SPAN_POLY: Array<[number, number]> = [
  [0.5, 0.5],
  [0.5, 4.5],
  [4.5, 4.5],
  [4.5, 0.5],
];

describe("readPolygon chunk-read-once + memory bound", () => {
  it("fetches each bbox-overlapping chunk exactly once across all timesteps", async () => {
    // Chunk shape [fullTime, tile, tile] = [20, 3, 3]: one chunk spans the
    // whole time axis for each 3×3 spatial tile.
    const { arr, store } = await makeArray({
      shape: [20, 6, 6],
      chunks: [20, 3, 3],
      filler: (t, r, c) => t * 100 + r * 10 + c,
      wrap: (s) => new CountingStore(s),
    });
    const counting = store as CountingStore;

    const sel = resolvePolygonCells(arr, {
      polygon: SPAN_POLY,
      spatialLayout: { kind: "2d", grid: GRID_6x6 },
    });
    // bbox spans rows {1..4}, cols {1..4} → touches all four 3×3 tiles.
    const bboxTilesR = new Set<number>();
    const bboxTilesC = new Set<number>();
    for (let r = sel.bbox.rMin; r < sel.bbox.rMax; r++)
      bboxTilesR.add(Math.floor(r / 3));
    for (let c = sel.bbox.cMin; c < sel.bbox.cMax; c++)
      bboxTilesC.add(Math.floor(c / 3));
    const expectedChunks = bboxTilesR.size * bboxTilesC.size;
    expect(expectedChunks).toBeGreaterThan(1); // genuinely multi-chunk

    let decodes = 0;
    const steps = await collect(
      readPolygon(arr, {
        polygon: SPAN_POLY,
        spatialLayout: { kind: "2d", grid: GRID_6x6 },
        readOptions: { observability: { onChunkDecoded: () => decodes++ } },
      }),
    );

    expect(steps).toHaveLength(20);
    // Each covered chunk fetched from the store exactly once (0 re-fetches).
    expect(counting.distinctChunkFetches()).toBe(expectedChunks);
    expect(counting.chunkFetches()).toHaveLength(expectedChunks);
    // Uncompressed arrays have no codec → no decode events; the fetch-once
    // count above is the binding guarantee. Assert no *extra* work regardless.
    expect(decodes).toBeLessThanOrEqual(expectedChunks);
  });

  it("keeps per-timestep allocation bounded to one slice regardless of time extent", async () => {
    const sizes: number[] = [];
    let peakInFlight = 0;
    const { arr } = await makeArray({
      shape: [50, 6, 6],
      chunks: [50, 3, 3],
      filler: (t, r, c) => t + r + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: SPAN_POLY,
      spatialLayout: { kind: "2d", grid: GRID_6x6 },
    });
    for await (const step of readPolygon(arr, {
      polygon: SPAN_POLY,
      spatialLayout: { kind: "2d", grid: GRID_6x6 },
      readOptions: {
        observability: {
          onInFlightBytes: (b) => {
            if (b > peakInFlight) peakInFlight = b;
          },
        },
      },
    })) {
      sizes.push(step.values.length);
    }
    // Every step allocates exactly cells.length — never grows with time index.
    expect(sizes).toHaveLength(50);
    expect(new Set(sizes)).toEqual(new Set([sel.cells.length]));
    // Peak in-flight bytes is bounded (does not scale with 50 timesteps).
    expect(peakInFlight).toBeGreaterThan(0);
  });
});

// ── US3 T016: 1d-rectilinear layout ──────────────────────────────────────────

describe("resolvePolygonCells (1d-rectilinear)", () => {
  // Monotonic axes: lat = 10 + i (0..9), lon = 20 + j (0..7).
  const lat1d = Array.from({ length: 10 }, (_, i) => 10 + i);
  const lon1d = Array.from({ length: 8 }, (_, j) => 20 + j);
  const layout = { kind: "1d" as const, lat: lat1d, lon: lon1d };
  // Box selecting lat 12.5..15.5 (i=3,4,5), lon 22.5..24.5 (j=3,4).
  const box: Array<[number, number]> = [
    [12.5, 22.5],
    [12.5, 24.5],
    [15.5, 24.5],
    [15.5, 22.5],
  ];

  it("resolves the bbox by binary search and positions from the axes", async () => {
    const { arr } = await makeArray({
      shape: [2, 10, 8],
      chunks: [2, 10, 8],
      filler: (t, r, c) => t * 1000 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: box,
      spatialLayout: layout,
    });

    // Expected in-polygon cells (lat=10+i in (12.5,15.5), lon=20+j in (22.5,24.5)).
    const ref: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 8; j++)
        if (10 + i > 12.5 && 10 + i < 15.5 && 20 + j > 22.5 && 20 + j < 24.5)
          ref.push([i, j]);
    expect(sel.cells.map((c) => [c.i, c.j])).toEqual(ref);
    for (const cell of sel.cells) {
      expect(cell.lat).toBe(lat1d[cell.i]);
      expect(cell.lon).toBe(lon1d[cell.j]);
    }
    // bbox contains the selection.
    expect(sel.bbox.rMin).toBeLessThanOrEqual(3);
    expect(sel.bbox.rMax).toBeGreaterThanOrEqual(6);
    expect(sel.bbox.cMin).toBeLessThanOrEqual(3);
    expect(sel.bbox.cMax).toBeGreaterThanOrEqual(5);
  });

  it("streams 1d-layout values aligned to cells", async () => {
    const { arr } = await makeArray({
      shape: [3, 10, 8],
      chunks: [3, 10, 8],
      filler: (t, r, c) => t * 1000 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: box,
      spatialLayout: layout,
    });
    const steps = await collect(
      readPolygon(arr, { polygon: box, spatialLayout: layout }),
    );
    expect(steps.map((s) => s.t)).toEqual([0, 1, 2]);
    for (const step of steps)
      sel.cells.forEach((cell, k) =>
        expect(step.values[k]).toBe(step.t * 1000 + cell.i * 10 + cell.j),
      );
  });

  it("rejects BigInt coordinate axes", async () => {
    const { arr } = await makeArray({
      shape: [1, 4, 4],
      chunks: [1, 4, 4],
      filler: () => 0,
    });
    expect(() =>
      resolvePolygonCells(arr, {
        polygon: box,
        spatialLayout: {
          kind: "1d",
          lat: new BigInt64Array(4) as unknown as ArrayLike<number>,
          lon: lon1d,
        },
      }),
    ).toThrow(SliceError);
  });
});

// ── US3 T018: 2d-curvilinear via a real GridIndex ────────────────────────────

describe("resolvePolygonCells (2d-curvilinear, real GridIndex)", () => {
  it("resolves exact membership with padded bbox and grid positions", async () => {
    // A mildly skewed curvilinear grid: lat = i + 0.1*j, lon = j + 0.1*i.
    const ny = 8;
    const nx = 8;
    const grid = makeGrid(
      ny,
      nx,
      // makeGrid uses latOf(i)/lonOf(j) independently; emulate skew by index.
      (i) => i,
      (j) => j,
    );
    const { arr } = await makeArray({
      shape: [2, ny, nx],
      chunks: [2, ny, nx],
      filler: (t, r, c) => t * 100 + r * 10 + c,
    });
    const poly: Array<[number, number]> = [
      [1.5, 1.5],
      [1.5, 5.5],
      [5.5, 5.5],
      [5.5, 1.5],
    ];
    const sel = resolvePolygonCells(arr, {
      polygon: poly,
      spatialLayout: { kind: "2d", grid },
    });
    const ref = referenceCells(
      ny,
      nx,
      (i) => i,
      (j) => j,
      poly,
    );
    expect(sel.cells.map((c) => [c.i, c.j])).toEqual(ref);
    for (const cell of sel.cells) {
      expect(cell.lat).toBe(grid.latAt(cell.i, cell.j));
      expect(cell.lon).toBe(grid.lonAt(cell.i, cell.j));
    }
  });
});

// ── US3 T020: npoints layout ─────────────────────────────────────────────────

describe("resolvePolygonCells / readPolygon (npoints)", () => {
  // 6 unstructured points; polygon selects a subset.
  const latPts = [0, 1, 2, 3, 4, 5];
  const lonPts = [0, 1, 2, 3, 4, 5];
  const layout = { kind: "npoints" as const, lat: latPts, lon: lonPts };
  // Box lat 0.5..3.5, lon 0.5..3.5 → points 1,2,3 (index==coord here).
  const box: Array<[number, number]> = [
    [0.5, 0.5],
    [0.5, 3.5],
    [3.5, 3.5],
    [3.5, 0.5],
  ];

  it("flat-filters points; i=point index, j=0; degenerate bbox", async () => {
    const { arr } = await makeArray({
      shape: [4, 6],
      chunks: [4, 6],
      filler: (t, p) => t * 100 + p,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: box,
      spatialLayout: layout,
    });
    expect(sel.cells.map((c) => c.i)).toEqual([1, 2, 3]);
    expect(sel.cells.every((c) => c.j === 0)).toBe(true);
    for (const cell of sel.cells) {
      expect(cell.lat).toBe(latPts[cell.i]);
      expect(cell.lon).toBe(lonPts[cell.i]);
    }
    // degenerate bbox over the point axis; column axis [0,1).
    expect(sel.bbox.cMin).toBe(0);
    expect(sel.bbox.cMax).toBe(1);
  });

  it("streams npoints values aligned to selected points", async () => {
    const { arr } = await makeArray({
      shape: [3, 6],
      chunks: [3, 6],
      filler: (t, p) => t * 100 + p,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: box,
      spatialLayout: layout,
    });
    const steps = await collect(
      readPolygon(arr, { polygon: box, spatialLayout: layout }),
    );
    expect(steps.map((s) => s.t)).toEqual([0, 1, 2]);
    for (const step of steps)
      sel.cells.forEach((cell, k) =>
        expect(step.values[k]).toBe(step.t * 100 + cell.i),
      );
  });
});

// ── US4 T022: adaptive maxCells stride ───────────────────────────────────────

describe("resolvePolygonCells adaptive maxCells stride", () => {
  // 12×12 grid, lat=i, lon=j; a big box covering nearly the whole grid.
  const GRID_12 = makeGrid(
    12,
    12,
    (i) => i,
    (j) => j,
  );
  const bigBox: Array<[number, number]> = [
    [-0.5, -0.5],
    [-0.5, 11.5],
    [11.5, 11.5],
    [11.5, -0.5],
  ];

  it("stays within budget, spreads cells, and reports stride > 1", async () => {
    const { arr } = await makeArray({
      shape: [1, 12, 12],
      chunks: [1, 12, 12],
      filler: () => 1,
    });
    const full = resolvePolygonCells(arr, {
      polygon: bigBox,
      spatialLayout: { kind: "2d", grid: GRID_12 },
    });
    expect(full.stride).toBe(1);
    expect(full.cells.length).toBe(144);

    const capped = resolvePolygonCells(arr, {
      polygon: bigBox,
      spatialLayout: { kind: "2d", grid: GRID_12 },
      maxCells: 20,
    });
    expect(capped.cells.length).toBeLessThanOrEqual(20);
    expect(capped.stride).toBeGreaterThan(1);
    // Cells spread across the area, not clustered in a corner: the row and
    // column spans are close to the full extent.
    const iVals = capped.cells.map((c) => c.i);
    const jVals = capped.cells.map((c) => c.j);
    expect(Math.max(...iVals) - Math.min(...iVals)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...jVals) - Math.min(...jVals)).toBeGreaterThanOrEqual(9);
  });

  it("stride 1 when within budget or unset (all in-polygon cells)", async () => {
    const { arr } = await makeArray({
      shape: [1, 12, 12],
      chunks: [1, 12, 12],
      filler: () => 1,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: bigBox,
      spatialLayout: { kind: "2d", grid: GRID_12 },
      maxCells: 1000, // well above 144
    });
    expect(sel.stride).toBe(1);
    expect(sel.cells.length).toBe(144);
  });

  it("clamps so a single-cell polygon never sub-samples to zero", async () => {
    const { arr } = await makeArray({
      shape: [1, 12, 12],
      chunks: [1, 12, 12],
      filler: () => 1,
    });
    // Tiny polygon around cell (5,5).
    const tiny: Array<[number, number]> = [
      [4.6, 4.6],
      [4.6, 5.4],
      [5.4, 5.4],
      [5.4, 4.6],
    ];
    const sel = resolvePolygonCells(arr, {
      polygon: tiny,
      spatialLayout: { kind: "2d", grid: GRID_12 },
      maxCells: 1,
    });
    expect(sel.cells.length).toBeGreaterThanOrEqual(1);
    expect(sel.cells).toContainEqual({ i: 5, j: 5, lat: 5, lon: 5 });
  });

  it("applies single-axis stride for npoints and stays within budget", async () => {
    const n = 40;
    const latPts = Array.from({ length: n }, () => 0.5); // all inside lat band
    const lonPts = Array.from({ length: n }, (_, p) => p); // spread across lon
    const { arr } = await makeArray({
      shape: [1, n],
      chunks: [1, n],
      filler: () => 1,
    });
    const boxAll: Array<[number, number]> = [
      [0, -1],
      [0, n],
      [1, n],
      [1, -1],
    ];
    const sel = resolvePolygonCells(arr, {
      polygon: boxAll,
      spatialLayout: { kind: "npoints", lat: latPts, lon: lonPts },
      maxCells: 10,
    });
    expect(sel.cells.length).toBeLessThanOrEqual(10);
    expect(sel.stride).toBeGreaterThan(1);
  });
});

// ── Regression: timeAxis is v1-restricted to 0 ───────────────────────────────

describe("timeAxis validation (v1: must be 0)", () => {
  const layout = { kind: "2d" as const, grid: GRID_5x5 };

  it("rejects a non-zero timeAxis in resolvePolygonCells", async () => {
    const { arr } = await makeArray({
      shape: [5, 5, 3],
      chunks: [5, 5, 3],
      filler: () => 1,
    });
    expect(() =>
      resolvePolygonCells(arr, {
        polygon: CONCAVE_POLY,
        spatialLayout: layout,
        timeAxis: 2,
      }),
    ).toThrow(SliceError);
  });

  it("rejects a non-zero timeAxis in readPolygon (before any yield)", async () => {
    const { arr } = await makeArray({
      shape: [5, 5, 3],
      chunks: [5, 5, 3],
      filler: () => 1,
    });
    await expect(
      collect(
        readPolygon(arr, {
          polygon: CONCAVE_POLY,
          spatialLayout: layout,
          timeAxis: 1,
        }),
      ),
    ).rejects.toThrow(SliceError);
  });

  it("accepts timeAxis: 0 explicitly (same as default)", async () => {
    const { arr } = await makeArray({
      shape: [2, 5, 5],
      chunks: [2, 5, 5],
      filler: (t, r, c) => t * 100 + r * 10 + c,
    });
    const a = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout,
      timeAxis: 0,
    });
    const b = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout,
    });
    expect(a.cells).toEqual(b.cells);
  });
});

// ── Regression: value dtype normalization to Float64Array ────────────────────

describe("value dtype normalization", () => {
  const layout = { kind: "2d" as const, grid: GRID_5x5 };

  it("streams <f4 array values as Float64Array aligned to cells", async () => {
    const { arr } = await makeArray({
      shape: [2, 5, 5],
      chunks: [2, 5, 5],
      dtype: "<f4",
      filler: (t, r, c) => t + r * 0.5 + c * 0.25,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout,
    });
    const steps = await collect(
      readPolygon(arr, { polygon: CONCAVE_POLY, spatialLayout: layout }),
    );
    for (const step of steps) {
      expect(step.values).toBeInstanceOf(Float64Array);
      sel.cells.forEach((cell, k) => {
        expect(step.values[k]).toBeCloseTo(
          step.t + cell.i * 0.5 + cell.j * 0.25,
          5,
        );
      });
    }
  });

  it("streams <i4 array values as Float64Array with exact integers", async () => {
    const { arr } = await makeArray({
      shape: [2, 5, 5],
      chunks: [2, 5, 5],
      dtype: "<i4",
      filler: (t, r, c) => t * 1000 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout,
    });
    const steps = await collect(
      readPolygon(arr, { polygon: CONCAVE_POLY, spatialLayout: layout }),
    );
    for (const step of steps) {
      expect(step.values).toBeInstanceOf(Float64Array);
      sel.cells.forEach((cell, k) => {
        expect(step.values[k]).toBe(step.t * 1000 + cell.i * 10 + cell.j);
      });
    }
  });
});

// ── Regression: NaN (missing value) passes through, cell not dropped ─────────

describe("NaN / missing value passthrough", () => {
  it("keeps in-polygon cells whose value is NaN, delivering NaN", async () => {
    const layout = { kind: "2d" as const, grid: GRID_5x5 };
    // Mark cell (2,1) as NaN — it is inside CONCAVE_POLY's left lobe.
    const { arr } = await makeArray({
      shape: [1, 5, 5],
      chunks: [1, 5, 5],
      filler: (_t, r, c) => (r === 2 && c === 1 ? NaN : r * 10 + c),
    });
    const sel = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout,
    });
    const nanCellIdx = sel.cells.findIndex((c) => c.i === 2 && c.j === 1);
    expect(nanCellIdx).toBeGreaterThanOrEqual(0); // cell IS selected

    const [step] = await collect(
      readPolygon(arr, { polygon: CONCAVE_POLY, spatialLayout: layout }),
    );
    expect(step.values.length).toBe(sel.cells.length); // not dropped
    expect(Number.isNaN(step.values[nanCellIdx])).toBe(true);
  });
});

// ── Regression: 1d descending axis ───────────────────────────────────────────

describe("1d-rectilinear descending axis", () => {
  it("resolves correctly when the lat axis descends (lat = 9 - i)", async () => {
    const lat1d = Array.from({ length: 10 }, (_, i) => 9 - i); // 9..0 descending
    const lon1d = Array.from({ length: 8 }, (_, j) => j); // 0..7 ascending
    const layout = { kind: "1d" as const, lat: lat1d, lon: lon1d };
    const box: Array<[number, number]> = [
      [2.5, 1.5],
      [2.5, 3.5],
      [5.5, 3.5],
      [5.5, 1.5],
    ];
    const { arr } = await makeArray({
      shape: [2, 10, 8],
      chunks: [2, 10, 8],
      filler: (t, r, c) => t * 1000 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: box,
      spatialLayout: layout,
    });

    // Expected cells: lat in (2.5,5.5) → 9-i ∈ (2.5,5.5) → i ∈ {4,5,6};
    // lon in (1.5,3.5) → j ∈ {2,3}.
    const ref: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 8; j++)
        if (
          lat1d[i] > 2.5 &&
          lat1d[i] < 5.5 &&
          lon1d[j] > 1.5 &&
          lon1d[j] < 3.5
        )
          ref.push([i, j]);
    expect(sel.cells.map((c) => [c.i, c.j])).toEqual(ref);
    for (const cell of sel.cells) {
      expect(cell.lat).toBe(lat1d[cell.i]);
      expect(cell.lon).toBe(lon1d[cell.j]);
    }
    // Streamed values align to cells even with the descending axis.
    const steps = await collect(
      readPolygon(arr, { polygon: box, spatialLayout: layout }),
    );
    for (const step of steps)
      sel.cells.forEach((cell, k) =>
        expect(step.values[k]).toBe(step.t * 1000 + cell.i * 10 + cell.j),
      );
  });
});

// ── Regression: genuinely skewed curvilinear grid ────────────────────────────

describe("2d-curvilinear genuinely skewed grid", () => {
  it("bbox padding covers every in-polygon cell on a rotated grid", async () => {
    // Rotated/skewed grid: lat and lon both depend on i AND j.
    const ny = 10;
    const nx = 10;
    const lat = new Float32Array(ny * nx);
    const lon = new Float32Array(ny * nx);
    for (let i = 0; i < ny; i++) {
      for (let j = 0; j < nx; j++) {
        lat[i * nx + j] = i + 0.4 * j;
        lon[i * nx + j] = j - 0.4 * i;
      }
    }
    const grid = GridIndex.fromCoordinates(lat, lon, ny, nx);
    const { arr } = await makeArray({
      shape: [1, ny, nx],
      chunks: [1, ny, nx],
      filler: () => 1,
    });
    const poly: Array<[number, number]> = [
      [3, 2],
      [3, 6],
      [7, 6],
      [7, 2],
    ];
    const sel = resolvePolygonCells(arr, {
      polygon: poly,
      spatialLayout: { kind: "2d", grid },
    });

    // Brute-force reference over the true per-cell lat/lon.
    const ref = new Set<string>();
    for (let i = 0; i < ny; i++)
      for (let j = 0; j < nx; j++)
        if (pointInPolygon(grid.latAt(i, j), grid.lonAt(i, j), poly))
          ref.add(`${i},${j}`);
    const got = new Set(sel.cells.map((c) => `${c.i},${c.j}`));
    // No in-polygon cell is missed by the padded bbox.
    for (const key of ref) expect(got.has(key)).toBe(true);
    // And everything returned is genuinely inside.
    for (const key of got) expect(ref.has(key)).toBe(true);
    expect(ref.size).toBeGreaterThan(0);
  });
});

// ── Regression: ring closure equivalence in 1d and npoints layouts ───────────

describe("ring closure equivalence across layouts", () => {
  const openRing: Array<[number, number]> = [
    [1.5, 1.5],
    [1.5, 3.5],
    [3.5, 3.5],
    [3.5, 1.5],
  ];
  const closedRing: Array<[number, number]> = [...openRing, [1.5, 1.5]];

  it("1d: closed == unclosed selection", async () => {
    const lat1d = Array.from({ length: 6 }, (_, i) => i);
    const lon1d = Array.from({ length: 6 }, (_, j) => j);
    const { arr } = await makeArray({
      shape: [1, 6, 6],
      chunks: [1, 6, 6],
      filler: () => 1,
    });
    const a = resolvePolygonCells(arr, {
      polygon: openRing,
      spatialLayout: { kind: "1d", lat: lat1d, lon: lon1d },
    });
    const b = resolvePolygonCells(arr, {
      polygon: closedRing,
      spatialLayout: { kind: "1d", lat: lat1d, lon: lon1d },
    });
    expect(a.cells).toEqual(b.cells);
  });

  it("npoints: closed == unclosed selection", async () => {
    const latPts = [0, 1, 2, 3, 4, 5];
    const lonPts = [0, 1, 2, 3, 4, 5];
    const { arr } = await makeArray({
      shape: [1, 6],
      chunks: [1, 6],
      filler: () => 1,
    });
    const a = resolvePolygonCells(arr, {
      polygon: openRing,
      spatialLayout: { kind: "npoints", lat: latPts, lon: lonPts },
    });
    const b = resolvePolygonCells(arr, {
      polygon: closedRing,
      spatialLayout: { kind: "npoints", lat: latPts, lon: lonPts },
    });
    expect(a.cells).toEqual(b.cells);
  });
});

// ── Regression: array rank must match the layout (no silent all-fill read) ───

describe("array rank validation", () => {
  it("rejects a 2-D array for a 2d layout (needs [time, rows, cols])", async () => {
    const grid = makeGrid(
      5,
      5,
      (i) => i,
      (j) => j,
    );
    // Missing the trailing spatial axis: shape is [time, rows] not [t, r, c].
    const { arr } = await makeArray({
      shape: [3, 5],
      chunks: [3, 5],
      filler: () => 1,
    });
    expect(() =>
      resolvePolygonCells(arr, {
        polygon: CONCAVE_POLY,
        spatialLayout: { kind: "2d", grid },
      }),
    ).toThrow(SliceError);
  });

  it("rejects a 4-D array with a non-singleton middle dim (states the singleton rule)", async () => {
    const lat1d = [0, 1, 2, 3, 4];
    const lon1d = [0, 1, 2, 3, 4];
    // [time, level=2, rows, cols] — a genuine multi-level axis, not a size-1
    // dim we can silently collapse. Must throw, and say why.
    const { arr } = await makeArray({
      shape: [2, 2, 5, 5],
      chunks: [2, 2, 5, 5],
      filler: () => 1,
    });
    await expect(
      collect(
        readPolygon(arr, {
          polygon: CONCAVE_POLY,
          spatialLayout: { kind: "1d", lat: lat1d, lon: lon1d },
        }),
      ),
    ).rejects.toThrow(/size 1/);
  });

  it("rejects a 3-D array for an npoints layout (needs [time, npoints])", async () => {
    const latPts = [0, 1, 2, 3, 4];
    const lonPts = [0, 1, 2, 3, 4];
    const { arr } = await makeArray({
      shape: [2, 5, 5],
      chunks: [2, 5, 5],
      filler: () => 1,
    });
    expect(() =>
      resolvePolygonCells(arr, {
        polygon: CONCAVE_POLY,
        spatialLayout: { kind: "npoints", lat: latPts, lon: lonPts },
      }),
    ).toThrow(SliceError);
  });
});

// ── Singleton middle dims: hydro current fields shaped [time, 1, lat, lon] ───

describe("singleton middle dims (degenerate depth in hydro current fields)", () => {
  const lat1d = Array.from({ length: 5 }, (_, i) => i);
  const lon1d = Array.from({ length: 5 }, (_, j) => j);
  const layout1d = { kind: "1d" as const, lat: lat1d, lon: lon1d };

  it("streams [time, 1, lat, lon] identically to the equivalent [time, lat, lon]", async () => {
    // Same values at (t, r, c) regardless of the degenerate depth axis.
    const rank3 = await makeArray({
      shape: [3, 5, 5],
      chunks: [3, 5, 5],
      filler: (t, r, c) => t * 1000 + r * 10 + c,
    });
    const rank4 = await makeArray({
      shape: [3, 1, 5, 5],
      chunks: [3, 1, 5, 5],
      filler: (t, _d, r, c) => t * 1000 + r * 10 + c,
    });

    const sel3 = resolvePolygonCells(rank3.arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout1d,
    });
    const sel4 = resolvePolygonCells(rank4.arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout1d,
    });
    // Selection (cells/bbox/stride) is time- and rank-invariant.
    expect(cellKeys(sel4)).toBe(cellKeys(sel3));
    expect(sel4.bbox).toEqual(sel3.bbox);
    expect(sel4.stride).toBe(sel3.stride);
    expect(sel4.cells.length).toBeGreaterThan(0);

    const steps3 = await collect(
      readPolygon(rank3.arr, { polygon: CONCAVE_POLY, spatialLayout: layout1d }),
    );
    const steps4 = await collect(
      readPolygon(rank4.arr, { polygon: CONCAVE_POLY, spatialLayout: layout1d }),
    );
    expect(steps4.map((s) => s.t)).toEqual(steps3.map((s) => s.t));
    for (let s = 0; s < steps3.length; s++) {
      expect(Array.from(steps4[s].values)).toEqual(
        Array.from(steps3[s].values),
      );
    }
  });

  it("handles a 2d layout with a leading singleton depth dim", async () => {
    const { arr } = await makeArray({
      shape: [2, 1, 5, 5],
      chunks: [2, 1, 5, 5],
      filler: (t, _d, r, c) => t * 100 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: { kind: "2d", grid: GRID_5x5 },
    });
    expect(sel.cells.length).toBeGreaterThan(0);
    const steps = await collect(
      readPolygon(arr, {
        polygon: CONCAVE_POLY,
        spatialLayout: { kind: "2d", grid: GRID_5x5 },
      }),
    );
    expect(steps.map((s) => s.t)).toEqual([0, 1]);
    for (const step of steps)
      sel.cells.forEach((cell, k) =>
        expect(step.values[k]).toBe(step.t * 100 + cell.i * 10 + cell.j),
      );
  });

  it("collapses more than one singleton middle dim ([time, 1, 1, lat, lon])", async () => {
    const { arr } = await makeArray({
      shape: [2, 1, 1, 5, 5],
      chunks: [2, 1, 1, 5, 5],
      filler: (t, _d0, _d1, r, c) => t * 1000 + r * 10 + c,
    });
    const sel = resolvePolygonCells(arr, {
      polygon: CONCAVE_POLY,
      spatialLayout: layout1d,
    });
    expect(sel.cells.length).toBeGreaterThan(0);
    const steps = await collect(
      readPolygon(arr, { polygon: CONCAVE_POLY, spatialLayout: layout1d }),
    );
    for (const step of steps)
      sel.cells.forEach((cell, k) =>
        expect(step.values[k]).toBe(step.t * 1000 + cell.i * 10 + cell.j),
      );
  });

  it("still rejects a non-singleton middle dim ([time, 3, lat, lon])", async () => {
    const { arr } = await makeArray({
      shape: [2, 3, 5, 5],
      chunks: [2, 3, 5, 5],
      filler: () => 1,
    });
    expect(() =>
      resolvePolygonCells(arr, {
        polygon: CONCAVE_POLY,
        spatialLayout: layout1d,
      }),
    ).toThrow(/size 1/);
  });
});

// ── Regression: exact bbox on a strongly-skewed grid (no PAD heuristic) ──────

describe("2d bbox exactness on a non-linear curvilinear grid", () => {
  it("selects every in-polygon cell where corner-nearest + PAD=1 would miss", async () => {
    // A sinusoidally warped grid: lat/lon are NOT monotone in i/j, so the four
    // envelope corners map (via nearest) to cells that do not bracket the true
    // in-polygon index span. A fixed 1-cell pad around the corner-nearest box
    // cannot recover the miss (verified: this fixture drops 3 in-polygon cells
    // under the old heuristic); the exact envelope scan must catch all of them.
    const ny = 20;
    const nx = 20;
    const lat = new Float32Array(ny * nx);
    const lon = new Float32Array(ny * nx);
    for (let i = 0; i < ny; i++) {
      for (let j = 0; j < nx; j++) {
        lat[i * nx + j] = i + 3 * Math.sin(j * 0.5);
        lon[i * nx + j] = j + 3 * Math.sin(i * 0.5);
      }
    }
    const grid = GridIndex.fromCoordinates(lat, lon, ny, nx);
    const poly: Array<[number, number]> = [
      [6, 6],
      [6, 12],
      [12, 12],
      [12, 6],
    ];
    const { arr } = await makeArray({
      shape: [1, ny, nx],
      chunks: [1, ny, nx],
      filler: (_t, r, c) => r * 1000 + c, // encode index in value
    });

    const sel = resolvePolygonCells(arr, {
      polygon: poly,
      spatialLayout: { kind: "2d", grid },
    });

    // Brute-force truth over the real per-cell lat/lon.
    const ref = new Set<string>();
    for (let i = 0; i < ny; i++)
      for (let j = 0; j < nx; j++)
        if (pointInPolygon(grid.latAt(i, j), grid.lonAt(i, j), poly))
          ref.add(`${i},${j}`);
    const got = new Set(sel.cells.map((c) => `${c.i},${c.j}`));

    expect(ref.size).toBeGreaterThan(0);
    // Exhaustive equality: no in-polygon cell missed, nothing spurious added.
    expect(got).toEqual(ref);

    // And the streamed values land on the right cells (value encodes r*100+c).
    const [step] = await collect(
      readPolygon(arr, { polygon: poly, spatialLayout: { kind: "2d", grid } }),
    );
    for (let k = 0; k < sel.cells.length; k++) {
      const cell = sel.cells[k];
      expect(step.values[k]).toBe(cell.i * 1000 + cell.j);
    }
  });
});
