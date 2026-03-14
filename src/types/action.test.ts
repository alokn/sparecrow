/** Tests for action Zod schemas — git ref validation (Story 18.1 AC4). */
import { describe, it, expect } from 'vitest';
import { GitPushActionSchema } from './action.js';

describe('GitPushActionSchema — git ref validation (Story 18.1 AC4)', () => {
  it('accepts valid branch names', () => {
    const valid = [
      'main',
      'feature/my-branch',
      'sparecrow/fix-bugs-abc123',
      'release-1.0.0',
      'my_branch',
    ];
    for (const branch of valid) {
      const result = GitPushActionSchema.safeParse({ type: 'git-push', branch });
      expect(result.success, `expected "${branch}" to be valid`).toBe(true);
    }
  });

  it('rejects branch values that look like git options (--delete)', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: '--delete' });
    expect(result.success).toBe(false);
  });

  it('rejects branch values that look like git options (--mirror)', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: '--mirror' });
    expect(result.success).toBe(false);
  });

  it('rejects branch with shell metacharacters', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: 'main; rm -rf /' });
    expect(result.success).toBe(false);
  });

  it('rejects branch longer than 255 characters', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'a'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('rejects remote values that look like git options', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: '--delete',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid remote names', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: 'upstream',
    });
    expect(result.success).toBe(true);
  });

  // Finding 1 (High): slash must not be the first character of a branch name
  it('rejects branch names that start with a slash', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: '/refs/heads/main',
    });
    expect(result.success).toBe(false);
  });

  it('rejects remote names that start with a slash', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: '/origin',
    });
    expect(result.success).toBe(false);
  });

  // Finding 5 (Medium): additional git-check-ref-format rules
  it('rejects branch names ending with a dot', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: 'feature.' });
    expect(result.success).toBe(false);
  });

  it('rejects branch names containing consecutive dots (..)', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'feature..branch',
    });
    expect(result.success).toBe(false);
  });

  it('rejects branch names with a .lock suffix', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: 'main.lock' });
    expect(result.success).toBe(false);
  });

  it('rejects branch names with a .lock component in a path', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'refs/heads/main.lock',
    });
    expect(result.success).toBe(false);
  });

  it('accepts branch names with slash in non-leading position', () => {
    // Slash is valid in middle of branch name (e.g., feature/my-branch)
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'feature/my-branch',
    });
    expect(result.success).toBe(true);
  });
});
