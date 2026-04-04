# Feature Specification: Zarr v2 Reader

**Feature Branch**: `001-zarr-v2-reader`
**Created**: 2026-04-03
**Status**: Draft
**Input**: User description: "Read Zarr v2 arrays from filesystem, HTTP, and S3"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read Array from Local Filesystem (Priority: P1)

A data engineer needs to read a Zarr v2 array stored on the local filesystem
to process scientific data in a Node.js data pipeline. They open the Zarr
store, inspect metadata (shape, dtype, chunk layout), and retrieve the array
data as a typed array for further computation.

**Why this priority**: This is the fundamental capability of the library.
Without local file reading, nothing else works. It validates the entire
core pipeline: metadata parsing, chunk resolution, codec decoding, and
typed array assembly.

**Independent Test**: Can be fully tested with a local Zarr v2 directory
fixture. Open the store, read an array, and verify the returned values
match the expected data.

**Acceptance Scenarios**:

1. **Given** a valid Zarr v2 array directory on disk, **When** the user opens
   it and requests the data, **Then** the library returns the correct typed
   array (e.g., Float32Array) with values matching the original data.
2. **Given** a Zarr v2 array with multiple chunks, **When** the user reads
   the full array, **Then** all chunks are fetched, decompressed, and
   assembled into a single contiguous typed array in the correct order.
3. **Given** a Zarr v2 array with gzip compression, **When** the user reads
   the data, **Then** chunks are transparently decompressed before assembly.
4. **Given** a Zarr v2 array directory, **When** the user inspects metadata,
   **Then** they can access shape, dtype, chunk shape, compressor info,
   fill value, and dimension separator.
5. **Given** a path that does not contain valid Zarr metadata, **When** the
   user tries to open it, **Then** a clear, descriptive error is thrown.

---

### User Story 2 - Navigate Zarr Groups and Hierarchy (Priority: P1)

A researcher has a Zarr v2 store containing a hierarchy of groups and
arrays (e.g., a climate dataset with variables like temperature, pressure,
humidity organized in groups). They need to traverse the hierarchy, list
available arrays and sub-groups, and selectively read specific arrays.

**Why this priority**: Most real-world Zarr stores use groups to organize
multiple arrays. Without group support, the library cannot handle standard
scientific datasets.

**Independent Test**: Open a Zarr v2 directory containing nested groups
and arrays. List children, navigate to a specific array, and read its data.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 store with a root group containing arrays and
   sub-groups, **When** the user opens the root, **Then** they can list all
   direct child arrays and groups.
2. **Given** a nested group structure, **When** the user navigates to a
   sub-group by path, **Then** they can access that group's arrays and
   attributes.
3. **Given** a group with user-defined attributes (.zattrs), **When** the
   user accesses attributes, **Then** they receive the full attribute
   dictionary as a plain object.
4. **Given** a root path, **When** the user calls a convenience open
   function, **Then** the library auto-detects whether it is an array or
   group and returns the appropriate object.

---

### User Story 3 - Read Array Slices (Priority: P2)

A data engineer needs to read only a portion of a large Zarr array (e.g.,
a spatial subset or a single time step from a multi-dimensional dataset)
without loading the entire array into memory. They specify a selection
(index or range per dimension) and receive only the requested data.

**Why this priority**: Large Zarr arrays can be gigabytes. Reading the
full array is impractical for many server workloads. Slice access is
essential for production use but can be added after the core read pipeline
works.

**Independent Test**: Open a multi-dimensional Zarr array, request a
slice (e.g., first row, or a 2D sub-region), and verify only the expected
subset is returned.

**Acceptance Scenarios**:

1. **Given** a 2D array of shape [100, 200], **When** the user requests
   slice [0:10, 50:60], **Then** the library returns a typed array
   containing only the 10x10 subset with correct values.
2. **Given** a chunked array, **When** the user requests a slice that spans
   multiple chunks, **Then** only the necessary chunks are fetched (not all
   chunks in the array).
3. **Given** a 3D array, **When** the user requests a single index on one
   dimension and a range on others, **Then** the result has the correct
   reduced shape.

---

### User Story 4 - Read Array from HTTP Server (Priority: P2)

A backend developer needs to read Zarr v2 data served over HTTP (e.g., from
a static file server, CDN, or cloud object storage via HTTPS endpoint).
They provide a base URL and the library fetches metadata and chunks via
HTTP requests.

**Why this priority**: Many scientific datasets are published via HTTP.
This extends the library beyond local files to remote data access, a
critical server-side capability.

