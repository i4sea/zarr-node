import { describe, it, expect } from "vitest";
import { S3Store } from "../../src/store/s3.js";

// Access the private handler factory without `any`.
interface HandlerInternals {
  buildRequestHandler(): Promise<unknown>;
}
function internals(store: S3Store): HandlerInternals {
  return store as unknown as HandlerInternals;
}

describe("S3Store request handler", () => {
  it("returns a caller-supplied requestHandler unchanged (escape hatch)", async () => {
    const sentinel = { handle: () => {} };
    const store = new S3Store({ bucket: "b", requestHandler: sentinel });
    expect(await internals(store).buildRequestHandler()).toBe(sentinel);
  });

  it("builds a NodeHttpHandler by default (keep-alive pool)", async () => {
    const store = new S3Store({ bucket: "b", maxSockets: 200 });
    const handler = await internals(store).buildRequestHandler();
    expect(
      (handler as { constructor: { name: string } }).constructor.name,
    ).toBe("NodeHttpHandler");
  });
});

describe("S3Store.prewarm", () => {
  it("never rejects, even when the connection fails", async () => {
    // Point at a dead local endpoint so the HEAD fails fast (ECONNREFUSED);
    // prewarm must swallow it and resolve.
    const store = new S3Store({
      bucket: "b",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:1",
      timeout: 500,
    });
    await expect(store.prewarm()).resolves.toBeUndefined();
  });
});
