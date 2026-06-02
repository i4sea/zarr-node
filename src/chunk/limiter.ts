/**
 * FIFO semaphore that bounds work by a *byte budget* rather than a slot count.
 *
 * Callers `acquire(cost)` before allocating/decoding a chunk and `release(cost)`
 * once that memory is no longer live. When the outstanding total would exceed
 * the capacity, further acquisitions queue (in arrival order) until budget frees
 * up. A single cost larger than the whole capacity is clamped to the capacity so
 * an oversized chunk still makes progress on its own instead of deadlocking.
 *
 * One limiter can be shared across several concurrent reads (e.g.
 * `ZarrGroup.readMultiple`) so the *combined* in-flight footprint is bounded,
 * not just each read in isolation.
 */
export class ByteLimiter {
  private readonly capacity: number;
  private available: number;
  private readonly waiters: Array<{ cost: number; resolve: () => void }> = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.available = this.capacity;
  }

  /** Reserve `cost` bytes, waiting (FIFO) until the budget allows. */
  async acquire(cost: number): Promise<void> {
    const c = this.clamp(cost);
    // Fast path: no one waiting and budget available -> reserve immediately.
    if (this.waiters.length === 0 && this.available >= c) {
      this.available -= c;
      return;
    }
    // Otherwise queue; the budget is reserved for us by pump() before we resume.
    await new Promise<void>((resolve) => {
      this.waiters.push({ cost: c, resolve });
    });
  }

  /** Return `cost` bytes to the budget and wake any waiters that now fit. */
  release(cost: number): void {
    this.available += this.clamp(cost);
    if (this.available > this.capacity) this.available = this.capacity;
    this.pump();
  }

  private pump(): void {
    // Wake waiters strictly in FIFO order, reserving budget for each before
    // resolving so a later acquire() cannot jump the queue.
    while (this.waiters.length > 0 && this.available >= this.waiters[0].cost) {
      const w = this.waiters.shift();
      if (!w) break;
      this.available -= w.cost;
      w.resolve();
    }
  }

  private clamp(cost: number): number {
    if (!Number.isFinite(cost) || cost <= 0) return 0;
    return Math.min(cost, this.capacity);
  }

  /** Bytes currently available (for tests/introspection). */
  get availableBytes(): number {
    return this.available;
  }
}
