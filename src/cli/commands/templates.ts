/** Templates command — list available built-in and custom task templates. */
import type { Command } from 'commander';
import Table from 'cli-table3';
import { loadBuiltins } from '../../templates/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { getPaths } from '../../platform/index.js';
import { isJsonMode, getConfigPath } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError } from '../../errors/index.js';
import { logger } from '../../utils/index.js';

/** Renders templates as a CLI table string. */
function renderTable(entries: Array<{ name: string; type: string; description: string }>): string {
  const table = new Table({
    head: ['Template', 'Type', 'Description'],
    style: { head: [], border: [] },
  });
  for (const entry of entries) {
    table.push([entry.name, entry.type, entry.description]);
  }
  return table.toString();
}

export function registerTemplates(program: Command): void {
  program
    .command('templates')
    .description('list available task templates')
    .action(async () => {
      let builtins: Array<{ name: string; type: string; description: string }>;

      try {
        const loaded = await loadBuiltins();
        builtins = loaded.map((t) => ({ name: t.name, type: t.type, description: t.description }));
      } catch (err) {
        const code = err instanceof ScrowError ? err.code : 'TEMPLATE_LOAD_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        if (isJsonMode()) {
          printJson(jsonError(code, message));
          return;
        }
        process.stderr.write(`error: ${message}\n`);
        process.exitCode = 1;
        return;
      }

      // Load custom tasks from config (best-effort; missing config is not an error)
      let customEntries: Array<{ name: string; type: string; description: string }> = [];
      try {
        const config = await loadConfig(resolveConfigFilePath(getPaths().config, getConfigPath()));
        customEntries = config.tasks.map((t) => ({
          name: t.name,
          type: 'custom',
          description: t.prompt.slice(0, 60).trimEnd() + (t.prompt.length > 60 ? '…' : ''),
        }));
      } catch (err) {
        void logger.debug('templates.config.load.skipped', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      const allEntries = [...builtins, ...customEntries];

      if (isJsonMode()) {
        printJson(
          jsonOk({
            templates: allEntries,
            customCount: customEntries.length,
          }),
        );
        return;
      }

      process.stdout.write(renderTable(allEntries) + '\n');

      if (customEntries.length === 0) {
        process.stdout.write(
          'Hint: Add one to queue with `sparecrow queue add --template <name> --target <path>`.\n',
        );
      }
    });
}