**Independent Test**: Serve a Zarr fixture directory via a local HTTP
server, open it via URL, read an array, and verify correct data.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 store served over HTTP, **When** the user opens it
   with a base URL, **Then** metadata and chunks are fetched via HTTP GET
   requests and the array data is correctly returned.
2. **Given** a slow or unreliable HTTP server, **When** a request times out,
   **Then** the library throws a descriptive timeout error including the
   URL and elapsed time.
3. **Given** a Zarr store behind authentication, **When** the user provides
   custom headers (e.g., Authorization), **Then** headers are included in
   all HTTP requests to the store.

---

### User Story 5 - Read Array from Amazon S3 (Priority: P3)

A cloud engineer needs to read Zarr v2 data stored in an Amazon S3 bucket
(or S3-compatible storage like MinIO). They configure the S3 store with
bucket name, prefix, and credentials, and the library reads data using
the native S3 protocol.

**Why this priority**: S3 is the dominant storage for cloud-hosted
scientific data. Native S3 support (not HTTP wrapper) provides better
authentication, streaming, and error handling. Delivered after core
and HTTP stores are stable.

**Independent Test**: Configure an S3 store pointing to a bucket with
Zarr fixtures (using MinIO locally), read an array, and verify correct data.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 store in an S3 bucket, **When** the user opens it
   with bucket name and prefix, **Then** the library reads metadata and
   chunks via S3 API and returns correct array data.
2. **Given** S3 credentials configured via environment variables, **When**
   the user creates an S3 store without explicit credentials, **Then** the
   library uses the default credential chain (env vars, profile, IAM role).
3. **Given** an S3-compatible endpoint (e.g., MinIO), **When** the user
   provides a custom endpoint URL, **Then** the library connects to that
   endpoint instead of AWS.
4. **Given** an S3 key that does not exist, **When** the library tries to
   fetch it, **Then** a descriptive error is thrown including bucket,
   key, and HTTP status.

---

### User Story 6 - Extensible Codec and Store Registry (Priority: P3)

A library consumer needs to add support for a custom compression codec
(e.g., a proprietary compressor) or a custom storage backend (e.g., Google
Cloud Storage) without modifying the library source code. They implement
the codec or store interface and register it.

**Why this priority**: Extensibility ensures the library can grow with
the community. Delivered last as it depends on stable core interfaces.

**Independent Test**: Implement a mock codec and mock store, register them,
and use them to open and read a Zarr array.

**Acceptance Scenarios**:

1. **Given** a custom codec implementing the Codec interface, **When** the
   user registers it with a compressor ID string, **Then** arrays using
   that compressor are automatically decoded with the custom codec.
2. **Given** a custom store implementing the Store interface, **When** the
   user passes it to the open function, **Then** the library uses it for
   all key lookups and data fetches.
3. **Given** an array with an unregistered compressor ID, **When** the user
   tries to read it, **Then** a clear error is thrown naming the missing
   codec and suggesting registration.

---

### Edge Cases

- What happens when a chunk file is missing from disk but referenced by metadata?
  The library MUST use the array's fill_value to generate a typed array of
  fill values for that chunk (Zarr spec behavior for missing chunks).
- What happens when the .zarray metadata contains an unsupported dtype?
  The library MUST throw a descriptive error listing supported dtypes.
- What happens when chunk data is corrupted (decompression fails)?
  The library MUST throw an error identifying the specific chunk coordinates
  and the decompression error.
- What happens when the array uses a dimension separator other than "."?
  The library MUST respect the dimension_separator field in .zarray metadata
  (supporting both "." and "/" separators).
- What happens when the Zarr store uses C-order vs F-order memory layout?
  The library MUST correctly handle both "C" and "F" order when assembling
  chunks into the output typed array.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Library MUST parse Zarr v2 metadata files (.zarray, .zgroup,
  .zattrs) and expose structured metadata objects.
- **FR-002**: Library MUST map Zarr v2 dtype strings to the correct
  TypedArray subtype (int8, uint8, int16, uint16, int32, uint32, float32,
  float64 at minimum). Library MUST support both little-endian (`<`) and
  big-endian (`>`) byte orders, transparently byte-swapping big-endian
  data to native little-endian before returning typed arrays.
- **FR-003**: Library MUST support reading chunked arrays by resolving
  chunk keys from array indices, fetching chunk data from the store, and
  assembling into a contiguous typed array.
