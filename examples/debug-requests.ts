import { S3Store, openGroup } from "../src/index.js";
import { CachedStore } from "../src/cache/cached-store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const s3 = new S3Store({ bucket: "my-zarr-bucket", prefix: "my-data.zarr", region: "us-east-1" });
let count = 0;
const counting = {
  async get(key: string) { count++; console.log(`  GET #${count}: ${key}`); return s3.get(key); },
  async has(key: string) { return s3.has(key); },
  async *list(prefix: string) { yield* s3.list(prefix); },
};

const cacheDir = join(tmpdir(), "zarr-debug-" + Date.now());
const cached = new CachedStore(counting, { cacheDir, storeId: "debug", maxSizeBytes: 1024 ** 3 });

count = 0;
const root = await openGroup(cached);
console.log(`\nAfter openGroup: ${count} GETs\n`);

const lat = await root.getArray("lat");
count = 0;
console.log("--- 4 concurrent lat corner reads ---");
await Promise.all([
  lat.get([[0, 1], [0, 1]]),
  lat.get([[0, 1], [601, 602]]),
  lat.get([[760, 761], [0, 1]]),
  lat.get([[760, 761], [601, 602]]),
]);
console.log(`\nLat corners: ${count} GETs (thundering herd — all hit chunk 0.0)\n`);

count = 0;
console.log("--- 4 sequential lat corner reads ---");
await lat.get([[0, 1], [0, 1]]);
await lat.get([[0, 1], [601, 602]]);
await lat.get([[760, 761], [0, 1]]);
await lat.get([[760, 761], [601, 602]]);
console.log(`\nLat corners sequential: ${count} GETs (first caches, rest hit cache)\n`);

await rm(cacheDir, { recursive: true, force: true });
