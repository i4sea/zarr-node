import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { S3Store } from "../../src/store/s3.js";
import { openArray } from "../../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const bucket = process.env.S3_TEST_BUCKET ?? "";
const prefix = process.env.S3_TEST_PREFIX ?? "";
const endpoint = process.env.S3_TEST_ENDPOINT;
const region = process.env.S3_TEST_REGION ?? "us-east-1";

const canRunS3Tests = Boolean(bucket);

async function loadExpected(fixtureName: string) {
  const raw = await readFile(
    join(FIXTURES, fixtureName, "expected.json"),
    "utf-8",
  );
  return JSON.parse(raw) as {
    shape: number[];
    dtype: string;
    data: number[];
  };
}

describe.skipIf(!canRunS3Tests)("S3Store — Store contract", () => {
  it("get() returns data for existing key (.zarray)", async () => {
    const store = new S3Store({
      bucket,
      prefix: prefix + "simple_1d",
      region,
      endpoint,
    });
    const data = await store.get(".zarray");
    expect(data).not.toBeNull();
    const text = new TextDecoder().decode(data!);
    expect(text).toContain("zarr_format");
  });

  it("get() returns null for missing key", async () => {
    const store = new S3Store({
      bucket,
      prefix: prefix + "simple_1d",
      region,
      endpoint,
    });
    const data = await store.get("nonexistent-key-" + Date.now());
    expect(data).toBeNull();
  });

  it("has() returns true for existing key", async () => {
    const store = new S3Store({
      bucket,
      prefix: prefix + "simple_1d",
      region,
      endpoint,
    });
    expect(await store.has(".zarray")).toBe(true);
  });

  it("has() returns false for missing key", async () => {
    const store = new S3Store({
      bucket,
      prefix: prefix + "simple_1d",
      region,
      endpoint,
    });
    expect(await store.has("nonexistent-" + Date.now())).toBe(false);
  });

  it("list() yields keys under prefix", async () => {
    const store = new S3Store({
      bucket,
      prefix: prefix + "simple_1d",
      region,
      endpoint,
    });
    const keys: string[] = [];
    for await (const key of store.list("")) {
      keys.push(key);
    }
    // simple_1d should have: .zarray, 0, expected.json
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });
});

describe.skipIf(!canRunS3Tests)(
  "S3Store — full pipeline read from S3",
  () => {
    it("reads simple_1d array from S3", async () => {
      const expected = await loadExpected("simple_1d");
      const store = new S3Store({
        bucket,
        prefix: prefix + "simple_1d",
        region,
        endpoint,
      });
      const arr = await openArray(store);

      expect(arr.shape).toEqual(expected.shape);
      expect(arr.dtype).toBe(expected.dtype);

      const data = await arr.get();
      expect(data).toBeInstanceOf(Float32Array);
      expect(data.length).toBe(expected.data.length);
      for (let i = 0; i < expected.data.length; i++) {
        expect(data[i]).toBeCloseTo(expected.data[i], 5);
      }
    });

    it("reads chunked_2d array from S3", async () => {
      const expected = await loadExpected("chunked_2d");
      const store = new S3Store({
        bucket,
        prefix: prefix + "chunked_2d",
        region,
        endpoint,
      });
      const arr = await openArray(store);

      expect(arr.shape).toEqual(expected.shape);

      const data = await arr.get();
      expect(data).toBeInstanceOf(Int32Array);
      expect(data.length).toBe(expected.data.length);
      for (let i = 0; i < expected.data.length; i++) {
        expect(data[i]).toBe(expected.data[i]);
      }
    });

    it("reads compressed_gzip array from S3", async () => {
      const expected = await loadExpected("compressed_gzip");
      const store = new S3Store({
        bucket,
        prefix: prefix + "compressed_gzip",
        region,
        endpoint,
      });
      const arr = await openArray(store);

      const data = await arr.get();
      expect(data).toBeInstanceOf(Float64Array);
      expect(data.length).toBe(expected.data.length);
      for (let i = 0; i < expected.data.length; i++) {
        expect(data[i]).toBeCloseTo(expected.data[i], 10);
      }
    });

    it("reads a slice from chunked_2d via S3", async () => {
      const expected = await loadExpected("chunked_2d");
      const store = new S3Store({
        bucket,
        prefix: prefix + "chunked_2d",
        region,
        endpoint,
      });
      const arr = await openArray(store);

      // Slice [0:5, 0:10]
      const slice = await arr.get([
        [0, 5],
        [0, 10],
      ]);
      expect(slice.length).toBe(50);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 10; c++) {
          expect(slice[r * 10 + c]).toBe(expected.data[r * 200 + c]);
        }
      }
    });
  },
);

describe("S3Store — instantiation (no credentials needed)", () => {
  it("can be instantiated", () => {
    const store = new S3Store({ bucket: "any-bucket" });
    expect(store).toBeDefined();
  });
});
