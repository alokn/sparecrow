/** Seeds a .claude/.credentials.json file inside a HOME-isolated temp directory. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Options for seeding a credentials file. All fields are optional. */
export interface SeedCredentialsOptions {
  /**
   * The OAuth access token to write. Defaults to `'e2e-test-token'` when omitted.
   * Use a descriptive value (e.g. `'e2e-test-token'`) — this is never sent to a real server
   * in unit/E2E tests unless `usage-endpoint-connectivity` makes an outbound call.
   */
  accessToken?: string;
  /**
   * Token expiry value to include in the credentials file.
   * - `undefined` (default): the `expiresAt` field is omitted entirely, so the expiry
   *   check in `checkAuthTokenValidity` is skipped and the token is always considered valid.
   * - `null`: same as `undefined` — the field is omitted (explicit no-expiry).
   * - A `number` or `string`: written verbatim; use epoch-milliseconds (number) or an
   *   ISO 8601 string. Pass a value in the past to trigger the "token expired" failure path.
   */
  expiresAt?: number | string | null;
}

/**
 * Writes a `.claude/.credentials.json` file inside `homeDir`.
 *
 * This mirrors the hardcoded path in `src/providers/claude-code/auth-manager.ts`:
 * `join(homedir(), '.claude', '.credentials.json')`.
 *
 * @param homeDir - The isolated HOME directory for the test
 * @param opts - Optional overrides for the credentials content
 * @returns The absolute path of the written `.credentials.json` file
 */
export async function seedCredentials(
  homeDir: string,
  opts?: SeedCredentialsOptions,
): Promise<string> {
  const credPath = join(homeDir, '.claude', '.credentials.json');

  // Create the .claude/ directory
  await mkdir(join(homeDir, '.claude'), { recursive: true });

  // Build the credentials JSON object
  const creds: Record<string, unknown> = {
    accessToken: opts?.accessToken ?? 'e2e-test-token',
  };

  // Include expiresAt only when it is defined and not null
  if (opts?.expiresAt !== undefined && opts?.expiresAt !== null) {
    creds.expiresAt = opts.expiresAt;
  }

  // Write with 0o600 permissions (matching auth-manager.ts expectations)
  await writeFile(credPath, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });

  return credPath;
}
