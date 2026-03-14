/** Seeds a valid queue.json inside a HOME-isolated temp directory. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedTask } from '../../../src/queue/queue-schema.js';

/**
 * Resolves the state/data directory path for the given homeDir,
 * mirroring env-paths v4 behaviour for Linux and macOS.
 *
 * On Linux, always computes the path relative to `homeDir` (never reads
 * `XDG_STATE_HOME` from the test runner's process environment — doing so
 * would cause seed files to land in the wrong location when CI sets
 * `XDG_STATE_HOME` globally, while the spawned binary only receives a
 * `HOME` override and thus resolves paths under `homeDir/.local/state`).
 * On macOS, uses `Library/Logs`.
 */
function resolveStateDir(homeDir: string): string {
  const appName = 'sparecrow';
  if (process.platform === 'darwin') {
    return join(homeDir, 'Library', 'Logs', appName);
  }
  // Linux (and other POSIX): always use homeDir-relative path so the seed
  // file is co-located with where env-paths resolves paths for the spawned
  // binary (which only has HOME overridden, not XDG_STATE_HOME).
  return join(homeDir, '.local', 'state', appName);
}

/**
 * Writes a valid `queue.json` to the platform-correct state path inside `homeDir`.
 *
 * The JSON matches `QueuePayloadSchema`: `{ version: 1, tasks: [...], paused: false }`.
 *
 * @param homeDir - The isolated HOME directory for the test
 * @param tasks - Array of tasks conforming to `PersistedTask`
 * @returns The absolute path of the written queue.json
 */
export async function seedQueue(homeDir: string, tasks: PersistedTask[]): Promise<string> {
  const stateDir = resolveStateDir(homeDir);
  const queuePath = join(stateDir, 'queue.json');

  const payload = {
    version: 1,
    tasks,
    paused: false,
  };

  await mkdir(stateDir, { recursive: true });
  await writeFile(queuePath, JSON.stringify(payload, null, 2), 'utf8');

  return queuePath;
}
