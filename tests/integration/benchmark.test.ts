import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

async function fixtureExists(name: string): Promise<boolean> {
  try {
    await access(join(FIXTURES, name, ".zarray"));
    return true;
  } catch {
    return false;
  }
}

describe("T049 — Performance: 100MB array read < 2 seconds", () => {
  it("reads 100MB chunked array from filesystem in < 2 seconds", async () => {
    const exists = await fixtureExists("large_100mb");
    if (!exists) {
      console.log("Skipping: large_100mb fixture not found. Run: .venv/bin/python tests/fixtures/generate_large.py");
      return;
    }

    const store = new FileSystemStore({ path: join(FIXTURES, "large_100mb") });
    const arr = await openArray(store);

    expect(arr.shape).toEqual([5000, 5000]);
    expect(arr.dtype).toBe("<f4");

    const start = performance.now();
    const data = await arr.get();
    const elapsed = performance.now() - start;

    expect(data.length).toBe(25_000_000);
    expect(data).toBeInstanceOf(Float32Array);

    console.log(`  100MB read: ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("T050 — Memory: slice read of 1GB array < 100MB overhead", () => {
  it("reads a small slice of 1GB array without excessive memory usage", async () => {
    const exists = await fixtureExists("large_1gb");
    if (!exists) {
      console.log("Skipping: large_1gb fixture not found. Run: .venv/bin/python tests/fixtures/generate_large.py");
      return;
    }

    const store = new FileSystemStore({ path: join(FIXTURES, "large_1gb") });
    const arr = await openArray(store);

    expect(arr.shape).toEqual([16384, 8192]);
    expect(arr.dtype).toBe("<f8");

    // Force GC before measurement
    if (global.gc) global.gc();
    const memBefore = process.memoryUsage().heapUsed;

    // Read a small slice: [0:100, 0:100] = 10,000 elements * 8 bytes = 80KB
    // This should only fetch the chunks needed (chunk size 1024x1024),
    // so at most 1 chunk = ~8MB, well under 100MB overhead
    const slice = await arr.get([[0, 100], [0, 100]]);

    const memAfter = process.memoryUsage().heapUsed;
    const overheadMB = (memAfter - memBefore) / (1024 * 1024);

    expect(slice.length).toBe(10_000);
    expect(slice).toBeInstanceOf(Float64Array);

    console.log(`  Slice read memory overhead: ${overheadMB.toFixed(1)}MB`);
    expect(overheadMB).toBeLessThan(100);
  });
});
