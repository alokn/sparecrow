/** Daemon module barrel exports for dispatcher, daemon state writer, log retention, and lifecycle. */
export { Dispatcher } from './dispatcher.js';
export {
  writeDaemonStatus,
  readExistingStatus,
  writeRunningStatus,
  writeStoppingStatus,
  writeStoppedStatus,
  writeErrorStatus,
  writeCycleStatus,
  writeUnexpectedExitStatus,
} from './state-writer.js';
export { cleanExpiredLogs, cleanExpiredTaskOutputs } from './log-retention.js';
export {
  startDaemon,
  stopDaemon,
  restartDaemon,
  reloadDaemon,
  getDaemonStatus,
  formatUptime,
  sanitizeDaemonEnv,
  DAEMON_STOP_TIMEOUT_MS,
  DAEMON_RUNNER_FLAG,
} from './lifecycle.js';
export {
  readPid,
  writePid,
  removePid,
  checkPidStatus,
  processExists,
  isScrowDaemonProcess,
  killOrphanDaemons,
  DAEMON_PID_FILENAME,
  DAEMON_STATUS_FILENAME,
  DAEMON_IDENTITY_ENV,
  DAEMON_IDENTITY_VALUE,
} from './pid-manager.js';
export { isDaemonRunner, runDaemon, createDispatchAdapter } from './runner.js';
export {
  PollingLoop,
  diffConfig,
  computeNextPollAt,
  buildUsageState,
  buildTriggerState,
  RESTART_REQUIRED_KEYS,
  HOT_APPLY_KEYS,
} from './polling-loop.js';
export { registerSignalHandlers, unregisterSignalHandlers } from './signal-handler.js';
export { writeSummaryFile } from './summary-writer.js';
export { writeTaskOutput, buildOutputContent } from './task-output-writer.js';
export { parseActionBlock } from './action-parser.js';
export { inferActions, getCommitsAhead, buildPrTitle, buildPrBody } from './action-inference.js';
export type { InferenceFrontmatter } from './action-inference.js';
export { executeActions, checkGhAvailable } from './action-executor.js';
export type { ActionExecutionResult, ActionExecutorContext } from '../types/index.js';
export { runActionPipeline } from './action-pipeline.js';
export type { ActionPipelineParams } from './action-pipeline.js';
export { partialOutputPath, finalOutputPath } from './partial-output-writer.js';
