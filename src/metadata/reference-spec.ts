import { MetadataError } from "../errors.js";

/**
 * Kerchunk v1 reference specification format.
 */
export interface ReferenceSpec {
  version: 1;
  refs: Record<string, string | [string] | [string, number, number]>;
}

/**
 * Parse and validate a kerchunk v1 reference spec from JSON.
 */
export function parseReferenceSpec(raw: string): ReferenceSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MetadataError("Invalid reference spec: not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new MetadataError("Invalid reference spec: expected object");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new MetadataError(
      `Unsupported reference spec version: ${obj.version}. Only version 1 is supported.`,
    );
  }

  if (typeof obj.refs !== "object" || obj.refs === null) {
    throw new MetadataError("Invalid reference spec: missing 'refs' object");
  }

  const refs = obj.refs as Record<string, unknown>;

  // Validate each ref value
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === "string") continue;
    if (Array.isArray(value)) {
      if (value.length === 1 && typeof value[0] === "string") continue;
      if (
        value.length === 3 &&
        typeof value[0] === "string" &&
        typeof value[1] === "number" &&
        typeof value[2] === "number"
      )
        continue;
      throw new MetadataError(
        `Invalid reference for key "${key}": array must have 1 or 3 elements`,
      );
    }
    throw new MetadataError(
      `Invalid reference for key "${key}": expected string or array`,
    );
  }

  return {
    version: 1,
    refs: refs as ReferenceSpec["refs"],
  };
}
