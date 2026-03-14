/** Writes task result artifacts as markdown files into the target repo's .scrow/ directory. */
import { join, relative } from 'node:path';
import { mkdir, readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { atomicWrite } from '../utils/index.js';
import { logger } from '../utils/index.js';
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
 * Writes a result artifact to the target repo's .scrow/ directory.
 *
 * Non-fatal: logs a warning on failure and does not rethrow.
 * This ensures the dispatch cycle is never interrupted by a result write failure.
 *
 * Steps:
 * 1. Ensure .scrow/ directory exists (mkdir -p)
 * 2. Update .gitignore if needed (before result write — AC4 atomic ordering)
 * 3. Write the result file atomically
 * 4. Log the result to the audit log
 * 5. Print notification to stdout if TTY attached
 */
export async function writeResultArtifact(
  input: ResultArtifactInput,
): Promise<ResultArtifactOutput | null> {
  const repoPath = input.task.targetPath;
  const templateSlug = input.task.templateName ?? input.task.name;

  try {
    // 1. Ensure .scrow/ directory exists
    const scrowDir = join(repoPath, SCROW_DIR);
    await mkdir(scrowDir, { recursive: true });

    // 2. Update .gitignore before writing result (AC4 atomic ordering)
    await ensureGitignore(repoPath);

    // 3. Build and write the result file
    const filename = buildFilename(input.result.completedAt, templateSlug, input.task.id);
    const filePath = join(scrowDir, filename);
    const content = buildResultContent(input);
    await atomicWrite(filePath, content);

    const relativePath = toRelativePath(filePath);

    // 4. Log to audit log (always, regardless of TTY)
    void logger.info(EventName.RESULT_ARTIFACT_WRITTEN, {
      taskId: input.task.id,
      templateName: templateSlug,
      repoPath,
      filePath,
      exitCode: input.result.exitCode,
      branch: input.branch,
      status: input.result.status,
    });

    // 5. Print notification to stdout if TTY attached
    const notification = formatDispatchNotification(input, filePath);
    if (process.stdout.isTTY) {
      process.stdout.write(notification + '\n');
    }

    return { filePath, relativePath };
  } catch (err) {
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
