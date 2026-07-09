# feat: leitura de Zarr v3 (núcleo + sharding) mantendo a API v2

> Este documento é o **input para `/speckit.specify`**. Ele descreve *o quê* e *o porquê*
> (intenção, escopo, restrições e critérios de aceite), deixando o *como* para o `spec.md` /
> `plan.md` gerados pelo speckit. Próximo diretório de spec esperado: `specs/006-zarr-v3-reader/`.

## Resumo / intenção

`@i4sea/zarr-node` hoje lê **apenas Zarr v2** — o parser rejeita qualquer `zarr_format != 2`
(`src/metadata/v2.ts:12` e `:76`). O ecossistema (zarr-python 3.x, zarrs, TensorStore, xarray) já
grava **Zarr v3** por padrão. Precisamos **ler Zarr v3** com a **mesma API pública**
(`open` / `openArray` / `openGroup` → `ZarrArray` / `ZarrGroup`, mesmo `get(selection)`),
**detectando a versão automaticamente**, sobre os mesmos backends (FileSystem, HTTP, S3,
Reference) e **sem regressão em v2**.

Prioridade de negócio: reduzir **volume de objetos no S3** e **latência de leitura na nuvem**. Em
v2, um chunk equivale a um objeto no S3 — isso domina o custo de escrita/armazenamento (muitos
PUTs, listagens lentas) e a latência de leitura (N GETs por região lida). O **sharding codec do
v3** empacota muitos *inner-chunks* num único objeto (shard), com um índice `uint64 (offset,
nbytes)`, permitindo ler um inner-chunk por **byte-range** sem baixar o shard inteiro. Por isso o
**sharding faz parte deste escopo**, não de um trabalho futuro: é o recurso do v3 que ataca
diretamente o gargalo.

O `docs/roadmap-melhorias.md` (Tier 3, itens 9–11) já enumerou o caminho de migração v3. Esta
issue consolida esse caminho num único trabalho: **núcleo v3 + refatoração habilitante de
metadados/codecs (itens 9–10) + sharding (item 11)**.

## De onde vem (e de onde NÃO vem) o ganho de performance

Para não criar expectativa errada quando os critérios de aceite forem expandidos:

- **O ganho de performance vem essencialmente do sharding.** Menos objetos no S3 (volume de
  escrita/armazenamento) e leitura de um inner-chunk por **byte-range** em vez de N GETs (latência
  na nuvem, que é dominada pela latência por-requisição, não pela banda).
- **O núcleo v3 sozinho NÃO acelera a leitura.** Um array v3 *sem sharding* mantém o modelo de
  **1 chunk = 1 objeto** do v2 e lê na mesma velocidade. Esse trabalho existe para **conseguir ler
  os dados do ecossistema** (compatibilidade), não para acelerar. A refatoração habilitante
  (interface de metadados neutra + `CodecPipeline`) é neutra em performance.
- **`zarr-node` é read-only.** A redução de *volume de escrita* no S3 depende de quem **grava** os
  dados passar a usar sharding (ex.: zarr-python). O `zarr-node` **colhe o benefício na leitura**
  de dados já shardados — ele não reduz o volume de escrita por si só. Ou seja: o ganho só se
  materializa quando o pipeline de geração dos `.zarr` gravar v3 com sharding.

## Escopo — o que deve ser lido em v3

- **`zarr.json` único por nó** (array e group), com discriminador `node_type`, substituindo
  `.zarray` / `.zgroup` / `.zattrs`. **Detecção automática de versão** ao abrir (v2 vs v3), sem o
  consumidor precisar informar qual é.
- **`data_type` nomeados do v3** (`bool`, `int8..int64`, `uint8..uint64`, `float16/32/64` e os
  tipos comuns do domínio geoespacial) mapeados para TypedArrays; **endianness derivada do `bytes`
  codec**, não do dtype (diferente do v2, onde vem no prefixo `<`/`>`/`|`).
- **Cadeia de codecs ordenada do v3**: `array→array` (ex.: `transpose`), **exatamente um**
  `array→bytes` (`bytes` / endian) e `bytes→bytes` (`blosc`, `gzip`, `zstd`, `crc32c`), com
  **decode em ordem reversa**. Reusar os codecs numcodecs já presentes (blosc/gzip). O pipeline
  deve aplicar **toda** a cadeia — corrigindo, no caminho v3, o gap atual em que `filters` v2 são
  parseados mas nunca aplicados no decode.
- **`chunk_grid` regular** e **`chunk_key_encoding`** (o default, prefixado com `c` e separador
  configurável, e o encoding `v2`).
- **`fill_value` no formato v3** (incluindo `NaN` / `Infinity` / `-Infinity` e a forma de bytes
  para os tipos que exigem).
