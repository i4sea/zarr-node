// Zarr v3 metadata parser (feature 006): parses `zarr.json` node documents
// into the version-neutral ResolvedArrayMeta / ResolvedGroupMeta, building the
// ordered CodecPipeline from the declared `codecs` chain.
import { MetadataError } from "../errors.js";
import { resolveV3Dtype, halfToFloat32 } from "../dtype.js";
import { codecRegistry } from "../codec/codec.js";
import { CodecPipeline, codecKind } from "../codec/pipeline.js";
import type { PipelineStage } from "../codec/pipeline.js";
import { BytesCodec } from "../codec/bytes.js";
import { shardIndexSize } from "../codec/sharding.js";
import type {
  ResolvedArrayMeta,
  ResolvedGroupMeta,
  ResolvedDtype,
  ChunkKeyStrategy,
  ShardingInfo,
  Zattrs,
  CompressorConfig,
} from "./types.js";

/** Raw v3 codec chain entry: `{ name, configuration? }`. */
export interface Codec3Config {
  name: string;
  configuration?: Record<string, unknown>;
}

function parseDoc(raw: Uint8Array | string, path: string) {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MetadataError(
      `Invalid zarr.json at path "${path || "/"}": failed to parse JSON`,
    );
  }
  if (parsed.zarr_format !== 3) {
    throw new MetadataError(
      `Unsupported zarr_format in zarr.json at path "${path || "/"}": ` +
        `${String(parsed.zarr_format)}. Supported: 3 (zarr.json) and 2 (.zarray/.zgroup).`,
    );
  }
  return parsed;
}

function parseShape(value: unknown, what: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 0)
  ) {
    throw new MetadataError(`${what} must be an array of non-negative integers`);
  }
  return value as number[];
}

function parseChunkGrid(value: unknown, shape: number[]): number[] {
  const grid = value as
    | { name?: unknown; configuration?: { chunk_shape?: unknown } }
    | undefined;
  if (!grid || grid.name !== "regular") {
    throw new MetadataError(
      `Unsupported chunk_grid: ${JSON.stringify(grid?.name)}. ` +
        `Only the "regular" grid is supported.`,
    );
  }
  const chunkShape = parseShape(
    grid.configuration?.chunk_shape,
    "chunk_grid.configuration.chunk_shape",
  );
  if (chunkShape.length !== shape.length) {
    throw new MetadataError(
      `shape and chunk_shape must have the same number of dimensions: ` +
        `shape has ${shape.length}, chunk_shape has ${chunkShape.length}`,
    );
  }
  for (let i = 0; i < chunkShape.length; i++) {
    if (chunkShape[i] <= 0) {
      throw new MetadataError(
        `chunk_shape[${i}] must be > 0, got ${chunkShape[i]}`,
      );
    }
  }
  return chunkShape;
}

function parseChunkKeyEncoding(
  value: unknown,
  basePath: string,
): ChunkKeyStrategy {
  const enc = (value ?? { name: "default" }) as {
    name?: unknown;
    configuration?: { separator?: unknown };
  };
  const separator = enc.configuration?.separator;
  if (enc.name === "default") {
    const sep = separator ?? "/";
    if (sep !== "/" && sep !== ".") {
      throw new MetadataError(
        `Invalid chunk_key_encoding separator: ${JSON.stringify(separator)}`,
      );
    }
    return {
      kind: "v3-default",
      separator: sep,
      prefix: "c",
      basePath: basePath || null,
    };
  }
  if (enc.name === "v2") {
    const sep = separator ?? ".";
    if (sep !== "/" && sep !== ".") {
      throw new MetadataError(
        `Invalid chunk_key_encoding separator: ${JSON.stringify(separator)}`,
      );
    }
    return {
      kind: "v2",
      separator: sep,
      prefix: null,
      basePath: basePath || null,
    };
  }
  throw new MetadataError(
    `Unsupported chunk_key_encoding: ${JSON.stringify(enc.name)}. ` +
      `Supported: "default", "v2".`,
  );
}

/** Interpret a hex bit-pattern fill (e.g. "0x7fc00000") per the dtype. */
function fillFromHex(
  hex: string,
  dtype: ResolvedDtype,
  dtypeName: string,
): number | bigint {
  let bits: bigint;
  try {
    bits = BigInt(hex);
  } catch {
    throw new MetadataError(`Invalid fill_value hex string: "${hex}"`);
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true); // little-endian: low bytes first
  switch (dtypeName) {
    case "float64":
      return view.getFloat64(0, true);
    case "float32":
      return view.getFloat32(0, true);
    case "float16":
      return halfToFloat32(new Uint16Array([Number(bits & 0xffffn)]))[0];
    case "int64":
      return view.getBigInt64(0, true);
    case "uint64":
      return view.getBigUint64(0, true);
    // Signed integers: reinterpret the low bytes as two's complement so a
    // bit-pattern like "0xff" for int8 resolves to -1, not 255.
    case "int8":
      return view.getInt8(0);
    case "int16":
      return view.getInt16(0, true);
    case "int32":
      return view.getInt32(0, true);
    default: {
      // Unsigned integer / bool types: the bit pattern IS the value (masked
      // to the stored size).
      const masked = bits & ((1n << BigInt(dtype.byteSize * 8)) - 1n);
      return Number(masked);
    }
  }
}

