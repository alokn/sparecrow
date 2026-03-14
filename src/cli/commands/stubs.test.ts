/** Unit tests for remaining CLI command stubs — verifies each action writes expected output. */
// Note: registerQueue() is no longer a stub — see queue.test.ts for coverage.
// Note: registerTemplates() is no longer a stub — see templates.test.ts for coverage.
// Note: registerDaemon() is no longer a stub — see daemon.test.ts for coverage.
// Note: registerOnboard() is no longer a stub — see onboard.test.ts for coverage.
// Note: registerDoctor() is no longer a stub — see doctor.test.ts for coverage.
// Note: registerReport() is no longer a stub — see report.test.ts for coverage.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

describe('command stubs — JSON mode', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../index.js', () => ({ isJsonMode: () => true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function parseJsonOutput(): { ok: boolean; data: unknown; error: unknown } {
    return JSON.parse(stdoutOutput) as { ok: boolean; data: unknown; error: unknown };
  }

  it('logs outputs valid JSON wrapper', async () => {
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs']);
    const parsed = parseJsonOutput();
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
  });

  // Note: daemon JSON output tested in daemon.test.ts with proper mocking
  // Note: onboard JSON output tested in onboard.test.ts (returns error JSON in JSON mode)
  // Note: doctor JSON output tested in doctor.test.ts with proper mocking
});
