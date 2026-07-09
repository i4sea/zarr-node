# Phase 0 Research: Zarr v3 Reader

**Feature**: 006-zarr-v3-reader | **Date**: 2026-07-09

Resolves the unknowns in the plan's Technical Context and records the key design decisions that
shape Phase 1. Codebase facts referenced here come from the current `src/` tree.

---

## R1. Version-neutral resolved metadata

**Decision**: Introduce `ResolvedArrayMeta` / `ResolvedGroupMeta` neutral types in
`src/metadata/types.ts`. Both `parseZarray`/`parseZgroup` (v2) and the new v3 parser produce these;
`ZarrArray`/`ZarrGroup` consume them instead of `ZarrayMeta` directly.

**Rationale**: Today `ZarrayMeta` (with a literal `zarr_format: 2`) flows straight into `ZarrArray`
(`array.ts`), so there is no seam for a second format. A neutral type is the smallest change that
lets the entire downstream read path stay shared and unchanged (satisfies FR-002, FR-020, and
Principle VII — one seam, demanded by dual-format detection, not speculation). The neutral shape
carries: `shape`, `chunkShape`, `dtype` (resolved to a TypedArray ctor + byte size + byte order),
`codecPipeline`, `fillValue`, `order`, and chunk-key info.

**Alternatives considered**:
- *Discriminated union of `ZarrayMeta | Zarr3Meta` threaded everywhere* — rejected: forces v2/v3
  branching across `array.ts`, `group.ts`, `loader.ts`; larger blast radius, more regression risk.
- *Keep v2 shape and shoehorn v3 into it* — rejected: v3 byte order, codec chain, and chunk-key
  encoding do not fit the v2 fields; would leak `dtype`-prefix assumptions.

---

## R2. Format detection (v2 vs v3)

