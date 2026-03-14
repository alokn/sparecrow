/** Orchestrates the post-execution action pipeline: parse → infer → validate → execute → record. */
import { readFile } from 'node:fs/promises';
import { parseActionBlock } from './action-parser.js';
import { inferActions } from './action-inference.js';
import type { InferenceFrontmatter } from './action-inference.js';
import { executeActions } from './action-executor.js';
import { logger, atomicWrite } from '../utils/index.js';
import { EventName } from '../types/index.js';
import type {
  ActionType,
  ActionExecutionResult,
  ActionPipelineResult,
  ActionResultRecord,
} from '../types/index.js';

/** Parameters for running the post-execution action pipeline. */
export interface ActionPipelineParams {
  /** Parsed frontmatter from the .scrow/ result artifact (for inferActions). */
  frontmatter: InferenceFrontmatter;
  /** Template's declared action types (for manifest validation in executeActions). */
  templateActions: ReadonlyArray<ActionType>;
  /** Path to the result artifact file — companion .actions.json is written alongside.
   *  The file content is read inside runActionPipeline and passed to parseActionBlock. */
  resultFilePath: string;
  /** Task ID for structured log messages. */
  taskId: string;
  /** Absolute path to the target git repository (for executeActions repoPath). */
  repoPath: string;
  /** When true, all actions are logged but not executed (passed through to executeActions). */
  dryRun?: boolean;
}

/**
 * Converts an ActionExecutionResult to a serialisable ActionResultRecord.
 * Normalises optional url/error/reason to null when absent.
 */
function toActionResultRecord(result: ActionExecutionResult): ActionResultRecord {
  return {
    type: result.type,
    status: result.status,
    url: result.url ?? null,
    error: result.error ?? null,
    reason: result.reason ?? null,
  };
}

/**
 * Runs the post-execution action pipeline for a completed task.
 *
 * Orchestrates: read result file → parse action block → infer (if null) →
 * validate → execute → record.
 *
 * Returns null when:
 * - The result artifact file cannot be read
 * - parseActionBlock returns null AND inferActions returns null (no block to execute)
 *
 * Non-fatal: companion file write failures are logged at warn level but do not
 * cause the function to return null — the computed ActionPipelineResult is still returned.
 */
export async function runActionPipeline(
  params: ActionPipelineParams,
): Promise<ActionPipelineResult | null> {
  // Read the result artifact content for parseActionBlock
  let content: string;
  try {
    content = await readFile(params.resultFilePath, 'utf-8');
  } catch (err) {
    void logger.warn('action-pipeline.read-result-failed', {
      taskId: params.taskId,
      resultFilePath: params.resultFilePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Step 1: Parse action block from file content
  let actionBlock = parseActionBlock(content);
  let source: 'parsed' | 'inferred';

  if (actionBlock !== null) {
    source = 'parsed';
  } else {
    // Step 2: Infer actions from context when no action block was parsed
    const inferred = await inferActions(params.frontmatter, Array.from(params.templateActions));
    if (inferred === null) {
      // No block parsed and no inference — nothing to do, no companion written
      return null;
    }
    actionBlock = inferred;
    source = 'inferred';
  }

  // Step 3: Execute the action block
  const executionResults = await executeActions(actionBlock, {
    repoPath: params.repoPath,
    templateActions: params.templateActions,
    taskId: params.taskId,
    dryRun: params.dryRun ?? false,
  });

  // Step 4: Convert to serialisable records
  const records: ActionResultRecord[] = executionResults.map(toActionResultRecord);

  // Step 5: Emit audit log entries per action
  for (const record of records) {
    const eventName =
      record.status === 'success' ? EventName.ACTION_EXECUTED : EventName.ACTION_FAILED;
    void logger.info(
      eventName,
      {
        taskId: params.taskId,
        actionType: record.type,
        status: record.status,
        url: record.url,
      },
      {
        provider: null,
        source: null,
        confidence: null,
        error: record.error,
      },
    );
  }

  // Step 6: Build the pipeline result
  const pipelineResult: ActionPipelineResult = {
    task_id: params.taskId,
    source,
    actions_requested: records.length,
    actions_executed: records.filter((r) => r.status === 'success').length,
    actions_failed: records.filter((r) => r.status === 'failed').length,
    actions_skipped: records.filter((r) => r.status === 'skipped' || r.status === 'dry-run').length,
    results: records,
  };

  // Step 7: Write companion file alongside the result artifact
  // Guard: only replace .md extension to avoid corrupting non-.md paths.
  // Result artifacts are always .md (enforced by buildFilename in result-writer.ts),
  // but this guard is defensive against future changes.
  const companionPath = params.resultFilePath.endsWith('.md')
    ? params.resultFilePath.replace(/\.md$/, '.actions.json')
    : params.resultFilePath + '.actions.json';
  try {
    await atomicWrite(companionPath, JSON.stringify(pipelineResult, null, 2));
  } catch (err) {
    // Companion write failure is non-fatal — log and return the result anyway
    void logger.warn('action-pipeline.companion-write-failed', {
      taskId: params.taskId,
      companionPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return pipelineResult;
}
