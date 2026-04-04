import { readFile } from "node:fs/promises";
import type { Store } from "./store.js";
import type { ReferenceSpec } from "../metadata/reference-spec.js";
import { parseReferenceSpec } from "../metadata/reference-spec.js";
import { FileSystemStore } from "./filesystem.js";
import { HTTPStore } from "./http.js";
import { StoreError } from "../errors.js";

export interface ReferenceStoreOptions {
  /** Parsed reference spec, or a ReferenceSpec object. */
  spec: ReferenceSpec | string;
}

/**
 * Store that resolves keys via a kerchunk-style JSON manifest.
 * Maps virtual Zarr chunk keys to byte ranges in target files.
 */
export class ReferenceStore implements Store {
  private readonly refs: Map<string, string | [string] | [string, number, number]>;
  private readonly innerStores = new Map<string, Store>();

  constructor(options: ReferenceStoreOptions) {
    const spec = typeof options.spec === "string"
      ? parseReferenceSpec(options.spec)
      : options.spec;

    this.refs = new Map(Object.entries(spec.refs));
  }

  /**
   * Create a ReferenceStore by loading a spec from a local file path.
   */
  static async fromFile(path: string): Promise<ReferenceStore> {
    const content = await readFile(path, "utf-8");
    return new ReferenceStore({ spec: content });
  }

  /** Number of references in the manifest. */
  get refCount(): number {
    return this.refs.size;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const ref = this.refs.get(key);
    if (ref === undefined) return null;

    // Inline string reference
    if (typeof ref === "string") {
      return new TextEncoder().encode(ref);
    }

    // [url] — whole file reference
    if (ref.length === 1) {
      const store = await this.getInnerStore(ref[0]);
      return store.get(this.resolveInnerKey(ref[0]));
    }

    // [url, offset, length] — byte-range reference
    const [url, offset, length] = ref;
    const store = await this.getInnerStore(url);

    // Use getRange if available
    if (store.getRange) {
      return store.getRange(this.resolveInnerKey(url), offset, length);
    }

    // Fallback: read full file and slice
    const full = await store.get(this.resolveInnerKey(url));
    if (full === null) return null;
    return full.slice(offset, offset + length);
  }

  async has(key: string): Promise<boolean> {
    return this.refs.has(key);
  }

  async *list(prefix: string): AsyncIterable<string> {
    for (const key of this.refs.keys()) {
      if (key.startsWith(prefix)) {
        yield key;
      }
    }
  }

  /**
   * Get or create an inner store for the given URL.
   * Caches stores by scheme + authority to avoid re-creating clients.
   */
  private async getInnerStore(url: string): Promise<Store> {
    if (url.startsWith("s3://")) {
      const storeKey = this.getS3StoreKey(url);
      const cached = this.innerStores.get(storeKey);
      if (cached) return cached;

      // Parse s3://bucket/prefix from URL
      const withoutScheme = url.slice(5); // remove "s3://"
      const slashIdx = withoutScheme.indexOf("/");
      const bucket = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);

      // Dynamic import — S3Store is optional peer dependency
      try {
        const { S3Store } = await import("./s3.js");
        const s3Store = new S3Store({ bucket });
        this.innerStores.set(storeKey, s3Store);
        return s3Store;
      } catch {
        throw new StoreError(
          "S3 references require @aws-sdk/client-s3. Install it with: npm install @aws-sdk/client-s3",
        );
      }
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
      const parsed = new URL(url);
      const storeKey = parsed.origin;
      const cached = this.innerStores.get(storeKey);
      if (cached) return cached;
      const httpStore = new HTTPStore({ url: storeKey });
      this.innerStores.set(storeKey, httpStore);
      return httpStore;
    }

    // Local file or file:// URL
    const filePath = url.startsWith("file://") ? url.slice(7) : url;
    // Use the file's directory as the store root
    const lastSlash = filePath.lastIndexOf("/");
    const dir = lastSlash > 0 ? filePath.slice(0, lastSlash) : ".";
    const cachedFs = this.innerStores.get(dir);
    if (cachedFs) return cachedFs;
    const fsStore = new FileSystemStore({ path: dir });
    this.innerStores.set(dir, fsStore);
    return fsStore;
  }

  /**
   * Resolve a URL to the inner key for the store.
   */
  private resolveInnerKey(url: string): string {
    if (url.startsWith("s3://")) {
      // s3://bucket/path/to/file → path/to/file (S3Store has no prefix set)
      const withoutScheme = url.slice(5);
      const slashIdx = withoutScheme.indexOf("/");
      return slashIdx === -1 ? "" : withoutScheme.slice(slashIdx + 1);
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
      const parsed = new URL(url);
      return parsed.pathname.slice(1); // remove leading /
    }

    // Local file
    const filePath = url.startsWith("file://") ? url.slice(7) : url;
    const lastSlash = filePath.lastIndexOf("/");
    return lastSlash > 0 ? filePath.slice(lastSlash + 1) : filePath;
  }

  private getS3StoreKey(url: string): string {
    // s3://bucket/prefix -> s3://bucket
    const parts = url.slice(5).split("/");
    return `s3://${parts[0]}`;
  }
}
