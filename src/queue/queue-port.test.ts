/** Contract tests for the QueuePort seam interface and InMemoryQueueAdapter. */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryQueueAdapter } from './queue-port.js';
import type { QueuePort } from './queue-port.js';
import type { TaskDefinition } from '../types/index.js';

function makeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'test-task',
    type: 'custom',
    status: 'pending',
    prompt: 'Do something useful',
    targetPath: '/repo',
    priority: 1,
    createdAt: new Date(),
    timeoutMs: 60_000,
    actions: [],
    ...overrides,
  };
}

describe('InMemoryQueueAdapter — QueuePort contract', () => {
  let adapter: QueuePort;

  beforeEach(() => {
    adapter = new InMemoryQueueAdapter();
  });

  it('enqueue returns position 1 for the first task', async () => {
    const result = await adapter.enqueue(makeTask());
    expect(result.position).toBe(1);
  });

  it('enqueue returns sequential positions for multiple tasks', async () => {
    const first = await adapter.enqueue(makeTask({ id: '00000000-0000-4000-8000-00000000000a' }));
    const second = await adapter.enqueue(makeTask({ id: '00000000-0000-4000-8000-00000000000b' }));
    const third = await adapter.enqueue(makeTask({ id: '00000000-0000-4000-8000-00000000000c' }));
    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(third.position).toBe(3);
  });

  it('nextIndex returns 1 when queue is empty', async () => {
    const idx = await adapter.nextIndex();
    expect(idx).toBe(1);
  });

  it('nextIndex returns N+1 after N tasks enqueued', async () => {
    await adapter.enqueue(makeTask({ id: '00000000-0000-4000-8000-00000000000a' }));
    await adapter.enqueue(makeTask({ id: '00000000-0000-4000-8000-00000000000b' }));
    const idx = await adapter.nextIndex();
    expect(idx).toBe(3);
  });

  it('accepts TaskDefinition with type: "custom"', async () => {
    const task = makeTask({ type: 'custom' });
    const result = await adapter.enqueue(task);
    expect(result.position).toBeGreaterThan(0);
  });

  it('accepts TaskDefinition with type: "template"', async () => {
    const task = makeTask({ type: 'template', templateName: 'improve-code', prompt: '' });
    const result = await adapter.enqueue(task);
    expect(result.position).toBeGreaterThan(0);
  });
});
