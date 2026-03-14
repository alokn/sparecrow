/** Detects terminal capabilities and provides a RenderContext for all UI components. */

/** Width mode derived from the terminal width with deterministic breakpoints. */
export type WidthMode = 'compact' | 'standard' | 'full' | 'wide';

export interface RenderContext {
  noColor: boolean; // true when color is disabled (non-TTY, NO_COLOR, or FORCE_COLOR absent+non-TTY)
  useUnicode: boolean; // locale supports unicode
  width: number; // terminal width, min 40, no upper clamp
  isTTY: boolean; // stdout is a TTY
  widthMode: WidthMode; // derived from width with deterministic breakpoints
  colorEnabled: boolean; // inverse of noColor
  spinnerEnabled: boolean; // isTTY && !noColor
  truncationEnabled: boolean; // isTTY only — non-TTY always disables truncation
}

let _ctx: RenderContext | null = null;

/** Derives the WidthMode from a resolved width value. */
function deriveWidthMode(width: number): WidthMode {
  if (width < 60) return 'compact';
  if (width < 80) return 'standard';
  if (width < 120) return 'full';
  return 'wide';
}

/** Sanitizes a raw width value: falls back to 80 for undefined/NaN/0/negative. */
function sanitizeWidth(raw: number | undefined): number {
  if (raw === undefined || raw === null || isNaN(raw) || raw <= 0) return 80;
  return Math.max(40, raw);
}

export function getRenderContext(): RenderContext {
  if (_ctx) return _ctx;

  const isTTY = Boolean(process.stdout.isTTY);

  // Capability precedence:
  // 1. isTTY=false (highest): forces noColor=true, useUnicode=false
  // 2. NO_COLOR env var (non-empty): forces noColor=true regardless of FORCE_COLOR
  // 3. FORCE_COLOR env var (non-empty): forces color on when isTTY=true and NO_COLOR absent/empty
  let noColor: boolean;
  if (!isTTY) {
    noColor = true;
  } else if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    noColor = true;
  } else if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '') {
    noColor = false;
  } else {
    noColor = false;
  }

  // Unicode detection: check LANG/LC_ALL/LC_CTYPE for UTF-8
  const locale = (
    process.env['LC_ALL'] ??
    process.env['LC_CTYPE'] ??
    process.env['LANG'] ??
    ''
  ).toLowerCase();
  const useUnicode = isTTY && (locale.includes('utf-8') || locale.includes('utf8'));

  const rawWidth = process.stdout.columns;
  const width = sanitizeWidth(rawWidth);

  const widthMode = deriveWidthMode(width);
  const colorEnabled = !noColor;
  const spinnerEnabled = isTTY && !noColor;
  const truncationEnabled = isTTY;

  _ctx = {
    noColor,
    useUnicode,
    isTTY,
    width,
    widthMode,
    colorEnabled,
    spinnerEnabled,
    truncationEnabled,
  };
  return _ctx;
}

/** Override context — used in tests to simulate different terminal environments. */
export function setRenderContext(partial: Partial<RenderContext>): void {
  const base = getRenderContext();

  // Sanitize incoming width if provided, before merging
  const sanitizedPartial = { ...partial };
  if ('width' in partial) {
    sanitizedPartial.width = sanitizeWidth(partial.width);
  }

  const merged = { ...base, ...sanitizedPartial };

  // Re-derive computed fields from base fields if not explicitly provided
  if (!('widthMode' in partial)) {
    merged.widthMode = deriveWidthMode(merged.width);
  }
  if (!('colorEnabled' in partial)) {
    merged.colorEnabled = !merged.noColor;
  }
  if (!('spinnerEnabled' in partial)) {
    merged.spinnerEnabled = merged.isTTY && !merged.noColor;
  }
  if (!('truncationEnabled' in partial)) {
    merged.truncationEnabled = merged.isTTY;
  }

  _ctx = merged;
}

/** Reset context — call in afterEach in tests. */
export function resetRenderContext(): void {
  _ctx = null;
}
