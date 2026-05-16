import { describe, it, expect } from "vitest";
import {
  parseZarrayMeta,
  parseZgroupMeta,
  parseZattrs,
} from "../../src/metadata/v2.js";

describe("parseZarrayMeta", () => {
  it("parses a valid .zarray JSON", () => {
    const raw = JSON.stringify({
      zarr_format: 2,
      shape: [10],
      chunks: [10],
      dtype: "<f4",
      compressor: null,
      fill_value: 0.0,
      order: "C",
      dimension_separator: ".",
      filters: null,
    });
    const meta = parseZarrayMeta(raw);
    expect(meta.zarr_format).toBe(2);
    expect(meta.shape).toEqual([10]);
    expect(meta.chunks).toEqual([10]);
    expect(meta.dtype).toBe("<f4");
    expect(meta.compressor).toBeNull();
    expect(meta.fill_value).toBe(0.0);
    expect(meta.order).toBe("C");
    expect(meta.dimension_separator).toBe(".");
    expect(meta.filters).toBeNull();
  });

  it("parses .zarray with compressor config", () => {
    const raw = JSON.stringify({
      zarr_format: 2,
      shape: [50, 100],
      chunks: [10, 25],
      dtype: "<f8",
      compressor: { id: "zlib", level: 1 },
      fill_value: 0.0,
      order: "C",
      dimension_separator: ".",
      filters: null,
    });
    const meta = parseZarrayMeta(raw);
    expect(meta.compressor).toEqual({ id: "zlib", level: 1 });
  });

  it("defaults dimension_separator to '.' when missing", () => {
    const raw = JSON.stringify({
      zarr_format: 2,
      shape: [10],
      chunks: [10],
      dtype: "<f4",
      compressor: null,
      fill_value: 0.0,
      order: "C",
      filters: null,
    });
    const meta = parseZarrayMeta(raw);
    expect(meta.dimension_separator).toBe(".");
  });

  it("throws on invalid zarr_format", () => {
    const raw = JSON.stringify({
      zarr_format: 3,
      shape: [10],
      chunks: [10],
      dtype: "<f4",
      compressor: null,
      fill_value: 0.0,
      order: "C",
      filters: null,
    });
    expect(() => parseZarrayMeta(raw)).toThrow("zarr_format");
  });

  it("throws on mismatched shape/chunks dimensions", () => {
    const raw = JSON.stringify({
      zarr_format: 2,
      shape: [10, 20],
      chunks: [10],
      dtype: "<f4",
      compressor: null,
      fill_value: 0.0,
      order: "C",
      filters: null,
    });
    expect(() => parseZarrayMeta(raw)).toThrow();
  });

  it("throws on invalid order", () => {
    const raw = JSON.stringify({
      zarr_format: 2,
      shape: [10],
      chunks: [10],
      dtype: "<f4",
      compressor: null,
      fill_value: 0.0,
      order: "X",
      filters: null,
    });
    expect(() => parseZarrayMeta(raw)).toThrow("order");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseZarrayMeta("not json")).toThrow();
  });

  it("handles special fill_value strings", () => {
    const raw = JSON.stringify({
      zarr_format: 2,
      shape: [10],
      chunks: [10],
      dtype: "<f4",
      compressor: null,
      fill_value: "NaN",
      order: "C",
      filters: null,
    });
    const meta = parseZarrayMeta(raw);
    expect(meta.fill_value).toBe("NaN");
  });
});

describe("parseZgroupMeta", () => {
  it("parses a valid .zgroup JSON", () => {
    const raw = JSON.stringify({ zarr_format: 2 });
    const meta = parseZgroupMeta(raw);
    expect(meta.zarr_format).toBe(2);
  });

  it("throws on invalid zarr_format", () => {
    const raw = JSON.stringify({ zarr_format: 3 });
    expect(() => parseZgroupMeta(raw)).toThrow("zarr_format");
  });
});

describe("parseZattrs", () => {
  it("parses attributes", () => {
    const raw = JSON.stringify({ units: "K", long_name: "Temperature" });
    const attrs = parseZattrs(raw);
    expect(attrs).toEqual({ units: "K", long_name: "Temperature" });
  });

  it("returns empty object for empty JSON", () => {
    const attrs = parseZattrs("{}");
    expect(attrs).toEqual({});
  });
});
