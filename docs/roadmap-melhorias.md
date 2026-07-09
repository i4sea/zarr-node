# Roadmap de melhorias — leitor Zarr v2 (Node.js)

**Base:** pesquisa multi-fonte verificada (25/25 afirmações confirmadas 3-0 contra specs
normativas e implementações de referência) cruzada com o estado real do código em `src/`.
Fontes primárias: [spec Zarr v2](https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html),
[spec Zarr v3](https://zarr-specs.readthedocs.io/en/latest/v3/core/v3.0.html),
[sharding-indexed](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/sharding-indexed/index.html),
[zarr-python](https://zarr.readthedocs.io/en/stable/),
[zarrs](https://docs.rs/zarrs/latest/zarrs/),
[TensorStore](https://google.github.io/tensorstore/).

**Princípio de priorização:** primeiro o que retorna dado *errado* (Tier 1), depois o que
reduz latência/custo na nuvem (Tier 2), por fim o caminho v3 (Tier 3). Itens em tiers
diferentes são independentes e podem ir em PRs separados.

---

## O que já está correto (sem ação)

Práticas que a pesquisa confirma como recomendadas e que **já estão implementadas** — listadas
para o roadmap não reabrir:

- **Concorrência de CPU separada da de I/O** — pool de decode dimensionado a
  `availableParallelism()-1` (`src/codec/decode-pool.ts`), fan-out de I/O limitado por
  `concurrency` em `loadChunks`, mais um gate por orçamento de bytes. É exatamente o modelo
  zarrs/TensorStore (pool de decode limitado por núcleos, separado do fan-out de I/O).
- **Caches LRU orçados por bytes**, não por contagem de entradas (`src/cache/memory.ts`,
  `src/cache/disk.ts`). Casa com o `total_bytes_limit` do TensorStore.
- **Metadata consolidada** lida por padrão na raiz (`src/metadata/consolidated.ts`) — o maior
  ganho de latência em store de nuvem, e já existe.
- **`dimension_separator`, ordem C/F, chunks de borda parciais, GETs com byte-range**
  em FS/HTTP/S3 — todos corretos.

---

## Tier 1 — Correção (mandatório por spec; hoje retorna dado errado ou lança)

### 1. Pipeline de `filters` é parseado mas nunca aplicado  ⚠️ mais grave
**Onde:** `src/codec/codec.ts`, `src/chunk/loader.ts`. Os `filters` do `.zarray` são lidos
(`src/metadata/v2.ts:64`) e guardados, mas **nunca invocados** no decode. Qualquer array com
filtro (shuffle, delta, fixedscaleoffset, vlen) decodifica para lixo **sem erro**.
**Correção:** ligar o pipeline de filtros ao caminho de decode — aplicar filtros em ordem
reversa após a descompressão. Fundação para os itens 2 e 4 e para a cadeia de codecs v3 (item 10).
**Spec:** v2 define `filters` aplicados antes do compressor na escrita → revertidos após
descompressão na leitura.

### 2. vlen-utf8 / vlen-bytes (dtype `object`)
**Onde:** `src/dtype.ts`. Pela pesquisa, o `dtype` sozinho é insuficiente; o nome do
object-codec em `filters` desambigua `vlen-utf8` (strings) de `vlen-bytes` (bytes). Comum em
dados de rótulo/coordenada. **Depende do item 1.**
**Spec:** zarr-python — "the dtype field alone does not fully specify a data type in Zarr V2.
The name of the object codec used, if one was used, is also required."

### 3. datetime64 / timedelta64  (`<M8[ns]`, `<m8[s]`)
**Onde:** `src/dtype.ts` lança no miss do `DTYPE_MAP`. Muito comum em arrays de coordenada de
eixo temporal — provavelmente presente nos datasets i4sea.
**Correção:** parsear a forma `M8[unit]`/`m8[unit]`, apoiar em `BigInt64Array`, expor a
unidade nos metadados.
**Spec:** v2 — `M`/`m` "MUST also include the units within square brackets", ex. `<M8[ns]`.

### 4. fill_value em Base64 para byte-string / structured
**Onde:** `src/array.ts:128`. Você trata `NaN/Infinity/-Infinity` (ok) mas não a codificação
Base64-ASCII que a spec exige para fills binários. **Depende de ter um dtype que precise disso.**
**Spec:** v2 — fills de byte-string fixo e structured "MUST be encoded as an ASCII string using
the standard Base64 alphabet."

### 5. Structured dtypes  (`[[field, dtype, shape], …]`)
**Onde:** `src/metadata/v2.ts:42` trata o dtype como string opaca. Frequência menor; decidir se
o domínio precisa de record arrays antes de investir.
**Spec:** v2 — tipos structured "encoded as a list of lists ... [fieldname, datatype, shape]".

---

## Tier 2 — Performance (arquitetura já existe; estes são os próximos passos documentados)

### 6. Coalescência de byte-range requests
**Onde:** `src/array.ts:522` computa ranges por chunk de forma independente, sem batching.
Orientação Earthmover/TensorStore: fundir byte-ranges adjacentes (com `max-gap` e
`max-request-size` limitados) num único GET. Maior ganho de latência na nuvem depois da
metadata consolidada, pois o número de requisições domina no S3/HTTP.
**Atenção (pergunta em aberto):** verificar se os stores-alvo honram multi-range GET ou só
single-range — coalescer só ajuda para ranges *adjacentes* num mesmo objeto (layouts
contíguos / sharding). Converge com o item 11.

### 7. Unificar a concorrência sob um alvo global
A pesquisa aponta que o zarrs amarra a concorrência de codec à de chunk contra um *único* alvo
(`chunk_concurrent_minimum=4`, alvo de codec = núcleos) em vez de dois pools independentes.
Hoje os seus são independentes. Ganho de tuning de baixo esforço; **medir antes/depois** — a
pergunta em aberto observa que o custo de IPC do worker no Node (structuredClone / transfer de
ArrayBuffer) pode mover o teto ótimo para baixo de `os.cpus()`.

### 8. Cache de partial-decoder para subsets repetidos no mesmo chunk
O zarrs faz cache do chunk inteiro decodificado quando se lê múltiplos subsets de um chunk,
evitando re-descomprimir. Só vale se o profiling mostrar leituras repetidas do mesmo chunk.
**Spec:** zarrs — "prefer to initialise a partial decoder ... The underlying codec chain will
use a cache where efficient."

---

## Tier 3 — Caminho de migração v3 (futuro, não urgente)

Hoje o leitor é v2-only de forma limpa (`src/metadata/v2.ts:12` rejeita `zarr_format != 2`). A
pesquisa fornece o formato exato da migração para já desenhar pensando nele.

### 9. Abstrair a camada de metadata atrás de uma interface neutra de versão
Antes de adicionar v3. O remapeamento v2→v3 está totalmente enumerado:
`dtype→data_type`, `chunks→chunk_grid`, `dimension_separator→chunk_key_encoding`,
`order→codec transpose`, `filters`+`compressor`→`codecs` único. Um único `zarr.json` por nó
substitui `.zarray`/`.zattrs`/`.zgroup`.

### 10. Generalizar o pipeline de codecs para a cadeia ordenada de 3 tipos do v3
`array→array`, `array→bytes`, `bytes→bytes`; decode em ordem reversa; exatamente um
`array→bytes`. Fazer o item 1 (pipeline de filtros) já com esse formato em mente torna o v3
majoritariamente config, não reescrita. Endianness migra para o bytes codec no v3.

### 11. Sharding codec
Índice uint64 (offset, nbytes) permite leitura por range de um único inner-chunk. É onde o
item 6 (coalescência) e o caminho v3 convergem: o índice de sharding é *desenhado* para GETs
por range coalescidos. Se for fazer v3, sharding + coalescência devem ser desenhados juntos.
**Spec:** v3 sharding-indexed — chunks vazios usam `2^64-1` para offset e nbytes; com suporte a
partial-read "single inner chunks can be requested from the store by specifying the byte range."

---

## Sequenciamento sugerido

1. **Item 1 (pipeline de filtros)** — é bug de correção *e* fundação para 2/4 e a cadeia de
   codecs v3 (item 10).
2. **Item 3 (datetime)** — provavelmente atinge dados reais.
3. **Item 6 (coalescência)** — ganho de performance de maior destaque na nuvem.
4. **V3 (itens 9–11)** — quando a pressão do ecossistema chegar; a arquitetura já está perto.

## Ressalvas da pesquisa

- **Nenhum número de throughput foi verificado** — medir mudanças de performance localmente
  (itens 6, 7, 8).
- O contraste com leitores JS (zarrita.js / zarr.js) foi **inferencial**, não verificado em
  nível de código-fonte.
- A substituição `null fill → 0` é específica do TensorStore, **não** mandatória por spec (a
  spec deixa o conteúdo de fill nulo indefinido).
- Metadata consolidada pode ficar **stale** (sem invalidação) — aceitável para dados
  read-only de mudança lenta, que é o caso de uso aqui.
