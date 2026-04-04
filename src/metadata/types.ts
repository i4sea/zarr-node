export interface CompressorConfig {
  id: string;
  [key: string]: unknown;
}

export interface FilterConfig {
  id: string;
  [key: string]: unknown;
}

export interface ZarrayMeta {
  zarr_format: 2;
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: CompressorConfig | null;
  fill_value: number | string | null;
  order: "C" | "F";
  dimension_separator: "." | "/";
  filters: FilterConfig[] | null;
}

export interface ZgroupMeta {
  zarr_format: 2;
}

export type Zattrs = Record<string, unknown>;
