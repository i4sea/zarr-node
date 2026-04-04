import { StoreError, UnsupportedOperationError } from "../errors.js";
import type { Store, HTTPStoreOptions } from "./store.js";

const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 503]);
const BASE_DELAY_MS = 100;

export class HTTPStore implements Store {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;

  constructor(options: HTTPStoreOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.headers = options.headers ?? {};
  }

  async get(key: string): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${key}`;
    const response = await this.fetchWithRetry(url);

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new StoreError(
        `HTTP GET ${url} failed with status ${response.status}: ${response.statusText}`,
      );
    }

    const buf = await response.arrayBuffer();
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

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${key}`;
    const end = offset + length - 1;
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
    return new Uint8Array(buf);
  }

  async *list(_prefix: string): AsyncIterable<string> {
    throw new UnsupportedOperationError("list()", "HTTPStore");
  }

  private async fetchWithRetry(
    url: string,
    method: string = "GET",
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    let lastError: Error | undefined;
    const headers = extraHeaders
      ? { ...this.headers, ...extraHeaders }
      : this.headers;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          signal: AbortSignal.timeout(this.timeout),
        });

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          await delay(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await delay(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
      }
    }

    throw new StoreError(
      `HTTP ${method} ${url} failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
