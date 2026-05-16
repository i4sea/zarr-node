import { MetadataError } from "../errors.js";
import type { ZarrayMeta, ZgroupMeta, Zattrs } from "./types.js";

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
