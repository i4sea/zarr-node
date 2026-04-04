import { readFile, writeFile, rename, mkdir, rm, stat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

export class DiskCache {
  private readonly storeDir: string;
  private readonly ttlMs: number | null;
  private readonly maxSizeBytes: number | null;

  constructor(cacheDir: string, storeId: string, ttlMs: number | null, maxSizeBytes: number | null = null) {
    if (maxSizeBytes !== null && maxSizeBytes <= 0) {
      throw new Error("DiskCache maxSizeBytes must be > 0");
    }
    const hash = createHash("sha256").update(storeId).digest("hex").slice(0, 16);
    this.storeDir = join(cacheDir, hash);
    this.ttlMs = ttlMs;
    this.maxSizeBytes = maxSizeBytes;
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

    // Evict if over size limit
    if (this.maxSizeBytes !== null) {
      await this.evictLRU();
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

  /** Remove oldest files by mtime until total size is under maxSizeBytes. */
  private async evictLRU(): Promise<void> {
    if (this.maxSizeBytes === null) return;

    try {
      const entries = await this.scanDirectory(this.storeDir);

      let totalSize = entries.reduce((sum, e) => sum + e.size, 0);
      if (totalSize <= this.maxSizeBytes) return;

      // Sort by mtime ascending (oldest first)
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      for (const entry of entries) {
        if (totalSize <= this.maxSizeBytes) break;
        try {
          await rm(entry.path, { force: true });
          totalSize -= entry.size;
        } catch {
          // ignore individual removal failures
        }
      }
    } catch {
      // ignore scan failures
    }
  }

  /** Recursively scan directory for files with their size and mtime. */
  private async scanDirectory(dir: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const results: Array<{ path: string; size: number; mtimeMs: number }> = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.name.endsWith(".tmp." + process.pid)) continue; // skip temp files
        if (entry.isDirectory()) {
          const subEntries = await this.scanDirectory(fullPath);
          results.push(...subEntries);
        } else if (entry.isFile()) {
          try {
            const s = await stat(fullPath);
            results.push({ path: fullPath, size: s.size, mtimeMs: s.mtimeMs });
          } catch {
            // ignore stat failures
          }
        }
      }
    } catch {
      // ignore readdir failures
    }

    return results;
  }
}
