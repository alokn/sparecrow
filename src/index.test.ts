/** Unit tests for the CLI entry point: Node.js version gate message format and exit behavior. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Node.js version gate', () => {
  let originalVersions: NodeJS.ProcessVersions;
  let originalArgv: string[];

  beforeEach(() => {
    vi.resetModules();
    originalVersions = process.versions;
    originalArgv = process.argv;
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process, 'versions', { value: originalVersions, configurable: true });
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('writes version-gate message and exits with code 1 when Node.js major is below 22', async () => {
    Object.defineProperty(process, 'versions', {
      value: { ...process.versions, node: '18.20.4' },
      configurable: true,
    });

    // Dynamically import src/index.ts so the top-level version check runs with the mocked version
    await import('./index.js');

    const stderrOutput = vi.mocked(process.stderr.write).mock.calls.flat().join('');
    expect(stderrOutput).toContain('sparecrow requires Node.js >= 22');
    expect(stderrOutput).toContain('You are running Node.js 18.20.4');
    expect(stderrOutput).toContain('https://nodejs.org/');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not include stack trace markers in the version-gate message', async () => {
    Object.defineProperty(process, 'versions', {
      value: { ...process.versions, node: '16.0.0' },
      configurable: true,
    });

    await import('./index.js');

    const stderrOutput = vi.mocked(process.stderr.write).mock.calls.flat().join('');
    expect(stderrOutput).not.toMatch(/Error:/);
    expect(stderrOutput).not.toMatch(/at (Module|Object|Function)\./);
    expect(stderrOutput).not.toContain('.js:');
  });
});
