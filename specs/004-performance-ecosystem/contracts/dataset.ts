import type { TypedArray } from "../../../src/dtype.js";

/**
 * Label-based selection by dimension name and coordinate value.
 * Values are mapped to nearest coordinate index.
 *
 * Example: { time: 0, lat: -25.5, lon: -44.5 }
 */
export type DatasetSelection = Record<string, number>;

/**
 * Dataset wraps a ZarrGroup with dimension-aware access.
 * Auto-discovers dimensions from _ARRAY_DIMENSIONS attributes.
 * Provides label-based selection (like xarray's ds.sel()).
 */
export interface Dataset {
  /** Names of all data variables (non-coordinate arrays). */
  readonly variableNames: readonly string[];

  /** Names of all dimensions. */
  readonly dimensionNames: readonly string[];

  /** Names of coordinate arrays. */
  readonly coordinateNames: readonly string[];

  /**
   * Select data by coordinate values (nearest-neighbor lookup).
   * Returns all data variables at the selected point/region.
   *
   * @param selection - Dimension name to coordinate value mapping.
   * @param variables - Optional subset of variable names to read. Default: all.
   */
  sel(
    selection: DatasetSelection,
    variables?: string[],
  ): Promise<Map<string, TypedArray>>;
}
