#!/usr/bin/env bash
set -euo pipefail

root="${FULLMAG_SP4_REPORT_ROOT:-.fullmag/reports/standard-problems/mumag/sp4/fem}"
devices="${FULLMAG_SP4_DEVICES:-cpu gpu}"
meshes="${FULLMAG_SP4_MESH_LEVELS:-coarse medium fine}"
cases="${FULLMAG_SP4_CASES:-case-a case-b}"
airboxes="${FULLMAG_SP4_AIRBOXES:-baseline expanded}"
duration="${FULLMAG_SP4_DURATION_S:-5e-9}"
qualifying="${FULLMAG_SP4_QUALIFYING:-1}"

mkdir -p "$root"
export MPLCONFIGDIR="$root/.matplotlib"
mkdir -p "$MPLCONFIGDIR"
export FULLMAG_GMSH_THREADS=1
export FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson

run_phase() {
  local device="$1" phase="$2" case_id="$3" mesh="$4" airbox="$5" state="$6" phase_duration="$7" output="$8"
  mkdir -p "$output"
  FULLMAG_SP4_DEVICE="$device" FULLMAG_SP4_PHASE="$phase" FULLMAG_SP4_CASE="$case_id" \
    FULLMAG_SP4_MESH="$mesh" FULLMAG_SP4_AIRBOX="$airbox" \
    FULLMAG_SP4_INITIAL_STATE="$state" FULLMAG_SP4_DURATION_S="$phase_duration" \
    just fem-sp4-run "$device" "$output"
}

for mesh in $meshes; do
  for airbox in $airboxes; do
    if [ "$airbox" = expanded ] && [ "$mesh" != medium ]; then continue; fi
    state_root="$root/states/$mesh/$airbox"
    mkdir -p "$state_root"
    FULLMAG_SP4_DEVICE=gpu FULLMAG_SP4_PHASE=relax FULLMAG_SP4_CASE=case-a \
      FULLMAG_SP4_MESH="$mesh" FULLMAG_SP4_AIRBOX="$airbox" \
      just fem-sp4-run gpu "$state_root/artifacts"
    python3 scripts/write_fem_magnetic_initial_state_from_shared_domain.py \
      "$state_root/artifacts" "$state_root/initial_state.json"
    sha256sum "$state_root/initial_state.json" > "$state_root/initial_state.sha256"

    for device in $devices; do
      for case_id in $cases; do
        run_root="$root/runs/$device/$mesh/$airbox/$case_id"
        mkdir -p "$run_root"
        awk '{print $1}' "$state_root/initial_state.sha256" > "$run_root/source_state.sha256"
        run_phase "$device" dynamic "$case_id" "$mesh" "$airbox" "$state_root/initial_state.json" "$duration" "$run_root/artifacts"
        if [ "$qualifying" = 1 ]; then
          read -r before after < <(python3 - "$run_root/artifacts/scalars.csv" <<'PY'
import csv, sys
rows=list(csv.DictReader(open(sys.argv[1], newline="")))
for left,right in zip(rows,rows[1:]):
    if float(left["mx"]) > 0 >= float(right["mx"]):
        print(left["time"], right["time"]); break
else: raise SystemExit("missing first positive-to-nonpositive mx crossing")
PY
          )
          run_phase "$device" replay-before "$case_id" "$mesh" "$airbox" "$state_root/initial_state.json" "$before" "$run_root/replay-before"
          run_phase "$device" replay-after "$case_id" "$mesh" "$airbox" "$state_root/initial_state.json" "$after" "$run_root/replay-after"
        fi
      done
    done
  done
done

PYTHONPATH=packages/fullmag-py/src:. python3 -m tests.standard_problems.mumag.sp4.fem.verify "$root" \
  $(if [ "$qualifying" = 1 ]; then printf '%s' '--qualifying'; else printf '%s' '--smoke'; fi)
