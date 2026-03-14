/** Unit tests for onboard-trigger-template — validation, trigger stage, template stage, consent, persistence. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import type { IdleHoursEntry } from '../../types/index.js';

const actualConfig =
  await vi.importActual<typeof import('../../config/index.js')>('../../config/index.js');
const actualErrors =
  await vi.importActual<typeof import('../../errors/index.js')>('../../errors/index.js');
const actualUtils =
  await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
const actualPlatform =
  await vi.importActual<typeof import('../../platform/index.js')>('../../platform/index.js');
const actualUi = await vi.importActual<typeof import('../../ui/index.js')>('../../ui/index.js');
const actualFsPromises =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const cancelSymbol = Symbol('cancel');

function mockClack(overrides: Record<string, unknown> = {}) {
  return {
    text: vi.fn().mockResolvedValue(''),
    multiselect: vi.fn().mockResolvedValue([]),
    confirm: vi.fn().mockResolvedValue(false),
    // Default select returns 'balanced' to avoid hanging in non-TTY env.
    // This protects ALL test suites that use mockClack, not just trigger tests.
    select: vi.fn().mockResolvedValue('balanced'),
    isCancel: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function mockLogger() {
  return { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

describe('parseStrictInt()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses valid integer strings', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('80')).toBe(80);
    expect(parseStrictInt('1')).toBe(1);
    expect(parseStrictInt('100')).toBe(100);
    expect(parseStrictInt('300')).toBe(300);
    expect(parseStrictInt('3600')).toBe(3600);
  });

  it('trims whitespace before parsing', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('  80  ')).toBe(80);
    expect(parseStrictInt('\t42\n')).toBe(42);
  });

  it('returns null for empty string', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('')).toBeNull();
    expect(parseStrictInt('  ')).toBeNull();
  });

  it('returns null for decimal notation', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('80.5')).toBeNull();
    expect(parseStrictInt('1.0')).toBeNull();
  });

  it('returns null for negative numbers', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('-80')).toBeNull();
    expect(parseStrictInt('-1')).toBeNull();
  });

  it('returns null for scientific notation', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('8e2')).toBeNull();
    expect(parseStrictInt('1e+3')).toBeNull();
  });

  it('returns null for non-numeric strings', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('abc')).toBeNull();
    expect(parseStrictInt('12abc')).toBeNull();
    expect(parseStrictInt('+80')).toBeNull();
  });

  it('parses zero', async () => {
    const { parseStrictInt } = await import('./onboard-trigger-template.js');
    expect(parseStrictInt('0')).toBe(0);
  });
});

describe('validateBounded()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for values within bounds', async () => {
    const { validateBounded } = await import('./onboard-trigger-template.js');
    expect(validateBounded(50, 'maxWastePercentage')).toBeNull();
    expect(validateBounded(0, 'maxWastePercentage')).toBeNull();
    expect(validateBounded(100, 'maxWastePercentage')).toBeNull();
    expect(validateBounded(30, 'weeklyReservePercentage')).toBeNull();
    expect(validateBounded(300, 'pollingInterval')).toBeNull();
  });

  it('returns error for values below minimum', async () => {
    const { validateBounded } = await import('./onboard-trigger-template.js');
    expect(validateBounded(-1, 'maxWastePercentage')).toContain('between 0 and 100');
    expect(validateBounded(-1, 'weeklyReservePercentage')).toContain('between 0 and 100');
    expect(validateBounded(59, 'pollingInterval')).toContain('between 60 and 3600');
  });

  it('returns error for values above maximum', async () => {
    const { validateBounded } = await import('./onboard-trigger-template.js');
    expect(validateBounded(101, 'maxWastePercentage')).toContain('between 0 and 100');
    expect(validateBounded(101, 'weeklyReservePercentage')).toContain('between 0 and 100');
    expect(validateBounded(3601, 'pollingInterval')).toContain('between 60 and 3600');
  });

  it('returns error for unknown field', async () => {
    const { validateBounded } = await import('./onboard-trigger-template.js');
    expect(validateBounded(50, 'unknownField')).toContain('Unknown field');
  });
});

describe('parseIdleHoursRange()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses overnight range (22:00-06:00)', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('22:00-06:00')).toEqual({ start: '22:00', end: '06:00' });
  });

  it('parses same-day range (09:00-17:00)', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('09:00-17:00')).toEqual({ start: '09:00', end: '17:00' });
  });

  it('returns null for empty string', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('')).toBeNull();
  });

  it('returns null for invalid format', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('not-a-time')).toBeNull();
    expect(parseIdleHoursRange('25:00-06:00')).toBeNull();
    expect(parseIdleHoursRange('22:00-99:99')).toBeNull();
  });

  it('returns null for single-part input', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('22:00')).toBeNull();
  });

  it('parses boundary times (00:00-23:59)', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('00:00-23:59')).toEqual({ start: '00:00', end: '23:59' });
  });

  it('accepts zero-length range (00:00-00:00) — both halves are valid HH:MM strings', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('00:00-00:00')).toEqual({ start: '00:00', end: '00:00' });
  });

  it('rejects input with spaces around hyphen (22:00 - 06:00)', async () => {
    // The parser splits on fixed position 5; char at index 5 is ' ' not '-', so returns null.
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('22:00 - 06:00')).toBeNull();
  });

  it('trims leading/trailing whitespace before parsing', async () => {
    const { parseIdleHoursRange } = await import('./onboard-trigger-template.js');
    expect(parseIdleHoursRange('  22:00-06:00  ')).toEqual({ start: '22:00', end: '06:00' });
  });
});

/**
 * Module-level helper: set up the standard module mocks for runTriggerStage() tests.
 * Consolidated from four identical local copies to prevent maintenance divergence.
 * Must be called after vi.resetModules() (done in each describe's beforeEach).
 */