/** Interpret a v3 `fill_value` per dtype (FR-011). */
export function resolveV3FillValue(
  fill: unknown,
  dtype: ResolvedDtype,
  dtypeName: string,
): number | bigint | boolean | null {
  if (fill === null || fill === undefined) return null;
  if (typeof fill === "boolean") return fill;
  if (typeof fill === "number") return fill;
  if (typeof fill === "string") {
    if (fill === "NaN") return NaN;
    if (fill === "Infinity") return Infinity;
    if (fill === "-Infinity") return -Infinity;
    if (fill.startsWith("0x")) return fillFromHex(fill, dtype, dtypeName);
    throw new MetadataError(`Unsupported fill_value: ${JSON.stringify(fill)}`);
  }
  throw new MetadataError(
    `Unsupported fill_value form: ${JSON.stringify(fill)}`,
  );
}

/** Normalize a raw v3 codec entry to a registry config (`{ id, ... }`). */
export function toCodecConfig(entry: Codec3Config): CompressorConfig {
  return { id: entry.name, ...(entry.configuration ?? {}) };
}

function parseCodecChain(value: unknown, path: string): Codec3Config[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((c) => typeof c !== "object" || c === null || !("name" in c))
  ) {
    throw new MetadataError(
      `Invalid codecs chain at path "${path || "/"}": expected an array of ` +
        `{ name, configuration? } entries`,
    );
  }
  return value as Codec3Config[];
}

/** Build the ordered pipeline from the declared v3 codec chain. */
export async function buildV3Pipeline(
  codecs: Codec3Config[],
): Promise<CodecPipeline> {
  const stages: PipelineStage[] = [];
  for (const entry of codecs) {
    const config = toCodecConfig(entry);
    stages.push({
      kind: codecKind(entry.name),
      codec: await codecRegistry.get(config),
      config,
    });
  }
  return new CodecPipeline(stages);
}

/**
 * Resolve the element byte order from the chain's `bytes` codec (FR-005).
 * For sharded arrays the `bytes` codec lives in the sharding codec's inner
 * chain — the search recurses through `sharding_indexed` configurations.
 */
export function resolveByteOrderFromCodecs(
  codecs: Codec3Config[],
  dtype: ResolvedDtype,
): ResolvedDtype["byteOrder"] {
  for (const entry of codecs) {
    if (entry.name === "bytes") {
      const codec = new BytesCodec(toCodecConfig(entry));
      return codec.resolveByteOrder(dtype.byteSize);
    }
    if (entry.name === "sharding_indexed") {
      const inner = entry.configuration?.codecs;
      if (Array.isArray(inner)) {
        return resolveByteOrderFromCodecs(inner as Codec3Config[], dtype);
      }
    }
  }
  if (dtype.byteSize === 1) return "none";
  throw new MetadataError(
    `The codec chain declares no "bytes" codec — element byte order is ` +
      `undefined for a ${dtype.byteSize}-byte data type`,
  );
}

/**
 * Parse a `sharding_indexed` configuration into the resolved sharding info
 * (FR-012). The outer chunk (shard) shape must be an exact multiple of the
 * inner chunk shape per dimension.
 */
