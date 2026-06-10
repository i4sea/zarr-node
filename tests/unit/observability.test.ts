import { describe, it, expect, vi } from "vitest";
import { safeInvoke } from "../../src/observability.js";

describe("safeInvoke", () => {
  // T002: throw-isolation — a throwing handler is swallowed and never propagates
  it("swallows a throwing handler and never propagates", () => {
    const throwing = () => {
      throw new Error("handler exploded");
    };

    expect(() =>
      safeInvoke(throwing, { tier: "memory", key: "0.0" }),
    ).not.toThrow();
  });

  it("invokes the handler with the given argument", () => {
    const handler = vi.fn();
    const payload = { tier: "disk", key: "1.2" };

    safeInvoke(handler, payload);

    expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  });
});
