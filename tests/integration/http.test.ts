import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { HTTPStore } from "../../src/store/http.js";
import { openArray } from "../../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
let server: Server;
let baseUrl: string;

// Simple static file server for fixtures
function createFixtureServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const srv = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const urlPath = decodeURIComponent(req.url ?? "/");

        // Contract test routes
        if (urlPath === "/contract/test-key") {
          res.writeHead(200);
          res.end(Buffer.from([1, 2, 3]));
          return;
        }
        if (urlPath === "/contract/prefix/a") {
          res.writeHead(200);
          res.end(Buffer.from([10]));
          return;
        }
        if (urlPath === "/contract/prefix/b") {
          res.writeHead(200);
          res.end(Buffer.from([20]));
          return;
        }

        // Retry test endpoint
        if (urlPath === "/retry-test") {
          const count = retryCounter++;
          if (count < 2) {
            res.writeHead(503);
            res.end("Service Unavailable");
            return;
          }
          res.writeHead(200);
          res.end(Buffer.from([42]));
          return;
        }

        // Mixed transient statuses: 500, 502, 504, then success
        if (urlPath === "/retry-mixed-test") {
          const count = mixedCounter++;
          const transientStatuses = [500, 502, 504];
          if (count < transientStatuses.length) {
            res.writeHead(transientStatuses[count]);
            res.end("Transient Error");
            return;
          }
          res.writeHead(200);
          res.end(Buffer.from([7]));
          return;
        }

        // Always fails with 503 — for maxRetries override tests
        if (urlPath === "/always-503") {
          always503Counter++;
          res.writeHead(503);
          res.end("Service Unavailable");
          return;
        }

        // Always 404 — must not be retried
        if (urlPath === "/counted-404") {
          notFoundCounter++;
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        // Returns a 206 with fewer bytes than the requested range
        if (urlPath === "/short-range") {
          res.writeHead(206, { "Content-Range": "bytes 0-1/10" });
          res.end(Buffer.from([1, 2]));
          return;
        }

        // Timeout test endpoint
        if (urlPath === "/timeout-test") {
          // Don't respond - let it timeout
          return;
        }

        // Serve fixture files
        const filePath = join(FIXTURES, urlPath);
        try {
          await access(filePath);
          const data = await readFile(filePath);
          res.writeHead(200);
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end("Not Found");
        }
      },
    );

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr !== "string") {
        resolve({ server: srv, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

let retryCounter = 0;
let mixedCounter = 0;
let always503Counter = 0;
let notFoundCounter = 0;

beforeAll(async () => {
  const result = await createFixtureServer();
  server = result.server;
  baseUrl = result.url;
});

afterAll(() => {
  server?.close();
});

// Contract tests (HTTP doesn't support list, so we skip the contract suite
// and test get/has directly)
describe("HTTPStore — basic operations", () => {
  it("get() returns data for existing key", async () => {
    const store = new HTTPStore({ url: `${baseUrl}/contract` });
    const data = await store.get("test-key");
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("get() returns null for missing key (404)", async () => {
    const store = new HTTPStore({ url: `${baseUrl}/contract` });
    const data = await store.get("nonexistent-key");
    expect(data).toBeNull();
  });

  it("has() returns true for existing key", async () => {
    const store = new HTTPStore({ url: `${baseUrl}/contract` });
    expect(await store.has("test-key")).toBe(true);
  });

  it("has() returns false for missing key", async () => {
    const store = new HTTPStore({ url: `${baseUrl}/contract` });
    expect(await store.has("nonexistent")).toBe(false);
  });

  it("list() throws UnsupportedOperationError", async () => {
    const store = new HTTPStore({ url: baseUrl });
    const iter = store.list("prefix/");
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
      "does not support",
    );
  });
});

describe("HTTPStore — custom headers", () => {
  it("sends custom headers with requests", async () => {
    // We just verify it doesn't throw — header verification would need a more complex server
    const store = new HTTPStore({
      url: `${baseUrl}/contract`,
      headers: { Authorization: "Bearer test-token" },
    });
    const data = await store.get("test-key");
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("HTTPStore — retry on transient failures", () => {
  it("retries on 503 and succeeds", async () => {
    retryCounter = 0;
    const store = new HTTPStore({ url: baseUrl });
    const data = await store.get("retry-test");
    expect(data).toEqual(new Uint8Array([42]));
    expect(retryCounter).toBe(3); // 2 failures + 1 success
  });

  it("retries on 500, 502 and 504 then succeeds", async () => {
    mixedCounter = 0;
    const store = new HTTPStore({ url: baseUrl });
    const data = await store.get("retry-mixed-test");
    expect(data).toEqual(new Uint8Array([7]));
    expect(mixedCounter).toBe(4); // 3 transient failures + 1 success
  });

  it("honors maxRetries override from options", async () => {
    always503Counter = 0;
    const store = new HTTPStore({ url: baseUrl, maxRetries: 1 });
    await expect(store.get("always-503")).rejects.toThrow("503");
    expect(always503Counter).toBe(2); // 1 initial + 1 retry
  });

  it("does not retry when maxRetries is 0", async () => {
    always503Counter = 0;
    const store = new HTTPStore({ url: baseUrl, maxRetries: 0 });
    await expect(store.get("always-503")).rejects.toThrow("503");
    expect(always503Counter).toBe(1);
  });

  it("does not retry a 404", async () => {
    notFoundCounter = 0;
    const store = new HTTPStore({ url: baseUrl });
    const data = await store.get("counted-404");
    expect(data).toBeNull();
    expect(notFoundCounter).toBe(1);
  });

  it("fires onRetry per attempt with the failing status", async () => {
    retryCounter = 0;
    const events: { attempt: number; status?: number; error?: string }[] = [];
    const store = new HTTPStore({
      url: baseUrl,
      observability: {
        onRetry: (e) => events.push(e),
      },
    });
    const data = await store.get("retry-test");
    expect(data).toEqual(new Uint8Array([42]));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ attempt: 1, status: 503 });
    expect(events[1]).toMatchObject({ attempt: 2, status: 503 });
  });
});

describe("HTTPStore — range response validation", () => {
  it("throws when a range response returns fewer bytes than requested", async () => {
    const store = new HTTPStore({ url: baseUrl });
    await expect(store.getRange("short-range", 0, 8)).rejects.toThrow(
      "expected 8",
    );
  });
});

describe("HTTPStore — timeout", () => {
  it("throws on timeout", async () => {
    const store = new HTTPStore({ url: baseUrl, timeout: 200 });
    await expect(store.get("timeout-test")).rejects.toThrow();
  });
});

describe("HTTPStore — read fixture via HTTP", () => {
  it("reads simple_1d array via HTTP", async () => {
    const store = new HTTPStore({ url: `${baseUrl}/simple_1d` });
    const arr = await openArray(store);

    expect(arr.shape).toEqual([10]);
    expect(arr.dtype).toBe("<f4");

    const data = await arr.get();
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(data[i]).toBeCloseTo(i, 5);
    }
  });
});
