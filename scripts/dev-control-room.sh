#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_ID="${1:-}"
API_URL="${FULLMAG_API_URL:-http://127.0.0.1:8080}"
WEB_HOST="${FULLMAG_WEB_HOST:-127.0.0.1}"
CONTROL_ROOM_URL_FILE=".fullmag/control-room-url.txt"

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
for port in (3000, 3001, 3002, 3003, 3004, 3005, 3010):
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
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

discover_existing_web_url() {
  for port in 3000 3001 3002 3003 3004 3005 3010; do
    local candidate="http://${WEB_HOST}:${port}"
    if curl -fsS "${candidate}" >/dev/null 2>&1; then
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
  if [[ -n "${WEB_URL_BASE}" ]] && curl -fsS "${WEB_URL_BASE}" >/dev/null 2>&1; then
    WEB_PORT="${WEB_URL_BASE##*:}"
  else
    WEB_PORT="$(pick_web_port)"
    WEB_URL_BASE="http://${WEB_HOST}:${WEB_PORT}"
  fi
elif EXISTING_WEB_URL="$(discover_existing_web_url)"; then
  WEB_URL_BASE="${EXISTING_WEB_URL}"
  WEB_PORT="${WEB_URL_BASE##*:}"
else
  WEB_PORT="$(pick_web_port)"
  WEB_URL_BASE="http://${WEB_HOST}:${WEB_PORT}"
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

if [[ -n "$SESSION_ID" ]]; then
  TARGET_URL="${WEB_URL_BASE}/runs/${SESSION_ID}"
else
  TARGET_URL="${WEB_URL_BASE}/runs"
fi

if curl -fsS "${WEB_URL_BASE}" >/dev/null 2>&1; then
  echo "Reusing Next.js control room on ${WEB_URL_BASE} ..."
  (
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "${TARGET_URL}" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "${TARGET_URL}" >/dev/null 2>&1 || true
    fi
  ) &
  echo "Session route: ${TARGET_URL}"
  exit 0
fi

(
  for _ in $(seq 1 120); do
    if curl -fsS "${WEB_URL_BASE}" >/dev/null 2>&1; then
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
echo "Session route: ${TARGET_URL}"
echo "API log: ${REPO_ROOT}/.fullmag/logs/fullmag-api.log"

if [[ ! -d "$REPO_ROOT/apps/web/node_modules" && ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "Installing web dependencies ..."
  "${PNPM_CMD[@]}" install --dir apps/web
fi

printf '%s\n' "${WEB_URL_BASE}" > "${CONTROL_ROOM_URL_FILE}"

"${PNPM_CMD[@]}" --dir apps/web exec next dev --hostname "${WEB_HOST}" --port "${WEB_PORT}"
