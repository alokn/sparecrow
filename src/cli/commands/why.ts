/** why command — explains step-by-step why the queue is or isn't dispatching. */
import { join } from 'node:path';
import type { Command } from 'commander';
import { getPaths } from '../../platform/index.js';
import { safeReadJson, isRecord } from '../../utils/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import type { TriggerConfig, IdleHoursEntry } from '../../types/index.js';
import { isJsonMode, getConfigPath } from '../index.js';
import { ErrorCode } from '../../errors/index.js';

interface TriggerSnapshot {
  shouldDispatch: boolean;
  reason: string;
  evaluatedAt: string | null;
  wastePotential: number | null;
  effectiveReserve: number | null;
  availableBudget: number | null;
  isIdleHours: boolean;
  rateHeadroom: boolean;
  perModelWaste: Array<{ model: string; waste: number }> | null;
}

interface UsageSnapshot {
  sessionUtilization: number | null;
  weeklyUtilization: number | null;
  sessionResetsAt: string | null;
  weeklyResetsAt: string | null;
  confidence: string | null;
}

interface WhyResult {
  dispatching: boolean;
  evaluatedAt: string | null;
  steps: StepResult[];
  verdict: string;
  suggestion: string | null;
}

interface StepResult {
  step: number;
  name: string;
  status: 'pass' | 'fail' | 'active' | 'blocked' | 'skipped' | 'unknown';
  detail: string;
  values?: Record<string, string | number | boolean | null>;
}

