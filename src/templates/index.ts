/** Template loader, resolver, and listing API for built-in and custom templates. */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { TemplateSchema } from './schema.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { logger, findClosestMatch } from '../utils/index.js';
import type { ActionType } from '../types/index.js';

/** Canonical built-in template keys in stable listing order (AC10, updated in Story 13.3). */
export const CANONICAL_KEYS = [
  'fix-bugs',
  'improve-code',
  'write-tests',
  'security-audit',
] as const;

export type CanonicalKey = (typeof CANONICAL_KEYS)[number];

/**
 * Set of active (branch-creating) template names.
 * Active templates instruct Claude to create a branch and commit changes.
 * Passive templates (security-audit) are read-only and produce no branch.
 */
export const ACTIVE_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  'fix-bugs',
  'improve-code',
  'write-tests',
]);

/**
 * Regex matching a sparecrow branch name in active template stdout.
 * Format: sparecrow/<template>-<YYYYMMDDTHHMMssZ>
 * Example: sparecrow/fix-bugs-20260304T143000Z
 */
const BRANCH_PATTERN = /sparecrow\/[\w-]+-\d{8}T\d{6}Z/;

/**
 * Extracts the branch name created by an active template from task stdout.
 * Searches for the first occurrence of the sparecrow branch naming pattern.
 * Returns null if no matching branch name is found (e.g. passive template or failed task).
 */
export function extractBranchFromStdout(stdout: string): string | null {
  const match = BRANCH_PATTERN.exec(stdout);
  return match ? match[0] : null;
}

/**
 * Backward-compatible aliases mapping old template names to new canonical names (Story 13.3 AC3).
 * Old names continue to resolve but emit a deprecation warning to stderr.
 */
export const TEMPLATE_ALIASES: ReadonlyMap<string, CanonicalKey> = new Map([
  ['bug-hunter', 'fix-bugs'],
  ['code-review', 'improve-code'],
  ['test-generation', 'write-tests'],
  ['security-review', 'security-audit'],
]);

/** A resolved template ready for use by the CLI or dispatcher. */
export interface Template {
  name: string;
  description: string;
  prompt: string;
  type: 'built-in' | 'custom';
  /** Optional timeout in minutes for tasks created from this template. */
  timeoutMinutes?: number;
  /**
   * Declared action types this template may request post-execution.
   * Always present (never undefined); defaults to [] (empty — opt-in).
   * Only actions in this list are permitted by the executor.
   */
  actions: ReadonlyArray<ActionType>;
}

/**
 * Resolves the built-in templates directory from a module URL.
 * Accepts a moduleUrl parameter to allow unit testing of path resolution
 * without requiring a real build (AC13 unit seam).
 */
export function getBuiltinDir(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'builtin');
}

/** Loads and validates all four built-in templates in canonical order. */
export async function loadBuiltins(): Promise<Template[]> {
  const builtinDir = getBuiltinDir(import.meta.url);
  const templates: Template[] = [];
  const seenKeys = new Set<string>();

  for (const key of CANONICAL_KEYS) {
    const filePath = join(builtinDir, `${key}.yaml`);

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new ScrowError(
        ErrorCode.TEMPLATE_LOAD_ERROR,
        `Failed to load built-in template file: ${filePath}`,
        err instanceof Error ? err : undefined,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new ScrowError(
        ErrorCode.TEMPLATE_INVALID,
        `Malformed YAML in template file: ${filePath}`,
        err instanceof Error ? err : undefined,
      );
    }

    const result = TemplateSchema.safeParse(parsed);
    if (!result.success) {
      throw new ScrowError(
        ErrorCode.TEMPLATE_INVALID,
        `Template file failed schema validation: ${filePath} — ${result.error.message}`,
      );
    }

    const { name, description, prompt } = result.data;

    if (seenKeys.has(name)) {
      throw new ScrowError(
        ErrorCode.TEMPLATE_DUPLICATE_KEY,
        `Duplicate template key detected: '${name}'`,
      );
    }
    seenKeys.add(name);

    if (name !== key) {
      throw new ScrowError(
        ErrorCode.TEMPLATE_INVALID,
        `Template file '${key}.yaml' declares name '${name}' — filename and declared name must match.`,
      );
    }

    templates.push({
      name,
      description,
      prompt,
      type: 'built-in',
      actions: result.data.actions ?? [],
      ...(result.data.timeout_minutes !== undefined
        ? { timeoutMinutes: result.data.timeout_minutes }
        : {}),
    });
  }

  return templates;
}

/**
 * Resolves a deprecated alias to its canonical name and emits a structured deprecation warning.
 * Returns the canonical name for the alias, or the original key if it is not an alias.
 */
export function resolveAlias(key: string): { resolved: string } {
  const canonical = TEMPLATE_ALIASES.get(key);
  if (canonical) {
    void logger.warn('template.deprecated_alias', {
      alias: key,
      canonical,
      hint: `Update your config to use '${canonical}' instead of '${key}'.`,
    });
    return { resolved: canonical };
  }
  return { resolved: key };
}

/**
 * Resolves a template by canonical key from a list.
 * Supports backward-compatible aliases with deprecation warnings (Story 13.3 AC3).
 * Throws TEMPLATE_NOT_FOUND with a list of valid options if not found (AC9, FR28).
 * Error message always reports the original user-typed key so error output is not confusing.
 * @internal Used by the templates module internally; production callers use resolveTemplateOrCustom.
 */
export function resolveTemplate(key: string, available: Template[]): Template {
  const { resolved } = resolveAlias(key);
  const template = available.find((t) => t.name === resolved);
  if (!template) {
    const names = available.map((t) => t.name);
    const closest = findClosestMatch(key, names);
    const hint = closest ? `Did you mean: ${closest}?` : `Available templates: ${names.join(', ')}`;
    throw new ScrowError(ErrorCode.TEMPLATE_NOT_FOUND, `Template '${key}' not found. ${hint}`);
  }
  return template;
}

/** Discriminated result from resolveTemplateOrCustom. */
export type ResolveResult =
  | { type: 'built-in'; template: Template }
  | { type: 'custom'; name: string; prompt: string; actions: ReadonlyArray<ActionType> };

/**
 * Resolves a --template <name> argument against built-in templates and config custom tasks.
 * Built-ins are checked first (canonical order); then config custom tasks in definition order.
 * Supports backward-compatible aliases with deprecation warnings (Story 13.3 AC4).
 * Throws TEMPLATE_NOT_FOUND if not found in either list (AC15, Task 3.4).
 * Error message always reports the original user-typed name so error output is not confusing.
 */
export function resolveTemplateOrCustom(
  name: string,
  builtins: Template[],
  customTasks: ReadonlyArray<{ name: string; prompt: string }>,
): ResolveResult {
  const { resolved } = resolveAlias(name);

  const builtinMatch = builtins.find((t) => t.name === resolved);
  if (builtinMatch) {
    return { type: 'built-in', template: builtinMatch };
  }

  const customMatch = customTasks.find((t) => t.name === resolved);
  if (customMatch) {
    return {
      type: 'custom',
      name: customMatch.name,
      prompt: customMatch.prompt,
      actions: [],
    };
  }

  const allNames = [...builtins.map((t) => t.name), ...customTasks.map((t) => t.name)];
  const closest = findClosestMatch(name, allNames);
  const hint = closest ? `Did you mean: ${closest}?` : `Available: ${allNames.join(', ')}`;
  throw new ScrowError(ErrorCode.TEMPLATE_NOT_FOUND, `Template '${name}' not found. ${hint}`);
}
