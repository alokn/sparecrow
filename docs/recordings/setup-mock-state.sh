#!/usr/bin/env bash
# Setup mock state for VHS recordings.
# Creates realistic-looking daemon status, queue, and audit log entries
# so that sparecrow commands produce representative output for recordings.
#
# Usage: ./setup-mock-state.sh [state-dir]
#   state-dir: Override state directory (default: platform-appropriate path)
#
# This script is idempotent -- safe to run multiple times.

set -euo pipefail

# Resolve state directory and config directory
if [[ -n "${1:-}" ]]; then
  STATE_DIR="$1"
  CONFIG_DIR="$1"
elif [[ "$(uname)" == "Darwin" ]]; then
  STATE_DIR="$HOME/Library/Application Support/sparecrow"
  CONFIG_DIR="$HOME/Library/Application Support/sparecrow"
else
  STATE_DIR="$HOME/.local/state/sparecrow"
  CONFIG_DIR="$HOME/.config/sparecrow"
fi

# Derive today's date for timestamps so mock data stays within default time windows
TODAY=$(date +%Y-%m-%d)

echo "Setting up mock state in: $STATE_DIR"
echo "Setting up mock config in: $CONFIG_DIR"
mkdir -p "$STATE_DIR/logs" "$CONFIG_DIR"

# Mock config.yaml — required by status, why, queue list, and other commands
# that call loadConfig(); without it, commands exit with CONFIG_NOT_FOUND.
if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
  cat > "$CONFIG_DIR/config.yaml" << 'CONFIG_EOF'
# sparecrow mock config for VHS recordings
polling_interval: 300
log_retention_days: 30
task_timeout_minutes: 60
last_summary_enabled: false

provider:
  name: claude-code
  execution_backend: container
  allow_dangerously_skip_permissions: false

trigger:
  max_waste_percentage: 50
  weekly_reserve_percentage: 30
  idle_hours:
    - start: "22:00"
      end: "06:00"
CONFIG_EOF
  echo "  - config.yaml created (mock settings)"
else
  echo "  - config.yaml already exists (skipped)"
fi

# Mock daemon-status.json — timestamps use today's date
cat > "$STATE_DIR/daemon-status.json" << DAEMON_EOF
{
  "pid": 12345,
  "status": "running",
  "startedAt": "${TODAY}T00:45:00.000Z",
  "lastPollAt": "${TODAY}T02:55:48.000Z",
  "nextPollAt": "${TODAY}T03:00:48.000Z",
  "pollingInterval": 300,
  "cycleCount": 53,
  "activeTask": null,
  "lastDispatch": {
    "taskId": "improve-code-1710644400",
    "startedAt": "${TODAY}T02:51:15.000Z",
    "completedAt": "${TODAY}T03:00:00.000Z",
    "outcome": "success"
  }
}
DAEMON_EOF

# Mock queue.json with 2 pending tasks
cat > "$STATE_DIR/queue.json" << QUEUE_EOF
{
  "version": 1,
  "tasks": [
    {
      "id": "security-audit-1710648000",
      "name": "security-audit",
      "templateKey": "security-audit",
      "prompt": "Scan this repository for security vulnerabilities, hardcoded secrets, and dependency issues.",
      "targetPath": "/home/user/my-project",
      "priority": 1,
      "status": "pending",
      "createdAt": "${TODAY}T03:05:00.000Z",
      "timeoutMinutes": 60
    },
    {
      "id": "fix-bugs-1710648060",
      "name": "fix-bugs",
      "templateKey": "fix-bugs",
      "prompt": "Search for bugs, edge cases, and logic flaws in this codebase.",
      "targetPath": "/home/user/api",
      "priority": 2,
      "status": "pending",
      "createdAt": "${TODAY}T03:06:00.000Z",
      "timeoutMinutes": 60
    }
  ],
  "paused": false
}
QUEUE_EOF

# Mock audit log for today
AUDIT_FILE="$STATE_DIR/logs/audit-${TODAY}.jsonl"

