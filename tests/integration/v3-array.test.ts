import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray, openGroup, open } from "../../src/index.js";
import { ZarrGroup } from "../../src/group.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

async function loadExpected(fixtureName: string) {
  const raw = await readFile(
    join(FIXTURES, fixtureName, "expected.json"),
    "utf-8",
  );
  return JSON.parse(raw) as {
    shape: number[];
    dtype: string;
    data: number[];
  };
}

describe("US1: read a Zarr v3 array with the same public API", () => {
  it("opens v3_chunked_2d via openArray and reads the full array", async () => {
    const expected = await loadExpected("v3_chunked_2d");
    const store = new FileSystemStore({
      path: join(FIXTURES, "v3_chunked_2d"),
    });
    const arr = await openArray(store);

    expect(arr.shape).toEqual(expected.shape);
    expect(arr.dtype).toBe(expected.dtype); // "int32" — the v3 name
    expect(arr.chunks).toEqual([10, 20]);
    expect(arr.order).toBe("C");

    const data = await arr.get();
    expect(data).toBeInstanceOf(Int32Array);
    expect(data.length).toBe(expected.data.length);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBe(expected.data[i]);
    }
  });

  it("reads a sub-region of v3_chunked_2d", async () => {
    const expected = await loadExpected("v3_chunked_2d");
    const store = new FileSystemStore({
      path: join(FIXTURES, "v3_chunked_2d"),
    });
    const arr = await openArray(store);

    // shape [100, 200], slice [5:15, 15:25] spans chunk boundaries ([10, 20] chunks)
    const slice = await arr.get([
      [5, 15],
      [15, 25],
    ]);
    expect(slice.length).toBe(100);
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const expectedIdx = (5 + r) * 200 + (15 + c);
        expect(slice[r * 10 + c]).toBe(expected.data[expectedIdx]);
      }
    }
  });

  it("reads v3_simple_1d (float32, default codec chain)", async () => {
    const expected = await loadExpected("v3_simple_1d");
    const store = new FileSystemStore({ path: join(FIXTURES, "v3_simple_1d") });
    const arr = await openArray(store);

    expect(arr.dtype).toBe("float32");
    const data = await arr.get();
    expect(data).toBeInstanceOf(Float32Array);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 5);
    }
  });

  it("reads v3_uncompressed_2d (no compressor)", async () => {
    const expected = await loadExpected("v3_uncompressed_2d");
    const store = new FileSystemStore({
      path: join(FIXTURES, "v3_uncompressed_2d"),
    });
    const arr = await openArray(store);

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float64Array);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 12);
    }

    // Sub-region too (byte-range-eligible path: uncompressed + C order).
    const sub = await arr.get([
      [3, 12],
      [7, 19],
    ]);
    expect(sub.length).toBe(9 * 12);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 12; c++) {
        expect(sub[r * 12 + c]).toBeCloseTo(
          expected.data[(3 + r) * 30 + (7 + c)],
          12,
        );
      }
    }
  });
});

describe("US1: read a Zarr v3 group with the same public API", () => {
  async function loadGroupExpected() {
    const raw = await readFile(
      join(FIXTURES, "v3_group", "expected.json"),
      "utf-8",
    );
    return JSON.parse(raw) as {
      root_attrs: Record<string, unknown>;
      sub_attrs: Record<string, unknown>;
      data: { shape: number[]; dtype: string; data: number[] };
      inner: { shape: number[]; dtype: string; data: number[] };
    };
  }

  it("opens the root as a group via open() with attributes", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: join(FIXTURES, "v3_group") });
    const root = await open(store);
    expect(root).toBeInstanceOf(ZarrGroup);
    expect((root as ZarrGroup).attrs).toEqual(expected.root_attrs);
  });

  it("reads a child array of a v3 group", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: join(FIXTURES, "v3_group") });
    const root = await openGroup(store);
    const arr = await root.getArray("data");

    expect(arr.shape).toEqual(expected.data.shape);
    expect(arr.dtype).toBe(expected.data.dtype);
    const data = await arr.get();
    for (let i = 0; i < expected.data.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data.data[i], 5);
    }
  });

  it("navigates a nested v3 group and reads its array", async () => {
    const expected = await loadGroupExpected();
    const store = new FileSystemStore({ path: join(FIXTURES, "v3_group") });
    const root = await openGroup(store);
    const sub = await root.getGroup("sub");
    expect(sub.attrs).toEqual(expected.sub_attrs);

    const inner = await sub.getArray("inner");
    expect(inner.shape).toEqual(expected.inner.shape);
    const data = await inner.get();
    for (let i = 0; i < expected.inner.data.length; i++) {
      expect(data[i]).toBe(expected.inner.data[i]);
    }
  });

  it("iterates v3 group children", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "v3_group") });
    const root = await openGroup(store);

    const arrays: string[] = [];
    for await (const [name] of root.arrays()) arrays.push(name);
    expect(arrays).toContain("data");

    const groups: string[] = [];
    for await (const [name] of root.groups()) groups.push(name);
    expect(groups).toContain("sub");

    expect(await root.contains("data")).toBe(true);
    expect(await root.contains("nope")).toBe(false);
  });
});
