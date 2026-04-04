import { describe, it, expect } from "vitest";
import { parseConsolidatedMetadata } from "../../src/metadata/consolidated.js";

const encoder = new TextEncoder();

function encode(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

describe("parseConsolidatedMetadata", () => {
  it("parses valid .zmetadata with arrays and groups", () => {
    const raw = encode({
      metadata: {
        ".zattrs": { description: "test" },
        ".zgroup": { zarr_format: 2 },
        "arr/.zarray": { shape: [10], dtype: "<f4", zarr_format: 2 },
        "arr/.zattrs": { units: "K" },
      },
    });

    const meta = parseConsolidatedMetadata(raw);

    expect(meta.has(".zattrs")).toBe(true);
    expect(meta.has(".zgroup")).toBe(true);
    expect(meta.has("arr/.zarray")).toBe(true);
    expect(meta.has("arr/.zattrs")).toBe(true);
    expect(meta.has("nonexistent")).toBe(false);
  });

  it("get() returns Uint8Array of JSON for existing key", () => {
    const raw = encode({
      metadata: {
        "arr/.zarray": { shape: [5], dtype: "<i4" },
      },
    });

    const meta = parseConsolidatedMetadata(raw);
    const result = meta.get("arr/.zarray");

    expect(result).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(result!));
    expect(parsed.shape).toEqual([5]);
    expect(parsed.dtype).toBe("<i4");
  });

  it("get() returns null for missing key", () => {
    const raw = encode({ metadata: {} });
    const meta = parseConsolidatedMetadata(raw);
    expect(meta.get("missing/.zarray")).toBeNull();
  });

  it("listChildren() extracts unique direct children at root", () => {
    const raw = encode({
      metadata: {
        ".zattrs": {},
        ".zgroup": { zarr_format: 2 },
        "temperature/.zarray": { shape: [10] },
        "temperature/.zattrs": {},
        "pressure/.zarray": { shape: [20] },
        "group1/.zgroup": { zarr_format: 2 },
      },
    });

    const meta = parseConsolidatedMetadata(raw);
    const children = meta.listChildren("");
    expect(children.sort()).toEqual(["group1", "pressure", "temperature"]);
  });

  it("listChildren() extracts children under a prefix", () => {
    const raw = encode({
      metadata: {
        "level1/.zgroup": { zarr_format: 2 },
        "level1/array_a/.zarray": { shape: [3] },
        "level1/level2/.zgroup": { zarr_format: 2 },
      },
    });

    const meta = parseConsolidatedMetadata(raw);
    const children = meta.listChildren("level1");
    expect(children.sort()).toEqual(["array_a", "level2"]);
  });

  it("throws on malformed JSON", () => {
    const raw = encoder.encode("not valid json{{{");
    expect(() => parseConsolidatedMetadata(raw)).toThrow();
  });

  it("throws when 'metadata' key is missing", () => {
    const raw = encode({ something_else: {} });
    expect(() => parseConsolidatedMetadata(raw)).toThrow("metadata");
  });

  it("handles empty metadata object", () => {
    const raw = encode({ metadata: {} });
    const meta = parseConsolidatedMetadata(raw);
    expect(meta.has(".zgroup")).toBe(false);
    expect(meta.listChildren("")).toEqual([]);
  });
});
