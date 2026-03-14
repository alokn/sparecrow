#!/usr/bin/env bash
# Container-side E2E test script for sparecrow.
# Exercises the full lifecycle: configure → queue → daemon → dispatch → verify → teardown.
# Uses checkpoint-based assertions; exits non-zero on first failure.
#
# Stderr is redirected to $LOG_FILE throughout — sparecrow emits structured INFO logs to
# stderr even in --json mode, and mixing them into stdout would break jq parsing.
set -uo pipefail

LOG_FILE="/tmp/sparecrow-e2e-test.log"
PASS_COUNT=0
FAIL_COUNT=0

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

banner() {
  echo "" | tee -a "$LOG_FILE"
  echo "======================================================================" | tee -a "$LOG_FILE"
  echo "  $1" | tee -a "$LOG_FILE"
  echo "======================================================================" | tee -a "$LOG_FILE"
  echo "" | tee -a "$LOG_FILE"
}

# assert_ok: run CMD (stdout → parse, stderr → log).  Assert JSON .ok == true.
assert_ok() {
  local desc="$1"
  local cmd="$2"
  local output
  output=$(eval "$cmd" 2>>"$LOG_FILE")
  echo "$output" >>"$LOG_FILE"
  local ok
  ok=$(echo "$output" | jq -r '.ok' 2>/dev/null || echo "false")
  if [ "$ok" = "true" ]; then
    echo "[PASS] $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $desc"
    echo "       Command: $cmd"
    echo "       Output:  $output"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    exit 1
  fi
}

# assert_field: run CMD, extract JQ_FILTER from stdout JSON, compare to EXPECTED.
assert_field() {
  local desc="$1"
  local cmd="$2"
  local filter="$3"
  local expected="$4"
  local output
  output=$(eval "$cmd" 2>>"$LOG_FILE")
  echo "$output" >>"$LOG_FILE"
  local actual
  actual=$(echo "$output" | jq -r "$filter" 2>/dev/null || echo "null")
  if [ "$actual" = "$expected" ]; then
    echo "[PASS] $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $desc (expected: $expected, got: $actual)"
    echo "       Command: $cmd"
    echo "       Output:  $output"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    exit 1
  fi
}

# assert_eq: string comparison.  Exit 1 on mismatch.
assert_eq() {
  local desc="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "[PASS] $desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $desc (expected: $expected, got: $actual)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    exit 1
  fi
}

# wait_for: poll CMD every 5s until it exits 0 or timeout elapses.
wait_for() {
  local desc="$1"
  local cmd="$2"
  local timeout_seconds="$3"
  local elapsed=0
  printf "[WAIT] %s " "$desc" | tee -a "$LOG_FILE"
  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    if eval "$cmd" >>"$LOG_FILE" 2>&1; then
      echo " [DONE]" | tee -a "$LOG_FILE"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    printf "." | tee -a "$LOG_FILE"
  done
  echo " [TIMEOUT after ${timeout_seconds}s]" | tee -a "$LOG_FILE"
  return 1
}

# ---------------------------------------------------------------------------
# Resolve state/config dirs from sparecrow config path
# ---------------------------------------------------------------------------

PATHS_JSON=$(sparecrow config path --json 2>>"$LOG_FILE")
echo "$PATHS_JSON" >>"$LOG_FILE"
STATE_DIR=$(echo "$PATHS_JSON" | jq -r '.data.dataPath')
CONFIG_FILE=$(echo "$PATHS_JSON" | jq -r '.data.configPath')
CONFIG_DIR=$(dirname "$CONFIG_FILE")

echo "[INFO] STATE_DIR:   $STATE_DIR"
echo "[INFO] CONFIG_FILE: $CONFIG_FILE"
echo "[INFO] LOG_FILE:    $LOG_FILE"
echo ""

# ===========================================================================
# Phase 1: Environment Verification
# ===========================================================================
banner "Phase 1: Environment Verification"

# Confirm binary works
if sparecrow --version >>"$LOG_FILE" 2>&1; then
  echo "[PASS] sparecrow binary accessible"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[FAIL] sparecrow binary not accessible"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

