import type { TypedArray } from "./dtype.js";

/**
 * Binary search for the nearest index in a sorted 1D coordinate array.
 * For sorted coordinates (ascending or descending), this is O(log n).
 */
export function nearestIndex(coords: TypedArray, value: number): number {
  const n = coords.length;
  if (n === 0) return 0;
  if (n === 1) return 0;

  // Determine sort direction
  const ascending = coords[n - 1] >= coords[0];

  let lo = 0;
  let hi = n - 1;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ascending) {
      if (coords[mid] < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    } else {
      if (coords[mid] > value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
  }

  // lo is the insertion point — check if lo or lo-1 is closer
  if (lo === 0) return 0;
  if (lo >= n) return n - 1;

  const distLo = Math.abs(coords[lo] - value);
  const distPrev = Math.abs(coords[lo - 1] - value);
  return distPrev <= distLo ? lo - 1 : lo;
}

/**
 * Linear scan for the nearest index in an unsorted or multi-dimensional coordinate array.
 * O(n) complexity.
 */
export function linearNearestIndex(coords: TypedArray, value: number): number {
  let bestIdx = 0;
  let bestDist = Math.abs(coords[0] - value);

  for (let i = 1; i < coords.length; i++) {
    const dist = Math.abs(coords[i] - value);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}
