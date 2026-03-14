/** Shared repository path validation — resolves, checks existence, readability, and git status. */
import { resolve } from 'node:path';
import { stat, access, constants } from 'node:fs/promises';
import { spawnWithGuardrails } from './process.js';

/** Timeout in ms for git rev-parse validation subprocess. */
const GIT_CHECK_TIMEOUT_MS = 5000;

/** Result of repository path validation. */
export interface RepoValidationResult {
  valid: boolean;
  absolutePath: string;
  error: string | null;
}

/**
 * Validates that a path points to a readable git repository directory.
 * Returns a deterministic result with an actionable error message on failure.
 */
export async function validateRepository(inputPath: string): Promise<RepoValidationResult> {
  const absolutePath = resolve(inputPath);

  // 1. Check exists and is directory
  let info: import('node:fs').Stats;
  try {
    info = await stat(absolutePath);
  } catch {
    return { valid: false, absolutePath, error: 'Path does not exist' };
  }

  if (!info.isDirectory()) {
    return { valid: false, absolutePath, error: 'Path is not a directory' };
  }

  // 2. Check readable
  try {
    await access(absolutePath, constants.R_OK);
  } catch {
    return { valid: false, absolutePath, error: 'Path is not readable (permission denied)' };
  }

  // 3. Check git repository via git rev-parse
  const result = await spawnWithGuardrails('git', ['-C', absolutePath, 'rev-parse', '--git-dir'], {
    timeoutMs: GIT_CHECK_TIMEOUT_MS,
  });

  if (result.enoent) {
    return { valid: false, absolutePath, error: 'git is not installed or not in PATH' };
  }

  if (result.timedOut) {
    return {
      valid: false,
      absolutePath,
      error: 'git check timed out — path may be on a slow filesystem',
    };
  }

  if (result.exitCode !== 0) {
    return { valid: false, absolutePath, error: 'Not a git repository' };
  }

  return { valid: true, absolutePath, error: null };
}
