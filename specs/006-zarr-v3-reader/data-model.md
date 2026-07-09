# Phase 1 Data Model: Zarr v3 Reader

**Feature**: 006-zarr-v3-reader | **Date**: 2026-07-09

Entities are the in-memory representations the reader resolves from store bytes. Field types are
descriptive (TypeScript-flavored) but not final signatures. The design goal: v2 and v3 both resolve
to the **neutral** entities so the read path is shared.

---

## ResolvedArrayMeta (version-neutral)

The single description of an array node consumed by `ZarrArray`, produced by both the v2 and v3
parsers.

| Field | Type | Notes |
|-------|------|-------|
| `zarrFormat` | `2 \| 3` | Which format produced this (diagnostics / consolidated lookup) |
| `shape` | `number[]` | Array shape |
| `chunkShape` | `number[]` | Regular chunk grid cell shape |
| `dtype` | `ResolvedDtype` | Resolved TypedArray ctor + byte size + byte order (see below) |
| `codecPipeline` | `CodecPipeline` | Ordered decode chain (see contracts) |
| `fillValue` | `number \| bigint \| boolean \| null` | Interpreted per dtype (incl. `NaN`/`±Inf`) |
| `order` | `"C" \| "F"` | Memory order. v2: from `.zarray` `order`. **v3: always `"C"`** — v3 has no `order` field; any axis permutation is expressed solely by the `transpose` codec in the pipeline. The v3 parser MUST NOT also set `order` from a transpose (double-permutation bug); the pipeline owns it. |
| `chunkKey` | `ChunkKeyStrategy` | How a chunk coord → store key (see below) |
| `attrs` | `Record<string, unknown>` | User attributes (`.zattrs` for v2; `attributes` in `zarr.json` for v3) |

**Validation rules**:
- `shape.length === chunkShape.length` (rank match) → else `MetadataError`.
- `dtype` must resolve to a supported type (FR-004) → else `MetadataError` ("unsupported data type").
- `codecPipeline` must contain exactly one array→bytes codec (FR-006) → else `MetadataError`.
- `fillValue` must be coercible to the resolved dtype (byte-form allowed for types requiring it, FR-011).

## ResolvedGroupMeta (version-neutral)

| Field | Type | Notes |
|-------|------|-------|
| `zarrFormat` | `2 \| 3` | Format that produced this |
| `attrs` | `Record<string, unknown>` | User attributes |

## ResolvedDtype

| Field | Type | Notes |
|-------|------|-------|
| `ctor` | `TypedArrayConstructor` | e.g. `Float32Array`, `BigInt64Array` |
| `byteSize` | `number` | Element size in bytes (stored size; `float16` = 2) |
| `byteOrder` | `"little" \| "big" \| "none"` | v2: from typestr prefix; v3: from `bytes` codec `endian` |
| `widenHalfToFloat` | `boolean` | True for `float16` → decode into `Float32Array` |

## ChunkKeyStrategy

| Field | Type | Notes |
|-------|------|-------|
| `kind` | `"v2" \| "v3-default"` | Encoding family |
| `separator` | `"." \| "/"` | v2 default `.`; v3-default `/` |
| `prefix` | `string \| null` | v3-default uses `"c"`; v2 uses none |
| `basePath` | `string \| null` | Node path prefix (folded in from `array.ts`) |

- `key(coord)` → v2: `join(sep)`; v3-default: `prefix + sep + join(sep)`, all under `basePath`.

## Zarr3NodeDocument (parse-time only)

Raw parse of `zarr.json`, consumed by the v3 parser to produce the neutral types. Not held past parse.

| Field | Type | Notes |
|-------|------|-------|
| `zarr_format` | `3` | Rejected if not 3 (and not 2 via v2 path) → `MetadataError` |
| `node_type` | `"array" \| "group"` | Discriminator (FR-003) |
| `data_type` | `string` | v3 named type (FR-004) |
| `shape`, `chunk_grid`, `chunk_key_encoding` | see spec | Regular grid; default/`v2` key encoding |
| `codecs` | `Codec3Config[]` | Ordered chain (array→array / array→bytes / bytes→bytes) |
| `fill_value` | `number \| string \| bool \| bytes-form` | v3 fill (incl. `NaN`/`Infinity`/`-Infinity`) |
| `attributes` | `object` | User attributes |
| `consolidated_metadata?` | nested | Present at root when consolidated (FR-016) |

## CodecPipeline (see contracts/codec-pipeline.md)

Ordered, classified codec chain with reverse-order decode. Applies **every** stage (fixes v2
filters gap, FR-009).

## Shard & ShardIndex (see contracts/sharding.md)

- **ShardIndex**: array of `{ offset: bigint; nbytes: bigint }` per inner-chunk; reserved marker
  `offset === nbytes === 2^64-1` ⇒ empty inner-chunk (fill value).
- **Shard**: a single store object packing inner-chunks + the index. Inner-chunks located by the
  index; read by `getRange` (coalesced) or sliced from a whole-shard fetch.

---

## Relationships

```text
open(store, path)
   └─ layout.detect(store, path)         # zarr.json? → v3 ; .zarray/.zgroup? → v2
        ├─ v3 → parse zarr.json ─┐
        └─ v2 → parse .zarray  ──┼─► ResolvedArrayMeta / ResolvedGroupMeta   (neutral)
                                 │        │
                                 │        ├─ dtype → ResolvedDtype
                                 │        ├─ codecs → CodecPipeline ──► (sharding codec → ShardIndex)
                                 │        └─ chunk_key_encoding → ChunkKeyStrategy
                                 ▼        ▼
                        ZarrArray / ZarrGroup  (unchanged public surface)
                                 │
                                 ▼
                        loadChunks(store, pipeline, tasks, ctx)  # reuses caches / limiter / decode pool
```

## State / lifecycle

No mutable state introduced. All entities are resolved once at open (or cached via existing
metadata read-through / consolidated metadata) and are immutable for the array's lifetime, matching
the read-only constitution.
