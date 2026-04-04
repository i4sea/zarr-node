# Data Model: Zarr v2 Reader

**Phase**: 1 (Design & Contracts)
**Date**: 2026-04-03

## Entities

### Store

Abstract storage backend providing key-value read access to Zarr data.

**Operations**:
- `get(key: string)` → `Promise<Uint8Array | null>` — Retrieve raw bytes by key. Returns null if key does not exist.
- `has(key: string)` → `Promise<boolean>` — Check if key exists.
- `list(prefix: string)` → `AsyncIterable<string>` — Enumerate keys under a prefix.

**Implementations**: FileSystemStore, HTTPStore, S3Store

**Relationships**: Used by ZarrArray and ZarrGroup to fetch metadata and chunks.

### ZarrArray

Represents an opened Zarr v2 array. Immutable after construction.

**Attributes**:
- `shape`: number[] — Array dimensions (e.g., [100, 200])
- `chunks`: number[] — Chunk dimensions (e.g., [10, 20])
- `dtype`: string — NumPy dtype string (e.g., "<f4")
- `compressor`: CompressorConfig | null — Compressor configuration
- `fillValue`: number | null — Default value for missing chunks
- `order`: "C" | "F" — Memory layout order
- `dimensionSeparator`: "." | "/" — Chunk key separator
- `filters`: FilterConfig[] | null — Pre-compression filters
- `attrs`: Record<string, unknown> — User attributes from .zattrs

**Operations**:
- `get(selection?)` → `Promise<TypedArray>` — Read data, optionally sliced
- `getRaw(selection?)` → `Promise<Uint8Array>` — Read raw bytes without dtype interpretation

**Relationships**: Belongs to a Store. Contains metadata parsed from .zarray and .zattrs.

### ZarrGroup

Represents an opened Zarr v2 group node.

**Attributes**:
- `attrs`: Record<string, unknown> — User attributes from .zattrs

**Operations**:
- `getArray(name: string)` → `Promise<ZarrArray>` — Open a child array
- `getGroup(name: string)` → `Promise<ZarrGroup>` — Open a child group
- `arrays()` → `AsyncIterable<[string, ZarrArray]>` — Iterate child arrays
- `groups()` → `AsyncIterable<[string, ZarrGroup]>` — Iterate child groups
- `contains(name: string)` → `Promise<boolean>` — Check if child exists

**Relationships**: Belongs to a Store. Children can be ZarrArrays or ZarrGroups.

### Codec

Compression/decompression unit for chunk data.

**Attributes**:
- `id`: string — Compressor identifier (e.g., "zlib", "gzip")

**Operations**:
- `decode(data: Uint8Array)` → `Promise<Uint8Array>` — Decompress chunk bytes

**Implementations**: RawCodec (no-op), GzipCodec (node:zlib inflate)

**Relationships**: Created by CodecRegistry based on .zarray compressor config.

### CodecRegistry

Central registry mapping compressor IDs to Codec factories.

**Attributes**:
- Internal map: `Map<string, (config: CompressorConfig) => Codec>`

**Operations**:
- `register(id: string, factory)` — Register a codec factory
- `get(config: CompressorConfig)` → `Codec` — Create codec from config
- `has(id: string)` → `boolean` — Check if codec is registered

**State**: Singleton. Pre-populated with built-in codecs (raw, zlib).

### Metadata Types

**CompressorConfig**:
- `id`: string — Compressor identifier
- Additional compressor-specific fields (e.g., `level` for zlib)

**ZarrayMeta** (parsed from .zarray):
- `zarr_format`: 2
- `shape`: number[]
- `chunks`: number[]
- `dtype`: string
- `compressor`: CompressorConfig | null
- `fill_value`: number | string | null
- `order`: "C" | "F"
- `dimension_separator`: "." | "/"
- `filters`: FilterConfig[] | null

**ZgroupMeta** (parsed from .zgroup):
- `zarr_format`: 2

**Zattrs** (parsed from .zattrs):
- `Record<string, unknown>`

## Entity Relationships

```
Store (1) ──reads──> (N) ZarrGroup
Store (1) ──reads──> (N) ZarrArray
ZarrGroup (1) ──contains──> (N) ZarrArray
ZarrGroup (1) ──contains──> (N) ZarrGroup
ZarrArray (1) ──uses──> (1) Codec
CodecRegistry (1) ──creates──> (N) Codec
```

## Validation Rules

- `shape` and `chunks` MUST have the same length (number of dimensions).
- Each `chunks[i]` MUST be > 0.
- `dtype` MUST be a recognized NumPy dtype string.
- `zarr_format` MUST be 2.
- `order` MUST be "C" or "F".
- `dimension_separator` MUST be "." or "/" (default ".").
- `compressor.id` MUST be registered in CodecRegistry or be null.
