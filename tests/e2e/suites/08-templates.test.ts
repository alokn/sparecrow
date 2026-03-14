/** E2E tests for the templates command (suite 08). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig } from '../helpers/index.js';

function baseEnv(dir: string): Record<string, string> {
  return {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
  };
}

describe('templates (suite 08)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-templates-'));
    await seedConfig(homeDir);
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  // Task 3 (AC: 1, 2, 3)
  it('exits 0 and lists all 4 built-in templates with type and hint', () => {
    const result = runCli(['templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('security-audit');
    expect(result.stdout).toContain('improve-code');
    expect(result.stdout).toContain('fix-bugs');
    expect(result.stdout).toContain('write-tests');
    expect(result.stdout).toContain('built-in');
    expect(result.stdout).toContain('sparecrow queue add');
  });

  // Task 4 (AC: 4)
  it('shows custom task with type custom and suppresses hint', async () => {
    await seedConfig(homeDir, {
      tasks: [
        {
          name: 'my-custom-task',
          prompt: 'Do something special.',
          target_path: join(homeDir, 'repo'),
        },
      ],
    });

    const result = runCli(['templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('my-custom-task');
    // Use '│ custom' to match the Type column cell specifically (not the substring
    // in the task name 'my-custom-task', which appears in the Template column).
    expect(result.stdout).toContain('│ custom');
    // All 4 built-in names must still be present alongside the custom task (AC4).
    expect(result.stdout).toContain('security-audit');
    expect(result.stdout).toContain('improve-code');
    expect(result.stdout).toContain('fix-bugs');
    expect(result.stdout).toContain('write-tests');
    expect(result.stdout).toContain('built-in');
    expect(result.stdout).not.toContain('sparecrow queue add');
  });

  // Task 5 (AC: 5)
  it('returns ok JSON with 4 built-in templates and customCount 0', () => {
    const result = runCli(['--json', 'templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(Array.isArray(parsed.data.templates)).toBe(true);
    expect(parsed.data.templates).toHaveLength(4);
    expect(parsed.data.customCount).toBe(0);
    expect(parsed.data.templates[0].name).toBe('fix-bugs');
    expect(parsed.data.templates[3].name).toBe('security-audit');

    for (const entry of parsed.data.templates) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.type).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(entry.type).toBe('built-in');
    }
  });

  // Task 6 (AC: 6)
  it('includes custom templates in JSON with correct customCount', async () => {
    await seedConfig(homeDir, {
      tasks: [
        {
          name: 'my-custom-task',
          prompt: 'Do something.',
          target_path: join(homeDir, 'repo'),
        },
      ],
    });

    const result = runCli(['--json', 'templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());

    // Envelope assertions (parity with Task 5).
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(Array.isArray(parsed.data.templates)).toBe(true);
    expect(parsed.data.templates).toHaveLength(5);
    expect(parsed.data.customCount).toBe(1);
    expect(parsed.data.templates[4].name).toBe('my-custom-task');
    expect(parsed.data.templates[4].type).toBe('custom');
    // Field-shape parity with Task 5 per-entry loop (description must be a string).
    expect(typeof parsed.data.templates[4].description).toBe('string');
  });

  // Task 7 (AC: 7)
  it('truncates custom prompt longer than 60 chars with Unicode ellipsis', async () => {
    await seedConfig(homeDir, {
      tasks: [
        {
          name: 'long-task',
          prompt: 'A'.repeat(70),
          target_path: join(homeDir, 'repo'),
        },
      ],
    });

    const result = runCli(['templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('A'.repeat(60) + '\u2026');
    expect(result.stdout).not.toContain('A'.repeat(61));
  });

  // Task 7b (AC: 8)
  it('does not truncate custom prompt at exactly 60 chars', async () => {
    await seedConfig(homeDir, {
      tasks: [
        {
          name: 'boundary-task',
          prompt: 'B'.repeat(60),
          target_path: join(homeDir, 'repo'),
        },
      ],
    });

    const result = runCli(['templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('B'.repeat(60));
    expect(result.stdout).not.toContain('B'.repeat(60) + '\u2026');
  });
});
