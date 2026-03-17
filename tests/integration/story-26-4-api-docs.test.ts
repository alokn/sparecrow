/** Integration tests for story 26.4 — API documentation generation. */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Root of the repository (two levels up from tests/integration/)
const REPO_ROOT = join(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// typedoc.json — configuration correctness
// ---------------------------------------------------------------------------

describe('typedoc.json configuration', () => {
  let config: Record<string, unknown>;

  beforeAll(async () => {
    const raw = await readFile(join(REPO_ROOT, 'typedoc.json'), 'utf8');
    config = JSON.parse(raw) as Record<string, unknown>;
  });

  it('has a $schema field', () => {
    expect(typeof config['$schema']).toBe('string');
    expect(config['$schema']).toContain('typedoc.org');
  });

  it('sets output directory to docs/api', () => {
    expect(config['out']).toBe('docs/api');
  });

  it('has entryPoints array with all barrel-exported modules including cli and ui', () => {
    const entryPoints = config['entryPoints'] as string[];
    expect(Array.isArray(entryPoints)).toBe(true);
    const expectedModules = [
      'src/types/index.ts',
      'src/errors/index.ts',
      'src/config/index.ts',
      'src/queue/index.ts',
      'src/templates/index.ts',
      'src/providers/index.ts',
      'src/trigger/index.ts',
      'src/daemon/index.ts',
      'src/platform/index.ts',
      'src/utils/index.ts',
      'src/cli/index.ts',
      'src/ui/index.ts',
    ];
    for (const ep of expectedModules) {
      expect(entryPoints).toContain(ep);
    }
  });

  it('sets entryPointStrategy to resolve for barrel entry points', () => {
    expect(config['entryPointStrategy']).toBe('resolve');
  });

  it('excludes private members', () => {
    expect(config['excludePrivate']).toBe(true);
  });

  it('excludes protected members', () => {
    expect(config['excludeProtected']).toBe(true);
  });

  it('excludes internal members', () => {
    expect(config['excludeInternal']).toBe(true);
  });

  it('has skipErrorChecking enabled', () => {
    expect(config['skipErrorChecking']).toBe(true);
  });

  it('points tsconfig to tsconfig.json', () => {
    expect(config['tsconfig']).toBe('tsconfig.json');
  });

  it('has cleanOutputDir enabled to prevent stale HTML accumulation', () => {
    expect(config['cleanOutputDir']).toBe(true);
  });

  it('uses README.md for the TypeDoc homepage', () => {
    expect(config['readme']).toBe('README.md');
  });

  it('all referenced entryPoint files exist on disk', () => {
    const entryPoints = config['entryPoints'] as string[];
    for (const ep of entryPoints) {
      const fullPath = join(REPO_ROOT, ep);
      expect(existsSync(fullPath), `Expected entry point to exist: ${ep}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// package.json — docs script and typedoc devDependency
// ---------------------------------------------------------------------------

describe('package.json docs setup', () => {
  let pkg: Record<string, unknown>;

  beforeAll(async () => {
    const raw = await readFile(join(REPO_ROOT, 'package.json'), 'utf8');
    pkg = JSON.parse(raw) as Record<string, unknown>;
  });

  it('has a docs script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(typeof scripts['docs']).toBe('string');
  });

  it('docs script invokes typedoc', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['docs']).toContain('typedoc');
  });

  it('has typedoc as a devDependency', () => {
    const devDeps = pkg['devDependencies'] as Record<string, string>;
    expect(typeof devDeps['typedoc']).toBe('string');
    expect(devDeps['typedoc']).toMatch(/^\^?\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// .gitignore — docs/api/ excluded
// ---------------------------------------------------------------------------

describe('.gitignore docs/api exclusion', () => {
  let gitignoreContent: string;

  beforeAll(async () => {
    gitignoreContent = await readFile(join(REPO_ROOT, '.gitignore'), 'utf8');
  });

  it('contains docs/api/ entry', () => {
    const lines = gitignoreContent.split('\n').map((l) => l.trim());
    expect(lines).toContain('docs/api/');
  });
});

// ---------------------------------------------------------------------------
// JSDoc comments on key exported types
// ---------------------------------------------------------------------------

describe('ScrowError JSDoc comments', () => {
  let sourceContent: string;

  beforeAll(async () => {
    sourceContent = await readFile(join(REPO_ROOT, 'src/errors/scrow-error.ts'), 'utf8');
  });

  it('has a class-level JSDoc block', () => {
    // Must have a /** ... */ block before the class declaration
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export class ScrowError/);
  });

  it('documents the code parameter', () => {
    expect(sourceContent).toContain('@param code');
  });

  it('documents the message parameter', () => {
    expect(sourceContent).toContain('@param message');
  });

  it('has an @example tag', () => {
    expect(sourceContent).toContain('@example');
  });

  it('references ErrorCodeValue in JSDoc', () => {
    expect(sourceContent).toMatch(/ErrorCodeValue/);
  });
});

describe('ScrowConfig JSDoc comments', () => {
  let sourceContent: string;

  beforeAll(async () => {
    sourceContent = await readFile(join(REPO_ROOT, 'src/types/config.ts'), 'utf8');
  });

  it('has an interface-level JSDoc block for ScrowConfig', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export interface ScrowConfig/);
  });

  it('documents pollingInterval field with seconds description', () => {
    // Field-level JSDoc mentions "seconds" (the unit for polling interval)
    expect(sourceContent).toMatch(/\/\*\*[^*]*seconds[^*]*\*\//i);
  });

  it('has logRetentionDays field documented', () => {
    // Field-level JSDoc mentions "days" for log retention
    expect(sourceContent).toMatch(/\/\*\*[^*]*days[^*]*\*\//i);
  });

  it('has taskTimeoutMinutes field documented', () => {
    // Field-level JSDoc mentions "minutes" for task timeout
    expect(sourceContent).toMatch(/\/\*\*[^*]*minutes[^*]*\*\//i);
  });

  it('has TriggerConfig interface-level JSDoc', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export interface TriggerConfig/);
  });

  it('has ProviderConfig interface-level JSDoc', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export interface ProviderConfig/);
  });

  it('has CustomTaskConfig interface-level JSDoc', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export interface CustomTaskConfig/);
  });
});

describe('TaskDefinition JSDoc comments', () => {
  let sourceContent: string;

  beforeAll(async () => {
    sourceContent = await readFile(join(REPO_ROOT, 'src/types/task.ts'), 'utf8');
  });

  it('has an interface-level JSDoc block for TaskDefinition', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export interface TaskDefinition/);
  });

  it('documents the id field', () => {
    // Field-level JSDoc on id (single-line /** ... */ before the field)
    expect(sourceContent).toMatch(/\/\*\*[^*]*identifier[^*]*\*\//i);
  });

  it('documents the priority field', () => {
    // Field-level JSDoc containing 'priority'
    expect(sourceContent).toMatch(/\/\*\*[^*]*[Pp]riority[^*]*\*\//);
  });

  it('references TaskResult in JSDoc cross-reference', () => {
    // Should link to TaskResult via @see
    expect(sourceContent).toMatch(/@see\s+\{@link TaskResult\}/);
  });
});

describe('TaskResult JSDoc comments', () => {
  let sourceContent: string;

  beforeAll(async () => {
    sourceContent = await readFile(join(REPO_ROOT, 'src/types/task.ts'), 'utf8');
  });

  it('has an interface-level JSDoc block for TaskResult', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export interface TaskResult/);
  });

  it('documents the taskId field', () => {
    // Field-level JSDoc comment precedes "taskId:" and mentions the task identifier
    expect(sourceContent).toMatch(/\/\*\*[^*]*executed task[^*]*\*\//i);
  });

  it('documents the durationMs field', () => {
    // Field-level JSDoc contains "duration" in a /** */ comment
    expect(sourceContent).toMatch(/\/\*\*[^*]*[Dd]uration[^*]*\*\//);
  });

  it('documents the exitCode field', () => {
    // Field-level JSDoc contains "exit" or "exit code"
    expect(sourceContent).toMatch(/\/\*\*[^*]*[Ee]xit[^*]*\*\//);
  });
});

describe('PersistedTask JSDoc comments', () => {
  let sourceContent: string;

  beforeAll(async () => {
    sourceContent = await readFile(join(REPO_ROOT, 'src/queue/queue-schema.ts'), 'utf8');
  });

  it('has a JSDoc block immediately before the PersistedTask type export', () => {
    expect(sourceContent).toMatch(/\/\*\*[\s\S]*?\*\/\s*export type PersistedTask/);
  });

  it('mentions discriminated union or type in JSDoc', () => {
    // The JSDoc should describe what PersistedTask is
    expect(sourceContent).toMatch(/discriminated|union|serialized|persisted/i);
  });

  it('mentions ISO 8601 date format in JSDoc', () => {
    expect(sourceContent).toMatch(/ISO 8601/i);
  });

  it('clarifies ISO 8601 constraint is Zod-validated at runtime', () => {
    expect(sourceContent).toMatch(/Zod|runtime|validated/i);
  });
});

// ---------------------------------------------------------------------------
// Barrel exports — JSDoc comments must not break existing type exports
// ---------------------------------------------------------------------------

describe('barrel export integrity', () => {
  it('src/errors/index.ts exports ScrowError', async () => {
    const content = await readFile(join(REPO_ROOT, 'src/errors/index.ts'), 'utf8');
    expect(content).toContain('ScrowError');
  });

  it('src/types/index.ts exports ScrowConfig', async () => {
    const content = await readFile(join(REPO_ROOT, 'src/types/index.ts'), 'utf8');
    expect(content).toContain('ScrowConfig');
  });

  it('src/types/index.ts exports TaskDefinition', async () => {
    const content = await readFile(join(REPO_ROOT, 'src/types/index.ts'), 'utf8');
    expect(content).toContain('TaskDefinition');
  });

  it('src/types/index.ts exports TaskResult', async () => {
    const content = await readFile(join(REPO_ROOT, 'src/types/index.ts'), 'utf8');
    expect(content).toContain('TaskResult');
  });

  it('src/queue/index.ts exports PersistedTask', async () => {
    const content = await readFile(join(REPO_ROOT, 'src/queue/index.ts'), 'utf8');
    expect(content).toContain('PersistedTask');
  });
});

// ---------------------------------------------------------------------------
// Runtime — JSDoc additions do not break ScrowError construction
// ---------------------------------------------------------------------------

describe('ScrowError runtime behaviour unchanged after JSDoc additions', () => {
  let ScrowError: Awaited<ReturnType<typeof import('../../src/errors/index.js')>>['ScrowError'];

  beforeAll(async () => {
    ({ ScrowError } = await import('../../src/errors/index.js'));
  });

  it('constructs without cause', () => {
    const err = new ScrowError('CONFIG_INVALID', 'test');
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toBe('test');
    expect(err.name).toBe('ScrowError');
    expect(err instanceof Error).toBe(true);
  });

  it('constructs with cause', () => {
    const cause = new Error('root cause');
    const err = new ScrowError('PROVIDER_UNREACHABLE', 'wrapped', cause);
    expect(err.cause).toBe(cause);
  });

  it('passes instanceof check', () => {
    const err = new ScrowError('QUEUE_EMPTY', 'empty');
    expect(err instanceof ScrowError).toBe(true);
  });
});
