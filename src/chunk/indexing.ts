/**
 * Compute the chunk grid indices for each dimension.
 * Returns an array of chunk indices per dimension.
 * For a full read, returns all chunk indices needed to cover the entire shape.
 */
export function computeChunkRanges(
  shape: readonly number[],
  chunks: readonly number[],
): number[][] {
  const ndim = shape.length;
  const ranges: number[][] = [];
  for (let d = 0; d < ndim; d++) {
    const numChunks = Math.ceil(shape[d] / chunks[d]);
    const range: number[] = [];
    for (let i = 0; i < numChunks; i++) {
      range.push(i);
    }
    ranges.push(range);
  }
  return ranges;
}

/**
 * Build the chunk key string from chunk indices and separator.
 */
export function chunkKey(
  indices: number[],
  separator: "." | "/",
): string {
  return indices.join(separator);
}

/**
 * Generate all chunk coordinate tuples from per-dimension ranges.
 * Uses a cartesian product of the ranges.
 */
export function* allChunkCoords(
  ranges: number[][],
): Generator<number[]> {
  const ndim = ranges.length;
  if (ndim === 0) {
    yield [];
    return;
  }
  const indices = new Array<number>(ndim).fill(0);
  const maxes = ranges.map((r) => r.length);

  while (true) {
    yield ranges.map((r, d) => r[indices[d]]);

    // Increment from last dimension
    let d = ndim - 1;
    while (d >= 0) {
      indices[d]++;
      if (indices[d] < maxes[d]) break;
      indices[d] = 0;
      d--;
    }
    if (d < 0) break;
  }
}

/**
 * Compute C-order strides for given shape.
 */
export function cStrides(shape: readonly number[]): number[] {
  const ndim = shape.length;
  const strides = new Array<number>(ndim);
  strides[ndim - 1] = 1;
  for (let d = ndim - 2; d >= 0; d--) {
    strides[d] = strides[d + 1] * shape[d + 1];
  }
  return strides;
}

/**
 * Compute F-order strides for given shape.
 */
export function fStrides(shape: readonly number[]): number[] {
  const ndim = shape.length;
  const strides = new Array<number>(ndim);
  strides[0] = 1;
  for (let d = 1; d < ndim; d++) {
    strides[d] = strides[d - 1] * shape[d - 1];
  }
  return strides;
}

// --- Slice support ---

export interface DimRange {
  start: number;
  stop: number;
}

type SliceElement = number | [number, number] | null;

/**
 * Normalize a user-provided selection into DimRange per dimension.
 */
export function normalizeSelection(
  selection: SliceElement[],
  shape: readonly number[],
): DimRange[] {
  return selection.map((sel, d) => {
    if (sel === null) {
      return { start: 0, stop: shape[d] };
    }
    if (typeof sel === "number") {
      return { start: sel, stop: sel + 1 };
    }
    return { start: sel[0], stop: sel[1] };
  });
}

/**
 * For each dimension, determine which chunk indices are needed to cover the slice range.
 */
export function computeSliceChunkRanges(
  ranges: DimRange[],
  chunks: readonly number[],
): number[][] {
  return ranges.map((r, d) => {
    const firstChunk = Math.floor(r.start / chunks[d]);
    const lastChunk = Math.floor((r.stop - 1) / chunks[d]);
    const result: number[] = [];
    for (let i = firstChunk; i <= lastChunk; i++) {
      result.push(i);
    }
    return result;
  });
}
