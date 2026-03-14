/** Signal handler — registers SIGTERM, SIGINT, and SIGHUP handlers for daemon lifecycle. */
import { logger } from '../utils/index.js';
import { removePid } from './pid-manager.js';
import { writeStoppingStatus, writeStoppedStatus } from './state-writer.js';
import type { PollingLoop } from './polling-loop.js';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Signal handler state — prevents double cleanup. */
interface SignalHandlerState {
  shuttingDown: boolean;
  startedAt: string | null;
  dataDir: string;
  pollingLoop: PollingLoop | null;
  onReload: (() => Promise<void>) | null;
  onShutdownComplete: (() => void) | null;
  /** Stored handler references for precise removeListener cleanup. */
  sigTermHandler: () => void;
  sigIntHandler: () => void;
  sigHupHandler: () => void;
}

let _state: SignalHandlerState | null = null;

/** Register SIGTERM, SIGINT, and SIGHUP signal handlers.
 *  Idempotent: subsequent calls update deps but do not register duplicate handlers. */
export function registerSignalHandlers(opts: {
  dataDir: string;
  startedAt: string;
  pollingLoop: PollingLoop;
  onReload: () => Promise<void>;
  onShutdownComplete?: () => void;
}): void {
  if (_state !== null) {
    // Update deps without re-registering handlers
    _state.pollingLoop = opts.pollingLoop;
    _state.onReload = opts.onReload;
    _state.startedAt = opts.startedAt;
    _state.onShutdownComplete = opts.onShutdownComplete ?? null;
    return;
  }

  // Define named handler functions so we can remove exactly these listeners later.
  const sigTermHandler = (): void => {
    void handleShutdown('SIGTERM');
  };
  const sigIntHandler = (): void => {
    void handleShutdown('SIGINT');
  };
  const sigHupHandler = (): void => {
    void handleSighup();
  };

  _state = {
    shuttingDown: false,
    startedAt: opts.startedAt,
    dataDir: opts.dataDir,
    pollingLoop: opts.pollingLoop,
    onReload: opts.onReload,
    onShutdownComplete: opts.onShutdownComplete ?? null,
    sigTermHandler,
    sigIntHandler,
    sigHupHandler,
  };

  process.on('SIGTERM', sigTermHandler);
  process.on('SIGINT', sigIntHandler);
  process.on('SIGHUP', sigHupHandler);
}

/** Unregister signal handlers and reset state. Call on shutdown completion.
 *  Uses precise removeListener calls to avoid removing third-party or test-harness listeners. */
export function unregisterSignalHandlers(): void {
  if (_state !== null) {
    process.removeListener('SIGTERM', _state.sigTermHandler);
    process.removeListener('SIGINT', _state.sigIntHandler);
    process.removeListener('SIGHUP', _state.sigHupHandler);
  }
  _state = null;
}

/** Graceful shutdown path — idempotent. */
async function handleShutdown(signal: string): Promise<void> {
  if (_state === null || _state.shuttingDown) {
    void logger.debug('signal-handler.shutdown-already-in-progress', { signal });
    return;
  }
  _state.shuttingDown = true;

  const { dataDir, startedAt, pollingLoop, onShutdownComplete } = _state;

  void logger.debug('signal-handler.shutdown-start', { signal });

  try {
    await writeStoppingStatus(startedAt);
  } catch (err) {
    void logger.debug('signal-handler.stopping-write-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Request loop stop and wait with bounded timeout.
  // The timer handle is stored and cleared after the race to avoid keeping the event loop alive.
  if (pollingLoop !== null) {
    const stopPromise = pollingLoop.stop();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        void logger.warn('signal-handler.graceful-shutdown-timeout', {
          timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        });
        resolve();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([stopPromise, timeoutPromise]);
    clearTimeout(timeoutId);
  }

  // Write final stopped state
  try {
    await writeStoppedStatus(startedAt);
  } catch (err) {
    void logger.debug('signal-handler.stopped-write-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // PID cleanup
  try {
    await removePid(dataDir);
  } catch (err) {
    void logger.debug('signal-handler.pid-remove-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  void logger.debug('signal-handler.shutdown-complete', { signal });

  if (onShutdownComplete) {
    onShutdownComplete();
  } else {
    process.exit(0);
  }
}

/** SIGHUP handler — reload config. Idempotent during shutdown. */
async function handleSighup(): Promise<void> {
  if (_state === null) return;

  // If shutdown is already in progress, do not reload
  if (_state.shuttingDown) {
    void logger.debug('signal-handler.sighup-ignored-during-shutdown', {});
    return;
  }

  void logger.debug('signal-handler.sighup-reload', {});

  const { onReload } = _state;
  if (onReload === null) return;

  try {
    await onReload();
    void logger.debug('signal-handler.sighup-reload-complete', {});
  } catch (err) {
    void logger.error('signal-handler.sighup-reload-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
