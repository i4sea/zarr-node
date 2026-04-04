# Contributing to zarr-node

Thanks for your interest in contributing! This guide covers development setup, conventions, and the PR process.

## Development Setup

```bash
git clone https://github.com/i4sea/zarr-node.git
cd zarr-node
npm install
```

### Requirements

- Node.js >= 22
- npm

## Scripts

| Command               | Description                        |
| --------------------- | ---------------------------------- |
| `npm test`            | Run all tests                      |
| `npm run test:watch`  | Run tests in watch mode            |
| `npm run typecheck`   | Type-check without emitting        |
| `npm run lint`        | Lint `src/` and `tests/`           |
| `npm run format`      | Format code with Prettier          |
| `npm run format:check`| Check formatting                   |
| `npm run build`       | Compile TypeScript to `dist/`      |

## Code Style

- TypeScript with `strict: true`, targeting ES2022
- Formatting enforced by Prettier (2-space indent, no semicolons by default)
- Linting via ESLint with typescript-eslint

Run `npm run format && npm run lint` before committing.

## Project Structure

```
src/
  array.ts          # ZarrArray — the main read API
  group.ts          # ZarrGroup — group traversal and multi-array reads
  dataset.ts        # Dataset — xarray-style label-based selection
  index.ts          # Public exports
  store/            # Storage backends (FS, HTTP, S3, Reference)
  cache/            # Disk and memory chunk caches
  chunk/            # Chunk loading and byte-range logic
  codec/            # Decompression (zlib, Blosc, etc.)
  metadata/         # .zarray, .zattrs, .zmetadata, reference-spec parsers
  coordinates.ts    # Coordinate lookup (nearest-neighbor)
tests/
  unit/             # Fast, isolated tests
  integration/      # Tests with real fixtures and stores
  fixtures/         # Zarr arrays on disk for testing
```

## Tests

We use [Vitest](https://vitest.dev/). Tests live alongside the code they cover:

- `tests/unit/` — pure logic, no I/O
- `tests/integration/` — reads from fixtures in `tests/fixtures/`

All new features must include tests. Run the full suite before submitting a PR:

```bash
npm test
```

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes with tests
3. Ensure `npm test && npm run lint` passes
4. Open a PR with a clear description of what and why
5. A maintainer will review and may request changes

## Reporting Issues

Use [GitHub Issues](https://github.com/i4sea/zarr-node/issues). For security issues, see [SECURITY.md](SECURITY.md).