- **Sharding codec (`sharding_indexed`)**: ler o índice `uint64 (offset, nbytes)` do shard, tratar
  inner-chunks vazios (`2^64-1` para offset e nbytes) e ler **um inner-chunk por byte-range** via
  `store.getRange` quando disponível (fallback: baixar o shard inteiro). Deve **convergir com
  coalescência de byte-ranges adjacentes** onde fizer sentido.
- **Consolidated metadata v3** (formato aninhado do v3), lida na raiz por padrão — mesmo ganho de
  latência que já existe para v2.

### Refatoração habilitante (parte do escopo)

- **Abstrair a camada de metadados atrás de uma interface neutra de versão**, para que v2 e v3
  compartilhem o caminho de leitura (loader, indexing, cache, stores) **inalterado**.
- **Generalizar o pipeline de codecs** para a cadeia ordenada de 3 tipos, de modo que suportar v3
  seja majoritariamente configuração, não reescrita.
- **Centralizar a construção de chave de metadados / detecção de shape**, hoje montada inline em
  `src/open.ts` e `src/group.ts` (`.zarray` / `.zgroup` / `.zattrs` / `.zmetadata`).

## Fora de escopo

- **Escrita** de Zarr v3 — a biblioteca é read-only.
- Data types exóticos do v3 além dos comuns do domínio (structured/record, extensões
  não-normativas) — só se o profiling dos dados reais exigir.
- Novos backends de store — os existentes são reusados; a camada de store é agnóstica de versão
  (`src/store/store.ts`).

## Restrições de compatibilidade e performance

- **Sem regressão em v2**: todos os fixtures e testes v2 atuais continuam passando; a **assinatura
  da API pública não muda**.
- **Backends reusados**: FS / HTTP / S3 / Reference sem alteração de interface; o sharding usa o
  `getRange` opcional que o `Store` já expõe.
- **Reuso da arquitetura de performance existente**: o caminho v3 deve reusar o pool de decode
  separado do I/O, os caches LRU orçados por bytes e o fan-out limitado por concorrência.
- **Nenhuma meta numérica de throughput inventada** — mudanças de performance devem ser medidas
  localmente (fixtures grandes já existem: `large_100mb`, `large_1gb`; adicionar equivalentes v3 e
  sharded).
- **Sharding + byte-range**: para um dataset sharded no S3/HTTP, ler uma sub-região deve resultar
  em GETs por range de inner-chunks (não baixar shards inteiros) quando o store suporta `getRange`.

## Critérios de aceite (alto nível — o speckit detalha em Given/When/Then)

1. Abrir um store v3 (`zarr.json`) via `openArray` / `openGroup` retorna os mesmos tipos e o mesmo
   `get(selection)` que v2, com dados **idênticos** ao `expected.json` gerado pelo zarr-python v3.
2. Abrir um store v2 continua funcionando sem mudança (**detecção automática de versão**).
3. Um array v3 com cadeia `transpose → bytes(endian) → blosc/gzip/zstd` decodifica corretamente.
4. Um array v3 **sharded** lê uma sub-região correta e, em S3/HTTP, usa **byte-range por
   inner-chunk**.
5. Consolidated metadata v3 na raiz evita GETs por-nó, como já ocorre no v2.

## Notas de implementação (não normativas — para orientar o `plan`)

- **Ponto de fork de versão**: gate em `src/metadata/v2.ts:12` / `:76` e call sites em
  `src/open.ts` / `src/group.ts` (nomes de arquivo inline). Centralizar a detecção `zarr.json` vs
  `.zarray` / `.zgroup`.
- **Codec pipeline**: introduzir uma abstração `CodecPipeline` (cadeia ordenada, decode reverso) e
  ampliar `loadChunks` / `LoadChunksContext` (`src/chunk/loader.ts`) além de um único `Codec`
  (hoje `{ id, decode }`, decode-only, em `src/codec/codec.ts`).
- **dtype v3**: adicionar um mapa `data_type` v3 → TypedArray em paralelo ao `DTYPE_MAP` de
  `src/dtype.ts`; endianness vinda do `bytes` codec.
- **chunk key**: `chunk_key_encoding` encaixa em `chunkKey` (`src/chunk/indexing.ts`); avaliar
  mover o prefixo `basePath` (hoje inline em `src/array.ts`) para lá para unificar v2/v3.
- **Registrar codecs v3** no `codecRegistry` existente: `transpose`, `bytes`, `crc32c`,
  `sharding_indexed` (reusar blosc/gzip/zstd já disponíveis via numcodecs).
- **Fixtures**: estender `tests/fixtures/generate.py` com funções `zarr_format=3` (incluindo um
  fixture com `sharding_indexed`); reusar o harness `expected.json` + `FileSystemStore` +
  `openArray`, que é agnóstico de versão.
- **Referências normativas**: spec Zarr v3 core e sharding-indexed (links no cabeçalho de
  `docs/roadmap-melhorias.md`).