async function parseShardingConfig(
  entry: Codec3Config,
  shardShape: number[],
): Promise<ShardingInfo> {
  const config = entry.configuration ?? {};
  const innerChunkShape = parseShape(
    config.chunk_shape,
    "sharding_indexed chunk_shape",
  );
  if (innerChunkShape.length !== shardShape.length) {
    throw new MetadataError(
      `sharding_indexed chunk_shape rank ${innerChunkShape.length} does not ` +
        `match the chunk grid rank ${shardShape.length}`,
    );
  }
  const chunksPerShardDim = shardShape.map((s, d) => {
    if (innerChunkShape[d] <= 0 || s % innerChunkShape[d] !== 0) {
      throw new MetadataError(
        `sharding_indexed chunk_shape[${d}] = ${innerChunkShape[d]} does not ` +
          `evenly divide the shard shape ${s}`,
      );
    }
    return s / innerChunkShape[d];
  });
  const chunksPerShard = chunksPerShardDim.reduce((a, b) => a * b, 1);

  const innerCodecs = parseCodecChain(config.codecs, "");
  const indexCodecs = parseCodecChain(config.index_codecs, "");
  if (indexCodecs.length === 0) {
    throw new MetadataError(
      "sharding_indexed requires index_codecs (the shard index encoding)",
    );
  }
  const indexLocation = config.index_location ?? "end";
  if (indexLocation !== "start" && indexLocation !== "end") {
    throw new MetadataError(
      `Invalid sharding_indexed index_location: ${JSON.stringify(indexLocation)}`,
    );
  }

  // The index is uint64 pairs — resolve its byte order from ITS bytes codec.
  const indexByteOrder = resolveByteOrderFromCodecs(indexCodecs, {
    ctor: BigUint64Array,
    byteSize: 8,
    byteOrder: "none",
    widenHalfToFloat: false,
  });

  return {
    innerChunkShape,
    chunksPerShardDim,
    chunksPerShard,
    innerPipeline: await buildV3Pipeline(innerCodecs),
    indexPipeline: await buildV3Pipeline(indexCodecs),
    indexByteOrder,
    indexLocation,
    indexSizeBytes: shardIndexSize(chunksPerShard, indexCodecs),
  };
}

/**
 * Parse a v3 array `zarr.json` document into the neutral array description
 * (FR-003, FR-004, FR-011, FR-021).
 */
export async function parseV3ArrayMeta(
  raw: Uint8Array | string,
  basePath: string,
): Promise<ResolvedArrayMeta> {
  const doc = parseDoc(raw, basePath);
  if (doc.node_type !== "array") {
    throw new MetadataError(
      `Expected an array node at path "${basePath || "/"}", ` +
        `got node_type ${JSON.stringify(doc.node_type)}`,
    );
  }

  const transformers = doc.storage_transformers;
  if (Array.isArray(transformers) && transformers.length > 0) {
    throw new MetadataError(
      `Unsupported storage_transformers at path "${basePath || "/"}": ` +
        `the reader supports none`,
    );
  }

  const shape = parseShape(doc.shape, "shape");
  const chunkShape = parseChunkGrid(doc.chunk_grid, shape);

  if (typeof doc.data_type !== "string") {
    throw new MetadataError(
      `Unsupported v3 data_type: ${JSON.stringify(doc.data_type)}. ` +
        `data_type must be a string name.`,
    );
  }
  const dtypeName = doc.data_type;
  const dtype = resolveV3Dtype(dtypeName);

  const codecs = parseCodecChain(doc.codecs, basePath);
  dtype.byteOrder = resolveByteOrderFromCodecs(codecs, dtype);

  // sharding_indexed occupies the array→bytes slot but executes as a
  // store-aware reader, not through pipeline.decode() (contracts/sharding.md).
  const shardingEntry = codecs.find((c) => c.name === "sharding_indexed");
  let sharding: ShardingInfo | null = null;
  let codecPipeline;
  if (shardingEntry) {
    if (codecs.length !== 1) {
      throw new MetadataError(
        `Unsupported codec chain at path "${basePath || "/"}": ` +
          `sharding_indexed must be the only outer codec ` +
          `(found: ${codecs.map((c) => c.name).join(", ")})`,
      );
    }
    sharding = await parseShardingConfig(shardingEntry, chunkShape);
    // For sharded arrays the resolved pipeline is the INNER chunk chain —
    // the sharding reader decodes each inner chunk through it.
    codecPipeline = sharding.innerPipeline;
  } else {
    codecPipeline = await buildV3Pipeline(codecs);
  }

  return {
    zarrFormat: 3,
    shape,
    chunkShape,
    dtypeName,
    dtype,
    codecPipeline,
    fillValue: resolveV3FillValue(doc.fill_value, dtype, dtypeName),
    // v3 has no `order` field: memory order is always C; any permutation is
    // expressed solely by the `transpose` codec in the pipeline.
    order: "C",
    chunkKey: parseChunkKeyEncoding(doc.chunk_key_encoding, basePath),
    attrs: (doc.attributes ?? {}) as Zattrs,
    sharding,
  };
}

/** Parse a v3 group `zarr.json` document (FR-003). */
export function parseV3GroupMeta(raw: Uint8Array | string): ResolvedGroupMeta {
  const doc = parseDoc(raw, "");
  if (doc.node_type !== "group") {
    throw new MetadataError(
      `Expected a group node, got node_type ${JSON.stringify(doc.node_type)}`,
    );
  }
  return { zarrFormat: 3, attrs: (doc.attributes ?? {}) as Zattrs };
}
