# Feature Specification: Performance & Ecosystem Improvements

**Feature Branch**: `004-performance-ecosystem`
**Created**: 2026-04-04
**Status**: Draft
**Input**: User description: "Fases 1, 2 e 3 do roadmap de melhorias inspiradas no ecossistema Python (sem prefetch)"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Zero-Config Blosc Support (Priority: P1)

A data engineer opens a Zarr v2 store compressed with Blosc (the most
common compressor in real-world scientific data). Currently, they must
manually register the Blosc codec with 10 lines of boilerplate before
any data can be read. With built-in Blosc support, the library reads
Blosc-compressed data out of the box — no extra code required.

**Why this priority**: Blosc is the default compressor in zarr-python.
Every user of real-world Zarr data (WRF, climate, satellite) hits this
on day one. Eliminating the boilerplate is the single highest-impact
usability improvement.

**Independent Test**: Open a Blosc-compressed Zarr array without any
manual codec registration. Verify the data is read correctly.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 array with `compressor: {"id": "blosc", "cname": "lz4"}`,
   **When** the user opens and reads it without registering any codec,
   **Then** the data is decompressed correctly using the built-in Blosc codec.
2. **Given** a Zarr v2 array with `compressor: {"id": "blosc", "cname": "zstd"}`,
   **When** the user reads it, **Then** the correct Blosc sub-codec (zstd)
   is used based on the metadata configuration.
3. **Given** a user who previously registered a custom Blosc codec,
   **When** the built-in is available, **Then** the user's custom
   registration takes precedence (no conflict).

---

### User Story 2 - In-Memory LRU Chunk Cache (Priority: P1)

A data engineer reads the same spatial region of a Zarr array multiple
times within a single session (e.g., computing statistics, generating
multiple visualizations, debugging). The disk cache (feature 003)
avoids re-fetching from S3 but still requires disk I/O and
decompression on every access. An in-memory cache of already-decoded
chunks eliminates both, making repeated reads near-instantaneous.

**Why this priority**: For interactive/iterative workflows, the
difference between 4ms (disk cache) and 0.01ms (memory cache) is
the difference between "fast" and "invisible". This is the biggest
performance win for repeated-access patterns.

**Independent Test**: Read the same chunk twice in the same session.
Verify the second read is served from memory without any disk I/O
or decompression.

**Acceptance Scenarios**:

1. **Given** an in-memory cache enabled with a size limit, **When** the
   user reads the same array region twice, **Then** the second read
   returns in under 0.1ms (memory access, no decompression).
2. **Given** an in-memory cache at capacity, **When** a new chunk is
   loaded, **Then** the least-recently-used cached chunk is evicted.
3. **Given** no in-memory cache configured, **When** the user reads data,
   **Then** behavior is identical to current library behavior (opt-in).
4. **Given** both disk cache and memory cache enabled, **When** the user
   reads a chunk, **Then** memory cache is checked first, then disk
   cache, then remote store.

---

### User Story 3 - Disk Cache Size Limit with LRU Eviction (Priority: P1)

A data engineer runs a long-lived service that processes many Zarr
datasets over time. Without a size limit, the disk cache grows
indefinitely. With LRU eviction, the cache stays within a configured
maximum size by removing the least-recently-accessed entries.

**Why this priority**: Operational safety — production services cannot
have unbounded disk growth. This was explicitly deferred in feature 003
and is now needed.

**Independent Test**: Fill the cache beyond the configured limit. Verify
old entries are evicted and total size stays within bounds.

**Acceptance Scenarios**:

1. **Given** a disk cache with a max size of N megabytes, **When** the
   cache exceeds N MB after a write, **Then** the least-recently-accessed
   entries are evicted until the total is under N MB.
2. **Given** a disk cache without a size limit (default), **When** the
   user writes to cache, **Then** no eviction occurs (backward compatible).

---

