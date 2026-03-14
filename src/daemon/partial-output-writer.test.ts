/** Unit tests for PartialOutputWriter — incremental task output file management. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as realFs from 'node:fs';

// Helper to create a temp directory
async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), 'partial-writer-test-' + randomBytes(6).toString('hex'));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('PartialOutputWriter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes chunks to the partial file', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'test-task-id', 0);
    writer.open();
    writer.write('hello ');
    writer.write('world');
    await writer.close();

    const content = await readFile(join(tempDir, 'test-task-id.partial.txt'), 'utf-8');
    expect(content).toContain('hello ');
    expect(content).toContain('world');
  });

  it('returns correct path', async () => {
    const { PartialOutputWriter, partialOutputPath } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'abc-123', 0);
    expect(writer.path).toBe(join(tempDir, 'abc-123.partial.txt'));
    expect(partialOutputPath(tempDir, 'abc-123')).toBe(join(tempDir, 'abc-123.partial.txt'));
  });

  it('cleanup removes the partial file', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'task-cleanup', 0);
    writer.open();
    writer.write('data');
    await writer.close();

    const filePath = join(tempDir, 'task-cleanup.partial.txt');
    // Verify it exists
    await expect(access(filePath)).resolves.toBeUndefined();

    await writer.cleanup();

    // Verify it no longer exists
    await expect(access(filePath)).rejects.toThrow();
  });

  it('cleanup is non-fatal when file does not exist (ENOENT)', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'nonexistent', 0);
    // No open() call — file was never created
    await expect(writer.cleanup()).resolves.toBeUndefined();
  });

  it('close is idempotent (safe to call multiple times)', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'idempotent', 0);
    writer.open();
    writer.write('data');
    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it('write after close is a no-op', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'write-after-close', 0);
    writer.open();
    writer.write('initial');
    await writer.close();

    // Write after close should not throw and should not modify the file
    writer.write('after-close');
    const content = await readFile(join(tempDir, 'write-after-close.partial.txt'), 'utf-8');
    expect(content).toBe('initial');
  });

  it('open is a no-op if called twice', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'double-open', 0);
    writer.open();
    writer.open(); // second call should be a no-op
    writer.write('data');
    await writer.close();

    const content = await readFile(join(tempDir, 'double-open.partial.txt'), 'utf-8');
    expect(content).toBe('data');
  });

  it('debounced flush writes data before close', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    // Use a large debounce so the flush timer doesn't fire automatically
    const writer = new PartialOutputWriter(tempDir, 'debounce-test', 60000);
    writer.open();
    writer.write('debounced chunk');
    // close() should flush pending buffer synchronously before closing
    await writer.close();

    const content = await readFile(join(tempDir, 'debounce-test.partial.txt'), 'utf-8');
    expect(content).toBe('debounced chunk');
  });

  it('accumulates multiple chunks in order', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'multi-chunk', 0);
    writer.open();
    writer.write('chunk1\n');
    writer.write('chunk2\n');
    writer.write('chunk3\n');
    await writer.close();

    const content = await readFile(join(tempDir, 'multi-chunk.partial.txt'), 'utf-8');
    expect(content).toBe('chunk1\nchunk2\nchunk3\n');
  });

  it('write is a no-op before open', async () => {
    const { PartialOutputWriter } = await import('./partial-output-writer.js');
    const writer = new PartialOutputWriter(tempDir, 'no-open', 0);
    // Write without open — should not throw
    writer.write('data');
    await writer.close();

    // File should not exist
    await expect(access(join(tempDir, 'no-open.partial.txt'))).rejects.toThrow();
  });

  it('exports TASK_PARTIAL_OUTPUT_FILENAME_REGEX matching expected pattern', async () => {
    const { TASK_PARTIAL_OUTPUT_FILENAME_REGEX } = await import('./partial-output-writer.js');
    expect(
      TASK_PARTIAL_OUTPUT_FILENAME_REGEX.test('abc12345-1234-1234-1234-abcdef012345.partial.txt'),
    ).toBe(true);
    expect(
      TASK_PARTIAL_OUTPUT_FILENAME_REGEX.test('abc12345-1234-1234-1234-abcdef012345.txt'),
    ).toBe(false);
    expect(TASK_PARTIAL_OUTPUT_FILENAME_REGEX.test('notauuid.partial.txt')).toBe(false);
  });

  it('opens the write stream with mode 0o600 (Story 18.1 AC2)', async () => {
    // Intercept createWriteStream to verify the mode option
    const createWriteStreamCalls: Array<{ path: string; options: object }> = [];
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...realFs,
      createWriteStream: (filePath: string, opts: object) => {
        createWriteStreamCalls.push({ path: String(filePath), options: opts ?? {} });
        return realFs.createWriteStream(filePath, opts);
      },
    }));

    const { PartialOutputWriter: FreshWriter } = await import('./partial-output-writer.js');
    const writer = new FreshWriter(tempDir, 'mode-check-task', 0);
    writer.open();
    await writer.close();

    expect(createWriteStreamCalls.length).toBeGreaterThanOrEqual(1);
    const call = createWriteStreamCalls.find((c) => c.path.includes('mode-check-task'));
    expect(call).toBeDefined();
    expect(call!.options).toMatchObject({ mode: 0o600 });
  });
});

describe('partialOutputPath / finalOutputPath', () => {
  it('partialOutputPath returns correct path', async () => {
    const { partialOutputPath } = await import('./partial-output-writer.js');
    expect(partialOutputPath('/some/dir', 'abc')).toBe('/some/dir/abc.partial.txt');
  });

  it('finalOutputPath returns correct path', async () => {
    const { finalOutputPath } = await import('./partial-output-writer.js');
    expect(finalOutputPath('/some/dir', 'abc')).toBe('/some/dir/abc.txt');
  });
});
