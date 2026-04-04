# Implementation Plan: Disk Chunk Cache

**Branch**: `003-disk-chunk-cache` | **Date**: 2026-04-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-disk-chunk-cache/spec.md`

## Summary

Add an opt-in disk cache layer for chunk data fetched from remote stores
(HTTP, S3). On first read, chunks are saved to a local directory; subsequent
reads serve from disk. Implements a CachedStore wrapper around any Store,
with atomic writes, optional TTL, and graceful failure handling. Inspired
by fsspec's file caching used with xarray.

## Technical Context

**Language/Version**: TypeScript 5.x with `strict: true`, targeting ES2022
**Primary Dependencies**: `node:fs/promises` (cache I/O), `node:path` (key mapping), `node:crypto` (store identity hash)
**Storage**: Local filesystem for cached chunks
**Testing**: vitest with `@vitest/coverage-v8`
**Target Platform**: Node.js >= 22 (LTS)
**Project Type**: Library (npm package)
**Performance Goals**: Cache hit < 10ms; cache write overhead < 5% of fetch time
**Constraints**: Atomic writes (tmp+rename), no in-memory size limits, graceful fallback on I/O errors
**Scale/Scope**: Two new modules (DiskCache, CachedStore) + public API addition for cache config

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Read-Only by Design | Store interface unchanged — CachedStore only reads from remote. Cache writes are to LOCAL disk, not to the Zarr store. | PASS |
| II. TypeScript-First | All new code in TypeScript strict. CacheOptions typed. | PASS |
| III. TDD | Unit tests for DiskCache, integration tests for CachedStore. | PASS |
| IV. Plugin Architecture | CachedStore wraps any Store — composable, not hardcoded. Users can wrap custom stores. | PASS |
| V. Server-First | Reduces network I/O for server workloads — direct performance win. | PASS |
| VI. Semver | New public API (CacheOptions) — minor version bump (0.x.0). | PASS |
| VII. Simplicity | Two focused classes. No LRU, no complex eviction — YAGNI for v1. | PASS |
| Technical Constraints | Node >= 22, ESM-only, no new npm dependencies. | PASS |
| Development Workflow | vitest, eslint, prettier, conventional commits. | PASS |

All gates **PASS**. No complexity violations.

## Project Structure

### Documentation (this feature)

```text
specs/003-disk-chunk-cache/
├── plan.md              # This file
├── research.md          # Phase 0: cache design research
├── data-model.md        # Phase 1: DiskCache + CachedStore entities
├── quickstart.md        # Phase 1: usage examples
├── contracts/
│   └── cache.ts         # Phase 1: CacheOptions + CachedStore interface
└── tasks.md             # Phase 2: task list
```

### Source Code (changes to repository)

```text
src/
├── cache/
│   ├── disk.ts          # NEW: DiskCache — file-based chunk storage
│   └── cached-store.ts  # NEW: CachedStore — Store wrapper with caching
├── index.ts             # MODIFIED: export CachedStore, CacheOptions
└── ...                  # All other files UNCHANGED

tests/
├── unit/
│   └── disk-cache.test.ts    # NEW: DiskCache tests
└── integration/
    └── cached-store.test.ts  # NEW: CachedStore integration tests
```

**Structure Decision**: New `src/cache/` directory for cache-related modules. Minimal footprint — two new files, one modified export file.

## Complexity Tracking

> No violations. Two focused modules with clear responsibilities.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | —          | —                                   |
