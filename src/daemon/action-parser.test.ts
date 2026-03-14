/** Tests for action-parser — sparecrow:actions YAML block extraction from task output. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Helpers to build fenced action blocks in content strings
function wrapInActionBlock(yaml: string): string {
  return `Some output text before.\n\`\`\`yaml sparecrow:actions\n${yaml}\`\`\`\nSome output text after.`;
}

describe('parseActionBlock', () => {
  let parseActionBlock: (content: string) => import('../types/index.js').ActionBlock | null;
  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    const mod = await import('./action-parser.js');
    parseActionBlock = mod.parseActionBlock;
  });

  describe('AC3 — extracts valid action blocks', () => {
    it('parses a single git-push action', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: git-push\n    branch: feature/my-branch\n',
      );
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [{ type: 'git-push', branch: 'feature/my-branch' }],
      });
    });

    it('parses a git-push action with optional remote and force fields', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: git-push\n    branch: main\n    remote: upstream\n    force: true\n',
      );
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [{ type: 'git-push', branch: 'main', remote: 'upstream', force: true }],
      });
    });

    it('parses a pr-create action with all fields including base_branch', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: pr-create\n    title: "Fix: resolve bugs"\n    body: "Detailed description"\n    base_branch: main\n    labels:\n      - bug\n      - enhancement\n    draft: true\n',
      );
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [
          {
            type: 'pr-create',
            title: 'Fix: resolve bugs',
            body: 'Detailed description',
            base_branch: 'main',
            labels: ['bug', 'enhancement'],
            draft: true,
          },
        ],
      });
    });

    it('parses a pr-create action with only required fields', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: pr-create\n    title: "My PR"\n    body: "PR body"\n',
      );
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [{ type: 'pr-create', title: 'My PR', body: 'PR body' }],
      });
    });

    it('parses an issue-create action', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: issue-create\n    title: "Found a bug"\n    body: "Details here"\n    labels:\n      - bug\n',
      );
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [
          { type: 'issue-create', title: 'Found a bug', body: 'Details here', labels: ['bug'] },
        ],
      });
    });

    it('parses a notify action with optional channel', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: notify\n    message: "Task complete"\n    channel: "#general"\n',
      );
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [{ type: 'notify', message: 'Task complete', channel: '#general' }],
      });
    });

    it('parses a notify action without optional channel', () => {
      const content = wrapInActionBlock('actions:\n  - type: notify\n    message: "Done!"\n');
      const result = parseActionBlock(content);
      expect(result).toEqual({
        actions: [{ type: 'notify', message: 'Done!' }],
      });
    });

    it('parses multiple actions in sequence', () => {
      const content = wrapInActionBlock(
        'actions:\n  - type: git-push\n    branch: main\n  - type: pr-create\n    title: "PR"\n    body: "body"\n  - type: notify\n    message: "Done"\n',
      );
      const result = parseActionBlock(content);
      expect(result?.actions).toHaveLength(3);
      expect(result?.actions[0]).toEqual({ type: 'git-push', branch: 'main' });
      expect(result?.actions[1]).toEqual({ type: 'pr-create', title: 'PR', body: 'body' });
      expect(result?.actions[2]).toEqual({ type: 'notify', message: 'Done' });
    });

    it('parses an empty actions array (AC2 — explicit no-op)', () => {
      const content = wrapInActionBlock('actions: []\n');
      const result = parseActionBlock(content);
      expect(result).toEqual({ actions: [] });
    });

    it('ignores other YAML blocks without the marker', () => {
      const content = [
        '```yaml',
        'some: config',
        'key: value',
        '```',
        '',
        '```yaml sparecrow:actions',
        'actions:',
        '  - type: git-push',
        '    branch: main',
        '```',
      ].join('\n');
      const result = parseActionBlock(content);
      expect(result).toEqual({ actions: [{ type: 'git-push', branch: 'main' }] });
    });

    it('uses only the first sparecrow:actions block when multiple are present', () => {
      const content = [
        '```yaml sparecrow:actions',
        'actions:',
        '  - type: git-push',
        '    branch: first',
        '```',
        '',
        '```yaml sparecrow:actions',
        'actions:',
        '  - type: git-push',
        '    branch: second',
        '```',
      ].join('\n');
      const result = parseActionBlock(content);
      // Should parse the first one
      expect(result?.actions[0]).toMatchObject({ branch: 'first' });
    });
  });

  describe('AC4 — malformed block handling', () => {
    it('returns null and logs warning when YAML is syntactically invalid', () => {
      const content = [
        '```yaml sparecrow:actions',
        'actions:',
        '  - type: git-push',
        '    branch: [unclosed bracket',
        '```',
      ].join('\n');
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        'action-parser.yaml-parse-error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });

    it('returns null and logs warning when schema validation fails (unknown action type)', () => {
      const content = wrapInActionBlock('actions:\n  - type: deploy\n    target: production\n');
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        'action-parser.schema-validation-error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });

    it('returns null and logs warning when required field is missing', () => {
      // git-push requires branch
      const content = wrapInActionBlock('actions:\n  - type: git-push\n');
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        'action-parser.schema-validation-error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });

    it('does not throw on malformed block', () => {
      const content = wrapInActionBlock('}: invalid yaml {{\n');
      expect(() => parseActionBlock(content)).not.toThrow();
    });

    it('returns null and logs warning for fence with no closing backticks', () => {
      const content = '```yaml sparecrow:actions\nactions:\n  - type: notify\n    message: "hi"\n';
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith('action-parser.malformed-fence', expect.any(Object));
    });

    it('returns null and logs warning for empty-body action block (yaml.parse returns null)', () => {
      // An empty fenced block: ```yaml sparecrow:actions\n```
      const content = '```yaml sparecrow:actions\n```';
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        'action-parser.schema-validation-error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });

    it('returns null and logs warning when block exceeds size limit', () => {
      // Build a block whose YAML content exceeds 64 KiB
      const bigValue = 'x'.repeat(70_000);
      const content = wrapInActionBlock(`actions:\n  - type: notify\n    message: "${bigValue}"\n`);
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        'action-parser.block-too-large',
        expect.objectContaining({ size: expect.any(Number), limit: expect.any(Number) }),
      );
    });
  });

  describe('AC5 — absent block handling', () => {
    it('returns null when no sparecrow:actions marker is present', () => {
      const content = 'Some task output without any action block.\nAll done!';
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns null for empty string', () => {
      const result = parseActionBlock('');
      expect(result).toBeNull();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns null when content has other YAML blocks but no action marker', () => {
      const content = [
        '```yaml',
        'some: yaml',
        '```',
        '',
        '```json',
        '{"key": "value"}',
        '```',
      ].join('\n');
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns null silently when marker appears only in prose (not in a fence opener)', () => {
      // The marker text appears in plain prose, not inside a fenced block opener
      const content =
        'This template supports sparecrow:actions blocks for post-execution automation.\nSee docs for details.';
      const result = parseActionBlock(content);
      expect(result).toBeNull();
      // Should NOT warn — prose mention is not a malformed fence
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('Story 18.1 AC3 — YAML alias expansion bounds', () => {
    it('rejects YAML with excessive alias expansion (>100 aliases)', () => {
      // Build a YAML string that uses more than 100 alias references
      // to trigger the maxAliasCount guard
      const anchor = '&a\n  type: git-push\n  branch: main\n';
      const aliases = Array.from({ length: 101 }, () => '  - *a').join('\n');
      const yaml = `actions:\n  - ${anchor}${aliases}\n`;
      const content = wrapInActionBlock(yaml);
      const result = parseActionBlock(content);
      // Should return null (YAML parse error due to alias limit)
      expect(result).toBeNull();
      expect(mockWarn).toHaveBeenCalledWith(
        'action-parser.yaml-parse-error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });

    it('accepts YAML with moderate alias usage (<=100 aliases)', () => {
      // Use a simple anchored scalar that gets referenced a few times
      const yaml = [
        'actions:',
        '  - type: git-push',
        '    branch: &b main',
        '  - type: git-push',
        '    branch: *b',
        '  - type: git-push',
        '    branch: *b',
        '',
      ].join('\n');
      const content = wrapInActionBlock(yaml);
      const result = parseActionBlock(content);
      expect(result).not.toBeNull();
      expect(result!.actions.length).toBe(3);
    });
  });
});
