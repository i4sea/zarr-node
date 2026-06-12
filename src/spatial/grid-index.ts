/**
 * GridIndex — nearest-neighbour lookup over a static 2D (curvilinear) lat/lon
 * grid, e.g. a WRF domain.
 *
 * The grid is immutable per dataset domain, so it is loaded/decoded once and
 * queried many times (every query becomes pure CPU). For ephemeral pods it can
 * also be persisted to a shared `Cache` (Redis) so only the first pod ever pays
 * the coordinate fetch — see {@link GridIndex.loadCached}.
 */
import { createHash } from "node:crypto";
import type { ZarrGroup } from "../group.js";
import type { ZarrArray, ReadOptions } from "../array.js";
import type { Cache } from "../cache/cache.js";

/** Mean km per degree of latitude (spherical Earth). */
const KM_PER_DEG = 111.195;
/** Redis/Cache key prefix for persisted grids. */
const KEY_PREFIX = "gridindex:";
/** Magic header for the binary snapshot ("GRID" little-endian). */
const SNAPSHOT_MAGIC = 0x44495247;

export interface NearestResult {
  /** Row index (first dimension). */
  i: number;
  /** Column index (second dimension). */
  j: number;
  /** Approximate great-circle distance to the matched cell, in km. */
  distanceKm: number;
}

export interface LoadCachedOptions {
  /** Coordinate array names. Defaults: "lat" / "lon". */
  latName?: string;
  lonName?: string;
  /** Read options forwarded to the coordinate `get()` calls. */
  readOptions?: ReadOptions;
  /**
   * Shared L2 cache (e.g. `RedisCache`). When provided, the grid is read from
   * / written to it under a domain-scoped key. Omit for L1 (process) only.
   */
  cache?: Cache;
  /** Override the derived grid key (level 2). Scoped under `gridindex:`. */
  gridKey?: string;
  /** TTL for the L2 entry, in ms. Omit ⇒ no expiry. */
  ttlMs?: number;
  /**
   * Fold a corner sample of lat/lon into the key (level 3, +2 cheap GETs).
   * Makes the key self-validating when the dataset attrs can't be trusted.
   */
  verifyGrid?: boolean;
}

export interface FromGroupOptions {
  latName?: string;
  lonName?: string;
  readOptions?: ReadOptions;
}

export class GridIndex {
  readonly ny: number;
  readonly nx: number;
  private readonly lat: Float32Array;
  private readonly lon: Float32Array;

  private constructor(
    lat: Float32Array,
    lon: Float32Array,
    ny: number,
    nx: number,
  ) {
    const expected = ny * nx;
    if (lat.length !== expected || lon.length !== expected) {
      throw new Error(
        `GridIndex: lat/lon length must equal ny*nx (${ny}*${nx}=${expected}); ` +
          `got lat=${lat.length}, lon=${lon.length}`,
      );
    }
    this.lat = lat;
    this.lon = lon;
    this.ny = ny;
    this.nx = nx;
  }

  /** Build from already-decoded coordinate arrays (any numeric TypedArray). */
  static fromCoordinates(
    lat: ArrayLike<number>,
    lon: ArrayLike<number>,
    ny: number,
    nx: number,
  ): GridIndex {
    return new GridIndex(toFloat32(lat), toFloat32(lon), ny, nx);
  }

  /** Load lat/lon from a group once and build the index (no cache). */
  static async fromGroup(
    group: ZarrGroup,
    opts: FromGroupOptions = {},
  ): Promise<GridIndex> {
    const latArr = await group.getArray(opts.latName ?? "lat");
    const lonArr = await group.getArray(opts.lonName ?? "lon");
    assertGridShape(latArr, lonArr);
    const [ny, nx] = latArr.shape as [number, number];
    const [latData, lonData] = await Promise.all([
      latArr.get(undefined, opts.readOptions),
      lonArr.get(undefined, opts.readOptions),
    ]);
    return GridIndex.fromCoordinates(
      numericCoords(latData, opts.latName ?? "lat"),
      numericCoords(lonData, opts.lonName ?? "lon"),
      ny,
      nx,
    );
  }

