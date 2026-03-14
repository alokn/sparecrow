# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in sparecrow, please report it responsibly through **GitHub Security Advisories**:

1. Go to [github.com/alokn/sparecrow/security/advisories/new](https://github.com/alokn/sparecrow/security/advisories/new)
2. Provide a description of the vulnerability, steps to reproduce, and potential impact
3. We will acknowledge receipt within 48 hours and provide a timeline for a fix

**Do not** open a public GitHub issue for security vulnerabilities.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.0-beta.x | Yes |
| < 1.0.0 | No (internal alpha, deprecated) |

## Security Hardening (v1.0.0-beta.1)

The following security measures are implemented in the current release:

- **Environment variable stripping**: Configurable `env_strip_patterns` removes sensitive env vars before passing them to container execution backends
- **Restrictive file permissions**: Audit log files and partial output files are created with mode `0o600` (owner read/write only)
- **YAML alias expansion bounds**: Action block parser limits YAML alias expansion to 100 aliases, preventing alias-based denial of service
- **Git ref validation**: Git push action parameters (`branch`, `remote`) are validated against a strict regex that rejects option injection (e.g., `--delete`, `--mirror`)
- **UUID task IDs**: Queue task IDs are validated as UUIDs at the schema level, preventing path traversal via crafted IDs
- **Systemd template quoting**: All interpolated values in systemd unit files are quoted consistently, preventing argument injection via paths with spaces
- **Container security**: Containers run with `CAP_DROP=ALL`, `no-new-privileges`, and ephemeral `/tmp` with `nosuid,noexec`
- **No credential logging**: The structured logger is designed to never log tokens, credentials, or secrets at any log level

## Deferred Findings

The following findings from security audits (2026-03-10, 2026-03-13) are architecturally complex or well-mitigated. They are documented here with their current mitigations and planned fix versions.

### Read-write `~/.claude/` credential mount (HIGH)

- **Location**: `src/providers/backends/container/credential-resolver.ts`
- **Description**: The `~/.claude/` directory is mounted read-write into the container, giving the container process write access to OAuth credentials
- **Current mitigation**: Container runs with `CAP_DROP=ALL` and `no-new-privileges`, limiting what a compromised process can do with the credentials
- **Planned fix**: Read-only mount in v1.1 (`readonly: true` on the credential mount)

### Task prompt visible in `/proc/PID/cmdline` (MEDIUM)

- **Location**: `src/providers/claude-code/task-executor.ts`
- **Description**: Task prompts are passed as CLI arguments to the `claude` binary, making them visible in `/proc/PID/cmdline` to other users on shared servers
- **Current mitigation**: This is only relevant on shared multi-user servers; most sparecrow users run on single-user workstations or CI machines
- **Planned fix**: Pass prompts via stdin pipe in v1.1

### PID file TOCTOU race (MEDIUM)

- **Location**: `src/daemon/daemon-lifecycle.ts`
- **Description**: The PID file check-then-use pattern has a time-of-check-to-time-of-use race condition between reading the PID file and sending a signal
- **Current mitigation**: `killOrphanDaemons()` on startup detects and cleans up stale PIDs; the race window is very small in practice
- **Planned fix**: File lock (e.g., `flock`) in v1.1

### WSL permission-check bypass heuristic (MEDIUM)

- **Location**: `src/platform/detect.ts`
- **Description**: On WSL (Windows Subsystem for Linux), filesystem permission checks are bypassed because WSL does not enforce POSIX permissions on Windows-hosted filesystems
- **Current mitigation**: This heuristic only applies on WSL, where POSIX permissions are not meaningful
- **Planned fix**: Narrow the bypass to only Windows-hosted mount points in v1.1

### `execOrThrow` args in error messages (LOW)

- **Location**: `src/utils/exec.ts`
- **Description**: When `execOrThrow` fails, the error message includes the full command arguments, which could potentially contain sensitive information
- **Current mitigation**: No secrets are passed as command arguments in the current codebase; all sensitive data flows through environment variables or mounted files
- **Planned fix**: Sanitize arguments in error messages in v1.1

### `safeReadJson` unchecked type assertion (LOW)

- **Location**: `src/utils/fs.ts`
- **Description**: `safeReadJson` returns `unknown` but callers cast the result without runtime validation
- **Current mitigation**: All current callers validate the parsed result through Zod schemas or explicit type checks
- **Planned fix**: Add optional Zod schema parameter to `safeReadJson` for runtime validation in v1.1
