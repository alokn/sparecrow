# VHS tape file: Status command with live data
# Shows: sparecrow status with daemon running and usage data
# Duration: ~12 seconds
# Output: docs/recordings/output/status.svg
#
# Prerequisites:
#   - sparecrow installed globally
#   - Mock state set up via setup-mock-state.sh
#
# Usage: vhs status.tape

Output docs/recordings/output/status.svg

Require sparecrow

Set Shell "bash"
Set FontSize 14
Set Width 900
Set Height 500
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set WindowBar Colorful
Set WindowBarSize 40

# Show status with all cards expanded
Type "sparecrow status --all"
Enter
Sleep 4s

# Show why dispatch is or isn't happening
Type "sparecrow why"
Enter
Sleep 4s

Sleep 2s
