/** Maps ErrorCode values to user-friendly messages and doctor suggestions. */
import { ErrorCode } from './error-codes.js';
import type { ErrorCodeValue } from './error-codes.js';

export interface ErrorUserMessage {
  userMessage: string;
  suggestion: string;
}

const ERROR_MESSAGES: Record<ErrorCodeValue, ErrorUserMessage> = {
  [ErrorCode.AUTH_TOKEN_EXPIRED]: {
    userMessage: 'Your Claude Code session has expired.',
    suggestion: 'Run: sparecrow config --reconnect',
  },
  [ErrorCode.AUTH_TOKEN_MISSING]: {
    userMessage: 'Claude Code authentication token not found.',
    suggestion: 'Run: claude auth login, then retry',
  },
  [ErrorCode.AUTH_TOKEN_FORMAT_CHANGED]: {
    userMessage: 'Claude Code token storage format has changed unexpectedly.',
    suggestion: 'Run: sparecrow doctor for diagnosis',
  },
  [ErrorCode.PROVIDER_UNREACHABLE]: {
    userMessage: 'Cannot reach the usage data provider.',
    suggestion: 'Check network connectivity. Run: sparecrow doctor',
  },
  [ErrorCode.PROVIDER_NOT_FOUND]: {
    userMessage: 'Unknown provider specified in configuration.',
    suggestion: 'Run: sparecrow config set provider.name claude-code',
  },
  [ErrorCode.QUEUE_EMPTY]: {
    userMessage: 'No tasks in queue.',
    suggestion: 'Run: sparecrow queue add --template improve-code --target <path>',
  },
  [ErrorCode.QUEUE_CORRUPT]: {
    userMessage: 'Task queue file is corrupt. The corrupt file has been renamed for inspection.',
    suggestion:
      'Run `sparecrow queue clear --yes` to reset, or inspect the backup file saved alongside queue.json',
  },
  [ErrorCode.QUEUE_WRITE_FAILED]: {
    userMessage: 'Failed to write task queue file.',
    suggestion: 'Check disk space and file permissions. Run: sparecrow doctor',
  },
  [ErrorCode.QUEUE_INVALID_POSITION]: {
    userMessage: 'Invalid queue position.',
    suggestion: 'Run: sparecrow queue to see valid positions',
  },
  [ErrorCode.QUEUE_CONFIRMATION_REQUIRED]: {
    userMessage: 'Confirmation required for destructive queue operations.',
    suggestion: 'Pass --yes to confirm in non-interactive or JSON mode',
  },
  [ErrorCode.CONFIG_INVALID]: {
    userMessage: 'Configuration file contains invalid values.',
    suggestion: 'Run: sparecrow config validate  for details, or  sparecrow config edit  to fix',
  },
  [ErrorCode.CONFIG_NOT_FOUND]: {
    userMessage: 'Configuration file not found.',
    suggestion: 'Run: sparecrow onboard to create initial configuration',
  },
  [ErrorCode.DAEMON_ALREADY_RUNNING]: {
    userMessage: 'Daemon is already running.',
    suggestion: 'Run: sparecrow daemon stop to stop it, or sparecrow daemon restart',
  },
  [ErrorCode.DAEMON_NOT_RUNNING]: {
    userMessage: 'Daemon is not running.',
    suggestion: 'Run: sparecrow daemon start',
  },
  [ErrorCode.CLAUDE_NOT_FOUND]: {
    userMessage:
      'Claude Code binary not found. Install Claude Code from https://claude.ai/download or set provider.claude_path in your config.',
    suggestion: 'Install Claude Code: https://claude.ai/download, then run: sparecrow onboard',
  },
  [ErrorCode.TASK_TIMEOUT]: {
    userMessage: 'Task execution exceeded the configured timeout.',
    suggestion: 'Increase timeout via config or check target repository size',
  },
  [ErrorCode.TASK_EXECUTOR_NOT_IMPLEMENTED]: {
    userMessage: 'Task execution is not yet configured for this provider.',
    suggestion: 'Ensure you are using the claude-code provider',
  },
  [ErrorCode.UNKNOWN_COMMAND]: {
    userMessage: 'Unknown command.',
    suggestion: 'Run: sparecrow --help for a list of available commands',
  },
  [ErrorCode.TEMPLATE_NOT_FOUND]: {
    userMessage: 'Template not found.',
    suggestion: 'Run: sparecrow templates to see available templates',
  },
  [ErrorCode.TEMPLATE_INVALID]: {
    userMessage: 'Template file is invalid or does not match the required schema.',
    suggestion: 'Check the template YAML for required fields: name, description, prompt',
  },
  [ErrorCode.TEMPLATE_LOAD_ERROR]: {
    userMessage: 'Failed to load a built-in template file.',
    suggestion: 'Run: sparecrow doctor to inspect the installation',
  },
  [ErrorCode.TEMPLATE_DUPLICATE_KEY]: {
    userMessage: 'Duplicate template key detected.',
    suggestion: 'Ensure all template names are unique across built-in and custom templates',
  },
  [ErrorCode.QUEUE_ADD_INVALID_MODE]: {
    userMessage: 'queue add requires exactly one of --template or --prompt',
    suggestion: 'Usage: sparecrow queue add --template <name> --target <path>',
  },
  [ErrorCode.QUEUE_ADD_TARGET_INVALID]: {
    userMessage: 'Target path is invalid.',
    suggestion: 'Provide an existing git repository directory path',
  },
  [ErrorCode.QUEUE_ADD_TEMPLATE_NOT_FOUND]: {
    userMessage: 'Template not found.',
    suggestion: 'Run: sparecrow templates to see available built-in and custom templates',
  },
  [ErrorCode.QUEUE_ADD_TIMEOUT_INVALID]: {
    userMessage: '--timeout must be a non-negative integer (minutes, 0 = no timeout).',
    suggestion: 'Example: --timeout 60 for a 1-hour timeout, --timeout 0 for no timeout',
  },
  [ErrorCode.QUOTA_EXHAUSTED]: {
    userMessage: 'Claude Code quota or rate limit reached. Task has been re-queued.',
    suggestion: 'Wait for quota reset or check usage with: sparecrow status',
  },
  [ErrorCode.TASK_EXECUTION_FAILED]: {
    userMessage: 'Task execution failed with a non-zero exit code.',
    suggestion: 'Check task logs via: sparecrow report',
  },
  [ErrorCode.QUEUE_TASK_NOT_FOUND]: {
    userMessage: 'Task not found in queue.',
    suggestion: 'Run: sparecrow queue to see current queue state',
  },
  [ErrorCode.LOGS_INVALID_FILTER]: {
    userMessage: 'Invalid filter value for logs command.',
    suggestion:
      'Use a positive integer for --count and a duration like 7d, 24h, 30m or an ISO 8601 date for --since',
  },
  [ErrorCode.DAEMON_SPAWN_FAILED]: {
    userMessage: 'Failed to spawn the daemon process.',
    suggestion: 'Check that the binary is installed correctly. Run: sparecrow doctor',
  },
  [ErrorCode.DAEMON_POLL_FAILED]: {
    userMessage: 'Daemon failed to poll usage data after retries.',
    suggestion: 'Check network connectivity and provider configuration. Run: sparecrow doctor',
  },
  [ErrorCode.DAEMON_RELOAD_FAILED]: {
    userMessage: 'Daemon failed to reload configuration.',
    suggestion: 'Check your config file for syntax errors. Run: sparecrow config validate',
  },
  [ErrorCode.CONFIG_WATCH_ERROR]: {
    userMessage: 'Config file watcher encountered an error.',
    suggestion:
      'Daemon will continue running with previous config. Run: sparecrow daemon reload to retry',
  },
  [ErrorCode.SERVICE_INSTALL_UNSUPPORTED_PLATFORM]: {
    userMessage:
      "Service installation is only supported on Linux (systemd) and macOS (launchd). On other platforms, start the daemon manually with 'sparecrow daemon start'.",
    suggestion: "Use 'sparecrow daemon start' to run the daemon manually without auto-start.",
  },
  [ErrorCode.SERVICE_INSTALL_FAILED]: {
    userMessage: 'Failed to install the daemon service file.',
    suggestion: 'Check file permissions on the service directory. Run: sparecrow doctor',
  },
  [ErrorCode.SERVICE_ENABLE_FAILED]: {
    userMessage: 'Failed to enable the daemon service for auto-start.',
    suggestion:
      'On Linux: run systemctl --user enable sparecrow manually. On macOS: run launchctl load ~/Library/LaunchAgents/com.sparecrow.daemon.plist manually.',
  },
  [ErrorCode.SERVICE_INSTALL_CONFIRMATION_REQUIRED]: {
    userMessage: 'Service file already exists. Pass --yes to overwrite in non-interactive mode.',
    suggestion: 'Run: sparecrow daemon install --yes to overwrite without prompting',
  },
  [ErrorCode.SERVICE_UNINSTALL_FAILED]: {
    userMessage: 'Failed to uninstall the daemon service.',
    suggestion:
      'Check file permissions and try removing the service file manually. Run: sparecrow doctor',
  },
  [ErrorCode.DAEMON_AUTH_FAILED]: {
    userMessage: 'Daemon authentication failed. Token refresh was unsuccessful.',
    suggestion: 'Run: sparecrow config --reconnect to re-authenticate',
  },
  [ErrorCode.DAEMON_DEGRADED]: {
    userMessage: 'Daemon is operating in degraded mode due to a failed primary source.',
    suggestion: 'Check network connectivity. Daemon will auto-recover when source is available.',
  },
  [ErrorCode.CONFIG_RELOAD_PRESERVED]: {
    userMessage: 'Config reload failed — daemon continues with last valid configuration.',
    suggestion: 'Fix the config file syntax errors. Run: sparecrow config validate',
  },
  [ErrorCode.SERVICE_START_FAILED]: {
    userMessage: 'Failed to start the daemon service or health verification timed out.',
    suggestion:
      'Check service logs with: journalctl --user -u sparecrow (Linux) or Console.app (macOS). Run: sparecrow doctor',
  },
  [ErrorCode.PLATFORM_UNSUPPORTED]: {
    userMessage: 'This operation is only supported on Linux (systemd) and macOS (launchd).',
    suggestion: "Use 'sparecrow daemon start' to run the daemon manually without auto-start.",
  },
  [ErrorCode.ONBOARD_ROLLBACK_FAILED]: {
    userMessage: 'Onboarding failed and could not fully restore prior configuration/queue state.',
    suggestion: 'Check config.yaml and queue.json manually. Run: sparecrow doctor for diagnosis',
  },
  [ErrorCode.AUTH_RECONNECT_FAILED]: {
    userMessage: 'Re-authentication failed. Claude Code auth did not complete successfully.',
    suggestion: 'Run: sparecrow config --reconnect from an interactive terminal to retry',
  },
  [ErrorCode.AUTH_RECONNECT_CANCELED]: {
    userMessage: 'Re-authentication was canceled.',
    suggestion: 'Run: sparecrow config --reconnect to try again when ready',
  },
  [ErrorCode.REPORT_COMPUTATION_FAILED]: {
    userMessage: 'Report computation failed due to unrecoverable data errors.',
    suggestion: 'Check audit log files for corruption. Run: sparecrow doctor',
  },
  [ErrorCode.DAEMON_LOOP_EXITED]: {
    userMessage: 'Daemon polling loop exited unexpectedly.',
    suggestion: 'Run: sparecrow daemon restart to resume normal operation',
  },
  [ErrorCode.TASK_OUTPUT_NOT_FOUND]: {
    userMessage: 'No output found for the specified task.',
    suggestion: 'Run: sparecrow logs to see tasks with available output',
  },
  [ErrorCode.BACKEND_NOT_AVAILABLE]: {
    userMessage: 'The configured execution backend is not available.',
    suggestion: 'Install Docker or Podman to restore container execution. Run: sparecrow doctor',
  },
  [ErrorCode.CONTAINER_RUNTIME_ERROR]: {
    userMessage: 'Container runtime command failed.',
    suggestion: 'Check Docker/Podman installation. Run: sparecrow doctor',
  },
  [ErrorCode.CONTAINER_RUNTIME_NOT_FOUND]: {
    userMessage:
      "Container runtime not found. Checked: Docker, Podman. The 'container' execution backend requires one of these.",
    get suggestion(): string {
      return process.platform === 'darwin'
        ? 'Install Docker: brew install docker, or Podman: brew install podman. Alternatively, set execution_backend: direct in your config.'
        : 'Install Docker: sudo apt install docker.io (Debian/Ubuntu) or sudo dnf install docker (Fedora). Alternatively, set execution_backend: direct in your config.';
    },
  },
  [ErrorCode.CONTAINER_CLEANUP_FAILED]: {
    userMessage: 'All container removal attempts failed during cleanup.',
    suggestion:
      'Check Docker/Podman permissions or remove containers manually. Run: sparecrow doctor',
  },
  [ErrorCode.CONTAINER_RUNTIME_UNAVAILABLE]: {
    userMessage: 'Container runtime is unavailable. Dispatch skipped.',
    suggestion: 'Restart Docker/Podman to restore container execution. Run: sparecrow doctor',
  },
  [ErrorCode.TASK_OOM_KILLED]: {
    userMessage: 'Container task was killed due to insufficient memory (OOM).',
    suggestion:
      'Increase the memory limit: sparecrow config set provider.container.memory_limit_mb 1024',
  },
  [ErrorCode.RESULT_WRITE_FAILED]: {
    userMessage: 'Failed to write result artifact to the target repository.',
    suggestion:
      'Check file permissions on the target repo .scrow/ directory. Run: sparecrow doctor',
  },
  [ErrorCode.RESULTS_NOT_FOUND]: {
    userMessage: 'No result artifact found for the specified task ID.',
    suggestion: 'Run: sparecrow results to see available results, or run a task first',
  },
  [ErrorCode.IDLE_HOURS_INVALID_TIMEZONE]: {
    userMessage: 'Invalid timezone string in idle hours evaluation.',
    suggestion:
      'Use a valid IANA timezone string (e.g. "America/New_York", "Europe/London", "UTC")',
  },
  [ErrorCode.IDLE_HOURS_PARSE_ERROR]: {
    userMessage: 'Failed to parse idle hours time value.',
    suggestion: 'Ensure all idle_hours start/end values are in HH:MM format (00:00-23:59)',
  },
  [ErrorCode.TASK_PARTIAL_OUTPUT_NOT_FOUND]: {
    userMessage: 'No in-progress task output found for the specified task.',
    suggestion:
      "Run: sparecrow queue to see in-progress tasks, or use 'sparecrow logs --output <id>' for completed tasks",
  },
  [ErrorCode.TASK_AMBIGUOUS]: {
    userMessage: 'Multiple in-progress tasks found. Specify a task ID.',
    suggestion: 'Run: sparecrow queue to list in-progress tasks and copy the desired task ID',
  },
  [ErrorCode.INVALID_ARGUMENT]: {
    userMessage: 'Invalid argument provided.',
    suggestion: 'Run: sparecrow --help for usage details',
  },
  [ErrorCode.QUEUE_INVALID_TRANSITION]: {
    userMessage: 'Invalid task status transition.',
    suggestion:
      'Valid lifecycle: pending -> in-progress -> done/failed/failed_quota; pending -> skipped; failed_quota -> in-progress/pending. Terminal states (done, failed, skipped) have no outgoing transitions.',
  },
  [ErrorCode.DATA_INVALID]: {
    userMessage: 'Runtime state data file contains invalid values.',
    suggestion: 'Run: sparecrow doctor to inspect and repair state files',
  },
  [ErrorCode.NOT_GIT_REPO]: {
    userMessage: 'Current directory is not a git repository.',
    suggestion:
      'Run sparecrow quickstart from inside a git repo, or specify a path: sparecrow quickstart /path/to/repo',
  },
  [ErrorCode.QUICKSTART_EXECUTION_FAILED]: {
    userMessage: 'Quickstart task execution failed.',
    suggestion:
      'Check the error output above. Ensure Claude Code is authenticated: claude auth login',
  },
  [ErrorCode.STATE_DIR_PERMISSION_DENIED]: {
    userMessage: 'Permission denied when creating or writing to the state directory.',
    suggestion:
      'Fix ownership with: sudo chown -R $(whoami) <path>, or check that the parent directory is writable',
  },
  [ErrorCode.COMPLETIONS_INSTALL_FAILED]: {
    userMessage: 'Failed to install shell completions.',
    suggestion:
      'Check file permissions on your shell rc file. Run: sparecrow completions <shell> to print the script manually.',
  },
  [ErrorCode.STATS_COMPUTATION_FAILED]: {
    userMessage: 'Stats computation failed due to unrecoverable data errors.',
    suggestion: 'Check audit log files for corruption. Run: sparecrow doctor',
  },
  [ErrorCode.CRASH_REPORT_NOT_FOUND]: {
    userMessage: 'Crash report file not found.',
    suggestion: 'Check the file path. Crash reports are stored in the sparecrow state directory.',
  },
  [ErrorCode.CRASH_REPORT_INVALID]: {
    userMessage: 'Crash report file is invalid or unreadable.',
    suggestion: 'Ensure the file is a valid crash report JSON generated by sparecrow.',
  },
};

export function getErrorMessage(code: ErrorCodeValue): ErrorUserMessage {
  return (
    ERROR_MESSAGES[code] ?? {
      userMessage: `An unexpected error occurred (${code}).`,
      suggestion: 'Run: sparecrow doctor for diagnosis',
    }
  );
}
