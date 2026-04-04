import type { ZarrGroup } from "./group.js";
import type { ZarrArray } from "./array.js";
import type { TypedArray } from "./dtype.js";
import { nearestIndex, linearNearestIndex } from "./coordinates.js";

export type DatasetSelection = Record<string, number>;

/**
 * Dataset wraps a ZarrGroup with dimension-aware access.
 * Auto-discovers dimensions from _ARRAY_DIMENSIONS attributes.
 * Provides label-based selection (like xarray's ds.sel()).
 */
export class Dataset {
  private readonly group: ZarrGroup;
  private readonly _variableNames: string[];
  private readonly _dimensionNames: string[];
  private readonly _coordinateNames: string[];
  private readonly arrays: Map<string, ZarrArray>;
  /** Map: dimension name -> coordinate array name */
  private readonly dimToCoord: Map<string, string>;
  /** Map: variable name -> ordered list of its dimension names */
  private readonly varDims: Map<string, string[]>;
  /** Cached coordinate data */
  private coordCache = new Map<string, TypedArray>();

  constructor(
    group: ZarrGroup,
    arrays: Map<string, ZarrArray>,
    dimToCoord: Map<string, string>,
    varDims: Map<string, string[]>,
    dimensionNames: string[],
    coordinateNames: string[],
    variableNames: string[],
  ) {
    this.group = group;
    this.arrays = arrays;
    this.dimToCoord = dimToCoord;
    this.varDims = varDims;
    this._dimensionNames = dimensionNames;
    this._coordinateNames = coordinateNames;
    this._variableNames = variableNames;
  }

  get variableNames(): readonly string[] {
    return this._variableNames;
  }

  get dimensionNames(): readonly string[] {
    return this._dimensionNames;
  }

  get coordinateNames(): readonly string[] {
    return this._coordinateNames;
  }

  /**
   * Select data by coordinate values (nearest-neighbor lookup).
   * Returns all data variables at the selected point/region.
   */
  async sel(
    selection: DatasetSelection,
    variables?: string[],
  ): Promise<Map<string, TypedArray>> {
    // Resolve each dimension to an index
    const dimIndices = new Map<string, number>();

    // Separate 1D and 2D+ coordinate selections
    const sel1D: Array<{ dimName: string; coordName: string; value: number }> = [];
    const sel2D: Array<{ dimName: string; coordName: string; value: number }> = [];

    for (const [dimName, value] of Object.entries(selection)) {
      const coordName = this.dimToCoord.get(dimName);
      if (!coordName) {
        throw new Error(`Unknown dimension: "${dimName}"`);
      }
      const coordArr = this.arrays.get(coordName);
      if (coordArr && coordArr.shape.length >= 2) {
        sel2D.push({ dimName, coordName, value });
      } else {
        sel1D.push({ dimName, coordName, value });
      }
    }

    // Resolve 1D coordinates with binary search
    for (const { dimName, coordName, value } of sel1D) {
      let coordData = this.coordCache.get(coordName);
      if (!coordData) {
        const coordArr = this.arrays.get(coordName);
        if (!coordArr) throw new Error(`Coordinate array "${coordName}" not found`);
        coordData = await coordArr.get();
        this.coordCache.set(coordName, coordData);
      }
      dimIndices.set(dimName, nearestIndex(coordData, value));
    }

    // Resolve 2D+ coordinates jointly — find the grid point minimizing combined distance
    if (sel2D.length > 0) {
      // Load all 2D coord arrays
      const coordArrays: Array<{ coordName: string; data: TypedArray; shape: readonly number[]; dims: string[] }> = [];
      for (const { coordName } of sel2D) {
        if (coordArrays.some((c) => c.coordName === coordName)) continue;
        let coordData = this.coordCache.get(coordName);
        if (!coordData) {
          const coordArr = this.arrays.get(coordName);
          if (!coordArr) throw new Error(`Coordinate array "${coordName}" not found`);
          coordData = await coordArr.get();
          this.coordCache.set(coordName, coordData);
        }
        const coordArr = this.arrays.get(coordName)!;
        const dims = this.varDims.get(coordName) ?? [];
        coordArrays.push({ coordName, data: coordData, shape: coordArr.shape, dims });
      }

      // Find the flat index minimizing the sum of squared distances across all 2D selections
      const n = coordArrays[0].data.length;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        let dist = 0;
        for (const { coordName, value } of sel2D) {
          const ca = coordArrays.find((c) => c.coordName === coordName)!;
          const d = ca.data[i] - value;
          dist += d * d;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      // Decompose flat index into multi-dimensional indices using the first coord array's shape
      const refCoord = coordArrays[0];
      let remaining = bestIdx;
      for (let d = refCoord.shape.length - 1; d >= 0; d--) {
        const dimSize = refCoord.shape[d];
        const localIdx = remaining % dimSize;
        remaining = Math.floor(remaining / dimSize);
        dimIndices.set(refCoord.dims[d], localIdx);
      }
    }

    // Read the requested variables
    const targetVars = variables ?? this._variableNames;
    const results = new Map<string, TypedArray>();

    for (const varName of targetVars) {
      const arr = this.arrays.get(varName);
      if (!arr) continue;

      const dims = this.varDims.get(varName);
      if (!dims) continue;

      // Build slice for this variable based on resolved dimension indices
      const slice = dims.map((dimName) => {
        const idx = dimIndices.get(dimName);
        if (idx !== undefined) {
          return idx; // single index
        }
        return null; // full range
      });

      const data = await arr.get(slice);
      results.set(varName, data);
    }

    return results;
  }
}

/**
 * Create a Dataset from a ZarrGroup by auto-discovering dimensions.
 */
export async function createDataset(group: ZarrGroup): Promise<Dataset> {
  const arrays = new Map<string, ZarrArray>();
  const allDimensions = new Set<string>();
  const varDims = new Map<string, string[]>();

  // Load all arrays and collect dimension info
  for await (const [name, arr] of group.arrays()) {
    arrays.set(name, arr);

    const dims = arr.attrs._ARRAY_DIMENSIONS;
    if (Array.isArray(dims)) {
      const dimNames = dims as string[];
      varDims.set(name, dimNames);
      for (const d of dimNames) {
        allDimensions.add(d);
      }
    }
  }

  // Find the maximum number of dimensions across all arrays (data variables have the most)
  let maxDims = 0;
  for (const dims of varDims.values()) {
    if (dims.length > maxDims) maxDims = dims.length;
  }

  // Coordinate arrays: those whose name matches a dimension name (1D coords)
  // or whose dims are a strict subset of the max-dim arrays (2D aux coords like lat[y,x])
  const coordinateNames: string[] = [];
  const variableNames: string[] = [];
  const dimToCoord = new Map<string, string>();

  for (const [name, arr] of arrays) {
    const dims = varDims.get(name);
    if (allDimensions.has(name)) {
      // 1D coordinate: array name matches a dimension name (e.g., "time" with dims ["time"])
      coordinateNames.push(name);
      dimToCoord.set(name, name);
    } else if (
      dims &&
      dims.length >= 2 &&
      dims.length < maxDims &&
      dims.every((d) => allDimensions.has(d))
    ) {
      // 2D+ auxiliary coordinate (e.g., lat[y,x], lon[y,x])
      // Has fewer dims than data variables — it's a coordinate grid, not data
      coordinateNames.push(name);
      dimToCoord.set(name, name);
    } else {
      variableNames.push(name);
    }
  }

  return new Dataset(
    group,
    arrays,
    dimToCoord,
    varDims,
    [...allDimensions].sort(),
    coordinateNames.sort(),
    variableNames.sort(),
  );
}
