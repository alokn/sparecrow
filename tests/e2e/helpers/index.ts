/** Barrel export for E2E test helpers. */
export { runCli } from './run-cli.js';
export type { RunCliResult } from './run-cli.js';
export { seedConfig } from './seed-config.js';
export { seedQueue } from './seed-queue.js';
export type { PersistedTask } from '../../../src/queue/queue-schema.js';
export { claudeShim } from './claude-shim.js';
export { osCmdShim } from './os-cmd-shim.js';
export { containerShim } from './container-shim.js';
export { seedCredentials } from './seed-credentials.js';
export type { SeedCredentialsOptions } from './seed-credentials.js';
export { shimEnv, platformServicePath } from './daemon-helpers.js';
export { runPty } from './run-pty.js';
export type { PtyResult, RunPtyOptions } from './run-pty.js';
