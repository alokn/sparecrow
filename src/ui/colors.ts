/** Chalk color theme with NO_COLOR passthrough. */
import chalk from 'chalk';
import { getRenderContext } from './render-context.js';

/** Returns a chalk-like wrapper that is a no-op when NO_COLOR is active. */
function c(colorFn: (text: string) => string): (text: string) => string {
  return (text: string) => {
    const { noColor } = getRenderContext();
    return noColor ? text : colorFn(text);
  };
}

export const color = {
  green: c(chalk.green),
  red: c(chalk.red),
  yellow: c(chalk.yellow),
  cyan: c(chalk.cyan),
  magenta: c(chalk.magenta),
  dim: c(chalk.dim),
  bold: c(chalk.bold),
  white: c(chalk.white),
  boldWhite: c(chalk.bold.white),
};
