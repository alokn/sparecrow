# CLAUDE.md — AI Agent Instructions for sparecrow

## 1. Project Overview

`sparecrow` (CLI binary: `sparecrow`, short alias: `scrow`) is a CLI tool and background daemon that monitors Claude Code subscription usage and automatically dispatches queued tasks against your repositories when surplus capacity is detected.

It authenticates via the Claude Code OAuth token, polls usage metrics, and executes pre-configured or user-defined prompts against git repositories using `claude` when capacity thresholds are met.

## 2. Module Dependency DAG

Import direction is strictly enforced (lower → higher only):

```
types → errors → utils → config → templates → platform → providers → trigger → queue → daemon → cli/ui
```

- `src/types/` — shared type definitions used across all modules
- `src/errors/` — typed error classes; imports only from `types`
- `src/utils/` — shared utilities (retry, logger, fs helpers); imports from `types`, `errors`
- `src/config/` — config schema and loading; imports from `types`, `errors`
- `src/templates/` — template schema, built-in loader, resolver; imports up to `config`
- `src/platform/` — OS paths, environment; imports from `types`, `errors`
- `src/providers/` — usage data sources (Claude Code OAuth); imports up to `platform`
- `src/trigger/` — condition evaluation engine; imports up to `providers`
- `src/queue/` — task queue management; imports up to `trigger`
- `src/daemon/` — polling loop and lifecycle; imports up to `queue`
- `src/cli/` — Commander commands; imports everything
- `src/ui/` — Ink/chalk rendering components; imports from `types`, `errors`

**Rule:** Lower modules NEVER import from higher ones. Move any type needed by a lower module to `src/types/`.

## 3. Naming Conventions

- **Files:** `kebab-case.ts` (e.g., `trigger-engine.ts`)
- **Functions/variables:** `camelCase`
- **Types/interfaces:** `PascalCase`
- **Constants:** `UPPER_SNAKE_CASE`
- **Config YAML keys:** `snake_case` (mapped to camelCase via zod transform)
- **File header:** Every `.ts` file starts with a single-line JSDoc: `/** Purpose of this file. */`

## 4. Structure Rules

- **Barrel exports** for cross-module imports: always `import from 'module/index.js'`
- **Direct imports** within a module (no barrel needed)
- **Unit tests co-located:** `src/trigger/trigger-engine.test.ts` alongside `trigger-engine.ts`
- **Integration tests** in `tests/integration/`
- **All TypeScript imports** use `.js` extension (NodeNext ESM convention):
  ```typescript
  // CORRECT
  import { ScrowError } from './errors/index.js';
  // WRONG
  import { ScrowError } from './errors/index';
  ```

## 5. Anti-Patterns (Forbidden)

- `any` type in production code — use `unknown` and narrow with type guards
- Relative imports crossing module boundaries (`../../other-module/internal`) — use barrel imports
- `console.log` for output — use structured logger in `src/utils/logger.ts`
- Synchronous filesystem operations in the daemon polling loop
- Hardcoded paths — always use `env-paths` package for platform-appropriate paths
- Swallowing errors without logging — always log before discarding
- Optional top-level fields in JSON output or audit records — all fields must always be present
- Tests with shared mutable state or ordering dependencies — each test must be fully isolated
- Logging tokens, credentials, or secrets at any log level (NFR: security requirement)

## 6. Testing Conventions

- `describe` block name matches the module/function name
- `it` descriptions start with a verb, no "should" prefix (e.g., `it('returns empty array when...')`)
- Every test is isolated with `beforeEach`/`afterEach` — no shared mutable state
- Temporary directories and files must be cleaned up in `afterEach`
- Mock external I/O (filesystem, network, process) at test boundaries
- Mock return values must reflect production reality — if a dependency returns `null` in production (e.g. `getConfigPath()` when no `--config` flag is passed), at least one test must mock it returning `null` to exercise the fallback branch. Mocks that always return a non-null value silently skip `?? fallback` paths and hide bugs in those branches.
- Minimum 70% coverage for lines, branches, functions, statements

## 7. Error Handling

- Always throw `ScrowError` with a typed `ErrorCode` — never throw plain `Error` or strings
- `ScrowError` is defined in `src/errors/` and exported from `src/errors/index.js`
- Catch at CLI command boundaries and at the daemon top-level loop only
- Errors propagate upward through typed `Result<T>` or thrown `ScrowError` — no silent failures
- Never expose raw stack traces to end users in production output

## 8. Data Format Rules

- **JSON CLI output:** `{ ok: boolean, data: T | null, error: { code, message } | null }` — all three top-level fields always present
- **JSONL audit records:** exactly 8 top-level fields always present (ts, level, event, data, provider, source, confidence, error)
- **Dates:** ISO 8601 strings everywhere (e.g., `2026-02-23T10:00:00.000Z`)
- **Config YAML:** snake_case keys, zod-transformed to camelCase in application

## 9. Build & Run Commands

```bash
npm run dev        # tsx src/index.ts (development, no build step)
npm run build      # tsup → dist/ (production ESM bundle with shebang)
npm test           # vitest run --coverage (unit tests + coverage report)
npm run test:watch # vitest (watch mode)
npm run test:integration  # vitest run --config vitest.integration.config.ts
npm run lint       # oxlint src/ (Rust-based linter, fast)
npm run format     # prettier --write src/
npm run format:check  # prettier --check src/ (CI-safe)
npm run typecheck  # tsc --noEmit (type checking without emit)
```

**Agent test execution rules:**
- Always run `NO_COLOR=1 npm test 2>&1 | tail -30` — `NO_COLOR=1` disables ANSI color codes (vitest v4 ignores `CI=true` for colors), making output reliably grep-friendly. The summary is always at the end.
- To check a specific file: `NO_COLOR=1 npm test -- path/to/file.test.ts 2>&1 | tail -20`
- To investigate failures: `NO_COLOR=1 npm test -- path/to/failing.test.ts --reporter=verbose 2>&1 | tail -40`
- Summary lines always end with: `Test Files: N passed (N)` and `Tests: N passed (N)`
- **NEVER re-run a test command just to try a different grep/tail pattern.** Capture enough output on the first run (use `tail -30` or `tail -40`). If you need more detail, run only the specific failing file with `--reporter=verbose`, not the full suite again.

Binary entrypoints after build:
- `sparecrow` → `./dist/index.js`
- `scrow` → `./dist/index.js`

## 10. Runtime State Paths

All paths are resolved via the `env-paths` package — never hardcode:

| Platform | Config | State/Data |
|----------|--------|------------|
| Linux    | `~/.config/sparecrow/config.yaml` | `~/.local/state/sparecrow/` |
| macOS    | `~/Library/Application Support/sparecrow/config.yaml` | `~/Library/Application Support/sparecrow/` |

State directory contents:
- `daemon.pid` — daemon PID file (Linux/macOS)
- `daemon-status.json` — last known daemon state (for CLI reads without daemon RPC)
- `queue.json` — persisted task queue
- `last-summary.json` — most recent execution summary for `sparecrow report`
- `logs/audit-YYYY-MM-DD.jsonl` — daily-rotated append-only audit logs (30-day default retention)
