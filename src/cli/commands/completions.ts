/** Shell completion script generator for bash, zsh, and fish with auto-install support. */
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import {
  detectShell,
  installCompletions,
  uninstallCompletions,
  buildFishCompletion,
} from './shell-completions.js';
import type { ShellType } from './shell-completions.js';

/** Known valid shell types for user-supplied arguments. */
const KNOWN_SHELLS: ShellType[] = ['bash', 'zsh', 'fish'];

function buildBashCompletion(commandNames: string[]): string {
  const commandList = commandNames.join(' ');
  return `_sparecrow_completions() {
  local commands="${commandList}"
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -F _sparecrow_completions sparecrow
complete -F _sparecrow_completions scrow`;
}

function buildZshCompletion(commands: Array<{ name: string; description: string }>): string {
  const entries = commands.map((c) => `    '${c.name}:${c.description}'`).join('\n');
  return `#compdef sparecrow scrow
_sparecrow() {
  local commands=(
${entries}
  )
  _describe 'commands' commands
}
_sparecrow`;
}

function buildCompletionScript(
  shell: string,
  commands: Array<{ name: string; description: string }>,
): string | null {
  if (shell === 'bash') {
    return buildBashCompletion(commands.map((c) => c.name));
  } else if (shell === 'zsh') {
    return buildZshCompletion(commands);
  } else if (shell === 'fish') {
    return buildFishCompletion(commands);
  }
  return null;
}

export function registerCompletions(program: Command): void {
  program
    .command('completions [shell]')
    .description('generate shell completion script (bash | zsh | fish)')
    .option('--install', 'install completions into your shell rc file')
    .option('--uninstall', 'remove completions from your shell rc file')
    .action(
      async (shellArg: string | undefined, opts: { install?: boolean; uninstall?: boolean }) => {
        const commands = program.commands
          .filter((c) => c.name() !== 'completions')
          .map((c) => ({ name: c.name(), description: c.description() }));

        // Handle --install
        if (opts.install) {
          const resolvedShell: ShellType = shellArg
            ? KNOWN_SHELLS.includes(shellArg as ShellType)
              ? (shellArg as ShellType)
              : 'unknown'
            : detectShell();
          if (resolvedShell === 'unknown') {
            if (isJsonMode()) {
              printJson(
                jsonError(
                  ErrorCode.COMPLETIONS_INSTALL_FAILED,
                  'Cannot detect shell. Specify one: sparecrow completions bash --install',
                ),
              );
              return;
            }
            throw new ScrowError(
              ErrorCode.COMPLETIONS_INSTALL_FAILED,
              `Cannot detect shell${shellArg ? ` (unknown: '${shellArg}')` : ''}. Specify one: sparecrow completions bash --install`,
            );
          }

          const shell = resolvedShell;
          const fishScript = shell === 'fish' ? buildFishCompletion(commands) : undefined;
          const result = await installCompletions(shell, fishScript);

          if (isJsonMode()) {
            printJson(jsonOk({ action: 'install', shell, ...result }));
            return;
          }

          if (result.alreadyInstalled) {
            process.stdout.write(`Shell completions already installed in ${result.path}\n`);
          } else if (result.installed) {
            process.stdout.write(
              `Shell completions installed for ${shell} in ${result.path}\n` +
                'Restart your shell or run: source ' +
                (result.path ?? '') +
                '\n',
            );
          } else {
            if (isJsonMode()) {
              printJson(
                jsonError(
                  ErrorCode.COMPLETIONS_INSTALL_FAILED,
                  `Failed to install completions for ${shell}`,
                ),
              );
              return;
            }
            throw new ScrowError(
              ErrorCode.COMPLETIONS_INSTALL_FAILED,
              `Failed to install completions for ${shell}`,
            );
          }
          return;
        }

        // Handle --uninstall
        if (opts.uninstall) {
          const resolvedUninstallShell: ShellType = shellArg
            ? KNOWN_SHELLS.includes(shellArg as ShellType)
              ? (shellArg as ShellType)
              : 'unknown'
            : detectShell();
          if (resolvedUninstallShell === 'unknown') {
            if (isJsonMode()) {
              printJson(
                jsonError(
                  ErrorCode.COMPLETIONS_INSTALL_FAILED,
                  'Cannot detect shell. Specify one: sparecrow completions bash --uninstall',
                ),
              );
              return;
            }
            throw new ScrowError(
              ErrorCode.COMPLETIONS_INSTALL_FAILED,
              `Cannot detect shell${shellArg ? ` (unknown: '${shellArg}')` : ''}. Specify one: sparecrow completions bash --uninstall`,
            );
          }
          const shell = resolvedUninstallShell;

          const result = await uninstallCompletions(shell);

          if (isJsonMode()) {
            printJson(jsonOk({ action: 'uninstall', shell, ...result }));
            return;
          }

          if (result.uninstalled) {
            process.stdout.write(`Shell completions removed from ${result.path}\n`);
          } else {
            process.stdout.write(`No completions found to remove for ${shell}\n`);
          }
          return;
        }

        // Default: print completion script (original behavior)
        if (!shellArg) {
          // If no shell specified and no flags, show help
          const detected = detectShell();
          const hint = detected !== 'unknown' ? ` (detected: ${detected})` : '';
          process.stderr.write(
            `Usage: sparecrow completions <shell>${hint}\n` +
              '  Shells: bash, zsh, fish\n' +
              '  Flags:  --install   auto-install to rc file\n' +
              '          --uninstall remove from rc file\n' +
              `\n  Tip: sparecrow completions --install${detected !== 'unknown' ? ' (auto-detects ' + detected + ')' : ''}\n`,
          );
          process.exit(1);
          return;
        }

        const script = buildCompletionScript(shellArg, commands);
        if (!script) {
          process.stderr.write(`Unknown shell '${shellArg}'. Supported: bash, zsh, fish\n`);
          process.exit(1);
          return;
        }

        if (isJsonMode()) {
          printJson(jsonOk({ shell: shellArg, script }));
          return;
        }
        process.stdout.write(script + '\n');
      },
    );
}
