/**
 * `@i4sea/zarr-node/spatial` — spatial helpers over Zarr coordinate grids.
 */
export { GridIndex } from "./grid-index.js";
export type {
  NearestResult,
  LoadCachedOptions,
  FromGroupOptions,
} from "./grid-index.js";

export { readPolygon, resolvePolygonCells } from "./polygon-reader.js";
export type {
  SpatialLayout,
  PolygonReadOptions,
  PolygonCell,
  PolygonBBox,
  PolygonSelection,
  PolygonTimestep,
} from "./polygon-reader.js";
