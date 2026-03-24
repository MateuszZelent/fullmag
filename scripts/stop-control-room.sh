#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pkill -f "${REPO_ROOT}/.fullmag/target/.*/fullmag-api" >/dev/null 2>&1 || true
pkill -f "${REPO_ROOT}/apps/web.*next dev" >/dev/null 2>&1 || true
pkill -f "next dev --hostname 127.0.0.1 --port 300" >/dev/null 2>&1 || true

rm -f "${REPO_ROOT}/.fullmag/control-room-url.txt"

echo "Stopped Fullmag control-room processes and cleared stored web URL."
