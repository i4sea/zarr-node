import { StoreError } from "../errors.js";
import type { Store, S3StoreOptions } from "./store.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

// Dynamic import helper — @aws-sdk/client-s3 is an optional peer dependency
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadS3SDK(): Promise<any> {
  try {
    // @ts-expect-error — optional peer dependency, may not be installed
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
  private clientPromise: Promise<S3Client> | null = null;

  constructor(options: S3StoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix?.replace(/\/+$/, "") ?? "";
    this.region = options.region;
    this.endpoint = options.endpoint;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const client = await this.getClient();
    const fullKey = this.resolveKey(key);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const sdk = await loadS3SDK();
        const response = await client.send(
          new sdk.GetObjectCommand({ Bucket: this.bucket, Key: fullKey }),
        );
        const body = response.Body;
        if (!body) return null;
        const bytes = await body.transformToByteArray();
        return new Uint8Array(bytes);
      } catch (err) {
        if (isNotFound(err)) return null;
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          await delay(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw new StoreError(
          `S3 GET s3://${this.bucket}/${fullKey} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return null;
  }

  async has(key: string): Promise<boolean> {
    const client = await this.getClient();
    const fullKey = this.resolveKey(key);

    try {
      const sdk = await loadS3SDK();
      await client.send(
        new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: fullKey }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw new StoreError(
        `S3 HEAD s3://${this.bucket}/${fullKey} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async *list(prefix: string): AsyncIterable<string> {
    const client = await this.getClient();
    const fullPrefix = this.prefix
      ? `${this.prefix}/${prefix}`
      : prefix;

    const sdk = await loadS3SDK();
    let continuationToken: string | undefined;

    do {
      const response = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      );

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
    return name === "NoSuchKey" || name === "NotFound" || name === "404";
  }
  if (err && typeof err === "object" && "$metadata" in err) {
    const meta = (err as { $metadata: { httpStatusCode?: number } }).$metadata;
    return meta.httpStatusCode === 404;
  }
  return false;
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object" && "$metadata" in err) {
    const meta = (err as { $metadata: { httpStatusCode?: number } }).$metadata;
    return meta.httpStatusCode === 429 || meta.httpStatusCode === 503;
  }
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name: string }).name;
    return name === "ThrottlingException" || name === "SlowDown";
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
