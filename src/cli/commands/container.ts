/** CLI commands for container runtime management — test and cleanup subcommands. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command } from 'commander';
import { isJsonMode, getConfigPath, EXIT, isInteractive } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { getPaths } from '../../platform/index.js';
import { detectContainerRuntime } from '../../providers/backends/container/index.js';
import type { ContainerRuntime } from '../../providers/backends/container/index.js';

/** Default container image — must match DEFAULT_IMAGE in container-backend.ts. */
const DEFAULT_IMAGE = 'node:lts-slim';

/**
 * Loads the container runtime preference from config, falling back to 'auto'.
 * Returns the runtime preference, container image, and mount_claude_binary override.
 */
async function loadContainerPreferences(): Promise<{
  preference: 'auto' | 'docker' | 'podman';
  image: string;
  mountClaudeBinary: boolean | undefined;
}> {
  try {
    const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
    const config = await loadConfig(configPath);
    return {
      preference: config.provider.container?.runtime ?? 'auto',
      image: config.provider.container?.image ?? DEFAULT_IMAGE,
      mountClaudeBinary: config.provider.container?.mountClaudeBinary,
    };
  } catch {
    return { preference: 'auto', image: DEFAULT_IMAGE, mountClaudeBinary: undefined };
  }
}

/**
 * Determines the mount strategy label from image name and explicit override.
 * Mirrors the logic in ContainerExecutionBackend.shouldMountBinary().
 */
function computeMountStrategy(
  image: string,
  mountClaudeBinary: boolean | undefined,
): 'host-binary' | 'image-builtin' {
  if (mountClaudeBinary !== undefined) {
    return mountClaudeBinary ? 'host-binary' : 'image-builtin';
  }
  return image === DEFAULT_IMAGE ? 'host-binary' : 'image-builtin';
}

/**
 * Detects container runtime or throws CONTAINER_RUNTIME_NOT_FOUND.
 * The thrown error is caught by the CLI global handler which produces
 * the JSON envelope in --json mode and a human-readable message otherwise.
 */
async function getRequiredRuntime(
  preference: 'auto' | 'docker' | 'podman',
): Promise<ContainerRuntime> {
  const runtime = await detectContainerRuntime(preference);
  if (!runtime) {
    throw new ScrowError(
      ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
      'No container runtime found. Install Docker or Podman.',
    );
  }
  return runtime;
}

