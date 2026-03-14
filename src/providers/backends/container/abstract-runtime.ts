/** AbstractContainerRuntime -- shared spawn-and-parse logic for Docker/Podman CLI wrappers. */
import { spawn } from 'node:child_process';
import { ScrowError, ErrorCode } from '../../../errors/index.js';
import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerExitResult,
  ContainerStats,
  RuntimeInfo,
  ContainerListFilter,
  ContainerListEntry,
} from './runtime.js';

/** Default timeout in milliseconds for short-lived management commands. */
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  enoent: boolean;
}

export abstract class AbstractContainerRuntime implements ContainerRuntime {
  abstract readonly name: string;

  /** The CLI binary name (e.g. 'docker' or 'podman'). */
  abstract get binary(): string;

  /** Build CLI args to fetch runtime info (version + rootless). */
  abstract buildInfoArgs(): string[];

  /** Build CLI args to fetch version string. */
  abstract buildVersionArgs(): string[];

  /** Parse stats JSON output. Returns null on malformed input. Implemented by subclasses. */
  abstract parseStats(json: string): ContainerStats | null;

  /** Subclass hook for info(). Implemented by each runtime to call the right commands. */
  abstract info(): Promise<RuntimeInfo>;

  /**
   * Spawns a subprocess and captures its output.
   * On ENOENT (binary not found), resolves with enoent: true instead of rejecting.
   * Default timeout: 30 000 ms for management commands.
   */
  protected exec(binary: string, args: string[], timeoutMs?: number): Promise<ExecResult> {
    const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    return new Promise((resolve) => {
      let settled = false;
      let stdoutChunks = '';
      let stderrChunks = '';

      const child = spawn(binary, args, { shell: false, stdio: 'pipe' });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill('SIGKILL');
            resolve({
              stdout: stdoutChunks,
              stderr: stderrChunks,
              exitCode: null,
              enoent: false,
            });
          }
        }, timeout);
      }

      function settle(exitCode: number | null, enoent: boolean): void {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        resolve({
          stdout: stdoutChunks,
          stderr: stderrChunks,
          exitCode,
          enoent,
        });
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks += chunk.toString('utf-8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks += chunk.toString('utf-8');
      });

      child.on('close', (code: number | null) => {
        settle(code, false);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          settle(null, true);
        }
        // Other errors (e.g. EPERM): let 'close' resolve the promise
      });
    });
  }

  /**
   * Like exec(), but throws ScrowError(CONTAINER_RUNTIME_ERROR) on non-zero exit code or ENOENT,
   * and ScrowError(TASK_TIMEOUT) when the command exceeds the timeout (exitCode null, not ENOENT).
   */
  protected async execOrThrow(
    binary: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.exec(binary, args, timeoutMs);

    if (result.enoent) {
      throw new ScrowError(
        ErrorCode.CONTAINER_RUNTIME_ERROR,
        `Container runtime binary '${binary}' not found on PATH.`,
      );
    }

    if (result.exitCode === null) {
      // exitCode is null and not ENOENT -- the management command timed out
      throw new ScrowError(
        ErrorCode.TASK_TIMEOUT,
        `Container command '${binary} ${args.join(' ')}' timed out after ${timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS}ms.`,
      );
    }

    if (result.exitCode !== 0) {
      throw new ScrowError(
        ErrorCode.CONTAINER_RUNTIME_ERROR,
        `Container command '${binary} ${args.join(' ')}' failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }

    return { stdout: result.stdout, stderr: result.stderr };
  }

  /** Returns true if the runtime binary is installed and functional. Never throws. */
  async available(): Promise<boolean> {
    const result = await this.exec(this.binary, ['info']);
    if (result.enoent) return false;
    return result.exitCode === 0;
  }

  /** Creates and starts a container in detached mode. Returns the container ID. */
  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    const args = this.buildRunArgs(options);
    const result = await this.execOrThrow(this.binary, args);
    const containerId = result.stdout.trim();
    return { containerId };
  }

  /**
   * Waits for a container to exit.
   * timeoutMs: 0 means "no timeout" -- the wait subprocess runs until the container exits naturally.
   * On timeout, kills the wait subprocess and throws ScrowError(TASK_TIMEOUT).
   * Container cleanup is the caller's responsibility.
   */
  async wait(containerId: string, timeoutMs: number): Promise<ContainerExitResult> {
    // Use exec with the caller-provided timeout (0 = no timeout)
    const waitResult = await this.exec(this.binary, ['wait', containerId], timeoutMs);

    if (waitResult.enoent) {
      throw new ScrowError(
        ErrorCode.CONTAINER_RUNTIME_ERROR,
        `Container runtime binary '${this.binary}' not found on PATH.`,
      );
    }

    // If the wait subprocess was killed by our timeout, throw TASK_TIMEOUT
    if (waitResult.exitCode === null && !waitResult.enoent) {
      throw new ScrowError(
        ErrorCode.TASK_TIMEOUT,
        `Container '${containerId}' did not exit within ${timeoutMs}ms.`,
      );
    }

    const exitCode = parseInt(waitResult.stdout.trim(), 10);
    const parsedExitCode = Number.isNaN(exitCode) ? null : exitCode;

    // Detect OOM kill via inspect
    let oomKilled = false;
    try {
      const inspectResult = await this.exec(this.binary, [
        'inspect',
        '--format',
        '{{.State.OOMKilled}}',
        containerId,
      ]);
      if (inspectResult.exitCode === 0) {
        oomKilled = inspectResult.stdout.trim().toLowerCase() === 'true';
      }
    } catch {
      // Inspect failed (container already removed) -- assume not OOM killed
      oomKilled = false;
    }

    return { exitCode: parsedExitCode, oomKilled };
  }

  /** Fetches container stdout and stderr logs. */
  async logs(containerId: string): Promise<{ stdout: string; stderr: string }> {
    const result = await this.execOrThrow(this.binary, ['logs', containerId]);
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Force-removes a container.
   * Swallows "no such container" errors (case-insensitive) -- the container may already be gone.
   * Throws ScrowError(CONTAINER_RUNTIME_ERROR) on all other failures.
   */
  async remove(containerId: string): Promise<void> {
    const result = await this.exec(this.binary, ['rm', '--force', containerId]);

    if (result.enoent) {
      throw new ScrowError(
        ErrorCode.CONTAINER_RUNTIME_ERROR,
        `Container runtime binary '${this.binary}' not found on PATH.`,
      );
    }

    if (result.exitCode !== 0) {
      // Swallow "no such container" errors
      if (result.stderr.toLowerCase().includes('no such container')) {
        return;
      }
      throw new ScrowError(
        ErrorCode.CONTAINER_RUNTIME_ERROR,
        `Failed to remove container '${containerId}': ${result.stderr.trim()}`,
      );
    }
  }

  /**
   * Fetches resource usage stats for a container.
   * Returns null when the container is not running (non-zero exit, empty output, or parse failure).
   * Does NOT throw on stats failure.
   */
  async stats(containerId: string): Promise<ContainerStats | null> {
    // Use '{{json .}}' template syntax for universal Docker/Podman compatibility.
    // Docker 25+ accepts '--format json', but '{{json .}}' works on all supported versions.
    const result = await this.exec(this.binary, [
      'stats',
      '--no-stream',
      '--format',
      '{{json .}}',
      containerId,
    ]);

    if (result.exitCode !== 0 || result.enoent) {
      return null;
    }

    const output = result.stdout.trim();
    if (output === '') {
      return null;
    }

    // Take the first non-empty line
    const lines = output.split('\n');
    const firstLine = lines.find((line) => line.trim() !== '');
    if (!firstLine) {
      return null;
    }

    return this.parseStats(firstLine.trim());
  }

  /**
   * Lists containers matching a filter.
   * Uses `--format '{{json .}}'` (Go template syntax) for consistent JSONL output
   * from both Docker and Podman. Returns empty array on any failure (never throws).
   */
  async list(filter: ContainerListFilter): Promise<ContainerListEntry[]> {
    const args: string[] = ['ps'];

    // Default to --all for cleanup (include stopped containers)
    if (filter.all !== false) {
      args.push('--all');
    }

    args.push('--format', '{{json .}}');

    if (filter.label) {
      args.push('--filter', `label=${filter.label}`);
    }

    const result = await this.exec(this.binary, args);

    if (result.enoent || result.exitCode !== 0) {
      return [];
    }

    const output = result.stdout.trim();
    if (output === '') {
      return [];
    }

    const entries: ContainerListEntry[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;

        // Handle Docker (ID, CreatedAt, Names) and Podman (Id, Created, Names) field name differences
        const containerId = String(obj['ID'] ?? obj['Id'] ?? '');
        const image = String(obj['Image'] ?? '');
        const createdAt = String(obj['CreatedAt'] ?? obj['Created'] ?? '');
        const status = String(obj['Status'] ?? '');
        const names = String(obj['Names'] ?? '');

        if (containerId) {
          entries.push({ containerId, image, createdAt, status, names });
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return entries;
  }

  /** Builds `docker/podman run --detach` args from ContainerRunOptions. */
  private buildRunArgs(options: ContainerRunOptions): string[] {
    const args: string[] = ['run', '--detach'];

    if (options.user !== undefined) {
      args.push('--user', options.user);
    }

    args.push('--workdir', options.cwd);

    for (const [key, value] of Object.entries(options.env)) {
      args.push('--env', `${key}=${value}`);
    }

    for (const mount of options.mounts) {
      const mountSpec = mount.readonly
        ? `${mount.source}:${mount.target}:ro`
        : `${mount.source}:${mount.target}`;
      args.push('--volume', mountSpec);
    }

    if (options.memoryLimitMb !== undefined) {
      args.push('--memory', `${options.memoryLimitMb}m`);
    }

    if (options.cpuLimit !== undefined) {
      args.push('--cpus', String(options.cpuLimit));
    }

    if (options.networkMode !== undefined) {
      args.push('--network', options.networkMode);
    }

    if (options.capDrop !== undefined) {
      for (const cap of options.capDrop) {
        args.push('--cap-drop', cap);
      }
    }

    if (options.securityOpts !== undefined) {
      for (const opt of options.securityOpts) {
        args.push('--security-opt', opt);
      }
    }

    if (options.tmpfsMounts !== undefined) {
      for (const tmpfs of options.tmpfsMounts) {
        args.push('--tmpfs', tmpfs);
      }
    }

    if (options.labels !== undefined) {
      for (const [key, value] of Object.entries(options.labels)) {
        args.push('--label', `${key}=${value}`);
      }
    }

    args.push(options.image);
    args.push(...options.command);

    return args;
  }
}
