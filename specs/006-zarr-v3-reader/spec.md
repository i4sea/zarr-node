# Feature Specification: Read Zarr v3 (core + sharding) keeping the v2 API

**Feature Branch**: `006-zarr-v3-reader`  
**Created**: 2026-07-09  
**Status**: Draft  
**Input**: User description: "https://github.com/i4sea/zarr-node/issues/15 — feat: read Zarr v3 (core + sharding) keeping the v2 API"

## Clarifications

### Session 2026-07-09

- Q: Which exact set of v3 named data types must be in scope? → A: Full enumerated set — `bool`, `int8/16/32/64`, `uint8/16/32/64`, `float16/32/64`; `float16` decoded into a 32-bit float representation, `int64`/`uint64` into big-integer typed arrays.
- Q: What should the reader do when a `crc32c` checksum does not match the decoded bytes? → A: Verify and error — recompute the checksum and throw a clear corruption error on mismatch (never return the data). This catches storage/transit corruption, and also surfaces byte-range/coalescing and codec-order bugs during development.
- Q: What governs when two nearby inner-chunk byte-ranges get merged into one request? → A: Gap-size threshold — merge adjacent ranges when the wasted bytes between them are at or below a configurable limit (default on the order of ~1 MB); exactly-contiguous ranges always merge.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read a Zarr v3 array with the same public API (Priority: P1)

A data consumer points the library at a store written by a modern Zarr v3 writer (zarr-python 3.x, zarrs, TensorStore, xarray) and reads array data through the exact same entry points and selection method they already use for v2. They do not tell the library which format the store is; the library detects it. The values they read back are identical to what the writing tool produced.

**Why this priority**: This is the core compatibility goal. The ecosystem now writes v3 by default, so without it the library cannot read newly produced datasets at all. It delivers standalone value even before sharding: consumers can open and read v3 data that today is rejected.

**Independent Test**: Generate a non-sharded v3 array fixture with a reference writer, plus its expected values, open it through the public entry points, read the full array and sub-regions, and assert the returned values equal the expected values per element.

**Acceptance Scenarios**:

1. **Given** a store containing a v3 array (`zarr.json` with `node_type: array`), **When** the consumer opens it through the array entry point and reads a selection, **Then** the returned object is the same type as for a v2 array and the read values match the reference expected values.
2. **Given** a store containing a v3 group (`zarr.json` with `node_type: group`), **When** the consumer opens it through the group entry point, **Then** the returned object is the same type as for a v2 group and its child arrays are readable.
3. **Given** a v3 array whose data type is one of the supported named types, **When** the consumer reads it, **Then** values land in the correct typed representation with the byte order derived from the array's byte-encoding codec.
4. **Given** a v3 array with a non-default fill value (including `NaN`, `Infinity`, `-Infinity`, or a byte-form fill for types that require it), **When** the consumer reads a region that overlaps a missing chunk, **Then** the missing positions are filled with the declared fill value.

---

### User Story 2 - Automatic version detection with no v2 regression (Priority: P1)

A consumer with a mixed collection of stores — some v2, some v3 — opens each one the same way, without passing a version flag. Existing v2 stores keep reading exactly as before; the upgrade is transparent to code that only ever touches v2.

**Why this priority**: The feature is only adoptable if it is drop-in. Any behavioral or signature change to the v2 path would break existing consumers and block the upgrade. Detection and non-regression are as critical as v3 support itself.

**Independent Test**: Run the full existing v2 fixture and test suite unchanged against the new code and confirm all pass; then open a v2 and a v3 store through the same call with no version argument and confirm each is read correctly.

**Acceptance Scenarios**:

1. **Given** a store written in v2 (`.zarray` / `.zgroup` / `.zattrs`), **When** opened after the v3 feature ships, **Then** it reads identically to before and the public entry-point signatures are unchanged.
2. **Given** a store written in v3 (`zarr.json`) and a store written in v2, **When** each is opened through the same entry point without a version argument, **Then** the library resolves the correct format automatically and reads each correctly.
3. **Given** the existing v2 fixtures and tests, **When** the suite runs against the new code, **Then** every v2 fixture and test passes.

---