  /**
   * Load the index using a layered cache: L2 (shared `cache`, if given) → L3
   * (the store). On an L2 hit, the coordinate chunks are never fetched. On a
   * miss, the grid is built from the store and written back to L2.
   *
   * The L2 key is derived per *domain* (so every forecast run of the same grid
   * shares one entry) — see the plan / {@link deriveGridKey}.
   */
  static async loadCached(
    group: ZarrGroup,
    opts: LoadCachedOptions = {},
  ): Promise<GridIndex> {
    const latArr = await group.getArray(opts.latName ?? "lat");
    const lonArr = await group.getArray(opts.lonName ?? "lon");
    assertGridShape(latArr, lonArr);

    const key = opts.gridKey
      ? KEY_PREFIX + sanitize(opts.gridKey)
      : await deriveGridKey(
          group,
          latArr,
          lonArr,
          opts.verifyGrid ?? false,
          opts.readOptions,
        );

    if (opts.cache) {
      try {
        const cached = await opts.cache.get(key);
        if (cached && cached.byteLength > 0) return GridIndex.fromBytes(cached);
      } catch {
        // Cache read failure ⇒ fall through and build from the store.
      }
    }

    const [ny, nx] = latArr.shape as [number, number];
    const [latData, lonData] = await Promise.all([
      latArr.get(undefined, opts.readOptions),
      lonArr.get(undefined, opts.readOptions),
    ]);
    const index = GridIndex.fromCoordinates(
      numericCoords(latData, opts.latName ?? "lat"),
      numericCoords(lonData, opts.lonName ?? "lon"),
      ny,
      nx,
    );

    if (opts.cache) {
      try {
        await opts.cache.set(key, index.toBytes(), opts.ttlMs);
      } catch {
        // Cache write failure must never break a read.
      }
    }
    return index;
  }

