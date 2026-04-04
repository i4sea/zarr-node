/**
 * Benchmark: Read WRF lat/lon from S3 with disk cache.
 * Compares first read (cold) vs second read (cached).
 *
 * Run with: npx tsx examples/benchmark-cache-s3.ts
 */
import { S3Store, CachedStore, openGroup } from "../src/index.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const cacheDir = join(tmpdir(), `zarr-bench-cache-${Date.now()}`);
  const s3 = new S3Store({
    bucket: "my-zarr-bucket",
    prefix: "my-data.zarr",
    region: "us-east-1",
  });
  const store = new CachedStore(s3, { cacheDir, storeId: "wrf-benchmark" });

  console.log("=== WRF S3 + Disk Cache Benchmark ===\n");

  // Open group (consolidated metadata)
  const root = await openGroup(store);

  // Pick center point
  const lat = await root.getArray("lat");
  const lon = await root.getArray("lon");
  const latIdx = Math.floor(lat.shape[0] / 2);
  const lonIdx = Math.floor(lat.shape[1] / 2);

  // --- COLD READ (first time, from S3) ---
  console.log("Cold read (first time, from S3):");
  let t0 = performance.now();
  const latSlice1 = await lat.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  let t1 = performance.now();
  console.log(`  lat point: ${fmt(t1 - t0)}  →  ${latSlice1[0].toFixed(4)}`);

  t0 = performance.now();
  const lonSlice1 = await lon.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`  lon point: ${fmt(t1 - t0)}  →  ${lonSlice1[0].toFixed(4)}`);

  // Wind time series
  const wind = await root.getArray("wind_speed_at_10m_agl");
  t0 = performance.now();
  const ts1 = await wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`  wind ts:   ${fmt(t1 - t0)}  →  ${ts1.length} values`);

  // --- CACHED READ (second time, from disk) ---
  console.log("\nCached read (second time, from disk):");
  t0 = performance.now();
  const latSlice2 = await lat.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`  lat point: ${fmt(t1 - t0)}  →  ${latSlice2[0].toFixed(4)}`);

  t0 = performance.now();
  const lonSlice2 = await lon.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`  lon point: ${fmt(t1 - t0)}  →  ${lonSlice2[0].toFixed(4)}`);

  t0 = performance.now();
  const ts2 = await wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`  wind ts:   ${fmt(t1 - t0)}  →  ${ts2.length} values`);

  // Cleanup
  await rm(cacheDir, { recursive: true, force: true });
}

main().catch(console.error);
