import { readFile, access, readdir, open as fsOpen } from "node:fs/promises";
import { join } from "node:path";
import type { Store, FileSystemStoreOptions } from "./store.js";

export class FileSystemStore implements Store {
  private readonly root: string;

  constructor(options: FileSystemStoreOptions) {
    this.root = options.path;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(join(this.root, key));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await access(join(this.root, key));
      return true;
    } catch {
      return false;
    }
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    const filePath = join(this.root, key);
    try {
      const fh = await fsOpen(filePath, "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<string> {
    const dir = join(this.root, prefix);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      yield prefix + entry;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
