# Implementation Plan: Efficient Polygon-Based Spatial Reading (Streaming bbox + mask)

**Branch**: `007-polygon-reader` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-polygon-reader/spec.md`

## Summary

Add a generic, domain-neutral polygon reader to the `@i4sea/zarr-node/spatial` sub-package. Given a `ZarrArray` shaped `[time, ...spatial]` and a lat/lon polygon, it streams one time step at a time via an async generator, yielding only the cells geometrically inside the polygon (ray-casting mask, concave-correct), in row-major bounding-box order. It reads the selection as bounding-box blocks so each backing-store chunk is downloaded/decompressed at most once, and (because chunks typically span the full time axis) reuses decoded chunks across time steps via the existing `MemoryCache`, keeping working memory bounded to ~one time slice. A companion `resolvePolygonCells` exposes the time-invariant selection (cells + positions + bbox + applied stride) without reading values. Coordinate → index resolution supports three layouts: 1-D rectilinear (binary search), 2-D curvilinear (reuse `GridIndex`), and unstructured npoints (flat point-in-polygon filter). An optional `maxCells` budget triggers a clamped spatial stride.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`), targeting ES2022, ESM-only
**Primary Dependencies**: None new. Reuses in-repo `ZarrArray.get` (block reads), `MemoryCache` (chunk reuse), `GridIndex` (2-D curvilinear lookup), `ReadOptions`/`ObservabilityHooks`, `SliceError`. Node built-ins only.
**Storage**: N/A (reads through existing `Store` backends — FS/HTTP/S3; no new backend)
**Testing**: Vitest (unit tests under `tests/unit/`, matching existing `grid-index.test.ts`)
**Target Platform**: Node.js >= 22, server-side
**Project Type**: Single library (spatial sub-package)
**Performance Goals**: Each bbox-overlapping chunk fetched/decompressed at most once per read (SC-001); working memory bounded to ~one time slice regardless of time extent (SC-002); area read replaces N point reads with O(chunks) block reads (SC-007)
**Constraints**: Read-only; no `any` in public signatures; generic dtype flow preserved; no default `maxCells` cap; stride clamped so a non-empty polygon never yields zero cells
**Scale/Scope**: One new module (`src/spatial/polygon-reader.ts`), ~2 public functions + supporting types, exported from `src/spatial/index.ts`. Point-read path untouched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Read-Only by Design | ✅ PASS | Pure read path; uses only `ZarrArray.get`. No write surface introduced. |
| II. TypeScript-First | ✅ PASS | All new APIs fully typed, no `any`. Values delivered as `Float64Array` (see research: dtype-normalization decision) — a deliberate, documented narrowing for the aggregation use case, not an `any` escape. |
| III. TDD (NON-NEGOTIABLE) | ✅ PASS | Tests-first for point-in-polygon (concave/hole), per-layout bbox resolution, stride clamp, streaming order, and "chunk read once" (instrumented store). Mirrors existing `grid-index.test.ts` fixture style. |
| IV. Extensible Plugin Architecture | ✅ PASS | No Store/Codec changes. Layout resolution is a discriminated union, open to the three spec'd layouts; adds no hardcoded backend assumptions. |
| V. Server-First Performance | ✅ PASS | Block reads + `MemoryCache` reuse; forwards `concurrency`/`maxInFlightBytes`/`observability`. A perf assertion (chunk-read-count) guards the critical path per CI benchmark discipline. |
| VI. Semantic Versioning & API Stability | ✅ PASS | Additive only → new minor (0.9.0). Changeset + CHANGELOG entry required. No existing signature changes. |
| VII. Simplicity (YAGNI) | ✅ PASS | Smallest useful surface: two functions (`readPolygon`, `resolvePolygonCells`) + types. Aggregation, multi-grid stitching, antimeridian wrapping, and point-path consolidation all explicitly deferred (spec Out of Scope). Functions over classes — no stateful abstraction needed. |

**Result**: PASS — no violations. Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/007-polygon-reader/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── polygon-reader.api.md   # Public API contract (types + function signatures)
├── checklists/
│   └── requirements.md  # From /speckit.specify
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── spatial/
│   ├── grid-index.ts        # EXISTING — reused for 2-D curvilinear bbox
│   ├── polygon-reader.ts    # NEW — readPolygon, resolvePolygonCells, types, ray-casting
│   └── index.ts             # MODIFIED — re-export new public API
├── array.ts                 # UNCHANGED — ZarrArray.get, ReadOptions, Slice (consumed)
├── cache/memory.ts          # UNCHANGED — MemoryCache (consumed for chunk reuse)
├── errors.ts                # UNCHANGED — SliceError reused for invalid inputs
└── index.ts                 # UNCHANGED — spatial ships via the "./spatial" subpath export

tests/
└── unit/
    ├── grid-index.test.ts       # EXISTING — reference for style/fixtures
    └── polygon-reader.test.ts   # NEW — point-in-polygon, per-layout, stride, streaming, chunk-once

package.json                 # MODIFIED — version bump 0.8.0 → 0.9.0 (minor)
.changeset/                  # NEW — changeset entry (minor)
```

**Structure Decision**: Single-project library. The spatial capability is published as a dedicated **subpath export** `@i4sea/zarr-node/spatial` (see `package.json` `exports["./spatial"]`), NOT via the root `src/index.ts`. The new module therefore lives in `src/spatial/polygon-reader.ts` beside `grid-index.ts` and is re-exported from `src/spatial/index.ts`. (The source issue's "exported in `src/index.ts`" is superseded — the correct barrel is `src/spatial/index.ts`; documented in research.md.)

## Complexity Tracking

> No Constitution violations — section intentionally empty.
