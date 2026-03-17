sparecrow(1) -- put spare Claude capacity to work
==================================================

## NAME

sparecrow - CLI tool and background daemon that monitors Claude Code subscription usage and dispatches queued tasks automatically

## SYNOPSIS

`sparecrow` [--json] [--quiet] [--config <path>] <command> [options]

`scrow` [--json] [--quiet] [--config <path>] <command> [options]

## DESCRIPTION

**sparecrow** monitors your Claude Code subscription usage and automatically dispatches queued tasks against your repositories when surplus capacity is detected. It authenticates via the Claude Code OAuth token, polls usage metrics, and executes pre-configured or user-defined prompts against git repositories using `claude` when capacity thresholds are met.

## GLOBAL OPTIONS

  * `--json`:
    Output all results in machine-readable JSON format. The envelope is always `{ ok, data, error }`.

  * `--quiet`:
    Suppress non-essential output.

  * `--config` <path>:
    Path to config.yaml. Overrides the default platform-specific location.

  * `--version`:
    Output the current version.

  * `--help`:
    Display help for a command.

## COMMANDS

### Getting Started

  * `sparecrow onboard`:
    Interactive onboarding wizard. Validates authentication, configures trigger thresholds, selects templates, targets repositories, and optionally installs the daemon as a system service.

  * `sparecrow quickstart` [path]:
    Run a single template task inline with zero configuration. Useful for trying sparecrow without setting up a config file or daemon.

  * `sparecrow status` [--all]:
    Display subscription usage, daemon state, and queue summary. Use `--all` to show all capacity windows.

### Queue Management

  * `sparecrow queue list` [--history]:
    List tasks in the queue. Use `--history` to include completed and failed tasks.

  * `sparecrow queue add` --template <name> --target <path> [--priority <n>] [--timeout <min>]:
    Add a template task to the queue for background execution.

  * `sparecrow queue add` --prompt <text> --target <path> [--priority <n>] [--timeout <min>]:
    Add a custom prompt task to the queue.

  * `sparecrow queue remove` <position> [--yes]:
    Remove a task from the queue by position.

  * `sparecrow queue clear` [--yes]:
    Remove all pending tasks from the queue.

  * `sparecrow queue pause`:
    Pause task dispatch (daemon keeps polling but skips execution).

  * `sparecrow queue resume`:
    Resume task dispatch.

### Daemon Management

  * `sparecrow daemon start`:
    Start the background daemon process.

  * `sparecrow daemon stop`:
    Stop the running daemon.

  * `sparecrow daemon restart`:
    Restart the daemon (stop then start).

  * `sparecrow daemon status`:
    Show daemon process status and last activity.

  * `sparecrow daemon install` [--yes]:
    Install the daemon as a system service (systemd on Linux, launchd on macOS).

  * `sparecrow daemon uninstall`:
    Remove the system service.

### Configuration

  * `sparecrow config show`:
    Display the active configuration.

  * `sparecrow config validate`:
    Check the configuration file for errors.

  * `sparecrow config edit`:
    Open the configuration file in your default editor.

  * `sparecrow config set` <key> <value>:
    Set a configuration value.

  * `sparecrow config` --reconnect:
    Re-authenticate with Claude Code.

### Monitoring & Reporting

  * `sparecrow logs` [--count <n>] [--since <duration>] [--failures] [--output <id>]:
    Display audit log entries. Use `--failures` to show only failed tasks. Use `--output <id>` to view task output.

  * `sparecrow report`:
    Show a summary of recent task execution and usage statistics.

  * `sparecrow results` [--latest]:
    Display output artifacts from completed tasks. Use `--latest` to show only the most recent.

  * `sparecrow stats` [--period <days>]:
    Show personal usage analytics and task execution statistics.

  * `sparecrow why`:
    Explain why the daemon is or is not dispatching tasks right now.

### Troubleshooting

  * `sparecrow doctor`:
    Run a full diagnostic check covering auth, config, daemon, and connectivity.

  * `sparecrow report-crash` [file]:
    Submit a structured crash report for debugging.

### Other Commands

  * `sparecrow templates`:
    List available built-in and custom task templates.

  * `sparecrow examples` [category]:
    Show usage examples and common workflows.

  * `sparecrow completions` <shell>:
    Output or install shell completion scripts (bash, zsh, fish).

  * `sparecrow container status`:
    Show container runtime status and configuration.

  * `sparecrow task` <id>:
    Show detailed information about a specific task.

  * `sparecrow refresh`:
    Force an immediate usage data refresh.

  * `sparecrow man`:
    Display this manual page directly in the terminal.

## CONFIGURATION

Configuration is stored in YAML format. The default location depends on the platform:

  * **Linux**: `~/.config/sparecrow/config.yaml`
  * **macOS**: `~/Library/Application Support/sparecrow/config.yaml`

Key configuration fields (snake_case in YAML):

  * `polling_interval`:
    Seconds between usage checks (default: 300).

  * `task_timeout_minutes`:
    Maximum task execution time in minutes (default: 60).

  * `trigger.threshold_percent`:
    Usage percentage above which tasks are dispatched.

  * `trigger.reserve_percent`:
    Capacity to hold in reserve (not consumed by tasks).

  * `provider.name`:
    Usage data provider (default: `claude-code`).

  * `execution_backend`:
    Task execution backend: `container` (default) or `direct`.

  * `idle_hours`:
    Schedule when the daemon should be active (array of time windows with timezone).

  * `telemetry.enabled`:
    Whether to send anonymous usage telemetry (default: false).

## FILES

  * `~/.config/sparecrow/config.yaml` (Linux):
    Configuration file.

  * `~/.local/state/sparecrow/daemon.pid`:
    Daemon PID file.

  * `~/.local/state/sparecrow/daemon-status.json`:
    Last known daemon state.

  * `~/.local/state/sparecrow/queue.json`:
    Persisted task queue.

  * `~/.local/state/sparecrow/last-summary.json`:
    Most recent execution summary.

  * `~/.local/state/sparecrow/logs/audit-YYYY-MM-DD.jsonl`:
    Daily-rotated audit logs (30-day default retention).

## ENVIRONMENT

  * `SPARECROW_CONFIG_PATH`:
    Override the default config file path (equivalent to `--config`).

  * `NO_COLOR`:
    Disable colored output when set to any value.

## EXIT CODES

  * `0`:
    Success.

  * `1`:
    General error.

  * `2`:
    Daemon not running (for commands that require the daemon).

  * `3`:
    Authentication or configuration error.

## EXAMPLES

Run a quick security audit on a repository:

    $ sparecrow quickstart /path/to/repo

Set up sparecrow interactively:

    $ sparecrow onboard

Queue a code review task:

    $ sparecrow queue add --template code-review --target /path/to/repo

Check why the daemon is idle:

    $ sparecrow why

View failed task logs:

    $ sparecrow logs --failures

Get machine-readable status:

    $ sparecrow status --json

## SEE ALSO

  * Project repository: <https://github.com/alokn/sparecrow>
  * Claude Code: <https://claude.ai/download>
  * Issue tracker: <https://github.com/alokn/sparecrow/issues>

## AUTHORS

Alok <https://github.com/alokn>
