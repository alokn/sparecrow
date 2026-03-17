# Terminal Recordings

Animated terminal recordings for sparecrow documentation. These recordings are embedded in the project README and used in launch materials.

## Recordings

| Recording | Description | Tape File | Output |
|-----------|-------------|-----------|--------|
| **Hero** | Onboard, queue a task, check status | `hero.tape` | `output/hero.svg` |
| **Status** | `sparecrow status --all` and `sparecrow why` | `status.tape` | `output/status.svg` |
| **Logs** | `sparecrow logs --failures` showing task history | `logs-failures.tape` | `output/logs-failures.svg` |
| **Results** | `sparecrow results` showing .scrow/ artifacts | `results.tape` | `output/results.svg` |

## Prerequisites

1. **VHS** -- scriptable terminal recorder by Charm: https://github.com/charmbracelet/vhs

   ```bash
   # macOS
   brew install charmbracelet/tap/vhs

   # Linux (Debian/Ubuntu)
   sudo apt install vhs

   # Linux (Snap)
   sudo snap install vhs

   # Linux (binary release -- any distro)
   # Download from: https://github.com/charmbracelet/vhs/releases
   # e.g.: curl -Lo vhs.tar.gz https://github.com/charmbracelet/vhs/releases/latest/download/vhs_Linux_x86_64.tar.gz
   #        tar -xzf vhs.tar.gz && sudo mv vhs /usr/local/bin/

   # Go (any platform)
   go install github.com/charmbracelet/vhs@latest
   ```

2. **sparecrow** installed globally:

   ```bash
   npm install -g sparecrow@beta
   ```

3. **Mock state** -- realistic daemon/queue/log data for recordings:

   Run from the `docs/recordings/` directory:

   ```bash
   cd docs/recordings
   ./setup-mock-state.sh
   ```

## Regenerating Recordings

All scripts (`regenerate.sh`, `setup-mock-state.sh`) are designed to be run from the `docs/recordings/` directory. The `vhs` command must be run from the **project root** because tape file `Output` directives use project-root-relative paths.

### All recordings (recommended)

```bash
cd docs/recordings
./regenerate.sh
```

### A specific recording

```bash
cd docs/recordings
./regenerate.sh hero
./regenerate.sh status
./regenerate.sh logs-failures
./regenerate.sh results
```

### Manual (single tape)

Run from the **project root** (tape `Output` paths are relative to the project root):

```bash
# From project root:
vhs docs/recordings/hero.tape
vhs docs/recordings/status.tape
vhs docs/recordings/logs-failures.tape
vhs docs/recordings/results.tape
```

## Output Format

Recordings use **SVG** format for:
- Crisp text rendering at any zoom level
- Smaller file sizes compared to GIF
- Native GitHub rendering (no external hosting needed)
- Each recording targets under 2MB for fast GitHub loading

## Tape File Syntax

Tape files use VHS syntax. Key directives:

```
Output path/to/output.svg     # Output file path and format
Set FontSize 14               # Terminal font size
Set Width 900                 # Terminal width in pixels
Set Height 500                # Terminal height in pixels
Set Theme "Catppuccin Mocha"  # Color theme
Set TypingSpeed 60ms          # Typing animation speed
Type "command"                # Type text
Enter                         # Press Enter
Sleep 2s                      # Wait
```

Full VHS documentation: https://github.com/charmbracelet/vhs

## Editing Recordings

1. Edit the `.tape` file
2. Run `./regenerate.sh <tape-name>` to preview
3. Adjust timing (`Sleep`), dimensions (`Set Width/Height`), or content as needed
4. Commit both the `.tape` file and regenerated `.svg` output

## Current Status

The SVG files in `output/` are **placeholder** static images that simulate terminal output. They will be replaced with actual VHS-generated animated recordings when VHS is available in the build environment.

The tape files contain correct VHS syntax and are ready to use.
