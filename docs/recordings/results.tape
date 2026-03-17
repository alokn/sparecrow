# VHS tape file: Results command showing .scrow/ artifacts
# Shows: sparecrow results listing result artifacts
# Duration: ~10 seconds
# Output: docs/recordings/output/results.svg
#
# Prerequisites:
#   - sparecrow installed globally
#   - Mock state with .scrow/ artifacts via setup-mock-state.sh
#
# Usage: vhs results.tape

Output docs/recordings/output/results.svg

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

# List all results
Type "sparecrow results"
Enter
Sleep 3s

# Show the latest result
Type "sparecrow results --latest"
Enter
Sleep 4s

Sleep 2s