function setupTriggerMocks(clackOverrides: Record<string, unknown> = {}) {
  vi.doMock('@clack/prompts', () => mockClack(clackOverrides));
  vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
  vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
  vi.doMock('../../errors/index.js', () => ({ ScrowError: class {}, ErrorCode: {} }));
  vi.doMock('../../utils/index.js', () => ({ atomicWrite: vi.fn(), logger: mockLogger() }));
  vi.doMock('../../platform/index.js', () => ({ getPaths: () => ({ config: '/tmp' }) }));
  vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
  vi.doMock('../../ui/index.js', () => ({
    renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
  }));
}

describe('runTriggerStage() — preset selection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns balanced preset values when balanced is selected', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('300'), // polling interval
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage, TRIGGER_DEFAULTS } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toEqual({
      triggerMaxWastePercentage: 50,
      triggerWeeklyReservePercentage: 30,
      triggerIdleHours: [],
      pollingInterval: TRIGGER_DEFAULTS.pollingInterval,
    });
  });

  it('returns conservative preset values when conservative is selected', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('300'), // polling interval
      select: vi.fn().mockResolvedValue('conservative'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toEqual({
      triggerMaxWastePercentage: 70,
      triggerWeeklyReservePercentage: 40,
      triggerIdleHours: [],
      pollingInterval: 300,
    });
  });

  it('returns aggressive preset values when aggressive is selected', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('300'), // polling interval
      select: vi.fn().mockResolvedValue('aggressive'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toEqual({
      triggerMaxWastePercentage: 30,
      triggerWeeklyReservePercentage: 15,
      triggerIdleHours: [],
      pollingInterval: 300,
    });
  });

  it('calls promptNumericField for maxWaste and weeklyReserve when custom is selected', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('80') // maxWastePercentage
        .mockResolvedValueOnce('25') // weeklyReservePercentage
        .mockResolvedValueOnce('600'), // pollingInterval
      select: vi.fn().mockResolvedValue('custom'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toEqual({
      triggerMaxWastePercentage: 80,
      triggerWeeklyReservePercentage: 25,
      triggerIdleHours: [],
      pollingInterval: 600,
    });
  });

  it('does NOT emit the old "press Enter or type c" prompt — only 1 text() call for idle hours when preset is selected', async () => {
    const textMock = vi
      .fn()
      .mockResolvedValueOnce('') // idle hours: skip
      .mockResolvedValueOnce('300'); // polling interval
    setupTriggerMocks({
      text: textMock,
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    await runTriggerStage();
    // 1 text() for idle hours + 1 text() for polling interval = 2 total, NOT 3+
    expect(textMock).toHaveBeenCalledTimes(2);
    // Verify the first text() is the idle hours prompt, NOT the old "press Enter or type c" prompt
    const firstCallArgs = textMock.mock.calls[0]?.[0] as { message: string };
    expect(firstCallArgs?.message).toContain('22:00-06:00');
    expect(firstCallArgs?.message).not.toContain("press Enter or type 'c'");
    expect(firstCallArgs?.message).not.toContain('max-waste=50%');
  });
});

