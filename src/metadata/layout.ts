// Metadata layout & detection (feature 006): the ONE place that knows about
// `zarr.json` (v3) vs `.zarray`/`.zgroup` (v2) — key construction and
// array-vs-group format detection. Consumed by open.ts and group.ts.
import { MetadataError } from "../errors.js";
import type { Store } from "../store/store.js";

/** v3 node metadata document name. */
export const V3_META = "zarr.json";
/** v2 metadata document names. */
export const V2_ARRAY_META = ".zarray";
export const V2_GROUP_META = ".zgroup";
export const V2_ATTRS_META = ".zattrs";

/**
 * Async metadata read — a store `get`, a cache read-through, or a
 * consolidated-metadata lookup. `null` means strictly "key absent".
 */
export type MetaReader = (key: string) => Promise<Uint8Array | null>;

/** Result of format/node detection at a path. */
export interface DetectedNode {
  format: 2 | 3;
  nodeType: "array" | "group";
  /** The raw metadata document bytes (zarr.json or .zarray/.zgroup). */
  raw: Uint8Array;
}

export interface DetectNodeOptions {
  /**
   * Probe this format's markers first. Defaults to 3 (v3-first): a v3 store
   * never has `.zarray`, so v3-first costs one probe for v3 data and one
   * extra for v2 — and it implements the documented precedence rule that
   * `zarr.json` WINS when both markers exist at the same node.
   *
   * Groups pass their own format here so child probing keeps the parent's
   * request pattern (a v2 group probes `.zarray`/`.zgroup` first).
   */
  preferFormat?: 2 | 3;
}

/** Build a metadata key under a node base path. */
export function metadataKey(basePath: string, name: string): string {
  return basePath ? `${basePath}/${name}` : name;
}

function toReader(source: Store | MetaReader): MetaReader {
  return typeof source === "function"
    ? source
    : (key: string) => source.get(key);
}

/**
 * Peek at a `zarr.json` document's `node_type` without fully validating it.
 * Full parsing (and the unknown-`zarr_format` rejection) happens in the v3
 * parser; detection only needs the discriminator.
 */
function v3NodeType(raw: Uint8Array, path: string): "array" | "group" {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
  } catch {
    throw new MetadataError(
      `Invalid zarr.json at path "${path || "/"}": failed to parse JSON`,
    );
  }
  if (parsed.zarr_format !== 3) {
    throw new MetadataError(
      `Unsupported zarr_format in zarr.json at path "${path || "/"}": ` +
        `${String(parsed.zarr_format)}. Supported: 3 (zarr.json) and 2 (.zarray/.zgroup).`,
    );
  }
  const nodeType = parsed.node_type;
  if (nodeType !== "array" && nodeType !== "group") {
    throw new MetadataError(
      `Invalid zarr.json at path "${path || "/"}": node_type must be ` +
        `"array" or "group", got ${JSON.stringify(nodeType)}`,
    );
  }
  return nodeType;
}

/**
 * Detect the format and node type at `path`.
 *
 * Probes `zarr.json` first (v3 wins when both formats' markers exist — the
 * documented deterministic rule for that degenerate case), then `.zarray`,
 * then `.zgroup`. Throws `MetadataError` when nothing is found or when a
 * `zarr.json` declares an unknown `zarr_format` (FR-021).
 */
export async function detectNode(
  source: Store | MetaReader,
  path: string,
  options?: DetectNodeOptions,
): Promise<DetectedNode> {
  const read = toReader(source);

  const probeV3 = async (): Promise<DetectedNode | null> => {
    const raw = await read(metadataKey(path, V3_META));
    if (!raw) return null;
    return { format: 3, nodeType: v3NodeType(raw, path), raw };
  };

  const probeV2 = async (): Promise<DetectedNode | null> => {
    const zarrayRaw = await read(metadataKey(path, V2_ARRAY_META));
    if (zarrayRaw) return { format: 2, nodeType: "array", raw: zarrayRaw };
    const zgroupRaw = await read(metadataKey(path, V2_GROUP_META));
    if (zgroupRaw) return { format: 2, nodeType: "group", raw: zgroupRaw };
    return null;
  };

  const v2First = options?.preferFormat === 2;
  const node = v2First
    ? ((await probeV2()) ?? (await probeV3()))
    : ((await probeV3()) ?? (await probeV2()));
  if (node) return node;

  throw new MetadataError(
    `No array or group metadata (zarr.json, .zarray or .zgroup) found at ` +
      `path "${path || "/"}"`,
  );
}
