# zarr-node

[![CI](https://github.com/i4sea/zarr-node/actions/workflows/ci.yml/badge.svg)](https://github.com/i4sea/zarr-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Read-only Zarr v2 array reader for Node.js. Server-first, with FileSystem, HTTP, and S3 backends.

## Features

- **Zarr v2** chunked array reader with full dtype support
- **Three storage backends**: FileSystem, HTTP (with retry/timeout), S3
- **Consolidated metadata** (`.zmetadata`) for fast group discovery
- **Disk cache** with thundering herd protection and LRU eviction
- **In-memory LRU cache** for sub-millisecond repeated reads
- **Shared metadata cache** — pluggable `Cache` interface with in-memory and Redis adapters
- **Observability hooks** — per-instance callbacks for cache hits/misses, store fetches, retries, decodes, in-flight bytes, and missing chunks
- **Built-in Blosc codec** (lz4, zstd, zlib, snappy) — zero configuration
- **Byte-range requests** for partial chunk fetches on uncompressed data
- **Bounded memory** — reads cap decoded bytes in flight, not just chunk count
- **Multi-array reads** sharing one in-flight memory budget
- **Reference filesystem** (kerchunk) for reading HDF5/NetCDF without conversion

## Install

Published to GitHub Packages under the `@i4sea` scope. Add this to a `.npmrc` in your consumer project (or `~/.npmrc`):

```
@i4sea:registry=https://npm.pkg.github.com
```

Then install:

```bash
npm install @i4sea/zarr-node
```

For S3 support, install the peer dependency:

```bash
npm install @aws-sdk/client-s3
```

## Quick Start

### Read an array from the filesystem

```typescript
import { FileSystemStore, open } from "@i4sea/zarr-node";

const store = new FileSystemStore({ path: "/path/to/zarr" });
const array = await open(store);

// Read all data
const data = await array.read();

// Read a slice (first 10 rows, columns 5-15)
const slice = await array.read([
  [0, 10],
  [5, 15],
]);
```

### Integer dtypes (int64 / uint64)

Arrays with dtype `<i8`, `>i8`, `<u8`, or `>u8` are returned as `BigInt64Array`
or `BigUint64Array`. Their elements are `bigint`, not `number`. Coerce with
`Number(value)` when you need a plain number — this is safe for epoch-seconds
up to year 285K AD and for epoch-nanoseconds up to year 2262. Beyond those
ranges precision is lost.

```typescript
const timeArray = await group.getArray("time"); // dtype "<i8"
const data = await timeArray.read();              // BigInt64Array
const seconds = Number(data[0]);                  // bigint -> number
```

### Read from HTTP

```typescript
import { HTTPStore, open } from "@i4sea/zarr-node";

const store = new HTTPStore({ url: "https://example.com/data.zarr" });
const array = await open(store);
const data = await array.read();
```

### Read from S3

```typescript
import { S3Store, open } from "@i4sea/zarr-node";

const store = new S3Store({
  bucket: "my-bucket",
  prefix: "data.zarr",
  region: "us-east-1",
});
const array = await open(store);
const data = await array.read();
```

#### Connection pooling and prewarming

S3 reads are latency-bound: each chunk is one round trip. Two levers reduce that:

```typescript
const store = new S3Store({
  bucket: "my-bucket",
  prefix: "data.zarr",
  region: "us-east-1",
  maxSockets: 256, // keep-alive pool size (default 128). Set >= read concurrency.
  warmOnCreate: true, // open a TLS connection up front (or call store.prewarm())
});

await store.prewarm(); // optional explicit warm-up at pod startup
const data = await array.read(undefined, { concurrency: 200 });
```

`maxSockets` (default **128**, keep-alive on) caps how many chunk fetches run in
parallel — raise the read `concurrency` and keep `maxSockets >= concurrency` so a
many-chunk read finishes in one wave instead of several. **Run the reader in the
same AWS region as the bucket** — that, not the library, dominates latency.

### Groups and multi-array reads

```typescript
import { FileSystemStore, openGroup } from "@i4sea/zarr-node";

const store = new FileSystemStore({ path: "/path/to/zarr-group" });
const group = await openGroup(store);

// List arrays
const arrays = await group.arrays();

// Read multiple arrays at once (shared in-flight memory budget)
const results = await group.readMultiple(
  ["temperature", "humidity", "wind"],
  [[0, 10]],
);
```

### Bounding memory

Reads are bounded by a **decoded-bytes-in-flight budget**, not just a chunk
count. By default a single `get()` holds at most `maxInFlightBytes` (256 MiB) of
decoded chunk data at once and copies each chunk into the output as it arrives,
so peak memory stays predictable even on arrays with large chunks.

```typescript
// Point over a full axis on a compressed array — bound the decode footprint
// explicitly (otherwise the 256 MiB default applies).
const series = await array.get([null, latIdx, lonIdx], {
  maxInFlightBytes: 64 * 1024 * 1024, // 64 MiB live at once
  concurrency: 8, // network-request cap; the byte budget binds first on big chunks
});
```

> **Compressed point-slices pay full-chunk cost.** Selecting a single
> `(lat, lon)` from a `blosc`/`gzip`/`zlib` array still downloads and
> decompresses the *entire* chunk covering that point — partial decode isn't
> possible for these codecs. The cost is per chunk, not per element, so a wide
> selection over a chunked axis decodes one full chunk per step. `maxInFlightBytes`
> bounds how many of those decode concurrently; a `MemoryCache` avoids
> re-decoding chunks across repeated reads.

`readMultiple` shares **one** budget across all arrays, so reading many
compressed arrays at once stays bounded by a single ceiling rather than
`arrays × concurrency × chunkSize`.

Any read whose materialized output would exceed `largeReadWarningBytes`
(512 MiB) — whether a full-array `get()` or a large slice — logs a one-line
`console.warn`. Set it to `Infinity` to silence.

#### Sizing `maxInFlightBytes` from a RAM limit

Peak bytes a single in-flight chunk holds while being processed:

```
peakPerChunk = chunkBytes × (decodeFactor + byteSwapFactor)

  decodeFactor   = 2 if the array is compressed (compressed input + decoded
                   output coexist during decode), else 1
  byteSwapFactor = 1 if the dtype is big-endian (an extra copy is made before
                   the in-place byte swap), else 0
```

So a compressed, big-endian array transiently holds up to 3× its chunk size
per in-flight chunk; a compressed little-endian array holds 2×.

To derive a safe `maxInFlightBytes` from a pod's RAM limit, subtract the
process baseline and keep a safety margin:

```
maxInFlightBytes ≈ (podRamLimit − baselineHeap) × safetyFraction
```

For example, a pod with a 2 GiB memory limit, ~300 MiB of baseline heap and
runtime, and a 0.5 safety fraction supports `maxInFlightBytes ≈ 850 MiB` —
remembering the read *output* buffer is allocated on top of the in-flight
budget. `maxInFlightBytes` caps the combined decoded footprint regardless of
`concurrency` or chunk size, so it is the binding knob for memory safety.

### Caching

```typescript
import { FileSystemStore, CachedStore, MemoryCache, open } from "@i4sea/zarr-node";

// Disk cache (persists across restarts)
const inner = new FileSystemStore({ path: "/path/to/zarr" });
const store = new CachedStore(inner, {
  cacheDir: "/tmp/zarr-cache",
  storeId: "my-dataset", // stable cache identity across restarts
  maxSizeBytes: 500 * 1024 * 1024, // 500 MB limit
});

// In-memory cache (for hot data)
const memCache = new MemoryCache({ maxBytes: 100 * 1024 * 1024 }); // 100 MB
const array = await open(store);
const data = await array.read(undefined, { memoryCache: memCache });
```

#### Eviction and cache sizing

After each write, `CachedStore` evicts the oldest entries by file modification
time (least-recently-*written* — reads do not refresh an entry's eviction
priority) so that store's cache stays at or below `maxSizeBytes`. A
non-positive or non-finite `maxSizeBytes` is rejected at construction.

The limit is scoped **per store**, not per directory: each `CachedStore` keeps
its entries under `cacheDir/<hash(storeId)>` and evicts only there. Several
stores sharing one `cacheDir` can therefore use up to N × `maxSizeBytes` in
total. For stores without a derivable identity (anything other than S3/HTTP,
e.g. `FileSystemStore`), pass an explicit `storeId` — otherwise a new cache
subdirectory is created on every process start and stale ones are never
evicted.

**Unbounded-growth risk**: `maxSizeBytes` is optional. Without it, nothing is
ever evicted — every chunk fetched from the inner store is written to
`cacheDir` and stays there, so sustained reads over a large dataset will
eventually fill the disk (or the pod's ephemeral-storage limit, evicting the
pod). Constructing a `CachedStore` without `maxSizeBytes` logs a
`console.warn` for this reason; only omit it when the working set is known to
fit on disk.

**Sizing guidance**:

- Size for the *hot* working set, not the whole dataset — e.g. the chunks
  covering the time window and variables your queries actually touch.
- Leave headroom on the volume: eviction runs after each chunk is written and
  reads fetch chunks concurrently (default concurrency 50), so usage can
  transiently exceed `maxSizeBytes` by roughly the read concurrency × chunk
  size before settling back under the limit.
- In Kubernetes, keep `maxSizeBytes` (plus the headroom above) comfortably
  below the container's `ephemeral-storage` limit (or mount a dedicated volume
  for `cacheDir`).
- Too small a limit causes thrashing (chunks are evicted and re-fetched
  repeatedly); if the hit rate is low, grow the limit or narrow the access
  pattern.

### Shared metadata cache

`open`/`openGroup`/`openArray` accept a `metadataCache` implementing the async
`Cache` interface. Metadata reads (`.zmetadata`, `.zarray`, `.zgroup`,
`.zattrs`) are served read-through: first open fetches from the store and
caches; later opens — in the same process or, with Redis, on any pod — skip
the store entirely. Entries are cached without TTL (datasets are immutable
per path). A cache error or unavailable backend falls back to the store, so
reads never fail because of the cache.

In-process:

```typescript
import { InMemoryCache, open } from "@i4sea/zarr-node";

const metadataCache = new InMemoryCache({ maxBytes: 64 * 1024 * 1024 });
const group = await open(store, "", { metadataCache });
```

Shared across pods via Redis (requires the optional `ioredis` peer
dependency — `npm install ioredis`):

```typescript
import { open } from "@i4sea/zarr-node";
import { RedisCache } from "@i4sea/zarr-node/redis";
import Redis from "ioredis";

const metadataCache = new RedisCache(new Redis(process.env.REDIS_URL));
const group = await open(store, "", { metadataCache });
```

`RedisCache` also accepts a connection URL directly
(`new RedisCache("redis://...")`, with optional ioredis options as a second
argument); the client is then created lazily on first use. Passing a
pre-configured client is preferred — with a bare URL, ioredis defaults apply
and commands issued while Redis is unreachable can stall before the store
fallback kicks in.

Cache keys are scoped as `${storeId}:${metadataKey}`. The store identity is
derived automatically for `S3Store` and `HTTPStore`; for any other store you
must pass an explicit `storeId`, otherwise `open` throws immediately
(preventing silent per-pod key divergence):

```typescript
await open(customStore, "", { metadataCache, storeId: "my-dataset-v1" });
```

### Observability hooks

Every layer accepts an optional per-instance `observability` object — no
global registry. The same object can be passed to multiple layers; each layer
fires only the events it owns:

```typescript
import { S3Store, CachedStore, open } from "@i4sea/zarr-node";

const observability = {
  onCacheHit: ({ tier, key }) => metrics.inc(`cache.hit.${tier}`), // "memory" | "disk" | "shared"
  onCacheMiss: ({ tier, key }) => metrics.inc(`cache.miss.${tier}`),
  onStoreFetch: ({ key, bytes, latencyMs }) => metrics.observe("store.fetch_ms", latencyMs),
  onRetry: ({ attempt, status, error }) => logger.warn(`retry ${attempt} status=${status}`),
  onChunkDecoded: ({ bytes, codec, decodeMs }) => metrics.observe(`decode.${codec}`, decodeMs),
  onInFlightBytes: (current) => metrics.gauge("inflight_bytes", current),
  onMissingChunk: ({ key }) => logger.error(`missing chunk ${key}`),
};

// Store layer: onStoreFetch, onRetry
const store = new S3Store({ bucket, region, observability });
// Disk-cache layer: onCacheHit/onCacheMiss (tier "disk")
const cached = new CachedStore(store, { cacheDir, maxSizeBytes, observability });
// Open path: onCacheHit/onCacheMiss (tier "shared", with metadataCache)
const group = await open(cached, "", { metadataCache, observability });
// Read path: memory-tier hit/miss, onChunkDecoded, onInFlightBytes, onMissingChunk
const data = await array.get(selection, { observability });
```

A throwing (or rejecting) handler is swallowed and never breaks a read. When
no hooks are registered there is zero overhead — payload objects are not even
allocated.

### Offloading decompression (worker threads)

Blosc decode is synchronous CPU work (it runs on WASM), so a large chunk blocks
the event loop for the whole decode — degrading the latency of *every* other
request in a shared API pod. `gzip`/`zlib` already run on the libuv threadpool
and are unaffected.

Opt in by passing a `DecodePool` via `decodeWorkers`. Chunks whose compressor is
offloadable (currently Blosc) and whose compressed size is at least `minBytes`
are decoded on a worker thread; everything else decodes inline as before. Create
one pool per process, reuse it across reads, and call `terminate()` on shutdown
(idle workers keep the process alive).

```typescript
import { DecodePool, open } from "@i4sea/zarr-node";

const decodeWorkers = new DecodePool({
  poolSize: 4,          // default: availableParallelism() - 1
  minBytes: 256 * 1024, // skip offload below this compressed size (IPC isn't worth it)
});

const array = await open(store, "wind_vel");
const data = await array.get(selection, { decodeWorkers });
// ... on shutdown:
await decodeWorkers.terminate();
```

The threshold is on the *compressed* size (known before decode). Use
`onChunkDecoded` (above) to measure `decodeMs` with and without the pool and
calibrate `minBytes` for your datasets; `examples/benchmark-decode-workers.ts`
runs that A/B and also reports event-loop lag.

### Reference filesystem (kerchunk)

```typescript
import { ReferenceStore, open } from "@i4sea/zarr-node";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("output.json", "utf-8"));
const store = new ReferenceStore({ spec: manifest });
const array = await open(store, "temperature");
const data = await array.read();
```

### Spatial lookups (GridIndex)

`@i4sea/zarr-node/spatial` resolves a (lat, lon) to the nearest grid cell `(i, j)`
on a 2D curvilinear grid (e.g. a WRF domain). The grid is static per domain, so it
is loaded once and queried many times — each query is pure CPU.

```typescript
import { openGroup } from "@i4sea/zarr-node";
import { GridIndex } from "@i4sea/zarr-node/spatial";

const group = await openGroup(store);
const grid = await GridIndex.fromGroup(group); // loads lat/lon once
const { i, j, distanceKm } = grid.nearest(-25.5, -44.5);
const series = await (await group.getArray("wind_vel")).get([null, [i, i + 1], [j, j + 1]]);
```

For ephemeral pods, persist the grid in a shared `Cache` (Redis) so only the first
pod pays the coordinate fetch — restarts and new pods rehydrate from the cache:

```typescript
import { RedisCache } from "@i4sea/zarr-node/redis";

const cache = new RedisCache(process.env.REDIS_URL!);
// L1 (process) → L2 (Redis) → L3 (store). The key is derived per *domain*
// (source_model/experiment/grid_id + shape), so every run of the same grid shares it.
const grid = await GridIndex.loadCached(group, { cache });
```

Pass an explicit `gridKey` to control the cache key, or `verifyGrid: true` to fold a
corner sample of the coordinates into it (+2 cheap reads) when the dataset attrs
can't be trusted.

## Requirements

- Node.js >= 22
- ESM only (`"type": "module"`)

## API

### Top-level functions

| Function | Description |
| --- | --- |
| `open(store, path?, options?)` | Open a Zarr array or group |
| `openArray(store, path?, options?)` | Open a Zarr array (throws if not an array) |
| `openGroup(store, path?, options?)` | Open a Zarr group (throws if not a group) |

All three accept `OpenOptions { metadataCache?, storeId?, observability? }`.

### Store backends

| Class | Description |
| --- | --- |
| `FileSystemStore` | Local filesystem |
| `HTTPStore` | HTTP/HTTPS with retry and timeout |
| `S3Store` | AWS S3 (requires `@aws-sdk/client-s3`) |
| `CachedStore` | Wraps any store with disk caching |
| `ReferenceStore` | Kerchunk JSON manifest |

### Caching

| Class | Description |
| --- | --- |
| `CachedStore` | Disk cache with LRU eviction and thundering herd protection |
| `MemoryCache` | In-memory LRU cache for decoded chunks |
| `InMemoryCache` | In-process `Cache` adapter for the metadata cache |
| `RedisCache` | Redis-backed `Cache` adapter (`@i4sea/zarr-node/redis`, requires `ioredis`) |

### Data classes

| Class | Description |
| --- | --- |
| `ZarrArray` | Read chunked array data with slicing support |
| `ZarrGroup` | Traverse groups, list arrays, multi-array reads |

### Spatial

| Class | Description |
| --- | --- |
| `GridIndex` | Nearest (lat, lon) → (i, j) on a 2D grid, with optional Redis-backed grid cache (`@i4sea/zarr-node/spatial`) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