### User Story 3 - Decode the full ordered v3 codec chain (Priority: P1)

A consumer reads a v3 array whose bytes were produced through an ordered codec chain — an array-to-array transform (e.g. transpose), exactly one array-to-bytes encoding (byte order), and one or more bytes-to-bytes compressors (e.g. blosc, gzip, zstd, checksum). The library applies the entire chain in reverse on decode and returns correct values.

**Why this priority**: v3 data in the wild is compressed and often transformed. A partial pipeline silently returns corrupt data. This also closes a known gap where v2 filters are parsed but never applied on decode — the v3 path must apply the whole chain, and the shared path must not carry that gap forward.

**Independent Test**: Generate a v3 fixture whose chunks pass through a transpose, a byte-order encoding, and a compressor, plus expected values; read it and assert every element matches, then vary the compressor across the supported set.

**Acceptance Scenarios**:

1. **Given** a v3 array whose codec chain is `transpose → byte-encoding → compressor`, **When** read, **Then** decoding applies the codecs in reverse order and returned values match the reference.
2. **Given** v3 arrays using each supported bytes-to-bytes compressor, **When** read, **Then** each decodes correctly.
3. **Given** a chunk whose declared chain includes an array-to-array transform, **When** read, **Then** the transform is inverted so the element layout matches the reference.

---

### User Story 4 - Read sharded v3 data by byte-range (Priority: P1)

A consumer reads a sub-region of a large sharded v3 dataset stored remotely. Rather than downloading whole shards, the library reads the shard index and fetches only the byte-ranges of the inner-chunks that the region actually touches. Reading a small window of a large sharded array transfers far less than the whole shard.

**Why this priority**: Sharding is the reason this feature is scoped now — it is the v3 capability that attacks the actual cost/latency bottleneck (fewer objects in object storage, one inner-chunk per byte-range instead of N whole-object reads). The core v3 read alone does not improve performance; sharding is where the business benefit is realized on read.

**Independent Test**: Generate a sharded v3 fixture with its expected values, read a sub-region, and (a) assert the values match, and (b) against a store that supports ranged reads, assert that only inner-chunk byte-ranges were requested — not entire shards.

**Acceptance Scenarios**:

1. **Given** a sharded v3 array, **When** the consumer reads a sub-region, **Then** the returned values match the reference expected values.
2. **Given** a sharded v3 array on a store that supports ranged reads, **When** the consumer reads a sub-region, **Then** the library reads the shard index and fetches only the byte-ranges of the touched inner-chunks, not the full shards.
3. **Given** a sharded v3 array on a store that does not support ranged reads, **When** the consumer reads a sub-region, **Then** the library falls back to fetching whole shards and still returns correct values.
4. **Given** a shard whose index marks some inner-chunks as empty, **When** a read touches an empty inner-chunk, **Then** those positions are filled with the array's fill value.
5. **Given** a read that touches multiple adjacent inner-chunks within a shard, **When** it is served over ranged reads, **Then** adjacent byte-ranges are coalesced where it makes sense to reduce request count.

---

### User Story 5 - Consolidated v3 metadata at the root (Priority: P2)

A consumer opens a v3 hierarchy that ships consolidated metadata at its root. The library reads the consolidated document once and avoids a per-node fetch when opening children, matching the latency benefit already available for v2.

**Why this priority**: A meaningful latency win for hierarchies with many nodes, and it parallels an existing v2 capability. It is valuable but not required for basic v3 correctness, so it ranks below the P1 read/decode/sharding stories.

**Independent Test**: Generate a v3 hierarchy with consolidated metadata, open it, and confirm children resolve without per-node metadata fetches while returning correct data.

**Acceptance Scenarios**:

1. **Given** a v3 hierarchy with consolidated metadata at the root, **When** the consumer opens it and accesses children, **Then** child metadata is served from the consolidated document rather than per-node fetches.
2. **Given** the same hierarchy, **When** children are read, **Then** the values match the reference and are consistent with reading the same hierarchy without consolidated metadata.

---

### Edge Cases

