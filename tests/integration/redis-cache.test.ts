import { describe, it, expect } from "vitest";
import { RedisCache } from "../../src/redis/index.js";
import { runCacheContractTests } from "../contract/cache.contract.js";

// Guard: ioredis is an optional peer dependency (installed as a devDependency
// here, but the suite must degrade gracefully when it is absent).
const ioredisAvailable = await import("ioredis").then(
  () => true,
  () => false,
);

// A real Redis server is only exercised when REDIS_URL is provided.
const REDIS_URL = process.env.REDIS_URL;

/**
 * Minimal in-process double of the ioredis command surface RedisCache uses
 * (getBuffer / set [PX] / exists), binary-safe via Buffer storage. Lets the
 * contract run without a live server.
 */
function fakeIoredisClient() {
  const entries = new Map<
    string,
    { value: Buffer; expiresAt: number | null }
  >();
  const live = (key: string): Buffer | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    async getBuffer(key: string): Promise<Buffer | null> {
      return live(key);
    },
    async set(
      key: string,
      value: Buffer,
      px?: string,
      ttlMs?: number,
    ): Promise<"OK"> {
      const expiresAt =
        px === "PX" && typeof ttlMs === "number" ? Date.now() + ttlMs : null;
      entries.set(key, { value: Buffer.from(value), expiresAt });
      return "OK";
    },
    async exists(key: string): Promise<number> {
      return live(key) === null ? 0 : 1;
    },
  };
}

describe.skipIf(!ioredisAvailable)("RedisCache (ioredis installed)", () => {
  // Contract against the ioredis command surface (no server required)
  runCacheContractTests("RedisCache (in-process client double)", async () => ({
    cache: new RedisCache(fakeIoredisClient()),
  }));

  it("constructing from a URL does not connect eagerly", () => {
    // Client creation is deferred to the first command, so construction
    // must not throw or open a connection.
    expect(() => new RedisCache("redis://localhost:1")).not.toThrow();
  });

  it("accepts ioredis options alongside a URL (fail-fast tuning)", async () => {
    // With Redis unreachable, bounded options must make the command reject
    // promptly instead of stalling in the offline queue for ~20 retries.
    const cache = new RedisCache("redis://127.0.0.1:1", {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    const started = performance.now();
    await expect(cache.get("any")).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe.skipIf(!ioredisAvailable || !REDIS_URL)(
  "RedisCache (live Redis via REDIS_URL)",
  () => {
    runCacheContractTests("RedisCache (live server)", async () => {
      const { default: Redis } = await import("ioredis");
      const client = new Redis(REDIS_URL!);
      return {
        cache: new RedisCache(client),
        cleanup: async () => {
          await client.quit();
        },
      };
    });
  },
);

describe.skipIf(ioredisAvailable)("RedisCache (ioredis absent)", () => {
  it("fails with a clear install hint on first use", async () => {
    const cache = new RedisCache("redis://localhost:6379");
    await expect(cache.get("any")).rejects.toThrow(
      /ioredis.*npm install ioredis/s,
    );
  });
});
