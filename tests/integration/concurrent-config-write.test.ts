/** Integration tests for concurrent config file writes — verifies YAML integrity under parallel access. */
import { mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '../../src/utils/index.js';

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-concurrent-config-${randomBytes(6).toString('hex')}`);
}

/**
 * Simulates a "config set" operation: reads config YAML, sets a key, writes back atomically.
 * This mirrors what the CLI `config set` command does.
 */
async function configSet(
  configPath: string,
  key: string,
  value: unknown,
): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = yamlParse(content) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  raw[key] = value;
  await atomicWrite(configPath, yamlStringify(raw));
}

describe('concurrent config writes', () => {
  let configDir: string;
  let configPath: string;

  beforeEach(async () => {
    configDir = makeTmpDir();
    await mkdir(configDir, { recursive: true });
    configPath = join(configDir, 'config.yaml');
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  describe('AC5 — concurrent config set operations', () => {
    it('preserves valid YAML after two concurrent writes', async () => {
      const ITERATIONS = 10;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        // Write initial config
        await atomicWrite(configPath, yamlStringify({ poll_interval_seconds: 30 }));

        // Two concurrent config set operations
        await Promise.all([
          configSet(configPath, 'poll_interval_seconds', 60),
          configSet(configPath, 'log_level', 'debug'),
        ]);

        // File must be valid YAML
        const content = await readFile(configPath, 'utf-8');
        const parsed = yamlParse(content) as Record<string, unknown>;
        expect(parsed).toBeDefined();
        expect(typeof parsed).toBe('object');

        // At least one write must be preserved (last-writer-wins semantics with atomic writes)
        const hasPollInterval = 'poll_interval_seconds' in parsed;
        const hasLogLevel = 'log_level' in parsed;
        expect(hasPollInterval || hasLogLevel).toBe(true);
      }
    });

    it('never produces corrupt YAML even under heavy concurrent writes', async () => {
      const WRITTEN_KEYS = ['key_a', 'key_b', 'key_c', 'key_d', 'key_e'] as const;

      // Write initial config
      await atomicWrite(configPath, yamlStringify({ initial: true }));

      // Fire 5 concurrent writes
      await Promise.all([
        configSet(configPath, 'key_a', 'value_a'),
        configSet(configPath, 'key_b', 'value_b'),
        configSet(configPath, 'key_c', 'value_c'),
        configSet(configPath, 'key_d', 'value_d'),
        configSet(configPath, 'key_e', 'value_e'),
      ]);

      // File must be valid YAML
      const content = await readFile(configPath, 'utf-8');
      const parsed = yamlParse(content) as Record<string, unknown>;
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe('object');

      // Count surviving keys — at least 1 must have been written (no silent data loss on all)
      // Under last-writer-wins semantics, the winner preserves its own key plus any keys from
      // the snapshot it read before writing. At least 1 of the 5 written keys must survive.
      const survivingKeys = WRITTEN_KEYS.filter((k) => k in parsed);
      expect(survivingKeys.length).toBeGreaterThanOrEqual(1);
    });
  });
});
