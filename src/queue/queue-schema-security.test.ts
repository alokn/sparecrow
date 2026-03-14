/** QA automation tests for Story 18.1 security hardening — queue schema security invariants. */
import { describe, it, expect } from 'vitest';
import { PersistedTaskSchema, QueuePayloadSchema } from './queue-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Record<string, unknown>) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'test-task',
    status: 'pending',
    targetPath: '/repos/test',
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: 60000,
    type: 'custom' as const,
    prompt: 'do something',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC5: UUID validation on PersistedTaskBase.id
// ---------------------------------------------------------------------------

describe('PersistedTaskSchema — AC5: UUID validation on id field', () => {
  it('accepts a valid v4 UUID as task id', () => {
    const result = PersistedTaskSchema.safeParse(
      makeTask({ id: 'cbb41575-a4ee-4a90-af40-ae1a1cbcb032' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a nil-UUID (00000000-…) as a valid UUID format', () => {
    const result = PersistedTaskSchema.safeParse(
      makeTask({ id: '00000000-0000-0000-0000-000000000000' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a path-traversal id "../../etc/evil"', () => {
    const result = PersistedTaskSchema.safeParse(makeTask({ id: '../../etc/evil' }));
    expect(result.success).toBe(false);
  });

  it('rejects an id with shell metacharacters "$(rm -rf /)"', () => {
    const result = PersistedTaskSchema.safeParse(makeTask({ id: '$(rm -rf /)' }));
    expect(result.success).toBe(false);
  });

  it('rejects a plain string id that is not UUID format', () => {
    const result = PersistedTaskSchema.safeParse(makeTask({ id: 'task-1' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty string id', () => {
    const result = PersistedTaskSchema.safeParse(makeTask({ id: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects an id that is too short to be a UUID', () => {
    const result = PersistedTaskSchema.safeParse(makeTask({ id: 'abc' }));
    expect(result.success).toBe(false);
  });

  it('rejects an id with a leading slash "/etc/passwd"', () => {
    const result = PersistedTaskSchema.safeParse(makeTask({ id: '/etc/passwd' }));
    expect(result.success).toBe(false);
  });

  it('rejects a numeric id that would pass a plain minLength check', () => {
    const result = PersistedTaskSchema.safeParse(
      makeTask({ id: '1234567890123456789012345678901234567890' }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5: QueuePayloadSchema rejects tasks with non-UUID ids
// ---------------------------------------------------------------------------

describe('QueuePayloadSchema — AC5: tasks with non-UUID ids are rejected', () => {
  it('rejects a queue payload containing a task with a path-traversal id', () => {
    const payload = {
      version: 1,
      paused: false,
      tasks: [makeTask({ id: '../../../etc/shadow' })],
    };
    const result = QueuePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects a queue payload containing a task with a non-UUID string id', () => {
    const payload = {
      version: 1,
      paused: false,
      tasks: [makeTask({ id: 'not-a-uuid' })],
    };
    const result = QueuePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts a queue payload with all tasks having valid UUID ids', () => {
    const payload = {
      version: 1,
      paused: false,
      tasks: [
        makeTask({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
        makeTask({ id: 'ffffffff-0000-4111-a222-333333333333', priority: 2 }),
      ],
    };
    const result = QueuePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
