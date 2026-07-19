#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

device="${1:-}"
script="${2:-}"
attempt_id="${3:-}"
build="${4:-false}"
ledger="${5:-.fullmag/reports/standard-problems/mumag/sp4/fem/ledger/results.csv}"

case "$device" in
  cpu|gpu) ;;
  *) echo "unsupported FEM device: $device (expected cpu or gpu)" >&2; exit 2 ;;
esac
case "$build" in
  true|false) ;;
  *) echo "unsupported build value: $build (expected true or false)" >&2; exit 2 ;;
esac
if [ -z "$attempt_id" ]; then
  echo "attempt_id must not be empty" >&2
  exit 2
fi
if [ ! -f "$script" ]; then
  echo "SP4 scenario script not found: $script" >&2
  exit 2
fi

script="$(realpath "$script")"
case "$script" in
  *.py) ;;
  *) echo "SP4 scenario must be a .py file: $script" >&2; exit 2 ;;
esac
bundle="${script%.py}.zarr"
scenario="$(basename "${script%.py}")"
ledger="$(realpath -m "$ledger")"
plot_dir="$(dirname "$ledger")/plots"
mkdir -p "$(dirname "$ledger")"

python_exec="$root/.fullmag/local/python/bin/python"
if [ ! -x "$python_exec" ]; then
  python_exec="$(command -v python3)"
fi
export PYTHONPATH="$root/packages/fullmag-py/src:$root"

started_ns="$(date +%s%N)"
set +e
just fullmag "build=$build" fem "$device" headless "$script"
run_status=$?
set -e
finished_ns="$(date +%s%N)"

if [ -d "$bundle" ]; then
  "$python_exec" -c '
import json
import sys
from pathlib import Path

path, start, stop, status, device = sys.argv[1:]
Path(path).write_text(
    json.dumps(
        {
            "schema": "fullmag.sp4.run_receipt.v1",
            "requested_device": device,
            "exit_status": int(status),
            "wall_time_s": (int(stop) - int(start)) / 1e9,
        },
        indent=2,
        sort_keys=True,
    ) + "\n",
    encoding="utf-8",
)
' "$bundle/run_receipt.json" "$started_ns" "$finished_ns" "$run_status" "$device"
fi

wall_time_s="$($python_exec -c 'import sys; print((int(sys.argv[2])-int(sys.argv[1]))/1e9)' "$started_ns" "$finished_ns")"

if [ "$run_status" -ne 0 ]; then
  "$python_exec" -m tests.standard_problems.mumag.sp4.fem.collect_results \
    --artifacts "$bundle" \
    --ledger "$ledger" \
    --scenario "$scenario" \
    --attempt-id "$attempt_id" \
    --requested-device "$device" \
    --wall-time-s "$wall_time_s" \
    --failure-category execution_failure \
    --failure-detail "native runtime exited with status $run_status"
  exit "$run_status"
fi

"$python_exec" -m tests.standard_problems.mumag.sp4.fem.collect_results \
  --artifacts "$bundle" \
  --ledger "$ledger" \
  --scenario "$scenario" \
  --attempt-id "$attempt_id"

export MPLCONFIGDIR="$(dirname "$ledger")/.matplotlib"
mkdir -p "$MPLCONFIGDIR"
"$python_exec" -m tests.standard_problems.mumag.sp4.fem.plot_results \
  --ledger "$ledger" \
  --output-dir "$plot_dir"
