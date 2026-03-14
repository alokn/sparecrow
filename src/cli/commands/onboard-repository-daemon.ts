/** Onboarding helpers — repository targeting, queue seeding, and daemon install orchestration. */
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { text, select, confirm, isCancel, spinner } from '@clack/prompts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { validateRepository, atomicWrite, logger } from '../../utils/index.js';
import {
  getPaths,
  installService,
  isLinux,
  isMacOS,
  getPlatformServicePath,
  serviceFileExists,
} from '../../platform/index.js';
import { QueueStore, QueueManager } from '../../queue/index.js';
import { loadBuiltins } from '../../templates/index.js';
import { ScrowConfigSchema } from '../../config/index.js';
import { startDaemon, getDaemonStatus, DAEMON_RUNNER_FLAG } from '../../daemon/index.js';
import { getConfigPath } from '../index.js';
import type { OnboardingState } from './onboard-trigger-template.js';

/** Health polling constants. */
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 10_000;

/** Result of the repo targeting stage. */
export interface RepoStageResult {
  targetPath: string;
}

/** Result of queue seeding. */
export interface QueueSeedResult {
  seeded: number;
  skipped: number;
}

/** Result of daemon health verification. */
export interface HealthCheckResult {
  healthy: boolean;
  pid: number | null;
}

/**
 * Prompts the user to select a target repository.
 * Uses cwd as default when it's a valid git repo; otherwise prompts without default.
 * Re-prompts on validation failure until valid or cancelled.
 */
export async function runRepoStage(): Promise<RepoStageResult | symbol> {
  const cwd = process.cwd();
  const cwdCheck = await validateRepository(cwd);
  const defaultPath = cwdCheck.valid ? cwdCheck.absolutePath : undefined;

  while (true) {
    const input = await text({
      message: defaultPath
        ? `Target repository path (Enter to use ${defaultPath}):`
        : 'Target repository path:',
      defaultValue: defaultPath ?? '',
      placeholder: defaultPath ?? '/path/to/your/repo',
      validate(value = '') {
        if (!value.trim() && !defaultPath) return 'Repository path is required.';
        return undefined;
      },
    });

    if (isCancel(input)) return input;

    const rawPath = (input as string).trim() || (defaultPath ?? '');

    const s = spinner();
    s.start('Validating repository...');
    const result = await validateRepository(rawPath);
    s.stop(result.valid ? 'Repository validated' : 'Validation failed');

    if (result.valid) {
      return { targetPath: result.absolutePath };
    }

    process.stdout.write(`  Warning: ${result.error}. Please try another path.\n`);
  }
}

/**
 * Renders a summary of all collected onboarding configuration and returns
 * the user's decision: 'confirm' to proceed, 'edit' to re-edit a stage, or a cancel symbol.
 */
export async function runSummaryStage(
  state: OnboardingState,
  targetPath: string,
  installDaemon: boolean,
): Promise<'confirm' | 'edit' | symbol> {
  process.stdout.write('\n--- Onboarding Summary ---\n');
  process.stdout.write(`  Max waste percentage:  ${state.triggerMaxWastePercentage}%\n`);
  process.stdout.write(`  Weekly reserve:        ${state.triggerWeeklyReservePercentage}%\n`);
  // TODO(15.7-followup): display triggerIdleHours in summary once idle hours are configurable
  process.stdout.write(`  Polling interval:      ${state.pollingInterval} seconds\n`);
  process.stdout.write(
    `  Selected templates:    ${state.selectedTemplates.length > 0 ? state.selectedTemplates.join(', ') : '(none)'}\n`,
  );
  const rt = state.containerRuntime ?? 'auto';
  const ver =
    state.containerRuntimeVersion && state.containerRuntimeVersion !== 'unknown'
      ? `v${state.containerRuntimeVersion}`
      : 'version unknown';
  process.stdout.write(`  Execution backend:     container (${rt}, ${ver})\n`);
  process.stdout.write(`  Target repository:     ${targetPath}\n`);
  process.stdout.write(`  Install daemon:        ${installDaemon ? 'yes' : 'no'}\n`);
  process.stdout.write(
    `  Skip permissions:      ${state.allowDangerouslySkipPermissions ? 'yes' : 'no'}\n`,
  );
  process.stdout.write('\n  Planned actions:\n');
  process.stdout.write('    1. Save configuration\n');
  if (state.selectedTemplates.length > 0) {
    process.stdout.write(
      `    2. Seed queue with ${state.selectedTemplates.length} template(s) targeting ${targetPath}\n`,
    );
    process.stdout.write(
      '       (duplicate pending tasks with same template+target will be skipped)\n',
    );
  }
  if (installDaemon) {
    process.stdout.write('    3. Install and start daemon as system service\n');
    process.stdout.write('    4. Verify daemon health\n');
  }
  process.stdout.write('---\n\n');

  const decision = await text({
    message: 'Press Enter to confirm, or type "e" to edit a setting.',
    defaultValue: '',
    placeholder: 'Enter or e',
    validate(value = '') {
      const t = value.trim().toLowerCase();
      if (t === '' || t === 'e') return undefined;
      return 'Press Enter to confirm or type "e" to edit.';
    },
  });

  if (isCancel(decision)) return decision;
  const trimmed = (decision as string).trim().toLowerCase();
  return trimmed === 'e' ? 'edit' : 'confirm';
}

