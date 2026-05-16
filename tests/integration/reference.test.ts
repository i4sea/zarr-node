import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ReferenceStore } from "../../src/store/reference.js";
import { openArray } from "../../src/index.js";

describe("ReferenceStore", () => {
  // T027: Inline string values (metadata entries)
  it("resolves inline string references", async () => {
    const store = new ReferenceStore({
      spec: {
        version: 1,
        refs: {
          ".zgroup": '{"zarr_format":2}',
          ".zattrs": '{"description":"inline test"}',
        },
      },
    });

    const zgroup = await store.get(".zgroup");
    expect(zgroup).not.toBeNull();
    expect(new TextDecoder().decode(zgroup!)).toBe('{"zarr_format":2}');

    const zattrs = await store.get(".zattrs");
    expect(new TextDecoder().decode(zattrs!)).toBe(
      '{"description":"inline test"}',
    );
  });

  // T028: Byte-range references [url, offset, length] pointing to local files
  it("resolves byte-range references to local files", async () => {
    // Create a temp file with known content
    const tmpDir = join(tmpdir(), `zarr-ref-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const dataFile = join(tmpDir, "data.bin");

    // Write 40 bytes: 10 float32 values [0.0, 1.0, ..., 9.0]
    const floats = new Float32Array(10);
    for (let i = 0; i < 10; i++) floats[i] = i;
    await writeFile(dataFile, new Uint8Array(floats.buffer));

    try {
      const store = new ReferenceStore({
        spec: {
          version: 1,
          refs: {
            ".zarray": JSON.stringify({
              zarr_format: 2,
              shape: [5],
              chunks: [5],
              dtype: "<f4",
              compressor: null,
              fill_value: 0.0,
              order: "C",
              filters: null,
              dimension_separator: ".",
            }),
            ".zattrs": "{}",
            // Reference first 20 bytes (5 floats) from data file
            "0": [dataFile, 0, 20],
          },
        },
      });

      // Read the chunk via byte-range reference
      const chunk = await store.get("0");
      expect(chunk).not.toBeNull();
      expect(chunk!.byteLength).toBe(20);

      const values = new Float32Array(chunk!.buffer, chunk!.byteOffset, 5);
      expect(Array.from(values)).toEqual([0, 1, 2, 3, 4]);

      // Verify we can open this as a zarr array
      const arr = await openArray(store);
      const data = await arr.get();
      expect(data.length).toBe(5);
      expect(Array.from(data)).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // T029: list() and has() operations
  it("supports has() and list() operations", async () => {
    const store = new ReferenceStore({
      spec: {
        version: 1,
        refs: {
          ".zgroup": '{"zarr_format":2}',
          ".zattrs": "{}",
          "var/.zarray": '{"zarr_format":2}',
          "var/0": ["file:///data.bin", 0, 100],
          "var/1": ["file:///data.bin", 100, 100],
        },
      },
    });

    // has()
    expect(await store.has(".zgroup")).toBe(true);
    expect(await store.has("var/.zarray")).toBe(true);
    expect(await store.has("nonexistent")).toBe(false);

    // list()
    const keys: string[] = [];
    for await (const key of store.list("var/")) {
      keys.push(key);
    }
    expect(keys).toContain("var/.zarray");
    expect(keys).toContain("var/0");
    expect(keys).toContain("var/1");
    expect(keys.length).toBe(3);
  });

  it("reports refCount", () => {
    const store = new ReferenceStore({
      spec: {
        version: 1,
        refs: {
          ".zgroup": '{"zarr_format":2}',
          "0": ["file:///data.bin", 0, 100],
        },
      },
    });
    expect(store.refCount).toBe(2);
  });

  it("handles [url] single-element reference", async () => {
    // Create a temp file
    const tmpDir = join(tmpdir(), `zarr-ref-single-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const dataFile = join(tmpDir, "chunk.bin");
    await writeFile(dataFile, new Uint8Array([1, 2, 3, 4]));

    try {
      const store = new ReferenceStore({
        spec: {
          version: 1,
          refs: {
            "0": [dataFile],
          },
        },
      });

      const data = await store.get("0");
      expect(data).not.toBeNull();
      expect(Array.from(data!)).toEqual([1, 2, 3, 4]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads spec from a JSON file via fromFile()", async () => {
    const tmpDir = join(tmpdir(), `zarr-ref-fromfile-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const specPath = join(tmpDir, "refs.json");
    const spec = {
      version: 1,
      refs: {
        ".zgroup": '{"zarr_format":2}',
        ".zattrs": '{"loaded":"from file"}',
      },
    };
    await writeFile(specPath, JSON.stringify(spec));

    try {
      const store = await ReferenceStore.fromFile(specPath);
      expect(store.refCount).toBe(2);

      const zattrs = await store.get(".zattrs");
      expect(new TextDecoder().decode(zattrs!)).toBe('{"loaded":"from file"}');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
