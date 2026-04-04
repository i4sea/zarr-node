# Data Model: Performance & Ecosystem Improvements

**Phase**: 1 (Design & Contracts)
**Date**: 2026-04-04

## New Entities

### MemoryCache

In-memory LRU cache for decoded chunk data.

**Attributes**:
- `maxBytes`: number — Maximum total cache size in bytes
- `totalBytes`: number — Current total size of cached entries
- Internal map: `Map<string, Uint8Array>` — LRU-ordered by insertion

**Operations**:
- `get(key: string)` → `Uint8Array | null` — Return cached chunk, update LRU order
- `set(key: string, data: Uint8Array)` → `void` — Cache chunk, evict if over limit
- `clear()` → `void` — Remove all entries
- `size` → `number` — Current number of entries

### ReferenceStore

Store implementation backed by a kerchunk-style JSON manifest.

**Attributes**:
- `refs`: Map<string, string | [string, number, number]> — Key→reference mapping
- Internal store pool: Map<string, Store> — Cached inner stores per URL scheme/prefix

**Operations**:
- `get(key: string)` → `Promise<Uint8Array | null>` — Resolve reference and fetch
- `has(key: string)` → `Promise<boolean>` — Check if key in refs
- `list(prefix: string)` → `AsyncIterable<string>` — Enumerate keys from refs

### Dataset

High-level wrapper around a ZarrGroup with dimension-aware selection.

**Attributes**:
- `group`: ZarrGroup — Underlying group
- `dims`: Map<string, string> — Dimension name → coordinate array name
- `coords`: Map<string, TypedArray> — Cached coordinate arrays
- `variables`: Map<string, ZarrArray> — Data variable arrays

**Operations**:
- `sel(selection: Record<string, number>)` → `Promise<Map<string, TypedArray>>` — Select by coordinate values
- `variables` → Iterable of variable names
- `dims` → Iterable of dimension names

### ReferenceSpec

Parsed kerchunk v1 JSON manifest.

**Attributes**:
- `version`: 1
- `refs`: Record<string, string | [string] | [string, number, number]>

## Modified Entities

### Store (interface — modified)

**New optional method**:
- `getRange?(key: string, offset: number, length: number)` → `Promise<Uint8Array | null>`

### DiskCache (modified)

**New attribute**:
- `maxSizeBytes`: number | null — Maximum cache directory size

**New operation**:
- `evictLRU()` → `Promise<void>` — Remove oldest entries until under size limit

### ZarrGroup (modified)

**New operation**:
- `readMultiple(names: string[], selection?: Slice, options?: ReadOptions)` → `Promise<Map<string, TypedArray>>`

## Entity Relationships

```
Dataset (1) ──wraps──> (1) ZarrGroup
Dataset (1) ──uses──> (N) ZarrArray (variables)
Dataset (1) ──caches──> (N) TypedArray (coordinates)
ReferenceStore (1) ──resolves──> (N) byte-range references
ReferenceStore (1) ──delegates──> (N) Store (inner stores per URL scheme)
MemoryCache (1) ──caches──> (N) decoded Uint8Array chunks
```

## Validation Rules

- MemoryCache `maxBytes` MUST be > 0
- DiskCache `maxSizeBytes` if set MUST be > 0
- ReferenceSpec `version` MUST be 1
- Reference arrays MUST have 1 or 3 elements: [url] or [url, offset, length]
- Dataset coordinate arrays MUST be 1D (for binary search) or 2D (for linear scan)