/** Stage selector for the edit loop. Returns the chosen stage name or cancel symbol. */
export async function runEditStageSelector(): Promise<string | symbol> {
  const result = await select({
    message: 'Which setting would you like to edit?',
    options: [
      { value: 'trigger', label: 'Trigger configuration' },
      { value: 'templates', label: 'Template selection' },
      { value: 'repo', label: 'Target repository' },
      { value: 'permissions', label: 'Permission consent' },
      { value: 'daemon', label: 'Daemon install choice' },
      { value: 'done', label: 'Done editing — return to summary' },
    ],
  });
  if (isCancel(result)) return result;
  return result as string;
}

/** Prompts whether to install daemon (for edit loop override). */
export async function promptInstallDaemon(): Promise<boolean | symbol> {
  const result = await confirm({
    message: 'Install and start daemon as a system service after setup?',
    initialValue: false,
  });
  if (isCancel(result)) return result;
  return result as boolean;
}

/**
 * Seeds the queue with selected templates targeting the repo.
 * Skips any pending task that matches the same (templateName, targetPath).
 * Returns the list of actually seeded template keys for messaging.
 *
 * Note: duplicate check reads the queue once before iteration. A concurrent
 * writer could cause a duplicate if it inserts between our list() and add()
 * calls, but onboarding is single-user interactive so this is acceptable.
 */
export async function seedQueue(
  selectedTemplates: string[],
  targetPath: string,
): Promise<QueueSeedResult & { seededTemplates: string[] }> {
  if (selectedTemplates.length === 0) {
    return { seeded: 0, skipped: 0, seededTemplates: [] };
  }

  const store = new QueueStore(getPaths().data);
  const manager = new QueueManager(store);
  const builtins = await loadBuiltins();

  const existingTasks = await manager.list();
  let seeded = 0;
  let skipped = 0;
  const seededTemplates: string[] = [];

  for (const templateKey of selectedTemplates) {
    const template = builtins.find((t) => t.name === templateKey);
    if (!template) {
      void logger.warn('onboard.seed.template_not_found', { templateKey });
      continue;
    }

    const isDuplicate = existingTasks.some(
      (t) =>
        t.status === 'pending' && t.templateName === templateKey && t.targetPath === targetPath,
    );

    if (isDuplicate) {
      skipped++;
      continue;
    }

    await manager.add({
      type: 'template',
      templateName: templateKey,
      prompt: template.prompt,
      targetPath,
    });
    seeded++;
    seededTemplates.push(templateKey);
  }

  return { seeded, skipped, seededTemplates };
}

/** Persists onboarding configuration (Story 5.2 fields + target repo) via read-merge-validate-atomic-write. */
export async function persistFullConfig(
  state: OnboardingState,
  _targetPath: string,
): Promise<void> {
  const configPath = getConfigPath() ?? join(getPaths().config, 'config.yaml');

  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        `Config file exists but could not be read or parsed: ${configPath}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  const trigger = (raw['trigger'] as Record<string, unknown> | undefined) ?? {};
  const provider = (raw['provider'] as Record<string, unknown> | undefined) ?? {};

  // Map triggerIdleHours to YAML snake_case shape (omit days when undefined)
  const idleHoursYaml = state.triggerIdleHours.map((e) => ({
    start: e.start,
    end: e.end,
    ...(e.days !== undefined ? { days: [...e.days] } : {}),
  }));

  // Set raw['trigger'] (including idle_hours) BEFORE safeParse so validation sees the new data
  raw['trigger'] = {
    ...trigger,
    max_waste_percentage: state.triggerMaxWastePercentage,
    weekly_reserve_percentage: state.triggerWeeklyReservePercentage,
    idle_hours: idleHoursYaml,
  };

  const existingContainer = (provider['container'] as Record<string, unknown>) ?? {};
  raw['provider'] = {
    ...provider,
    allow_dangerously_skip_permissions: state.allowDangerouslySkipPermissions,
    execution_backend: 'container',
    container: {
      ...existingContainer,
      runtime: state.containerRuntime,
    },
  };

  raw['polling_interval'] = state.pollingInterval;

  const validation = ScrowConfigSchema.safeParse(raw);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ScrowError(
      ErrorCode.CONFIG_INVALID,
      `Merged configuration failed validation:\n${issues}`,
    );
  }

  await mkdir(dirname(configPath), { recursive: true });
  await atomicWrite(configPath, stringifyYaml(raw));

  void logger.info('onboard.config.persisted', { event: 'config_saved' });
}

/**
 * Installs and starts the daemon service, then verifies health.
 * Returns health check result. Throws ScrowError on failure.
 */
export async function installAndStartDaemon(): Promise<HealthCheckResult> {
  // Check platform support
  if (!isLinux() && !isMacOS()) {
    throw new ScrowError(
      ErrorCode.PLATFORM_UNSUPPORTED,
      'Daemon service installation is only supported on Linux (systemd) and macOS (launchd).',
    );
  }

  // Install service
  await installService({
    force: true,
    daemonRunnerFlag: DAEMON_RUNNER_FLAG,
  });

  // Start daemon
  try {
    await startDaemon();
  } catch (err) {
    if (err instanceof ScrowError && err.code === ErrorCode.DAEMON_ALREADY_RUNNING) {
      // Daemon was already running — treat as success and verify health
      void logger.info('onboard.daemon.already_running', {});
    } else {
      throw new ScrowError(
        ErrorCode.SERVICE_START_FAILED,
        `Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  // Health verification with bounded polling
  return verifyDaemonHealth();
}

