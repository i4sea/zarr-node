import { MetadataError } from "../errors.js";

export class ConsolidatedMetadata {
  private readonly entries: Map<string, Uint8Array>;

  constructor(entries: Map<string, Uint8Array>) {
    this.entries = entries;
  }

  get(key: string): Uint8Array | null {
    return this.entries.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Extract unique direct child names under a given prefix.
   * For prefix "" (root), returns top-level children.
   * For prefix "level1", returns children of level1.
   */
  listChildren(prefix: string): string[] {
    const searchPrefix = prefix ? `${prefix}/` : "";
    const children = new Set<string>();

    for (const key of this.entries.keys()) {
      if (searchPrefix && !key.startsWith(searchPrefix)) continue;

      const rel = searchPrefix ? key.slice(searchPrefix.length) : key;
      const slashIdx = rel.indexOf("/");
      if (slashIdx === -1) continue; // Skip root-level .zattrs/.zgroup
      const name = rel.slice(0, slashIdx);
      if (name && !name.startsWith(".")) {
        children.add(name);
      }
    }

    return [...children];
  }
}

export function parseConsolidatedMetadata(
  raw: Uint8Array,
): ConsolidatedMetadata {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
  } catch {
    throw new MetadataError("Invalid .zmetadata: failed to parse JSON");
  }

  const metadata = parsed.metadata;
  if (!metadata || typeof metadata !== "object") {
    throw new MetadataError('Invalid .zmetadata: missing "metadata" key');
  }

  const encoder = new TextEncoder();
  const entries = new Map<string, Uint8Array>();

  for (const [key, value] of Object.entries(
    metadata as Record<string, unknown>,
  )) {
    entries.set(key, encoder.encode(JSON.stringify(value)));
  }

  return new ConsolidatedMetadata(entries);
}
