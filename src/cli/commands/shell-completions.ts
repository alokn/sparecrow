/** Shell completion auto-install and uninstall utilities. */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../../utils/index.js';

export type ShellType = 'bash' | 'zsh' | 'fish' | 'unknown';

/** Build the fish completion script for sparecrow and scrow aliases. */
export function buildFishCompletion(
  commands: Array<{ name: string; description: string }>,
): string {
  const sparecrowLines = commands
    .map(
      (c) => `complete -c sparecrow -n '__fish_use_subcommand' -a ${c.name} -d '${c.description}'`,
    )
    .join('\n');
  const scrowLines = commands
    .map((c) => `complete -c scrow -n '__fish_use_subcommand' -a ${c.name} -d '${c.description}'`)
    .join('\n');
  return `complete -c sparecrow -f\ncomplete -c scrow -f\n${sparecrowLines}\n${scrowLines}`;
}

/** The marker comment surrounding the sourced completion line in rc files. */
const MARKER_START = '# sparecrow shell completions — auto-installed';
const MARKER_END = '# end sparecrow shell completions';

/**
 * Detect the user's shell from $SHELL environment variable.
 */
export function detectShell(): ShellType {
  const shell = process.env['SHELL'] ?? '';
  if (shell.endsWith('/bash') || shell === 'bash') return 'bash';
  if (shell.endsWith('/zsh') || shell === 'zsh') return 'zsh';
  if (shell.endsWith('/fish') || shell === 'fish') return 'fish';
  return 'unknown';
}

/**
 * Returns the rc file path for the given shell.
 */
export function getRcFilePath(shell: ShellType): string | null {
  const home = homedir();
  if (shell === 'bash') return join(home, '.bashrc');
  if (shell === 'zsh') return join(home, '.zshrc');
  if (shell === 'fish') return join(home, '.config', 'fish', 'completions', 'sparecrow.fish');
  return null;
}

/**
 * Build the block that gets appended to bash/zsh rc files.
 */
function buildRcBlock(shell: 'bash' | 'zsh'): string {
  return `\n${MARKER_START}\neval "$(sparecrow completions ${shell})"\n${MARKER_END}\n`;
}

/**
 * Check if completions are already installed in the given rc file content.
 */
export function isAlreadyInstalled(rcContent: string): boolean {
  return rcContent.includes(MARKER_START);
}

/**
 * Install shell completions for bash or zsh by appending to rc file,
 * or for fish by writing to the fish completions directory.
 *
 * Returns an object describing the result.
 */
export async function installCompletions(
  shell: ShellType,
  fishCompletionScript?: string,
): Promise<{ installed: boolean; alreadyInstalled: boolean; path: string | null }> {
  const rcPath = getRcFilePath(shell);
  if (!rcPath) {
    return { installed: false, alreadyInstalled: false, path: null };
  }

  if (shell === 'fish') {
    // Fish: write the completion script directly to the completions directory
    const dir = dirname(rcPath);
    await mkdir(dir, { recursive: true });

    // Check if file already has our content using the dedicated marker
    try {
      const existing = await readFile(rcPath, 'utf-8');
      if (existing.includes(MARKER_START)) {
        return { installed: false, alreadyInstalled: true, path: rcPath };
      }
    } catch {
      // File doesn't exist — proceed
    }

    if (!fishCompletionScript) {
      return { installed: false, alreadyInstalled: false, path: rcPath };
    }

    await writeFile(rcPath, `${MARKER_START}\n${fishCompletionScript}\n${MARKER_END}\n`, 'utf-8');
    void logger.info('completions.install', { shell, path: rcPath });
    return { installed: true, alreadyInstalled: false, path: rcPath };
  }

  // Bash / Zsh: append sourcing block to rc file
  let existing = '';
  try {
    existing = await readFile(rcPath, 'utf-8');
  } catch {
    // File doesn't exist — will create
  }

  if (isAlreadyInstalled(existing)) {
    return { installed: false, alreadyInstalled: true, path: rcPath };
  }

  const block = buildRcBlock(shell as 'bash' | 'zsh');
  await writeFile(rcPath, existing + block, 'utf-8');
  void logger.info('completions.install', { shell, path: rcPath });
  return { installed: true, alreadyInstalled: false, path: rcPath };
}

/**
 * Uninstall shell completions by removing the marker block from the rc file,
 * or deleting the fish completion file.
 */
export async function uninstallCompletions(
  shell: ShellType,
): Promise<{ uninstalled: boolean; path: string | null }> {
  const rcPath = getRcFilePath(shell);
  if (!rcPath) {
    return { uninstalled: false, path: null };
  }

  if (shell === 'fish') {
    try {
      await unlink(rcPath);
      void logger.info('completions.uninstall', { shell, path: rcPath });
      return { uninstalled: true, path: rcPath };
    } catch {
      return { uninstalled: false, path: rcPath };
    }
  }

  // Bash / Zsh: remove the marker block
  let existing = '';
  try {
    existing = await readFile(rcPath, 'utf-8');
  } catch {
    return { uninstalled: false, path: rcPath };
  }

  const startIdx = existing.indexOf(MARKER_START);
  if (startIdx === -1) {
    return { uninstalled: false, path: rcPath };
  }

  const endIdx = existing.indexOf(MARKER_END, startIdx);
  if (endIdx === -1) {
    return { uninstalled: false, path: rcPath };
  }

  // The block was inserted as: \nMARKER_START\n...\nMARKER_END\n
  // Strip the leading \n (before MARKER_START) and the trailing \n (after MARKER_END).
  // Only one of these should be removed to preserve content separation.
  const leadingNewline = startIdx > 0 && existing[startIdx - 1] === '\n';
  const before = leadingNewline ? existing.slice(0, startIdx - 1) : existing.slice(0, startIdx);
  const afterStart = endIdx + MARKER_END.length;
  // If we consumed the leading \n, keep the trailing \n so content after the block
  // remains on its own line. If there was no leading \n, consume the trailing \n instead.
  const after = leadingNewline
    ? existing.slice(afterStart)
    : existing[afterStart] === '\n'
      ? existing.slice(afterStart + 1)
      : existing.slice(afterStart);
  await writeFile(rcPath, before + after, 'utf-8');
  void logger.info('completions.uninstall', { shell, path: rcPath });
  return { uninstalled: true, path: rcPath };
}
