/** Renders a horizontal section divider at the configured width (max 80). */
import { getTokens } from './tokens.js';
import { getRenderContext } from './render-context.js';

export function renderSectionDivider(width?: number): string {
  const tokens = getTokens();
  const { width: ctxWidth } = getRenderContext();
  const w = Math.max(1, width ?? ctxWidth);
  return tokens.DIVIDER_H.repeat(w);
}
