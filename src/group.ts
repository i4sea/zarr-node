import type { Store } from "./store/store.js";
import type { Zattrs } from "./metadata/types.js";
import { ZarrArray } from "./array.js";
import { parseZarrayMeta, parseZgroupMeta, parseZattrs } from "./metadata/v2.js";
import { MetadataError } from "./errors.js";

export class ZarrGroup {
  readonly attrs: Readonly<Record<string, unknown>>;

  private readonly store: Store;
  private readonly basePath: string;

  constructor(store: Store, attrs: Zattrs, basePath: string) {
    this.store = store;
    this.attrs = attrs;
    this.basePath = basePath;
  }

  async getArray(name: string): Promise<ZarrArray> {
    const path = this.childPath(name);
    const zarrayKey = `${path}/.zarray`;
    const raw = await this.store.get(zarrayKey);
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
    const raw = await this.store.get(zgroupKey);
    if (!raw) {
      throw new MetadataError(
        `No .zgroup metadata found for "${name}" at path "${path}"`,
      );
    }
    parseZgroupMeta(new TextDecoder().decode(raw));
    const attrs = await this.loadAttrs(path);
    return new ZarrGroup(this.store, attrs, path);
  }

  async *arrays(): AsyncIterable<[string, ZarrArray]> {
    for (const name of await this.discoverChildren()) {
      const zarrayKey = this.childPath(name) + "/.zarray";
      if (await this.store.has(zarrayKey)) {
        yield [name, await this.getArray(name)];
      }
    }
  }

  async *groups(): AsyncIterable<[string, ZarrGroup]> {
    for (const name of await this.discoverChildren()) {
      const zgroupKey = this.childPath(name) + "/.zgroup";
      if (await this.store.has(zgroupKey)) {
        yield [name, await this.getGroup(name)];
      }
    }
  }

  /**
   * Discover unique direct child names by listing keys under this group's
   * prefix and extracting the first path segment. Works for both flat
   * key stores (S3) and directory-based stores (filesystem).
   */
  private async discoverChildren(): Promise<string[]> {
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

  async contains(name: string): Promise<boolean> {
    const path = this.childPath(name);
    const hasArray = await this.store.has(`${path}/.zarray`);
    const hasGroup = await this.store.has(`${path}/.zgroup`);
    return hasArray || hasGroup;
  }

  private childPath(name: string): string {
    return this.basePath ? `${this.basePath}/${name}` : name;
  }

  private async loadAttrs(path: string): Promise<Zattrs> {
    const zattrsKey = `${path}/.zattrs`;
    const raw = await this.store.get(zattrsKey);
    return raw ? parseZattrs(new TextDecoder().decode(raw)) : {};
  }
}
