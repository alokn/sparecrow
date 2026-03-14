/** Renders a dim hint line suggesting next actions. */
import { color } from './colors.js';

export function renderHintLine(text: string): string {
  return color.dim(text);
}