**Decision**: A `layout` abstraction (`src/metadata/layout.ts`) centralizes detection and key
construction. On open at a path, probe `zarr.json` first; if present, parse and branch on
`node_type` (`array`/`group`). If absent, fall back to the existing `.zarray`→`.zgroup` probe.
Precedence: **v3 (`zarr.json`) wins** when both markers exist at the same node (the documented,
deterministic rule for the degenerate case in the spec's Edge Cases).

**Rationale**: Detection is currently inlined in `open.ts` (`.zarray`/`.zgroup` probing) and
`group.ts` child access. Centralizing it is required to add v3 without duplicating the probe in
every call site, and gives one place to define precedence. `zarr.json`-first matches the v3 spec's
intent that a v3 store is self-describing.

**Alternatives considered**:
- *Probe `.zarray` first, `zarr.json` second* — rejected: a v3 store never has `.zarray`, so this
  only adds a wasted round-trip; v3-first is one probe for v3 data and two for v2 (same as today).
- *Require the caller to pass a version* — rejected: violates FR-001 (automatic detection) and the
  drop-in requirement.

---

## R3. Codec pipeline abstraction

**Decision**: Add `CodecPipeline` in `src/codec/pipeline.ts`: an ordered list classified into
`array→array`, exactly one `array→bytes`, and `bytes→bytes` stages, with `decode()` applying the
chain in **reverse**. `LoadChunksContext` in `src/chunk/loader.ts` carries a `CodecPipeline`
instead of a single `Codec | null`. v2 builds a pipeline of `[filters… , (implicit bytes), compressor]`;
v3 builds it directly from the ordered `codecs` array.

**Rationale**: The current `Codec` is a single decode-only compressor (`codec.ts`); v3 `codecs` is
an ordered array. A pipeline is the minimal generalization and, as a bonus, closes the existing
gap where v2 `filters` are parsed but never applied (FR-009) — the shared decode path now applies
every declared stage. Reuses `codecRegistry` for individual codec construction (Principle IV).

**Alternatives considered**:
- *Special-case v3 in the loader without a pipeline type* — rejected: duplicates ordering logic,
  leaves v2 `filters` gap unfixed, harder to unit-test.
- *Fold sharding into the pipeline as just another bytes→bytes codec* — partially: sharding IS
  registered as a codec, but it needs store + `getRange` + chunk geometry, so it is a special
  `array→bytes` codec that owns inner-chunk decoding (see R6), not a plain bytes→bytes stage.

---

## R4. v3 data types and byte order

**Decision**: Add a v3 `data_type` → `{ ctor, byteSize }` map in `src/dtype.ts` in parallel to the
numpy-typestr `DTYPE_MAP`. Byte order comes from the `bytes` codec's `endian` field, not a dtype
prefix. Per the clarification: `float16` decodes into `Float32Array` (widen on decode via a
half-to-float conversion), `int64`/`uint64` into `BigInt64Array`/`BigUint64Array`. Byte-swap reuses
the existing `byteSwap` helper, driven by the resolved byte order rather than `isBigEndian(dtype)`.

**Rationale**: v3 dtype names (`float32`, `int32`, …) carry no endianness; the `bytes` codec does.
`float16` has no native `Float16Array` guaranteed across Node 22/24, and the library's public
`dtype`→TypedArray contract (Principle II) is cleaner if `float16` surfaces as `Float32Array`.
`BigInt` arrays already exist in `DTYPE_MAP` for 64-bit ints, so the mapping is consistent.

**Alternatives considered**:
- *`float16` → `Uint16Array` raw* — rejected: leaks the half-float encoding to consumers; violates
  the "correct typed representation" acceptance scenario.
- *Reuse the numpy-typestr map by synthesizing a typestr from name+endian* — rejected: brittle
  string synthesis; a direct name map is clearer and testable.

---

## R5. Chunk key encoding

**Decision**: Extend `src/chunk/indexing.ts` `chunkKey` to accept a chunk-key strategy: the v3
**default** encoding (`c` prefix + configurable separator, default `/`, e.g. `c/0/1`) and the v3
**`v2`** encoding (separator-joined indices, no prefix). Move the `basePath` prefixing (today
inlined in `array.ts` `getFull`/`getSlice`) into the key builder so v2 and v3 share one path.

**Rationale**: v3 chunk keys differ structurally (`c/…` prefix, `/` default separator) from v2's
`0.0`. Centralizing key construction (called out in the issue's implementation notes) removes the
two inlined v2-only sites in `array.ts` and makes the encoding a per-array strategy.

**Alternatives considered**:
- *Branch on version inside `array.ts`* — rejected: re-inlines format logic into the read path,
  the opposite of the neutral-metadata goal.

---

## R6. Sharding (`sharding_indexed`)

**Decision**: Implement `sharding_indexed` as a codec (registered in `codecRegistry`) that, given
a shard key, reads the shard **index** (an array of `uint64 (offset, nbytes)` pairs; the index
location — end of shard by default — comes from the codec config) and decodes only the requested
inner-chunks. When the store exposes `getRange`, fetch each touched inner-chunk by byte-range;
coalesce ranges whose inter-range gap ≤ a configurable threshold (default ~1 MB, per clarification),
with exactly-contiguous ranges always merged. The reserved empty marker (`2^64-1` for both offset
and nbytes) means an empty inner-chunk → fill value. Without `getRange`, fetch the whole shard once
and slice inner-chunks in memory. Inner-chunks are decoded through their own (inner) `CodecPipeline`.

**Rationale**: This is the feature's performance rationale (FR-012–FR-015, SC-004). Byte-range per
inner-chunk is what turns "N GETs per region" into a few ranged GETs. The gap-threshold coalescing
(R-clarification) is the standard fsspec/zarr approach and is directly testable. The whole-shard
fallback keeps correctness on non-ranged stores (FR-014). `getRange` already exists on `Store` and
is implemented for FS; the loader's current gating of `getRange` to the `codec === null` path must
be relaxed so sharding can range-read compressed inner-chunks.

**Alternatives considered**:
- *Always download whole shards* — rejected: defeats the entire performance purpose (SC-004).
- *One request per inner-chunk, never coalesce* — rejected: high request count for dense
  sub-regions; the gap threshold is the tunable middle ground.
- *Read the index via a separate metadata channel* — rejected: the index lives inside the shard
  object; a `getRange` of the index region (or whole-shard fallback) is the correct mechanism.

---

## R7. `crc32c` implementation

**Decision**: Use a small table-based CRC-32C (Castagnoli) implementation. Prefer a tiny,
well-audited dependency if one is already ESM-friendly and zero-transitive; otherwise vendor a
~40-line table implementation in `src/codec/crc32c.ts`. Verify on decode and **throw a clear
corruption error on mismatch** (clarification; FR-008a), never returning the data.

**Rationale**: `crc32c` is not a Node built-in (`node:zlib` provides CRC-32, not CRC-32C). The
computation is trivial and hot only on the checksum bytes, so an in-repo table implementation
avoids a new runtime dependency (Technical Constraints: minimize deps). Verify-and-error matches
the clarified integrity posture and doubles as a byte-range/codec-order regression detector during
development.

**Alternatives considered**:
- *Skip verification, strip checksum* — rejected by clarification (Option C declined).
- *Warn-and-continue* — rejected by clarification (Option B declined).
- *Heavy hashing dependency* — rejected: CRC-32C is a few lines; a dependency is not justified
  (Principle VII, Technical Constraints).

---

## R8. v3 consolidated metadata

**Decision**: Read v3 `consolidated_metadata` (the nested form embedded in the root `zarr.json`)
in a new `src/metadata/consolidated-v3.ts`, exposing the same lookup surface the v2
`ConsolidatedMetadata` gives `ZarrGroup` (`get`/`has`/`listChildren`) so child resolution avoids
per-node fetches. Root-only, matching the existing v2 behavior (`open.ts` loads consolidated at
root only).

**Rationale**: v3 consolidated metadata is structurally different from v2's flat `.zmetadata`
(nested under the root node rather than a flat `metadata` map), so it needs its own reader, but it
should present the same interface to `ZarrGroup` so the group code stays version-neutral
(FR-016, SC-005).

**Alternatives considered**:
- *Reuse the v2 `ConsolidatedMetadata` class as-is* — rejected: the document shape differs; a thin
  v3 adapter presenting the same interface is cleaner than overloading the v2 parser.

---

## R9. Fixtures & test strategy

**Decision**: Extend `tests/fixtures/generate.py` with `zarr_format=3` generators covering: each
supported dtype, the codec chain `transpose → bytes(endian) → blosc/gzip/zstd`, a `crc32c` case,
each `chunk_key_encoding`, special fill values (`NaN`/`Inf`/`-Inf`), a `sharding_indexed` fixture,
and a v3 consolidated-metadata hierarchy. Reuse the existing `expected.json` schema and the
`FileSystemStore + openArray + expected.json` comparison harness (version-agnostic in shape). Add
large v3 + sharded equivalents alongside `large_100mb`/`large_1gb` for local perf measurement.

**Rationale**: Principle III mandates fixtures from the reference Python `zarr` library; v3 support
in `zarr-python` 3.x produces exactly the `zarr.json` + `c/…` layout the reader must handle. The
harness shape is already reusable; only the generators and fixture directories are new.

**Alternatives considered**:
- *Hand-craft v3 fixtures* — rejected: cross-implementation correctness requires a reference
  writer, per Principle III.

---

## Summary of resolved unknowns

| Unknown (Technical Context) | Resolution |
|-----------------------------|------------|
| Neutral metadata seam | R1 — `Resolved*Meta` produced by both parsers |
| Detection / precedence | R2 — `layout` abstraction, v3-first, documented precedence |
| Codec chain model | R3 — `CodecPipeline`, reverse decode, fixes v2 filters gap |
| v3 dtypes & endianness | R4 — v3 name map; `float16`→`Float32Array`; endian from `bytes` codec |
| Chunk key encoding | R5 — default `c/` + `v2` encodings in `indexing.ts`; basePath folded in |
| Sharding read strategy | R6 — codec + `getRange` per inner-chunk, gap-coalesce, whole-shard fallback |
| `crc32c` implementation | R7 — table-based (vendored or tiny dep), verify-and-error |
| v3 consolidated metadata | R8 — `consolidated-v3.ts` presenting the v2 lookup interface |
| Fixtures | R9 — `zarr_format=3` generators, reuse `expected.json` harness |

**All NEEDS CLARIFICATION resolved. Ready for Phase 1.**
