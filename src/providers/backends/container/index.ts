/** Container runtime abstractions -- barrel export. */

export type {
  ContainerRuntime,
  RuntimeInfo,
  ContainerRunOptions,
  ContainerHandle,
  ContainerExitResult,
  ContainerStats,
  Mount,
  ContainerListFilter,
  ContainerListEntry,
} from './runtime.js';
export type { ExecResult } from './abstract-runtime.js';
export { DockerRuntime } from './docker-runtime.js';
export { PodmanRuntime } from './podman-runtime.js';
export { detectContainerRuntime } from './detect-runtime.js';
export { ContainerExecutionBackend } from './container-backend.js';
export { resolveContainerCredentials } from './credential-resolver.js';
export type { CredentialResolverOptions, ContainerCredentials } from './credential-resolver.js';
export { resolveBinaryMount } from './binary-resolver.js';
export type { BinaryMountResult, BinaryResolverOptions } from './binary-resolver.js';
