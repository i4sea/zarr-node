import { describe, it, expect } from "vitest";
import { parseV3ConsolidatedMetadata } from "../../src/metadata/consolidated-v3.js";
import { MetadataError } from "../../src/errors.js";

const enc = new TextEncoder();

const ROOT_DOC = {
  zarr_format: 3,
  node_type: "group",
  attributes: { title: "root" },
  consolidated_metadata: {
    kind: "inline",
    must_understand: false,
    metadata: {
      data: {
        zarr_format: 3,
        node_type: "array",
        shape: [4],
        data_type: "int32",
      },
      sub: { zarr_format: 3, node_type: "group", attributes: { depth: 1 } },
      "sub/inner": {
        zarr_format: 3,
        node_type: "array",
        shape: [3],
        data_type: "float32",
      },
    },
  },
};

function rawRoot(doc: unknown = ROOT_DOC): Uint8Array {
  return enc.encode(JSON.stringify(doc));
}

describe("v3 consolidated metadata reader (FR-016)", () => {
  it("parses nested consolidated_metadata and answers get() with zarr.json keys", () => {
    const consolidated = parseV3ConsolidatedMetadata(rawRoot());
    expect(consolidated).not.toBeNull();

    const raw = consolidated!.get("sub/zarr.json");
    expect(raw).not.toBeNull();
    const doc = JSON.parse(new TextDecoder().decode(raw!));
    expect(doc.node_type).toBe("group");
    expect(doc.attributes).toEqual({ depth: 1 });

    expect(consolidated!.get("sub/inner/zarr.json")).not.toBeNull();
    expect(consolidated!.get("data/zarr.json")).not.toBeNull();
  });

  it("answers has() like the v2 lookup surface", () => {
    const consolidated = parseV3ConsolidatedMetadata(rawRoot())!;
    expect(consolidated.has("data/zarr.json")).toBe(true);
    expect(consolidated.has("missing/zarr.json")).toBe(false);
  });

  it("lists direct children per prefix like the v2 lookup surface", () => {
    const consolidated = parseV3ConsolidatedMetadata(rawRoot())!;
    expect(consolidated.listChildren("").sort()).toEqual(["data", "sub"]);
    expect(consolidated.listChildren("sub")).toEqual(["inner"]);
  });

  it("returns null when the root document has no consolidated_metadata", () => {
    const consolidated = parseV3ConsolidatedMetadata(
      rawRoot({ zarr_format: 3, node_type: "group" }),
    );
    expect(consolidated).toBeNull();
  });

  it("throws on a malformed consolidated_metadata block", () => {
    expect(() =>
      parseV3ConsolidatedMetadata(
        rawRoot({
          zarr_format: 3,
          node_type: "group",
          consolidated_metadata: { kind: "inline", metadata: "nope" },
        }),
      ),
    ).toThrow(MetadataError);
  });
});
