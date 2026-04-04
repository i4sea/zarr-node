import { S3Store, openGroup } from "../src/index.js";
import { CachedStore } from "../src/cache/cached-store.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const cacheDir = join(tmpdir(), `zarr-parallel-${Date.now()}`);
  const s3 = new S3Store({ bucket: "my-zarr-bucket", prefix: "my-data.zarr", region: "us-east-1" });
  const store = new CachedStore(s3, { cacheDir, storeId: "parallel-test" });

  const root = await openGroup(store);
  const lat = await root.getArray("lat");
  const lon = await root.getArray("lon");

  // Sequential: lat then lon
  let t0 = performance.now();
  await lat.get([[0, 1], [0, 1]]);
  await lon.get([[0, 1], [0, 1]]);
  console.log(`Sequencial (lat, depois lon):  ${fmt(performance.now() - t0)}`);

  // Clear cache for fair comparison
  await store.clearCache();

  // Parallel: lat AND lon at the same time
  t0 = performance.now();
  await Promise.all([
    lat.get([[0, 1], [0, 1]]),
    lon.get([[0, 1], [0, 1]]),
  ]);
  console.log(`Paralelo (lat + lon juntos):   ${fmt(performance.now() - t0)}`);

  await rm(cacheDir, { recursive: true, force: true });
}

main().catch(console.error);
