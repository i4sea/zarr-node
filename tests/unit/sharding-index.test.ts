import { describe, it, expect } from "vitest";
import {
  shardIndexSize,
  decodeShardIndex,
} from "../../src/codec/sharding.js";
import { buildV3Pipeline } from "../../src/metadata/v3.js";
import { crc32c } from "../../src/codec/crc32c.js";
import { CodecError, MetadataError } from "../../src/errors.js";

const EMPTY = 0xffffffffffffffffn;

/** Raw index bytes: N (offset, nbytes) uint64 pairs, little-endian. */
function rawIndex(entries: Array<[bigint, bigint]>): Uint8Array {
  const out = new Uint8Array(entries.length * 16);
  const view = new DataView(out.buffer);
  entries.forEach(([offset, nbytes], i) => {
    view.setBigUint64(i * 16, offset, true);
    view.setBigUint64(i * 16 + 8, nbytes, true);
  });
  return out;
}

function withCrc(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out.set(payload, 0);
  new DataView(out.buffer).setUint32(payload.length, crc32c(payload), true);
  return out;
}

const INDEX_CODECS_PLAIN = [
  { name: "bytes", configuration: { endian: "little" } },
];
const INDEX_CODECS_CRC = [
  { name: "bytes", configuration: { endian: "little" } },
  { name: "crc32c" },
];

describe("shard index size (derived, not stored)", () => {
  it("is N × 16 bytes with plain bytes index codecs", () => {
    expect(shardIndexSize(4, INDEX_CODECS_PLAIN)).toBe(64);
  });

  it("adds the crc32c checksum overhead", () => {
    expect(shardIndexSize(4, INDEX_CODECS_CRC)).toBe(68);
    expect(shardIndexSize(1, INDEX_CODECS_CRC)).toBe(20);
  });

  it("rejects index codecs whose size overhead is not derivable", () => {
    expect(() =>
      shardIndexSize(4, [
        { name: "bytes", configuration: { endian: "little" } },
        { name: "gzip" },
      ]),
    ).toThrow(MetadataError);
  });
});

describe("shard index decode (FR-012)", () => {
  it("decodes (offset, nbytes) pairs through the index pipeline", async () => {
    const pipeline = await buildV3Pipeline(INDEX_CODECS_PLAIN);
    const raw = rawIndex([
      [0n, 100n],
      [100n, 50n],
    ]);
    const index = await decodeShardIndex(raw, 2, pipeline, "little");
    expect(index).toEqual([
      { offset: 0, nbytes: 100 },
      { offset: 100, nbytes: 50 },
    ]);
  });

  it("decodes an index protected by crc32c", async () => {
    const pipeline = await buildV3Pipeline(INDEX_CODECS_CRC);
    const raw = withCrc(rawIndex([[8n, 24n]]));
    const index = await decodeShardIndex(raw, 1, pipeline, "little");
    expect(index).toEqual([{ offset: 8, nbytes: 24 }]);
  });

  it("maps the reserved 2^64-1 marker to an empty inner chunk (null)", async () => {
    const pipeline = await buildV3Pipeline(INDEX_CODECS_PLAIN);
    const raw = rawIndex([
      [0n, 16n],
      [EMPTY, EMPTY],
    ]);
    const index = await decodeShardIndex(raw, 2, pipeline, "little");
    expect(index[0]).toEqual({ offset: 0, nbytes: 16 });
    expect(index[1]).toBeNull();
  });

  it("throws a corruption error when the index crc32c fails (FR-008a)", async () => {
    const pipeline = await buildV3Pipeline(INDEX_CODECS_CRC);
    const good = withCrc(rawIndex([[0n, 8n]]));
    good[0] ^= 0xff; // corrupt an index byte
    await expect(decodeShardIndex(good, 1, pipeline, "little")).rejects.toThrow(
      CodecError,
    );
  });

  it("throws a clear error on a malformed (wrong-size) index", async () => {
    const pipeline = await buildV3Pipeline(INDEX_CODECS_PLAIN);
    const raw = rawIndex([[0n, 8n]]); // 1 entry, but 2 expected
    await expect(decodeShardIndex(raw, 2, pipeline, "little")).rejects.toThrow(
      MetadataError,
    );
    await expect(decodeShardIndex(raw, 2, pipeline, "little")).rejects.toThrow(
      /index/i,
    );
  });

  it("reads big-endian index entries when the index bytes codec says so", async () => {
    const pipeline = await buildV3Pipeline([
      { name: "bytes", configuration: { endian: "big" } },
    ]);
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    view.setBigUint64(0, 32n, false);
    view.setBigUint64(8, 64n, false);
    const index = await decodeShardIndex(out, 1, pipeline, "big");
    expect(index).toEqual([{ offset: 32, nbytes: 64 }]);
  });
});