# Confirm Docker socket forwarding works
if docker info >>"$LOG_FILE" 2>&1; then
  echo "[PASS] Docker socket accessible"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[FAIL] Docker socket not accessible — check /var/run/docker.sock mount"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

# Verify Claude OAuth credentials before wasting time on a Docker build.
# Use CLAUDE_REAL_PATH directly — 'claude' is not in container PATH (the binary
# is mounted from the host at its real path, e.g. ~/.local/share/claude/versions/2.1.63).
if [ -z "${CLAUDE_REAL_PATH:-}" ]; then
  echo "[FAIL] CLAUDE_REAL_PATH env var not set — check run.sh and docker-compose.yaml"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi
if "$CLAUDE_REAL_PATH" auth status >>"$LOG_FILE" 2>&1; then
  echo "[PASS] Claude OAuth credentials valid"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[FAIL] Claude OAuth credentials invalid or expired — fix auth before running E2E"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

# sparecrow doctor — warn on non-critical findings (don't fail)
DOCTOR_OUTPUT=$(sparecrow doctor --json 2>>"$LOG_FILE" || true)
echo "$DOCTOR_OUTPUT" >>"$LOG_FILE"
DOCTOR_OK=$(echo "$DOCTOR_OUTPUT" | jq -r '.ok' 2>/dev/null || echo "false")
if [ "$DOCTOR_OK" = "true" ]; then
  echo "[PASS] sparecrow doctor passed"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[WARN] sparecrow doctor reported non-critical findings (continuing)"
fi

# Container runtime check — assert .data.passed == true (not just .ok == true)
assert_field "container runtime accessible (.data.passed)" \
  "sparecrow container test --json" \
  ".data.passed" \
  "true"

# Confirm test repo is a git repo
if git -C "$TEST_REPO_PATH" rev-parse --git-dir >>"$LOG_FILE" 2>&1; then
  echo "[PASS] TEST_REPO_PATH is a valid git repo ($TEST_REPO_PATH)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[FAIL] TEST_REPO_PATH is not a git repo: $TEST_REPO_PATH"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

# ===========================================================================
# Phase 2: Configuration
# ===========================================================================
banner "Phase 2: Configuration"

# Log paths for debugging
echo "[INFO] Config paths: $(echo "$PATHS_JSON" | jq -c '.data')"

# Write a complete config.yaml fixture directly — required because
# provider.execution_backend and provider.allow_dangerously_skip_permissions
# are not in SETTABLE_CONFIG_KEYS and cannot be set via 'config set'.
mkdir -p "$CONFIG_DIR"
# Note: heredoc without quotes so $CLAUDE_REAL_PATH is expanded.
cat >"$CONFIG_FILE" <<YAML
polling_interval: 60
provider:
  claude_path: ${CLAUDE_REAL_PATH}
  execution_backend: container
  allow_dangerously_skip_permissions: true
  container:
    runtime: docker
    image: node:lts-slim
    mount_claude_config: true
    fallback: none
trigger:
  threshold_percentage: 99
  require_reset_window: false
YAML

echo "[INFO] Wrote config fixture to $CONFIG_FILE"
cat "$CONFIG_FILE" >>"$LOG_FILE"

assert_ok "config validate" "sparecrow config validate --json"

# ===========================================================================
# Phase 3: Queue Management
# ===========================================================================
banner "Phase 3: Queue Management"

assert_ok "templates list" "sparecrow templates --json"

assert_ok "queue add (code-review template)" \
  "sparecrow queue add --template code-review --target \"$TEST_REPO_PATH\" --json"

QUEUE_OUTPUT=$(sparecrow queue list --json 2>>"$LOG_FILE")
echo "$QUEUE_OUTPUT" >>"$LOG_FILE"
QUEUE_COUNT=$(echo "$QUEUE_OUTPUT" | jq '.data.tasks | length' 2>/dev/null || echo "0")
assert_eq "queue has 1 item after first add" "$QUEUE_COUNT" "1"

