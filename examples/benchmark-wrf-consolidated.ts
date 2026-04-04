/**
 * Benchmark: Full WRF workflow with consolidated metadata.
 * Compare open+list+read times with the previous non-consolidated run.
 *
 * Run with: npx tsx examples/benchmark-wrf-consolidated.ts
 */
import { S3Store, openGroup, codecRegistry } from "../src/index.js";
import { Blosc } from "numcodecs";

codecRegistry.register("blosc", () => ({
  id: "blosc",
  async decode(data: Uint8Array): Promise<Uint8Array> {
    return Blosc.fromConfig({ id: "blosc", cname: "lz4", clevel: 5, shuffle: 1, blocksize: 0 }).decode(data);
  },
}));

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const store = new S3Store({
    bucket: "teste-zarr",
    prefix: "wrf_sse1_complete.zarr",
    region: "us-east-1",
  });

  console.log("=== WRF S3 Benchmark (com .zmetadata) ===\n");

  // 1. Open root group (loads .zmetadata)
  let t0 = performance.now();
  const root = await openGroup(store);
  let t1 = performance.now();
  console.log(`1. Abrir root group:             ${fmt(t1 - t0)}`);

  // 2. List all arrays
  t0 = performance.now();
  const arrayNames: string[] = [];
  for await (const [name] of root.arrays()) {
    arrayNames.push(name);
  }
  t1 = performance.now();
  console.log(`2. Listar ${arrayNames.length} arrays:              ${fmt(t1 - t0)}`);

  // 3. Open wind metadata
  t0 = performance.now();
  const wind = await root.getArray("wind_speed_at_10m_agl");
  t1 = performance.now();
  console.log(`3. Abrir metadados do wind:      ${fmt(t1 - t0)}`);
  console.log(`   shape=${JSON.stringify(wind.shape)} chunks=${JSON.stringify(wind.chunks)} dtype=${wind.dtype}`);

  // 4. Open lat/lon metadata
  t0 = performance.now();
  const lat = await root.getArray("lat");
  const lon = await root.getArray("lon");
  t1 = performance.now();
  console.log(`4. Abrir metadados lat/lon:      ${fmt(t1 - t0)}`);

  // Pick center point
  const latIdx = Math.floor(lat.shape[0] / 2);
  const lonIdx = Math.floor(lat.shape[1] / 2);

  // 5. Read lat/lon at point
  t0 = performance.now();
  const latVal = await lat.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  const lonVal = await lon.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`5. Ler lat/lon do ponto:         ${fmt(t1 - t0)}`);
  console.log(`   Ponto: lat=${latVal[0].toFixed(4)}, lon=${lonVal[0].toFixed(4)} (idx=[${latIdx}, ${lonIdx}])`);

  // 6. Read time series
  t0 = performance.now();
  const timeSeries = await wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  t1 = performance.now();
  console.log(`6. Ler serie temporal (${timeSeries.length} steps): ${fmt(t1 - t0)}`);

  // 7. Read time coordinate
  t0 = performance.now();
  const time = await root.getArray("time");
  const timeData = await time.get();
  t1 = performance.now();
  console.log(`7. Ler coordenada time:          ${fmt(t1 - t0)}`);

  // Comparison table
  console.log(`\n=== Comparacao: antes vs depois ===\n`);
  console.log(`| Operacao                       | Antes     | Agora     |`);
  console.log(`|--------------------------------|-----------|-----------|`);
  console.log(`| 1. Abrir root group            | 996ms     | ${fmt(0).padStart(9)} |`);
  console.log(`| 2. Listar 19 arrays            | 41.68s    | ${fmt(0).padStart(9)} |`);
  console.log(`| 3. Abrir metadados wind        | 410ms     | ${fmt(0).padStart(9)} |`);
  console.log(`| 4. Abrir metadados lat/lon     | 783ms     | ${fmt(0).padStart(9)} |`);
  console.log(`| 5. Ler lat/lon do ponto        | 2.50s     |           |`);
  console.log(`| 6. Ler serie temporal          | 199ms     |           |`);
  console.log(`| 7. Ler coordenada time         | 1.02s     |           |`);

  // Print time series
  console.log(`\n=== Vento a 10m em (${latVal[0].toFixed(2)}, ${lonVal[0].toFixed(2)}) ===\n`);
  console.log("  Hora (UTC)              Vento (kt)");
  console.log("  ─────────────────────   ──────────");
  for (let i = 0; i < timeSeries.length; i++) {
    const date = new Date(timeData[i] * 1000).toISOString().replace("T", " ").slice(0, 19);
    const bar = "█".repeat(Math.round(timeSeries[i]));
    console.log(`  ${date}   ${timeSeries[i].toFixed(1).padStart(5)} ${bar}`);
  }
}

main().catch(console.error);
