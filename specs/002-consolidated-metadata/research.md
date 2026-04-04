# Research: Consolidated Metadata (.zmetadata)

**Phase**: 0 (Outline & Research)
**Date**: 2026-04-04

## .zmetadata File Format

### Decision: Parse standard Zarr v2 consolidated metadata JSON

**Rationale**: The `.zmetadata` file is a Zarr v2 convention created by
`zarr.convenience.consolidate_metadata()` in Python and automatically by
xarray's `to_zarr()`. It contains all metadata for the entire store in a
single JSON file.

**Format**:
```json
{
  "metadata": {
    ".zattrs": {},
    ".zgroup": { "zarr_format": 2 },
    "array_name/.zarray": { "shape": [...], "dtype": "...", ... },
    "array_name/.zattrs": { "units": "K", ... },
    "group/subgroup/.zgroup": { "zarr_format": 2 },
    "group/subgroup/.zattrs": { "depth": 1 }
  }
}
```

**Key details**:
- Top-level key is always `"metadata"`
- Keys are relative paths from store root (no leading `/`)
- Values are the parsed JSON content of each metadata file
- Includes `.zarray`, `.zgroup`, and `.zattrs` entries
- Does NOT include chunk data keys — only metadata

**Alternatives considered**: None — this is the only consolidated metadata
format in Zarr v2. Zarr v3 uses a different mechanism (not in scope).

## Cache Design

### Decision: Store-wrapping approach with metadata overlay

**Rationale**: Rather than modifying every callsite, create a
`ConsolidatedMetadata` class that acts as a metadata cache. When a
metadata key (`.zarray`, `.zgroup`, `.zattrs`) is requested, check the
cache first; if not found, delegate to the underlying store.

**Approach**:
- Parse `.zmetadata` once into a `Map<string, Uint8Array>` where keys
  match store key format and values are UTF-8 encoded JSON strings
- Provide `get(key)` and `has(key)` that mirror Store interface
- ZarrGroup receives the cache and uses it for metadata lookups
- For child discovery (arrays/groups iteration), derive child names
  from the cache keys instead of calling `store.list()`

**Alternatives considered**:
- Wrapping Store entirely (proxy pattern): More complex, would need to
  handle chunk reads too. Rejected per YAGNI — only metadata needs caching.
- Modifying Store interface to add cache: Would break plugin architecture
  (Constitution IV). Rejected.

## Child Discovery from Cache

### Decision: Derive children from consolidated metadata keys

**Rationale**: Currently `arrays()` and `groups()` call `store.list()`
then `store.has()` for each child — the main performance bottleneck.
With consolidated metadata, we can extract child names directly from
the cache keys.

**Approach**: From cache keys like `"temperature/.zarray"` and
`"level1/.zgroup"`, extract the first path segment before the first `/`
to get child names. Then check for `.zarray` or `.zgroup` suffix to
classify as array or group.

## Loading Strategy

### Decision: Eager load on group open, lazy fallback

**Rationale**: Load `.zmetadata` once when `openGroup()` or `open()`
creates a root group. If `.zmetadata` is absent (returns null), set
cache to null and all subsequent operations fall through to per-file
fetching. No retry, no periodic refresh.

**Key details**:
- `.zmetadata` is always at store root (not at sub-group paths)
- Loading happens in `openGroupFromMeta()` in index.ts
- The cache reference is passed to ZarrGroup constructor
- Sub-groups created via `getGroup()` share the same cache instance
- `openArray()` also benefits when called via a group with cache

## Fixture Generation

### Decision: Generate consolidated fixture from existing nested_groups

**Rationale**: Use the existing `nested_groups` fixture structure and add
a `.zmetadata` file that consolidates all its metadata. This allows
testing consolidated vs non-consolidated behavior with the same data.

Additionally, test against the real WRF dataset on S3 which already has
`.zmetadata`.
