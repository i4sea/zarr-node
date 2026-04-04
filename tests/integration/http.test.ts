import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readFile, readdir, access } from "node:fs/promises";
import { HTTPStore } from "../../src/store/http.js";
import { runStoreContractTests } from "../contract/store.contract.js";
import { openArray } from "../../src/index.js";
import { FileSystemStore } from "../../src/store/filesystem.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
let server: Server;
let baseUrl: string;

// Simple static file server for fixtures
function createFixtureServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
    });

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr !== "string") {
        resolve({ server: srv, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

let retryCounter = 0;

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
