# Research: Zarr v2 Reader

**Phase**: 0 (Outline & Research)
**Date**: 2026-04-03

## Zarr v2 Metadata Format

### Decision: Parse `.zarray`, `.zgroup`, `.zattrs` JSON files

**Rationale**: Zarr v2 uses three JSON files per node:
- `.zarray`: Array metadata (shape, chunks, dtype, compressor, fill_value, order, dimension_separator, filters)
- `.zgroup`: Group marker (`{"zarr_format": 2}`)
- `.zattrs`: User-defined attributes (arbitrary JSON)

**Alternatives considered**: None — this is the Zarr v2 spec. No alternatives exist.

**Key details**:
- `dtype` field uses NumPy dtype strings: `<f4` (little-endian float32), `>i2` (big-endian int16), `|u1` (byte-order agnostic uint8)
- `compressor` is an object with `id` field (e.g., `{"id": "zlib", "level": 1}`) or `null` for raw
- `fill_value` can be a number, `null`, `"NaN"`, `"Infinity"`, `"-Infinity"`, or a base64-encoded string for complex types
- `order` is `"C"` (row-major) or `"F"` (column-major)
- `dimension_separator` is `"."` (default) or `"/"`
- `filters` is an array of filter objects or `null` (v1 feature: filters are applied before compression)

## Dtype Mapping

### Decision: Support standard numeric dtypes with endianness byte-swap

**Rationale**: Node.js/V8 is little-endian. Most Zarr v2 data is little-endian (x86).
Big-endian data exists from non-x86 systems or explicit choice.

**Mapping table**:

| Zarr dtype | TypedArray | Byte size |
|------------|------------|-----------|
| `\|b1`, `\|i1` | Int8Array | 1 |
| `\|u1` | Uint8Array | 1 |
| `<i2`, `>i2` | Int16Array | 2 |
| `<u2`, `>u2` | Uint16Array | 2 |
| `<i4`, `>i4` | Int32Array | 4 |
| `<u4`, `>u4` | Uint32Array | 4 |
| `<f4`, `>f4` | Float32Array | 4 |
| `<f8`, `>f8` | Float64Array | 8 |

**Byte-swapping approach**: Use `DataView` to read values with explicit
endianness and write into TypedArray. For little-endian data, zero-copy
via `Buffer` backed TypedArray. For big-endian, iterate with DataView.

**Alternatives considered**:
- Buffer.swap16/swap32/swap64: In-place swap, fast but mutates input buffer. Acceptable since chunks are ephemeral.
- Manual byte reversal: Too slow for large arrays.

**Decision**: Use `Buffer.swap16/swap32/swap64` for big-endian byte-swap (in-place, fast, zero-allocation). This is safe because chunk buffers are owned by the library and not shared.

## Compression Codecs

### Decision: Ship raw + gzip (zlib) built-in; extensible registry for others

**Rationale**: `node:zlib` provides gzip/zlib/deflate natively with zero
dependencies. Zarr v2 uses compressor IDs:
- `null` → raw (no compression)
- `"zlib"` → zlib/deflate (NOT gzip framing; uses `zlib.inflate`)
- `"gzip"` → gzip framing (uses `zlib.gunzip`)

**Important**: Zarr Python's default "zlib" compressor uses raw deflate
with zlib framing, not gzip. The `node:zlib.inflate` (not `gunzip`) is
the correct decompressor.

**Alternatives considered**:
- pako/fflate (pure JS): Unnecessary — Node.js built-in is faster and zero-dep
- Blosc, Zstd: Deferred to follow-up. Blosc requires native bindings (`blosc` npm). Zstd available via `fzstd` (pure JS) or native bindings.

## Chunk Key Resolution

### Decision: Dot-separated default, "/" separator via dimension_separator

**Rationale**: Zarr v2 chunk keys are constructed from chunk indices:
- Default: `0.0.0` (dot-separated)
- With `dimension_separator: "/"`: `0/0/0` (path-separated)

Key format: `{array_path}/{chunk_key}`

For a 3D array at path `/data/temperature` with chunk index [2, 3, 1]:
- Default: `/data/temperature/2.3.1`
- Path-separated: `/data/temperature/2/3/1`

