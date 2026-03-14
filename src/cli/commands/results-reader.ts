/** Result artifact discovery and frontmatter parsing for the scrow results command. */
import { readdir, readFile, access } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../../utils/index.js';
import { AUDIT_LOG_FILENAME_REGEX } from '../../utils/index.js';
import { EventName } from '../../types/index.js';
import type { ActionPipelineResult } from '../../types/index.js';
import { asAuditRecord, asString } from './audit-parsing.js';

/** The directory name used to store result artifacts within a repo. */
const SCROW_DIR = '.scrow';

/** Parsed frontmatter from a .scrow/ result file. */
export interface ResultFrontmatter {
  task_id: string;
  template: string;
  repo: string;
  dispatched_at: string;
  completed_at: string;
  exit_code: number;
  branch: string | null;
}

/** A discovered result artifact with parsed frontmatter and file path. */
export interface ResultEntry {
  frontmatter: ResultFrontmatter;
  filePath: string;
  rawContent: string;
}

/** Events that contain repoPath data for repo discovery. */
const REPO_DISCOVERY_EVENTS = new Set<string>([
  EventName.RESULT_ARTIFACT_WRITTEN,
  EventName.TASK_COMPLETED,
  EventName.TASK_FAILED,
]);

/**
 * Scans JSONL audit log files to extract unique repo paths from task events.
 * Looks for repoPath in RESULT_ARTIFACT_WRITTEN events and targetPath in task events.
 * Returns an array of unique absolute paths to repos that have had tasks dispatched.
 */
