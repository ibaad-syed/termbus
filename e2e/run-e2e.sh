#!/usr/bin/env bash
# Real-iTerm2 end-to-end test. Opens a scratch window, exercises
# list/check/send/ask against a live zsh, then closes it.
# Opt-in: TERMBUS_E2E=1 ./e2e/run-e2e.sh   (needs macOS + iTerm2 + GUI)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${TERMBUS_E2E:-}" != "1" ]; then
  echo "skipping e2e (set TERMBUS_E2E=1 to run)"
  exit 0
fi

pnpm build

WIN_ID=$(osascript -e 'tell application "iTerm2" to id of (create window with default profile)')
cleanup() {
  osascript -e "tell application \"iTerm2\" to close (first window whose id = $WIN_ID)" || true
}
trap cleanup EXIT
sleep 2 # let the shell start

SESS_ID=$(osascript -e "tell application \"iTerm2\" to id of current session of (first window whose id = $WIN_ID)")
echo "scratch session: $SESS_ID"

echo "--- list must include the scratch pane"
node dist/cli.js list --json | grep -q "$SESS_ID"

echo "--- ask a shell command, verify output and exit code"
OUT=$(node dist/cli.js ask "$SESS_ID" 'echo termbus-e2e-$((6*7))' --timeout 30)
echo "$OUT" | grep -q 'termbus-e2e-42'

echo "--- failing command sets exit code"
if node dist/cli.js ask "$SESS_ID" 'false' --timeout 30 >/dev/null 2>&1; then
  echo "EXPECTED nonzero exit"; exit 1
fi

echo "--- check reads the screen"
node dist/cli.js check "$SESS_ID" | grep -q 'termbus-e2e-42'

echo "--- send without submit types but does not run"
node dist/cli.js send "$SESS_ID" 'echo should-not-run-yet' --no-submit
sleep 1
if node dist/cli.js check "$SESS_ID" | grep -q '^should-not-run-yet$'; then
  echo "EXPECTED no execution"; exit 1
fi

echo "ALL E2E PASSED"
