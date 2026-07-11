import { describe, it, expect } from "vitest";
import { parseV3ArrayMeta, parseV3GroupMeta } from "../../src/metadata/v3.js";
import { MetadataError } from "../../src/errors.js";

const enc = new TextEncoder();

function arrayDoc(overrides: Record<string, unknown> = {}): Uint8Array {
  return enc.encode(
    JSON.stringify({
      zarr_format: 3,
      node_type: "array",
      shape: [100, 200],
      data_type: "int32",
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: [10, 20] },
      },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: 0,
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      attributes: {},
      ...overrides,
    }),
  );
}

function groupDoc(overrides: Record<string, unknown> = {}): Uint8Array {
  return enc.encode(
    JSON.stringify({
      zarr_format: 3,
      node_type: "group",
      attributes: { title: "g" },
      ...overrides,
    }),
  );
}

describe("v3 array metadata parse (FR-003)", () => {
  it("parses a regular array document into neutral metadata", async () => {
    const meta = await parseV3ArrayMeta(arrayDoc(), "path/arr");
    expect(meta.zarrFormat).toBe(3);
    expect(meta.shape).toEqual([100, 200]);
    expect(meta.chunkShape).toEqual([10, 20]);
    expect(meta.dtypeName).toBe("int32");
    expect(meta.dtype.ctor).toBe(Int32Array);
    expect(meta.dtype.byteOrder).toBe("little");
    expect(meta.order).toBe("C");
    expect(meta.fillValue).toBe(0);
    expect(meta.chunkKey).toEqual({
      kind: "v3-default",
      separator: "/",
      prefix: "c",
      basePath: "path/arr",
    });
  });

  it("supports the v2 chunk_key_encoding", async () => {
    const meta = await parseV3ArrayMeta(
      arrayDoc({
        chunk_key_encoding: { name: "v2", configuration: { separator: "." } },
      }),
      "",
    );
    expect(meta.chunkKey.kind).toBe("v2");
    expect(meta.chunkKey.separator).toBe(".");
    expect(meta.chunkKey.prefix).toBeNull();
    expect(meta.chunkKey.basePath).toBeNull();
  });

  it("defaults the default encoding separator to /", async () => {
    const meta = await parseV3ArrayMeta(
      arrayDoc({ chunk_key_encoding: { name: "default" } }),
      "",
    );
    expect(meta.chunkKey.separator).toBe("/");
    expect(meta.chunkKey.prefix).toBe("c");
  });

  it("parses special float fill values (FR-011)", async () => {
    const nan = await parseV3ArrayMeta(
      arrayDoc({ data_type: "float64", fill_value: "NaN" }),
      "",
    );
    expect(Number.isNaN(nan.fillValue as number)).toBe(true);

    const inf = await parseV3ArrayMeta(
      arrayDoc({ data_type: "float64", fill_value: "Infinity" }),
      "",
    );
    expect(inf.fillValue).toBe(Infinity);

    const ninf = await parseV3ArrayMeta(
      arrayDoc({ data_type: "float64", fill_value: "-Infinity" }),
      "",
    );
    expect(ninf.fillValue).toBe(-Infinity);
  });

  it("parses byte-form (hex string) float fill values (FR-011)", async () => {
    // 0x7fc00000 = float32 quiet NaN bit pattern
    const meta = await parseV3ArrayMeta(
      arrayDoc({ data_type: "float32", fill_value: "0x7fc00000" }),
      "",
    );
    expect(Number.isNaN(meta.fillValue as number)).toBe(true);

    // 0x3f800000 = float32 1.0
    const one = await parseV3ArrayMeta(
      arrayDoc({ data_type: "float32", fill_value: "0x3f800000" }),
      "",
    );
    expect(one.fillValue).toBe(1.0);
  });

  it("parses a bool fill value", async () => {
    const meta = await parseV3ArrayMeta(
      arrayDoc({ data_type: "bool", fill_value: true }),
      "",
    );
    expect(meta.fillValue).toBe(true);
  });

  it("sign-extends hex fill values for signed integer dtypes (FR-011)", async () => {
    // int8 0xff is the two's-complement pattern for -1, not 255.
    const i8 = await parseV3ArrayMeta(
      arrayDoc({
        data_type: "int8",
        fill_value: "0xff",
        codecs: [{ name: "bytes" }],
      }),
      "",
    );
    expect(i8.fillValue).toBe(-1);

    // int16 0xfffe → -2
    const i16 = await parseV3ArrayMeta(
      arrayDoc({ data_type: "int16", fill_value: "0xfffe" }),
      "",
    );
    expect(i16.fillValue).toBe(-2);

    // int32 0xffffffff → -1
    const i32 = await parseV3ArrayMeta(
      arrayDoc({ data_type: "int32", fill_value: "0xffffffff" }),
      "",
    );
    expect(i32.fillValue).toBe(-1);
  });

  it("keeps unsigned integer hex fill values unsigned (FR-011)", async () => {
    const u8 = await parseV3ArrayMeta(
      arrayDoc({
        data_type: "uint8",
        fill_value: "0xff",
        codecs: [{ name: "bytes" }],
      }),
      "",
    );
    expect(u8.fillValue).toBe(255);

    const u16 = await parseV3ArrayMeta(
      arrayDoc({ data_type: "uint16", fill_value: "0xfffe" }),
      "",
    );
    expect(u16.fillValue).toBe(65534);
  });

  it("carries attributes through", async () => {
    const meta = await parseV3ArrayMeta(
      arrayDoc({ attributes: { units: "K" } }),
      "",
    );
    expect(meta.attrs).toEqual({ units: "K" });
  });

  it("rejects an unknown zarr_format (FR-021)", async () => {
    await expect(
      parseV3ArrayMeta(arrayDoc({ zarr_format: 4 }), ""),
    ).rejects.toThrow(MetadataError);
  });

  it("rejects an unknown data_type (FR-004)", async () => {
    await expect(
      parseV3ArrayMeta(arrayDoc({ data_type: "complex128" }), ""),
    ).rejects.toThrow(MetadataError);
    await expect(
      parseV3ArrayMeta(arrayDoc({ data_type: "complex128" }), ""),
    ).rejects.toThrow(/complex128/);
  });

  it("rejects a non-regular chunk grid", async () => {
    await expect(
      parseV3ArrayMeta(
        arrayDoc({ chunk_grid: { name: "rectilinear", configuration: {} } }),
        "",
      ),
    ).rejects.toThrow(MetadataError);
  });

  it("rejects rank mismatch between shape and chunk_shape", async () => {
    await expect(
      parseV3ArrayMeta(
        arrayDoc({
          chunk_grid: { name: "regular", configuration: { chunk_shape: [10] } },
        }),
        "",
      ),
    ).rejects.toThrow(MetadataError);
  });

  it("rejects a group document passed to the array parser", async () => {
    await expect(parseV3ArrayMeta(groupDoc(), "")).rejects.toThrow(
      MetadataError,
    );
  });
});

describe("v3 group metadata parse (FR-003)", () => {
  it("parses a group document with attributes", () => {
    const meta = parseV3GroupMeta(groupDoc());
    expect(meta.zarrFormat).toBe(3);
    expect(meta.attrs).toEqual({ title: "g" });
  });

  it("defaults attributes to {}", () => {
    const meta = parseV3GroupMeta(groupDoc({ attributes: undefined }));
    expect(meta.attrs).toEqual({});
  });

  it("rejects an array document passed to the group parser", () => {
    expect(() => parseV3GroupMeta(arrayDoc())).toThrow(MetadataError);
  });

  it("rejects an unknown zarr_format", () => {
    expect(() => parseV3GroupMeta(groupDoc({ zarr_format: 1 }))).toThrow(
      MetadataError,
    );
  });
});