assert_ok "queue add (custom prompt)" \
  "sparecrow queue add --prompt 'Add a brief comment to the top of index.js' --target \"$TEST_REPO_PATH\" --json"

QUEUE_OUTPUT=$(sparecrow queue list --json 2>>"$LOG_FILE")
echo "$QUEUE_OUTPUT" >>"$LOG_FILE"
QUEUE_COUNT=$(echo "$QUEUE_OUTPUT" | jq '.data.tasks | length' 2>/dev/null || echo "0")
assert_eq "queue has 2 items after second add" "$QUEUE_COUNT" "2"

# ===========================================================================
# Phase 4: Daemon Lifecycle
# ===========================================================================
banner "Phase 4: Daemon Lifecycle"

assert_ok "daemon start" "sparecrow daemon start --json"
assert_field "daemon state is running" "sparecrow daemon status --json" ".data.state" "running"

# Poll the raw daemon-status.json file directly (NOT 'daemon status --json' which returns
# DaemonStatusInfo without cycleResult).  Wait up to 600s for dispatch to complete.
# The test mounts a fake ~/.claude/projects/ with ~0% utilization so the trigger fires
# on the first poll cycle.  The 600s budget covers: container image pull + Claude execution.
echo ""
DISPATCH_WAIT_MSG="[WAIT] Waiting for dispatch cycle to complete in $STATE_DIR/daemon-status.json (up to 600s)"
echo "$DISPATCH_WAIT_MSG" | tee -a "$LOG_FILE"
printf " "
DISPATCH_TIMEOUT=600
DISPATCH_ELAPSED=0
DISPATCHED=false

while [ "$DISPATCH_ELAPSED" -lt "$DISPATCH_TIMEOUT" ]; do
  if [ -f "$STATE_DIR/daemon-status.json" ]; then
    CYCLE_RESULT=$(jq -r '.cycleResult' "$STATE_DIR/daemon-status.json" 2>/dev/null || echo "null")
    if [ "$CYCLE_RESULT" != "null" ] && [ -n "$CYCLE_RESULT" ]; then
      DISPATCHED=true
      DOT_MSG=" [DONE after ${DISPATCH_ELAPSED}s]"
      printf "%s\n" "$DOT_MSG" | tee -a "$LOG_FILE"
      break
    fi
    CURRENT_STATE=$(jq -r '.state' "$STATE_DIR/daemon-status.json" 2>/dev/null || echo "unknown")
    ACTIVE_TASK=$(jq -r '.activeTask.taskName // ""' "$STATE_DIR/daemon-status.json" 2>/dev/null || echo "")
    if [ -n "$ACTIVE_TASK" ]; then
      DOT=".(running:${ACTIVE_TASK})"
    else
      DOT=".(${CURRENT_STATE})"
    fi
  else
    DOT=".(no-status)"
  fi
  printf "%s" "$DOT"
  echo "$DOT" >>"$LOG_FILE"
  sleep 10
  DISPATCH_ELAPSED=$((DISPATCH_ELAPSED + 10))
done

if [ "$DISPATCHED" = "false" ]; then
  echo " [TIMEOUT after ${DISPATCH_TIMEOUT}s]"
  echo "[FAIL] Daemon did not complete a dispatch cycle within ${DISPATCH_TIMEOUT}s"
  echo "  daemon-status.json contents:"
  jq '.' "$STATE_DIR/daemon-status.json" 2>/dev/null || cat "$STATE_DIR/daemon-status.json" 2>/dev/null || echo "  (file not found)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

TASKS_ATTEMPTED=$(jq -r '.cycleResult.tasksAttempted // 0' "$STATE_DIR/daemon-status.json" 2>/dev/null || echo "0")
echo "[PASS] Dispatch cycle completed (tasksAttempted: $TASKS_ATTEMPTED)"
PASS_COUNT=$((PASS_COUNT + 1))

# ===========================================================================
# Phase 5: Verify Results
# ===========================================================================
banner "Phase 5: Verify Results"

