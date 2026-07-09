# Contract: Codec Pipeline

**Feature**: 006-zarr-v3-reader

Generalizes the single decode-only `Codec` into an ordered pipeline shared by v2 and v3.

## Public API impact

**None** to `open`/`ZarrArray`. The `Codec` interface and `codecRegistry` (public plugin surface,
Principle IV) remain backward-compatible: existing `{ id, decode }` codecs still register and run.
`CodecPipeline` is additive.

## Types

```ts
type CodecKind = "array->array" | "array->bytes" | "bytes->bytes";

interface CodecPipeline {
  // Decode a stored chunk buffer back to raw element bytes, applying the chain in REVERSE order.
  decode(data: Uint8Array, ctx: ChunkDecodeContext): Promise<Uint8Array>;
}
```

- Construction validates: **exactly one** `array->bytes` codec; zero+ `array->array` (before it in
  encode order); zero+ `bytes->bytes` (after it) — else `MetadataError`/`CodecError` (FR-006).
- Decode order: reverse of the declared (encode) order (FR-007). Every stage is applied — no
  silent skip. This is where v2 `filters` (previously parsed-but-unused) are now applied (FR-009).

## v3 codecs registered via `codecRegistry`

| Codec | Kind | Behavior |
|-------|------|----------|
| `transpose` | array→array | Invert the declared axis permutation on decode |
| `bytes` | array→bytes | Interpret bytes as elements using its `endian` field; sets `ResolvedDtype.byteOrder` |
| `blosc` / `gzip` / `zstd` | bytes→bytes | Reuse existing (zstd via Blosc `cname:"zstd"`) |
| `crc32c` | bytes→bytes | Split trailing 4-byte checksum, verify over the rest, **throw on mismatch** (FR-008a); returns the payload **without** the checksum (output is 4 bytes shorter than input) |
| `sharding_indexed` | array→bytes (special) | Store-aware reader, NOT run via `pipeline.decode()`; owns inner-chunk fetch+decode — see sharding.md |

## Loader integration

`LoadChunksContext` carries a `CodecPipeline` (replacing the single `Codec | null`). `decodeRaw`
in `loader.ts` delegates to `pipeline.decode`. The decode pool (`shouldOffload`) continues to
offload the heavy `bytes->bytes` compressor stage (e.g. blosc) to workers; lightweight stages
(`transpose`, `bytes`, `crc32c`) run inline.

## Tests (TDD, red first)

- Unit per codec with known input/output byte pairs (Principle III): `transpose` inverse, `bytes`
  little/big endian, `crc32c` match (passes) and mismatch (throws), pass-through when chain empty.
- Unit: pipeline rejects zero or >1 array→bytes codecs.
- Unit: reverse-order application (`transpose→bytes→gzip` decodes as `gunzip→bytes→untranspose`).
- Regression: a v2 array declaring a `filters` entry now applies it on decode (closes FR-009 gap).
- Integration: v3 fixture `transpose → bytes(endian) → {blosc|gzip|zstd}` matches `expected.json`
  (US3).
