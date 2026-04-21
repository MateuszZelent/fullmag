#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_ID="${1:-}"
API_URL="${FULLMAG_API_URL:-http://localhost:8081}"
WEB_BIND_HOST="${FULLMAG_WEB_BIND_HOST:-0.0.0.0}"
WEB_PUBLIC_HOST="${FULLMAG_WEB_HOST:-localhost}"
CONTROL_ROOM_URL_FILE=".fullmag/control-room-url.txt"
LOOPBACK_HOST="$(python3 - <<'PY'
import socket
print(socket.gethostbyname("localhost"))
PY
)"

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

cleanup() {
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

mkdir -p .fullmag/logs

pick_web_port() {
  python3 - <<'PY'
import socket
LOOPBACK = socket.gethostbyname("localhost")
for port in (3000, 3001, 3002, 3003, 3004, 3005, 3010):
    sock = socket.socket()
    try:
        sock.bind((LOOPBACK, port))
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
raise SystemExit("no free control-room port found in 3000,3001,3002,3003,3004,3005,3010")
PY
}

port_is_bindable() {
  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket()
loopback = socket.gethostbyname("localhost")
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

web_url_is_healthy() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

stop_next_on_port() {
  local port="$1"
  for host in "${WEB_BIND_HOST}" 0.0.0.0 "${LOOPBACK_HOST}" localhost; do
    pkill -f "next dev --hostname ${host} --port ${port}" >/dev/null 2>&1 || true
    pkill -f "node dev-server.mjs --hostname ${host} --port ${port}" >/dev/null 2>&1 || true
  done

  for _ in $(seq 1 25); do
    if port_is_bindable "${port}"; then
      return 0
    fi
    sleep 0.2
  done
}

discover_existing_web_url() {
  for port in 3000 3001 3002 3003 3004 3005 3010; do
    local candidate="http://${WEB_PUBLIC_HOST}:${port}"
    if web_url_is_healthy "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

if [[ -n "${FULLMAG_WEB_URL:-}" ]]; then
  WEB_URL_BASE="${FULLMAG_WEB_URL}"
  WEB_PORT="${WEB_URL_BASE##*:}"
elif [[ -f "${CONTROL_ROOM_URL_FILE}" ]]; then
  WEB_URL_BASE="$(tr -d '\n' < "${CONTROL_ROOM_URL_FILE}")"
  if [[ -n "${WEB_URL_BASE}" ]] && web_url_is_healthy "${WEB_URL_BASE}"; then
    WEB_PORT="${WEB_URL_BASE##*:}"
  else
    if [[ -n "${WEB_URL_BASE}" ]]; then
      STORED_PORT="${WEB_URL_BASE##*:}"
      if port_is_bindable "${STORED_PORT}"; then
        WEB_PORT="${STORED_PORT}"
        WEB_URL_BASE="http://${WEB_PUBLIC_HOST}:${WEB_PORT}"
      else
        WEB_PORT="$(pick_web_port)"
        WEB_URL_BASE="http://${WEB_PUBLIC_HOST}:${WEB_PORT}"
      fi
    else
      WEB_PORT="$(pick_web_port)"
      WEB_URL_BASE="http://${WEB_PUBLIC_HOST}:${WEB_PORT}"
    fi
  fi
elif EXISTING_WEB_URL="$(discover_existing_web_url)"; then
  WEB_URL_BASE="${EXISTING_WEB_URL}"
  WEB_PORT="${WEB_URL_BASE##*:}"
else
  WEB_PORT="$(pick_web_port)"
  WEB_URL_BASE="http://${WEB_PUBLIC_HOST}:${WEB_PORT}"
fi

if curl -fsS "${API_URL}/healthz" >/dev/null 2>&1; then
  echo "Reusing Fullmag API on ${API_URL} ..."
else
  echo "Starting Fullmag API on ${API_URL} ..."
  CARGO_TARGET_DIR=.fullmag/target cargo +nightly run -p fullmag-api > .fullmag/logs/fullmag-api.log 2>&1 &
  API_PID=$!

  for _ in $(seq 1 50); do
    if curl -fsS "${API_URL}/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

TARGET_URL="${WEB_URL_BASE}/"

if ! web_url_is_healthy "${WEB_URL_BASE}" && ! port_is_bindable "${WEB_PORT}"; then
  echo "Restarting unhealthy Next.js control room on ${WEB_URL_BASE} ..."
  stop_next_on_port "${WEB_PORT}"
  rm -rf "${REPO_ROOT}/apps/web/.next"
fi

if web_url_is_healthy "${WEB_URL_BASE}"; then
  echo "Reusing Next.js control room on ${WEB_URL_BASE} ..."
  (
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "${TARGET_URL}" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "${TARGET_URL}" >/dev/null 2>&1 || true
    fi
  ) &
  echo "Workspace route: ${TARGET_URL}"
  exit 0
fi

(
  for _ in $(seq 1 120); do
    if web_url_is_healthy "${WEB_URL_BASE}"; then
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${TARGET_URL}" >/dev/null 2>&1 || true
      elif command -v open >/dev/null 2>&1; then
        open "${TARGET_URL}" >/dev/null 2>&1 || true
      fi
      exit 0
    fi
    sleep 0.5
  done
  exit 0
) &

echo "Starting Next.js control room on ${WEB_URL_BASE} ..."
echo "Workspace route: ${TARGET_URL}"
echo "API log: ${REPO_ROOT}/.fullmag/logs/fullmag-api.log"

if [[ ! -d "$REPO_ROOT/apps/web/node_modules" && ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "Installing web dependencies ..."
  "${PNPM_CMD[@]}" install --dir apps/web
fi

printf '%s\n' "${WEB_URL_BASE}" > "${CONTROL_ROOM_URL_FILE}"

FULLMAG_API_PROXY_TARGET="http://localhost:8081" \
  "${PNPM_CMD[@]}" --dir apps/web exec node dev-server.mjs --hostname "${WEB_BIND_HOST}" --port "${WEB_PORT}" --api-target "http://localhost:8081"
