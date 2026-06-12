# Plano: reduzir latência de leitura no S3

**Princípio:** o gargalo é o round-trip por requisição (~127 ms a partir do Brasil para
us-east-1). Os itens **1** e **3** reduzem o custo por round-trip e o número de ondas;
o item **2** elimina round-trips recorrentes (a grade é estática). Os três são
independentes e podem ir em PRs separados.

## Diagnóstico (medido)

- RTT de rede Brasil → us-east-1: **~127 ms** (ping). Piso físico de cada requisição S3.
- No benchmark, carregar `lat` somou ~40 s em 120 GETs = **~330 ms/GET** (127 ms de RTT +
  TLS handshake em sockets novos + assinatura). Paralelizado em 50, deu ~1 s de wall-clock.
- Metadata = ~850 ms porque são **2 GETs sequenciais** (`.zgroup` depois `.zmetadata`) com
  conexão fria.
- Conclusão: quase todo o "tempo do S3" é distância geográfica, não a biblioteca. Tudo que
  reduz (a) número de round-trips ou (b) distância ganha proporcionalmente.

## Fatos técnicos que embasam o plano

- AWS SDK `3.1024.0`. `NodeHttpHandler` **não** é exportado por `@aws-sdk/client-s3`, mas
  está em `@smithy/node-http-handler` (já presente como dependência transitiva).
  `new NodeHttpHandler({ httpsAgent: new https.Agent({ maxSockets, keepAlive }) })`
  funciona ✓ (verificado).
- Default do SDK: `maxSockets ≈ 50`, `keepAlive: true`. Hoje o `S3Store` usa o handler padrão
  (não configura nada) → teto de 50 conexões, casando com `concurrency=50`, o que força
  ~3 ondas num read de 120 chunks.
- `S3Store.getObject` já memoiza o client (`clientPromise`) e tem retry próprio
  (`maxAttempts: 1` no SDK).

---

## Item 1 — `S3Store`: expor `maxSockets` / keep-alive / `requestHandler`

**Objetivo:** permitir reads mais largos que 50 conexões (colapsar as ondas) e garantir
reuso de conexão TLS.

### 1.1 `src/store/store.ts` — estender `S3StoreOptions`

```ts
export interface S3StoreOptions {
  // ...existentes...
  /** Máx. de conexões TCP simultâneas no pool (https.Agent). Default: 128. */
  maxSockets?: number;
  /** Reusar conexões (keep-alive). Default: true. */
  keepAlive?: boolean;
  /** Timeout de estabelecimento de conexão, ms. Default: 3000. */
  connectionTimeoutMs?: number;
  /** Escape hatch: handler já configurado (ignora maxSockets/keepAlive). */
  requestHandler?: unknown;
}
```

### 1.2 `src/store/s3.ts` — `createClient()`

- Se `options.requestHandler` foi passado → usar direto.
- Senão, construir handler com `https.Agent`:

```ts
const { NodeHttpHandler } = await import("@smithy/node-http-handler");
const { Agent } = await import("node:https");
const agent = new Agent({ keepAlive: this.keepAlive, maxSockets: this.maxSockets });
return new sdk.S3Client({
  region: this.region,
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({
    httpsAgent: agent,
    connectionTimeout: this.connectionTimeoutMs,
  }),
  ...endpointCfg,
});
```

- **Degradação graciosa:** envolver o `import("@smithy/node-http-handler")` em try/catch; se
  falhar, `console.warn` + cair no client padrão (não quebra quem não tem o módulo). Como
  `@aws-sdk/client-s3` sempre traz o `@smithy/node-http-handler`, na prática nunca falha.

### 1.3 Defaults e interação com `concurrency` — DECIDIDO (opção A)

- **Default `maxSockets: 128`, `keepAlive: true`** (estritamente melhor para leitura de muitos
  chunks; risco desprezível). Default-on, não opt-in.
- `ReadOptions.concurrency` permanece **50** por padrão (não surpreender ninguém com 128 GETs
  simultâneos). O teto de 128 sockets existe para que quem precisar de reads grandes possa
  subir `concurrency` sem esbarrar no pool.
