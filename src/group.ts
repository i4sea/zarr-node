import type { Store } from "./store/store.js";
import type { Zattrs } from "./metadata/types.js";
import type { TypedArray } from "./dtype.js";
import type { ConsolidatedMetadata } from "./metadata/consolidated.js";
import { ZarrArray, DEFAULT_MAX_IN_FLIGHT_BYTES } from "./array.js";
import type { Slice, ReadOptions } from "./array.js";
import { ByteLimiter } from "./chunk/limiter.js";
import {
  parseZarrayMeta,
  parseZgroupMeta,
  parseZattrs,
} from "./metadata/v2.js";
import { MetadataError } from "./errors.js";
import { codecRegistry } from "./codec/codec.js";

export class ZarrGroup {
  readonly attrs: Readonly<Record<string, unknown>>;

  private readonly store: Store;
  private readonly basePath: string;
  private readonly consolidatedMeta: ConsolidatedMetadata | null;

  constructor(
    store: Store,
    attrs: Zattrs,
    basePath: string,
    consolidatedMeta: ConsolidatedMetadata | null = null,
  ) {
    this.store = store;
    this.attrs = attrs;
    this.basePath = basePath;
    this.consolidatedMeta = consolidatedMeta;
  }

  async getArray(name: string): Promise<ZarrArray> {
    const path = this.childPath(name);
    const zarrayKey = `${path}/.zarray`;
    const raw = await this.getMeta(zarrayKey);
    if (!raw) {
      throw new MetadataError(
        `No .zarray metadata found for "${name}" at path "${path}"`,
      );
    }
    const meta = parseZarrayMeta(new TextDecoder().decode(raw));
    const attrs = await this.loadAttrs(path);
    const codec = meta.compressor
      ? await codecRegistry.get(meta.compressor)
      : null;
    return new ZarrArray(this.store, meta, attrs, path, codec);
  }

  async getGroup(name: string): Promise<ZarrGroup> {
    const path = this.childPath(name);
    const zgroupKey = `${path}/.zgroup`;
    const raw = await this.getMeta(zgroupKey);
    if (!raw) {
      throw new MetadataError(
        `No .zgroup metadata found for "${name}" at path "${path}"`,
      );
    }
    parseZgroupMeta(new TextDecoder().decode(raw));
    const attrs = await this.loadAttrs(path);
    return new ZarrGroup(this.store, attrs, path, this.consolidatedMeta);
  }

  async *arrays(): AsyncIterable<[string, ZarrArray]> {
    for (const name of await this.discoverChildren()) {
      const zarrayKey = this.childPath(name) + "/.zarray";
      if (await this.hasMeta(zarrayKey)) {
        yield [name, await this.getArray(name)];
      }
    }
  }

  async *groups(): AsyncIterable<[string, ZarrGroup]> {
    for (const name of await this.discoverChildren()) {
      const zgroupKey = this.childPath(name) + "/.zgroup";
      if (await this.hasMeta(zgroupKey)) {
        yield [name, await this.getGroup(name)];
      }
    }
  }

  /**
   * Read multiple arrays with the same selection, bounding their *combined*
   * in-flight memory through one shared byte budget (`maxInFlightBytes`). This
   * prevents the `arrays × concurrency × chunkSize` blow-up of reading many
   * compressed arrays at once: the total live decoded footprint stays near the
   * single budget instead of multiplying per array.
   * Invalid array names are silently skipped (partial failure handling).
   */
  async readMultiple(
    names: string[],
    selection?: Slice,
    options?: ReadOptions,
  ): Promise<Map<string, TypedArray>> {
    const results = new Map<string, TypedArray>();

    // Open all arrays (skip invalid ones)
    const arrays: Array<{ name: string; array: ZarrArray }> = [];
    for (const name of names) {
      try {
        const arr = await this.getArray(name);
        arrays.push({ name, array: arr });
      } catch {
        // Skip invalid array names (FR-013 partial failure)
      }
    }

    // One byte budget shared across every array read.
    const limiter = new ByteLimiter(
      options?.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES,
    );

    // Read all arrays through the shared budget.
    const promises = arrays.map(async ({ name, array }) => {
      const data = await array.readWithLimiter(selection, options, limiter);
      return { name, data };
    });

    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.set(result.value.name, result.value.data);
      }
    }

    return results;
  }

  async contains(name: string): Promise<boolean> {
    const path = this.childPath(name);
    const hasArray = await this.hasMeta(`${path}/.zarray`);
    const hasGroup = await this.hasMeta(`${path}/.zgroup`);
    return hasArray || hasGroup;
  }

  /**
   * Discover unique direct child names. Uses consolidated cache when
   * available, falls back to store.list() for non-consolidated stores.
   */
  private async discoverChildren(): Promise<string[]> {
    if (this.consolidatedMeta) {
      return this.consolidatedMeta.listChildren(this.basePath);
    }

    const prefix = this.basePath ? `${this.basePath}/` : "";
    const children = new Set<string>();
    for await (const key of this.store.list(prefix)) {
      const rel = key.slice(prefix.length);
      const slashIdx = rel.indexOf("/");
      const name = slashIdx === -1 ? rel : rel.slice(0, slashIdx);
      if (name && !name.startsWith(".")) {
        children.add(name);
      }
    }
    return [...children];
  }

  /**
   * Get metadata by key. Checks consolidated cache first, falls back to store.
   */
  private async getMeta(key: string): Promise<Uint8Array | null> {
    if (this.consolidatedMeta) {
      const cached = this.consolidatedMeta.get(key);
      if (cached !== null) return cached;
      // Cache miss — fall back to store (FR-005)
    }
    return this.store.get(key);
  }

  /**
   * Check if metadata key exists. Checks consolidated cache first.
   */
  private async hasMeta(key: string): Promise<boolean> {
    if (this.consolidatedMeta && this.consolidatedMeta.has(key)) {
      return true;
    }
    return this.store.has(key);
  }

  private childPath(name: string): string {
    return this.basePath ? `${this.basePath}/${name}` : name;
  }

  private async loadAttrs(path: string): Promise<Zattrs> {
    const zattrsKey = `${path}/.zattrs`;
    const raw = await this.getMeta(zattrsKey);
    return raw ? parseZattrs(new TextDecoder().decode(raw)) : {};
  }
}
