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

  describe('unknown shell', () => {
    it('writes error to stderr for unsupported shell', async () => {
      await program.parseAsync(['node', 'sparecrow', 'completions', 'powershell']);
      expect(stderrOutput).toContain('powershell');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
