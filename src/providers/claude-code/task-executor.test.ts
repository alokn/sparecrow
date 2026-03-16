/** Unit tests for ClaudeCodeTaskExecutor — subprocess spawn, classification, and contract invariants. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ClaudeCodeTaskExecutor, classifyExit, parseExecutorOutput } from './task-executor.js';
import type {
  ExecutionBackend,
  BackendExecutionResult,
  BackendExecutionOptions,
} from '../../types/index.js';
import type { RequeuePort } from '../../types/index.js';
import type { TaskDefinition, ProviderConfig } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { logger } from '../../utils/index.js';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'claude-code',
    allowDangerouslySkipPermissions: false,
    executionBackend: 'container',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 'task-test-1',
    name: 'test-task',
    type: 'custom',
    status: 'pending',
    prompt: 'do something',
    targetPath: '/tmp',
    priority: 1,
    createdAt: new Date(),
    timeoutMs: 5000,
    actions: [],
    ...overrides,
  };
}

function makeBackendResult(
  overrides: Partial<BackendExecutionResult> = {},
): BackendExecutionResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    oomKilled: false,
    ...overrides,
  };
}

function makeMockBackend(
  result: BackendExecutionResult = makeBackendResult(),
): ExecutionBackend & { execute: ReturnType<typeof vi.fn> } {
  return {
    name: 'mock',
    available: () => Promise.resolve(true),
    execute: vi.fn().mockResolvedValue(result),
  };
}

// ─── classifyExit pure function ───────────────────────────────────────────────

describe('classifyExit', () => {
  it('returns done with null errorCode for exit code 0', () => {
    expect(classifyExit(0, '', '')).toEqual({ status: 'done', errorCode: null });
  });

  it('classifies stderr containing "rate limit" as failed_quota', () => {
    const r = classifyExit(1, '', 'Error: rate limit exceeded');
    expect(r.status).toBe('failed_quota');
    expect(r.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  it('classifies stdout containing "quota" as failed_quota', () => {
    const r = classifyExit(1, 'quota exceeded please wait', '');
    expect(r.status).toBe('failed_quota');
    expect(r.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  it('classifies "capacity exceeded" in stderr as failed_quota', () => {
    const r = classifyExit(2, '', 'capacity exceeded');
    expect(r.status).toBe('failed_quota');
    expect(r.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  it('classifies "too many requests" as failed_quota', () => {
    const r = classifyExit(1, '', 'too many requests');
    expect(r.status).toBe('failed_quota');
    expect(r.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  it('classifies "429" in output as failed_quota', () => {
    const r = classifyExit(1, '', 'HTTP 429 rate limit');
    expect(r.status).toBe('failed_quota');
    expect(r.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  it('performs case-insensitive matching', () => {
    const r = classifyExit(1, '', 'RATE LIMIT EXCEEDED');
    expect(r.status).toBe('failed_quota');
  });

  it('returns failed with TASK_EXECUTION_FAILED errorCode for unrecognised non-zero exit', () => {
    const r = classifyExit(1, 'some output', 'some error');
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe(ErrorCode.TASK_EXECUTION_FAILED);
  });

  it('returns failed with TASK_EXECUTION_FAILED errorCode for null exitCode without quota pattern', () => {
    const r = classifyExit(null, '', 'unexpected crash');
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe(ErrorCode.TASK_EXECUTION_FAILED);
  });
});

// ─── parseExecutorOutput ───────────────────────────────────────────────────────

describe('parseExecutorOutput', () => {
  it('returns raw string unchanged', () => {
    expect(parseExecutorOutput('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(parseExecutorOutput('')).toBe('');
  });

  it('preserves multi-line output', () => {
    const multiline = 'line one\nline two\nline three\n';
    expect(parseExecutorOutput(multiline)).toBe(multiline);
  });

  it('preserves special characters and unicode', () => {
    const special = 'résumé — "quoted" \t tabbed \0 null 🚀';
    expect(parseExecutorOutput(special)).toBe(special);
  });

  it('preserves JSON-shaped output unchanged', () => {
    const json = '{"ok":true,"data":{"result":"done"},"error":null}';
    expect(parseExecutorOutput(json)).toBe(json);
  });

  it('handles output with only whitespace', () => {
    expect(parseExecutorOutput('   \n\t  ')).toBe('   \n\t  ');
  });
});

// ─── ClaudeCodeTaskExecutor — mock backend tests ──────────────────────────────

describe('ClaudeCodeTaskExecutor', () => {
  let tmpDir: string;
  let fakeClaudePath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `task-executor-test-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });
    fakeClaudePath = join(tmpDir, 'claude');
    await writeFile(fakeClaudePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws CLAUDE_NOT_FOUND when claudePath is not set', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(makeConfig(), mockBackend); // no claudePath
    await expect(executor.execute(makeTask())).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('throws CLAUDE_NOT_FOUND when claudePath points to non-existent file', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: '/nonexistent/path/claude' }),
      mockBackend,
    );
    await expect(executor.execute(makeTask())).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('throws CLAUDE_NOT_FOUND when claudePath exists but is not executable', async () => {
    // Create file without execute permission
    const nonExecPath = join(tmpDir, 'claude-noexec');
    await writeFile(nonExecPath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: nonExecPath }),
      mockBackend,
    );
    await expect(executor.execute(makeTask())).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('returns done result with stdout on successful exit (exit code 0)', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ stdout: 'task output\n', exitCode: 0 }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const result = await executor.execute(makeTask());

    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('task output');
    expect(result.error).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it('populates all TaskResult fields on success', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ stdout: 'ok\n', exitCode: 0 }));
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const result = await executor.execute(makeTask());

    expect(result.taskId).toBe('task-test-1');
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it('classifies quota-error exit as failed_quota with QUOTA_EXHAUSTED errorCode', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ stderr: 'rate limit exceeded', exitCode: 1 }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed_quota');
    expect(result.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  it('calls RequeuePort.requeue on failed_quota', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ stderr: 'rate limit exceeded', exitCode: 1 }),
    );
    const mockPort: RequeuePort = { requeue: vi.fn().mockResolvedValue(undefined) };
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
      mockPort,
    );
    const result = await executor.execute(makeTask({ id: 'quota-task-99' }));

    expect(result.status).toBe('failed_quota');
    expect(mockPort.requeue).toHaveBeenCalledOnce();
    expect(mockPort.requeue).toHaveBeenCalledWith('quota-task-99');
  });

  it('does NOT call RequeuePort.requeue on generic failed exit', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ exitCode: 2 }));
    const mockPort: RequeuePort = { requeue: vi.fn().mockResolvedValue(undefined) };
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
      mockPort,
    );
    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed');
    expect(mockPort.requeue).not.toHaveBeenCalled();
  });

  it('returns failed with TASK_EXECUTION_FAILED errorCode on generic non-zero exit', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ stderr: 'something went wrong', exitCode: 3 }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('something went wrong');
    expect(result.errorCode).toBe(ErrorCode.TASK_EXECUTION_FAILED);
  });

  it('includes --dangerously-skip-permissions flag only when config is true', async () => {
    const mockBackendWith = makeMockBackend();
    const executorWith = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath, allowDangerouslySkipPermissions: true }),
      mockBackendWith,
    );
    await executorWith.execute(makeTask({ prompt: 'test-prompt' }));
    const [, argsWith] = mockBackendWith.execute.mock.calls[0]!;
    expect(argsWith).toContain('--dangerously-skip-permissions');

    const mockBackendWithout = makeMockBackend();
    const executorWithout = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath, allowDangerouslySkipPermissions: false }),
      mockBackendWithout,
    );
    await executorWithout.execute(makeTask({ prompt: 'test-prompt' }));
    const [, argsWithout] = mockBackendWithout.execute.mock.calls[0]!;
    expect(argsWithout).not.toContain('--dangerously-skip-permissions');
  });

  it('does not include tokens or full prompt text in logged data (security hygiene)', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ stdout: 'ok\n', exitCode: 0 }));
    const secretPrompt = 'sk-secret-token-123456789';
    // Spy on logger.info to verify the actual log call does not contain the prompt or token
    const loggerInfoSpy = vi.spyOn(logger, 'info').mockResolvedValue(undefined);
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const result = await executor.execute(makeTask({ prompt: secretPrompt }));
    // Verify the actual logger.info calls (task.executor.start, task.executor.success)
    // do not include the secret prompt text in the logged data
    expect(loggerInfoSpy).toHaveBeenCalled();
    for (const call of loggerInfoSpy.mock.calls) {
      const loggedData = JSON.stringify(call[1] ?? {});
      expect(loggedData).not.toContain('sk-secret-token');
      expect(loggedData).not.toContain(secretPrompt);
    }
    // errorCode must be null (success) — never contains prompt text
    expect(result.errorCode).toBeNull();
    // error field must be null on success — never contains prompt text
    expect(result.error).toBeNull();
    loggerInfoSpy.mockRestore();
  });

  it('populates all TaskResult fields on failure (no optional fields missing)', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ exitCode: 1 }));
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const result = await executor.execute(makeTask());

    // All top-level fields must be present (null where required)
    expect(result).toMatchObject({
      taskId: expect.any(String),
      status: expect.any(String),
      startedAt: expect.any(Date),
      completedAt: expect.any(Date),
      durationMs: expect.any(Number),
      stdout: expect.any(String),
      stderr: expect.any(String),
      exitCode: expect.any(Number),
      error: expect.any(String),
      errorCode: ErrorCode.TASK_EXECUTION_FAILED,
    });
  });
});

// ─── ClaudeCodeTaskExecutor — mock backend tests ──────────────────────────────

describe('ClaudeCodeTaskExecutor — mock backend delegation', () => {
  let tmpDir: string;
  let fakeClaudePath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `task-executor-mock-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });
    fakeClaudePath = join(tmpDir, 'claude');
    // Create a minimal executable so access() succeeds
    await writeFile(fakeClaudePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('calls backend.available() before dispatching (H2 — interface contract exercised)', async () => {
    const mockBackend = makeMockBackend();
    const availableSpy = vi.spyOn(mockBackend, 'available');
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask());

    expect(availableSpy).toHaveBeenCalledOnce();
  });

  it('throws BACKEND_NOT_AVAILABLE when backend.available() returns false (H2)', async () => {
    const unavailableBackend: ExecutionBackend = {
      name: 'future-backend',
      available: () => Promise.resolve(false),
      execute: (_command: string, _args: string[], _options: BackendExecutionOptions) =>
        Promise.resolve(makeBackendResult()),
    };
    const executeSpy = vi.spyOn(unavailableBackend, 'execute');
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      unavailableBackend,
    );

    await expect(executor.execute(makeTask())).rejects.toMatchObject({
      code: ErrorCode.BACKEND_NOT_AVAILABLE,
    });
    // execute() should never be called if available() returned false
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('delegates to injected backend execute() method with correct args', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask({ prompt: 'analyze code', targetPath: '/tmp/repo' }));

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [command, args, options] = mockBackend.execute.mock.calls[0]!;
    expect(command).toBe(fakeClaudePath);
    expect(args).toContain('--print');
    // Story 22.2: prompt is passed via stdinData, NOT as a CLI argument
    expect(args).not.toContain('analyze code');
    expect(options.stdinData).toBe('analyze code');
    expect(options.cwd).toBe('/tmp/repo');
    expect(options.timeoutMs).toBe(5000);
  });

  it('returns failed + TASK_TIMEOUT errorCode when backend returns timedOut: true', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ timedOut: true, exitCode: null }));
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    const result = await executor.execute(makeTask({ timeoutMs: 200 }));

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe(ErrorCode.TASK_TIMEOUT);
    expect(result.error).toContain('timeout');
  });

  it('returns failed + cancelled message when backend returns aborted: true', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ aborted: true, exitCode: null }));
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const controller = new AbortController();

    const result = await executor.execute(makeTask(), { signal: controller.signal });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('cancelled');
    expect(result.errorCode).toBeNull();
  });

  it('handles exit classification independent of backend (non-zero exitCode)', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ exitCode: 3, stdout: 'output', stderr: 'some error' }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.errorCode).toBe(ErrorCode.TASK_EXECUTION_FAILED);
  });

  it('propagates ScrowError(CLAUDE_NOT_FOUND) thrown by backend.execute() (enoent path)', async () => {
    const mockBackend = makeMockBackend();
    mockBackend.execute.mockRejectedValue(
      new ScrowError(ErrorCode.CLAUDE_NOT_FOUND, 'Binary not found'),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await expect(executor.execute(makeTask())).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('logs task.executor.backend_error before re-throwing on unexpected backend error (H3)', async () => {
    const mockBackend = makeMockBackend();
    const unexpectedError = new Error('Container runtime crashed unexpectedly');
    mockBackend.execute.mockRejectedValue(unexpectedError);
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockResolvedValue(undefined);
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await expect(executor.execute(makeTask({ id: 'task-h3-test' }))).rejects.toThrow(
      'Container runtime crashed unexpectedly',
    );
    // Verify the error boundary logged before re-throwing
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'task.executor.backend_error',
      expect.objectContaining({ taskId: 'task-h3-test' }),
    );
    loggerErrorSpy.mockRestore();
  });

  it('wires env from TaskExecutorOptions into BackendExecutionOptions (M2)', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );
    const customEnv = { HOME: '/home/test', PATH: '/usr/bin' };

    await executor.execute(makeTask(), { env: customEnv });

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options.env).toEqual(customEnv);
  });

  it('does not set env in BackendExecutionOptions when TaskExecutorOptions.env is absent', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask());

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options).not.toHaveProperty('env');
  });

  it('correctly maps options.healthCheckIntervalMs into BackendExecutionOptions', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask(), { healthCheckIntervalMs: 15000 });

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options.healthCheckIntervalMs).toBe(15000);
  });

  it('does not include healthCheckIntervalMs when not provided in options', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask());

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options).not.toHaveProperty('healthCheckIntervalMs');
  });

  // ── Timeout 0 pass-through (Story 7.19 — AC7) ──────────────────────────

  it('passes timeoutMs: 0 to backend when task has timeoutMs 0', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask({ timeoutMs: 0 }));

    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options.timeoutMs).toBe(0);
  });

  it('uses task.timeoutMs directly — QueuePayloadSchema guarantees nonneg at schema boundary', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    const task = makeTask({ timeoutMs: 3600000 }); // 60 min — matches DEFAULT_TIMEOUT_MS
    await executor.execute(task);

    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options.timeoutMs).toBe(3600000);
  });

  // ── Story 12.6: envStripPatterns forwarding ───────────────────────────────

  it('forwards envStripPatterns from ProviderConfig into BackendExecutionOptions (Story 12.6)', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath, envStripPatterns: ['CUSTOM_*', 'MY_SECRET'] }),
      mockBackend,
    );

    await executor.execute(makeTask());

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options.envStripPatterns).toEqual(['CUSTOM_*', 'MY_SECRET']);
  });

  it('does not include envStripPatterns in BackendExecutionOptions when ProviderConfig.envStripPatterns is undefined', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask());

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options).not.toHaveProperty('envStripPatterns');
  });

  // ── Story 10.11: OOM kill path ──────────────────────────────────────────────

  it('returns failed + TASK_OOM_KILLED when backend returns oomKilled: true', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ exitCode: 137, oomKilled: true, stdout: 'partial', stderr: 'oom err' }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe(ErrorCode.TASK_OOM_KILLED);
    expect(result.error).toContain('insufficient memory');
    expect(result.exitCode).toBe(137);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toBe('oom err');
  });

  it('falls through to classifyExit when oomKilled: false with non-zero exit', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({ exitCode: 1, oomKilled: false, stdout: 'out', stderr: 'some error' }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe(ErrorCode.TASK_EXECUTION_FAILED);
  });

  it('falls through to classifyExit QUOTA_EXHAUSTED when oomKilled: false with quota error', async () => {
    const mockBackend = makeMockBackend(
      makeBackendResult({
        exitCode: 1,
        oomKilled: false,
        stdout: '',
        stderr: 'rate limit exceeded',
      }),
    );
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    const result = await executor.execute(makeTask());

    expect(result.status).toBe('failed_quota');
    expect(result.errorCode).toBe(ErrorCode.QUOTA_EXHAUSTED);
  });

  // ── Story 22.2: Stdin prompt delivery ──────────────────────────────────────

  it('passes prompt via stdinData instead of CLI args (Story 22.2 — /proc/PID/cmdline security)', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask({ prompt: 'secret task prompt' }));

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, args, options] = mockBackend.execute.mock.calls[0]!;
    // Prompt must NOT appear in CLI args (would be visible in /proc/PID/cmdline)
    expect(args).not.toContain('secret task prompt');
    // Prompt must be passed via stdinData
    expect(options.stdinData).toBe('secret task prompt');
    // --print flag must still be present (reads prompt from stdin)
    expect(args).toContain('--print');
  });

  it('always sets stdinData in BackendExecutionOptions regardless of prompt content', async () => {
    const mockBackend = makeMockBackend();
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    // Even empty prompts should use stdinData
    await executor.execute(makeTask({ prompt: '' }));

    expect(mockBackend.execute).toHaveBeenCalledOnce();
    const [, , options] = mockBackend.execute.mock.calls[0]!;
    expect(options.stdinData).toBe('');
  });

  it('logs task.executor.failed with oomKilled: true in data payload', async () => {
    const mockBackend = makeMockBackend(makeBackendResult({ exitCode: 137, oomKilled: true }));
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockResolvedValue(undefined);
    const executor = new ClaudeCodeTaskExecutor(
      makeConfig({ claudePath: fakeClaudePath }),
      mockBackend,
    );

    await executor.execute(makeTask({ id: 'oom-task-1' }));

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'task.executor.failed',
      expect.objectContaining({
        taskId: 'oom-task-1',
        oomKilled: true,
        errorCode: ErrorCode.TASK_OOM_KILLED,
      }),
    );
    loggerWarnSpy.mockRestore();
  });
});
