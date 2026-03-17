/** Writes task result artifacts as markdown files into the target repo's .scrow/ directory. */
import { join, relative } from 'node:path';
import { mkdir, readFile, access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { atomicWrite, validateSlug, logger } from '../utils/index.js';
import { EventName } from '../types/index.js';
import type { TaskDefinition, TaskResult } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';

/** Directory name for result artifacts inside target repos. */
export const SCROW_DIR = '.scrow';

/** Input required to write a result artifact. */
export interface ResultArtifactInput {
  task: TaskDefinition;
  result: TaskResult;
  /** Branch name for active templates, null for passive templates. */
  branch: string | null;
}

/** Output returned after writing a result artifact. */
export interface ResultArtifactOutput {
  /** Absolute path to the written result file. */
  filePath: string;
  /** Path relative to $HOME (or absolute if outside $HOME). */
  relativePath: string;
}

/**
 * Formats an ISO 8601 timestamp for use in filenames.
 * Replaces colons with hyphens and removes milliseconds.
 * Example: "2026-03-04T14:30:00.000Z" -> "2026-03-04T14-30-00Z"
 */
export function formatTimestamp(date: Date): string {
  const iso = date.toISOString();
  // Remove milliseconds and replace colons with hyphens
  return iso.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Builds the result artifact filename.
 * Format: <timestamp>-<template-slug>-<short-task-id>.md
 */
export function buildFilename(completedAt: Date, templateSlug: string, taskId: string): string {
  validateSlug(templateSlug);
  const timestamp = formatTimestamp(completedAt);
  const shortId = taskId.substring(0, 7);
  return `${timestamp}-${templateSlug}-${shortId}.md`;
}

/**
 * Builds YAML frontmatter with exactly 7 fields, all always present.
 * Fields: task_id, template, repo, dispatched_at, completed_at, exit_code, branch
 */
export function buildFrontmatter(input: ResultArtifactInput): string {
  const shortId = input.task.id.substring(0, 7);
  const templateName = input.task.templateName ?? input.task.name;
  const exitCode = input.result.exitCode ?? 1;
  const branchValue = input.branch === null ? 'null' : input.branch;

  const lines = [
    '---',
    `task_id: "${shortId}"`,
    `template: "${templateName}"`,
    `repo: "${input.task.targetPath}"`,
    `dispatched_at: "${input.task.createdAt.toISOString()}"`,
    `completed_at: "${input.result.completedAt.toISOString()}"`,
    `exit_code: ${exitCode}`,
    `branch: ${input.branch === null ? 'null' : `"${branchValue}"`}`,
    '---',
  ];

  return lines.join('\n');
}

/**
 * Builds the complete result file content: frontmatter + raw stdout body.
 */
export function buildResultContent(input: ResultArtifactInput): string {
  const frontmatter = buildFrontmatter(input);
  const body = input.result.stdout || '';
  return `${frontmatter}\n\n${body}`;
}

/**
 * Ensures the .gitignore in the target repo contains `.scrow/`.
 * - If .gitignore exists and doesn't contain `.scrow/` or `.scrow`, appends `.scrow/`
 * - If .gitignore doesn't exist, creates one containing only `.scrow/`
 * - If .gitignore already contains the pattern, does nothing
 *
 * This runs before the result file write (atomic ordering per AC4).
 */
export async function ensureGitignore(repoPath: string): Promise<boolean> {
  const gitignorePath = join(repoPath, '.gitignore');
  let exists = true;

  try {
    await access(gitignorePath);
  } catch {
    exists = false;
  }

  if (exists) {
    const content = await readFile(gitignorePath, 'utf-8');
    // Check if .scrow/ or .scrow is already in the gitignore
    const lines = content.split('\n');
    const alreadyPresent = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed === '.scrow/' || trimmed === '.scrow';
    });

    if (alreadyPresent) {
      return false;
    }

    // Append .scrow/ with a preceding newline — use atomic write for crash safety
    const suffix = content.endsWith('\n') ? '.scrow/\n' : '\n.scrow/\n';
    await atomicWrite(gitignorePath, content + suffix);
    void logger.info('result-writer.gitignore-updated', { repoPath, action: 'appended' });
    return true;
  }

  // No .gitignore exists — create one with atomic write for crash safety
  await atomicWrite(gitignorePath, '.scrow/\n');
  void logger.info('result-writer.gitignore-updated', { repoPath, action: 'created' });
  return true;
}

