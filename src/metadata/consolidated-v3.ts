// v3 consolidated metadata reader (feature 006, US5).
//
// v3 consolidates metadata INSIDE the root `zarr.json` under a nested
// `consolidated_metadata: { kind: "inline", metadata: { <path>: <doc> } }`
// block (unlike v2's flat sibling `.zmetadata` document). This reader adapts
// that nested form onto the SAME lookup surface the v2 `ConsolidatedMetadata`
// gives `ZarrGroup` (`get`/`has`/`listChildren`, FR-016), keyed by the
// metadata keys the group code actually asks for (`<path>/zarr.json`) — so
// child resolution stays version-neutral and avoids per-node fetches.
import { MetadataError } from "../errors.js";
import { ConsolidatedMetadata } from "./consolidated.js";
import { V3_META } from "./layout.js";

/**
 * Extract the nested `consolidated_metadata` from a root v3 `zarr.json`
 * document. Returns null when the document carries none (transparent
 * fallback, mirroring the v2 `.zmetadata` behavior).
 */
export function parseV3ConsolidatedMetadata(
  rootRaw: Uint8Array | string,
): ConsolidatedMetadata | null {
  const text =
    typeof rootRaw === "string" ? rootRaw : new TextDecoder().decode(rootRaw);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MetadataError("Invalid root zarr.json: failed to parse JSON");
  }

  const block = parsed.consolidated_metadata;
  if (block === undefined || block === null) return null;
  const metadata = (block as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) {
    throw new MetadataError(
      'Invalid consolidated_metadata in root zarr.json: missing "metadata" map',
    );
  }

  const encoder = new TextEncoder();
  const entries = new Map<string, Uint8Array>();
  for (const [path, doc] of Object.entries(
    metadata as Record<string, unknown>,
  )) {
    if (typeof doc !== "object" || doc === null) {
      throw new MetadataError(
        `Invalid consolidated_metadata entry for path "${path}": ` +
          `expected a zarr.json document`,
      );
    }
    // Keyed exactly as ZarrGroup asks for it: `<path>/zarr.json`.
    entries.set(`${path}/${V3_META}`, encoder.encode(JSON.stringify(doc)));
  }

  return new ConsolidatedMetadata(entries);
}
