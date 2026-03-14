/** PodmanRuntime -- ContainerRuntime implementation using Podman CLI. */
import { AbstractContainerRuntime } from './abstract-runtime.js';
import type { ContainerStats, RuntimeInfo } from './runtime.js';

/** Bytes per MiB for converting raw byte values. */
const BYTES_PER_MIB = 1_048_576;

export class PodmanRuntime extends AbstractContainerRuntime {
  readonly name = 'podman';

  get binary(): string {
    return 'podman';
  }

  buildVersionArgs(): string[] {
    return ['version', '--format', '{{.Client.Version}}'];
  }

  buildInfoArgs(): string[] {
    return ['info', '--format', '{{.Host.Security.Rootless}}'];
  }

  /** Fetches Podman version and rootless status. */
  async info(): Promise<RuntimeInfo> {
    const versionResult = await this.execOrThrow(this.binary, this.buildVersionArgs());
    const version = versionResult.stdout.trim();

    const infoResult = await this.execOrThrow(this.binary, this.buildInfoArgs());
    const rootless = infoResult.stdout.trim().toLowerCase() === 'true';

    return { version, rootless };
  }

  /**
   * Parses Podman stats JSON format.
   * Podman outputs: {"cpu_percent":0.00,"mem_usage":1572864,"mem_limit":536870912,...}
   * CPU is a float, memory values are raw bytes.
   * Returns null on malformed or empty JSON input.
   */
  parseStats(json: string): ContainerStats | null {
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const obj = parsed as Record<string, unknown>;
      const cpuPercent = obj['cpu_percent'];
      const memUsage = obj['mem_usage'];
      const memLimit = obj['mem_limit'];

      if (typeof cpuPercent !== 'number') return null;
      if (typeof memUsage !== 'number') return null;
      if (typeof memLimit !== 'number') return null;

      return {
        cpuPercent,
        memoryUsageMb: memUsage / BYTES_PER_MIB,
        memoryLimitMb: memLimit / BYTES_PER_MIB,
      };
    } catch {
      return null;
    }
  }
}
