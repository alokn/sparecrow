/** Config file watcher — watches parent directory and calls reload on config file changes. */
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { logger } from '../utils/index.js';

const DEBOUNCE_MS = 300;

/** Opaque watcher handle. */
export interface ConfigWatcher {
  close(): void;
}

/** Creates a config file watcher with 300ms debounce.
 *
 * Watches the *parent directory* (not the file directly) to handle atomic writes (temp + rename),
 * which cause inotify to stop tracking the original inode on Linux.
 * Only events for the config filename are forwarded to onReload.
 *
 * @param configPath  Absolute path to the config file to watch.
 * @param onReload    Async callback invoked on change (debounced). Must not throw.
 */
export function createConfigWatcher(
  configPath: string,
  onReload: () => Promise<void>,
): ConfigWatcher {
  const configDir = dirname(configPath);
  const configFile = basename(configPath);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function scheduleReload(): void {
    if (closed) return;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      void onReload().catch((err: unknown) => {
        void logger.error('config-watcher.reload-callback-error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, DEBOUNCE_MS);
  }

  let watcher: ReturnType<typeof watch> | null = null;

  try {
    watcher = watch(configDir, { persistent: false }, (eventType, filename) => {
      if (closed) return;
      // filename may be null on some platforms; only handle events for our config file
      if (filename !== null && filename !== configFile) return;
      // If filename is null (platform limitation), fire anyway — we're watching the directory
      void logger.debug('config-watcher.change-detected', {
        eventType,
        filename: filename ?? '(null — directory event)',
      });
      scheduleReload();
    });

    watcher.on('error', (err: Error) => {
      if (closed) return;
      void logger.error('config-watcher.watcher-error', { error: err.message });
      // Do not crash the daemon — log and continue
    });
  } catch (err) {
    // fs.watch may fail on network/virtual filesystems — log and return a no-op handle
    void logger.error('config-watcher.watch-init-error', {
      configDir,
      error: err instanceof Error ? (err as Error).message : String(err),
    });
    return {
      close(): void {
        closed = true;
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
      },
    };
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      try {
        watcher?.close();
      } catch {
        // Best-effort
      }
    },
  };
}