  /**
   * Nearest grid cell to (lat, lon). Uses an equirectangular metric with a
   * `cos(lat)` longitude correction — accurate for regional grids and exact
   * enough for cell selection.
   */
  nearest(targetLat: number, targetLon: number): NearestResult {
    const cosLat = Math.cos((targetLat * Math.PI) / 180);
    const { lat, lon, nx, ny } = this;
    let best = Infinity;
    let bi = 0;
    let bj = 0;
    for (let i = 0; i < ny; i++) {
      const row = i * nx;
      for (let j = 0; j < nx; j++) {
        const dLat = lat[row + j] - targetLat;
        const dLon = (lon[row + j] - targetLon) * cosLat;
        const d = dLat * dLat + dLon * dLon;
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    return { i: bi, j: bj, distanceKm: Math.sqrt(best) * KM_PER_DEG };
  }

  /** Resolve many points in one pass over the call sites. */
  nearestMany(points: Array<[number, number]>): NearestResult[] {
    return points.map(([lat, lon]) => this.nearest(lat, lon));
  }

  /**
   * Compact binary snapshot: `magic(u32) ny(u32) nx(u32)` then lat then lon as
   * little-endian f32. Suitable for storing in Redis as a raw buffer.
   */
  toBytes(): Uint8Array {
    const n = this.ny * this.nx;
    const out = new Uint8Array(12 + n * 4 * 2);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SNAPSHOT_MAGIC, true);
    dv.setUint32(4, this.ny, true);
    dv.setUint32(8, this.nx, true);
    out.set(asBytes(this.lat), 12);
    out.set(asBytes(this.lon), 12 + n * 4);
    return out;
  }

  /** Rehydrate a {@link GridIndex} from {@link toBytes} output. */
  static fromBytes(buf: Uint8Array): GridIndex {
    if (buf.byteLength < 12) {
      throw new Error("GridIndex.fromBytes: buffer too small for header");
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== SNAPSHOT_MAGIC) {
      throw new Error(
        "GridIndex.fromBytes: bad magic (not a GridIndex snapshot)",
      );
    }
    const ny = dv.getUint32(4, true);
    const nx = dv.getUint32(8, true);
    const n = ny * nx;
    const expected = 12 + n * 4 * 2;
    if (buf.byteLength !== expected) {
      throw new Error(
        `GridIndex.fromBytes: length mismatch (expected ${expected}, got ${buf.byteLength})`,
      );
    }
    // `.slice()` copies into a fresh, 4-byte-aligned ArrayBuffer so the
    // Float32Array view is always valid regardless of `buf`'s byteOffset.
    const lat = new Float32Array(buf.slice(12, 12 + n * 4).buffer);
    const lon = new Float32Array(buf.slice(12 + n * 4, expected).buffer);
    return new GridIndex(lat, lon, ny, nx);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toFloat32(a: ArrayLike<number>): Float32Array {
  if (a instanceof Float32Array) return a;
  const out = new Float32Array(a.length);
  out.set(a);
  return out;
}

/**
 * Narrow a decoded coordinate array to a numeric `ArrayLike`. Coordinates are
 * float/int dtypes; a 64-bit integer dtype (BigInt arrays) is rejected since it
 * can't be treated as `number`.
 */
function numericCoords(
  data: { length: number },
  name: string,
): ArrayLike<number> {
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    throw new Error(
      `GridIndex: "${name}" has a 64-bit integer dtype; expected float/int coordinates`,
    );
  }
  return data as unknown as ArrayLike<number>;
}

function asBytes(a: Float32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "");
}

function assertGridShape(lat: ZarrArray, lon: ZarrArray): void {
  if (lat.shape.length !== 2) {
    throw new Error(
      `GridIndex expects a 2D lat array, got shape ${JSON.stringify(lat.shape)}`,
    );
  }
  if (
    lon.shape.length !== 2 ||
    lon.shape[0] !== lat.shape[0] ||
    lon.shape[1] !== lat.shape[1]
  ) {
    throw new Error(
      `GridIndex: lat/lon shapes must match — lat=${JSON.stringify(lat.shape)}, ` +
        `lon=${JSON.stringify(lon.shape)}`,
    );
  }
}

function attrStr(v: unknown): string {
  return v == null ? "" : String(v);
}

/**
 * Derive a *domain-scoped* cache key (level 1): identifies the grid by the
 * dataset's domain attrs (`source_model`/`experiment`/`grid_id`) plus the
 * coordinate `shape`/`chunks`/`dtype`. `run_time` and other per-run attrs are
 * deliberately excluded so every run of the same domain shares one entry.
 * Costs zero chunk fetches (all inputs come from consolidated metadata). With
 * `verify`, also folds a corner sample of lat/lon into the key (+2 GETs).
 */
async function deriveGridKey(
  group: ZarrGroup,
  latArr: ZarrArray,
  lonArr: ZarrArray,
  verify: boolean,
  readOptions: ReadOptions | undefined,
): Promise<string> {
  const attrs = group.attrs as Record<string, unknown>;
  const domain = [
    attrStr(attrs.source_model),
    attrStr(attrs.experiment),
    attrStr(attrs.grid_id),
  ]
    .filter(Boolean)
    .join("-");

  if (!domain) {
    console.warn(
      "[zarr-node] GridIndex: dataset has no source_model/experiment/grid_id " +
        "attrs; the grid key falls back to shape/dtype only and may collide " +
        "across different domains with the same shape. Pass an explicit " +
        "`gridKey`, or `verifyGrid: true`, to disambiguate.",
    );
  }

  let canonical = [
    domain,
    latArr.shape.join("x"),
    lonArr.shape.join("x"),
    latArr.chunks.join("x"),
    latArr.dtype,
  ].join("|");

  if (verify) {
    const [latCorner, lonCorner] = await Promise.all([
      latArr.get(
        [
          [0, 1],
          [0, 1],
        ],
        readOptions,
      ),
      lonArr.get(
        [
          [0, 1],
          [0, 1],
        ],
        readOptions,
      ),
    ]);
    canonical += `|corner=${latCorner[0]},${lonCorner[0]}`;
  }

  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 16);
  const readable = sanitize(domain || "grid") + "-" + latArr.shape.join("x");
  return `${KEY_PREFIX}${readable}-${hash}`;
}