describe('runTriggerStage() — custom entry path', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns custom values from numeric prompts', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('90') // maxWastePercentage
        .mockResolvedValueOnce('35') // weeklyReservePercentage
        .mockResolvedValueOnce('600'), // pollingInterval
      select: vi.fn().mockResolvedValue('custom'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toEqual({
      triggerMaxWastePercentage: 90,
      triggerWeeklyReservePercentage: 35,
      triggerIdleHours: [],
      pollingInterval: 600,
    });
  });
});

describe('runTriggerStage() — idle hours input', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores valid idle hours range in triggerIdleHours', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('22:00-06:00') // idle hours
        .mockResolvedValueOnce('300'), // polling interval
      confirm: vi.fn().mockResolvedValue(false), // no weekend
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toMatchObject({
      triggerIdleHours: [{ start: '22:00', end: '06:00' }],
    });
  });

  it('sets triggerIdleHours to [] when idle hours input is empty', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('300'), // polling interval
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toMatchObject({ triggerIdleHours: [] });
  });

  it('validate callback returns non-empty string on bad idle hours input', async () => {
    // We capture the validate function from the first text() call (idle hours prompt) directly.
    // The second text() call is for pollingInterval and returns '300'.
    // setupTriggerMocks is NOT called here — we set up all mocks in a single vi.doMock call
    // to avoid the first mock being silently overridden by a second vi.doMock for the same module.
    let capturedValidate: ((input: string) => string | undefined) | undefined;
    let callCount = 0;
    vi.doMock('@clack/prompts', () =>
      mockClack({
        text: vi
          .fn()
          .mockImplementation((opts: { validate?: (input: string) => string | undefined }) => {
            callCount++;
            if (callCount === 1 && opts.validate) capturedValidate = opts.validate;
            return Promise.resolve(callCount === 1 ? '' : '300');
          }),
        select: vi.fn().mockResolvedValue('balanced'),
      }),
    );
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({ ScrowError: class {}, ErrorCode: {} }));
    vi.doMock('../../utils/index.js', () => ({ atomicWrite: vi.fn(), logger: mockLogger() }));
    vi.doMock('../../platform/index.js', () => ({ getPaths: () => ({ config: '/tmp' }) }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    await runTriggerStage();

    expect(capturedValidate).toBeDefined();
    const errorMsg = capturedValidate!('not-a-valid-time');
    expect(errorMsg).toBeTruthy();
    expect(typeof errorMsg).toBe('string');
    expect((errorMsg as string).length).toBeGreaterThan(0);
  });

  it('returns cancel symbol when user cancels at idle hours prompt', async () => {
    setupTriggerMocks({
      text: vi.fn().mockResolvedValue(cancelSymbol),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });
});

describe('runTriggerStage() — weekend question', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends saturday/sunday entry when user answers yes to weekend question', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('22:00-06:00') // idle hours
        .mockResolvedValueOnce('300'), // polling interval
      confirm: vi.fn().mockResolvedValue(true), // yes to weekend
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toMatchObject({
      triggerIdleHours: [
        { start: '22:00', end: '06:00' },
        { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] as const },
      ],
    });
  });

  it('leaves idleHours unchanged when user answers no to weekend question', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('22:00-06:00') // idle hours
        .mockResolvedValueOnce('300'), // polling interval
      confirm: vi.fn().mockResolvedValue(false), // no to weekend
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toMatchObject({
      triggerIdleHours: [{ start: '22:00', end: '06:00' }],
    });
  });

  it('does NOT show weekend question when idle hours are skipped', async () => {
    const confirmMock = vi.fn().mockResolvedValue(false);
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('300'), // polling interval
      confirm: confirmMock,
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    await runTriggerStage();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('returns cancel symbol when user cancels at weekend confirm', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('22:00-06:00') // idle hours
        .mockResolvedValueOnce('300'), // polling interval
      confirm: vi.fn().mockResolvedValue(cancelSymbol),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      select: vi.fn().mockResolvedValue('balanced'),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });
});

