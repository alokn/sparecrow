/** Refresh command — force a one-shot usage poll, trigger evaluation, and dispatch cycle. */
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type { Command } from 'commander';
import { isJsonMode, getConfigPath } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import type { DaemonStatusFile } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { logger } from '../../utils/index.js';
import { getPaths } from '../../platform/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { createProvider } from '../../providers/index.js';
import { TriggerEngine } from '../../trigger/index.js';
import { QueueStore, QueueManager } from '../../queue/index.js';
import {
  Dispatcher,
  writeDaemonStatus,
  readExistingStatus,
  buildUsageState,
  buildTriggerState,
} from '../../daemon/index.js';
import type { DispatchCycleResult } from '../../types/index.js';
import { loadStatusSnapshot } from './status-state.js';
import { renderStatusOutput } from './status-presenter.js';

export function registerRefresh(program: Command): void {
  program
    .command('refresh')
    .description('force a one-shot usage poll, trigger evaluation, and dispatch cycle')
    .action(async () => {
      const paths = getPaths();

      // AC7: Load config — throw CONFIG_NOT_FOUND if file does not exist
      const configPath = resolveConfigFilePath(paths.config, getConfigPath());
      try {
        await access(configPath);
      } catch {
        throw new ScrowError(
          ErrorCode.CONFIG_NOT_FOUND,
          `No config file found at ${configPath}. Run 'sparecrow init' to create one.`,
        );
      }
      const config = await loadConfig(configPath);

      // AC2: Fetch fresh usage data
      const provider = await createProvider(config.provider.name, config.provider);
      const snapshot = await provider.usageMonitor.poll();

      // AC3: Evaluate trigger conditions
      const triggerEngine = new TriggerEngine();
      const triggerResult = triggerEngine.evaluate(snapshot, config.trigger);

      // Build state fields for status file
      const usageState = buildUsageState(snapshot);
      const triggerState = buildTriggerState(triggerResult);

      // AC4: Dispatch if triggered
      let lastDispatchAt: string | null = null;
      const queueStore = new QueueStore(paths.data);
      const queueManager = new QueueManager(queueStore);
      const queueDepth = await queueManager.countWorkload();

      let dispatchPromise: Promise<DispatchCycleResult | null> | null = null;
      if (triggerResult.shouldDispatch) {
        const dispatcher = new Dispatcher({
          queueManager,
          taskExecutor: provider.taskExecutor,
        });
        // Non-blocking dispatch: kick off execution but do not await task completion.
        // Attach .catch() to prevent unhandled rejection after CLI exits.
        dispatchPromise = dispatcher.dispatch();
        dispatchPromise.catch((err: unknown) => {
          void logger.error('refresh.dispatch-failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        lastDispatchAt = new Date().toISOString();
      }

      // AC5: Update daemon-status.json, preserving lifecycle fields
      const statusFilePath = join(paths.data, 'daemon-status.json');
      const existing = await readExistingStatus(statusFilePath);

      const now = new Date().toISOString();
      const updatedStatus: DaemonStatusFile = {
        // Preserve lifecycle fields from existing status, or use defaults
        state: existing?.state ?? 'stopped',
        startedAt: existing?.startedAt ?? null,
        pid: existing?.pid ?? null,
        // Merge fresh data fields
        lastPollAt: now,
        nextPollAt: existing?.nextPollAt ?? null,
        usage: usageState,
        trigger: triggerState,
        activeTask: existing?.activeTask ?? null,
        lastError: existing?.lastError ?? null,
        lastErrorDetail: existing?.lastErrorDetail ?? null,
        updatedAt: now,
        lastDispatchAt: lastDispatchAt ?? existing?.lastDispatchAt ?? null,
        cycleResult: existing?.cycleResult ?? null,
        queueDepth,
        backendState: existing?.backendState ?? null,
      };

      await writeDaemonStatus(updatedStatus);

      // AC5 (cycleResult): Once dispatch resolves, write updated cycleResult to status file.
      // This runs asynchronously after the CLI renders output, so sparecrow report sees fresh data.
      if (dispatchPromise !== null) {
        dispatchPromise
          .then(async (cycleResult) => {
            if (cycleResult === null) return;
            const post = await readExistingStatus(statusFilePath);
            const postStatus: DaemonStatusFile = {
              ...(post ?? updatedStatus),
              cycleResult,
              updatedAt: new Date().toISOString(),
            };
            await writeDaemonStatus(postStatus);
          })
          .catch((err: unknown) => {
            void logger.error('refresh.cycleResult-write-failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      // AC6: Render output
      if (isJsonMode()) {
        const freshSnapshot = await loadStatusSnapshot();
        printJson(jsonOk(freshSnapshot));
        return;
      }

      const freshSnapshot = await loadStatusSnapshot();
      const output = renderStatusOutput(freshSnapshot, {
        all: false,
        detail: false,
        explain: false,
      });
      process.stdout.write(output + '\n');
    });
}
