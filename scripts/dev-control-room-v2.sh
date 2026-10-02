#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
STORAGE_RESOLVER="${REPO_ROOT}/scripts/fullmag_storage.py"
STORAGE_PYTHON=""
if command -v python3 >/dev/null 2>&1; then
  STORAGE_PYTHON="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  STORAGE_PYTHON="$(command -v python)"
else
  echo "Python is required for the Fullmag storage resolver." >&2
  exit 2
fi
if [[ ! -f "${STORAGE_RESOLVER}" ]]; then
  echo "Fullmag storage resolver is missing: ${STORAGE_RESOLVER}" >&2
  exit 2
fi

# Direct launcher invocations enter through the same lock and environment
# boundary as just/Make.  A launcher called from an already managed recipe
# reuses the inherited lock; a direct call is re-entered by the resolver before
# it can create logs, links, or build outputs.
if ! "${STORAGE_PYTHON}" "${STORAGE_RESOLVER}" assert-lock --repo-root "${REPO_ROOT}" >/dev/null 2>&1; then
  exec "${STORAGE_PYTHON}" "${STORAGE_RESOLVER}" run --repo-root "${REPO_ROOT}" -- \
    bash "${SCRIPT_PATH}" "$@"
fi

INSTANCE_ID="${FULLMAG_INSTANCE_ID:-}"
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$($STORAGE_PYTHON -c 'import uuid; print(uuid.uuid4().hex)')"
fi
if [[ ! "$INSTANCE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  echo "FULLMAG_INSTANCE_ID contains unsafe characters: ${INSTANCE_ID}" >&2
  exit 2
fi

# The resolver exports the canonical per-worktree runtime root when this
# script is entered through `fullmag_storage.py run`.  Transient API and
# launcher state belongs to this run; the compatibility .fullmag link is a
# shared cache and is not an instance state directory.
RUNTIME_ROOT="${FULLMAG_RUNTIME_ROOT:-}"
if [[ -z "$RUNTIME_ROOT" ]]; then
  RUNTIME_ROOT="$($STORAGE_PYTHON "$STORAGE_RESOLVER" resolve --repo-root "$REPO_ROOT" --format json | "$STORAGE_PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["runtime_root"])')"
fi
FULLMAG_STATE_ROOT="${FULLMAG_STATE_ROOT:-${RUNTIME_ROOT}/instances/${INSTANCE_ID}}"
mkdir -p "$FULLMAG_STATE_ROOT/logs"
export FULLMAG_INSTANCE_ID FULLMAG_STATE_ROOT

API_PREFERRED="${FULLMAG_API_PORT:-8081}"
WEB_PREFERRED="${FULLMAG_CONTROL_ROOM_V2_PORT:-${FULLMAG_WEB_PORT:-3100}}"
[[ "$API_PREFERRED" == "0" ]] && API_PREFERRED=8081
[[ "$WEB_PREFERRED" == "0" ]] && WEB_PREFERRED=3100
API_BIND_HOST="${FULLMAG_API_BIND_HOST:-0.0.0.0}"
WEB_BIND_HOST="${FULLMAG_CONTROL_ROOM_V2_BIND_HOST:-${FULLMAG_WEB_BIND_HOST:-0.0.0.0}}"
CONTROL_ROOM_URL_FILE="${FULLMAG_STATE_ROOT}/control-room-v2-url.txt"
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

cd "$REPO_ROOT"

NODE_BINARY="${FULLMAG_NODE_BINARY:-}"
if [[ -z "$NODE_BINARY" ]]; then
  NODE_BINARY="$(command -v node || true)"
fi
if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
  echo "Node.js is required for the Fullmag Control Room dev server." >&2
  echo "Install Node.js or set FULLMAG_NODE_BINARY to an executable managed Node.js binary." >&2
  exit 127
fi

# The shell launcher owns only the children it starts.  `setsid --wait` gives
# each service a private process group, while the pid file written by the
# service child lets cleanup target that group rather than a PID returned by a
# wrapper.  If setsid is unavailable, cleanup falls back to the direct child;
# it never scans or kills a process merely because it uses our port.
start_owned_process() {
  local pid_file="$1"
  local log_file="$2"
  shift 2
  rm -f "$pid_file"
  if command -v setsid >/dev/null 2>&1; then
    setsid --wait bash -c 'printf "%s\n" "$BASHPID" > "$1"; shift; exec "$@"' \
      -- "$pid_file" "$@" >"$log_file" 2>&1 &
    STARTED_WRAPPER_PID=$!
    STARTED_PROCESS_GROUP=1
    for _ in $(seq 1 100); do
      if [[ -s "$pid_file" ]]; then
        STARTED_PROCESS_PID="$(cat "$pid_file")"
        if [[ "$STARTED_PROCESS_PID" =~ ^[1-9][0-9]*$ ]]; then
          return 0
        fi
      fi
      if ! kill -0 "$STARTED_WRAPPER_PID" 2>/dev/null; then
        return 1
      fi
      sleep 0.02
    done
    if [[ "${STARTED_PROCESS_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
      stop_owned_process "$STARTED_PROCESS_PID" "$STARTED_WRAPPER_PID" "$STARTED_PROCESS_GROUP"
    elif kill -0 "$STARTED_WRAPPER_PID" 2>/dev/null; then
      kill -TERM "$STARTED_WRAPPER_PID" >/dev/null 2>&1 || true
      wait "$STARTED_WRAPPER_PID" 2>/dev/null || true
    fi
    return 1
  fi

  "$@" >"$log_file" 2>&1 &
  STARTED_WRAPPER_PID=$!
  STARTED_PROCESS_PID=$STARTED_WRAPPER_PID
  STARTED_PROCESS_GROUP=0
  printf '%s\n' "$STARTED_PROCESS_PID" >"$pid_file"
}

stop_owned_process() {
  local pid="${1:-}"
  local wrapper_pid="${2:-}"
  local process_group="${3:-0}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0

  if kill -0 "$pid" 2>/dev/null; then
    if [[ "$process_group" == "1" ]]; then
      kill -TERM -- "-$pid" >/dev/null 2>&1 || true
    else
      kill -TERM "$pid" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$wrapper_pid" =~ ^[1-9][0-9]*$ ]] && [[ "$wrapper_pid" != "$pid" ]] &&
    kill -0 "$wrapper_pid" 2>/dev/null; then
    kill -TERM "$wrapper_pid" >/dev/null 2>&1 || true
  fi

  for _ in $(seq 1 50); do
    local alive=0
    kill -0 "$pid" 2>/dev/null && alive=1
    [[ "$wrapper_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$wrapper_pid" 2>/dev/null && alive=1
    [[ "$alive" == "0" ]] && break
    sleep 0.02
  done
  if [[ "$process_group" == "1" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" >/dev/null 2>&1 || true
  elif kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  if [[ "$wrapper_pid" =~ ^[1-9][0-9]*$ ]]; then
    wait "$wrapper_pid" 2>/dev/null || true
  fi
}

cleanup() {
  stop_owned_process "${FRONTEND_PID:-}" "${FRONTEND_WRAPPER_PID:-}" "${FRONTEND_PROCESS_GROUP:-0}"
  stop_owned_process "${API_PID:-}" "${API_WRAPPER_PID:-}" "${API_PROCESS_GROUP:-0}"
  FRONTEND_PID=""
  FRONTEND_WRAPPER_PID=""
  API_PID=""
  API_WRAPPER_PID=""
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_is_bindable() {
  "${STORAGE_PYTHON}" "${PORT_HELPER}" check "${WEB_BIND_HOST}" "$1"
}

endpoint_instance_is_ready() {
  local url="$1"
  local headers status instance
  headers="$(curl --silent --show-error --max-time 2 --dump-header - --output /dev/null "$url" 2>/dev/null || true)"
  status="$(printf '%s\n' "$headers" | awk '/^HTTP\/[0-9.]+ [0-9]+/ { code = $2 } END { print code }')"
  instance="$(printf '%s\n' "$headers" | awk 'BEGIN { IGNORECASE = 1 } tolower($1) == "x-fullmag-instance-id:" { gsub("\r", "", $2); print $2; exit }')"
  [[ "$status" =~ ^[23][0-9][0-9]$ && "$instance" == "${INSTANCE_ID}" ]]
}

owned_process_is_alive() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]] && kill -0 "$1" 2>/dev/null
}

api_is_ready() {
  owned_process_is_alive "${API_PID:-}" || return 1
  endpoint_instance_is_ready "${API_URL}/healthz"
}

frontend_is_ready() {
  owned_process_is_alive "${FRONTEND_PID:-}" || return 1
  # Next redirects `/` to `/workspace` in development.  We intentionally do
  # not require a 2xx response here: the identity header plus a 2xx/3xx
  # response is the readiness contract and a redirect is valid while the
  # workspace is compiling.
  endpoint_instance_is_ready "${WEB_URL_BASE}/"
}

resolve_api_binary() {
  local configured="${FULLMAG_API_BINARY:-}"
  if [[ -n "$configured" ]]; then
    if [[ -x "$configured" ]]; then
      printf '%s\n' "$configured"
      return 0
    fi
    echo "FULLMAG_API_BINARY is not an executable: ${configured}" >&2
    return 2
  fi
  local candidates=(
    "${REPO_ROOT}/.fullmag/local/bin/fullmag-api"
    "${RUNTIME_ROOT}/bin/fullmag-api"
    "${REPO_ROOT}/.fullmag/bin/fullmag-api"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "Managed fullmag-api binary is missing for this worktree." >&2
  echo "Build/install it through the managed Fullmag runner (for example: just build fullmag)," >&2
  echo "or set FULLMAG_API_BINARY to an existing managed executable." >&2
  return 2
}

pick_port_pair() {
  local api_candidates=("${API_PREFERRED}")
  local web_candidates=("${WEB_PREFERRED}")
  local port
  for port in $(seq 8080 8099); do
    [[ "$port" == "${API_PREFERRED}" ]] || api_candidates+=("$port")
  done
  for port in $(seq 3100 3199); do
    [[ "$port" == "${WEB_PREFERRED}" ]] || web_candidates+=("$port")
  done
  local selected
  selected="$($STORAGE_PYTHON "$PORT_HELPER" pair \
    --api-host "${API_BIND_HOST}" --web-host "${WEB_BIND_HOST}" \
    --api-ports "${api_candidates[@]}" --web-ports "${web_candidates[@]}" \
    --format shell)"
  read -r API_PORT WEB_PORT <<<"$selected"
  if [[ ! "$API_PORT" =~ ^[1-9][0-9]{0,4}$ || ! "$WEB_PORT" =~ ^[1-9][0-9]{0,4}$ ]]; then
    echo "Control Room port helper returned an invalid pair: ${selected}" >&2
    return 1
  fi
  API_URL="http://localhost:${API_PORT}"
  echo "Selected Fullmag instance ${INSTANCE_ID}: API ${API_PORT}, UI ${WEB_PORT}" >&2
}

for attempt in 1 2 3; do
  pick_port_pair
  WEB_URL_BASE="http://${WEB_PUBLIC_HOST}:${WEB_PORT}"
  BROWSER_API_URL="${API_URL}"
  if [[ "$WEB_PUBLIC_HOST" != "localhost" && "$WEB_PUBLIC_HOST" != "127.0.0.1" && "$API_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
    BROWSER_API_URL="http://${WEB_PUBLIC_HOST}:${API_PORT}"
  fi

  "${STORAGE_PYTHON}" "${STORAGE_RESOLVER}" prepare-links \
    --repo-root "${REPO_ROOT}" --compat --frontend \
    --next-dist-dir ".next-control-room-${WEB_PORT}" >/dev/null

  API_BINARY="$(resolve_api_binary)"

  echo "Starting Fullmag API instance ${INSTANCE_ID} on ${API_URL} ..."
  export FULLMAG_API_PORT="${API_PORT}"
  export FULLMAG_INSTANCE_ID="${INSTANCE_ID}"
  export FULLMAG_REPO_ROOT="${FULLMAG_API_REPO_ROOT:-${REPO_ROOT}}"
  export FULLMAG_STATE_ROOT="${FULLMAG_STATE_ROOT}"
  export FULLMAG_DISABLE_STATIC_CONTROL_ROOM=1
  if ! start_owned_process "${FULLMAG_STATE_ROOT}/api.pid" \
    "${FULLMAG_STATE_ROOT}/logs/fullmag-api.log" "${API_BINARY}"; then
    echo "Fullmag API process could not be started; retrying with a fresh pair." >&2
    cleanup
    [[ "$attempt" -lt 3 ]] && continue
    exit 1
  fi
  API_PID="${STARTED_PROCESS_PID}"
  API_WRAPPER_PID="${STARTED_WRAPPER_PID}"
  API_PROCESS_GROUP="${STARTED_PROCESS_GROUP}"

  api_ready=0
  for _ in $(seq 1 600); do
    if api_is_ready; then
      api_ready=1
      break
    fi
    if ! owned_process_is_alive "$API_PID"; then
      echo "Fullmag API process exited unexpectedly; retrying with a fresh pair." >&2
      break
    fi
    sleep 0.2
  done
  if [[ "$api_ready" != "1" ]]; then
    cleanup
    [[ "$attempt" -lt 3 ]] && continue
    echo "Fullmag API did not become healthy after ${attempt} attempts." >&2
    echo "API log: ${FULLMAG_STATE_ROOT}/logs/fullmag-api.log" >&2
    exit 1
  fi

  echo "Starting frontend v2 dev server for instance ${INSTANCE_ID} on ${WEB_URL_BASE} ..."
  export NEXT_PUBLIC_FULLMAG_API_URL="${BROWSER_API_URL}"
  export FULLMAG_API_URL="${API_URL}"
  export FULLMAG_API_PROXY_TARGET="${API_URL}"
  export FULLMAG_WEB_PUBLIC_HOST="${WEB_PUBLIC_HOST}"
  export FULLMAG_WEB_PUBLIC_PORT="${WEB_PORT}"
  export FULLMAG_INSTANCE_ID="${INSTANCE_ID}"
  export FULLMAG_STATE_ROOT="${FULLMAG_STATE_ROOT}"
  if ! start_owned_process "${FULLMAG_STATE_ROOT}/frontend.pid" \
    "${FULLMAG_STATE_ROOT}/logs/control-room.log" \
    "${NODE_BINARY}" "${REPO_ROOT}/apps/control-room/dev-server.mjs" \
    --hostname "${WEB_BIND_HOST}" --port "${WEB_PORT}" --api-target "${API_URL}"; then
    echo "Control Room dev server could not be started; retrying with a fresh pair." >&2
    cleanup
    [[ "$attempt" -lt 3 ]] && continue
    exit 1
  fi
  FRONTEND_PID="${STARTED_PROCESS_PID}"
  FRONTEND_WRAPPER_PID="${STARTED_WRAPPER_PID}"
  FRONTEND_PROCESS_GROUP="${STARTED_PROCESS_GROUP}"

  frontend_ready=0
  for _ in $(seq 1 600); do
    if frontend_is_ready; then
      frontend_ready=1
      break
    fi
    if ! owned_process_is_alive "$FRONTEND_PID"; then
      break
    fi
    sleep 0.2
  done
  if [[ "$frontend_ready" != "1" ]]; then
    echo "Frontend instance ${INSTANCE_ID} did not become ready with its own identity." >&2
    if ! owned_process_is_alive "$FRONTEND_PID" && ! port_is_bindable "$WEB_PORT"; then
      echo "Frontend port ${WEB_PORT} was claimed during startup; retrying with a fresh API/UI pair." >&2
    fi
    cleanup
    [[ "$attempt" -lt 3 ]] && continue
    echo "Frontend log: ${FULLMAG_STATE_ROOT}/logs/control-room.log" >&2
    exit 1
  fi

  # Discovery is published only after both owned services are ready.  A
  # reader can therefore never be directed to a dead or foreign endpoint.
  printf '%s\n' "${WEB_URL_BASE}" > "${CONTROL_ROOM_URL_FILE}"
  echo "API base: ${API_URL}"
  echo "API health: ${API_URL}/healthz"
  echo "API v2 health: ${API_URL}/v2/platform/health"
  echo "Frontend route: ${WEB_URL_BASE}/workspace"
  echo "API log: ${FULLMAG_STATE_ROOT}/logs/fullmag-api.log"

  set +e
  wait "$FRONTEND_WRAPPER_PID"
  frontend_status=$?
  set -e
  exit "$frontend_status"
done
