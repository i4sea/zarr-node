// v3 `bytes` codec (array→bytes): fixes how stored bytes are interpreted as
// array elements via its `endian` field (FR-005, FR-008).
//
// Decode is a byte-identity: the reader applies endianness once, at typed-
// array construction (`ZarrArray.toTypedChunk` byte-swaps when the resolved
// `ResolvedDtype.byteOrder` is "big"), exactly like the v2 typestr path. The
// v3 metadata parser reads `endian` from this codec's configuration and sets
// `ResolvedDtype.byteOrder`; the codec instance keeps the chain's
// exactly-one-array→bytes invariant satisfied.
import { MetadataError } from "../errors.js";
import type { ByteOrder } from "../metadata/types.js";
import type { PipelineCodec } from "./pipeline.js";

export interface BytesCodecConfig {
  id: string;
  endian?: unknown;
}

export class BytesCodec implements PipelineCodec {
  readonly id = "bytes";
  /** Declared element byte order; null when `endian` was omitted. */
  readonly endian: "little" | "big" | null;

  constructor(config: BytesCodecConfig = { id: "bytes" }) {
    const endian = config.endian;
    if (endian === undefined || endian === null) {
      this.endian = null;
    } else if (endian === "little" || endian === "big") {
      this.endian = endian;
    } else {
      throw new MetadataError(
        `Invalid "bytes" codec endian: ${JSON.stringify(endian)}. ` +
          `Must be "little" or "big".`,
      );
    }
  }

  /**
   * Resolve the element byte order for a dtype of `byteSize` bytes.
   * `endian` may be omitted only for single-byte types (→ "none").
   */
  resolveByteOrder(byteSize: number): ByteOrder {
    if (byteSize === 1) return "none";
    if (this.endian === null) {
      throw new MetadataError(
        `The "bytes" codec requires an "endian" configuration for ` +
          `multi-byte data types (element size ${byteSize})`,
      );
    }
    return this.endian;
  }

  async decode(data: Uint8Array): Promise<Uint8Array> {
    return data;
  }
}
