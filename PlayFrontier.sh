#!/usr/bin/env bash

set -euo pipefail

STAGED_ROOT="${HOME}/Library/Application Support/evejs-frontier/macos/staged-client/current"
SESSION_FILE="${HOME}/Library/Application Support/evejs-frontier/macos/launcher-session.args"
LOG_ROOT="${HOME}/Library/Application Support/evejs-frontier/macos/logs"
SERVER_HOST="127.0.0.1"
SETTINGS_PROFILE="EveJSFrontier"
USE_SESSION=false
DRY_RUN=false
FOREGROUND=true

usage() {
  cat <<'EOF'
Usage: bash PlayFrontier.sh [options]

Launches only the isolated staged EVE Frontier client against the isolated
EveJS Frontier server.

Options:
  --staged-root <path>       Staged runtime root
  --server-host <host>       Game server host. Frontier uses port 26000.
  --settings-profile <name>  Client settings profile. Default: EveJSFrontier
  --session-file <path>      Replay captured Frontier launcher arguments
  --use-captured-session     Use the default private session file
  --foreground               Keep the client attached (default)
  --detach                   Launch the client in the background
  --dry-run                  Print a redacted launch command
  -h, --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --staged-root)
      STAGED_ROOT="$2"
      shift 2
      ;;
    --server-host|--server)
      SERVER_HOST="$2"
      shift 2
      ;;
    --settings-profile)
      SETTINGS_PROFILE="$2"
      shift 2
      ;;
    --session-file)
      SESSION_FILE="$2"
      USE_SESSION=true
      shift 2
      ;;
    --use-captured-session)
      USE_SESSION=true
      shift
      ;;
    --foreground)
      FOREGROUND=true
      shift
      ;;
    --detach)
      FOREGROUND=false
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
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

if [[ -L "$STAGED_ROOT" ]]; then
  STAGED_ROOT="$(cd "$STAGED_ROOT" && pwd -P)"
fi

MARKER="${STAGED_ROOT}/.evejs-frontier-stage.json"
APP="${STAGED_ROOT}/SharedCache/stillness/EVE.app"
BUILD_ROOT="${APP}/Contents/Resources/build"
EXEFILE="${BUILD_ROOT}/bin64/exefile"
RESFILES="${STAGED_ROOT}/SharedCache/ResFiles"
COMMON_INI="${BUILD_ROOT}/common.ini"

if [[ ! -f "$MARKER" || ! -x "$EXEFILE" || ! -d "$RESFILES" ]]; then
  echo "[evejs-frontier] Valid staged client not found: $STAGED_ROOT" >&2
  echo "[evejs-frontier] Run: bash StageFrontierClient.sh" >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*cryptoPack[[:space:]]*=[[:space:]]*Placebo[[:space:]]*$' "$COMMON_INI"; then
  echo "[evejs-frontier] Stage is missing the Placebo common.ini overlay." >&2
  exit 1
fi
if [[ "$USE_SESSION" == true ]]; then
  if [[ ! -f "$SESSION_FILE" ]]; then
    echo "[evejs-frontier] Captured Frontier session not found: $SESSION_FILE" >&2
    exit 1
  fi
  MODE="$(stat -f '%Lp' "$SESSION_FILE")"
  if [[ "$MODE" != "600" ]]; then
    echo "[evejs-frontier] Session file must be private (mode 600): $SESSION_FILE" >&2
    exit 1
  fi
fi

# macOS still ships Bash 3.2, where an empty array trips nounset expansion.
ARGS=("/noconsole")
if [[ "$USE_SESSION" == true ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    ARGS+=("$line")
  done < "$SESSION_FILE"
fi

upsert_arg() {
  local prefix="$1"
  local replacement="$2"
  local output=()
  local found=false
  local value=""
  for value in "${ARGS[@]}"; do
    if [[ "$value" == "$prefix"* ]]; then
      if [[ "$found" == false ]]; then
        output+=("$replacement")
        found=true
      fi
    else
      output+=("$value")
    fi
  done
  if [[ "$found" == false ]]; then
    output+=("$replacement")
  fi
  ARGS=("${output[@]}")
}

upsert_arg "/noconsole" "/noconsole"
upsert_arg "/server:" "/server:${SERVER_HOST}"
upsert_arg "/settingsprofile=" "/settingsprofile=${SETTINGS_PROFILE}"
upsert_arg "/language=" "/language=en"
upsert_arg "/cryptoPack=" "/cryptoPack=Placebo"

mkdir -p "$LOG_ROOT"
STDOUT_LOG="${LOG_ROOT}/client-stdout.log"
STDERR_LOG="${LOG_ROOT}/client-stderr.log"
JSONL_LOG="${LOG_ROOT}/logs-client.jsonl"
ENVIRONMENT=(
  "EO_REMOTEFILECACHEFOLDER=${RESFILES}"
  "FRONTIER_PUBLIC_GATEWAY_ADDRESS=127.0.0.1:26103"
  "FRONTIER_PUBLIC_GATEWAY_IS_SECURE=1"
  "JSONL-LOGPATH=${LOG_ROOT}"
)

sanitize() {
  case "$1" in
    /ssoToken=*|/refreshToken=*|/LauncherData=*|/deviceID=*|/machineHash=*|/journeyID=*)
      printf '%s=***' "${1%%=*}"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

echo "[evejs-frontier] Client: $APP"
echo "[evejs-frontier] Server: ${SERVER_HOST}:26000"
echo "[evejs-frontier] Settings: $SETTINGS_PROFILE"
echo "[evejs-frontier] Boot crypto: Placebo"
echo "[evejs-frontier] Session replay: $USE_SESSION"

if [[ "$DRY_RUN" == true ]]; then
  printf '  cd %q && env' "${BUILD_ROOT}/bin64"
  for value in "${ENVIRONMENT[@]}"; do
    printf ' %q' "$value"
  done
  printf ' %q' "$EXEFILE"
  for value in "${ARGS[@]}"; do
    printf ' %q' "$(sanitize "$value")"
  done
  printf '\n'
  exit 0
fi

: > "$JSONL_LOG"
cd "${BUILD_ROOT}/bin64"
if [[ "$FOREGROUND" == true ]]; then
  exec env "${ENVIRONMENT[@]}" "$EXEFILE" "${ARGS[@]}"
fi

: > "$STDOUT_LOG"
: > "$STDERR_LOG"
nohup env "${ENVIRONMENT[@]}" "$EXEFILE" "${ARGS[@]}" \
  </dev/null >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
echo "$!" > "${LOG_ROOT}/client.pid"
echo "[evejs-frontier] Client PID: $!"
echo "[evejs-frontier] Client stderr: $STDERR_LOG"
echo "[evejs-frontier] Client JSONL: $JSONL_LOG"
