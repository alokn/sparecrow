# Contributing to sparecrow

Thank you for your interest in contributing! This document explains how the project is structured and how to get your changes merged.

## Mirror architecture

This repository is a public mirror of an internal development repo. What that means for contributors:

- **PRs are welcome here** — open them against `main` as normal
- **Merged PRs are synced** back into the internal repo, which then pushes a filtered version back to this repo
- **The public history is periodically rewritten** when the internal repo syncs — if you have a local fork you will need to rebase onto the updated `main` after a sync:
  ```bash
  git fetch upstream
  git rebase upstream/main
  ```
- There is no difference in the source code between the two repos — only internal planning and tooling files are excluded from this mirror

## Development setup

**Prerequisites:** Node.js 22+, npm

```bash
git clone https://github.com/alokn/sparecrow.git
cd sparecrow
npm install
```

**Verify everything works:**

```bash
npm run typecheck   # type check
npm run lint        # lint
npm test            # unit tests + coverage
```

**Key commands:**

| Command | Description |
|---------|-------------|
| `npm run dev` | Run without building (uses tsx) |
| `npm run build` | Compile to `dist/` |
| `npm test` | Unit tests + coverage report |
| `npm run test:watch` | Watch mode |
| `npm run test:e2e` | End-to-end tests |
| `npm run lint` | oxlint (fast) |
| `npm run format` | prettier |
| `npm run typecheck` | tsc --noEmit |

## Project structure

```
src/
  types/      shared type definitions
  errors/     typed error classes
  utils/      retry, logger, fs helpers
  config/     config schema and loading
  templates/  built-in prompt templates
  platform/   OS paths and environment
  providers/  usage data sources
  trigger/    condition evaluation engine
  queue/      task queue management
  daemon/     polling loop and lifecycle
  cli/        commander commands
  ui/         ink/chalk rendering
```

Module imports flow strictly downward (`types → errors → utils → … → cli/ui`). Lower modules never import from higher ones.

## Coding conventions

See `CLAUDE.md` for full conventions. Key points:

- **TypeScript strict mode** — no `any`, use `unknown` and narrow with type guards
- **ESM imports** with `.js` extension: `import { Foo } from './foo/index.js'`
- **Error handling** — throw `ScrowError` with a typed `ErrorCode`, never plain `Error`
- **No `console.log`** — use the structured logger in `src/utils/logger.ts`
- **Tests co-located** with source files (`foo.test.ts` next to `foo.ts`)
- **70% minimum coverage** — lines, branches, functions, statements

## Submitting a pull request

1. **Fork** this repo and create a branch from `main`
2. **Make your changes** — keep commits focused and descriptive
3. **Add tests** for any new behaviour
4. **Run the full check suite** before opening the PR:
   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test
   ```
5. **Open a PR** against `main` with a clear description of what the change does and why

PRs that pass CI and follow the conventions above will be reviewed promptly.

## Reporting bugs

Open a GitHub issue with:
- sparecrow version (`sparecrow --version`)
- OS and Node.js version
- Steps to reproduce
- Expected vs actual behaviour

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior as described in the Code of Conduct.

## Questions

Open a GitHub Discussion or issue — happy to help.
