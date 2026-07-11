import { MetadataError } from "../errors.js";
import {
  dtypeToTypedArrayCtor,
  dtypeByteSize,
  isBigEndian,
} from "../dtype.js";
import type { CodecPipeline } from "../codec/pipeline.js";
import type {
  ZarrayMeta,
  ZgroupMeta,
  Zattrs,
  ResolvedArrayMeta,
  ResolvedGroupMeta,
  ResolvedDtype,
} from "./types.js";

export function parseZarrayMeta(raw: string): ZarrayMeta {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new MetadataError("Invalid .zarray JSON: failed to parse");
  }

  if (parsed.zarr_format !== 2) {
    throw new MetadataError(
      `Unsupported zarr_format: ${String(parsed.zarr_format)}. Only zarr_format 2 is supported.`,
    );
  }

  const shape = parsed.shape as number[];
  const chunks = parsed.chunks as number[];

  if (!Array.isArray(shape) || !Array.isArray(chunks)) {
    throw new MetadataError("shape and chunks must be arrays");
  }

  if (shape.length !== chunks.length) {
    throw new MetadataError(
      `shape and chunks must have the same number of dimensions: shape has ${shape.length}, chunks has ${chunks.length}`,
    );
  }

  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i] <= 0) {
      throw new MetadataError(`chunks[${i}] must be > 0, got ${chunks[i]}`);
    }
  }

  const order = parsed.order as string;
  if (order !== "C" && order !== "F") {
    throw new MetadataError(`Invalid order: "${order}". Must be "C" or "F".`);
  }

  const dtype = parsed.dtype as string;
  if (typeof dtype !== "string") {
    throw new MetadataError("dtype must be a string");
  }

  const dimensionSeparator =
    (parsed.dimension_separator as string | undefined) ?? ".";
  if (dimensionSeparator !== "." && dimensionSeparator !== "/") {
    throw new MetadataError(
      `Invalid dimension_separator: "${dimensionSeparator}". Must be "." or "/".`,
    );
  }

  return {
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: (parsed.compressor ?? null) as ZarrayMeta["compressor"],
    fill_value: (parsed.fill_value ?? null) as ZarrayMeta["fill_value"],
    order: order as "C" | "F",
    dimension_separator: dimensionSeparator as "." | "/",
    filters: (parsed.filters ?? null) as ZarrayMeta["filters"],
  };
}

export function parseZgroupMeta(raw: string): ZgroupMeta {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new MetadataError("Invalid .zgroup JSON: failed to parse");
  }

  if (parsed.zarr_format !== 2) {
    throw new MetadataError(
      `Unsupported zarr_format: ${String(parsed.zarr_format)}. Only zarr_format 2 is supported.`,
    );
  }

  return { zarr_format: 2 };
}

export function parseZattrs(raw: string): Zattrs {
  try {
    return JSON.parse(raw) as Zattrs;
  } catch {
    throw new MetadataError("Invalid .zattrs JSON: failed to parse");
  }
}

// --- v2 → version-neutral adapters (feature 006) ---

/** Resolve a v2 numpy typestr into the neutral dtype description. */
export function resolveV2Dtype(dtype: string): ResolvedDtype {
  const byteSize = dtypeByteSize(dtype);
  return {
    ctor: dtypeToTypedArrayCtor(dtype),
    byteSize,
    byteOrder: byteSize === 1 ? "none" : isBigEndian(dtype) ? "big" : "little",
    widenHalfToFloat: false,
  };
}

/** Interpret a v2 `fill_value` (incl. the JSON string forms of specials). */
export function resolveV2FillValue(
  fillValue: ZarrayMeta["fill_value"],
): number | null {
  if (fillValue === null) return null;
  if (fillValue === "NaN") return NaN;
  if (fillValue === "Infinity") return Infinity;
  if (fillValue === "-Infinity") return -Infinity;
  return typeof fillValue === "number" ? fillValue : null;
}

/** Convert a parsed `.zarray` into the version-neutral array description. */
export function toResolvedArrayMeta(
  meta: ZarrayMeta,
  attrs: Zattrs,
  basePath: string,
  codecPipeline: CodecPipeline,
): ResolvedArrayMeta {
  return {
    zarrFormat: 2,
    shape: meta.shape,
    chunkShape: meta.chunks,
    dtypeName: meta.dtype,
    dtype: resolveV2Dtype(meta.dtype),
    codecPipeline,
    fillValue: resolveV2FillValue(meta.fill_value),
    order: meta.order,
    chunkKey: {
      kind: "v2",
      separator: meta.dimension_separator,
      prefix: null,
      basePath: basePath || null,
    },
    attrs,
  };
}

/** Convert a parsed `.zgroup` into the version-neutral group description. */
export function toResolvedGroupMeta(
  _meta: ZgroupMeta,
  attrs: Zattrs,
): ResolvedGroupMeta {
  return { zarrFormat: 2, attrs };
}
