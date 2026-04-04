# Feature Specification: Consolidated Metadata (.zmetadata)

**Feature Branch**: `002-consolidated-metadata`
**Created**: 2026-04-03
**Status**: Draft
**Input**: User description: "otimização com .zmetadata consolidado"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fast Group Discovery via Consolidated Metadata (Priority: P1)

A data engineer opens a remote Zarr v2 store (HTTP or S3) containing dozens
of arrays. Currently, listing all arrays requires one `list()` call followed
by a `has()` call for each potential child — resulting in many round-trips
to the remote store. With consolidated metadata support, the library reads
a single `.zmetadata` file on first access and uses the cached metadata
for all subsequent operations, reducing dozens of network requests to one.

**Why this priority**: This is the core optimization. Remote stores (S3,
HTTP) are the primary use case for consolidated metadata. The 40+ second
listing time observed on a real WRF dataset drops to under 1 second.

**Independent Test**: Open a remote Zarr v2 store that contains a
`.zmetadata` file. List all arrays and verify the same results as
non-consolidated access, but with only a single network request for
metadata.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 store with a `.zmetadata` file, **When** the user
   opens the root group and lists arrays, **Then** the library fetches
   `.zmetadata` once and returns all arrays without additional metadata
   requests.
2. **Given** a Zarr v2 store with a `.zmetadata` file containing 19
   arrays, **When** the user lists all arrays, **Then** the operation
   completes in under 2 seconds on a remote store (vs 40+ seconds
   without consolidation).
3. **Given** a Zarr v2 store with a `.zmetadata` file, **When** the user
   opens a specific array by name, **Then** the metadata is served from
   the consolidated cache without fetching individual `.zarray`/`.zattrs`
   files.

---

### User Story 2 - Transparent Fallback for Stores Without Consolidated Metadata (Priority: P1)

A data engineer uses the library against both modern stores (with
`.zmetadata`) and legacy stores (without it). The library automatically
detects whether consolidated metadata is available and falls back to
per-file metadata fetching when it is not, without any change to user code.

**Why this priority**: Users should not need to know or care whether a
store uses consolidated metadata. The optimization must be transparent.

**Independent Test**: Open a Zarr v2 store that does NOT have a
`.zmetadata` file. Verify that all operations work identically to the
current behavior.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 store without `.zmetadata`, **When** the user
   opens the root group and lists arrays, **Then** the library falls back
   to per-file metadata fetching and all operations work correctly.
2. **Given** a Zarr v2 store without `.zmetadata`, **When** the
   `.zmetadata` fetch returns 404/null, **Then** no error is thrown and
   the library proceeds silently.

---

### User Story 3 - Navigate Deep Group Hierarchies Efficiently (Priority: P2)

A researcher works with a Zarr v2 store organized in nested groups (e.g.,
`/model/forecast/temperature`). With consolidated metadata, navigating
the entire hierarchy — listing groups, sub-groups, and arrays at each
level — requires zero additional network requests after the initial
`.zmetadata` load.

**Why this priority**: Builds on US1 to cover hierarchical stores. Most
real-world scientific datasets use group hierarchies.

**Independent Test**: Open a store with nested groups, navigate the full
hierarchy, and verify all metadata is resolved from the consolidated
cache.

**Acceptance Scenarios**:

1. **Given** a Zarr v2 store with nested groups and `.zmetadata`, **When**
   the user traverses the full group tree, **Then** no additional metadata
   requests are made beyond the initial `.zmetadata` fetch.
2. **Given** a consolidated metadata cache, **When** the user accesses
   `.zattrs` at any level of the hierarchy, **Then** attributes are
   returned from cache.

---

### Edge Cases

- What happens when `.zmetadata` exists but is malformed JSON?
  The library MUST throw a descriptive error and NOT fall back to
  per-file fetching (malformed consolidated metadata indicates a
  corrupt store, not an absent feature).
- What happens when `.zmetadata` is present but incomplete (missing
  some arrays)?
  The library MUST use consolidated metadata for entries present and
  fall back to per-file fetching for entries not found in the cache.
- What happens when `.zmetadata` is very large (e.g., thousands of
  arrays)?
  The library MUST parse it once and cache the result in memory for
  the lifetime of the group object.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Library MUST attempt to read `.zmetadata` when opening a
  group, before any per-file metadata access.
- **FR-002**: Library MUST parse the `.zmetadata` JSON format:
  a top-level `"metadata"` object whose keys are relative paths
  (e.g., `"array_name/.zarray"`) and values are parsed JSON objects.
- **FR-003**: When consolidated metadata is available, `getArray()`,
  `getGroup()`, `arrays()`, `groups()`, and `contains()` on ZarrGroup
  MUST resolve metadata from the cache without making additional store
  requests.
- **FR-004**: When consolidated metadata is NOT available (`.zmetadata`
  returns null/404), the library MUST fall back to the current per-file
  behavior transparently.
- **FR-005**: When consolidated metadata is available but a specific
  entry is not found in the cache, the library MUST fall back to
  per-file fetching for that entry only.
- **FR-006**: The `open()`, `openArray()`, and `openGroup()` entry
  functions MUST benefit from consolidated metadata when opening arrays
  or groups by path.
- **FR-007**: Consolidated metadata MUST be loaded at most once per
  group root, regardless of how many operations are performed.
- **FR-008**: Library MUST correctly handle the consolidated metadata
  format produced by `zarr.convenience.consolidate_metadata()` from
  the Python zarr library and by xarray's `to_zarr()`.

### Key Entities

- **ConsolidatedMetadata**: In-memory cache of all `.zarray`, `.zgroup`,
  and `.zattrs` entries parsed from `.zmetadata`. Provides key-based
  lookup matching the store's `get()` interface for metadata keys.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Listing all arrays in a remote store with 19+ arrays
  completes in under 2 seconds (vs 40+ seconds without consolidation).
- **SC-002**: Opening and reading a specific array from a remote store
  with consolidated metadata requires at most 1 network request for
  metadata (the `.zmetadata` file itself).
- **SC-003**: All existing tests continue to pass without modification
  (backward compatibility).
- **SC-004**: Stores without `.zmetadata` show no performance regression.

## Assumptions

- Zarr v2 consolidated metadata format is stable and follows the
  structure `{"metadata": {"path/.zarray": {...}, ...}}`.
- `.zmetadata` files are small enough to fit in memory (typically
  < 1MB even for stores with hundreds of arrays).
- Consolidated metadata is read-only — the library does not generate
  or update `.zmetadata` files (consistent with the read-only
  constitution principle).
- The `.zmetadata` file is always located at the store root, not at
  sub-group paths.
