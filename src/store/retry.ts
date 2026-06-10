/**
 * Shared retry policy for remote stores (FR-019–FR-024).
 *
 * Both HTTPStore and S3Store consume this module so retryable
 * classification, full-jitter backoff, and attempt accounting stay
 * identical across transports.
 */

/** HTTP statuses worth retrying (throttling and transient server errors). */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

/**
 * Node/undici network-error codes worth retrying (transient EKS/DNS/LB
 * conditions). `UND_ERR_SOCKET` is undici's "other side closed" — a
 * keep-alive connection dropped mid-request, common during rolling deploys.
 */
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** AWS SDK error names worth retrying (plus AbortSignal.timeout's TimeoutError). */
export const RETRYABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "SlowDown",
  "TimeoutError",
]);

export const BASE_DELAY_MS = 100;
/** Upper bound on a single backoff delay regardless of attempt count. */
export const CAP_DELAY_MS = 10_000;

export interface RetryConfig {
  maxRetries: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  timeoutMs: 30_000,
};

export function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && RETRYABLE_STATUS.has(status);
}

/** Extract an HTTP status from an error (`status` or AWS `$metadata`). */
export function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as {
    status?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof e.status === "number") return e.status;
  const metaStatus = e.$metadata?.httpStatusCode;
  return typeof metaStatus === "number" ? metaStatus : undefined;
}

/** Extract a network-error code from an error (`code` or `cause.code`, as undici sets). */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string") return e.code;
  const causeCode = e.cause?.code;
  return typeof causeCode === "string" ? causeCode : undefined;
}

/**
 * Extract retryable-relevant error names: the error's own `name` and its
 * `cause`'s name. The cause matters because abort wrappers hide the timeout:
 * an aborted AWS SDK send rejects with name "AbortError" whose cause is the
 * `AbortSignal.timeout` DOMException named "TimeoutError".
 */
function errorNames(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];
  const names: string[] = [];
  const e = err as { name?: unknown; cause?: { name?: unknown } };
  if (typeof e.name === "string") names.push(e.name);
  const causeName = e.cause?.name;
  if (typeof causeName === "string") names.push(causeName);
  return names;
}

/**
 * Classify an error as retryable: transient HTTP status (direct or via
 * AWS `$metadata`), transient network code (direct or via `err.cause`),
 * or a retryable SDK/timeout error name (direct or via `err.cause`).
 */
export function isRetryable(err: unknown): boolean {
  if (isRetryableStatus(errorStatus(err))) return true;
  const code = errorCode(err);
  if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return errorNames(err).some((name) => RETRYABLE_ERROR_NAMES.has(name));
}

/**
 * Full-jitter backoff (AWS-recommended): uniform random delay in
 * `[0, min(capMs, baseMs · 2^attempt)]`.
 */
export function fullJitterDelay(
  attempt: number,
  baseMs: number = BASE_DELAY_MS,
  capMs: number = CAP_DELAY_MS,
): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

/** Thrown when a retryable operation still fails after exhausting all attempts. */
export class RetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`failed after ${attempts} attempt(s): ${detail}`, { cause });
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
  }
}

export interface RetryEvent {
  attempt: number;
  status?: number;
  error?: string;
}

export interface ExecuteRetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  /** Fired before each backoff delay, once per failed retryable attempt. */
  onRetry?: (e: RetryEvent) => void;
}

/**
 * Run `op` with up to `maxRetries` retries and full-jitter backoff.
 * Non-retryable errors propagate unchanged (fail fast, FR-024);
 * retryable errors that exhaust attempts throw RetryExhaustedError.
 */
export async function executeWithRetry<T>(
  op: () => Promise<T>,
  options: ExecuteRetryOptions,
): Promise<T> {
  const classify = options.isRetryable ?? isRetryable;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (!classify(err)) throw err;
      if (attempt >= options.maxRetries) break;
      if (options.onRetry) {
        options.onRetry({
          attempt: attempt + 1,
          status: errorStatus(err),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await delay(
        fullJitterDelay(attempt, options.baseDelayMs, options.capDelayMs),
      );
    }
  }

  throw new RetryExhaustedError(options.maxRetries + 1, lastError);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
