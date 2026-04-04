# Feature Specification: Disk Chunk Cache

**Feature Branch**: `003-disk-chunk-cache`
**Created**: 2026-04-04
**Status**: Draft
**Input**: User description: "vamos implementar uma camada de cache em disco para nao precisar fazer refetch de chuncks ja baixados, similar ao que o ffspec faz com o xarray"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cache Chunks on Disk for Repeated Reads (Priority: P1)

A data engineer runs a daily pipeline that reads the same Zarr v2 arrays
from S3 multiple times (e.g., different analysis passes, debugging,
iterative exploration). Currently, every read fetches chunks from S3 again,
even if the data hasn't changed. With a disk cache, the first read
downloads chunks from the remote store and saves them locally; subsequent
reads serve chunks from the local cache instantly, similar to how
fsspec's caching works with xarray.

**Why this priority**: This is the core value — avoid redundant network
fetches for data that was already downloaded. Directly reduces cost (S3
GET requests), latency, and bandwidth usage.

**Independent Test**: Read an array from a remote store twice. Verify
the first read fetches from the store and the second read serves from
cache without any network requests.

**Acceptance Scenarios**:

1. **Given** a remote Zarr v2 store and a configured disk cache, **When**
   the user reads an array for the first time, **Then** chunks are fetched
   from the remote store and saved to the cache directory.
2. **Given** a previously cached chunk, **When** the user reads the same
   array region again, **Then** the chunk is served from disk with no
   network request.
3. **Given** a configured disk cache, **When** the user reads a chunk
   that is NOT in cache, **Then** the library fetches it from the remote
   store, returns the data, and writes it to cache for future use.

---

### User Story 2 - Opt-in Cache Configuration (Priority: P1)

A developer wants to control whether and where disk caching is used.
The cache is opt-in — disabled by default. The user enables it by
providing a cache directory when creating a store or opening a group.
No code changes are needed beyond passing a configuration option.

**Why this priority**: Caching must be explicit to avoid surprises
(stale data, unexpected disk usage). Users who don't need caching
should see zero behavior change.

**Independent Test**: Open a store without cache config — verify no
cache files are created. Open with cache config — verify cache files
appear in the specified directory.

**Acceptance Scenarios**:

1. **Given** a store opened without cache configuration, **When** the
   user reads data, **Then** no caching occurs and behavior is identical
   to current library behavior.
2. **Given** a store opened with a cache directory path, **When** the
   user reads chunks, **Then** chunks are cached in that directory.
3. **Given** a cache directory, **When** the user inspects the directory,
   **Then** cached chunks are stored in a human-understandable structure
   (e.g., mirroring the Zarr key hierarchy).

---

### User Story 3 - Cache Expiration and Invalidation (Priority: P2)

A researcher works with Zarr data that is updated periodically (e.g.,
new forecast runs replace old data at the same S3 path). They need a
way to control cache freshness — either via a time-to-live (TTL) setting
or by manually clearing the cache.

**Why this priority**: Without invalidation, cached data can become stale.
TTL provides automatic freshness; manual clear provides full control.

**Independent Test**: Set a TTL, wait for it to expire, read again —
verify the chunk is re-fetched from the remote store.

**Acceptance Scenarios**:

1. **Given** a cache with a TTL of N seconds, **When** a cached chunk is
   older than N seconds, **Then** the library re-fetches it from the
   remote store and updates the cache.
2. **Given** a cache with no TTL (default), **When** a chunk is in cache,
   **Then** it is served from cache indefinitely until manually cleared.
3. **Given** a populated cache directory, **When** the user calls a
   clear method, **Then** all cached chunks are removed.

---

### User Story 4 - Cache Works Across Sessions (Priority: P2)

A data engineer closes their application and restarts it later. The
disk cache persists between sessions — previously cached chunks are
available immediately without re-downloading.

**Why this priority**: Disk caching only makes sense if it survives
process restarts. This distinguishes it from in-memory caching.

**Independent Test**: Read data with cache enabled, terminate the
process, start a new process, read the same data — verify it comes
from cache.

