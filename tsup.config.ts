/** tsup build configuration — bundles src/ to dist/ and copies YAML template assets. */
import { defineConfig } from 'tsup';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { version } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  shims: false,
  define: {
    // Replaced with the literal version string at bundle time; see src/utils/version.ts
    'process.env.PACKAGE_VERSION': JSON.stringify(version),
  },
  // onSuccess runs inside the same Node process after bundling completes, so it also fires
  // on watch-mode rebuilds (unlike a postbuild npm script). The callback may optionally
  // return a cleanup function invoked before the next watch-mode rebuild; returning void here
  // is valid per tsup's onSuccess type signature.
  onSuccess: async () => {
    try {
      const srcDir = join(__dirname, 'src', 'templates', 'builtin');
      const destDir = join(__dirname, 'dist', 'builtin');

      // Remove and recreate dest dir to ensure a clean slate — tsup's `clean: true` only
      // cleans bundle outputs (JS/maps), not asset subdirs created by onSuccess. Without
      // this, stale non-YAML files (e.g. .gitkeep from an older build) would persist
      // across rebuilds even though we filter them from the copy below.
      await rm(destDir, { recursive: true, force: true });
      await mkdir(destDir, { recursive: true });

      // Copy only *.yaml files — avoids propagating .gitkeep, .DS_Store, backup files,
      // or any other non-template artifacts into the dist package.
      const entries = await readdir(srcDir);
      const yamlFiles = entries.filter((f) => f.endsWith('.yaml'));

      await Promise.all(yamlFiles.map((file) => copyFile(join(srcDir, file), join(destDir, file))));

      console.log(`[tsup] Copied ${yamlFiles.length} YAML template(s) to dist/builtin/`);
    } catch (err) {
      // Surface errors as a hard build failure so CI/CD and developers know immediately
      // when the copy step breaks, rather than getting a confusing TEMPLATE_LOAD_ERROR at
      // runtime.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[tsup] Failed to copy builtin YAML templates to dist/builtin/: ${message}`);
    }
  },
});