describe('runTriggerStage() — cancellation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cancel symbol when user cancels at idle hours prompt', async () => {
    setupTriggerMocks({
      text: vi.fn().mockResolvedValue(cancelSymbol),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });

  it('returns cancel symbol when user cancels at preset select', async () => {
    setupTriggerMocks({
      text: vi.fn().mockResolvedValue(''), // idle hours: skip
      select: vi.fn().mockResolvedValue(cancelSymbol),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });

  it('returns cancel symbol when user cancels at pollingInterval prompt (preset path)', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce(cancelSymbol), // polling interval: cancel
      select: vi.fn().mockResolvedValue('balanced'),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });

  it('returns cancel symbol when user cancels during custom maxWastePercentage prompt', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce(cancelSymbol), // maxWastePercentage: cancel
      select: vi.fn().mockResolvedValue('custom'),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });

  it('returns cancel symbol when user cancels at pollingInterval prompt (custom path)', async () => {
    setupTriggerMocks({
      text: vi
        .fn()
        .mockResolvedValueOnce('') // idle hours: skip
        .mockResolvedValueOnce('80') // maxWastePercentage
        .mockResolvedValueOnce('25') // weeklyReservePercentage
        .mockResolvedValueOnce(cancelSymbol), // pollingInterval: cancel
      select: vi.fn().mockResolvedValue('custom'),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
    });

    const { runTriggerStage } = await import('./onboard-trigger-template.js');
    const result = await runTriggerStage();
    expect(result).toBe(cancelSymbol);
  });
});

