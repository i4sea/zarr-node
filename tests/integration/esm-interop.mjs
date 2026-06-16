// ESM interop smoke. Mirrors cjs-interop.cjs for the ESM build path.
// Loads from the built dist (not the package main), so we're testing
// the artifact that will ship.
import * as pkg from "../../dist/index.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const expected = [
  "ZarrArray",
  "ZarrGroup",
  "FileSystemStore",
  "HTTPStore",
  "S3Store",
  "CachedStore",
  "MemoryCache",
  "ReferenceStore",
  "open",
  "openArray",
  "openGroup",
  "codecRegistry",
  "DecodePool",
  "ZarrError",
  "MetadataError",
  "StoreError",
  "CodecError",
  "SliceError",
  "UnsupportedOperationError",
];

const missing = expected.filter((name) => pkg[name] === undefined);
if (missing.length) {
  console.error("ESM interop FAILED. Missing exports:", missing);
  process.exit(1);
}

const fixture = resolve(here, "..", "fixtures", "compressed_blosc");
const store = new pkg.FileSystemStore({ path: fixture });
const arr = await pkg.openArray(store);
const data = await arr.get();
if (data.length !== 100 || Math.abs(data[42] - 42) > 1e-5) {
  console.error("ESM Blosc read FAILED. Got length", data.length, "data[42]=", data[42]);
  process.exit(1);
}

// Worker-offloaded decode: spawn a real worker thread (minBytes:0 forces
// offload of the small fixture chunk) and verify the Blosc decode round-trips.
const pool = new pkg.DecodePool({ poolSize: 1, minBytes: 0 });
try {
  const arrW = await pkg.openArray(store);
  const dataW = await arrW.get(undefined, { decodeWorkers: pool });
  if (dataW.length !== 100 || Math.abs(dataW[42] - 42) > 1e-5) {
    console.error("ESM DecodePool read FAILED. Got length", dataW.length, "data[42]=", dataW[42]);
    process.exit(1);
  }
} finally {
  await pool.terminate();
}

console.log(
  `ESM interop OK (${expected.length} exports present, Blosc decode + worker offload verified)`,
);
