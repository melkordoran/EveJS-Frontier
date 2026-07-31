#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILD="3450341"
RESET_RUNTIME=false
LOG_LEVEL="2"

usage() {
  cat <<'EOF'
Usage: bash StartFrontierServer.sh [options]

Starts an isolated EVE Frontier compatibility server on local development
ports. It never reads or writes the live EveJS game store.

Options:
  --build <number>   Extracted/generated Frontier build. Default: 3450341
  --reset-runtime   Replace the disposable runtime database from its generated baseline
  --quiet           Use normal rather than verbose server logging
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      BUILD="$2"
      shift 2
      ;;
    --reset-runtime)
      RESET_RUNTIME=true
      shift
      ;;
    --quiet)
      LOG_LEVEL="1"
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

if ! [[ "$BUILD" =~ ^[0-9]+$ ]]; then
  echo "[evejs-frontier] Build must be numeric: $BUILD" >&2
  exit 1
fi

GENERATED_ROOT="${REPO_ROOT}/_local/frontier-gameStore/${BUILD}"
GENERATED_DATA="${GENERATED_ROOT}/data"
RUNTIME_ROOT="${REPO_ROOT}/_local/frontier-runtime/${BUILD}"
RUNTIME_DATA="${RUNTIME_ROOT}/gameStore/data"
RUNTIME_MARKER="${RUNTIME_ROOT}/.evejs-frontier-runtime"
STATIC_ROOT="${REPO_ROOT}/_local/frontier-sde/${BUILD}"

if [[ ! -d "$GENERATED_DATA" ]]; then
  echo "[evejs-frontier] Generated Frontier database is missing: $GENERATED_DATA" >&2
  echo "[evejs-frontier] Run: npm run frontier:database -- --force" >&2
  exit 1
fi
if [[ ! -d "$STATIC_ROOT" ]]; then
  echo "[evejs-frontier] Frontier static snapshot is missing: $STATIC_ROOT" >&2
  exit 1
fi

if [[ "$RESET_RUNTIME" == true && -e "$RUNTIME_ROOT" ]]; then
  if [[ ! -f "$RUNTIME_MARKER" ]]; then
    echo "[evejs-frontier] Refusing to reset an unrecognized runtime: $RUNTIME_ROOT" >&2
    exit 1
  fi
  rm -rf "$RUNTIME_ROOT"
fi

if [[ ! -d "$RUNTIME_DATA" ]]; then
  mkdir -p "$(dirname "$RUNTIME_DATA")"
  ditto "$GENERATED_DATA" "$RUNTIME_DATA"
  cp "${GENERATED_ROOT}/manifest.json" "${RUNTIME_ROOT}/generated-manifest.json"
  printf 'build=%s\n' "$BUILD" > "$RUNTIME_MARKER"
  echo "[evejs-frontier] Created isolated runtime from generated build $BUILD."
fi

echo "[evejs-frontier] Runtime: $RUNTIME_ROOT"
echo "[evejs-frontier] Game TCP: 127.0.0.1:26000"
echo "[evejs-frontier] Profile: Frontier 20.04 build $BUILD, MachoNet 489, Placebo"

cd "$REPO_ROOT"
exec env \
  EVEJS_GAMESTORE_DATA_DIR="$RUNTIME_DATA" \
  EVEJS_STATIC_JSONL_ROOT="$STATIC_ROOT" \
  EVEJS_CLIENT_COMPATIBILITY_PROFILE="frontier" \
  EVEJS_CLIENT_VERSION="20.04" \
  EVEJS_CLIENT_BUILD="$BUILD" \
  EVEJS_EVE_BIRTHDAY="170472" \
  EVEJS_MACHO_VERSION="489" \
  EVEJS_PROJECT_CODENAME="cycle-6" \
  EVEJS_PROJECT_REGION="ccp" \
  EVEJS_PROJECT_VERSION="V20.04@ccp" \
  EVEJS_GAME_SERVER_BIND_HOST="127.0.0.1" \
  EVEJS_GAME_SERVER_HOST="127.0.0.1" \
  EVEJS_SERVER_PORT="26000" \
  EVEJS_IMAGE_SERVER_URL="http://127.0.0.1:26101/" \
  EVEJS_IMAGE_SERVER_BIND_HOST="127.0.0.1" \
  EVEJS_MICROSERVICES_REDIRECT_URL="http://127.0.0.1:26102/" \
  EVEJS_MICROSERVICES_PUBLIC_BASE_URL="http://127.0.0.1:26102/" \
  EVEJS_MICROSERVICES_BIND_HOST="127.0.0.1" \
  EVEJS_PROXY_LOOPBACK_CDN_LISTEN_PORT="0" \
  EVEJS_REDSHIFT_MONITOR_PORT="26401" \
  EVEJS_XMPP_SERVER_PORT="5223" \
  EVEJS_XMPP_CONNECT_HOST="127.0.0.1" \
  EVEJS_XMPP_DOMAIN="frontier.localhost" \
  EVEJS_XMPP_CONFERENCE_DOMAIN="conference.frontier.localhost" \
  EVEJS_DEV_AUTO_CREATE_ACCOUNTS="true" \
  EVEJS_DEV_SKIP_PASSWORD_VALIDATION="true" \
  EVEJS_WORMHOLES_ENABLED="false" \
  EVEJS_SKIP_NPC_STARTUP="1" \
  EVEJS_LOG_LEVEL="$LOG_LEVEL" \
  node server/index.js
