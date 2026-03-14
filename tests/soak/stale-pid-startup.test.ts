/** Soak test — stale PID file recovery on daemon startup (AC4, Story 18.5). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

describe('stale-pid-startup', () => {
  let tmpDataDir: string;

  beforeEach(async () => {
    tmpDataDir = join(tmpdir(), `soak-pid-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDataDir, { recursive: true, force: true });
  });

  it('detects stale PID for non-existent process and removes the PID file', async () => {
    const { writePid, checkPidStatus, removePid, readPid } = await import(
      '../../src/daemon/pid-manager.js'
    );

    const fakePid = 999999999;

    // Write a PID that maps to no running process
    await writePid(tmpDataDir, fakePid);

    // Verify the PID file was written
    const pidContent = await readFile(join(tmpDataDir, 'daemon.pid'), 'utf-8');
    expect(parseInt(pidContent.trim(), 10)).toBe(fakePid);

    // checkPidStatus should detect it as stale
    const status = await checkPidStatus(tmpDataDir);
    expect(status).toMatchObject({ status: 'stale', pid: fakePid });

    // Remove the stale PID file
    await removePid(tmpDataDir);

    // Verify the PID file is gone
    const readResult = await readPid(tmpDataDir);
    expect(readResult).toBeNull();
  });

  it('detects PID 1 (init/systemd) as stale because it is not a sparecrow daemon', async () => {
    const { writePid, checkPidStatus } = await import('../../src/daemon/pid-manager.js');

    // PID 1 exists on Linux but is not a sparecrow daemon
    await writePid(tmpDataDir, 1);

    const status = await checkPidStatus(tmpDataDir);
    // PID 1 exists (init) but isScrowDaemonProcess(1) returns false → stale
    expect(status).toMatchObject({ status: 'stale', pid: 1 });
  });

  it('allows clean writePid after stale cleanup', async () => {
    const { writePid, checkPidStatus, removePid, readPid } = await import(
      '../../src/daemon/pid-manager.js'
    );

    const fakePid = 999999999;

    // Write stale PID, detect, remove
    await writePid(tmpDataDir, fakePid);
    const status = await checkPidStatus(tmpDataDir);
    expect(status.status).toBe('stale');
    await removePid(tmpDataDir);

    // Write a clean PID (current process)
    await writePid(tmpDataDir, process.pid);

    // Verify the new PID is readable
    const currentPid = await readPid(tmpDataDir);
    expect(currentPid).toBe(process.pid);
  });

  it('removePid silently succeeds when no PID file exists (ENOENT swallowed)', async () => {
    const { removePid, readPid } = await import('../../src/daemon/pid-manager.js');

    // No PID file exists — removePid should not throw
    await expect(removePid(tmpDataDir)).resolves.toBeUndefined();

    // Confirm still no PID file
    const result = await readPid(tmpDataDir);
    expect(result).toBeNull();
  });

  it('checkPidStatus returns none when no PID file exists', async () => {
    const { checkPidStatus } = await import('../../src/daemon/pid-manager.js');

    const status = await checkPidStatus(tmpDataDir);
    expect(status).toMatchObject({ status: 'none', pid: null });
  });
});