- **FR-004**: Library MUST support gzip decompression of chunks using
  Node.js built-in zlib.
- **FR-005**: Library MUST support reading uncompressed (raw) chunks.
- **FR-006**: Library MUST handle missing chunks by filling with the
  array's declared fill_value.
- **FR-007**: Library MUST support both "C" (row-major) and "F"
  (column-major) memory order.
- **FR-008**: Library MUST support both "." and "/" dimension separators
  for chunk key resolution.
- **FR-009**: Library MUST provide a FileSystem store that reads from
  local directories using Node.js fs/promises.
- **FR-010**: Library MUST provide an HTTP store that fetches data via
  HTTP GET requests with configurable timeout and headers. On transient
  failures (HTTP 429, 503, network errors), the store MUST retry up to
  3 times with exponential backoff before throwing.
- **FR-011**: Library MUST provide an S3 store that reads from S3 buckets
  using the AWS SDK with support for custom endpoints and the default
  credential chain. On transient failures (throttling, network errors),
  the store MUST retry up to 3 times with exponential backoff before
  throwing.
- **FR-012**: Library MUST provide a codec registry allowing users to
  register custom compression codecs by compressor ID.
- **FR-013**: Library MUST provide a store interface that users can
  implement for custom storage backends.
- **FR-014**: Library MUST support slice-based access to read subsets of
  arrays without loading the full data.
- **FR-015**: Library MUST support configurable concurrency limits for
  multi-chunk parallel reads. Default concurrency MUST be 10 concurrent
  chunk fetches. Users MUST be able to override this per-read operation.

### Key Entities

- **Store**: Abstract storage backend providing key-value access to Zarr
  data. Has operations: get (retrieve bytes by key), has (check key
  existence), list (enumerate keys by prefix).
- **ZarrArray**: Represents an opened Zarr v2 array. Contains parsed
  metadata (shape, dtype, chunks, compressor, fill_value, order,
  dimension_separator) and provides data access methods.
- **ZarrGroup**: Represents an opened Zarr v2 group. Contains attributes
  and provides traversal to child arrays and sub-groups.
- **Codec**: Compression/decompression unit. Decodes raw bytes from a
  chunk into uncompressed bytes. Identified by a string ID matching the
  compressor.id field in .zarray metadata.
- **CodecRegistry**: Central registry mapping compressor ID strings to
  Codec factory functions. Pre-populated with built-in codecs, extensible
  by users.
- **Metadata**: Parsed representations of .zarray (array config), .zgroup
  (group marker), and .zattrs (user attributes) files.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can open and read any Zarr v2 array (uncompressed or
  gzip-compressed) from local filesystem in under 5 lines of code.
- **SC-002**: Reading a 100MB chunked array from local filesystem completes
  in under 2 seconds on standard hardware.
- **SC-003**: Library correctly reads 100% of Zarr v2 test fixtures
  generated by the reference Python zarr library, producing byte-identical
  typed arrays.
- **SC-004**: Users can read partial data (slices) from a 1GB array
  without exceeding 100MB memory usage for the library's overhead.
- **SC-005**: All three storage backends (filesystem, HTTP, S3) pass the
  same contract test suite, ensuring consistent behavior.
- **SC-006**: A custom codec or store can be registered and used in under
  10 lines of code.
- **SC-007**: Errors include sufficient context (file path, chunk
  coordinates, HTTP status, compressor ID) for users to diagnose issues
  without debugging library internals.

## Clarifications

### Session 2026-04-03

- Q: Should the library handle big-endian Zarr data or only little-endian? → A: Support both endianness; byte-swap big-endian data transparently.
- Q: What should be the default concurrency limit for parallel chunk reads? → A: Default 10 concurrent chunk fetches, configurable per-read.
- Q: Should HTTP/S3 stores retry on transient failures? → A: Retry up to 3 times with exponential backoff for transient errors (429, 503, network).

## Assumptions

- Target users are Node.js backend developers working with scientific or
  geospatial data who are familiar with the Zarr format concepts.
- Zarr v2 is the initial target; v3 support will be a separate feature.
- Write operations are out of scope for this feature (read-only library).
- The library targets Node.js >= 22 only; no browser compatibility needed.
- Blosc and Zstd codecs will be delivered as separate codec packages or
  in a follow-up iteration; this feature covers raw and gzip only.
- S3 store depends on the user installing @aws-sdk/client-s3 as a peer
  dependency.
- Test fixtures will be generated by a Python script using the zarr-python
  library to ensure cross-implementation correctness.
