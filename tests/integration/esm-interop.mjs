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

console.log(
  `ESM interop OK (${expected.length} exports present, Blosc decode verified)`,
);