describe('runTemplateStage()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all templates when user accepts defaults', async () => {
    const builtins = [
      {
        name: 'security-audit',
        description: 'Security review',
        prompt: 'p',
        type: 'built-in' as const,
      },
      { name: 'improve-code', description: 'Code review', prompt: 'p', type: 'built-in' as const },
    ];
    const expectedKeys = builtins.map((t) => t.name);
    vi.doMock('@clack/prompts', () =>
      mockClack({ multiselect: vi.fn().mockResolvedValue(expectedKeys) }),
    );
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(builtins),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    const result = await runTemplateStage();
    expect(result).toEqual(expectedKeys);
  });

  it('returns partial selection', async () => {
    const builtins = [
      { name: 'security-audit', description: 'Security', prompt: 'p', type: 'built-in' as const },
      { name: 'improve-code', description: 'Code', prompt: 'p', type: 'built-in' as const },
    ];
    vi.doMock('@clack/prompts', () =>
      mockClack({ multiselect: vi.fn().mockResolvedValue(['improve-code']) }),
    );
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(builtins),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    const result = await runTemplateStage();
    expect(result).toEqual(['improve-code']);
  });

  it('returns empty array when user confirms empty selection', async () => {
    const builtins = [
      { name: 'security-audit', description: 'Security', prompt: 'p', type: 'built-in' as const },
    ];
    vi.doMock('@clack/prompts', () =>
      mockClack({
        multiselect: vi.fn().mockResolvedValue([]),
        confirm: vi.fn().mockResolvedValue(true),
      }),
    );
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(builtins),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    const result = await runTemplateStage();
    expect(result).toEqual([]);
  });

  it('loops back to multiselect when user declines empty selection', async () => {
    const builtins = [
      { name: 'security-audit', description: 'Security', prompt: 'p', type: 'built-in' as const },
    ];
    const multiselectMock = vi
      .fn()
      .mockResolvedValueOnce([]) // first: empty
      .mockResolvedValueOnce(['security-audit']); // second: selected
    vi.doMock('@clack/prompts', () =>
      mockClack({
        multiselect: multiselectMock,
        confirm: vi.fn().mockResolvedValue(false), // decline empty
      }),
    );
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(builtins),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    const result = await runTemplateStage();
    expect(result).toEqual(['security-audit']);
    expect(multiselectMock).toHaveBeenCalledTimes(2);
  });

  it('throws when loadBuiltins fails with TEMPLATE_LOAD_ERROR', async () => {
    vi.doMock('@clack/prompts', () => mockClack());
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('file not found'), { code: 'TEMPLATE_LOAD_ERROR' }),
        ),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class extends Error {
        code: string;
        constructor(code: string, msg: string) {
          super(msg);
          this.code = code;
        }
      },
      ErrorCode: { TEMPLATE_LOAD_ERROR: 'TEMPLATE_LOAD_ERROR' },
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    await expect(runTemplateStage()).rejects.toThrow('file not found');
  });

  it('throws when loadBuiltins returns empty array', async () => {
    vi.doMock('@clack/prompts', () => mockClack());
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class extends Error {
        code: string;
        constructor(code: string, msg: string) {
          super(msg);
          this.code = code;
        }
      },
      ErrorCode: { TEMPLATE_LOAD_ERROR: 'TEMPLATE_LOAD_ERROR' },
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    await expect(runTemplateStage()).rejects.toMatchObject({
      code: 'TEMPLATE_LOAD_ERROR',
    });
  });

  it('returns cancel symbol when user cancels multiselect', async () => {
    const builtins = [
      { name: 'security-audit', description: 'Security', prompt: 'p', type: 'built-in' as const },
    ];
    vi.doMock('@clack/prompts', () =>
      mockClack({
        multiselect: vi.fn().mockResolvedValue(cancelSymbol),
        isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      }),
    );
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(builtins),
    }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class extends Error {
        code: string;
        constructor(code: string, msg: string) {
          super(msg);
          this.code = code;
        }
      },
      ErrorCode: { TEMPLATE_LOAD_ERROR: 'TEMPLATE_LOAD_ERROR' },
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runTemplateStage } = await import('./onboard-trigger-template.js');
    const result = await runTemplateStage();
    expect(result).toBe(cancelSymbol);
  });
});

describe('runPermissionConsentStage()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when user consents', async () => {
    vi.doMock('@clack/prompts', () => mockClack({ confirm: vi.fn().mockResolvedValue(true) }));
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runPermissionConsentStage } = await import('./onboard-trigger-template.js');
    const result = await runPermissionConsentStage();
    expect(result).toBe(true);
  });

  it('returns false when user declines', async () => {
    vi.doMock('@clack/prompts', () => mockClack({ confirm: vi.fn().mockResolvedValue(false) }));
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runPermissionConsentStage } = await import('./onboard-trigger-template.js');
    const result = await runPermissionConsentStage();
    expect(result).toBe(false);
  });

  it('returns cancel symbol when user cancels', async () => {
    vi.doMock('@clack/prompts', () =>
      mockClack({
        confirm: vi.fn().mockResolvedValue(cancelSymbol),
        isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      }),
    );
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../config/index.js', () => ({ ScrowConfigSchema: {} }));
    vi.doMock('../../errors/index.js', () => ({
      ScrowError: class {},
      ErrorCode: {},
    }));
    vi.doMock('../../utils/index.js', () => ({
      atomicWrite: vi.fn(),
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: '/tmp' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../ui/index.js', () => ({
      renderErrorBlock: vi.fn().mockReturnValue('ERROR'),
    }));

    const { runPermissionConsentStage } = await import('./onboard-trigger-template.js');
    const result = await runPermissionConsentStage();
    expect(result).toBe(cancelSymbol);
  });
});

