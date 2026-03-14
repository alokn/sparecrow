/** Executes validated action requests using host-side credentials (git, gh CLI). */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/index.js';
import type {
  ActionBlock,
  ActionType,
  ActionExecutionResult,
  ActionExecutorContext,
  GitPushAction,
  PrCreateAction,
  NotifyAction,
} from '../types/index.js';

const execFileAsync = promisify(execFile);

/**
 * Checks whether `gh` CLI is installed and authenticated.
 *
 * Runs `gh auth status` — checks both installation and authentication in a single call.
 * Returns true only when exit code is 0.
 * Any non-zero exit (unauthenticated, not installed, network timeout) returns false.
 * Never throws.
 */
export async function checkGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
    return true;
  } catch (err) {
    // Log gh stderr at debug level to aid operator diagnostics without noise in normal output
    const errMsg = err instanceof Error ? err.message : String(err);
    void logger.debug('action-executor.gh-availability-check-failed', { reason: errMsg });
    return false;
  }
}

/**
 * Executes a git-push action.
 *
 * Runs `git push -u <remote> <branch>` in the target repo directory.
 * When `force === true`, adds `--force-with-lease` (safer variant that rejects if remote updated).
 *
 * Known limitation: on first-time push with `--force-with-lease`, git may fail with
 * "cannot lock ref" because there is no remote tracking reference to compare against.
 * This is an acceptable failure mode — no special-case handling is added.
 */
async function executeGitPush(
  action: GitPushAction,
  repoPath: string,
): Promise<ActionExecutionResult> {
  const remote = action.remote ?? 'origin';
  // Place --force-with-lease before operands (canonical option-before-operand ordering)
  // Use -- separator before positional arguments to prevent option injection (Story 18.1 AC4)
  const args =
    action.force === true
      ? ['push', '--force-with-lease', '-u', '--', remote, action.branch]
      : ['push', '-u', '--', remote, action.branch];
  try {
    await execFileAsync('git', args, { cwd: repoPath, timeout: 60000 });
    return { type: 'git-push', status: 'success' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { type: 'git-push', status: 'failed', error };
  }
}

/**
 * Executes a pr-create action using the `gh` CLI.
 *
 * Checks gh availability first; if not available, returns a skipped result
 * and logs a warning suggesting `gh auth login`.
 *
 * Parses the PR URL from the last non-empty line of stdout.
 */
async function executePrCreate(
  action: PrCreateAction,
  repoPath: string,
  ghAvailable: boolean,
  taskId: string,
): Promise<ActionExecutionResult> {
  if (!ghAvailable) {
    void logger.warn('action-executor.gh-not-available', {
      taskId,
      suggestion: 'Run `gh auth login` to authenticate the GitHub CLI',
    });
    return {
      type: 'pr-create',
      status: 'skipped',
      reason: 'gh CLI not available or not authenticated',
    };
  }

  const args: string[] = ['pr', 'create', '--title', action.title, '--body', action.body];
  if (action.base_branch) {
    args.push('--base', action.base_branch);
  }
  if (action.draft === true) {
    args.push('--draft');
  }
  for (const label of action.labels ?? []) {
    args.push('--label', label);
  }

  try {
    const { stdout } = await execFileAsync('gh', args, { cwd: repoPath, timeout: 30000 });
    // gh pr create outputs the PR URL as the last line of stdout.
    // url may be '' if gh returns no output — callers should treat '' as "URL unavailable".
    const url =
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1) ?? '';
    return { type: 'pr-create', status: 'success', url };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { type: 'pr-create', status: 'failed', error };
  }
}

/**
 * Executes a notify action by logging the message at info level.
 * No system notification integration — deferred for future implementation.
 */
async function executeNotify(action: NotifyAction, taskId: string): Promise<ActionExecutionResult> {
  void logger.info('action-executor.notify', { taskId, message: action.message });
  return { type: 'notify', status: 'success' };
}

/**
 * Executes a list of action requests from an ActionBlock sequentially.
 *
 * Processing order per action:
 * 1. Validate against templateActions manifest (AC6) — invalid → skipped regardless of dryRun
 * 2. If dryRun === true → return dry-run result without executing (AC7)
 * 3. Dispatch to executor
 *
 * Errors thrown by individual executors are caught at the per-action level and
 * converted to { status: 'failed' } — they never propagate to the caller (AC5).
 *
 * @param block - The action block to execute
 * @param context - Executor context (repoPath, templateActions, taskId, dryRun)
 */
export async function executeActions(
  block: ActionBlock,
  context: ActionExecutorContext,
): Promise<ActionExecutionResult[]> {
  // Default dryRun to false to prevent silent live execution when callers omit the field
  const dryRun = context.dryRun ?? false;
  const results: ActionExecutionResult[] = [];
  // Cache gh availability for the lifetime of this executeActions() call only (per-call, not global)
  let ghAvailable: boolean | undefined;

  for (const action of block.actions) {
    const type: ActionType = action.type;

    // AC6: Validate action type against template manifest
    if (!context.templateActions.includes(type)) {
      void logger.warn('action-executor.manifest-validation-rejected', {
        taskId: context.taskId,
        type,
        templateActions: context.templateActions,
      });
      results.push({
        type,
        status: 'skipped',
        reason: 'action type not declared in template manifest',
      });
      continue;
    }

    // AC7: Dry-run guard (after manifest validation, before executor dispatch)
    if (dryRun) {
      void logger.info('action-executor.dry-run', { taskId: context.taskId, type });
      results.push({ type, status: 'dry-run', reason: 'dry-run mode active' });
      continue;
    }

    // Dispatch to executor
    try {
      let result: ActionExecutionResult;
      if (action.type === 'git-push') {
        result = await executeGitPush(action, context.repoPath);
      } else if (action.type === 'pr-create') {
        // Lazy-initialise per-call gh availability cache
        if (ghAvailable === undefined) {
          ghAvailable = await checkGhAvailable();
        }
        result = await executePrCreate(action, context.repoPath, ghAvailable, context.taskId);
      } else if (action.type === 'notify') {
        result = await executeNotify(action, context.taskId);
      } else {
        // AC8: Unimplemented action type (e.g. issue-create)
        // action is already ActionRequest here — no cast needed; type is narrowed from the loop
        const unimplementedType = action.type;
        void logger.warn('action-executor.unimplemented-type', {
          type: unimplementedType,
          taskId: context.taskId,
        });
        result = {
          type: unimplementedType,
          status: 'skipped',
          reason: `executor not implemented for action type: ${unimplementedType}`,
        };
      }
      results.push(result);
    } catch (err) {
      // Safety net: individual executor errors must never propagate (AC5)
      const error = err instanceof Error ? err.message : String(err);
      void logger.warn('action-executor.unexpected-error', {
        taskId: context.taskId,
        type,
        error,
      });
      results.push({ type, status: 'failed', error });
    }
  }

  return results;
}