/**
 * Returns a path relative to $HOME when possible, absolute otherwise.
 */
export function toRelativePath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath.startsWith(home)) {
    return '~/' + relative(home, absolutePath);
  }
  return absolutePath;
}

/**
 * Formats a dispatch notification string for TTY output or audit logging.
 */
export function formatDispatchNotification(input: ResultArtifactInput, resultPath: string): string {
  const templateName = input.task.templateName ?? input.task.name;
  const relativePath = toRelativePath(resultPath);
  const exitCode = input.result.exitCode;
  const isSuccess = input.result.status === 'done';

  if (!isSuccess) {
    return `\u2717 ${templateName} failed (exit ${exitCode ?? 1})\n  Results \u2192 ${relativePath}`;
  }

  if (input.branch !== null) {
    // Active template success
    return `\u2713 ${templateName} complete \u2192 branch ${input.branch}\n  Results \u2192 ${relativePath}`;
  }

  // Passive template success
  return `\u2713 ${templateName} complete \u2192 report only, no code changes made\n  Results \u2192 ${relativePath}`;
}

/**
 * Asserts that a resolved file path is contained within a resolved container directory.
 *
 * Exported for unit testing of the containment check in isolation, since
 * `buildFilename()` always validates slugs before `writeResultArtifact()` reaches
 * this check — making PATH_TRAVERSAL_REJECTED unreachable via the normal call path.
 * Exporting this function allows direct testing of the containment logic.
 *
 * @throws ScrowError with PATH_TRAVERSAL_REJECTED if path escapes the container.
 */
export function assertPathContainment(
  resolvedFilePath: string,
  resolvedContainerDir: string,
): void {
  if (!resolvedFilePath.startsWith(resolvedContainerDir + '/')) {
    throw new ScrowError(
      ErrorCode.PATH_TRAVERSAL_REJECTED,
      `Result path ${resolvedFilePath} escapes containment directory ${resolvedContainerDir}`,
    );
  }
}

/**
 * Writes a result artifact to the target repo's .scrow/ directory.
 *
 * Non-fatal: logs a warning on failure and does not rethrow.
 * This ensures the dispatch cycle is never interrupted by a result write failure.
 *
 * Security hardening:
 * - Resolves the full repoPath via realpath() to detect symlinks in parent path components.
 * - Checks .scrow via lstat() after mkdir() to reject symlink substitution.
 *   Note: a TOCTOU window exists between mkdir() and lstat(); this reduces the window
 *   but cannot eliminate it without O_NOFOLLOW semantics (not available in Node.js fs).
 * - Uses realpath() on the .scrow directory and joins the filename to compute the
 *   canonical write target, then asserts containment.
 * - Writes to the resolved path (not the raw joined path) so the security check and
 *   the actual write target are always the same path.
 * - Security errors (SYMLINK_REJECTED, PATH_TRAVERSAL_REJECTED) are audit-logged
 *   before propagation to ensure attack attempts leave a trace.
 *
 * Steps:
 * 1. Resolve repoPath to detect symlinks in parent path components
 * 2. Ensure .scrow/ directory exists (mkdir -p)
 * 3. Symlink guard: lstat() .scrow and reject if it is a symlink
 * 4. Update .gitignore if needed (before result write — AC4 atomic ordering)
 * 5. Path containment: realpath() both .scrow/ and derive the resolved write target,
 *    then assert the target is inside the container
 * 6. Write the result file atomically to the resolved path
 * 7. Log the result to the audit log
 * 8. Print notification to stdout if TTY attached
 */
