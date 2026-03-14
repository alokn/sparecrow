/** Unit tests for the config loader. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig, hasOldTriggerFields } from './loader.js';
import { ScrowError, ErrorCode } from '../errors/index.js';

describe('loadConfig()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sparecrow-test-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns complete defaults when config file does not exist', async () => {
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.pollingInterval).toBe(300);
    expect(config.trigger.maxWastePercentage).toBe(50);
    expect(config.trigger.weeklyReservePercentage).toBe(30);
    expect(config.logRetentionDays).toBe(30);
    expect(config.tasks).toEqual([]);
  });

  it('loads and transforms a valid config file', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'polling_interval: 120\n');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.pollingInterval).toBe(120);
    expect(config.trigger.maxWastePercentage).toBe(50); // default preserved
  });

  it('throws ScrowError(CONFIG_INVALID) when polling_interval is below range', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'polling_interval: 5\n');
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws ScrowError(CONFIG_INVALID) when max_waste_percentage is above 100', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'trigger:\n  max_waste_percentage: 200\n');
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('reports all validation errors, not just the first', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'polling_interval: -1\nlog_retention_days: 0\n');
    try {
      await loadConfig(join(tmpDir, 'config.yaml'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ScrowError);
      expect((err as ScrowError).message).toContain('polling_interval');
      expect((err as ScrowError).message).toContain('log_retention_days');
    }
  });

  it('applies default provider name when provider section is absent', async () => {
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.provider.name).toBe('claude-code');
  });

  it('merges partial config with defaults', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'trigger:\n  max_waste_percentage: 60\n');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.trigger.maxWastePercentage).toBe(60);
    expect(config.trigger.weeklyReservePercentage).toBe(30); // default preserved
    expect(config.pollingInterval).toBe(300); // default preserved
  });

  it('maps claude_path to claudePath in provider config', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      'provider:\n  claude_path: /usr/local/bin/claude\n',
    );
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.provider.claudePath).toBe('/usr/local/bin/claude');
  });

  it('loads and maps custom tasks from config', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      [
        'tasks:',
        '  - name: my-task',
        '    prompt: do something useful',
        '    target_path: ./src',
      ].join('\n'),
    );
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0]?.name).toBe('my-task');
    expect(config.tasks[0]?.prompt).toBe('do something useful');
    expect(config.tasks[0]?.targetPath).toBe('./src');
  });

  it('throws ScrowError(CONFIG_INVALID) when config file cannot be read', async () => {
    // Create a directory at the config path so readFile gets EISDIR (not ENOENT)
    const dirAsFile = join(tmpDir, 'config.yaml');
    await mkdir(dirAsFile);
    await expect(loadConfig(dirAsFile)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('returns defaults when config file is empty string', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), '');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.pollingInterval).toBe(300);
    expect(config.trigger.maxWastePercentage).toBe(50);
  });

  it('returns defaults when config file contains null YAML', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), '~\n');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.pollingInterval).toBe(300);
    expect(config.trigger.maxWastePercentage).toBe(50);
  });

  it('returns defaults when config file is whitespace only', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), '   \n\n  ');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.pollingInterval).toBe(300);
    expect(config.logRetentionDays).toBe(30);
  });

  it('throws ScrowError(CONFIG_INVALID) when max_waste_percentage is negative', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'trigger:\n  max_waste_percentage: -5\n');
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws ScrowError(CONFIG_INVALID) when weekly_reserve_percentage is above 100', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'trigger:\n  weekly_reserve_percentage: 150\n');
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  // ── Custom task schema hardening (Task 1.3 — AC1, AC2, AC14) ──────────────

  it('throws CONFIG_INVALID when task is missing name field', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', '  - prompt: do something', '    target_path: ./src'].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID when task is missing prompt field', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', '  - name: my-task', '    target_path: ./src'].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID when task is missing target_path field', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', '  - name: my-task', '    prompt: do something'].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID when task name is empty string', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', "  - name: ''", '    prompt: do something', '    target_path: ./src'].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID when task prompt is empty string', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', '  - name: my-task', "    prompt: ''", '    target_path: ./src'].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID when task target_path is empty string', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', '  - name: my-task', '    prompt: do something', "    target_path: ''"].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID when task name is a number (wrong type)', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      ['tasks:', '  - name: 42', '    prompt: do something', '    target_path: ./src'].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID for mixed valid/invalid entries in tasks array', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      [
        'tasks:',
        '  - name: valid-task',
        '    prompt: good prompt',
        '    target_path: ./src',
        '  - name: bad-task',
        "    prompt: ''",
        '    target_path: ./src',
      ].join('\n'),
    );
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('loads multiple valid tasks in definition order (AC14 backward compat)', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      [
        'tasks:',
        '  - name: task-a',
        '    prompt: prompt a',
        '    target_path: ./a',
        '  - name: task-b',
        '    prompt: prompt b',
        '    target_path: ./b',
      ].join('\n'),
    );
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.tasks).toHaveLength(2);
    expect(config.tasks[0]?.name).toBe('task-a');
    expect(config.tasks[1]?.name).toBe('task-b');
  });

  it('returns empty tasks array when tasks section is absent (AC14 backward compat)', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'polling_interval: 300\n');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.tasks).toEqual([]);
  });

  // ── task_timeout_minutes (Story 7.19 — AC1) ────────────────────────────────

  it('defaults taskTimeoutMinutes to 60 when not set', async () => {
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.taskTimeoutMinutes).toBe(60);
  });

  it('loads custom task_timeout_minutes value', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'task_timeout_minutes: 120\n');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.taskTimeoutMinutes).toBe(120);
  });

  it('accepts task_timeout_minutes: 0 (no timeout)', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'task_timeout_minutes: 0\n');
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.taskTimeoutMinutes).toBe(0);
  });

  it('throws CONFIG_INVALID for negative task_timeout_minutes', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'task_timeout_minutes: -1\n');
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('throws CONFIG_INVALID for fractional task_timeout_minutes', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'task_timeout_minutes: 30.5\n');
    await expect(loadConfig(join(tmpDir, 'config.yaml'))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  // ── allow_dangerously_skip_permissions (Story 3.5 — AC3) ──────────────────

  it('defaults allowDangerouslySkipPermissions to false when not set', async () => {
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.provider.allowDangerouslySkipPermissions).toBe(false);
  });

  it('maps allow_dangerously_skip_permissions: true to allowDangerouslySkipPermissions: true', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      'provider:\n  allow_dangerously_skip_permissions: true\n',
    );
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.provider.allowDangerouslySkipPermissions).toBe(true);
  });

  it('maps allow_dangerously_skip_permissions: false explicitly', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      'provider:\n  allow_dangerously_skip_permissions: false\n',
    );
    const config = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(config.provider.allowDangerouslySkipPermissions).toBe(false);
  });
});

// ── hasOldTriggerFields() unit tests ────────────────────────────────────────

describe('hasOldTriggerFields()', () => {
  it('returns false for non-record input', () => {
    expect(hasOldTriggerFields(null)).toBe(false);
    expect(hasOldTriggerFields([])).toBe(false);
    expect(hasOldTriggerFields('string')).toBe(false);
    expect(hasOldTriggerFields(42)).toBe(false);
  });

  it('returns false when trigger is absent', () => {
    expect(hasOldTriggerFields({})).toBe(false);
    expect(hasOldTriggerFields({ pollingInterval: 300 })).toBe(false);
  });

  it('returns false when trigger is not a record', () => {
    expect(hasOldTriggerFields({ trigger: 'not-an-object' })).toBe(false);
    expect(hasOldTriggerFields({ trigger: [] })).toBe(false);
    expect(hasOldTriggerFields({ trigger: null })).toBe(false);
  });

  it('returns false when trigger has only new fields', () => {
    expect(hasOldTriggerFields({ trigger: { max_waste_percentage: 50 } })).toBe(false);
    expect(hasOldTriggerFields({ trigger: { weekly_reserve_percentage: 30 } })).toBe(false);
    expect(hasOldTriggerFields({ trigger: { idle_hours: [] } })).toBe(false);
  });

  it('returns true when threshold_percentage is present', () => {
    expect(hasOldTriggerFields({ trigger: { threshold_percentage: 80 } })).toBe(true);
  });

  it('returns true when time_before_reset_minutes is present', () => {
    expect(hasOldTriggerFields({ trigger: { time_before_reset_minutes: 60 } })).toBe(true);
  });

  it('returns true when require_reset_window is present', () => {
    expect(hasOldTriggerFields({ trigger: { require_reset_window: true } })).toBe(true);
  });

  it('returns true when multiple old fields are present', () => {
    expect(
      hasOldTriggerFields({
        trigger: {
          threshold_percentage: 80,
          time_before_reset_minutes: 60,
          require_reset_window: true,
        },
      }),
    ).toBe(true);
  });
});

// ── Migration tests ──────────────────────────────────────────────────────────

describe('loadConfig() — migration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sparecrow-migration-test-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Task 6.2: AC3 — old fields are stripped, new field defaults applied
  it('migrates old trigger fields to defaults and strips them (AC3)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(
      configPath,
      [
        'trigger:',
        '  threshold_percentage: 80',
        '  time_before_reset_minutes: 60',
        '  require_reset_window: true',
      ].join('\n'),
    );
    const config = await loadConfig(configPath);
    expect(config.trigger.maxWastePercentage).toBe(50);
    expect(config.trigger.weeklyReservePercentage).toBe(30);
    expect(config.trigger.idleHours).toEqual([]);
  });

  // Task 6.3: AC4 — config file is rewritten after migration
  it('rewrites config file after migration with old fields removed (AC4)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(
      configPath,
      ['trigger:', '  threshold_percentage: 80', '  time_before_reset_minutes: 60'].join('\n'),
    );
    await loadConfig(configPath);
    const rewritten = await readFile(configPath, 'utf-8');
    expect(rewritten).not.toContain('threshold_percentage');
    expect(rewritten).not.toContain('time_before_reset_minutes');
    expect(rewritten).not.toContain('require_reset_window');
  });

  // Task 6.4: AC6 — mixed config: old + new fields; new field values preserved
  it('preserves new field values when old and new fields coexist (AC6)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(
      configPath,
      ['trigger:', '  threshold_percentage: 70', '  max_waste_percentage: 40'].join('\n'),
    );
    const config = await loadConfig(configPath);
    expect(config.trigger.maxWastePercentage).toBe(40);
    expect(config.trigger.weeklyReservePercentage).toBe(30);
  });

  // Task 6.5: AC5 — fresh config (no trigger section) uses defaults, no migration
  it('applies defaults and does not migrate when trigger section is absent (AC5)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(configPath, 'polling_interval: 300\n');
    const config = await loadConfig(configPath);
    expect(config.trigger.maxWastePercentage).toBe(50);
    expect(config.trigger.weeklyReservePercentage).toBe(30);
    expect(config.trigger.idleHours).toEqual([]);
  });

  // Task 6.6: AC3 — logger.warn is called with migration event message when old fields detected
  // Uses vi.resetModules() + vi.doMock() so the spy intercepts the logger reference captured
  // inside loader.ts at import time (CLAUDE.md testing pattern for module-level dependencies).
  it('logs a warning via logger.warn when migration is triggered (AC3)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(configPath, ['trigger:', '  threshold_percentage: 80'].join('\n'));

    vi.resetModules();
    const warnMock = vi.fn().mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../utils/index.js')>('../utils/index.js');
    vi.doMock('../utils/index.js', () => ({
      ...actual,
      logger: { ...actual.logger, warn: warnMock },
    }));

    const { loadConfig: loadConfigFresh } = await import('./loader.js');
    await loadConfigFresh(configPath);

    expect(warnMock).toHaveBeenCalledWith(
      'config.migration',
      expect.objectContaining({
        message: expect.stringContaining('Trigger config migrated to capacity intelligence model'),
      }),
    );
  });

  // Task 6.7: AC4 resilience — rewrite failure is non-fatal; migrated config still returned
  it('returns migrated config even when file rewrite fails (AC4 resilience, Task 4.5)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(configPath, ['trigger:', '  threshold_percentage: 80'].join('\n'));
    // Make the directory read-only to cause atomicWrite to fail
    await chmod(tmpDir, 0o555);
    let config;
    try {
      config = await loadConfig(configPath);
    } finally {
      // Restore permissions so afterEach cleanup can delete tmpDir
      await chmod(tmpDir, 0o755);
    }
    expect(config).toBeDefined();
    expect(config!.trigger.maxWastePercentage).toBe(50);
    expect(config!.trigger.weeklyReservePercentage).toBe(30);
  });

  // Task 6.8: AC3-clarification — existing idle_hours preserved during migration
  it('preserves custom idle_hours during migration (AC3-clarification, Edge Case 2)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(
      configPath,
      [
        'trigger:',
        '  threshold_percentage: 80',
        '  idle_hours:',
        '    - start: "22:00"',
        '      end: "06:00"',
      ].join('\n'),
    );
    const config = await loadConfig(configPath);
    expect(config.trigger.idleHours).toEqual([{ start: '22:00', end: '06:00' }]);
  });

  // Task 6.9: YAML top-level array — hasOldTriggerFields returns false, loadConfig throws CONFIG_INVALID
  it('throws CONFIG_INVALID for YAML top-level array without migration attempt (Task 6.9)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(configPath, '- item\n');
    await expect(loadConfig(configPath)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID,
    });
  });

  it('includes Zod path and config edit hint in validation error message', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), 'polling_interval: 5\n');
    try {
      await loadConfig(join(tmpDir, 'config.yaml'));
      expect.fail('Expected ScrowError to be thrown');
    } catch (err) {
      expect(err).toMatchObject({ code: ErrorCode.CONFIG_INVALID });
      const msg = (err as Error).message;
      expect(msg).toContain('polling_interval');
      expect(msg).toContain('sparecrow config edit');
    }
  });
});
