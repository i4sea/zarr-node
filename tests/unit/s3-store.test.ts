import { describe, it, expect, vi } from "vitest";
import { S3Store } from "../../src/store/s3.js";

// Access the private handler factory without `any`.
interface HandlerInternals {
  buildRequestHandler(): Promise<unknown>;
  clientPromise: Promise<unknown> | null;
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

describe("S3Store body deadline (#22)", () => {
  it("aborts a body read that never settles, then retries", async () => {
    // A body whose read never settles even after the abort fires — what the
    // SDK's checksum-validation stream does when the socket dies mid-body.
    const stalled = {
      transformToByteArray: () => new Promise<Uint8Array>(() => {}),
      destroy: vi.fn(),
    };
    const ok = {
      transformToByteArray: async () => new Uint8Array([1, 2, 3]),
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Body: stalled })
      .mockResolvedValueOnce({ Body: ok });
    const store = new S3Store({ bucket: "b", timeout: 200 });
    internals(store).clientPromise = Promise.resolve({ send });

    await expect(store.get("k")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(send).toHaveBeenCalledTimes(2);
    expect(stalled.destroy).toHaveBeenCalledOnce();
  });

  it("does not destroy a body that completes in time", async () => {
    const body = {
      transformToByteArray: async () => new Uint8Array([9]),
      destroy: vi.fn(),
    };
    const store = new S3Store({ bucket: "b", timeout: 200 });
    internals(store).clientPromise = Promise.resolve({
      send: async () => ({ Body: body }),
    });

    await expect(store.get("k")).resolves.toEqual(new Uint8Array([9]));
    // Outlive the deadline: the listener must be gone, not fire late.
    await new Promise((r) => setTimeout(r, 300));
    expect(body.destroy).not.toHaveBeenCalled();
  });
});