### User Story 4 - Parallel Multi-Array Reads (Priority: P2)

A data engineer needs to read 4 weather variables (wind, temperature,
pressure, humidity) at the same point and time range. Currently they
must do `Promise.all` manually, and each array uses its own concurrency
pool (potentially 4 x 10 = 40 simultaneous S3 requests). A built-in
helper reads multiple arrays through a shared concurrency pool, reducing
connection pressure and simplifying user code.

**Why this priority**: Common workflow in geospatial data — read multiple
variables at the same spatial/temporal selection. Shared concurrency pool
prevents overloading remote stores.

**Independent Test**: Read 4 arrays at the same selection using the
helper. Verify all data is returned correctly and total concurrent
requests don't exceed the configured concurrency limit.

**Acceptance Scenarios**:

1. **Given** a group with multiple arrays, **When** the user calls
   a multi-array read with a list of array names and a selection,
   **Then** all arrays are read and returned as a named collection.
2. **Given** a concurrency limit of 10, **When** 4 arrays are read
   simultaneously, **Then** total concurrent chunk fetches never
   exceed 10 (shared pool, not 4 x 10).
3. **Given** a multi-array read, **When** one array fails (e.g.,
   missing), **Then** the error identifies which array failed and
   other arrays' results are still available.

---

### User Story 5 - Byte-Range Requests for Partial Chunk Reads (Priority: P2)

A data engineer reads a small slice from a large uncompressed Zarr array.
Currently the library fetches the entire chunk even when only a few bytes
are needed. With byte-range request support, the library fetches only the
required byte range from the remote store, drastically reducing transfer
size for uncompressed data.

**Why this priority**: Enables efficient partial reads for uncompressed
data and is a prerequisite for the reference filesystem (US7). S3 and
HTTP natively support byte-range GETs.

**Independent Test**: Read a small slice from a large uncompressed chunk
via S3. Verify only the needed bytes are transferred (not the full chunk).

**Acceptance Scenarios**:

1. **Given** an uncompressed Zarr array on a remote store, **When** the
   user requests a small slice, **Then** the library uses byte-range
   requests to fetch only the needed portion of the chunk.
2. **Given** a compressed Zarr array, **When** the user requests any
   slice, **Then** the library fetches the full chunk (compression
   requires the complete chunk for decompression).
3. **Given** a store that does not support byte-range requests, **When**
   a range is requested, **Then** the library falls back to fetching
   the full chunk silently.

---

### User Story 6 - Reference Filesystem (Kerchunk-style) (Priority: P3)

A data engineer has WRF forecast data stored as NetCDF4/HDF5 files on
S3. Converting them to Zarr format is time-consuming and doubles storage.
With a reference filesystem, a small JSON manifest maps virtual Zarr
chunk keys to byte ranges in the original HDF5/NetCDF files. The
library reads data through these references, treating non-Zarr files
as if they were Zarr stores — without any data conversion.

**Why this priority**: Eliminates the need to convert HDF5/NetCDF to
Zarr. Major workflow improvement for organizations with large existing
archives. Depends on byte-range support (US5).

**Independent Test**: Create a reference manifest for an HDF5 file on
disk. Open it as a Zarr store via the reference filesystem and verify
correct data is returned.

**Acceptance Scenarios**:

1. **Given** a kerchunk-compatible JSON reference manifest, **When** the
   user opens it as a store, **Then** the library resolves chunk keys
   to byte ranges in the target files and returns correct data.
2. **Given** a reference manifest pointing to S3/HTTP URLs, **When** the
   user reads data, **Then** the library fetches the specified byte
   ranges from the remote URLs.
3. **Given** a reference manifest with inline base64-encoded data
   (common for small metadata), **When** the library reads such a key,
   **Then** the inline data is decoded and returned directly.

---

### User Story 7 - Dataset Concept (xarray-style) (Priority: P3)

