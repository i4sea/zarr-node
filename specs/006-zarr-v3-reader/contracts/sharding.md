# Contract: Sharding (`sharding_indexed`)

**Feature**: 006-zarr-v3-reader

The v3 sharding codec: many inner-chunks packed into one shard object, located by an index, read by
byte-range. This is where the feature's performance benefit is realized (SC-004).

## Public API impact

**None.** A sharded array reads through the same `ZarrArray.get(selection)`.

## Where sharding lives (loader vs codec)

Sharding is **not** a plain `bytes→bytes` `Codec`. A plain codec receives an already-fetched
`Uint8Array` and returns bytes; sharding must decide *what to fetch* — it needs the `store`, the
shard key, `getRange`, and the inner-chunk geometry **before** any bytes are read. So the
sharded-vs-non-sharded decision is made by the **read path** (a sharded array's chunk read is
routed to the sharding reader), and the sharding reader in turn **uses** an inner `CodecPipeline`
to decode each inner-chunk. The `sharding_indexed` entry occupies the array→bytes slot of the outer
chain, but it is materialized as this store-aware reader rather than run through `pipeline.decode()`
like an ordinary codec. Registering it in `codecRegistry` is for discovery/parse; its execution
contract is the read strategy below, not the plain `decode(data, ctx)` signature.

## Shard index

- Layout: `N` entries of two `uint64` values `(offset, nbytes)`, one per inner-chunk, in the shard's
  chunk order. Index location (end-of-shard by default; start allowed) comes from the codec config.
- The index bytes are themselves encoded by the shard's `index_codecs` (typically `bytes` little-endian
  `+ crc32c`), so the reader MUST decode the index through that sub-pipeline before reading `(offset,
  nbytes)` pairs — it is not raw `uint64` on the wire when `crc32c` is present. A failing index
  `crc32c` ⇒ corruption error (FR-008a), same as any chunk.
- Index size is derived, not stored: `N × 16 bytes` (+ the `index_codecs` checksum overhead). This
  is what lets a `getRange` store read only the index region (a suffix range for end-of-shard) without
  fetching the whole shard.
- Reserved empty marker: `offset === nbytes === 2^64 - 1` ⇒ inner-chunk is empty ⇒ fill value
  (FR-011, FR-012). No read is issued for empty inner-chunks.
- A missing or malformed index ⇒ clear error (spec Edge Case), never a partial/garbage read.

## Read strategy

Given a selection touching a set of inner-chunks within one or more shards:

1. Read the shard index. On a `getRange`-capable store, read only the index byte region; otherwise
   fetch the whole shard (fallback below).
2. Determine touched inner-chunks; drop empty-marked ones (→ fill).
3. **`getRange` available** (FR-013): fetch each touched inner-chunk by `(offset, nbytes)`.
   **Coalesce** ranges whose inter-range gap ≤ configurable threshold (default ~1 MB); contiguous
   ranges always merge (FR-015, clarification). One request per coalesced span; slice inner-chunks
   out of the returned bytes.
4. **`getRange` absent** (FR-014): fetch the whole shard once; slice all inner-chunks in memory.
5. Decode each inner-chunk through its inner `CodecPipeline` (which may itself include `crc32c`,
   compressors, `bytes`, `transpose`).

## Loader change required

Today `loader.ts` uses `getRange` only when `codec === null`. That gating must be relaxed so the
sharding codec can range-read **compressed** inner-chunks. The relaxation is scoped to the sharding
path; non-sharded reads keep their current behavior.

## Given/When/Then

- Given a sharded array on a `getRange` store, When reading a small sub-region, Then only touched
  inner-chunk byte-ranges are requested and **zero** full-shard downloads occur (SC-004).
- Given a sharded array on a non-`getRange` store, When reading a sub-region, Then whole shards are
  fetched and values are still correct (FR-014).
- Given a read touching adjacent inner-chunks with gap ≤ threshold, When served by range, Then the
  ranges are coalesced into one request (FR-015).
- Given a read touching inner-chunks with gap > threshold, When served by range, Then they are
  separate requests.
- Given a shard with empty-marked inner-chunks, When a read touches them, Then those positions are
  fill value, no read issued (FR-012).
- Given a corrupt inner-chunk whose `crc32c` fails, When decoded, Then a corruption error is thrown
  (FR-008a).

## Tests (TDD, red first)

- Unit: shard index parse (incl. empty marker); range coalescing (gap ≤/> threshold; contiguous).
- Unit: strategy selection (`getRange` vs whole-shard fallback) via a mock store that records the
  exact `getRange`/`get` calls — assert **no full-shard `get`** on the ranged path (SC-004).
- Integration: reference `sharding_indexed` fixture, read full + sub-region, match `expected.json`
  (US4). Run over `FileSystemStore` (getRange) and a range-less store variant.
- Perf (local, no CI target number): sharded `large_*` fixture, record bytes transferred for a
  sub-region read vs whole-shard baseline (SC-006).
