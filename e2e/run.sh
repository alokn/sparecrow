#!/usr/bin/env bash
# Host-side wrapper for the sparecrow E2E clean-room test suite.
# Resolves paths, creates an ephemeral test repo, and launches the Docker-based test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

echo ""
echo "======================================================================"
echo "  sparecrow E2E Test Runner"
echo "======================================================================"
echo ""

if ! command -v docker &>/dev/null; then
  echo "[ERROR] docker is not installed or not in PATH"
  exit 1
fi

DOCKER_SOCKET=/var/run/docker.sock
if [ ! -S "$DOCKER_SOCKET" ]; then
  echo "[ERROR] Docker socket not found at $DOCKER_SOCKET"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "[ERROR] claude binary not found in PATH — Claude Code must be installed"
  exit 1
fi

if ! command -v git &>/dev/null; then
  echo "[ERROR] git is not installed or not in PATH — required for test repo creation"
  exit 1
fi

if [ ! -d "$HOME/.claude" ]; then
  echo "[ERROR] ~/.claude directory not found — Claude Code credentials required"
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve host paths
# ---------------------------------------------------------------------------

HOST_HOME="$HOME"
HOST_UID=$(id -u)
HOST_GID=$(id -g)
CLAUDE_REAL_PATH=$(realpath "$(command -v claude)")
CLAUDE_INSTALL_DIR=$(dirname "$CLAUDE_REAL_PATH")
TEST_REPO_PATH="/tmp/sparecrow-e2e-repo-$$"
DOCKER_SOCKET_GID=$(stat -c '%g' "$DOCKER_SOCKET")
if ! echo "$DOCKER_SOCKET_GID" | grep -qE '^[0-9]+$'; then
  echo "[ERROR] Could not resolve Docker socket GID (got: '$DOCKER_SOCKET_GID') — check permissions on $DOCKER_SOCKET"
  exit 1
fi

# Fake Claude projects directory — mounted over ~/.claude/projects/ inside the test
# container to shadow the host's real usage logs.  The JSONL estimate source reads from
# this directory and sees minimal token usage (~1000 tokens vs 250k session cap = 0.4%
# utilization), guaranteeing the trigger fires regardless of the host's actual quota state.
# The task containers spawned BY sparecrow mount the real host ~/.claude/ directly via the
# Docker socket, so their Claude authentication is unaffected by this shadow.
FAKE_CLAUDE_PROJECTS_DIR="/tmp/sparecrow-e2e-claude-projects-$$"
mkdir -p "$FAKE_CLAUDE_PROJECTS_DIR/e2e-test"
# Write a minimal JSONL file with a tiny token count timestamped in the last 5 minutes.
# Needs >0 tokens so the source doesn't throw PROVIDER_UNREACHABLE; any small value works.
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
cat > "$FAKE_CLAUDE_PROJECTS_DIR/e2e-test/fake-session.jsonl" <<EOF
{"timestamp":"${NOW_ISO}","usage":{"input_tokens":500,"output_tokens":500,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}
EOF

echo "Resolved paths:"
echo "  HOST_HOME:          $HOST_HOME"
echo "  HOST_UID:GID:       $HOST_UID:$HOST_GID"
echo "  CLAUDE_REAL_PATH:   $CLAUDE_REAL_PATH"
echo "  CLAUDE_INSTALL_DIR: $CLAUDE_INSTALL_DIR"
echo "  TEST_REPO_PATH:     $TEST_REPO_PATH"
echo "  DOCKER_SOCKET:      $DOCKER_SOCKET (GID: $DOCKER_SOCKET_GID)"
echo "  FAKE_CLAUDE_PROJECTS_DIR: $FAKE_CLAUDE_PROJECTS_DIR"
echo ""

# ---------------------------------------------------------------------------
# Teardown trap — runs on EXIT (success, failure, or Ctrl+C)
# ---------------------------------------------------------------------------

cleanup() {
  echo ""
  echo "[TEARDOWN] Cleaning up..."

  docker compose -f "$SCRIPT_DIR/docker-compose.yaml" down -v 2>/dev/null || true

  if [ -d "$TEST_REPO_PATH" ]; then
    rm -rf "$TEST_REPO_PATH"
    echo "[TEARDOWN] Removed test repo: $TEST_REPO_PATH"
  fi

  if [ -d "$FAKE_CLAUDE_PROJECTS_DIR" ]; then
    rm -rf "$FAKE_CLAUDE_PROJECTS_DIR"
    echo "[TEARDOWN] Removed fake claude projects dir: $FAKE_CLAUDE_PROJECTS_DIR"
  fi

  ORPHANS=$(docker ps -aq --filter label=sparecrow.managed=true 2>/dev/null || true)
  if [ -n "$ORPHANS" ]; then
    echo "$ORPHANS" | xargs -r docker rm -f
    echo "[TEARDOWN] Removed orphaned sparecrow task containers"
  fi

  echo "[TEARDOWN] Done."
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Create ephemeral test repo on the host
# ---------------------------------------------------------------------------

echo "[SETUP] Creating ephemeral test repo at $TEST_REPO_PATH..."
mkdir -p "$TEST_REPO_PATH"
cd "$TEST_REPO_PATH"
git init
echo "# E2E Test Repo" >README.md
echo "const x = 1;" >index.js
git add -A
git -c user.email=e2e@test.local -c user.name=sparecrow-e2e commit -m "init"
cd - >/dev/null
echo "[SETUP] Test repo created."
echo ""

# ---------------------------------------------------------------------------
# Export env vars for docker-compose interpolation
# ---------------------------------------------------------------------------

export HOST_HOME
export HOST_UID
export HOST_GID
export CLAUDE_REAL_PATH
export CLAUDE_INSTALL_DIR
export TEST_REPO_PATH
export DOCKER_SOCKET
export DOCKER_SOCKET_GID
export FAKE_CLAUDE_PROJECTS_DIR

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

echo "[RUN] Building and starting E2E test container..."
echo ""

docker compose -f "$SCRIPT_DIR/docker-compose.yaml" up --build --exit-code-from sparecrow-e2e
