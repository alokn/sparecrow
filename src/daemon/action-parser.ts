/** Parses sparecrow:actions YAML blocks from task output content. */
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/index.js';
import { ActionBlockSchema } from '../types/index.js';
import type { ActionBlock } from '../types/index.js';

/**
 * Fenced opener marker — only matches when the marker appears inside a code fence opener.
 * Used to distinguish a malformed (unclosed) fence from a prose mention.
 */
const FENCED_OPENER_MARKER = '```yaml sparecrow:actions';

/**
 * Regex to extract a fenced YAML block with the sparecrow:actions marker.
 * Matches: ```yaml sparecrow:actions\n<content>\n```
 * Uses non-greedy matching so it stops at the first closing fence.
 */
const ACTION_BLOCK_REGEX = /```yaml\s+sparecrow:actions\s*\n([\s\S]*?)```/;

/**
 * Maximum number of characters allowed in a sparecrow:actions YAML block.
 * Guards against unbounded synchronous YAML parsing in the daemon.
 */
const MAX_BLOCK_SIZE = 65_536; // 64 KiB

/**
 * Parses the sparecrow action block from task output content.
 *
 * Returns the parsed ActionBlock if a valid block is found.
 * Returns null if no block is present (session truncated) or the block is malformed.
 * Never throws.
 */
export function parseActionBlock(content: string): ActionBlock | null {
  // AC5: If no fenced opener is present at all, return null silently
  const match = ACTION_BLOCK_REGEX.exec(content);
  if (!match) {
    // Only warn when there is a genuine fenced opener (not a prose mention)
    if (content.includes(FENCED_OPENER_MARKER)) {
      void logger.warn('action-parser.malformed-fence', {
        reason: 'sparecrow:actions marker found but no closing ``` fence detected',
      });
    }
    return null;
  }

  // match[1] is guaranteed to be defined when the regex matches (group always participates)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const yamlContent = match[1]!;

  // Guard against excessively large blocks to protect the daemon process
  if (yamlContent.length > MAX_BLOCK_SIZE) {
    void logger.warn('action-parser.block-too-large', {
      size: yamlContent.length,
      limit: MAX_BLOCK_SIZE,
    });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent, { maxAliasCount: 100 });
  } catch (err) {
    // AC4: Invalid YAML — log warning, return null
    void logger.warn('action-parser.yaml-parse-error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // AC4: Handle empty block (yaml.parse('') returns null/undefined)
  if (parsed === null || parsed === undefined) {
    void logger.warn('action-parser.schema-validation-error', {
      error: 'Action block is empty; expected an object with an "actions" array',
    });
    return null;
  }

  // AC4: Schema validation failure — log warning, return null
  const result = ActionBlockSchema.safeParse(parsed);
  if (!result.success) {
    void logger.warn('action-parser.schema-validation-error', {
      error: result.error.message,
    });
    return null;
  }

  return result.data;
}
