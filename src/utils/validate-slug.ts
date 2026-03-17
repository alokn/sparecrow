/** Validates slug strings used in filenames and schema names. */
import { ScrowError, ErrorCode } from '../errors/index.js';

/**
 * Regex matching characters forbidden in slugs:
 * - Forward slash (/)
 * - Backslash (\)
 */
const FORBIDDEN_CHARS = /[/\\]/;
/**
 * Regex matching non-printable control characters forbidden in slugs:
 * - C0 control characters (U+0000–U+001F)
 * - DEL character (U+007F)
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates that the input string is a safe slug for use in filenames and identifiers.
 *
 * Rejects:
 * - Forward slash (/)
 * - Backslash (\)
 * - Double dot path traversal (..)
 * - Control characters (U+0000–U+001F) and DEL (U+007F)
 * - Leading dots (e.g., ".hidden")
 *
 * @param input - The string to validate
 * @returns The input string unchanged if valid
 * @throws ScrowError with INVALID_SLUG if validation fails
 */
export function validateSlug(input: string): string {
  if (FORBIDDEN_CHARS.test(input)) {
    throw new ScrowError(
      ErrorCode.INVALID_SLUG,
      `Slug contains forbidden character (/ or \\): "${input}"`,
    );
  }

  if (CONTROL_CHARS.test(input)) {
    throw new ScrowError(ErrorCode.INVALID_SLUG, `Slug contains control character: "${input}"`);
  }

  if (input.includes('..')) {
    throw new ScrowError(ErrorCode.INVALID_SLUG, `Slug contains path traversal (..): "${input}"`);
  }

  if (input.startsWith('.')) {
    throw new ScrowError(ErrorCode.INVALID_SLUG, `Slug must not start with a dot: "${input}"`);
  }

  return input;
}