A researcher wants to work with a Zarr store using dimension names
and coordinate values instead of numeric indices. A Dataset wraps a
group of arrays sharing common dimensions (e.g., time, lat, lon) and
provides selection by label — `ds.sel({time: 0, lat: -25.5})` instead
of `arr.get([0, [380, 381], [301, 302]])`.

**Why this priority**: Major usability improvement for scientific
workflows. Depends on multi-array reads (US4). Inspired by xarray but
scoped to read-only label-based selection.

**Independent Test**: Open a WRF-style store as a Dataset. Select data
by dimension name and coordinate value. Verify correct array subset
is returned.

**Acceptance Scenarios**:

1. **Given** a Zarr group with arrays that have `_ARRAY_DIMENSIONS`
   attributes, **When** the user opens it as a Dataset, **Then** the
   library auto-discovers dimension names and coordinate arrays.
2. **Given** a Dataset with lat/lon coordinates, **When** the user
   selects by `{lat: -25.5, lon: -44.5}`, **Then** the library finds
   the nearest coordinate index and returns the corresponding data.
3. **Given** a Dataset, **When** the user reads multiple variables at
   the same selection, **Then** all variables are returned in a single
   call using the multi-array read infrastructure.

---

### Edge Cases

- What happens when Blosc sub-codec (cname) is not supported by the
  installed numcodecs version?
  The library MUST throw a descriptive error naming the unsupported
  sub-codec and suggesting an update.
- What happens when the in-memory cache size limit is smaller than a
  single chunk?
  The library MUST still function — chunks are loaded and returned but
  not cached in memory.
- What happens when a reference manifest points to a file that doesn't
  exist?
  The library MUST throw an error identifying the missing target file
  and the reference key that pointed to it.
- What happens when byte-range request returns unexpected data length?
  The library MUST throw an error and fall back to full chunk fetch.
- What happens when Dataset encounters arrays with inconsistent
  dimensions?
  The library MUST include only arrays whose dimensions match the
  declared coordinate dimensions, skipping incompatible arrays with
  a warning.
- What happens when `ds.sel()` receives a coordinate value that doesn't
  exist exactly in the coordinate array?
  The library MUST find the nearest coordinate value (nearest-neighbor
  lookup) and return data at that index.

## Requirements *(mandatory)*

### Functional Requirements

**Blosc Codec (US1)**

- **FR-001**: Library MUST include Blosc as a built-in codec, registered
  automatically at import time. No user action required.
- **FR-002**: The built-in Blosc codec MUST respect all compressor
  configuration fields from `.zarray` metadata (cname, clevel, shuffle,
  blocksize) — not hardcoded defaults.
- **FR-003**: If a user registers a custom codec with the same ID
  ("blosc"), their registration MUST take precedence over the built-in.

**In-Memory LRU Cache (US2)**

- **FR-004**: Library MUST provide an opt-in in-memory LRU cache for
  decoded chunk data (post-decompression).
- **FR-005**: The memory cache MUST be configurable with a maximum size
  in bytes or number of entries.
- **FR-006**: When the memory cache is at capacity, the least-recently-
  used entry MUST be evicted.
- **FR-007**: The memory cache MUST sit in the data pipeline between
  decompression and the caller — caching decoded bytes, not raw
  compressed bytes.

**Disk Cache LRU (US3)**

- **FR-008**: The existing disk cache MUST support an optional maximum
  size in bytes (`maxSizeBytes`).
- **FR-009**: When the disk cache exceeds the size limit, the least-
  recently-accessed entries MUST be evicted until under the limit.
- **FR-010**: No size limit by default (backward compatible with
  feature 003).

**Multi-Array Reads (US4)**

- **FR-011**: Library MUST provide a method to read multiple arrays from
  a group with a single selection, returning results as a named
  collection.
- **FR-012**: Multi-array reads MUST use a shared concurrency pool to
  limit total concurrent chunk fetches across all arrays.
