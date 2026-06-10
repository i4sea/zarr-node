import type { Cache } from "../cache/cache.js";
import { StoreError } from "../errors.js";

export type { Cache } from "../cache/cache.js";

// Minimal ioredis command surface used by RedisCache. Typed structurally so
// a pre-configured ioredis client can be passed without importing its types.
export interface RedisClientLike {
  getBuffer(key: string): Promise<Buffer | null>;
  set(
    key: string,
    value: Buffer,
    px?: "PX",
    ttlMs?: number,
  ): Promise<unknown>;
  exists(key: string): Promise<number>;
}

// Dynamic import helper — ioredis is an optional peer dependency (FR-009)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadIORedis(): Promise<any> {
  try {
    const mod = await import("ioredis");
    return mod.default ?? mod;
  } catch {
    throw new StoreError(
      "RedisCache requires ioredis. Install it with: npm install ioredis",
    );
  }
}

/**
 * Redis-backed Cache adapter (FR-007). Accepts a pre-configured ioredis
 * client (preferred) or a connection URL; with a URL the client is created
 * lazily on first use via dynamic import("ioredis"). TTLs use PX
 * (millisecond) expiry; values are stored as binary-safe buffers.
 */
export class RedisCache implements Cache {
  private readonly client: RedisClientLike | null;
  private readonly url: string | null;
  private clientPromise: Promise<RedisClientLike> | null = null;

  constructor(clientOrUrl: RedisClientLike | string) {
    if (typeof clientOrUrl === "string") {
      this.client = null;
      this.url = clientOrUrl;
    } else {
      this.client = clientOrUrl;
      this.url = null;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const client = await this.getClient();
    const buf = await client.getBuffer(key);
    if (buf == null) return null;
    return new Uint8Array(buf);
  }

  async set(key: string, value: Uint8Array, ttlMs?: number): Promise<void> {
    const client = await this.getClient();
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (ttlMs !== undefined) {
      await client.set(key, buf, "PX", ttlMs);
    } else {
      await client.set(key, buf);
    }
  }

  async has(key: string): Promise<boolean> {
    const client = await this.getClient();
    return (await client.exists(key)) === 1;
  }

  private getClient(): Promise<RedisClientLike> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.clientPromise) {
      this.clientPromise = loadIORedis()
        .then((Redis) => new Redis(this.url) as RedisClientLike)
        .catch((err: unknown) => {
          // Don't cache the rejection — let the next call retry creation
          this.clientPromise = null;
          throw err;
        });
    }
    return this.clientPromise;
  }
}
