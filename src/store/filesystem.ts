import { readFile, access, readdir } from "node:fs/promises";
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