- Documentar a regra: **`maxSockets` ≥ `ReadOptions.concurrency`**. Opcionalmente logar um
  `console.warn` único se `concurrency > maxSockets` (fica como nota, talvez fora do v1).

### 1.4 `package.json`

- Declarar `@smithy/node-http-handler` como `optionalDependencies` (ou peer opcional), para
  tornar explícita a dependência que passamos a importar.

### 1.5 Testes (`tests/unit/s3-store.test.ts`, novo)

- Construir `S3Store({ maxSockets: 200 })`, acessar o client e asserir
  `requestHandler instanceof NodeHttpHandler` e `agent.maxSockets === 200`. Sem rede (só
  inspeção de config). Precisa de um acessor de teste ou inspecionar via
  `(store as any).getClient()`.

---

## Item 2 — `GridIndex`: resolver i/j uma vez e cachear a grade

**Objetivo:** parar de rebaixar lat/lon (~1.6 s no S3) a cada lookup. A grade é imutável por
dataset → carrega/decodifica **uma vez**, consulta N vezes, e pode ser **persistida**
(Redis/disco) para um pod novo rehidratar sem tocar no S3.

### 2.1 Novo módulo `src/spatial/grid-index.ts`

```ts
export class GridIndex {
  readonly ny: number; readonly nx: number;
  private constructor(lat: Float32Array, lon: Float32Array, ny: number, nx: number);

  /** Constrói a partir de arrays já decodificados (sync). */
  static fromCoordinates(lat: Float32Array, lon: Float32Array, ny: number, nx: number): GridIndex;

  /** Conveniência: carrega lat/lon do grupo UMA vez (usa cache de leitura se passado). */
  static async fromGroup(group: ZarrGroup, opts?: {
    latName?: string;  // default "lat"
    lonName?: string;  // default "lon"
    readOptions?: ReadOptions;
  }): Promise<GridIndex>;

  /** Vizinho mais próximo. Equiretangular (correto p/ grade regional). */
  nearest(lat: number, lon: number): { i: number; j: number; distanceKm: number };
  nearestMany(points: Array<[number, number]>): Array<{ i: number; j: number; distanceKm: number }>;

  /** Persistência cross-pod: snapshot BINÁRIO cru (header ny/nx + lat + lon). */
  toBytes(): Uint8Array;
  static fromBytes(buf: Uint8Array): GridIndex;
}
```

> **Formato binário, não base64.** O snapshot é `header(ny,nx) + lat(f4) + lon(f4)` ≈ 3.6 MB
> para a grade WRF 3km. `ioredis` aceita `Buffer` direto — base64 inflaria ~33% à toa.

### 2.2 Algoritmo

- **v1: varredura linear** equiretangular com correção `cos(lat)` (validada: ~3 ms em 458k
  pontos; correta para grade regional WRF). Simples e sem dependências.
- **Follow-up opcional:** KD-tree em coordenadas ECEF (xyz) para O(log n) — só compensa com
  muitas consultas ou grade global. Deixar atrás de `{ algorithm: "linear" | "kdtree" }`,
  fora do v1.

### 2.3 Padrão de uso — cache em camadas L1 → L2 → L3 (o ganho real)

O objetivo é **desacoplar o custo (~1.6 s + 240 GETs) do ciclo de vida do pod**. Em k8s pods
reiniciam o tempo todo (rollout, autoscaling, OOM, drain), e memória/disco local não
sobrevivem ao restart → cada pod repaga o S3. Redis resolve: só o primeiro pod paga.

- **L1 — memória do processo:** `GridIndex` construído no startup; lookups viram CPU puro.
  Perde no restart.
- **L2 — Redis (compartilhado, sobrevive a restart):** no startup o pod tenta
  `cache.get(gridKey)`; hit → `GridIndex.fromBytes(...)` (rehidrata em ms); miss → monta do
  S3 (L3) e `cache.set(gridKey, index.toBytes())`. **Só o primeiro pod paga o S3**; todos os
  demais (novos/reiniciados/escalados) leem ~3.6 MB do Redis. Reusa o `RedisCache` existente
  (não precisa de Redis novo).
