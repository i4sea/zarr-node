import { describe, it, expect } from "vitest";
import { Crc32cCodec, crc32c } from "../../src/codec/crc32c.js";
import { CodecError } from "../../src/errors.js";

const enc = new TextEncoder();

/** payload + trailing LE crc32c checksum. */
function withChecksum(payload: Uint8Array, checksum = crc32c(payload)): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out.set(payload, 0);
  new DataView(out.buffer).setUint32(payload.length, checksum, true);
  return out;
}

describe("CRC-32C (Castagnoli) — known vectors", () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32c(enc.encode("123456789"))).toBe(0xe3069283);
  });

  it("empty input has checksum 0", () => {
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  it("matches known vectors", () => {
    // RFC 3720 / iSCSI test vectors
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa); // 32 × 0x00
    expect(crc32c(new Uint8Array(32).fill(0xff))).toBe(0x62a8ab43); // 32 × 0xff
  });
});

describe("crc32c codec (FR-008a)", () => {
  it("verifies a matching checksum and returns the payload without it", async () => {
    const payload = enc.encode("hello zarr");
    const codec = new Crc32cCodec();

    const decoded = await codec.decode(withChecksum(payload));
    expect(decoded.byteLength).toBe(payload.byteLength); // 4 bytes shorter than input
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });

  it("throws a clear corruption error on checksum mismatch", async () => {
    const payload = enc.encode("hello zarr");
    const corrupted = withChecksum(payload, 0xdeadbeef);
    const codec = new Crc32cCodec();

    await expect(codec.decode(corrupted)).rejects.toThrow(CodecError);
    await expect(codec.decode(corrupted)).rejects.toThrow(/crc32c/i);
  });

  it("detects a single flipped payload bit", async () => {
    const payload = enc.encode("sensor-data");
    const encoded = withChecksum(payload);
    encoded[3] ^= 0x01;

    await expect(new Crc32cCodec().decode(encoded)).rejects.toThrow(CodecError);
  });

  it("throws on inputs shorter than the checksum itself", async () => {
    await expect(new Crc32cCodec().decode(new Uint8Array(3))).rejects.toThrow(
      CodecError,
    );
  });
});
