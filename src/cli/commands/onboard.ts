/** Onboard command — run the interactive setup wizard (Stories 5.1 + 5.2 + 5.3). */
import type { Command } from 'commander';
import { intro, outro, confirm, isCancel, spinner } from '@clack/prompts';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { logger } from '../../utils/index.js';
import {
  detectClaudeBinary,
  validateAuth,
  runAuthLogin,
  persistClaudePath,
  renderClaudeNotFoundError,
  renderAuthSuccess,
  renderAuthFailedError,
  renderConfigSaveError,
} from './onboard-auth.js';
import {
  runTriggerStage,
  runTemplateStage,
  runPermissionConsentStage,
  renderTemplateLoadError,
} from './onboard-trigger-template.js';
import type { OnboardingState } from './onboard-trigger-template.js';
import {
  runRepoStage,
  runSummaryStage,
  runEditStageSelector,
  promptInstallDaemon,
  seedQueue,
  persistFullConfig,
  installAndStartDaemon,
  captureSnapshots,
  rollbackSnapshots,
  cleanupServiceArtifacts,
  detectExistingConfig,
  promptReconfigure,
  renderFirstDispatchMessage,
} from './onboard-repository-daemon.js';
import { runContainerDetectionStage } from './onboard-container.js';

export function registerOnboard(program: Command): void {
  program
    .command('onboard')
    .alias('init')
    .description('run the interactive setup wizard')
    .option('--install-daemon', 'Install and start daemon as system service', false)
    .action(async (opts: { installDaemon?: boolean }) => {
      // JSON mode rejection
      if (isJsonMode()) {
        printJson(
          jsonError(
            ErrorCode.CONFIG_INVALID,
            'Onboarding requires an interactive TTY. Run this command without --json in an interactive terminal.',
          ),
        );
        process.exit(1);
        return;
      }

      // Non-TTY gating
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(
          'Onboarding requires an interactive terminal. Run this command in an interactive terminal.\n',
        );
        process.exit(1);
        return;
      }

      await runOnboardingWizard(opts.installDaemon === true);
    });
}

