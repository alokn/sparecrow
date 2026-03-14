/** DockerRuntime -- ContainerRuntime implementation using Docker CLI. */
import { AbstractContainerRuntime } from './abstract-runtime.js';
import type { ContainerStats, RuntimeInfo } from './runtime.js';

export class DockerRuntime extends AbstractContainerRuntime {
  readonly name = 'docker';

  get binary(): string {
    return 'docker';
  }

  buildVersionArgs(): string[] {
    return ['version', '--format', '{{.Client.Version}}'];
  }

  buildInfoArgs(): string[] {
    return ['info', '--format', '{{.SecurityOptions}}'];
  }

  /** Fetches Docker version and rootless status. */
  async info(): Promise<RuntimeInfo> {
    const versionResult = await this.execOrThrow(this.binary, this.buildVersionArgs());
    const version = versionResult.stdout.trim();

    const infoResult = await this.execOrThrow(this.binary, this.buildInfoArgs());
    const rootless = infoResult.stdout.toLowerCase().includes('rootless');

    return { version, rootless };
  }

  /**
   * Parses Docker stats JSON format.
   * Docker outputs: {"CPUPerc":"0.00%","MemUsage":"1.5MiB / 512MiB","MemPerc":"0.29%",...}
   * Returns null on malformed or empty JSON input.
   */
  parseStats(json: string): ContainerStats | null {
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const obj = parsed as Record<string, unknown>;
      const cpuPercStr = obj['CPUPerc'];
      const memUsageStr = obj['MemUsage'];

      if (typeof cpuPercStr !== 'string' || typeof memUsageStr !== 'string') return null;

      // Parse CPU percentage: "0.50%" -> 0.50
      const cpuPercent = parseFloat(cpuPercStr.replace('%', ''));
      if (Number.isNaN(cpuPercent)) return null;

      // Parse memory usage: "1.5MiB / 512MiB"
      const memParts = memUsageStr.split('/').map((s) => s.trim());
      if (memParts.length !== 2) return null;

      const memoryUsageMb = parseMemoryString(memParts[0]!);
      const memoryLimitMb = parseMemoryString(memParts[1]!);

      if (memoryUsageMb === null || memoryLimitMb === null) return null;

      return { cpuPercent, memoryUsageMb, memoryLimitMb };
    } catch {
      return null;
    }
  }
}

/**
 * Parses a Docker-style memory string (e.g. "1.5MiB", "512MiB", "2GiB", "1024KiB") to MiB.
 * Returns null on unrecognized format.
 */
function parseMemoryString(s: string): number | null {
  const match = s.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]!);
  if (Number.isNaN(value)) return null;

  const unit = match[2]!;
  switch (unit) {
    case 'B':
      return value / (1024 * 1024);
    case 'KiB':
    case 'kB':
      return value / 1024;
    case 'MiB':
    case 'MB':
      return value;
    case 'GiB':
    case 'GB':
      return value * 1024;
    case 'TiB':
    case 'TB':
      return value * 1024 * 1024;
    default:
      return null;
  }
}
