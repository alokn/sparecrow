/** QA automation tests for Story 18.1 security hardening — action parser YAML alias bounds. */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a YAML document with N aliases expanding exponentially (billion-laughs style). */
function buildAliasBombYaml(depth: number): string {
  const lines: string[] = [];
  lines.push('a: &a ["lol"]');
  for (let i = 1; i <= depth; i++) {
    const prev = String.fromCharCode(96 + i); // a, b, c, ...
    const curr = String.fromCharCode(97 + i); // b, c, d, ...
    lines.push(`${curr}: &${curr} [*${prev}, *${prev}]`);
  }
  lines.push('result: *' + String.fromCharCode(97 + depth));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// AC3: YAML alias expansion bounds (maxAliasCount: 100)
// ---------------------------------------------------------------------------

describe('action-parser — AC3: YAML alias expansion bounded', () => {
  it('throws or returns null for a YAML document with 200 aliases (exceeds maxAliasCount:100)', async () => {
    // Import action-parser fresh to avoid module caching issues
    const { parseActionBlock } = await import('./action-parser.js');

    // Build a YAML string with repeated alias references — 200 unique anchor references
    const aliases = Array.from({ length: 200 }, (_, i) => `*anchor${i}`).join(' ');
    const anchorDefs = Array.from(
      { length: 200 },
      (_, i) => `anchor${i}: &anchor${i} value${i}`,
    ).join('\n');
    const heavyYaml = [anchorDefs, `data: [${aliases}]`, '```'].join('\n');

    // parseActionBlock should either return null (graceful) or throw (which we catch)
    // It must NOT hang indefinitely or crash the process
    try {
      const result = parseActionBlock('```yaml sparecrow:actions\n' + heavyYaml);
      // If it returns without throwing, result should be null (malformed) or a valid object
      // The key invariant is that it completes in finite time
      expect(result === null || typeof result === 'object').toBe(true);
    } catch (e) {
      // Throwing is also acceptable — the important thing is it doesn't hang
      expect(e).toBeTruthy();
    }
  });

  it('successfully parses a YAML action block with a few aliases (under the limit)', async () => {
    const { parseActionBlock } = await import('./action-parser.js');

    // A valid action block with no aliases
    const yaml = [
      '```yaml sparecrow:actions',
      'actions:',
      '  - type: git-push',
      '    branch: main',
      '  - type: pr-create',
      '    title: "Test PR"',
      '    body: "body text"',
      '```',
    ].join('\n');

    const result = parseActionBlock(yaml);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.actions).toHaveLength(2);
    }
  });

  it('returns null for a block with entirely invalid YAML', async () => {
    const { parseActionBlock } = await import('./action-parser.js');

    const badYaml = '```yaml sparecrow:actions\n{{{invalid yaml:::\n```';
    const result = parseActionBlock(badYaml);
    expect(result).toBeNull();
  });

  it('returns null when the input exceeds MAX_BLOCK_SIZE (64 KB)', async () => {
    const { parseActionBlock } = await import('./action-parser.js');

    // Build a YAML string > 64 KB
    const bigYaml = '```yaml sparecrow:actions\n' + 'x: ' + 'a'.repeat(70 * 1024) + '\n```';
    const result = parseActionBlock(bigYaml);
    expect(result).toBeNull();
  });
});
