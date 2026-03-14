/** Type definitions barrel — re-exports all shared types. */

export type { JsonResponse } from './common.js';
export { jsonOk, jsonError } from './common.js';

export type { LogLevel, AuditRecord, AuditMeta } from './audit.js';

export type {
  ScrowConfig,
  ProviderConfig,
  TriggerConfig,
  CustomTaskConfig,
  ContainerConfig,
  IdleHoursEntry,
  DayOfWeek,
} from './config.js';

export type { CapacitySnapshot, CapacityWindow, UsageSource, ConfidenceLevel } from './usage.js';

export type { TriggerCondition, TriggerResult } from './trigger.js';

export type {
  TaskDefinition,
  TaskResult,
  TaskStatus,
  DispatchCycleResult,
  DispatchOptions,
  OnTaskStartCallback,
  OnTaskCompleteCallback,
  DispatchAuditMeta,
  DispatchLogger,
  QueueDispatchPort,
  DispatcherDeps,
  DispatchAdapter,
  DispatchAdapterOptions,
} from './task.js';

export type {
  UsageMonitor,
  TaskExecutor,
  TaskExecutorOptions,
  AuthManager,
  AuthValidationResult,
  Provider,
  BackendExecutionOptions,
  BackendExecutionResult,
  ExecutionBackend,
} from './provider.js';

export { EventName } from './events.js';
export type { EventNameValue } from './events.js';

export type {
  DaemonState,
  AuthState,
  StatusHealth,
  StatusUsage,
  StatusQueue,
  StatusDispatchRow,
  StatusActivity,
  StatusSnapshot,
  DaemonStatusFile,
  DaemonLastError,
  DaemonLifecycleState,
  DaemonBootstrapStatus,
  DaemonStatusInfo,
  DaemonUsageState,
  DaemonBackendState,
  DaemonTriggerState,
  DaemonActiveTaskState,
  LogOutcome,
  LogEntry,
  LogQueryOptions,
  LogQueryResult,
  FailureSummaryEntry,
} from './status.js';

export type { RequeuePort } from './ports.js';
export { NoOpRequeueAdapter } from './ports.js';

export type {
  ServiceInstallOptions,
  ServiceInstallResult,
  ServiceUninstallResult,
  ServiceTemplateOpts,
} from './service.js';

export type {
  DoctorSeverity,
  DoctorStatus,
  DoctorCheckKey,
  DoctorFinding,
  DoctorSummary,
  DoctorResult,
} from './doctor.js';
export { DOCTOR_CHECK_ORDER, DOCTOR_CHECK_NAMES, CONTAINER_CHECK_KEYS } from './doctor.js';

export type {
  ReportData,
  ReportBreakdownRow,
  UsagePolledRecord,
  TaskCompletedRecord,
} from './report.js';

export type {
  ActionRequest,
  ActionBlock,
  ActionType,
  GitPushAction,
  PrCreateAction,
  IssueCreateAction,
  NotifyAction,
  ActionExecutionStatus,
  ActionExecutionResult,
  ActionExecutorContext,
  ActionResultRecord,
  ActionPipelineResult,
} from './action.js';
export {
  ActionRequestSchema,
  ActionBlockSchema,
  GitPushActionSchema,
  PrCreateActionSchema,
  IssueCreateActionSchema,
  NotifyActionSchema,
} from './action.js';
