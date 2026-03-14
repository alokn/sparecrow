/** Integration test verifying that npm run build produces dist/builtin/ with exactly 4 YAML files (AC1). */
import { describe, it, expect, beforeAll } from 'vitest';
import { readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
const distBuiltinDir = join(projectRoot, 'dist', 'builtin');

const EXPECTED_YAML_FILES = [
  'fix-bugs.yaml',
  'improve-code.yaml',
  'security-audit.yaml',
  'write-tests.yaml',
];

describe('builtin-templates build output', () => {
  beforeAll(async () => {
    // Run the build so dist/builtin/ is freshly populated
    await execAsync('npm run build', { cwd: projectRoot });
  }, 60000);

  it('creates dist/builtin/ directory after build', async () => {
    await expect(access(distBuiltinDir)).resolves.toBeUndefined();
  });

  it('contains exactly 4 YAML files in dist/builtin/', async () => {
    const entries = await readdir(distBuiltinDir);
    const yamlFiles = entries.filter((f) => f.endsWith('.yaml')).sort();
    expect(yamlFiles).toHaveLength(4);
  });

  it('contains exactly the canonical template YAML files', async () => {
    const entries = await readdir(distBuiltinDir);
    const yamlFiles = entries.filter((f) => f.endsWith('.yaml')).sort();
    expect(yamlFiles).toEqual(EXPECTED_YAML_FILES);
  });

  it('does not copy non-YAML files (e.g. .gitkeep) to dist/builtin/', async () => {
    const entries = await readdir(distBuiltinDir);
    const nonYaml = entries.filter((f) => !f.endsWith('.yaml'));
    expect(nonYaml).toHaveLength(0);
  });
});
