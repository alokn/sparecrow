/** Unit tests for QueuePayloadSchema and PersistedTaskSchema Zod schemas. */
import { describe, expect, it } from 'vitest';
import { QueuePayloadSchema, PersistedTaskSchema } from './queue-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplateTask(overrides?: Record<string, unknown>) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Run linter',
    status: 'pending',
    targetPath: '/repos/myproject',
    priority: 0,
    createdAt: '2026-01-15T10:00:00.000Z',
    timeoutMs: 60000,
    type: 'template',
    templateName: 'lint-check',
    prompt: '',
    ...overrides,
  };
}

function makeCustomTask(overrides?: Record<string, unknown>) {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Custom review',
    status: 'pending',
    targetPath: '/repos/myproject',
    priority: 1,
    createdAt: '2026-01-15T10:00:00.000Z',
    timeoutMs: 120000,
    type: 'custom',
    prompt: 'Run the full test suite and report failures.',
    ...overrides,
  };
}

function makeQueuePayload(overrides?: Record<string, unknown>) {
  return {
    version: 1,
    tasks: [],
    paused: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PersistedTaskSchema — template discriminant
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — template task', () => {
  it('parses a valid template task', () => {
    const result = PersistedTaskSchema.safeParse(makeTemplateTask());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('template');
      if (result.data.type === 'template') {
        expect(result.data.templateName).toBe('lint-check');
      }
    }
  });

  it('fails when templateName is missing', () => {
    const { templateName: _, ...task } = makeTemplateTask() as Record<string, unknown>;
    const result = PersistedTaskSchema.safeParse(task);
    expect(result.success).toBe(false);
  });

  it('fails when templateName is empty string', () => {
    const result = PersistedTaskSchema.safeParse(makeTemplateTask({ templateName: '' }));
    expect(result.success).toBe(false);
  });

  it('allows prompt to be empty string for template tasks', () => {
    const result = PersistedTaskSchema.safeParse(makeTemplateTask({ prompt: '' }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PersistedTaskSchema — custom discriminant
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — custom task', () => {
  it('parses a valid custom task', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('custom');
    }
  });

  it('fails when type is unknown discriminant', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ type: 'magical' }));
    expect(result.success).toBe(false);
  });

  it('fails when id is empty string', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ id: '' }));
    expect(result.success).toBe(false);
  });

  it('fails when name is empty string', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: '' }));
    expect(result.success).toBe(false);
  });

  it('fails when targetPath is empty string', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ targetPath: '' }));
    expect(result.success).toBe(false);
  });

  it('fails when priority is negative', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ priority: -1 }));
    expect(result.success).toBe(false);
  });

  it('fails when priority is a float', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ priority: 1.5 }));
    expect(result.success).toBe(false);
  });

  it('fails when timeoutMs is negative', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ timeoutMs: -1 }));
    expect(result.success).toBe(false);
  });

  it('accepts zero for timeoutMs', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ timeoutMs: 0 }));
    expect(result.success).toBe(true);
  });

  it('accepts zero for priority', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ priority: 0 }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PersistedTaskBase — createdAt validation
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — createdAt validation', () => {
  it('accepts a valid ISO 8601 timestamp', () => {
    const result = PersistedTaskSchema.safeParse(
      makeCustomTask({ createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(result.success).toBe(true);
  });

  it('fails for a non-date string', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ createdAt: 'not-a-date' }));
    expect(result.success).toBe(false);
  });

  it('fails for an empty createdAt string', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ createdAt: '' }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PersistedTaskBase — status defaults
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — status field backward compatibility', () => {
  it('defaults status to "pending" when missing (backward compat)', () => {
    const task = makeCustomTask();
    const { status: _, ...taskWithoutStatus } = task as Record<string, unknown>;
    const result = PersistedTaskSchema.safeParse(taskWithoutStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('pending');
    }
  });

  it('accepts all valid status values', () => {
    for (const status of ['pending', 'in-progress', 'done', 'failed', 'failed_quota', 'skipped']) {
      const result = PersistedTaskSchema.safeParse(makeCustomTask({ status }));
      expect(result.success).toBe(true);
    }
  });

  it('fails for an invalid status value', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ status: 'cancelled' }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QueuePayloadSchema
// ---------------------------------------------------------------------------

describe('QueuePayloadSchema', () => {
  it('parses a valid empty queue', () => {
    const result = QueuePayloadSchema.safeParse(makeQueuePayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.tasks).toHaveLength(0);
      expect(result.data.paused).toBe(false);
    }
  });

  it('parses a queue with mixed task types', () => {
    const result = QueuePayloadSchema.safeParse(
      makeQueuePayload({ tasks: [makeTemplateTask(), makeCustomTask()] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks).toHaveLength(2);
      expect(result.data.tasks[0]!.type).toBe('template');
      expect(result.data.tasks[1]!.type).toBe('custom');
    }
  });

  it('fails when version is not 1', () => {
    const result = QueuePayloadSchema.safeParse(makeQueuePayload({ version: 2 }));
    expect(result.success).toBe(false);
  });

  it('fails when version is missing', () => {
    const { version: _, ...payload } = makeQueuePayload() as Record<string, unknown>;
    const result = QueuePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('defaults paused to false when missing', () => {
    const { paused: _, ...payload } = makeQueuePayload() as Record<string, unknown>;
    const result = QueuePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paused).toBe(false);
    }
  });

  it('accepts paused=true', () => {
    const result = QueuePayloadSchema.safeParse(makeQueuePayload({ paused: true }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paused).toBe(true);
    }
  });

  it('fails when tasks is not an array', () => {
    const result = QueuePayloadSchema.safeParse(makeQueuePayload({ tasks: 'not-an-array' }));
    expect(result.success).toBe(false);
  });

  it('fails when a task in the array has an invalid type discriminant', () => {
    const result = QueuePayloadSchema.safeParse(
      makeQueuePayload({ tasks: [makeCustomTask({ type: 'bad-type' })] }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story 27.1 — Slug validation on task name
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — task name slug validation (Story 27.1)', () => {
  it('rejects task name containing forward slash', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: 'path/traversal' }));
    expect(result.success).toBe(false);
  });

  it('rejects task name containing backslash', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: 'path\\traversal' }));
    expect(result.success).toBe(false);
  });

  it('rejects task name containing double dots', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: '..secret' }));
    expect(result.success).toBe(false);
  });

  it('rejects task name with control characters', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: 'my\x00task' }));
    expect(result.success).toBe(false);
  });

  it('rejects task name starting with a dot', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: '.hidden' }));
    expect(result.success).toBe(false);
  });

  it('accepts valid task name with hyphens and underscores', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ name: 'my-task_v2' }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Story 18.1 AC5 — Task ID constrained to UUID format
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — task ID UUID validation (Story 18.1 AC5)', () => {
  it('accepts a valid UUID v4 task ID', () => {
    const result = PersistedTaskSchema.safeParse(
      makeCustomTask({ id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a path-traversal ID (../../etc/evil)', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ id: '../../etc/evil' }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID string ID', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ id: 'task-001' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty string ID', () => {
    const result = PersistedTaskSchema.safeParse(makeCustomTask({ id: '' }));
    expect(result.success).toBe(false);
  });
});
