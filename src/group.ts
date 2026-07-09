import type { Store } from "./store/store.js";
import type { Zattrs, ResolvedGroupMeta } from "./metadata/types.js";
import type { TypedArray } from "./dtype.js";
import type { ConsolidatedMetadata } from "./metadata/consolidated.js";
import { ZarrArray, DEFAULT_MAX_IN_FLIGHT_BYTES } from "./array.js";
import type { Slice, ReadOptions } from "./array.js";
import { ByteLimiter } from "./chunk/limiter.js";
import {
  parseZarrayMeta,
  parseZgroupMeta,
  parseZattrs,
  toResolvedArrayMeta,
  toResolvedGroupMeta,
} from "./metadata/v2.js";
import {
  detectNode,
  metadataKey,
  V2_ATTRS_META,
} from "./metadata/layout.js";
import type { DetectedNode, MetaReader } from "./metadata/layout.js";
import { MetadataError } from "./errors.js";
import { buildV2Pipeline } from "./codec/pipeline.js";
import type { MetadataCacheContext } from "./cache/read-through.js";
import { readMetadataThrough } from "./cache/read-through.js";

/** Load a node's user attributes (v2: sibling `.zattrs`; absent ⇒ `{}`). */
async function loadV2Attrs(
  read: MetaReader,
  basePath: string,
): Promise<Zattrs> {
  const raw = await read(metadataKey(basePath, V2_ATTRS_META));
  return raw ? parseZattrs(new TextDecoder().decode(raw)) : {};
}

/**
 * @internal Materialize a detected ARRAY node into a `ZarrArray`.
 * Shared by `open.ts` and `ZarrGroup` child access.
 */
export async function materializeArrayNode(
  store: Store,
  node: DetectedNode,
  basePath: string,
  read: MetaReader,
): Promise<ZarrArray> {
  if (node.format === 3) {
    // Implemented by the v3 parser (feature 006, US1).
    throw new MetadataError(
      `Zarr v3 array at path "${basePath || "/"}" is not supported yet`,
    );
  }
  const meta = parseZarrayMeta(new TextDecoder().decode(node.raw));
  const attrs = await loadV2Attrs(read, basePath);
  const pipeline = await buildV2Pipeline(meta.compressor, meta.filters);
  return new ZarrArray(
    store,
    toResolvedArrayMeta(meta, attrs, basePath, pipeline),
  );
}

/**
 * @internal Materialize a detected GROUP node into its neutral metadata.
 * The caller builds the `ZarrGroup` (root opens also wire consolidated
 * metadata).
 */
export async function materializeGroupMeta(
  node: DetectedNode,
  basePath: string,
  read: MetaReader,
): Promise<ResolvedGroupMeta> {
  if (node.format === 3) {
    // Implemented by the v3 parser (feature 006, US1).
    throw new MetadataError(
      `Zarr v3 group at path "${basePath || "/"}" is not supported yet`,
    );
  }
  const meta = parseZgroupMeta(new TextDecoder().decode(node.raw));
  const attrs = await loadV2Attrs(read, basePath);
  return toResolvedGroupMeta(meta, attrs);
}

export class ZarrGroup {
  readonly attrs: Readonly<Record<string, unknown>>;

  private readonly store: Store;
  private readonly meta: ResolvedGroupMeta;
  private readonly basePath: string;
  private readonly consolidatedMeta: ConsolidatedMetadata | null;
  private readonly metaContext?: MetadataCacheContext;

  constructor(
    store: Store,
    meta: ResolvedGroupMeta,
    basePath: string,
    consolidatedMeta: ConsolidatedMetadata | null = null,
    metaContext?: MetadataCacheContext,
  ) {
    this.store = store;
    this.meta = meta;
    this.attrs = meta.attrs;
    this.basePath = basePath;
    this.consolidatedMeta = consolidatedMeta;
    this.metaContext = metaContext;
  }

