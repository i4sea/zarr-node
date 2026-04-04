import { readFile, writeFile, rename, mkdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

export class DiskCache {
  private readonly storeDir: string;
  private readonly ttlMs: number | null;

  constructor(cacheDir: string, storeId: string, ttlMs: number | null) {
    const hash = createHash("sha256").update(storeId).digest("hex").slice(0, 16);
    this.storeDir = join(cacheDir, hash);
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const filePath = this.pathFor(key);
    try {
      if (this.ttlMs !== null) {
        const s = await stat(filePath);
        if (Date.now() - s.mtimeMs > this.ttlMs) {
          return null;
        }
      }
      const buf = await readFile(filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  async set(key: string, data: Uint8Array): Promise<void> {
    const filePath = this.pathFor(key);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(tmpPath, data);
      await rename(tmpPath, filePath);
    } catch {
      // Silently ignore cache write failures (FR-010)
      try {
        await rm(tmpPath, { force: true });
      } catch {
        // ignore cleanup failure too
      }
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.storeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /** Exposed for testing — compute file path for a cache key. */
  pathFor(key: string): string {
    return join(this.storeDir, key);
  }
}
