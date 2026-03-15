/** Shell completion script generator for bash, zsh, and fish. */
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk } from '../../types/index.js';

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

function buildFishCompletion(commands: Array<{ name: string; description: string }>): string {
  const lines = commands
    .map(
      (c) => `complete -c sparecrow -n '__fish_use_subcommand' -a ${c.name} -d '${c.description}'`,
    )
    .join('\n');
  return `complete -c sparecrow -f\n${lines}`;
}

export function registerCompletions(program: Command): void {
  program
    .command('completions <shell>')
    .description('generate shell completion script (bash | zsh | fish)')
    .action((shell: string) => {
      const commands = program.commands
        .filter((c) => c.name() !== 'completions')
        .map((c) => ({ name: c.name(), description: c.description() }));

      let script: string;
      if (shell === 'bash') {
        script = buildBashCompletion(commands.map((c) => c.name));
      } else if (shell === 'zsh') {
        script = buildZshCompletion(commands);
      } else if (shell === 'fish') {
        script = buildFishCompletion(commands);
      } else {
        process.stderr.write(`Unknown shell '${shell}'. Supported: bash, zsh, fish\n`);
        process.exit(1);
        return;
      }

      // When --json is passed, emit a JSON envelope wrapping the completion script.
      // This satisfies AC6: the output is a valid { ok, data, error } envelope.
      if (isJsonMode()) {
        printJson(jsonOk({ shell, script }));
        return;
      }
      process.stdout.write(script + '\n');
    });
}
