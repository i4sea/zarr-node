/**
 * Benchmark: Read WRF metadata and extract a time series from S3.
 *
 * Run with: npx tsx examples/benchmark-wrf.ts
 */
import { S3Store, openGroup } from "../src/index.js";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const store = new S3Store({
    bucket: "teste-zarr",
    prefix: "wrf_sse1_complete.zarr",
    region: "us-east-1",
  });

  console.log("=== WRF S3 Benchmark ===\n");

  // 1. Open root group (reads .zgroup + .zattrs)
  let t0 = performance.now();
  const root = await openGroup(store);
  let t1 = performance.now();
  console.log(`1. Open root group:          ${fmt(t1 - t0)}`);

  // 2. List all arrays (discovers children + checks .zarray for each)
  t0 = performance.now();
  const arrayNames: string[] = [];
  for await (const [name, arr] of root.arrays()) {
    arrayNames.push(name);
  }
  t1 = performance.now();
  console.log(`2. List all arrays (${arrayNames.length}):     ${fmt(t1 - t0)}`);

  // 3. Open wind_speed_at_10m_agl (reads .zarray + .zattrs)
  t0 = performance.now();
  const wind = await root.getArray("wind_speed_at_10m_agl");
  t1 = performance.now();
  console.log(`3. Open wind array metadata: ${fmt(t1 - t0)}`);
  console.log(`   shape=${JSON.stringify(wind.shape)} chunks=${JSON.stringify(wind.chunks)} dtype=${wind.dtype}`);
  console.log(`   attrs=${JSON.stringify(wind.attrs)}`);

  // 4. Read lat/lon to pick a point
  t0 = performance.now();
  const lat = await root.getArray("lat");
  const lon = await root.getArray("lon");
  t1 = performance.now();
  console.log(`4. Open lat/lon metadata:    ${fmt(t1 - t0)}`);

  // Pick a point near the center of the grid
  const latIdx = Math.floor(lat.shape[0] / 2); // ~380
  const lonIdx = Math.floor(lat.shape[1] / 2); // ~301

  // 5. Read lat/lon at that point to know the coordinates
  t0 = performance.now();
  const latVal = await lat.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  const lonVal = await lon.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`5. Read lat/lon at point:    ${fmt(t1 - t0)}`);
  console.log(`   Point: lat=${latVal[0].toFixed(4)}, lon=${lonVal[0].toFixed(4)} (idx=[${latIdx}, ${lonIdx}])`);

  // 6. Read full time series for wind at that point: all 49 timesteps
  //    Slice: [null, latIdx:latIdx+1, lonIdx:lonIdx+1] → shape [49]
  t0 = performance.now();
  const timeSeries = await wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`6. Read wind time series:    ${fmt(t1 - t0)}`);
  console.log(`   ${timeSeries.length} values (${wind.attrs.units})`);

  // 7. Read time coordinate
  t0 = performance.now();
  const time = await root.getArray("time");
  const timeData = await time.get();
  t1 = performance.now();
  console.log(`7. Read time coordinate:     ${fmt(t1 - t0)}`);

  // Print the time series
  console.log(`\n=== Wind speed time series at (${latVal[0].toFixed(2)}, ${lonVal[0].toFixed(2)}) ===\n`);
  console.log("  Time (UTC)              Wind (knots)");
  console.log("  ─────────────────────   ────────────");
  for (let i = 0; i < timeSeries.length; i++) {
    const date = new Date(timeData[i] * 1000).toISOString().replace("T", " ").slice(0, 19);
    const bar = "█".repeat(Math.round(timeSeries[i]));
    console.log(`  ${date}   ${timeSeries[i].toFixed(1).padStart(5)} ${bar}`);
  }
}

main().catch(console.error);