/** Registers the `container` subcommand group with `test` and `cleanup` subcommands. */
export function registerContainer(program: Command): void {
  const container = program
    .command('container')
    .description('container runtime management commands');

  // ── container test ──────────────────────────────────────────────────
  container
    .command('test')
    .description('validate container runtime end-to-end')
    .option('--verbose', 'show container logs and detailed timing')
    .action(async (opts: { verbose?: boolean }) => {
      const { preference, image, mountClaudeBinary } = await loadContainerPreferences();
      const runtime = await getRequiredRuntime(preference);

      let runtimeVersion = 'unknown';
      let rootless = false;
      try {
        const runtimeInfo = await runtime.info();
        runtimeVersion = runtimeInfo.version;
        rootless = runtimeInfo.rootless;
      } catch {
        // info() failed — continue with unknown version
      }

      const start = Date.now();
      let containerId: string | null = null;
      let tempDir: string | null = null;
      let passed = false;
      let stdout = '';
      let failMessage = '';

      try {
        tempDir = await mkdtemp(join(tmpdir(), 'sparecrow-container-test-'));

        const handle = await runtime.run({
          image,
          command: ['echo', 'sparecrow-container-test'],
          cwd: '/workspace',
          env: {},
          mounts: [{ source: tempDir, target: '/workspace', readonly: false }],
        });
        containerId = handle.containerId;

        const exitResult = await runtime.wait(containerId, 30_000);
        const logResult = await runtime.logs(containerId);
        stdout = logResult.stdout;

        if (exitResult.exitCode === 0 && logResult.stdout.includes('sparecrow-container-test')) {
          passed = true;
        } else {
          failMessage = `Exit code: ${exitResult.exitCode}, stderr: ${logResult.stderr.trim()}`;
        }
      } catch (error: unknown) {
        if (error instanceof ScrowError && error.code === ErrorCode.TASK_TIMEOUT) {
          failMessage = 'Container test timed out after 30 seconds.';
        } else {
          failMessage = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (containerId) {
          try {
            await runtime.remove(containerId);
          } catch {
            // Swallow cleanup errors
          }
        }
        if (tempDir) {
          try {
            await rm(tempDir, { recursive: true, force: true });
          } catch {
            // Swallow cleanup errors
          }
        }
      }

      const durationMs = Date.now() - start;

      // Compute mount strategy for JSON output (AC8: mountStrategy must be present in all JSON responses).
      const mountStrategy = computeMountStrategy(image, mountClaudeBinary);

      // JSON mode: always returns { ok: true, data: { passed: ... }, error: null }.
      // ok:true on test failure is intentional per AC3 — the command itself succeeded in
      // running the test; only the container test result is reported via data.passed.
      // ok:false is reserved for AC6 (no runtime found), handled by getRequiredRuntime().
      if (isJsonMode()) {
        printJson(
          jsonOk({
            runtime: runtime.name,
            version: runtimeVersion,
            rootless,
            image,
            mountStrategy,
            mountClaudeBinary: mountClaudeBinary ?? null,
            containerId,
            durationMs,
            stdout: stdout.trim(),
            passed,
          }),
        );
        process.exit(passed ? EXIT.SUCCESS : EXIT.ERROR);
        return;
      }

      // Human output: failures go to stderr (correct UX — distinguishable from stdout on success).
      // This asymmetry is intentional: success info is informational (stdout), failure is diagnostic (stderr).
      if (passed) {
        process.stdout.write(`Container test passed (${durationMs}ms)\n`);
        process.stdout.write(`  Runtime: ${runtime.name} v${runtimeVersion}\n`);
        process.stdout.write(`  Rootless: ${String(rootless)}\n`);
        process.stdout.write(`  Image: ${image}\n`);
        if (containerId) {
          process.stdout.write(`  Container: ${containerId.slice(0, 12)}\n`);
        }
        if (opts.verbose) {
          process.stdout.write(`  Logs: ${stdout.trim()}\n`);
        }
      } else {
        process.stderr.write(`Container test failed (${durationMs}ms)\n`);
        process.stderr.write(`  Runtime: ${runtime.name} v${runtimeVersion}\n`);
        process.stderr.write(`  Image: ${image}\n`);
        if (failMessage) {
          process.stderr.write(`  Error: ${failMessage}\n`);
        }
        if (opts.verbose && stdout) {
          process.stderr.write(`  Logs: ${stdout.trim()}\n`);
        }
      }

      process.exit(passed ? EXIT.SUCCESS : EXIT.ERROR);
    });

  // ── container cleanup ───────────────────────────────────────────────
  container
    .command('cleanup')
    .description('remove orphaned sparecrow-managed containers')
    .option('--yes', 'skip confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      const { preference } = await loadContainerPreferences();
      const runtime = await getRequiredRuntime(preference);

      // List orphaned containers by sparecrow.managed=true label
      // See: src/providers/backends/container/container-backend.ts for CONTAINER_LABEL_PREFIX
      const containers = await runtime.list({ label: 'sparecrow.managed=true', all: true });

      if (containers.length === 0) {
        if (isJsonMode()) {
          printJson(jsonOk({ found: 0, removed: 0, failed: 0, containers: [] }));
        } else {
          process.stdout.write('No orphaned sparecrow containers found.\n');
        }
        process.exit(EXIT.SUCCESS);
        return;
      }

      // Display list
      if (!isJsonMode()) {
        process.stdout.write(`Found ${containers.length} orphaned container(s):\n`);
        for (const c of containers) {
          process.stdout.write(
            `  ${c.containerId.slice(0, 12)}  ${c.image}  ${c.createdAt}  ${c.status}\n`,
          );
        }
      }

      // Confirmation
      if (!isJsonMode() && !opts.yes) {
        if (!isInteractive()) {
          throw new ScrowError(
            ErrorCode.QUEUE_CONFIRMATION_REQUIRED,
            'Confirmation required. Pass --yes in non-interactive mode.',
          );
        }

        // Dynamic import of @clack/prompts for interactive confirmation
        const { confirm } = await import('@clack/prompts');
        const confirmed = await confirm({
          message: `Remove ${containers.length} container(s)?`,
        });
        if (confirmed !== true) {
          process.stdout.write('Cleanup canceled.\n');
          process.exit(EXIT.SUCCESS);
          return;
        }
      }

      // Remove containers
      let removed = 0;
      let failed = 0;
      const results: Array<{ containerId: string; removed: boolean; error: string | null }> = [];

      for (const c of containers) {
        try {
          await runtime.remove(c.containerId);
          removed++;
          results.push({ containerId: c.containerId, removed: true, error: null });
        } catch (error: unknown) {
          failed++;
          const msg = error instanceof Error ? error.message : String(error);
          results.push({ containerId: c.containerId, removed: false, error: msg });
        }
      }

      if (isJsonMode()) {
        const ok = removed > 0 || failed === 0;
        if (ok) {
          printJson(
            jsonOk({
              found: containers.length,
              removed,
              failed,
              containers: results,
            }),
          );
        } else {
          printJson(
            jsonError(
              ErrorCode.CONTAINER_CLEANUP_FAILED,
              `All ${failed} container removal(s) failed.`,
            ),
          );
        }
        process.exit(removed > 0 || failed === 0 ? EXIT.SUCCESS : EXIT.ERROR);
        return;
      }

      // Human output
      process.stdout.write(`\nCleanup complete: ${removed} removed, ${failed} failed.\n`);
      if (failed > 0) {
        for (const r of results) {
          if (!r.removed) {
            process.stderr.write(
              `  Failed: ${r.containerId.slice(0, 12)} — ${r.error ?? 'unknown error'}\n`,
            );
          }
        }
      }

      // Exit 0 if at least one succeeded; exit 1 only if ALL failed
      process.exit(removed > 0 || failed === 0 ? EXIT.SUCCESS : EXIT.ERROR);
    });
}
