#!/bin/sh
# Rig emulation matrix for FEM GPU jobs (docs/audits/2026-11-26-rig-one-core-per-gpu-job.md).
#
# Run inside the Docker DEV backend container of the checkout, from the source root:
#   docker exec -i -w /opt/fullmag/source <backend> sh -s < scripts/benchmarks/run_rig_fem_matrix.sh
#
# One GPU job at a time. Configurations:
#   A  = DEV default (cgroup CPU quota, thread pools from the container environment)
#   B  = one logical CPU (taskset) and thread pools of 1
#   C  = one logical CPU, thread pools left at the container default
#   D  = B plus one busy loop pinned to the same CPU (two jobs per core)
#   D2 = B plus two busy loops (three jobs per core)
# Each B/D/D2 run is repeated for FULLMAG_CUDA_WAIT_MODE=default and blocking.
# Per-step costs come from differencing the 10-step and 110-step runs (analyze_rig_probe.py) and from
# performance/steps.csv.
set -u
K=${RIG_CPU:-30}
OUT=${RIG_OUT:-/build/rig/results}
HELPER=${RIG_NVML_HELPER:-/build/rig/nvml_gpu_sample}
mkdir -p "$(dirname "$HELPER")"
[ -x "$HELPER" ] || gcc -O2 -I/usr/local/cuda/include scripts/benchmarks/nvml_gpu_sample.c -lnvidia-ml -o "$HELPER"
PR="python3 scripts/benchmarks/rig_probe.py --output $OUT --timeout 1800 --nvml-helper $HELPER"
THREADS1="--env FULLMAG_CPU_THREADS=1 --env OMP_NUM_THREADS=1 --env OMP_THREAD_LIMIT=1 --env RAYON_NUM_THREADS=1 --env OPENBLAS_NUM_THREADS=1 --env MKL_NUM_THREADS=1"
CASE="--case-script scripts/benchmarks/fem_memory_transfer_case.py --backend fem --env FEM_CASE_HMAX=${RIG_HMAX:-3e-9}"

run() {  # label config wait strategy steps
  label=$1; cfg=$2; wait=$3; strategy=$4; steps=$5
  args="$CASE --env FEM_CASE_GPU_STRATEGY=$strategy --env FEM_CASE_STEPS=$steps --env FULLMAG_CUDA_WAIT_MODE=$wait"
  case $cfg in
    A)  $PR --label "$label" $args ;;
    B)  $PR --label "$label" --prefix "taskset -c $K" $THREADS1 $args ;;
    C)  $PR --label "$label" --prefix "taskset -c $K" $args ;;
    D)  $PR --label "$label" --prefix "taskset -c $K" --neighbor-cpu $K --neighbor-count 1 $THREADS1 $args ;;
    D2) $PR --label "$label" --prefix "taskset -c $K" --neighbor-cpu $K --neighbor-count 2 $THREADS1 $args ;;
  esac
}

$PR --label idle_start --idle-only 60
for strategy in auto cg_amg; do
  for steps in 10 110; do
    run "${strategy}_A_default_s$steps" A default $strategy $steps
    for wait in default blocking; do
      run "${strategy}_B_${wait}_s$steps" B $wait $strategy $steps
    done
  done
  run "${strategy}_C_default_s110" C default $strategy 110
  for wait in default blocking; do
    run "${strategy}_D_${wait}_s110" D $wait $strategy 110
    run "${strategy}_D2_${wait}_s110" D2 $wait $strategy 110
  done
done
$PR --label idle_end --idle-only 60
