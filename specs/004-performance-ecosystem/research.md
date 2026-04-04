# Research: Performance & Ecosystem Improvements

**Phase**: 0 (Outline & Research)
**Date**: 2026-04-04

## Blosc Auto-Registration

### Decision: Register at module load, user override takes precedence

**Rationale**: The `numcodecs` package is already a dependency. Blosc is
the most common compressor in real Zarr data. Auto-registering eliminates
boilerplate for every user.

**Key details**:
- Register "blosc" factory in `src/codec/codec.ts` at module import time
- Factory passes the full `CompressorConfig` to `Blosc.fromConfig()`,
  which handles cname, clevel, shuffle, blocksize from `.zarray` metadata
- If user has already registered a custom "blosc" codec, don't overwrite —
  check `has("blosc")` before registering
- Order: built-in registration runs at import; user code runs after import.
  So built-in registers first, user can override.

**Alternative**: Register only if `numcodecs` is importable (dynamic
import). Rejected — it's already a direct dependency, not optional.

## In-Memory LRU Cache Design

### Decision: Post-decompression cache in chunk loader pipeline

**Rationale**: The cache should sit between decompression and the caller,
caching decoded `Uint8Array` (not raw compressed bytes). This avoids
re-decompression on every access.

**Implementation approach**:
- `MemoryCache` class: `Map<string, Uint8Array>` with LRU ordering
- Use Map insertion order for LRU: on access, delete + re-insert key
- Max size by bytes: track `totalBytes`, evict oldest entries until under limit
- Keyed by store key (same key as DiskCache)

**Integration point**: Inside `loadChunks()` in `src/chunk/loader.ts`.
Before fetching from store, check memory cache. After fetching + decoding,
store in memory cache. This is per-ZarrArray, not global.

**Alternative**: Store-level wrapper (like CachedStore). Rejected because
the memory cache needs decoded bytes, not raw store bytes. The Store
interface only deals with raw bytes.

**Configuration**: Via `ReadOptions`:
```typescript
const data = await arr.get(null, { memoryCache: cache });
```
Or set on ZarrArray construction:
```typescript
const cache = new MemoryCache({ maxBytes: 100 * 1024 * 1024 }); // 100MB
```

## Disk Cache LRU Eviction

### Decision: Scan-on-write eviction using file mtime

**Rationale**: When `DiskCache.set()` is called and total size exceeds
`maxSizeBytes`, scan the cache directory for files, sort by mtime
(least recently accessed), and delete oldest until under the limit.

**Key details**:
- Only scan when a new file is written (not on every read)
- Track approximate total size to avoid scanning on every write
- Use `fs.readdir()` + `fs.stat()` to collect file sizes and mtimes
- Delete in order of oldest mtime first
- Approximate tracking: increment on write, scan when over threshold

**Alternative**: Maintain an index file. Rejected — adds complexity,
the filesystem IS the index via mtime.

## Byte-Range Requests

### Decision: Optional `getRange()` method on Store interface

**Rationale**: Add an optional method rather than changing `get()` to
preserve backward compatibility with existing custom stores.

**Interface extension**:
```typescript
interface Store {
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
  getRange?(key: string, offset: number, length: number): Promise<Uint8Array | null>;
}
```

**Implementations**:
- S3Store: `GetObjectCommand` with `Range: bytes=offset-end` header
- HTTPStore: `fetch()` with `Range: bytes=offset-end` header
- FileSystemStore: `fs.read()` with `position` and `length`
- CachedStore: delegate to inner store's getRange (no caching for ranges)
- ReferenceStore: uses getRange internally for byte-range fetches

**When to use byte-range**: Only for uncompressed chunks (`compressor: null`)
where the chunk loader knows the exact byte offsets for the requested slice.

## Reference Filesystem (Kerchunk)

### Decision: Implement kerchunk v1 JSON spec reader

**Rationale**: The kerchunk reference format is the standard for virtual
Zarr stores. Version 1 is stable and widely used.

**Reference spec format**:
```json
{
  "version": 1,
  "refs": {
    ".zgroup": "{\"zarr_format\":2}",
    ".zattrs": "{}",
    "var/.zarray": "{\"shape\":[100],\"dtype\":\"<f4\",...}",
    "var/0": ["s3://bucket/file.nc", 1024, 4096],
    "var/1": ["s3://bucket/file.nc", 5120, 4096]
  }
}
```

**Key types**:
- String value: inline data (JSON or base64)
- Array `[url, offset, length]`: byte-range reference to remote file
- Array `[url]`: whole-file reference (fetch entire URL)

**Implementation**:
- `ReferenceStore` implements `Store` interface
- On `get(key)`: look up in refs map
  - If string: return as Uint8Array (encode if needed)
  - If array: fetch byte range from URL via inner store or fetch
- Inner fetch uses the appropriate store (S3, HTTP, FS) based on URL scheme
- Cache resolved stores by URL prefix to avoid re-creating clients

## Dataset / Coordinate Lookup

### Decision: Lightweight Dataset class with CF convention auto-discovery

**Rationale**: xarray's power comes from dimension-aware operations.
We implement the core: label-based selection via coordinate lookup.

**Auto-discovery**: Read `_ARRAY_DIMENSIONS` attribute from each array.
Arrays sharing dimension names form the dataset. Coordinate arrays are
those whose name matches a dimension name (e.g., array "time" is a
coordinate for dimension "time").

**Selection**: `ds.sel({time: 0, lat: -25.5})`
1. For each named dimension in the selection:
   - Load the coordinate array (1D or 2D)
   - Find the nearest value (binary search for sorted 1D coords)
   - Map to index
2. Build a Slice from the resolved indices
3. Use `readMultiple()` to fetch all requested variables at that slice

**Nearest-neighbor**: For 1D sorted coordinates, use binary search.
For unsorted or 2D coordinates (like WRF lat/lon), linear scan for
minimum distance. Cache coordinate arrays in memory (they're small).

**Multi-Array Reads**: `readMultiple()` on ZarrGroup collects chunk
tasks from all requested arrays, runs them through a shared concurrency
pool (single `loadChunks` call with combined tasks), then splits results
back per-array.
