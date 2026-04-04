/**
 * End-to-end test: Read WRF forecast from S3 with all optimizations.
 * - Consolidated metadata (.zmetadata)
 * - Disk chunk cache
 * - Blosc codec
 *
 * Run with: npx tsx examples/e2e-wrf.ts
 */
import { S3Store, CachedStore, openGroup } from "../src/index.js";
import { ZarrGroup } from "../src/group.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const totalStart = performance.now();
  const cacheDir = join(tmpdir(), `zarr-e2e-${Date.now()}`);

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   zarr-node — End-to-End WRF Forecast Reader        ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // 1. Setup store with cache
  const s3 = new S3Store({
    bucket: "teste-zarr",
    prefix: "wrf_sse1_complete.zarr",
    region: "us-east-1",
  });
  const store = new CachedStore(s3, { cacheDir, storeId: "wrf-e2e" });

  // 2. Open root group (consolidated metadata)
  let t0 = performance.now();
  const root = await openGroup(store);
  console.log(`[${fmt(performance.now() - t0)}] Abriu root group (consolidated metadata)`);
  console.log(`  attrs: ${JSON.stringify(root.attrs)}\n`);

  // 3. List all variables
  t0 = performance.now();
  const variables: { name: string; shape: readonly number[]; units: string }[] = [];
  for await (const [name, arr] of root.arrays()) {
    variables.push({
      name,
      shape: arr.shape,
      units: (arr.attrs.units as string) ?? "",
    });
  }
  console.log(`[${fmt(performance.now() - t0)}] Listou ${variables.length} variáveis:\n`);

  const maxName = Math.max(...variables.map((v) => v.name.length));
  for (const v of variables) {
    console.log(`  ${v.name.padEnd(maxName)}  ${JSON.stringify(v.shape).padEnd(18)} ${v.units}`);
  }

  // 4. Read coordinates
  console.log("\n── Coordenadas ──");
  const lat = await root.getArray("lat");
  const lon = await root.getArray("lon");
  const time = await root.getArray("time");

  t0 = performance.now();
  const timeData = await time.get();
  console.log(`[${fmt(performance.now() - t0)}] time: ${timeData.length} steps`);

  const t0dt = new Date(timeData[0] * 1000);
  const t1dt = new Date(timeData[timeData.length - 1] * 1000);
  console.log(`  Início: ${t0dt.toISOString()}`);
  console.log(`  Fim:    ${t1dt.toISOString()}`);
  console.log(`  Intervalo: ${((timeData[1] - timeData[0]) / 3600).toFixed(0)}h`);

  // Grid corners
  t0 = performance.now();
  const [latNW, latNE, latSW, latSE] = await Promise.all([
    lat.get([[0, 1], [0, 1]]),
    lat.get([[0, 1], [lat.shape[1] - 1, lat.shape[1]]]),
    lat.get([[lat.shape[0] - 1, lat.shape[0]], [0, 1]]),
    lat.get([[lat.shape[0] - 1, lat.shape[0]], [lat.shape[1] - 1, lat.shape[1]]]),
  ]);
  const [lonNW, lonNE, lonSW, lonSE] = await Promise.all([
    lon.get([[0, 1], [0, 1]]),
    lon.get([[0, 1], [lon.shape[1] - 1, lon.shape[1]]]),
    lon.get([[lon.shape[0] - 1, lon.shape[0]], [0, 1]]),
    lon.get([[lon.shape[0] - 1, lon.shape[0]], [lon.shape[1] - 1, lon.shape[1]]]),
  ]);
  console.log(`[${fmt(performance.now() - t0)}] Grid ${lat.shape[0]}x${lat.shape[1]}:`);
  console.log(`  NW: (${latNW[0].toFixed(2)}, ${lonNW[0].toFixed(2)})  NE: (${latNE[0].toFixed(2)}, ${lonNE[0].toFixed(2)})`);
  console.log(`  SW: (${latSW[0].toFixed(2)}, ${lonSW[0].toFixed(2)})  SE: (${latSE[0].toFixed(2)}, ${lonSE[0].toFixed(2)})`);

  // 5. Read time series at a point
  const latIdx = Math.floor(lat.shape[0] / 2);
  const lonIdx = Math.floor(lat.shape[1] / 2);

  t0 = performance.now();
  const latPt = await lat.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  const lonPt = await lon.get([[latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]);
  console.log(`\n── Série temporal em (${latPt[0].toFixed(2)}, ${lonPt[0].toFixed(2)}) ──`);

  const wind = await root.getArray("wind_speed_at_10m_agl");
  const temp = await root.getArray("air_temperature_at_2m_agl");
  const press = await root.getArray("air_pressure_at_sea_level");
  const rh = await root.getArray("relative_humidity_at_2m_agl");

  const [windTs, tempTs, pressTs, rhTs] = await Promise.all([
    wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
    temp.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
    press.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
    rh.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
  ]);
  console.log(`[${fmt(performance.now() - t0)}] Leu 4 variáveis x ${windTs.length} timesteps\n`);

  console.log("  Hora (UTC)              Temp(°C) Press(hPa)  RH(%)  Vento(kt)");
  console.log("  ─────────────────────   ──────── ──────────  ─────  ─────────");
  for (let i = 0; i < windTs.length; i++) {
    const date = new Date(timeData[i] * 1000).toISOString().replace("T", " ").slice(0, 16);
    const bar = "▓".repeat(Math.round(windTs[i] / 2));
    console.log(
      `  ${date}   ${tempTs[i].toFixed(1).padStart(6)}   ${pressTs[i].toFixed(1).padStart(7)}  ${rhTs[i].toFixed(0).padStart(4)}%  ${windTs[i].toFixed(1).padStart(5)} ${bar}`,
    );
  }

  // 6. Second pass (cached) — show speedup
  console.log("\n── Segunda leitura (cache) ──");
  t0 = performance.now();
  const [windTs2, tempTs2, pressTs2, rhTs2] = await Promise.all([
    wind.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
    temp.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
    press.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
    rh.get([null, [latIdx, latIdx + 1], [lonIdx, lonIdx + 1]]),
  ]);
  console.log(`[${fmt(performance.now() - t0)}] 4 variáveis x ${windTs2.length} steps (do cache)`);

  const totalEnd = performance.now();
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  Total: ${fmt(totalEnd - totalStart)}`);
  console.log(`══════════════════════════════════════════════════════`);

  await rm(cacheDir, { recursive: true, force: true });
}

main().catch(console.error);
