/** Integration tests for read-only credential mount (Story 22.1, Task 6). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolveContainerCredentials } from '../../src/providers/backends/container/credential-resolver.js';

// Mock logger to prevent disk I/O during integration tests
vi.mock('../../src/utils/index.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('resolveContainerCredentials read-only mount (integration)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = join(tmpdir(), 'scrow-22-1-' + randomBytes(6).toString('hex'));
    const claudeDir = join(tmpHome, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify({ token: 'test' }));
    await writeFile(join(tmpHome, '.claude.json'), JSON.stringify({ numStartups: 1 }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('resolves real host credential paths with readonly: true by default', async () => {
    const result = await resolveContainerCredentials({ hostHomedir: tmpHome });

    const claudeDirMount = result.mounts.find((m) => m.target.endsWith('/.claude'));
    expect(claudeDirMount).toBeDefined();
    expect(claudeDirMount!.readonly).toBe(true);
    expect(claudeDirMount!.source).toBe(join(tmpHome, '.claude'));
  });

  it('resolves real host credential paths with readonly: false when override set', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: tmpHome,
      mountClaudeConfigReadonly: false,
    });

    const claudeDirMount = result.mounts.find((m) => m.target.endsWith('/.claude'));
    expect(claudeDirMount).toBeDefined();
    expect(claudeDirMount!.readonly).toBe(false);
  });

  it('always keeps .claude.json mount as read-only regardless of mountClaudeConfigReadonly setting', async () => {
    const resultRo = await resolveContainerCredentials({
      hostHomedir: tmpHome,
      mountClaudeConfigReadonly: true,
    });
    const claudeJsonMountRo = resultRo.mounts.find((m) => m.target.endsWith('.claude.json'));
    expect(claudeJsonMountRo).toBeDefined();
    expect(claudeJsonMountRo!.readonly).toBe(true);

    const resultRw = await resolveContainerCredentials({
      hostHomedir: tmpHome,
      mountClaudeConfigReadonly: false,
    });
    const claudeJsonMountRw = resultRw.mounts.find((m) => m.target.endsWith('.claude.json'));
    expect(claudeJsonMountRw).toBeDefined();
    expect(claudeJsonMountRw!.readonly).toBe(true);
  });

  it('returns empty mounts without throwing when credential directory does not exist', async () => {
    const missingHome = join(tmpdir(), 'scrow-missing-' + randomBytes(6).toString('hex'));
    const result = await resolveContainerCredentials({ hostHomedir: missingHome });

    expect(result.mounts).toHaveLength(0);
    expect(result.env['HOME']).toBeDefined();
  });
});