- **FR-013**: If one array in a multi-array read fails, the error MUST
  identify which array failed. Other arrays' results SHOULD still be
  available.

**Byte-Range Requests (US5)**

- **FR-014**: Store implementations MUST support optional byte-range
  read operations for partial chunk fetches.
- **FR-015**: For uncompressed arrays, the library MUST use byte-range
  requests to fetch only the needed bytes of a chunk when the store
  supports it.
- **FR-016**: For compressed arrays, the library MUST fall back to
  fetching the full chunk (compression requires complete data).
- **FR-017**: If a store does not support byte-range requests, the
  library MUST fall back to full chunk fetch silently.

**Reference Filesystem (US6)**

- **FR-018**: Library MUST provide a store implementation that reads
  data via a kerchunk-compatible JSON reference manifest.
- **FR-019**: The reference store MUST resolve chunk keys to byte ranges
  (URL, offset, length) in target files and fetch them via byte-range
  requests.
- **FR-020**: The reference store MUST support inline base64-encoded
  data for small entries (metadata).
- **FR-021**: The reference store MUST support targets on local
  filesystem, HTTP, and S3.

**Dataset (US7)**

- **FR-022**: Library MUST provide a Dataset class that wraps a group
  of arrays sharing common dimensions.
- **FR-023**: Dataset MUST auto-discover dimension names from
  `_ARRAY_DIMENSIONS` attributes (CF/xarray convention).
- **FR-024**: Dataset MUST provide label-based selection by dimension
  name and coordinate value (`sel` method).
- **FR-025**: Coordinate lookup MUST use nearest-neighbor matching when
  an exact match is not found.
- **FR-026**: Dataset MUST use multi-array read infrastructure for
  reading multiple variables at the same selection.

### Key Entities

- **BloscCodec**: Built-in codec for Blosc compression. Delegates to
  numcodecs Blosc with full config passthrough.
- **MemoryCache**: LRU cache of decoded chunk data (Uint8Array). Keyed
  by chunk store key. Configurable max size.
- **ReferenceStore**: Store that resolves keys via a JSON manifest
  mapping to byte ranges in target files.
- **Dataset**: High-level wrapper around a ZarrGroup. Provides
  dimension-aware selection and multi-variable reads.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Blosc-compressed arrays can be read without any manual
  codec registration (zero lines of setup code).
- **SC-002**: In-memory cache hit returns decoded chunk data in under
  0.1ms (vs ~4ms for disk cache hit).
- **SC-003**: Disk cache stays within configured size limit — total
  cache size never exceeds `maxSizeBytes` by more than one chunk size.
- **SC-004**: Multi-array read of 4 variables at the same selection
  completes with the same concurrency limit as a single-array read
  (no connection explosion).
- **SC-005**: Byte-range read of a small slice from an uncompressed
  chunk transfers less than 10% of the full chunk size.
- **SC-006**: Reference filesystem can open and read data from an
  HDF5/NetCDF file via a kerchunk manifest without any file conversion.
- **SC-007**: Dataset label-based selection (`ds.sel({lat: -25.5})`)
  returns correct data matching the nearest coordinate value.
- **SC-008**: All existing tests continue to pass without modification
  (backward compatibility across all new features).

## Assumptions

- The `numcodecs` npm package remains the source of Blosc decompression
  and is already installed as a dependency.
- In-memory cache is per-process — not shared across Node.js worker
  threads or cluster processes.
- Kerchunk reference manifest format (version 1) is stable and follows
  the spec from the fsspec/kerchunk project.
- The `_ARRAY_DIMENSIONS` attribute convention (from CF/xarray) is the
  standard way to associate dimensions with Zarr arrays.
- Nearest-neighbor coordinate lookup uses Euclidean distance for 1D
  coordinates. Multi-dimensional coordinate lookup (curvilinear grids)
  is out of scope for v1 but may be added later.
- Write operations remain out of scope (read-only library).
