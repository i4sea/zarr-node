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
- **Built-in Blosc codec** (lz4, zstd, zlib, snappy) — zero configuration
- **Byte-range requests** for partial chunk fetches on uncompressed data
- **Multi-array reads** with shared concurrency pool
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

const store = new FileSystemStore("/path/to/zarr");
const array = await open(store);

// Read all data
const data = await array.read();

// Read a slice (first 10 rows, columns 5-15)
const slice = await array.read([
  { start: 0, stop: 10 },
  { start: 5, stop: 15 },
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

const store = new HTTPStore("https://example.com/data.zarr");
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

### Groups and multi-array reads

```typescript
import { FileSystemStore, openGroup } from "@i4sea/zarr-node";

const store = new FileSystemStore("/path/to/zarr-group");
const group = await openGroup(store);

// List arrays
const arrays = await group.arrays();

// Read multiple arrays at once (shared concurrency pool)
const results = await group.readMultiple(
  ["temperature", "humidity", "wind"],
  [{ start: 0, stop: 10 }],
);
```

### Caching

```typescript
import { FileSystemStore, CachedStore, MemoryCache, open } from "@i4sea/zarr-node";

// Disk cache (persists across restarts)
const inner = new FileSystemStore("/path/to/zarr");
const store = new CachedStore(inner, {
  cacheDir: "/tmp/zarr-cache",
  maxSizeBytes: 500 * 1024 * 1024, // 500 MB limit
});

// In-memory cache (for hot data)
const memCache = new MemoryCache({ maxBytes: 100 * 1024 * 1024 }); // 100 MB
const array = await open(store);
const data = await array.read(null, { memoryCache: memCache });
```

### Reference filesystem (kerchunk)

```typescript
import { ReferenceStore, open } from "@i4sea/zarr-node";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("output.json", "utf-8"));
const store = new ReferenceStore({ spec: manifest });
const array = await open(store, "temperature");
const data = await array.read();
```

## Requirements

- Node.js >= 22
- ESM only (`"type": "module"`)

## API

### Top-level functions

| Function | Description |
| --- | --- |
| `open(store, path?)` | Open a Zarr array or group |
| `openArray(store, path?)` | Open a Zarr array (throws if not an array) |
| `openGroup(store, path?)` | Open a Zarr group (throws if not a group) |

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

### Data classes

| Class | Description |
| --- | --- |
| `ZarrArray` | Read chunked array data with slicing support |
| `ZarrGroup` | Traverse groups, list arrays, multi-array reads |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
