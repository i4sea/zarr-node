import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray, openGroup, open } from "../../src/index.js";
import { ZarrArray } from "../../src/array.js";
import { ZarrGroup } from "../../src/group.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

async function loadExpected(fixtureName: string) {
  const raw = await readFile(
    join(FIXTURES, fixtureName, "expected.json"),
    "utf-8",
  );
  return JSON.parse(raw) as { shape: number[]; dtype: string; data: number[] };
}

describe("US2: automatic version detection — same call, no version argument", () => {
  it("the same openArray call resolves a v2 fixture and a v3 fixture", async () => {
    // v2 (.zarray)
    const v2Expected = await loadExpected("chunked_2d");
    const v2 = await openArray(
      new FileSystemStore({ path: join(FIXTURES, "chunked_2d") }),
    );
    expect(v2.dtype).toBe("<i4"); // v2 typestr preserved byte-for-byte
    const v2Data = await v2.get([
      [0, 5],
      [0, 5],
    ]);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        expect(v2Data[r * 5 + c]).toBe(v2Expected.data[r * 200 + c]);
      }
    }

    // v3 (zarr.json) — identical call shape
    const v3Expected = await loadExpected("v3_chunked_2d");
    const v3 = await openArray(
      new FileSystemStore({ path: join(FIXTURES, "v3_chunked_2d") }),
    );
    expect(v3.dtype).toBe("int32"); // v3 name surfaced
    const v3Data = await v3.get([
      [0, 5],
      [0, 5],
    ]);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        expect(v3Data[r * 5 + c]).toBe(v3Expected.data[r * 200 + c]);
      }
    }
  });

  it("the same openGroup call resolves v2 and v3 group fixtures", async () => {
    const v2 = await openGroup(
      new FileSystemStore({ path: join(FIXTURES, "nested_groups") }),
    );
    expect(v2).toBeInstanceOf(ZarrGroup);
    expect(v2.attrs).toEqual({ description: "Test nested groups" });

    const v3 = await openGroup(
      new FileSystemStore({ path: join(FIXTURES, "v3_group") }),
    );
    expect(v3).toBeInstanceOf(ZarrGroup);
    expect(v3.attrs).toEqual({ description: "v3 test group" });
  });

  it("open() dispatches to array vs group across both formats", async () => {
    const v2Arr = await open(
      new FileSystemStore({ path: join(FIXTURES, "simple_1d") }),
    );
    expect(v2Arr).toBeInstanceOf(ZarrArray);

    const v2Grp = await open(
      new FileSystemStore({ path: join(FIXTURES, "nested_groups") }),
    );
    expect(v2Grp).toBeInstanceOf(ZarrGroup);

    const v3Arr = await open(
      new FileSystemStore({ path: join(FIXTURES, "v3_simple_1d") }),
    );
    expect(v3Arr).toBeInstanceOf(ZarrArray);

    const v3Grp = await open(
      new FileSystemStore({ path: join(FIXTURES, "v3_group") }),
    );
    expect(v3Grp).toBeInstanceOf(ZarrGroup);
  });
});
