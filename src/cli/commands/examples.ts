/** Examples command — display categorised usage examples directly in the terminal. */
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson, getTokens } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';

/** A single CLI example entry. */
export interface Example {
  readonly title: string;
  readonly command: string;
  readonly description: string;
}

/** Category of examples with a human-readable label. */
export interface ExampleCategory {
  readonly key: string;
  readonly label: string;
  readonly examples: readonly Example[];
}

/** Built-in example categories. */
export const EXAMPLE_CATEGORIES: readonly ExampleCategory[] = [
  {
    key: 'getting-started',
    label: 'Getting Started',
    examples: [
      {
        title: 'Run a quick security audit',
        command: 'sparecrow quickstart /path/to/repo',
        description: 'Run a single template task inline with zero configuration.',
      },
      {
        title: 'Interactive onboarding',
        command: 'sparecrow onboard',
        description: 'Walk through auth validation, trigger config, and daemon setup.',
      },
      {
        title: 'Check current status',
        command: 'sparecrow status',
        description: 'View subscription usage, daemon state, and queue summary.',
      },
    ],
  },
  {
    key: 'queue',
    label: 'Queue Management',
    examples: [
      {
        title: 'Add a template task',
        command: 'sparecrow queue add --template security-audit --target /path/to/repo',
        description: 'Queue a built-in template task for background execution.',
      },
      {
        title: 'Add a custom prompt',
        command: 'sparecrow queue add --prompt "Review error handling" --target /path/to/repo',
        description: 'Queue a custom prompt for background execution.',
      },
      {
        title: 'List queued tasks',
        command: 'sparecrow queue list',
        description: 'Show all tasks in the queue with their status and priority.',
      },
      {
        title: 'Pause and resume the queue',
        command: 'sparecrow queue pause && sparecrow queue resume',
        description: 'Temporarily halt and restart task dispatch.',
      },
    ],
  },
  {
    key: 'config',
    label: 'Configuration',
    examples: [
      {
        title: 'Show current config',
        command: 'sparecrow config show',
        description: 'Display the active configuration file contents.',
      },
      {
        title: 'Set conservative polling',
        command: 'sparecrow config set polling_interval 600',
        description: 'Poll every 10 minutes to conserve resources.',
      },
      {
        title: 'Set task timeout',
        command: 'sparecrow config set task_timeout_minutes 30',
        description: 'Allow tasks up to 30 minutes before timing out.',
      },
    ],
  },
  {
    key: 'monitoring',
    label: 'Monitoring',
    examples: [
      {
        title: 'View execution logs',
        command: 'sparecrow logs',
        description: 'Display recent audit log entries.',
      },
      {
        title: 'Filter logs by failures',
        command: 'sparecrow logs --failures',
        description: 'Show only failed and retrying log entries.',
      },
      {
        title: 'View task results',
        command: 'sparecrow results',
        description: 'Display output artifacts from completed tasks.',
      },
      {
        title: 'Generate a usage report',
        command: 'sparecrow report',
        description: 'Show a summary of recent task execution and usage.',
      },
    ],
  },
];

/** Get all valid category keys. */
export function getCategoryKeys(): string[] {
  return EXAMPLE_CATEGORIES.map((c) => c.key);
}

/** Find a category by exact key or case-insensitive label match. */
export function findCategory(query: string): ExampleCategory | undefined {
  const lower = query.toLowerCase();
  return EXAMPLE_CATEGORIES.find((c) => c.key === lower || c.label.toLowerCase() === lower);
}

/** Format examples for terminal display. */
function formatExamples(categories: readonly ExampleCategory[]): string {
  const lines: string[] = [];
  for (const category of categories) {
    lines.push(`\n  ${category.label}`);
    lines.push(`  ${getTokens().DIVIDER_H.repeat(category.label.length)}`);
    for (const example of category.examples) {
      lines.push(`    ${example.title}`);
      lines.push(`      $ ${example.command}`);
      lines.push(`      ${example.description}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function registerExamples(program: Command): void {
  program
    .command('examples')
    .description('show usage examples and common workflows')
    .argument('[category]', 'filter by category (getting-started, queue, config, monitoring)')
    .action(async (categoryArg: string | undefined) => {
      if (categoryArg !== undefined) {
        const category = findCategory(categoryArg);
        if (!category) {
          const validKeys = getCategoryKeys().join(', ');
          if (isJsonMode()) {
            printJson(
              jsonError(
                'INVALID_CATEGORY',
                `Unknown category '${categoryArg}'. Available: ${validKeys}`,
              ),
            );
            process.exitCode = 1;
            return;
          }
          process.stderr.write(
            `Unknown category '${categoryArg}'. Available categories: ${validKeys}\n`,
          );
          process.exitCode = 1;
          return;
        }

        if (isJsonMode()) {
          printJson(jsonOk({ categories: [category] }));
          return;
        }

        process.stdout.write(formatExamples([category]) + '\n');
        return;
      }

      // No category filter — show all
      if (isJsonMode()) {
        printJson(jsonOk({ categories: EXAMPLE_CATEGORIES }));
        return;
      }

      process.stdout.write(formatExamples(EXAMPLE_CATEGORIES) + '\n');
    });
}
