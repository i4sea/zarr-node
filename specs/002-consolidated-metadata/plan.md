# Implementation Plan: Consolidated Metadata (.zmetadata)

**Branch**: `002-consolidated-metadata` | **Date**: 2026-04-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-consolidated-metadata/spec.md`

## Summary

Add support for Zarr v2 consolidated metadata (`.zmetadata`) to eliminate
per-file metadata requests when opening groups and arrays. On first group
access, the library attempts to load `.zmetadata`; if present, all
subsequent metadata lookups (`.zarray`, `.zgroup`, `.zattrs`) are served
from an in-memory cache. Falls back transparently to per-file fetching
when consolidated metadata is absent.

## Technical Context

**Language/Version**: TypeScript 5.x with `strict: true`, targeting ES2022
**Primary Dependencies**: None new — uses existing Store interface and metadata parser
**Storage**: N/A (reads `.zmetadata` from existing Store backends)
**Testing**: vitest with `@vitest/coverage-v8`; existing Python zarr fixtures + new consolidated fixture
**Target Platform**: Node.js >= 22 (LTS)
**Project Type**: Library (npm package) — internal optimization, no public API changes
**Performance Goals**: Group listing from 40+ seconds to < 2 seconds on remote stores; single metadata request per store open
**Constraints**: Cache must be memory-only, no disk persistence; must not break existing per-file behavior
**Scale/Scope**: Single new module + modifications to group.ts and index.ts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Read-Only by Design | Only reads `.zmetadata`, no write operations. | PASS |
| II. TypeScript-First | All new code in TypeScript strict. No `any` in public API. | PASS |
| III. TDD | Unit tests for consolidated parser. Integration tests with fixtures. | PASS |
| IV. Plugin Architecture | No change to Store/Codec interfaces. Cache is internal. | PASS |
| V. Server-First | Reduces network round-trips — direct server performance improvement. | PASS |
| VI. Semver | No public API changes — patch-level change (0.x.y). | PASS |
| VII. Simplicity | Single cache class. No speculative features. Transparent fallback. | PASS |
| Technical Constraints | Node >= 22, ESM-only, no new dependencies. | PASS |
| Development Workflow | vitest, eslint, prettier, conventional commits. | PASS |

All gates **PASS**. No complexity violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-consolidated-metadata/
├── plan.md              # This file
├── research.md          # Phase 0: .zmetadata format research
├── data-model.md        # Phase 1: ConsolidatedMetadata entity
├── quickstart.md        # Phase 1: usage (transparent — no code changes)
└── tasks.md             # Phase 2: task list (/speckit.tasks)
```

### Source Code (changes to existing repository)

```text
src/
├── metadata/
│   ├── consolidated.ts  # NEW: Parse & cache .zmetadata
│   ├── types.ts         # UNCHANGED
│   └── v2.ts            # UNCHANGED
├── group.ts             # MODIFIED: Use consolidated cache for lookups
├── index.ts             # MODIFIED: Load .zmetadata on open/openGroup
└── ...                  # All other files UNCHANGED

tests/
├── fixtures/
│   └── consolidated/    # NEW: Fixture with .zmetadata file
├── unit/
│   └── consolidated.test.ts  # NEW: Parser tests
└── integration/
    └── array.test.ts    # EXTENDED: Consolidated metadata tests
```

**Structure Decision**: No new directories beyond `src/metadata/consolidated.ts` and test fixtures. Minimal footprint — one new module, two modified files.

## Complexity Tracking

> No violations. Single-module optimization with transparent fallback.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | —          | —                                   |
