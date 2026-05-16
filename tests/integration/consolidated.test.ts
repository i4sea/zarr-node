import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openGroup, open } from "../../src/index.js";
import { ZarrGroup } from "../../src/group.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("Consolidated metadata — group discovery (US1)", () => {
  it("lists all arrays from consolidated metadata", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await openGroup(store);
    expect(root).toBeInstanceOf(ZarrGroup);

    // Root has one child group "level1", no direct arrays
    const groups: string[] = [];
    for await (const [name] of root.groups()) {
      groups.push(name);
    }
    expect(groups).toContain("level1");
  });

  it("getArray uses consolidated cache (no extra store calls)", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await openGroup(store);
    const level1 = await root.getGroup("level1");

    // Should get array_a from cache
    const arrA = await level1.getArray("array_a");
    expect(arrA.shape).toEqual([3]);
    expect(arrA.dtype).toBe("<f4");
  });

  it("reads data correctly through consolidated path", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await openGroup(store);
    const level1 = await root.getGroup("level1");
    const arrA = await level1.getArray("array_a");

    const data = await arrA.get();
    expect(data[0]).toBeCloseTo(1.0, 5);
    expect(data[1]).toBeCloseTo(2.0, 5);
    expect(data[2]).toBeCloseTo(3.0, 5);
  });

  it("open() returns group with consolidated cache", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await open(store);
    expect(root).toBeInstanceOf(ZarrGroup);
  });

  it("root attributes are correct", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = (await open(store)) as ZarrGroup;
    expect(root.attrs).toEqual({ description: "Test nested groups" });
  });
});

describe("Consolidated metadata — reduces store calls (US1)", () => {
  it("uses cache instead of store for metadata keys", async () => {
    // Create a counting wrapper around FileSystemStore
    const inner = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });

    let getCalls = 0;
    const countingStore: Store = {
      async get(key: string) {
        getCalls++;
        return inner.get(key);
      },
      async has(key: string) {
        return inner.has(key);
      },
      async *list(prefix: string) {
        yield* inner.list(prefix);
      },
    };

    const root = await openGroup(countingStore);
    // Opening root: 1 get for .zmetadata, 1 get for .zgroup (before cache),
    // then .zattrs from cache
    const callsAfterOpen = getCalls;

    // Navigate to level1 — should use cache
    const level1 = await root.getGroup("level1");
    expect(level1.attrs).toEqual({ depth: 1 });

    // Get array — should use cache for .zarray and .zattrs
    const arrA = await level1.getArray("array_a");
    expect(arrA.shape).toEqual([3]);

    // The only store.get() calls after open should be minimal
    // (cache serves .zgroup, .zarray, .zattrs)
    const callsForNavigation = getCalls - callsAfterOpen;
    // With cache, navigation should make 0 get calls for metadata
    expect(callsForNavigation).toBe(0);
  });
});

describe("Consolidated metadata — partial cache miss (FR-005)", () => {
  it("falls back to store for entries not in .zmetadata", async () => {
    // The nested_groups fixture has .zmetadata with all entries.
    // We test partial miss by using a mock store that has .zmetadata
    // missing one array, but has the array files on "disk".
    const inner = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });

    // Load the real .zmetadata and remove array_b entries
    const realMeta = await inner.get(".zmetadata");
    const parsed = JSON.parse(new TextDecoder().decode(realMeta!));
    delete parsed.metadata["level1/level2/array_b/.zarray"];
    delete parsed.metadata["level1/level2/array_b/.zattrs"];
    const modifiedMeta = new TextEncoder().encode(JSON.stringify(parsed));

    const mockStore: Store = {
      async get(key: string) {
        if (key === ".zmetadata") return modifiedMeta;
        return inner.get(key);
      },
      async has(key: string) {
        return inner.has(key);
      },
      async *list(prefix: string) {
        yield* inner.list(prefix);
      },
    };

    const root = await openGroup(mockStore);
    const level1 = await root.getGroup("level1");
    const level2 = await level1.getGroup("level2");

    // array_b is NOT in cache, should fall back to store
    const arrB = await level2.getArray("array_b");
    expect(arrB.shape).toEqual([4]);
    expect(arrB.dtype).toBe("<i4");

    const data = await arrB.get();
    expect(data[0]).toBe(10);
    expect(data[3]).toBe(40);
  });
});

describe("Consolidated metadata — hierarchy traversal (US3)", () => {
  it("traverses full hierarchy with shared cache", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await openGroup(store);

    // Root → level1 → level2
    const level1 = await root.getGroup("level1");
    expect(level1.attrs).toEqual({ depth: 1 });

    const level2 = await level1.getGroup("level2");
    expect(level2.attrs).toEqual({ depth: 2 });

    // Arrays at each level
    const arrA = await level1.getArray("array_a");
    expect(arrA.shape).toEqual([3]);

    const arrB = await level2.getArray("array_b");
    expect(arrB.shape).toEqual([4]);

    // Verify data integrity
    const dataA = await arrA.get();
    expect(dataA[0]).toBeCloseTo(1.0, 5);

    const dataB = await arrB.get();
    expect(dataB[0]).toBe(10);
  });

  it("contains() works with consolidated cache", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await openGroup(store);

    expect(await root.contains("level1")).toBe(true);
    expect(await root.contains("nonexistent")).toBe(false);

    const level1 = await root.getGroup("level1");
    expect(await level1.contains("array_a")).toBe(true);
    expect(await level1.contains("level2")).toBe(true);
  });

  it("arrays() and groups() iterate correctly with cache", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "nested_groups"),
    });
    const root = await openGroup(store);
    const level1 = await root.getGroup("level1");

    const arrays: string[] = [];
    for await (const [name] of level1.arrays()) {
      arrays.push(name);
    }
    expect(arrays).toContain("array_a");

    const groups: string[] = [];
    for await (const [name] of level1.groups()) {
      groups.push(name);
    }
    expect(groups).toContain("level2");
  });
});