/** Polls daemon status with bounded interval until running or timeout. */
export async function verifyDaemonHealth(): Promise<HealthCheckResult> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus();
    if (status.state === 'running' && status.pid !== null) {
      return { healthy: true, pid: status.pid };
    }
    await new Promise<void>((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return { healthy: false, pid: null };
}

/**
 * Captures pre-apply snapshots for rollback.
 * Returns file contents (or null if not found).
 */
export async function captureSnapshots(): Promise<{
  configSnapshot: string | null;
  queueSnapshot: string | null;
  configPath: string;
  queuePath: string;
}> {
  const configPath = getConfigPath() ?? join(getPaths().config, 'config.yaml');
  const queuePath = join(getPaths().data, 'queue.json');

  const configSnapshot = await readFile(configPath, 'utf-8').catch(() => null);
  const queueSnapshot = await readFile(queuePath, 'utf-8').catch(() => null);

  return { configSnapshot, queueSnapshot, configPath, queuePath };
}

/**
 * Restores pre-apply snapshots on failure.
 * Logs but does not throw if rollback itself fails.
 */
export async function rollbackSnapshots(
  configPath: string,
  configSnapshot: string | null,
  queuePath: string,
  queueSnapshot: string | null,
): Promise<boolean> {
  let success = true;
  try {
    if (configSnapshot !== null) {
      await atomicWrite(configPath, configSnapshot);
    } else {
      // Config didn't exist before — try to remove the newly created one
      const { unlink } = await import('node:fs/promises');
      await unlink(configPath).catch(() => {});
    }
  } catch (err) {
    void logger.error('onboard.rollback.config_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    success = false;
  }

  try {
    if (queueSnapshot !== null) {
      await atomicWrite(queuePath, queueSnapshot);
    }
    // If queue didn't exist before but was created, leave it (empty queue is harmless)
  } catch (err) {
    void logger.error('onboard.rollback.queue_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    success = false;
  }

  return success;
}

/**
 * Removes partially-created service artifacts on rollback (AC9).
 * Only removes the service file if it exists — does not attempt to unload/disable
 * since the service may not have been loaded successfully.
 */
export async function cleanupServiceArtifacts(): Promise<void> {
  try {
    const servicePath = getPlatformServicePath();
    if (await serviceFileExists(servicePath)) {
      const { unlink } = await import('node:fs/promises');
      await unlink(servicePath);
      void logger.info('onboard.rollback.service_artifact_removed', { path: servicePath });
    }
  } catch (err) {
    void logger.error('onboard.rollback.service_cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Detects whether existing config file has onboarding-relevant fields already set.
 * Returns true if config exists and has trigger/provider fields.
 */
export async function detectExistingConfig(): Promise<boolean> {
  const configPath = getConfigPath() ?? join(getPaths().config, 'config.yaml');
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      // Consider config "existing" if it has trigger or provider keys
      return 'trigger' in obj || 'provider' in obj;
    }
    return false;
  } catch {
    return false;
  }
}

/** Prompts reconfigure vs exit for existing config. */
export async function promptReconfigure(): Promise<'reconfigure' | 'exit' | symbol> {
  const result = await select({
    message: 'Existing configuration detected. What would you like to do?',
    options: [
      { value: 'reconfigure', label: 'Reconfigure — update onboarding settings' },
      { value: 'exit', label: 'Exit — keep current configuration' },
    ],
  });
  if (isCancel(result)) return result;
  return result as 'reconfigure' | 'exit';
}

/**
 * Renders the first-dispatch messaging based on daemon status and seeded tasks (AC7).
 * Shows template/repo details when tasks were seeded, or guidance otherwise.
 */
export function renderFirstDispatchMessage(
  daemonHealthy: boolean,
  seeded: number,
  seededTemplates: string[],
  targetPath: string,
): string {
  if (!daemonHealthy) {
    return 'Daemon health verification failed. Run: sparecrow daemon status to check.';
  }

  if (seeded > 0) {
    const taskList = seededTemplates
      .map((t) => `    Task queued: ${t} against ${targetPath}`)
      .join('\n');
    return `${taskList}\n  Daemon monitoring. First task will dispatch when surplus detected.`;
  }

  return 'Daemon is running. No tasks were queued — add tasks with: sparecrow queue add';
}