describe('persistOnboardingConfig()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'onboard-52-test-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // triggerIdleHours: [] is required now that OnboardingState has this field
  const defaultState = {
    triggerMaxWastePercentage: 50,
    triggerWeeklyReservePercentage: 30,
    triggerIdleHours: [] as IdleHoursEntry[],
    pollingInterval: 300,
    selectedTemplates: ['improve-code'],
    allowDangerouslySkipPermissions: false,
    containerRuntime: 'docker' as const,
    containerRuntimeVersion: '24.0.1',
  };

  /** Helper: set up mocks for persistence tests — real schema, real errors, mocked logger. */
  function mockForPersistence(configPath: string, utilsOverrides: Record<string, unknown> = {}) {
    vi.doMock('@clack/prompts', () => mockClack());
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../config/index.js', () => actualConfig);
    vi.doMock('../../errors/index.js', () => actualErrors);
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: mockLogger(),
      ...utilsOverrides,
    }));
    vi.doMock('../../platform/index.js', () => actualPlatform);
    vi.doMock('../../ui/index.js', () => actualUi);
    // Reset node:fs/promises to real implementation (previous tests may have mocked readFile)
    vi.doMock('node:fs/promises', () => actualFsPromises);
  }

  it('writes Story 5.2 fields to new config file', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig(defaultState);

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('max_waste_percentage: 50');
    expect(content).toContain('weekly_reserve_percentage: 30');
    expect(content).toContain('polling_interval: 300');
    expect(content).toContain('allow_dangerously_skip_permissions: false');
  });

  it('writes idle_hours to config when triggerIdleHours is non-empty', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig({
      ...defaultState,
      triggerIdleHours: [{ start: '22:00', end: '06:00' }],
    });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('idle_hours');
    expect(content).toContain('22:00');
    expect(content).toContain('06:00');
  });

  it('writes idle_hours: [] when triggerIdleHours is empty', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig({ ...defaultState, triggerIdleHours: [] });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('idle_hours');
  });

  it('writes weekend entry with days when present', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig({
      ...defaultState,
      triggerIdleHours: [
        { start: '22:00', end: '06:00' },
        { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] as const },
      ],
    });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('saturday');
    expect(content).toContain('sunday');
  });

  it('passes ScrowConfigSchema validation when weekday and weekend entries are both present', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    // Should not throw — both entries are schema-valid
    await expect(
      persistOnboardingConfig({
        ...defaultState,
        triggerIdleHours: [
          { start: '22:00', end: '06:00' },
          { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] as const },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves existing config keys when merging', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(
      configPath,
      'polling_interval: 120\nprovider:\n  name: claude-code\n  claude_path: /usr/bin/claude\n',
      'utf-8',
    );
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig(defaultState);

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('claude_path: /usr/bin/claude');
    expect(content).toContain('name: claude-code');
    expect(content).toContain('max_waste_percentage: 50');
    expect(content).toContain('polling_interval: 300');
  });

  it('skips write when all values already match (idempotent) — ?? [] guard is load-bearing for missing idle_hours key', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    // Config file has no idle_hours key — defaultState has triggerIdleHours: []
    // JSON.stringify(trigger['idle_hours'] ?? []) === JSON.stringify([]) so early-return fires
    await writeFile(
      configPath,
      [
        'polling_interval: 300',
        'trigger:',
        '  max_waste_percentage: 50',
        '  weekly_reserve_percentage: 30',
        'provider:',
        '  name: claude-code',
        '  allow_dangerously_skip_permissions: false',
        '',
      ].join('\n'),
      'utf-8',
    );
    const atomicWriteMock = vi.fn();
    mockForPersistence(configPath, { atomicWrite: atomicWriteMock });

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig(defaultState);
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('writes when only idle_hours changed', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    // Config has empty idle_hours; state now has a non-empty one — must write
    await writeFile(
      configPath,
      [
        'polling_interval: 300',
        'trigger:',
        '  max_waste_percentage: 50',
        '  weekly_reserve_percentage: 30',
        '  idle_hours: []',
        'provider:',
        '  name: claude-code',
        '  allow_dangerously_skip_permissions: false',
        '',
      ].join('\n'),
      'utf-8',
    );
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig({
      ...defaultState,
      triggerIdleHours: [{ start: '22:00', end: '06:00' }],
    });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('22:00');
  });

  it('round-trips a no-days entry: second persist skips write when idle_hours unchanged', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    // First persist: write idle hours without days
    const { persistOnboardingConfig: persist1 } = await import('./onboard-trigger-template.js');
    await persist1({ ...defaultState, triggerIdleHours: [{ start: '22:00', end: '06:00' }] });

    // Second persist in a fresh module context
    vi.resetModules();
    const atomicWriteMock = vi.fn();
    mockForPersistence(configPath, { atomicWrite: atomicWriteMock });
    const { persistOnboardingConfig: persist2 } = await import('./onboard-trigger-template.js');
    await persist2({ ...defaultState, triggerIdleHours: [{ start: '22:00', end: '06:00' }] });

    // Second persist should skip write since values are identical
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('throws CONFIG_INVALID when idle_hours entry has invalid time string', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    // This state cannot be produced through the wizard (parser prevents it) but defends standalone API
    await expect(
      persistOnboardingConfig({
        ...defaultState,
        triggerIdleHours: [{ start: '25:00', end: '06:00' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('throws CONFIG_INVALID when config file is unreadable (not ENOENT)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    vi.doMock('@clack/prompts', () => mockClack());
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../errors/index.js', () => actualErrors);
    vi.doMock('../../config/index.js', () => actualConfig);
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => actualPlatform);
    vi.doMock('../../ui/index.js', () => actualUi);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await expect(persistOnboardingConfig(defaultState)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('writes allow_dangerously_skip_permissions: true when consent is true', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await persistOnboardingConfig({
      ...defaultState,
      allowDangerouslySkipPermissions: true,
    });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('allow_dangerously_skip_permissions: true');
  });

  it('throws CONFIG_INVALID when existing config file contains malformed YAML', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    vi.doMock('@clack/prompts', () => mockClack());
    vi.doMock('../../templates/index.js', () => ({ loadBuiltins: vi.fn() }));
    vi.doMock('../../config/index.js', () => actualConfig);
    vi.doMock('../../errors/index.js', () => actualErrors);
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: vi.fn().mockResolvedValue('[unclosed bracket'),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: mockLogger(),
    }));
    vi.doMock('../../platform/index.js', () => actualPlatform);
    vi.doMock('../../ui/index.js', () => actualUi);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await expect(persistOnboardingConfig(defaultState)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('throws CONFIG_INVALID when merged config fails schema validation', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    // log_retention_days: 0 is not overwritten by Story 5.2 fields and fails schema min(1)
    await writeFile(configPath, 'log_retention_days: 0\n', 'utf-8');
    mockForPersistence(configPath);

    const { persistOnboardingConfig } = await import('./onboard-trigger-template.js');
    await expect(persistOnboardingConfig(defaultState)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

describe('renderTemplateLoadError()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error block with reason and recovery hint', async () => {
    // Ensure real dependencies (not leftover mocks from other tests)
    vi.doMock('../../ui/index.js', () => actualUi);
    const { renderTemplateLoadError } = await import('./onboard-trigger-template.js');
    const result = renderTemplateLoadError('file not found');
    expect(result).toContain('Template loading failed');
    expect(result).toContain('file not found');
    expect(result).toContain('sparecrow doctor');
  });
});

describe('renderConfigPersistError()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error block with reason and recovery hint', async () => {
    vi.doMock('../../ui/index.js', () => actualUi);
    const { renderConfigPersistError } = await import('./onboard-trigger-template.js');
    const result = renderConfigPersistError('permission denied');
    expect(result).toContain('Failed to save configuration');
    expect(result).toContain('permission denied');
    expect(result).toContain('sparecrow doctor');
  });
});
