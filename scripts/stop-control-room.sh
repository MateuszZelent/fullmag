#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_ROOM_DIR="${REPO_ROOT}/apps/control-room"

pkill -f "${REPO_ROOT}/.fullmag/target/.*/fullmag-api" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/.fullmag/local/bin/fullmag-api" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/target/.*/fullmag-api" >/dev/null 2>&1 || true
pkill -f "cargo +nightly run -p fullmag-api" >/dev/null 2>&1 || true
while read -r pid; do
  [[ -z "$pid" || "$pid" == "$$" ]] && continue
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$CONTROL_ROOM_DIR" ]] || continue
  kill "$pid" >/dev/null 2>&1 || true
done < <(pgrep -f 'next|dev-server\.mjs' 2>/dev/null || true)

rm -f "${REPO_ROOT}/.fullmag/control-room-url.txt"
rm -f "${REPO_ROOT}/.fullmag/control-room-v2-url.txt"

echo "Stopped Fullmag control-room processes and cleared stored web URL."
