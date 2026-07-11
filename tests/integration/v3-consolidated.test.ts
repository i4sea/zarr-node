import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openGroup } from "../../src/index.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const FIXTURE = join(FIXTURES, "v3_consolidated");

async function loadExpected() {
  const raw = await readFile(join(FIXTURE, "expected.json"), "utf-8");
  return JSON.parse(raw) as {
    root_attrs: Record<string, unknown>;
    sub_attrs: Record<string, unknown>;
    data: { shape: number[]; dtype: string; data: number[] };
    inner: { shape: number[]; dtype: string; data: number[] };
  };
}

function countingStore(inner: FileSystemStore): {
  store: Store;
  metadataGets: () => string[];
} {
  const gets: string[] = [];
  const store: Store = {
    async get(key) {
      gets.push(key);
      return inner.get(key);
    },
    async has(key) {
      return inner.has(key);
    },
    async *list(prefix) {
      yield* inner.list(prefix);
    },
    getRange: (key, offset, length) => inner.getRange(key, offset, length),
    head: (key) => inner.head(key),
  };
  return {
    store,
    metadataGets: () => gets.filter((k) => k.endsWith("zarr.json")),
  };
}

describe("US5: v3 consolidated metadata at the root (FR-016, SC-005)", () => {
  it("resolves children with zero per-node metadata fetches", async () => {
    const { store, metadataGets } = countingStore(
      new FileSystemStore({ path: FIXTURE }),
    );

    const root = await openGroup(store);
    const afterOpen = metadataGets().length; // the root zarr.json read

    // Navigate: group attrs, child group, arrays — all from consolidated.
    const expected = await loadExpected();
    expect(root.attrs).toEqual(expected.root_attrs);

    const sub = await root.getGroup("sub");
    expect(sub.attrs).toEqual(expected.sub_attrs);

    const data = await root.getArray("data");
    expect(data.shape).toEqual(expected.data.shape);

    const innerArr = await sub.getArray("inner");
    expect(innerArr.shape).toEqual(expected.inner.shape);

    expect(await root.contains("data")).toBe(true);

    // Zero zarr.json fetches beyond the root open (SC-005).
    expect(metadataGets().length - afterOpen).toBe(0);

    // A nonexistent child probes the store once — consolidated metadata may
    // legitimately be incomplete (FR-005 fallback), so absence from it is
    // not authoritative.
    expect(await root.contains("nope")).toBe(false);
  });

  it("reads values identical to a non-consolidated read", async () => {
    const expected = await loadExpected();

    const root = await openGroup(new FileSystemStore({ path: FIXTURE }));
    const data = await (await root.getArray("data")).get();
    for (let i = 0; i < expected.data.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data.data[i], 5);
    }

    const sub = await root.getGroup("sub");
    const inner = await (await sub.getArray("inner")).get();
    expect(Array.from(inner)).toEqual(expected.inner.data);
  });

  it("lists children from consolidated metadata", async () => {
    const root = await openGroup(new FileSystemStore({ path: FIXTURE }));

    const arrays: string[] = [];
    for await (const [name] of root.arrays()) arrays.push(name);
    expect(arrays).toEqual(["data"]);

    const groups: string[] = [];
    for await (const [name] of root.groups()) groups.push(name);
    expect(groups).toEqual(["sub"]);
  });
});