QUEUE_OUTPUT=$(sparecrow queue list --json 2>>"$LOG_FILE")
echo "$QUEUE_OUTPUT" >>"$LOG_FILE"
COMPLETED=$(echo "$QUEUE_OUTPUT" | jq '[.data.tasks[] | select(.status == "done" or .status == "failed" or .status == "failed_quota" or .status == "skipped")] | length' 2>/dev/null || echo "0")
if [ "$COMPLETED" -ge 1 ]; then
  echo "[PASS] At least one task reached terminal state (count: $COMPLETED)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[FAIL] No tasks reached a terminal state after dispatch"
  echo "$QUEUE_OUTPUT" | jq '.data.tasks' 2>/dev/null || true
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

# sparecrow logs returns TASK_COMPLETED/TASK_FAILED/DISPATCH_QUOTA_EXHAUSTED events.
LOGS_OUTPUT=$(sparecrow logs --json 2>>"$LOG_FILE")
echo "$LOGS_OUTPUT" >>"$LOG_FILE"
LOG_COUNT=$(echo "$LOGS_OUTPUT" | jq '.data.entries | length' 2>/dev/null || echo "0")
if [ "$LOG_COUNT" -ge 1 ]; then
  echo "[PASS] At least one task audit log entry exists (count: $LOG_COUNT)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "[FAIL] No task audit log entries found after dispatch"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  exit 1
fi

# Log failures for debugging (non-fatal)
FAILURES_OUTPUT=$(sparecrow logs --failures --json 2>>"$LOG_FILE" || true)
echo "$FAILURES_OUTPUT" >>"$LOG_FILE"
FAILURE_COUNT=$(echo "$FAILURES_OUTPUT" | jq '.data.entries | length' 2>/dev/null || echo "0")
if [ "$FAILURE_COUNT" -gt 0 ]; then
  echo "[INFO] Task failures logged ($FAILURE_COUNT entries):"
  echo "$FAILURES_OUTPUT" | jq '.data.entries' 2>/dev/null || true
fi

TASK_ID=$(echo "$LOGS_OUTPUT" | jq -r '[.data.entries[] | select(.taskId != null)] | first | .taskId // empty' 2>/dev/null || echo "")
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "null" ]; then
  if sparecrow logs --output "$TASK_ID" >>"$LOG_FILE" 2>&1; then
    echo "[PASS] Task output captured for task $TASK_ID"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[WARN] Could not retrieve task output for $TASK_ID (non-fatal)"
  fi
else
  echo "[WARN] No task ID found in log entries — skipping output file check (non-fatal)"
fi

assert_ok "sparecrow status" "sparecrow status --json"

# Report (may say 'insufficient data' — that is ok)
REPORT_OUTPUT=$(sparecrow report --json 2>>"$LOG_FILE" || true)
echo "$REPORT_OUTPUT" >>"$LOG_FILE"
echo "[INFO] report response: $(echo "$REPORT_OUTPUT" | jq -c '.data' 2>/dev/null || echo "$REPORT_OUTPUT")"

# ===========================================================================
# Phase 6: Teardown and Additional CLI Commands
# ===========================================================================
banner "Phase 6: Teardown"

assert_ok "daemon stop" "sparecrow daemon stop --json"
assert_field "daemon state is stopped" "sparecrow daemon status --json" ".data.state" "stopped"
assert_ok "container cleanup" "sparecrow container cleanup --yes --json"
assert_ok "queue clear" "sparecrow queue clear --yes --json"

QUEUE_OUTPUT=$(sparecrow queue list --json 2>>"$LOG_FILE")
echo "$QUEUE_OUTPUT" >>"$LOG_FILE"
QUEUE_COUNT=$(echo "$QUEUE_OUTPUT" | jq '.data.tasks | length' 2>/dev/null || echo "0")
assert_eq "queue is empty after clear" "$QUEUE_COUNT" "0"

# ===========================================================================
# Summary
# ===========================================================================
banner "Test Summary"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "  Passed: $PASS_COUNT / $TOTAL"
echo "  Failed: $FAIL_COUNT / $TOTAL"
echo ""
echo "  Full log: $LOG_FILE"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "TESTS FAILED"
  exit 1
fi
