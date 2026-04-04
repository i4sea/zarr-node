import { describe, it, expect } from "vitest";
import { nearestIndex, linearNearestIndex } from "../../src/coordinates.js";

describe("coordinate lookup", () => {
  // T034: Nearest-neighbor for sorted 1D (binary search)
  describe("nearestIndex (sorted 1D binary search)", () => {
    it("finds exact match", () => {
      const coords = new Float64Array([0, 1, 2, 3, 4, 5]);
      expect(nearestIndex(coords, 3)).toBe(3);
    });

    it("finds nearest for value between elements", () => {
      const coords = new Float64Array([0, 1, 2, 3, 4, 5]);
      expect(nearestIndex(coords, 2.3)).toBe(2);
      expect(nearestIndex(coords, 2.7)).toBe(3);
    });

    it("clamps to first element for value below range", () => {
      const coords = new Float64Array([10, 20, 30]);
      expect(nearestIndex(coords, -5)).toBe(0);
    });

    it("clamps to last element for value above range", () => {
      const coords = new Float64Array([10, 20, 30]);
      expect(nearestIndex(coords, 100)).toBe(2);
    });

    it("handles single-element array", () => {
      const coords = new Float64Array([42]);
      expect(nearestIndex(coords, 100)).toBe(0);
    });

    it("handles negative coordinates", () => {
      const coords = new Float64Array([-26.0, -25.5, -25.0, -24.5]);
      expect(nearestIndex(coords, -25.5)).toBe(1);
      expect(nearestIndex(coords, -25.3)).toBe(1);
      expect(nearestIndex(coords, -25.7)).toBe(1);
    });
  });

  // T034: Unsorted/2D linear scan
  describe("linearNearestIndex (unsorted/2D)", () => {
    it("finds nearest in unsorted array", () => {
      const coords = new Float64Array([5, 2, 8, 1, 9]);
      expect(linearNearestIndex(coords, 7.5)).toBe(2); // 8 is nearest
    });

    it("finds nearest in Float32Array", () => {
      const coords = new Float32Array([10, 20, 30, 40]);
      expect(linearNearestIndex(coords, 25)).toBe(1); // equidistant — first match wins
      expect(linearNearestIndex(coords, 26)).toBe(2); // 30 is closer
    });

    it("handles single element", () => {
      const coords = new Float64Array([42]);
      expect(linearNearestIndex(coords, 100)).toBe(0);
    });
  });
});
