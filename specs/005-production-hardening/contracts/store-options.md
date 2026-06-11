# Contract: Store options, retry/timeout, missing-chunk

Public API contract for network resilience (FR-019–FR-024), missing-chunk handling (FR-025–FR-027), and the unbounded disk-cache warning (FR-001).

## Store option additions

```ts
export interface HTTPStoreOptions {
  url: string;
  timeout?: number;          // existing; default 30000
  headers?: Record<string, string>;
  maxRetries?: number;       // NEW; default 3
  observability?: ObservabilityHooks; // NEW
}

export interface S3StoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  maxRetries?: number;       // NEW; default 3
  timeout?: number;          // NEW; explicit per-op timeout, default 30000
  observability?: ObservabilityHooks; // NEW
}
```

## Retry / backoff contract

- **Retryable HTTP statuses**: `429, 500, 502, 503, 504` (FR-019).
- **Retryable network errors**: `ECONNRESET, ETIMEDOUT, EAI_AGAIN` (FR-020); S3 also `ThrottlingException, SlowDown, TimeoutError`.
- **Non-retryable**: 404 / `NoSuchKey` / `NotFound` ⇒ return `null` (object missing) or fail fast without consuming attempts (FR-024).
- **Backoff**: full jitter — delay = uniform random in `[0, min(cap, 100 · 2^attempt)]` ms (FR-021). Never negative; total attempts bounded by `maxRetries`.
- **Timeout**: each operation aborts at `timeoutMs`; S3 passes `abortSignal: AbortSignal.timeout(timeoutMs)` to `client.send` (FR-022).
- **Config**: `maxRetries` and `timeout` honored from options instead of constants (FR-023). Defaults preserve current behavior.
- `onRetry({ attempt, status?, error? })` fires before each backoff delay.

### Contract tests (`tests/unit/retry.test.ts`)

1. Each retryable status/network code triggers a retry; success after a transient failure returns data.
2. A non-retryable outcome (404) does not retry and does not throw spuriously (returns `null`).
3. `fullJitterDelay(attempt, base)` ∈ `[0, min(cap, base·2^attempt)]` for attempts 0..maxRetries.
4. After `maxRetries` exhausted, a `StoreError` is thrown citing attempt count.
5. S3 operation exceeding `timeout` is aborted.

## Missing-chunk contract

```ts
export interface ReadOptions {
  // … existing fields …
  strict?: boolean;          // NEW; default false
  observability?: ObservabilityHooks; // NEW
}

export class MissingChunkError extends ZarrError {} // NEW, exported
```

- Default (`strict` false): missing chunk ⇒ fill with fill value (default 0) **and** fire `onMissingChunk({key})` (FR-025, FR-027).
- `strict: true`: missing chunk ⇒ throw `MissingChunkError` (no fill) (FR-026).
- Applies to both the full-fetch miss path and the byte-range miss path in `loader.ts`.

### Contract tests (`tests/unit/loader.test.ts`)

1. Absent chunk, default mode ⇒ zeros returned **and** `onMissingChunk` fired with the key.
2. Absent chunk, `strict: true` ⇒ `MissingChunkError` thrown; no zeros returned.
3. `strict: false` (or omitted) ⇒ behavior byte-identical to current implementation.

## Unbounded disk-cache warning contract

- `new CachedStore(inner, options)` with `options.maxSizeBytes` undefined and `skipLocal` false ⇒ emit a one-time `console.warn` naming the unbounded-growth risk and how to bound it (FR-001).
- With `maxSizeBytes` set ⇒ no warning; eviction keeps total ≤ limit (FR-002, existing).
- `maxSizeBytes <= 0` ⇒ throws (FR-003, existing).

### Contract test (`tests/unit/disk-cache.test.ts`)

1. Construct `CachedStore` without `maxSizeBytes` ⇒ `console.warn` called once with the risk message.
2. Construct with `maxSizeBytes` ⇒ `console.warn` not called.
