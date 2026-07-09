import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";
import { CodecError } from "../../src/errors.js";
import type { Store } from "../../src/store/store.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

async function loadExpected(fixtureName: string) {
  const raw = await readFile(
    join(FIXTURES, fixtureName, "expected.json"),
    "utf-8",
  );
  return JSON.parse(raw) as { shape: number[]; dtype: string; data: number[] };
}

describe("US3: full ordered v3 codec chain (transpose → bytes → compressor)", () => {
  for (const compressor of ["blosc", "gzip", "zstd"] as const) {
    const fixture = `v3_transpose_${compressor}`;

    it(`decodes ${fixture} element-wise (full read)`, async () => {
      const expected = await loadExpected(fixture);
      const arr = await openArray(
        new FileSystemStore({ path: join(FIXTURES, fixture) }),
      );

      expect(arr.shape).toEqual(expected.shape);
      const data = await arr.get();
      expect(data.length).toBe(expected.data.length);
      for (let i = 0; i < expected.data.length; i++) {
        expect(data[i]).toBeCloseTo(expected.data[i], 5);
      }
    });

    it(`decodes a ${fixture} sub-region spanning chunks`, async () => {
      const expected = await loadExpected(fixture);
      const arr = await openArray(
        new FileSystemStore({ path: join(FIXTURES, fixture) }),
      );

      // shape [20, 30], chunks [10, 15]: [5:15, 10:20] spans all 4 chunks
      const slice = await arr.get([
        [5, 15],
        [10, 20],
      ]);
      expect(slice.length).toBe(100);
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
          expect(slice[r * 10 + c]).toBeCloseTo(
            expected.data[(5 + r) * 30 + (10 + c)],
            5,
          );
        }
      }
    });
  }

  it("verifies crc32c checksums on the v3_crc32c fixture", async () => {
    const expected = await loadExpected("v3_crc32c");
    const arr = await openArray(
      new FileSystemStore({ path: join(FIXTURES, "v3_crc32c") }),
    );

    const data = await arr.get();
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 12);
    }
  });

  it("throws a corruption error when a crc32c-protected chunk is corrupted (FR-008a)", async () => {
    const inner = new FileSystemStore({ path: join(FIXTURES, "v3_crc32c") });
    const corrupting: Store = {
      async get(key: string) {
        const raw = await inner.get(key);
        if (raw && key.startsWith("c/")) {
          const bad = raw.slice();
          bad[0] ^= 0xff; // flip payload bits — checksum must catch it
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
    };

    const arr = await openArray(corrupting);
    await expect(arr.get()).rejects.toThrow(CodecError);
    await expect(arr.get()).rejects.toThrow(/crc32c/i);
  });

  it("reads v3_big_endian through the bytes(endian=big) codec", async () => {
    const expected = await loadExpected("v3_big_endian");
    const arr = await openArray(
      new FileSystemStore({ path: join(FIXTURES, "v3_big_endian") }),
    );

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float64Array);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBeCloseTo(expected.data[i], 12);
    }
  });
});