- A `zarr.json` declaring an unsupported `zarr_format` value (neither 2 nor 3) is rejected with a clear error rather than misread.
- A v3 array whose codec chain violates the v3 rule of exactly one array-to-bytes codec (zero or more than one) is rejected with a clear error.
- A v3 data type outside the supported set surfaces a clear "unsupported data type" error rather than returning wrong values.
- A store that contains both v2 and v3 markers at the same node resolves deterministically (documented precedence) rather than ambiguously.
- A chunk whose `crc32c` checksum does not match the decoded bytes raises a clear corruption error rather than returning the data.
- A sharded read where the shard index itself is missing or malformed surfaces a clear error.
- A shard index entry uses the reserved empty marker for offset and size; the inner-chunk is treated as empty (fill value), not read.
- Reading a region that lies entirely outside declared chunks returns fill values without erroring.
- A v3 array using the `v2`-style chunk key encoding (rather than the default) resolves chunk keys correctly.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The library MUST detect a node's Zarr format automatically when opening (v2 vs v3) without the consumer supplying a version, resolving v3 from a single per-node `zarr.json` and v2 from the existing `.zarray`/`.zgroup`/`.zattrs` layout.
- **FR-002**: The library MUST read v3 arrays and groups through the same public entry points and the same selection/read method as v2, returning the same object types, with no change to the public API surface.
- **FR-003**: The library MUST distinguish v3 array nodes from group nodes using the `node_type` discriminator in `zarr.json`.
- **FR-004**: The library MUST map the full supported set of v3 named data types — `bool`; `int8`, `int16`, `int32`, `int64`; `uint8`, `uint16`, `uint32`, `uint64`; `float16`, `float32`, `float64` — to their typed representations, decoding `float16` into a 32-bit float representation and `int64`/`uint64` into big-integer typed arrays.
- **FR-005**: The library MUST derive element byte order for v3 from the array's byte-encoding codec, not from a dtype string prefix as in v2.
- **FR-006**: The library MUST parse the ordered v3 codec chain consisting of zero or more array-to-array codecs, exactly one array-to-bytes codec, and zero or more bytes-to-bytes codecs, and MUST reject a chain that does not contain exactly one array-to-bytes codec.
- **FR-007**: The library MUST decode a v3 chunk by applying the full codec chain in reverse order, applying every codec in the chain (no silently skipped stage).
- **FR-008**: The library MUST support the v3 array-to-array transpose codec, the array-to-bytes byte-encoding codec, and the bytes-to-bytes compressors and checksum used by the ecosystem (blosc, gzip, zstd, crc32c), reusing the existing compression implementations already available.
- **FR-008a**: When decoding a chunk whose codec chain includes `crc32c`, the library MUST recompute the checksum over the decoded bytes and MUST throw a clear corruption error on mismatch, never returning the mismatched data.
- **FR-009**: The library MUST close the existing gap where declared v2 `filters` are parsed but never applied during decode, so the shared decode path applies every declared transform for both formats. This is an intentional behavior change on the v2 path for arrays that declare a non-null `filters` entry: their decoded values change (from today's unfiltered bytes to correctly filtered values). No existing v2 fixture declares filters (all are `filters: null`), so no current fixture regresses; a new v2-with-filter fixture MUST be added to cover the corrected path.
- **FR-010**: The library MUST support the v3 regular chunk grid and both the default chunk key encoding (with its configurable separator) and the `v2` chunk key encoding.
- **FR-011**: The library MUST interpret v3 fill values, including the special float values `NaN`, `Infinity`, and `-Infinity`, and the byte-form fill representation for types that require it, and MUST use the fill value for positions not backed by stored data.
- **FR-012**: The library MUST read the v3 sharding codec: parse the shard index of `(offset, size)` pairs, recognize the reserved empty-marker for empty inner-chunks, and materialize the requested inner-chunks.
- **FR-013**: When the backing store supports ranged reads, the library MUST fetch individual inner-chunks by byte-range rather than downloading whole shards for a sub-region read.
- **FR-014**: When the backing store does not support ranged reads, the library MUST fall back to fetching whole shards and still return correct values.
- **FR-015**: The library MUST coalesce inner-chunk byte-ranges within a shard using a gap-size threshold: two ranges are merged into one request when the wasted (unwanted) bytes between them are at or below a configurable limit (default on the order of ~1 MB), and exactly-contiguous ranges are always merged. Ranges separated by more than the limit MUST be fetched as separate requests.
- **FR-016**: The library MUST read v3 consolidated metadata at the hierarchy root by default and use it to resolve child metadata without per-node fetches, matching the existing v2 consolidated-metadata behavior.
- **FR-017**: The library MUST reuse all existing backends (filesystem, HTTP, S3, reference) without changing the store interface; sharding MUST use the store's existing optional ranged-read capability.
- **FR-018**: The library MUST reuse the existing performance architecture on the v3 path — the decode work pool separated from I/O, the byte-budgeted caches, and the concurrency-limited fan-out.
- **FR-019**: The library MUST NOT support writing Zarr v3; the library remains read-only.
- **FR-020**: The library MUST preserve all existing v2 fixtures and tests as passing, with no regression in v2 read behavior.
- **FR-021**: The library MUST surface a clear, actionable error for unsupported v3 constructs (unknown `zarr_format`, unsupported data type, malformed or missing shard index, invalid codec chain) rather than returning incorrect data.

### Key Entities *(include if feature involves data)*

- **Node metadata (version-neutral)**: The resolved description of a single array or group, independent of whether it originated from v2 or v3 files — shape, chunking, data type, byte order, codec chain, fill value, and node kind (array vs group). Both formats produce this so the downstream read path is shared and unchanged.
- **v3 node document (`zarr.json`)**: The single per-node metadata document for v3, carrying the format version, the `node_type` discriminator, and the array/group descriptors.
- **Codec chain**: An ordered sequence of transforms — array-to-array, exactly one array-to-bytes, and bytes-to-bytes — with a defined reverse order for decoding.
- **Chunk grid & chunk key encoding**: The mapping from a grid coordinate to a stored key, including the separator and the default vs `v2` encodings.
- **Shard & shard index**: A single stored object packing many inner-chunks, plus an index of `(offset, size)` locating each inner-chunk within the object, with a reserved marker for empty inner-chunks.
- **Consolidated metadata document (v3)**: A root-level document aggregating the metadata of the hierarchy's nodes to avoid per-node fetches.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A consumer can open and read a v3 store — array or group — through the same calls used for v2, with zero code changes beyond pointing at the v3 store, and the returned values match the reference writer's expected output for 100% of elements.
- **SC-002**: 100% of the existing v2 fixtures and tests pass unchanged against the new code, and the public API signatures are unchanged.
- **SC-003**: Every supported v3 data type, codec-chain combination (transpose, byte-encoding, and each compressor), fill value (including special float values), and chunk key encoding in the fixture set reads with values matching the reference for 100% of elements.
- **SC-004**: For a sharded v3 array on a store that supports ranged reads, reading a sub-region that touches a small fraction of a shard transfers only the touched inner-chunks' byte-ranges — the number of full-shard downloads is zero — and the values are correct.
- **SC-005**: Opening a v3 hierarchy with root consolidated metadata resolves children with zero per-node metadata fetches, matching the v2 consolidated-metadata behavior.
- **SC-006**: Any performance change is demonstrated with local measurements on large and sharded fixtures rather than asserted; no throughput target is claimed without a measured basis.

## Assumptions

- The upstream pipeline that generates `.zarr` data is what adopts sharding when writing; this read-only library realizes the object-count and read-latency benefit only on data that was already written v3 with sharding. It does not reduce write volume by itself.
- The core v3 read (without sharding) is a compatibility feature and is expected to be performance-neutral versus v2 (one chunk still equals one stored object); the enabling metadata/codec refactor is also expected to be performance-neutral.
- The supported data types are exactly the enumerated boolean and numeric types in FR-004; exotic v3 data types (structured/record, non-normative extensions) are out of scope unless profiling of real data later requires them.
- No new store backends are introduced; the existing store interface is agnostic to format version and is reused as-is, including its optional ranged-read capability.
- Reference expected-value fixtures are produced by a Zarr v3 reference writer (zarr-python 3.x), reusing the existing expected-values test harness which is already format-agnostic.
- Where a store presents both v2 and v3 markers at the same node (unexpected in practice), a documented, deterministic precedence resolves the ambiguity.
