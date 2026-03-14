/** Smoke tests for basic CLI contract: version, help, unknown command, missing argument. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli } from '../helpers/index.js';

describe('CLI smoke contract', () => {
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-smoke-'));
  });

  afterEach(async () => {
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  it('exits 0 and prints version string for --version', () => {
    const result = runCli(['--version'], { HOME: homeDir! });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('exits 0 and lists all top-level commands for --help', () => {
    const result = runCli(['--help'], { HOME: homeDir! });

    expect(result.exitCode).toBe(0);

    const expectedCommands = [
      'status',
      'queue',
      'daemon',
      'config',
      'doctor',
      'onboard',
      'templates',
      'logs',
      'report',
      'completions',
    ];

    for (const cmd of expectedCommands) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it('exits 1 and mentions unknown command in stderr', () => {
    const result = runCli(['unknowncmd'], { HOME: homeDir! });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error:');
    expect(result.stderr).toContain('unknowncmd');
  });

  it('exits 1 when queue remove is called without a position argument', () => {
    const result = runCli(['queue', 'remove'], { HOME: homeDir! });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('position');
  });
});
