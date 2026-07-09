import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";
import { CodecError } from "../../src/errors.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const FIXTURE = join(FIXTURES, "v3_sharded");

async function loadExpected() {
  const raw = await readFile(join(FIXTURE, "expected.json"), "utf-8");
  return JSON.parse(raw) as { shape: number[]; dtype: string; data: number[] };
}

/** Wrap a store, recording calls and optionally hiding capabilities. */
function wrap(
  inner: FileSystemStore,
  opts: { ranges?: boolean } = { ranges: true },
): {
  store: Store;
  gets: string[];
  ranges: Array<{ key: string; offset: number; length: number }>;
} {
  const gets: string[] = [];
  const ranges: Array<{ key: string; offset: number; length: number }> = [];
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
  };
  if (opts.ranges) {
    store.getRange = async (key, offset, length) => {
      ranges.push({ key, offset, length });
      return inner.getRange(key, offset, length);
    };
    store.head = (key) => inner.head(key);
  }
  return { store, gets, ranges };
}

describe("US4: sharded v3 reads (sharding_indexed, byte-range)", () => {
  // Fixture: shape (40, 40) f4, shards (20, 20), inner chunks (10, 10),
  // inner chain bytes → zstd → crc32c, index [bytes, crc32c] at end.

  it("exposes the shard shape as chunks and reads the full array", async () => {
    const expected = await loadExpected();
    const arr = await openArray(new FileSystemStore({ path: FIXTURE }));

    expect(arr.shape).toEqual([40, 40]);
    expect(arr.chunks).toEqual([20, 20]); // outer chunk = shard shape

    const data = await arr.get();
    expect(data.length).toBe(expected.data.length);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 5);
    }
  });

  it("reads a sub-region correctly (spanning shards and inner chunks)", async () => {
    const expected = await loadExpected();
    const arr = await openArray(new FileSystemStore({ path: FIXTURE }));

    const slice = await arr.get([
      [15, 25],
      [5, 35],
    ]);
    expect(slice.length).toBe(10 * 30);
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 30; c++) {
        expect(slice[r * 30 + c]).toBeCloseTo(
          expected.data[(15 + r) * 40 + (5 + c)],
          5,
        );
      }
    }
  });

  it("issues only index + inner-chunk ranges over a getRange store (SC-004)", async () => {
    const inner = new FileSystemStore({ path: FIXTURE });
    const { store, gets, ranges } = wrap(inner);
    const arr = await openArray(store);

    // A 10x10 window inside shard (0,0), touching 4 inner chunks at most.
    const expected = await loadExpected();
    const slice = await arr.get([
      [5, 15],
      [5, 15],
    ]);
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        expect(slice[r * 10 + c]).toBeCloseTo(
          expected.data[(5 + r) * 40 + (5 + c)],
          5,
        );
      }
    }

    // Metadata get (zarr.json) is fine; NO whole-shard chunk get.
    expect(gets.filter((k) => k.startsWith("c/"))).toHaveLength(0);
    // All range reads hit the single touched shard.
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((r) => r.key === "c/0/0")).toBe(true);
  });

  it("falls back to whole-shard fetches on a range-less store (FR-014)", async () => {
    const inner = new FileSystemStore({ path: FIXTURE });
    const { store, gets, ranges } = wrap(inner, { ranges: false });
    const arr = await openArray(store);

    const expected = await loadExpected();
    const slice = await arr.get([
      [5, 15],
      [5, 15],
    ]);
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        expect(slice[r * 10 + c]).toBeCloseTo(
          expected.data[(5 + r) * 40 + (5 + c)],
          5,
        );
      }
    }

    expect(ranges).toHaveLength(0);
    expect(gets.filter((k) => k.startsWith("c/"))).toEqual(["c/0/0"]);
  });

  it("throws a corruption error for a corrupt inner chunk (crc32c, FR-008a)", async () => {
    const inner = new FileSystemStore({ path: FIXTURE });
    const corrupting: Store = {
      async get(key) {
        const raw = await inner.get(key);
        if (raw && key.startsWith("c/")) {
          const bad = raw.slice();
          bad[0] ^= 0xff; // first inner chunk's payload
          return bad;
        }
        return raw;
      },
      async has(key) {
        return inner.has(key);
      },
      async *list(prefix) {
        yield* inner.list(prefix);
      },
      // no getRange: force the whole-shard path through the corrupted get()
    };

    const arr = await openArray(corrupting);
    await expect(arr.get()).rejects.toThrow(CodecError);
    await expect(arr.get()).rejects.toThrow(/crc32c/i);
  });
});
