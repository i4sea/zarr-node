/**
 * Example: stream the cells inside a lat/lon polygon of a `[time, ny, nx]`
 * array, one time step at a time, and compute a per-step statistic.
 *
 * Reads each step as a bounding-box block, so each backing chunk is fetched
 * once and peak memory stays bounded to ~one time slice regardless of how many
 * time steps the array has. Aggregation is the caller's concern.
 *
 * Run with: npx tsx examples/read-polygon.ts
 */
import { S3Store, openGroup } from "../src/index.js";
import { GridIndex, readPolygon, resolvePolygonCells } from "../src/spatial/index.js";

async function main() {
  const store = new S3Store({
    bucket: "my-zarr-bucket",
    prefix: "my-data.zarr",
    region: "us-east-1",
  });

  const group = await openGroup(store);
  const arr = await group.getArray("t2m"); // shape [time, ny, nx]
  const grid = await GridIndex.fromGroup(group); // curvilinear lat/lon

  // A ring of [lat, lon] vertices (closed or unclosed — implicitly closed).
  const polygon: Array<[number, number]> = [
    [-23.0, -43.5],
    [-23.0, -43.0],
    [-22.5, -43.0],
    [-22.5, -43.5],
  ];

  // Inspect the time-invariant selection without reading any values.
  const sel = resolvePolygonCells(arr, {
    polygon,
    spatialLayout: { kind: "2d", grid },
  });
  console.log(
    `selection: ${sel.cells.length} cells, stride ${sel.stride}, bbox`,
    sel.bbox,
  );

  // Stream one time step at a time; step.values aligns with sel.cells.
  for await (const step of readPolygon(arr, {
    polygon,
    spatialLayout: { kind: "2d", grid },
    // timeRange: [0, 24],  // optional half-open [start, end) sub-range
    // maxCells: 5_000,     // optional cap → clamped uniform stride
  })) {
    const mean =
      step.values.reduce((a, b) => a + b, 0) / (step.values.length || 1);
    console.log(`t=${step.t}  n=${step.values.length}  mean=${mean.toFixed(3)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
