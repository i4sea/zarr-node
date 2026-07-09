// v3 `crc32c` checksum codec (bytes→bytes): the encoded chunk is the payload
// followed by its 4-byte little-endian CRC-32C (Castagnoli). Decode verifies
// the checksum and THROWS on mismatch (FR-008a — corrupted data must never be
// returned), then strips it.
//
// Table-based implementation vendored per research R7: CRC-32C is not a Node
// built-in (node:zlib exposes CRC-32) and ~40 lines beat a runtime dependency.
import { CodecError } from "../errors.js";
import type { PipelineCodec } from "./pipeline.js";

/** Reflected Castagnoli polynomial. */
const POLY = 0x82f63b78;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli) of `data`, as an unsigned 32-bit integer. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class Crc32cCodec implements PipelineCodec {
  readonly id = "crc32c";

  async decode(data: Uint8Array): Promise<Uint8Array> {
    if (data.byteLength < 4) {
      throw new CodecError(
        `crc32c: chunk of ${data.byteLength} bytes is too short to carry a ` +
          `4-byte checksum`,
      );
    }
    const payload = data.subarray(0, data.byteLength - 4);
    const stored = new DataView(
      data.buffer,
      data.byteOffset + data.byteLength - 4,
      4,
    ).getUint32(0, true);
    const computed = crc32c(payload);
    if (computed !== stored) {
      throw new CodecError(
        `crc32c checksum mismatch: stored 0x${stored.toString(16)}, ` +
          `computed 0x${computed.toString(16)} — chunk is corrupted`,
      );
    }
    return payload;
  }
}
