#!/usr/bin/env bash

set -euo pipefail

OUTPUT="${HOME}/Library/Application Support/evejs-frontier/macos/launcher-session.args"
TIMEOUT=180
OPEN_LAUNCHER=false
LAUNCHER="/Applications/EVE Frontier.app"

usage() {
  cat <<'EOF'
Usage: bash CaptureFrontierSession.sh [options]

Captures private launcher arguments from a Frontier client started by the
official launcher. The output is mode 600 and token values are never printed.

Options:
  --output <path>       Private argument file
  --timeout <seconds>   Wait time. Default: 180
  --open-launcher       Open /Applications/EVE Frontier.app first
  --launcher <path>     Alternate launcher app
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    --open-launcher)
      OPEN_LAUNCHER=true
      shift
      ;;
    --launcher)
      LAUNCHER="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[evejs-frontier] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "[evejs-frontier] Timeout must be numeric." >&2
  exit 1
fi
if [[ "$OPEN_LAUNCHER" == true ]]; then
  open -a "$LAUNCHER"
fi

echo "[evejs-frontier] Waiting for the official launcher to start Frontier..."
START="$(date +%s)"
while true; do
  COMMAND_LINE="$(
    ps -axww -o pid= -o command= |
      awk '/SharedCache\\/stillness\\/EVE\\.app\\/Contents\\/(MacOS\\/EVE|Resources\\/build\\/bin64\\/exefile)/ && /\\/ssoToken=/ { sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); print }' |
      tail -n 1
  )"
  if [[ -n "$COMMAND_LINE" ]]; then
    mkdir -p "$(dirname "$OUTPUT")"
    TEMP="$(mktemp "${OUTPUT}.tmp.XXXXXX")"
    {
      echo "# Captured from the official EVE Frontier launcher on $(date '+%Y-%m-%d %H:%M:%S')"
      for token in $COMMAND_LINE; do
        case "$token" in
          /noconsole|/server:*|/ssoToken=*|/refreshToken=*|/settingsprofile=*|/language=*|/LauncherData=*|/deviceID=*|/machineHash=*|/journeyID=*|exp=*)
            echo "$token"
            ;;
        esac
      done
    } > "$TEMP"
    chmod 600 "$TEMP"
    mv "$TEMP" "$OUTPUT"
    echo "[evejs-frontier] Captured private session: $OUTPUT"
    echo "[evejs-frontier] Token values were not printed."
    exit 0
  fi

  if (( $(date +%s) - START >= TIMEOUT )); then
    echo "[evejs-frontier] Timed out waiting for a launcher-started Frontier client." >&2
    exit 1
  fi
  sleep 1
done
