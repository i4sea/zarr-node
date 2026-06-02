import { describe, it, expect } from "vitest";
import { ByteLimiter } from "../../src/chunk/limiter.js";

describe("ByteLimiter", () => {
  it("admits acquisitions while budget allows", async () => {
    const lim = new ByteLimiter(100);
    await lim.acquire(40);
    await lim.acquire(40);
    expect(lim.availableBytes).toBe(20);
  });

  it("queues acquisitions that exceed the budget until released (FIFO)", async () => {
    const lim = new ByteLimiter(100);
    await lim.acquire(60);

    const order: number[] = [];
    // Two waiters of 60 each; neither fits until the first 60 is released.
    const w1 = lim.acquire(60).then(() => order.push(1));
    const w2 = lim.acquire(60).then(() => order.push(2));

    // Give microtasks a chance — neither should have resolved yet.
    await Promise.resolve();
    expect(order).toEqual([]);

    lim.release(60); // frees 60 -> wakes w1 only (w2 still doesn't fit)
    await w1;
    expect(order).toEqual([1]);

    lim.release(60); // frees 60 -> wakes w2
    await w2;
    expect(order).toEqual([1, 2]);
  });

  it("lets an oversized cost proceed alone instead of deadlocking", async () => {
    const lim = new ByteLimiter(100);
    // Cost larger than the whole budget is clamped to capacity.
    await lim.acquire(500);
    expect(lim.availableBytes).toBe(0);
    lim.release(500);
    expect(lim.availableBytes).toBe(100);
  });

  it("does not over-fill the budget on release", () => {
    const lim = new ByteLimiter(100);
    lim.release(50); // nothing was acquired
    expect(lim.availableBytes).toBe(100);
  });

  it("ignores non-positive / non-finite costs", async () => {
    const lim = new ByteLimiter(100);
    await lim.acquire(0);
    await lim.acquire(-5);
    await lim.acquire(Infinity); // non-finite -> treated as 0 (no reservation)
    expect(lim.availableBytes).toBe(100);
  });
});
