import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("Byte-range requests", () => {
  // T020: getRange() on FileSystemStore
  it("FileSystemStore getRange reads partial file", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });

    // Read full chunk first
    const full = await store.get("0");
    expect(full).not.toBeNull();

    // Read partial — first 8 bytes (2 float32s)
    const partial = await store.getRange!("0", 0, 8);
    expect(partial).not.toBeNull();
    expect(partial!.byteLength).toBe(8);

    // Verify the partial matches the beginning of the full chunk
    for (let i = 0; i < 8; i++) {
      expect(partial![i]).toBe(full![i]);
    }
  });

  it("FileSystemStore getRange reads from offset", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });

    // Read 4 bytes starting at offset 4 (second float32)
    const partial = await store.getRange!("0", 4, 4);
    expect(partial).not.toBeNull();
    expect(partial!.byteLength).toBe(4);

    // The second float32 should be 1.0
    const view = new Float32Array(partial!.buffer, partial!.byteOffset, 1);
    expect(view[0]).toBeCloseTo(1.0);
  });

  it("FileSystemStore getRange returns null for missing key", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "simple_1d") });
    const result = await store.getRange!("nonexistent", 0, 10);
    expect(result).toBeNull();
  });

  // T021: Read small slice from uncompressed fixture, verify only needed bytes fetched
  it("tracks byte ranges requested from store", async () => {
    const inner = new FileSystemStore({
      path: join(FIXTURES, "uncompressed_2d"),
    });

    const rangesRequested: Array<{
      key: string;
      offset: number;
      length: number;
    }> = [];
    const fullGets: string[] = [];

    // Create a tracking wrapper
    const trackingStore: Store & { getRange: typeof inner.getRange } = {
      async get(key: string) {
        fullGets.push(key);
        return inner.get(key);
      },
      async has(key: string) {
        return inner.has(key);
      },
      async *list(prefix: string) {
        yield* inner.list(prefix);
      },
      async getRange(key: string, offset: number, length: number) {
        rangesRequested.push({ key, offset, length });
        return inner.getRange!(key, offset, length);
      },
    };

    // For now, the store supports getRange - this validates the interface works
    const result = await trackingStore.getRange("0.0", 0, 40);
    expect(result).not.toBeNull();
    expect(result!.byteLength).toBe(40);
    expect(rangesRequested.length).toBe(1);
  });

  // Chunk loader actually uses getRange for uncompressed slice reads
  it("chunk loader uses getRange for uncompressed array slices", async () => {
    const inner = new FileSystemStore({
      path: join(FIXTURES, "uncompressed_2d"),
    });

    const rangesRequested: Array<{
      key: string;
      offset: number;
      length: number;
    }> = [];
    const fullGets: string[] = [];

    const trackingStore: Store = {
      async get(key: string) {
        fullGets.push(key);
        return inner.get(key);
      },
      async has(key: string) {
        return inner.has(key);
      },
      async *list(prefix: string) {
        yield* inner.list(prefix);
      },
      async getRange(key: string, offset: number, length: number) {
        rangesRequested.push({ key, offset, length });
        return inner.getRange!(key, offset, length);
      },
    };

    const arr = await openArray(trackingStore);
    // uncompressed_2d is [50,20] with chunks [10,20]
    // Slice [[0,2], null] = 2 rows, full 20 cols — trailing dim is full, contiguous
    rangesRequested.length = 0;
    fullGets.length = 0;

    const data = await arr.get([[0, 2], null]);
    expect(data.length).toBe(40); // 2 * 20

    // Should have used getRange (not full get) for chunk data
    expect(rangesRequested.length).toBeGreaterThan(0);
    // Full gets should only be for metadata (.zarray, .zattrs), not chunk data
    const chunkFullGets = fullGets.filter((k) => !k.startsWith(".z"));
    expect(chunkFullGets.length).toBe(0);

    // Verify byte range was for partial chunk (2 rows * 20 cols * 4 bytes = 160 bytes)
    // not full chunk (10 rows * 20 cols * 4 bytes = 800 bytes)
    const chunkRange = rangesRequested.find((r) => r.key === "0.0");
    expect(chunkRange).toBeDefined();
    expect(chunkRange!.length).toBe(160); // 2 * 20 * 4
  });

  // T021b: Fallback when store does NOT support getRange
  it("falls back to full chunk fetch when store has no getRange", async () => {
    const inner = new FileSystemStore({
      path: join(FIXTURES, "uncompressed_2d"),
    });

    // Store without getRange
    const noRangeStore: Store = {
      async get(key: string) {
        return inner.get(key);
      },
      async has(key: string) {
        return inner.has(key);
      },
      async *list(prefix: string) {
        yield* inner.list(prefix);
      },
    };

    // Should still work via full chunk fetch
    const arr = await openArray(noRangeStore);
    const data = await arr.get([
      [0, 1],
      [0, 1],
    ]);
    expect(data.length).toBe(1);
  });
});
