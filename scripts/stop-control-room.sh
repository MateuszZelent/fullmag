#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOPBACK_HOST="$(python3 - <<'PY'
import socket
print(socket.gethostbyname("localhost"))
PY
)"

pkill -f "${REPO_ROOT}/.fullmag/target/.*/fullmag-api" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/.fullmag/local/bin/fullmag-api" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/target/.*/fullmag-api" >/dev/null 2>&1 || true
pkill -f "cargo +nightly run -p fullmag-api" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/apps/web.*next dev" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/apps/web.*dev-server.mjs" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/apps/control-room.*next dev" >/dev/null 2>&1 || true
pkill -f "next dev --hostname 0.0.0.0 --port 300" >/dev/null 2>&1 || true
pkill -f "next dev --hostname localhost --port 300" >/dev/null 2>&1 || true
pkill -f "next dev --hostname ${LOOPBACK_HOST} --port 300" >/dev/null 2>&1 || true
pkill -f "next dev --hostname 0.0.0.0 --port 310" >/dev/null 2>&1 || true
pkill -f "next dev --hostname localhost --port 310" >/dev/null 2>&1 || true
pkill -f "next dev --hostname ${LOOPBACK_HOST} --port 310" >/dev/null 2>&1 || true
pkill -f "node dev-server.mjs --hostname 0.0.0.0 --port 300" >/dev/null 2>&1 || true
pkill -f "node dev-server.mjs --hostname localhost --port 300" >/dev/null 2>&1 || true
pkill -f "node dev-server.mjs --hostname ${LOOPBACK_HOST} --port 300" >/dev/null 2>&1 || true

rm -f "${REPO_ROOT}/.fullmag/control-room-url.txt"
rm -f "${REPO_ROOT}/.fullmag/control-room-v2-url.txt"

echo "Stopped Fullmag control-room processes and cleared stored web URL."
