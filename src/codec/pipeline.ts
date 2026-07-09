// Ordered codec pipeline shared by the v2 and v3 read paths (feature 006).
//
// v3 declares an ordered `codecs` chain classified into array→array stages,
// exactly one array→bytes stage, and bytes→bytes stages; decode applies the
// chain in REVERSE of the declared (encode) order. v2 builds a pipeline from
// `filters` + `compressor` — which also closes the long-standing gap where v2
// filters were parsed but never applied (FR-009).
import { MetadataError } from "../errors.js";
import { codecRegistry } from "./codec.js";
import type { Codec } from "./codec.js";
import type { DecodePool } from "./decode-pool.js";
import type {
  CompressorConfig,
  FilterConfig,
  ResolvedDtype,
} from "../metadata/types.js";

/** Classification of a codec within the chain (encode direction). */
export type CodecKind = "array->array" | "array->bytes" | "bytes->bytes";

/**
 * Per-chunk context available to context-aware (v3) codec stages such as
 * `transpose` (needs the chunk shape) and `bytes` (needs the element size).
 * Plain v2 codecs ignore it — `Codec.decode(data)` stays compatible.
 */
export interface ChunkDecodeContext {
  chunkShape: readonly number[];
  dtype: ResolvedDtype;
}

/** A codec whose decode may consume the chunk context (v3 codecs). */
export interface PipelineCodec extends Codec {
  decode(data: Uint8Array, ctx?: ChunkDecodeContext): Promise<Uint8Array>;
  /**
   * Set by context-aware (v3) codecs to receive the `ChunkDecodeContext` as
   * decode's second argument. Third-party/v2 codecs never get a second
   * argument — some (e.g. numcodecs Blosc) interpret one as an output buffer.
   */
  usesContext?: boolean;
}

/** One classified stage of the chain, in encode order. */
export interface PipelineStage {
  kind: CodecKind;
  codec: PipelineCodec;
  /**
   * Raw config for this stage. Lets the decode pool rebuild the codec inside
   * a worker thread for offloaded bytes→bytes stages.
   */
  config: CompressorConfig;
}

/**
 * Codec ids known to be byte-identities on decode: they never change the
 * buffer contents (the v3 `bytes` codec only fixes the element interpretation,
 * which the read path applies via `ResolvedDtype.byteOrder`). A pipeline made
 * only of these stages is safe for partial byte-range reads.
 */
const IDENTITY_CODEC_IDS = new Set(["bytes", "raw"]);

/** Known codec classifications; unknown/plugin codecs default to bytes→bytes. */
const CODEC_KINDS: Record<string, CodecKind> = {
  transpose: "array->array",
  bytes: "array->bytes",
  sharding_indexed: "array->bytes",
  blosc: "bytes->bytes",
  gzip: "bytes->bytes",
  zlib: "bytes->bytes",
  zstd: "bytes->bytes",
  crc32c: "bytes->bytes",
};

/**
 * Classify a codec id. Unknown ids are treated as bytes→bytes — the safe
 * assumption for v2 compressors/filters registered through `codecRegistry`.
 */
export function codecKind(id: string): CodecKind {
  return CODEC_KINDS[id] ?? "bytes->bytes";
}

/** Offload wiring for heavy synchronous bytes→bytes stages (e.g. Blosc). */
export interface PipelineOffload {
  pool: DecodePool;
}

/**
 * Ordered, classified codec chain with reverse-order decode.
 *
 * Validation (FR-006): a NON-empty chain must contain exactly one array→bytes
 * codec. An EMPTY chain is a valid pass-through (the v2 uncompressed,
 * unfiltered case).
 */
export class CodecPipeline {
  /** Stages in declared (encode) order. */
  private readonly stages: readonly PipelineStage[];

  constructor(stages: readonly PipelineStage[]) {
    if (stages.length > 0) {
      const arrayToBytes = stages.filter((s) => s.kind === "array->bytes");
      if (arrayToBytes.length !== 1) {
        throw new MetadataError(
          `Invalid codec chain: expected exactly one array->bytes codec, ` +
            `found ${arrayToBytes.length} ` +
            `(chain: ${stages.map((s) => s.codec.id).join(" -> ")})`,
        );
      }
    }
    this.stages = stages;
  }

  /** The empty chain: decode returns its input unchanged. */
  static passthrough(): CodecPipeline {
    return new CodecPipeline([]);
  }

  /**
   * True when decode is a byte-identity end to end — every stage is a known
   * identity codec. Gates partial byte-range chunk reads.
   */
  get isPassthrough(): boolean {
    return this.stages.every((s) => IDENTITY_CODEC_IDS.has(s.codec.id));
  }

  /**
   * Id of the outermost bytes→bytes (compressor) stage, for observability
   * (`onChunkDecoded.codec`) — null when the chain has none.
   */
  get compressorId(): string | null {
    for (let i = this.stages.length - 1; i >= 0; i--) {
      if (this.stages[i].kind === "bytes->bytes") {
        return this.stages[i].codec.id;
      }
    }
    return null;
  }

  /**
   * Decode a stored chunk buffer back to raw element bytes, applying every
   * stage in REVERSE of the declared order (FR-007) — no silent skips.
   *
   * When `offload` is provided, bytes→bytes stages the pool accepts (heavy
   * synchronous codecs above the size threshold) run on a worker thread;
   * everything else decodes inline.
   */
  async decode(
    data: Uint8Array,
    ctx?: ChunkDecodeContext,
    offload?: PipelineOffload,
  ): Promise<Uint8Array> {
    let buf = data;
    for (let i = this.stages.length - 1; i >= 0; i--) {
      const stage = this.stages[i];
      if (
        offload &&
        stage.kind === "bytes->bytes" &&
        offload.pool.shouldOffload(stage.codec.id, buf.byteLength)
      ) {
        buf = await offload.pool.decode(stage.config, buf);
      } else if (stage.codec.usesContext) {
        buf = await stage.codec.decode(buf, ctx);
      } else {
        buf = await stage.codec.decode(buf);
      }
    }
    return buf;
  }
}

/**
 * Build the v2 pipeline from `.zarray` `compressor` + `filters`.
 *
 * v2 encode order is: filters (in declared order) → compressor, over the raw
 * element bytes (v2 has no explicit array→bytes codec — element interpretation
 * comes from the dtype typestr). Decode therefore decompresses first, then
 * applies each filter's decode in reverse declaration order (FR-009).
 */
export async function buildV2Pipeline(
  compressor: CompressorConfig | null,
  filters: FilterConfig[] | null,
): Promise<CodecPipeline> {
  const stages: PipelineStage[] = [];
  for (const filter of filters ?? []) {
    stages.push({
      kind: "bytes->bytes",
      codec: await codecRegistry.get(filter),
      config: filter,
    });
  }
  if (compressor) {
    stages.push({
      kind: "bytes->bytes",
      codec: await codecRegistry.get(compressor),
      config: compressor,
    });
  }
  if (stages.length === 0) return CodecPipeline.passthrough();
  // v2's implicit array→bytes slot: a raw identity stage, so the chain
  // satisfies the exactly-one-array→bytes invariant shared with v3.
  stages.unshift({
    kind: "array->bytes",
    codec: {
      id: "raw",
      decode: async (d: Uint8Array) => d,
    },
    config: { id: "raw" },
  });
  return new CodecPipeline(stages);
}
