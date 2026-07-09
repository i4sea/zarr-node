import { describe, it, expect } from "vitest";
import { BytesCodec } from "../../src/codec/bytes.js";
import { parseV3ArrayMeta } from "../../src/metadata/v3.js";
import { ZarrArray } from "../../src/array.js";
import { MetadataError } from "../../src/errors.js";
import type { Store } from "../../src/store/store.js";

function v3ArrayDoc(
  dataType: string,
  codecs: unknown[],
  shape = [2],
  chunk = [2],
): string {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunk } },
    chunk_key_encoding: { name: "default" },
    fill_value: 0,
    codecs,
    attributes: {},
  });
}

function storeWith(entries: Record<string, Uint8Array>): Store {
  const map = new Map(Object.entries(entries));
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async has(key) {
      return map.has(key);
    },
    async *list() {},
  };
}

describe("bytes codec (FR-005, FR-008)", () => {
  it("resolves little and big byte orders from the endian config", () => {
    expect(new BytesCodec({ id: "bytes", endian: "little" }).resolveByteOrder(4)).toBe(
      "little",
    );
    expect(new BytesCodec({ id: "bytes", endian: "big" }).resolveByteOrder(2)).toBe(
      "big",
    );
  });

  it("endian omitted resolves to none for 1-byte types and does not throw", () => {
    const codec = new BytesCodec({ id: "bytes" });
    expect(codec.resolveByteOrder(1)).toBe("none");
  });

  it("endian omitted throws for multi-byte types", () => {
    const codec = new BytesCodec({ id: "bytes" });
    expect(() => codec.resolveByteOrder(4)).toThrow(MetadataError);
  });

  it("rejects an invalid endian value", () => {
    expect(() => new BytesCodec({ id: "bytes", endian: "middle" })).toThrow(
      MetadataError,
    );
  });

  it("decode passes bytes through unchanged", async () => {
    const codec = new BytesCodec({ id: "bytes", endian: "little" });
    const input = new Uint8Array([1, 2, 3, 4]);
    expect(await codec.decode(input)).toBe(input);
  });

  it("interprets big-endian uint16 chunk bytes correctly (known byte pair)", async () => {
    // Stored big-endian: [0x00, 0x01] = 1, [0x01, 0x00] = 256
    const doc = v3ArrayDoc("uint16", [
      { name: "bytes", configuration: { endian: "big" } },
    ]);
    const meta = await parseV3ArrayMeta(doc, "");
    expect(meta.dtype.byteOrder).toBe("big");

    const arr = new ZarrArray(
      storeWith({ "c/0": new Uint8Array([0x00, 0x01, 0x01, 0x00]) }),
      meta,
    );
    const data = await arr.get();
    expect(Array.from(data)).toEqual([1, 256]);
  });

  it("interprets little-endian uint16 chunk bytes correctly (known byte pair)", async () => {
    const doc = v3ArrayDoc("uint16", [
      { name: "bytes", configuration: { endian: "little" } },
    ]);
    const meta = await parseV3ArrayMeta(doc, "");
    expect(meta.dtype.byteOrder).toBe("little");

    const arr = new ZarrArray(
      storeWith({ "c/0": new Uint8Array([0x00, 0x01, 0x01, 0x00]) }),
      meta,
    );
    const data = await arr.get();
    expect(Array.from(data)).toEqual([256, 1]);
  });

  it("a 1-byte dtype with endian omitted parses to byteOrder none", async () => {
    const doc = v3ArrayDoc("uint8", [{ name: "bytes" }]);
    const meta = await parseV3ArrayMeta(doc, "");
    expect(meta.dtype.byteOrder).toBe("none");

    const arr = new ZarrArray(
      storeWith({ "c/0": new Uint8Array([7, 9]) }),
      meta,
    );
    expect(Array.from(await arr.get())).toEqual([7, 9]);
  });
});
