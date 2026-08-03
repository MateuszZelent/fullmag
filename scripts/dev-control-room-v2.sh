#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${FULLMAG_API_PORT:-8081}"
API_URL="${FULLMAG_API_URL:-http://localhost:${API_PORT}}"
WEB_BIND_HOST="${FULLMAG_CONTROL_ROOM_V2_BIND_HOST:-${FULLMAG_WEB_BIND_HOST:-0.0.0.0}}"
WEB_PORT="${FULLMAG_CONTROL_ROOM_V2_PORT:-}"
CONTROL_ROOM_URL_FILE=".fullmag/control-room-v2-url.txt"
PORT_HELPER="${REPO_ROOT}/scripts/control_room_port.py"

default_web_public_host() {
  if [[ -n "${FULLMAG_CONTROL_ROOM_V2_HOST:-}" ]]; then
    printf '%s\n' "${FULLMAG_CONTROL_ROOM_V2_HOST}"
    return
  fi
  if [[ -n "${FULLMAG_WEB_HOST:-}" ]]; then
    printf '%s\n' "${FULLMAG_WEB_HOST}"
    return
  fi
  if [[ -n "${WSL_DISTRO_NAME:-}" || -n "${WSL_INTEROP:-}" ]]; then
    local wsl_host
    wsl_host="$(hostname -I 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i !~ /:/) { print $i; exit } }')"
    if [[ -n "$wsl_host" ]]; then
      printf '%s\n' "$wsl_host"
      return
    fi
  fi
  printf '%s\n' "localhost"
}

WEB_PUBLIC_HOST="$(default_web_public_host)"
BROWSER_API_URL="${API_URL}"
if [[ "$WEB_PUBLIC_HOST" != "localhost" && "$WEB_PUBLIC_HOST" != "127.0.0.1" && "$API_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  BROWSER_API_URL="http://${WEB_PUBLIC_HOST}:${API_PORT}"
fi

cd "$REPO_ROOT"

if command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM_CMD=(corepack pnpm)
else
  echo "Neither pnpm nor corepack is available on PATH." >&2
  echo "Install Node.js with corepack support, or install pnpm globally." >&2
  exit 127
fi

mkdir -p .fullmag/logs

cleanup() {
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

port_is_bindable() {
  python3 "${PORT_HELPER}" check "${WEB_BIND_HOST}" "$1"
}

pick_web_port() {
  python3 "${PORT_HELPER}" pick "${WEB_BIND_HOST}" \
    3100 3101 3102 3103 3006 3007 3008 3009 3010
}

if [[ -z "$WEB_PORT" ]]; then
  WEB_PORT="$(pick_web_port)"
elif ! port_is_bindable "$WEB_PORT"; then
  echo "Requested FULLMAG_CONTROL_ROOM_V2_PORT=${WEB_PORT} is not bindable on ${WEB_BIND_HOST}." >&2
  echo "Choose another port or unset FULLMAG_CONTROL_ROOM_V2_PORT for automatic selection." >&2
  exit 2
fi

WEB_URL_BASE="http://${WEB_PUBLIC_HOST}:${WEB_PORT}"

if curl -fsS "${API_URL}/healthz" >/dev/null 2>&1; then
  echo "Reusing empty Fullmag API backend on ${API_URL} ..."
else
  echo "Starting empty Fullmag API backend on ${API_URL} ..."
  FULLMAG_API_PORT="${API_PORT}" \
    FULLMAG_DISABLE_STATIC_CONTROL_ROOM=1 \
    CARGO_TARGET_DIR=.fullmag/target \
    cargo +nightly run -p fullmag-api > .fullmag/logs/fullmag-api-v2.log 2>&1 &
  API_PID=$!

  for _ in $(seq 1 600); do
    if curl -fsS "${API_URL}/healthz" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$API_PID" 2>/dev/null; then
      echo "Fullmag API process exited unexpectedly." >&2
      echo "API log: ${REPO_ROOT}/.fullmag/logs/fullmag-api-v2.log" >&2
      exit 1
    fi
    sleep 0.2
  done

  if ! curl -fsS "${API_URL}/healthz" >/dev/null 2>&1; then
    echo "Fullmag API did not become healthy on ${API_URL}." >&2
    echo "API log: ${REPO_ROOT}/.fullmag/logs/fullmag-api-v2.log" >&2
    exit 1
  fi
fi

printf '%s\n' "${WEB_URL_BASE}" > "${CONTROL_ROOM_URL_FILE}"

# Kill any stale frontend process running from this project directory, then
# remove the .next/dev state so Next.js 16's multi-instance guard doesn't
# reject the new process. Next inserts --webpack between `dev` and the host
# flags, so matching the old contiguous argv was not reliable.
CONTROL_ROOM_DIR="${REPO_ROOT}/apps/control-room"
while read -r stale_pid; do
  [[ -z "$stale_pid" || "$stale_pid" == "$$" ]] && continue
  stale_cwd="$(readlink -f "/proc/${stale_pid}/cwd" 2>/dev/null || true)"
  if [[ "$stale_cwd" == "$CONTROL_ROOM_DIR" ]]; then
    echo "Stopping stale Control Room frontend (PID ${stale_pid}) ..." >&2
    kill "$stale_pid" 2>/dev/null || true
  fi
done < <(pgrep -f 'next|dev-server\.mjs' 2>/dev/null || true)
sleep 0.5
rm -rf "${CONTROL_ROOM_DIR}/.next/dev"

echo "Starting frontend v2 dev server on ${WEB_URL_BASE} ..."
echo "API base: ${API_URL}"
echo "API health: ${API_URL}/healthz"
echo "API v2 health: ${API_URL}/v2/platform/health"
echo "Frontend route: ${WEB_URL_BASE}/workspace"
echo "API log: ${REPO_ROOT}/.fullmag/logs/fullmag-api-v2.log"

NEXT_PUBLIC_FULLMAG_API_URL="${BROWSER_API_URL}" \
  FULLMAG_API_URL="${API_URL}" \
  FULLMAG_API_PROXY_TARGET="${API_URL}" \
  FULLMAG_WEB_PUBLIC_HOST="${WEB_PUBLIC_HOST}" \
  "${PNPM_CMD[@]}" --dir apps/control-room dev --hostname "${WEB_BIND_HOST}" --port "${WEB_PORT}"
