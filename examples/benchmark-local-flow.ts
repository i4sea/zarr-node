/**
 * Benchmark LOCAL do fluxo completo do zarr-node + todas as formas de cache.
 *
 * Lê um dataset WRF Zarr v2 do disco local (FileSystemStore) e cronometra cada
 * etapa do fluxo, instrumentando I/O de backend, decode de chunks e hits/misses
 * em cada tier de cache. Responde diretamente às perguntas:
 *
 *   1. Quanto tempo demora para ler o metadata?
 *   2. Quanto tempo para carregar o array de lat?
 *   3. Quanto tempo para carregar o array de lon?
 *   4. Quanto tempo para carregar o array de time?
 *   5. Quanto demora para achar o i/j de uma lat/lon específica?
 *   6. Quanto demora ler um chunk depois que lat/lon/time já foram carregados?
 *   7. Quais etapas eu pulo quando o chunk já está no cache do pod?
 *   8. Quais são os tipos/formas de cache e como funcionam?
 *
 * Pré-requisitos:
 *   - Dataset local em .bench/wrf.zarr (baixe com `aws s3 sync`), ou aponte
 *     ZARR_LOCAL_PATH para um diretório .zarr com .zmetadata consolidado.
 *   - Para a etapa de Redis: um redis local em redis://127.0.0.1:6379
 *     (pule com SKIP_REDIS=1).
 *
 * Rodar:
 *   npx tsx examples/benchmark-local-flow.ts
 *   ZARR_LOCAL_PATH=/caminho/data.zarr VERBOSE=1 npx tsx examples/benchmark-local-flow.ts
 *
 * Diagnóstico de produção (S3), separando GRADE × POINT (frio × quente):
 *   # GRADE (time, lat, lon) — 1 chunk por ponto; cold-start + queries quentes:
 *   MODE=s3-serving S3_BUCKET=i4sea-zarr S3_PREFIX=<...wrf3km.../...zarr> \
 *     S3_REGION=us-east-1 DATA_VAR=wind_vel npx tsx examples/benchmark-local-flow.ts
 *
 *   # POINT (time, npoints) — array inteiro = 1 chunk; over-read por consulta:
 *   MODE=s3-point S3_BUCKET=i4sea-zarr S3_PREFIX=<...wave.../...point...zarr> \
 *     S3_REGION=us-east-1 DATA_VAR=<var_de_ponto> \
 *     LAT_POINTS_VAR=lat_points LON_POINTS_VAR=lon_points \
 *     npx tsx examples/benchmark-local-flow.ts
 *
 *   (use SKIP_REDIS=1 se não houver Redis local; S3_REGION deve casar com a região
 *    do bucket — rode in-region para refletir a latência do pod.)
 */
