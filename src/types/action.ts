/** ActionRequest discriminated union and ActionBlock types for the action request protocol. */
import { z } from 'zod';

/** Regex for validating git ref names — rejects option injection like --delete, --mirror.
 *  First char must be alphanumeric, dot, or underscore (not hyphen or slash).
 *  Remaining chars allow alphanumeric, dot, underscore, slash, hyphen.
 *  Additional constraints enforced separately: no trailing dot, no consecutive dots (..),
 *  no .lock suffix — per git-check-ref-format rules. */
const GIT_REF_REGEX = /^[a-zA-Z0-9._][a-zA-Z0-9._/-]*$/;

/**
 * Validates a git ref string against additional git-check-ref-format rules:
 * - Must not end with a dot
 * - Must not contain consecutive dots (..)
 * - Must not end with .lock (or contain a /<component>.lock segment)
 * Returns an error message string if invalid, or null if valid.
 */
function validateGitRefExtended(ref: string): string | null {
  if (ref.endsWith('.')) return 'Git ref must not end with a dot';
  if (ref.includes('..')) return 'Git ref must not contain consecutive dots (..)';
  // Reject any path component that ends with .lock (e.g., "main.lock", "refs/heads/main.lock")
  const parts = ref.split('/');
  for (const part of parts) {
    if (part.endsWith('.lock')) return 'Git ref must not have a .lock suffix on any component';
  }
  return null;
}

/** Zod schema for a git-push action request. */
export const GitPushActionSchema = z.object({
  type: z.literal('git-push'),
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(GIT_REF_REGEX, 'Invalid git ref format')
    .superRefine((val, ctx) => {
      const err = validateGitRefExtended(val);
      if (err !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }),
  remote: z
    .string()
    .min(1)
    .max(255)
    .regex(GIT_REF_REGEX, 'Invalid git ref format')
    .superRefine((val, ctx) => {
      const err = validateGitRefExtended(val);
      if (err !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    })
    .optional(),
  force: z.boolean().optional(),
});

/** Zod schema for a pr-create action request. */
export const PrCreateActionSchema = z.object({
  type: z.literal('pr-create'),
  title: z.string().min(1),
  body: z.string().min(1),
  base_branch: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  draft: z.boolean().optional(),
});

/** Zod schema for an issue-create action request. */
export const IssueCreateActionSchema = z.object({
  type: z.literal('issue-create'),
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string()).optional(),
});

/** Zod schema for a notify action request. */
export const NotifyActionSchema = z.object({
  type: z.literal('notify'),
  message: z.string().min(1),
  channel: z.string().optional(),
});

/** Zod discriminated union schema for all ActionRequest variants. */
export const ActionRequestSchema = z.discriminatedUnion('type', [
  GitPushActionSchema,
  PrCreateActionSchema,
  IssueCreateActionSchema,
  NotifyActionSchema,
]);

/** Zod schema for the full ActionBlock (a list of action requests). */
export const ActionBlockSchema = z.object({
  actions: z.array(ActionRequestSchema),
});

/** A git-push action: pushes a branch to origin. */
export type GitPushAction = z.infer<typeof GitPushActionSchema>;

/** A pr-create action: creates a pull request. */
export type PrCreateAction = z.infer<typeof PrCreateActionSchema>;

/** An issue-create action: creates an issue. */
export type IssueCreateAction = z.infer<typeof IssueCreateActionSchema>;

/** A notify action: sends a notification message. */
export type NotifyAction = z.infer<typeof NotifyActionSchema>;

/** Discriminated union of all supported action request types. */
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

/** A block of action requests emitted by a template at end of task output. */
export type ActionBlock = z.infer<typeof ActionBlockSchema>;

/** Valid action type strings that can appear in template manifests. */
export type ActionType = ActionRequest['type'];

/** Status of a single executed action. */
export type ActionExecutionStatus = 'success' | 'failed' | 'skipped' | 'dry-run';

/** Result of executing one action request. */
export interface ActionExecutionResult {
  type: ActionType;
  status: ActionExecutionStatus;
  /** PR or issue URL returned by gh CLI on success. */
  url?: string;
  /** Human-readable error message on 'failed' status. */
  error?: string;
  /** Human-readable reason for 'skipped' or 'dry-run' status. */
  reason?: string;
}

/** Context passed to executeActions — identifies where and how to run. */
export interface ActionExecutorContext {
  /** Absolute path to the target git repository. */
  repoPath: string;
  /** Declared action types from the template manifest (for AC6 validation). */
  templateActions: ReadonlyArray<ActionType>;
  /** Task ID for structured log messages. */
  taskId: string;
  /** When true, all actions are logged but not executed (AC7). */
  dryRun?: boolean;
}

/** Serialisable form of ActionExecutionResult for the companion .actions.json file.
 *  All fields always present — no optional fields (project anti-pattern). */
export interface ActionResultRecord {
  type: ActionType;
  status: ActionExecutionStatus;
  url: string | null;
  error: string | null;
  reason: string | null;
}

/** Result of running the full action pipeline for one task. */
export interface ActionPipelineResult {
  task_id: string;
  source: 'parsed' | 'inferred';
  actions_requested: number;
  actions_executed: number;
  actions_failed: number;
  actions_skipped: number;
  results: ActionResultRecord[];
}
