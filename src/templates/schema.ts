/** Zod schema for validating built-in template YAML objects. */
import { z } from 'zod';
import type { ActionType } from '../types/index.js';
import { validateSlug } from '../utils/index.js';

/**
 * Canonical action type string values derived from the ActionType union in src/types/action.ts.
 * This satisfies the ActionType union so TypeScript enforces parity at compile time — any new
 * action type added to ActionType must also appear here or the build will fail.
 */
export const ACTION_TYPE_VALUES = [
  'git-push',
  'pr-create',
  'issue-create',
  'notify',
] as const satisfies ReadonlyArray<ActionType>;

/** Zod schema for a single action type string in the template manifest. */
export const ActionTypeSchema = z.enum(ACTION_TYPE_VALUES);

export const TemplateSchema = z.object({
  name: z
    .string()
    .min(1)
    .superRefine((val, ctx) => {
      try {
        validateSlug(val);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            err instanceof Error
              ? err.message
              : 'Template name contains invalid characters (/, \\, .., control chars, or leading dot)',
        });
      }
    }),
  description: z.string().min(1),
  prompt: z.string().min(1),
  timeout_minutes: z.number().int().min(0).optional(),
  /**
   * Optional list of action types this template may request after execution. Defaults to [] (opt-in).
   * Duplicate entries are rejected by the uniqueness refine.
   */
  actions: z
    .array(ActionTypeSchema)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'actions list must not contain duplicate entries',
    })
    .optional(),
});

export type TemplateYaml = z.infer<typeof TemplateSchema>;
