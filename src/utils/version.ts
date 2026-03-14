/** Package version — inlined at build time via tsup define; falls back in dev. */
// process.env.PACKAGE_VERSION is replaced with the literal version string during tsup bundling.
// In dev (tsx), it is undefined; npm_package_version is set by npm when running npm scripts.
export const VERSION: string =
  process.env['PACKAGE_VERSION'] ?? process.env['npm_package_version'] ?? 'unknown';
