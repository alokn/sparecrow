/** Daemon summary writer — writes last-summary.txt after dispatch cycles when enabled. */
import { join } from 'node:path';
import { atomicWrite } from '../utils/index.js';
import { logger } from '../utils/index.js';

/** Exact template for the last-summary.txt one-liner (AC9).
 *  Format: `sparecrow: <success_count> tasks completed in last dispatch cycle. Run sparecrow logs for details.` */
function buildSummaryLine(successCount: number): string {
  return `sparecrow: ${String(successCount)} tasks completed in last dispatch cycle. Run sparecrow logs for details.`;
}

/** Writes last-summary.txt to the platform-resolved state directory.
 *  Called after a dispatch cycle completes when lastSummaryEnabled === true.
 *
 *  Failure isolation: filesystem errors (e.g. EACCES) are logged as non-fatal warnings
 *  and do not propagate — callers must not depend on this write succeeding (AC14). */
export async function writeSummaryFile(dataDir: string, successCount: number): Promise<void> {
  const filePath = join(dataDir, 'last-summary.txt');
  const content = buildSummaryLine(successCount);

  try {
    await atomicWrite(filePath, content);
    void logger.debug('summary-writer.written', { filePath, successCount });
  } catch (err) {
    // Non-fatal: log warning and continue — must not break dispatch cycle (AC14)
    void logger.warn('summary-writer.write-failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
