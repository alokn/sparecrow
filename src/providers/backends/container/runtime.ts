/** Container runtime abstraction -- unified interface for Docker/Podman container operations. */

export interface Mount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface ContainerRunOptions {
  image: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  mounts: Mount[];
  memoryLimitMb?: number;
  cpuLimit?: number;
  networkMode?: 'bridge' | 'none' | 'host';
  capDrop?: string[];
  securityOpts?: string[];
  tmpfsMounts?: string[];
  labels?: Record<string, string>;
  /** Run the container as a specific user (e.g., '1000:1000'). Defaults to host UID:GID. */
  user?: string;
}

export interface ContainerHandle {
  containerId: string;
}

export interface ContainerExitResult {
  exitCode: number | null;
  oomKilled: boolean;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
}

export interface RuntimeInfo {
  version: string;
  rootless: boolean;
}

/** Filter for listing containers. */
export interface ContainerListFilter {
  /** Filter by label (e.g., 'sparecrow.managed=true'). */
  label?: string;
  /** Include stopped containers. Default: true for cleanup. */
  all?: boolean;
}

/** A single container entry from `docker/podman ps`. */
export interface ContainerListEntry {
  containerId: string;
  image: string;
  createdAt: string;
  status: string;
  names: string;
}

/** Result of an interactive container run (stdin piped, output captured directly). */
export interface InteractiveRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ContainerRuntime {
  name: string;
  available(): Promise<boolean>;
  info(): Promise<RuntimeInfo>;
  run(options: ContainerRunOptions): Promise<ContainerHandle>;
  /**
   * Runs a container interactively: writes stdinData to the container's stdin,
   * captures stdout/stderr directly, and returns the exit code.
   * Uses `-i --rm` instead of `--detach` to support stdin piping.
   * This prevents task prompts from appearing in /proc/PID/cmdline.
   */
  runInteractive(
    options: ContainerRunOptions,
    stdinData: string,
    timeoutMs: number,
  ): Promise<InteractiveRunResult>;
  wait(containerId: string, timeoutMs: number): Promise<ContainerExitResult>;
  logs(containerId: string): Promise<{ stdout: string; stderr: string }>;
  remove(containerId: string): Promise<void>;
  stats(containerId: string): Promise<ContainerStats | null>;
  list(filter: ContainerListFilter): Promise<ContainerListEntry[]>;
}
