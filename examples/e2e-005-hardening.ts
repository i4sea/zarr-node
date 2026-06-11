/**
 * E2E da spec 005-production-hardening contra um dataset WRF real no S3.
 *
 * Cobre, com dados reais, o que faz sentido validar ao vivo (US1, US2, US3, US5
 * parcial, US4 timeout). Falhas transitórias injetadas (5xx/ECONNRESET/jitter)
 * e o caminho de retry interno são validados de forma determinística pela suíte
 * (tests/unit/retry.test.ts, tests/unit/observability.test.ts) — não dá para
 * reproduzir confiavelmente contra o S3 real.
 *
 * Run:
 *   npx tsx examples/e2e-005-hardening.ts
 *
 * Requer credenciais AWS com acesso de leitura ao bucket abaixo.
 */
import {
  S3Store,
  CachedStore,
  InMemoryCache,
  openGroup,
  MissingChunkError,
  type Store,
  type ObservabilityHooks,
} from "../src/index.js";
import { rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Dataset alvo (immutable por path) ──────────────────────────────────────
const BUCKET = "i4sea-zarr-dev";
const PREFIX =
  "dev/data/model/sse/sse002/wrf3km/2026051212/forcing_atm_WRF3km_sse1_2026051218.zarr";
const REGION = "us-east-1"; // bucket está em us-east-1 (config padrão = us-east-2 → cross-region)

// ── harness mínimo de PASS/FAIL ─────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
}
function section(title: string) {
  console.log(`\n${"─".repeat(64)}\n  ${title}\n${"─".repeat(64)}`);
}
const fmt = (ms: number) =>
  ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;

/** Tamanho total em disco de um diretório (bytes). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = await stat(p);
    total += s.isDirectory() ? await dirSize(p) : s.size;
  }
  return total;
}

/**
 * Wrapper de Store que (a) conta gets por chave e (b) pode "sumir" com chunks
 * de um array (retornando null) para exercitar missing-chunk com dados reais,
 * sem depender de o S3 misbehaving.
 */
class InstrumentedStore implements Store {
  gets = new Map<string, number>();
  dropPrefix: string | null = null;
  constructor(private inner: Store) {}

  private count(key: string) {
    this.gets.set(key, (this.gets.get(key) ?? 0) + 1);
  }
  metadataGets(): number {
    let n = 0;
    for (const [k, c] of this.gets) if (k.includes(".z")) n += c;
    return n;
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.count(key);
    if (this.dropPrefix && key.startsWith(this.dropPrefix) && !key.includes(".z")) {
      return null; // simula chunk ausente
    }
    return this.inner.get(key);
  }
  has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }
  list(prefix: string): AsyncIterable<string> {
    return this.inner.list(prefix);
  }
  getRange(key: string, offset: number, length: number) {
    return this.inner.getRange?.(key, offset, length) ?? Promise.resolve(null);
  }
}

