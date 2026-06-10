import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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

describe.skipIf(!canRunS3Tests)("S3Store — full pipeline read from S3", () => {
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
});

describe("S3Store — instantiation (no credentials needed)", () => {
  it("can be instantiated", () => {
    const store = new S3Store({ bucket: "any-bucket" });
    expect(store).toBeDefined();
  });
});

// Retry/timeout behavior against a local fake S3 endpoint (path-style).
// S3Store sets maxAttempts: 1 on its client, so the attempt counts asserted
// here observe the store's own retry layer with no SDK-internal multiplier.
describe("S3Store — retry and timeout (local fake S3)", () => {
  let fakeS3: Server;
  let fakeEndpoint: string;
  let transientCounter = 0;
  let always500Counter = 0;
  let notFoundCounter = 0;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.AWS_ACCESS_KEY_ID ??= "test-access-key";
    process.env.AWS_SECRET_ACCESS_KEY ??= "test-secret-key";

    await new Promise<void>((resolve) => {
      fakeS3 = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          const urlPath = req.url ?? "/";

          if (urlPath.includes("transient-key")) {
            const count = transientCounter++;
            if (count < 2) {
              res.writeHead(500, { "Content-Type": "application/xml" });
              res.end(
                '<?xml version="1.0"?><Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>',
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            res.end(Buffer.from([7, 8, 9]));
            return;
          }

          if (urlPath.includes("always-500-key")) {
            always500Counter++;
            res.writeHead(500, { "Content-Type": "application/xml" });
            res.end(
              '<?xml version="1.0"?><Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>',
            );
            return;
          }

          if (urlPath.includes("missing-key")) {
            notFoundCounter++;
            res.writeHead(404, { "Content-Type": "application/xml" });
            res.end(
              '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
            );
            return;
          }

          if (urlPath.includes("hang-key")) {
            // Never respond — exercises the per-operation timeout abort
            return;
          }

          res.writeHead(404, { "Content-Type": "application/xml" });
          res.end(
            '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
          );
        },
      );
      fakeS3.listen(0, "127.0.0.1", () => {
        const addr = fakeS3.address();
        if (addr && typeof addr !== "string") {
          fakeEndpoint = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    fakeS3?.close();
    if (savedEnv.AWS_ACCESS_KEY_ID === undefined) {
      delete process.env.AWS_ACCESS_KEY_ID;
    } else {
      process.env.AWS_ACCESS_KEY_ID = savedEnv.AWS_ACCESS_KEY_ID;
    }
    if (savedEnv.AWS_SECRET_ACCESS_KEY === undefined) {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    } else {
      process.env.AWS_SECRET_ACCESS_KEY = savedEnv.AWS_SECRET_ACCESS_KEY;
    }
  });

  function makeStore(extra?: { maxRetries?: number; timeout?: number }) {
    return new S3Store({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: fakeEndpoint,
      ...extra,
    });
  }

  it("retries transient 500s and returns data on success", async () => {
    transientCounter = 0;
    const store = makeStore();
    const data = await store.get("transient-key");
    expect(data).toEqual(new Uint8Array([7, 8, 9]));
    expect(transientCounter).toBe(3); // 2 failures + 1 success
  });

  it("honors maxRetries override from options", async () => {
    always500Counter = 0;
    const store = makeStore({ maxRetries: 1 });
    await expect(store.get("always-500-key")).rejects.toThrow();
    expect(always500Counter).toBe(2); // 1 initial + 1 retry
  });

  it("does not retry a missing key (404/NoSuchKey) and returns null", async () => {
    notFoundCounter = 0;
    const store = makeStore();
    const data = await store.get("missing-key");
    expect(data).toBeNull();
    expect(notFoundCounter).toBe(1);
  });

  it("aborts an operation that exceeds the configured timeout", async () => {
    const store = makeStore({ timeout: 300, maxRetries: 0 });
    const started = performance.now();
    await expect(store.get("hang-key")).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("fires onRetry per attempt", async () => {
    transientCounter = 0;
    const events: { attempt: number; status?: number; error?: string }[] = [];
    const store = new S3Store({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: fakeEndpoint,
      observability: {
        onRetry: (e) => events.push(e),
      },
    });
    const data = await store.get("transient-key");
    expect(data).toEqual(new Uint8Array([7, 8, 9]));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ attempt: 1, status: 500 });
    expect(events[1]).toMatchObject({ attempt: 2, status: 500 });
  });

  it("applies retry/timeout to getRange as well", async () => {
    transientCounter = 0;
    const store = makeStore();
    const data = await store.getRange("transient-key", 0, 3);
    expect(data).toEqual(new Uint8Array([7, 8, 9]));
    expect(transientCounter).toBe(3);
  });
});