  /**
   * Detect a child node through the layout seam. Children are probed in this
   * group's own format order first (a v2 group's children are v2 in practice),
   * keeping the v2 request pattern unchanged.
   *
   * With consolidated metadata, detection probes run against the consolidated
   * map ONLY (a miss there costs no store round-trip); if the node is entirely
   * absent from it, detection retries against the store — consolidated
   * metadata may be incomplete (FR-005).
   */
  private async detectChild(path: string): Promise<DetectedNode> {
    const opts = { preferFormat: this.meta.zarrFormat };
    if (this.consolidatedMeta) {
      const consolidated = this.consolidatedMeta;
      try {
        return await detectNode(
          async (key: string) => consolidated.get(key),
          path,
          opts,
        );
      } catch (err) {
        if (!(err instanceof MetadataError)) throw err;
        // Fall through: not in consolidated metadata — probe the store.
      }
    }
    return detectNode(this.metaReader, path, opts);
  }

  private get metaReader(): MetaReader {
    return (key: string) => this.getMeta(key);
  }

  async getArray(name: string): Promise<ZarrArray> {
    const path = this.childPath(name);
    let node: DetectedNode;
    try {
      node = await this.detectChild(path);
    } catch (err) {
      if (err instanceof MetadataError) {
        throw new MetadataError(
          `No array metadata found for "${name}" at path "${path}"`,
        );
      }
      throw err;
    }
    if (node.nodeType !== "array") {
      throw new MetadataError(
        `Node "${name}" at path "${path}" is a group, not an array`,
      );
    }
    return materializeArrayNode(this.store, node, path, this.metaReader);
  }

  async getGroup(name: string): Promise<ZarrGroup> {
    const path = this.childPath(name);
    let node: DetectedNode;
    try {
      node = await this.detectChild(path);
    } catch (err) {
      if (err instanceof MetadataError) {
        throw new MetadataError(
          `No group metadata found for "${name}" at path "${path}"`,
        );
      }
      throw err;
    }
    if (node.nodeType !== "group") {
      throw new MetadataError(
        `Node "${name}" at path "${path}" is an array, not a group`,
      );
    }
    const meta = await materializeGroupMeta(node, path, this.metaReader);
    return new ZarrGroup(
      this.store,
      meta,
      path,
      this.consolidatedMeta,
      this.metaContext,
    );
  }

  async *arrays(): AsyncIterable<[string, ZarrArray]> {
    for (const name of await this.discoverChildren()) {
      const node = await this.tryDetectChild(name);
      if (node?.nodeType === "array") {
        yield [name, await this.getArray(name)];
      }
    }
  }

  async *groups(): AsyncIterable<[string, ZarrGroup]> {
    for (const name of await this.discoverChildren()) {
      const node = await this.tryDetectChild(name);
      if (node?.nodeType === "group") {
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
   * Invalid array names are silently skipped (partial failure handling), but
   * a read that starts and then fails (store error, `MissingChunkError` under
   * `strict`) rejects with that error once every sibling read has settled —
   * chunk keys are array-path-scoped, so the error identifies which array
   * failed.
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
      options?.observability?.onInFlightBytes,
    );

    // Read all arrays through the shared budget.
    const promises = arrays.map(async ({ name, array }) => {
      const data = await array.readWithLimiter(selection, options, limiter);
      return { name, data };
    });

    // allSettled (not all) so sibling reads drain — and release their shared
    // budget — before a failure is surfaced.
    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.set(result.value.name, result.value.data);
      }
    }

    return results;
  }

  async contains(name: string): Promise<boolean> {
    return (await this.tryDetectChild(name)) !== null;
  }

  /** detectChild that resolves null for non-node children instead of throwing. */
  private async tryDetectChild(name: string): Promise<DetectedNode | null> {
    try {
      return await this.detectChild(this.childPath(name));
    } catch (err) {
      if (err instanceof MetadataError) return null;
      throw err;
    }
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
   * Get metadata by key. Checks consolidated cache first, then reads through
   * the shared metadata cache (when configured), falling back to the store.
   */
  private async getMeta(key: string): Promise<Uint8Array | null> {
    if (this.consolidatedMeta) {
      const cached = this.consolidatedMeta.get(key);
      if (cached !== null) return cached;
      // Cache miss — fall back to store (FR-005)
    }
    return readMetadataThrough(this.store, key, this.metaContext);
  }

  private childPath(name: string): string {
    return this.basePath ? `${this.basePath}/${name}` : name;
  }
}
