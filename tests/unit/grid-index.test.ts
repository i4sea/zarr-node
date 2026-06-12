import { describe, it, expect } from "vitest";
import { GridIndex } from "../../src/spatial/grid-index.js";
import type { ZarrGroup } from "../../src/group.js";
import type { ZarrArray } from "../../src/array.js";
import type { Cache } from "../../src/cache/cache.js";

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeArrayOpts {
  shape: number[];
  data: Float32Array | BigInt64Array;
  chunks?: number[];
  dtype?: string;
  onFullGet?: () => void;
}

function fakeArray(opts: FakeArrayOpts): ZarrArray {
  const arr = {
    shape: opts.shape,
    chunks: opts.chunks ?? opts.shape,
    dtype: opts.dtype ?? "<f4",
    async get(selection?: unknown): Promise<Float32Array | BigInt64Array> {
      if (selection === undefined) {
        opts.onFullGet?.();
        return opts.data;
      }
      // Corner read [[0,1],[0,1]] used by verifyGrid — return first element.
      return opts.data.slice(0, 1) as Float32Array | BigInt64Array;
    },
  };
  return arr as unknown as ZarrArray;
}

function fakeGroup(
  attrs: Record<string, unknown>,
  arrays: Record<string, ZarrArray>,
): ZarrGroup {
  const group = {
    attrs,
    async getArray(name: string): Promise<ZarrArray> {
      const a = arrays[name];
      if (!a) throw new Error(`no array ${name}`);
      return a;
    },
  };
  return group as unknown as ZarrGroup;
}

function fakeCache(): Cache & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

// Rectilinear-as-2D grid: lat = 10 + i, lon = 20 + j over ny×nx.
function makeGrid(
  ny: number,
  nx: number,
): { lat: Float32Array; lon: Float32Array } {
  const lat = new Float32Array(ny * nx);
  const lon = new Float32Array(ny * nx);
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      lat[i * nx + j] = 10 + i;
      lon[i * nx + j] = 20 + j;
    }
  }
  return { lat, lon };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("GridIndex.nearest", () => {
  const { lat, lon } = makeGrid(3, 4);
  const idx = GridIndex.fromCoordinates(lat, lon, 3, 4);

  it("recovers the exact cell", () => {
    expect(idx.nearest(10, 20)).toMatchObject({ i: 0, j: 0 });
    expect(idx.nearest(12, 23)).toMatchObject({ i: 2, j: 3 });
  });

  it("rounds to the nearest cell", () => {
    expect(idx.nearest(11.4, 22.6)).toMatchObject({ i: 1, j: 3 });
    expect(idx.nearest(10.4, 20.4)).toMatchObject({ i: 0, j: 0 });
  });

  it("reports a non-negative distance in km", () => {
    expect(idx.nearest(10, 20).distanceKm).toBeCloseTo(0, 5);
    expect(idx.nearest(11.5, 21.5).distanceKm).toBeGreaterThan(0);
  });

  it("resolves many points", () => {
    const r = idx.nearestMany([
      [10, 20],
      [12, 23],
    ]);
    expect(r.map((x) => [x.i, x.j])).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });
});

describe("GridIndex.toBytes / fromBytes", () => {
  it("round-trips and preserves queries", () => {
    const { lat, lon } = makeGrid(5, 7);
    const idx = GridIndex.fromCoordinates(lat, lon, 5, 7);
    const bytes = idx.toBytes();
    const back = GridIndex.fromBytes(bytes);
    expect(back.ny).toBe(5);
    expect(back.nx).toBe(7);
    expect(back.nearest(13, 24)).toEqual(idx.nearest(13, 24));
  });

  it("rejects a corrupt snapshot", () => {
    expect(() => GridIndex.fromBytes(new Uint8Array(4))).toThrow(
      /too small|magic/i,
    );
    const bad = new Uint8Array(12 + 8);
    new DataView(bad.buffer).setUint32(0, 0xdeadbeef, true);
    expect(() => GridIndex.fromBytes(bad)).toThrow(/magic/i);
  });
});

describe("GridIndex.fromCoordinates validation", () => {
  it("throws on length mismatch", () => {
    expect(() =>
      GridIndex.fromCoordinates(new Float32Array(3), new Float32Array(3), 2, 2),
    ).toThrow(/length must equal/);
  });
});