import {
  FileSystemStore,
  S3Store,
  CachedStore,
  MemoryCache,
  InMemoryCache,
  openGroup,
  type Store,
  type ReadOptions,
  type OpenOptions,
  type ObservabilityHooks,
  type Slice,
} from "../src/index.js";
import { RedisCache } from "../src/redis/index.js";
import { GridIndex } from "../src/spatial/grid-index.js";
import { rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.ZARR_LOCAL_PATH ?? resolve(__dirname, "..", ".bench", "wrf.zarr");
const STORE_ID = "wrf-bench";
const VERBOSE = process.env.VERBOSE === "1";
const SKIP_REDIS = process.env.SKIP_REDIS === "1";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// MODE: "local" (FileSystemStore, padrão), "s3" (S3Store) ou "both".
const MODE = (process.env.MODE ?? "local").toLowerCase();
const S3_BUCKET = process.env.S3_BUCKET ?? "i4sea-zarr-dev";
const S3_PREFIX =
  process.env.S3_PREFIX ??
  "dev/data/model/sse/sse002/wrf3km/2026051212/forcing_atm_WRF3km_sse1_2026051218.zarr";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";

// Variáveis de coordenada e variável de dados padrão (auto-detectadas se faltarem)
const COORD_LAT = process.env.LAT_VAR ?? "lat";
const COORD_LON = process.env.LON_VAR ?? "lon";
const COORD_TIME = process.env.TIME_VAR ?? "time";
const DATA_VAR = process.env.DATA_VAR ?? "wind_vel";

// Coordenadas dos datasets POINT (time, npoints) — usadas pelo MODE=s3-point.
const COORD_LAT_POINTS = process.env.LAT_POINTS_VAR ?? "lat_points";
const COORD_LON_POINTS = process.env.LON_POINTS_VAR ?? "lon_points";

// ──────────────────────────────────────────────────────────────────────────
// Helpers de formatação / cronometragem
// ──────────────────────────────────────────────────────────────────────────
const fmt = (ms: number): string =>
  ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
const kib = (b: number): string => `${(b / 1024).toFixed(0)} KiB`;

async function timeit<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function hr(title?: string): void {
  if (title) console.log(`\n${"━".repeat(74)}\n  ${title}\n${"━".repeat(74)}`);
  else console.log("─".repeat(74));
}

// ──────────────────────────────────────────────────────────────────────────
// TimingStore — wrapper que mede o I/O REAL do backend (cache misses)
// FileSystemStore não tem hooks de observabilidade, então medimos aqui.
// ──────────────────────────────────────────────────────────────────────────
interface IoCounters {
  gets: number;
  getBytes: number;
  getMs: number;
  ranges: number;
  has: number;
  lists: number;
}
function zeroIo(): IoCounters {
  return { gets: 0, getBytes: 0, getMs: 0, ranges: 0, has: 0, lists: 0 };
}

class TimingStore implements Store {
  io: IoCounters = zeroIo();
  constructor(private readonly inner: Store) {}
  reset(): void {
    this.io = zeroIo();
  }
  snapshot(): IoCounters {
    return { ...this.io };
  }
  async get(key: string): Promise<Uint8Array | null> {
    const t0 = performance.now();
    const r = await this.inner.get(key);
    this.io.getMs += performance.now() - t0;
    this.io.gets++;
    if (r) this.io.getBytes += r.byteLength;
    return r;
  }
  async has(key: string): Promise<boolean> {
    this.io.has++;
    return this.inner.has(key);
  }
  async *list(prefix: string): AsyncIterable<string> {
    this.io.lists++;
    yield* this.inner.list(prefix);
  }
  async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    const t0 = performance.now();
    const r = await (this.inner.getRange?.(key, offset, length) ?? this.inner.get(key));
    this.io.getMs += performance.now() - t0;
    this.io.ranges++;
    if (r) this.io.getBytes += r.byteLength;
    return r;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Probe — conta eventos de observabilidade (decode + hits/misses por tier)
// ──────────────────────────────────────────────────────────────────────────
interface Ev {
  decodes: number;
  decodeMs: number;
  decodedBytes: number;
  hitMemory: number;
  missMemory: number;
  hitDisk: number;
  missDisk: number;
  hitShared: number;
  missShared: number;
  missing: number;
  retries: number;
}
function zeroEv(): Ev {
  return {
    decodes: 0, decodeMs: 0, decodedBytes: 0,
    hitMemory: 0, missMemory: 0, hitDisk: 0, missDisk: 0,
    hitShared: 0, missShared: 0, missing: 0, retries: 0,
  };
}

class Probe {
  ev: Ev = zeroEv();
  readonly hooks: ObservabilityHooks;
  constructor() {
    this.hooks = {
      onChunkDecoded: (e) => {
        this.ev.decodes++;
        this.ev.decodeMs += e.decodeMs;
        this.ev.decodedBytes += e.bytes;
        if (VERBOSE) console.log(`      · decode ${kib(e.bytes)} codec=${e.codec} ${fmt(e.decodeMs)}`);
      },
      onCacheHit: (e) => {
        if (e.tier === "memory") this.ev.hitMemory++;
        else if (e.tier === "disk") this.ev.hitDisk++;
        else this.ev.hitShared++;
        if (VERBOSE) console.log(`      · HIT  [${e.tier}] ${e.key}`);
      },
      onCacheMiss: (e) => {
        if (e.tier === "memory") this.ev.missMemory++;
        else if (e.tier === "disk") this.ev.missDisk++;
        else this.ev.missShared++;
        if (VERBOSE) console.log(`      · miss [${e.tier}] ${e.key}`);
      },
      onMissingChunk: () => {
        this.ev.missing++;
      },
      onRetry: (e) => {
        this.ev.retries++;
        if (VERBOSE) console.log(`      · RETRY attempt=${e.attempt} status=${e.status ?? "-"} ${e.error ?? ""}`);
      },
    };
  }
  reset(): void {
    this.ev = zeroEv();
  }
  snapshot(): Ev {
    return { ...this.ev };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Etapa medida: cronometra + imprime + retorna contadores delta
// ──────────────────────────────────────────────────────────────────────────
async function stage<T>(
  label: string,
  fn: () => Promise<T>,
  probe: Probe,
  timing: TimingStore | null,
  rec?: { into: Record<string, number>; key: string },
): Promise<T> {
  if (timing) timing.reset();
  probe.reset();
  const { ms, value } = await timeit(fn);
  if (rec) rec.into[rec.key] = ms;
  const ev = probe.snapshot();
  const io = timing?.snapshot() ?? zeroIo();

  const parts: string[] = [];
  if (io.gets || io.ranges) parts.push(`backend: ${io.gets}get/${io.ranges}range ${kib(io.getBytes)} (${fmt(io.getMs)})`);
  if (ev.decodes) parts.push(`decode: ${ev.decodes}× ${fmt(ev.decodeMs)}`);
  const hits: string[] = [];
  if (ev.hitMemory || ev.missMemory) hits.push(`mem ${ev.hitMemory}H/${ev.missMemory}M`);
  if (ev.hitDisk || ev.missDisk) hits.push(`disk ${ev.hitDisk}H/${ev.missDisk}M`);
  if (ev.hitShared || ev.missShared) hits.push(`shared ${ev.hitShared}H/${ev.missShared}M`);
  if (hits.length) parts.push(`cache: ${hits.join(" ")}`);
  if (ev.missing) parts.push(`missing: ${ev.missing}`);
  if (ev.retries) parts.push(`retries: ${ev.retries}`);

  console.log(`  ${fmt(ms).padStart(8)}  ${label}`);
  if (parts.length) console.log(`            ${parts.join("  |  ")}`);
  return value;
}

// ──────────────────────────────────────────────────────────────────────────
// Busca i/j (nearest neighbor) numa grade lat/lon 2D curvilínea
// ──────────────────────────────────────────────────────────────────────────
function findNearest(
  lat: Float32Array,
  lon: Float32Array,
  ny: number,
  nx: number,
  targetLat: number,
  targetLon: number,
): { i: number; j: number; dist: number } {
  const cosLat = Math.cos((targetLat * Math.PI) / 180);
  let best = Infinity;
  let bi = 0;
  let bj = 0;
  for (let i = 0; i < ny; i++) {
    const row = i * nx;
    for (let j = 0; j < nx; j++) {
      const dLat = lat[row + j] - targetLat;
      const dLon = (lon[row + j] - targetLon) * cosLat;
      const d = dLat * dLat + dLon * dLon;
      if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  return { i: bi, j: bj, dist: Math.sqrt(best) * 111 }; // ~km
}

// ──────────────────────────────────────────────────────────────────────────
// Fluxo completo medido — reutilizável entre configs e passes
// ──────────────────────────────────────────────────────────────────────────
interface FlowDeps {
  store: Store;
  timing: TimingStore | null;
  probe: Probe;
  openOpts?: OpenOptions;
  readOpts?: ReadOptions;
}

async function runFlow(
  passLabel: string,
  deps: FlowDeps,
): Promise<Record<string, number>> {
  const { store, timing, probe, openOpts, readOpts } = deps;
  const t: Record<string, number> = {};
  hr();
  console.log(`  ▶ PASS: ${passLabel}`);
  hr();

  // 1. Metadata: abrir o root group (lê .zmetadata consolidado)
  const root = await stage(
    "1. Ler metadata (openGroup → .zmetadata consolidado)",
    () => openGroup(store, "", openOpts),
    probe,
    timing,
    { into: t, key: "metadata" },
  );

  // Abrir os arrays de coordenada (vem do consolidated → custo ~0, sem I/O)
  const lat = await stage(
    `   getArray("${COORD_LAT}") [metadata do array, do consolidated]`,
    () => root.getArray(COORD_LAT),
    probe,
    timing,
  );
  const lon = await root.getArray(COORD_LON);
  const time = await root.getArray(COORD_TIME);
  const dataArr = await root.getArray(DATA_VAR);
  const [ny, nx] = lat.shape as [number, number];

  // 4. Carregar array de time (1 chunk, i8)
  const timeData = await stage(
    `4. Carregar array "${COORD_TIME}" completo  shape=${JSON.stringify(time.shape)}`,
    () => time.get(undefined, readOpts),
    probe,
    timing,
    { into: t, key: "time" },
  );

  // 2. Carregar array de lat completo (120 chunks)
  const latData = (await stage(
    `2. Carregar array "${COORD_LAT}" completo   shape=${JSON.stringify(lat.shape)}`,
    () => lat.get(undefined, readOpts),
    probe,
    timing,
    { into: t, key: "lat" },
  )) as Float32Array;

  // 3. Carregar array de lon completo (120 chunks)
  const lonData = (await stage(
    `3. Carregar array "${COORD_LON}" completo   shape=${JSON.stringify(lon.shape)}`,
    () => lon.get(undefined, readOpts),
    probe,
    timing,
    { into: t, key: "lon" },
  )) as Float32Array;

  // Definir um alvo lat/lon realista: o valor no centro da grade
  const ci = Math.floor(ny / 2);
  const cj = Math.floor(nx / 2);
  const targetLat = latData[ci * nx + cj];
  const targetLon = lonData[ci * nx + cj];

  // 5. Achar i/j da lat/lon alvo (CPU puro sobre arrays já carregados)
  const found = await stage(
    `5. Achar i/j de (lat=${targetLat.toFixed(4)}, lon=${targetLon.toFixed(4)})  [nearest sobre ${ny * nx} pontos]`,
    async () => findNearest(latData, lonData, ny, nx, targetLat, targetLon),
    probe,
    null, // sem I/O — só CPU
    { into: t, key: "findij" },
  );

  // 6. Ler 1 chunk: série temporal num ponto (variável [49,761,602], chunk [49,64,64])
  //    Selecionar [todos os tempos, i, j] toca exatamente 1 chunk espacial.
  const ts = await stage(
    `6. Ler série temporal "${DATA_VAR}"[: , ${found.i}, ${found.j}]  [1 chunk de ${JSON.stringify(dataArr.chunks)}]`,
    () => dataArr.get([null, [found.i, found.i + 1], [found.j, found.j + 1]], readOpts),
    probe,
    timing,
    { into: t, key: "chunk" },
  );

  // Validação / contexto
  const t0 = Number(timeData[0] as unknown as bigint);
  console.log(
    `\n            ✓ time[0]=${new Date(t0 * 1000).toISOString()}  steps=${time.shape[0]}  | ` +
      ` grid ${ny}×${nx} | série ${ts.length} valores | ponto recuperado=(${found.i},${found.j}) dist≈${found.dist.toFixed(2)}km`,
  );
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// Explicação dos tipos de cache (pergunta 8)
// ──────────────────────────────────────────────────────────────────────────
function printCacheTaxonomy(): void {
  hr("PERGUNTA 8 — Tipos / formas de cache no zarr-node");
  console.log(`
  Há 3 caches independentes, cada um numa camada diferente do pipeline:

  ┌─ Leitura de CHUNK ──────────────────────────────────────────────────────┐
  │ (A) MemoryCache  — src/cache/memory.ts                                   │
  │     • Guarda: chunks JÁ DECODIFICADOS (Uint8Array pós-Blosc), em heap.   │
  │     • Onde: memória do processo (pod). Passado em ReadOptions.memoryCache│
  │     • Hit: pula store.get + decode + byte-limiter. É o cache mais rápido.│
  │     • Eviction: LRU por bytes (maxBytes). Sem TTL.                        │
  │                                                                          │
  │ (B) DiskCache via CachedStore — src/cache/disk.ts, cached-store.ts       │
  │     • Guarda: chunks RAW (comprimidos, pré-decode), em arquivos.         │
  │     • Onde: filesystem local (cacheDir/<hash storeId>/<key>).            │
  │     • Hit: pula o fetch do backend (S3/HTTP), mas AINDA decodifica.      │
  │     • Eviction: LRU por mtime (maxSizeBytes) + TTL opcional (ttl seg).   │
  │     • Dedup de requests in-flight (anti thundering-herd).                │
  └──────────────────────────────────────────────────────────────────────────┘
  ┌─ Leitura de METADATA ───────────────────────────────────────────────────┐
  │ (C) Shared metadata cache — interface Cache (src/cache/cache.ts)         │
  │     Implementações: InMemoryCache (heap+TTL) e RedisCache (compartilhado)│
  │     • Guarda: .zarray/.zattrs/.zgroup/.zmetadata. NUNCA chunks.          │
  │     • Onde: heap do pod (InMemoryCache) OU Redis (entre pods/processos). │
  │     • Read-through: cache.get → store.get → cache.set. Chaves escopadas  │
  │       por storeId ("${"${storeId}"}:${"${key}"}"). Negative-cache p/ ausentes.       │
  │     • Hit: pula o store.get do arquivo de metadata.                      │
  │                                                                          │
  │  + Consolidated metadata (.zmetadata) — src/metadata/consolidated.ts:    │
  │     Não é "cache" configurável: é 1 arquivo que traz TODO o metadata.    │
  │     Após openGroup, getArray/getGroup leem do mapa em memória → 0 I/O.   │
  └──────────────────────────────────────────────────────────────────────────┘`);
}

// ──────────────────────────────────────────────────────────────────────────
// Backend factory — produz um Store fresco por modo
// ──────────────────────────────────────────────────────────────────────────
type Mode = "local" | "s3";

function makeInner(mode: Mode, hooks: ObservabilityHooks): Store {
  if (mode === "s3") {
    return new S3Store({
      bucket: S3_BUCKET,
      prefix: S3_PREFIX,
      region: S3_REGION,
      observability: hooks, // onStoreFetch / onRetry nativos do S3Store
    });
  }
  return new FileSystemStore({ path: DATA_DIR });
}

function backendLabel(mode: Mode): string {
  return mode === "s3"
    ? `S3Store (s3://${S3_BUCKET}/${S3_PREFIX})`
    : `FileSystemStore (${DATA_DIR})`;
}

// ──────────────────────────────────────────────────────────────────────────
// Matriz de caches — roda as 4 configs contra um backend (local OU s3)
// ──────────────────────────────────────────────────────────────────────────
async function runMatrix(mode: Mode, probe: Probe): Promise<void> {
  const readOptsBase: ReadOptions = { observability: probe.hooks };
  hr(`MODO = ${mode.toUpperCase()}  —  backend: ${backendLabel(mode)}`);

  // ── CONFIG 1 — SEM CACHE (baseline) ──────────────────────────────────────
  hr(`[${mode}] CONFIG 1 — SEM CACHE (baseline)`);
  console.log("  Custo cru: I/O do backend + Blosc decode em cada leitura.");
  {
    const timing = new TimingStore(makeInner(mode, probe.hooks));
    await runFlow("sem cache (frio)", {
      store: timing,
      timing,
      probe,
      readOpts: { ...readOptsBase },
    });
  }

  // ── CONFIG 2 — MemoryCache (chunks decodificados no pod) ──────────────────
  hr(`[${mode}] CONFIG 2 — MemoryCache (chunks decodificados em heap)`);
  console.log("  Pass 1 popula o cache; Pass 2 mostra o que é PULADO (pergunta 7).");
  {
    const timing = new TimingStore(makeInner(mode, probe.hooks));
    const memoryCache = new MemoryCache({ maxBytes: 512 * 1024 * 1024 });
    const ro: ReadOptions = { ...readOptsBase, memoryCache };
    await runFlow("MemoryCache — Pass 1 (popular)", { store: timing, timing, probe, readOpts: ro });
    await runFlow("MemoryCache — Pass 2 (quente: pula I/O + decode)", {
      store: timing,
      timing,
      probe,
      readOpts: ro,
    });
  }

  // ── CONFIG 3 — DiskCache via CachedStore (chunks raw em disco) ────────────
  hr(`[${mode}] CONFIG 3 — DiskCache (CachedStore: chunks raw em disco)`);
  if (mode === "s3") {
    console.log("  CASO DE USO REAL: cache de disco evitando ida ao S3.");
    console.log("  Pass 1 baixa do S3 + grava no disco; Pass 2: backend S3 = 0 (só disco + decode).");
  } else {
    console.log("  Backend já é local; o TimingStore mostra o I/O de backend evitado.");
    console.log("  Pass 2: backend = 0 gets, mas AINDA decodifica (guarda chunk comprimido).");
  }
  const diskCacheDir = join(tmpdir(), `zarr-bench-disk-${mode}-${process.pid}`);
  {
    const timing = new TimingStore(makeInner(mode, probe.hooks));
    const cached = new CachedStore(timing, {
      cacheDir: diskCacheDir,
      storeId: `${STORE_ID}-${mode}`,
      maxSizeBytes: 1024 ** 3,
      observability: probe.hooks,
    });
    const ro: ReadOptions = { ...readOptsBase };
    await runFlow("DiskCache — Pass 1 (popular disco)", { store: cached, timing, probe, readOpts: ro });
    await runFlow("DiskCache — Pass 2 (quente: backend evitado, decode mantido)", {
      store: cached,
      timing,
      probe,
      readOpts: ro,
    });
  }

  // ── CONFIG 4 — Shared metadata cache (InMemoryCache + Redis) ──────────────
  hr(`[${mode}] CONFIG 4 — Shared metadata cache (InMemoryCache e Redis)`);
  console.log("  Simula vários pods: o .zmetadata vem do cache compartilhado no 2º open,");
  console.log("  evitando o store.get do arquivo de metadata no backend.");

  // 4a — InMemoryCache
  {
    const timing = new TimingStore(makeInner(mode, probe.hooks));
    const metadataCache = new InMemoryCache({ maxBytes: 32 * 1024 * 1024 });
    const oo: OpenOptions = {
      metadataCache,
      storeId: `${STORE_ID}-${mode}`,
      observability: probe.hooks,
    };
    console.log("\n  ── InMemoryCache ──");
    await stage("open #1 (frio: lê .zmetadata do backend + popula cache)", () => openGroup(timing, "", oo), probe, timing);
    await stage("open #2 (quente: .zmetadata vem do cache compartilhado)", () => openGroup(timing, "", oo), probe, timing);
  }

  // 4b — RedisCache
  if (!SKIP_REDIS) {
    console.log("\n  ── RedisCache ──");
    let client: { quit: () => Promise<unknown>; get: (k: string) => Promise<unknown> } | null = null;
    try {
      const IORedis = (await import("ioredis")).default;
      client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: 2,
        connectTimeout: 2000,
      }) as unknown as typeof client;
      // Warm-up: força o socket a conectar antes de cronometrar.
      await client!.get("__warmup__");

      const redis = new RedisCache(client as never);
      const timing = new TimingStore(makeInner(mode, probe.hooks));
      // storeId único por run+modo → garante cold miss no open #1 e isola modos.
      const redisStoreId = `${STORE_ID}-${mode}-${process.pid}`;
      const oo: OpenOptions = { metadataCache: redis, storeId: redisStoreId, observability: probe.hooks };
      await stage("open #1 (frio: lê .zmetadata + popula Redis)", () => openGroup(timing, "", oo), probe, timing);
      await stage("open #2 (quente: .zmetadata vem do Redis)", () => openGroup(timing, "", oo), probe, timing);
    } catch (err) {
      console.log(`  (Redis indisponível — pulando. ${(err as Error).message})`);
    } finally {
      await client?.quit().catch(() => {});
    }
  } else {
    console.log("\n  ── RedisCache: pulado (SKIP_REDIS=1) ──");
  }

  // ── CONFIG 5 — OTIMIZADA (só S3): os 3 itens do plano combinados ──────────
  if (mode === "s3") {
    hr(`[s3] CONFIG 5 — OTIMIZADA (maxSockets + prewarm + concurrency alta + GridIndex)`);
    console.log("  Item 1 (pool 256) + Item 3 (prewarm) + concurrency 130 (colapsa ondas)");
    console.log("  + Item 2 (GridIndex resolve i/j sem rebaixar lat/lon a cada lookup).");
    const store = new S3Store({
      bucket: S3_BUCKET,
      prefix: S3_PREFIX,
      region: S3_REGION,
      maxSockets: 256,
      observability: probe.hooks,
    });
    const timing = new TimingStore(store);
    const ro: ReadOptions = { ...readOptsBase, concurrency: 130 };

    await stage("prewarm() — abre conexão TLS no pool", () => store.prewarm(), probe, timing);
    const root = await stage(
      "openGroup (metadata)",
      () => openGroup(timing, "", { observability: probe.hooks }),
      probe,
      timing,
    );
    const gi = await stage(
      "GridIndex.fromGroup — monta a grade 1× (lat+lon @ concurrency 130)",
      () => GridIndex.fromGroup(root, { readOptions: ro }),
      probe,
      timing,
    );
    const found = await stage(
      "nearest(i/j) — CPU puro, 0 I/O (lookups seguintes são grátis)",
      async () => gi.nearest(-25.5, -44.5),
      probe,
      null,
    );
    const dataArr = await root.getArray(DATA_VAR);
    await stage(
      `série temporal "${DATA_VAR}"[:, ${found.i}, ${found.j}] (1 chunk)`,
      () => dataArr.get([null, [found.i, found.i + 1], [found.j, found.j + 1]], ro),
      probe,
      timing,
    );
  }

  await rm(diskCacheDir, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────────────
// S3 — ANTES vs DEPOIS (mesma janela de rede, fluxo idêntico)
// ──────────────────────────────────────────────────────────────────────────
async function runS3BeforeAfter(probe: Probe): Promise<void> {
  hr("S3 — ANTES vs DEPOIS (mesma janela de rede, fluxo idêntico)");
  console.log("  LEGADO    = comportamento pré-implementação (maxSockets 50, concurrency 50).");
  console.log("  OTIMIZADO = Item 1 (pool 256) + Item 3 (prewarm) + concurrency 130.");
  console.log("  (Rodam back-to-back para compartilhar a latência de rede do momento.)");

  // LEGADO — replica o default antigo do SDK (~50 sockets) e concurrency 50.
  const legacy = new S3Store({
    bucket: S3_BUCKET,
    prefix: S3_PREFIX,
    region: S3_REGION,
    maxSockets: 50,
    observability: probe.hooks,
  });
  const legacyTiming = new TimingStore(legacy);
  const before = await runFlow("LEGADO (maxSockets 50, concurrency 50, sem prewarm)", {
    store: legacyTiming,
    timing: legacyTiming,
    probe,
    readOpts: { observability: probe.hooks, concurrency: 50 },
  });

  // OTIMIZADO — pool largo + prewarm + concurrency que cobre os 120 chunks numa onda.
  const opt = new S3Store({
    bucket: S3_BUCKET,
    prefix: S3_PREFIX,
    region: S3_REGION,
    maxSockets: 256,
    observability: probe.hooks,
  });
  const optTiming = new TimingStore(opt);
  await stage("prewarm() — abre conexão TLS no pool (Item 3)", () => opt.prewarm(), probe, optTiming);
  const after = await runFlow("OTIMIZADO (maxSockets 256, concurrency 130, prewarm)", {
    store: optTiming,
    timing: optTiming,
    probe,
    readOpts: { observability: probe.hooks, concurrency: 130 },
  });

  printAB(before, after);
}

function printAB(before: Record<string, number>, after: Record<string, number>): void {
  const rows: Array<[string, string]> = [
    ["1. Ler metadata", "metadata"],
    ["2. Carregar lat", "lat"],
    ["3. Carregar lon", "lon"],
    ["4. Carregar time", "time"],
    ["5. Achar i/j (CPU)", "findij"],
    ["6. Ler 1 chunk", "chunk"],
  ];
  hr("RESULTADO — ANTES vs DEPOIS (wall-clock por etapa)");
  console.log("  Etapa                  LEGADO       OTIMIZADO    Ganho");
  console.log("  ────────────────────   ─────────    ─────────    ──────");
  for (const [label, key] of rows) {
    const b = before[key] ?? 0;
    const a = after[key] ?? 0;
    const speedup = a > 0 ? b / a : 0;
    const gain = speedup >= 1.05 ? `${speedup.toFixed(1)}×` : "≈";
    console.log(`  ${label.padEnd(21)}  ${fmt(b).padStart(8)}     ${fmt(a).padStart(8)}     ${gain}`);
  }
  console.log("\n  Nota: GridIndex (Item 2) não aparece aqui porque ambos os fluxos");
  console.log("  carregam lat/lon 1×. O ganho do GridIndex é nos lookups SEGUINTES");
  console.log("  (0 I/O) e no cold-start via L2/Redis — ver CONFIG 5 / README.");
}

// ──────────────────────────────────────────────────────────────────────────
// S3 — PADRÃO DE SERVIÇO: lat/lon carregados 1×, queries seguintes reusam
// ──────────────────────────────────────────────────────────────────────────
async function runS3Serving(probe: Probe): Promise<void> {
  hr("S3 — PADRÃO DE SERVIÇO (lat/lon carregados 1×; 2ª+ vez reusa)");
  console.log("  POD 1: cold start (carrega o grid 1× do S3).");
  console.log("  Queries 2ª+ no mesmo pod: i/j é CPU puro; só lê o chunk do ponto.");
  console.log("  POD 2: cold start com Redis quente → rehidrata o grid SEM tocar lat/lon.");

  // concurrency 50 (evita a tempestade de conexões que vimos em concurrency alta
  // sobre link de alta latência).
  const ro: ReadOptions = { observability: probe.hooks, concurrency: 50 };
  const t: Record<string, number> = {};

  // storeId/gridKey únicos por run → POD 1 é sempre cold (não pega cache de runs
  // anteriores); POD 2 (mesma run) reusa.
  const runId = `serving-${process.pid}`;

  // Redis (L2 compartilhado entre "pods"). Pulável com SKIP_REDIS=1.
  let client: { quit: () => Promise<unknown>; get: (k: string) => Promise<unknown> } | null = null;
  let redis: RedisCache | undefined;
  if (!SKIP_REDIS) {
    try {
      const IORedis = (await import("ioredis")).default;
      client = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 2000 }) as unknown as typeof client;
      await client!.get("__warmup__");
      redis = new RedisCache(client as never);
    } catch (err) {
      console.log(`  (Redis indisponível — seguindo sem L2. ${(err as Error).message})`);
    }
  }
  const openOpts: OpenOptions = redis
    ? { metadataCache: redis, storeId: runId, observability: probe.hooks }
    : { observability: probe.hooks };

  try {
    // ── POD 1 — cold start ──────────────────────────────────────────────────
    hr("POD 1 — cold start (paga o grid 1×)");
    const store = new S3Store({
      bucket: S3_BUCKET,
      prefix: S3_PREFIX,
      region: S3_REGION,
      maxSockets: 128,
      observability: probe.hooks,
    });
    const timing = new TimingStore(store);
    await stage("prewarm()", () => store.prewarm(), probe, timing);
    const root = await stage("openGroup (metadata)", () => openGroup(timing, "", openOpts), probe, timing, {
      into: t,
      key: "pod1_meta",
    });
    const grid = await stage(
      "GridIndex.loadCached — carrega lat/lon 1× (COLD: do S3)",
      () => GridIndex.loadCached(root, { cache: redis, gridKey: runId, readOptions: ro }),
      probe,
      timing,
      { into: t, key: "pod1_grid" },
    );
    const dataArr = await root.getArray(DATA_VAR);

    // ── Queries quentes no mesmo pod ─────────────────────────────────────────
    hr("Queries no mesmo pod (grid em memória → 0 I/O de lat/lon)");
    const memoryCache = new MemoryCache({ maxBytes: 256 * 1024 * 1024 });
    const roq: ReadOptions = { ...ro, memoryCache };
    const points: Array<[number, number]> = [
      [-25.5, -44.5],
      [-23.0, -43.2],
      [-27.6, -48.5],
      [-25.5, -44.5], // repetido → chunk vem do MemoryCache
      [-22.9, -42.0],
    ];
    let qn = 0;
    for (const [la, lo] of points) {
      qn++;
      const f = grid.nearest(la, lo);
      await stage(
        `Query ${qn}: (${la}, ${lo}) → (${f.i},${f.j})  [nearest CPU + 1 chunk]`,
        () => dataArr.get([null, [f.i, f.i + 1], [f.j, f.j + 1]], roq),
        probe,
        timing,
        { into: t, key: `q${qn}` },
      );
    }

    // ── POD 2 — cold start, Redis quente ─────────────────────────────────────
    if (redis) {
      hr("POD 2 — cold start com Redis quente (rehidrata grid sem tocar lat/lon)");
      const store2 = new S3Store({
        bucket: S3_BUCKET,
        prefix: S3_PREFIX,
        region: S3_REGION,
        maxSockets: 128,
        observability: probe.hooks,
      });
      const timing2 = new TimingStore(store2);
      await stage("prewarm()", () => store2.prewarm(), probe, timing2);
      const root2 = await stage("openGroup (metadata via Redis)", () => openGroup(timing2, "", openOpts), probe, timing2, {
        into: t,
        key: "pod2_meta",
      });
      await stage(
        "GridIndex.loadCached — rehidrata do Redis (0 GET de lat/lon)",
        () => GridIndex.loadCached(root2, { cache: redis, gridKey: runId, readOptions: ro }),
        probe,
        timing2,
        { into: t, key: "pod2_grid" },
      );
    }
  } finally {
    await client?.quit().catch(() => {});
  }

  // ── Resumo ──────────────────────────────────────────────────────────────
  hr("RESULTADO — custo por requisição (1ª vez vs 2ª+ vez)");
  const cold = (t.pod1_meta ?? 0) + (t.pod1_grid ?? 0);
  console.log(`  POD 1 cold: setup do grid (metadata + lat/lon 1×) = ${fmt(cold)}`);
  console.log(`     ├─ openGroup (metadata) ............ ${fmt(t.pod1_meta ?? 0)}`);
  console.log(`     └─ GridIndex (lat+lon do S3) ....... ${fmt(t.pod1_grid ?? 0)}`);
  console.log(`  Queries no mesmo pod (i/j CPU + 1 chunk):`);
  console.log(`     ├─ Query 1 ......................... ${fmt(t.q1 ?? 0)}`);
  console.log(`     ├─ Query 2 ......................... ${fmt(t.q2 ?? 0)}`);
  console.log(`     ├─ Query 3 ......................... ${fmt(t.q3 ?? 0)}`);
  console.log(`     ├─ Query 4 (ponto repetido, cache) . ${fmt(t.q4 ?? 0)}`);
  console.log(`     └─ Query 5 ......................... ${fmt(t.q5 ?? 0)}`);
  if (t.pod2_grid !== undefined) {
    console.log(`  POD 2 cold (Redis quente): grid rehidratado = ${fmt((t.pod2_meta ?? 0) + (t.pod2_grid ?? 0))}`);
    console.log(`     ├─ openGroup (metadata via Redis) .. ${fmt(t.pod2_meta ?? 0)}`);
    console.log(`     └─ GridIndex (do Redis, 0 lat/lon) . ${fmt(t.pod2_grid ?? 0)}`);
    const factor = t.pod2_grid > 0 ? (t.pod1_grid ?? 0) / t.pod2_grid : 0;
    if (factor >= 1.5) console.log(`\n  → grid via Redis foi ${factor.toFixed(0)}× mais rápido que via S3.`);
  }
  console.log("\n  Pulado a partir da 2ª vez: metadata + lat + lon. Sobra só o chunk");
  console.log("  do ponto (ou nada, se já no MemoryCache — ver Query 4).");
}

// ──────────────────────────────────────────────────────────────────────────
// S3 — DATASET POINT (time, npoints): array inteiro = 1 chunk
// Testa a hipótese B do diagnóstico: como o converter chunka datasets POINT com
// `npoints: -1` (e `time: -1`), o array inteiro vira UM chunk. Toda consulta de
// ponto baixa + descomprime esse chunk inteiro para extrair 1 série. Aqui medimos
// o tamanho do chunk, o custo de decode e o over-read ratio (bytes decodificados ÷
// bytes úteis devolvidos), comparando frio (S3) × quente-disco (decode mantido) ×
// quente-memória (decode pulado).
// ──────────────────────────────────────────────────────────────────────────
async function tryGetArray2(group: Awaited<ReturnType<typeof openGroup>>, name: string) {
  try {
    return await group.getArray(name);
  } catch {
    return null;
  }
}

function toFloat64(typed: ArrayLike<number | bigint>): Float64Array {
  const out = new Float64Array(typed.length);
  for (let i = 0; i < typed.length; i++) out[i] = Number(typed[i]);
  return out;
}

function findNearestPoint(
  lat: Float64Array,
  lon: Float64Array,
  n: number,
  targetLat: number,
  targetLon: number,
): { k: number; dist: number } {
  const cosLat = Math.cos((targetLat * Math.PI) / 180);
  let best = Infinity;
  let bk = 0;
  for (let k = 0; k < n; k++) {
    const dLat = lat[k] - targetLat;
    const dLon = (lon[k] - targetLon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < best) {
      best = d;
      bk = k;
    }
  }
  return { k: bk, dist: Math.sqrt(best) * 111 };
}

/** Lê 1× medindo I/O de backend + decode, e devolve os contadores delta. */
async function measuredRead(
  label: string,
  fn: () => Promise<{ length: number }>,
  probe: Probe,
  timing: TimingStore,
): Promise<{ ms: number; returned: number; io: IoCounters; ev: Ev }> {
  timing.reset();
  probe.reset();
  const { ms, value } = await timeit(fn);
  const io = timing.snapshot();
  const ev = probe.snapshot();
  console.log(`  ${fmt(ms).padStart(8)}  ${label}`);
  const parts: string[] = [];
  if (io.gets || io.ranges) parts.push(`backend: ${io.gets}get/${io.ranges}range ${kib(io.getBytes)} (${fmt(io.getMs)})`);
  if (ev.decodes) parts.push(`decode: ${ev.decodes}× ${kib(ev.decodedBytes)} ${fmt(ev.decodeMs)}`);
  console.log(`            ${parts.join("  |  ")}`);
  return { ms, returned: value.length, io, ev };
}

async function runS3Point(probe: Probe): Promise<void> {
  hr("S3 — DATASET POINT (time, npoints) — array inteiro = 1 chunk");
  console.log("  Hipótese B: cada consulta baixa + descomprime o array POINT inteiro p/ 1 série.");
  console.log(`  coords: ${COORD_LAT_POINTS}/${COORD_LON_POINTS} (fallback ${COORD_LAT}/${COORD_LON} 1D) | data var: ${DATA_VAR}`);

  const ro: ReadOptions = { observability: probe.hooks, concurrency: 50 };
  const diskCacheDir = join(tmpdir(), `zarr-bench-point-${process.pid}`);

  const store = new S3Store({
    bucket: S3_BUCKET,
    prefix: S3_PREFIX,
    region: S3_REGION,
    maxSockets: 128,
    observability: probe.hooks,
  });
  await store.prewarm().catch(() => {});
  const timing = new TimingStore(store);
  const cached = new CachedStore(timing, {
    cacheDir: diskCacheDir,
    storeId: `point-${process.pid}`,
    maxSizeBytes: 1024 ** 3,
    observability: probe.hooks,
  });

  try {
    const root = await stage("openGroup (metadata)", () => openGroup(cached, "", { observability: probe.hooks }), probe, timing);

    // Coords de ponto (lat_points/lon_points), com fallback p/ lat/lon 1D.
    const latArr = (await tryGetArray2(root, COORD_LAT_POINTS)) ?? (await tryGetArray2(root, COORD_LAT));
    const lonArr = (await tryGetArray2(root, COORD_LON_POINTS)) ?? (await tryGetArray2(root, COORD_LON));
    if (!latArr || !lonArr) {
      console.log("  ⚠ sem coords de ponto (lat_points/lon_points nem lat/lon). Verifique LAT_POINTS_VAR/LON_POINTS_VAR.");
      return;
    }
    if (latArr.shape.length !== 1) {
      console.log(`  ⚠ "${COORD_LAT_POINTS}" não é 1D (shape=${JSON.stringify(latArr.shape)}). Este modo é p/ datasets POINT; use MODE=s3-serving p/ grades.`);
      return;
    }

    const latData = toFloat64(
      await stage(`coords ${COORD_LAT_POINTS} completo shape=${JSON.stringify(latArr.shape)}`, () => latArr.get(undefined, ro), probe, timing),
    );
    const lonData = toFloat64(await lonArr.get(undefined, ro));
    const n = latData.length;

    const target = Math.floor(n / 2);
    const f = findNearestPoint(latData, lonData, n, latData[target], lonData[target]);

    const dataArr = await root.getArray(DATA_VAR);
    hr();
    console.log(`  data var "${DATA_VAR}"  shape=${JSON.stringify(dataArr.shape)}  chunks=${JSON.stringify(dataArr.chunks)}  dtype=${dataArr.dtype}`);
    if (dataArr.shape.length !== 2) {
      console.log(`  ⚠ rank ${dataArr.shape.length} != 2 — este modo lê [tempo, ponto]. Para spectral/grade use outro DATA_VAR/MODE.`);
      return;
    }
    const chunkElems = (dataArr.chunks as number[]).reduce((a, b) => a * b, 1);
    console.log(`  → 1 chunk = ${chunkElems.toLocaleString()} elementos (${kib((chunkElems * 4))} se float32)`);
    hr();

    // Pass 1 — FRIO: baixa do S3 + popula disco. Pass 2 — quente disco (decode mantido).
    // Pass 3 — quente memória (decode também pulado).
    const memoryCache = new MemoryCache({ maxBytes: 512 * 1024 * 1024 });
    const sel: Slice = [null, f.k];
    const cold = await measuredRead(`Pass 1 FRIO  "${DATA_VAR}"[:, ${f.k}] (S3 + decode)`, () => dataArr.get(sel, ro), probe, timing);
    const warmDisk = await measuredRead(`Pass 2 disco "${DATA_VAR}"[:, ${f.k}] (backend=0, decode mantido)`, () => dataArr.get(sel, ro), probe, timing);
    const roMem: ReadOptions = { ...ro, memoryCache };
    await measuredRead(`Pass 3 mem 1ª "${DATA_VAR}"[:, ${f.k}] (popula MemoryCache)`, () => dataArr.get(sel, roMem), probe, timing);
    const warmMem = await measuredRead(`Pass 4 mem 2ª "${DATA_VAR}"[:, ${f.k}] (decode pulado)`, () => dataArr.get(sel, roMem), probe, timing);

    // Over-read: bytes decodificados (chunk inteiro) ÷ bytes úteis (série devolvida).
    const returnedBytes = Math.max(1, cold.returned * 4);
    const overRead = Math.round((cold.io.getBytes + cold.ev.decodedBytes) / returnedBytes);
    hr("RESULTADO — custo de 1 consulta de ponto num dataset POINT");
    console.log(`  ponto k=${f.k}/${n}  dist≈${f.dist.toFixed(2)}km  | série devolvida = ${cold.returned} valores (${kib(returnedBytes)})`);
    console.log(`  FRIO (S3+decode) ............ ${fmt(cold.ms)}   (baixou ${kib(cold.io.getBytes)}, decodificou ${kib(cold.ev.decodedBytes)})`);
    console.log(`  quente disco (só decode) .... ${fmt(warmDisk.ms)}   (decode ${kib(warmDisk.ev.decodedBytes)} — pago a CADA request sem MemoryCache)`);
    console.log(`  quente memória (nada) ....... ${fmt(warmMem.ms)}`);
    console.log(`\n  → OVER-READ RATIO = ${overRead}× — bytes movidos/decodificados por valor útil devolvido.`);
    console.log("    Ratio alto = o chunk único do dataset POINT é desproporcional ao ponto pedido.");
    console.log("    Nota: o nautilus NÃO passa MemoryCache hoje → paga o 'quente disco' (decode) por request.");
  } finally {
    await rm(diskCacheDir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  hr("zarr-node — Benchmark do fluxo + caches (local / s3 / s3-ab / s3-serving / s3-point)");
  console.log(`  MODE=${MODE}  | coord vars: ${COORD_LAT}/${COORD_LON}/${COORD_TIME}  | data var: ${DATA_VAR}`);
  console.log(`  VERBOSE=${VERBOSE}  SKIP_REDIS=${SKIP_REDIS}`);

  const probe = new Probe();

  // MODE=s3-ab: só a comparação antes/depois (rápida, janela de rede curta).
  if (MODE === "s3-ab") {
    await runS3BeforeAfter(probe);
    hr("FIM — comparação antes/depois concluída");
    return;
  }

  // MODE=s3-serving: padrão de serviço (1ª vez vs 2ª+ vez).
  if (MODE === "s3-serving") {
    await runS3Serving(probe);
    hr("FIM — padrão de serviço concluído");
    return;
  }

  // MODE=s3-point: dataset POINT (time, npoints) — over-read do chunk único.
  if (MODE === "s3-point") {
    await runS3Point(probe);
    hr("FIM — diagnóstico de dataset POINT concluído");
    return;
  }

  printCacheTaxonomy();

  const modes: Mode[] = MODE === "both" ? ["local", "s3"] : MODE === "s3" ? ["s3"] : ["local"];
  if (!["local", "s3", "both"].includes(MODE)) {
    console.log(`\n  ⚠ MODE inválido "${MODE}" — usando "local". Use MODE=local|s3|both|s3-ab.`);
  }

  for (const mode of modes) {
    await runMatrix(mode, probe);
  }

  hr("FIM — resumo das respostas acima, por etapa / config / modo");
  console.log(`
  Leitura dos contadores por etapa:
    backend: Ngets/Mrange KiB (tempo)  → I/O real no backend (cache miss).
             ATENÇÃO: tempo = SOMA das fetches concorrentes, não wall-clock.
    decode:  N× tempo                  → chunks Blosc decodificados
    cache:   mem/disk/shared  H=hits M=misses   | retries: tentativas do backend
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
