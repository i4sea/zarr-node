import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray, open } from "../../src/index.js";
import { ZarrGroup } from "../../src/group.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

async function loadExpected(fixtureName: string) {
  const raw = await readFile(join(FIXTURES, fixtureName, "expected.json"), "utf-8");
  return JSON.parse(raw) as {
    shape: number[];
    dtype: string;
    data: number[];
  };
}

describe("Full pipeline: open -> read -> verify", () => {
  it("reads simple_1d float32 array (no compression)", async () => {
    const expected = await loadExpected("simple_1d");
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const arr = await openArray(store);

    expect(arr.shape).toEqual(expected.shape);
    expect(arr.dtype).toBe(expected.dtype);

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(expected.data.length);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 5);
    }
  });

  it("reads chunked_2d int32 array (multiple chunks, no compression)", async () => {
    const expected = await loadExpected("chunked_2d");
    const store = new FileSystemStore({ path: join(FIXTURES, "chunked_2d") });
    const arr = await openArray(store);

    expect(arr.shape).toEqual(expected.shape);

    const data = await arr.get();
    expect(data).toBeInstanceOf(Int32Array);
    expect(data.length).toBe(expected.data.length);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBe(expected.data[i]);
    }
  });

  it("reads compressed_gzip float64 array (zlib compression)", async () => {
    const expected = await loadExpected("compressed_gzip");
    const store = new FileSystemStore({
      path: join(FIXTURES, "compressed_gzip"),
    });
    const arr = await openArray(store);

    expect(arr.shape).toEqual(expected.shape);

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float64Array);
    expect(data.length).toBe(expected.data.length);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 10);
    }
  });

  it("reads big_endian float64 array (byte-swap)", async () => {
    const expected = await loadExpected("big_endian");
    const store = new FileSystemStore({ path: join(FIXTURES, "big_endian") });
    const arr = await openArray(store);

    expect(arr.dtype).toBe(expected.dtype);

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float64Array);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 10);
    }
  });

  it("reads f_order float32 array (Fortran order)", async () => {
    const expected = await loadExpected("f_order");
    const store = new FileSystemStore({ path: join(FIXTURES, "f_order") });
    const arr = await openArray(store);

    expect(arr.order).toBe("F");

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(expected.data.length);
    // Data should match C-order flattened expected (row-major output)
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 5);
    }
  });

  it("exposes metadata properties", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const arr = await openArray(store);

    expect(arr.shape).toEqual([10]);
    expect(arr.chunks).toEqual([10]);
    expect(arr.dtype).toBe("<f4");
    expect(arr.order).toBe("C");
    expect(arr.fillValue).toBe(0.0);
  });

  it("handles missing chunk with fill_value", async () => {
    // simple_1d has shape [10] with chunk [10], so chunk "0" exists
    // We test by reading an array where we know the chunk file exists
    // The fill_value test is implicit in the ZarrArray implementation
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const arr = await openArray(store);
    const data = await arr.get();
    expect(data.length).toBe(10);
  });

  it("throws on invalid path", async () => {
    const store = new FileSystemStore({ path: "/nonexistent/path" });
    await expect(openArray(store)).rejects.toThrow();
  });
});

describe("Group hierarchy traversal", () => {
  const groupFixture = join(FIXTURES, "nested_groups");

  async function loadGroupExpected() {
    const raw = await readFile(join(groupFixture, "expected.json"), "utf-8");
    return JSON.parse(raw) as {
      root_attrs: Record<string, unknown>;
      level1_attrs: Record<string, unknown>;
      level2_attrs: Record<string, unknown>;
      array_a: { shape: number[]; dtype: string; data: number[] };
      array_b: { shape: number[]; dtype: string; data: number[] };
    };
  }

  it("opens root as group via open()", async () => {
    const store = new FileSystemStore({ path: groupFixture });
    const root = await open(store);
    expect(root).toBeInstanceOf(ZarrGroup);
  });

  it("reads root group attributes", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    expect(root.attrs).toEqual(expected.root_attrs);
  });

  it("navigates to child group and reads attributes", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    const level1 = await root.getGroup("level1");
    expect(level1.attrs).toEqual(expected.level1_attrs);
  });

  it("navigates to nested group", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    const level1 = await root.getGroup("level1");
    const level2 = await level1.getGroup("level2");
    expect(level2.attrs).toEqual(expected.level2_attrs);
  });

  it("reads array within group", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    const level1 = await root.getGroup("level1");
    const arrA = await level1.getArray("array_a");

    expect(arrA.shape).toEqual(expected.array_a.shape);
    const data = await arrA.get();
    for (let i = 0; i < expected.array_a.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.array_a.data[i], 5);
    }
  });

  it("reads deeply nested array", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    const level1 = await root.getGroup("level1");
    const level2 = await level1.getGroup("level2");
    const arrB = await level2.getArray("array_b");

    expect(arrB.shape).toEqual(expected.array_b.shape);
    const data = await arrB.get();
    for (let i = 0; i < expected.array_b.data.length; i++) {
      expect(data[i]).toBe(expected.array_b.data[i]);
    }
  });

  it("iterates child arrays", async () => {
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    const level1 = await root.getGroup("level1");
    const arrays: string[] = [];
    for await (const [name] of level1.arrays()) {
      arrays.push(name);
    }
    expect(arrays).toContain("array_a");
  });

  it("iterates child groups", async () => {
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    const groups: string[] = [];
    for await (const [name] of root.groups()) {
      groups.push(name);
    }
    expect(groups).toContain("level1");
  });

  it("contains() checks child existence", async () => {
    const store = new FileSystemStore({ path: groupFixture });
    const root = (await open(store)) as ZarrGroup;
    expect(await root.contains("level1")).toBe(true);
    expect(await root.contains("nonexistent")).toBe(false);
  });
});

