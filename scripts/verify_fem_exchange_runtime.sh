#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host"
RESULTS_DIR="${REPO_ROOT}/tests/fem_exchange_validation/results"

if [[ ! -f "${RUNTIME_ROOT}/manifest.json" ]]; then
  echo "managed FEM runtime manifest is missing: ${RUNTIME_ROOT}/manifest.json" >&2
  echo "Run: just ensure-managed-fem-runtime" >&2
  exit 1
fi

PYTHON_BIN="${FULLMAG_PYTHON:-python3}"
export PYTHONPATH="${RUNTIME_ROOT}:${REPO_ROOT}/packages/fullmag-py/src:${REPO_ROOT}/target/release:${REPO_ROOT}/target/debug:${PYTHONPATH:-}"
export LD_LIBRARY_PATH="${RUNTIME_ROOT}/lib:${RUNTIME_ROOT}/openmpi/lib:${LD_LIBRARY_PATH:-}"

rm -rf "${RESULTS_DIR}"
mkdir -p "${RESULTS_DIR}"

"${PYTHON_BIN}" "${REPO_ROOT}/tests/fem_exchange_validation/sinusoidal_mode.py"

test -f "${RESULTS_DIR}/sinusoidal_mode.csv"
