/**
 * Benchmark: List arrays on WRF S3 store with consolidated metadata.
 *
 * Run with: npx tsx examples/benchmark-consolidated.ts
 */
import { S3Store, openGroup } from "../src/index.js";

async function main() {
  const store = new S3Store({
    bucket: "teste-zarr",
    prefix: "wrf_sse1_complete.zarr",
    region: "us-east-1",
  });

  console.log("=== Consolidated Metadata S3 Benchmark ===\n");

  const t0 = performance.now();
  const root = await openGroup(store);
  const t1 = performance.now();
  console.log(`1. Open root group (loads .zmetadata): ${(t1 - t0).toFixed(0)}ms`);

  const t2 = performance.now();
  const arrays: string[] = [];
  for await (const [name, arr] of root.arrays()) {
    arrays.push(`${name}: shape=${JSON.stringify(arr.shape)} ${arr.attrs.units ?? ""}`);
  }
  const t3 = performance.now();
  console.log(`2. List all ${arrays.length} arrays:              ${(t3 - t2).toFixed(0)}ms`);
  console.log(`   Total (open + list):                ${(t3 - t0).toFixed(0)}ms`);

  console.log(`\nArrays found:`);
  for (const a of arrays) {
    console.log(`  ${a}`);
  }

  // Also benchmark getArray directly
  const t4 = performance.now();
  const wind = await root.getArray("wind_speed_at_10m_agl");
  const t5 = performance.now();
  console.log(`\n3. getArray("wind_speed_at_10m_agl"):  ${(t5 - t4).toFixed(0)}ms`);
  console.log(`   shape=${JSON.stringify(wind.shape)} dtype=${wind.dtype}`);
}

main().catch(console.error);
