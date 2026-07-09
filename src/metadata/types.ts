import type { TypedArrayConstructor } from "../dtype.js";
import type { CodecPipeline } from "../codec/pipeline.js";

export interface CompressorConfig {
  id: string;
  [key: string]: unknown;
}

export interface FilterConfig {
  id: string;
  [key: string]: unknown;
}

export interface ZarrayMeta {
  zarr_format: 2;
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: CompressorConfig | null;
  fill_value: number | string | null;
  order: "C" | "F";
  dimension_separator: "." | "/";
  filters: FilterConfig[] | null;
}

export interface ZgroupMeta {
  zarr_format: 2;
}

export type Zattrs = Record<string, unknown>;

// --- Version-neutral resolved metadata (feature 006) ---
//
// Both the v2 (.zarray/.zgroup) and v3 (zarr.json) parsers produce these
// types, so the entire downstream read path (ZarrArray, loadChunks, caches,
// stores) is shared and format-agnostic.

/** Element byte order. v2: from the typestr prefix; v3: from the `bytes` codec. */
export type ByteOrder = "little" | "big" | "none";

/** Resolved element type consumed by the read path. */
export interface ResolvedDtype {
  /** TypedArray constructor the read materializes into. */
  ctor: TypedArrayConstructor;
  /** STORED element size in bytes (`float16` = 2 even though it widens). */
  byteSize: number;
  byteOrder: ByteOrder;
  /** True for `float16`: stored halves decode into a Float32Array. */
  widenHalfToFloat: boolean;
}

/** How a chunk coordinate maps to a store key. */
export interface ChunkKeyStrategy {
  /** Encoding family: v2 (`0.0`) or the v3 default (`c/0/0`). */
  kind: "v2" | "v3-default";
  separator: "." | "/";
  /** v3-default uses `"c"`; v2 uses none. */
  prefix: string | null;
  /** Node path prefix folded into every chunk key (null at the store root). */
  basePath: string | null;
}

/** Version-neutral description of an array node consumed by `ZarrArray`. */
export interface ResolvedArrayMeta {
  /** Which format produced this (diagnostics / consolidated lookup). */
  zarrFormat: 2 | 3;
  shape: number[];
  /** Regular chunk grid cell shape (the shard shape for sharded v3 arrays). */
  chunkShape: number[];
  /** Original dtype spelling surfaced as `ZarrArray.dtype` (v2 typestr / v3 name). */
  dtypeName: string;
  dtype: ResolvedDtype;
  /** Ordered decode chain (see contracts/codec-pipeline.md). */
  codecPipeline: CodecPipeline;
  /** Interpreted per dtype (incl. NaN/±Infinity). */
  fillValue: number | bigint | boolean | null;
  /**
   * Memory order. v2: from `.zarray` `order`. v3: always "C" — any axis
   * permutation is expressed solely by the `transpose` codec in the pipeline.
   */
  order: "C" | "F";
  chunkKey: ChunkKeyStrategy;
  attrs: Zattrs;
  /**
   * Present when the array→bytes slot is `sharding_indexed` (v3): the read
   * path then routes chunk reads to the store-aware sharding reader instead
   * of `loadChunks`. For sharded arrays `chunkShape` is the SHARD shape and
   * `codecPipeline` is the INNER chunk pipeline.
   */
  sharding?: ShardingInfo | null;
}

/** Resolved `sharding_indexed` configuration (see contracts/sharding.md). */
export interface ShardingInfo {
  /** Inner-chunk shape; divides the shard (outer chunk) shape per dimension. */
  innerChunkShape: number[];
  /** Inner chunks per shard, per dimension (chunkShape / innerChunkShape). */
  chunksPerShardDim: number[];
  /** Total inner chunks per shard (product of chunksPerShardDim). */
  chunksPerShard: number;
  /** Decode chain for each inner chunk. */
  innerPipeline: CodecPipeline;
  /** Decode chain for the shard index (typically bytes LE + crc32c). */
  indexPipeline: CodecPipeline;
  /** Byte order of the decoded index's uint64 pairs. */
  indexByteOrder: ByteOrder;
  indexLocation: "start" | "end";
  /** Stored index size: N × 16 bytes + index-codec checksum overhead. */
  indexSizeBytes: number;
}

/** Version-neutral description of a group node. */
export interface ResolvedGroupMeta {
  zarrFormat: 2 | 3;
  attrs: Zattrs;
}
