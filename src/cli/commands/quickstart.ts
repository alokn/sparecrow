/** Quickstart command — run a single template task inline with zero configuration. */
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { logger, spawnWithGuardrails } from '../../utils/index.js';
import { loadBuiltins, resolveTemplate, CANONICAL_KEYS } from '../../templates/index.js';
import { detectClaudeBinary, validateAuth } from './onboard-auth.js';

/** Default template used when --template is not specified. */
const DEFAULT_TEMPLATE = 'security-audit';

/** Timeout for the quickstart task execution (10 minutes). */
const QUICKSTART_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Checks whether a directory is a git repository by looking for a .git directory or file.
 * Returns 'not-found' when the path does not exist, 'not-repo' when path exists but has no
 * .git entry, and 'repo' when a .git directory or file is present.
 * Uses stat() rather than spawning git to avoid requiring git on PATH.
 */
export async function checkGitRepo(dir: string): Promise<'repo' | 'not-repo' | 'not-found'> {
  try {
    await stat(resolve(dir));
  } catch {
    return 'not-found';
  }
  try {
    const info = await stat(resolve(dir, '.git'));
    return info.isDirectory() || info.isFile() ? 'repo' : 'not-repo';
  } catch {
    return 'not-repo';
  }
}

/**
 * Checks whether a directory is a git repository.
 * Returns true when a .git directory or file is present, false otherwise.
 * For more detailed status, use checkGitRepo().
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const status = await checkGitRepo(dir);
  return status === 'repo';
}

export function registerQuickstart(program: Command): void {
  program
    .command('quickstart')
    .description('run a single task immediately with zero configuration')
    .argument('[path]', 'path to a git repository (defaults to current directory)')
    .option(
      '-t, --template <name>',
      `template to run (default: ${DEFAULT_TEMPLATE}). Available: ${CANONICAL_KEYS.join(', ')}`,
    )
    .action(async (pathArg: string | undefined, opts: { template?: string }) => {
      const templateName = opts.template ?? DEFAULT_TEMPLATE;
      const targetPath = resolve(pathArg ?? '.');

      // AC1: Detect Claude binary
      const detection = await detectClaudeBinary();
      if (!detection.found || !detection.absolutePath) {
        throw new ScrowError(
          ErrorCode.CLAUDE_NOT_FOUND,
          'Claude Code not found on PATH. Install from https://claude.ai/download',
        );
      }

      // AC2: Validate auth — always throw on failure so callers get a non-zero exit code
      const authResult = await validateAuth(detection.absolutePath);
      if (!authResult.valid) {
        throw new ScrowError(
          ErrorCode.AUTH_TOKEN_MISSING,
          'Claude Code not authenticated. Run: claude auth login',
        );
      }

      // AC3: Check git repo — distinguish missing path from non-git path
      const repoStatus = await checkGitRepo(targetPath);
      if (repoStatus === 'not-found') {
        throw new ScrowError(ErrorCode.NOT_GIT_REPO, `Path not found: '${targetPath}'`);
      }
      if (repoStatus === 'not-repo') {
        if (pathArg !== undefined) {
          // User explicitly specified a path that isn't a repo
          throw new ScrowError(ErrorCode.NOT_GIT_REPO, `'${targetPath}' is not a git repository.`);
        }
        // No path arg and cwd isn't a repo — suggest providing a path
        throw new ScrowError(
          ErrorCode.NOT_GIT_REPO,
          'No git repo detected in current directory. Specify a path: sparecrow quickstart /path/to/repo',
        );
      }

      // AC4: Resolve template
      const builtins = await loadBuiltins();
      const template = resolveTemplate(templateName, builtins);

      // AC1: Execute inline using claude --print with prompt delivered via stdin (Story 22.2)
      if (!isJsonMode()) {
        process.stderr.write(`Running '${template.name}' against ${targetPath}...\n`);
      }

      void logger.info('quickstart.execute', {
        template: template.name,
        targetPath,
      });

      const timeoutMinutes = Math.round(QUICKSTART_TIMEOUT_MS / 60_000);
      const result = await spawnWithGuardrails(detection.absolutePath, ['--print'], {
        cwd: targetPath,
        timeoutMs: QUICKSTART_TIMEOUT_MS,
        stdinData: template.prompt,
      });

      if (result.timedOut) {
        throw new ScrowError(
          ErrorCode.QUICKSTART_EXECUTION_FAILED,
          `Task timed out after ${timeoutMinutes} minutes.`,
        );
      }

      if (result.enoent) {
        throw new ScrowError(
          ErrorCode.CLAUDE_NOT_FOUND,
          `Claude binary not accessible at '${detection.absolutePath}'.`,
        );
      }

      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || 'unknown error';
        throw new ScrowError(
          ErrorCode.QUICKSTART_EXECUTION_FAILED,
          `Task failed (exit code ${result.exitCode}): ${detail}`,
        );
      }

      // AC1/AC5: Display results
      if (isJsonMode()) {
        printJson(
          jsonOk({
            template: template.name,
            targetPath,
            output: result.stdout,
          }),
        );
        return;
      }

      process.stdout.write(result.stdout);

      // AC5: Follow-up hint
      process.stderr.write(
        '\nLike what you see? Run `sparecrow onboard` to set up automatic background dispatch.\n',
      );
    });
}
