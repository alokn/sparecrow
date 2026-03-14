/** PTY-based CLI runner for interactive E2E tests. */
import * as pty from 'node-pty';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_INDEX = resolve(PROJECT_ROOT, 'dist', 'index.js');

/**
 * Result returned by the runPty helper.
 *
 * Note: `output` contains the merged PTY stream (stdout + stderr + ANSI control sequences).
 * It is named `output` rather than `stdout` to reflect that a PTY merges both streams.
 */
export interface PtyResult {
  output: string;
  exitCode: number;
}

/**
 * A keystroke entry: either a raw character string to send immediately, or an
 * object that waits for specific text to appear in the output before sending.
 *
 * Use `{ key, waitFor }` when the preceding step involves a long-running async
 * operation (e.g. a spinner) that may not produce continuous output in CI mode
 * (where @clack/prompts skips repeated spinner frames). Waiting for specific
 * text avoids premature keystroke delivery.
 */
export type KeystrokeEntry = string | { key: string; waitFor: string };

/**
 * Options accepted by the runPty helper.
 *
 * Timeout guidance: set `timeoutMs` to at least 10 seconds below the Vitest
 * test-level timeout (the `{ timeout }` option on the `it()` call). This
 * ensures `runPty` rejects and runs `afterEach` cleanup BEFORE Vitest's own
 * watchdog fires, which would tear down the test worker without cleanup.
 */
export interface RunPtyOptions {
  env?: Record<string, string>;
  keystrokes: KeystrokeEntry[];
  keystrokeDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Spawns the built `sparecrow` binary inside a real pseudo-TTY with the given arguments,
 * sends simulated keystrokes, and returns captured output and exit code.
 *
 * Waits for output to stabilize before sending each keystroke to avoid
 * sending input before the process has rendered its next prompt.
 *
 * @param args - CLI arguments (e.g. `['onboard']`)
 * @param opts - PTY options including keystrokes to send and timing configuration
 */
export function runPty(args: string[], opts: RunPtyOptions): Promise<PtyResult> {
  const delay = opts.keystrokeDelayMs ?? 80;
  const timeout = opts.timeoutMs ?? 20000;

  return new Promise<PtyResult>((resolvePromise, rejectPromise) => {
    let output = '';
    let settled = false;
    let lastOutputTime = 0;
    let hasReceivedOutput = false;

    const proc = pty.spawn('node', [DIST_INDEX, ...args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 24,
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...opts.env },
    });

    proc.onData((data: string) => {
      output += data;
      lastOutputTime = Date.now();
      hasReceivedOutput = true;
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ output, exitCode });
      }
    });

    // Hard timeout to prevent indefinite hangs.
    // `timer.unref()` ensures the timer does not prevent Node from exiting if
    // the process exits naturally — avoiding a race where both the runPty
    // rejection AND Vitest's test-level watchdog fire at nearly the same time.
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill();
        } catch {
          /* best effort */
        }
        rejectPromise(
          new Error(
            `runPty timed out after ${String(timeout)}ms. Captured output so far:\n${output}`,
          ),
        );
      }
    }, timeout);
    timer.unref();

    /**
     * Waits until output has been received AND has been stable (no new data)
     * for at least `quietMs`. This ensures the process has finished rendering
     * its prompt before the next keystroke is sent.
     */
    const waitForQuiet = (quietMs: number, maxWaitMs: number): Promise<void> => {
      return new Promise<void>((res) => {
        const deadline = Date.now() + maxWaitMs;
        const check = (): void => {
          if (settled) {
            res();
            return;
          }
          if (Date.now() >= deadline) {
            res();
            return;
          }
          // Must have received some output before considering "quiet"
          if (!hasReceivedOutput) {
            setTimeout(check, 20);
            return;
          }
          const elapsed = Date.now() - lastOutputTime;
          if (elapsed >= quietMs) {
            res();
            return;
          }
          setTimeout(check, 20);
        };
        setTimeout(check, 50);
      });
    };

    /**
     * Waits until the captured output contains the given text string.
     * Used before sending keystrokes that follow long-running async operations
     * (e.g. spinners) which may not produce continuous output in CI mode.
     */
    const waitForText = (text: string, maxWaitMs: number): Promise<void> => {
      return new Promise<void>((res) => {
        const deadline = Date.now() + maxWaitMs;
        const check = (): void => {
          if (settled || output.includes(text)) {
            res();
            return;
          }
          if (Date.now() >= deadline) {
            res();
            return;
          }
          setTimeout(check, 50);
        };
        setTimeout(check, 50);
      });
    };

    // Send keystrokes sequentially, waiting for output to stabilize between each
    const sendKeystrokes = async (): Promise<void> => {
      // Wait for initial output (process startup + first prompt render)
      await waitForQuiet(200, 10000);

      for (let i = 0; i < opts.keystrokes.length; i++) {
        if (settled) return;
        const entry = opts.keystrokes[i]!;
        const key = typeof entry === 'string' ? entry : entry.key;
        // If this keystroke has a waitFor guard, wait for the text first
        if (typeof entry !== 'string' && entry.waitFor) {
          await waitForText(entry.waitFor, 15000);
          await waitForQuiet(100, 2000);
        }
        proc.write(key);
        // Wait for process to react and render next prompt
        await new Promise<void>((r) => setTimeout(r, delay));
        await waitForQuiet(100, 5000);
      }
    };

    void sendKeystrokes();
  });
}