async function main() {
  const totalStart = performance.now();
  console.log("==================================================================");
  console.log("  zarr-node — E2E spec 005 (production-hardening) com WRF real");
  console.log(`  s3://${BUCKET}/${PREFIX}`);
  console.log("==================================================================");

  const cacheDir = join(tmpdir(), `zarr-005-${Date.now()}`);

  // ════════════════════════════════════════════════════════════════════════
  section("US1 — Cache em disco não cresce sem limite (FR-001/002/003)");
  // ════════════════════════════════════════════════════════════════════════

  // FR-001: sem maxSizeBytes → warning descobrível no console.warn.
  let warned = false;
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (String(a[0]).includes("unbounded")) warned = true;
    origWarn(...a);
  };
  new CachedStore(new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION }), {
    cacheDir: join(cacheDir, "unbounded"),
    storeId: "wrf-unbounded",
  });
  console.warn = origWarn;
  check("FR-001: construir sem maxSizeBytes emite warning de unbounded", warned);

  // FR-003: maxSizeBytes não-positivo é rejeitado.
  let rejected = false;
  try {
    new CachedStore(new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION }), {
      cacheDir: join(cacheDir, "bad"),
      storeId: "wrf-bad",
      maxSizeBytes: 0,
    });
  } catch {
    rejected = true;
  }
  check("FR-003: maxSizeBytes = 0 é rejeitado na construção", rejected);

  // FR-002: com limite, eviction LRU mantém o cache <= limite.
  const LIMIT = 4 * 1024 * 1024; // 4 MiB — pequeno de propósito
  const evictDir = join(cacheDir, "bounded");
  const boundedStore = new CachedStore(
    new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION }),
    { cacheDir: evictDir, storeId: "wrf-bounded", maxSizeBytes: LIMIT },
  );
  const evRoot = await openGroup(boundedStore);
  const windName = (await firstChunkedVar(evRoot)) ?? "lat";
  const evArr = await evRoot.getArray(windName);
  // Lê vários timesteps para forçar > 4 MiB de chunks no disco.
  for (let t = 0; t < Math.min(8, evArr.shape[0] ?? 1); t++) {
    const sel = evArr.shape.map((_, i) => (i === 0 ? t : null)) as (number | null)[];
    await evArr.get(sel);
  }
  const onDisk = await dirSize(evictDir);
  check(
    "FR-002: cache em disco fica <= maxSizeBytes após eviction",
    onDisk <= LIMIT,
    `${(onDisk / 1024 / 1024).toFixed(2)} MiB <= ${(LIMIT / 1024 / 1024).toFixed(0)} MiB`,
  );

  // ════════════════════════════════════════════════════════════════════════
  section("US2 — Cache de metadados plugável evita re-fetch (FR-005/007/008)");
  // ════════════════════════════════════════════════════════════════════════

  const inst = new InstrumentedStore(
    new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION }),
  );
  const metaCache = new InMemoryCache({ maxBytes: 16 * 1024 * 1024 });

  await openGroup(inst, "", { metadataCache: metaCache, storeId: "wrf-shared" });
  const afterFirst = inst.metadataGets();
  await openGroup(inst, "", { metadataCache: metaCache, storeId: "wrf-shared" });
  const afterSecond = inst.metadataGets();
  check(
    "FR-007: primeiro open busca metadados no store",
    afterFirst > 0,
    `${afterFirst} gets de metadados`,
  );
  check(
    "FR-005/007: segundo open é servido do cache (zero re-fetch)",
    afterSecond === afterFirst,
    `${afterSecond} == ${afterFirst}`,
  );

  // FR-008: identidade de store diferente → chaves não colidem.
  const inst2 = new InstrumentedStore(
    new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION }),
  );
  await openGroup(inst2, "", { metadataCache: metaCache, storeId: "outra-identidade" });
  check(
    "FR-008: storeId distinto não reaproveita entradas (busca do store)",
    inst2.metadataGets() > 0,
    `${inst2.metadataGets()} gets`,
  );

  // FR-008a: sem identidade derivável e sem storeId → falha rápida.
  let failFast = false;
  try {
    const naked: Store = {
      get: () => Promise.resolve(null),
      has: () => Promise.resolve(false),
      // eslint-disable-next-line @typescript-eslint/require-await
      list: async function* () {},
    };
    await openGroup(naked, "", { metadataCache: metaCache });
  } catch {
    failFast = true;
  }
  check("FR-008a: cache + store sem identidade e sem storeId → falha rápida", failFast);

  // ════════════════════════════════════════════════════════════════════════
  section("US3 — Hooks de observabilidade (FR-012..018)");
  // ════════════════════════════════════════════════════════════════════════

  const fired = new Set<string>();
  const hooks: ObservabilityHooks = {
    onCacheHit: (e) => fired.add(`cacheHit:${e.tier}`),
    onCacheMiss: (e) => fired.add(`cacheMiss:${e.tier}`),
    onStoreFetch: () => fired.add("storeFetch"),
    onRetry: () => fired.add("retry"),
    onChunkDecoded: () => fired.add("chunkDecoded"),
    onInFlightBytes: () => fired.add("inFlightBytes"),
    onMissingChunk: () => fired.add("missingChunk"),
    // handler que lança — não pode quebrar a leitura.
    // (sobrescreve abaixo após o primeiro uso para testar isolamento)
  };

  const obsDir = join(cacheDir, "obs");
  const obsStore = new CachedStore(
    new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION, observability: hooks }),
    { cacheDir: obsDir, storeId: "wrf-obs", maxSizeBytes: 64 * 1024 * 1024, observability: hooks },
  );
  const obsRoot = await openGroup(obsStore, "", { observability: hooks });
  const obsArr = await obsRoot.getArray(windName);
  const obsSel = obsArr.shape.map((_, i) => (i === 0 ? 0 : null)) as (number | null)[];
  await obsArr.get(obsSel, { observability: hooks }); // miss + fetch + decode + inflight
  await obsArr.get(obsSel, { observability: hooks }); // hit (disco/memória)

  check("FR-014: onStoreFetch disparou", fired.has("storeFetch"));
  check("FR-016: onChunkDecoded disparou", fired.has("chunkDecoded"));
  check("FR-017: onInFlightBytes disparou", fired.has("inFlightBytes"));
  check(
    "FR-013: onCacheHit/Miss disparou identificando tier",
    [...fired].some((f) => f.startsWith("cacheHit:")) ||
      [...fired].some((f) => f.startsWith("cacheMiss:")),
    [...fired].filter((f) => f.includes("cache")).join(", "),
  );

  // FR-012: handler que lança não quebra a leitura.
  let survived = true;
  try {
    const throwing: ObservabilityHooks = {
      onChunkDecoded: () => {
        throw new Error("handler explodiu");
      },
    };
    const tArr = await (await openGroup(obsStore)).getArray(windName);
    await tArr.get(obsSel, { observability: throwing });
  } catch {
    survived = false;
  }
  check("FR-012: handler que lança não aborta a leitura", survived);

  // ════════════════════════════════════════════════════════════════════════
  section("US5 — Missing chunk observável e opcionalmente fatal (FR-025/026)");
  // ════════════════════════════════════════════════════════════════════════

  const missInst = new InstrumentedStore(
    new S3Store({ bucket: BUCKET, prefix: PREFIX, region: REGION }),
  );
  const missRoot = await openGroup(missInst);
  // Escolhe um array pequeno (1D) e some com seus chunks.
  const small = (await firstVar(missRoot, 1)) ?? windName;
  missInst.dropPrefix = `${small}/`;
  const missArr = await missRoot.getArray(small);

  // Default: missing → fill value + onMissingChunk.
  const missFired = new Set<string>();
  const data = await missArr.get(undefined, {
    observability: { onMissingChunk: () => missFired.add("miss") },
  });
  check("FR-025: chunk ausente dispara onMissingChunk", missFired.has("miss"));
  check(
    "FR-025/027: default ainda retorna dados (fill value, sem quebrar)",
    data.length > 0,
    `${data.length} valores (zeros)`,
  );

  // Strict: missing → MissingChunkError.
  let threwStrict = false;
  try {
    await missArr.get(undefined, { strict: true });
  } catch (e) {
    threwStrict = e instanceof MissingChunkError;
  }
  check("FR-026: strict=true lança MissingChunkError em chunk ausente", threwStrict);

  // ════════════════════════════════════════════════════════════════════════
  section("US4 — Timeout por operação no caminho S3 (FR-022/023)");
  // ════════════════════════════════════════════════════════════════════════

  // FR-023: timeout configurável é honrado; FR-022: aborta ao estourar.
  // (cobertura de retry/jitter/5xx é determinística em tests/unit/retry.test.ts)
  const tinyTimeout = new S3Store({
    bucket: BUCKET,
    prefix: PREFIX,
    region: REGION,
    timeout: 1, // 1ms — deve abortar quase sempre
  });
  let aborted = false;
  try {
    await tinyTimeout.get(".zmetadata");
  } catch {
    aborted = true;
  }
  check(
    "FR-022/023: timeout=1ms aborta a operação S3",
    aborted,
    aborted ? "abortou" : "completou rápido demais — inconclusivo",
  );

  // ── Resultado ──
  section("RESULTADO");
  console.log(`\n  Total: ${fmt(performance.now() - totalStart)}`);
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  console.log(
    `\n  Lembrete: retry/jitter/5xx/ECONNRESET e payloads completos dos hooks` +
      `\n  são validados em 'npm test' (retry.test.ts, observability.test.ts).`,
  );
  await rm(cacheDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

/** Primeiro array com >1 chunk (bom para exercitar eviction/decode). */
async function firstChunkedVar(group: Awaited<ReturnType<typeof openGroup>>) {
  for await (const [name, arr] of group.arrays()) {
    if (arr.shape.length >= 2 && (arr.shape[0] ?? 1) > 1) return name;
  }
  return null;
}
/** Primeiro array com o número de dimensões pedido. */
async function firstVar(group: Awaited<ReturnType<typeof openGroup>>, ndim: number) {
  for await (const [name, arr] of group.arrays()) {
    if (arr.shape.length === ndim) return name;
  }
  return null;
}

main().catch((err) => {
  console.error("\nERRO FATAL:", err);
  process.exit(2);
});
