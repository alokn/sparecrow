/** Unit tests for the seedCredentials E2E helper. */
import { stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { seedCredentials } from './seed-credentials.js';

describe('seedCredentials', () => {
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-seed-creds-'));
  });

  afterEach(async () => {
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  it('creates .claude/.credentials.json at the expected path', async () => {
    const credPath = await seedCredentials(homeDir!);
    expect(credPath).toBe(join(homeDir!, '.claude', '.credentials.json'));
    const info = await stat(credPath);
    expect(info.isFile()).toBe(true);
  });

  it('writes credentials file with mode 0o600', async () => {
    const credPath = await seedCredentials(homeDir!);
    const info = await stat(credPath);
    // Extract the permission bits (mask out file-type bits)
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes default accessToken when no options provided', async () => {
    const credPath = await seedCredentials(homeDir!);
    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(credPath, 'utf8'));
    expect(contents.accessToken).toBe('e2e-test-token');
    expect(contents.expiresAt).toBeUndefined();
  });

  it('writes custom accessToken when provided', async () => {
    const credPath = await seedCredentials(homeDir!, { accessToken: 'custom-token' });
    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(credPath, 'utf8'));
    expect(contents.accessToken).toBe('custom-token');
  });

  it('includes expiresAt when provided as a number', async () => {
    const expiry = Date.now() + 3600_000;
    const credPath = await seedCredentials(homeDir!, { expiresAt: expiry });
    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(credPath, 'utf8'));
    expect(contents.expiresAt).toBe(expiry);
  });

  it('omits expiresAt when explicitly set to null', async () => {
    const credPath = await seedCredentials(homeDir!, { expiresAt: null });
    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(credPath, 'utf8'));
    expect(Object.prototype.hasOwnProperty.call(contents, 'expiresAt')).toBe(false);
  });
});
