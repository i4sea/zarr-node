# Data Model: Consolidated Metadata

**Phase**: 1 (Design & Contracts)
**Date**: 2026-04-04

## Entities

### ConsolidatedMetadata

In-memory cache parsed from a `.zmetadata` file. Provides fast key-based
lookup for metadata entries without store round-trips.

**Attributes**:
- Internal map: `Map<string, Uint8Array>` — keys are relative store
  paths (e.g., `"temperature/.zarray"`), values are UTF-8 encoded JSON

**Operations**:
- `get(key: string)` → `Uint8Array | null` — Retrieve cached metadata
  by key. Returns null if key not in cache.
- `has(key: string)` → `boolean` — Check if key exists in cache.
- `listChildren(prefix: string)` → `string[]` — Extract unique direct
  child names under a prefix from cache keys.

**Construction**: `parseConsolidatedMetadata(raw: Uint8Array)` factory
function that parses the `.zmetadata` JSON and returns a
ConsolidatedMetadata instance, or throws MetadataError if malformed.

**Relationships**: Held by ZarrGroup (optional, may be null). Shared
across all sub-groups created from the same root.

## Modified Entities

### ZarrGroup (existing — modified)

**New attribute**:
- `consolidatedMeta`: `ConsolidatedMetadata | null` — Cache instance,
  or null if `.zmetadata` was not available.

**Modified operations**:
- `getArray()`, `getGroup()`: Check cache before store.
- `arrays()`, `groups()`: Use `listChildren()` from cache when available
  instead of `store.list()` + `store.has()`.
- `contains()`: Check cache before store.

### open/openGroup (existing — modified)

**Modified behavior**:
- On group open, attempt `store.get(".zmetadata")` first.
- If present, parse and pass cache to ZarrGroup.
- If absent (null), pass null cache — no behavior change.

## Validation Rules

- `.zmetadata` must contain a `"metadata"` top-level key.
- Values under `"metadata"` must be valid JSON objects.
- Malformed `.zmetadata` must throw MetadataError (not silently ignored).
