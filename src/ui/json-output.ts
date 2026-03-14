/** Prints a JsonResponse as clean JSON with no ANSI codes. */
import type { JsonResponse } from '../types/index.js';

export function printJson<T>(response: JsonResponse<T>): void {
  // process.stdout.write — not console.log — to avoid any extra formatting
  process.stdout.write(JSON.stringify(response, null, 2) + '\n');
}