/** Runs the full onboarding wizard. Exits with code 1 on any failure. */
async function runOnboardingWizard(installDaemonFlag: boolean): Promise<void> {
  intro('Welcome to sparecrow setup');

  // ── Existing config detection (AC8) ──────────────────────────────
  const hasExistingConfig = await detectExistingConfig();
  if (hasExistingConfig) {
    const reconfigChoice = await promptReconfigure();
    if (isCancel(reconfigChoice)) {
      outro('Setup cancelled.');
      process.exit(1);
      return;
    }
    if (reconfigChoice === 'exit') {
      outro('Exiting without changes.');
      process.exit(0);
      return;
    }
  }

  // ── Auth stage (Story 5.1) ────────────────────────────────────────
  const s = spinner();
  s.start('Detecting Claude Code installation...');
  const detection = await detectClaudeBinary();
  s.stop('Claude Code detection complete');

  if (!detection.found || !detection.absolutePath) {
    process.stdout.write('\n' + renderClaudeNotFoundError() + '\n');
    void logger.warn('onboard.detection.failed', { error: detection.error ?? 'not found' });
    outro('Setup could not complete. Install Claude Code and try again.');
    process.exit(1);
    return;
  }

  const claudePath = detection.absolutePath;
  void logger.info('onboard.detection.success', { event: 'claude_found' });

  const authResult = await performAuthValidation(claudePath);
  if (!authResult) {
    return;
  }

  try {
    await persistClaudePath(claudePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write('\n' + renderConfigSaveError(msg) + '\n');
    void logger.error('onboard.config.save_failed', { reason: msg });
    outro('Setup could not complete due to a configuration error.');
    process.exit(1);
    return;
  }

  process.stdout.write('\n' + renderAuthSuccess(authResult.tier) + '\n');

  // ── Trigger configuration (Story 5.2) ─────────────────────────────
  let triggerResult = await runTriggerStage();
  if (isCancel(triggerResult)) {
    outro('Setup cancelled.');
    process.exit(1);
    return;
  }

  // ── Template selection (Story 5.2) ────────────────────────────────
  let templateResult: string[] | symbol;
  try {
    templateResult = await runTemplateStage();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write('\n' + renderTemplateLoadError(msg) + '\n');
    void logger.error('onboard.templates.load_failed', { reason: msg });
    outro('Setup could not complete. Verify built-in template files.');
    process.exit(1);
    return;
  }
  if (isCancel(templateResult)) {
    outro('Setup cancelled.');
    process.exit(1);
    return;
  }

  // ── Permission consent (Story 5.2) ────────────────────────────────
  let consentResult = await runPermissionConsentStage();
  if (isCancel(consentResult)) {
    outro('Setup cancelled.');
    process.exit(1);
    return;
  }

  // ── Container detection (Story 12.3) ─────────────────────────────
  // TODO(AC5): wire autoSelectExecutionBackend() here when --yes flag is added
  const containerResult = await runContainerDetectionStage();
  if (isCancel(containerResult)) {
    outro('Setup cancelled.');
    process.exit(1);
    return;
  }

  // ── Repository targeting (Story 5.3 AC1, AC2) ────────────────────
  let repoResult = await runRepoStage();
  if (isCancel(repoResult)) {
    outro('Setup cancelled.');
    process.exit(1);
    return;
  }

  // Build onboarding state
  const containerDetection = containerResult as Exclude<typeof containerResult, symbol>;
  let onboardState: OnboardingState = {
    ...(triggerResult as Exclude<typeof triggerResult, symbol>),
    selectedTemplates: templateResult as string[],
    allowDangerouslySkipPermissions: consentResult as boolean,
    containerRuntime: containerDetection.containerRuntime,
    containerRuntimeVersion: containerDetection.containerRuntimeVersion,
  };
  let targetPath = (repoResult as { targetPath: string }).targetPath;
  let wantInstallDaemon = installDaemonFlag;

  // ── Summary + Edit loop (Story 5.3 AC3) ──────────────────────────
  while (true) {
    const summaryDecision = await runSummaryStage(onboardState, targetPath, wantInstallDaemon);
    if (isCancel(summaryDecision)) {
      outro('Setup cancelled.');
      process.exit(1);
      return;
    }

    if (summaryDecision === 'confirm') {
      break;
    }

    // Edit loop
    const editStage = await runEditStageSelector();
    if (isCancel(editStage)) {
      outro('Setup cancelled.');
      process.exit(1);
      return;
    }

    const stage = editStage as string;

    if (stage === 'done') continue;

    if (stage === 'trigger') {
      const newTrigger = await runTriggerStage();
      if (isCancel(newTrigger)) {
        outro('Setup cancelled.');
        process.exit(1);
        return;
      }
      triggerResult = newTrigger;
      onboardState = {
        ...(triggerResult as Exclude<typeof triggerResult, symbol>),
        selectedTemplates: onboardState.selectedTemplates,
        allowDangerouslySkipPermissions: onboardState.allowDangerouslySkipPermissions,
        containerRuntime: onboardState.containerRuntime,
        containerRuntimeVersion: onboardState.containerRuntimeVersion,
      };
    } else if (stage === 'templates') {
      try {
        const newTemplates = await runTemplateStage();
        if (isCancel(newTemplates)) {
          outro('Setup cancelled.');
          process.exit(1);
          return;
        }
        templateResult = newTemplates;
        onboardState = { ...onboardState, selectedTemplates: templateResult as string[] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write('\n' + renderTemplateLoadError(msg) + '\n');
        void logger.error('onboard.templates.load_failed', { reason: msg });
        outro('Setup could not complete. Verify built-in template files.');
        process.exit(1);
        return;
      }
    } else if (stage === 'repo') {
      const newRepo = await runRepoStage();
      if (isCancel(newRepo)) {
        outro('Setup cancelled.');
        process.exit(1);
        return;
      }
      repoResult = newRepo;
      targetPath = (repoResult as { targetPath: string }).targetPath;
    } else if (stage === 'permissions') {
      const newConsent = await runPermissionConsentStage();
      if (isCancel(newConsent)) {
        outro('Setup cancelled.');
        process.exit(1);
        return;
      }
      consentResult = newConsent;
      onboardState = {
        ...onboardState,
        allowDangerouslySkipPermissions: consentResult as boolean,
      };
    } else if (stage === 'daemon') {
      const daemonChoice = await promptInstallDaemon();
      if (isCancel(daemonChoice)) {
        outro('Setup cancelled.');
        process.exit(1);
        return;
      }
      wantInstallDaemon = daemonChoice as boolean;
    }
  }

  // ── Apply phase (Story 5.3 AC4, AC5, AC6, AC7, AC9) ──────────────
  const snapshots = await captureSnapshots();

  try {
    // Step 1: Persist configuration
    const configSpinner = spinner();
    configSpinner.start('Saving configuration...');
    await persistFullConfig(onboardState, targetPath);
    configSpinner.stop('Configuration saved');

    // Step 2: Seed queue
    let seedResult = { seeded: 0, skipped: 0, seededTemplates: [] as string[] };
    if (onboardState.selectedTemplates.length > 0) {
      const queueSpinner = spinner();
      queueSpinner.start('Seeding task queue...');
      seedResult = await seedQueue(onboardState.selectedTemplates, targetPath);
      queueSpinner.stop(
        `Queue seeded: ${seedResult.seeded} added, ${seedResult.skipped} skipped (duplicates)`,
      );
    }

    // Step 3: Install + start daemon (if requested)
    if (wantInstallDaemon) {
      const installSpinner = spinner();
      installSpinner.start('Installing daemon service...');
      let healthResult;
      try {
        healthResult = await installAndStartDaemon();
        installSpinner.stop('Daemon service installed');
      } catch (installErr) {
        installSpinner.stop('Daemon installation failed');
        throw installErr;
      }

      // Step 4: Health verification
      if (!healthResult.healthy) {
        throw new ScrowError(
          ErrorCode.SERVICE_START_FAILED,
          'Daemon health verification timed out after installation.',
        );
      }

      // ── Success outro with daemon (AC7) ──────────────────────────
      const dispatchMessage = renderFirstDispatchMessage(
        true,
        seedResult.seeded,
        seedResult.seededTemplates,
        targetPath,
      );
      outro(
        `Setup complete! Daemon is running (PID ${healthResult.pid}).\n` +
          `  ${dispatchMessage}\n` +
          '  Run `sparecrow status` to check current state.',
      );
      process.exit(0);
      return;
    }

    // ── Success outro without daemon ──────────────────────────────
    const seedSummary =
      seedResult.seeded > 0 ? `${seedResult.seeded} task(s) queued.` : 'No tasks queued.';
    outro(
      `Setup complete! ${seedSummary}\n` +
        '  Daemon was not installed by this run.\n' +
        '  Next steps:\n' +
        '    - Run `sparecrow daemon install` then `sparecrow daemon start` to begin.\n' +
        '    - Run `sparecrow status` to verify your configuration.',
    );
    process.exit(0);
  } catch (err) {
    // ── Rollback on failure (AC9) ──────────────────────────────────
    void logger.error('onboard.apply.failed', {
      error: err instanceof Error ? err.message : String(err),
    });

    const rollbackOk = await rollbackSnapshots(
      snapshots.configPath,
      snapshots.configSnapshot,
      snapshots.queuePath,
      snapshots.queueSnapshot,
    );

    // Clean up partially-created service artifacts (AC9)
    if (wantInstallDaemon) {
      await cleanupServiceArtifacts();
    }

    if (!rollbackOk) {
      void logger.error('onboard.rollback.partial_failure', {
        code: ErrorCode.ONBOARD_ROLLBACK_FAILED,
      });
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\nSetup failed: ${errorMsg}\n`);

    if (!rollbackOk) {
      process.stdout.write(
        'Warning: Could not fully restore prior state. Run: sparecrow doctor for diagnosis.\n',
      );
    } else {
      process.stdout.write('Prior configuration and queue state have been restored.\n');
    }

    outro('Setup could not complete.');
    process.exit(1);
  }
}

/**
 * Performs auth validation with a single retry remediation loop.
 * Returns AuthValidationResult on success, null on failure (exit has been called).
 */
async function performAuthValidation(
  claudePath: string,
): Promise<{ valid: boolean; tier: string } | null> {
  const s = spinner();
  s.start('Checking authentication...');
  const authResult = await validateAuth(claudePath);
  s.stop('Authentication check complete');

  if (authResult.valid) {
    return authResult;
  }

  const shouldLogin = await confirm({
    message: 'Authentication is missing or expired. Run `claude auth login` to authenticate?',
  });

  if (isCancel(shouldLogin) || !shouldLogin) {
    outro('Setup cancelled.');
    process.exit(1);
    return null;
  }

  const loginOk = await runAuthLogin(claudePath);
  if (!loginOk) {
    process.stdout.write('\n' + renderAuthFailedError() + '\n');
    void logger.warn('onboard.auth.login_subprocess_failed', {});
    outro('Setup could not complete. Run `claude auth login` manually and retry.');
    process.exit(1);
    return null;
  }

  const s2 = spinner();
  s2.start('Verifying authentication after login...');
  const retryResult = await validateAuth(claudePath);
  s2.stop('Re-verification complete');

  if (!retryResult.valid) {
    process.stdout.write('\n' + renderAuthFailedError() + '\n');
    void logger.warn('onboard.auth.retry_failed', {});
    outro('Setup could not complete. Run `sparecrow doctor` for diagnosis.');
    process.exit(1);
    return null;
  }

  return retryResult;
}
