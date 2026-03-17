# VHS tape file: Hero recording for sparecrow README
# Shows: onboard (abbreviated) -> queue add -> status
# Duration: ~25 seconds
# Output: docs/recordings/output/hero.svg
#
# Prerequisites:
#   - sparecrow installed globally (npm install -g sparecrow@beta)
#   - Mock state set up via setup-mock-state.sh
#
# Usage: vhs hero.tape

Output docs/recordings/output/hero.svg

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

# Step 1: Onboard (abbreviated — show the command and skip interaction)
Type "sparecrow onboard"
Enter
Sleep 3s

# Step 2: Queue a task
Type "sparecrow queue add --template security-audit --target ."
Enter
Sleep 2s

# Step 3: Check status
Type "sparecrow status"
Enter
Sleep 3s

Sleep 2s
