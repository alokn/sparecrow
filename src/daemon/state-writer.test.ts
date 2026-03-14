/** Unit tests for daemon state writer atomic persistence contract. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  writeDaemonStatus,
  writeRunningStatus,
  writeStoppingStatus,
  writeStoppedStatus,
  writeErrorStatus,
  writeDegradedStatus,
  writeCycleStatus,
  buildLastErrorDetail,
} from './state-writer.js';
import { getPaths } from '../platform/index.js';
import { atomicWrite } from '../utils/index.js';

vi.mock('../platform/index.js', () => ({
  ensureDirectories: vi.fn().mockResolvedValue(undefined),
  getPaths: vi.fn(),
}));

vi.mock('../utils/index.js', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
}));

function getPayload(): Record<string, unknown> {
  const [, rawJson] = vi.mocked(atomicWrite).mock.calls[0]!;
  return JSON.parse(rawJson as string) as Record<string, unknown>;
}

const MOCK_PATHS = {
  config: '/tmp/config',
  data: '/tmp/state',
  logs: '/tmp/state/logs',
  taskOutputs: '/tmp/state/task-outputs',
};

describe('writeDaemonStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes all required top-level fields always present', async () => {
    await writeDaemonStatus({
      state: 'running',
      startedAt: '2026-02-25T12:00:00.000Z',
      lastPollAt: '2026-02-25T12:00:01.000Z',
      nextPollAt: '2026-02-25T12:05:01.000Z',
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: '2026-02-25T12:00:01.000Z',
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
      backendState: null,
    });

    const payload = getPayload();

    expect(payload['state']).toBe('running');
    expect(payload['startedAt']).toBe('2026-02-25T12:00:00.000Z');
    expect(payload['lastPollAt']).toBe('2026-02-25T12:00:01.000Z');
    expect(payload['nextPollAt']).toBe('2026-02-25T12:05:01.000Z');
    expect(payload['usage']).toBeNull();
    expect(payload['trigger']).toBeNull();
    expect(payload['activeTask']).toBeNull();
    expect(payload['lastError']).toBeNull();
    expect(payload['lastDispatchAt']).toBeNull();
    expect(payload['cycleResult']).toBeNull();
    expect(payload['queueDepth']).toBe(0);
  });
});

describe('buildLastErrorDetail', () => {
  it('returns object with code, message, and null recoveryCommand by default', () => {
    const detail = buildLastErrorDetail('SOME_CODE', 'something failed');
    expect(detail).toEqual({
      code: 'SOME_CODE',
      message: 'something failed',
      recoveryCommand: null,
    });
  });

  it('includes recoveryCommand when provided', () => {
    const detail = buildLastErrorDetail(
      'AUTH_TOKEN_EXPIRED',
      'token expired',
      'sparecrow reconnect',
    );
    expect(detail).toEqual({
      code: 'AUTH_TOKEN_EXPIRED',
      message: 'token expired',
      recoveryCommand: 'sparecrow reconnect',
    });
  });
});

describe('writeRunningStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes state=running with non-null pid and startedAt', async () => {
    const startedAt = '2026-02-25T08:00:00.000Z';
    await writeRunningStatus(startedAt, 12345);

    const payload = getPayload();

    expect(payload['state']).toBe('running');
    expect(payload['startedAt']).toBe(startedAt);
    expect(payload['pid']).toBe(12345);
    expect(payload['lastError']).toBeNull();
    expect(typeof payload['updatedAt']).toBe('string');
  });

  it('includes all required top-level fields', async () => {
    await writeRunningStatus('2026-02-25T08:00:00.000Z', 999);
    const payload = getPayload();
    for (const field of [
      'state',
      'startedAt',
      'lastPollAt',
      'nextPollAt',
      'usage',
      'trigger',
      'activeTask',
      'lastError',
      'lastErrorDetail',
      'updatedAt',
      'lastDispatchAt',
      'cycleResult',
      'queueDepth',
      'pid',
    ]) {
      expect(payload).toHaveProperty(field);
    }
  });
});

describe('writeStoppingStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes state=stopping with provided startedAt', async () => {
    const startedAt = '2026-02-25T08:00:00.000Z';
    await writeStoppingStatus(startedAt);

    const payload = getPayload();

    expect(payload['state']).toBe('stopping');
    expect(payload['startedAt']).toBe(startedAt);
    expect(payload['pid']).toBeNull();
  });

  it('writes state=stopping with null startedAt', async () => {
    await writeStoppingStatus(null);
    const payload = getPayload();
    expect(payload['state']).toBe('stopping');
    expect(payload['startedAt']).toBeNull();
  });
});

describe('writeStoppedStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes state=stopped with provided startedAt', async () => {
    const startedAt = '2026-02-25T08:00:00.000Z';
    await writeStoppedStatus(startedAt);

    const payload = getPayload();

    expect(payload['state']).toBe('stopped');
    expect(payload['startedAt']).toBe(startedAt);
  });

  it('writes state=stopped with null startedAt', async () => {
    await writeStoppedStatus(null);
    const payload = getPayload();
    expect(payload['state']).toBe('stopped');
    expect(payload['startedAt']).toBeNull();
  });
});

describe('writeErrorStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes state=error with lastError string', async () => {
    await writeErrorStatus('2026-02-25T08:00:00.000Z', 'poll cycle failed');

    const payload = getPayload();

    expect(payload['state']).toBe('error');
    expect(payload['lastError']).toBe('poll cycle failed');
    expect(payload['lastErrorDetail']).toBeNull();
  });

  it('includes lastErrorDetail when provided', async () => {
    const detail = buildLastErrorDetail('DAEMON_POLL_FAILED', 'poll failed', 'sparecrow status');
    await writeErrorStatus('2026-02-25T08:00:00.000Z', 'poll failed', detail);

    const payload = getPayload();

    expect(payload['state']).toBe('error');
    expect(payload['lastError']).toBe('poll failed');
    expect(payload['lastErrorDetail']).toEqual({
      code: 'DAEMON_POLL_FAILED',
      message: 'poll failed',
      recoveryCommand: 'sparecrow status',
    });
  });

  it('writes state=error with null startedAt', async () => {
    await writeErrorStatus(null, 'fatal error');
    const payload = getPayload();
    expect(payload['state']).toBe('error');
    expect(payload['startedAt']).toBeNull();
  });
});

describe('writeDegradedStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes state=running (not error) to avoid false CLI error reporting', async () => {
    await writeDegradedStatus('2026-02-25T08:00:00.000Z', 'auth refresh failed');

    const payload = getPayload();

    expect(payload['state']).toBe('running');
    expect(payload['lastError']).toBe('auth refresh failed');
    expect(payload['lastErrorDetail']).toBeNull();
  });

  it('includes lastErrorDetail when provided', async () => {
    const detail = buildLastErrorDetail('DAEMON_DEGRADED', 'degraded', 'sparecrow reconnect');
    await writeDegradedStatus('2026-02-25T08:00:00.000Z', 'degraded', detail);

    const payload = getPayload();

    expect(payload['state']).toBe('running');
    expect(payload['lastErrorDetail']).toEqual({
      code: 'DAEMON_DEGRADED',
      message: 'degraded',
      recoveryCommand: 'sparecrow reconnect',
    });
  });

  it('differs from writeErrorStatus only in state field', async () => {
    await writeDegradedStatus(null, 'degraded');
    const degraded = getPayload();

    vi.clearAllMocks();

    await writeErrorStatus(null, 'degraded');
    const errored = getPayload();

    expect(degraded['state']).toBe('running');
    expect(errored['state']).toBe('error');
    // All other fields have the same shape
    expect(degraded['lastError']).toBe(errored['lastError']);
  });
});

describe('writeCycleStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPaths).mockReturnValue(MOCK_PATHS);
  });

  it('writes state=running with full cycle data', async () => {
    await writeCycleStatus({
      startedAt: '2026-02-25T08:00:00.000Z',
      lastPollAt: '2026-02-25T10:00:00.000Z',
      nextPollAt: '2026-02-25T10:05:00.000Z',
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: null,
      lastDispatchAt: '2026-02-25T09:55:00.000Z',
      cycleResult: null,
      queueDepth: 3,
      pid: 42,
    });

    const payload = getPayload();

    expect(payload['state']).toBe('running');
    expect(payload['lastPollAt']).toBe('2026-02-25T10:00:00.000Z');
    expect(payload['nextPollAt']).toBe('2026-02-25T10:05:00.000Z');
    expect(payload['queueDepth']).toBe(3);
    expect(payload['pid']).toBe(42);
    expect(typeof payload['updatedAt']).toBe('string');
  });

  it('writes activeTask with taskType field when provided', async () => {
    await writeCycleStatus({
      startedAt: '2026-02-25T08:00:00.000Z',
      lastPollAt: '2026-02-25T10:00:00.000Z',
      nextPollAt: '2026-02-25T10:05:00.000Z',
      usage: null,
      trigger: null,
      activeTask: {
        taskId: 'task-1',
        taskName: 'security-audit',
        taskType: 'template',
        startedAt: '2026-02-25T10:00:05.000Z',
      },
      lastError: null,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 2,
      pid: 42,
    });

    const payload = getPayload();
    const activeTask = payload['activeTask'] as Record<string, unknown>;

    expect(activeTask['taskId']).toBe('task-1');
    expect(activeTask['taskName']).toBe('security-audit');
    expect(activeTask['taskType']).toBe('template');
    expect(activeTask['startedAt']).toBe('2026-02-25T10:00:05.000Z');
  });

  it('defaults pid to null when not provided', async () => {
    await writeCycleStatus({
      startedAt: null,
      lastPollAt: '2026-02-25T10:00:00.000Z',
      nextPollAt: '2026-02-25T10:05:00.000Z',
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: null,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
    });

    const payload = getPayload();
    expect(payload['pid']).toBeNull();
  });

  it('includes lastErrorDetail when provided', async () => {
    const detail = buildLastErrorDetail('QUOTA_EXHAUSTED', 'quota hit');
    await writeCycleStatus({
      startedAt: null,
      lastPollAt: '2026-02-25T10:00:00.000Z',
      nextPollAt: '2026-02-25T10:05:00.000Z',
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: 'quota hit',
      lastErrorDetail: detail,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
    });

    const payload = getPayload();
    expect(payload['lastError']).toBe('quota hit');
    expect(payload['lastErrorDetail']).toEqual({
      code: 'QUOTA_EXHAUSTED',
      message: 'quota hit',
      recoveryCommand: null,
    });
  });
});

describe('writeUnexpectedExitStatus (Story 14.3)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'state-writer-14-3-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('preserves usage data from existing status file on unexpected exit (AC1)', async () => {
    // Write a pre-existing daemon-status.json with usage data
    const existingStatus = {
      state: 'running',
      startedAt: '2026-03-05T10:00:00.000Z',
      lastPollAt: '2026-03-05T10:05:00.000Z',
      nextPollAt: '2026-03-05T10:10:00.000Z',
      usage: {
        sessionUtilization: 42,
        weeklyUtilization: 15,
        sessionResetsAt: '2026-03-05T15:00:00.000Z',
        weeklyResetsAt: '2026-03-10T00:00:00.000Z',
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: 'max5',
        degradedReason: null,
      },
      trigger: {
        shouldDispatch: true,
        reason: 'threshold met',
        evaluatedAt: '2026-03-05T10:05:00.000Z',
        snapshotSource: 'oauth',
      },
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: '2026-03-05T10:05:00.000Z',
      lastDispatchAt: '2026-03-05T10:04:00.000Z',
      cycleResult: { dispatched: 1, succeeded: 1, failed: 0 },
      queueDepth: 3,
      pid: 12345,
      backendState: { name: 'container', runtime: 'docker', version: '24.0.0', available: true },
    };
    await writeFile(join(tmpDir, 'daemon-status.json'), JSON.stringify(existingStatus));

    // Capture atomic writes
    const writtenPayloads: Array<Record<string, unknown>> = [];

    vi.doMock('../platform/index.js', () => ({
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
      getPaths: () => ({
        data: tmpDir,
        config: tmpDir,
        logs: tmpDir,
        taskOutputs: tmpDir,
      }),
    }));

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: async (_path: string, content: string) => {
        writtenPayloads.push(JSON.parse(content) as Record<string, unknown>);
      },
    }));

    const { writeUnexpectedExitStatus } = await import('./state-writer.js');

    const errorDetail = {
      code: 'DAEMON_LOOP_EXITED',
      message: 'loop crashed',
      recoveryCommand: 'sparecrow daemon restart',
    };
    await writeUnexpectedExitStatus(
      '2026-03-05T10:00:00.000Z',
      '2026-03-05T10:05:00.000Z',
      'loop crashed',
      errorDetail,
    );

    expect(writtenPayloads.length).toBe(1);
    const payload = writtenPayloads[0]!;

    // AC1: Preserved fields from existing status
    expect(payload['usage']).toEqual(existingStatus.usage);
    expect(payload['trigger']).toEqual(existingStatus.trigger);
    expect(payload['lastDispatchAt']).toBe(existingStatus.lastDispatchAt);
    expect(payload['cycleResult']).toEqual(existingStatus.cycleResult);
    expect(payload['queueDepth']).toBe(existingStatus.queueDepth);
    expect(payload['backendState']).toEqual(existingStatus.backendState);

    // AC1: Caller-supplied startedAt and lastPollAt are forwarded (not inherited from existing)
    expect(payload['startedAt']).toBe('2026-03-05T10:00:00.000Z');
    expect(payload['lastPollAt']).toBe('2026-03-05T10:05:00.000Z');

    // AC1: Error fields populated
    expect(payload['state']).toBe('stopped');
    expect(payload['lastError']).toBe('loop crashed');
    expect(payload['lastErrorDetail']).toEqual(errorDetail);

    // AC3: pid and nextPollAt set to null
    expect(payload['pid']).toBeNull();
    expect(payload['nextPollAt']).toBeNull();
    expect(payload['activeTask']).toBeNull();

    // Contract: updatedAt must be a fresh ISO 8601 string (not inherited from existing spread)
    expect(typeof payload['updatedAt']).toBe('string');
    expect(payload['updatedAt']).not.toBe(existingStatus.updatedAt);
  });

  it('falls back to nulls when status file is missing (AC2)', async () => {
    // No pre-existing daemon-status.json — tmpDir is empty

    const writtenPayloads: Array<Record<string, unknown>> = [];

    vi.doMock('../platform/index.js', () => ({
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
      getPaths: () => ({
        data: tmpDir,
        config: tmpDir,
        logs: tmpDir,
        taskOutputs: tmpDir,
      }),
    }));

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: async (_path: string, content: string) => {
        writtenPayloads.push(JSON.parse(content) as Record<string, unknown>);
      },
    }));

    const { writeUnexpectedExitStatus } = await import('./state-writer.js');

    const errorDetail = {
      code: 'DAEMON_LOOP_EXITED',
      message: 'loop exited',
      recoveryCommand: null,
    };
    await writeUnexpectedExitStatus('2026-03-05T10:00:00.000Z', null, 'loop exited', errorDetail);

    expect(writtenPayloads.length).toBe(1);
    const payload = writtenPayloads[0]!;

    // AC2: Fallback to nulls
    expect(payload['usage']).toBeNull();
    expect(payload['trigger']).toBeNull();
    expect(payload['lastDispatchAt']).toBeNull();
    expect(payload['cycleResult']).toBeNull();
    expect(payload['queueDepth']).toBe(0);
    expect(payload['backendState']).toBeNull();

    // Error fields still populated
    expect(payload['state']).toBe('stopped');
    expect(payload['lastError']).toBe('loop exited');
    expect(payload['pid']).toBeNull();
    expect(payload['nextPollAt']).toBeNull();

    // Contract: updatedAt must be a fresh ISO 8601 string
    expect(typeof payload['updatedAt']).toBe('string');
    expect(payload['updatedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to nulls when status file contains corrupted JSON (AC2)', async () => {
    // Write corrupted JSON to daemon-status.json
    await writeFile(join(tmpDir, 'daemon-status.json'), '{ this is not valid json !!!');

    const writtenPayloads: Array<Record<string, unknown>> = [];

    vi.doMock('../platform/index.js', () => ({
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
      getPaths: () => ({
        data: tmpDir,
        config: tmpDir,
        logs: tmpDir,
        taskOutputs: tmpDir,
      }),
    }));

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: async (_path: string, content: string) => {
        writtenPayloads.push(JSON.parse(content) as Record<string, unknown>);
      },
    }));

    const { writeUnexpectedExitStatus } = await import('./state-writer.js');

    const errorDetail = { code: 'DAEMON_LOOP_EXITED', message: 'crash', recoveryCommand: null };
    await writeUnexpectedExitStatus('2026-03-05T10:00:00.000Z', null, 'crash', errorDetail);

    expect(writtenPayloads.length).toBe(1);
    const payload = writtenPayloads[0]!;

    // AC2: Corrupted file => fallback to nulls
    expect(payload['usage']).toBeNull();
    expect(payload['trigger']).toBeNull();
    expect(payload['queueDepth']).toBe(0);
    expect(payload['state']).toBe('stopped');
    expect(payload['pid']).toBeNull();

    // Contract: updatedAt must be a fresh ISO 8601 string
    expect(typeof payload['updatedAt']).toBe('string');
    expect(payload['updatedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sets pid to null and nextPollAt to null on unexpected exit (AC3)', async () => {
    // Write existing status with a valid pid and nextPollAt
    const existingStatus = {
      state: 'running',
      startedAt: '2026-03-05T10:00:00.000Z',
      lastPollAt: '2026-03-05T10:05:00.000Z',
      nextPollAt: '2026-03-05T10:10:00.000Z',
      usage: null,
      trigger: null,
      activeTask: {
        taskId: 't-1',
        taskName: 'test',
        taskType: 'template',
        startedAt: '2026-03-05T10:05:00.000Z',
      },
      lastError: null,
      lastErrorDetail: null,
      updatedAt: '2026-03-05T10:05:00.000Z',
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: 99999,
      backendState: null,
    };
    await writeFile(join(tmpDir, 'daemon-status.json'), JSON.stringify(existingStatus));

    const writtenPayloads: Array<Record<string, unknown>> = [];

    vi.doMock('../platform/index.js', () => ({
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
      getPaths: () => ({
        data: tmpDir,
        config: tmpDir,
        logs: tmpDir,
        taskOutputs: tmpDir,
      }),
    }));

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: async (_path: string, content: string) => {
        writtenPayloads.push(JSON.parse(content) as Record<string, unknown>);
      },
    }));

    const { writeUnexpectedExitStatus } = await import('./state-writer.js');

    const errorDetail = { code: 'DAEMON_LOOP_EXITED', message: 'exit', recoveryCommand: null };
    await writeUnexpectedExitStatus(
      '2026-03-05T10:00:00.000Z',
      '2026-03-05T10:05:00.000Z',
      'exit',
      errorDetail,
    );

    expect(writtenPayloads.length).toBe(1);
    const payload = writtenPayloads[0]!;

    // AC3: pid and nextPollAt must be null despite existing status having non-null values
    expect(payload['pid']).toBeNull();
    expect(payload['nextPollAt']).toBeNull();
    // AC3: activeTask must be null (daemon is no longer running)
    expect(payload['activeTask']).toBeNull();

    // Contract: updatedAt must be a fresh ISO 8601 string (not inherited from existing spread)
    expect(typeof payload['updatedAt']).toBe('string');
    expect(payload['updatedAt']).not.toBe(existingStatus.updatedAt);
  });
});