describe("GridIndex.fromGroup", () => {
  it("loads lat/lon and builds the index", async () => {
    const { lat, lon } = makeGrid(3, 4);
    const group = fakeGroup(
      {},
      {
        lat: fakeArray({ shape: [3, 4], data: lat }),
        lon: fakeArray({ shape: [3, 4], data: lon }),
      },
    );
    const idx = await GridIndex.fromGroup(group);
    expect(idx.nearest(11, 22)).toMatchObject({ i: 1, j: 2 });
  });

  it("rejects a non-2D coordinate array", async () => {
    const group = fakeGroup(
      {},
      {
        lat: fakeArray({ shape: [10], data: new Float32Array(10) }),
        lon: fakeArray({ shape: [10], data: new Float32Array(10) }),
      },
    );
    await expect(GridIndex.fromGroup(group)).rejects.toThrow(/2D/);
  });

  it("rejects 64-bit integer coordinates", async () => {
    const group = fakeGroup(
      {},
      {
        lat: fakeArray({
          shape: [2, 2],
          data: new BigInt64Array(4),
          dtype: "<i8",
        }),
        lon: fakeArray({
          shape: [2, 2],
          data: new BigInt64Array(4),
          dtype: "<i8",
        }),
      },
    );
    await expect(GridIndex.fromGroup(group)).rejects.toThrow(/64-bit integer/);
  });
});

describe("GridIndex.loadCached (L1 + L2)", () => {
  const domainAttrs = {
    source_model: "WRF",
    experiment: "sse002",
    grid_id: "1",
  };

  function buildGroup(
    attrs: Record<string, unknown>,
    gridSize = [3, 4] as const,
  ) {
    const { lat, lon } = makeGrid(gridSize[0], gridSize[1]);
    let fullGets = 0;
    const group = fakeGroup(attrs, {
      lat: fakeArray({
        shape: [...gridSize],
        data: lat,
        onFullGet: () => fullGets++,
      }),
      lon: fakeArray({
        shape: [...gridSize],
        data: lon,
        onFullGet: () => fullGets++,
      }),
    });
    return { group, gets: () => fullGets };
  }

  it("misses, builds, and populates the cache; second call is an L2 hit (no refetch)", async () => {
    const cache = fakeCache();
    const { group, gets } = buildGroup(domainAttrs);

    const idx1 = await GridIndex.loadCached(group, { cache });
    expect(gets()).toBe(2); // lat + lon fetched once
    expect(cache.store.size).toBe(1);

    const idx2 = await GridIndex.loadCached(group, { cache });
    expect(gets()).toBe(2); // unchanged → served from L2, no chunk fetch
    expect(idx2.nearest(11, 22)).toEqual(idx1.nearest(11, 22));
  });

  it("keys by domain: same domain shares one entry, different grid_id does not", async () => {
    const cache = fakeCache();
    await GridIndex.loadCached(buildGroup(domainAttrs).group, { cache });
    await GridIndex.loadCached(buildGroup(domainAttrs).group, { cache });
    expect(cache.store.size).toBe(1); // same domain → one key

    await GridIndex.loadCached(
      buildGroup({ ...domainAttrs, grid_id: "2" }).group,
      { cache },
    );
    expect(cache.store.size).toBe(2); // different domain → new key
  });

  it("honors an explicit gridKey override", async () => {
    const cache = fakeCache();
    await GridIndex.loadCached(buildGroup(domainAttrs).group, {
      cache,
      gridKey: "custom-grid",
    });
    expect([...cache.store.keys()]).toEqual(["gridindex:custom-grid"]);
  });

  it("falls back to a hash (not an empty key) for non-sanitizable gridKeys", async () => {
    const cache = fakeCache();
    // Both sanitize to "" → must hash distinctly, never collapse to "gridindex:".
    await GridIndex.loadCached(buildGroup(domainAttrs).group, {
      cache,
      gridKey: "日本語",
    });
    await GridIndex.loadCached(buildGroup(domainAttrs).group, {
      cache,
      gridKey: "中文網格",
    });
    const keys = [...cache.store.keys()];
    expect(keys).toHaveLength(2); // distinct → no collision
    for (const k of keys) {
      expect(k).not.toBe("gridindex:");
      expect(k.length).toBeGreaterThan("gridindex:".length);
    }
  });

  it("works without a cache (L1 only)", async () => {
    const { group, gets } = buildGroup(domainAttrs);
    const idx = await GridIndex.loadCached(group, {});
    expect(gets()).toBe(2);
    expect(idx.nearest(10, 20)).toMatchObject({ i: 0, j: 0 });
  });
});
