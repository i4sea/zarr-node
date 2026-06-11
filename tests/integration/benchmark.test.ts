import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";
import type { Store } from "../../src/store/store.js";

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
      console.log(
        "Skipping: large_100mb fixture not found. Run: .venv/bin/python tests/fixtures/generate_large.py",
      );
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
      console.log(
        "Skipping: large_1gb fixture not found. Run: .venv/bin/python tests/fixtures/generate_large.py",
      );
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
    const slice = await arr.get([
      [0, 100],
      [0, 100],
    ]);

    const memAfter = process.memoryUsage().heapUsed;
    const overheadMB = (memAfter - memBefore) / (1024 * 1024);

    expect(slice.length).toBe(10_000);
    expect(slice).toBeInstanceOf(Float64Array);

    console.log(`  Slice read memory overhead: ${overheadMB.toFixed(1)}MB`);
    expect(overheadMB).toBeLessThan(100);
  });
});

describe("T020 — SC-004: zero overhead with no observability hooks registered", () => {
  /** Synthetic in-memory zarr v2 array: many small chunks so per-chunk loop
   *  overhead dominates, which is exactly where hook dispatch would show up. */
  function syntheticStore(): Store {
    const map = new Map<string, Uint8Array>();
    map.set(
      ".zarray",
      new TextEncoder().encode(
        JSON.stringify({
          zarr_format: 2,
          shape: [64, 64],
          chunks: [8, 8],
          dtype: "<f4",
          compressor: null,
          fill_value: 0,
          order: "C",
          filters: null,
        }),
      ),
    );
    const chunk = new Uint8Array(8 * 8 * 4);
    new Float32Array(chunk.buffer).fill(1.5);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        map.set(`${i}.${j}`, chunk.slice());
      }
    }
    return {
      async get(key) {
        return map.get(key) ?? null;
      },
      async has(key) {
        return map.has(key);
      },
      async *list() {},
    };
  }

  function median(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  it("read throughput with an empty hooks object is statistically unchanged from baseline", async () => {
    const store = syntheticStore();
    const arr = await openArray(store);

    const ITERATIONS = 40;
    const baseline: number[] = [];
    const withGuards: number[] = [];

    // Warm-up (JIT, codec paths) before measuring.
    for (let i = 0; i < 5; i++) {
      await arr.get();
      await arr.get(undefined, { observability: {} });
    }

    // Interleave samples so drift (GC, CPU frequency) hits both groups equally.
    for (let i = 0; i < ITERATIONS; i++) {
      let start = performance.now();
      await arr.get();
      baseline.push(performance.now() - start);

      start = performance.now();
      await arr.get(undefined, { observability: {} });
      withGuards.push(performance.now() - start);
    }

    const ratio = median(withGuards) / median(baseline);
    console.log(
      `  no-hooks read: baseline ${median(baseline).toFixed(3)}ms, ` +
        `with empty hooks ${median(withGuards).toFixed(3)}ms (ratio ${ratio.toFixed(2)})`,
    );

    // Generous tolerance to absorb CI noise — a per-chunk payload allocation
    // or unconditional dispatch shows up far above this.
    expect(ratio).toBeLessThan(1.5);
  });
});
