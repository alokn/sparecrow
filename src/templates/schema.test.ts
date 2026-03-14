/** Unit tests for TemplateSchema validation. */
import { describe, it, expect } from 'vitest';
import { TemplateSchema } from './schema.js';

describe('TemplateSchema', () => {
  it('accepts a valid template object', () => {
    const result = TemplateSchema.safeParse({
      name: 'my-template',
      description: 'A description',
      prompt: 'Do something useful.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my-template');
      expect(result.data.description).toBe('A description');
      expect(result.data.prompt).toBe('Do something useful.');
    }
  });

  it('rejects missing name field', () => {
    const result = TemplateSchema.safeParse({
      description: 'A description',
      prompt: 'Do something.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing description field', () => {
    const result = TemplateSchema.safeParse({
      name: 'my-template',
      prompt: 'Do something.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing prompt field', () => {
    const result = TemplateSchema.safeParse({
      name: 'my-template',
      description: 'A description',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string for name', () => {
    const result = TemplateSchema.safeParse({
      name: '',
      description: 'A description',
      prompt: 'Do something.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string for description', () => {
    const result = TemplateSchema.safeParse({
      name: 'my-template',
      description: '',
      prompt: 'Do something.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string for prompt', () => {
    const result = TemplateSchema.safeParse({
      name: 'my-template',
      description: 'A description',
      prompt: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object input', () => {
    const result = TemplateSchema.safeParse('not an object');
    expect(result.success).toBe(false);
  });

  it('rejects null input', () => {
    const result = TemplateSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects array input', () => {
    const result = TemplateSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  // ── timeout_minutes (Story 7.19 — AC3) ──────────────────────────────────

  it('accepts template without timeout_minutes (optional field)', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_minutes).toBeUndefined();
    }
  });

  it('accepts template with timeout_minutes: 60', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      timeout_minutes: 60,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_minutes).toBe(60);
    }
  });

  it('accepts template with timeout_minutes: 0 (no timeout)', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      timeout_minutes: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_minutes).toBe(0);
    }
  });

  it('rejects template with negative timeout_minutes', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      timeout_minutes: -5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects template with fractional timeout_minutes', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      timeout_minutes: 30.5,
    });
    expect(result.success).toBe(false);
  });
});

// ── actions field (Story 17.3 — AC1, AC3, AC4) ──────────────────────────────

describe('TemplateSchema actions field', () => {
  it('accepts template without actions field (field is optional, defaults absent)', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions).toBeUndefined();
    }
  });

  it('accepts template with empty actions array', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions).toEqual([]);
    }
  });

  it('accepts template with valid action types: git-push and pr-create', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: ['git-push', 'pr-create'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions).toEqual(['git-push', 'pr-create']);
    }
  });

  it('accepts template with all four valid action types', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: ['git-push', 'pr-create', 'issue-create', 'notify'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions).toEqual(['git-push', 'pr-create', 'issue-create', 'notify']);
    }
  });

  it('rejects template with unknown action type: deploy', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: ['git-push', 'deploy'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects template with unknown action type: send-email', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: ['send-email'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects template with actions containing empty string', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects template with actions set to a string instead of array', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: 'git-push',
    });
    expect(result.success).toBe(false);
  });

  it('rejects template with duplicate action entries', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: ['git-push', 'git-push'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts template with distinct action entries (no duplicates)', () => {
    const result = TemplateSchema.safeParse({
      name: 'test',
      description: 'desc',
      prompt: 'do stuff',
      actions: ['git-push', 'pr-create'],
    });
    expect(result.success).toBe(true);
  });
});
