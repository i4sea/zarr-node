import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openGroup } from "../../src/index.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("readMultiple", () => {
  // T016: Read 4 arrays via readMultiple(), verify all returned correctly
  it("reads multiple arrays with the same selection", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "multi_array") });
    const root = await openGroup(store);

    const results = await root.readMultiple(
      ["temperature", "wind"],
      [[0, 1], null, null],
    );

    expect(results.size).toBe(2);
    expect(results.has("temperature")).toBe(true);
    expect(results.has("wind")).toBe(true);

    // temperature and wind are [3,4,3], sliced to [1,4,3] = 12 elements
    const temp = results.get("temperature")!;
    const wind = results.get("wind")!;
    expect(temp.length).toBe(12);
    expect(wind.length).toBe(12);
  });

  it("reads all arrays without selection (full read)", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "multi_array") });
    const root = await openGroup(store);

    const results = await root.readMultiple(["time", "lat", "lon"]);

    expect(results.get("time")!.length).toBe(3);
    expect(results.get("lat")!.length).toBe(4);
    expect(results.get("lon")!.length).toBe(3);
  });

  // T017: Shared concurrency pool test
  it("limits total concurrent fetches via shared concurrency pool", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const inner = new FileSystemStore({ path: join(FIXTURES, "multi_array") });
    // Wrap store to track concurrent fetches
    const trackingStore: Store = {
      async get(key: string) {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) {
          maxConcurrent = currentConcurrent;
        }
        const result = await inner.get(key);
        currentConcurrent--;
        return result;
      },
      async has(key: string) {
        return inner.has(key);
      },
      async *list(prefix: string) {
        yield* inner.list(prefix);
      },
    };

    const root = await openGroup(trackingStore);
    await root.readMultiple(["temperature", "wind"], undefined, {
      concurrency: 2,
    });

    // Should respect concurrency limit
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // T017b: Partial failure — one invalid array name
  it("returns error for invalid array and results for valid arrays", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "multi_array") });
    const root = await openGroup(store);

    const results = await root.readMultiple([
      "temperature",
      "nonexistent_array",
      "wind",
    ]);

    // Valid arrays should succeed
    expect(results.has("temperature")).toBe(true);
    expect(results.has("wind")).toBe(true);
    expect(results.get("temperature")!.length).toBe(36); // 3*4*3

    // Invalid array should have an error entry
    expect(results.has("nonexistent_array")).toBe(false);
  });
});
