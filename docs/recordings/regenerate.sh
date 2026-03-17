#!/usr/bin/env bash
# Regenerate all VHS terminal recordings for sparecrow.
#
# Prerequisites:
#   - VHS installed: https://github.com/charmbracelet/vhs
#   - sparecrow installed globally: npm install -g sparecrow@beta
#   - Mock state set up: ./setup-mock-state.sh
#
# Usage: ./regenerate.sh [tape-name]
#   tape-name: Optional -- regenerate only a specific recording (e.g., "hero")
#              If omitted, all recordings are regenerated.
#
# Output: SVG files are written to docs/recordings/output/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Check VHS is installed
if ! command -v vhs &> /dev/null; then
  echo "Error: VHS is not installed."
  echo "Install it from: https://github.com/charmbracelet/vhs"
  echo ""
  echo "  brew install charmbracelet/tap/vhs        # macOS"
  echo "  sudo apt install vhs                       # Linux (Debian/Ubuntu)"
  echo "  sudo snap install vhs                      # Linux (Snap)"
  echo "  go install github.com/charmbracelet/vhs@latest  # Go (any platform)"
  echo "  # Binary releases: https://github.com/charmbracelet/vhs/releases"
  echo ""
  exit 1
fi

# Check sparecrow is installed
if ! command -v sparecrow &> /dev/null; then
  echo "Error: sparecrow is not installed."
  echo "Install it: npm install -g sparecrow@beta"
  exit 1
fi

# List of all tape files
TAPES=(hero status logs-failures results)

# Filter to specific tape if argument provided
if [[ -n "${1:-}" ]]; then
  TAPES=("$1")
  if [[ ! -f "$SCRIPT_DIR/${1}.tape" ]]; then
    echo "Error: Tape file not found: $SCRIPT_DIR/${1}.tape"
    echo "Available tapes: hero, status, logs-failures, results"
    exit 1
  fi
fi

echo "Regenerating recordings..."
echo ""

FAILED=0
for tape in "${TAPES[@]}"; do
  TAPE_FILE="$SCRIPT_DIR/${tape}.tape"
  echo "  Recording: $tape"
  echo "    Input:  $TAPE_FILE"
  echo "    Output: $OUTPUT_DIR/${tape}.svg"

  if vhs "$TAPE_FILE"; then
    echo "    Status: OK"
  else
    echo "    Status: FAILED"
    FAILED=$((FAILED + 1))
  fi
  echo ""
done

if [[ $FAILED -gt 0 ]]; then
  echo "Warning: $FAILED recording(s) failed. Check VHS output above."
  exit 1
fi

echo "All recordings regenerated successfully."
echo "Output directory: $OUTPUT_DIR"

# Report file sizes
echo ""
echo "File sizes:"
for tape in "${TAPES[@]}"; do
  SVG_FILE="$OUTPUT_DIR/${tape}.svg"
  if [[ -f "$SVG_FILE" ]]; then
    SIZE=$(du -h "$SVG_FILE" | cut -f1)
    echo "  ${tape}.svg: $SIZE"
  fi
done