# Timestamps use today's date so sparecrow logs --failures finds entries within
# the default --since window regardless of when this script is run.
cat > "$AUDIT_FILE" << AUDIT_EOF
{"ts":"${TODAY}T01:30:00.000Z","level":"info","event":"dispatch:complete","data":{"taskId":"write-tests-1710637800","name":"write-tests","outcome":"success","durationMs":920000,"targetPath":"/home/user/api"},"provider":"claude-code","source":"daemon","confidence":"high","error":null}
{"ts":"${TODAY}T02:15:00.000Z","level":"error","event":"dispatch:complete","data":{"taskId":"security-audit-1710640500","name":"security-audit","outcome":"failed","durationMs":754000,"targetPath":"/home/user/my-project","error":"Container exited with code 1: OOM killed (memory limit 512MB)"},"provider":"claude-code","source":"daemon","confidence":"high","error":{"code":"EXECUTION_FAILED","message":"Container exited with code 1: OOM killed (memory limit 512MB)"}}
{"ts":"${TODAY}T02:45:00.000Z","level":"info","event":"dispatch:complete","data":{"taskId":"security-audit-1710642300","name":"security-audit","outcome":"success","durationMs":372000,"targetPath":"/home/user/my-project"},"provider":"claude-code","source":"daemon","confidence":"high","error":null}
{"ts":"${TODAY}T03:00:00.000Z","level":"info","event":"dispatch:complete","data":{"taskId":"improve-code-1710644400","name":"improve-code","outcome":"success","durationMs":525000,"targetPath":"/home/user/my-project"},"provider":"claude-code","source":"daemon","confidence":"high","error":null}
AUDIT_EOF

# Create .scrow/ result artifact directories used by `sparecrow results`
# These simulate completed task outputs that the results.tape recording will list.
MY_PROJECT_SCROW="$HOME/my-project/.scrow"
API_SCROW="$HOME/api/.scrow"
mkdir -p "$MY_PROJECT_SCROW" "$API_SCROW"

cat > "$MY_PROJECT_SCROW/security-audit-${TODAY}T02-45-00.md" << 'RESULT_EOF'
# Security Audit Results

**Task:** security-audit
**Repository:** /home/user/my-project
**Completed:** 2026-03-17T02:45:00.000Z
**Duration:** 6m 12s

## Summary

Scanned 142 files. Found 0 critical issues, 2 warnings.

### Warnings

- `src/config/loader.ts:45` — consider validating environment variable `API_KEY` before use
- `package.json` — 1 dependency with known low-severity CVE (no fix available)

No secrets or hardcoded credentials detected.
RESULT_EOF

cat > "$MY_PROJECT_SCROW/improve-code-${TODAY}T03-00-00.md" << 'RESULT_EOF'
# Code Improvement Results

**Task:** improve-code
**Repository:** /home/user/my-project
**Completed:** 2026-03-17T03:00:00.000Z
**Duration:** 8m 45s

## Summary

Reviewed 38 files. Applied 3 improvements.

### Changes Made

- Extracted repeated error-handling logic into shared utility
- Added JSDoc to 12 public API functions
- Simplified conditional chain in `src/trigger/trigger-engine.ts`
RESULT_EOF

cat > "$API_SCROW/write-tests-${TODAY}T01-30-00.md" << 'RESULT_EOF'
# Test Generation Results

**Task:** write-tests
**Repository:** /home/user/api
**Completed:** 2026-03-17T01:30:00.000Z
**Duration:** 15m 20s

## Summary

Added 24 unit tests across 6 modules. Coverage increased from 61% to 78%.

### Tests Added

- `src/auth/auth.test.ts` — 8 tests
- `src/routes/users.test.ts` — 7 tests
- `src/middleware/validate.test.ts` — 9 tests
RESULT_EOF

cat > "$API_SCROW/fix-bugs-${TODAY}T22-00-00.md" << 'RESULT_EOF'
# Bug Fix Results

**Task:** fix-bugs
**Repository:** /home/user/api
**Completed:** 2026-03-16T22:00:00.000Z
**Duration:** 11m 03s

## Summary

Found and fixed 3 bugs.

### Fixes Applied

- `src/routes/users.ts:87` — null-deref when user has no profile
- `src/auth/session.ts:34` — session token not invalidated on logout
- `src/db/connection.ts:12` — connection pool not released on error
RESULT_EOF

echo "Mock state created:"
echo "  - daemon-status.json (running, PID 12345)"
echo "  - queue.json (2 pending tasks)"
echo "  - audit log ($AUDIT_FILE, 4 entries)"
echo "  - $MY_PROJECT_SCROW/ (2 result artifacts)"
echo "  - $API_SCROW/ (2 result artifacts)"
echo ""
echo "Ready for VHS recording. Run:"
echo "  ./regenerate.sh"
