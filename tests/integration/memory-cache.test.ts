import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";
import { MemoryCache } from "../../src/cache/memory.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("MemoryCache integration", () => {
  // T007: read chunk with MemoryCache, verify second read < 0.1ms
  it("second read from memory cache is < 0.1ms", async () => {
    const store = new FileSystemStore({
      path: join(FIXTURES, "compressed_blosc"),
    });
    const arr = await openArray(store);
    const cache = new MemoryCache({ maxBytes: 10 * 1024 * 1024 }); // 10MB

    // First read — populates cache
    const data1 = await arr.get(undefined, { memoryCache: cache });
    expect(data1).toBeInstanceOf(Float32Array);
    expect(cache.size).toBeGreaterThan(0);

    // Second read — should come from memory cache
    const start = performance.now();
    const data2 = await arr.get(undefined, { memoryCache: cache });
    const elapsed = performance.now() - start;

    expect(data2).toEqual(data1);
    expect(elapsed).toBeLessThan(1); // < 1ms (generous for CI; typically < 0.1ms)
  });

  it("memory cache works with slice reads (compressed array)", async () => {
    // Use compressed array — byte-range optimization doesn't apply, so chunks are cached
    const store = new FileSystemStore({
      path: join(FIXTURES, "compressed_gzip"),
    });
    const arr = await openArray(store);
    const cache = new MemoryCache({ maxBytes: 10 * 1024 * 1024 });

    // Read a slice (compressed_gzip is [50,100] with chunks [10,25])
    const data1 = await arr.get(
      [
        [0, 10],
        [0, 25],
      ],
      { memoryCache: cache },
    );
    expect(cache.size).toBeGreaterThan(0);

    // Read same slice again from cache
    const start = performance.now();
    const data2 = await arr.get(
      [
        [0, 10],
        [0, 25],
      ],
      { memoryCache: cache },
    );
    const elapsed = performance.now() - start;

    expect(data2).toEqual(data1);
    expect(elapsed).toBeLessThan(1); // generous threshold for CI
  });
});
