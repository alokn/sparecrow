/** Man command — display the sparecrow manual page directly in the terminal. */
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ErrorCode, ScrowError, getErrorMessage } from '../../errors/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Candidate paths for the man page file relative to this module. */
const MAN_PAGE_CANDIDATES = [
  // Production bundle: dist/sparecrow.1 (man.ts is in dist/)
  join(__dirname, 'sparecrow.1'),
  // Development (tsx): src/cli/commands/ -> dist/sparecrow.1
  join(__dirname, '..', '..', '..', 'dist', 'sparecrow.1'),
  // Fallback: man page source markdown in docs/
  join(__dirname, '..', '..', '..', 'docs', 'sparecrow.1.md'),
];

/** Attempt to locate and read the man page content. */
export async function findManPage(): Promise<{ content: string; path: string } | null> {
  for (const candidate of MAN_PAGE_CANDIDATES) {
    try {
      const content = await readFile(candidate, 'utf-8');
      return { content, path: candidate };
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/** Display content through a pager (less) if available, otherwise write to stdout. */
export function displayPaged(content: string): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdout.isTTY) {
      process.stdout.write(content);
      resolve();
      return;
    }

    const pager = spawn('less', ['-R'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    let settled = false;

    pager.on('error', () => {
      // less not available — write directly; guard against double-resolve when
      // Node fires both 'error' and 'close' in sequence for a spawn failure.
      if (!settled) {
        settled = true;
        process.stdout.write(content);
        resolve();
      }
    });

    pager.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    if (pager.stdin !== null) {
      pager.stdin.write(content);
      pager.stdin.end();
    }
  });
}

/** Strip basic roff formatting for plain text display. */
export function stripRoff(roff: string): string {
  return (
    roff
      .replace(/^\.TH\s+.*$/m, '')
      .replace(/^\.SH\s+"?([^"]*)"?\s*$/gm, '\n$1\n' + '='.repeat(40))
      .replace(/^\.SS\s+"?([^"]*)"?\s*$/gm, '\n  $1\n  ' + '-'.repeat(30))
      .replace(/^\.IP\s+.*$/gm, '  *')
      .replace(/^\.RS\s*.*$/gm, '')
      .replace(/^\.RE\s*$/gm, '')
      .replace(/^\.P\s*$/gm, '')
      .replace(/^\.br\s*$/gm, '')
      .replace(/^\.nf\s*$/gm, '')
      .replace(/^\.fi\s*$/gm, '')
      .replace(/\\fB([^\\]*)\\fR/g, '$1')
      .replace(/\\fB([^\\]*)\\fP/g, '$1')
      .replace(/\\fI([^\\]*)\\fR/g, '$1')
      .replace(/\\fI([^\\]*)\\fP/g, '$1')
      .replace(/\\\|/g, '')
      .replace(/\\\./g, '.')
      .replace(/\\-/g, '-')
      .replace(/\\'/g, "'")
      .replace(/\\`/g, '`')
      .replace(/\\&/g, '')
      .replace(/\\"/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

export function registerMan(program: Command): void {
  program
    .command('man')
    .description('display the sparecrow manual page')
    .action(async () => {
      const result = await findManPage();

      if (!result) {
        const err = new ScrowError(ErrorCode.MAN_PAGE_NOT_FOUND, 'Man page file not found.');
        const { userMessage, suggestion } = getErrorMessage(err.code);
        if (isJsonMode()) {
          printJson(jsonError(err.code, userMessage));
          process.exitCode = 1;
          return;
        }
        process.stderr.write(`error: ${userMessage}\n  → ${suggestion}\n`);
        process.exitCode = 1;
        return;
      }

      const { content, path } = result;

      // If JSON mode, return the raw content
      if (isJsonMode()) {
        printJson(jsonOk({ path, content }));
        return;
      }

      // If the file is roff format, strip formatting for terminal display
      const isRoff = path.endsWith('.1');
      const displayContent = isRoff ? stripRoff(content) : content;

      await displayPaged(displayContent);
    });
}
