/**
 * Benchmark: novo default de concurrency (50) vs antigo (10).
 * Run: npx tsx examples/benchmark-concurrency.ts
 */
import { S3Store, openGroup } from "../src/index.js";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const s3 = new S3Store({
    bucket: "my-zarr-bucket",
    prefix: "my-data.zarr",
    region: "us-east-1",
  });

  const root = await openGroup(s3);
  const wind = await root.getArray("wind_speed_at_10m_agl");

  const chunks = Math.ceil(wind.shape[1] / wind.chunks[1]) * Math.ceil(wind.shape[2] / wind.chunks[2]);
  console.log(`Full field: ${wind.shape[1]}×${wind.shape[2]} = ${chunks} chunks\n`);

  // New default (50)
  let t0 = performance.now();
  await wind.get([0, null, null]);
  const d50 = performance.now() - t0;
  console.log(`  concurrency=50 (novo default): ${fmt(d50)}  (${(chunks / (d50 / 1000)).toFixed(0)} req/s)`);

  // Old default (10)
  t0 = performance.now();
  await wind.get([0, null, null], { concurrency: 10 });
  const d10 = performance.now() - t0;
  console.log(`  concurrency=10 (antigo):       ${fmt(d10)}  (${(chunks / (d10 / 1000)).toFixed(0)} req/s)`);

  console.log(`\n  Speedup: ${(d10 / d50).toFixed(1)}x mais rápido com novo default`);
}

main().catch(console.error);
