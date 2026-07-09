import { describe, it, expect } from "vitest";
import { detectNode, metadataKey } from "../../src/metadata/layout.js";
import { MetadataError } from "../../src/errors.js";

const enc = new TextEncoder();

/** MetaReader over a fixed key → bytes map. */
function reader(entries: Record<string, unknown>) {
  const map = new Map<string, Uint8Array>(
    Object.entries(entries).map(([k, v]) => [k, enc.encode(JSON.stringify(v))]),
  );
  return async (key: string): Promise<Uint8Array | null> =>
    map.get(key) ?? null;
}

describe("layout.metadataKey", () => {
  it("builds v2 metadata keys under a base path", () => {
    expect(metadataKey("", ".zarray")).toBe(".zarray");
    expect(metadataKey("a/b", ".zgroup")).toBe("a/b/.zgroup");
    expect(metadataKey("a", ".zattrs")).toBe("a/.zattrs");
  });

  it("builds the v3 metadata key under a base path", () => {
    expect(metadataKey("", "zarr.json")).toBe("zarr.json");
    expect(metadataKey("nested/child", "zarr.json")).toBe(
      "nested/child/zarr.json",
    );
  });
});

describe("layout.detectNode — v2 branches", () => {
  it("detects a v2 array from .zarray", async () => {
    const read = reader({
      ".zarray": { zarr_format: 2, shape: [4], chunks: [4], dtype: "<f4" },
    });
    const node = await detectNode(read, "");
    expect(node.format).toBe(2);
    expect(node.nodeType).toBe("array");
    expect(node.raw).toBeInstanceOf(Uint8Array);
  });

  it("detects a v2 group from .zgroup", async () => {
    const read = reader({ ".zgroup": { zarr_format: 2 } });
    const node = await detectNode(read, "");
    expect(node.format).toBe(2);
    expect(node.nodeType).toBe("group");
  });

  it("detects a v2 array at a nested path", async () => {
    const read = reader({
      "sub/child/.zarray": { zarr_format: 2, shape: [1], chunks: [1] },
    });
    const node = await detectNode(read, "sub/child");
    expect(node.format).toBe(2);
    expect(node.nodeType).toBe("array");
  });

  it("throws MetadataError when the node does not exist", async () => {
    const read = reader({});
    await expect(detectNode(read, "missing")).rejects.toThrow(MetadataError);
    await expect(detectNode(read, "missing")).rejects.toThrow(/missing/);
  });
});
