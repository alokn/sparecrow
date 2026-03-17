/** Zod schema for the persisted queue.json payload. */
import { z } from 'zod';
import { ActionRequestSchema } from '../types/index.js';
import type { ActionType } from '../types/index.js';
import { validateSlug } from '../utils/index.js';

const PersistedTaskStatusSchema = z.enum([
  'pending',
  'in-progress',
  'done',
  'failed',
  'failed_quota',
  'skipped',
]);

/**
 * Valid action type strings — derived from the canonical ActionRequestSchema discriminated
 * union so that adding a new action type to src/types/action.ts automatically extends this
 * schema without requiring a manual update here.
 *
 * The cast to `[ActionType, ...ActionType[]]` is safe: ActionRequestSchema.options are the
 * same four variants that define ActionType, so the runtime values are identical.
 */
const actionTypeValues = ActionRequestSchema.options.map((opt) => opt.shape.type.value) as [
  ActionType,
  ...ActionType[],
];
const ActionTypeSchema = z.enum(actionTypeValues);

/** Shared fields for all persisted tasks. */
const PersistedTaskBase = z.object({
  id: z.string().uuid(),
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
              : 'Task name contains invalid characters (/, \\, .., control chars, or leading dot)',
        });
      }
    }),
  // Backward compatibility: legacy queue.json records may not have status.
  status: PersistedTaskStatusSchema.default('pending'),
  targetPath: z.string().min(1),
  priority: z.number().int().nonnegative(),
  createdAt: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: 'createdAt must be a valid ISO 8601 date string',
    }),
  // Backward compatibility: legacy queue.json records may not have completedAt.
  completedAt: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: 'completedAt must be a valid ISO 8601 date string',
    })
    .optional(),
  timeoutMs: z.number().int().nonnegative(),
  // Backward compatibility: legacy queue.json records may not have actions field.
  actions: z.array(ActionTypeSchema).default([]),
});

/** Template task: requires templateName, prompt may be empty. */
const PersistedTemplateTaskSchema = PersistedTaskBase.extend({
  type: z.literal('template'),
  templateName: z.string().min(1),
  prompt: z.string(),
});

/** Custom task: requires non-empty prompt, no templateName. */
const PersistedCustomTaskSchema = PersistedTaskBase.extend({
  type: z.literal('custom'),
  prompt: z.string(),
});

/** Persisted form of a single queued task — discriminated union on type. */
const PersistedTaskSchema = z.discriminatedUnion('type', [
  PersistedTemplateTaskSchema,
  PersistedCustomTaskSchema,
]);

/** Top-level persisted queue file. Version field allows future migrations. */
const QueuePayloadSchema = z.object({
  version: z.literal(1),
  tasks: z.array(PersistedTaskSchema),
  paused: z.boolean().default(false),
});

/**
 * Serialized form of a queued task as stored in `queue.json`.
 *
 * This is a discriminated union on `type`:
 * - `'template'` tasks require a `templateName` field.
 * - `'custom'` tasks have a user-supplied `prompt`.
 *
 * Dates are stored as ISO 8601 strings (not `Date` objects) for JSON round-tripping.
 * The TypeScript type exposes `createdAt: string` — the ISO 8601 constraint is a
 * Zod-validated runtime guarantee enforced by `PersistedTaskSchema`, not a compile-time
 * type-level guarantee.
 * The schema applies backward-compatible defaults for fields added after v1 (`status`, `actions`).
 */
export type PersistedTask = z.infer<typeof PersistedTaskSchema>;
export type QueuePayload = z.infer<typeof QueuePayloadSchema>;
export { QueuePayloadSchema, PersistedTaskSchema };
