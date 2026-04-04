import { describe, it, expect } from "vitest";
import type { Store } from "../../src/store/store.js";

/**
 * Shared contract test suite for all Store implementations.
 * Call runStoreContractTests with a factory that creates a populated store.
 * The store must contain at least:
 *   - key "test-key" with value Uint8Array [1, 2, 3]
 *   - keys "prefix/a" and "prefix/b"
 */
export function runStoreContractTests(
  name: string,
  createStore: () => Promise<{ store: Store; cleanup?: () => Promise<void> }>,
) {
  describe(`${name} — Store contract`, () => {
    it("get() returns data for existing key", async () => {
      const { store, cleanup } = await createStore();
      try {
        const data = await store.get("test-key");
        expect(data).not.toBeNull();
        expect(data).toEqual(new Uint8Array([1, 2, 3]));
      } finally {
        await cleanup?.();
      }
    });

    it("get() returns null for missing key", async () => {
      const { store, cleanup } = await createStore();
      try {
        const data = await store.get("nonexistent-key");
        expect(data).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it("has() returns true for existing key", async () => {
      const { store, cleanup } = await createStore();
      try {
        const exists = await store.has("test-key");
        expect(exists).toBe(true);
      } finally {
        await cleanup?.();
      }
    });

    it("has() returns false for missing key", async () => {
      const { store, cleanup } = await createStore();
      try {
        const exists = await store.has("nonexistent-key");
        expect(exists).toBe(false);
      } finally {
        await cleanup?.();
      }
    });

    it("list() yields keys under prefix", async () => {
      const { store, cleanup } = await createStore();
      try {
        const keys: string[] = [];
        for await (const key of store.list("prefix/")) {
          keys.push(key);
        }
        expect(keys.sort()).toEqual(["prefix/a", "prefix/b"]);
      } finally {
        await cleanup?.();
      }
    });

    it("list() yields empty for unknown prefix", async () => {
      const { store, cleanup } = await createStore();
      try {
        const keys: string[] = [];
        for await (const key of store.list("unknown/")) {
          keys.push(key);
        }
        expect(keys).toEqual([]);
      } finally {
        await cleanup?.();
      }
    });
  });
}
