# Quickstart: Polygon Reader

**Feature**: 007-polygon-reader | Import path: `@i4sea/zarr-node/spatial`

Read every forecast cell inside an area, one time step at a time, then compute your own per-area statistics.

## 1. Stream in-polygon cells over time (2-D curvilinear grid)

```ts
import { openGroup } from "@i4sea/zarr-node";
import { GridIndex, readPolygon } from "@i4sea/zarr-node/spatial";

const group = await openGroup(store);
const arr = await group.getArray("t2m");          // shape [time, ny, nx]
const grid = await GridIndex.fromGroup(group);    // curvilinear lat/lon

const polygon: Array<[number, number]> = [        // ring of [lat, lon]
  [-23.0, -43.5], [-23.0, -43.0], [-22.5, -43.0], [-22.5, -43.5],
];

for await (const step of readPolygon(arr, {
  polygon,
  spatialLayout: { kind: "2d", grid },
})) {
  // step.values: Float64Array of only the in-polygon cells for step.t
  const median = percentile(step.values, 50);     // aggregation is YOUR concern
  console.log(step.t, median);
}
```

## 2. Get the selection (positions) without reading values

```ts
import { resolvePolygonCells } from "@i4sea/zarr-node/spatial";

const sel = resolvePolygonCells(arr, {
  polygon,
  spatialLayout: { kind: "2d", grid },
});

console.log(sel.cells.length, "cells; stride", sel.stride, "bbox", sel.bbox);
// sel.cells[k] = { i, j, lat, lon } — aligned to step.values[k] in readPolygon
```

## 3. 1-D rectilinear axes and a time sub-range

```ts
const latAxis = await (await group.getArray("lat")).get(); // monotonic 1-D
const lonAxis = await (await group.getArray("lon")).get();

for await (const step of readPolygon(arr, {
  polygon,
  spatialLayout: { kind: "1d", lat: latAxis, lon: lonAxis },
  timeRange: [0, 24],           // only the first 24 time steps
})) { /* ... */ }
```

## 4. Cap a huge selection (adaptive stride)

```ts
const sel = resolvePolygonCells(arr, {
  polygon: hugeCoastline,
  spatialLayout: { kind: "2d", grid },
  maxCells: 5_000,              // no default cap; opt in here
});
// sel.cells.length <= 5000, spread across the area; sel.stride > 1
```

## 5. Forward read tuning / observability

```ts
import { MemoryCache } from "@i4sea/zarr-node";

const cache = new MemoryCache(512 * 1024 * 1024);
let decodes = 0;

for await (const step of readPolygon(arr, {
  polygon,
  spatialLayout: { kind: "2d", grid },
  readOptions: {
    memoryCache: cache,                     // reuse decoded chunks across timesteps
    concurrency: 16,
    observability: { onChunkDecoded: () => decodes++ },
  },
})) { /* ... */ }
// `decodes` equals the number of distinct bbox-overlapping chunks — each read once.
```

## Behaviour notes

- **Concave polygons**: only cells geometrically inside are returned — bbox-inside-but-polygon-outside cells are excluded.
- **Ring closure**: pass the ring closed or unclosed; results are identical.
- **Empty area** (polygon outside the grid): the loop simply yields nothing; no error.
- **Invalid input** (< 3 vertices, reversed `timeRange`): throws `SliceError`.
- **Aggregation is out of scope** — the library hands you the raw in-polygon values; you compute median/min/max/argmax yourself.

## Verifying the guarantees (test hooks)

- **Chunk-read-once / memory bound**: count `readOptions.observability.onChunkDecoded` over a full multi-timestep read → equals the number of distinct chunks overlapping the bbox (0 re-decodes). See `tests/unit/polygon-reader.test.ts`.
- **Ordering**: `resolvePolygonCells(...).cells` order matches every `step.values` alignment.
