/** Unit tests for shell completion auto-install utilities. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { detectShell } from './shell-completions.js';

describe('detectShell()', () => {
  let originalShell: string | undefined;

  beforeEach(() => {
    originalShell = process.env['SHELL'];
  });

  afterEach(() => {
    if (originalShell !== undefined) {
      process.env['SHELL'] = originalShell;
    } else {
      delete process.env['SHELL'];
    }
    vi.restoreAllMocks();
  });

  it('detects bash from /bin/bash', () => {
    process.env['SHELL'] = '/bin/bash';
    expect(detectShell()).toBe('bash');
  });

  it('detects zsh from /bin/zsh', () => {
    process.env['SHELL'] = '/bin/zsh';
    expect(detectShell()).toBe('zsh');
  });

  it('detects fish from /usr/bin/fish', () => {
    process.env['SHELL'] = '/usr/bin/fish';
    expect(detectShell()).toBe('fish');
  });

  it('returns unknown for unrecognized shell', () => {
    process.env['SHELL'] = '/bin/csh';
    expect(detectShell()).toBe('unknown');
  });

  it('returns unknown when SHELL is not set', () => {
    delete process.env['SHELL'];
    expect(detectShell()).toBe('unknown');
  });
});

describe('getRcFilePath()', () => {
  it('returns .bashrc for bash', async () => {
    const { getRcFilePath } = await import('./shell-completions.js');
    const result = getRcFilePath('bash');
    expect(result).toContain('.bashrc');
  });

  it('returns .zshrc for zsh', async () => {
    const { getRcFilePath } = await import('./shell-completions.js');
    const result = getRcFilePath('zsh');
    expect(result).toContain('.zshrc');
  });

  it('returns fish completions path for fish', async () => {
    const { getRcFilePath } = await import('./shell-completions.js');
    const result = getRcFilePath('fish');
    expect(result).toContain('fish');
    expect(result).toContain('sparecrow.fish');
  });

  it('returns null for unknown', async () => {
    const { getRcFilePath } = await import('./shell-completions.js');
    expect(getRcFilePath('unknown')).toBeNull();
  });
});

describe('isAlreadyInstalled()', () => {
  it('returns true when marker is present', async () => {
    const { isAlreadyInstalled } = await import('./shell-completions.js');
    const content =
      'some stuff\n# sparecrow shell completions — auto-installed\neval...\n# end sparecrow shell completions\n';
    expect(isAlreadyInstalled(content)).toBe(true);
  });

  it('returns false when marker is absent', async () => {
    const { isAlreadyInstalled } = await import('./shell-completions.js');
    expect(isAlreadyInstalled('# just some rc content\n')).toBe(false);
  });
});

describe('installCompletions()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scrow-completions-' + randomBytes(6).toString('hex')));
    vi.resetModules();
    // Mock homedir to point to our temp dir
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => tmpDir };
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('installs bash completions to rc file', async () => {
    const rcPath = join(tmpDir, '.bashrc');
    await writeFile(rcPath, '# existing content\n', 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('bash');
    expect(result.installed).toBe(true);
    expect(result.alreadyInstalled).toBe(false);

    const content = await readFile(rcPath, 'utf-8');
    expect(content).toContain('# sparecrow shell completions');
    expect(content).toContain('eval "$(sparecrow completions bash)"');
    expect(content).toContain('# existing content');
  });

  it('detects already installed and does not duplicate', async () => {
    const rcPath = join(tmpDir, '.bashrc');
    const existing =
      '# existing\n# sparecrow shell completions — auto-installed\neval...\n# end sparecrow shell completions\n';
    await writeFile(rcPath, existing, 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('bash');
    expect(result.installed).toBe(false);
    expect(result.alreadyInstalled).toBe(true);

    const content = await readFile(rcPath, 'utf-8');
    expect(content).toBe(existing);
  });

  it('installs zsh completions to rc file', async () => {
    const rcPath = join(tmpDir, '.zshrc');
    await writeFile(rcPath, '', 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('zsh');
    expect(result.installed).toBe(true);

    const content = await readFile(rcPath, 'utf-8');
    expect(content).toContain('eval "$(sparecrow completions zsh)"');
  });

  it('installs fish completions by writing file with marker', async () => {
    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('fish', 'complete -c sparecrow -f');
    expect(result.installed).toBe(true);

    const fishPath = join(tmpDir, '.config', 'fish', 'completions', 'sparecrow.fish');
    const content = await readFile(fishPath, 'utf-8');
    expect(content).toContain('complete -c sparecrow -f');
    expect(content).toContain('# sparecrow shell completions');
  });

  it('detects fish idempotency via marker not word match', async () => {
    const fishDir = join(tmpDir, '.config', 'fish', 'completions');
    await mkdir(fishDir, { recursive: true });
    const fishPath = join(fishDir, 'sparecrow.fish');
    // File mentions sparecrow in a comment but does NOT have the marker
    await writeFile(fishPath, '# See sparecrow docs for reference\n', 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('fish', 'complete -c sparecrow -f');
    // Should install because marker is absent
    expect(result.installed).toBe(true);
    expect(result.alreadyInstalled).toBe(false);
  });

  it('detects fish already installed when marker present', async () => {
    const fishDir = join(tmpDir, '.config', 'fish', 'completions');
    await mkdir(fishDir, { recursive: true });
    const fishPath = join(fishDir, 'sparecrow.fish');
    await writeFile(
      fishPath,
      '# sparecrow shell completions \u2014 auto-installed\ncomplete -c sparecrow -f\n# end sparecrow shell completions\n',
      'utf-8',
    );

    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('fish', 'complete -c sparecrow -f');
    expect(result.installed).toBe(false);
    expect(result.alreadyInstalled).toBe(true);
  });

  it('returns installed false for unknown shell', async () => {
    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('unknown');
    expect(result.installed).toBe(false);
    expect(result.path).toBeNull();
  });

  it('creates rc file if it does not exist for bash', async () => {
    const mod = await import('./shell-completions.js');
    const result = await mod.installCompletions('bash');
    expect(result.installed).toBe(true);

    const rcPath = join(tmpDir, '.bashrc');
    const content = await readFile(rcPath, 'utf-8');
    expect(content).toContain('sparecrow completions bash');
  });
});

describe('uninstallCompletions()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scrow-completions-' + randomBytes(6).toString('hex')));
    vi.resetModules();
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => tmpDir };
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('removes bash completions block from rc file', async () => {
    const rcPath = join(tmpDir, '.bashrc');
    const content =
      '# before\n# sparecrow shell completions \u2014 auto-installed\neval "$(sparecrow completions bash)"\n# end sparecrow shell completions\n# after\n';
    await writeFile(rcPath, content, 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.uninstallCompletions('bash');
    expect(result.uninstalled).toBe(true);

    const remaining = await readFile(rcPath, 'utf-8');
    expect(remaining).not.toContain('sparecrow shell completions');
    expect(remaining).toContain('# before');
    expect(remaining).toContain('# after');
  });

  it('leaves no trailing blank line after uninstall', async () => {
    const rcPath = join(tmpDir, '.bashrc');
    const content =
      '# before\n# sparecrow shell completions \u2014 auto-installed\neval "$(sparecrow completions bash)"\n# end sparecrow shell completions\n# after\n';
    await writeFile(rcPath, content, 'utf-8');

    const mod = await import('./shell-completions.js');
    await mod.uninstallCompletions('bash');

    const remaining = await readFile(rcPath, 'utf-8');
    // Should not have consecutive blank lines or trailing blank line from uninstall
    expect(remaining).toBe('# before\n# after\n');
  });

  it('returns uninstalled false when no marker found', async () => {
    const rcPath = join(tmpDir, '.bashrc');
    await writeFile(rcPath, '# just normal stuff\n', 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.uninstallCompletions('bash');
    expect(result.uninstalled).toBe(false);
  });

  it('deletes fish completion file', async () => {
    const fishDir = join(tmpDir, '.config', 'fish', 'completions');
    await mkdir(fishDir, { recursive: true });
    const fishPath = join(fishDir, 'sparecrow.fish');
    await writeFile(fishPath, 'complete -c sparecrow -f\n', 'utf-8');

    const mod = await import('./shell-completions.js');
    const result = await mod.uninstallCompletions('fish');
    expect(result.uninstalled).toBe(true);
  });

  it('returns uninstalled false for unknown shell', async () => {
    const mod = await import('./shell-completions.js');
    const result = await mod.uninstallCompletions('unknown');
    expect(result.uninstalled).toBe(false);
    expect(result.path).toBeNull();
  });

  it('returns uninstalled false when rc file does not exist', async () => {
    const mod = await import('./shell-completions.js');
    const result = await mod.uninstallCompletions('zsh');
    expect(result.uninstalled).toBe(false);
  });

  it('returns uninstalled false when fish file does not exist', async () => {
    const mod = await import('./shell-completions.js');
    const result = await mod.uninstallCompletions('fish');
    expect(result.uninstalled).toBe(false);
  });
});
