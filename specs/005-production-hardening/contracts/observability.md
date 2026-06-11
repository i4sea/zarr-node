# Contract: `ObservabilityHooks`

Public API contract for observability (FR-012–FR-018). Exported from package root.

## Type

```ts
export type CacheTier = "memory" | "disk" | "shared";

export interface ObservabilityHooks {
  onCacheHit?(e: { tier: CacheTier; key: string }): void;
  onCacheMiss?(e: { tier: CacheTier; key: string }): void;
  onStoreFetch?(e: { key: string; bytes: number; latencyMs: number }): void;
  onRetry?(e: { attempt: number; status?: number; error?: string }): void;
  onChunkDecoded?(e: { bytes: number; codec: string | null; decodeMs: number }): void;
  onInFlightBytes?(current: number): void;
  onMissingChunk?(e: { key: string }): void;
}
```

## Registration contract (FR-012a)

- Passed per instance via construction/open/read options — `HTTPStoreOptions`, `S3StoreOptions`, `CacheOptions`, `OpenOptions`, `ReadOptions`.
- No global registry; no per-read positional handler argument.
- The same hooks object MAY be passed to multiple layers; each layer fires only the events it owns (see ownership table in data-model.md).

## Behavioral contract (`tests/unit/observability.test.ts`)

1. Each hook fires exactly when its event occurs, with the documented payload.
2. `onCacheHit`/`onCacheMiss` carry the correct `tier` for memory / disk / shared layers.
3. `onStoreFetch` reports byte length and a non-negative `latencyMs`.
4. `onRetry` fires once per retry attempt with `attempt` (1-based) and the triggering `status` or `error`.
5. `onChunkDecoded` reports decoded byte count, codec id (or `null`), and a non-negative `decodeMs`.
6. `onInFlightBytes` reports the current budget value on change.
7. `onMissingChunk` fires with the missing key (both full-fetch and byte-range miss paths).
8. **Isolation**: a hook that throws does not abort or corrupt the read — the value is still returned (caught via `safeInvoke`).
9. **Zero-overhead**: with no hooks registered, no hook-related allocation or dispatch occurs; a benchmark read is statistically unchanged from baseline (SC-004).

## Call-site pattern (required for #8 + #9 to hold together)

Every emission site MUST guard on hook existence **before** constructing the payload; `safeInvoke` is applied only inside the guard:

```ts
// ✅ correct — zero allocation/dispatch when the hook is absent
if (hooks?.onChunkDecoded) {
  safeInvoke(hooks.onChunkDecoded, { bytes, codec, decodeMs });
}

// ❌ forbidden — allocates the payload object even when no hook is registered,
// breaking SC-004 in the per-chunk hot loop
safeInvoke(hooks?.onChunkDecoded, { bytes, codec, decodeMs });
```

`safeInvoke` provides throw-isolation (#8) only; it is not the dispatch guard (#9).
