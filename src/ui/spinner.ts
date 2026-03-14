/** Spinner wrapper — no-op when not a TTY or NO_COLOR. */
import { getRenderContext } from './render-context.js';

export interface Spinner {
  start(text?: string): void;
  stop(): void;
  succeed(text?: string): void;
  fail(text?: string): void;
}

const noop = (): void => {};
const noopSpinner: Spinner = { start: noop, stop: noop, succeed: noop, fail: noop };

export async function createSpinner(text: string): Promise<Spinner> {
  const { isTTY, noColor } = getRenderContext();
  if (!isTTY || noColor) return noopSpinner;

  // Dynamic import so non-TTY environments skip ora entirely
  const { default: ora } = await import('ora');
  const spinner = ora(text);
  return {
    start: (t?: string) => {
      spinner.start(t ?? text);
    },
    stop: () => {
      spinner.stop();
    },
    succeed: (t?: string) => {
      spinner.succeed(t);
    },
    fail: (t?: string) => {
      spinner.fail(t);
    },
  };
}
