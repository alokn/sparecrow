# VHS tape file: Logs command showing task results
# Shows: sparecrow logs --failures to display failed task history
# Duration: ~10 seconds
# Output: docs/recordings/output/logs-failures.svg
#
# Prerequisites:
#   - sparecrow installed globally
#   - Mock state with audit log entries via setup-mock-state.sh
#
# Usage: vhs logs-failures.tape

Output docs/recordings/output/logs-failures.svg

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

# Show recent failures
Type "sparecrow logs --failures"
Enter
Sleep 3s

# Show all recent logs
Type "sparecrow logs --count 5"
Enter
Sleep 4s

Sleep 2s
