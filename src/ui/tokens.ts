/** Design tokens — all components use these, never raw strings or hardcoded symbols. */
import { getRenderContext } from './render-context.js';

export const MIN_WIDTH = 40;
export const CARD_WIDTH = 80;
export const CARD_GAP = 2;
export const INDENT = '  ';

/** Returns resolved tokens based on the current RenderContext. */
export function getTokens() {
  const { useUnicode, noColor } = getRenderContext();

  return {
    DOT_OK: noColor ? '[OK] ' : useUnicode ? '●' : '*',
    DOT_ERR: noColor ? '[ERR] ' : useUnicode ? '●' : '*',
    DOT_WARN: noColor ? '[WARN] ' : useUnicode ? '●' : '*',
    DOT_INFO: noColor ? '[INFO] ' : useUnicode ? '●' : '*',
    CHECK_PASS: useUnicode ? '✓' : '[PASS]',
    CHECK_FAIL: useUnicode ? '✗' : '[FAIL]',
    ARROW: useUnicode ? '→' : '->',
    DIVIDER_H: useUnicode ? '─' : '-',
    BOX_TL: useUnicode ? '┌' : '+',
    BOX_TR: useUnicode ? '┐' : '+',
    BOX_BL: useUnicode ? '└' : '+',
    BOX_BR: useUnicode ? '┘' : '+',
    BOX_H: useUnicode ? '─' : '-',
    BOX_V: useUnicode ? '│' : '|',
    BOX_T: useUnicode ? '┬' : '+',
    BOX_B: useUnicode ? '┴' : '+',
    BULLET: useUnicode ? '•' : '*',
    INFO_MARK: useUnicode ? 'ℹ' : '[i]',
  } as const;
}
