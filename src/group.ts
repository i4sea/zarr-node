import type { Store } from "./store/store.js";
import type { Zattrs } from "./metadata/types.js";
import type { ConsolidatedMetadata } from "./metadata/consolidated.js";
import { ZarrArray } from "./array.js";
import { parseZarrayMeta, parseZgroupMeta, parseZattrs } from "./metadata/v2.js";
import { MetadataError } from "./errors.js";

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
    return new ZarrArray(this.store, meta, attrs, path);
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
