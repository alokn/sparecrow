/** Infers action requests from task context when the session truncated before emitting an action block. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/index.js';
import type { ActionBlock, ActionType } from '../types/index.js';

const execFileAsync = promisify(execFile);

/**
 * Frontmatter fields extracted from a .scrow/ result artifact.
 * Matches the ResultFrontmatter shape from results-reader.ts.
 */
export interface InferenceFrontmatter {
  task_id: string;
  template: string;
  repo: string;
  dispatched_at: string;
  completed_at: string;
  exit_code: number;
  branch: string | null;
}

/**
 * Maximum number of commit messages to include in the inferred PR body.
 * Guards against extremely long bodies from repos with many commits.
 */
const MAX_COMMITS_IN_BODY = 20;

/**
 * Retrieves commits on `taskBranch` that are not reachable from `baseBranch`.
 * Shells out to `git log --oneline <baseBranch>..<taskBranch>`.
 *
 * Returns an array of commit subject lines (e.g. ["abc1234 Fix bug", "def5678 Add test"]).
 * Returns an empty array if the branch has no commits ahead of base or on error.
 *
 * @param repoPath - Absolute path to the git repository
 * @param taskBranch - Branch to check for commits
 * @param baseBranch - Base branch to compare against (defaults to "main")
 */
export async function getCommitsAhead(
  repoPath: string,
  taskBranch: string,
  baseBranch: string = 'main',
): Promise<string[]> {
  try {
    // Use execFile with array args to prevent shell injection from branch names with metacharacters
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', `${baseBranch}..${taskBranch}`],
      { cwd: repoPath },
    );
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines;
  } catch (err) {
    void logger.warn('action-inference.git-log-failed', {
      repoPath,
      taskBranch,
      baseBranch,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Builds a PR title from the template name and completion date.
 * Format: "<Template>: automated changes — <YYYY-MM-DD>"
 */
export function buildPrTitle(templateName: string, completedAt: string): string {
  const date = new Date(completedAt);
  let dateStr: string;
  if (isNaN(date.getTime())) {
    void logger.warn('action-inference.invalid-completed-at', {
      completedAt,
      fallback: 'today',
    });
    dateStr = new Date().toISOString().slice(0, 10);
  } else {
    dateStr = date.toISOString().slice(0, 10);
  }
  return `${templateName}: automated changes — ${dateStr}`;
}

/**
 * Builds a PR body from the template name and a list of commit messages.
 * Truncates to MAX_COMMITS_IN_BODY commits.
 */
export function buildPrBody(templateName: string, commits: string[]): string {
  if (commits.length === 0) {
    return `Automated changes from \`${templateName}\` template.\n\n## Commits\n_(no commits)_`;
  }
  const truncated = commits.slice(0, MAX_COMMITS_IN_BODY);
  const commitList = truncated.map((c) => `- ${c}`).join('\n');
  const truncationNote =
    commits.length > MAX_COMMITS_IN_BODY
      ? `\n\n_(${commits.length - MAX_COMMITS_IN_BODY} more commits not shown)_`
      : '';
  return `Automated changes from \`${templateName}\` template.\n\n## Commits\n${commitList}${truncationNote}`;
}

/**
 * Infers action requests from task context when the session truncated before emitting an action block.
 *
 * This is the truncation fallback — only called when `parseActionBlock()` returns null.
 *
 * Returns an ActionBlock if the task completed successfully, has a branch, has commits ahead,
 * and the template declares at least one infer-able action type.
 *
 * Returns null when:
 * - exit_code != 0 (AC3)
 * - branch is null or no commits exist on the branch (AC4)
 * - templateActions is empty or contains no infer-able types
 *
 * @param frontmatter - Parsed frontmatter from the .scrow/ result artifact
 * @param templateActions - Declared action types from the template manifest
 * @param baseBranch - Base branch to compare against when running `git log` (defaults to "main")
 */
export async function inferActions(
  frontmatter: InferenceFrontmatter,
  templateActions: ActionType[],
  baseBranch: string = 'main',
): Promise<ActionBlock | null> {
  // AC3: Don't infer actions for failed tasks
  if (frontmatter.exit_code !== 0) {
    void logger.debug('action-inference.skipped-nonzero-exit', {
      taskId: frontmatter.task_id,
      exitCode: frontmatter.exit_code,
    });
    return null;
  }

  // AC4: Don't infer if no branch field (null or empty string are both treated as absent)
  if (frontmatter.branch === null || frontmatter.branch === '') {
    void logger.debug('action-inference.skipped-no-branch', {
      taskId: frontmatter.task_id,
    });
    return null;
  }

  const branch = frontmatter.branch;

  // Check for commits on the branch
  const commits = await getCommitsAhead(frontmatter.repo, branch, baseBranch);

  // AC4: Don't infer if no commits on the branch
  if (commits.length === 0) {
    void logger.debug('action-inference.skipped-no-commits', {
      taskId: frontmatter.task_id,
      branch,
      baseBranch,
    });
    return null;
  }

  const actions: ActionBlock['actions'] = [];

  // ACTION ORDERING: git-push MUST appear before pr-create.
  // The branch must exist on the remote before a PR can be opened against it.
  // Any change to this ordering will cause pr-create to fail at dispatch time.

  // Infer git-push if declared in template actions
  if (templateActions.includes('git-push')) {
    actions.push({ type: 'git-push', branch });
  }

  // Infer pr-create if declared in template actions
  if (templateActions.includes('pr-create')) {
    const title = buildPrTitle(frontmatter.template, frontmatter.completed_at);
    const body = buildPrBody(frontmatter.template, commits);
    actions.push({
      type: 'pr-create',
      title,
      body,
      // Include base_branch only when a non-default base was used so the PR targets the correct branch
      ...(baseBranch !== 'main' ? { base_branch: baseBranch } : {}),
      draft: true, // Conservative — inferred PRs are always drafts (AC2)
    });
  }

  if (actions.length === 0) {
    const nonInferable = templateActions.filter((t) => t !== 'git-push' && t !== 'pr-create');
    void logger.warn('action-inference.no-infer-able-actions', {
      taskId: frontmatter.task_id,
      templateActions,
      nonInferableTypes: nonInferable,
    });
    return null;
  }

  void logger.info('action-inference.inferred', {
    taskId: frontmatter.task_id,
    branch,
    commitCount: commits.length,
    actionCount: actions.length,
    actionTypes: actions.map((a) => a.type),
  });

  return { actions };
}
