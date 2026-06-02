# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-06-02

### Added

- **`maxInFlightBytes` read option** (default 256 MiB). Reads now bound the *decoded bytes held in flight* rather than only the chunk count, so peak memory stays predictable regardless of `concurrency` or chunk size. On arrays with large (e.g. compressed WRF) chunks the effective decode parallelism drops automatically. Exposed as `DEFAULT_MAX_IN_FLIGHT_BYTES`.
- **`largeReadWarningBytes` read option** (default 512 MiB). A `get()` whose materialized output would exceed this threshold logs a one-line `console.warn`. Set to `Infinity` to silence. Exposed as `DEFAULT_LARGE_READ_WARNING_BYTES`.

### Changed

- **Chunks are now streamed into the output as they decode instead of being accumulated.** Previously every selected chunk was decoded and retained until the whole selection finished, so a point-slice over a full axis of a compressed array held *all* covered chunks at once — the root of an observed OOM. Decoded buffers are now copied into the output on arrival and released immediately, bounding the live footprint to roughly `maxInFlightBytes` plus the output. Read results are unchanged.
- **`ZarrGroup.readMultiple` now bounds the *combined* in-flight memory of all arrays through one shared `maxInFlightBytes` budget**, instead of each array read allocating an independent ceiling. This caps the `arrays × concurrency × chunkSize` blow-up when reading many compressed arrays at once. (The previous "shared concurrency pool" was not in fact shared — each array ran its own pool.)

### Notes

- Compressed point-slices still pay full-chunk cost: selecting one `(lat, lon)` from a `blosc`/`gzip`/`zlib` array decodes the entire chunk covering that point (partial decode is not possible for these codecs). `maxInFlightBytes` bounds how many such decodes run concurrently; a `MemoryCache` avoids re-decoding across repeated reads.
- `DEFAULT_CONCURRENCY` remains 50 — the byte budget, not a lower count, is what makes the large-chunk case safe by default.

## [0.2.0] — 2026-05-16

### Added

- Dual ESM/CJS package. `require('@i4sea/zarr-node')` now works in CommonJS consumers (e.g. NestJS services compiled to CJS), in addition to `import`. The package now ships a second build under `dist/cjs/` with a per-folder `package.json` declaring `type: commonjs`, and the root `exports` map gains `require`/`default` conditions.
- Interop smoke tests (`npm run test:cjs`, `npm run test:esm`) gating release via `prepublishOnly`. Both exercise the Blosc lazy-load path end-to-end so the `ERR_REQUIRE_ESM` regression cannot ship undetected.

### Changed

- **Breaking**: `codecRegistry.get(config)` is now async and returns `Promise<Codec>`. Codec factories may return either `Codec` or `Promise<Codec>`. Built-in `zlib`/`gzip` codecs are unchanged in behavior; Blosc is now lazy-loaded on first use via dynamic `import()`. This avoids `ERR_REQUIRE_ESM` against the ESM-only `numcodecs` package when zarr-node is loaded from a CommonJS consumer.
- **Breaking**: `ZarrArray` constructor takes an additional `codec: Codec | null` parameter. The `open()` / `openArray()` / `openGroup()` / `ZarrGroup.getArray()` helpers resolve the codec for you, so the change is transparent to typical consumers — only code that constructs `ZarrArray` directly is affected.

## [0.1.0]

### Added

- Zarr v2 array reader with `FileSystemStore`, `HTTPStore`, and `S3Store` backends
- Consolidated metadata (`.zmetadata`) support for fast group discovery
- Disk chunk cache with thundering herd protection and LRU eviction
- Built-in Blosc codec (lz4, zstd, zlib, snappy) with zero-config auto-registration
- In-memory LRU chunk cache for sub-millisecond repeated reads
- Multi-array reads with shared concurrency pool (`readMultiple`)
- Byte-range requests for partial chunk fetches on all store backends
- Reference filesystem (kerchunk) support via `ReferenceStore`
- `Dataset` class with xarray-style label-based coordinate selection (`sel()`)
