/** Shared utility types used across all modules. */

/** Fixed-schema JSON response wrapper for all CLI --json output.
 *  All three fields are ALWAYS present — use null, never omit. */
export interface JsonResponse<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

export function jsonOk<T>(data: T): JsonResponse<T> {
  return { ok: true, data, error: null };
}

export function jsonError(code: string, message: string): JsonResponse<never> {
  return { ok: false, data: null, error: { code, message } };
}