export async function writeResultArtifact(
  input: ResultArtifactInput,
): Promise<ResultArtifactOutput | null> {
  const repoPath = input.task.targetPath;
  const templateSlug = input.task.templateName ?? input.task.name;

  // Defense-in-depth: validate slug before entering the non-fatal catch block.
  // INVALID_SLUG is a programming/data error (not an I/O error) and must propagate
  // so callers see a clear security signal rather than a silent null return.
  const filename = buildFilename(input.result.completedAt, templateSlug, input.task.id);

  try {
    // 1. Resolve repoPath to detect symlinks in parent path components of the repo.
    //    This prevents an attacker from redirecting the .scrow/ directory by symlinking
    //    a parent directory of repoPath.
    const resolvedRepoPath = await realpath(repoPath);

    // 2. Ensure .scrow/ directory exists
    const scrowDir = join(resolvedRepoPath, SCROW_DIR);
    await mkdir(scrowDir, { recursive: true });

    // 3. Symlink guard: reject if .scrow is a symbolic link.
    //    Note: TOCTOU window exists between mkdir() (step 2) and lstat() here.
    //    An attacker could replace the directory with a symlink in this window.
    //    This guard reduces the window significantly. A true fix would require
    //    O_NOFOLLOW semantics on the open() call, which Node.js does not expose
    //    at the fs/promises level.
    const scrowStat = await lstat(scrowDir);
    if (scrowStat.isSymbolicLink()) {
      void logger.warn(ErrorCode.SYMLINK_REJECTED, {
        taskId: input.task.id,
        templateName: templateSlug,
        repoPath,
        scrowDir,
        event: 'symlink-attack-detected',
      });
      throw new ScrowError(
        ErrorCode.SYMLINK_REJECTED,
        `.scrow directory is a symlink at ${scrowDir}`,
      );
    }

    // 4. Update .gitignore before writing result (AC4 atomic ordering)
    await ensureGitignore(resolvedRepoPath);

    // 5. Path containment: use realpath() on .scrow/ to get its canonical path,
    //    then join the filename (which contains no path separators — guaranteed by
    //    validateSlug above) to derive the resolved write target.
    //    This ensures the security check and actual write target are the same path,
    //    even if scrowDir itself contains symlinks.
    const resolvedScrowDir = await realpath(scrowDir);
    // filename is a flat name (no path separators) — join is equivalent to resolve here
    const resolvedFilePath = join(resolvedScrowDir, filename);
    assertPathContainment(resolvedFilePath, resolvedScrowDir);

    // 6. Write to the resolved path — same path validated by containment check above
    const content = buildResultContent(input);
    await atomicWrite(resolvedFilePath, content);

    const relativePath = toRelativePath(resolvedFilePath);

    // 7. Log to audit log (always, regardless of TTY)
    void logger.info(EventName.RESULT_ARTIFACT_WRITTEN, {
      taskId: input.task.id,
      templateName: templateSlug,
      repoPath,
      filePath: resolvedFilePath,
      exitCode: input.result.exitCode,
      branch: input.branch,
      status: input.result.status,
    });

    // 8. Print notification to stdout if TTY attached
    const notification = formatDispatchNotification(input, resolvedFilePath);
    if (process.stdout.isTTY) {
      process.stdout.write(notification + '\n');
    }

    return { filePath: resolvedFilePath, relativePath };
  } catch (err) {
    // Security errors must propagate — callers need a clear signal, not a silent null.
    // Audit log for PATH_TRAVERSAL_REJECTED (SYMLINK_REJECTED is logged above before throw).
    if (err instanceof ScrowError && err.code === ErrorCode.PATH_TRAVERSAL_REJECTED) {
      void logger.warn(ErrorCode.PATH_TRAVERSAL_REJECTED, {
        taskId: input.task.id,
        templateName: templateSlug,
        repoPath,
        error: err.message,
        event: 'path-traversal-attack-detected',
      });
      throw err;
    }
    if (err instanceof ScrowError && err.code === ErrorCode.SYMLINK_REJECTED) {
      throw err;
    }
    // Non-fatal: log warning and continue — must not break dispatch cycle
    const wrappedErr =
      err instanceof ScrowError
        ? err
        : new ScrowError(
            ErrorCode.RESULT_WRITE_FAILED,
            err instanceof Error ? err.message : String(err),
            err instanceof Error ? err : undefined,
          );
    void logger.warn(ErrorCode.RESULT_WRITE_FAILED, {
      taskId: input.task.id,
      templateName: templateSlug,
      repoPath,
      error: wrappedErr.message,
    });
    return null;
  }
}