export function registerWhy(program: Command): void {
  program
    .command('why')
    .description('explain step-by-step why the queue is or is not dispatching')
    .action(async () => {
      try {
        const paths = getPaths();
        const configPath = resolveConfigFilePath(paths.config, getConfigPath());
        const [statusData, cfg] = await Promise.all([
          safeReadJson<unknown>(join(paths.data, 'daemon-status.json')),
          loadConfig(configPath).catch(() => null),
        ]);

        const trigger = extractTrigger(statusData);
        const usage = extractUsage(statusData);
        const triggerCfg: TriggerConfig = cfg?.trigger ?? {
          maxWastePercentage: 50,
          weeklyReservePercentage: 30,
          idleHours: [],
        };

        const result = buildWhyResult(trigger, usage, triggerCfg);

        if (isJsonMode()) {
          printJson(jsonOk(result));
          return;
        }

        process.stdout.write(renderWhyOutput(result) + '\n');
      } catch (err) {
        if (isJsonMode()) {
          printJson(
            jsonError(ErrorCode.DAEMON_DEGRADED, err instanceof Error ? err.message : String(err)),
          );
          return;
        }
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n  → Run 'sparecrow daemon start' if the daemon is not running.\n`,
        );
        process.exitCode = 1;
      }
    });
}

function extractTrigger(raw: unknown): TriggerSnapshot | null {
  if (!isRecord(raw)) return null;
  const t = raw['trigger'];
  if (!isRecord(t)) return null;
  return {
    shouldDispatch: typeof t['shouldDispatch'] === 'boolean' ? t['shouldDispatch'] : false,
    reason: typeof t['reason'] === 'string' ? t['reason'] : '',
    evaluatedAt: typeof t['evaluatedAt'] === 'string' ? t['evaluatedAt'] : null,
    wastePotential: toFiniteNumber(t['wastePotential']),
    effectiveReserve: toFiniteNumber(t['effectiveReserve']),
    availableBudget: toFiniteNumber(t['availableBudget']),
    isIdleHours: typeof t['isIdleHours'] === 'boolean' ? t['isIdleHours'] : false,
    rateHeadroom: typeof t['rateHeadroom'] === 'boolean' ? t['rateHeadroom'] : true,
    perModelWaste: extractPerModelWaste(t['perModelWaste']),
  };
}

function extractUsage(raw: unknown): UsageSnapshot | null {
  if (!isRecord(raw)) return null;
  const u = raw['usage'];
  if (!isRecord(u)) return null;
  return {
    sessionUtilization: toFiniteNumber(u['sessionUtilization']),
    weeklyUtilization: toFiniteNumber(u['weeklyUtilization']),
    sessionResetsAt: typeof u['sessionResetsAt'] === 'string' ? u['sessionResetsAt'] : null,
    weeklyResetsAt: typeof u['weeklyResetsAt'] === 'string' ? u['weeklyResetsAt'] : null,
    confidence: typeof u['confidence'] === 'string' ? u['confidence'] : null,
  };
}

function extractPerModelWaste(raw: unknown): Array<{ model: string; waste: number }> | null {
  if (!Array.isArray(raw)) return null;
  return (raw as unknown[])
    .filter(
      (e): e is { model: string; waste: number } =>
        isRecord(e) && typeof e['model'] === 'string' && typeof e['waste'] === 'number',
    )
    .map((e) => ({ model: e.model, waste: e.waste }));
}

function buildWhyResult(
  trigger: TriggerSnapshot | null,
  usage: UsageSnapshot | null,
  cfg: TriggerConfig,
): WhyResult {
  if (trigger === null) {
    return {
      dispatching: false,
      evaluatedAt: null,
      steps: [],
      verdict: 'No trigger data available. The daemon may not have run a poll cycle yet.',
      suggestion: "Run 'sparecrow daemon start' and wait for the first poll cycle.",
    };
  }

  const steps: StepResult[] = [];

  // Step 1: Rate Gate
  if (!trigger.rateHeadroom) {
    steps.push({
      step: 1,
      name: 'Rate Gate',
      status: 'fail',
      detail:
        'All rate windows are at or above 80% utilisation. Dispatch is blocked until a window cools down.',
      values: {
        sessionUtilization:
          usage?.sessionUtilization != null ? pct(usage.sessionUtilization) : null,
        threshold: '< 80%',
        resetsIn: usage?.sessionResetsAt ? timeUntil(usage.sessionResetsAt) : null,
      },
    });
  } else {
    steps.push({
      step: 1,
      name: 'Rate Gate',
      status: 'pass',
      detail: 'At least one rate window is below 80% — throughput headroom exists.',
      values: {
        sessionUtilization:
          usage?.sessionUtilization != null ? pct(usage.sessionUtilization) : null,
        threshold: '< 80%',
      },
    });
  }

  // Step 2: Capacity metrics (always computed — show the numbers)
  steps.push({
    step: 2,
    name: 'Capacity Metrics',
    status: 'pass',
    detail: 'Current capacity snapshot used for dispatch decisions.',
    values: {
      wastePotential: trigger.wastePotential != null ? pct(trigger.wastePotential) : null,
      effectiveReserve: trigger.effectiveReserve != null ? pct(trigger.effectiveReserve) : null,
      availableBudget: trigger.availableBudget != null ? pct(trigger.availableBudget) : null,
      weeklyResetsIn: usage?.weeklyResetsAt ? timeUntil(usage.weeklyResetsAt) : null,
    },
  });

  // Step 3: Idle Hours path (if configured)
  if (cfg.idleHours.length > 0) {
    if (trigger.isIdleHours) {
      if (trigger.availableBudget !== null && trigger.availableBudget > 0) {
        steps.push({
          step: 3,
          name: 'Idle Hours',
          status: 'active',
          detail:
            'Currently inside a configured idle window and available budget is positive — dispatching.',
          values: {
            schedule: formatIdleSchedule(cfg.idleHours),
            availableBudget: pct(trigger.availableBudget),
          },
        });
      } else {
        steps.push({
          step: 3,
          name: 'Idle Hours',
          status: 'blocked',
          detail:
            'Currently inside an idle window but available budget is at or below zero (below reserve).',
          values: {
            schedule: formatIdleSchedule(cfg.idleHours),
            availableBudget: trigger.availableBudget != null ? pct(trigger.availableBudget) : null,
            effectiveReserve:
              trigger.effectiveReserve != null ? pct(trigger.effectiveReserve) : null,
          },
        });
      }
    } else {
      steps.push({
        step: 3,
        name: 'Idle Hours',
        status: 'skipped',
        detail: 'Not currently inside any configured idle window — idle dispatch path not taken.',
        values: {
          schedule: formatIdleSchedule(cfg.idleHours),
        },
      });
    }
  }

  // Step 4: Waste Potential path (when not dispatching via idle hours)
  const dispatchingViaIdle = trigger.isIdleHours && trigger.shouldDispatch;
  if (!dispatchingViaIdle) {
    const wasteThresholdFrac = cfg.maxWastePercentage / 100;
    if (trigger.wastePotential !== null) {
      if (trigger.wastePotential > wasteThresholdFrac) {
        steps.push({
          step: cfg.idleHours.length > 0 ? 4 : 3,
          name: 'Waste Potential',
          status: 'active',
          detail: `Waste potential exceeds threshold — dispatching to prevent budget expiry.`,
          values: {
            wastePotential: pct(trigger.wastePotential),
            threshold: `≥ ${cfg.maxWastePercentage}%`,
          },
        });
      } else {
        steps.push({
          step: cfg.idleHours.length > 0 ? 4 : 3,
          name: 'Waste Potential',
          status: 'blocked',
          detail: `Waste potential is below threshold — not enough budget at risk to justify dispatch.`,
          values: {
            wastePotential: pct(trigger.wastePotential),
            threshold: `≥ ${cfg.maxWastePercentage}%`,
            gap: pct(wasteThresholdFrac - trigger.wastePotential),
          },
        });
      }
    }
  }

  const verdict = trigger.shouldDispatch
    ? 'DISPATCHING — conditions met.'
    : `NOT DISPATCHING — ${trigger.reason}`;

  const suggestion = buildSuggestion(trigger, cfg);

  return {
    dispatching: trigger.shouldDispatch,
    evaluatedAt: trigger.evaluatedAt,
    steps,
    verdict,
    suggestion,
  };
}

function buildSuggestion(trigger: TriggerSnapshot, cfg: TriggerConfig): string | null {
  if (trigger.shouldDispatch) return null;

  if (!trigger.rateHeadroom) {
    return 'Wait for the session rate window to cool down — no config change needed.';
  }

  if (trigger.wastePotential !== null) {
    const currentWastePct = Math.round(trigger.wastePotential * 100);
    if (currentWastePct < cfg.maxWastePercentage) {
      return `Lower maxWastePercentage below ${currentWastePct} in config.yaml to dispatch now, or wait until more budget is at risk of expiring.`;
    }
  }

  if (trigger.availableBudget !== null && trigger.availableBudget <= 0) {
    return `Available budget is below the reserve. Lower weeklyReservePercentage (currently ${cfg.weeklyReservePercentage}%) or wait for more capacity.`;
  }

  return null;
}

function renderWhyOutput(result: WhyResult): string {
  const lines: string[] = [];
  const WIDTH = 60;

  const banner = result.dispatching ? '● DISPATCHING' : '○ NOT DISPATCHING';
  lines.push(banner);
  if (result.evaluatedAt) {
    lines.push(`  Evaluated: ${formatRelative(result.evaluatedAt)}`);
  }
  lines.push('');

  for (const step of result.steps) {
    const badge = statusBadge(step.status);
    const header = `Step ${step.step}: ${step.name}`;
    const padding = Math.max(1, WIDTH - header.length - badge.length);
    lines.push(`${header}${' '.repeat(padding)}${badge}`);
    lines.push(`  ${step.detail}`);

    if (step.values) {
      for (const [key, val] of Object.entries(step.values)) {
        if (val === null || val === undefined) continue;
        const label = camelToLabel(key);
        lines.push(`  ${label.padEnd(20)} ${String(val)}`);
      }
    }
    lines.push('');
  }

  lines.push(`Verdict: ${result.verdict}`);
  if (result.suggestion) {
    lines.push('');
    lines.push(`Suggestion: ${result.suggestion}`);
  }

  return lines.join('\n');
}

function statusBadge(status: StepResult['status']): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'active':
      return 'ACTIVE';
    case 'blocked':
      return 'BLOCKED';
    case 'skipped':
      return 'SKIPPED';
    case 'unknown':
      return 'UNKNOWN';
  }
}

function camelToLabel(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function timeUntil(isoStr: string): string {
  const target = new Date(isoStr);
  if (Number.isNaN(target.getTime())) return 'unknown';
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return 'now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatRelative(isoStr: string): string {
  const ts = new Date(isoStr);
  if (Number.isNaN(ts.getTime())) return 'unknown';
  const diff = Date.now() - ts.getTime();
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatIdleSchedule(entries: IdleHoursEntry[]): string {
  return entries
    .map((e) => {
      const days = e.days && e.days.length > 0 ? ` (${e.days.join(', ')})` : ' daily';
      return `${e.start}–${e.end}${days}`;
    })
    .join(', ');
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}
