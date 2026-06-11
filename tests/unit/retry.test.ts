import { describe, it, expect, vi } from "vitest";
import {
  RETRYABLE_STATUS,
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_ERROR_NAMES,
  DEFAULT_RETRY_CONFIG,
  BASE_DELAY_MS,
  CAP_DELAY_MS,
  isRetryableStatus,
  isRetryable,
  fullJitterDelay,
  executeWithRetry,
  RetryExhaustedError,
} from "../../src/store/retry.js";

describe("retry policy — retryable classification", () => {
  it("classifies 429, 500, 502, 503, 504 as retryable statuses", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(RETRYABLE_STATUS.has(status)).toBe(true);
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("does not classify 404 (or other statuses) as retryable", () => {
    for (const status of [200, 206, 304, 400, 403, 404]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
    expect(isRetryableStatus(undefined)).toBe(false);
  });

  it("classifies ECONNRESET, ETIMEDOUT, EAI_AGAIN error codes as retryable", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      expect(RETRYABLE_NETWORK_CODES.has(code)).toBe(true);
      const err = Object.assign(new Error(`boom: ${code}`), { code });
      expect(isRetryable(err)).toBe(true);
    }
  });

  it("detects retryable network codes on err.cause.code (undici fetch shape)", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = Object.assign(
        new Error("socket error"),
        { code },
      );
      expect(isRetryable(err)).toBe(true);
    }
  });

  it("classifies transient disconnect codes (UND_ERR_SOCKET, ECONNREFUSED, EPIPE) as retryable", () => {
    // undici's "other side closed" during LB churn / rolling deploys
    for (const code of ["UND_ERR_SOCKET", "ECONNREFUSED", "EPIPE"]) {
      expect(RETRYABLE_NETWORK_CODES.has(code)).toBe(true);
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = Object.assign(
        new Error("other side closed"),
        { code },
      );
      expect(isRetryable(err)).toBe(true);
    }
  });

  it("classifies an aborted-timeout SDK error (AbortError wrapping TimeoutError) as retryable", () => {
    // Shape thrown by @smithy/node-http-handler when AbortSignal.timeout
    // fires: outer name "AbortError", cause is a DOMException named
    // "TimeoutError" with numeric code 23.
    const err = Object.assign(new Error("Request aborted"), {
      name: "AbortError",
      cause: Object.assign(
        new Error("The operation was aborted due to timeout"),
        {
          name: "TimeoutError",
          code: 23,
        },
      ),
    });
    expect(isRetryable(err)).toBe(true);
  });

  it("does not classify a plain user abort as retryable", () => {
    const err = Object.assign(new Error("Request aborted"), {
      name: "AbortError",
      cause: Object.assign(new Error("user abort"), { name: "AbortError" }),
    });
    expect(isRetryable(err)).toBe(false);
  });

  it("classifies S3 SDK error names ThrottlingException/SlowDown/TimeoutError as retryable", () => {
    for (const name of ["ThrottlingException", "SlowDown", "TimeoutError"]) {
      expect(RETRYABLE_ERROR_NAMES.has(name)).toBe(true);
      const err = new Error("sdk error");
      err.name = name;
      expect(isRetryable(err)).toBe(true);
    }
  });

  it("classifies SDK errors by $metadata.httpStatusCode", () => {
    const retryable = Object.assign(new Error("slow down"), {
      $metadata: { httpStatusCode: 503 },
    });
    expect(isRetryable(retryable)).toBe(true);

    const notFound = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    expect(isRetryable(notFound)).toBe(false);
  });

  it("does not classify unknown errors or 404-shaped errors as retryable", () => {
    expect(isRetryable(new Error("plain"))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable("string error")).toBe(false);
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    expect(isRetryable(enoent)).toBe(false);
  });
});

describe("retry policy — defaults", () => {
  it("defaults to 3 retries and a 30000ms timeout", () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.timeoutMs).toBe(30000);
  });
});

describe("fullJitterDelay", () => {
  it("stays within [0, min(cap, base·2^attempt)] for attempts 0..5", () => {
    for (let attempt = 0; attempt <= 5; attempt++) {
      const ceiling = Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      for (let i = 0; i < 200; i++) {
        const d = fullJitterDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("respects a custom base and cap", () => {
    for (let i = 0; i < 200; i++) {
      const d = fullJitterDelay(10, 100, 500);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(500);
    }
  });

  it("is never negative", () => {
    expect(fullJitterDelay(0, 0)).toBe(0);
  });
});

describe("executeWithRetry", () => {
  const transient = () =>
    Object.assign(new Error("transient"), { code: "ECONNRESET" });

  it("returns data after a transient failure then success", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw transient();
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("bounds attempts by maxRetries and throws RetryExhaustedError citing attempts", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw transient();
        },
        { maxRetries: 2, baseDelayMs: 0 },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      expect((err as RetryExhaustedError).attempts).toBe(3);
      expect((err as RetryExhaustedError).message).toContain("3");
      return true;
    });
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("makes exactly one attempt when maxRetries is 0", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw transient();
        },
        { maxRetries: 0, baseDelayMs: 0 },
      ),
    ).rejects.toThrow(RetryExhaustedError);
    expect(calls).toBe(1);
  });

  it("fails fast on a non-retryable error without consuming attempts", async () => {
    let calls = 0;
    const notFound = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw notFound;
        },
        { maxRetries: 3, baseDelayMs: 0 },
      ),
    ).rejects.toBe(notFound);
    expect(calls).toBe(1);
  });

  it("fires onRetry before each backoff with attempt number and error detail", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error("throttled"), {
            $metadata: { httpStatusCode: 503 },
          });
        }
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 0, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ attempt: 1, status: 503 }),
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: 2, status: 503 }),
    );
  });

  it("honors a custom isRetryable predicate", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw transient();
        },
        { maxRetries: 3, baseDelayMs: 0, isRetryable: () => false },
      ),
    ).rejects.toThrow("transient");
    expect(calls).toBe(1);
  });
});
