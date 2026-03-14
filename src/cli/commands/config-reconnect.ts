/** Re-authentication flow for config --reconnect. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from '../../config/index.js';
import { ClaudeCodeAuthManager } from '../../providers/claude-code/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { getPaths } from '../../platform/index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk } from '../../types/index.js';
import { isJsonMode, getConfigPath } from '../index.js';
import { getDaemonState } from './status-state.js';
import type { DaemonState } from '../../types/index.js';

/** Daemon resume mode derived from current daemon state. */
export type DaemonResumeMode = 'next-poll' | 'on-start' | 'unknown';

/** Reconnect success payload for JSON mode. */
export interface ReconnectSuccessData {
  reauthenticated: true;
  daemonResumeMode: DaemonResumeMode;
}

const CANCELED_EXIT_CODE = 130;

/** Maps daemon state to resume mode for user messaging. */
export function mapDaemonResumeMode(state: DaemonState): DaemonResumeMode {
  if (state === 'running') return 'next-poll';
  if (state === 'stopped') return 'on-start';
  return 'unknown';
}

/** Resolves the Claude binary path from config using the provided paths. */
async function resolveClaudeBinary(paths: { config: string }): Promise<string> {
  const configPath = getConfigPath() ?? join(paths.config, 'config.yaml');
  const cfg = await loadConfig(configPath);
  return cfg.provider.claudePath ?? 'claude';
}

/** Spawns `claude auth login` and returns the exit code or throws on spawn errors. */
function runAuthLogin(
  claudeBinary: string,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary, ['auth', 'login'], { stdio: 'inherit' });

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      resolve({ exitCode: code, signal });
    });
  });
}

/** Sanitizes an error message for user output (strips multi-segment file paths and raw details). */
function sanitizeErrorDetail(message: string): string {
  // Remove absolute file paths (multi-segment only to avoid false positives on short tokens)
  return message
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Main reconnect handler invoked by `sparecrow config --reconnect`. */
export async function handleReconnect(): Promise<void> {
  // AC5a: Non-interactive context check
  if (!process.stdin.isTTY) {
    throw new ScrowError(
      ErrorCode.AUTH_RECONNECT_FAILED,
      'Reconnect requires an interactive terminal. Run this command from an interactive TTY session.',
    );
  }

  // Hoist paths to avoid repeated getPaths() invocations
  const paths = getPaths();

  // Resolve Claude binary path; wrap with reconnect context if config is unreadable
  let claudeBinary: string;
  try {
    claudeBinary = await resolveClaudeBinary(paths);
  } catch {
    throw new ScrowError(
      ErrorCode.AUTH_RECONNECT_FAILED,
      'Cannot load configuration for re-authentication. Run: sparecrow config validate',
    );
  }

  // AC5b: Spawn auth login — catch ENOENT/EACCES
  let authResult: { exitCode: number | null; signal: string | null };
  try {
    authResult = await runAuthLogin(claudeBinary);
  } catch (err: unknown) {
    if (err instanceof Error) {
      const errNode = err as NodeJS.ErrnoException;
      if (errNode.code === 'ENOENT' || errNode.code === 'EACCES') {
        throw new ScrowError(
          ErrorCode.CLAUDE_NOT_FOUND,
          `Claude Code CLI not found or not executable at '${claudeBinary}'.`,
        );
      }
      throw new ScrowError(
        ErrorCode.AUTH_RECONNECT_FAILED,
        `Failed to start authentication: ${sanitizeErrorDetail(errNode.message)}`,
      );
    }
    throw new ScrowError(
      ErrorCode.AUTH_RECONNECT_FAILED,
      'Failed to start authentication: unknown error',
    );
  }

  // AC5d: Canceled login
  if (authResult.exitCode === CANCELED_EXIT_CODE || authResult.signal === 'SIGINT') {
    throw new ScrowError(
      ErrorCode.AUTH_RECONNECT_CANCELED,
      'Re-authentication was canceled by user.',
    );
  }

  // AC5c: Auth command non-zero exit
  if (authResult.exitCode !== 0) {
    throw new ScrowError(
      ErrorCode.AUTH_RECONNECT_FAILED,
      `Claude auth login exited with code ${authResult.exitCode ?? 'unknown'}.`,
    );
  }

  // AC2: Post-login validation gate
  const authManager = new ClaudeCodeAuthManager();
  const isValid = await authManager.validate();
  if (!isValid) {
    throw new ScrowError(
      ErrorCode.AUTH_TOKEN_MISSING,
      'Authentication completed but credential validation failed. Run: sparecrow doctor for diagnosis.',
    );
  }

  // Derive daemon resume mode using hoisted paths
  const daemonInfo = await getDaemonState(paths.data);
  const daemonResumeMode = mapDaemonResumeMode(daemonInfo.state);

  // Output success
  if (isJsonMode()) {
    const data: ReconnectSuccessData = { reauthenticated: true, daemonResumeMode };
    printJson(jsonOk(data));
    return;
  }

  // Human-readable success output (AC3, AC4)
  process.stdout.write('Re-authentication successful.\n');
  if (daemonResumeMode === 'next-poll') {
    process.stdout.write('Usage monitoring resumes on next poll cycle.\n');
  } else if (daemonResumeMode === 'on-start') {
    process.stdout.write('Usage monitoring resumes when daemon is started.\n');
  } else {
    process.stdout.write('Run `sparecrow daemon start` to begin monitoring.\n');
  }
}
