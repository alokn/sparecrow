/** Unit tests for the shell completion script generator. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerStatus } from './status.js';
import { registerQueue } from './queue.js';
import { registerLogs } from './logs.js';
import { registerConfig } from './config.js';
import { registerDaemon } from './daemon.js';
import { registerDoctor } from './doctor.js';
import { registerOnboard } from './onboard.js';
import { registerTemplates } from './templates.js';
import { registerReport } from './report.js';
import { registerCompletions } from './completions.js';

function makeFullProgram(): Command {
  const program = new Command();
  program.exitOverride();
  // Register all commands so completions can enumerate them from program.commands
  registerStatus(program);
  registerQueue(program);
  registerLogs(program);
  registerConfig(program);
  registerDaemon(program);
  registerDoctor(program);
  registerOnboard(program);
  registerTemplates(program);
  registerReport(program);
  registerCompletions(program);
  return program;
}

describe('registerCompletions()', () => {
  let program: Command;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    program = makeFullProgram();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('bash completion', () => {
    it('outputs a non-empty bash completion script', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'bash']);
      expect(stdoutOutput.trim()).not.toBe('');
    });

    it('includes all 9 commands in bash completion', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'bash']);
      const commands = [
        'status',
        'queue',
        'logs',
        'config',
        'daemon',
        'doctor',
        'onboard',
        'templates',
        'report',
      ];
      for (const cmd of commands) {
        expect(stdoutOutput).toContain(cmd);
      }
    });

    it('includes bash completion function definition', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'bash']);
      expect(stdoutOutput).toContain('_sparecrow_completions');
      expect(stdoutOutput).toContain('complete');
    });
  });

  describe('zsh completion', () => {
    it('outputs a non-empty zsh completion script', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'zsh']);
      expect(stdoutOutput.trim()).not.toBe('');
    });

    it('includes all 9 commands in zsh completion', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'zsh']);
      const commands = [
        'status',
        'queue',
        'logs',
        'config',
        'daemon',
        'doctor',
        'onboard',
        'templates',
        'report',
      ];
      for (const cmd of commands) {
        expect(stdoutOutput).toContain(cmd);
      }
    });

    it('includes zsh compdef directive', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'zsh']);
      expect(stdoutOutput).toContain('#compdef');
    });
  });

  describe('fish completion', () => {
    it('outputs a non-empty fish completion script', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'fish']);
      expect(stdoutOutput.trim()).not.toBe('');
    });

    it('includes all 9 commands in fish completion', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'fish']);
      const commands = [
        'status',
        'queue',
        'logs',
        'config',
        'daemon',
        'doctor',
        'onboard',
        'templates',
        'report',
      ];
      for (const cmd of commands) {
        expect(stdoutOutput).toContain(cmd);
      }
    });

    it('uses fish complete syntax', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'fish']);
      expect(stdoutOutput).toContain('complete -c sparecrow');
    });
  });

  describe('script syntax validation', () => {
    it('bash script contains function declaration and complete builtin', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'bash']);
      // Bash completion scripts must define a function and register it with `complete`
      expect(stdoutOutput).toContain('_sparecrow_completions()');
      expect(stdoutOutput).toContain('complete -F');
      expect(stdoutOutput).toContain('COMPREPLY');
      expect(stdoutOutput).toContain('COMP_WORDS');
    });

    it('zsh script contains compdef and _describe', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'zsh']);
      // Zsh completion scripts need #compdef directive and _describe call
      expect(stdoutOutput).toContain('#compdef');
      expect(stdoutOutput).toContain('_sparecrow');
      expect(stdoutOutput).toContain('_describe');
    });

    it('fish script uses complete -c syntax with subcommand flag', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'fish']);
      // Fish completion scripts use `complete -c <command>` syntax
      expect(stdoutOutput).toContain('complete -c sparecrow -f');
      expect(stdoutOutput).toContain('complete -c sparecrow -n');
      expect(stdoutOutput).toContain('__fish_use_subcommand');
    });

    it('fish script registers completions for both sparecrow and scrow aliases', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'fish']);
      expect(stdoutOutput).toContain('complete -c sparecrow -f');
      expect(stdoutOutput).toContain('complete -c scrow -f');
      expect(stdoutOutput).toContain('complete -c scrow -n');
    });

    it('bash script registers completions for both sparecrow and scrow', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'bash']);
      expect(stdoutOutput).toContain('complete -F _sparecrow_completions sparecrow');
      expect(stdoutOutput).toContain('complete -F _sparecrow_completions scrow');
    });

    it('zsh script registers compdef for both sparecrow and scrow', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'zsh']);
      expect(stdoutOutput).toMatch(/#compdef sparecrow scrow/);
    });
  });

  describe('unknown shell', () => {
    it('writes error to stderr for unsupported shell', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'powershell']);
      expect(stderrOutput).toContain('powershell');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});

// JSON mode tests — use vi.resetModules() + vi.doMock() to simulate isJsonMode() === true
describe('registerCompletions() --json mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
      isInteractive: () => false,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits JSON envelope with shell and script when isJsonMode returns true (bash)', async () => {
    const { registerCompletions: registerCompletionsJson } = await import('./completions.js');
    const cmd = new Command();
    cmd.exitOverride();
    registerCompletionsJson(cmd);

    let stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });

    await cmd.parseAsync(['node', 'sparecrow', 'completions', 'bash']);

    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['error']).toBeNull();
    const data = parsed['data'] as Record<string, unknown>;
    expect(data['shell']).toBe('bash');
    expect(typeof data['script']).toBe('string');
    expect((data['script'] as string).length).toBeGreaterThan(0);
  });

  it('emits JSON envelope with shell and script when isJsonMode returns true (zsh)', async () => {
    const { registerCompletions: registerCompletionsJson } = await import('./completions.js');
    const cmd = new Command();
    cmd.exitOverride();
    registerCompletionsJson(cmd);

    let stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });

    await cmd.parseAsync(['node', 'sparecrow', 'completions', 'zsh']);

    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['error']).toBeNull();
    const data = parsed['data'] as Record<string, unknown>;
    expect(data['shell']).toBe('zsh');
    expect(typeof data['script']).toBe('string');
  });

  it('emits JSON envelope with shell and script when isJsonMode returns true (fish)', async () => {
    const { registerCompletions: registerCompletionsJson } = await import('./completions.js');
    const cmd = new Command();
    cmd.exitOverride();
    registerCompletionsJson(cmd);

    let stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });

    await cmd.parseAsync(['node', 'sparecrow', 'completions', 'fish']);

    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['error']).toBeNull();
    const data = parsed['data'] as Record<string, unknown>;
    expect(data['shell']).toBe('fish');
    expect(typeof data['script']).toBe('string');
  });
});
