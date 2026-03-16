/** Platform-correct path resolution via env-paths. XDG-aware on Linux. */
import envPaths from 'env-paths';
import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { ScrowError, ErrorCode } from '../errors/index.js';

const APP_NAME = 'sparecrow';

/** Filename of the YAML configuration file that lives inside the config directory. */
export const CONFIG_FILENAME = 'config.yaml';

export interface AppPaths {
  config: string; // config.yaml lives here
  data: string; // daemon.pid, daemon-status.json, queue.json, last-summary.json, last-summary.txt
  logs: string; // audit-YYYY-MM-DD.jsonl files
  taskOutputs: string; // per-task output files (<task-id>.txt)
}

let _paths: AppPaths | null = null;

export function getPaths(): AppPaths {
  if (_paths) return _paths;

  // env-paths v4: .log maps to XDG_STATE_HOME (~/.local/state) on Linux,
  // and ~/Library/Application Support on macOS — matches architecture requirements.
  // .config maps to XDG_CONFIG_HOME (~/.config) on Linux.
  const ep = envPaths(APP_NAME, { suffix: '' });

  _paths = {
    config: ep.config,
    data: ep.log, // ep.log → XDG_STATE_HOME (~/.local/state) on Linux, not ep.data (XDG_DATA_HOME)
    logs: `${ep.log}/logs`,
    taskOutputs: `${ep.log}/task-outputs`,
  };

  return _paths;
}

/** Ensures all required directories exist with proper permissions.
 *  Call this at daemon/CLI startup before any file access. */
export async function ensureDirectories(): Promise<void> {
  const paths = getPaths();
  const dirs = [paths.config, paths.data, paths.logs, paths.taskOutputs];

  await Promise.all(
    dirs.map(async (dir) => {
      try {
        await mkdir(dir, {
          recursive: true,
          // mode 700: owner rwx only — protects sensitive credentials and state
          mode: 0o700,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          const username = userInfo().username;
          throw new ScrowError(
            ErrorCode.STATE_DIR_PERMISSION_DENIED,
            `Permission denied: cannot create or write to ${dir}. ` +
              `Fix with: sudo chown -R ${username} ${dir}`,
            err instanceof Error ? err : undefined,
          );
        }
        throw err;
      }
    }),
  );
}
