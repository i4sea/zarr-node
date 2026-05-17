// CJS interop smoke. Runs under plain `node`, not vitest. Exits non-zero
// on any failure so it can gate CI and prepublishOnly. `require("../../")`
// resolves through the package's `main` field — which after the 0.2.0
// dual-build changes points at `./dist/cjs/index.js`. That's exactly the
// codepath a downstream CommonJS consumer will hit.
const pkg = require("../../");

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
  console.error("CJS interop FAILED. Missing exports:", missing);
  process.exit(1);
}

if (typeof pkg.openGroup !== "function") {
  console.error("openGroup is not a function");
  process.exit(1);
}
if (typeof pkg.codecRegistry?.has !== "function") {
  console.error("codecRegistry.has is not a function");
  process.exit(1);
}

// Exercise the Blosc lazy-load path end-to-end against a fixture. This
// catches the ERR_REQUIRE_ESM failure mode that motivated this release.
(async () => {
  const path = require("node:path");
  const fixture = path.resolve(
    __dirname,
    "..",
    "fixtures",
    "compressed_blosc",
  );
  const store = new pkg.FileSystemStore({ path: fixture });
  const arr = await pkg.openArray(store);
  const data = await arr.get();
  if (data.length !== 100 || Math.abs(data[42] - 42) > 1e-5) {
    console.error("CJS Blosc read FAILED. Got length", data.length, "data[42]=", data[42]);
    process.exit(1);
  }
  console.log(
    `CJS interop OK (${expected.length} exports present, Blosc decode verified)`,
  );
})().catch((err) => {
  console.error("CJS interop FAILED with exception:", err);
  process.exit(1);
});
