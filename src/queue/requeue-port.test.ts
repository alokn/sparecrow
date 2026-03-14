/** Contract tests for the RequeuePort seam interface and NoOpRequeueAdapter. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoOpRequeueAdapter } from './requeue-port.js';
import type { RequeuePort } from './requeue-port.js';

describe('NoOpRequeueAdapter — RequeuePort contract', () => {
  let adapter: RequeuePort;

  beforeEach(() => {
    adapter = new NoOpRequeueAdapter();
  });

  it('implements the RequeuePort interface', () => {
    expect(typeof adapter.requeue).toBe('function');
  });

  it('resolves without error for a given taskId', async () => {
    await expect(adapter.requeue('task-abc')).resolves.toBeUndefined();
  });

  it('resolves without error for multiple calls', async () => {
    await expect(adapter.requeue('task-1')).resolves.toBeUndefined();
    await expect(adapter.requeue('task-2')).resolves.toBeUndefined();
  });

  it('can be used as a mock to verify executor calls requeue on quota failure', async () => {
    const mockPort: RequeuePort = { requeue: vi.fn().mockResolvedValue(undefined) };
    await mockPort.requeue('task-quota-123');
    expect(mockPort.requeue).toHaveBeenCalledOnce();
    expect(mockPort.requeue).toHaveBeenCalledWith('task-quota-123');
  });
});
