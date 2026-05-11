#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${FULLMAG_API_PORT:-8081}"
API_URL="${FULLMAG_API_URL:-http://localhost:${API_PORT}}"
WEB_BIND_HOST="${FULLMAG_CONTROL_ROOM_V2_BIND_HOST:-${FULLMAG_WEB_BIND_HOST:-0.0.0.0}}"
WEB_PUBLIC_HOST="${FULLMAG_CONTROL_ROOM_V2_HOST:-${FULLMAG_WEB_HOST:-localhost}}"
WEB_PORT="${FULLMAG_CONTROL_ROOM_V2_PORT:-}"
CONTROL_ROOM_URL_FILE=".fullmag/control-room-v2-url.txt"

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
  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
loopback = socket.gethostbyname("localhost")
sock = socket.socket()
try:
    sock.bind((loopback, port))
except OSError:
    raise SystemExit(1)
else:
    raise SystemExit(0)
finally:
    try:
        sock.close()
    except OSError:
        pass
PY
}

pick_web_port() {
  python3 - <<'PY'
import socket

loopback = socket.gethostbyname("localhost")
for port in (3100, 3101, 3102, 3103, 3006, 3007, 3008, 3009, 3010):
    sock = socket.socket()
    try:
        sock.bind((loopback, port))
    except OSError:
        pass
    else:
        print(port)
        sock.close()
        raise SystemExit(0)
    finally:
        try:
            sock.close()
        except OSError:
            pass
raise SystemExit("no free control-room v2 port found")
PY
}

if [[ -z "$WEB_PORT" ]]; then
  WEB_PORT="$(pick_web_port)"
elif ! port_is_bindable "$WEB_PORT"; then
  echo "Requested FULLMAG_CONTROL_ROOM_V2_PORT=${WEB_PORT} is not bindable." >&2
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

echo "Starting frontend v2 dev server on ${WEB_URL_BASE} ..."
echo "API base: ${API_URL}"
echo "API health: ${API_URL}/healthz"
echo "API v2 health: ${API_URL}/v2/platform/health"
echo "Frontend route: ${WEB_URL_BASE}/workspace"
echo "API log: ${REPO_ROOT}/.fullmag/logs/fullmag-api-v2.log"

NEXT_PUBLIC_FULLMAG_API_URL="${API_URL}" \
  FULLMAG_API_URL="${API_URL}" \
  FULLMAG_API_PROXY_TARGET="${API_URL}" \
  "${PNPM_CMD[@]}" --dir apps/control-room dev --hostname "${WEB_BIND_HOST}" --port "${WEB_PORT}"
