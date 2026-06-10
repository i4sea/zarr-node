import { StoreError, UnsupportedOperationError } from "../errors.js";
import type { ObservabilityHooks } from "../observability.js";
import { safeInvoke } from "../observability.js";
import {
  DEFAULT_RETRY_CONFIG,
  RETRYABLE_STATUS,
  RetryExhaustedError,
  executeWithRetry,
} from "./retry.js";
import type { Store, HTTPStoreOptions } from "./store.js";

/**
 * Sentinel thrown inside the retry loop so a retryable status goes through
 * the shared backoff policy. Carries the response so the final attempt's
 * response can still be returned to callers (preserving 404→null mapping
 * and status-specific error messages).
 */
class RetryableStatusError extends Error {
  readonly status: number;

  constructor(readonly response: Response) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = "RetryableStatusError";
    this.status = response.status;
  }
}

export class HTTPStore implements Store {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  private readonly hooks?: ObservabilityHooks;

  constructor(options: HTTPStoreOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_RETRY_CONFIG.timeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries;
    this.headers = options.headers ?? {};
    this.hooks = options.observability;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${key}`;
    const start = this.hooks?.onStoreFetch ? performance.now() : 0;
    const response = await this.fetchWithRetry(url);

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new StoreError(
        `HTTP GET ${url} failed with status ${response.status}: ${response.statusText}`,
      );
    }

    const buf = await response.arrayBuffer();
    if (this.hooks?.onStoreFetch) {
      safeInvoke(this.hooks.onStoreFetch, {
        key,
        bytes: buf.byteLength,
        latencyMs: performance.now() - start,
      });
    }
    return new Uint8Array(buf);
  }

  async has(key: string): Promise<boolean> {
    const url = `${this.baseUrl}/${key}`;
    try {
      const response = await this.fetchWithRetry(url, "HEAD");
      return response.ok;
    } catch {
      return false;
    }
  }

  async getRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${key}`;
    const end = offset + length - 1;
    const start = this.hooks?.onStoreFetch ? performance.now() : 0;
    const response = await this.fetchWithRetry(url, "GET", {
      Range: `bytes=${offset}-${end}`,
    });

    if (response.status === 404) return null;
    if (!response.ok && response.status !== 206) {
      throw new StoreError(
        `HTTP GET ${url} (range) failed with status ${response.status}: ${response.statusText}`,
      );
    }

    const buf = await response.arrayBuffer();
    // A 200 means the server ignored the Range header and sent the full
    // object — slice locally instead of returning the whole body as if it
    // were the requested range (which would silently corrupt chunk data).
    const data =
      response.status === 200
        ? new Uint8Array(buf).slice(offset, offset + length)
        : new Uint8Array(buf);
    // A short body (truncated 206, or a non-conformant 200 carrying only the
    // range bytes) would flow into chunk assembly as silent zero/NaN fill.
    if (data.byteLength !== length) {
      throw new StoreError(
        `HTTP GET ${url} (range ${offset}-${end}) returned ${data.byteLength} bytes, expected ${length}`,
      );
    }
    if (this.hooks?.onStoreFetch) {
      safeInvoke(this.hooks.onStoreFetch, {
        key,
        bytes: data.byteLength,
        latencyMs: performance.now() - start,
      });
    }
    return data;
  }

  async *list(_prefix: string): AsyncIterable<string> {
    throw new UnsupportedOperationError("list()", "HTTPStore");
  }

  private async fetchWithRetry(
    url: string,
    method: string = "GET",
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers = extraHeaders
      ? { ...this.headers, ...extraHeaders }
      : this.headers;
    const onRetry = this.hooks?.onRetry;

    try {
      return await executeWithRetry(
        async () => {
          const response = await fetch(url, {
            method,
            headers,
            signal: AbortSignal.timeout(this.timeout),
          });
          if (RETRYABLE_STATUS.has(response.status)) {
            // Drain the body so the connection can be reused.
            void response.arrayBuffer().catch(() => {});
            throw new RetryableStatusError(response);
          }
          return response;
        },
        {
          maxRetries: this.maxRetries,
          onRetry: onRetry ? (e) => safeInvoke(onRetry, e) : undefined,
        },
      );
    } catch (err) {
      // A retryable status that survived every attempt is still a response —
      // return it so callers map the final status (404→null, error message).
      if (err instanceof RetryableStatusError) return err.response;
      if (err instanceof RetryExhaustedError) {
        if (err.cause instanceof RetryableStatusError) {
          return err.cause.response;
        }
        throw new StoreError(`HTTP ${method} ${url} ${err.message}`);
      }
      throw new StoreError(
        `HTTP ${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
