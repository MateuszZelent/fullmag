#!/usr/bin/env bash
set -euo pipefail

root="${FULLMAG_SP4_REPORT_ROOT:-.fullmag/reports/standard-problems/mumag/sp4/fem}"
root="$(realpath -m "$root")"
devices="${FULLMAG_SP4_DEVICES:-cpu gpu}"
relaxation_algorithms="${FULLMAG_SP4_RELAX_ALGORITHMS:-llg_overdamped projected_gradient_bb nonlinear_cg}"
meshes="${FULLMAG_SP4_MESH_LEVELS:-coarse medium fine}"
cases="${FULLMAG_SP4_CASES:-case-a case-b}"
airboxes="${FULLMAG_SP4_AIRBOXES:-baseline expanded}"
duration="${FULLMAG_SP4_DURATION_S:-5e-9}"
qualifying="${FULLMAG_SP4_QUALIFYING:-1}"
resume="${FULLMAG_SP4_RESUME:-0}"

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
    for device in $devices; do
      for algorithm in $relaxation_algorithms; do
        relaxation_root="$root/relaxations/$device/$mesh/$airbox/$algorithm/artifacts"
        relaxation_ready=0
        if [ "$resume" = 1 ]; then
          if [ "$qualifying" = 1 ]; then
            if python3 scripts/check_fem_sp4_relaxation.py "$relaxation_root" \
                 --expected-algorithm "$algorithm" --expected-device "$device"; then
              relaxation_ready=1
            fi
          elif [ -s "$relaxation_root/metadata.json" ] && \
               [ -s "$relaxation_root/scalars.csv" ] && \
               [ -s "$relaxation_root/m_final.json" ]; then
            relaxation_ready=1
          fi
        fi
        if [ "$relaxation_ready" != 1 ]; then
          FULLMAG_SP4_DEVICE="$device" FULLMAG_SP4_PHASE=relax \
            FULLMAG_SP4_RELAX_ALGORITHM="$algorithm" FULLMAG_SP4_CASE=case-a \
            FULLMAG_SP4_MESH="$mesh" FULLMAG_SP4_AIRBOX="$airbox" \
            just fem-sp4-run "$device" "$relaxation_root"
        fi
        if [ "$qualifying" = 1 ] && \
           ! python3 scripts/check_fem_sp4_relaxation.py "$relaxation_root" \
             --expected-algorithm "$algorithm" --expected-device "$device"; then
          echo "fresh SP4 relaxation did not satisfy the qualification gate: $device/$mesh/$airbox/$algorithm" >&2
          exit 1
        fi
      done
    done

    if [ "$qualifying" = 1 ]; then
      PYTHONPATH=packages/fullmag-py/src:. python3 \
        scripts/select_fem_sp4_relaxation_state.py "$root" \
        --mesh "$mesh" --airbox "$airbox"
    else
      canonical_artifacts="$root/relaxations/gpu/$mesh/$airbox/llg_overdamped/artifacts"
      python3 scripts/write_fem_magnetic_initial_state_from_shared_domain.py \
        "$canonical_artifacts" "$state_root/initial_state.json"
      sha256sum "$state_root/initial_state.json" > "$state_root/initial_state.sha256"
    fi

    for device in $devices; do
      for case_id in $cases; do
        run_root="$root/runs/$device/$mesh/$airbox/$case_id"
        mkdir -p "$run_root"
        awk '{print $1}' "$state_root/initial_state.sha256" > "$run_root/source_state.sha256"
        if [ "$resume" != 1 ] || [ ! -s "$run_root/artifacts/metadata.json" ] || \
           [ ! -s "$run_root/artifacts/scalars.csv" ] || [ ! -s "$run_root/artifacts/m_final.json" ]; then
          run_phase "$device" dynamic "$case_id" "$mesh" "$airbox" "$state_root/initial_state.json" "$duration" "$run_root/artifacts"
        fi
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
