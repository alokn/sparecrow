/** Unit tests for template loader, resolver, alias resolution, and getBuiltinDir path utility. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  CANONICAL_KEYS,
  TEMPLATE_ALIASES,
  ACTIVE_TEMPLATE_NAMES,
  extractBranchFromStdout,
  resolveTemplateOrCustom,
} from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_YAML = (name: string) =>
  `name: ${name}\ndescription: A description for ${name}\nprompt: Do something useful for ${name}.\n`;

const MALFORMED_YAML = `name: bad\ndescription: [unclosed bracket\nprompt: ok\n`;

const MISSING_FIELD_YAML = `name: incomplete\ndescription: Only two fields\n`;

// ---------------------------------------------------------------------------
// getBuiltinDir path resolution (AC13 unit seam)
// ---------------------------------------------------------------------------

describe('getBuiltinDir', () => {
  it('resolves builtin directory relative to a given module URL', async () => {
    const { getBuiltinDir } = await import('./index.js');
    const fakeModuleUrl = pathToFileURL('/some/path/to/templates/index.ts').href;
    const result = getBuiltinDir(fakeModuleUrl);
    expect(result).toMatch(/templates[/\\]builtin$/);
    expect(result).toContain('some');
  });

  it('resolves different paths for different module URLs', async () => {
    const { getBuiltinDir } = await import('./index.js');
    const devUrl = pathToFileURL('/project/src/templates/index.ts').href;
    const prodUrl = pathToFileURL('/project/dist/index.js').href;
    const devResult = getBuiltinDir(devUrl);
    const prodResult = getBuiltinDir(prodUrl);
    expect(devResult).toContain('src');
    expect(devResult).toContain('builtin');
    expect(prodResult).toContain('dist');
    expect(prodResult).toContain('builtin');
  });
});

// ---------------------------------------------------------------------------
// loadBuiltins — happy path using real YAML files
// ---------------------------------------------------------------------------

describe('loadBuiltins', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads all four built-in templates', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    expect(templates).toHaveLength(4);
  });

  it('returns templates in canonical order', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const names = templates.map((t) => t.name);
    expect(names).toEqual(['fix-bugs', 'improve-code', 'write-tests', 'security-audit']);
  });

  it('sets type to built-in for all loaded templates', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    expect(templates.every((t) => t.type === 'built-in')).toBe(true);
  });

  it('all templates have non-empty name, description, and prompt', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const t of templates) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(0);
    }
  });

  it('security-audit prompt covers vulnerabilities, dependency risk, and hardcoded secrets', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const sr = templates.find((t) => t.name === 'security-audit')!;
    const lower = sr.prompt.toLowerCase();
    expect(lower).toMatch(/vulnerabilit/);
    expect(lower).toMatch(/depend/);
    expect(lower).toMatch(/secret|credential|key|token/);
  });

  it('security-audit prompt explicitly states DO NOT make changes (AC4)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const sr = templates.find((t) => t.name === 'security-audit')!;
    // Prominent standalone warning block (finding 9 — not buried inline)
    expect(sr.prompt).toMatch(/DO NOT MAKE ANY CHANGES|DO NOT make any changes/);
    expect(sr.prompt).toMatch(/read-only/i);
  });

  it('security-audit prompt instructs prioritized findings with severity ratings (AC4)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const sr = templates.find((t) => t.name === 'security-audit')!;
    const lower = sr.prompt.toLowerCase();
    expect(lower).toMatch(/prioritized/);
    expect(lower).toMatch(/severity/);
    expect(lower).toMatch(/remediation/);
  });

  it('security-audit description notes report-only (AC5)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const sr = templates.find((t) => t.name === 'security-audit')!;
    expect(sr.description).toMatch(/report only/i);
    expect(sr.description).toMatch(/no code changes/i);
  });

  it('improve-code prompt covers bugs, error-handling, and code quality', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const cr = templates.find((t) => t.name === 'improve-code')!;
    const lower = cr.prompt.toLowerCase();
    expect(lower).toMatch(/bug/);
    expect(lower).toMatch(/error.{0,20}handl/);
    expect(lower).toMatch(/quality/);
  });

  it('improve-code prompt instructs branch creation and commit with refactor: prefix (AC2)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const cr = templates.find((t) => t.name === 'improve-code')!;
    expect(cr.prompt).toMatch(/sparecrow\/improve-code-/);
    expect(cr.prompt).toMatch(/refactor: \[sparecrow\]/);
    expect(cr.prompt).toMatch(/git checkout -b/);
    // Exact bash date format string must be present — prevents git-invalid formats like %Y-%m-%dT%H:%M:%SZ
    expect(cr.prompt).toContain('+%Y%m%dT%H%M%SZ');
  });

  it('improve-code description signals active intent (AC5)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const cr = templates.find((t) => t.name === 'improve-code')!;
    expect(cr.description.toLowerCase()).toMatch(/directly|new branch/);
  });

  it('fix-bugs prompt covers edge cases, logic errors, and defects', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const bh = templates.find((t) => t.name === 'fix-bugs')!;
    const lower = bh.prompt.toLowerCase();
    expect(lower).toMatch(/edge case/);
    expect(lower).toMatch(/logic/);
  });

  it('fix-bugs prompt instructs branch creation and commit with fix: prefix (AC1)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const bh = templates.find((t) => t.name === 'fix-bugs')!;
    expect(bh.prompt).toMatch(/sparecrow\/fix-bugs-/);
    expect(bh.prompt).toMatch(/fix: \[sparecrow\]/);
    expect(bh.prompt).toMatch(/git checkout -b/);
    // Exact bash date format string must be present — prevents git-invalid formats like %Y-%m-%dT%H:%M:%SZ
    expect(bh.prompt).toContain('+%Y%m%dT%H%M%SZ');
  });

  it('fix-bugs description signals active intent (AC5)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const bh = templates.find((t) => t.name === 'fix-bugs')!;
    expect(bh.description.toLowerCase()).toMatch(/directly|new branch/);
  });

  it('write-tests prompt covers untested paths and test case generation', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const tg = templates.find((t) => t.name === 'write-tests')!;
    const lower = tg.prompt.toLowerCase();
    expect(lower).toMatch(/test/);
    expect(lower).toMatch(/coverage|untested/);
  });

  it('write-tests prompt instructs branch creation, test running, and commit with test: prefix (AC3)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const tg = templates.find((t) => t.name === 'write-tests')!;
    expect(tg.prompt).toMatch(/sparecrow\/write-tests-/);
    expect(tg.prompt).toMatch(/test: \[sparecrow\]/);
    expect(tg.prompt).toMatch(/git checkout -b/);
    // AC3: must instruct to run tests before committing
    const lower = tg.prompt.toLowerCase();
    expect(lower).toMatch(/run.*test.*suite|run the.*test/);
    // Exact bash date format string must be present — prevents git-invalid formats like %Y-%m-%dT%H:%M:%SZ
    expect(tg.prompt).toContain('+%Y%m%dT%H%M%SZ');
  });

  it('write-tests description signals active intent (AC5)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const tg = templates.find((t) => t.name === 'write-tests')!;
    expect(tg.description.toLowerCase()).toMatch(/directly|new branch/);
  });

  it('fix-bugs prompt has a dedicated RUN THE TESTS step (finding 5 — test-run as top-level step)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const bh = templates.find((t) => t.name === 'fix-bugs')!;
    // Must have a numbered "RUN THE TESTS" step, not just a sub-bullet buried inside COMMIT
    expect(bh.prompt).toMatch(/\d\.\s+RUN THE TESTS/);
  });

  it('improve-code prompt has a dedicated RUN THE TESTS step (finding 5 — test-run as top-level step)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const cr = templates.find((t) => t.name === 'improve-code')!;
    // Must have a numbered "RUN THE TESTS" step, not just a sub-bullet buried inside COMMIT
    expect(cr.prompt).toMatch(/\d\.\s+RUN THE TESTS/);
  });

  it('active templates all instruct to never commit to default branch', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const activeNames = ['fix-bugs', 'improve-code', 'write-tests'];
    for (const name of activeNames) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt.toLowerCase()).toMatch(/never commit to the default branch/);
    }
  });

  it('active templates all instruct to write a summary', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const activeNames = ['fix-bugs', 'improve-code', 'write-tests'];
    for (const name of activeNames) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt.toLowerCase()).toMatch(/write a summary/);
    }
  });

  it('produces deterministic results across multiple calls', async () => {
    const { loadBuiltins } = await import('./index.js');
    const first = await loadBuiltins();
    const second = await loadBuiltins();
    expect(first.map((t) => t.name)).toEqual(second.map((t) => t.name));
  });

  // ── actions field (Story 17.3 — AC2, AC3, AC5) ──────────────────────────

  it('fix-bugs declares git-push and pr-create actions (AC2)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const t = templates.find((tmpl) => tmpl.name === 'fix-bugs')!;
    expect(t.actions).toContain('git-push');
    expect(t.actions).toContain('pr-create');
  });

  it('improve-code declares git-push and pr-create actions (AC2)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const t = templates.find((tmpl) => tmpl.name === 'improve-code')!;
    expect(t.actions).toContain('git-push');
    expect(t.actions).toContain('pr-create');
  });

  it('write-tests declares git-push and pr-create actions (AC2)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const t = templates.find((tmpl) => tmpl.name === 'write-tests')!;
    expect(t.actions).toContain('git-push');
    expect(t.actions).toContain('pr-create');
  });

  it('security-audit declares empty actions array (AC2)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const t = templates.find((tmpl) => tmpl.name === 'security-audit')!;
    expect(t.actions).toEqual([]);
  });

  it('all templates have an actions array of ActionType (AC5 — field always present, not undefined)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const VALID_ACTION_TYPES = ['git-push', 'pr-create', 'issue-create', 'notify'];
    for (const t of templates) {
      expect(Array.isArray(t.actions)).toBe(true);
      // actions must be defined (non-optional contract)
      expect(t.actions).toBeDefined();
      // every entry must be a valid ActionType string
      for (const action of t.actions) {
        expect(VALID_ACTION_TYPES).toContain(action);
      }
    }
  });

  it('template without actions field in YAML defaults actions to [] (AC3)', async () => {
    vi.resetModules();
    // All 4 files return YAML without an actions field. loadBuiltins should not crash
    // and each resulting Template should have actions: [].
    const yamlMap: Record<string, string> = {
      'fix-bugs.yaml': VALID_YAML('fix-bugs'),
      'improve-code.yaml': VALID_YAML('improve-code'),
      'write-tests.yaml': VALID_YAML('write-tests'),
      'security-audit.yaml': VALID_YAML('security-audit'),
    };
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        const basename = filePath.split('/').pop()!;
        const content = yamlMap[basename];
        if (content) return Promise.resolve(content);
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }),
    }));
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const t of templates) {
      expect(t.actions).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// built-in template prompts — action protocol (Story 17.6)
// ---------------------------------------------------------------------------

describe('built-in template prompts — action protocol', () => {
  const ACTIVE_TEMPLATE_KEYS = ['fix-bugs', 'improve-code', 'write-tests'] as const;
  const ACTION_MARKER = '```yaml sparecrow:actions';

  beforeEach(async () => {
    vi.resetModules();
    // Override any previously registered node:fs/promises mock with the real module
    // so these pure string-content tests read the actual YAML files from disk.
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => actualFs);
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('all three active templates contain the sparecrow:actions fenced opener marker (AC6)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt).toContain(ACTION_MARKER);
    }
  });

  it('none of the three active templates contain gh pr create (AC1/AC2/AC3)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt).not.toContain('gh pr create');
    }
  });

  it('none of the three active templates contain git push -u origin HEAD as a shell command (AC1/AC2/AC3)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt).not.toContain('git push -u origin HEAD');
    }
  });

  it('security-audit prompt does NOT contain the sparecrow:actions marker (AC4)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    const sa = templates.find((t) => t.name === 'security-audit')!;
    expect(sa.prompt).not.toContain(ACTION_MARKER);
  });

  it('each active template prompt contains exactly TWO occurrences of the sparecrow:actions marker — one opt-out example and one full-form example (AC8)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      const count = (t.prompt.match(/```yaml sparecrow:actions/g) ?? []).length;
      expect(count).toBe(2);
    }
  });

  it('each active template prompt contains the empty opt-out block string actions: [] (AC5)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt).toContain('actions: []');
    }
  });

  it('each active template prompt contains the multi-line body scalar indicator body: | (AC7)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt).toContain('body: |');
    }
  });

  it('each active template prompt uses a dynamic date expression not a hardcoded date in the PR title (AC6)', async () => {
    const { loadBuiltins } = await import('./index.js');
    const templates = await loadBuiltins();
    for (const name of ACTIVE_TEMPLATE_KEYS) {
      const t = templates.find((tmpl) => tmpl.name === name)!;
      expect(t.prompt).toContain('$(date -u +%Y-%m-%d)');
      // Guard against hardcoded date strings like YYYY-MM-DD (4 digits, dash, 2 digits, dash, 2 digits)
      const hardcodedDateMatches = t.prompt.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      expect(hardcodedDateMatches).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// loadBuiltins — failure modes (using mocked filesystem)
// ---------------------------------------------------------------------------

describe('loadBuiltins — failure modes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws TEMPLATE_LOAD_ERROR when a builtin file is missing', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    }));
    const { loadBuiltins } = await import('./index.js');
    await expect(loadBuiltins()).rejects.toMatchObject({ code: 'TEMPLATE_LOAD_ERROR' });
  });

  it('throws TEMPLATE_INVALID for malformed YAML content', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(MALFORMED_YAML),
    }));
    const { loadBuiltins } = await import('./index.js');
    await expect(loadBuiltins()).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('throws TEMPLATE_INVALID when required schema fields are missing', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(MISSING_FIELD_YAML),
    }));
    const { loadBuiltins } = await import('./index.js');
    await expect(loadBuiltins()).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });

  it('throws TEMPLATE_DUPLICATE_KEY when two templates share the same name', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(VALID_YAML('fix-bugs')), // always returns same name
    }));
    const { loadBuiltins } = await import('./index.js');
    await expect(loadBuiltins()).rejects.toMatchObject({ code: 'TEMPLATE_DUPLICATE_KEY' });
  });

  it('throws TEMPLATE_INVALID when filename and declared name differ', async () => {
    vi.resetModules();
    let callCount = 0;
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockImplementation(() => {
        callCount++;
        // First file (fix-bugs.yaml) returns correct name; second returns mismatched name
        return Promise.resolve(callCount === 1 ? VALID_YAML('fix-bugs') : VALID_YAML('wrong-name'));
      }),
    }));
    const { loadBuiltins } = await import('./index.js');
    await expect(loadBuiltins()).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

describe('resolveTemplate', () => {
  const templates = [
    {
      name: 'security-audit',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'improve-code',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
  ];

  it('returns the matching template by name', async () => {
    const { resolveTemplate } = await import('./index.js');
    const result = resolveTemplate('security-audit', templates);
    expect(result.name).toBe('security-audit');
  });

  it('throws with code TEMPLATE_NOT_FOUND for unknown key', async () => {
    const { resolveTemplate } = await import('./index.js');
    expect(() => resolveTemplate('unknown-template', templates)).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND' }),
    );
  });

  it('error message includes available template names', async () => {
    const { resolveTemplate } = await import('./index.js');

    let thrown: Error | null = null;
    try {
      resolveTemplate('unknown-template', templates);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('security-audit');
    expect(thrown!.message).toContain('improve-code');
  });

  it('throws with code TEMPLATE_NOT_FOUND when available list is empty', async () => {
    const { resolveTemplate } = await import('./index.js');
    expect(() => resolveTemplate('any', [])).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND' }),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAlias — backward-compatible alias resolution (Story 13.3 AC3)
// ---------------------------------------------------------------------------

describe('resolveAlias', () => {
  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock('../utils/index.js', () => ({
      logger: { warn: mockWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves old name bug-hunter to fix-bugs with structured deprecation warning', async () => {
    const { resolveAlias } = await import('./index.js');
    const result = resolveAlias('bug-hunter');
    expect(result.resolved).toBe('fix-bugs');
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'bug-hunter', canonical: 'fix-bugs' }),
    );
  });

  it('resolves old name code-review to improve-code with structured deprecation warning', async () => {
    const { resolveAlias } = await import('./index.js');
    const result = resolveAlias('code-review');
    expect(result.resolved).toBe('improve-code');
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'code-review', canonical: 'improve-code' }),
    );
  });

  it('resolves old name test-generation to write-tests with structured deprecation warning', async () => {
    const { resolveAlias } = await import('./index.js');
    const result = resolveAlias('test-generation');
    expect(result.resolved).toBe('write-tests');
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'test-generation', canonical: 'write-tests' }),
    );
  });

  it('resolves old name security-review to security-audit with structured deprecation warning', async () => {
    const { resolveAlias } = await import('./index.js');
    const result = resolveAlias('security-review');
    expect(result.resolved).toBe('security-audit');
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'security-review', canonical: 'security-audit' }),
    );
  });

  it('passes through canonical name without warning', async () => {
    const { resolveAlias } = await import('./index.js');
    const result = resolveAlias('fix-bugs');
    expect(result.resolved).toBe('fix-bugs');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('passes through unknown name without warning', async () => {
    const { resolveAlias } = await import('./index.js');
    const result = resolveAlias('unknown-template');
    expect(result.resolved).toBe('unknown-template');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveTemplate with aliases (Story 13.3 AC3)
// ---------------------------------------------------------------------------

describe('resolveTemplate — alias resolution', () => {
  const templates = [
    {
      name: 'fix-bugs',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'improve-code',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'write-tests',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'security-audit',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
  ];

  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock('../utils/index.js', () => ({
      logger: { warn: mockWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves old name bug-hunter to fix-bugs template with deprecation warning', async () => {
    const { resolveTemplate } = await import('./index.js');
    const result = resolveTemplate('bug-hunter', templates);
    expect(result.name).toBe('fix-bugs');
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'bug-hunter', canonical: 'fix-bugs' }),
    );
  });

  it('resolves old name code-review to improve-code template', async () => {
    const { resolveTemplate } = await import('./index.js');
    const result = resolveTemplate('code-review', templates);
    expect(result.name).toBe('improve-code');
  });

  it('resolves old name test-generation to write-tests template', async () => {
    const { resolveTemplate } = await import('./index.js');
    const result = resolveTemplate('test-generation', templates);
    expect(result.name).toBe('write-tests');
  });

  it('resolves old name security-review to security-audit template', async () => {
    const { resolveTemplate } = await import('./index.js');
    const result = resolveTemplate('security-review', templates);
    expect(result.name).toBe('security-audit');
  });

  it('error message reports the original user-typed key when alias resolves to absent template', async () => {
    const { resolveTemplate } = await import('./index.js');
    // bug-hunter resolves to fix-bugs, but fix-bugs is absent from available list
    const available = [
      {
        name: 'improve-code',
        description: 'desc',
        prompt: 'p',
        type: 'built-in' as const,
        actions: [] as const,
      },
    ];
    let thrown: Error | null = null;
    try {
      resolveTemplate('bug-hunter', available);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('bug-hunter');
    expect(thrown!.message).not.toContain("'fix-bugs'");
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateOrCustom with aliases (Story 13.3 AC4)
// ---------------------------------------------------------------------------

describe('resolveTemplateOrCustom — alias resolution', () => {
  const builtins = [
    {
      name: 'fix-bugs',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'improve-code',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'write-tests',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
    {
      name: 'security-audit',
      description: 'desc',
      prompt: 'prompt',
      type: 'built-in' as const,
      actions: [] as const,
    },
  ];

  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock('../utils/index.js', () => ({
      logger: { warn: mockWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves old name bug-hunter via alias in resolveTemplateOrCustom', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    const result = resolveTemplateOrCustom('bug-hunter', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.name).toBe('fix-bugs');
    }
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'bug-hunter', canonical: 'fix-bugs' }),
    );
  });

  it('resolves old name code-review via alias in resolveTemplateOrCustom', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    const result = resolveTemplateOrCustom('code-review', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.name).toBe('improve-code');
    }
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'code-review', canonical: 'improve-code' }),
    );
  });

  it('resolves old name test-generation via alias in resolveTemplateOrCustom', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    const result = resolveTemplateOrCustom('test-generation', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.name).toBe('write-tests');
    }
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'test-generation', canonical: 'write-tests' }),
    );
  });

  it('resolves old name security-review via alias in resolveTemplateOrCustom', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    const result = resolveTemplateOrCustom('security-review', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.name).toBe('security-audit');
    }
    expect(mockWarn).toHaveBeenCalledWith(
      'template.deprecated_alias',
      expect.objectContaining({ alias: 'security-review', canonical: 'security-audit' }),
    );
  });

  it('resolves canonical name without deprecation warning in resolveTemplateOrCustom', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    const result = resolveTemplateOrCustom('fix-bugs', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.name).toBe('fix-bugs');
    }
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('throws TEMPLATE_NOT_FOUND when alias resolves to a canonical name absent from builtins and customTasks', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    // bug-hunter resolves to fix-bugs, but the builtins list provided does not include fix-bugs
    const limitedBuiltins = [
      {
        name: 'improve-code',
        description: 'desc',
        prompt: 'p',
        type: 'built-in' as const,
        actions: [] as const,
      },
    ];
    expect(() => resolveTemplateOrCustom('bug-hunter', limitedBuiltins, [])).toThrowError(
      expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND' }),
    );
  });

  it('error message reports original user-typed alias name (not resolved canonical) when not found', async () => {
    const { resolveTemplateOrCustom } = await import('./index.js');
    const limitedBuiltins = [
      {
        name: 'improve-code',
        description: 'desc',
        prompt: 'p',
        type: 'built-in' as const,
        actions: [] as const,
      },
    ];
    let thrown: Error | null = null;
    try {
      resolveTemplateOrCustom('bug-hunter', limitedBuiltins, []);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('bug-hunter');
    expect(thrown!.message).not.toContain("'fix-bugs'");
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateOrCustom — actions propagation (AC5 — consumer entrypoint)
// ---------------------------------------------------------------------------

describe('resolveTemplateOrCustom — actions propagation', () => {
  it('returns built-in template with correct actions populated (AC5)', () => {
    const builtins = [
      {
        name: 'fix-bugs',
        description: 'desc',
        prompt: 'prompt',
        type: 'built-in' as const,
        actions: ['git-push', 'pr-create'] as const,
      },
      {
        name: 'security-audit',
        description: 'desc',
        prompt: 'prompt',
        type: 'built-in' as const,
        actions: [] as const,
      },
    ];

    const result = resolveTemplateOrCustom('fix-bugs', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.actions).toEqual(['git-push', 'pr-create']);
    }
  });

  it('returns built-in template with empty actions for security-audit (AC5)', () => {
    const builtins = [
      {
        name: 'security-audit',
        description: 'desc',
        prompt: 'prompt',
        type: 'built-in' as const,
        actions: [] as const,
      },
    ];

    const result = resolveTemplateOrCustom('security-audit', builtins, []);
    expect(result.type).toBe('built-in');
    if (result.type === 'built-in') {
      expect(result.template.actions).toEqual([]);
    }
  });

  it('returns custom result with empty actions array', () => {
    const result = resolveTemplateOrCustom('my-task', [], [{ name: 'my-task', prompt: 'do it' }]);
    expect(result.type).toBe('custom');
    if (result.type === 'custom') {
      expect(result.actions).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// CANONICAL_KEYS export
// ---------------------------------------------------------------------------

describe('CANONICAL_KEYS', () => {
  it('exports the four expected keys in stable order', () => {
    expect(CANONICAL_KEYS).toEqual(['fix-bugs', 'improve-code', 'write-tests', 'security-audit']);
  });
});

// ---------------------------------------------------------------------------
// TEMPLATE_ALIASES export
// ---------------------------------------------------------------------------

describe('TEMPLATE_ALIASES', () => {
  it('maps all four old names to new names', () => {
    expect(TEMPLATE_ALIASES.get('bug-hunter')).toBe('fix-bugs');
    expect(TEMPLATE_ALIASES.get('code-review')).toBe('improve-code');
    expect(TEMPLATE_ALIASES.get('test-generation')).toBe('write-tests');
    expect(TEMPLATE_ALIASES.get('security-review')).toBe('security-audit');
  });

  it('has exactly four entries', () => {
    expect(TEMPLATE_ALIASES.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ACTIVE_TEMPLATE_NAMES export (Story 13.4 AC6)
// ---------------------------------------------------------------------------

describe('ACTIVE_TEMPLATE_NAMES', () => {
  it('contains the three active template names', () => {
    expect(ACTIVE_TEMPLATE_NAMES.has('fix-bugs')).toBe(true);
    expect(ACTIVE_TEMPLATE_NAMES.has('improve-code')).toBe(true);
    expect(ACTIVE_TEMPLATE_NAMES.has('write-tests')).toBe(true);
  });

  it('does not contain the passive security-audit template', () => {
    expect(ACTIVE_TEMPLATE_NAMES.has('security-audit')).toBe(false);
  });

  it('has exactly three entries', () => {
    expect(ACTIVE_TEMPLATE_NAMES.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// extractBranchFromStdout (Story 13.4 AC6)
// ---------------------------------------------------------------------------

describe('extractBranchFromStdout', () => {
  it('extracts fix-bugs branch name from stdout containing branch creation line', () => {
    const stdout = "Switched to a new branch 'sparecrow/fix-bugs-20260304T143000Z'";
    expect(extractBranchFromStdout(stdout)).toBe('sparecrow/fix-bugs-20260304T143000Z');
  });

  it('extracts improve-code branch name from stdout', () => {
    const stdout =
      'Some output\ngit checkout -b sparecrow/improve-code-20260304T120000Z\nMore output';
    expect(extractBranchFromStdout(stdout)).toBe('sparecrow/improve-code-20260304T120000Z');
  });

  it('extracts write-tests branch name from stdout', () => {
    const stdout = 'Created branch sparecrow/write-tests-20260301T080000Z for test writing';
    expect(extractBranchFromStdout(stdout)).toBe('sparecrow/write-tests-20260301T080000Z');
  });

  it('returns null when stdout contains no sparecrow branch pattern', () => {
    const stdout = 'Security audit complete. Found 3 vulnerabilities. No branches created.';
    expect(extractBranchFromStdout(stdout)).toBeNull();
  });

  it('returns null for empty stdout', () => {
    expect(extractBranchFromStdout('')).toBeNull();
  });

  it('returns the first matching branch when stdout contains multiple branch references', () => {
    const stdout = 'sparecrow/fix-bugs-20260304T100000Z\nsparecrow/fix-bugs-20260304T110000Z';
    expect(extractBranchFromStdout(stdout)).toBe('sparecrow/fix-bugs-20260304T100000Z');
  });
});
