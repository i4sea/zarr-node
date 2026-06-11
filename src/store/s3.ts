import { StoreError } from "../errors.js";
import type { ObservabilityHooks } from "../observability.js";
import { safeInvoke } from "../observability.js";
import {
  DEFAULT_RETRY_CONFIG,
  RetryExhaustedError,
  executeWithRetry,
  isRetryable,
} from "./retry.js";
import type { Store, S3StoreOptions } from "./store.js";

// Dynamic import helper — @aws-sdk/client-s3 is an optional peer dependency
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadS3SDK(): Promise<any> {
  try {
    return await import("@aws-sdk/client-s3");
  } catch {
    throw new StoreError(
      "S3Store requires @aws-sdk/client-s3. Install it with: npm install @aws-sdk/client-s3",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S3Client = any;

export class S3Store implements Store {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region?: string;
  private readonly endpoint?: string;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly hooks?: ObservabilityHooks;
  private clientPromise: Promise<S3Client> | null = null;

  constructor(options: S3StoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix?.replace(/\/+$/, "") ?? "";
    this.region = options.region;
    this.endpoint = options.endpoint;
    this.maxRetries = options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries;
    this.timeout = options.timeout ?? DEFAULT_RETRY_CONFIG.timeoutMs;
    this.hooks = options.observability;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const fullKey = this.resolveKey(key);
    return this.getObject(
      key,
      { Bucket: this.bucket, Key: fullKey },
      `S3 GET s3://${this.bucket}/${fullKey}`,
    );
  }

  async has(key: string): Promise<boolean> {
    const client = await this.getClient();
    const fullKey = this.resolveKey(key);
    const onRetry = this.hooks?.onRetry;

    try {
      await executeWithRetry(
        async () => {
          const sdk = await loadS3SDK();
          await client.send(
            new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: fullKey }),
            { abortSignal: AbortSignal.timeout(this.timeout) },
          );
        },
        {
          maxRetries: this.maxRetries,
          onRetry: onRetry ? (e) => safeInvoke(onRetry, e) : undefined,
        },
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      if (err instanceof RetryExhaustedError) {
        throw new StoreError(
          `S3 HEAD s3://${this.bucket}/${fullKey} ${err.message}`,
        );
      }
      throw new StoreError(
        `S3 HEAD s3://${this.bucket}/${fullKey} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    const fullKey = this.resolveKey(key);
    const end = offset + length - 1;
    return this.getObject(
      key,
      {
        Bucket: this.bucket,
        Key: fullKey,
        Range: `bytes=${offset}-${end}`,
      },
      `S3 GET s3://${this.bucket}/${fullKey} (range)`,
    );
  }

  async *list(prefix: string): AsyncIterable<string> {
    const client = await this.getClient();
    const fullPrefix = this.prefix ? `${this.prefix}/${prefix}` : prefix;

    const sdk = await loadS3SDK();
    const onRetry = this.hooks?.onRetry;
    let continuationToken: string | undefined;

    do {
      const token = continuationToken;
      const response = (await executeWithRetry(
        () =>
          client.send(
            new sdk.ListObjectsV2Command({
              Bucket: this.bucket,
              Prefix: fullPrefix,
              ContinuationToken: token,
            }),
            { abortSignal: AbortSignal.timeout(this.timeout) },
          ) as Promise<unknown>,
        {
          maxRetries: this.maxRetries,
          onRetry: onRetry ? (e) => safeInvoke(onRetry, e) : undefined,
        },
      )) as {
        Contents?: { Key?: string }[];
        NextContinuationToken?: string;
      };

      for (const obj of response.Contents ?? []) {
        if (obj.Key) {
          const relKey = this.prefix
            ? obj.Key.slice(this.prefix.length + 1)
            : obj.Key;
          yield relKey;
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  /**
   * GetObject with the shared retry policy: full-jitter backoff, expanded
   * retryable classification, and an explicit per-attempt timeout via
   * `AbortSignal.timeout` on `client.send`.
   */
  private async getObject(
    key: string,
    commandInput: { Bucket: string; Key: string; Range?: string },
    describeOp: string,
  ): Promise<Uint8Array | null> {
    const client = await this.getClient();
    // Timer spans every attempt plus backoff, matching HTTPStore semantics.
    const start = this.hooks?.onStoreFetch ? performance.now() : 0;
    const onRetry = this.hooks?.onRetry;

    try {
      return await executeWithRetry(
        async () => {
          const sdk = await loadS3SDK();
          const response = await client.send(
            new sdk.GetObjectCommand(commandInput),
            { abortSignal: AbortSignal.timeout(this.timeout) },
          );
          const body = response.Body;
          if (!body) {
            // A 2xx GetObject with no body is an anomalous response, not a
            // missing key — null is reserved for "key absent" (Store contract).
            throw new StoreError(
              `${describeOp} succeeded but returned no body`,
            );
          }
          const bytes = await body.transformToByteArray();
          if (this.hooks?.onStoreFetch) {
            safeInvoke(this.hooks.onStoreFetch, {
              key,
              bytes: bytes.byteLength,
              latencyMs: performance.now() - start,
            });
          }
          return new Uint8Array(bytes);
        },
        {
          maxRetries: this.maxRetries,
          isRetryable,
          onRetry: onRetry ? (e) => safeInvoke(onRetry, e) : undefined,
        },
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      if (err instanceof StoreError) throw err;
      if (err instanceof RetryExhaustedError) {
        throw new StoreError(`${describeOp} ${err.message}`);
      }
      throw new StoreError(
        `${describeOp} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolveKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private async getClient(): Promise<S3Client> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<S3Client> {
    const sdk = await loadS3SDK();
    return new sdk.S3Client({
      region: this.region,
      // The store's own retry policy (executeWithRetry) is the single retry
      // layer — the SDK's internal retry (default maxAttempts 3) would
      // multiply with it (up to maxAttempts × (maxRetries+1) requests) and
      // make the documented maxRetries option meaningless.
      maxAttempts: 1,
      ...(this.endpoint
        ? {
            endpoint: this.endpoint,
            forcePathStyle: true,
          }
        : {}),
    });
  }
}

function isNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name: string }).name;
    if (name === "NoSuchKey" || name === "NotFound" || name === "404") {
      return true;
    }
  }
  if (err && typeof err === "object" && "$metadata" in err) {
    const meta = (err as { $metadata: { httpStatusCode?: number } }).$metadata;
    return meta.httpStatusCode === 404;
  }
  return false;
}
