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

### ~~Read-write `~/.claude/` credential mount (HIGH)~~ — RESOLVED in v1.1

- **Location**: `src/providers/backends/container/credential-resolver.ts`
- **Description**: The `~/.claude/` directory is mounted read-write into the container, giving the container process write access to OAuth credentials
- **Resolution (v1.1, Story 22.1)**: The `~/.claude/` directory is now mounted read-only by default (`readonly: true`). This prevents a compromised container process from **modifying or tampering with** OAuth credentials (e.g. token rotation attacks, credential corruption). Note: a read-only mount does not prevent the container process from *reading* credential file contents — this is expected and required for Claude Code authentication. A `mount_claude_config_readonly` config option (default: `true`) allows users to override this with a `warn`-level security log. OAuth token refresh is handled on the host side by `auth-manager.ts` and the refreshed token is available on the next container task via the read-only mount.

### ~~Task prompt visible in `/proc/PID/cmdline` (MEDIUM)~~ — RESOLVED in v1.1

- **Location**: `src/providers/claude-code/task-executor.ts`
- **Description**: Task prompts are passed as CLI arguments to the `claude` binary, making them visible in `/proc/PID/cmdline` to other users on shared servers
- **Resolution (v1.1, Story 22.2)**: Task prompts are now delivered to the `claude` binary via stdin pipe instead of CLI arguments. The `--print` flag is passed without a positional prompt argument, and the prompt text is written to the child process's stdin stream. For the container execution backend, `docker/podman run -i --rm` is used instead of `--detach` when stdin data is present, enabling stdin passthrough into the container. The `stdinData` field in `BackendExecutionOptions` carries the prompt through the execution pipeline without exposing it in `/proc/PID/cmdline`.

### ~~PID file TOCTOU race (MEDIUM)~~ — RESOLVED in v1.1

- **Location**: `src/daemon/lifecycle.ts`
- **Description**: The PID file check-then-use pattern has a time-of-check-to-time-of-use race condition between reading the PID file and sending a signal
- **Resolution (v1.1, Story 22.3)**: A `PidLock` utility (`src/daemon/pid-lock.ts`) now provides advisory file locking using atomic exclusive file creation (`O_EXCL`). The daemon runner acquires an exclusive lock on `daemon.pid.lock` at startup and holds the file handle open for its lifetime. On process crash, the OS closes the file handle and the stale lock file is detected via PID liveness check on next startup (automatic recovery). The `daemon start` command checks the advisory lock before the PID file check, eliminating the TOCTOU race window. Two concurrent `daemon start` invocations cannot both succeed — the second detects the lock and exits with `DAEMON_ALREADY_RUNNING`.

### WSL permission-check bypass heuristic (MEDIUM)

- **Location**: `src/platform/detect.ts`
- **Description**: On WSL (Windows Subsystem for Linux), filesystem permission checks were bypassed for all paths because WSL does not enforce POSIX permissions on Windows-hosted filesystems
- **Resolution (v1.1, Story 22.4)**: The `isWslWindowsPath()` function in `src/platform/detect.ts` now narrows the permission-check bypass to only Windows-hosted mount points (default: `/mnt/`). POSIX-native filesystems within WSL (e.g., `/home/`, `/tmp/`, `/var/`) now receive proper permission enforcement. The mount prefix is configurable via `wsl_mount_prefix` in `config.yaml` for non-standard WSL mount configurations. Non-WSL platforms are unaffected.

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
