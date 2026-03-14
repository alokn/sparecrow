/** Unit tests for the config command: get/set/validate/path/show. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { ScrowConfigSchema } from '../../config/index.js';
import { coerceValue } from './config.js';

let tmpDir = '';

vi.mock('../../platform/index.js', () => ({
  getPaths: () => ({
    config: tmpDir + '/config',
    data: tmpDir + '/data',
    logs: tmpDir + '/data/logs',
  }),
  ensureDirectories: async () => {
    const { mkdir: mkdirFn } = await import('node:fs/promises');
    await mkdirFn(tmpDir + '/config', { recursive: true });
    await mkdirFn(tmpDir + '/data', { recursive: true });
  },
}));

vi.mock('../index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.js')>();
  return {
    ...actual,
    isJsonMode: vi.fn(() => false),
    getConfigPath: vi.fn(() => undefined),
  };
});

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

describe('config command', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let exitCode: number | undefined;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `sparecrow-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(tmpDir, 'config'), { recursive: true });
    await mkdir(join(tmpDir, 'data'), { recursive: true });

    stdoutOutput = '';
    stderrOutput = '';
    exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : 0;
      return undefined as never;
    });

    // Reset CLI global option mocks for each test
    const { isJsonMode, getConfigPath } = await import('../index.js');
    vi.mocked(isJsonMode).mockReturnValue(false);
    vi.mocked(getConfigPath).mockReturnValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Schema validation helpers ──────────────────────────────────────────────

  describe('ScrowConfigSchema', () => {
    it('validates empty input as valid (all defaults)', () => {
      const result = ScrowConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts valid polling_interval in range', () => {
      const result = ScrowConfigSchema.safeParse({ polling_interval: 120 });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.pollingInterval).toBe(120);
    });

    it('rejects polling_interval below minimum (60)', () => {
      const result = ScrowConfigSchema.safeParse({ polling_interval: 5 });
      expect(result.success).toBe(false);
    });

    it('rejects polling_interval above maximum (3600)', () => {
      const result = ScrowConfigSchema.safeParse({ polling_interval: 9999 });
      expect(result.success).toBe(false);
    });

    it('collects all errors when multiple fields are invalid', () => {
      const result = ScrowConfigSchema.safeParse({ polling_interval: -1, log_retention_days: 0 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('applies camelCase transform on successful parse', () => {
      const result = ScrowConfigSchema.safeParse({
        polling_interval: 600,
        trigger: { max_waste_percentage: 70, weekly_reserve_percentage: 25 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pollingInterval).toBe(600);
        expect(result.data.trigger.maxWastePercentage).toBe(70);
      }
    });

    it('parses trigger.weekly_reserve_percentage correctly', () => {
      const result = ScrowConfigSchema.safeParse({
        trigger: {
          max_waste_percentage: 60,
          weekly_reserve_percentage: 40,
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trigger.weeklyReservePercentage).toBe(40);
      }
    });

    it('defaults trigger.max_waste_percentage to 50 when omitted', () => {
      const result = ScrowConfigSchema.safeParse({
        trigger: { weekly_reserve_percentage: 25 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trigger.maxWastePercentage).toBe(50);
      }
    });

    it('defaults all trigger fields when trigger is omitted', () => {
      const result = ScrowConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trigger.maxWastePercentage).toBe(50);
        expect(result.data.trigger.weeklyReservePercentage).toBe(30);
      }
    });
  });

  // ── coerceValue helper ────────────────────────────────────────────────────

  describe('coerceValue()', () => {
    it('converts numeric string to number', () => {
      expect(coerceValue('120')).toBe(120);
      expect(coerceValue('0')).toBe(0);
    });

    it('converts "true" to boolean true', () => {
      expect(coerceValue('true')).toBe(true);
    });

    it('converts "false" to boolean false', () => {
      expect(coerceValue('false')).toBe(false);
    });

    it('leaves string values as strings', () => {
      expect(coerceValue('claude-code')).toBe('claude-code');
    });

    it('handles float strings as numbers', () => {
      expect(coerceValue('3.14')).toBe(3.14);
    });

    it('treats whitespace-only strings as strings', () => {
      expect(coerceValue('   ')).toBe('   ');
    });
  });

  // ── config show (bare command) ─────────────────────────────────────────────

  describe('sparecrow config (show)', () => {
    it('displays table with config keys when no config file exists', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);
      expect(stdoutOutput).toContain('polling_interval');
      expect(stdoutOutput).toContain('trigger.max_waste_percentage');
    });

    it('redacts provider.claude_path when not set', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);
      expect(stdoutOutput).toContain('[not set]');
    });

    it('shows full task values instead of only task count', async () => {
      const configPath = join(tmpDir, 'config', 'config.yaml');
      await writeFile(
        configPath,
        'tasks:\n  - name: daily\n    prompt: run tests\n    target_path: ./repo\n',
      );

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);
      expect(stdoutOutput).toContain('tasks[0].name');
      expect(stdoutOutput).toContain('daily');
      expect(stdoutOutput).not.toContain('tasks.count');
    });

    it('invokes reconnect handler for --reconnect flag (non-TTY renders error and exits 3)', async () => {
      // In the test environment process.stdin.isTTY is undefined (non-interactive),
      // so reconnect renders an error block via renderErrorBlock and exits with code 3.
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', '--reconnect']);
      expect(stderrOutput).toContain('Re-authentication failed');
      expect(exitCode).toBe(3);
    });
  });

  // ── config get ─────────────────────────────────────────────────────────────

  describe('sparecrow config get <key>', () => {
    it('returns polling_interval value using snake_case key', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'polling_interval']);
      expect(stdoutOutput).toMatch(/300/);
    });

    it('returns same value with camelCase key alias', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'pollingInterval']);
      expect(stdoutOutput).toMatch(/300/);
    });

    it('returns nested key value (trigger.max_waste_percentage)', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'get',
        'trigger.max_waste_percentage',
      ]);
      expect(stdoutOutput).toMatch(/50/);
    });

    it('reads from global --config override path when provided', async () => {
      const customConfigPath = join(tmpDir, 'custom-config.yaml');
      await writeFile(customConfigPath, 'polling_interval: 120\n');

      const { getConfigPath } = await import('../index.js');
      vi.mocked(getConfigPath).mockReturnValue(customConfigPath);

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'polling_interval']);
      expect(stdoutOutput).toContain('120');
    });

    it('exits with code 1 and prints error for unknown key', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'nonexistent_key']);
      expect(stderrOutput).toContain("Unknown config key: 'nonexistent_key'");
      expect(exitCode).toBe(1);
    });
  });

  // ── config set ─────────────────────────────────────────────────────────────

  describe('sparecrow config set <key> <value>', () => {
    it('sets polling_interval and prints success', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '120']);
      expect(stdoutOutput).toContain('✓ Set polling_interval to 120');
    });

    it('writes updated value to config.yaml', async () => {
      const { registerConfig } = await import('./config.js');
      const { readFile } = await import('node:fs/promises');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '600']);

      const content = await readFile(join(tmpDir, 'config', 'config.yaml'), 'utf-8');
      expect(content).toContain('600');
    });

    it('rejects invalid polling_interval (too low) and exits with code 3', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '5']);
      expect(stderrOutput).toContain("Invalid value for 'polling_interval'");
      expect(exitCode).toBe(3);
    });

    it('does not write config.yaml when validation fails', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '1']);

      // Verify config.yaml was NOT created
      const { access } = await import('node:fs/promises');
      await expect(access(join(tmpDir, 'config', 'config.yaml'))).rejects.toThrow();
    });

    it('preserves existing keys when setting a new value', async () => {
      const configPath = join(tmpDir, 'config', 'config.yaml');
      await writeFile(configPath, 'polling_interval: 300\nlog_retention_days: 7\n');

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '600']);

      const { readFile } = await import('node:fs/promises');
      const content = await readFile(configPath, 'utf-8');
      expect(content).toContain('log_retention_days');
    });

    it('rejects unknown config key and exits with code 1', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'totally_unknown', '1']);
      expect(stderrOutput).toContain("Unknown config key: 'totally_unknown'");
      expect(exitCode).toBe(1);
    });

    it('does not overwrite malformed config.yaml when set is attempted', async () => {
      const configPath = join(tmpDir, 'config', 'config.yaml');
      const malformed = 'polling_interval: [\n';
      await writeFile(configPath, malformed);

      const { registerConfig } = await import('./config.js');
      const { readFile } = await import('node:fs/promises');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '120']);

      const updated = await readFile(configPath, 'utf-8');
      expect(updated).toBe(malformed);
      expect(stderrOutput).toContain('Cannot read config file');
      expect(exitCode).toBe(3);
    });
  });

  // ── config validate ────────────────────────────────────────────────────────

  describe('sparecrow config validate', () => {
    it('exits 0 and prints valid message when no config file exists', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'validate']);
      expect(stdoutOutput).toContain('✓ Configuration is valid');
      expect(exitCode).toBe(0);
    });

    it('exits 0 for valid config file', async () => {
      const configPath = join(tmpDir, 'config', 'config.yaml');
      await writeFile(configPath, 'polling_interval: 120\n');

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'validate']);
      expect(stdoutOutput).toContain('✓ Configuration is valid');
      expect(exitCode).toBe(0);
    });

    it('exits 3 and reports all errors for invalid config', async () => {
      const configPath = join(tmpDir, 'config', 'config.yaml');
      await writeFile(configPath, 'polling_interval: -1\nlog_retention_days: 0\n');

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'validate']);
      expect(exitCode).toBe(3);
      // Multiple error blocks written to stderr
      expect(stderrOutput.length).toBeGreaterThan(0);
    });
  });

  // ── config path ────────────────────────────────────────────────────────────

  describe('sparecrow config path', () => {
    it('prints config file path', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'path']);
      expect(stdoutOutput).toContain('config.yaml');
      expect(stdoutOutput).toContain('Config file:');
    });

    it('prints state directory path', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'path']);
      expect(stdoutOutput).toContain('State directory:');
    });

    it('prints logs directory path', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'path']);
      expect(stdoutOutput).toContain('Logs directory:');
    });
  });

  // ── JSON mode ──────────────────────────────────────────────────────────────

  describe('--json mode', () => {
    beforeEach(async () => {
      const { isJsonMode } = await import('../index.js');
      vi.mocked(isJsonMode).mockReturnValue(true);
    });

    it('config show outputs JSON wrapper with config data', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { config: { tasks: unknown[]; provider: { claude_path: string } } } | null;
        error: unknown;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toBeTruthy();
      expect(parsed.data?.config.tasks).toEqual([]);
      expect(parsed.data?.config.provider.claude_path).toBe('[not set]');
      expect(parsed.error).toBeNull();
    });

    it('config get outputs JSON wrapper with key and value', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'polling_interval']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { key: string; value: number };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.key).toBe('polling_interval');
      expect(parsed.data.value).toBe(300);
    });

    it('config path outputs JSON wrapper with paths', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'path']);
      const parsed = JSON.parse(stdoutOutput) as { ok: boolean; data: { configPath: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.configPath).toContain('config.yaml');
    });

    it('config validate outputs JSON wrapper with valid:true when valid', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'validate']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { valid: boolean; errors: unknown[] };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.valid).toBe(true);
      expect(parsed.data.errors).toEqual([]);
    });

    it('config set outputs JSON wrapper with key and value on success', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '120']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { key: string; value: number };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.key).toBe('polling_interval');
      expect(parsed.data.value).toBe(120);
    });

    it('config set outputs JSON error wrapper when value is invalid', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'set', 'polling_interval', '5']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string } | null;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error?.code).toBe('CONFIG_INVALID');
      expect(parsed.error?.message).toContain("Invalid value for 'polling_interval'");
      expect(stderrOutput).toBe('');
      expect(exitCode).toBe(3);
    });

    it('config validate outputs JSON error when config is invalid', async () => {
      const configPath = join(tmpDir, 'config', 'config.yaml');
      await writeFile(configPath, 'polling_interval: -1\n');

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'validate']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { valid: boolean; errors: Array<{ field: string; message: string }> } | null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data?.valid).toBe(false);
      expect(parsed.data?.errors.length).toBeGreaterThan(0);
      expect(parsed.data?.errors[0]?.field).toBe('polling_interval');
      expect(parsed.error.code).toBe('CONFIG_INVALID');
      expect(exitCode).toBe(3);
    });

    it('config get unknown key returns JSON wrapper and no stderr error block', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'nonexistent_key']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('CONFIG_INVALID');
      expect(parsed.error.message).toContain("Unknown config key: 'nonexistent_key'");
      expect(stderrOutput).toBe('');
      expect(exitCode).toBe(1);
    });
  });

  // ── Nested key set ─────────────────────────────────────────────────────────

  describe('nested key operations', () => {
    it('sets nested trigger.max_waste_percentage key', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'trigger.max_waste_percentage',
        '90',
      ]);
      expect(stdoutOutput).toContain('✓ Set trigger.max_waste_percentage to 90');
    });

    it('writes nested key to config.yaml correctly', async () => {
      const { registerConfig } = await import('./config.js');
      const { readFile } = await import('node:fs/promises');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'trigger.max_waste_percentage',
        '90',
      ]);
      const content = await readFile(join(tmpDir, 'config', 'config.yaml'), 'utf-8');
      expect(content).toContain('90');
    });
  });

  // ── trigger.weekly_reserve_percentage ────────────────────────────────────────

  describe('trigger.weekly_reserve_percentage', () => {
    it('config get trigger.weekly_reserve_percentage returns default 30', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'get',
        'trigger.weekly_reserve_percentage',
      ]);
      expect(stdoutOutput).toContain('30');
    });

    it('config get trigger.weeklyReservePercentage returns default 30 (camelCase alias)', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'get',
        'trigger.weeklyReservePercentage',
      ]);
      expect(stdoutOutput).toContain('30');
    });

    it('config set trigger.weekly_reserve_percentage 40 writes to config', async () => {
      const { registerConfig } = await import('./config.js');
      const { readFile } = await import('node:fs/promises');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'trigger.weekly_reserve_percentage',
        '40',
      ]);
      expect(stdoutOutput).toContain('✓ Set trigger.weekly_reserve_percentage to 40');
      const content = await readFile(join(tmpDir, 'config', 'config.yaml'), 'utf-8');
      expect(content).toContain('weekly_reserve_percentage: 40');
    });

    it('config set trigger.weekly_reserve_percentage 20 writes to config', async () => {
      const { registerConfig } = await import('./config.js');
      const { readFile } = await import('node:fs/promises');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'trigger.weekly_reserve_percentage',
        '20',
      ]);
      expect(stdoutOutput).toContain('✓ Set trigger.weekly_reserve_percentage to 20');
      const content = await readFile(join(tmpDir, 'config', 'config.yaml'), 'utf-8');
      expect(content).toContain('weekly_reserve_percentage: 20');
    });

    it('config show includes trigger.weekly_reserve_percentage in output', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);
      expect(stdoutOutput).toContain('trigger.weekly_reserve_percentage');
    });
  });

  // ── provider.container.memory_limit_mb (Story 10.11 AC4) ────────────────────

  describe('provider.container.memory_limit_mb', () => {
    it('config get returns default value 512 when not set', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'get',
        'provider.container.memory_limit_mb',
      ]);
      expect(stdoutOutput).toContain('512');
    });

    it('config get with camelCase alias returns default value 512', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'get',
        'provider.container.memoryLimitMb',
      ]);
      expect(stdoutOutput).toContain('512');
    });

    it('config set provider.container.memory_limit_mb 1024 succeeds', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'provider.container.memory_limit_mb',
        '1024',
      ]);
      expect(stdoutOutput).toContain('✓ Set provider.container.memory_limit_mb to 1024');
    });

    it('config set rejects value below minimum (63) with schema error', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'provider.container.memory_limit_mb',
        '63',
      ]);
      expect(stderrOutput).toContain("Invalid value for 'provider.container.memory_limit_mb'");
      expect(exitCode).toBe(3);
    });

    it('config set rejects value above maximum (65537) with schema error', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'config',
        'set',
        'provider.container.memory_limit_mb',
        '65537',
      ]);
      expect(stderrOutput).toContain("Invalid value for 'provider.container.memory_limit_mb'");
      expect(exitCode).toBe(3);
    });

    it('config show (human table) includes provider.container.memory_limit_mb', async () => {
      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);
      expect(stdoutOutput).toContain('provider.container.memory_limit_mb');
      expect(stdoutOutput).toContain('512');
    });

    it('config show --json includes provider.container.memory_limit_mb in provider object', async () => {
      const { isJsonMode } = await import('../index.js');
      vi.mocked(isJsonMode).mockReturnValue(true);

      const { registerConfig } = await import('./config.js');
      const program = makeProgram();
      registerConfig(program);
      await program.parseAsync(['node', 'sparecrow', 'config']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: {
          config: {
            provider: {
              container: { memory_limit_mb: number };
            };
          };
        };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.config.provider.container.memory_limit_mb).toBe(512);
    });
  });
});