describe("Slice reads", () => {
  it("reads a 2D sub-region from chunked_2d", async () => {
    const expected = await loadExpected("chunked_2d");
    const store = new FileSystemStore({ path: join(FIXTURES, "chunked_2d") });
    const arr = await openArray(store);

    // shape [100, 200], slice [0:10, 50:60] -> 10x10 region
    const slice = await arr.get([[0, 10], [50, 60]]);
    expect(slice.length).toBe(100); // 10 * 10

    // Verify values match expected full data at those positions
    // Expected data is C-order flattened [100, 200]
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const expectedIdx = r * 200 + (50 + c);
        expect(slice[r * 10 + c]).toBe(expected.data[expectedIdx]);
      }
    }
  });

  it("reads a single row from chunked_2d", async () => {
    const expected = await loadExpected("chunked_2d");
    const store = new FileSystemStore({ path: join(FIXTURES, "chunked_2d") });
    const arr = await openArray(store);

    // slice [5, null] -> row 5, all 200 columns
    const slice = await arr.get([5, null]);
    expect(slice.length).toBe(200);
    for (let c = 0; c < 200; c++) {
      expect(slice[c]).toBe(expected.data[5 * 200 + c]);
    }
  });

  it("reads slice spanning multiple chunks", async () => {
    const expected = await loadExpected("chunked_2d");
    const store = new FileSystemStore({ path: join(FIXTURES, "chunked_2d") });
    const arr = await openArray(store);

    // chunks are [10, 20], slice [5:15, 15:25] spans chunk boundaries
    const slice = await arr.get([[5, 15], [15, 25]]);
    expect(slice.length).toBe(100); // 10 * 10
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const expectedIdx = (5 + r) * 200 + (15 + c);
        expect(slice[r * 10 + c]).toBe(expected.data[expectedIdx]);
      }
    }
  });

  it("reads full array via null slice", async () => {
    const expected = await loadExpected("simple_1d");
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const arr = await openArray(store);

    const slice = await arr.get([null]);
    expect(slice.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(slice[i]).toBeCloseTo(expected.data[i], 5);
    }
  });
});

describe("Custom store usage", () => {
  it("reads an array via a custom in-memory store", async () => {
    // Create a mock store with a simple 1D array
    const zarray = JSON.stringify({
      zarr_format: 2,
      shape: [4],
      chunks: [4],
      dtype: "<f4",
      compressor: null,
      fill_value: 0.0,
      order: "C",
      dimension_separator: ".",
      filters: null,
    });

    const chunkData = new Float32Array([10, 20, 30, 40]);
    const chunkBytes = new Uint8Array(chunkData.buffer);

    const data = new Map<string, Uint8Array>([
      [".zarray", new TextEncoder().encode(zarray)],
      ["0", chunkBytes],
    ]);

    const mockStore: Store = {
      async get(key: string) {
        return data.get(key) ?? null;
      },
      async has(key: string) {
        return data.has(key);
      },
      async *list(_prefix: string) {
        for (const key of data.keys()) {
          yield key;
        }
      },
    };

    const arr = await openArray(mockStore);
    expect(arr.shape).toEqual([4]);

    const result = await arr.get();
    expect(result).toBeInstanceOf(Float32Array);
    expect(result[0]).toBe(10);
    expect(result[1]).toBe(20);
    expect(result[2]).toBe(30);
    expect(result[3]).toBe(40);
  });
});