**Acceptance Scenarios**:

1. **Given** a populated cache from a previous session, **When** a new
   process opens the same store with the same cache directory, **Then**
   previously cached chunks are served from disk.

---

### Edge Cases

- What happens when the cache directory does not exist?
  The library MUST create it automatically (including parent directories).
- What happens when disk space runs out while writing a cache entry?
  The library MUST catch the write error, discard the partial cache
  entry, and continue serving the chunk from the original fetch. No
  error should propagate to the user.
- What happens when two processes use the same cache directory
  simultaneously?
  The library MUST handle concurrent access safely by using atomic
  writes (write to temp file, then rename).
- What happens when the cache directory is on a read-only filesystem?
  The library MUST detect the failure on first write attempt and
  silently disable caching for the session, serving all reads from
  the remote store.
- What happens when a cached file is corrupted?
  The library MUST detect read failures, delete the corrupt entry,
  and re-fetch from the remote store transparently.
- What happens when multiple concurrent reads request the same chunk?
  The library MUST coalesce them into a single network fetch. For
  example, 4 parallel slice reads hitting chunk "lat/0.0" MUST result
  in only 1 S3 GET request, not 4 (thundering herd protection).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Library MUST provide an opt-in disk caching mechanism for
  chunk data fetched from remote stores (HTTP, S3).
- **FR-002**: Disk cache MUST be disabled by default. Users enable it by
  providing a cache directory path.
- **FR-003**: When cache is enabled and a chunk is requested, the library
  MUST check the disk cache first; on miss, fetch from store and write
  to cache before returning.
- **FR-004**: Cached chunks MUST be stored in a directory structure that
  mirrors the Zarr store key hierarchy for debuggability.
- **FR-005**: Cache MUST persist across process restarts (disk-based,
  not in-memory only).
- **FR-006**: Library MUST support an optional TTL (time-to-live) for
  cached entries. When TTL is set and a cached entry is older than TTL,
  the library MUST re-fetch from the remote store.
- **FR-007**: Library MUST provide a method to clear all cached entries
  for a given store.
- **FR-008**: Cache writes MUST be atomic (write to temporary file, then
  rename) to prevent corruption from concurrent access or crashes.
- **FR-009**: Cache MUST NOT apply to local filesystem stores — only
  remote stores (HTTP, S3) benefit from caching.
- **FR-010**: Cache failures (disk full, permissions, corruption) MUST
  NOT propagate as errors to the user. The library MUST fall back to
  direct remote reads silently.
- **FR-011**: When multiple concurrent reads request the same chunk key,
  the library MUST deduplicate in-flight requests so that only one
  network fetch is made. All concurrent callers MUST receive the result
  of that single fetch (thundering herd protection).

### Key Entities

- **DiskCache**: Manages reading and writing chunk data to a local
  directory. Provides get/set operations keyed by store path + chunk key.
  Handles TTL expiration and atomic writes.
- **CachedStore**: A store wrapper that intercepts `get()` calls, checks
  DiskCache first, and delegates to the underlying store on cache miss.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Second read of the same chunk from a remote store completes
  in under 10ms (vs hundreds of milliseconds for a network fetch).
- **SC-002**: Cache hit rate reaches 100% for repeated reads of the same
  data region within TTL.
- **SC-003**: All existing tests continue to pass without modification
  (cache is opt-in, default behavior unchanged).
- **SC-004**: Cache survives process restart — chunks cached in session A
  are available in session B without re-fetching.

## Assumptions

- Users have local disk space available for caching (typically 1-10GB
  for scientific datasets; no built-in size limit in v1).
- Cache directory path is provided by the user; the library does not
  choose a default location (avoids surprising disk usage).
- Cache key includes enough context (store identity + chunk key) to
  avoid collisions between different remote stores using the same
  cache directory.
- Metadata files (.zarray, .zgroup, .zattrs) are NOT cached on disk —
  they are already handled by consolidated metadata (feature 002). Only
  chunk data is disk-cached.
- A cache size limit (LRU eviction) is out of scope for v1 but may be
  added in a future iteration.