- **L3 — S3:** só no cold start global (cache vazio).

**Chave do Redis — ponto crítico:** chavear por **domínio/grid**, NÃO pelo `storeId` do run.
Se a chave incluir o caminho do run (`.../2026051212/...zarr`), cada novo forecast vira miss
e repaga o S3. Como a lat/lon do WRF 3km/sse é **idêntica entre runs** (o domínio não muda),
a chave deve agrupar todos os runs do mesmo domínio.

#### O que é um "domínio"

A **geometria da grade lat/lon** (a malha de pontos). Fixa para uma configuração de modelo;
muda só com **área, resolução ou projeção** — não a cada forecast. Dois datasets são o mesmo
domínio sse, e só se, suas arrays lat/lon forem idênticas ponto a ponto.

As attrs do root do dataset já separam o que é fixo do que muda por run:

```
"source_model": "WRF"          ← identidade do domínio
"experiment":   "sse002"       ← identidade do domínio
"grid_id":      "1"            ← identidade do domínio
"run_time":     "2026051212"   ← MUDA por run → EXCLUIR
"conversion_timestamp", "converter_version" ← MUDA por run → EXCLUIR
"data_type":    "deterministic" ← NÃO incluir (ensemble usa a mesma grade física)
```

#### Como derivar a chave — 3 níveis

- **Nível 1 — default recomendado: derivar do `.zmetadata` (ZERO GET extra).** Tudo já está
  no `.zmetadata` que o pod carrega ao abrir o grupo:
  ```
  gridKey = hash( source_model + experiment + grid_id
                + lat.shape + lon.shape + chunks + dtype )
          // ex. legível: "WRF-sse002-grid1-761x602"
  ```
  `shape/chunks/dtype` distinguem resoluções (wrf3km vs wrf9km). `run_time` excluído → todos
  os runs do domínio compartilham a grade. Custo: 0 requisições extras → cold start barato.

- **Nível 2 — override explícito.** Caller passa `gridKey: "wrf3km-sse1"` quando conhece a
  topologia. Máximo controle.

- **Nível 3 — fingerprint de conteúdo (flag `verifyGrid: true`, +2 GETs baratos).** Inclui na
  chave o hash do **chunk de canto** de lat e lon (chunk `0.0`, ~64×64 floats cada = 2 GETs
  vs os 240 da grade inteira). Auto-validante: se as coordenadas reais mudarem, a chave muda
  sozinha; funde automaticamente grades idênticas. Para quem não confia 100% nas attrs.

**Decisão: Nível 1 como default + Nível 2 como override; Nível 3 atrás de flag.** Nível 1 é
grátis, legível e correto na prática (pior caso = duplicar uma entrada de 3.6 MB; nunca
incorreto).

**Quando L2 não vale:** apenas se houver 1-2 pods longevos que quase nunca reiniciam — aí o
L1 basta. Como o cenário é de pods efêmeros e o Redis já está no fluxo (cache de metadata),
o L2 é a escolha certa.

### 2.4 Export e escopo — DECIDIDO (subpath `/spatial`)

- Shipado como **subpath export `@i4sea/zarr-node/spatial`** (mesmo padrão do `/redis`),
  mantendo o core limpo e ainda entregando reuso entre serviços.
- Estrutura: módulo em `src/spatial/grid-index.ts`, entrypoint `src/spatial/index.ts`.
- `package.json` → adicionar ao bloco `exports`:
  ```jsonc
  "./spatial": {
    "types": "./dist/spatial/index.d.ts",
    "import": "./dist/spatial/index.js",
    "require": "./dist/cjs/spatial/index.js",
    "default": "./dist/spatial/index.js"
  }
  ```
- `scripts/validate-exports.mjs` e `scripts/postbuild-cjs.mjs` já cobrem subpaths (o `/redis`
  é o precedente) — confirmar que o `/spatial` entra na mesma lista.
