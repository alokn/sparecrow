# SpareCrow - Make It Count

[![CI](https://github.com/alokn/sparecrow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alokn/sparecrow/actions/workflows/ci.yml)

<p align="center">
  <img src="assets/sparecrow_logo.PNG" alt="SpareCrow logo" width="500">
</p>

> **Public Beta** -- sparecrow 1.0.0-beta.1 is the first public release. Install with `npm install -g sparecrow@beta`. Report issues at [github.com/alokn/sparecrow/issues](https://github.com/alokn/sparecrow/issues).

`sparecrow` is a CLI tool and background daemon that monitors your Claude Code subscription usage and automatically dispatches queued tasks against your repositories when spare capacity is detected. Stop leaving your Claude Pro/Team quota on the table -- put it to work.

## How It Works

1. **Authenticate** -- `sparecrow` reads your existing Claude Code OAuth token (no extra credentials needed).
2. **Poll** -- A background daemon polls Claude's usage metrics on a configurable interval.
3. **Evaluate** -- The capacity intelligence engine calculates waste potential across your subscription models, checks whether you are inside a configured idle-hours window, and ensures the weekly reserve percentage is respected.
4. **Dispatch** -- When conditions are met, the daemon picks the next task from your queue and runs `claude` inside a Docker/Podman container against the target repository.
5. **Post-process** -- Active templates emit structured action requests (branch creation, git push, PR creation) that sparecrow executes on the host after the container task completes.
6. **Record** -- Results are written to a `.scrow/` directory inside the target repository, logged to a daily-rotated audit log, and available via `sparecrow report` and `sparecrow results`.

---

## Requirements

- **Node.js >= 22** -- [nodejs.org](https://nodejs.org/)
- **Claude Code** -- must be installed and authenticated (`claude login` should have been run at least once)
- **Docker or Podman** -- required for container-isolated task execution (the default and only supported execution mode)

> **Note:** `execution_backend: direct` is no longer supported and will cause `sparecrow config validate` to fail. If you have a stale config using `direct`, run `sparecrow onboard` to reconfigure.

---

## Installation

```bash
npm install -g sparecrow@beta
```

Verify:

```bash
sparecrow --version
```

Then run the interactive setup wizard:

```bash
sparecrow onboard
```

The wizard walks you through:
1. Detecting your `claude` binary and validating your auth token
2. Configuring idle hours (time windows when dispatch is preferred)
3. Choosing an aggressiveness preset (conservative / balanced / aggressive)
4. Optionally setting up container runtime (Docker/Podman detection and configuration)
5. Registering a target repository
6. Optionally installing and starting the background daemon as a system service

---

## Quick Start

```bash
# Install
npm install -g sparecrow@beta

# Run the interactive setup wizard
sparecrow onboard

# Add a task to the queue
sparecrow queue add --template fix-bugs --target /path/to/repo

# Start the daemon
sparecrow daemon start

# Check status
sparecrow status

# View execution history
sparecrow logs

# View result artifacts
sparecrow results
```

---

## Commands

All commands also work with the `scrow` short alias (e.g., `scrow status`).

### Global flags

These flags work with all commands:

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output |
| `--quiet` | Suppress non-essential output |
| `--config <path>` | Override the default config file location |
| `--version` | Show version number |
| `--help` | Show command help |

### Onboarding

| Command | Description |
|---------|-------------|
| `sparecrow onboard` | Interactive setup wizard (alias: `sparecrow init`) |

The wizard walks you through Claude Code detection, authentication, idle hours configuration, aggressiveness preset selection, container runtime setup, repository targeting, and optional daemon installation. Automatically rolls back on failure.

### Status & Monitoring

| Command | Description |
|---------|-------------|
| `sparecrow status` | Show daemon health, usage level, queue depth, and recent activity |
| `sparecrow doctor` | Run diagnostic health checks |
| `sparecrow report` | Show the most recent execution summary (utilization, ROI, tasks completed) |
| `sparecrow refresh` | Force re-fetch usage data, re-evaluate triggers, and run a dispatch cycle |
| `sparecrow why` | Explain step-by-step why the queue is or is not dispatching (waste potential, idle hours, reserve) |

`sparecrow status --all` expands all cards to full detail.
`sparecrow doctor --verbose` shows per-check timing and failure details.

### Daemon Management

| Command | Description |
|---------|-------------|
| `sparecrow daemon start` | Start the background daemon |
| `sparecrow daemon stop` | Stop the daemon (graceful SIGTERM, forced SIGKILL after timeout) |
| `sparecrow daemon restart` | Restart the daemon (or start if not running) |
| `sparecrow daemon reload` | Reload config without restarting |
| `sparecrow daemon status` | Show daemon process state and active task |
| `sparecrow daemon install` | Install as a system service (systemd on Linux, launchd on macOS) |
| `sparecrow daemon uninstall` | Uninstall the system service |

`sparecrow daemon start --dry-run` previews the effective config without starting.
`sparecrow daemon install --yes` skips overwrite confirmation.

### Task Queue

| Command | Description |
|---------|-------------|
| `sparecrow queue list` | List queued tasks (alias: `sparecrow queue ls`); use `--include-history` to include completed/failed/skipped tasks |
| `sparecrow queue add` | Add a task to the queue |
| `sparecrow queue remove <position>` | Remove a task by position (`--yes` required in non-interactive mode) |
| `sparecrow queue clear` | Clear all tasks (`--yes` required in non-interactive mode) |
| `sparecrow queue reorder move <from> <to>` | Move a task from one position to another |
| `sparecrow queue pause` | Pause task dispatch without stopping the daemon |
| `sparecrow queue resume` | Resume task dispatch |
| `sparecrow queue history` | View completed task history (done/failed/skipped tasks) |

#### Adding tasks

```bash
# Using a built-in template
sparecrow queue add --template security-audit --target /path/to/repo

# Using a custom prompt
sparecrow queue add --prompt "Review error handling" --target /path/to/repo

# With a custom timeout (minutes, 0 = no timeout)
sparecrow queue add --template fix-bugs --target /path/to/repo --timeout 60

# Preview without modifying the queue
sparecrow queue add --template write-tests --target /path/to/repo --dry-run
```

Exactly one of `--template` or `--prompt` is required. `--target` must point to a valid git repository.

**Timeout precedence:** CLI `--timeout` flag > template `timeout_minutes` > config `task_timeout_minutes` > default (60 min).

### Task Monitoring

| Command | Description |
|---------|-------------|
| `sparecrow task tail [task-id]` | Stream live output of a running task (auto-detects active task if omitted) |

### Logs & History

| Command | Description |
|---------|-------------|
| `sparecrow logs` | View execution history from daily-rotated audit logs |

```bash
sparecrow logs                          # last 20 entries
sparecrow logs --count 50               # last 50 entries
sparecrow logs --since 7d               # entries from last 7 days
sparecrow logs --since 2026-02-23       # entries since a specific date
sparecrow logs --task my-task           # filter by task name
sparecrow logs --outcome failed         # filter by outcome (failed, success, retrying, quota)
sparecrow logs --failures               # shorthand for --outcome failed,retrying
sparecrow logs --verbose                # expanded detail per entry
sparecrow logs --task my-task --full    # full transcript without truncation
sparecrow logs --output <taskId>        # print full output for a specific task
```

### Results

| Command | Description |
|---------|-------------|
| `sparecrow results` | View `.scrow/` result artifacts across all repos |

```bash
sparecrow results                           # list all results
sparecrow results --repo /path/to/repo      # filter by repository
sparecrow results --template fix-bugs       # filter by template name
sparecrow results --latest                  # view the most recent result
sparecrow results --task <id>               # view result for a specific task
```

### Configuration

| Command | Description |
|---------|-------------|
| `sparecrow config` | Print resolved config as a table (or JSON with `--json`) |
| `sparecrow config get <key>` | Get a single config value (supports `snake_case` and `camelCase` keys) |
| `sparecrow config set <key> <value>` | Set a config value (validates before persisting) |
| `sparecrow config validate` | Validate config file against schema |
| `sparecrow config path` | Show config and state directory paths |
| `sparecrow config --reconnect` | Re-authenticate with Claude Code |

### Templates

| Command | Description |
|---------|-------------|
| `sparecrow templates` | List available built-in and custom prompt templates |

Four built-in templates are included:

| Template | Type | Description |
|----------|------|-------------|
| `security-audit` | passive | Scan repo for vulnerabilities and hardcoded secrets |
| `fix-bugs` | active | Search for bugs, edge cases, and logic flaws -- emits action requests |
| `improve-code` | active | Review for code quality, error handling, and improvements -- emits action requests |
| `write-tests` | active | Identify untested paths and generate candidate tests -- emits action requests |

Active templates (`fix-bugs`, `improve-code`, `write-tests`) produce structured action requests for post-execution operations such as branch creation, git push, and pull request creation. See [Action Request Protocol](#action-request-protocol) below.

Custom templates can be defined in your config file under the `tasks` key. Each entry requires three fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier for the task (used in queue and logs) |
| `prompt` | yes | The prompt text sent to Claude inside the container |
| `target_path` | yes | Absolute path to the target git repository |
| `timeout_minutes` | no | Per-task timeout override (0 = no limit) |

Example:
```yaml
tasks:
  - name: my-custom-task
    prompt: "Review this repo for security issues"
    target_path: /path/to/repo
    timeout_minutes: 60
```

### Container Execution

| Command | Description |
|---------|-------------|
| `sparecrow container test` | Validate container runtime end-to-end (Docker/Podman) |
| `sparecrow container cleanup` | Remove orphaned sparecrow-managed containers |

`sparecrow container test --verbose` shows container logs and detailed timing.
`sparecrow container cleanup --yes` skips confirmation.

Container execution is the default and only supported execution mode. Sparecrow auto-detects Docker or Podman, or you can specify `container.runtime: docker` or `container.runtime: podman` in your config.

> **Note:** `execution_backend: direct` is no longer supported. If your config still uses `direct`, run `sparecrow onboard` to reconfigure.

### Other

| Command | Description |
|---------|-------------|
| `sparecrow completions` | Print shell completion script (bash/zsh) |

---

## Configuration

Config is stored in the platform-appropriate location -- never hardcoded:

| Platform | Config file | State / logs |
|----------|-------------|--------------|
| Linux | `~/.config/sparecrow/config.yaml` | `~/.local/state/sparecrow/` |
| macOS | `~/Library/Application Support/sparecrow/config.yaml` | `~/Library/Application Support/sparecrow/` |

Run `sparecrow config path` to see the exact paths on your system.

### Config file reference

```yaml
polling_interval: 300                    # seconds between usage checks (60-3600, default: 300)
log_retention_days: 30                   # audit log retention (1-365, default: 30)
task_timeout_minutes: 60                 # per-task timeout (0 = no limit, default: 60)
last_summary_enabled: false              # persist summary after each dispatch

provider:
  name: claude-code
  claude_path: /path/to/claude           # optional: explicit path to claude binary
  allow_dangerously_skip_permissions: false
  execution_backend: container           # only 'container' is supported ('direct' is rejected)
  container:
    runtime: auto                        # 'auto', 'docker', or 'podman'
    image: node:lts-slim                 # container image
    memory_limit_mb: 512                 # memory limit (64-65536)
    cpu_limit: 1.0                       # CPU limit (0.1-128.0)
    network_mode: bridge                 # 'bridge', 'none', or 'host'
    mount_claude_config: true            # mount .claude dir for OAuth credentials
    mount_claude_binary: false           # mount claude binary from host
    claude_binary_path: /path/to/claude  # explicit path if mount_claude_binary: true

trigger:
  max_waste_percentage: 50               # 0-100, dispatch when waste potential exceeds this % (default: 50)
  weekly_reserve_percentage: 30          # 0-100, percentage of weekly quota to hold in reserve (default: 30)
  idle_hours:                            # time windows when dispatch is preferred
    - start: "22:00"                     # HH:MM format
      end: "06:00"
      days:                              # optional, defaults to all days
        - monday
        - tuesday
        - wednesday
        - thursday
        - friday

tasks:                                   # custom task templates
  - name: my-custom-task
    prompt: "Review this repo for..."
    target_path: /path/to/repo
    timeout_minutes: 60                  # optional per-task timeout
```

All keys use `snake_case` in YAML and are transformed to `camelCase` internally.

#### Trigger configuration

The `trigger` block controls when sparecrow dispatches tasks:

- **`max_waste_percentage`** (0-100, default: 50) -- Maximum acceptable waste potential before triggering dispatch. Lower values mean more aggressive usage of spare capacity.
- **`weekly_reserve_percentage`** (0-100, default: 30) -- Percentage of weekly quota to hold in reserve. Ensures you always have capacity for interactive use.
- **`idle_hours`** -- List of time windows when dispatch is preferred. Each entry has `start` (HH:MM), `end` (HH:MM), and an optional `days` array (full day names: `monday`, `tuesday`, etc.). If `days` is omitted, the window applies to all days.

The onboarding wizard offers three presets that configure these values:
| Preset | `max_waste_percentage` | `weekly_reserve_percentage` |
|--------|----------------------|---------------------------|
| conservative | 70 | 40 |
| balanced | 50 | 30 |
| aggressive | 30 | 15 |

### State directory contents

```
daemon.pid                        -- daemon PID (while running)
daemon-status.json                -- last known daemon state
queue.json                        -- persisted task queue
last-summary.json                 -- most recent execution summary
task-outputs/<task-id>.txt        -- per-task output files (subdirectory of state dir)
logs/audit-YYYY-MM-DD.jsonl       -- daily-rotated append-only audit log
```

> **Note:** `task-outputs/` is a subdirectory of the state directory (e.g. `~/.local/state/sparecrow/task-outputs/` on Linux), not the logs directory.

---

## Action Request Protocol

Active templates (`fix-bugs`, `improve-code`, `write-tests`) produce structured action request blocks at the end of their output. These blocks request git operations such as:

- Creating a new branch
- Committing changes
- Pushing to a remote
- Opening a pull request

Sparecrow parses these action requests and executes them **on the host** after the container task completes. This means:

- `gh` CLI and git credentials are **not** needed inside the container
- Actions run with your host machine's credentials and tool access
- You can review pending actions before they execute

The `security-audit` template is passive (read-only) and does not emit action requests.

---

## Development

```bash
git clone https://github.com/alokn/sparecrow.git
cd sparecrow
npm install
```

### Run in development mode (no build step)

```bash
npm run dev -- status          # equivalent to: sparecrow status
npm run dev -- onboard
```

### Build

```bash
npm run build          # tsup -> dist/
```

### Tests

```bash
npm test               # unit tests + coverage report (>= 70% required)
npm run test:watch     # watch mode
npm run test:integration  # integration tests
npm run test:e2e       # end-to-end tests (requires Docker)
```

### Lint & format

```bash
npm run lint           # oxlint (fast Rust-based linter)
npm run format         # prettier --write src/
npm run format:check   # prettier --check (CI-safe)
npm run typecheck      # tsc --noEmit
```

---

## JSON Output

All commands support `--json` for machine-readable output. The envelope is consistent:

```json
{
  "ok": true,
  "data": { },
  "error": null
}
```

On error:

```json
{
  "ok": false,
  "data": null,
  "error": { "code": "ERROR_CODE", "message": "User-facing message" }
}
```

---

## Contributing

Contributions are welcome! Here's how to get involved:

### Reporting bugs

Open an issue at [github.com/alokn/sparecrow/issues](https://github.com/alokn/sparecrow/issues). Include:
- Your OS and Node.js version (`node --version`)
- Steps to reproduce
- Actual vs. expected behaviour
- Any relevant output from `sparecrow doctor --json`

### Submitting a pull request

1. Fork the repository and create a branch from `main`.
2. Follow the [module dependency DAG](#module-structure) -- lower modules never import from higher ones.
3. Match the existing conventions:
   - Files: `kebab-case.ts`
   - Functions/variables: `camelCase`; types: `PascalCase`; constants: `UPPER_SNAKE_CASE`
   - Every `.ts` file starts with a single-line JSDoc comment describing its purpose
   - ESM imports use the `.js` extension: `import { X } from './module.js'`
4. Write tests for your change. Each test must be fully isolated (`beforeEach`/`afterEach`, no shared mutable state). Coverage must remain >= 70%.
5. Run the full check suite before opening a PR:
   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test
   ```
6. Open a pull request against `main` with a clear description of what and why.

### Module structure

Import direction is strictly enforced (lower -> higher only):

```
types -> errors -> utils -> config -> templates -> platform -> providers -> trigger -> queue -> daemon -> cli/ui
```

If a type is needed by a lower module, move it to `src/types/`.

### Error handling

- Always throw `ScrowError` with a typed `ErrorCode` -- never `throw new Error(...)` or throw strings.
- Catch only at CLI command boundaries and the daemon top-level loop.
- Never log tokens, credentials, or secrets at any log level.

---

## License

[MIT](LICENSE)