## Chunk Assembly (C-order vs F-order)

### Decision: Support both C and F order in chunk-to-array assembly

**Rationale**: C-order (row-major) stores the last index varying fastest.
F-order (column-major) stores the first index varying fastest. This
affects how multi-dimensional chunk data maps to the linear TypedArray.

**Implementation approach**:
- C-order: Direct copy — chunk bytes are already in row-major layout matching TypedArray's logical order
- F-order: Transpose during assembly — read elements from chunk buffer using F-order stride and write to output in C-order

For slice reads, stride calculations differ:
- C-order stride for dim[i] = product of shape[i+1..n]
- F-order stride for dim[i] = product of shape[0..i-1]

## Store Interface

### Decision: Minimal 3-method async interface

```typescript
interface Store {
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
}
```

**Rationale**: Aligned with Constitution Principle I (Read-Only by Design).
`get` returns `null` for missing keys (Zarr spec: missing chunk = fill_value).
`list` returns `AsyncIterable` for lazy enumeration of large directories.

**Alternatives considered**:
- `getRange(key, offset, length)`: Byte-range reads. Useful for sharding (v3) but not needed for v2. Deferred per YAGNI.
- Sync interface: Rejected — all I/O should be async for server workloads.

## HTTP Store

### Decision: Native fetch with timeout, custom headers, retry

**Rationale**: Node.js 22+ has stable native `fetch` (undici-backed).
No need for external HTTP library.

**Key details**:
- Timeout via `AbortSignal.timeout(ms)`
- Custom headers for auth (Bearer tokens, API keys)
- Retry: 3 attempts, exponential backoff (100ms, 200ms, 400ms) on 429, 503, network errors
- `get(key)`: `GET {baseUrl}/{key}`, return body as Uint8Array or null on 404
- `has(key)`: `HEAD {baseUrl}/{key}`, return true on 200
- `list(prefix)`: Not natively supported by HTTP; throw UnsupportedOperationError (HTTP stores are typically used for direct array access, not directory listing)

**Alternative considered**: `list` via HTML directory index parsing — fragile, server-dependent. Rejected.

## S3 Store

### Decision: @aws-sdk/client-s3 as optional peer dependency

**Rationale**: Native S3 API provides streaming, IAM auth, and proper
error codes (vs HTTP fetch to S3 endpoints which lacks SigV4 auth for
private buckets).

**Key details**:
- `GetObjectCommand` for `get(key)` — stream body to Buffer
- `HeadObjectCommand` for `has(key)`
- `ListObjectsV2Command` for `list(prefix)` — paginated async iteration
- Endpoint configuration for MinIO/LocalStack compatibility
- Credential chain: env vars → shared credentials file → IAM role (SDK default)
- Retry handled by SDK's built-in retry strategy + our 3x retry on top

**Import strategy**: Dynamic `import('@aws-sdk/client-s3')` to fail
gracefully if peer dep not installed. Clear error message guiding
installation.

## Concurrency Control

### Decision: Promise pool with configurable limit (default 10)

**Rationale**: When reading multi-chunk arrays, fetching all chunks
simultaneously can exhaust file descriptors, memory, or trigger
rate limits on remote stores.

**Implementation**: Simple promise pool pattern — maintain a set of
in-flight promises, await one before starting next when at limit.
No external dependency needed.

## Test Fixture Generation

### Decision: Python script using zarr-python to generate fixtures

**Rationale**: The Python zarr library is the reference implementation.
Generating fixtures with it ensures our library reads real-world data
correctly.

**Fixtures needed**:
1. `simple_1d/`: 1D float32 array, 10 elements, no compression
2. `chunked_2d/`: 2D int32 array [100, 200], chunks [10, 20], no compression
3. `compressed_gzip/`: 2D float64 array with zlib compression
4. `nested_groups/`: Root group → sub-groups → arrays, with .zattrs
5. `big_endian/`: Big-endian float64 1D array
6. `f_order/`: Fortran-order 2D float32 array

Each fixture includes a `expected.json` with the array data as nested
lists for verification.
