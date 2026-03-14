/** ContainerBackendWrapper -- wraps a container backend with availability checking and recovery logging. */
import type {
  ExecutionBackend,
  BackendExecutionOptions,
  BackendExecutionResult,
  DaemonBackendState,
} from '../../types/index.js';
import { EventName } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { logger } from '../../utils/index.js';
import type { ContainerExecutionBackend } from './container/container-backend.js';

/**
 * Type guard: verifies the primary backend exposes the ContainerExecutionBackend-specific
 * methods that ContainerBackendWrapper depends on at runtime. Since ContainerExecutionBackend
 * is imported with `import type`, there is no runtime instanceof check — this guard provides
 * defense-in-depth against accidental injection of a wrong backend type.
 */
function assertPrimaryHasRequiredMethods(
  primary: unknown,
): asserts primary is ContainerExecutionBackend {
  if (
    typeof primary !== 'object' ||
    primary === null ||
    typeof (primary as Record<string, unknown>)['resetAvailabilityCache'] !== 'function' ||
    typeof (primary as Record<string, unknown>)['getRuntimeInfo'] !== 'function'
  ) {
    throw new ScrowError(
      ErrorCode.BACKEND_NOT_AVAILABLE,
      'ContainerBackendWrapper requires a primary backend with resetAvailabilityCache() and getRuntimeInfo() methods. Ensure a ContainerExecutionBackend is passed as the primary.',
    );
  }
}

export class ContainerBackendWrapper implements ExecutionBackend {
  readonly name = 'container';

  private readonly _primary: ContainerExecutionBackend;
  private _previouslyUnavailable = false;
  /** True once available() has been called at least once — guards against reporting
   * a fabricated availability state before any probe has occurred. */
  private _availabilityProbed = false;

  constructor(primary: ContainerExecutionBackend) {
    // Runtime guard: ensure the primary backend exposes the ContainerExecutionBackend-specific
    // methods that this wrapper calls. Import type does not provide instanceof, so we verify
    // the required methods exist to prevent hard-to-diagnose runtime errors.
    assertPrimaryHasRequiredMethods(primary);
    this._primary = primary;
  }

  /**
   * Internal probe: invalidates cache, checks availability, updates internal state.
   * Does NOT emit dispatch-specific audit events (CONTAINER_DISPATCH_SKIPPED / RECOVERED).
   * Used by both available() and getBackendState() to ensure accurate state without
   * producing audit log spam on routine health checks (AC4).
   */
  private async _probe(): Promise<boolean> {
    this._primary.resetAvailabilityCache();
    try {
      const isAvailable = await this._primary.available();
      this._previouslyUnavailable = !isAvailable;
      return isAvailable;
    } finally {
      // Always mark as probed — even on throw — so callers do not retry indefinitely.
      this._availabilityProbed = true;
    }
  }

  /**
   * Checks primary backend availability (with cache invalidation) and logs state transitions.
   *
   * Logs CONTAINER_DISPATCH_SKIPPED when the container runtime is unavailable (every cycle).
   * Logs CONTAINER_RUNTIME_RECOVERED once when the runtime recovers from an unavailable state.
   */
  async available(): Promise<boolean> {
    const wasPreviouslyUnavailable = this._previouslyUnavailable;
    const isAvailable = await this._probe();

    if (isAvailable) {
      // Recovery: only log if we were previously unavailable.
      if (wasPreviouslyUnavailable) {
        void logger.info(EventName.CONTAINER_RUNTIME_RECOVERED, {
          message: 'Container runtime recovered — resuming container execution.',
        });
      }
      return true;
    }

    // Primary is unavailable — emit dispatch-specific event.
    void logger.warn(EventName.CONTAINER_DISPATCH_SKIPPED, {
      message: 'Container runtime unavailable — dispatch skipped.',
    });
    return false;
  }

  /** Always delegates to primary container backend. */
  async execute(
    command: string,
    args: string[],
    options: BackendExecutionOptions,
  ): Promise<BackendExecutionResult> {
    return this._primary.execute(command, args, options);
  }

  /** Returns current backend state for status writes.
   *  Self-probing: if no probe has occurred yet, calls _probe() to get an accurate
   *  availability result without emitting dispatch-specific audit events (AC1, AC2, AC4). */
  async getBackendState(): Promise<DaemonBackendState> {
    // Lazy one-time probe: ensures the first getBackendState() call returns an accurate
    // availability result even if available() has never been called (AC2).
    if (!this._availabilityProbed) {
      await this._probe();
    }

    let runtime: string | null = null;
    let version: string | null = null;

    try {
      const info = await this._primary.getRuntimeInfo();
      if (info) {
        runtime = info.name;
        version = info.version || null;
      }
    } catch {
      // getRuntimeInfo failed — leave runtime/version as null
    }

    // _probe() guarantees _availabilityProbed is true, so we can rely on _previouslyUnavailable.
    const available = !this._previouslyUnavailable;

    return {
      name: 'container',
      runtime,
      version,
      available,
    };
  }
}
