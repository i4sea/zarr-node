# Contract: Metadata Layout & Detection

**Feature**: 006-zarr-v3-reader

Defines the seam that resolves format, detects array-vs-group, and builds metadata keys — the one
place that knows about `zarr.json` vs `.zarray`/`.zgroup`. Consumed by `open.ts` and `group.ts`.

## Public API impact

**None.** `open`/`openArray`/`openGroup`/`ZarrArray`/`ZarrGroup` signatures are unchanged (FR-002,
Principle VI). This is an internal abstraction.

## Detection contract

```
detectNode(store, path) → { format: 2|3, nodeType: "array"|"group", raw: bytes }
```

- Probe `zarr.json` at `path`. If present → parse `node_type` → return `{format:3, nodeType, raw}`.
- Else probe `.zarray` → `{format:2, nodeType:"array"}`; else `.zgroup` → `{format:2, nodeType:"group"}`.
- Else → `MetadataError` (node not found).
- **Precedence**: if both `zarr.json` and `.zarray`/`.zgroup` exist at the same node, v3 wins
  (documented deterministic rule; degenerate case).

**Given/When/Then**
- Given a node with `zarr.json` (`node_type: array`), When `detectNode`, Then `{format:3, nodeType:"array"}`.
- Given a node with `.zgroup` only, When `detectNode`, Then `{format:2, nodeType:"group"}`.
- Given a node with neither, When `detectNode`, Then `MetadataError`.
- Given a node with an unknown `zarr_format` in `zarr.json`, When parsed, Then `MetadataError`
  (not silently misread) — spec Edge Case.

## Key construction contract

`layout` owns metadata-key naming so no call site hard-codes `.zarray`/`zarr.json`:
- v2 keys: `.zarray`, `.zgroup`, `.zattrs`, `.zmetadata` under `basePath`.
- v3 key: `zarr.json` under `basePath`; consolidated read from root `zarr.json`.

## Tests (TDD, red first)

- Unit: `detectNode` for v3-array, v3-group, v2-array, v2-group, both-present (v3 wins), neither
  (error), bad `zarr_format` (error).
- Integration: existing v2 fixtures still open unchanged (no regression, FR-020).
