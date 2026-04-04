/**
 * Benchmark: medir o impacto de cada feature do 004-performance-ecosystem.
 *
 * Testa com WRF real no S3 (49 timesteps, 761x602 grid, Blosc-compressed).
 *
 * Run: npx tsx examples/benchmark-all.ts
 */
import {
  S3Store,
  CachedStore,
  MemoryCache,
  openGroup,
  openArray,
} from "../src/index.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fmt(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function speedup(base: number, fast: number): string {
  if (fast === 0) return "∞x";
  const x = base / fast;
  return `${x.toFixed(1)}x`;
}

interface BenchResult {
  label: string;
  time: number;
  detail?: string;
}

const results: BenchResult[] = [];

function bench(label: string, time: number, detail?: string) {
  results.push({ label, time, detail });
  console.log(`  ${fmt(time).padStart(8)}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

async function main() {
  const cacheDir = join(tmpdir(), `zarr-bench-${Date.now()}`);

  const s3 = new S3Store({
    bucket: "my-zarr-bucket",
    prefix: "my-data.zarr",
    region: "us-east-1",
  });

  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  zarr-node benchmark — WRF 49x761x602 Blosc/S3      ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // ── 1. Open group (consolidated metadata) ──
  console.log("── 1. Consolidated Metadata ──\n");

  const { result: root, ms: openMs } = await measure(() => openGroup(s3));
  bench("openGroup (loads .zmetadata)", openMs);

  const { ms: listMs } = await measure(async () => {
    const names: string[] = [];
    for await (const [name] of root.arrays()) names.push(name);
    return names;
  });
  bench("list 19 arrays (from consolidated)", listMs);

  // ── 2. Blosc — single chunk read ──
  console.log("\n── 2. Blosc Decompression ──\n");

  const wind = await root.getArray("wind_speed_at_10m_agl");
  console.log(`  wind: ${JSON.stringify(wind.shape)} chunks=${JSON.stringify(wind.chunks)} dtype=${wind.dtype}\n`);

  // Cold read — includes S3 latency + Blosc decompression
  const { ms: bloscCold } = await measure(() => wind.get([0, [0, 16], [0, 16]]));
  bench("1 chunk cold (S3 + Blosc)", bloscCold);

  // ── 3. Memory Cache ──
  console.log("\n── 3. Memory Cache ──\n");

  const memCache = new MemoryCache({ maxBytes: 200 * 1024 * 1024 }); // 200MB

  // Warm up
  await wind.get([0, [0, 16], [0, 16]], { memoryCache: memCache });

  // Cached read
  const { ms: memHit } = await measure(() =>
    wind.get([0, [0, 16], [0, 16]], { memoryCache: memCache }),
  );
  bench("1 chunk memory cache hit", memHit);
  bench("speedup vs cold", 0, speedup(bloscCold, memHit));

  // ── 4. Disk Cache ──
  console.log("\n── 4. Disk Cache ──\n");

  const cached = new CachedStore(s3, {
    cacheDir,
    storeId: "bench-wrf",
    maxSizeBytes: 500 * 1024 * 1024,
  });

  const windCached = await (await openGroup(cached)).getArray("wind_speed_at_10m_agl");

  // Cold read through disk cache
  const { ms: diskCold } = await measure(() =>
    windCached.get([0, [0, 16], [0, 16]]),
  );
  bench("1 chunk cold (S3 → disk cache)", diskCold);

  // Warm disk cache read
  const { ms: diskHit } = await measure(() =>
    windCached.get([0, [0, 16], [0, 16]]),
  );
  bench("1 chunk disk cache hit", diskHit);
  bench("speedup vs S3 cold", 0, speedup(diskCold, diskHit));

  // ── 5. Time series — single point, all timesteps ──
  console.log("\n── 5. Time Series (1 point × 49 steps) ──\n");

  const latIdx = Math.floor(wind.shape[1] / 2);
  const lonIdx = Math.floor(wind.shape[2] / 2);

  // Raw S3
  const { ms: tsSlow } = await measure(() =>
    wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
  );
  bench("time series (raw S3)", tsSlow);

  // With memory cache
  const memCache2 = new MemoryCache({ maxBytes: 200 * 1024 * 1024 });
  const { ms: tsMem1 } = await measure(() =>
    wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]], { memoryCache: memCache2 }),
  );
  bench("time series (S3 + memcache cold)", tsMem1);

  const { ms: tsMem2 } = await measure(() =>
    wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]], { memoryCache: memCache2 }),
  );
  bench("time series (memcache warm)", tsMem2);
  bench("speedup vs raw S3", 0, speedup(tsSlow, tsMem2));

  // ── 6. readMultiple — 4 variables at same point ──
  console.log("\n── 6. readMultiple (4 vars × 1 point) ──\n");

  const { ms: multiMs } = await measure(() =>
    root.readMultiple(
      ["wind_speed_at_10m_agl", "air_temperature_at_2m_agl", "relative_humidity_at_2m_agl", "air_pressure_at_sea_level"],
      [0, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]],
    ),
  );
  bench("readMultiple 4 vars", multiMs);

  // Sequential for comparison
  const { ms: seqMs } = await measure(async () => {
    const temp = await root.getArray("air_temperature_at_2m_agl");
    const rh = await root.getArray("relative_humidity_at_2m_agl");
    const press = await root.getArray("air_pressure_at_sea_level");
    await wind.get([0, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
    await temp.get([0, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
    await rh.get([0, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
    await press.get([0, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  });
  bench("4 vars sequential", seqMs);
  bench("readMultiple speedup", 0, speedup(seqMs, multiMs));

  // ── 7. getRange — partial vs full ──
  console.log("\n── 7. Byte-Range (getRange vs get) ──\n");

  // Full chunk
  const { ms: fullMs } = await measure(() => s3.get("time/0"));
  bench("full GET time/0", fullMs);

  // Partial (first 16 bytes)
  const { ms: rangeMs } = await measure(() => s3.getRange("time/0", 0, 16));
  bench("getRange time/0 (16 bytes)", rangeMs);

  // ── 8. Full field read — 1 timestep of entire grid ──
  console.log("\n── 8. Full Field (1 timestep × 761×602) ──\n");

  const memCache3 = new MemoryCache({ maxBytes: 500 * 1024 * 1024 });

  const { ms: fieldMs } = await measure(() =>
    wind.get([0, null, null], { memoryCache: memCache3 }),
  );
  bench(`full field cold (${wind.shape[1]}×${wind.shape[2]})`, fieldMs);

  const { ms: fieldCached } = await measure(() =>
    wind.get([0, null, null], { memoryCache: memCache3 }),
  );
  bench("full field memcache warm", fieldCached);
  bench("speedup", 0, speedup(fieldMs, fieldCached));

  const fieldElements = wind.shape[1] * wind.shape[2];
  const fieldMB = (fieldElements * 4) / (1024 * 1024);
  const throughputCold = fieldMB / (fieldMs / 1000);
  const throughputWarm = fieldMB / (fieldCached / 1000);
  bench("throughput cold", 0, `${throughputCold.toFixed(0)} MB/s`);
  bench("throughput warm", 0, `${throughputWarm.toFixed(0)} MB/s`);

  // ══════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("══════════════════════════════════════════════════════\n");

  console.log(`  ${"Operation".padEnd(42)}  ${"Time".padStart(10)}`);
  console.log(`  ${"─".repeat(42)}  ${"─".repeat(10)}`);
  for (const r of results) {
    if (r.time > 0) {
      console.log(`  ${r.label.padEnd(42)}  ${fmt(r.time).padStart(10)}`);
    } else if (r.detail) {
      console.log(`  ${r.label.padEnd(42)}  ${r.detail.padStart(10)}`);
    }
  }

  console.log(`\n  cache: ${(memCache.totalBytes / 1024 / 1024).toFixed(1)} MB in memory, disk at ${cacheDir}`);

  await rm(cacheDir, { recursive: true, force: true });
}

main().catch(console.error);
