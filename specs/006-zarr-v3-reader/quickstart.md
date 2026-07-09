# Quickstart: Zarr v3 Reader

**Feature**: 006-zarr-v3-reader | **Date**: 2026-07-09

The whole point of this feature: **nothing changes for the consumer.** The same calls read v2 and
v3, and the library detects the format.

## Reading a v3 array (identical to v2)

```ts
import { openArray, FileSystemStore } from "@i4sea/zarr-node";

// The store may be v2 (.zarray/.zgroup) or v3 (zarr.json) — no version argument.
const store = new FileSystemStore({ path: "/data/temperature.zarr" });
const arr = await openArray(store);

console.log(arr.shape, arr.dtype);          // same fields as v2
const region = await arr.get([[0, 100], [0, 100]]);  // same selection API → TypedArray
```

## Reading a v3 group

```ts
import { openGroup, S3Store } from "@i4sea/zarr-node";

const group = await openGroup(new S3Store({ bucket: "grids", prefix: "model/run.zarr" }));
const wind = await group.getArray("u10");     // child resolved from zarr.json (or consolidated)
const slab = await wind.get([0, null, null]);  // whole 2-D slab at t=0
```

## Sharded v3 data on S3/HTTP (byte-range reads)

```ts
// A sharded array reads a sub-region without downloading whole shards
// (when the store supports ranged reads — FS/HTTP/S3 do).
const sharded = await openArray(new S3Store({ bucket: "grids", prefix: "sharded.zarr" }));
const window = await sharded.get([[500, 520], [500, 520]]);
// Under the hood: shard index read → only the touched inner-chunk byte-ranges fetched,
// adjacent ranges coalesced (~1 MB gap threshold). Zero full-shard downloads.
```

## Verifying the feature (maps to Success Criteria)

| Check | How | SC |
|-------|-----|----|
| v3 array/group reads match reference | Open v3 fixture, compare `get()` to `expected.json` (from zarr-python v3) | SC-001, SC-003 |
| No v2 regression | Run the existing v2 fixture + test suite unchanged; all pass | SC-002 |
| Full codec chain | v3 fixture `transpose → bytes → {blosc\|gzip\|zstd}` decodes correctly | SC-003 |
| Sharded byte-range | Mock/record store shows only inner-chunk ranges, zero whole-shard `get` | SC-004 |
| v3 consolidated | Open v3 hierarchy with root consolidated metadata; children resolve with zero per-node fetches | SC-005 |
| Corruption caught | Inner-chunk with bad `crc32c` throws a clear error | Edge case / FR-008a |

## Running the fixtures & tests

```bash
# (Re)generate v3 fixtures with the reference Python zarr v3 library
python tests/fixtures/generate.py

# Full suite (v2 unchanged + new v3 unit/integration)
npm test && npm run lint
```

## Notes for reviewers

- Supported v3 data types: `bool`, `int8/16/32/64`, `uint8/16/32/64`, `float16/32/64`. `float16`
  surfaces as `Float32Array`; `int64`/`uint64` as BigInt typed arrays.
- Detection is automatic; if both `zarr.json` and `.zarray` exist at a node (degenerate), v3 wins.
- `crc32c` mismatch is a hard error — it also surfaces byte-range / codec-order bugs during dev.