export async function discoverRepoPaths(logsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return [];
  }

  const repoPaths = new Set<string>();

  // Sort files newest-first for efficiency
  const logFiles = entries
    .filter((name) => AUDIT_LOG_FILENAME_REGEX.test(name))
    .sort()
    .reverse();

  for (const filename of logFiles) {
    const filePath = join(logsDir, filename);
    let text: string;
    try {
      text = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      try {
        const parsed: unknown = JSON.parse(line);
        const record = asAuditRecord(parsed);
        if (record === null) continue;

        if (!REPO_DISCOVERY_EVENTS.has(record.event)) continue;

        const data = record.data;
        // RESULT_ARTIFACT_WRITTEN uses repoPath; task events may use targetPath
        const repoPath = asString(data['repoPath']) ?? asString(data['targetPath']);
        if (repoPath !== null) {
          repoPaths.add(repoPath);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return Array.from(repoPaths);
}

/**
 * Parses YAML frontmatter from a .scrow/ result markdown file.
 * Returns the parsed frontmatter or null if the file is malformed.
 */
export function parseFrontmatter(content: string): ResultFrontmatter | null {
  // Frontmatter is delimited by --- on its own lines.
  // The closing --- is anchored to a line boundary (^---$) via the m flag so that
  // a body line containing --- does not produce a false-positive match.
  const fmMatch = /^---\n([\s\S]*?)\n^---$/m.exec(content);
  if (!fmMatch || !fmMatch[1]) return null;

  const fmBlock = fmMatch[1];
  const fields: Record<string, string> = {};

  for (const line of fmBlock.split('\n')) {
    // Match key: value where key contains no colon (YAML key rule).
    // This preserves colons within the value (e.g. repo paths like /home/user/my:project).
    const keyValueMatch = /^([^:]+):\s*(.*)$/.exec(line);
    if (!keyValueMatch) continue;
    const key = keyValueMatch[1]!.trim();
    let value = keyValueMatch[2]!.trim();
    // Strip surrounding double-quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // Strip surrounding single-quotes
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  // Validate all 7 required fields are present
  const taskId = fields['task_id'];
  const template = fields['template'];
  const repo = fields['repo'];
  const dispatchedAt = fields['dispatched_at'];
  const completedAt = fields['completed_at'];
  const exitCodeStr = fields['exit_code'];
  const branchStr = fields['branch'];

  if (
    taskId === undefined ||
    template === undefined ||
    repo === undefined ||
    dispatchedAt === undefined ||
    completedAt === undefined ||
    exitCodeStr === undefined ||
    branchStr === undefined
  ) {
    return null;
  }

  const exitCode = parseInt(exitCodeStr, 10);
  if (isNaN(exitCode)) return null;

  const branch = branchStr === 'null' ? null : branchStr;

  return {
    task_id: taskId,
    template,
    repo,
    dispatched_at: dispatchedAt,
    completed_at: completedAt,
    exit_code: exitCode,
    branch,
  };
}

/**
 * Discovers and parses all .scrow/*.md result files across known repos.
 * Gracefully handles repos that no longer exist or have no .scrow/ directory.
 */
export async function discoverResultFiles(repoPaths: string[]): Promise<ResultEntry[]> {
  const results: ResultEntry[] = [];

  for (const repoPath of repoPaths) {
    const scrowDir = join(repoPath, SCROW_DIR);

    // Check if .scrow/ exists
    try {
      await access(scrowDir);
    } catch {
      // Repo or .scrow/ doesn't exist — skip gracefully
      continue;
    }

    let files: string[];
    try {
      files = await readdir(scrowDir);
    } catch {
      void logger.debug('results-reader.readdir-failed', { scrowDir });
      continue;
    }

    // Filter for .md files only
    const mdFiles = files.filter((f) => f.endsWith('.md'));

    for (const filename of mdFiles) {
      const filePath = join(scrowDir, filename);
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        void logger.debug('results-reader.read-failed', { filePath });
        continue;
      }

      const frontmatter = parseFrontmatter(content);
      if (frontmatter === null) {
        void logger.debug('results-reader.parse-failed', { filePath });
        continue;
      }

      results.push({ frontmatter, filePath, rawContent: content });
    }
  }

  // Sort by completed_at descending (most recent first).
  // Guard against NaN from non-ISO completed_at strings — NaN entries sort last.
  results.sort((a, b) => {
    const dateA = new Date(a.frontmatter.completed_at).getTime();
    const dateB = new Date(b.frontmatter.completed_at).getTime();
    const aValid = !isNaN(dateA);
    const bValid = !isNaN(dateB);
    if (aValid && bValid) return dateB - dateA;
    if (aValid) return -1; // b is NaN → a sorts first
    if (bValid) return 1; // a is NaN → b sorts first
    return 0; // both NaN → equal
  });

  return results;
}

/**
 * Filters results by repo path and/or template name.
 */
export function filterResults(
  results: ResultEntry[],
  options: { repo?: string | undefined; template?: string | undefined },
): ResultEntry[] {
  let filtered = results;

  if (options.repo) {
    const normalizedRepo = options.repo.replace(/\/+$/, '');
    filtered = filtered.filter((r) => {
      const resultRepo = r.frontmatter.repo.replace(/\/+$/, '');
      return resultRepo === normalizedRepo;
    });
  }

  if (options.template) {
    const templateLower = options.template.toLowerCase();
    filtered = filtered.filter((r) => r.frontmatter.template.toLowerCase() === templateLower);
  }

  return filtered;
}

/**
 * Finds a result entry by short task ID (prefix match).
 * Returns null if no matching result is found.
 */
export function findResultByTaskId(results: ResultEntry[], taskId: string): ResultEntry | null {
  const idLower = taskId.toLowerCase();
  const match = results.find((r) => r.frontmatter.task_id.toLowerCase().startsWith(idLower));
  return match ?? null;
}

/**
 * Returns the most recent result entry, or null if no results exist.
 * Assumes results are already sorted by completed_at descending.
 */
export function getLatestResult(results: ResultEntry[]): ResultEntry | null {
  return results[0] ?? null;
}

/**
 * Returns a path relative to $HOME when possible, absolute otherwise.
 * Uses a path-separator boundary check to avoid false matches on paths
 * like /home/user2/repo when home is /home/user.
 */
export function toRelativeHomePath(absolutePath: string): string {
  const home = homedir();
  // Ensure the match ends at a path separator boundary so that /home/user
  // does not match /home/user2/... producing a wrong ~/2/... result.
  const prefix = home.endsWith('/') ? home : home + '/';
  if (absolutePath === home) {
    return '~';
  }
  if (absolutePath.startsWith(prefix)) {
    return '~/' + relative(home, absolutePath);
  }
  return absolutePath;
}

/**
 * Validates that a value matches the ActionResultRecord shape.
 * All five fields (type, status, url, error, reason) must be present with correct types.
 */
function isActionResultRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['type'] === 'string' &&
    typeof r['status'] === 'string' &&
    (r['url'] === null || typeof r['url'] === 'string') &&
    (r['error'] === null || typeof r['error'] === 'string') &&
    (r['reason'] === null || typeof r['reason'] === 'string')
  );
}

/**
 * Validates the parsed JSON matches the expected ActionPipelineResult shape.
 * Returns true only when all required top-level fields are present with correct types,
 * and each element in the results array passes ActionResultRecord validation.
 */
function isActionPipelineResult(v: unknown): v is ActionPipelineResult {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (
    !(
      typeof obj['task_id'] === 'string' &&
      (obj['source'] === 'parsed' || obj['source'] === 'inferred') &&
      typeof obj['actions_requested'] === 'number' &&
      typeof obj['actions_executed'] === 'number' &&
      typeof obj['actions_failed'] === 'number' &&
      typeof obj['actions_skipped'] === 'number' &&
      Array.isArray(obj['results'])
    )
  ) {
    return false;
  }
  // Validate each ActionResultRecord element to prevent malformed records crashing downstream
  return (obj['results'] as unknown[]).every(isActionResultRecord);
}

/**
 * Reads and parses the companion .actions.json file for a given result file path.
 * The companion path is derived by replacing the .md extension with .actions.json.
 *
 * Returns null when:
 * - The companion file does not exist (ENOENT)
 * - The file contains malformed JSON
 * - The parsed JSON does not match the ActionPipelineResult shape
 *
 * Logs at debug level for all three failure modes.
 */
export async function readActionCompanion(
  resultFilePath: string,
): Promise<ActionPipelineResult | null> {
  const companionPath = resultFilePath.replace(/\.md$/, '.actions.json');

  let raw: string;
  try {
    raw = await readFile(companionPath, 'utf-8');
  } catch (err) {
    const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      void logger.debug('results-reader.companion-not-found', { companionPath });
    } else {
      void logger.debug('results-reader.companion-read-failed', {
        companionPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    void logger.debug('results-reader.companion-malformed-json', {
      companionPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!isActionPipelineResult(parsed)) {
    void logger.debug('results-reader.companion-invalid-shape', { companionPath });
    return null;
  }

  return parsed;
}