- Sem dependências novas (usa só `ZarrGroup`/`ReadOptions` + a interface `Cache` para o L2).

### 2.5 Testes (`tests/unit/grid-index.test.ts`)

- Grade sintética conhecida → `nearest` recupera índices esperados (incl. o ponto exato).
- Round-trip `toBytes`/`fromBytes` preserva resultados (e `nearest` idêntico após rehidratar).
- `fromGroup` com fixture pequena (criar fixture 2D lat/lon em `tests/fixtures/`).

---

## Item 3 — Pré-aquecimento de conexão (`prewarm`)

**Objetivo:** o 1º GET real não pagar o TLS handshake (~1 RTT extra) — abrir a conexão no
pool antes.

### 3.1 `src/store/s3.ts` — método público

```ts
/** Estabelece o client e abre 1 conexão TLS no pool. Best-effort (engole erros). */
async prewarm(): Promise<void> {
  try {
    const client = await this.getClient();
    const sdk = await loadS3SDK();
    await client.send(
      new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.resolveKey(".zmetadata") }),
      { abortSignal: AbortSignal.timeout(this.timeout) },
    );
  } catch {
    /* 404/erro de conexão são irrelevantes — só queríamos o handshake */
  }
}
```

- Usa `.zmetadata` (existe em datasets consolidados) como alvo do HEAD; se ausente, o
  handshake já aconteceu mesmo com 404.

### 3.2 Opção `warmOnCreate?: boolean`

- Se `true`, dispara `void this.prewarm().catch(() => {})` ao construir (fire-and-forget, sem
  unhandled rejection). Default `false` (explícito é mais previsível).
- Documentar o padrão no startup do pod:
  `const store = new S3Store({...}); await store.prewarm();`.

### 3.3 Simetria (nota)

- `HTTPStore` poderia ter `prewarm()` equivalente (1 HEAD). Fora do v1; mencionar.

### 3.4 Testes

- `prewarm()` não lança quando a chave/o bucket não existe (mock do client).

---

## Cross-cutting

- **Benchmark:** estender o modo `s3` de `examples/benchmark-local-flow.ts` com uma **CONFIG
  extra** que combina `maxSockets: 128` + `prewarm()` + `GridIndex` (lookup sem refetch),
  para medir o ganho real lado a lado com o baseline atual.
- **Docs:** README (seção S3 e nova seção "Spatial lookups") + CHANGELOG. Commits
  convencionais, sem trailer de IA (regra do CLAUDE.md).
- **Sem regressões:** itens 1 e 3 são puramente aditivos (defaults preservam ou melhoram o
  comportamento); item 2 é módulo novo.

## Entrega — PR único (DECIDIDO)

Um único PR cobrindo os 3 itens. Título sugerido: `perf: S3 latency reduction
(connection pooling, prewarm, GridIndex)`. Ordem interna de commits para revisão incremental:

1. **Item 1** (~½ dia) — `maxSockets`/keep-alive no `S3Store`; valida ondas no benchmark.
2. **Item 3** (~2 h) — `prewarm()`; complementa o 1 (mesmo arquivo `s3.ts`).
3. **Item 2** (~1 dia, + fixture/testes) — módulo `/spatial` com `GridIndex` (L1+L2).

## Decisões tomadas

1. **`maxSockets`:** ✅ **Opção A** — default-on em **128 + keepAlive**; `concurrency`
   permanece 50 (ver §1.3).
2. **`GridIndex`:**
   - **2a** ✅ subpath export **`@i4sea/zarr-node/spatial`** (ver §2.4).
   - **2b** ✅ cache em camadas **L1 (memória) + L2 (Redis)** já no v1 (ver §2.3).
   - Chave do Redis: ✅ Nível 1 derivado do `.zmetadata` por domínio + override explícito;
     Nível 3 (`verifyGrid`) atrás de flag (ver §2.3).
3. **Estrutura de entrega:** ✅ **PR único** (ver acima).
