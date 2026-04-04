# Implementation Plan: Performance & Ecosystem Improvements

**Branch**: `004-performance-ecosystem` | **Date**: 2026-04-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-performance-ecosystem/spec.md`

## Summary

Seven features across three tiers: (1) Built-in Blosc codec, in-memory
LRU cache, disk cache size limit; (2) Multi-array reads, byte-range
requests; (3) Reference filesystem, Dataset concept. Each feature is
independently implementable. Together they bring zero-config Blosc
support, sub-microsecond cached reads, shared concurrency pools,
partial chunk fetches, kerchunk compatibility, and xarray-style
label-based selection.

## Technical Context

**Language/Version**: TypeScript 5.x with `strict: true`, targeting ES2022
**Primary Dependencies**: `numcodecs` (Blosc), `node:fs/promises`, `node:crypto`, `node:path`
**Storage**: Local filesystem (cache), remote stores (S3, HTTP)
**Testing**: vitest with `@vitest/coverage-v8`
**Target Platform**: Node.js >= 22 (LTS)
**Project Type**: Library (npm package)
**Performance Goals**: Memory cache hit < 0.1ms; byte-range fetch < 10% of full chunk transfer
**Constraints**: Backward compatible with features 001-003; opt-in for all new features
**Scale/Scope**: 6 new modules, 3 modified files, ~800 lines new code

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Read-Only by Design | All features read-only. Cache writes are to LOCAL disk only. ReferenceStore reads byte ranges. Dataset is read-only. | PASS |
| II. TypeScript-First | All code in TypeScript strict. New types: MemoryCacheOptions, ReferenceSpec, Dataset, DatasetSelection. | PASS |
| III. TDD | Tests for each feature: Blosc codec, memory cache, LRU eviction, multi-array, byte-range, reference store, dataset. | PASS |
| IV. Plugin Architecture | Blosc registered via existing CodecRegistry. ReferenceStore implements Store interface. No interface changes. | PASS |
| V. Server-First | Memory cache and byte-range optimize server workloads. Dataset simplifies server-side data pipelines. | PASS |
| VI. Semver | New public API (MemoryCache, ReferenceStore, Dataset) — minor version bump (0.2.0). | PASS |
| VII. Simplicity | Each feature is a focused module. No speculative abstractions. Dataset is the most complex but justified by clear user demand. | PASS |
| Technical Constraints | Node >= 22, ESM-only, numcodecs as only new dependency (already installed). | PASS |

All gates **PASS**. No complexity violations.

## Project Structure

### Documentation (this feature)

```text
specs/004-performance-ecosystem/
├── plan.md              # This file
├── research.md          # Phase 0: design decisions
├── data-model.md        # Phase 1: entities
├── quickstart.md        # Phase 1: usage examples
├── contracts/
│   ├── memory-cache.ts  # MemoryCache interface
│   ├── reference.ts     # ReferenceStore + spec format
│   └── dataset.ts       # Dataset interface
└── tasks.md             # Phase 2: task list
```

### Source Code (changes to repository)

```text
src/
├── codec/
│   └── codec.ts             # MODIFIED: auto-register Blosc
├── cache/
│   ├── memory.ts            # NEW: In-memory LRU chunk cache
│   ├── disk.ts              # MODIFIED: add maxSizeBytes + LRU eviction
│   └── cached-store.ts      # MODIFIED: integrate memory cache layer
├── store/
│   ├── store.ts             # MODIFIED: add optional getRange() method
│   ├── http.ts              # MODIFIED: implement getRange() with Range header
│   ├── s3.ts                # MODIFIED: implement getRange() with Range param
│   ├── filesystem.ts        # MODIFIED: implement getRange() with read position
│   └── reference.ts         # NEW: kerchunk-style reference filesystem store
├── chunk/
│   └── loader.ts            # MODIFIED: use byte-range for uncompressed + memory cache
├── group.ts                 # MODIFIED: add readMultiple() method
├── dataset.ts               # NEW: Dataset class with label-based selection
├── coordinates.ts           # NEW: coordinate lookup + nearest-neighbor
└── index.ts                 # MODIFIED: export new types and classes

tests/
├── unit/
│   ├── memory-cache.test.ts # NEW
│   ├── disk-cache-lru.test.ts # NEW (extends existing)
│   ├── coordinates.test.ts  # NEW
│   └── blosc-builtin.test.ts # NEW
└── integration/
    ├── multi-array.test.ts  # NEW
    ├── byte-range.test.ts   # NEW
    ├── reference.test.ts    # NEW
    └── dataset.test.ts      # NEW
```

**Structure Decision**: Extends existing directory structure. New `src/dataset.ts` and `src/coordinates.ts` for Tier 3. New `src/store/reference.ts` for kerchunk. All other changes modify existing files.

## Complexity Tracking

> No violations. Each feature is a focused module with clear boundaries.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | —          | —                                   |
